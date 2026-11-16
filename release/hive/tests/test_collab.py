"""Disposable Planner -> Review -> revision loop over the shared request/artifact/finding interfaces (no models)."""
import json

from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)


def mind(client, swarm, name, mandate=None):
    role = None
    if mandate:
        role = client.post("/api/roles", json={"name": f"{name} {mandate['id']} r", "prompt": "review", "mandate": mandate}).json()["id"]
    return client.post("/api/agents", json={"name": name, "kind": "module", "swarm_id": swarm["id"], "role_id": role}).json()


def call(client, who, method, path, body=None):
    return client.request(method, path, headers=agent_headers(who), json=body)


def held_goal(client, swarm, who, title="work"):
    g = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": title, "assignee": who["name"]}).json()
    assert call(client, who, "POST", f"/api/agent/goals/{g['id']}/claim").status_code == 200
    return g


PLAN1 = {"goal": "ship x", "constraints": ["no spend over 5"], "steps": [{"id": "s1", "do": "design"}, {"id": "s2", "do": "build"}, {"id": "s3", "do": "test"}]}
GRAPH = {"s2": ["s1"], "s3": ["s2"]}


def test_the_whole_loop_with_its_refusals(client):
    R, P, V, U = (client.post("/api/swarms", json={"name": n}).json() for n in ("Requester", "Planner", "Review", "Unrelated"))
    r, p, u = mind(client, R, "Asker"), mind(client, P, "Plan"), mind(client, U, "Other")
    v = mind(client, V, "Critic", {"id": "security", "version": "1"})
    w = mind(client, V, "Coster", {"id": "cost", "version": "1"})
    gR = held_goal(client, R, r)
    # receiving swarms opt in
    assert call(client, r, "POST", "/api/agent/requests", {"kind": "plan", "to_swarm": P["id"], "title": "Plan x", "from_goal": gR["id"]}).status_code == 403
    client.put(f"/api/swarms/{P['id']}/services", json={"kinds": ["plan"]})
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    rq1 = call(client, r, "POST", "/api/agent/requests", {"kind": "plan", "to_swarm": P["id"], "title": "Plan x", "from_goal": gR["id"], "budget_usd": 5}).json()
    assert rq1["state"] == "queued" and rq1["budget"]["root"] == rq1["id"] and rq1["depth"] == 0

    # the planner claims the receiving goal and writes revision 1
    gP = rq1["receiving_goal"]
    assert call(client, p, "POST", f"/api/agent/goals/{gP}/claim").status_code == 200
    assert call(client, r, "GET", f"/api/agent/requests/{rq1['id']}").json()["state"] == "working"
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "Plan x"}).json()
    rev1 = call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps(PLAN1), "dependency_graph": GRAPH, "parent": None}).json()
    assert rev1["n"] == 1 and rev1["digest"].startswith("sha256:")
    assert call(client, u, "GET", f"/api/agent/artifacts/{art['id']}/revisions/1").status_code == 403

    # review request bound to revision 1, nested under rq1 (shares its budget root)
    rq2 = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "Review plan x r1", "from_goal": gP,
                                                         "subject": {"artifact_id": art["id"], "revision": 1}, "budget_usd": 2, "constraints": {"mandates": [{"id": "security", "version": "1"}]}, "context_refs": ["ev:threat-notes"]}).json()
    rq2c = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "Cost review plan x r1", "from_goal": gP,
                                                          "subject": {"artifact_id": art["id"], "revision": 1}, "budget_usd": 1, "constraints": {"mandates": [{"id": "cost", "version": "1"}]}, "context_refs": ["ev:threat-notes"]}).json()
    assert rq2["ancestry"] == [rq1["id"]] and rq2["budget"]["root"] == rq1["id"] and rq2["subject"]["digest"] == rev1["digest"]
    over = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "again", "from_goal": gP,
                                                          "subject": {"artifact_id": art["id"], "revision": 1}, "budget_usd": 3, "constraints": {"mandates": [{"id": "security", "version": "1"}]}})
    assert over.status_code == 402 and over.json()["error"]["code"] == "request_budget"
    foreign = call(client, r, "POST", "/api/agent/requests", {"kind": "plan", "to_swarm": P["id"], "title": "x", "from_goal": gR["id"],
                                                             "subject": {"artifact_id": art["id"], "revision": 1}})
    assert foreign.status_code == 403 and foreign.json()["error"]["code"] == "not_your_artifact"

    # the reviewer reads exactly that revision and raises findings
    gV = rq2["receiving_goal"]
    call(client, v, "POST", f"/api/agent/goals/{gV}/claim")
    assert call(client, v, "GET", f"/api/agent/artifacts/{art['id']}/revisions/1").json()["digest"] == rev1["digest"]
    f1 = call(client, v, "POST", "/api/agent/findings", {"request_id": rq2["id"], "mandate": {"id": "security", "version": "1"},
                                                        "target": {"step": "s1"}, "severity": "major", "recommendation": "threat model first",
                                                        "evidence_refs": ["ev:threat-notes"]}).json()
    call(client, w, "POST", f"/api/agent/goals/{rq2c['receiving_goal']}/claim")
    wrong_role = call(client, v, "POST", "/api/agent/findings", {"request_id": rq2["id"], "mandate": {"id": "cost", "version": "1"},
                                                                "target": {"step": "s3"}, "severity": "minor", "recommendation": "x"})
    assert wrong_role.status_code == 403   # cost is not assigned on v's request, and v's role is security
    f2 = call(client, w, "POST", "/api/agent/findings", {"request_id": rq2c["id"], "mandate": {"id": "cost", "version": "1"},
                                                        "target": {"step": "s3"}, "severity": "minor", "recommendation": "cheaper test"}).json()
    assert f1["raised_on"] == {"artifact_id": art["id"], "revision": 1, "digest": rev1["digest"]}
    def finding(**over):
        body = dict({"request_id": rq2["id"], "mandate": {"id": "security", "version": "1"}, "target": {"step": "s2"},
                     "severity": "note", "recommendation": "why"}, **over)
        return call(client, v, "POST", "/api/agent/findings", body)
    assert finding(execute=True).status_code == 400
    assert finding(mandate={"id": "security", "version": "2"}).json()["error"]["code"] == "mandate_unassigned"
    assert finding(evidence_refs=["ev:not-exhibited"]).json()["error"]["code"] == "evidence_scope"
    assert finding(target={"step": "s9"}).json()["error"]["code"] == "invalid_target"
    assert finding(target={"path": "a.py:1"}).json()["error"]["code"] == "invalid_target"
    assert finding(recommendation="  ").status_code == 400
    assert call(client, u, "POST", "/api/agent/findings", {"request_id": rq2["id"], "mandate": {"id": "x", "version": "1"}, "severity": "note"}).status_code == 403

    # a cycle back to the planner is refused
    cyc = call(client, v, "POST", "/api/agent/requests", {"kind": "plan", "to_swarm": P["id"], "title": "loop", "from_goal": gV})
    assert cyc.status_code == 409 and cyc.json()["error"]["code"] == "request_cycle"

    # revision 2 changes s1: s2 and s3 are affected through the graph; open findings become unverified, never cleared
    stale = call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": "x", "parent": None})
    assert stale.status_code == 409
    plan2 = dict(PLAN1, steps=[{"id": "s1", "do": "design with threat model"}, {"id": "s2", "do": "build"}, {"id": "s3", "do": "test"}])
    rev2 = call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps(plan2), "dependency_graph": GRAPH, "parent": 1}).json()
    assert rev2["changed_steps"] == ["s1"] and rev2["affected_steps"] == ["s2", "s3"] and rev2["whole_plan_in_scope"] is False
    assert call(client, v, "GET", f"/api/agent/artifacts/{art['id']}/revisions/2").status_code == 403   # bound to revision 1 only
    assert call(client, v, "GET", f"/api/agent/artifacts/{art['id']}/revisions/1").status_code == 200
    found = {f["id"]: f for f in call(client, p, "GET", f"/api/agent/artifacts/{art['id']}/findings").json()}
    assert all(found[x]["applicability"] == [{"revision": 2, "state": "unverified", "by": "hive"}] for x in (f1["id"], f2["id"]))
    assert found[f1["id"]]["raised_on"]["revision"] == 1

    # the planner claims, only the reviewer decides
    call(client, p, "POST", f"/api/agent/findings/{f1['id']}/response", {"revision": 2, "stance": "addressed"})
    call(client, p, "POST", f"/api/agent/findings/{f2['id']}/response", {"revision": 2, "stance": "disputed", "note": "cost is fine"})
    assert call(client, p, "POST", f"/api/agent/findings/{f1['id']}/disposition", {"verdict": "confirmed-resolved", "revision": 2}).status_code == 403
    assert call(client, v, "POST", f"/api/agent/findings/{f1['id']}/response", {"revision": 2, "stance": "addressed"}).status_code == 403
    # judging revision 2 under the revision-1 request is refused; nonexistent revisions are refused
    unread = call(client, v, "POST", f"/api/agent/findings/{f1['id']}/disposition", {"verdict": "confirmed-resolved", "revision": 2})
    assert unread.status_code == 403 and unread.json()["error"]["code"] == "review_revision"
    assert call(client, v, "POST", f"/api/agent/findings/{f1['id']}/disposition", {"verdict": "still-open", "revision": 999}).status_code == 404
    rq3 = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "Re-review r2", "from_goal": gP,
                                                         "subject": {"artifact_id": art["id"], "revision": 2}, "budget_usd": 0.5, "constraints": {"mandates": [{"id": "security", "version": "1"}]}, "context_refs": ["ev:threat-notes"]}).json()
    rq3c = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "Cost re-review r2", "from_goal": gP,
                                                          "subject": {"artifact_id": art["id"], "revision": 2}, "budget_usd": 0.5, "constraints": {"mandates": [{"id": "cost", "version": "1"}]}, "context_refs": ["ev:threat-notes"]}).json()
    call(client, w, "POST", f"/api/agent/goals/{rq3c['receiving_goal']}/claim")
    call(client, v, "POST", f"/api/agent/goals/{rq3['receiving_goal']}/claim")
    d1 = call(client, v, "POST", f"/api/agent/findings/{f1['id']}/disposition", {"verdict": "confirmed-resolved", "revision": 2, "request_id": rq3["id"]}).json()
    assert call(client, v, "POST", f"/api/agent/findings/{f2['id']}/disposition", {"verdict": "withdrawn", "revision": 2, "request_id": rq3["id"]}).status_code == 403
    d2 = call(client, w, "POST", f"/api/agent/findings/{f2['id']}/disposition", {"verdict": "still-open", "revision": 2, "request_id": rq3c["id"]}).json()
    assert d1["raised_on"]["revision"] == 1 and [h["type"] for h in d1["history"]] == ["applicability", "planner_response", "disposition"]
    assert d1["planner_response"]["stance"] == "addressed" and d1["disposition"]["verdict"] == "confirmed-resolved"
    assert d2["planner_response"]["stance"] == "disputed" and d2["disposition"]["verdict"] == "still-open"   # dissent kept

    # a global change puts the whole plan in scope; only the still-open finding gains applicability
    plan3 = dict(plan2, constraints=["no spend over 3"])
    rev3 = call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps(plan3), "dependency_graph": GRAPH, "parent": 2}).json()
    assert rev3["whole_plan_in_scope"] is True and rev3["affected_steps"] == ["s1", "s2", "s3"]
    found = {f["id"]: f for f in call(client, p, "GET", f"/api/agent/artifacts/{art['id']}/findings").json()}
    # the global change puts s1 back in scope, so the resolved finding is reopened for checking (unverified)
    assert found[f1["id"]]["applicability"][-1] == {"revision": 3, "state": "unverified", "by": "hive", "reason": "target changed after resolution"}
    assert found[f2["id"]]["applicability"][-1]["revision"] == 3

    # cancelling the root cascades; the reviewer loses access and cannot add findings
    assert call(client, v, "POST", f"/api/agent/requests/{rq1['id']}/cancel").status_code == 403
    out = call(client, r, "POST", f"/api/agent/requests/{rq1['id']}/cancel").json()
    assert set(out["cancelled"]) == {rq1["id"], rq2["id"], rq2c["id"], rq3["id"], rq3c["id"]}
    late = call(client, w, "POST", f"/api/agent/findings/{f2['id']}/disposition", {"verdict": "withdrawn", "revision": 2, "request_id": rq3c["id"]})
    assert late.status_code == 403
    assert call(client, r, "GET", f"/api/agent/requests/{rq2['id']}").status_code == 403   # requester sees only its own request
    assert call(client, p, "GET", f"/api/agent/requests/{rq2['id']}").json()["state"] == "cancelled"
    assert call(client, v, "GET", f"/api/agent/artifacts/{art['id']}/revisions/2").status_code == 403
    assert call(client, v, "POST", "/api/agent/findings", {"request_id": rq2["id"], "mandate": {"id": "x", "version": "1"}, "severity": "note"}).status_code == 403
    goals = {g["id"]: g["status"] for g in client.get(f"/api/swarms/{V['id']}/goals").json()}
    assert goals[gV] == "cancelled"


