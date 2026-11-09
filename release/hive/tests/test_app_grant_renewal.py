"""Owner-triggered renewal of an app's short-lived read grants (Atlas, 2026-10-05)."""
import json
import time

from hive.tests.test_core_api import client  # noqa: F401  (fixture)

OWNER = "user:u_owner"
RELEASE = "/opt/release/abc"
ENTRY = {"id": "atlas", "path": RELEASE + "/programs/atlas", "digest": "sha-reviewed"}
SWARM = "s_atlas"


def config(monkeypatch, programs=None, **over):
    """The launcher's grant config. With ``programs``, also what a start records from it (owner and grant vars)."""
    cfg = {"owner": OWNER, "release": RELEASE, "digest": "sha-reviewed", "swarms": [SWARM], "scope": {"classification": "synthetic", "swarm_id": SWARM}, "fields": {"T_SYN": ["classification", "swarm_id", "expires_at"], "T_READ": ["principal", "operations", "expires_at"]}, "vars": ["T_SYN", "T_READ"], "ttl": 86000, **over}
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", json.dumps({"atlas": cfg}))
    monkeypatch.setenv("T_SYN", json.dumps({"classification": "synthetic", "swarm_id": SWARM, "expires_at": 1}))
    monkeypatch.setenv("T_READ", json.dumps([{"principal": OWNER, "operations": ["read"], "expires_at": 1}]))
    if programs is not None:
        programs._snapshot_grant_owners()


def owner_viewer(**over):
    return {"kind": "person", "principal": OWNER, "local_operator": False, **over}


def expiry(name):
    v = json.loads(__import__("os").environ[name])
    return (v[0] if isinstance(v, list) else v)["expires_at"]


def test_the_owner_opening_the_app_renews_only_the_expiry(client, monkeypatch):
    config(monkeypatch, client.app.state.hive.programs)
    programs = client.app.state.hive.programs
    programs.renew_grants(ENTRY, owner_viewer(), SWARM)
    assert expiry("T_SYN") > time.time() + 85000 and expiry("T_READ") > time.time() + 85000
    assert json.loads(__import__("os").environ["T_READ"])[0]["operations"] == ["read"]


def test_nobody_else_and_no_other_release_renews(client, monkeypatch):
    programs = client.app.state.hive.programs
    for viewer, entry in ((owner_viewer(principal="user:someone"), ENTRY),
                          (owner_viewer(local_operator=True), ENTRY),
                          ({"kind": "mind", "principal": OWNER}, ENTRY)):
        config(monkeypatch)
        programs.renew_grants(entry, viewer, SWARM)
        assert expiry("T_SYN") == 1 and expiry("T_READ") == 1, (viewer, entry)
    import pytest
    from hive.core.hive import HiveError
    config(monkeypatch)
    with pytest.raises(HiveError):   # another release: the app does not open at all (fail closed)
        programs.renew_grants({"id": "atlas", "path": "/elsewhere/programs/atlas", "digest": "sha-reviewed"}, owner_viewer(), SWARM)
    assert expiry("T_SYN") == 1 and expiry("T_READ") == 1


def test_dispatch_grants_and_revoked_grants_are_never_renewed(client, monkeypatch):
    programs = client.app.state.hive.programs
    config(monkeypatch)
    monkeypatch.setenv("T_READ", json.dumps([{"principal": OWNER, "operations": ["read", "dispatch"], "expires_at": 1}]))
    programs.renew_grants(ENTRY, owner_viewer(), SWARM)
    assert expiry("T_READ") == 1 and expiry("T_SYN") == 1      # one var not read-only: NOTHING renewed
    config(monkeypatch)
    monkeypatch.delenv("T_SYN")                                 # one part of the bundle revoked
    programs.renew_grants(ENTRY, owner_viewer(), SWARM)
    assert "T_SYN" not in __import__("os").environ             # never recreated
    assert expiry("T_READ") == 1                                # and the rest is NOT renewed alone (OmegaReview)


