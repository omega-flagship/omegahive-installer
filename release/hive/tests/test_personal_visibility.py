"""Other people's personal minds stay out of everyone's default lists and live events, admins included (Jon 2026-10-09:
"I should only see my own user unless others give me permission to see"). Admins keep audit through an explicit
?include=personal on GET /api/swarms and GET /api/agents, and by id."""

import json

import pytest

from hive.core.visibility import Viewer
from hive.tests.test_personal_mind import _client, _env, _person


def _signed_in(c, admin, google, email, name, role):
    if role == "admin":
        # _person invites as member; promote through the store before signing in, as an admin invite would
        headers, pid = _person(c, admin, google, email, name)
        c.app.state.hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", (pid,))
        return headers, pid
    return _person(c, admin, google, email, name)


def _ids(rows):
    return {r["id"] for r in rows}


def test_others_personal_swarms_and_minds_hidden_by_default(monkeypatch):
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _signed_in(c, op, google, "ana@example.com", "Ana", "admin")
        bo, bo_id = _signed_in(c, op, google, "bo@example.com", "Bo", "admin")
        cy, cy_id = _signed_in(c, op, google, "cy@example.com", "Cy", "member")
        mine = {p: hive.personal.mind_row(f"user:{p}") for p in (ana_id, bo_id, cy_id)}
        swarm_of = {p: m["swarm_id"] for p, m in mine.items()}
        assert all(mine.values())
        team = c.post("/api/swarms", json={"name": "Team", "visibility": "shared", "shared_with": [f"user:{cy_id}"]},
                      headers=op).json()
        assert hive.db.one("SELECT visibility FROM swarms WHERE id = ?", (team["id"],))["visibility"] == "shared"

        # admin Ana: her own personal swarm and mind, not Bo's or Cy's
        swarms = _ids(c.get("/api/swarms", headers=ana).json())
        assert swarm_of[ana_id] in swarms and team["id"] in swarms
        assert swarm_of[bo_id] not in swarms and swarm_of[cy_id] not in swarms
        agents = _ids(c.get("/api/agents", headers=ana).json())
        assert mine[ana_id]["id"] in agents
        assert mine[bo_id]["id"] not in agents and mine[cy_id]["id"] not in agents

        # audit opt-in: an admin sees all; a member is refused
        swarms = _ids(c.get("/api/swarms?include=personal", headers=ana).json())
        assert set(swarm_of.values()) <= swarms
        agents = _ids(c.get("/api/agents?include=personal", headers=ana).json())
        assert {m["id"] for m in mine.values()} <= agents
        assert c.get("/api/swarms?include=personal", headers=cy).status_code == 403
        assert c.get("/api/agents?include=personal", headers=cy).status_code == 403

        # direct access by id stays open to admins (audit)
        assert c.get(f"/api/swarms/{swarm_of[bo_id]}", headers=ana).status_code == 200
        assert c.get(f"/api/agents/{mine[bo_id]['id']}", headers=ana).status_code == 200

        # member Cy: unchanged; own personal swarm and the team swarm shared with her, nobody else's
        swarms = _ids(c.get("/api/swarms", headers=cy).json())
        assert swarm_of[cy_id] in swarms and team["id"] in swarms
        assert swarm_of[ana_id] not in swarms and swarm_of[bo_id] not in swarms
        agents = _ids(c.get("/api/agents", headers=cy).json())
        assert mine[cy_id]["id"] in agents and mine[ana_id]["id"] not in agents
        assert c.get(f"/api/swarms/{swarm_of[bo_id]}", headers=cy).status_code == 404

        # Bo shares his personal swarm and mind with Ana: now she sees them by default
        hive.db.execute("UPDATE swarms SET visibility = 'shared', shared_with = ? WHERE id = ?",
                        (json.dumps([f"user:{ana_id}"]), swarm_of[bo_id]))
        hive.db.execute("UPDATE agents SET visibility = 'shared', shared_with = ? WHERE id = ?",
                        (json.dumps([f"user:{ana_id}"]), mine[bo_id]["id"]))
        assert swarm_of[bo_id] in _ids(c.get("/api/swarms", headers=ana).json())
        assert mine[bo_id]["id"] in _ids(c.get("/api/agents", headers=ana).json())
    finally:
        c.__exit__(None, None, None)


