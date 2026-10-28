"""sandbox:run — apps run their own pinned tools inside the OS sandbox. Real sandbox-exec where available."""
import asyncio
import hashlib
import json
import pathlib
import shutil

import pytest

from hive.core import sandbox_run
from hive.supervisor.sandbox import backend

MAC = pytest.mark.skipif(backend() != "sandbox-exec", reason="needs macOS sandbox-exec")
# r14: the same boundary tests run on Linux under the namespace/Landlock launcher with no relay ports.
SANDBOXED = pytest.mark.skipif(backend() not in ("sandbox-exec", "landlock"), reason="needs an OS sandbox")
LINUX = pytest.mark.skipif(backend() != "landlock", reason="needs Linux namespaces + Landlock")
NODE = shutil.which("node")


def make_app(tmp_path, files):
    app = tmp_path / "app"
    tools = app / "tools"
    tools.mkdir(parents=True)
    for rel, text in files.items():
        (tools / rel).write_text(text)
    lock = {"files": {rel: hashlib.sha256((tools / rel).read_bytes()).hexdigest() for rel in files}}
    (tools / "bundle.lock.json").write_text(json.dumps(lock))
    return {"id": "demo", "path": str(app), "capabilities": ["sandbox:run"]}


@pytest.fixture(autouse=True)
def config(monkeypatch):
    monkeypatch.setenv("HIVE_SANDBOX_RUN_APPS", "demo")
    runtimes = {"sh": "/bin/sh"}
    if NODE:
        runtimes["node"] = NODE
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps(runtimes))


def run(*a, **k):
    return asyncio.run(sandbox_run.run(*a, **k))


@SANDBOXED
def test_runs_the_bundle_and_returns_declared_outputs(tmp_path):
    app = make_app(tmp_path, {"up.sh": 'tr a-z A-Z < in.txt > out.txt; echo done'})
    r = run(app, "up.sh", inputs={"in.txt": b"hello"}, outputs=["out.txt", "nope.txt"], runtime="sh")
    assert r["exit"] == 0 and r["outputs"]["out.txt"] == b"HELLO" and r["stdout"].strip() == b"done"
    assert r["missing_outputs"] == ["nope.txt"]


@SANDBOXED
def test_cannot_read_or_write_outside_its_job(tmp_path):
    canary = tmp_path / "canary.txt"
    canary.write_text("secret")
    app = make_app(tmp_path, {"peek.sh": f'cat "{canary}"; echo x > "{tmp_path}/escaped.txt"; echo end'})
    r = run(app, "peek.sh", runtime="sh")
    assert b"secret" not in r["stdout"] and not (tmp_path / "escaped.txt").exists()


@pytest.mark.skipif(not NODE, reason="needs node")
@SANDBOXED
def test_no_network_even_to_loopback(tmp_path):
    app = make_app(tmp_path, {"net.mjs": "import net from 'node:net';const s=net.connect(8700,'127.0.0.1');"
                                         "s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});"
                                         "s.on('error',e=>{console.log('DENIED '+e.code);process.exit(0)});"})
    r = run(app, "net.mjs", runtime="node")
    assert b"CONNECTED" not in r["stdout"], r


@SANDBOXED
def test_a_changed_or_extra_bundle_file_is_refused(tmp_path):
    app = make_app(tmp_path, {"a.sh": "echo a"})
    (pathlib.Path(app["path"]) / "tools" / "a.sh").write_text("echo changed")
    with pytest.raises(ValueError, match="changed"):
        run(app, "a.sh", runtime="sh")
    app2 = make_app(tmp_path / "two", {"a.sh": "echo a"})
    (pathlib.Path(app2["path"]) / "tools" / "extra.sh").write_text("echo extra")
    with pytest.raises(ValueError, match="differ"):
        run(app2, "a.sh", runtime="sh")


@SANDBOXED
def test_only_allowlisted_apps_and_configured_runtimes(tmp_path, monkeypatch):
    app = make_app(tmp_path, {"a.sh": "echo a"})
    with pytest.raises(ValueError, match="runtime"):
        run(app, "a.sh", runtime="python")
    monkeypatch.setenv("HIVE_SANDBOX_RUN_APPS", "someone-else")
    with pytest.raises(PermissionError):
        run(app, "a.sh", runtime="sh")


