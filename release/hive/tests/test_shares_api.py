"""Timed, consented sharing of private memory between dots."""

import asyncio
import json

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def write_space(client, agent, name, atoms):
    memory = client.app.state.hive.settings.agents_dir / agent["id"] / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    (memory / f"{name}.metta").write_text("\n".join(atoms) + "\n")


def call(client, agent, method, path, body=None, **params):
    return client.request(method, path, headers=agent_headers(agent), json=body, params=params)


def inbox(client, agent):
    return [json.loads(m["text"]) for m in call(client, agent, "GET", "/api/agent/inbox").json()["messages"]]


THEORY = ['(Theory gravity "mass bends spacetime")', '(Theory light "c is constant")', "(Note todo check units)"]


def test_request_grant_read_and_expire(client):
    _, (a, b) = make_swarm_and_agents(client)
    write_space(client, a, "world", THEORY)
    req = call(client, b, "POST", "/api/agent/shares/request",
               {"owner": a["name"], "space": "world", "minutes": 20, "reason": "checking the light theory"}).json()
    assert req["status"] == "requested" and req["owner_id"] == a["id"]
    assert call(client, b, "POST", "/api/agent/shares/request",
                {"owner": a["name"], "space": "world"}).json()["id"] == req["id"]   # no duplicates
    assert inbox(client, a)[-1]["event"] == "share_request"
    assert call(client, b, "GET", f"/api/agent/shares/{req['id']}/atoms").status_code == 410   # not granted yet
    assert call(client, b, "POST", f"/api/agent/shares/{req['id']}/grant").status_code == 403  # only the owner
    granted = call(client, a, "POST", f"/api/agent/shares/{req['id']}/grant").json()
    assert granted["status"] == "active" and granted["expires_at"]
    assert inbox(client, b)[-1]["event"] == "share_granted"
    read = call(client, b, "GET", f"/api/agent/shares/{req['id']}/atoms", q="theory").json()
    assert read["total"] == 2 and read["owner"] == a["name"]
    assert call(client, a, "GET", f"/api/agent/shares/{req['id']}/atoms").status_code == 403  # owner isn't grantee
    assert client.get(f"/api/shares/{req['id']}/reads").json()[0]["returned"] == 2
    hive = client.app.state.hive
    hive.db.update("shares", req["id"], {"expires_at": "2000-01-01T00:00:00.000Z"})
    assert asyncio.run(hive.shares.expire()) == [req["id"]]
    assert call(client, b, "GET", f"/api/agent/shares/{req['id']}/atoms").status_code == 410
    assert inbox(client, b)[-1]["event"] == "share_expired"


def test_deny_offer_filter_and_revoke(client):
    _, (a, b) = make_swarm_and_agents(client)
    write_space(client, a, "world", THEORY)
    req = call(client, b, "POST", "/api/agent/shares/request", {"owner": a["id"], "space": "world"}).json()
    assert call(client, a, "POST", f"/api/agent/shares/{req['id']}/deny", {"reason": "not ready"}).json()["status"] \
        == "denied"
    offer = call(client, a, "POST", "/api/agent/shares/offer",
                 {"grantee": b["name"], "space": "world", "minutes": 999, "filter": "light"}).json()
    assert offer["status"] == "active" and offer["minutes"] == 240    # capped
    read = call(client, b, "GET", f"/api/agent/shares/{offer['id']}/atoms").json()
    assert read["atoms"] == ['(Theory light "c is constant")']        # the owner's filter always applies
    assert call(client, b, "POST", f"/api/agent/shares/{offer['id']}/revoke").status_code == 403
    assert call(client, a, "POST", f"/api/agent/shares/{offer['id']}/revoke").json()["status"] == "revoked"
    assert call(client, b, "GET", f"/api/agent/shares/{offer['id']}/atoms").status_code == 410


