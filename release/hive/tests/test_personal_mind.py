"""Personal minds P1: one per named person, asleep, never woken; backfill; GET/POST /api/me/mind owner only."""

import json
import pathlib
import tempfile
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.tests.test_people_api import PETTA, FakeGoogle, FakeSupervisor, sign_in

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


class CountingSupervisor(FakeSupervisor):
    def __init__(self):
        self.starts, self.prepared = [], []

    def prepare(self, agent, token):
        self.prepared.append(agent["id"])

    def start(self, agent_id):
        self.starts.append(agent_id)


def _env(monkeypatch, tmp=None, family=False):
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setenv("HIVE_GOOGLE_CLIENT_SECRET", "shh")
    monkeypatch.setenv("HIVE_GOOGLE_REDIRECT_URI", "https://hive.example/omegahive/api/auth/google/callback")
    monkeypatch.setenv("HIVE_PUBLIC_BASE", "https://hive.example")
    if not family:
        monkeypatch.setenv("HIVE_SSO_USERS", "")
    tmp = tmp or tempfile.mkdtemp(prefix="hive-personal-")
    settings = load_settings(data_dir=pathlib.Path(tmp), admin_password="pw", petta_path=PETTA, offline=True, base_path="/omegahive")
    sup = CountingSupervisor()
    app = create_app(settings, supervisor=sup, reconcile_seconds=0)
    google = FakeGoogle()
    app.state.hive.people.client = httpx.AsyncClient(transport=httpx.MockTransport(google.handler))
    return app, google, sup, tmp