def test_budgets_must_be_finite_and_finished_requests_close_access(client):
    R, P, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("A", "B", "C"))
    r, p, v = mind(client, R, "Asker"), mind(client, P, "Plan"), mind(client, V, "Critic", {"id": "m", "version": "1"})
    client.put(f"/api/swarms/{P['id']}/services", json={"kinds": ["plan"]})
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    gR = held_goal(client, R, r)
    for bad in ("nan", "inf", "-inf", 1e12):
        res = call(client, r, "POST", "/api/agent/requests", {"kind": "plan", "to_swarm": P["id"], "title": "x", "from_goal": gR["id"], "budget_usd": bad})
        assert res.status_code == 400, bad
    gP = held_goal(client, P, p)
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "t"}).json()
    call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": "{}", "parent": None})
    rq = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "r", "from_goal": gP["id"],
                                                        "subject": {"artifact_id": art["id"], "revision": 1}, "constraints": {"mandates": [{"id": "m", "version": "1"}]}}).json()
    call(client, v, "POST", f"/api/agent/goals/{rq['receiving_goal']}/claim")
    assert call(client, v, "GET", f"/api/agent/artifacts/{art['id']}/revisions/1").status_code == 200
    done = call(client, v, "POST", f"/api/agent/requests/{rq['id']}/review-complete",
                {"recommendation": "proceed", "rationale": "no objection: nothing found", "finding_ids": []})
    assert done.status_code == 200
    assert call(client, v, "GET", f"/api/agent/artifacts/{art['id']}/revisions/1").status_code == 403   # finished: access ends
    after = call(client, v, "POST", "/api/agent/findings", {"request_id": rq["id"], "mandate": {"id": "m", "version": "1"},
                                                           "target": {"step": "s1"}, "severity": "note", "recommendation": "late"})
    assert after.status_code == 403 and after.json()["error"]["code"] == "review_not_held"   # no findings after the goal is done


