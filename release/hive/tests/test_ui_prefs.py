"""Your look and layout (Surface v1): per-person variants, validated as data, refused when unreadable, resettable."""

import copy
import json
import os
import pathlib
import secrets
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.db import now
from hive.core.hive import token_hash
from hive.core.programs import check_app
from hive.core import theme_rules
from hive.core.ui_prefs import ALPHA_KEYS, check_variant

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")
SEEDS = pathlib.Path(__file__).resolve().parents[1] / "ui" / "src" / "shell" / "uiVariants.seed.json"


class FakeSupervisor:
    def attach(self, hive): pass
    def prepare(self, agent, token): pass
    def reconfigure(self, agent): pass
    def start(self, agent_id): pass
    def stop(self, agent_id): pass
    def logs(self, agent_id, tail=200): return []
    def check(self): pass


def seeds():
    return json.loads(SEEDS.read_text())


@pytest.fixture()
def hive():
    tmp = tempfile.mkdtemp(prefix="hive-uiprefs-")
    settings = load_settings(data_dir=pathlib.Path(tmp), admin_password="pw", petta_path=PETTA, offline=True)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app) as c:
        admin = {"Authorization": "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]}

        def person(pid):
            token = secrets.token_urlsafe(16)
            app.state.hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                                  "principal": f"user:{pid}", "expires_at": time.time() + 3600})
            return {"Authorization": f"Bearer {token}"}

        yield c, admin, person


def test_every_seed_variant_passes_the_host_validator():
    for v in seeds():
        assert check_variant(v) == [], v["id"]


def test_defaults_to_nothing_then_stores_per_person_and_resets(hive):
    c, admin, person = hive
    ana, ben = person("ana"), person("ben")
    assert c.get("/api/me/ui", headers=ana).json()["prefs"] is None
    ember, deep = seeds()[0], seeds()[1]
    r = c.put("/api/me/ui", headers=ana, json={"variant": ember, "layout": None})
    assert r.status_code == 200 and r.json()["prefs"]["variant"]["id"] == ember["id"]
    c.put("/api/me/ui", headers=ben, json={"variant": deep, "layout": "rail"})
    # isolation: each person reads only their own; the operator has none
    assert c.get("/api/me/ui", headers=ana).json()["prefs"]["variant"]["id"] == ember["id"]
    assert c.get("/api/me/ui", headers=ben).json()["prefs"] == {"variant": deep, "layout": "rail", "apps": None, "experience": None}
    assert c.get("/api/me/ui", headers=admin).json()["prefs"] is None
    # reset clears only the caller
    assert c.delete("/api/me/ui", headers=ana).json()["prefs"] is None
    assert c.get("/api/me/ui", headers=ana).json()["prefs"] is None
    assert c.get("/api/me/ui", headers=ben).json()["prefs"]["variant"]["id"] == deep["id"]


def test_requires_sign_in(hive):
    c, _, _ = hive
    assert c.get("/api/me/ui").status_code == 401
    assert c.put("/api/me/ui", json={"variant": None}).status_code == 401


@pytest.mark.parametrize("mutate, needle", [
    (lambda v: v["colors"].__setitem__("ink", v["colors"]["void"]), "ink on void"),
    (lambda v: v["colors"].__setitem__("ink-4", "#161009"), "ink-4 on void"),
    (lambda v: v["colors"].__setitem__("ink", None), "colors.ink"),
    (lambda v: v["colors"].update({"ink": "#000000", "void": None, "abyss": None}), "colors.void"),
    (lambda v: v["colors"].__setitem__("accent", "url(https://evil.example/x)"), "colors.accent"),
    (lambda v: v["colors"].__setitem__("glass", "rgb(0 0 0 / 0.5); background:url(x)"), "colors.glass"),
    (lambda v: v["fonts"].__setitem__("sans", "x; } body { background: url(https://evil.example)"), "fonts.sans"),
    (lambda v: v.__setitem__("css", "body{}"), "unknown keys"),
    (lambda v: v.__setitem__("layout", "sideways"), "layout"),
    (lambda v: v["colors"].pop("bad"), "colors missing"),
    (lambda v: v.__setitem__("schema", "other/1"), "schema"),
])
def test_refuses_unreadable_or_non_data_variants(hive, mutate, needle):
    c, admin, _ = hive
    v = copy.deepcopy(seeds()[0])
    mutate(v)
    r = c.put("/api/me/ui", headers=admin, json={"variant": v})
    assert r.status_code == 400 and needle in r.text
    assert c.get("/api/me/ui", headers=admin).json()["prefs"] is None


