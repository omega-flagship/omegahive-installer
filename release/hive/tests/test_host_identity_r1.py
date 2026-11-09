"""host-identity r1 (PLATFORM_HOST_IDENTITY_AUDIT_20261017 findings 2, 3 and 5): who may answer an approval, what a
sign-out or revoked access ends, and the chat route's payer re-check at reservation."""
from hive.tests.test_ask import ask, world
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_phase2_api import authorize
from hive.tests.test_visibility import person

WRITE = '(write-file "x.txt" "y")'


def decide(client, approval_id, decision, headers=None, minutes=None):
    return client.post(f"/api/approvals/{approval_id}/decide", headers=headers or {},
                       json={"decision": decision, "minutes": minutes})


def status_of(hive, approval_id):
    return hive.db.one("SELECT status FROM approvals WHERE id = ?", (approval_id,))["status"]


# ---- finding 3: approvals ---------------------------------------------------------------------------------------------

def test_a_person_who_cannot_see_the_mind_cannot_answer_its_approval(client):
    hive = client.app.state.hive
    bob = person(client, "u_bob")
    _, (a, _) = make_swarm_and_agents(client)                       # the operator's own swarm: Bob does not see it
    p = authorize(client, a, WRITE)["approval_id"]
    assert decide(client, p, "once", bob).status_code == 404
    assert decide(client, p, "always", bob).status_code == 404
    assert client.post(f"/api/approvals/{p}/approve", headers=bob, json={}).status_code == 404
    assert client.post(f"/api/approvals/{p}/deny", headers=bob).status_code == 404
    assert status_of(hive, p) == "pending"
    assert hive.db.all("SELECT * FROM policy_rules WHERE origin = 'answer'") == []


def test_a_viewer_who_is_not_the_owner_answers_once_but_never_durably(client):
    w = world(client)                                               # the coordinator is shared with Ann, owned by the operator
    hive, ann = w["hive"], w["ann"]
    p = authorize(client, w["coord"], WRITE)["approval_id"]
    for durable in ("always", "for", "never"):
        r = decide(client, p, durable, ann, minutes=10)
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
    assert client.post(f"/api/approvals/{p}/approve", headers=ann, json={"remember": True}).status_code == 403
    assert status_of(hive, p) == "pending" and hive.db.all("SELECT * FROM policy_rules WHERE origin = 'answer'") == []
    assert decide(client, p, "once", ann).json()["status"] == "approved"          # the legitimate one-request path stays
    q = authorize(client, w["coord"], '(write-file "q.txt" "y")')["approval_id"]
    assert client.post(f"/api/approvals/{q}/deny", headers=ann).json()["status"] == "denied"
    r = authorize(client, w["coord"], '(write-file "r.txt" "y")')["approval_id"]
    assert client.post(f"/api/approvals/{r}/approve", headers=ann, json={}).json()["status"] == "approved"


def test_the_minds_owner_and_an_admin_answer_durably_and_the_grantor_is_recorded(client):
    hive = client.app.state.hive
    ann = person(client, "u_ann")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    mine = client.post("/api/agents", headers=ann, json={"name": "Ada", "swarm_id": sw["id"]}).json()
    p = authorize(client, mine, WRITE)["approval_id"]
    assert decide(client, p, "always", ann).json()["status"] == "approved"
    rule = hive.db.one("SELECT * FROM policy_rules WHERE scope = ? AND origin = 'answer'", (f"agent:{mine['id']}",))
    assert rule["mode"] == "allow" and rule["granted_by"] == "user:u_ann"
    _, (a, _) = make_swarm_and_agents(client)
    q = authorize(client, a, WRITE)["approval_id"]
    assert decide(client, q, "for", minutes=5).json()["status"] == "approved"   # the hive admin (local operator)
    rule = hive.db.one("SELECT * FROM policy_rules WHERE scope = ? AND origin = 'answer'", (f"agent:{a['id']}",))
    assert rule["granted_by"] == "user:operator"
    hive.db.execute("DELETE FROM policy_rules")                     # so the next request asks again
    r = authorize(client, a, '(write-file "n.txt" "y")')["approval_id"]
    assert decide(client, r, "never").json()["status"] == "denied"
    assert hive.db.one("SELECT granted_by FROM policy_rules WHERE mode = 'deny'")["granted_by"] == "user:operator"
    assert all(row["granted_by"] is None for row in hive.db.all("SELECT granted_by FROM policy_rules WHERE origin != 'answer'"))


