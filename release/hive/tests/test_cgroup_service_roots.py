"""Purpose: the Code resource owner's cgroup bootstrap starts only in the hive's own service: the system service, or
the same unit under this account's own systemd user manager, never another account's unit or any other cgroup."""
from hive.supervisor import cgroup_v2

MiB = 1024 * 1024
POLICY = (256 * MiB, 0, 512 * MiB, 128 * MiB, 16 * MiB, 64, 128, 32)
UNIT = "omegahive.service"


def test_service_roots_are_the_system_unit_and_this_accounts_user_unit():
    assert cgroup_v2.service_roots(UNIT, 1000) == (
        "/system.slice/omegahive.service",
        "/user.slice/user-1000.slice/user@1000.service/app.slice/omegahive.service")


def _attempt(monkeypatch, path, uid=1000):
    """Run bootstrap as service account `uid` with its own cgroup reading `path`; past the root check it reaches the
    cgroup mount, which this replaces with a marker refusal, so the error says which check stopped it."""
    monkeypatch.setattr(cgroup_v2._os, "getuid", lambda: uid)
    monkeypatch.setattr(cgroup_v2._os, "geteuid", lambda: uid)
    monkeypatch.setattr(cgroup_v2, "_self_path", lambda owner: path)

    def mount(owner, relative_root):
        raise cgroup_v2.CgroupUnavailable("root_accepted")

    monkeypatch.setattr(cgroup_v2, "_mount", mount)
    attempt = cgroup_v2.bootstrap(service_unit=UNIT, monotonic_until=cgroup_v2._now() + 5, capacity_policy=POLICY,
                                  workspace_policy=(1, 1, 1, 1))
    assert attempt.phase == "bootstrap-refused"
    return str(attempt.primary_error)


def test_the_system_service_and_this_accounts_user_unit_pass_the_root_check(monkeypatch):
    assert _attempt(monkeypatch, "/system.slice/omegahive.service") == "root_accepted"
    assert _attempt(monkeypatch, "/user.slice/user-1000.slice/user@1000.service/app.slice/omegahive.service") \
        == "root_accepted"


def test_any_other_cgroup_is_refused(monkeypatch):
    for path in ("/user.slice/user-1001.slice/user@1001.service/app.slice/omegahive.service",
                 "/user.slice/user-1000.slice/user@1000.service/app.slice/other.service",
                 "/user.slice/user-1000.slice/user@1000.service/omegahive.service",
                 "/user.slice/user-1000.slice/session-3.scope",
                 "/system.slice/other.service"):
        assert _attempt(monkeypatch, path) == "original_service_root_required", path