@SANDBOXED
def test_cpu_limit_stops_a_runaway(tmp_path):
    app = make_app(tmp_path, {"spin.sh": "echo started; while :; do :; done"})
    r = run(app, "spin.sh", runtime="sh", cpu_seconds=1, timeout=20)
    # The loop really ran, then a signal ended it (SIGXCPU or SIGKILL): not a launcher refusal (78), not a normal exit.
    assert r["stdout"].strip() == b"started", r
    import signal as _signal
    by_signal = -r["exit"] if r["exit"] < 0 else r["exit"] - 128
    assert by_signal in (_signal.SIGXCPU, _signal.SIGKILL), r      # the CPU limit, not some other crash


@pytest.mark.skipif(not NODE, reason="needs node")
@SANDBOXED
def test_node_actually_runs_inside_and_the_network_attempt_is_refused_not_crashed(tmp_path):
    app = make_app(tmp_path, {"hi.mjs": "import fs from 'node:fs';fs.writeFileSync('o.json',JSON.stringify({ok:1}));console.log('ran')",
                              "net.mjs": "import net from 'node:net';const s=net.connect(8700,'127.0.0.1');"
                                         "s.on('connect',()=>console.log('CONNECTED'));s.on('error',e=>console.log('DENIED '+e.code));"})
    r = run(app, "hi.mjs", outputs=["o.json"], runtime="node")
    assert r["exit"] == 0 and r["stdout"].strip() == b"ran" and json.loads(r["outputs"]["o.json"]) == {"ok": 1}, r
    n = run(app, "net.mjs", runtime="node")
    assert b"DENIED" in n["stdout"] and b"CONNECTED" not in n["stdout"], n


@MAC
def test_a_venv_interpreter_runs_as_configured_and_keeps_its_packages(tmp_path, monkeypatch):
    import sys
    venv_python = pathlib.Path(sys.executable)          # the hive's own venv interpreter (a symlink into Homebrew)
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"py": {"exe": str(venv_python), "reads": [sys.prefix]}}))
    app = make_app(tmp_path, {"p.py": "import sys, httpx; print(sys.prefix)"})
    r = run(app, "p.py", runtime="py")
    assert r["exit"] == 0 and r["stdout"].strip() == sys.prefix.encode(), r


@pytest.mark.parametrize("kind", [None, "", "bubblewrap", "seatbelt"])
def test_refuses_on_a_host_without_a_known_boundary(monkeypatch, kind):
    """Only sandbox-exec (macOS) and the Linux namespace/Landlock launcher are bundle boundaries: anything else refuses,
    never crashes or runs unsandboxed (r12, kept by r14)."""
    import asyncio as _asyncio
    from hive.core import sandbox_run
    monkeypatch.setattr(sandbox_run, "backend", lambda: kind)
    monkeypatch.setattr(sandbox_run, "_allowed_apps", lambda: {"app"})
    with pytest.raises(RuntimeError, match="sandbox unavailable"):
        _asyncio.run(sandbox_run.run({"id": "app", "path": "/nonexistent"}, "x.js"))


@SANDBOXED
def test_the_file_size_limit_is_exact_bytes(tmp_path):
    """r14: Ubuntu's dash counts `ulimit -f` in 512-byte blocks (a 4 KiB limit allowed only 2 KiB); limits.sh uses
    prlimit's exact bytes where it exists. 4 KiB allowed: writing 8 KiB stops at exactly 4096 bytes."""
    app = make_app(tmp_path, {"fill.sh": "head -c 8192 /dev/zero > out.bin; echo wrote $?"})
    r = run(app, "fill.sh", runtime="sh", file_bytes=4096, outputs=["out.bin"])
    assert len(r["outputs"]["out.bin"]) == 4096, r


@LINUX
def test_file_size_limits_are_exact_for_any_byte_count(tmp_path):
    """r14 review: Linux passes the requested bytes straight to prlimit, so 4097 means 4097 (not rounded to 5 KiB)."""
    app = make_app(tmp_path, {"fill.sh": "head -c 9000 /dev/zero > out.bin; echo wrote $?"})
    r = run(app, "fill.sh", runtime="sh", file_bytes=4097, outputs=["out.bin"])
    assert len(r["outputs"]["out.bin"]) == 4097, r