def test_changed_code_or_another_swarm_renews_nothing(client, monkeypatch):
    """Kimi 2026-10-05: bound to the reviewed bytes and the app's own swarm, not just a path."""
    programs = client.app.state.hive.programs
    events = []
    monkeypatch.setattr(programs.hive.events, "publish", lambda kind, **kw: events.append((kind, kw.get("reason"))))
    config(monkeypatch)
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError):
        programs.renew_grants({**ENTRY, "digest": "sha-tampered"}, owner_viewer(), SWARM)
    programs.renew_grants(ENTRY, owner_viewer(), "s_other")
    assert expiry("T_SYN") == 1 and expiry("T_READ") == 1
    assert [k for k, _ in events] == ["app.grants_refused", "app.grants_refused"]


def test_tampering_is_reported_whoever_looks_and_full_revocation_is_recorded(client, monkeypatch):
    """Kimi round 3: integrity mismatch is a deployment fact; revoking everything leaves a trace."""
    import os
    programs = client.app.state.hive.programs
    events = []
    monkeypatch.setattr(programs.hive.events, "publish", lambda kind, **kw: events.append((kind, kw.get("by"), kw.get("reason"))))
    config(monkeypatch, programs)
    import pytest
    from hive.core.hive import HiveError
    with pytest.raises(HiveError):
        programs.renew_grants({**ENTRY, "digest": "sha-tampered"}, owner_viewer(principal="user:someone"), SWARM)
    assert events[-1] == ("app.grants_refused", "user:someone", "app source differs from the reviewed release")
    monkeypatch.delenv("T_SYN"); monkeypatch.delenv("T_READ")
    programs.renew_grants(ENTRY, owner_viewer(), SWARM)
    assert events[-1][0] == "app.grants_refused" and events[-1][2] == "every grant is revoked"
    assert "T_SYN" not in os.environ and "T_READ" not in os.environ



def test_a_grant_outside_the_reviewed_scope_renews_nothing(client, monkeypatch):
    """OmegaReview 2026-10-05: an invented personal classification or another swarm must not advance any expiry."""
    programs = client.app.state.hive.programs
    for bad in ({"classification": "personal", "swarm_id": SWARM, "expires_at": 1},
                {"classification": "synthetic", "swarm_id": "s_elsewhere", "expires_at": 1}):
        config(monkeypatch)
        monkeypatch.setenv("T_SYN", json.dumps(bad))
        programs.renew_grants(ENTRY, owner_viewer(), SWARM)
        assert expiry("T_SYN") == 1 and expiry("T_READ") == 1, bad



def test_a_missing_or_extra_field_renews_nothing(client, monkeypatch):
    """Kimi 2026-10-05: an omitted scope field or an unknown extra key must refuse, not slip through."""
    programs = client.app.state.hive.programs
    for bad_syn, bad_read in (({"classification": "synthetic", "expires_at": 1}, None),
                              ({"classification": "synthetic", "swarm_id": SWARM, "expires_at": 1, "extra": "x"}, None),
                              (None, [{"principal": OWNER, "operations": ["read"], "expires_at": 1}, {"expires_at": 1}])):
        config(monkeypatch)
        if bad_syn: monkeypatch.setenv("T_SYN", json.dumps(bad_syn))
        if bad_read: monkeypatch.setenv("T_READ", json.dumps(bad_read))
        programs.renew_grants(ENTRY, owner_viewer(), SWARM)
        assert expiry("T_SYN") == 1 and expiry("T_READ") == 1, (bad_syn, bad_read)


def test_an_app_that_is_not_its_reviewed_release_does_not_open(client, monkeypatch):
    """Kimi 2026-10-05: fail closed, not just 'no renewal', when the code is not the reviewed release."""
    import pytest
    from hive.core.hive import HiveError
    programs = client.app.state.hive.programs
    config(monkeypatch)
    with pytest.raises(HiveError) as e:
        programs.renew_grants({**ENTRY, "digest": "sha-tampered"}, owner_viewer(), SWARM)
    assert e.value.code == "app_integrity"


