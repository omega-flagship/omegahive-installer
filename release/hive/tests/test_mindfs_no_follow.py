"""The hive never follows a link a mind planted in its own folder (hive/supervisor/mindfs.py).

A mind is OS-sandboxed and may write anything inside <data>/agents/<id>/, links included; the hive is not sandboxed.
For every place the hive writes, reads or deletes inside a mind folder, a symlink (and a hard link where one can be
made) pointing outside is planted and the outside target must stay untouched and undisclosed. No network.
"""
import contextlib
import json
import os
import stat
import subprocess
import sys
from types import SimpleNamespace

import pytest

from hive.supervisor import mindfs
from hive.supervisor.mindfs import UnsafeMindPath
from hive.supervisor.workspace import iter_kit_digest

SECRET = "outside-secret-do-not-touch\n"


@pytest.fixture
def mind(tmp_path):
    root = tmp_path / "data" / "agents" / "a_mind"
    root.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    target = outside / "target.txt"
    target.write_text(SECRET)
    return SimpleNamespace(root=root, outside=outside, target=target, tmp=tmp_path)


def untouched(m):
    assert m.target.read_text() == SECRET
    assert sorted(p.name for p in m.outside.iterdir()) == ["target.txt"], "nothing was created outside"


def hardlink_or_skip(src, dst):
    try:
        os.link(src, dst)
    except OSError as exc:  # pragma: no cover - a filesystem without hard links
        pytest.skip(f"no hard links here ({exc})")


def regular(path):
    st = os.lstat(path)
    return stat.S_ISREG(st.st_mode) and st.st_nlink == 1


# ---- the primitives ----------------------------------------------------------------------------------------------

def test_write_replaces_a_symlinked_file_and_never_writes_through(mind):
    (mind.root / "run.metta").symlink_to(mind.target)
    mindfs.write_text(mind.root, "run.metta", "new")
    untouched(mind)
    assert regular(mind.root / "run.metta") and (mind.root / "run.metta").read_text() == "new"


def test_write_replaces_a_hardlinked_file_and_never_writes_through(mind):
    hardlink_or_skip(mind.target, mind.root / "token")
    mindfs.write_text(mind.root, "token", "tok")
    untouched(mind)
    assert regular(mind.root / "token") and (mind.root / "token").read_text() == "tok"
    assert stat.S_IMODE(os.stat(mind.root / "token").st_mode) == 0o600


def test_a_symlinked_directory_on_the_way_is_refused(mind):
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)
    for call in (lambda: mindfs.write_text(mind.root, "memory/prompt.txt", "x"),
                 lambda: mindfs.ensure_dir(mind.root, "memory/runtime"),
                 lambda: mindfs.read_bytes(mind.root, "memory/target.txt"),
                 lambda: mindfs.open_write(mind.root, "memory/target.txt", append=True),
                 lambda: mindfs.unlink(mind.root, "memory/target.txt"),
                 lambda: mindfs.listdir(mind.root, "memory"),
                 lambda: mindfs.symlink(mind.root, "memory/link", "/"),
                 lambda: mindfs.remove_tree(mind.root, "memory/target.txt")):
        with pytest.raises(UnsafeMindPath):
            call()
    untouched(mind)
    assert (mind.root / "memory").is_symlink()


def test_a_file_where_a_directory_is_expected_is_refused(mind):
    (mind.root / "memory").write_text("not a dir")
    with pytest.raises(UnsafeMindPath):
        mindfs.write_text(mind.root, "memory/prompt.txt", "x")


def test_a_symlinked_root_is_refused(mind):
    link = mind.tmp / "data" / "agents" / "a_link"
    link.symlink_to(mind.outside, target_is_directory=True)
    with pytest.raises(UnsafeMindPath):
        mindfs.write_text(link, "token", "x")
    with pytest.raises(UnsafeMindPath):
        mindfs.read_bytes(link, "target.txt")
    untouched(mind)


