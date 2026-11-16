"""Host regression port: inert current-namespace workspace cwd models.

Source-only and UNRUN at freeze. The model and four resolved namespace cases
are verbatim from the reviewed standalone control Source. No runner fixture,
child, syscall, mount, namespace or native probe is used by these controls.
"""
from types import SimpleNamespace

import pytest

from hive.supervisor import landlock as L


class _NamespaceMountModel:
    """Pure old/current mount references can share the same inode identity.

    This counterpart models only the selected cwd join; it is not a kernel or
    native namespace proof. Every OS, mount and pivot effect is target-local.
    """
    root = "/original-meta/.quota-root-2"
    job = "/original-meta"

    def __init__(self, *, coordinate_drift=False, cwd_drift=False, expire_after_cwd_check=False):
        self.events = []
        self.coordinate_drift, self.cwd_drift = coordinate_drift, cwd_drift
        self.expire_after_cwd_check, self.expired = expire_after_cwd_check, False
        self.old_mount, self.current_mount, self.tmpfs_mount = object(), object(), object()
        self.cwd_mount, self.cwd_path = self.current_mount, "/some-start"
        self.mounted = False
        self.held = SimpleNamespace(st_dev=1, st_ino=99)

    def fstat(self, fd):
        assert fd == 55
        self.events.append(("fstat", fd))
        return self.held

    def stat(self, path, *, follow_symlinks):
        assert follow_symlinks is False and path in (self.root, ".")
        self.events.append(("stat", path, follow_symlinks))
        if path == self.root:
            inode = 100 if self.coordinate_drift else 99
        elif self.cwd_path != self.root:
            inode = 101
        else:
            inode = 100 if self.cwd_drift and self.cwd_mount is self.current_mount else 99
        if path == "." and self.expire_after_cwd_check:
            self.expired = True
        return SimpleNamespace(st_dev=1, st_ino=inode)

    def fchdir(self, fd):
        assert fd == 55
        self.events.append(("fchdir", fd))
        # The old FD has the same dev/inode as the current coordinate but a
        # distinct mount reference. Inode equality alone cannot repair this.
        self.cwd_mount, self.cwd_path = self.old_mount, self.root

    def chdir(self, path):
        assert path in (self.root, "/")
        self.events.append(("chdir", path))
        self.cwd_path = path
        self.cwd_mount = self.tmpfs_mount if self.mounted else self.current_mount

    def mount(self, source, target, filesystem, flags, data=None):
        self.events.append(("mount", source, target, filesystem, flags, data))
        if source == "tmpfs":
            assert target == "." and filesystem == "tmpfs"
            assert flags == L.MS_NOSUID | L.MS_NODEV
            assert data == "mode=0755,size=268435456,nr_inodes=8192"
            if self.cwd_mount is not self.current_mount or self.cwd_path != self.root:
                raise OSError(22, "modeled foreign-namespace mount reference")
            self.mounted = True

    def install(self, monkeypatch):
        model = self
        class Session:
            path = model.root
            mountpoint = SimpleNamespace(value=55)
            ready = closed = False
            def raise_first(self): pass
            def guard(self):
                model.events.append(("deadline",))
                if model.expired:
                    raise TimeoutError("modeled original workspace deadline")
            def mounted_root(self, path):
                assert model.mounted and path == model.job
                model.events.append(("mounted-readback-and-ack", path))
                self.ready = self.closed = True
        session = Session()
        fake_os = SimpleNamespace(fstat=self.fstat, stat=self.stat,
            fchdir=self.fchdir, chdir=self.chdir,
            chmod=lambda *a: self.events.append(("chmod", *a)),
            makedirs=lambda *a, **k: None, rmdir=lambda *a: None,
            path=SimpleNamespace(exists=lambda p: True))
        monkeypatch.setattr(L, "os", fake_os)
        monkeypatch.setattr(L, "platform", SimpleNamespace(machine=lambda: "x86_64"))
        monkeypatch.setattr(L, "_mount", self.mount)
        monkeypatch.setattr(L, "_mkdirs", lambda p: self.events.append(("mkdir", p)))
        monkeypatch.setattr(L, "_mirror", lambda *a: self.events.append(("mirror", *a[:2])))
        monkeypatch.setattr(L, "_bind", lambda *a, **k: self.events.append(("bind", *a)))
        monkeypatch.setattr(L, "allowed_roots", lambda p: p)
        monkeypatch.setattr(L, "effective_read", lambda p: p)
        monkeypatch.setattr(L, "_libc", lambda: SimpleNamespace(syscall=lambda *a: 0, umount2=lambda *a: 0))
        profile = {"_workspace": session, "mind_dir": self.job, "read": [], "dev_rw": [], "dev_read": []}
        return session, profile


@pytest.mark.parametrize("drift", [False, True])
def test_actual_namespace_root_is_one_capped_fs_without_host_job_bind(monkeypatch, drift):
    model = _NamespaceMountModel(coordinate_drift=drift)
    session, profile = model.install(monkeypatch)
    if drift:
        with pytest.raises(OSError):
            L._private_root(profile)
        assert not any(e[0] == "mount" for e in model.events)
        assert not session.ready and not session.closed
    else:
        assert model.old_mount is not model.current_mount
        assert L._private_root(profile) is True
        mounts = [e for e in model.events if e[0] == "mount" and e[1] == "tmpfs"]
        assert mounts == [("mount", "tmpfs", ".", "tmpfs", L.MS_NOSUID | L.MS_NODEV,
                           "mode=0755,size=268435456,nr_inodes=8192")]
        before = model.events.index(("chdir", model.root))
        checked = model.events.index(("stat", ".", False))
        mounted = model.events.index(mounts[0])
        after = model.events.index(("chdir", model.root), mounted + 1)
        made_tmp = model.events.index(("mkdir", model.root + "/tmp"))
        assert before < checked < mounted < after < made_tmp
        assert not any(e[0] == "fchdir" for e in model.events)
        assert not any(e[0] == "bind" and e[2] == model.job for e in model.events)
        assert ("chmod", model.root + "/tmp", 0o1777) in model.events
        assert model.events[-1] == ("mounted-readback-and-ack", model.job)
        assert session.ready and session.closed


def test_post_chdir_cwd_identity_mismatch_refuses_before_tmpfs(monkeypatch):
    model = _NamespaceMountModel(cwd_drift=True)
    session, profile = model.install(monkeypatch)
    with pytest.raises(OSError):
        L._private_root(profile)
    assert ("stat", model.root, False) in model.events
    assert ("chdir", model.root) in model.events and ("stat", ".", False) in model.events
    assert model.events.index(("chdir", model.root)) < model.events.index(("stat", ".", False))
    assert not any(e[0] == "mount" and e[1] == "tmpfs" for e in model.events)
    assert not any(e[0] in ("mkdir", "mirror", "bind", "mounted-readback-and-ack") for e in model.events)
    assert not session.ready and not session.closed


def test_cwd_acquisition_crossing_original_deadline_refuses_before_tmpfs(monkeypatch):
    model = _NamespaceMountModel(expire_after_cwd_check=True)
    session, profile = model.install(monkeypatch)
    with pytest.raises(TimeoutError):
        L._private_root(profile)
    checked = model.events.index(("stat", ".", False))
    assert model.events.index(("chdir", model.root)) < checked
    assert model.events[checked + 1] == ("deadline",)
    assert not any(e[0] == "mount" and e[1] == "tmpfs" for e in model.events)
    assert not any(e[0] in ("mkdir", "mirror", "bind", "mounted-readback-and-ack") for e in model.events)
    assert not session.ready and not session.closed
