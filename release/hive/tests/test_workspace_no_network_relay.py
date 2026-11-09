"""UNRUN actual launch/quota/pid1/WorkspaceJob bodies with inert effect models.

Reuse the reviewed namespace model; no real process, socket, namespace, mount,
filesystem, thread, clock or untrusted command is invoked. The modeled fork
boundary supplies a profile explicitly; it is not actual fork/lineage evidence.
"""
import shutil
import tempfile
from types import SimpleNamespace

import pytest

from hive.core import sandbox_workspace as W
from hive.supervisor import landlock as L
from hive.tests.test_landlock_workspace_namespace_cwd import _NamespaceMountModel


class _ProjectReached(BaseException):
    pass


class _Socket:
    def __init__(self, model, family, kind):
        self.model, self.family, self.kind = model, family, kind
        self.bound = None
        self.closed = False
        model.sockets.append(self)
        model.events.append(("socket", family, kind))
    def setsockopt(self, *args):
        self.model.events.append(("socket-option", *args))
    def bind(self, path):
        self.bound = path
        self.model.events.append(("socket-bind", path))
    def listen(self, backlog):
        assert backlog == 64
        self.model.events.append(("socket-listen", backlog))
    def close(self):
        self.closed = True
        self.model.events.append(("socket-close", self.bound))


class _LaunchModel:
    job = "/original-meta"
    def __init__(self):
        self.events, self.sockets, self.setup_errors = [], [], []
        self.entries = set()
        self.pending = None
        self.directory_closed = self.directory_removed = False
        self.loop = SimpleNamespace(time=lambda: 0.0)
        model = self
        class Session:
            path = model.job + "/.quota-root-2"
            def raise_first(self):
                model.events.append(("session-first",))
                if model.pending is not None:
                    raise model.pending
            def close(self): model.events.append(("session-close",))
            def role_barrier(self, index):
                assert index == 0
                model.events.append(("role-barrier", index))
                return SimpleNamespace(parent_closed=lambda: model.events.append(("parent-closed", index)))
        self.session = Session()

    def makedirs(self, path, **kwargs):
        assert path == self.job + "/.hive-relay"
        assert kwargs == {"mode": 0o700, "exist_ok": True}
        self.events.append(("host-makedirs", path))
        self.entries.add(".hive-relay")

    def chdir(self, path):
        self.events.append(("host-chdir", path))
        assert path == self.job + "/.hive-relay" and ".hive-relay" in self.entries

    def unlink(self, path):
        self.events.append(("host-unlink", path))
        raise FileNotFoundError(path)

    def install(self, monkeypatch):
        fake_os = SimpleNamespace(getuid=lambda: 996, getgid=lambda: 996,
            getcwd=lambda: self.job, environ={}, makedirs=self.makedirs,
            chdir=self.chdir, unlink=self.unlink,
            path=SimpleNamespace(join=lambda a, b: a.rstrip("/") + "/" + b,
                                 isabs=lambda path: path.startswith("/")),
            fork=lambda: self.events.append(("parent-fork",)) or 73,
            rmdir=lambda path: self.events.append(("legacy-root-rmdir", path)))
        monkeypatch.setattr(L, "os", fake_os)
        monkeypatch.setattr(L, "time", SimpleNamespace(monotonic=lambda: 0.0))
        monkeypatch.setattr(L, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9,
            signal=lambda *a: self.events.append(("signal-handler", a[0]))))
        monkeypatch.setattr(L, "sys", SimpleNamespace(stderr=SimpleNamespace(
            write=lambda text: self.events.append(("setup-stderr", text)))))
        monkeypatch.setattr(L, "socket", SimpleNamespace(AF_UNIX=1, AF_INET=2,
            SOCK_STREAM=1, SOL_SOCKET=1, SO_REUSEADDR=2,
            socket=lambda family, kind: _Socket(self, family, kind)))
        monkeypatch.setattr(L, "_netns_id", lambda: self.events.append(("netns",)) or "modeled-original-netns")
        monkeypatch.setattr(L, "_serve_host", lambda listeners: self.events.append(("serve-host", len(listeners))))
        monkeypatch.setattr(L, "_wait", lambda pid: self.events.append(("original-wait", pid)) or 0)
        original_failed = L._setup_failed
        def failed(error, root, listeners):
            self.setup_errors.append(error)
            return original_failed(error, root, listeners)
        monkeypatch.setattr(L, "_setup_failed", failed)

    def profile(self, ports=()):
        return {"mind_dir": self.job, "read": [], "dev_rw": [], "dev_read": [], "connect_ports": list(ports)}

    def run_parent(self, ports=(), *, workspace=True):
        return L.launch(self.profile(ports), ["/selected/tool"],
            _runner_until=10.0, _runner_workspace=self.session if workspace else None)

    def make_original_job(self, monkeypatch):
        """Actual W create/dispose; only original directory I/O is modeled."""
        basis = SimpleNamespace(st_dev=1, st_ino=19, st_uid=996, st_mode=0o40700)
        def open_directory(path, flags):
            assert path == self.job
            self.events.append(("job-open", path))
            return 77
        def fstat(fd):
            assert fd == 77
            return basis
        def listdir(fd):
            assert fd == 77 and not self.directory_closed
            self.events.append(("job-listdir", tuple(sorted(self.entries))))
            return sorted(self.entries)
        def close(fd):
            assert fd == 77 and not self.directory_closed
            self.directory_closed = True
            self.events.append(("job-close",))
        def remove(path):
            assert path == self.job and self.directory_closed and not self.entries
            self.directory_removed = True
            self.events.append(("job-rmdir", path))
        monkeypatch.setattr(W, "os", SimpleNamespace(open=open_directory, fstat=fstat,
            lstat=lambda path: basis, listdir=listdir, close=close, rmdir=remove,
            getuid=lambda: 996, path=SimpleNamespace(realpath=lambda path: path),
            O_RDONLY=0, O_DIRECTORY=1, O_NOFOLLOW=2, O_CLOEXEC=4))
        monkeypatch.setattr(W, "stat", SimpleNamespace(S_ISDIR=lambda mode: mode & 0o170000 == 0o040000))
        monkeypatch.setattr(W, "asyncio", SimpleNamespace(get_running_loop=lambda: self.loop))
        monkeypatch.setattr(W, "tempfile", SimpleNamespace(mkdtemp=lambda **kw: self.job))
        context = SimpleNamespace(loop=self.loop, loop_until=10.0, workspaces=[None, None, None])
        job = W.WorkspaceJob(context).create(9.0)
        assert job.ready and job.directory.returned and not job.directory.closed
        return job