def test_append_open_recreates_a_symlinked_or_hardlinked_log(mind):
    (mind.root / "agent.log").symlink_to(mind.target)
    fd = mindfs.open_write(mind.root, "agent.log", append=True)
    os.write(fd, b"line\n")
    os.close(fd)
    untouched(mind)
    assert regular(mind.root / "agent.log") and (mind.root / "agent.log").read_text() == "line\n"
    os.unlink(mind.root / "agent.log")
    hardlink_or_skip(mind.target, mind.root / "agent.log")
    fd = mindfs.open_write(mind.root, "agent.log", append=True)
    os.write(fd, b"two\n")
    os.close(fd)
    untouched(mind)
    assert regular(mind.root / "agent.log") and (mind.root / "agent.log").read_text() == "two\n"


def test_append_open_keeps_a_plain_log_and_appends(mind):
    (mind.root / "agent.log").write_text("old\n")
    fd = mindfs.open_write(mind.root, "agent.log", append=True)
    os.write(fd, b"new\n")
    os.close(fd)
    assert (mind.root / "agent.log").read_text() == "old\nnew\n"


def test_a_fifo_never_blocks_the_hive(mind):
    os.mkfifo(mind.root / "agent.log")
    with pytest.raises(UnsafeMindPath):
        mindfs.read_bytes(mind.root, "agent.log")           # O_NONBLOCK: no reader wait
    fd = mindfs.open_write(mind.root, "agent.log", append=True)
    os.close(fd)
    assert regular(mind.root / "agent.log")


def test_reads_refuse_links_and_hard_links(mind):
    (mind.root / "token").symlink_to(mind.target)
    with pytest.raises(UnsafeMindPath):
        mindfs.read_text(mind.root, "token")
    with pytest.raises(UnsafeMindPath):
        mindfs.tail_bytes(mind.root, "token", 10)
    os.unlink(mind.root / "token")
    hardlink_or_skip(mind.target, mind.root / "token")
    with pytest.raises(UnsafeMindPath):
        mindfs.read_text(mind.root, "token")
    with pytest.raises(FileNotFoundError):
        mindfs.read_text(mind.root, "missing")


def test_symlink_replaces_files_and_links_but_never_a_real_directory(mind):
    mindfs.symlink(mind.root, "repos/core", mind.outside)
    assert os.readlink(mind.root / "repos" / "core") == str(mind.outside)
    (mind.root / "repos" / "core").unlink()
    (mind.root / "repos" / "core").write_text("x")
    mindfs.symlink(mind.root, "repos/core", mind.outside)
    assert (mind.root / "repos" / "core").is_symlink()
    (mind.root / "repos" / "real").mkdir()
    with pytest.raises(UnsafeMindPath):
        mindfs.symlink(mind.root, "repos/real", mind.outside)
    assert (mind.root / "repos" / "real").is_dir() and not (mind.root / "repos" / "real").is_symlink()
    assert mindfs.readlink(mind.root, "repos/core") == str(mind.outside)
    assert mindfs.readlink(mind.root, "repos/real") is None
    untouched(mind)


def test_remove_tree_unlinks_links_and_never_follows_them(mind):
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)
    mindfs.remove_tree(mind.root, "memory")
    assert not os.path.lexists(mind.root / "memory")
    untouched(mind)
    memory = mind.root / "memory"
    (memory / "deep").mkdir(parents=True)
    (memory / "deep" / "out").symlink_to(mind.outside, target_is_directory=True)
    (memory / "file").symlink_to(mind.target)
    hardlink_or_skip(mind.target, memory / "hard")
    mindfs.remove_tree(mind.root, "memory")
    assert not os.path.lexists(memory)
    untouched(mind)
    mindfs.remove_tree(mind.root, "memory")                    # missing is fine
    mindfs.remove_tree(mind.tmp / "data" / "agents" / "a_gone", "memory")


def test_copy_tree_replaces_symlinked_destination_dirs_and_files(mind, tmp_path):
    src = tmp_path / "template"
    (src / "memory").mkdir(parents=True)
    (src / "memory" / "hive.txt").write_text("note")
    (src / "tools").mkdir()
    (src / "tools" / "send.py").write_text("print(1)")
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)
    (mind.root / "tools").mkdir()
    (mind.root / "tools" / "send.py").symlink_to(mind.target)
    mindfs.copy_tree(src, mind.root)
    untouched(mind)
    assert (mind.root / "memory").is_dir() and not (mind.root / "memory").is_symlink()
    assert (mind.root / "memory" / "hive.txt").read_text() == "note"
    assert regular(mind.root / "tools" / "send.py") and (mind.root / "tools" / "send.py").read_text() == "print(1)"