def test_exhibit_to_the_swarm(client):
    _, (a, b, c) = make_swarm_and_agents(client, n=3)
    write_space(client, a, "world", THEORY)
    shown = call(client, a, "POST", "/api/agent/exhibits",
                 {"title": "Unified notes", "to": "swarm", "minutes": 10, "body": "Draft of the theory.",
                  "space": "world", "filter": "Theory", "atoms": ["(Claim x)"]}).json()
    assert shown["atoms"] == 3 and len(shown["shares"]) == 2
    share = next(s for s in shown["shares"] if s["grantee_id"] == c["id"])
    read = call(client, c, "GET", f"/api/agent/shares/{share['id']}/atoms").json()
    assert read["title"] == "Unified notes" and read["body"] == "Draft of the theory." and read["total"] == 3
    assert inbox(client, b)[-1]["event"] == "exhibit"
    big = call(client, a, "POST", "/api/agent/exhibits", {"title": "Huge", "to": "swarm", "body": "x" * 300000})
    assert big.status_code == 413


def test_sharing_stays_inside_the_swarm(client):
    _, (a,) = make_swarm_and_agents(client, n=1)
    _, (stranger,) = make_swarm_and_agents(client, n=1)
    write_space(client, a, "world", THEORY)
    asked = call(client, stranger, "POST", "/api/agent/shares/request", {"owner": a["id"], "space": "world"})
    assert asked.status_code == 404
    assert call(client, a, "POST", "/api/agent/shares/request", {"owner": a["id"], "space": "world"}).status_code \
        == 400  # asking yourself
    missing = call(client, a, "POST", "/api/agent/shares/offer", {"grantee": "nobody", "space": "world"})
    assert missing.status_code == 404


def test_external_members_use_timed_exhibits(client):
    swarm = client.post("/api/swarms", json={"name": "Private project"}).json()
    codex = client.post("/api/agents", json={"name": "Codex", "kind": "module", "swarm_id": swarm["id"]}).json()
    fable = client.post("/api/agents", json={"name": "Fable", "kind": "module", "swarm_id": swarm["id"]}).json()
    shown = call(client, codex, "POST", "/api/agent/exhibits",
                 {"title": "Module map v1", "to": ["Fable"], "minutes": 15, "body": "outline"}).json()
    share = shown["shares"][0]
    assert inbox(client, fable)[-1]["event"] == "exhibit"
    assert call(client, fable, "GET", f"/api/agent/shares/{share['id']}/atoms").json()["body"] == "outline"
    assert client.post(f"/api/shares/{share['id']}/revoke").json()["status"] == "revoked"   # operator revokes
    assert call(client, fable, "GET", f"/api/agent/shares/{share['id']}/atoms").status_code == 410


# ---- policy applies to direct HTTP callers too ------------------------------------------------