def test_a_look_the_rules_can_repair_is_accepted_as_the_browser_wears_it(hive):
    """One source (theme.rules.json): the host refuses only what still falls short after the rules' repair."""
    c, admin, _ = hive
    v = copy.deepcopy(seeds()[0])
    v["colors"]["ink-4"] = "#222222"                       # 1.2:1 on void, but a lighter ink-4 reads: repaired, not refused
    assert theme_rules.check_look(v["colors"]) == []
    assert c.put("/api/me/ui", headers=admin, json={"variant": v}).status_code == 200


def test_host_and_browser_read_one_rules_file():
    assert set(ALPHA_KEYS) == set(theme_rules.RULES["translucent"])
    assert {(x["token"], x["against"]) for x in theme_rules.CHECKS} >= {("ink", "void"), ("primary-ink", "accent")}
    # the two-way repair (Dot R1.1 #3): on a mid-grey ground, ink passes on the far side
    grey = dict(seeds()[0]["colors"], void="#666666", abyss="#666666", ink="#aaaaaa")
    assert [f for f in theme_rules.check_look(grey) if f["token"] == "ink"] == []


def test_contrast_fails_closed_and_decides_on_the_exact_ratio():
    base = dict(seeds()[0]["colors"])
    nul = theme_rules.check_look(dict(base, ink=None))
    assert any(f["token"] == "ink" and f["ratio"] is None for f in nul)
    assert theme_rules.check_look(dict(base, ink="#000000", void=None, abyss=None))
    assert check_variant(dict(seeds()[0], colors=dict(base, ink=None)))
    # 2.9997:1 rounds to 3.00 but is below the 3:1 floor: decided exactly, as the browser does (themeCheck.ts)
    assert 2.9995 < theme_rules.contrast("#725180", "#080822") < 3.0
    edge = theme_rules.check_look({**base, "void": "#04040f", "abyss": "#080822", "accent-2": "#725180"})
    assert not [f for f in edge if f["token"] == "accent-2"]   # repaired, not passed as 3.00


def test_refuses_unknown_body_keys_and_oversize(hive):
    c, admin, _ = hive
    assert c.put("/api/me/ui", headers=admin, json={"theme": {}}).status_code == 400
    v = copy.deepcopy(seeds()[0])
    v["blurb"] = "x" * 161
    assert c.put("/api/me/ui", headers=admin, json={"variant": v}).status_code == 400


def test_designed_app_identities_pass_the_app_theme_validator_unchanged():
    pack = json.loads((SEEDS.parent / "appIdentities.json").read_text())
    assert {"omegatruth", "atlas", "omegafusion"} <= set(pack)
    for program_id, ident in pack.items():
        app, warnings = check_app({"theme": ident["theme"]})
        assert warnings == [], (program_id, warnings)
        assert app["theme"] == ident["theme"], program_id


def test_app_identity_choice_is_stored_and_checked(hive):
    c, admin, _ = hive
    assert c.put("/api/me/ui", headers=admin, json={"variant": None, "apps": "designed"}).json()["prefs"]["apps"] == "designed"
    assert c.put("/api/me/ui", headers=admin, json={"apps": "everything"}).status_code == 400


def test_experience_is_a_slug_choice(hive):
    c, admin, _ = hive
    assert c.put("/api/me/ui", headers=admin, json={"experience": "cosmos"}).json()["prefs"]["experience"] == "cosmos"
    assert c.put("/api/me/ui", headers=admin, json={"experience": "../../x"}).status_code == 400


@pytest.mark.parametrize("fonts", [{"sans": " , ,"}, {"display": "''"}, {"mono": "-"}])
def test_refuses_font_stacks_without_a_family(hive, fonts):
    c, admin, _ = hive
    v = copy.deepcopy(seeds()[0])
    v["fonts"] = fonts
    r = c.put("/api/me/ui", headers=admin, json={"variant": v})
    assert r.status_code == 400 and "fonts." in r.text


def test_malformed_colours_refuse_and_never_error(hive):
    c, admin, _ = hive
    v = copy.deepcopy(seeds()[0])
    v["colors"]["void"] = "rgb(0 0 0 / 1)"
    v["colors"]["accent"] = 12
    r = c.put("/api/me/ui", headers=admin, json={"variant": v})
    assert r.status_code == 400


def test_body_size_is_capped_before_parsing(hive):
    c, admin, _ = hive
    r = c.put("/api/me/ui", headers={**admin, "content-type": "application/json"}, content=b'{"variant": null, "pad": "' + b"x" * 20000 + b'"}')
    assert r.status_code == 413


# ---- revisions: a write made against an older look is refused, so a late or stale save can never win ----------------