def test_iter_files_skips_links_and_hard_links(mind):
    (mind.root / "memory").mkdir()
    (mind.root / "memory" / "a.metta").write_text("(a)")
    (mind.root / "memory" / "link.metta").symlink_to(mind.target)
    (mind.root / "outdir").symlink_to(mind.outside, target_is_directory=True)
    hardlink_or_skip(mind.target, mind.root / "memory" / "hard.metta")
    seen = {"/".join(parts): data for parts, data, _ in mindfs.iter_files(mind.root)}
    assert seen == {"memory/a.metta": b"(a)"}


def test_relative_paths_cannot_escape(mind):
    for bad in ("../x", "/etc/passwd", "a/../../x", "a\0b"):
        with pytest.raises(ValueError):
            mindfs.write_text(mind.root, bad, "x")


# ---- the workspace (hive/supervisor/workspace.py) ------------------------------------------------------------------

def _workspace(m):
    from hive.supervisor.workspace import Workspace
    core = m.tmp / "core"
    (core / "memory").mkdir(parents=True)
    chroma = m.tmp / "chroma"
    chroma.mkdir()
    settings = SimpleNamespace(agents_dir=m.root.parent, data_dir=m.tmp / "data", core_root=core, petta_path=m.tmp)
    ws = Workspace(settings)
    ws.runtime_core = lambda: core
    ws.chromadb_lib = lambda: chroma
    return ws


AGENT = {"id": "a_mind", "name": "Lyra", "kind": "omega", "role_prompt": "r", "persona": "p"}


def test_create_writes_nothing_through_planted_file_links(mind):
    ws = _workspace(mind)
    (mind.root / "memory").mkdir()
    (mind.root / "repos").mkdir()
    for rel in ("token", "run.metta", "memory/prompt.txt", "memory/tools-loader.metta", "memory/tools-signatures.metta",
                "memory/tools-affordance.metta", "repos/OmegaClaw-Core"):
        (mind.root / rel).symlink_to(mind.target)
    hardlink_or_skip(mind.target, mind.root / "repos" / "petta_lib_chromadb")
    ws.create(AGENT, "tok-123")
    untouched(mind)
    for rel in ("token", "run.metta", "memory/prompt.txt", "memory/tools-loader.metta"):
        assert regular(mind.root / rel), rel
    assert (mind.root / "token").read_text() == "tok-123"
    assert os.readlink(mind.root / "repos" / "OmegaClaw-Core") == str((mind.tmp / "core").resolve())
    assert ws.token("a_mind") == "tok-123"
    ws.refresh_runtime(AGENT)                                 # already right: left alone
    assert os.readlink(mind.root / "repos" / "OmegaClaw-Core") == str((mind.tmp / "core").resolve())


@pytest.mark.parametrize("planted", ["memory", "repos"])
def test_create_refuses_a_symlinked_memory_or_repos_dir(mind, planted):
    ws = _workspace(mind)
    (mind.root / planted).symlink_to(mind.outside, target_is_directory=True)
    with pytest.raises(UnsafeMindPath):
        ws.create(AGENT, "tok")
    untouched(mind)


def test_refresh_runtime_never_replaces_a_real_directory_or_follows_repos(mind):
    ws = _workspace(mind)
    (mind.root / "repos" / "OmegaClaw-Core").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="real directory"):
        ws.refresh_runtime(AGENT)
    (mind.root / "repos" / "OmegaClaw-Core").rmdir()
    (mind.root / "repos").rmdir()
    (mind.root / "repos").symlink_to(mind.outside, target_is_directory=True)
    with pytest.raises((RuntimeError, UnsafeMindPath)):
        ws.refresh_runtime(AGENT)
    untouched(mind)