@pytest.fixture
def launch(monkeypatch):
    model = _LaunchModel()
    original_which, original_mkdtemp = shutil.which, tempfile.mkdtemp
    # Actual L.launch performs these two local stdlib imports. These finite
    # shared aliases are declared and independently restored, never cloned.
    try:
        monkeypatch.setattr(shutil, "which", lambda command: model.events.append(("which", command)) or command)
        monkeypatch.setattr(tempfile, "mkdtemp", lambda **kw: model.events.append(("legacy-temp-root",)) or "/legacy-root")
        model.install(monkeypatch)
        yield model
    finally:
        try:
            shutil.which = original_which
        finally:
            tempfile.mkdtemp = original_mkdtemp


def _pid1_to_project(model, monkeypatch, *, workspace=True, fail=None, ports=()):
    """Actual B body; its exec is an inert sentinel, never a real command."""
    prof = model.profile(ports)
    prof.update(_cwd=model.job, _root="/legacy-root")
    if workspace:
        namespace = _NamespaceMountModel()
        session, _ = namespace.install(monkeypatch)
        prof["_workspace"] = session
        fake_os = L.os
        root_chdir = fake_os.chdir
        def chdir(path):
            if path == model.job + "/.hive-relay":
                model.events.append(("private-relay-cwd", path))
                raise FileNotFoundError(path)  # Host entry is not private-FS visibility.
            if path == model.job and namespace.mounted:
                model.events.append(("project-cwd", path))
                return
            return root_chdir(path)
        fake_os.chdir = chdir
        fake_os.path.isdir = lambda path: path == model.job
        fake_os.path.join = lambda a, b: a.rstrip("/") + "/" + b
    else:
        namespace, session = None, None
        monkeypatch.setattr(L, "_private_root", lambda profile: model.events.append(("legacy-private-root",)) or True)
        fake_os = L.os
        def chdir(path):
            model.events.append(("legacy-B-cwd", path))
            assert path in (model.job, model.job + "/.hive-relay")
        fake_os.chdir = chdir
        fake_os.path.isdir = lambda path: path == model.job
    def stage(name):
        model.events.append((name,))
        if fail == name:
            raise RuntimeError("modeled " + name)
    monkeypatch.setattr(L, "_loopback_up", lambda: stage("loopback"))
    def restrict(profile):
        if workspace:
            assert namespace.mounted and session.ready and session.closed
        stage("restrict")
    monkeypatch.setattr(L, "restrict_files", restrict)
    monkeypatch.setattr(L, "deny_unix_sockets", lambda: stage("deny-unix"))
    fake_os.fork = lambda: model.events.append(("project-fork",)) or 0
    def execute(argv0, argv):
        model.events.append(("project-exec", argv0, tuple(argv)))
        raise _ProjectReached
    fake_os.execvp = execute
    with pytest.raises(_ProjectReached):
        L._pid1(prof, ["/selected/tool"])
    return namespace, session