def test_admin_live_events_leave_out_others_personal(monkeypatch):
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        _ana, ana_id = _signed_in(c, op, google, "ana@example.com", "Ana", "admin")
        _bo, bo_id = _signed_in(c, op, google, "bo@example.com", "Bo", "admin")
        ana_mind, bo_mind = hive.personal.mind_row(f"user:{ana_id}"), hive.personal.mind_row(f"user:{bo_id}")
        team = c.post("/api/swarms", json={"name": "Team"}, headers=op).json()
        ana = Viewer(f"user:{ana_id}", True)
        ev = lambda obj: hive.visibility.event_visible(ana, json.dumps(obj))
        assert not ev({"type": "agent.updated", "agent": {"id": bo_mind["id"], "swarm_id": bo_mind["swarm_id"]}})
        assert not ev({"type": "swarm.updated", "swarm": {"id": bo_mind["swarm_id"]}})
        assert ev({"type": "agent.updated", "agent": {"id": ana_mind["id"], "swarm_id": ana_mind["swarm_id"]}})
        assert ev({"type": "swarm.updated", "swarm": {"id": team["id"]}})
        assert ev({"type": "policy.updated"})                      # admin business still reaches admins
    finally:
        c.__exit__(None, None, None)


def test_admin_health_and_rooms_leave_out_others_personal(monkeypatch):
    """Stand-in r1 P1: /api/health and /api/rooms carried other people's personal mind and team-room names to admins."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _signed_in(c, op, google, "ana@example.com", "Ana", "admin")
        _bo, bo_id = _signed_in(c, op, google, "bo@example.com", "Bo", "admin")
        cy, _cy_id = _signed_in(c, op, google, "cy@example.com", "Cy", "member")
        ana_mind, bo_mind = hive.personal.mind_row(f"user:{ana_id}"), hive.personal.mind_row(f"user:{bo_id}")
        # each personal swarm's team room (the room the UI shows for the swarm)
        for m, who in ((ana_mind, ana), (bo_mind, op)):
            assert c.post(f"/api/swarms/{m['swarm_id']}/room", headers=who).status_code == 200
        room_of = {m["swarm_id"]: hive.db.one("SELECT id FROM rooms WHERE swarm_id = ?", (m["swarm_id"],))["id"]
                   for m in (ana_mind, bo_mind)}

        minds = _ids(c.get("/api/health", headers=ana).json()["minds"])
        assert ana_mind["id"] in minds and bo_mind["id"] not in minds
        rooms = _ids(c.get("/api/rooms", headers=ana).json())
        assert room_of[ana_mind["swarm_id"]] in rooms and room_of[bo_mind["swarm_id"]] not in rooms

        # audit opt-in, admin only; and the room by id stays open to admins
        assert bo_mind["id"] in _ids(c.get("/api/health?include=personal", headers=ana).json()["minds"])
        assert room_of[bo_mind["swarm_id"]] in _ids(c.get("/api/rooms?include=personal", headers=ana).json())
        assert c.get("/api/health?include=personal", headers=cy).status_code == 403
        assert c.get("/api/rooms?include=personal", headers=cy).status_code == 403
        assert c.get(f"/api/rooms/{room_of[bo_mind['swarm_id']]}", headers=ana).status_code == 200
        # a member still sees neither
        assert bo_mind["id"] not in _ids(c.get("/api/health", headers=cy).json()["minds"])
        assert room_of[bo_mind["swarm_id"]] not in _ids(c.get("/api/rooms", headers=cy).json())
    finally:
        c.__exit__(None, None, None)


# ---- r3 sweep (stand-in r2: budgets and shares still leaked): every default list an admin reads, one parametrised test.
# Each route is read as admin Ana with one row naming Bo's personal mind (or swarm) seeded. By default the response must
# not contain Bo's ids; with ?include=personal (audit) it must, which proves the seed reached the route; Ana's own
# personal ids, wherever the audit response has them, must also be in the default one.

NOW = "2026-10-09T00:00:00.000Z"


def _seed(hive, op_client, op, mind, swarm, room_hdr):
    db = hive.db
    db.insert("usage", {"agent_id": mind, "model": "mock/m", "prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.0,
                        "created_at": NOW})
    db.insert("approvals", {"id": "ap_" + mind, "agent_id": mind, "skill": "s", "command": "c", "reason": "r", "risk": "low",
                            "status": "pending", "created_at": NOW})
    db.insert("budgets", {"id": "b_" + mind, "scope": f"agent:{mind}", "period": "month", "limit_usd": 1.0, "created_at": NOW})
    db.insert("shares", {"id": "sh_" + mind, "kind": "space", "swarm_id": swarm, "owner_id": mind, "grantee_id": mind,
                         "minutes": 5, "status": "requested", "initiated_by": "x", "created_at": NOW})
    room = op_client.post(f"/api/swarms/{swarm}/room", headers=room_hdr).json()["id"]
    db.insert("work_sessions", {"id": "ws_" + mind, "room_id": room, "agent_id": mind, "owner": "user:operator", "title": "t",
                                "budget_usd": 1.0, "spent_at_start": 0.0, "created_at": NOW})
    db.insert("person_requests", {"id": "pr_" + mind, "kind": "k", "requested_by": "user:operator",
                                  "payload": json.dumps({"swarm_id": swarm}), "created_at": NOW})
    db.insert("goals", {"id": "g_" + mind, "swarm_id": swarm, "title": "t", "priority": 1.0, "status": "open",
                        "created_by": "user:operator", "created_at": NOW, "updated_at": NOW})
    db.insert("motivations", {"id": "m_" + mind, "title": "t", "owner": f"swarm:{swarm}", "swarm_id": swarm,
                              "visibility": "public", "created_by": "user:operator", "created_at": NOW, "updated_at": NOW})
    db.insert("delegations", {"coordinator_id": mind, "specialist_id": mind, "created_by": "x", "created_at": NOW})
    hive.assets.put(f"asset of {mind}".encode(), "text/plain", f"agent:{mind}", owner_swarm=swarm, name="n.txt")


ROUTES = [
    ("GET", "/api/swarms"), ("GET", "/api/agents"), ("GET", "/api/health"), ("GET", "/api/rooms"),
    ("GET", "/api/usage"), ("GET", "/api/approvals"), ("GET", "/api/budgets"), ("GET", "/api/budgets/limits"),
    ("GET", "/api/shares"), ("GET", "/api/sessions"), ("GET", "/api/asks"), ("GET", "/api/motivations"),
    ("GET", "/api/tasks"), ("GET", "/api/lifecycle/delegations"), ("POST", "/api/explore"), ("GET", "/api/assets"),
]


@pytest.fixture(scope="module")
def world():
    mp = pytest.MonkeyPatch()
    app, google, _sup, _ = _env(mp)
    c, op = _client(app)
    hive = app.state.hive
    ana, ana_id = _signed_in(c, op, google, "ana@example.com", "Ana", "admin")
    _bo, bo_id = _signed_in(c, op, google, "bo@example.com", "Bo", "admin")
    a, b = hive.personal.mind_row(f"user:{ana_id}"), hive.personal.mind_row(f"user:{bo_id}")
    _seed(hive, c, op, b["id"], b["swarm_id"], op)
    _seed(hive, c, op, a["id"], a["swarm_id"], ana)
    yield c, ana, a, b
    c.__exit__(None, None, None)
    mp.undo()


@pytest.mark.parametrize("method,route", ROUTES, ids=[r for _, r in ROUTES])
def test_every_admin_default_list_hides_others_personal(world, method, route):
    c, ana, a, b = world
    call = (lambda url: c.post(url, json={}, headers=ana)) if method == "POST" else (lambda url: c.get(url, headers=ana))
    default, audit = call(route), call(route + "?include=personal")
    assert default.status_code == 200 and audit.status_code == 200, (default.text[:200], audit.text[:200])
    assert b["id"] in audit.text or b["swarm_id"] in audit.text, "seed did not reach this route"
    assert b["id"] not in default.text and b["swarm_id"] not in default.text
    for own in (a["id"], a["swarm_id"]):
        if own in audit.text:
            assert own in default.text


def test_mixed_owner_asset_redacts_hidden_personal_owner(monkeypatch):
    """Stand-in r3 P1: the same bytes put by Bo's personal mind and into a team swarm. The team swarm still lists the
    asset (access unchanged), but Bo's personal swarm, his mind as creator and their history entries are redacted, for
    admin Ana by default and for a member of the team; ?include=personal shows them to the admin."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, _ana_id = _signed_in(c, op, google, "ana@example.com", "Ana", "admin")
        _bo, bo_id = _signed_in(c, op, google, "bo@example.com", "Bo", "admin")
        cy, cy_id = _signed_in(c, op, google, "cy@example.com", "Cy", "member")
        bo = hive.personal.mind_row(f"user:{bo_id}")
        team = c.post("/api/swarms", json={"name": "Team", "visibility": "shared", "shared_with": [f"user:{cy_id}"]},
                      headers=op).json()
        data = b"the same bytes"
        hive.assets.put(data, "text/plain", f"agent:{bo['id']}", owner_swarm=bo["swarm_id"], name="bo.txt")
        hive.assets.put(data, "text/plain", "user:operator", owner_swarm=team["id"], name="bo.txt")

        for who in (ana, cy):
            r = c.get("/api/assets", headers=who)
            assert r.status_code == 200
            [asset] = [a for a in r.json() if team["id"] in a["owners"]]
            assert asset["owners"] == [team["id"]] and asset["owner_swarm"] == team["id"]
            assert asset["created_by"] == "user:operator"
            assert bo["swarm_id"] not in r.text and bo["id"] not in r.text
        audit = c.get("/api/assets?include=personal", headers=ana)
        assert bo["swarm_id"] in audit.text and bo["id"] in audit.text
        assert c.get("/api/assets?include=personal", headers=cy).status_code == 403
    finally:
        c.__exit__(None, None, None)