def test_write_prompt_and_iter_note_never_write_through(mind):
    ws = _workspace(mind)
    (mind.root / "memory").mkdir()
    (mind.root / "memory" / "prompt.txt").symlink_to(mind.target)
    (mind.root / "memory" / "hive.txt").symlink_to(mind.target)
    ws.write_prompt(AGENT)
    ws.write_iter_note(dict(AGENT, kind="iter"))
    untouched(mind)
    assert "Lyra" in (mind.root / "memory" / "prompt.txt").read_text()
    assert regular(mind.root / "memory" / "hive.txt")


def _iter_clones(ws, tmp_path):
    """Pinned Iter clones as setup leaves them: the omega branch with the Git metadata and outside-chat channel a
    worker never gets, and the metta branch's loop."""
    src, metta = tmp_path / "iter-src", tmp_path / "iter-metta-src"
    for base, names in ((src, ("iter.py", "prompt.txt", "tools/send.py", "tools/nop.py", "tools/metta.py", "irc.py",
                               ".git/config")),
                        (metta, ("iter.metta", "utils.metta", "utils.py", "tools/metta.py"))):
        for name in names:
            (base / name).parent.mkdir(parents=True, exist_ok=True)
            (base / name).write_text(f"# {base.name} {name}\n")
    (metta / "iter.metta").write_text("# loop\n(= (MAX_TOOLS) 30)\n")
    (ws.settings.core_root / "core-dependency.json").write_text(json.dumps(
        {"revision": "a" * 40, "iter": {"revision": "b" * 40}, "iter_metta": {"revision": "c" * 40}}))
    ws.iter_source = lambda key="iter": metta if key == "iter_metta" else src


def test_create_iter_replaces_planted_links_in_the_copy(mind, tmp_path):
    ws = _workspace(mind)
    _iter_clones(ws, tmp_path)
    (mind.root / "tools").symlink_to(mind.outside, target_is_directory=True)
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)
    (mind.root / "iter.py").symlink_to(mind.target)
    (mind.root / ".iter_revision").symlink_to(mind.target)      # a planted stamp is neither believed nor written through
    (mind.root / "iter").symlink_to(mind.outside, target_is_directory=True)
    ws.create(dict(AGENT, kind="iter"), "tok-iter")
    untouched(mind)
    assert (mind.root / "iter.py").read_text() == "# iter-src iter.py\n" and regular(mind.root / "iter.py")
    assert (mind.root / "tools").is_dir() and not (mind.root / "tools").is_symlink()
    assert (mind.root / "memory" / "hive.txt").is_file() and not (mind.root / "memory").is_symlink()
    assert (mind.root / "token").read_text() == "tok-iter"
    assert not (mind.root / "irc.py").exists() and not (mind.root / ".git").exists()
    assert regular(mind.root / ".iter_revision") and (mind.root / ".iter_revision").read_text() == "b" * 40 + "+kit:" + iter_kit_digest()
    assert os.readlink(mind.root / "iter") == "."
    assert os.readlink(mind.root / "PeTTa" / "run.sh") == str((tmp_path / "run.sh").resolve())


def test_a_metta_iter_takes_the_loop_and_drops_iter_py_without_following_links(mind, tmp_path):
    ws = _workspace(mind)
    _iter_clones(ws, tmp_path)
    metta = dict(AGENT, kind="iter", options={"iter_variant": "metta"})
    ws.create(metta, "tok-iter")
    (mind.root / ".iter_revision").unlink()           # the pin moved: the next start copies again
    (mind.root / "iter.py").symlink_to(mind.target)   # and what the Iter planted meanwhile is replaced, never followed
    (mind.root / "iter.metta").unlink()
    (mind.root / "iter.metta").symlink_to(mind.target)
    ws.sync_iter(metta)
    untouched(mind)
    assert not (mind.root / "iter.py").exists() and not (mind.root / "iter.py").is_symlink()
    assert regular(mind.root / "iter.metta") and "(= (MAX_TOOLS) 40)" in (mind.root / "iter.metta").read_text()
    assert (mind.root / "tools" / "metta.py").read_text() == "# iter-metta-src tools/metta.py\n"
    assert (mind.root / ".iter_revision").read_text() == "b" * 40 + "+" + "c" * 40 + "+tools/metta.py+kit:" + iter_kit_digest()


