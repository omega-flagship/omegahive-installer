"""First Light R1a (host): per-person onboarding progress, the member "finish setting up" list, Kimi as an outside CLI
with a billing label, and the personal mind's first hello. Synthetic people and keys only."""

import pathlib
import sqlite3
import tempfile

import pytest

from hive.core import onboarding
from hive.core.db import now
from hive.core.mcp import BILLING, HARNESSES
from hive.tests.test_personal_mind import _client, _env, _person
from hive.tests.test_people_api import PETTA

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


@pytest.fixture()
def hive_app(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("HIVE_ASK_CONDUCTOR_MODEL", raising=False)
    app, google, sup, tmp = _env(monkeypatch)
    c, admin = _client(app)
    try:
        yield app, c, admin, google, sup
    finally:
        c.__exit__(None, None, None)


def _err(r):
    return r.json()["error"]["code"]


# ---- 1. progress: the person's own, validated, versioned ------------------------------------------------------------

def test_progress_blank_then_written_and_survives_sign_out(hive_app):
    app, c, admin, google, _ = hive_app
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    blank = c.get("/api/me/onboarding", headers=ana).json()
    assert blank["status"] == "not_started" and blank["version"] == 0 and blank["beats_done"] == []
    assert blank["beats"] == list(onboarding.BEATS) and blank["role_paths"] == ["admin", "coder", "researcher", "explorer"]
    r = c.put("/api/me/onboarding", headers=ana, json={"current_beat": "models", "beats_done": ["look", "arrive"],
                                                         "beats_skipped": ["tour"], "role_path": "coder",
                                                         "monthly_spend_usd": 20})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["beats_done"] == ["arrive", "look"]          # the shared order, no repeats
    assert body["status"] == "in_progress" and body["version"] == 1 and body["started_at"] and body["finished_at"] is None
    started = body["started_at"]
    # PATCH merges; finishing stamps finished_at; started_at never moves
    body = c.patch("/api/me/onboarding", headers=ana, json={"status": "finished", "version": 1}).json()
    assert body["role_path"] == "coder" and body["status"] == "finished" and body["finished_at"] and body["version"] == 2
    assert body["started_at"] == started
    # sign out (the session ends) and sign in again: same person, same record
    c.post("/api/auth/logout", headers=ana)
    google.account = {"email": "ana@example.com", "email_verified": True, "name": "Ana"}
    from hive.tests.test_people_api import sign_in
    r, _ = sign_in(c)
    again = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": r.cookies.get("hive_signin")}).json()
    c.cookies.clear()
    ana2 = {"Authorization": f"Bearer {again['token']}"}
    assert again["user"]["id"] == ana_id
    assert c.get("/api/me/onboarding", headers=ana2).json()["version"] == 2
    # PUT replaces: what is not given goes back to blank
    body = c.put("/api/me/onboarding", headers=ana2, json={"current_beat": "hello"}).json()
    assert body["role_path"] is None and body["beats_done"] == [] and body["status"] == "in_progress"
    assert body["finished_at"] is None and body["started_at"] == started


def test_progress_is_only_the_persons_own(hive_app):
    app, c, admin, google, _ = hive_app
    ana, _ = _person(c, admin, google, "ana@example.com", "Ana")
    bo, _ = _person(c, admin, google, "bo@example.com", "Bo")
    c.put("/api/me/onboarding", headers=ana, json={"role_path": "researcher", "monthly_spend_usd": 5})
    assert c.get("/api/me/onboarding", headers=bo).json()["version"] == 0           # another person sees none of it
    c.patch("/api/me/onboarding", headers=bo, json={"role_path": "explorer"})
    assert c.get("/api/me/onboarding", headers=ana).json()["role_path"] == "researcher"
    # the loopback operator, a mind's token and nobody are refused; no route names another person
    assert _err(c.get("/api/me/onboarding", headers=admin)) == "person_required"
    assert c.put("/api/me/onboarding", headers=admin, json={}).status_code == 403
    swarm = c.post("/api/swarms", json={"name": "Team"}, headers=admin).json()
    mind = c.post("/api/agents", json={"name": "M", "swarm_id": swarm["id"]}, headers=admin).json()
    assert c.get("/api/me/onboarding", headers={"Authorization": f"Bearer {mind['token']}"}).status_code == 401
    assert c.get("/api/me/onboarding").status_code == 401
    assert c.get("/api/me/setup", headers=admin).status_code == 403
    assert c.post("/api/me/personal-mind/hello", headers=admin).status_code == 403


def test_identity_change_never_sees_the_previous_persons_record(hive_app):
    """One browser, two people one after the other: the second reads their own (blank) record, never the first's."""
    app, c, admin, google, _ = hive_app
    ana, _ = _person(c, admin, google, "ana@example.com", "Ana")
    c.patch("/api/me/onboarding", headers=ana, json={"role_path": "admin", "key_choice": "hive-keys"})
    c.post("/api/auth/logout", headers=ana)
    bo, _ = _person(c, admin, google, "bo@example.com", "Bo")
    mine = c.get("/api/me/onboarding", headers=bo).json()
    assert mine["role_path"] is None and mine["key_choice"] is None and mine["version"] == 0
    assert [i for i in c.get("/api/me/setup", headers=bo).json()["items"] if i["id"] == "provider_key"][0]["done"] is False
    # and a disabled person is refused outright
    hive = app.state.hive
    bo_row = hive.db.one("SELECT id FROM people WHERE email = 'bo@example.com'")
    hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", (bo_row["id"],))
    assert c.get("/api/me/onboarding", headers=bo).status_code in (401, 403)


@pytest.mark.parametrize("body", [
    {"current_beat": "lunch"},
    {"beats_done": ["arrive", "nap"]},
    {"beats_done": "arrive"},
    {"beats_done": ["arrive"], "beats_skipped": ["arrive"]},
    {"role_path": "boss"},
    {"monthly_spend_usd": -1},
    {"monthly_spend_usd": True},
    {"monthly_spend_usd": 1e9},
    {"monthly_spend_usd": "10"},
    {"key_choice": "theirs"},
    {"status": "not_started"},
    {"status": "done"},
    {"finished_at": "2026-01-01"},
    {"version": "1"},
    {"version": -1},
])
def test_progress_validation_refuses_whole(hive_app, body):
    app, c, admin, google, _ = hive_app
    ana, _ = _person(c, admin, google, "ana@example.com", "Ana")
    c.patch("/api/me/onboarding", headers=ana, json={"role_path": "coder"})
    for method in (c.put, c.patch):
        r = method("/api/me/onboarding", headers=ana, json=body)
        assert r.status_code == 400 and _err(r) == "invalid", (body, r.text)
    after = c.get("/api/me/onboarding", headers=ana).json()
    assert after["role_path"] == "coder" and after["version"] == 1                   # nothing was written


def test_progress_stale_version_and_size(hive_app):
    app, c, admin, google, _ = hive_app
    ana, _ = _person(c, admin, google, "ana@example.com", "Ana")
    c.patch("/api/me/onboarding", headers=ana, json={"role_path": "coder"})
    r = c.patch("/api/me/onboarding", headers=ana, json={"role_path": "explorer", "version": 0})
    assert r.status_code == 409 and _err(r) == "stale_onboarding"
    assert r.json()["error"]["current"]["role_path"] == "coder" and r.json()["error"]["current"]["version"] == 1
    assert c.get("/api/me/onboarding", headers=ana).json()["role_path"] == "coder"
    assert c.patch("/api/me/onboarding", headers=ana, json={"role_path": "explorer", "version": 1}).status_code == 200
    r = c.put("/api/me/onboarding", headers=ana, content=b'{"role_path": "' + b"x" * 5000 + b'"}')
    assert r.status_code == 413 and _err(r) == "too_large"
    assert c.put("/api/me/onboarding", headers=ana, content=b"[]").status_code == 400


def test_schema_is_additive_tables_only(hive_app):
    app = hive_app[0]
    cols = {r["name"] for r in app.state.hive.db.all("PRAGMA table_info(onboarding_progress)")}
    assert {"principal", "current_beat", "beats_done", "beats_skipped", "role_path", "monthly_spend_usd", "key_choice",
            "status", "started_at", "finished_at", "updated_at", "version"} <= cols


# ---- 2. the "finish setting up" list -------------------------------------------------------------------------------

def test_setup_list_is_derived_from_live_state(hive_app):
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"

    def items():
        out = c.get("/api/me/setup", headers=ana).json()
        return out, {i["id"]: i for i in out["items"]}

    out, it = items()
    assert [i["id"] for i in out["items"]] == ["provider_key", "monthly_limit", "ask_prefs", "mind_awake", "outside_tool",
                                               "onboarding"]
    assert not any(i["done"] for i in out["items"]) and out["done"] == 0 and out["total"] == 5 and out["complete"] is False
    assert all(i["label"] and i["route"].startswith("#/") for i in out["items"])
    assert it["outside_tool"]["optional"] is True and it["monthly_limit"]["detail"]["allowance_usd"] == 50.0
    assert "dot" not in " ".join(i["label"].lower() for i in out["items"])

    # provider key: "own-key" chosen but no key is not done; a key the person owns is; or the hive's by choice
    c.patch("/api/me/onboarding", headers=ana, json={"key_choice": "own-key"})
    assert items()[1]["provider_key"]["done"] is False
    hive.keyring.ring.setdefault("keys", {})["k_test"] = {"id": "k_test", "owner": principal, "provider": "anthropic"}
    assert items()[1]["provider_key"]["done"] is True and items()[1]["provider_key"]["detail"]["own_keys"] == 1
    del hive.keyring.ring["keys"]["k_test"]                       # live, not remembered: the key going undoes it
    assert items()[1]["provider_key"]["done"] is False
    c.patch("/api/me/onboarding", headers=ana, json={"key_choice": "hive-keys"})
    assert items()[1]["provider_key"]["done"] is True

    c.patch("/api/me/onboarding", headers=ana, json={"monthly_spend_usd": 25})
    assert items()[1]["monthly_limit"]["done"] is True and items()[1]["monthly_limit"]["detail"]["chosen_usd"] == 25.0

    assert c.put("/api/me/ask", headers=ana, json={"thread_budget_usd": 0.5}).status_code == 200
    assert items()[1]["ask_prefs"]["done"] is True

    assert c.post("/api/me/personal-mind/hello", headers=ana).status_code == 200
    assert items()[1]["mind_awake"]["done"] is True

    # an outside tool that this person brought in and that joined
    swarm = c.post("/api/swarms", json={"name": "Tools"}, headers=admin).json()
    _, code = hive.harnesses.invite("kimi", "Kimi", swarm["id"], by=principal)
    assert items()[1]["outside_tool"]["done"] is False            # invited is not joined
    assert hive.harnesses.member(code) is not None
    assert items()[1]["outside_tool"]["done"] is True

    c.patch("/api/me/onboarding", headers=ana, json={"status": "skipped"})
    out, it = items()
    assert it["onboarding"]["done"] is True and out["complete"] is True and out["done"] == 5
    assert not hive.db.all("SELECT name FROM sqlite_master WHERE name LIKE '%setup%'")   # nothing about it is stored


# ---- 3. Kimi and billing --------------------------------------------------------------------------------------------

def test_kimi_is_a_supported_harness_with_join_steps_and_billing(hive_app):
    app, c, admin, google, _ = hive_app
    assert "kimi" in HARNESSES
    cat = {h["id"]: h for h in c.get("/api/harnesses", headers=admin).json()["harnesses"]}
    assert set(cat) == {"claude-code", "codex", "hermes", "kimi", "mcp"}
    assert cat["kimi"]["label"] == "Kimi CLI" and cat["kimi"]["billing"] == list(BILLING)
    assert "kimi mcp add --transport http omegahive {url}" in cat["kimi"]["setup"][0]["text"]
    assert c.get("/api/harnesses").status_code == 401
    swarm = c.post("/api/swarms", json={"name": "Team"}, headers=admin).json()
    inv = c.post("/api/harness-invites", json={"harness": "kimi", "name": "Kimi", "swarm_id": swarm["id"]}, headers=admin).json()
    assert inv["harness_label"] == "Kimi CLI" and inv["billing"] == "own-subscription"
    assert inv["setup"] == [{"label": "In a terminal", "text": "kimi mcp add --transport http omegahive "
                             f"{inv['mcp_url']} --header \"Authorization: Bearer {inv['code']}\""}]
    inv2 = c.post("/api/harness-invites", json={"harness": "codex", "name": "Cx", "swarm_id": swarm["id"],
                                                "billing": "hive-keys"}, headers=admin).json()
    assert inv2["billing"] == "hive-keys" and "{code}" not in inv2["setup"][1]["text"]
    r = c.post("/api/harness-invites", json={"harness": "kimi", "name": "K2", "swarm_id": swarm["id"], "billing": "free"},
               headers=admin)
    assert r.status_code == 400 and _err(r) == "bad_billing"
    listing = {i["name"]: i for i in c.get("/api/harness-invites", headers=admin).json()}
    assert listing["Kimi"]["billing"] == "own-subscription" and listing["Cx"]["billing"] == "hive-keys"
    assert "code" not in listing["Kimi"] and "setup" not in listing["Kimi"]       # the code is shown once, at invite


def test_billing_column_is_added_to_an_older_database(monkeypatch):
    """An invite table from before R1a gains billing; its rows read as own-subscription (what they always were)."""
    tmp = tempfile.mkdtemp(prefix="hive-fl-old-")
    con = sqlite3.connect(pathlib.Path(tmp) / "hive.db")
    con.execute("""CREATE TABLE harness_invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, harness TEXT NOT NULL, name TEXT NOT NULL, swarm_id TEXT NOT NULL,
  role_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at REAL NOT NULL,
  redeemed_at TEXT, agent_id TEXT, revoked_at TEXT)""")
    con.execute("INSERT INTO harness_invites VALUES ('hi_old', 'h', 'codex', 'Old', 's_x', NULL, 'user:operator', "
                "'2026-10-01T00:00:00.000Z', 0, NULL, NULL, NULL)")
    con.commit()
    con.close()
    app, _, _, _ = _env(monkeypatch, tmp)
    hive = app.state.hive
    cols = {r["name"]: r for r in hive.db.all("PRAGMA table_info(harness_invites)")}
    assert "billing" in cols and cols["billing"]["dflt_value"] == "'own-subscription'"
    rows = hive.harnesses.list()
    assert rows[0]["id"] == "hi_old" and rows[0]["billing"] == "own-subscription"
    swarm = hive.create_swarm("Tools")
    view, _ = hive.harnesses.invite("kimi", "Kimi", swarm["id"], billing="hive-keys")   # new rows store it
    assert hive.harnesses.get(view["id"])["billing"] == "hive-keys"


# ---- 4. wake and greet ----------------------------------------------------------------------------------------------

def test_hello_wakes_the_persons_own_mind_once_and_returns_the_greeting(hive_app):
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    c.patch("/api/me/onboarding", headers=ana, json={"role_path": "coder"})
    assert c.get("/api/me/personal-mind/hello", headers=ana).json() == {"hello": None}
    mind = hive.personal.mind_row(principal)
    assert sup.starts == []
    r = c.post("/api/me/personal-mind/hello", headers=ana)
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["created"] is True and first["state"] == "waiting" and first["greeting"] is None
    assert first["mind"]["id"] == mind["id"] and first["conversation_id"] == f"c_{mind['id']}~{principal}"
    assert sup.starts == [mind["id"]]                                          # woken through the ordinary wake
    notes = hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in'", (mind["id"],))
    assert len(notes) == 1 and notes[0]["sender"] == "hive:first-light"
    assert notes[0]["conversation_id"] == first["conversation_id"]
    assert "greet Ana by name" in notes[0]["text"] and "write and review code" in notes[0]["text"]
    # a second call: the same hello, nothing sent, nothing woken
    again = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert again["created"] is False and again["message_id"] == first["message_id"]
    assert sup.starts == [mind["id"]]
    assert len(hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND direction = 'in'", (mind["id"],))) == 1
    # the mind answers in that conversation through the ordinary path; the hello now carries its greeting
    hive.record_agent_message(mind["id"], {"text": "Hi Ana, I'm awake. Shall we look at your repository?",
                                           "conversation_id": first["conversation_id"]})
    done = c.post("/api/me/personal-mind/hello", headers=ana).json()
    assert done["state"] == "greeted" and done["greeting"]["text"].startswith("Hi Ana") and done["created"] is False
    assert c.get("/api/me/personal-mind/hello", headers=ana).json()["hello"]["greeting"]["text"].startswith("Hi Ana")
    # and the person reads it in their own chat with the mind
    msgs = c.get(f"/api/agents/{mind['id']}/messages", headers=ana,
                 params={"conversation_id": first["conversation_id"]}).json()
    assert [m["direction"] for m in msgs] == ["in", "out"]
    assert sup.starts == [mind["id"]] and hive.db.all("SELECT * FROM usage") == []


def test_hello_is_only_for_the_person_and_their_own_mind(hive_app):
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    bo, bo_id = _person(c, admin, google, "bo@example.com", "Bo")
    a = c.post("/api/me/personal-mind/hello", headers=ana).json()
    b = c.post("/api/me/personal-mind/hello", headers=bo).json()
    assert a["mind"]["id"] == hive.personal.mind_row(f"user:{ana_id}")["id"]
    assert b["mind"]["id"] == hive.personal.mind_row(f"user:{bo_id}")["id"] and a["mind"]["id"] != b["mind"]["id"]
    assert b["created"] is True                                                  # Ana's hello is not Bo's
    hive.record_agent_message(a["mind"]["id"], {"text": "Hi Ana", "conversation_id": a["conversation_id"]})
    assert c.get("/api/me/personal-mind/hello", headers=bo).json()["hello"]["greeting"] is None


def test_hello_refuses_with_a_reason_when_the_mind_cannot_think(hive_app, monkeypatch):
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    mind = hive.personal.mind_row(principal)
    hive.db.execute("UPDATE agents SET model = 'anthropic/claude-sonnet-5-5' WHERE id = ?", (mind["id"],))

    def refused(code):
        r = c.post("/api/me/personal-mind/hello", headers=ana)
        assert r.status_code in (402, 409) and _err(r) == code, r.text
        assert r.json()["error"]["message"] == onboarding.SAY[code]
        assert sup.starts == [] and not hive.db.all("SELECT * FROM onboarding_hello")      # nothing woken, nothing claimed
        assert not hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (mind["id"],))

    refused("no_key")                                                       # no key for the mind's model
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-synthetic-test")
    hive.db.insert("usage", {"agent_id": mind["id"], "model": "anthropic/claude-sonnet-5-5", "prompt_tokens": 0,
                             "completion_tokens": 0, "cost_usd": 60.0, "created_at": now(), "payer": principal})
    refused("spend_limit")                                                  # past the member's $50 month allowance
    hive.db.execute("DELETE FROM usage")
    hive.db.execute("UPDATE agents SET model = 'nowhere/model' WHERE id = ?", (mind["id"],))
    refused("no_model")
    hive.db.execute("UPDATE agents SET model = 'anthropic/claude-sonnet-5-5' WHERE id = ?", (mind["id"],))
    r = c.post("/api/me/personal-mind/hello", headers=ana)                   # within the allowance: it goes
    assert r.status_code == 200 and r.json()["created"] is True and sup.starts == [mind["id"]]


def test_hello_refuses_an_admin_with_no_allowance(hive_app, monkeypatch):
    """An admin has no member default and no month rule: their personal mind has nothing to pay from (no_budget)."""
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    link = c.post("/api/invites", json={"email": "ad@example.com", "name": "Ad", "role": "admin"}, headers=admin).json()["link"]
    google.account = {"email": "ad@example.com", "email_verified": True, "name": "Ad"}
    c.cookies.clear()
    from hive.tests.test_people_api import sign_in
    r, _ = sign_in(c, link.split("invite=")[1])
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": r.cookies.get("hive_signin")}).json()
    c.cookies.clear()
    ad = {"Authorization": f"Bearer {session['token']}"}
    mind = hive.personal.mind_row(f"user:{session['user']['id']}")
    hive.db.execute("UPDATE agents SET model = 'anthropic/claude-sonnet-5-5' WHERE id = ?", (mind["id"],))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-synthetic-test")
    r = c.post("/api/me/personal-mind/hello", headers=ad)
    assert r.status_code == 402 and _err(r) == "no_budget" and sup.starts == []


def test_hello_that_cannot_wake_leaves_no_claim(hive_app):
    app, c, admin, google, sup = hive_app
    hive = app.state.hive
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    from hive.supervisor.drivers import StartRefused

    def refuse(agent_id):
        raise StartRefused("synthetic: cannot run here")
    sup.start = refuse
    r = c.post("/api/me/personal-mind/hello", headers=ana)
    assert r.status_code == 409 and _err(r) == "cannot_wake"
    assert not hive.db.all("SELECT * FROM onboarding_hello")
    sup.start = lambda agent_id: sup.starts.append(agent_id)
    assert c.post("/api/me/personal-mind/hello", headers=ana).json()["created"] is True     # a retry may go