def _client(app):
    c = TestClient(app, base_url="https://hive.example")
    c.__enter__()
    admin = {"Authorization": "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]}
    return c, admin


def _person(c, admin, google, email, name):
    """Invite and sign in one person through the hive's Google flow; returns their bearer headers and person id."""
    link = c.post("/api/invites", json={"email": email, "name": name, "role": "member"}, headers=admin).json()["link"]
    google.account = {"email": email, "email_verified": True, "name": name}
    c.cookies.clear()
    r, _ = sign_in(c, link.split("invite=")[1])
    cookie = r.cookies.get("hive_signin")
    session = c.post("/omegahive/api/auth/sso", cookies={"hive_signin": cookie}).json()
    c.cookies.clear()
    return {"Authorization": f"Bearer {session['token']}"}, session["user"]["id"]


def _personal(hive, principal=None):
    sql, params = "SELECT * FROM agents WHERE personal_of IS NOT NULL AND deleted = 0", ()
    if principal:
        sql, params = sql + " AND personal_of = ?", (principal,)
    return hive.db.all(sql, params)


def test_first_signin_makes_exactly_one_asleep_personal_mind_and_never_starts_it(monkeypatch):
    app, google, sup, _ = _env(monkeypatch)
    c, admin = _client(app)
    hive = app.state.hive
    try:
        assert _personal(hive) == []
        ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
        rows = _personal(hive, f"user:{ana_id}")
        assert len(rows) == 1
        mind = rows[0]
        assert mind["kind"] == "omega" and mind["status"] == "asleep" and mind["desired"] == "asleep"
        assert mind["name"] == "Ana" and mind["owner"] == f"user:{ana_id}" and mind["visibility"] == "private"
        swarm = hive.db.one("SELECT * FROM swarms WHERE id = ?", (mind["swarm_id"],))
        assert swarm["personal_of"] == f"user:{ana_id}" and swarm["owner"] == f"user:{ana_id}" and swarm["visibility"] == "private"
        assert swarm["coordinator_id"] == mind["id"]
        assert [r["id"] for r in hive.db.all("SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm["id"],))] == [mind["id"]]
        # no lifetime figure of its own: the person pays, so their month allowance is its limit at call time
        assert mind["budget_usd"] == 0.0
        # creation never woke it and never called a model
        assert sup.starts == [] and hive.db.all("SELECT * FROM usage") == []
        # signing in again, and the exchange again, make nothing new
        google.account = {"email": "ana@example.com", "email_verified": True, "name": "Ana"}
        r, _ = sign_in(c)
        c.post("/omegahive/api/auth/sso", cookies={"hive_signin": r.cookies.get("hive_signin")})
        c.cookies.clear()
        assert len(_personal(hive, f"user:{ana_id}")) == 1 and sup.starts == []
        body = c.get("/api/me/mind", headers=ana).json()["mind"]
        assert body["id"] == mind["id"] and body["status"] == "asleep" and body["swarm_id"] == swarm["id"]
        assert body["allowance_usd"] == 50.0 and body["allowance_origin"] == "member-default"
        assert body["version"] is None and body["previous_version_id"] is None
        assert sup.starts == []
    finally:
        c.__exit__(None, None, None)


def test_backfill_is_idempotent_across_restarts(monkeypatch):
    app, google, sup, tmp = _env(monkeypatch)
    hive = app.state.hive
    for i, (email, name) in enumerate((("bo@example.com", "Bo"), ("cy@example.com", ""))):
        hive.db.insert("people", {"id": f"u_0000000{i}", "email": email, "name": name, "role": "member", "invited_by": "x",
                                  "created_at": "2026-10-01T00:00:00.000Z"})
    hive.db.insert("people", {"id": "u_00000009", "email": "off@example.com", "name": "Off", "role": "member",
                              "invited_by": "x", "created_at": "2026-10-01T00:00:00.000Z", "disabled": 1})
    assert _personal(hive) == []
    app2, _, sup2, _ = _env(monkeypatch, tmp)          # a restart: the backfill runs once
    hive2 = app2.state.hive
    rows = {r["personal_of"]: r for r in _personal(hive2)}
    assert set(rows) == {"user:u_00000000", "user:u_00000001"}            # the disabled person gets none
    assert rows["user:u_00000001"]["name"] == "cy"                          # no name: the address before the @
    assert all(r["status"] == "asleep" for r in rows.values()) and sup2.starts == []
    assert hive2.personal.backfill() == 0                                  # again: nothing new
    app3, _, sup3, _ = _env(monkeypatch, tmp)                              # and another restart
    assert sorted(r["id"] for r in _personal(app3.state.hive)) == sorted(r["id"] for r in rows.values())
    assert len(app3.state.hive.db.all("SELECT * FROM swarms WHERE personal_of IS NOT NULL")) == 2
    assert sup3.starts == [] and app3.state.hive.db.all("SELECT * FROM usage") == []


def test_operator_minds_and_unnamed_principals_get_none(monkeypatch):
    app, google, sup, _ = _env(monkeypatch)
    c, admin = _client(app)
    hive = app.state.hive
    try:
        r = c.get("/api/me/mind", headers=admin)                          # the loopback operator
        assert r.status_code == 403 and r.json()["error"]["code"] == "person_required"
        assert c.post("/api/me/mind", json={"name": "Op"}, headers=admin).status_code == 403
        swarm = c.post("/api/swarms", json={"name": "Team"}, headers=admin).json()
        mind = c.post("/api/agents", json={"name": "M", "swarm_id": swarm["id"]}, headers=admin).json()
        assert c.get("/api/me/mind", headers={"Authorization": f"Bearer {mind['token']}"}).status_code == 401   # a mind
        assert c.get("/api/me/mind").status_code == 401                                                      # signed out
        assert hive.personal.ensure("user:operator") is None and hive.personal.ensure(f"agent:{mind['id']}") is None
        assert hive.personal.ensure("user:dee") is None                     # a legacy family principal: no account here
        assert _personal(hive) == []
    finally:
        c.__exit__(None, None, None)


def test_legacy_family_principal_gets_none(monkeypatch):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="hive-family-"))
    (tmp / "sessions.json").write_text(json.dumps({"fam-tok": {"username": "dee", "expires": int(time.time()) + 3600}}))
    (tmp / "users.json").write_text(json.dumps({"dee": {"name": "Dee"}}))
    monkeypatch.setenv("HIVE_SSO_STATE_DIR", str(tmp))
    monkeypatch.setenv("HIVE_SSO_USERS", "dee")
    app, google, sup, _ = _env(monkeypatch, family=True)
    c, admin = _client(app)
    try:
        session = c.post("/omegahive/api/auth/sso", cookies={"omega_session": "fam-tok"}).json()
        c.cookies.clear()
        r = c.get("/api/me/mind", headers={"Authorization": f"Bearer {session['token']}"})
        assert r.status_code == 403 and _personal(app.state.hive) == []
    finally:
        c.__exit__(None, None, None)


def test_get_and_post_are_owner_only(monkeypatch):
    app, google, sup, _ = _env(monkeypatch)
    c, admin = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
        bo, bo_id = _person(c, admin, google, "bo@example.com", "Bo")
        a = c.get("/api/me/mind", headers=ana).json()["mind"]
        b = c.get("/api/me/mind", headers=bo).json()["mind"]
        assert a["id"] != b["id"] and a["name"] == "Ana" and b["name"] == "Bo"
        # Bo renames his own; Ana's is untouched. The body names nothing but the name: no id of anyone else's.
        r = c.post("/api/me/mind", json={"name": "Bo's mind"}, headers=bo).json()
        assert r["mind"]["id"] == b["id"] and r["mind"]["name"] == "Bo's mind" and r["created"] is False
        assert hive.swarm(b["swarm_id"])["name"] == "Bo's mind"
        assert c.get("/api/me/mind", headers=ana).json()["mind"]["name"] == "Ana"
        assert c.post("/api/me/mind", json={"name": "X", "id": a["id"]}, headers=bo).status_code == 400
        assert c.post("/api/me/mind", json={"name": " "}, headers=bo).status_code == 400
        # Bo cannot see Ana's mind or swarm through the ordinary routes (R13: private, not found)
        assert c.get(f"/api/agents/{a['id']}", headers=bo).status_code == 404
        assert c.get(f"/api/swarms/{a['swarm_id']}", headers=bo).status_code == 404
        assert c.patch(f"/api/agents/{a['id']}", json={"name": "mine"}, headers=bo).status_code == 404
        assert a["id"] not in {m["id"] for m in c.get("/api/agents", headers=bo).json()}
        assert hive.agent(a["id"])["name"] == "Ana"
        # re-create if missing: Ana's mind deleted, her POST makes a new one in her personal swarm, asleep
        hive.delete_agent(a["id"])
        r = c.post("/api/me/mind", json={"name": "Ana two"}, headers=ana).json()
        assert r["created"] is True and r["mind"]["id"] != a["id"] and r["mind"]["name"] == "Ana two"
        assert r["mind"]["swarm_id"] == a["swarm_id"] and r["mind"]["status"] == "asleep"
        assert len(_personal(hive, f"user:{ana_id}")) == 1 and sup.starts == []
        # and GET makes one again if it went missing (never null for a named person)
        hive.delete_agent(r["mind"]["id"])
        again = c.get("/api/me/mind", headers=ana).json()["mind"]
        assert again["status"] == "asleep" and again["name"] == "Ana"
        assert sup.starts == [] and hive.db.all("SELECT * FROM usage") == []
    finally:
        c.__exit__(None, None, None)


def test_one_live_personal_mind_per_person_is_enforced_by_the_schema(monkeypatch):
    app, google, sup, _ = _env(monkeypatch)
    hive = app.state.hive
    hive.db.insert("people", {"id": "u_0000000a", "email": "a@example.com", "name": "A", "role": "member", "invited_by": "x",
                              "created_at": "2026-10-01T00:00:00.000Z"})
    row = hive.personal.ensure("user:u_0000000a")
    other = hive.create_agent("Other", "omega", None, owner="user:u_0000000a")
    with pytest.raises(Exception):
        hive.db.execute("UPDATE agents SET personal_of = 'user:u_0000000a' WHERE id = ?", (other["id"],))
    assert hive.personal.ensure("user:u_0000000a")["id"] == row["id"]


def test_migration_adds_personal_of_to_an_old_database(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="hive-personal-old-")
    app, *_ = _env(monkeypatch, tmp)
    db = app.state.hive.db
    db.execute("DROP INDEX agents_personal_of")
    db.execute("DROP INDEX swarms_personal_of")
    db.execute("ALTER TABLE agents DROP COLUMN personal_of")
    db.execute("ALTER TABLE swarms DROP COLUMN personal_of")
    app2, *_ = _env(monkeypatch, tmp)
    for table in ("agents", "swarms"):
        assert "personal_of" in {r["name"] for r in app2.state.hive.db.all(f"PRAGMA table_info({table})")}


# ---- alone in its own swarm --------------------------------------------------------------------------------------------

def test_a_personal_swarm_holds_its_persons_mind_alone(monkeypatch):
    app, google, sup, _ = _env(monkeypatch)
    c, admin = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
        mine = c.get("/api/me/mind", headers=ana).json()["mind"]
        other = c.post("/api/swarms", json={"name": "Team"}, headers=admin).json()
        m = c.post("/api/agents", json={"name": "M", "swarm_id": other["id"]}, headers=admin).json()
        for who in (admin, ana):   # no one adds a mind to it, the owner included
            r = c.post("/api/agents", json={"name": "Extra", "swarm_id": mine["swarm_id"]}, headers=who)
            assert r.status_code == 400 and r.json()["error"]["code"] == "personal_swarm"
        r = c.patch(f"/api/agents/{m['id']}", json={"swarm_id": mine["swarm_id"]}, headers=admin)
        assert r.status_code == 400 and r.json()["error"]["code"] == "personal_swarm"
        for target in (other["id"], None):   # and the personal mind never leaves it
            r = c.patch(f"/api/agents/{mine['id']}", json={"swarm_id": target}, headers=admin)
            assert r.status_code == 400 and r.json()["error"]["code"] == "personal_swarm"
        assert [a["id"] for a in hive.db.all("SELECT id FROM agents WHERE swarm_id = ? AND deleted = 0", (mine["swarm_id"],))] == [mine["id"]]
        assert hive.agent(m["id"])["swarm_id"] == other["id"]
        # a room becoming a swarm cannot carry the personal mind off either
        room = c.post("/api/rooms", json={"kind": "group", "name": "G", "members": [f"agent:{mine['id']}"]}, headers=admin)
        assert room.status_code == 200, room.text
        swarms_before = len(hive.db.all("SELECT id FROM swarms"))
        r = c.post(f"/api/rooms/{room.json()['id']}/swarm", json={"move_minds": [mine["id"]]}, headers=admin)
        assert r.status_code == 400 and r.json()["error"]["code"] == "personal_swarm"
        assert hive.agent(mine["id"])["swarm_id"] == mine["swarm_id"] and len(hive.db.all("SELECT id FROM swarms")) == swarms_before
        # an admin may still delete it; the person's next read makes another, alone in the same swarm
        assert c.delete(f"/api/agents/{mine['id']}", headers=admin).status_code == 200
        again = c.get("/api/me/mind", headers=ana).json()["mind"]
        assert again["swarm_id"] == mine["swarm_id"] and again["status"] == "asleep" and sup.starts == []
    finally:
        c.__exit__(None, None, None)


# ---- held copies for the browser (personal_inbox.py) ------------------------------------------------------------------

from hive.tests.test_ask import ask, reply, world  # noqa: E402
from hive.tests.test_core_api import client  # noqa: E402,F401  (fixture)
from hive.core import personal_inbox as inboxmod  # noqa: E402


def _gateway_calls(client, monkeypatch):
    gw, calls = client.app.state.gateway, []
    for name in ("chat", "embeddings"):
        real = getattr(gw, name)

        async def counted(*a, _real=real, _name=name, **k):
            calls.append(_name)
            return await _real(*a, **k)
        monkeypatch.setattr(gw, name, counted)
    return calls


def _answered(client, w, op, text="what changed today?", answer="Here is the answer.", **extra):
    extra.setdefault("context", {"swarm_id": w["swarm"]["id"]})
    r = ask(client, w["ann"], op, text=text, **extra)
    assert r.status_code == 202, r.text
    reply(w["hive"], w["coord"], r.json()["turn_id"], answer)
    return r.json()["turn_id"]


def test_a_swarm_answer_is_held_only_for_its_person_and_nothing_wakes_or_calls(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    calls = _gateway_calls(client, monkeypatch)
    personal = hive.personal.ensure("user:u_ann")
    hive.personal.ensure("user:u_bob")
    hive.personal.ensure("user:u_jon")
    supervisor_before = list(client.supervisor.calls)
    usage_before = hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"]
    turn = _answered(client, w, "op-held-001", text="Ann's private words", answer="The coordinator's answer")
    # the asleep personal mind stays asleep: no start, no message, no trace, no usage, no gateway call
    assert hive.agent(personal["id"])["status"] == "asleep"
    assert [c for c in client.supervisor.calls if c not in supervisor_before and c[1] == personal["id"]] == []
    assert hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == usage_before == 0 and calls == []
    assert hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (personal["id"],)) == []
    assert hive.db.all("SELECT * FROM traces WHERE agent_id = ?", (personal["id"],)) == []
    assert hive.messages(personal["id"]) == []
    assert client.get(f"/api/agents/{personal['id']}/messages").json() == []          # an admin reads nothing either
    # its only seat is its own swarm's team room (team rooms r6: every swarm has one), and the copy wrote nothing there
    team = hive.rooms.team_room(personal["swarm_id"])
    assert [r["room_id"] for r in hive.db.all("SELECT room_id FROM room_members WHERE member = ?", (f"agent:{personal['id']}",))] \
        == ([team["id"]] if team else [])
    if team:
        assert hive.db.all("SELECT * FROM room_messages WHERE room_id = ?", (team["id"],)) == []
    # the copy is in Ann's inbox, and only there
    got = client.get("/api/me/mind/inbox", headers=w["ann"]).json()
    assert [(i["turn_id"], i["words"], i["answer"], i["truncated"]) for i in got["items"]] == \
        [(turn, "Ann's private words", "The coordinator's answer", False)]
    assert got["next"] is None and got["dropped"] == 0
    for other in (w["bob"], w["jon"]):   # another member, and an admin person: their own (empty) inbox only
        assert client.get("/api/me/mind/inbox", headers=other).json()["items"] == []
    assert client.get("/api/me/mind/inbox").status_code == 403                        # the operator: no admin read
    for other in (w["bob"], w["jon"]):   # someone else's ids are ignored
        assert client.post("/api/me/mind/inbox/ack", headers=other, json={"ids": [got["items"][0]["id"]]}).json() == {"deleted": 0}
    # one per turn: a late second reply to the closed turn, or a second hold, adds nothing
    reply(hive, w["coord"], turn, "a late word")
    assert hive.personal_inbox.hold(hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,)), "again") is None
    assert len(client.get("/api/me/mind/inbox", headers=w["ann"]).json()["items"]) == 1
    # ack deletes it, idempotently
    item = got["items"][0]["id"]
    assert client.post("/api/me/mind/inbox/ack", headers=w["ann"], json={"ids": [item, "pi_nope"]}).json() == {"deleted": 1}
    assert client.post("/api/me/mind/inbox/ack", headers=w["ann"], json={"ids": [item]}).json() == {"deleted": 0}
    assert hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == []
    assert client.post("/api/me/mind/inbox/ack", headers=w["ann"], json={"ids": "x"}).status_code == 400
    assert hive.agent(personal["id"])["status"] == "asleep" and calls == []