def test_studio_skills_never_read_or_write_through_run_metta(mind):
    ws = _workspace(mind)
    mind.target.write_text("!(omegaclaw)\n")
    (mind.root / "run.metta").symlink_to(mind.target)
    with pytest.raises(UnsafeMindPath):
        ws.write_studio_skills(AGENT, True)
    assert mind.target.read_text() == "!(omegaclaw)\n"


def test_the_credential_read_discloses_no_outside_file(mind):
    ws = _workspace(mind)
    (mind.root / "token").symlink_to(mind.target)
    with pytest.raises(UnsafeMindPath):
        ws.token("a_mind")
    os.unlink(mind.root / "token")
    hardlink_or_skip(mind.target, mind.root / "token")
    with pytest.raises(UnsafeMindPath):
        ws.token("a_mind")
    os.unlink(mind.root / "token")
    (mind.root / "current").write_text("2")
    (mind.root / "token-e2").symlink_to(mind.target)
    with pytest.raises(UnsafeMindPath):
        ws.token("a_mind")
    os.unlink(mind.root / "current")
    (mind.root / "current").symlink_to(mind.target)
    with pytest.raises(RuntimeError):
        ws.token("a_mind")


# ---- the local driver (hive/supervisor/drivers.py) -----------------------------------------------------------------

class FakeWorkspace:
    def __init__(self, root, command):
        self.root, self._command = root, command
        self.settings = SimpleNamespace(data_dir=root.parent.parent, core_root=root.parent.parent, petta_path="/nonexistent")

    def path(self, agent_id):
        return self.root

    def command(self, agent, petta_path):
        return self._command


def _start_and_wait(driver, agent_id="a_mind"):
    driver.start({"id": agent_id, "kind": "omega"}, {})
    driver.procs[agent_id].wait(timeout=20)


def test_agent_log_symlink_is_replaced_and_the_target_untouched(mind, monkeypatch):
    from hive.supervisor.drivers import LocalDriver
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")   # unsandboxed on purpose: unset now means the sandbox is on
    (mind.root / "agent.log").symlink_to(mind.target)
    d = LocalDriver(FakeWorkspace(mind.root, ["/bin/sh", "-c", "echo from-the-mind"]), "/nonexistent")
    _start_and_wait(d)
    untouched(mind)
    assert regular(mind.root / "agent.log") and "from-the-mind" in (mind.root / "agent.log").read_text()
    assert regular(mind.root / "mind.pid")
    assert d.logs("a_mind", 10) == ["from-the-mind"]


def test_the_pid_record_is_never_written_read_or_removed_through_a_link(mind):
    from hive.supervisor.drivers import LocalDriver, ProcessObservationError
    d = LocalDriver(FakeWorkspace(mind.root, []), "/nonexistent")
    (mind.root / "mind.pid").symlink_to(mind.outside / "pid-target")      # dangling: must not be created outside
    d._pidfile("a_mind").write_text("123")
    untouched(mind)
    assert regular(mind.root / "mind.pid")
    os.unlink(mind.root / "mind.pid")
    mind.target.write_text("4242")
    (mind.root / "mind.pid").symlink_to(mind.target)
    with pytest.raises(ProcessObservationError):                          # unknown, as for any unreadable record
        d.status("a_mind")
    d._pidfile("a_mind").unlink()
    assert not os.path.lexists(mind.root / "mind.pid") and mind.target.read_text() == "4242"


def test_agent_log_hardlink_is_replaced_and_the_target_untouched(mind, monkeypatch):
    from hive.supervisor.drivers import LocalDriver
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")   # unsandboxed on purpose: unset now means the sandbox is on
    hardlink_or_skip(mind.target, mind.root / "agent.log")
    d = LocalDriver(FakeWorkspace(mind.root, ["/bin/sh", "-c", "echo hard"]), "/nonexistent")
    _start_and_wait(d)
    untouched(mind)
    assert regular(mind.root / "agent.log") and (mind.root / "agent.log").read_text() == "hard\n"