def test_policy_rule_writes_follow_current_member_and_admin_authority(client):
    import time
    from hive.core.hive import token_hash
    from hive.core.policy import ORIGIN_MEMBER
    from hive.tests.test_member_rules_p3c import person as current_person

    hive = client.app.state.hive
    ann_id, jon_id = "u_0a0a0a0a", "u_0c0c0c0c"
    ann = current_person(client, ann_id)  # positive SSO fixture, including a future expiry
    ann_principal = "user:" + ann_id
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    mine = client.post("/api/agents", headers=ann, json={"name": "Ada", "swarm_id": sw["id"]}).json()
    for scope in ("hive", f"agent:{mine['id']}"):
        r = client.post("/api/policy", headers=ann, json={"scope": scope, "skill": "*", "mode": "allow"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    assert hive.db.all("SELECT * FROM policy_rules WHERE skill = '*'") == []
    # P3c members may add and remove only their own mind's ask/deny restrictions.
    for mode in ("ask", "deny"):
        r = client.post("/api/policy", headers=ann,
                        json={"scope": f"agent:{mine['id']}", "skill": "write-file", "mode": mode})
        assert r.status_code == 200, r.text
        member_rule = hive.db.one("SELECT * FROM policy_rules WHERE id = ?", (r.json()["id"],))
        assert (member_rule["origin"], member_rule["granted_by"], member_rule["mode"]) == (ORIGIN_MEMBER, ann_principal, mode)
        assert client.delete(f"/api/policy/{member_rule['id']}", headers=ann).status_code == 200
        assert hive.db.one("SELECT id FROM policy_rules WHERE id = ?", (member_rule["id"],)) is None
    rule = client.post("/api/policy", json={"scope": "hive", "skill": "shell*", "mode": "deny"}).json()
    assert hive.db.one("SELECT granted_by FROM policy_rules WHERE id = ?", (rule["id"],))["granted_by"] == "user:operator"
    assert client.delete(f"/api/policy/{rule['id']}", headers=ann).status_code == 403
    assert hive.db.one("SELECT id FROM policy_rules WHERE id = ?", (rule["id"],)) is not None
    # A current named admin and the stored hive owner, while still an enabled admin, can write hive-wide rules.
    jon = current_person(client, jon_id, role="admin")
    r = client.post("/api/policy", headers=jon, json={"scope": "hive", "skill": "net*", "mode": "ask"})
    assert r.status_code == 200 and r.json()["granted_by"] == "user:" + jon_id
    hive.ownhive.ensure_owner()
    hive.db.execute("UPDATE hive_owner SET owner = ? WHERE id = 1", (ann_principal,))
    # money port r1.1 (Dot): a recorded owner who is not an admin (demoted) has no owner powers
    assert client.delete(f"/api/policy/{rule['id']}", headers=ann).status_code == 403
    hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", (ann_id,))
    assert client.delete(f"/api/policy/{rule['id']}", headers=ann).status_code == 200
    r = client.post("/api/policy", headers=ann, json={"scope": "hive", "skill": "x*", "mode": "deny"})
    assert r.status_code == 200 and r.json()["granted_by"] == ann_principal
    # Stored ownership does not bypass the current signed-in-person expiry check.
    before = hive.policy.rules()
    key = token_hash(ann["Authorization"].removeprefix("Bearer "))
    hive.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (time.time() - 1, key))
    r = client.post("/api/policy", headers=ann, json={"scope": "hive", "skill": "expired*", "mode": "allow"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized", r.text
    assert hive.policy.rules() == before


def test_track_record_needs_sight_of_the_mind(client):
    bob = person(client, "u_bob")
    _, (a, _) = make_swarm_and_agents(client)
    p = authorize(client, a, WRITE)["approval_id"]
    assert client.get(f"/api/approvals/{p}/track-record", headers=bob).status_code == 404
    assert client.get(f"/api/approvals/{p}/track-record").status_code == 200   # the admin still reads it


# ---- finding 2: sign-out and revoked access ---------------------------------------------------------------------------

def _anns_work(client, w):
    """Ann: an open Ask turn on the coordinator (its thread is her work session) and an ordinary session on a third
    mind. Jon: an ordinary session on the worker, which must outlive Ann leaving."""
    third = client.post("/api/agents", json={"name": "Third", "swarm_id": w["swarm"]["id"]}).json()
    client.put(f"/api/agents/{third['id']}/visibility", json={"visibility": "shared", "shared_with": ["user:u_ann"]})
    turn = ask(client, w["ann"], "op-leave-01", context={"swarm_id": w["swarm"]["id"]})
    assert turn.status_code == 202, turn.text
    s = client.post("/api/sessions", headers=w["ann"], json={"mind": third["id"], "title": "Ann's", "budget_usd": 1})
    assert s.status_code == 200, s.text
    j = client.post("/api/sessions", headers=w["jon"], json={"mind": w["worker"]["id"], "title": "Jon's", "budget_usd": 1})
    assert j.status_code == 200, j.text
    hive = w["hive"]
    assert hive.payer_for(hive.agent(w["coord"]["id"]))[0] == "user:u_ann"
    assert hive.payer_for(hive.agent(third["id"]))[0] == "user:u_ann"
    return third, turn.json()


def _assert_ann_gone(w, third, turn):
    hive = w["hive"]
    assert hive.db.one("SELECT state FROM ask_turns WHERE id = ?", (turn["turn_id"],))["state"] == "refused"
    assert hive.db.all("SELECT id FROM work_sessions WHERE owner = 'user:u_ann' AND status = 'active'") == []
    assert hive.payer_for(hive.agent(w["coord"]["id"]))[0] != "user:u_ann"
    assert hive.payer_for(hive.agent(third["id"]))[0] != "user:u_ann"
    # Jon's work and the minds themselves are untouched
    assert len(hive.db.all("SELECT id FROM work_sessions WHERE owner = 'user:u_jon' AND status = 'active'")) == 1
    assert hive.agent(w["coord"]["id"])["status"] == "awake"


def test_sign_out_ends_the_persons_sessions_and_open_ask_turns(client):
    w = world(client)
    third, turn = _anns_work(client, w)
    assert client.post("/api/auth/logout", headers=w["ann"]).status_code == 200
    _assert_ann_gone(w, third, turn)


def test_disabling_a_person_ends_their_sessions_and_open_ask_turns(client):
    w = world(client)
    third, turn = _anns_work(client, w)
    assert client.patch("/api/people/u_ann", json={"disabled": True}).status_code == 200
    _assert_ann_gone(w, third, turn)


# ---- finding 5: the chat route re-checks the payer at reservation -----------------------------------------------------

def test_chat_route_refuses_when_the_payer_changes_before_reservation(client, monkeypatch):
    from hive.tests.test_cost_reservations import MODEL, _fake_chat, _gateway
    hive = client.app.state.hive
    person(client, "u_ann"), person(client, "u_bob")
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=5)
    hive.db.execute("UPDATE agents SET owner = 'user:u_ann' WHERE id = ?", (a["id"],))
    _fake_chat(_gateway(client))
    real = hive.check_budget

    def admitted_then_payer_moves(*args, **kwargs):
        out = real(*args, **kwargs)
        hive.db.execute("UPDATE agents SET owner = 'user:u_bob' WHERE id = ?", (a["id"],))   # lands between admission and reserve
        return out
    monkeypatch.setattr(hive, "check_budget", admitted_then_payer_moves)
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(a),
                    json={"messages": [{"role": "user", "content": "x"}], "max_tokens": 100})
    assert r.status_code == 409 and r.json()["error"]["code"] == "payer_changed", r.text
    assert hive.db.all("SELECT * FROM cost_reservations") == []
    assert hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (a["id"],)) == []
    monkeypatch.setattr(hive, "check_budget", real)                  # an unchanged payer still goes through
    r = client.post("/llm/v1/chat/completions", headers=agent_headers(a),
                    json={"messages": [{"role": "user", "content": "x"}], "max_tokens": 100})
    assert r.status_code == 200, r.text
    assert [u["payer"] for u in hive.db.all("SELECT payer FROM usage WHERE agent_id = ?", (a["id"],))] == ["user:u_bob"]


