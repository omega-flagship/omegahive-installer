"""GET /api/me/apps (Ask-and-apps contract R1 §3): the apps this person can open, discoverable and openable only.

Synthetic only: invented apps and people. Person apps follow the P14 install review and audience (even for an admin);
swarm apps need an active activation in a swarm the viewer sees and default lists do not hide; listing never opens a
context. /api/programs no longer names a person app to a member outside its audience."""
import json

from hive.core.my_apps import MyApps
from hive.core.visibility import Viewer
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_key_owner_oi13 import ANN, BOB, CY, w  # noqa: F401  (fixture)
from hive.tests.test_p14_ready_on_install import (  # noqa: F401  (fixture x)
    ANN_P, BOB_P, CY_P, HELPERS, MANIFESTS, SHARED, SOLO, install, mount, open_app, x)


def ids(x, headers):
    r = x.client.get("/api/me/apps", headers=headers)
    assert r.status_code == 200, r.text
    return [a["id"] for a in r.json()["apps"]]


def swarm(x, sid, **cols):
    x.hive.db.execute("INSERT INTO swarms (id, name, hue, created_at) VALUES (?, ?, 1, '2026-11-03')", (sid, sid))
    for k, v in cols.items():
        x.hive.db.execute(f"UPDATE swarms SET {k} = ? WHERE id = ?", (v, sid))


def activate(x, program, sid):
    x.hive.db.execute("INSERT INTO app_activations VALUES (?, ?, 1, ?)", (program, sid, ANN_P))


def test_installed_person_apps_are_listed_for_people_in_their_audience(x):
    assert SOLO in ids(x, x.bob) and HELPERS in ids(x, x.bob)
    app = next(a for a in x.client.get("/api/me/apps", headers=x.bob).json()["apps"] if a["id"] == SOLO)
    assert app["placement"] == "person" and app["open"] == {"kind": "person"} and isinstance(app["order"], int)


def test_unreviewed_turned_off_or_outside_the_audience_is_not_listed(x, monkeypatch):
    x.hive.db.execute("DELETE FROM app_install_reviews WHERE program = ?", (HELPERS,))
    assert HELPERS not in ids(x, x.bob)                                    # not reviewed
    assert x.client.delete(f"/api/programs/{SOLO}/install", headers=x.ann).status_code == 200
    assert SOLO not in ids(x, x.bob)                                       # revoked / turned off
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    assert install(x, SOLO).status_code == 200
    assert SOLO in ids(x, x.bob) and SOLO not in ids(x, x.cy)              # audience first