def test_logs_api_never_reads_a_linked_agent_log(mind):
    from hive.supervisor.drivers import LocalDriver
    d = LocalDriver(FakeWorkspace(mind.root, []), "/nonexistent")
    (mind.root / "agent.log").symlink_to(mind.target)
    assert d.logs("a_mind", 10) == []
    os.unlink(mind.root / "agent.log")
    hardlink_or_skip(mind.target, mind.root / "agent.log")
    assert d.logs("a_mind", 10) == []
    assert all(SECRET.strip() not in line for line in d.logs("a_mind", 10))


def test_a_symlinked_tmp_dir_refuses_the_start(mind, monkeypatch):
    from hive.supervisor.drivers import LocalDriver
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")   # unsandboxed on purpose: unset now means the sandbox is on
    (mind.root / "tmp").symlink_to(mind.outside, target_is_directory=True)
    d = LocalDriver(FakeWorkspace(mind.root, ["/bin/sh", "-c", "touch \"$TMPDIR/x\""]), "/nonexistent")
    with pytest.raises(UnsafeMindPath):
        d.start({"id": "a_mind", "kind": "omega"}, {})
    assert "a_mind" not in d.procs
    untouched(mind)


def test_only_the_log_reaches_the_child(mind, monkeypatch):
    """The child inherits stdout/stderr = the safely opened agent.log, stdin /dev/null, and no other descriptor."""
    from hive.supervisor import drivers
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "0")   # unsandboxed on purpose: unset now means the sandbox is on
    seen = {}
    real = drivers.subprocess.Popen

    def popen(argv, **kwargs):
        seen.update(kwargs)
        st = os.fstat(kwargs["stdout"])
        seen["regular"] = stat.S_ISREG(st.st_mode) and st.st_nlink == 1
        return real(argv, **kwargs)

    monkeypatch.setattr(drivers.subprocess, "Popen", popen)
    d = drivers.LocalDriver(FakeWorkspace(mind.root, ["/bin/sh", "-c", "true"]), "/nonexistent")
    _start_and_wait(d)
    assert seen["regular"] and seen["stderr"] == subprocess.STDOUT and seen["stdin"] == subprocess.DEVNULL
    assert seen.get("close_fds", True) and "pass_fds" not in seen


def test_docker_refuses_to_mount_a_linked_memory_or_run_metta(mind, monkeypatch):
    from hive.supervisor.drivers import DockerDriver, StartRefused
    ws = _workspace(mind)
    d = DockerDriver(ws)
    calls = []
    monkeypatch.setattr(d, "_docker", lambda *a, **k: calls.append(a) or SimpleNamespace(returncode=1, stdout=""))
    monkeypatch.setattr(d, "status", lambda agent_id: "absent")
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)
    with pytest.raises(StartRefused):
        d.start(AGENT, {})
    assert not any(a and a[0] == "run" for a in calls)
    os.unlink(mind.root / "memory")
    (mind.root / "memory").mkdir()
    (mind.root / "run.metta").symlink_to(mind.target)
    with pytest.raises(StartRefused):
        d.start(AGENT, {})
    untouched(mind)


# ---- hive-side readers and writers (placement, memory API, archive, research, Studio credentials) -----------------

def test_write_body_never_writes_through(mind):
    from hive.core.placement import Placement
    (mind.root / "memory" / "runtime" / "body").mkdir(parents=True)
    (mind.root / "memory" / "runtime" / "body" / "host.json").symlink_to(mind.target)
    fake = SimpleNamespace(hive=SimpleNamespace(settings=SimpleNamespace(data_dir=mind.tmp / "data")),
                           _workspace_guard=lambda agent_id: contextlib.nullcontext(),
                           identity=lambda: {"id": "h_1", "name": "Home", "home": True, "owner": None})
    Placement.write_body(fake, "a_mind")
    untouched(mind)
    assert json.loads((mind.root / "memory" / "runtime" / "body" / "host.json").read_text())["hive_id"] == "h_1"
    os.unlink(mind.root / "memory" / "runtime" / "body" / "host.json")
    os.rmdir(mind.root / "memory" / "runtime" / "body")
    (mind.root / "memory" / "runtime" / "body").symlink_to(mind.outside, target_is_directory=True)
    with pytest.raises(UnsafeMindPath):
        Placement.write_body(fake, "a_mind")
    untouched(mind)