# ---- r1.1: the role side door (Kimi/stand-in P1) ----------------------------------------------------------------------

def _roles(client):
    loose = client.post("/api/roles", json={"name": "Loose", "prompt": "You are {name}.",
                                            "rules": [{"skill": "write-file", "mode": "allow"}]}).json()
    strict = client.post("/api/roles", json={"name": "Strict", "prompt": "You are {name}.",
                                             "rules": [{"skill": "write-file", "mode": "deny"}]}).json()
    plain = next(r for r in client.get("/api/roles").json() if r.get("builtin") and r.get("rules") == [])
    return loose, strict, plain


def _role_rules(hive, agent_id):
    return hive.db.all("SELECT skill, mode, note, granted_by FROM policy_rules WHERE scope = ? AND note LIKE 'role:%'",
                       (f"agent:{agent_id}",))


def test_a_member_cannot_change_a_role_that_carries_rules(client):
    w = world(client)
    hive, ann = w["hive"], w["ann"]
    loose, strict, plain = _roles(client)
    assert client.patch(f"/api/agents/{w['coord']['id']}", json={"role_id": strict["id"]}).status_code == 200   # the admin
    before = _role_rules(hive, w["coord"]["id"])
    assert [r["mode"] for r in before] == ["deny"]
    assert hive.agent(w["coord"]["id"])["role_id"] == strict["id"]                    # persisted, never stripped
    # removing a role's deny, or swapping it, is a policy write: refused before anything changes
    for role_id in (None, plain["id"], loose["id"]):
        r = client.patch(f"/api/agents/{w['coord']['id']}", headers=ann, json={"role_id": role_id, "name": "Renamed"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    assert _role_rules(hive, w["coord"]["id"]) == before
    assert hive.agent(w["coord"]["id"])["role_id"] == strict["id"] and hive.agent(w["coord"]["id"])["name"] == "Orchestra"
    # giving a rule-free mind a permissive role is refused too
    r = client.patch(f"/api/agents/{w['worker']['id']}", headers=ann, json={"role_id": loose["id"]})
    assert r.status_code == 403 and _role_rules(hive, w["worker"]["id"]) == [] and hive.agent(w["worker"]["id"])["role_id"] is None
    # a prompt-only role (every built-in) is no policy change: still the member's to pick, and it persists
    r = client.patch(f"/api/agents/{w['worker']['id']}", headers=ann, json={"role_id": plain["id"]})
    assert r.status_code == 200 and hive.agent(w["worker"]["id"])["role_id"] == plain["id"]
    assert client.patch(f"/api/agents/{w['worker']['id']}", headers=ann, json={"role_id": None}).status_code == 200
    assert [r["granted_by"] for r in before] == ["user:operator"]                     # the admin's assignment, recorded
    # the hive's owner may while still an enabled admin (money port r1.1, Dot: a demoted owner may not), and is
    # recorded as the grantor
    hive.ownhive.ensure_owner()
    hive.db.execute("UPDATE hive_owner SET owner = 'user:u_ann' WHERE id = 1")
    r = client.patch(f"/api/agents/{w['worker']['id']}", headers=ann, json={"role_id": loose["id"]})
    assert r.status_code == 403 and _role_rules(hive, w["worker"]["id"]) == []
    hive.db.execute("UPDATE people SET role = 'admin' WHERE id = 'u_ann'")
    assert client.patch(f"/api/agents/{w['worker']['id']}", headers=ann, json={"role_id": loose["id"]}).status_code == 200
    assert [(r["mode"], r["granted_by"]) for r in _role_rules(hive, w["worker"]["id"])] == [("allow", "user:u_ann")]


def test_a_member_creates_minds_only_with_a_prompt_only_role(client):
    hive = client.app.state.hive
    loose, strict, plain = _roles(client)
    ann = person(client, "u_ann")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    count = hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    for role in (loose, strict):
        r = client.post("/api/agents", headers=ann, json={"name": "Ada", "swarm_id": sw["id"], "role_id": role["id"]})
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    assert hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"] == count             # nothing was created
    ok = client.post("/api/agents", headers=ann, json={"name": "Ada", "swarm_id": sw["id"], "role_id": plain["id"]})
    assert ok.status_code == 200 and ok.json()["role_id"] == plain["id"]
    assert client.post("/api/agents", headers=ann, json={"name": "Bea", "swarm_id": sw["id"]}).status_code == 200
    # an admin's new mind gets the role's rules, recorded with the admin as grantor; a role edit records its editor
    _, (a,) = make_swarm_and_agents(client, n=1, role_id=loose["id"])
    assert [(r["mode"], r["granted_by"]) for r in _role_rules(hive, a["id"])] == [("allow", "user:operator")]
    jon = person(client, "u_jon", role="admin")
    assert client.patch(f"/api/roles/{loose['id']}", headers=jon, json={"rules": [{"skill": "write-file", "mode": "ask"}]}).status_code == 200
    assert [(r["mode"], r["granted_by"]) for r in _role_rules(hive, a["id"])] == [("ask", "user:u_jon")]


def test_app_attachment_rules_record_who_attached(client, monkeypatch):
    import asyncio
    import json as _json
    import types
    hive = client.app.state.hive
    _, (a,) = make_swarm_and_agents(client, n=1)
    att = hive.app_attachments
    hive.db.execute("INSERT INTO app_activations VALUES ('studio', ?, 1, 'user:u_adm')", (a["swarm_id"],))
    hive.db.insert("app_attachments", {"id": "at_t1", "program": "studio", "swarm": a["swarm_id"], "mind": a["id"], "actor": None,
                                       "scope": _json.dumps({}), "policy": _json.dumps({"save": "allow"}), "expires": None,
                                       "status": "binding", "by_person": "user:u_adm", "revoked_by": None})
    module = types.SimpleNamespace(bind=lambda *args: None)
    monkeypatch.setattr(att, "context", lambda row, principal: ({"module": module}, object()))

    async def call(entry, fn, *args):
        return {"actor": "studio:x"}
    monkeypatch.setattr(hive.programs, "_call", call)
    asyncio.run(att.finish_bind({"id": "at_t1"}))
    rule = hive.db.one("SELECT granted_by FROM policy_rules WHERE note = 'attachment:at_t1'")
    assert rule is not None and rule["granted_by"] == "user:u_adm"


# ---- r1.1: sessions that refuse to end are surfaced (P2) --------------------------------------------------------------

def test_a_session_that_refuses_to_end_is_counted_and_sent_to_admins(client, monkeypatch):
    from hive.core.hive import HiveError
    from hive.core.visibility import event_rule
    w = world(client)
    hive = w["hive"]
    third, _ = _anns_work(client, w)
    stuck = hive.db.one("SELECT id FROM work_sessions WHERE owner = 'user:u_ann' AND agent_id = ?", (third["id"],))["id"]
    real_end, published = hive.sessions.end, []

    def end(viewer, session_id):
        if session_id == stuck:
            raise HiveError(409, "liabilities_open", "unsettled")
        return real_end(viewer, session_id)
    monkeypatch.setattr(hive.sessions, "end", end)
    real_publish = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **f: (published.append((kind, f)), real_publish(kind, **f))[1])
    r = client.post("/api/auth/logout", headers=w["ann"])
    assert r.status_code == 200 and r.json()["sessions_kept"] == 1
    kept = [f for k, f in published if k == "sessions.kept"]
    assert kept == [{"principal": "user:u_ann", "sessions": [{"session": stuck, "code": "liabilities_open"}]}]
    assert event_rule("sessions.kept") == "admin"
    assert hive.db.one("SELECT status FROM work_sessions WHERE id = ?", (stuck,))["status"] == "active"
    # revoking access reports the same count
    r = client.patch("/api/people/u_ann", json={"disabled": True})
    assert r.status_code == 200 and r.json()["sessions_kept"] == 1


# ---- r1.2: the binding check runs inside the role change (stand-in P1, atomicity) ------------------------------------

def test_a_role_assigned_between_the_route_check_and_the_change_is_still_refused(client, monkeypatch):
    w = world(client)
    hive, ann = w["hive"], w["ann"]
    _, strict, _ = _roles(client)
    worker = w["worker"]["id"]
    real = hive.update_agent

    def admin_lands_first(*args, **kwargs):   # after the route's fast check passed (no role:... rules then), before the worker
        hive.roles.assign(worker, strict["id"], by="user:operator")
        return real(*args, **kwargs)
    monkeypatch.setattr(hive, "update_agent", admin_lands_first)
    r = client.patch(f"/api/agents/{worker}", headers=ann, json={"role_id": None, "name": "Renamed"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    assert hive.agent(worker)["role_id"] == strict["id"] and hive.agent(worker)["name"] == "Worker"   # nothing changed
    assert [r["mode"] for r in _role_rules(hive, worker)] == ["deny"]


def test_a_role_that_gains_rules_between_the_route_check_and_the_insert_is_still_refused(client, monkeypatch):
    hive = client.app.state.hive
    soon = client.post("/api/roles", json={"name": "Soon", "prompt": "You are {name}."}).json()   # rule-free for now
    ann = person(client, "u_ann")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    count = hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    real = hive.create_agent

    def edit_lands_first(*args, **kwargs):
        hive.roles.update(soon["id"], {"rules": [{"skill": "write-file", "mode": "allow"}]}, "user:operator")
        return real(*args, **kwargs)
    monkeypatch.setattr(hive, "create_agent", edit_lands_first)
    r = client.post("/api/agents", headers=ann, json={"name": "Ada", "swarm_id": sw["id"], "role_id": soon["id"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    assert hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"] == count
    assert hive.db.all("SELECT * FROM policy_rules WHERE note = 'role:Soon'") == []