@LINUX
def test_the_launcher_refuses_without_exact_limits(tmp_path):
    """r14 review: on Linux the exact-byte mechanism is required; without prlimit, or with a bad number, nothing runs."""
    import subprocess
    marker = tmp_path / "ran"
    launcher = str(sandbox_run.LAUNCHER)
    only_uname = tmp_path / "bin"
    only_uname.mkdir()
    (only_uname / "uname").symlink_to(shutil.which("uname"))        # the Linux branch is taken; prlimit is absent
    no_prlimit = subprocess.run(["/bin/sh", launcher, "1", "4096", "/bin/touch", str(marker)], env={"PATH": str(only_uname)})
    bad_number = subprocess.run(["/bin/sh", launcher, "1", "4k", "/bin/touch", str(marker)], env={"PATH": "/usr/bin:/bin"})
    fake = tmp_path / "fakebin"
    fake.mkdir()
    (fake / "uname").symlink_to(shutil.which("uname"))
    (fake / "prlimit").write_text("#!/bin/sh\nexit 1\n")            # prlimit present but unable to set the limits
    (fake / "prlimit").chmod(0o755)
    cannot_set = subprocess.run(["/bin/sh", launcher, "1", "4096", "/bin/touch", str(marker)], env={"PATH": str(fake)})
    assert no_prlimit.returncode == 78 and bad_number.returncode == 78 and cannot_set.returncode == 78
    assert not marker.exists()


@LINUX
@pytest.mark.skipif(not NODE, reason="needs node")
def test_rewriting_the_profile_from_inside_widens_nothing(tmp_path):
    """r14 (stand-in review): the launcher's profile sits in the writable job folder. A tool that really rewrites it to
    grant / and the port of a live host listener must still fail to read or write outside or connect, because the profile
    was read before exec and the network namespace has no route out."""
    import socket
    host = socket.socket()
    host.bind(("127.0.0.1", 0))
    host.listen(1)
    port = host.getsockname()[1]
    canary = tmp_path / "canary.txt"
    canary.write_text("secret")
    escaped = tmp_path / "escaped.txt"
    child_net = (f"const s=require('net').connect({port},'127.0.0.1');"
                 "s.on('connect',()=>{console.log('CHILD_NET CONNECTED');process.exit(0)});"
                 "s.on('error',e=>{console.log('CHILD_NET DENIED '+e.code);process.exit(0)});")
    wide = json.dumps({"version": 2, "mind_dir": "/", "read": ["/"], "dev_rw": [], "dev_read": [], "connect_ports": [port]})
    script = (
        "import fs from 'node:fs'; import net from 'node:net';"
        "const out = {};"
        "const dir = '.sandbox-profile'; const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));"
        f"for (const f of files) {{ fs.writeFileSync(dir + '/' + f, {json.dumps(wide)}); }}"
        f"out.rewritten = files.length > 0 && files.every(f => fs.readFileSync(dir + '/' + f, 'utf8') === {json.dumps(wide)});"
        f"try {{ out.read = fs.readFileSync({json.dumps(str(canary))}, 'utf8'); }} catch (e) {{ out.read = 'DENIED ' + e.code; }}"
        f"try {{ fs.writeFileSync({json.dumps(str(escaped))}, 'x'); out.write = 'WROTE'; }} catch (e) {{ out.write = 'DENIED ' + e.code; }}"
        "const { execFileSync } = await import('node:child_process');"
        f"out.child = execFileSync('/bin/sh', ['-c', {json.dumps('echo CHILD_STARTED; (cat ' + str(canary) + ') 2>/dev/null; (echo x > ' + str(escaped) + '2) 2>/dev/null && echo CHILD_WROTE || echo CHILD_WRITE_DENIED; echo CHILD_DONE')}], {{ stdio: ['ignore', 'pipe', 'ignore'] }}).toString();"
        # r14.4 (stand-in 5, Kimi 4): the child itself probes the live host listener and reports its own marker
        f"out.child_net = execFileSync(process.execPath, ['-e', {json.dumps(child_net)}], {{ stdio: ['ignore', 'pipe', 'ignore'] }}).toString();"
        f"const s = net.connect({port}, '127.0.0.1');"
        "s.on('connect', () => { out.net = 'CONNECTED'; console.log(JSON.stringify(out)); process.exit(0); });"
        "s.on('error', e => { out.net = 'DENIED ' + e.code; console.log(JSON.stringify(out)); process.exit(0); });")
    app = make_app(tmp_path, {"widen.mjs": script})
    try:
        r = run(app, "widen.mjs", runtime="node", timeout=30)
    finally:
        host.close()
    out = json.loads(r["stdout"].strip().splitlines()[-1])
    assert out["rewritten"] is True, out                              # the mutation really happened
    assert out["read"].startswith("DENIED") and out["write"].startswith("DENIED") and out["net"].startswith("DENIED"), out
    assert "CHILD_STARTED" in out["child"] and "CHILD_DONE" in out["child"], out   # the child really ran after the rewrite
    assert "secret" not in out["child"] and not pathlib.Path(str(escaped) + "2").exists(), out
    assert "CHILD_WRITE_DENIED" in out["child"] and "CHILD_WROTE" not in out["child"], out
    assert "CHILD_NET DENIED" in out["child_net"] and "CONNECTED" not in out["child_net"], out
    assert not escaped.exists()