def test_rev_starts_at_zero_and_every_write_bumps_it(hive):
    c, admin, person = hive
    ana = person("ana")
    ember, deep = seeds()[0], seeds()[1]
    assert c.get("/api/me/ui", headers=ana).json() == {"prefs": None, "updated_at": None, "rev": 0}
    assert c.put("/api/me/ui", headers=ana, json={"variant": ember}).json()["rev"] == 1
    assert c.put("/api/me/ui", headers=ana, json={"variant": deep}).json()["rev"] == 2
    r = c.delete("/api/me/ui", headers=ana).json()
    assert r["prefs"] is None and r["rev"] == 3          # a reset keeps counting up, never back to 0
    assert c.get("/api/me/ui", headers=ana).json()["rev"] == 3


def test_a_matching_base_rev_writes_and_a_stale_one_changes_nothing(hive):
    c, admin, person = hive
    ana = person("ana")
    ember, deep = seeds()[0], seeds()[1]
    assert c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": "0"}, json={"variant": ember}).json()["rev"] == 1
    before = c.get("/api/me/ui", headers=ana).json()
    r = c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": "0"}, json={"variant": deep})
    assert r.status_code == 409
    error = r.json()["error"]
    assert error["code"] == "stale_ui_prefs"
    assert error["current"] == before                      # the host's current look, to reconcile against
    assert c.get("/api/me/ui", headers=ana).json() == before
    r = c.delete("/api/me/ui", headers={**ana, "X-UI-Base-Rev": "0"})
    assert r.status_code == 409 and c.get("/api/me/ui", headers=ana).json() == before
    assert c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": "1"}, json={"variant": deep}).json()["rev"] == 2


def test_the_reviewed_late_save_sequences_end_on_the_newer_look(hive):
    """Stand-in r1k findings 1 and 2: the older save (Ember) was sent against rev n; the newer one (Deep Sea) also
    against rev n but lands first. Whether the older save lands late after a client timeout or after the person
    signed out and back in, it carries the stale rev and is refused, so the host ends where the page does."""
    c, admin, person = hive
    ana = person("ana")
    ember, deep = seeds()[0], seeds()[1]
    base = c.get("/api/me/ui", headers=ana).json()["rev"]
    newer = c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": str(base)}, json={"variant": deep})
    assert newer.status_code == 200
    late = c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": str(base)}, json={"variant": ember})
    assert late.status_code == 409 and late.json()["error"]["current"]["prefs"]["variant"]["id"] == deep["id"]
    assert c.get("/api/me/ui", headers=ana).json()["prefs"]["variant"]["id"] == deep["id"]
    # the same after a reset in between (rev keeps rising, so the old base can never match again)
    c.delete("/api/me/ui", headers=ana)
    assert c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": str(base)}, json={"variant": ember}).status_code == 409


def test_without_if_match_writes_stay_unconditional(hive):
    c, admin, person = hive
    ana = person("ana")
    ember, deep = seeds()[0], seeds()[1]
    c.put("/api/me/ui", headers=ana, json={"variant": ember})
    assert c.put("/api/me/ui", headers=ana, json={"variant": deep}).status_code == 200   # older clients keep working
    assert c.delete("/api/me/ui", headers=ana).status_code == 200


def test_revisions_are_per_person(hive):
    c, admin, person = hive
    ana, ben = person("ana"), person("ben")
    ember = seeds()[0]
    c.put("/api/me/ui", headers=ana, json={"variant": ember})
    c.put("/api/me/ui", headers=ana, json={"variant": ember})
    assert c.get("/api/me/ui", headers=ben).json()["rev"] == 0
    assert c.put("/api/me/ui", headers={**ben, "X-UI-Base-Rev": "0"}, json={"variant": ember}).json()["rev"] == 1
    assert c.get("/api/me/ui", headers=ana).json()["rev"] == 2


@pytest.mark.parametrize("value", ["-1", "1.5", "abc", "", "W/\"1\"", "\"0\"", "*", "0, 1", "1 2", "+1", "9" * 19])
def test_a_malformed_if_match_is_refused_before_anything_is_written(hive, value):
    c, admin, person = hive
    ana = person("ana")
    r = c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": value}, json={"variant": seeds()[0]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"
    assert c.get("/api/me/ui", headers=ana).json()["rev"] == 0


def test_an_invalid_body_is_refused_whatever_the_revision(hive):
    c, admin, person = hive
    ana = person("ana")
    assert c.put("/api/me/ui", headers={**ana, "X-UI-Base-Rev": "7"}, json={"theme": {}}).status_code == 400


def test_a_repeated_base_rev_header_is_refused(hive):
    c, admin, person = hive
    ana = person("ana")
    r = c.put("/api/me/ui", headers=[*ana.items(), ("X-UI-Base-Rev", "0"), ("X-UI-Base-Rev", "garbage")],
              json={"variant": seeds()[0]})
    assert r.status_code == 400 and c.get("/api/me/ui", headers=ana).json()["rev"] == 0


