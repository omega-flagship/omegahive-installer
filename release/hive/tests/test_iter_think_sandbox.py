"""Purpose: test the sandbox an Iter worker's MeTTa runs in while its mind's own coding is off (QA's F1 on
omega-flagship/omegahive#395). Jon on #395: "Thinking in code is allowed by default (calculations, analysis, the mind's
own MeTTa), as a sandboxed tool", with the wall enforced "by what actually runs the code". So the kit's tools/metta.py
reasons and computes free, Python included, while every write the MeTTa tries through Python or Prolog into the tools
the worker's loop loads is refused; the same MeTTa through Iter's own tools/metta.py writes them, so the attempts are
real; and where the sandbox can't be built the hive's gate decides each use, with nothing run before it allows. On a
Mac, which refuses that sandbox inside the mind's own (Jon on #395: "Mac and Linux should behave the same"), the
kit's PeTTa runs as a swipl of its own that the mind's profile gives the same limits, so it runs free there too."""
import importlib.util
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile

import pytest

from hive.supervisor import landlock

ROOT = pathlib.Path(__file__).resolve().parents[2]
KIT = ROOT / "hive/templates/iter"
LIB = ROOT / "hive/supervisor/landlock.py"
PETTA = pathlib.Path(os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa")))
needs_petta = pytest.mark.skipif(not (PETTA / "src" / "main.pl").exists(), reason="needs PeTTa")
needs_landlock = pytest.mark.skipif(landlock.abi_version() < 1, reason="needs Linux Landlock")

# Three ways MeTTa reaches past itself, each writing a file into the worker's tools/ when nothing stops it (probed in
# pinned PeTTa): a shell through Python, a file Python opens, and a shell through any Prolog predicate.
ESCAPES = ('!(py-call (os.system "echo pwned > {tools}/evil_system.py"))',
           '!(py-call (builtins.open "{tools}/evil_open.py" "w"))',
           '!(callPredicate (Predicate (quote (shell "echo pwned > {tools}/evil_prolog.py"))))')


@pytest.fixture
def worker(tmp_path, monkeypatch):
    """An Iter worker's folder as Workspace._iter_home lays it out: HOME is the folder, ~/PeTTa links the PeTTa
    runtime and Omega's NAL and PLN libraries, and the kit's metta and its sandbox are in tools/."""
    root = tmp_path / "worker"
    (root / "tools").mkdir(parents=True)
    (root / "tmp").mkdir()
    (root / "PeTTa").mkdir()
    for name in ("run.sh", "src", "lib"):
        (root / "PeTTa" / name).symlink_to(PETTA / name)
    for name in ("lib_nal.metta", "lib_pln.metta"):
        (root / "PeTTa" / name).symlink_to(ROOT / "third_party/Omega" / name)
    (root / "_hive.py").write_bytes((KIT / "_hive.py").read_bytes())
    for name in ("metta.py", "_think_sandbox.py"):
        (root / "tools" / name).write_bytes((KIT / "tools" / name).read_bytes())
    monkeypatch.setenv("HOME", str(root))
    monkeypatch.setenv("HIVE_THINK_SANDBOX_LIB", str(LIB))
    monkeypatch.setattr(tempfile, "tempdir", str(root / "tmp"))
    return root


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def written(root):
    return sorted(p.name for p in (root / "tools").iterdir() if p.name.startswith("evil_"))


@needs_petta
@needs_landlock
def test_the_kits_metta_reasons_free_but_writes_nothing_the_loop_loads(worker):
    metta = load(worker / "tools/metta.py", "kit_metta")
    # true, true: the NAL and PLN libraries imported inside the sandbox; then MeTTa's sum and Python's square root
    assert metta.run("!(+ 1 2)\n!(py-call (math.sqrt 16))").split() == ["true", "true", "3", "4.0"]
    for escape in ESCAPES:
        metta.run(escape.format(tools=worker / "tools"))
    assert written(worker) == []
    assert sorted(p.name for p in (worker / "PeTTa").iterdir()) == ["lib", "lib_nal.metta", "lib_pln.metta", "run.sh",
                                                                     "src"]   # its code file and scratch are gone
    assert list((worker / "tmp").iterdir()) == []


@needs_petta
def test_the_same_metta_through_iters_own_tool_writes_into_tools(worker):
    """What F1 found: Iter's own tools/metta.py runs the MeTTa unconfined, so each escape lands."""
    (worker / "tools/metta.py").write_bytes((ROOT / "third_party/iter/tools/metta.py").read_bytes())
    metta = load(worker / "tools/metta.py", "iters_own_metta")
    for escape in ESCAPES:
        metta.run(escape.format(tools=worker / "tools"))
    assert written(worker) == ["evil_open.py", "evil_prolog.py", "evil_system.py"]


def test_where_the_sandbox_cant_be_built_the_gate_decides_each_use_and_nothing_runs_first(worker, monkeypatch):
    marker = worker / "ran"
    run_sh = worker / "fake-run.sh"   # stands in for PeTTa: it leaves a marker when it runs
    run_sh.write_text(f'touch "{marker}"; echo ran\n')
    monkeypatch.delenv("HIVE_THINK_SANDBOX_LIB")   # the helper can't find the hive's sandbox: exit 75, nothing ran
    metta = load(worker / "tools/metta.py", "kit_metta_fallback")
    monkeypatch.setattr(metta, "RUN_SH", run_sh)
    asked = []

    def gate(decision):
        def call(method, path, payload=None, timeout=None):
            asked.append(payload["command"])
            return {"decision": decision, "message": "HIVE-ASK a person approves (metta \"!(+ 1 2)\")"}, None
        return call

    monkeypatch.setattr(metta._hive, "call", gate("pending"))
    assert metta.run("!(+ 1 2)") == 'HIVE-ASK a person approves (metta "!(+ 1 2)")'
    assert asked == ['(metta "!(+ 1 2)")'] and not marker.exists()
    monkeypatch.setattr(metta._hive, "call", gate("allow"))
    assert metta.run("!(+ 1 2)").strip() == "ran" and marker.exists()


def test_the_sandbox_helper_runs_nothing_it_cant_confine(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_THINK_SANDBOX_LIB", raising=False)
    marker = tmp_path / "ran"
    done = subprocess.run([sys.executable, "-I", "-B", str(KIT / "tools/_think_sandbox.py"), str(tmp_path), "--",
                           "touch", str(marker)], capture_output=True, text=True)
    assert done.returncode == 75 and done.stderr.startswith("THINK-SANDBOX-UNAVAILABLE") and not marker.exists()


@needs_landlock
def test_restrict_writes_keeps_writes_to_its_folders_and_refuses_tcp_and_unix_sockets(tmp_path):
    """landlock.restrict_writes with deny_unix_sockets, in a child: reads stay, writes go only beneath the folder."""
    inside, outside = tmp_path / "scratch", tmp_path / "outside"
    inside.mkdir()
    code = f"""
import errno, socket, sys
sys.path.insert(0, {str(ROOT)!r})
from hive.supervisor import landlock
landlock.restrict_writes([{str(inside)!r}])
landlock.deny_unix_sockets()
open({str(inside / 'ok')!r}, 'w').write('x')
def refused(act):
    try:
        act()
    except OSError as exc:
        return exc.errno in (errno.EACCES, errno.EPERM)
    return False
print(refused(lambda: open({str(outside)!r}, 'w')), open({str(inside / 'ok')!r}).read(), open({str(LIB)!r}).read(2),
      refused(lambda: socket.socket(socket.AF_UNIX)),
      landlock.abi_version() < landlock.NET_ABI or refused(lambda: socket.create_connection(('127.0.0.1', 9), 1)))
"""
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert done.stdout.split() == ["True", "x", "#!", "True", "True"], done.stderr
    assert not outside.exists()


# ---- macOS: the kit's PeTTa runs as a swipl of its own, which the mind's profile limits -----------------------------

MAC = sys.platform == "darwin" and shutil.which("sandbox-exec") is not None
SWIPL = shutil.which("swipl")


class _Stop(Exception):
    pass


def test_the_mac_profile_gives_the_think_swipl_its_limits_after_every_allow(tmp_path):
    from hive.supervisor import sandbox
    mind = tmp_path / "agents" / "a_1"
    mind.mkdir(parents=True)
    swipl = tmp_path / "bin" / "swipl-think"
    plain = sandbox.profile(mind, [], ports=(8700,))
    text = sandbox.profile(mind, [], ports=(8700,), think=(swipl, "tmp/think"))
    who = f'(process-path "{swipl.resolve()}")'
    assert "process-path" not in plain and text.startswith(plain)
    assert text[len(plain):].splitlines() == [
        f"(deny network-outbound network-inbound network-bind {who})",
        f"(deny process-exec process-fork {who})",
        f'(deny file-write* (require-all {who} (require-not (subpath "{mind.resolve()}/tmp/think"))'
        ' (require-not (literal "/dev/null")) (require-not (literal "/dev/dtracehelper"))))']


def test_the_think_limits_are_refused_where_the_sandbox_cant_keep_them(tmp_path, monkeypatch):
    from hive.supervisor import sandbox
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    with pytest.raises(RuntimeError, match="macOS"):
        sandbox.wrap(["/bin/true"], tmp_path / "m", [], tmp_path / "p", "a_x", think=(tmp_path / "swipl", "tmp/think"))


def test_the_think_swipl_is_a_copy_beside_this_hosts_swipl_made_again_when_that_changes(tmp_path, monkeypatch):
    from hive.supervisor import sandbox
    real = tmp_path / "swipl-home" / "bin" / "swipl"
    real.parent.mkdir(parents=True)
    real.write_text("#!/bin/sh\necho one\n")
    real.chmod(0o755)
    on_path = tmp_path / "path"
    on_path.mkdir()
    (on_path / "swipl").symlink_to(real)   # as Homebrew and the Mac installer link it
    monkeypatch.setenv("PATH", str(on_path))
    copy = sandbox.think_swipl()
    assert copy == real.with_name("swipl-think") and copy.read_text() == real.read_text() and os.access(copy, os.X_OK)
    made = copy.stat().st_ino
    assert sandbox.think_swipl() == copy and copy.stat().st_ino == made   # current: not copied again
    real.write_text("#!/bin/sh\necho two, after an upgrade\n")
    assert sandbox.think_swipl() == copy and copy.read_text() == real.read_text()
    monkeypatch.setenv("PATH", str(tmp_path / "nowhere"))
    assert sandbox.think_swipl() is None
    if os.geteuid() != 0:   # root writes anywhere
        monkeypatch.setenv("PATH", str(on_path))
        copy.unlink()
        real.parent.chmod(0o555)
        try:
            assert sandbox.think_swipl() is None
        finally:
            real.parent.chmod(0o755)


@pytest.mark.parametrize("case", ("off", "on", "no copy"))
def test_a_mac_iter_worker_whose_own_coding_is_off_gets_the_think_swipl_and_its_limits(tmp_path, monkeypatch, case):
    from hive.core.config import load_settings
    from hive.supervisor import drivers, sandbox
    from hive.supervisor.workspace import Workspace
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setenv("HIVE_ALLOW_LOCAL_ITER", "1")
    monkeypatch.setattr(sandbox, "backend", lambda: "sandbox-exec")
    monkeypatch.setattr(drivers, "sandbox_backend", lambda: "sandbox-exec")
    monkeypatch.setattr(drivers, "sandbox_available", lambda: True)
    swipl = tmp_path / "swipl-home" / "swipl-think"
    monkeypatch.setattr(drivers, "think_swipl", lambda: None if case == "no copy" else swipl)
    seen = {}

    def popen(argv, **kwargs):
        seen.update(argv=argv, env=kwargs["env"])
        raise _Stop()

    monkeypatch.setattr(drivers.subprocess, "Popen", popen)
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw")
    driver = drivers.LocalDriver(Workspace(settings), settings.petta_path)
    monkeypatch.setattr(driver.workspace, "command", lambda agent, petta: ["/bin/echo", "worker"])
    root = driver.workspace.path("a_iter")
    root.mkdir(parents=True, exist_ok=True)
    with pytest.raises(_Stop):
        driver.start({"id": "a_iter", "kind": "iter", "options": {"own_coding": True} if case == "on" else {}}, {})
    assert seen["argv"][:2] == ["sandbox-exec", "-f"]
    limited = case == "off"
    assert (f'(process-path "{swipl.resolve()}")' in pathlib.Path(seen["argv"][2]).read_text()) is limited
    assert seen["env"].get("HIVE_THINK_SWIPL") == (str(swipl) if limited else None)
    assert seen["env"].get("HIVE_THINK_SCRATCH") == (str(root / "tmp" / "think") if limited else None)
    assert (root / "tmp" / "think").is_dir() is limited


def test_with_a_think_swipl_the_metta_runs_it_with_run_shs_arguments_and_asks_no_one(worker, monkeypatch):
    """On a Mac the kit runs run.sh's swipl command itself, with the swipl the mind's profile limits, its scratch in
    the folder that profile lets it write, and nobody is asked."""
    seen, fake = worker / "argv", worker / "fake-swipl"
    fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" "$TMPDIR" > "{seen}"\necho ran\n')
    fake.chmod(0o755)
    (worker / "tmp" / "think").mkdir()
    monkeypatch.setenv("HIVE_THINK_SWIPL", str(fake))
    monkeypatch.setenv("HIVE_THINK_SCRATCH", str(worker / "tmp" / "think"))
    metta = load(worker / "tools/metta.py", "kit_metta_think")
    asked = []
    monkeypatch.setattr(metta._hive, "call", lambda *a, **k: asked.append(a) or ({"decision": "pending"}, None))
    assert metta.run("!(+ 1 2)").strip() == "ran" and asked == []
    args = seen.read_text().splitlines()
    assert args[:5] == ["--stack_limit=8g", "-q", "-s", str(worker / "PeTTa/src/main.pl"), "--"]
    assert args[5].startswith(str(worker / "PeTTa/tmp_metta_")) and args[6] == "-s"
    assert args[7].startswith(str(worker / "tmp/think/think-"))   # TMPDIR: its scratch, gone after the run
    assert list((worker / "tmp" / "think").iterdir()) == []


@needs_petta
@pytest.mark.skipif(SWIPL is None, reason="needs swipl")
def test_run_shs_swipl_command_as_the_kit_gives_it_runs_petta(worker, monkeypatch):
    """The command the kit gives the think swipl is run.sh's: with this host's swipl it loads NAL and PLN and
    computes."""
    (worker / "tmp" / "think").mkdir()
    monkeypatch.setenv("HIVE_THINK_SWIPL", SWIPL)
    monkeypatch.setenv("HIVE_THINK_SCRATCH", str(worker / "tmp" / "think"))
    metta = load(worker / "tools/metta.py", "kit_metta_think_real")
    assert metta.run("!(+ 1 2)\n!(py-call (math.sqrt 16))").split() == ["true", "true", "3", "4.0"]


@pytest.mark.skipif(not (MAC and SWIPL and (PETTA / "src" / "main.pl").exists()), reason="macOS with swipl and PeTTa")
def test_on_a_mac_the_kits_petta_gets_the_limits_linux_gives_it(worker, tmp_path):
    """Under the real profile, the kit's MeTTa computes as its own swipl, while each way out, a write into tools/ or
    memory/, a program, or a connection to the hive's port, is refused; the worker's own process keeps the last two."""
    from hive.supervisor.sandbox import profile, runtime_roots, think_swipl
    swipl = think_swipl()
    assert swipl is not None
    (worker / "memory").mkdir()
    (worker / "tmp" / "think").mkdir()
    hive = socket.create_server(("127.0.0.1", 0))   # stands in for the hive's own port
    port = hive.getsockname()[1]
    roots = runtime_roots(str(PETTA), ROOT) + [sys.prefix, sys.base_prefix, str(PETTA), str(ROOT / "third_party/Omega")]
    sb = tmp_path / "mind.sb"
    sb.write_text(profile(worker, roots, ports=(port,), think=(swipl, "tmp/think")))
    env = {"HOME": str(worker), "PATH": os.environ["PATH"], "TMPDIR": str(worker / "tmp"),
           "HIVE_THINK_SWIPL": str(swipl), "HIVE_THINK_SCRATCH": str(worker / "tmp" / "think")}

    def think(code):
        probe = ("import importlib.util, sys; s = importlib.util.spec_from_file_location('m', sys.argv[1]); "
                 "m = importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.run(sys.argv[2]))")
        done = subprocess.run(["sandbox-exec", "-f", str(sb), sys.executable, "-c", probe,
                               str(worker / "tools/metta.py"), code], capture_output=True, text=True, env=env,
                              timeout=120)
        return done.stdout + done.stderr

    try:
        assert think("!(+ 1 2)\n!(py-call (math.sqrt 16))").split()[:4] == ["true", "true", "3", "4.0"]
        for escape in (*ESCAPES, '!(py-call (builtins.open "{memory}/note.txt" "w"))',
                       f'!(py-call (socket.create_connection (127.0.0.1 {port})))'):
            think(escape.format(tools=worker / "tools", memory=worker / "memory"))
        assert written(worker) == [] and list((worker / "memory").iterdir()) == []
        assert "py_socket" not in think("!(py-call (socket.create_server (127.0.0.1 0)))")   # no port of its own
        hive.settimeout(0.5)
        with pytest.raises(socket.timeout):
            hive.accept()   # nothing from the MeTTa reached the port
        worker_side = subprocess.run(
            ["sandbox-exec", "-f", str(sb), sys.executable, "-c",
             f"import socket, pathlib; socket.create_connection(('127.0.0.1', {port}), 3); "
             f"pathlib.Path({str(worker / 'memory/w.txt')!r}).write_text('w'); print('worker ok')"],
            capture_output=True, text=True, env=env, timeout=60)
        assert worker_side.stdout.strip() == "worker ok", worker_side.stderr[-500:]
    finally:
        hive.close()