@LINUX
def test_a_tool_sees_only_its_own_processes_and_cannot_signal_the_host(tmp_path):
    """r14 review: the tool enumerates /proc successfully, finds itself, does not see a live host process, and cannot
    signal it; the host process is still alive afterwards."""
    import subprocess
    host = subprocess.Popen(["sleep", "60"])
    try:
        app = make_app(tmp_path, {"ps.sh": f"ls /proc > procs.txt && echo me=$$ && "
                                           f"(test -e /proc/{host.pid} && echo SEES_HOST || echo hidden) && "
                                           f"(kill -0 {host.pid} 2>/dev/null && echo SIGNALLED || echo nosignal)"})
        r = run(app, "ps.sh", runtime="sh", outputs=["procs.txt"])
        pids = [int(x) for x in r["outputs"]["procs.txt"].split() if x.isdigit()]
        me = int(r["stdout"].split(b"me=")[1].split()[0])
        assert r["exit"] == 0 and pids and me in pids and len(pids) <= 8, r
        assert b"hidden" in r["stdout"] and b"nosignal" in r["stdout"], r
        assert host.poll() is None                                    # the host process is untouched
    finally:
        host.kill()


def _sleep_alive(d):
    """pgrep's status, strictly: 0 = running, 1 = no such process. Any other status is a probe error and fails the
    test rather than counting as "gone" (stand-in r14.4)."""
    import subprocess
    done = subprocess.run(["pgrep", "-x", "-f", f"sleep {d}"], capture_output=True)
    if done.returncode not in (0, 1):
        raise AssertionError(f"pgrep probe failed (status {done.returncode}): {done.stderr!r}")
    return done.returncode == 0


def _until(cond, seconds):
    """Poll `cond` until it holds or the deadline passes (no fixed sleeps: Kimi r14.3)."""
    import time
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return cond()


def _hang_app(tmp_path):
    import random
    base = random.randint(700000, 799999)       # durations unique to this run: a survivor is found exactly
    durations = [base, base + 1, base + 2]
    app = make_app(tmp_path, {"hang.sh": f"sleep {durations[0]} & sleep {durations[1]} & exec sleep {durations[2]}"})
    return app, durations


def _private_tempdir(tmp_path, monkeypatch):
    import tempfile
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(jobs))   # the run's job folder is made here, so its removal is seen
    return jobs


@SANDBOXED
def test_the_descendant_probe_never_counts_a_probe_error_as_gone(monkeypatch):
    """Stand-in r14.4 finding 2: only pgrep status 1 means absent; status 2 (bad usage / probe error) fails loudly."""
    import subprocess
    real = subprocess.run
    for status, expect in ((0, True), (1, False)):
        monkeypatch.setattr(subprocess, "run", lambda *a, s=status, **k: subprocess.CompletedProcess(a, s, b"", b""))
        assert _sleep_alive(1) is expect
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 2, b"", b"bad"))
    with pytest.raises(AssertionError, match="probe failed"):
        _sleep_alive(1)
    monkeypatch.setattr(subprocess, "run", real)