def test_integrity_is_enforced_at_every_entry_not_only_view(client, monkeypatch):
    """Kimi 2026-10-05: act, result validation and the UI bundle all pass through _ready, which now checks integrity."""
    import json as _json
    import pytest
    from hive.core.hive import HiveError
    programs = client.app.state.hive.programs
    items = client.get("/api/programs").json()
    items = items if isinstance(items, list) else items.get("programs", [])
    # a program that loaded: one that failed to load (a platform program with no act(), my_apps.NOT_APPS) is refused
    # as program_error before integrity is reached, which is not what this test is about
    loaded = [i["id"] for i in items if not programs.get(i["id"])["error"]]
    if not loaded:
        pytest.skip("no app loaded")
    pid = loaded[0]
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", _json.dumps({pid: {"release": "/nowhere/release", "digest": "sha256:" + "0" * 64}}))
    with pytest.raises(HiveError) as e:
        programs._ready(pid)
    assert e.value.code == "app_integrity"


def mounted_atlas(client, tmp_path, monkeypatch):
    folder = tmp_path / "atlas"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "atlas", "name": "Atlas", "capabilities": []}))
    (folder / "program.py").write_text("def describe():\n    return {'contract': '0.2', 'kinds': [], 'relations': [], 'actions': []}\n")
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")


def test_revocation_and_disable_survive_a_restart_and_owner_open(client, tmp_path, monkeypatch):
    """Atlas 2026-10-05: the launcher mints grants at every start, so revocation must be a persisted host decision."""
    import os
    from hive.core.programs import Programs
    mounted_atlas(client, tmp_path, monkeypatch)
    config(monkeypatch, client.app.state.hive.programs)
    hive = client.app.state.hive
    assert hive.programs.revoke_grants("atlas", owner_viewer())["grants_revoked"] is True
    assert "T_SYN" not in os.environ and "T_READ" not in os.environ
    hive.programs.set_enabled("atlas", False, OWNER)
    config(monkeypatch)                                   # the launcher mints them again at the next start
    restarted = Programs(hive)
    assert "T_SYN" not in os.environ and "T_READ" not in os.environ
    assert "atlas" in restarted.disabled
    config(monkeypatch)                                   # even if a var reappears, the owner opening does not renew it
    before = os.environ["T_SYN"]
    restarted.renew_grants(ENTRY, owner_viewer(), SWARM)
    assert os.environ["T_SYN"] == before and expiry("T_SYN") == 1


def test_only_the_owner_restores_and_only_at_the_next_start(client, tmp_path, monkeypatch):
    import os
    import pytest
    from hive.core.hive import HiveError
    from hive.core.programs import Programs
    mounted_atlas(client, tmp_path, monkeypatch)
    config(monkeypatch, client.app.state.hive.programs)
    hive = client.app.state.hive
    with pytest.raises(HiveError):
        hive.programs.revoke_grants("atlas", owner_viewer(principal="user:someone"))
    hive.programs.revoke_grants("atlas", owner_viewer(local_operator=True, kind="operator", principal="user:operator"))
    for who in (owner_viewer(principal="user:someone"), owner_viewer(local_operator=True)):
        with pytest.raises(HiveError) as e:
            hive.programs.restore_grants("atlas", who)
        assert e.value.code == "owner_required"
    assert hive.programs.restore_grants("atlas", owner_viewer())["takes_effect"] == "next restart"
    assert "T_SYN" not in os.environ                      # nothing recreated in this process
    config(monkeypatch)
    Programs(hive)
    assert "T_SYN" in os.environ                          # the next start keeps the launcher's fresh grants


def test_authority_comes_from_the_start_not_the_live_environment(client, tmp_path, monkeypatch):
    """Kimi next8-r1: an app can write the environment, so who owns its grants is what the launcher said at start."""
    import os
    mounted_atlas(client, tmp_path, monkeypatch)
    programs = client.app.state.hive.programs
    config(monkeypatch, programs)
    config(monkeypatch, owner="user:intruder")            # the live config is rewritten after start
    before = os.environ["T_SYN"]
    programs.renew_grants(ENTRY, owner_viewer(principal="user:intruder"), SWARM)
    programs.renew_grants(ENTRY, owner_viewer(), SWARM)    # the live owner no longer matches the recorded one either
    assert os.environ["T_SYN"] == before
    monkeypatch.delenv("HIVE_APP_GRANT_RENEWAL")           # even with the live config gone, the recorded owner can revoke
    assert programs.revoke_grants("atlas", owner_viewer())["grants_revoked"] is True
    assert "T_SYN" not in os.environ and "T_READ" not in os.environ