def test_private_apps_and_swarms_are_never_copied(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    hive.personal.ensure("user:u_ann")
    assert client.put("/api/me/ask", headers=w["ann"], json={"swarm_id": w["swarm"]["id"]}).status_code == 200
    _answered(client, w, "op-priv-0001", context={"private": True})                   # a private app's page
    client.post("/api/ask/op-priv-0001/stop", headers=w["ann"])
    _answered(client, w, "op-priv-0002", context={"swarm_id": w["swarm"]["id"], "route": "/programs/atlas/view"})
    client.patch(f"/api/swarms/{w['swarm']['id']}", json={"name": "Truth lab"})       # a private app's swarm, by name
    _answered(client, w, "op-priv-0003", context={"swarm_id": w["swarm"]["id"]})
    client.patch(f"/api/swarms/{w['swarm']['id']}", json={"name": "Home"})
    monkeypatch.setenv("HIVE_APP_HOMES", json.dumps({"atlas": [w["swarm"]["id"]]}))  # a private app's home swarm
    _answered(client, w, "op-priv-0004", context={"swarm_id": w["swarm"]["id"]})
    assert hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == []
    monkeypatch.setenv("HIVE_APP_HOMES", "{}")                                           # an ordinary swarm again: copied
    _answered(client, w, "op-priv-0005", context={"swarm_id": w["swarm"]["id"]})
    assert len(hive.personal_inbox.db.all("SELECT * FROM personal_inbox")) == 1


def test_no_copy_without_a_personal_mind_for_a_conductor_turn_or_for_the_persons_own_mind(client):
    w = world(client)
    hive = w["hive"]
    _answered(client, w, "op-none-0001")                      # Ann has no personal mind (made only at sign-in/backfill)
    assert hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == []
    own = hive.personal.ensure("user:u_ann")
    base = {"principal": "user:u_ann", "text": "hi", "context_resolved": "{}"}
    assert hive.personal_inbox.hold(dict(base, id="at_c1", swarm_id=w["swarm"]["id"], mind_id=w["coord"]["id"],
                                         conductor_model="m"), "a") is None
    assert hive.personal_inbox.hold(dict(base, id="at_c2", swarm_id=own["swarm_id"], mind_id=own["id"]), "a") is None
    assert hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == []


def _hold(hive, sw, n, text="w", answer="a", principal="user:u_ann"):
    mind = hive.personal.mind_row(principal)
    for i in range(n):
        hive.personal_inbox.hold({"id": f"at_{principal[-3:]}{i:05d}_{len(answer)}", "principal": principal, "swarm_id": sw,
                                  "mind_id": "a_coord", "text": text, "context_resolved": "{}"}, answer)
    return mind


def test_bounds_items_bytes_truncation_and_expiry(client):
    w = world(client)
    hive, sw = w["hive"], w["swarm"]["id"]
    hive.personal.ensure("user:u_ann")
    hive.personal.ensure("user:u_bob")
    # one item: at most 16 KB, cut and flagged
    _hold(hive, sw, 1, text="é" * 5000, answer="ü" * 20000)
    row = hive.personal_inbox.db.one("SELECT * FROM personal_inbox")
    assert row["bytes"] <= inboxmod.ITEM_BYTES and row["truncated"] == 1
    item = client.get("/api/me/mind/inbox", headers=w["ann"]).json()["items"][0]
    assert item["truncated"] is True and len(item["words"].encode()) <= inboxmod.WORDS_BYTES and item["answer"].startswith("ü")
    hive.personal_inbox.db.execute("DELETE FROM personal_inbox")
    # count: at most 200 per person, the oldest go first, counted; another person's are untouched
    _hold(hive, sw, 3, principal="user:u_bob")
    _hold(hive, sw, 205)
    rows = hive.personal_inbox.db.all("SELECT turn_id FROM personal_inbox WHERE principal = 'user:u_ann' ORDER BY seq")
    assert len(rows) == 200 and rows[0]["turn_id"].startswith("at_ann00005")
    assert len(hive.personal_inbox.db.all("SELECT * FROM personal_inbox WHERE principal = 'user:u_bob'")) == 3
    page = client.get("/api/me/mind/inbox?limit=500", headers=w["ann"]).json()
    assert len(page["items"]) == 50 and page["next"] == page["items"][-1]["id"] and page["dropped"] == 5
    second = client.get(f"/api/me/mind/inbox?after={page['next']}&limit=50", headers=w["ann"]).json()
    assert second["items"][0]["turn_id"] == rows[50]["turn_id"]
    hive.personal_inbox.db.execute("DELETE FROM personal_inbox WHERE principal = 'user:u_ann'")
    # bytes: at most 2 MB per person
    _hold(hive, sw, 140, answer="x" * 15000)
    total = hive.personal_inbox.db.one("SELECT COUNT(*) AS n, SUM(bytes) AS b FROM personal_inbox WHERE principal = 'user:u_ann'")
    assert total["b"] <= inboxmod.MAX_BYTES and total["n"] < 140
    # expiry: 7 days, swept on read (and by the reconcile loop's sweep)
    hive.personal_inbox.db.execute("UPDATE personal_inbox SET created_at = '2026-01-01T00:00:00.000Z' WHERE principal = 'user:u_ann'")
    got = client.get("/api/me/mind/inbox", headers=w["ann"]).json()
    assert got["items"] == [] and got["expired"] == total["n"]
    assert len(hive.personal_inbox.db.all("SELECT * FROM personal_inbox WHERE principal = 'user:u_bob'")) == 3