def test_a_timeout_ends_the_tool_and_every_descendant(tmp_path, monkeypatch):
    """r14 review, r14.4 (stand-in 3, Kimi 3): on timeout the whole process group goes, including background children,
    and the job folder is removed. The watcher signals that all three really started (an Event, no fixed window), and
    their end is polled against a deadline rather than assumed after a fixed sleep."""
    import threading
    jobs = _private_tempdir(tmp_path, monkeypatch)
    app, durations = _hang_app(tmp_path)
    all_started = threading.Event()

    def watch():
        if _until(lambda: all(_sleep_alive(d) for d in durations), 4.5):
            all_started.set()

    import time
    watcher = threading.Thread(target=watch)
    watcher.start()
    began = time.monotonic()
    with pytest.raises(asyncio.TimeoutError):    # an outer deadline: a cleanup that hangs fails here, never hangs CI
        asyncio.run(asyncio.wait_for(sandbox_run.run(app, "hang.sh", runtime="sh", timeout=5), 20))
    watcher.join()
    assert time.monotonic() - began < 15, "the run's own timeout did not end it (its cleanup hung)"
    assert all_started.is_set(), "the three sleeps never all ran before the timeout"
    assert _until(lambda: not any(_sleep_alive(d) for d in durations), 5), [d for d in durations if _sleep_alive(d)]
    assert list(jobs.iterdir()) == [], list(jobs.iterdir())       # the job folder is gone


@SANDBOXED
def test_cancelling_a_run_ends_every_descendant_and_removes_the_job(tmp_path, monkeypatch):
    """r14.4 (stand-in 3): cancellation (the caller goes away) is handled like a timeout: every descendant ends and the
    job folder is removed; the cancellation itself propagates."""
    jobs = _private_tempdir(tmp_path, monkeypatch)
    app, durations = _hang_app(tmp_path)

    async def scenario():
        task = asyncio.ensure_future(sandbox_run.run(app, "hang.sh", runtime="sh", timeout=60))
        started = await asyncio.to_thread(_until, lambda: all(_sleep_alive(d) for d in durations), 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):       # not a TimeoutError: the cancelled run's cleanup finished
            await asyncio.wait_for(asyncio.shield(task), 15)
        return started

    assert asyncio.run(scenario()), "the three sleeps never all ran before the cancel"
    assert _until(lambda: not any(_sleep_alive(d) for d in durations), 5), [d for d in durations if _sleep_alive(d)]
    assert list(jobs.iterdir()) == [], list(jobs.iterdir())


@SANDBOXED
def test_cpu_limit_is_inherited_by_a_child(tmp_path):
    """r14.4 (stand-in 4): a child the tool starts inherits the CPU limit. The child really starts, spins, and is ended
    by SIGXCPU/SIGKILL; the parent (which uses no CPU waiting) survives to report the child's status."""
    import signal as _signal
    app = make_app(tmp_path, {"kid.sh": "/bin/sh -c 'echo child-started; while :; do :; done'; echo child-exit=$?"})
    r = run(app, "kid.sh", runtime="sh", cpu_seconds=1, timeout=30)
    assert r["exit"] == 0 and b"child-started" in r["stdout"], r
    status = int(r["stdout"].split(b"child-exit=")[1].split()[0])
    assert status - 128 in (_signal.SIGXCPU, _signal.SIGKILL), r


@pytest.mark.skipif(not NODE, reason="needs node")
@SANDBOXED
def test_a_child_process_has_no_network_either(tmp_path):
    """r14.4 (stand-in 5, Kimi 4): a child the tool starts probes a LIVE host listener itself and reports its own
    marker; the listener sees no connection."""
    import socket
    host = socket.socket()
    host.bind(("127.0.0.1", 0))
    host.listen(1)
    host.settimeout(0.5)
    port = host.getsockname()[1]
    child = (f"const s=require('net').connect({port},'127.0.0.1');"
             "s.on('connect',()=>{console.log('CHILD_NET CONNECTED');process.exit(0)});"
             "s.on('error',e=>{console.log('CHILD_NET DENIED '+e.code);process.exit(0)});")
    script = ("import { execFileSync } from 'node:child_process';"
              f"console.log(execFileSync(process.execPath, ['-e', {json.dumps(child)}]).toString().trim());")
    app = make_app(tmp_path, {"kid.mjs": script})
    try:
        r = run(app, "kid.mjs", runtime="node", timeout=30)
        try:
            conn, _ = host.accept()
            conn.close()
            reached = True
        except OSError:
            reached = False
    finally:
        host.close()
    assert b"CHILD_NET DENIED" in r["stdout"] and b"CONNECTED" not in r["stdout"], r
    assert not reached, "the child's connection reached the host listener"