def test_the_audience_applies_to_an_admin_too(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    assert install(x, SOLO).status_code == 200
    assert SOLO not in ids(x, x.ann)


def test_listing_matches_what_opening_allows(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    assert install(x, SOLO).status_code == 200
    for headers in (x.bob, x.cy):
        listed = SOLO in ids(x, headers)
        assert listed == (open_app(x, SOLO, headers).status_code == 200)


def test_listing_never_creates_a_context(x):
    before = x.hive.db.one("SELECT COUNT(*) AS n FROM app_person_contexts")["n"]
    ids(x, x.bob)
    ids(x, x.cy)
    assert x.hive.db.one("SELECT COUNT(*) AS n FROM app_person_contexts")["n"] == before


def test_swarm_apps_only_in_swarms_the_viewer_sees(x):
    swarm(x, "s_team")
    swarm(x, "s_bob_only", visibility="private", owner=BOB_P)
    activate(x, SHARED, "s_team")
    activate(x, SHARED, "s_bob_only")
    bob = [a for a in x.client.get("/api/me/apps", headers=x.bob).json()["apps"] if a["id"] == SHARED]
    cy = [a for a in x.client.get("/api/me/apps", headers=x.cy).json()["apps"] if a["id"] == SHARED]
    assert {a["open"]["swarm_id"] for a in bob} == {"s_team", "s_bob_only"}
    assert {a["open"]["swarm_id"] for a in cy} == {"s_team"}               # never another person's private swarm


def test_another_persons_personal_swarm_is_hidden_even_from_an_admin(x):
    swarm(x, "s_bob_personal", visibility="private", owner=BOB_P, personal_of=BOB_P)
    activate(x, SHARED, "s_bob_personal")
    listed = MyApps(x.hive).list(Viewer(ANN_P, True), ANN_P)["apps"]
    assert all(a["open"].get("swarm_id") != "s_bob_personal" for a in listed)


def test_archived_swarms_and_disabled_apps_are_not_listed(x):
    swarm(x, "s_old", archived_at="2026-11-01")
    activate(x, SHARED, "s_old")
    assert SHARED not in ids(x, x.bob)
    swarm(x, "s_team2")
    activate(x, SHARED, "s_team2")
    assert SHARED in ids(x, x.bob)
    x.hive.programs.set_enabled(SHARED, False, ANN_P)
    assert SHARED not in ids(x, x.bob)


def test_the_local_operator_has_no_apps(x):
    assert MyApps(x.hive).list(Viewer("user:operator", True), "user:operator") == {"apps": []}


def test_person_apps_come_first_then_swarm_apps(x):
    swarm(x, "s_team3")
    activate(x, SHARED, "s_team3")
    apps = x.client.get("/api/me/apps", headers=x.bob).json()["apps"]
    kinds = [a["placement"] for a in apps]
    assert kinds == sorted(kinds, key=lambda k: k != "person") and [a["order"] for a in apps] == list(range(len(apps)))


def test_programs_list_hides_person_apps_from_members_outside_their_audience(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    assert install(x, SOLO).status_code == 200
    names = lambda h: {p["id"] for p in x.client.get("/api/programs", headers=h).json()}  # noqa: E731
    assert SOLO in names(x.bob) and SOLO not in names(x.cy)
    assert SOLO in names(x.ann)                                            # admins still see the whole catalogue
    assert SHARED in names(x.cy)                                           # swarm apps unchanged


def test_landing_pref_round_trips_and_rejects_other_values(x):
    r = x.client.put("/api/me/ui", headers=x.bob, json={"landing": "pro"})
    assert r.status_code == 200, r.text
    assert x.client.get("/api/me/ui", headers=x.bob).json()["prefs"]["landing"] == "pro"
    assert x.client.put("/api/me/ui", headers=x.bob, json={"landing": "sideways"}).status_code == 400
    r = x.client.put("/api/me/ui", headers=x.bob, json={"layout": "rail"})
    assert "landing" not in (x.client.get("/api/me/ui", headers=x.bob).json()["prefs"] or {})   # absent means awake
    assert json.loads(json.dumps(r.json())) is not None


def test_an_admin_audit_flag_never_widens_the_app_list(x):
    swarm(x, "s_bob_personal2", visibility="private", owner=BOB_P, personal_of=BOB_P)
    activate(x, SHARED, "s_bob_personal2")
    listed = MyApps(x.hive).list(Viewer(ANN_P, True, audit=True), ANN_P)["apps"]
    assert all(a["open"].get("swarm_id") != "s_bob_personal2" for a in listed)
    r = x.client.get("/api/me/apps?include=personal", headers=x.ann)
    assert all(a["open"].get("swarm_id") != "s_bob_personal2" for a in r.json()["apps"])


def test_install_status_hides_a_person_app_from_members_outside_its_audience(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    assert install(x, SOLO).status_code == 200
    assert x.client.get(f"/api/programs/{SOLO}/install", headers=x.cy).status_code == 404
    assert x.client.get(f"/api/programs/{SOLO}/install", headers=x.bob).status_code == 200
    assert x.client.get(f"/api/programs/{SOLO}/install", headers=x.ann).status_code == 200


def test_listing_publishes_nothing_and_does_not_rehash(x, monkeypatch):
    swarm(x, "s_team9")
    activate(x, SHARED, "s_team9")
    published, hashed = [], []
    monkeypatch.setattr(x.hive.events, "publish", lambda *a, **k: published.append(a))
    monkeypatch.setattr(x.hive.programs, "check_integrity", lambda e: hashed.append(e["id"]))
    ids(x, x.bob)
    assert published == [] and hashed == []


# ---- Jon 11-04/11-05: only what is supposed to be visible; Create is one app with its benches inside

def test_host_test_scaffolding_is_never_listed(x):
    from hive.core.my_apps import listed
    # the release ships these two for host contract tests; they are never a person's app
    assert not listed({"id": "contract-fixture"}) and not listed({"id": "code-project-test"})
    assert listed({"id": "commons-explorer"})
    swarm(x, "s_team")
    for pid in (SHARED, "contract-fixture", "code-project-test"):
        activate(x, pid, "s_team")
    got = ids(x, x.bob)
    assert SHARED in got and "contract-fixture" not in got and "code-project-test" not in got


def test_create_is_one_app_named_create_with_code_and_flow_inside_it(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, "omegadesign": {"name": "OmegaDesign", "version": "1.0.0", "capabilities": []},
                           "omegacode": {"name": "OmegaCode", "version": "1.0.0", "capabilities": []},
                           "omegaflow": {"name": "OmegaFlow", "version": "1.0.0", "capabilities": []}})
    swarm(x, "s_studio"); swarm(x, "s_team")
    for pid, sid in (("omegadesign", "s_studio"), ("omegadesign", "s_team"), ("omegacode", "s_team"), ("omegaflow", "s_team"), (SHARED, "s_team")):
        activate(x, pid, sid)
    apps = x.client.get("/api/me/apps", headers=x.bob).json()["apps"]
    create = [a for a in apps if a["id"] == "omegadesign"]
    assert len(create) == 1 and create[0]["name"] == "Create"
    assert "omegacode" not in {a["id"] for a in apps}                     # a bench of Create
    assert "omegaflow" not in {a["id"] for a in apps}                     # a bench of Create too
    assert SHARED in {a["id"] for a in apps}
    assert [a["order"] for a in apps] == list(range(len(apps)))


def test_without_create_the_code_app_is_still_listed_on_its_own(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, "omegacode": {"name": "OmegaCode", "version": "1.0.0", "capabilities": []},
                           "omegaflow": {"name": "OmegaFlow", "version": "1.0.0", "capabilities": []}})
    swarm(x, "s_team")
    activate(x, "omegacode", "s_team"); activate(x, "omegaflow", "s_team")
    assert {"omegacode", "omegaflow"} <= set(ids(x, x.bob))