def test_memory_api_never_discloses_a_linked_space(mind):
    from hive.core.hive import Hive
    fake = SimpleNamespace(MEMORY_SKIP=Hive.MEMORY_SKIP, _atoms=Hive._atoms,
                           _memory_dir=lambda agent_id: mind.root / "memory")
    fake._memory_read = lambda agent_id, name: Hive._memory_read(fake, agent_id, name)
    (mind.root / "memory").mkdir()
    (mind.root / "memory" / "mine.metta").write_text("(a b)\n(c d)\n")
    mind.target.write_text("(secret atom)\n")
    (mind.root / "memory" / "leak.metta").symlink_to(mind.target)
    hardlink_or_skip(mind.target, mind.root / "memory" / "hard.metta")
    spaces = Hive.memory_spaces(fake, "a_mind")
    assert [s["name"] for s in spaces] == ["mine"] and spaces[0]["atoms"] == 2
    from hive.core.hive import HiveError
    for space in ("leak", "hard"):
        with pytest.raises(HiveError):
            Hive.memory_atoms(fake, "a_mind", space)
    assert [r["text"] for r in Hive.memory_atoms(fake, "a_mind", "mine")] == ["(a b)", "(c d)"]
    os.rename(mind.root / "memory", mind.root / "memory.real")
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)
    assert Hive.memory_spaces(fake, "a_mind") == []
    with pytest.raises(HiveError):
        Hive.memory_atoms(fake, "a_mind", "target")


def test_log_rotation_never_reads_or_empties_a_linked_log(mind):
    from hive.core.archive import Archive
    fake_hive = SimpleNamespace(db=SimpleNamespace(execute=lambda *a, **k: None),
                                settings=SimpleNamespace(data_dir=mind.tmp / "data", agents_dir=mind.root.parent))
    archive = Archive(fake_hive)
    mind.target.write_text(SECRET * 100)
    (mind.root / "agent.log").symlink_to(mind.target)
    assert archive.rotate_logs(limit=10) == []
    hard = mind.root.parent / "a_hard"
    hard.mkdir()
    hardlink_or_skip(mind.target, hard / "agent.log")
    assert archive.rotate_logs(limit=10) == []
    assert mind.target.read_text() == SECRET * 100
    assert not (mind.tmp / "data" / "archive" / "logs").exists()
    plain = mind.root.parent / "a_plain"
    plain.mkdir()
    (plain / "agent.log").write_text("x" * 50)
    rolled = archive.rotate_logs(limit=10)
    assert [r["agent_id"] for r in rolled] == ["a_plain"] and (plain / "agent.log").read_text() == ""


def test_research_erase_removes_a_linked_memory_without_following_it(mind):
    from hive.core.research import Research
    (mind.root / "memory").symlink_to(mind.outside, target_is_directory=True)

    class DB:
        def secure_writes(self):
            return contextlib.nullcontext()

        def transaction(self):
            return contextlib.nullcontext()

        def execute(self, *a):
            return None

        def one(self, *a):
            return None

    fake = SimpleNamespace(db=DB(), hive=SimpleNamespace(settings=SimpleNamespace(agents_dir=mind.root.parent), archive=None))
    Research._erase(fake, "a_mind")
    assert not os.path.lexists(mind.root / "memory")
    untouched(mind)
    (mind.root / "memory" / "sub").mkdir(parents=True)
    (mind.root / "memory" / "sub" / "out").symlink_to(mind.outside, target_is_directory=True)
    (mind.root / "memory" / "t").symlink_to(mind.target)
    Research._erase(fake, "a_mind")
    assert not os.path.lexists(mind.root / "memory")
    untouched(mind)