def test_bundle_integrity_is_checked_on_every_host(tmp_path):
    """Review r12 (restored in r14.2 after r14.1 dropped it): the lock-file check does not depend on the OS boundary."""
    app = make_app(tmp_path, {"a.sh": "echo a"})
    root = pathlib.Path(app["path"])
    assert sandbox_run.verify_bundle(root, "tools") == (root / "tools").resolve()
    (root / "tools" / "a.sh").write_text("echo changed")
    with pytest.raises(ValueError, match="changed"):
        sandbox_run.verify_bundle(root, "tools")
    app2 = make_app(tmp_path / "two", {"a.sh": "echo a"})
    (pathlib.Path(app2["path"]) / "tools" / "extra.sh").write_text("echo extra")
    with pytest.raises(ValueError, match="differ"):
        sandbox_run.verify_bundle(app2["path"], "tools")


@LINUX
def test_a_failed_isolation_setup_never_starts_the_tool(tmp_path, monkeypatch):
    """r14 review: inject a launcher setup failure through the app-bundle path. An unreadable profile is now refused by
    the runner's own read-back before anything launches (r14.4); a readable, port-free but incomplete profile still
    reaches the launcher, which exits 78. Either way the tool never runs. (Found by the first real Linux smoke.)"""
    real_wrap = sandbox_run.wrap
    app = make_app(tmp_path, {"ran.sh": "echo TOOL_RAN"})

    def wrap_writing(text):
        def broken_wrap(*a, **k):
            argv, prof = real_wrap(*a, **k)
            pathlib.Path(prof).write_text(text)
            return argv, prof
        return broken_wrap

    monkeypatch.setattr(sandbox_run, "wrap", wrap_writing("{not json"))
    with pytest.raises(RuntimeError, match="sandbox unavailable"):
        run(app, "ran.sh", runtime="sh")
    monkeypatch.setattr(sandbox_run, "wrap", wrap_writing('{"connect_ports": []}'))
    monkeypatch.setattr(sandbox_run, "_REACHABLE", {})
    with pytest.raises(RuntimeError, match="not executable inside the sandbox view"):
        run(app, "ran.sh", runtime="sh")                     # the runtime probe runs under the same broken profile
    monkeypatch.setattr(sandbox_run, "_runtime_reachable", lambda kind, exe, reads: True)
    r = run(app, "ran.sh", runtime="sh")                     # past the probe, the launcher still refuses
    assert r["exit"] == 78 and b"TOOL_RAN" not in r["stdout"], r


@SANDBOXED
def test_symlinks_and_truncation_cannot_reach_outside_the_job(tmp_path):
    """r14 review: a symlink from the job to an outside file reads nothing; truncating an outside file fails."""
    canary = tmp_path / "canary.txt"
    canary.write_text("secret")
    app = make_app(tmp_path, {"escape.sh": f'ln -s "{canary}" link; (cat link) 2>/dev/null; (: > "{canary}") 2>/dev/null; '
                                           f'(truncate -s 0 "{canary}") 2>/dev/null; echo end'})
    r = run(app, "escape.sh", runtime="sh")
    assert b"end" in r["stdout"] and b"secret" not in r["stdout"], r
    assert canary.read_text() == "secret"


# ---- r14.4: Mac-runnable seams for the Linux run path ------------------------------------------------------------

def _fakebin(tmp_path, name, prlimit=None):
    """A PATH holding a `uname` that says Linux (so limits.sh takes its Linux branch on any host) and, optionally, a
    `prlimit` script. The seam the earlier rounds used (a PATH of fakes), extended so the Linux branch runs here."""
    d = tmp_path / name
    d.mkdir()
    (d / "uname").write_text("#!/bin/sh\necho Linux\n")
    (d / "uname").chmod(0o755)
    if prlimit is not None:
        (d / "prlimit").write_text("#!/bin/sh\n" + prlimit)
        (d / "prlimit").chmod(0o755)
    return d


COUNTING_PRLIMIT = """n=0; [ -f "$PRL_COUNT" ] && read n < "$PRL_COUNT"; n=$((n+1)); echo "$n" > "$PRL_COUNT"
echo "$*" >> "$PRL_LOG"
[ "$n" -eq "$PRL_FAIL_AT" ] && exit 1
exit 0
"""