def test_mixed_owner_asset_never_shows_the_hidden_owners_filename(monkeypatch):
    """Stand-in r4 P1: each owner keeps the filename it put the file under. Bo's personal mind puts a file under a private
    name; the team puts the same bytes under its own name (through the upload route) and, a second file, under no name.
    Default admin and team views show only the team's name, or a neutral 'file' + extension; never Bo's."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, _ana_id = _signed_in(c, op, google, "ana@example.com", "Ana", "admin")
        _bo, bo_id = _signed_in(c, op, google, "bo@example.com", "Bo", "admin")
        cy, cy_id = _signed_in(c, op, google, "cy@example.com", "Cy", "member")
        bo = hive.personal.mind_row(f"user:{bo_id}")
        team = c.post("/api/swarms", json={"name": "Team", "visibility": "shared", "shared_with": [f"user:{cy_id}"]},
                      headers=op).json()
        private = "Bo-confidential-diagnosis.pdf"
        hive.assets.put(b"report bytes", "application/pdf", f"agent:{bo['id']}", owner_swarm=bo["swarm_id"], name=private)
        hive.assets.put(b"scan bytes", "application/pdf", f"agent:{bo['id']}", owner_swarm=bo["swarm_id"], name="Bo-scan.pdf")
        up = c.post(f"/api/assets?swarm_id={team['id']}&name=team-notes.pdf", content=b"report bytes",
                    headers={**op, "content-type": "application/pdf"})
        assert up.status_code == 200 and up.json()["name"] == "team-notes.pdf" and "Bo-" not in up.text
        hive.assets.put(b"scan bytes", "application/pdf", "user:operator", owner_swarm=team["id"], name="")

        for who in (ana, cy):
            r = c.get("/api/assets", headers=who)
            names = sorted(a["name"] for a in r.json() if team["id"] in a["owners"])
            assert names == ["file.pdf", "team-notes.pdf"]
            assert "Bo-" not in r.text and "confidential" not in r.text
        audit = c.get("/api/assets?include=personal", headers=ana)
        assert private in audit.text

        # r3 (stand-in + Kimi P1): the download header follows the same rule as the list, for the named and the
        # unnamed team upload; only an admin's explicit audit names Bo's file
        import hashlib
        report, scan = hashlib.sha256(b"report bytes").hexdigest(), hashlib.sha256(b"scan bytes").hexdigest()
        for who in (ana, cy):
            for sha, expected in ((report, "team-notes.pdf"), (scan, "file.pdf")):
                d = c.get(f"/api/assets/{sha}", headers=who)
                assert d.status_code == 200
                disposition = d.headers["content-disposition"]
                assert f'filename="{expected}"' in disposition and "Bo-" not in disposition
        d = c.get(f"/api/assets/{report}?include=personal", headers=ana)
        assert f'filename="{private}"' in d.headers["content-disposition"]
    finally:
        c.__exit__(None, None, None)