def test_studio_credential_files_never_follow_links(mind):
    from hive.core import studio_handoff as sh
    # write_fsync (pending token, current.tmp): a planted link is replaced, never written through
    (mind.root / "current.tmp").symlink_to(mind.target)
    sh.write_fsync(mind.root / "current.tmp", "3")
    untouched(mind)
    assert regular(mind.root / "current.tmp") and (mind.root / "current.tmp").read_text() == "3"
    hardlink_or_skip(mind.target, mind.root / "pending-token-e3")
    sh.write_fsync(mind.root / "pending-token-e3", "tok")
    untouched(mind)
    assert regular(mind.root / "pending-token-e3")
    # reads (hash, epoch) never disclose a linked file
    (mind.root / "token-e2").symlink_to(mind.target)
    assert sh.file_hash(mind.root / "token-e2") is None
    (mind.root / "current").symlink_to(mind.target)
    assert sh._read_epoch(mind.root / "current") is None
    # cleanup unlinks the entries, never their targets
    removed = sh.cleanup(mind.root, 5)
    assert "token-e2" in removed and not os.path.lexists(mind.root / "token-e2")
    untouched(mind)
    sh.dir_fsync(mind.root)
    os.unlink(mind.root / "current")
    sh.point(mind.root, 3)
    assert (mind.root / "current").read_text() == "3" and regular(mind.root / "current")


# ---- under the real macOS sandbox --------------------------------------------------------------------------------

def _sandbox_available():
    try:
        from hive.supervisor.sandbox import available
        return sys.platform == "darwin" and available()
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not _sandbox_available(), reason="needs macOS sandbox-exec")
def test_under_real_sandbox_exec_a_planted_agent_log_link_does_not_reach_the_host(mind, monkeypatch):
    """A mind under the real sandbox-exec profile plants agent.log -> an outside file (which it may do: the link sits in
    its own folder); the next hive start (unsandboxed hive, sandboxed child) appends nothing to the outside file."""
    from hive.supervisor import drivers
    from hive.supervisor.sandbox import profile
    prof = mind.tmp / "plant.sb"
    prof.write_text(profile(mind.root, [sys.prefix, sys.base_prefix], ports=()))
    plant = ("import os, sys; r = sys.argv[1]; os.symlink(sys.argv[2], os.path.join(r, 'agent.log')); "
             "os.symlink(sys.argv[3], os.path.join(r, 'memory'))")
    run = subprocess.run(["sandbox-exec", "-f", str(prof), sys.executable, "-I", "-c", plant, str(mind.root),
                          str(mind.target), str(mind.outside)], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    assert (mind.root / "agent.log").is_symlink()              # the threat is real: the sandbox lets it plant the link
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setattr(drivers, "runtime_roots", lambda *a, **k: [])
    ws = FakeWorkspace(mind.root, ["/bin/echo", "marker-from-sandboxed-mind"])
    ws.settings = SimpleNamespace(data_dir=mind.tmp / "data", core_root=mind.tmp, petta_path="/nonexistent")
    d = drivers.LocalDriver(ws, "/nonexistent")
    _start_and_wait(d)
    untouched(mind)
    assert regular(mind.root / "agent.log")
    assert "marker-from-sandboxed-mind" in (mind.root / "agent.log").read_text()
    assert d.isolation["a_mind"]["os_sandbox"] is True
    assert d.logs("a_mind", 5) == ["marker-from-sandboxed-mind"]


def test_linux_launcher_never_enters_a_linked_relay_folder(mind):
    """landlock.py (run as the hive user before any restriction) binds its relay sockets in <mind>/.hive-relay: a link
    the mind planted there is refused, so no socket is bound or unlinked outside. Pure os calls: runs on macOS too."""
    from hive.supervisor import landlock as L
    (mind.root / L.RELAY_DIR).symlink_to(mind.outside, target_is_directory=True)
    here = os.getcwd()
    try:
        with pytest.raises(OSError):
            L._enter_relay_dir({"mind_dir": str(mind.root)}, create=True)
        assert os.getcwd() == here
        os.unlink(mind.root / L.RELAY_DIR)
        L._enter_relay_dir({"mind_dir": str(mind.root)}, create=True)
        assert os.path.realpath(os.getcwd()) == os.path.realpath(mind.root / L.RELAY_DIR)
    finally:
        os.chdir(here)
    untouched(mind)