def test_limits_are_set_once_on_the_launcher_and_any_failure_is_78(tmp_path):
    """r14.4 (Kimi 1, stand-in 1): limits.sh applies the limits in ONE prlimit operation on itself (--pid of the
    launcher), then execs the tool. Whichever prlimit invocation fails, the launcher exits 78 and the tool never starts;
    prlimit is never the one that runs the tool. On r14.3, a check that succeeded followed by a failing second prlimit
    returned that prlimit's own status (1), not 78."""
    import subprocess
    fake = _fakebin(tmp_path, "fakebin", COUNTING_PRLIMIT)
    runs = []
    for fail_at in (1, 2, 3):
        marker, count, log = tmp_path / f"ran{fail_at}", tmp_path / f"count{fail_at}", tmp_path / f"log{fail_at}"
        env = {"PATH": str(fake), "PRL_COUNT": str(count), "PRL_LOG": str(log), "PRL_FAIL_AT": str(fail_at)}
        tool = ["/bin/sh", "-c", ': > "$0"', str(marker)]
        done = subprocess.run(["/bin/sh", str(sandbox_run.LAUNCHER), "1", "4097", *tool], env=env)
        calls = log.read_text().splitlines() if log.exists() else []
        runs.append((fail_at, done.returncode, marker.exists(), calls, str(marker)))
    for fail_at, code, ran, calls, _ in runs:
        if len(calls) >= fail_at:                       # the failing invocation happened: setup failure
            assert code == 78 and not ran, (fail_at, code, ran, calls)
        else:                                           # every invocation succeeded: the tool ran
            assert code == 0 and ran, (fail_at, code, ran, calls)
    for fail_at, _, _, calls, marker in runs:
        assert len(calls) == 1, calls                   # exactly one setup operation
        assert calls[0].startswith("--pid=") and "--cpu=1" in calls[0] and "--fsize=4097" in calls[0], calls
        assert marker not in calls[0], calls            # prlimit never runs the tool itself


def test_available_is_true_only_when_the_real_run_path_can_execute(tmp_path, monkeypatch):
    """r14.4 (Root, tools-r10 correction): sandbox_run.available() is the predicate run() enforces. With the Linux
    backend it is true only when the launcher's real prlimit path works on the run's PATH; otherwise false, and run()
    refuses before spawning anything."""
    real_backend = backend()
    if real_backend in ("sandbox-exec", "landlock"):
        assert sandbox_run.available() is True          # this host's real run path works
    monkeypatch.setattr(sandbox_run, "backend", lambda: "landlock")
    monkeypatch.setattr(sandbox_run, "RUN_PATH", str(_fakebin(tmp_path, "none")))
    assert sandbox_run.available() is False             # Linux, no prlimit
    monkeypatch.setattr(sandbox_run, "RUN_PATH", str(_fakebin(tmp_path, "broken", "exit 1\n")))
    assert sandbox_run.available() is False             # prlimit cannot set the limits
    spawned = []

    async def no_spawn(*a, **k):
        spawned.append(a)
        raise AssertionError("spawned a tool on a host that cannot run it")

    monkeypatch.setattr(sandbox_run.asyncio, "create_subprocess_exec", no_spawn)
    app = make_app(tmp_path, {"a.sh": "echo a"})
    with pytest.raises(RuntimeError, match="sandbox unavailable"):
        run(app, "a.sh", runtime="sh")
    assert spawned == []
    monkeypatch.setattr(sandbox_run, "RUN_PATH", str(_fakebin(tmp_path, "works", "exit 0\n")))
    assert sandbox_run.available() is True              # a working prlimit
    monkeypatch.setattr(sandbox_run, "backend", lambda: None)
    assert sandbox_run.available() is False
    monkeypatch.setattr(sandbox_run, "backend", lambda: "landlock")
    monkeypatch.setattr(sandbox_run, "LAUNCHER", tmp_path / "missing.sh")
    assert sandbox_run.available() is False