def test_deny_rules_refuse_disclosure_at_the_endpoint(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    write_space(client, a, "world", THEORY)
    for skill in ("hive-exhibit", "hive-exhibit-space", "hive-share-offer", "hive-share-grant"):
        client.post("/api/policy", json={"scope": "hive", "skill": skill, "mode": "deny"})
    exhibit = call(client, a, "POST", "/api/agent/exhibits", {"title": "T", "to": "swarm", "body": "x"})
    assert exhibit.status_code == 403 and exhibit.json()["error"]["code"] == "policy_denied"
    snapshot = call(client, a, "POST", "/api/agent/exhibits", {"title": "T", "to": "swarm", "space": "world"})
    assert snapshot.status_code == 403
    offer = call(client, a, "POST", "/api/agent/shares/offer", {"grantee": b["name"], "space": "world"})
    assert offer.status_code == 403
    req = call(client, b, "POST", "/api/agent/shares/request", {"owner": a["name"], "space": "world"}).json()
    grant = call(client, a, "POST", f"/api/agent/shares/{req['id']}/grant")
    assert grant.status_code == 403 and grant.json()["error"]["code"] == "policy_denied"
    assert client.get("/api/shares", params={"status": "active"}).json() == []      # nothing was disclosed
    client.post("/api/policy", json={"scope": f"swarm:{swarm['id']}", "skill": "hive-shared", "mode": "deny"})
    offer_rule = [r for r in client.get("/api/policy").json() if r["skill"] == "hive-share-offer"][0]
    client.delete(f"/api/policy/{offer_rule['id']}")
    opened = call(client, a, "POST", "/api/agent/shares/offer", {"grantee": b["name"], "space": "world"}).json()
    assert call(client, b, "GET", f"/api/agent/shares/{opened['id']}/atoms").status_code == 403  # reading denied


def test_ask_rules_need_a_person_once_per_disclosure(client):
    _, (a, b) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": "hive", "skill": "hive-exhibit", "mode": "ask"})
    body = {"title": "Module map", "to": [b["name"]], "body": "outline"}
    first = call(client, a, "POST", "/api/agent/exhibits", body)
    assert first.status_code == 403 and first.json()["error"]["code"] == "approval_required"
    approval_id = first.json()["error"]["approval_id"]
    assert client.get("/api/shares").json() == []
    client.post(f"/api/approvals/{approval_id}/approve")
    assert call(client, a, "POST", "/api/agent/exhibits", body).status_code == 200      # runs once
    again = call(client, a, "POST", "/api/agent/exhibits", body)
    assert again.status_code == 403 and again.json()["error"]["code"] == "approval_required"


def test_an_omega_gate_approval_covers_the_call_it_approved(client):
    _, (a, b) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": "hive", "skill": "hive-exhibit", "mode": "ask"})
    command = '(hive-exhibit "Bo" 10 "Notes | text")'
    pending = call(client, a, "POST", "/api/agent/authorize", {"command": command}).json()
    client.post(f"/api/approvals/{pending['approval_id']}/approve")
    assert call(client, a, "POST", "/api/agent/authorize", {"command": command}).json()["decision"] == "allow"
    body = {"title": "Notes", "to": [b["name"]], "body": "text"}
    assert call(client, a, "POST", "/api/agent/exhibits", body).status_code == 200      # the gate's approval
    assert call(client, a, "POST", "/api/agent/exhibits", body).status_code == 403      # redeemed only once


# ---- reads are paged explicitly; nothing is silently cut ------------------------------------------

def test_large_exhibits_page_with_totals(client):
    _, (a, b) = make_swarm_and_agents(client)
    atoms = [f"(Step {i})" for i in range(600)]
    shown = call(client, a, "POST", "/api/agent/exhibits", {"title": "Long proof", "to": [b["name"]],
                                                              "atoms": atoms, "body": "intro"}).json()
    sid = shown["shares"][0]["id"]
    page = call(client, b, "GET", f"/api/agent/shares/{sid}/atoms", limit=2000).json()
    assert page["total"] == 600 and page["returned"] == 500 and page["limit_clamped"] is True
    assert page["complete"] is False and page["next_offset"] == 500 and page["body"] == "intro"
    rest = call(client, b, "GET", f"/api/agent/shares/{sid}/atoms", limit=500, offset=500).json()
    assert rest["returned"] == 100 and rest["next_offset"] is None and rest["body"] == ""
    assert page["atoms"] + rest["atoms"] == atoms                                    # every atom, in order
    small = call(client, b, "GET", f"/api/agent/shares/{sid}/atoms", q="Step 59").json()
    assert small["complete"] is True and small["total"] == len([x for x in atoms if "Step 59" in x])


def test_space_shares_page_past_a_thousand_atoms(client):
    _, (a, b) = make_swarm_and_agents(client)
    write_space(client, a, "world", [f"(Fact {i})" for i in range(1200)])
    offer = call(client, a, "POST", "/api/agent/shares/offer", {"grantee": b["name"], "space": "world"}).json()
    seen, offset = [], 0
    while offset is not None:
        page = call(client, b, "GET", f"/api/agent/shares/{offer['id']}/atoms", limit=500, offset=offset).json()
        assert page["total"] == 1200
        seen += page["atoms"]
        offset = page["next_offset"]
    assert len(seen) == 1200 and seen[-1] == "(Fact 1199)"