def test_actual_resource_parent_quota_B_handoff_and_original_job_retirement(launch, monkeypatch):
    job = launch.make_original_job(monkeypatch)
    assert launch.run_parent() == 0
    namespace, session = _pid1_to_project(launch, monkeypatch)
    assert namespace.events[-1] == ("mounted-readback-and-ack", launch.job)
    assert session.ready and session.closed
    assert ("project-fork",) in launch.events and ("deny-unix",) in launch.events
    assert not launch.sockets and not launch.entries
    assert not any(e[0] in ("host-makedirs", "host-chdir", "private-relay-cwd") for e in launch.events)
    assert job.dispose(10.0) is True and job.removed and job.disposed
    assert launch.directory_closed and launch.directory_removed


def test_actual_parent_job_dispose_is_not_blocked_by_a_new_relay_entry(launch, monkeypatch):
    job = launch.make_original_job(monkeypatch)
    assert launch.run_parent() == 0
    assert job.dispose(10.0) is True
    assert ("job-listdir", ()) in launch.events and job.removed and job.directory.closed


def test_existing_host_relay_entry_is_not_adopted_or_deleted_to_fake_retirement(launch, monkeypatch):
    job = launch.make_original_job(monkeypatch)
    launch.entries.add(".hive-relay")
    assert launch.run_parent() == 0
    assert job.dispose(10.0) is False
    assert not job.removed and not job.disposed and job.primary is not None
    assert launch.entries == {".hive-relay"} and not launch.directory_removed
    assert job.directory.closed  # Independent original close still happens.


@pytest.mark.parametrize("ports", [[18731], [18731, 18732]], ids=("one-port", "two-ports"))
def test_resource_network_ports_refuse_before_launch_setup_effects(launch, ports):
    assert launch.run_parent(ports) == 78
    assert type(launch.setup_errors[0]) is ValueError
    assert ("session-close",) in launch.events
    assert not any(e[0] in ("netns", "which", "legacy-temp-root", "host-makedirs", "host-chdir", "socket", "parent-fork") for e in launch.events)
    assert not launch.entries and not launch.sockets


def test_pending_workspace_raw_error_precedes_derived_port_refusal(launch):
    first = RuntimeError("modeled original workspace error")
    launch.pending = first
    assert launch.run_parent([18731]) == 78
    assert launch.setup_errors == [first]
    assert ("session-close",) in launch.events
    assert not any(e[0] in ("netns", "which", "host-makedirs", "parent-fork") for e in launch.events)


@pytest.mark.parametrize("ports", [[], [18731]], ids=("zero-ports", "one-port"))
def test_legacy_parent_and_B_keep_original_relay_setup(launch, monkeypatch, ports):
    assert launch.run_parent(ports, workspace=False) == 0
    host_sockets = tuple(launch.sockets)
    _pid1_to_project(launch, monkeypatch, workspace=False, ports=ports)
    assert ".hive-relay" in launch.entries
    assert ("host-makedirs", launch.job + "/.hive-relay") in launch.events
    assert ("host-chdir", launch.job + "/.hive-relay") in launch.events
    assert ("legacy-B-cwd", launch.job + "/.hive-relay") in launch.events
    assert ("legacy-root-rmdir", "/legacy-root") in launch.events
    assert len(host_sockets) == len(ports)
    if ports:
        assert host_sockets[0].bound == "18731.sock"
        inner = launch.sockets[-1]
        assert inner.family == L.socket.AF_INET and inner.bound == ("127.0.0.1", 18731) and inner.closed


@pytest.mark.parametrize("stage", ["loopback", "restrict"], ids=("loopback", "restrict"))
def test_quota_to_B_setup_failure_never_reaches_project_fork(launch, monkeypatch, stage):
    with pytest.raises(RuntimeError, match="modeled " + stage):
        _pid1_to_project(launch, monkeypatch, fail=stage)
    assert not any(e[0] in ("project-fork", "project-exec") for e in launch.events)