def test_a_bundle_profile_that_allows_network_is_refused(tmp_path, monkeypatch):
    """r14.4 (network isolation for bundle runs): on the Linux path the runner reads back the profile the launcher will
    enforce and refuses, before spawning, unless it lists no relay port. The real wrap() emits connect_ports == []."""
    from hive.supervisor import sandbox
    monkeypatch.setattr(sandbox_run, "backend", lambda: "landlock")
    monkeypatch.setattr(sandbox_run, "available", lambda: True, raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")      # the real wrap() writes a real Linux profile
    monkeypatch.setattr(sandbox_run, "_runtime_reachable", lambda kind, exe, reads: True)   # probed for real in the Linux suite
    spawned = []

    class Spawned(Exception):
        pass

    async def record(*a, **k):
        spawned.append(a)
        raise Spawned()

    monkeypatch.setattr(sandbox_run.asyncio, "create_subprocess_exec", record)
    app = make_app(tmp_path, {"a.sh": "echo a"})
    seen = {}
    real_wrap = sandbox_run.wrap

    def checking_wrap(*a, **k):
        argv, path = real_wrap(*a, **k)
        seen["profile"] = json.loads(pathlib.Path(path).read_text())
        return argv, path

    monkeypatch.setattr(sandbox_run, "wrap", checking_wrap)
    with pytest.raises(Spawned):                        # the real profile has no port: the run proceeds to spawn
        run(app, "a.sh", runtime="sh")
    assert seen["profile"]["connect_ports"] == [] and len(spawned) == 1

    def leaky_wrap(*a, **k):
        argv, path = real_wrap(*a, **k)
        prof = json.loads(pathlib.Path(path).read_text())
        pathlib.Path(path).write_text(json.dumps(dict(prof, connect_ports=[8700])))
        return argv, path

    monkeypatch.setattr(sandbox_run, "wrap", leaky_wrap)
    with pytest.raises(RuntimeError, match="network"):
        run(app, "a.sh", runtime="sh")
    assert len(spawned) == 1                            # nothing more was spawned


def test_admission_probes_the_runtime_on_every_backend(tmp_path, monkeypatch):
    """Kimi runtime-mirror r2: the reachability probe is not Linux-only. On macOS (sandbox-exec) a runtime the
    boundary cannot execute is refused before any job runs, exactly as on Linux."""
    monkeypatch.setattr(sandbox_run, "backend", lambda: "sandbox-exec")
    monkeypatch.setattr(sandbox_run, "available", lambda: True, raising=False)
    seen = []
    monkeypatch.setattr(sandbox_run, "_runtime_reachable", lambda kind, exe, reads: seen.append(kind) or False)

    async def never(*a, **k):
        raise AssertionError("no job may start")

    monkeypatch.setattr(sandbox_run.asyncio, "create_subprocess_exec", never)
    app = make_app(tmp_path, {"a.sh": "echo a"})
    with pytest.raises(RuntimeError, match="not executable inside the sandbox view"):
        run(app, "a.sh", runtime="sh")
    assert seen == ["sandbox-exec"]


def test_the_probe_cache_key_covers_backend_roots_and_interpreter_and_is_bounded(tmp_path, monkeypatch):
    exe = tmp_path / "py"
    exe.write_text("#!/bin/sh\n")
    a = sandbox_run._probe_key("landlock", str(exe), ("/opt/a",))
    assert a != sandbox_run._probe_key("sandbox-exec", str(exe), ("/opt/a",))
    assert a != sandbox_run._probe_key("landlock", str(exe), ("/opt/b",))
    exe.write_text("#!/bin/sh\n# replaced\n")
    assert a != sandbox_run._probe_key("landlock", str(exe), ("/opt/a",))      # interpreter identity changed
    b = sandbox_run._probe_key("landlock", str(exe), ("/opt/a",))
    exe.chmod(0o644)
    assert b != sandbox_run._probe_key("landlock", str(exe), ("/opt/a",))      # exec permission removed (Root r3)
    monkeypatch.setattr(sandbox_run, "_REACHABLE", {})
    monkeypatch.setattr(sandbox_run, "REACHABLE_MAX", 3)
    calls = []

    class Done:
        returncode = 0

    import subprocess as sp
    monkeypatch.setattr(sp, "run", lambda *a, **k: calls.append(a) or Done())
    monkeypatch.setattr(sandbox_run, "backend", lambda: "sandbox-exec")
    for i in range(5):
        assert sandbox_run._runtime_reachable("sandbox-exec", str(exe), (str(tmp_path / f"r{i}"),)) is True
    assert len(sandbox_run._REACHABLE) == 3 and len(calls) == 5


def test_the_roots_check_uses_what_the_sandbox_grants(tmp_path):
    """Kimi runtime-mirror r2 finding 3: the check runs against the granted roots (safe_roots: resolved, never '/' or
    the home folder), not the raw list, so a root the sandbox would drop cannot make a runtime look covered."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    assert str(real.resolve()) in sandbox_run._granted("landlock", [str(link)])
    assert set(sandbox_run._granted("sandbox-exec", ["/", str(pathlib.Path.home())])) == set(sandbox_run.MAC_SYSTEM_READ)