LOOK = {"variant": None, "layout": "rail", "apps": None, "experience": None}


@pytest.mark.parametrize("legacy", ["none", "reset", "put", "put-then-reset", "same-row-rewritten", "two-puts"])
def test_every_write_prepared_before_a_restart_is_refused_after_it(tmp_path, legacy):
    """A rollback-and-return restarts the host. Whatever an older host (which knows nothing of revisions) did to the
    looks meanwhile, including changes that leave no trace in the final row, every base issued before the restart is
    refused afterwards, and the revision never goes back or repeats (stand-in r3 finding 1-2)."""
    from hive.core.db import Database, now as stamp
    from hive.core.ui_prefs import StalePrefs, UiPrefs

    db = Database(tmp_path / "hive.sqlite3")
    prefs = UiPrefs(db)
    seen = [prefs.get("user:ana")["rev"]]
    seen.append(prefs.put("user:ana", LOOK, base_rev=seen[-1])["rev"])
    before = list(range(seen[-1] + 1))             # every base the clients could hold before the restart
    row = db.one("SELECT prefs, updated_at FROM ui_prefs WHERE principal = 'user:ana'")
    if legacy in ("put", "put-then-reset", "two-puts"):
        db.execute("UPDATE ui_prefs SET prefs = ?, updated_at = ? WHERE principal = 'user:ana'",
                   (json.dumps({**LOOK, "layout": "dock"}), stamp()))
    if legacy == "two-puts":
        db.execute("UPDATE ui_prefs SET prefs = ?, updated_at = ? WHERE principal = 'user:ana'",
                   (json.dumps({**LOOK, "layout": "topbar"}), stamp()))
    if legacy in ("reset", "put-then-reset"):
        db.execute("DELETE FROM ui_prefs WHERE principal = 'user:ana'")
    if legacy == "same-row-rewritten":          # an exact restore of the counted row leaves no trace at all
        db.execute("UPDATE ui_prefs SET prefs = ?, updated_at = ? WHERE principal = 'user:ana'",
                   (row["prefs"], row["updated_at"]))
    prefs = UiPrefs(db)                         # the host starts again
    after = prefs.get("user:ana")
    assert after["rev"] > max(seen) and prefs.get("user:ana") == after     # moved on, and stable across reads
    for base in before:
        with pytest.raises(StalePrefs):
            prefs.put("user:ana", {**LOOK, "layout": "topbar"}, base_rev=base)
    assert prefs.get("user:ana") == after
    assert prefs.put("user:ana", LOOK, base_rev=after["rev"])["rev"] == after["rev"] + 1


def test_a_person_who_never_saved_also_moves_on_with_each_start(tmp_path):
    from hive.core.db import Database
    from hive.core.ui_prefs import StalePrefs, UiPrefs

    db = Database(tmp_path / "hive.sqlite3")
    assert UiPrefs(db).get("user:ben")["rev"] == 0
    prefs = UiPrefs(db)
    assert prefs.get("user:ben")["rev"] == 1
    with pytest.raises(StalePrefs):
        prefs.reset("user:ben", base_rev=0)
    assert prefs.reset("user:ben", base_rev=1)["rev"] == 2


def test_a_read_takes_the_look_and_its_revision_in_one_statement():
    """Structural guard: the look and its revision come from one SQL statement (one committed state). A write landing
    between two separate SELECTs could otherwise pair the old look with the new revision (stand-in r2 finding 2)."""
    import inspect

    from hive.core import ui_prefs as module
    source = inspect.getsource(module.UiPrefs._read)
    assert source.count("self.db.one(") == 1 and "ui_prefs_revision" in source


def test_an_older_tables_saved_looks_are_kept(tmp_path):
    """A hive created by an older host keeps every saved look; its counter starts from 0."""
    import sqlite3

    from hive.core.db import Database
    from hive.core.ui_prefs import UiPrefs

    path = tmp_path / "hive.sqlite3"
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE ui_prefs (principal TEXT PRIMARY KEY, prefs TEXT NOT NULL, updated_at TEXT NOT NULL)")
    conn.execute("INSERT INTO ui_prefs VALUES ('user:ana', ?, 'then')", (json.dumps({"variant": None, "layout": "rail", "apps": None, "experience": None}),))
    conn.commit()
    conn.close()
    prefs = UiPrefs(Database(path))
    assert prefs.get("user:ana") == {"prefs": {"variant": None, "layout": "rail", "apps": None, "experience": None}, "updated_at": "then", "rev": 0}
    assert prefs.put("user:ana", {"layout": "dock"}, base_rev=0)["rev"] == 1