def test_a_mind_without_the_mandate_cannot_raise_under_it(client):
    R, P, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("A2", "B2", "C2"))
    p = mind(client, P, "Plan")
    coordinator = mind(client, V, "Coordinator")            # a role with no mandate
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    gP = held_goal(client, P, p)
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "t"}).json()
    call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": '{"steps": [{"id": "s1"}]}', "parent": None})
    refused = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "r", "from_goal": gP["id"],
                                                        "subject": {"artifact_id": art["id"], "revision": 1}, "constraints": {"mandates": [{"id": "m", "version": "1"}]}})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "reviewer_ambiguous"


def test_a_review_finishes_only_with_its_structured_receipt(client):
    R, P, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("Req3", "Plan3", "Rev3"))
    p = mind(client, P, "Plan")
    v = mind(client, V, "Sec", {"id": "security", "version": "1"})
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    gP = held_goal(client, P, p)
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "t"}).json()
    call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps(PLAN1), "parent": None})
    def review():
        rq = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "r", "from_goal": gP["id"],
                                                            "subject": {"artifact_id": art["id"], "revision": 1},
                                                            "constraints": {"mandates": [{"id": "security", "version": "1"}]}}).json()
        goal = call(client, v, "GET", f"/api/agent/goals/{rq['receiving_goal']}").json()
        assert goal["assignee"] == v["id"]                                    # assigned to the one eligible reviewer
        call(client, v, "POST", f"/api/agent/goals/{rq['receiving_goal']}/claim")
        return rq, goal
    rq, goal = review()
    plain = call(client, v, "POST", f"/api/agent/goals/{goal['id']}/result", {"status": "done", "result": "looks fine",
                                                                              "data": {"binding_digest": goal["binding_digest"]}})
    assert plain.status_code == 409 and plain.json()["error"]["code"] == "review_needs_receipt"
    f1 = call(client, v, "POST", "/api/agent/findings", {"request_id": rq["id"], "mandate": {"id": "security", "version": "1"},
                                                        "target": {"step": "s1"}, "severity": "major", "recommendation": "threat model"}).json()
    omitted = call(client, v, "POST", f"/api/agent/requests/{rq['id']}/review-complete", {"recommendation": "revise", "rationale": "r", "finding_ids": []})
    assert omitted.status_code == 409 and omitted.json()["error"]["code"] == "findings_mismatch"
    # malformed results are refused whole, never coerced or truncated (six cases found by OmegaReview)
    url = f"/api/agent/requests/{rq['id']}/review-complete"
    good = {"recommendation": "revise", "rationale": "r", "finding_ids": [f1["id"]]}
    for bad, status in [({"recommendation": {"x": 1}}, 400), ({"recommendation": "execute"}, 400), ({"recommendation": "no objection"}, 400),
                        ({"rationale": ["a", "b"]}, 400), ({"rationale": "x" * 4001}, 413),
                        ({"finding_ids": ""}, 400), ({"coverage": 7}, 400), ({"coverage": ["s"] * 51}, 400), ({"coverage": ["x" * 201]}, 400)]:
        # mind fitness 2026-10-06: one coverage text given as text ("s1") is now taken as ["s1"], never split into
        # characters (test_mind_fitness_feedback); "" and non-text are still refused whole
        assert call(client, v, "POST", url, {**good, **bad}).status_code == status, bad
    out = call(client, v, "POST", f"/api/agent/requests/{rq['id']}/review-complete",
               {"recommendation": "revise", "rationale": "s1 lacks a threat model", "finding_ids": [f1["id"]], "coverage": ["s1", "s2", "s3"]}).json()
    r = out["receipt"]
    assert r["findings"][0]["id"] == f1["id"] and r["findings"][0]["digest"].startswith("sha256:") and r["empty"] is False
    assert r["authority"] == "none" and r["mandate"] == {"id": "security", "version": "1"}
    stored = call(client, p, "GET", f"/api/agent/requests/{rq['id']}").json()
    assert stored["state"] == "completed" and stored["result"]["review_receipt"] == r
    # an empty review is allowed, but only explicitly, and only once per held goal
    rq2, _ = review()
    empty = call(client, v, "POST", f"/api/agent/requests/{rq2['id']}/review-complete",
                 {"recommendation": "proceed", "rationale": "no objection under this mandate", "finding_ids": []}).json()
    assert empty["receipt"]["empty"] is True
    again = call(client, v, "POST", f"/api/agent/requests/{rq2['id']}/review-complete",
                 {"recommendation": "proceed", "rationale": "x", "finding_ids": []})
    assert again.status_code == 403                                          # the goal is done: no longer held


