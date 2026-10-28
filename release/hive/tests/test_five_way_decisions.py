"""the owner's five answers (2026-10-04): Once, For a time, Always, No, Never, for minds' approvals and people's requests."""
import time

from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_phase2_api import authorize
from hive.tests.test_visibility import person


def decide(client, approval_id, decision, minutes=None):
    return client.post(f"/api/approvals/{approval_id}/decide", json={"decision": decision, "minutes": minutes})


def test_for_a_time_allows_until_it_expires(client):
    _, (a, _) = make_swarm_and_agents(client)
    p = authorize(client, a, '(write-file "x.txt" "y")')
    assert decide(client, p["approval_id"], "for", 10).json()["status"] == "approved"
    authorize(client, a, '(write-file "x.txt" "y")')                                   # the one-shot grant
    assert authorize(client, a, '(write-file "other.txt" "z")')["decision"] == "allow"   # the timed rule
    hive = client.app.state.hive
    hive.db.execute("UPDATE policy_rules SET expires_at = ? WHERE expires_at IS NOT NULL", (time.time() - 1,))
    assert authorize(client, a, '(write-file "later.txt" "z")')["decision"] == "pending"  # expired: asks again
    assert not any(r.get("expires_at") for r in client.get("/api/policy").json())


def test_never_refuses_and_keeps_refusing(client):
    _, (a, b) = make_swarm_and_agents(client)
    p = authorize(client, a, '(write-file "x.txt" "y")')
    assert decide(client, p["approval_id"], "never").json()["status"] == "denied"
    assert authorize(client, a, '(write-file "other.txt" "z")')["decision"] == "deny"
    assert authorize(client, b, '(write-file "other.txt" "z")')["decision"] == "pending"   # only that mind


def test_once_always_no_and_bad_answers(client):
    _, (a, _) = make_swarm_and_agents(client)
    p = authorize(client, a, '(write-file "x.txt" "y")')
    assert decide(client, p["approval_id"], "maybe").status_code == 400
    assert decide(client, p["approval_id"], "for").status_code == 400                   # needs minutes
    assert decide(client, p["approval_id"], "for", 99999).status_code == 400
    assert decide(client, p["approval_id"], "no").json()["status"] == "denied"
    assert decide(client, p["approval_id"], "once").status_code == 409                  # already decided
    p = authorize(client, a, '(write-file "x.txt" "y")')
    decide(client, p["approval_id"], "always")
    authorize(client, a, '(write-file "x.txt" "y")')
    assert authorize(client, a, '(write-file "z.txt" "y")')["decision"] == "allow"