def test_a_restore_is_bound_to_the_start_that_applies_it(client, tmp_path, monkeypatch):
    """Kimi next8-r1: a restore leaves an observable receipt at the start that honours it."""
    from hive.core.programs import Programs
    mounted_atlas(client, tmp_path, monkeypatch)
    hive = client.app.state.hive
    config(monkeypatch, hive.programs)
    hive.programs.revoke_grants("atlas", owner_viewer())
    hive.programs.restore_grants("atlas", owner_viewer())
    row = hive.db.one("SELECT restored_at, restore_applied_at FROM app_authority WHERE program = 'atlas'")
    assert row["restored_at"] and row["restore_applied_at"] is None
    config(monkeypatch)
    seen = []
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: seen.append(kind))
    Programs(hive)
    assert "app.grants_restore_applied" in seen
    assert hive.db.one("SELECT restore_applied_at FROM app_authority WHERE program = 'atlas'")["restore_applied_at"]


def test_revocation_wins_against_an_inflight_renewal(client, tmp_path, monkeypatch):
    """OmegaReview next8 R3 probe (adapted: authority recorded at start): a renewal paused at its write boundary while
    the owner revokes writes nothing afterwards."""
    import os
    import sys
    import threading
    mounted_atlas(client, tmp_path, monkeypatch)
    programs = client.app.state.hive.programs
    config(monkeypatch, programs)
    paused, resume, errors = threading.Event(), threading.Event(), []

    def trace(frame, event, arg):
        if event == "line" and frame.f_code is programs.renew_grants.__func__.__code__ and "until" in frame.f_locals:
            sys.settrace(None)
            paused.set()
            if not resume.wait(5):
                raise TimeoutError("probe release")
        return trace

    def renewing():
        sys.settrace(trace)
        try:
            programs.renew_grants(ENTRY, owner_viewer(), SWARM)
        except BaseException as exc:          # noqa: BLE001  (recorded for the assertion)
            errors.append(repr(exc))
        finally:
            sys.settrace(None)

    t = threading.Thread(target=renewing, daemon=True)
    t.start()
    try:
        assert paused.wait(5), "did not reach the renewal write boundary"
        programs.revoke_grants("atlas", owner_viewer())
    finally:
        resume.set()
        t.join(5)
    assert not errors and programs.grants_revoked("atlas")
    assert "T_SYN" not in os.environ and "T_READ" not in os.environ


def test_replacing_ui_and_its_lock_invalidates_the_reviewed_program(client, tmp_path, monkeypatch):
    """Atlas UI: a self-consistent new bundle must not retain old release authority."""
    import hashlib
    import pytest
    from hive.core.hive import HiveError
    from hive.core.programs import Programs
    mounted_atlas(client, tmp_path, monkeypatch)
    folder = tmp_path / 'atlas'
    (folder / 'program.py').write_text("def describe():\n    return {'contract': '0.2', 'kinds': [{'id': 'record', 'role': 'other'}], 'relations': [], 'actions': []}\ndef view(ctx, focus=None, stage='unfold'):\n    return {}\ndef act(ctx, action, items, params):\n    return {'status': 'refused'}\n")
    ui = folder / 'ui'
    ui.mkdir()
    files = {'index.html': '<html><head></head></html>', 'app.js': 'old interface', 'style.css': 'body{}'}
    def write_bundle():
        for name, value in files.items(): (ui / name).write_text(value)
        (ui / 'bundle.lock.json').write_text(json.dumps({'files': {
            name: hashlib.sha256(value.encode()).hexdigest() for name, value in files.items()}}))
    write_bundle()
    client.post('/api/programs/reload')
    hive = client.app.state.hive
    digest = hive.programs.get('atlas')['digest']
    monkeypatch.setenv('HIVE_APP_GRANT_RENEWAL', json.dumps({'atlas': {
        'release': str(tmp_path), 'digest': digest, 'owner': OWNER}}))
    assert hive.programs.ui_bundle('atlas')['files']['app.js'] == 'old interface'
    files['app.js'] = 'replacement interface'
    write_bundle()  # verifier accepts the new self-consistent bytes; reviewed digest must refuse them
    assert Programs.source_digest(folder) != digest
    with pytest.raises(HiveError) as refused:
        hive.programs.ui_bundle('atlas')
    assert refused.value.code == 'app_integrity'