def test_a_coordinator_reads_every_receipt_and_its_qc_decision_on_one_exact_subject(client):
    R, V, U = (client.post("/api/swarms", json={"name": n}).json() for n in ("ReqC", "RevC", "OutsideC"))
    p = mind(client, R, "Asker")
    a = mind(client, V, "SecC", {"id": "security", "version": "1"})
    b = mind(client, V, "CostC", {"id": "cost", "version": "1"})
    qc = mind(client, V, "QC")
    coord = mind(client, V, "Coord")
    outsider = mind(client, U, "Nosy")
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    g = held_goal(client, R, p)
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "t"}).json()
    rev = call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps(PLAN1), "parent": None}).json()
    for who, mandate in ((a, "security"), (b, "cost")):
        rq = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": mandate, "from_goal": g["id"],
                                                            "subject": {"artifact_id": art["id"], "revision": 1},
                                                            "constraints": {"mandates": [{"id": mandate, "version": "1"}], "review": f"agent:{qc['id']}"}}).json()
        call(client, who, "POST", f"/api/agent/goals/{rq['receiving_goal']}/claim")
        rec = "hold" if mandate == "security" else "proceed"
        assert call(client, who, "POST", f"/api/agent/requests/{rq['id']}/review-complete",
                    {"recommendation": rec, "rationale": f"{mandate} view", "finding_ids": []}).json()["goal"]["status"] == "submitted"
        call(client, qc, "POST", f"/api/agent/goals/{rq['receiving_goal']}/review", {"decision": "accept", "notes": "well supported"})
    out = call(client, coord, "GET", f"/api/agent/review-receipts?subject_digest={rev['digest']}").json()
    assert out["count"] == 2
    recs = {r["receipt"]["mandate"]["id"]: r for r in out["requests"]}
    assert recs["security"]["receipt"]["recommendation"] == "hold" and recs["cost"]["receipt"]["recommendation"] == "proceed"   # dissent kept
    assert [q["action"] for q in recs["security"]["qc"]] == ["submit", "accept"] and recs["security"]["qc"][1]["notes"] == "well supported"
    assert call(client, coord, "GET", "/api/agent/review-receipts?subject_digest=sha256:" + "0" * 64).json()["count"] == 0
    assert call(client, outsider, "GET", f"/api/agent/review-receipts?subject_digest={rev['digest']}").json()["count"] == 0   # not their swarm
    wrong = call(client, coord, "GET", f"/api/agent/review-receipts?subject_digest={rq['id']}")   # a request id, not the digest
    assert wrong.status_code == 400 and rev["digest"] in wrong.json()["error"]["message"]