def test_app_actions_are_once_only(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.db.insert("approvals", {"id": "p_app00001", "agent_id": a["id"], "skill": "program:studio:save", "command": "x", "reason": "test",
                                 "risk": "medium", "status": "pending", "created_at": "2026-10-04T00:00:00Z"})
    assert decide(client, "p_app00001", "always").json()["error"]["code"] == "exact_only"
    assert decide(client, "p_app00001", "for", 5).json()["error"]["code"] == "exact_only"


def test_member_asks_for_a_mind_and_an_admin_answers(client):
    ann = person(client, "u_ann")
    quinn = person(client, "u_quinn", role="admin")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()
    r = client.post("/api/asks", headers=ann, json={"kind": "mind", "payload": {"name": "Helper", "swarm_id": sw["id"]}})
    assert r.status_code == 200 and r.json()["status"] == "pending", r.text
    assert client.post(f"/api/asks/{r.json()['id']}/decide", headers=ann, json={"decision": "once"}).status_code == 403
    done = client.post(f"/api/asks/{r.json()['id']}/decide", headers=quinn, json={"decision": "always"}).json()
    assert done["status"] == "granted"
    mind = client.app.state.hive.agent(done["result"]["agent_id"])
    assert mind["owner"] == "user:u_ann" and mind["swarm_id"] == sw["id"]
    # always: the next one is granted at once
    again = client.post("/api/asks", headers=ann, json={"kind": "mind", "payload": {"name": "Two", "swarm_id": sw["id"]}}).json()
    assert again["status"] == "granted" and again["decided_by"].startswith("rule:")
    # Ann sees her own; another member sees none of hers
    bob = person(client, "u_bob")
    assert len(client.get("/api/asks", headers=ann).json()) == 2 and client.get("/api/asks", headers=bob).json() == []


def test_never_declines_this_kind_from_then_on(client):
    ann = person(client, "u_ann")
    quinn = person(client, "u_quinn", role="admin")
    r = client.post("/api/asks", headers=ann, json={"kind": "allowance", "payload": {"monthly_usd": 80}}).json()
    client.post(f"/api/asks/{r['id']}/decide", headers=quinn, json={"decision": "never"})
    again = client.post("/api/asks", headers=ann, json={"kind": "allowance", "payload": {"monthly_usd": 60}}).json()
    assert again["status"] == "declined"


def test_allowance_and_swarm_access_take_effect(client):
    ann = person(client, "u_a0000001")
    quinn = person(client, "u_quinn", role="admin")
    hive = client.app.state.hive
    r = client.post("/api/asks", headers=ann, json={"kind": "allowance", "payload": {"monthly_usd": 80}}).json()
    client.post(f"/api/asks/{r['id']}/decide", headers=quinn, json={"decision": "once"})
    assert any(x["scope"] == "person:u_a0000001" and x["limit_usd"] == 80 for x in hive.budgets.rules())
    private = client.post("/api/swarms", headers=quinn, json={"name": "Quinn's"}).json()
    assert client.get(f"/api/swarms/{private['id']}", headers=ann).status_code == 404
    r = client.post("/api/asks", headers=ann, json={"kind": "swarm_access", "payload": {"swarm_id": private["id"]}}).json()
    client.post(f"/api/asks/{r['id']}/decide", headers=quinn, json={"decision": "once"})
    assert client.get(f"/api/swarms/{private['id']}", headers=ann).status_code == 200


def test_running_out_asks_the_admins_once_a_month(client):
    hive = client.app.state.hive
    person(client, "u_ann")
    hive.person_requests.auto_allowance("user:u_ann", 50)
    hive.person_requests.auto_allowance("user:u_ann", 50)
    rows = hive.db.all("SELECT * FROM person_requests WHERE requested_by = 'user:u_ann'")
    assert len(rows) == 1 and rows[0]["kind"] == "allowance" and rows[0]["status"] == "pending"


def test_answers_become_revisable_evidence_in_the_governance_commons(client):
    _, (a, _) = make_swarm_and_agents(client)
    ids = []
    for _ in range(3):
        p = authorize(client, a, '(write-file "x.txt" "y")')
        ids.append(p["approval_id"])
        decide(client, p["approval_id"], "once")
        authorize(client, a, '(write-file "x.txt" "y")')                               # use the grant
    rec = client.get(f"/api/approvals/{ids[-1]}/track-record").json()
    assert rec["answers"] == 3 and rec["positive"] == 3
    assert rec["tv"]["f"] == 1.0 and abs(rec["tv"]["c"] - 0.75) < 1e-6                 # three observations: 3/(3+1)
    p = authorize(client, a, '(write-file "x.txt" "y")')
    decide(client, p["approval_id"], "no")
    rec = client.get(f"/api/approvals/{p['approval_id']}/track-record").json()
    assert rec["answers"] == 4 and rec["positive"] == 3 and abs(rec["tv"]["f"] - 0.75) < 1e-6 and abs(rec["tv"]["c"] - 0.8) < 1e-6


def test_a_standing_answer_is_not_new_evidence(client):
    ann = person(client, "u_ann")
    quinn = person(client, "u_quinn", role="admin")
    r = client.post("/api/asks", headers=ann, json={"kind": "allowance", "payload": {"monthly_usd": 80}}).json()
    client.post(f"/api/asks/{r['id']}/decide", headers=quinn, json={"decision": "never"})
    client.post("/api/asks", headers=ann, json={"kind": "allowance", "payload": {"monthly_usd": 60}})
    assert client.app.state.hive.db.one("SELECT count(*) AS n FROM governance_evidence")["n"] == 1


def test_a_later_never_overrides_an_earlier_always(client):
    """Security fix (2026-10-04): ties used to go to the oldest rule, so Never after Always was ignored."""
    _, (a, _) = make_swarm_and_agents(client)
    p = authorize(client, a, '(write-file "x.txt" "y")')
    decide(client, p["approval_id"], "always")
    authorize(client, a, '(write-file "x.txt" "y")')
    assert authorize(client, a, '(write-file "z.txt" "y")')["decision"] == "allow"
    hive = client.app.state.hive
    hive.db.insert("approvals", {"id": "p_never001", "agent_id": a["id"], "skill": "write-file", "command": '(write-file "q.txt" "y")',
                                 "reason": "test", "risk": "medium", "status": "pending", "created_at": "2026-10-04T00:00:00Z"})
    assert decide(client, "p_never001", "never").json()["status"] == "denied"
    assert authorize(client, a, '(write-file "w.txt" "y")')["decision"] == "deny"
    p = authorize(client, a, '(write-file "w.txt" "y")')
    assert p["decision"] == "deny"
    rules = [r for r in hive.db.all("SELECT * FROM policy_rules WHERE scope = ?", (f"agent:{a['id']}",))]
    assert any(r["mode"] == "allow" and r["expires_at"] for r in rules)       # the old Always is kept, expired


def test_a_later_always_overrides_an_earlier_never(client):
    _, (a, _) = make_swarm_and_agents(client)
    p = authorize(client, a, '(write-file "x.txt" "y")')
    decide(client, p["approval_id"], "never")
    assert authorize(client, a, '(write-file "x.txt" "y")')["decision"] == "deny"
    hive = client.app.state.hive
    hive.db.insert("approvals", {"id": "p_alwys001", "agent_id": a["id"], "skill": "write-file", "command": '(write-file "q.txt" "y")',
                                 "reason": "test", "risk": "medium", "status": "pending", "created_at": "2026-10-04T00:00:00Z"})
    decide(client, "p_alwys001", "always")
    assert authorize(client, a, '(write-file "w.txt" "y")')["decision"] == "allow"


def test_deny_wins_a_tie_with_an_admin_allow(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "write-file", "mode": "deny"})
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "write-file", "mode": "allow"})
    assert authorize(client, a, '(write-file "w.txt" "y")')["decision"] == "deny"


def test_remember_refuses_high_risk(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.db.insert("approvals", {"id": "p_hirisk01", "agent_id": a["id"], "skill": "metta", "command": "(metta (+ 1 1))",
                                 "reason": "test", "risk": "high", "status": "pending", "created_at": "2026-10-04T00:00:00Z"})
    r = client.post("/api/approvals/p_hirisk01/approve", json={"remember": True})
    assert r.status_code == 400 and r.json()["error"]["code"] == "one_at_a_time"
