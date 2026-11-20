"""Purpose: verify both mind kinds recover completed swarm work and continue it without replaying completion."""

import json
import pathlib
import re

import pytest

from hive.core.goals import CONTINUATION_KEYS, MAX_DETAIL_CHARS
from hive.tests.test_core_api import agent_headers, client  # noqa: F401
from hive.tests.test_mcp_s3 import HEX, c, call, member, swarm as mcp_swarm  # noqa: F401  (c is the MCP host fixture)
from hive.tests.test_mind_fitness_iter import through, tool
from hive.tests.test_mind_fitness_prompt import hc
from hive.tests.test_visibility import person

# The function an Omega command runs where its name differs from the Iter tool's (modules/hive/skills.metta).
OMEGA = {"goal_done": "goal_finish"}
SKILLS = pathlib.Path(__file__).resolve().parents[2] / "modules" / "hive" / "skills.metta"
DONE_COMMAND = '(= (hive-goal-done $id $result)\n   (py-call (hive_commons.goal_finish $id "done" $result)))'


@pytest.fixture(params=["iter", "omega"])
def mind(request, client, monkeypatch):
    swarm = client.post("/api/swarms", json={"name": "History"}).json()
    agent = client.post("/api/agents", json={"name": "Reader", "kind": "module", "swarm_id": swarm["id"]}).json()
    peer = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": swarm["id"]}).json()
    monkeypatch.setenv("HIVE_AGENT_ID", agent["id"])

    def transport(method, path, payload=None):
        response = client.request(method, path, headers=agent_headers(agent), json=payload)
        if response.status_code >= 400:
            error = response.json()["error"]
            return None, f"HIVE-ERROR {error['code']}: {error['message']}"
        return response.json(), None

    monkeypatch.setattr(hc, "_call", transport)

    def invoke(name, *args):
        if request.param == "iter":
            return through(client, agent, tool("hive_" + name)).run(*args)
        return getattr(hc, OMEGA.get(name, name))(*args)

    return swarm, agent, peer, invoke


def completed(client, swarm, author, title="Create report", detail="Build the report.", data=None):
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": title, "detail": detail}).json()
    headers = agent_headers(author)
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=headers).status_code == 200
    response = client.post(f"/api/agent/goals/{goal['id']}/result", headers=headers,
                           json={"status": "done", "result": "Created the draft in ar_report", "data": data})
    assert response.status_code == 200, response.text
    return response.json()


def test_minds_find_swarm_output_and_continue_it(client, mind):
    swarm, reader, maker, invoke = mind
    original = completed(client, swarm, maker, data={"artifact_id": "ar_report", "remaining": "Add the final chart"})
    assert original["id"] in invoke("goals")
    history = invoke("goal_history", "ar_report", 0)
    assert original["id"] in history and "Created the draft" in history
    detail = invoke("goal_get", original["id"])
    assert "Created the draft" in detail and "Add the final chart" in detail
    response = invoke("goal_continue", original["id"], "Add the final chart and verify it")
    assert "HIVE-ERROR" not in response, response
    follow_id = re.search(r"g_[a-z0-9]+", response).group()
    assert follow_id != original["id"]
    follow = client.get(f"/api/agent/goals/{follow_id}", headers=agent_headers(reader)).json()
    assert follow["status"] == "claimed" and follow["claimed_by"] == reader["id"] and follow["parent_id"] is None
    assert "Created the draft in ar_report" in follow["detail"] and "Add the final chart" in follow["detail"]
    assert follow["binding"]["continued_from"] == original["id"]
    assert "Add the final chart and verify it" in follow["detail"]
    assert client.post(f"/api/agent/goals/{follow_id}/claim", headers=agent_headers(reader)).status_code == 200
    result = client.post(f"/api/agent/goals/{follow_id}/result", headers=agent_headers(reader),
                         json={"status": "done", "result": "Chart verified",
                               "data": {"binding_digest": follow["binding_digest"], "proposal": {"verified": True}}})
    assert result.status_code == 200 and result.json()["status"] == "done", result.text
    stored = client.get(f"/api/agent/goals/{original['id']}", headers=agent_headers(reader)).json()
    assert stored["status"] == "done" and stored["result"] == original["result"]
    assert stored["result_data"] == original["result_data"]


def test_minds_finish_a_continuation_with_their_own_done_command(client, mind):
    """A tester's mind continued a finished task, then finished the follow-up with hive-goal-done, the command it uses
    for any task, and the hive refused it for want of a binding echo. Once that passed, a mind left to claim the
    follow-up and read the source spent the turns its loop grants on reads. The continue reply now holds the work
    and the command that finishes it, so a mind's next turn can be its done."""
    swarm, reader, maker, invoke = mind
    assert DONE_COMMAND in SKILLS.read_text(encoding="utf-8")
    original = completed(client, swarm, maker, title="Release checklist", data={"next": "add a verification line"})
    created = invoke("goal_continue", original["id"], "Add the line: Verification: history recovery works")
    follow_id = re.search(r"g_[a-z0-9]+", created).group()
    for needed in ("is yours", "Verification: history recovery works", "Created the draft in ar_report", "add a verification line"):
        assert needed in created, created
    assert f"goal_done{'(' if 'continued as' in created else ' '}{follow_id}" in created.replace("-", "_"), created
    finished = invoke("goal_done", follow_id, "done", "Release checklist. Verification: history recovery works")
    assert "HIVE-ERROR" not in finished, finished
    follow = client.get(f"/api/agent/goals/{follow_id}", headers=agent_headers(reader)).json()
    assert follow["status"] == "done" and follow["result"].endswith("Verification: history recovery works")
    assert follow["binding"]["continued_from"] == original["id"] and follow["parent_id"] is None
    stored = client.get(f"/api/agent/goals/{original['id']}", headers=agent_headers(reader)).json()
    assert stored["status"] == "done" and stored["result"] == original["result"]
    inbox = client.get("/api/agent/inbox", headers=agent_headers(maker)).json()["messages"]
    assert not any(follow_id in message["text"] for message in inbox)   # the follow-up was announced to no one


def test_a_follow_up_carries_the_source_cut_to_fit(client):
    swarm = client.post("/api/swarms", json={"name": "Long work"}).json()
    agent = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": swarm["id"]}).json()
    source = completed(client, swarm, agent, title="Long report", detail="step " * 900, data={"body": "x" * 5000})
    instruction = ("Shorten it " * 200).strip()
    follow = client.post(f"/api/agent/goals/{source['id']}/continue", headers=agent_headers(agent),
                         json={"instruction": instruction}).json()
    detail = follow["detail"]
    assert len(detail) <= MAX_DETAIL_CHARS and detail.startswith("New instruction:\n" + instruction + "\n")
    assert detail.count(f"hive-goal-output {source['id']} 0 reads all of it") == 2
    result = detail.split("Its result:\n")[1].split("\nIts instructions:\n")[0]
    assert result.startswith("Created the draft in ar_report") and len(result) > len(detail.split("Its instructions:\n")[1])


def test_a_reviewed_follow_up_says_it_waits_for_its_reviewer(client, mind):
    swarm, reader, maker, invoke = mind
    source = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Reviewed draft", "binding": {"review": "person"}}).json()
    client.app.state.hive.db.execute("UPDATE goals SET status = 'done', result = 'Draft accepted' WHERE id = ?", (source["id"],))
    follow_id = re.search(r"g_[a-z0-9]+", invoke("goal_continue", source["id"], "Revise the draft")).group()
    assert "HIVE-ERROR" not in invoke("goal_claim", follow_id)
    finished = invoke("goal_done", follow_id, "done", "Revised draft")
    assert "submitted" in finished.lower() and "HIVE-ERROR" not in finished, finished
    stored = client.get(f"/api/agent/goals/{follow_id}", headers=agent_headers(reader)).json()
    assert stored["status"] == "submitted" and stored["review_by"] == "person"


def test_a_bound_tasks_refusal_names_the_command_that_finishes_it(client, mind):
    swarm, reader, maker, invoke = mind
    bound = client.post(f"/api/swarms/{swarm['id']}/goals",
                        json={"title": "Answer a request", "binding": {"request_id": "rq_demo", "base_revision": 1}}).json()
    assert "HIVE-ERROR" not in invoke("goal_claim", bound["id"])
    refused = invoke("goal_done", bound["id"], "done", "Answered")
    assert "binding_mismatch" in refused and "hive-goal-propose" in refused, refused
    assert "HIVE-ERROR" not in invoke("goal_propose", bound["id"], "Answered")
    assert client.get(f"/api/agent/goals/{bound['id']}", headers=agent_headers(reader)).json()["status"] == "done"


def test_a_follow_up_needs_no_digest_but_a_sent_one_must_match(c):
    sw = mcp_swarm(c, "Team")
    code = member(c, sw, "Claude")
    follow = c.post(f"/api/swarms/{sw['id']}/goals", headers=c.admin,
                    json={"title": "follow-up", "binding": {"continued_from": "g_source", "review": "none"}}).json()
    call(c, code, "hive_goal_claim", {"goal_id": follow["id"]})
    done = {"goal_id": follow["id"], "status": "done", "result": "finished"}
    _, err = call(c, code, "hive_goal_result", {**done, "binding_digest": "sha256:" + HEX})
    assert err["code"] == "binding_mismatch"
    out, err = call(c, code, "hive_goal_result", done)
    assert err is None and out["status"] == "done"
    # continued_from beside a request's key is no follow-up continue_goal made: the digest is still required
    other = c.post(f"/api/swarms/{sw['id']}/goals", headers=c.admin,
                   json={"title": "bound", "binding": {"continued_from": "g_source", "request_id": "rq_demo"}}).json()
    call(c, code, "hive_goal_claim", {"goal_id": other["id"]})
    _, err = call(c, code, "hive_goal_result", {"goal_id": other["id"], "status": "done", "result": "x"})
    assert err["code"] == "binding_mismatch"


def test_history_search_is_literal_paged_and_scoped(client, mind):
    swarm, reader, maker, invoke = mind
    goals = [completed(client, swarm, maker, title=f"Report {i}") for i in range(5)]
    special = completed(client, swarm, maker, title="Report 100%_ready", data={"note": "Needle MixedCase café Straße"})
    foreign = client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    outsider = client.post("/api/agents", json={"name": "Other", "kind": "module", "swarm_id": foreign["id"]}).json()
    hidden = completed(client, foreign, outsider, title="Private report")
    headers = agent_headers(reader)
    first = client.get("/api/agent/goals/history", headers=headers).json()
    assert len(first["goals"]) == 3 and first["goals"][0]["id"] == special["id"]
    seen = {goal["id"] for goal in first["goals"]}
    next_page = client.get("/api/agent/goals/history", params={"offset": first["next_offset"]}, headers=headers).json()
    assert seen.isdisjoint(goal["id"] for goal in next_page["goals"])
    seen.update(goal["id"] for goal in next_page["goals"])
    assert seen == {special["id"], *(goal["id"] for goal in goals)} and next_page["next_offset"] is None
    assert hidden["id"] not in invoke("goal_history", "", 0)
    assert "HIVE-ERROR" not in invoke("goal_history", "", 0.0)
    for query in ("100%_ready", "needle mixedcase", "CAFÉ", "strasse"):
        found = client.get("/api/agent/goals/history", params={"q": query}, headers=headers).json()
        assert [goal["id"] for goal in found["goals"]] == [special["id"]]
    assert "none" in invoke("goal_history", "unrecorded artifact", 0).lower()
    assert client.get("/api/agent/goals/history?offset=-1", headers=headers).status_code == 400
    assert client.post(f"/api/agent/goals/{hidden['id']}/continue", headers=headers,
                       json={"instruction": "Finish it"}).status_code == 403
    assert client.post(f"/api/agent/goals/{special['id']}/continue", headers=headers,
                       json={"instruction": " "}).status_code == 400


def test_an_ask_threads_bookkeeping_goal_is_never_listed_as_completed_work(client, mind):
    swarm, reader, maker, invoke = mind
    work = completed(client, swarm, maker, title="Weekly report")
    hive = client.app.state.hive
    thread = hive.goals._create_record(swarm["id"], "Ask thread", "", created_by="user:operator",
                                       binding={"kind": "ask.thread"})
    hive.db.execute("UPDATE goals SET status = 'done', result = 'answered' WHERE id = ?", (thread["id"],))
    listed = client.get("/api/agent/goals/history", headers=agent_headers(reader)).json()
    assert [goal["id"] for goal in listed["goals"]] == [work["id"]]


def test_continuation_preserves_result_schema_and_review(client):
    swarm = client.post("/api/swarms", json={"name": "Reviewed"}).json()
    agent = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": swarm["id"]}).json()
    schema = {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}}
    original = client.post(f"/api/swarms/{swarm['id']}/goals",
                           json={"title": "A checked report", "binding": {"result_schema": schema, "review": "person"}}).json()
    headers = agent_headers(agent)
    assert client.post(f"/api/agent/goals/{original['id']}/claim", headers=headers).status_code == 200
    response = client.post(f"/api/agent/goals/{original['id']}/result", headers=headers,
                           json={"status": "done", "result": "Checked", "data": {
                               "binding_digest": original["binding_digest"], "proposal": {"answer": "Draft"}}})
    assert response.status_code == 200 and response.json()["status"] == "submitted", response.text
    reviewer = person(client, "u_reviewer", "admin")
    assert client.post(f"/api/goals/{original['id']}/review", headers=reviewer, json={"decision": "accept"}).status_code == 200
    follow = client.post(f"/api/agent/goals/{original['id']}/continue", headers=headers,
                         json={"instruction": "Complete the draft"})
    assert follow.status_code == 200, follow.text
    follow = follow.json()
    assert follow["binding"]["result_schema"] == schema and follow["review_by"] == "person"
    assert set(follow["binding"]) <= CONTINUATION_KEYS
    assert client.post(f"/api/agent/goals/{follow['id']}/claim", headers=headers).status_code == 200
    plain = client.post(f"/api/agent/goals/{follow['id']}/result", headers=headers, json={"status": "done", "result": "Done"})
    assert plain.status_code == 422 and "hive-goal-propose" in plain.json()["error"]["message"], plain.text
    forged = client.post(f"/api/agent/goals/{follow['id']}/result", headers=headers,
                         json={"status": "done", "result": "Finished", "data": {
                             "binding_digest": "sha256:" + "0" * 64, "proposal": {"answer": "Finished"}}})
    assert forged.status_code == 409 and forged.json()["error"]["code"] == "binding_mismatch", forged.text
    wrong = client.post(f"/api/agent/goals/{follow['id']}/result", headers=headers,
                        json={"status": "done", "result": "Wrong", "data": {
                            "binding_digest": follow["binding_digest"], "proposal": {}}})
    assert wrong.status_code == 422
    valid = client.post(f"/api/agent/goals/{follow['id']}/result", headers=headers,
                        json={"status": "done", "result": "Finished", "data": {
                            "binding_digest": follow["binding_digest"], "proposal": {"answer": "Finished"}}})
    assert valid.status_code == 200 and valid.json()["status"] == "submitted", valid.text


def test_a_plain_done_on_a_follow_up_still_meets_its_inherited_checks(client):
    swarm = client.post("/api/swarms", json={"name": "Checked"}).json()
    agent = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": swarm["id"]}).json()
    source = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "An app's task"}).json()
    # A finished task an app's validator checks; the follow-up inherits the validator, which no app here can satisfy.
    client.app.state.hive.db.execute("UPDATE goals SET status = 'done', result = 'First pass', binding = ? WHERE id = ?",
                                     (json.dumps({"validate": "program:demo"}), source["id"]))
    headers = agent_headers(agent)
    follow = client.post(f"/api/agent/goals/{source['id']}/continue", headers=headers,
                         json={"instruction": "Second pass"}).json()
    assert set(follow["binding"]) <= CONTINUATION_KEYS and follow["binding"]["validate"] == "program:demo"
    assert client.post(f"/api/agent/goals/{follow['id']}/claim", headers=headers).status_code == 200
    plain = client.post(f"/api/agent/goals/{follow['id']}/result", headers=headers, json={"status": "done", "result": "Second pass"})
    assert plain.status_code == 422 and "program:demo" in plain.json()["error"]["message"], plain.text
    assert client.get(f"/api/agent/goals/{follow['id']}", headers=headers).json()["status"] == "claimed"


def test_personal_work_is_not_visible_to_a_swarm_member(client, mind):
    swarm, reader, maker, invoke = mind
    hive = client.app.state.hive
    personal = client.post("/api/swarms", json={"name": "Personal work"}).json()
    owner = client.post("/api/agents", json={"name": "Private mind", "kind": "module", "swarm_id": personal["id"]}).json()
    hive.db.execute("UPDATE swarms SET personal_of = ?, visibility = 'private' WHERE id = ?", ("user:private-person", personal["id"]))
    hive.db.execute("UPDATE agents SET personal_of = ?, visibility = 'private' WHERE id = ?", ("user:private-person", owner["id"]))
    hidden = completed(client, personal, owner, title="Private journal", data={"artifact_id": "ar_private"})
    assert hidden["id"] not in invoke("goals")
    assert hidden["id"] not in invoke("goal_history", "ar_private", 0)
    assert "forbidden" in invoke("goal_get", hidden["id"])
    assert "forbidden" in invoke("goal_continue", hidden["id"], "Continue it")
    assert "forbidden" in invoke("goal_output", hidden["id"], 0)


def test_history_uses_current_read_fences_before_pagination(client, mind):
    swarm, reader, maker, invoke = mind
    hive = client.app.state.hive
    visible = completed(client, swarm, maker, title="Accessible work")
    hidden = [completed(client, swarm, maker, title=f"Private research {i}") for i in range(4)]
    for number, goal in enumerate(hidden):
        hive.db.execute("UPDATE goals SET binding = ? WHERE id = ?", (json.dumps({"kind": "research"}), goal["id"]))
        hive.db.insert("research_reports", {"request_id": f"rq_private_{number}", "goal_id": goal["id"],
                                           "principal": "user:private-person", "swarm_id": swarm["id"],
                                           "title": "Private research", "state": "done", "child_id": maker["id"],
                                           "created_at": goal["created_at"]})
    page = client.get("/api/agent/goals/history", headers=agent_headers(reader)).json()
    assert [goal["id"] for goal in page["goals"]] == [visible["id"]] and page["next_offset"] is None
    for goal in hidden:
        assert goal["id"] not in invoke("goal_history", "", 0)
        assert "not_assigned" in invoke("goal_get", goal["id"])
        assert "not_assigned" in invoke("goal_continue", goal["id"], "Continue it")
        assert "not_assigned" in invoke("goal_output", goal["id"], 0)


def test_continuation_needs_done_work_and_an_open_swarm(client, mind):
    swarm, reader, maker, invoke = mind
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Unfinished"}).json()
    assert "not_done" in invoke("goal_continue", goal["id"], "Continue it")
    done = completed(client, swarm, maker)
    hive = client.app.state.hive
    hive.db.execute("UPDATE swarms SET archived_at = ? WHERE id = ?", ("2026-11-12T00:00:00Z", swarm["id"]))
    assert "swarm_archived" in invoke("goal_continue", done["id"], "Continue it")


def test_large_output_remains_readable_without_losing_unicode(client, mind):
    swarm, reader, maker, invoke = mind
    data = {"text": "a" * 8500 + " café; tail marker", "artifact_id": "ar_large"}
    done = completed(client, swarm, maker, detail="instruction " * 330, data=data)
    detail = invoke("goal_get", done["id"])
    assert f"goal_output {done['id']} 0 reads" in detail.replace("-", "_") and len(detail) <= 5000
    assert "detail cut at" in detail
    whole = invoke("goal_get", completed(client, swarm, maker, title="Short report")["id"])
    assert "Created the draft" in whole and "goal_output" not in whole.replace("-", "_")   # nothing left to page
    offset, text, final_offset = 0, "", 0
    while offset is not None:
        final_offset = offset
        page = client.get(f"/api/agent/goals/{done['id']}/output", params={"offset": offset}, headers=agent_headers(reader)).json()
        assert len(page["text"]) <= 3000
        text += page["text"]
        offset = page["next_offset"]
    assert json.loads(text)["result_data"] == data
    assert json.loads(text)["detail"] == "instruction " * 330
    output = invoke("goal_output", done["id"], final_offset)
    assert "tail marker" in output and len(output) <= 5000 and "next_offset=None" in output


def test_studio_artifact_lookup_uses_its_recorded_goal_only(client, mind):
    swarm, reader, maker, invoke = mind
    goal = completed(client, swarm, maker)
    unrelated = completed(client, swarm, maker, title="An unrelated task by the same author")
    artifact = client.post("/api/agent/artifacts", headers=agent_headers(maker),
                           json={"title": "Saved report", "kind": "studio-source"}).json()
    hive = client.app.state.hive
    hive.db.insert("studio_sessions", {
        "id": "ss_history", "intent_id": "intent-history", "principal": "user:owner", "ask_turn_id": "turn-history",
        "swarm_id": swarm["id"], "program_id": "demo", "app_pin": "{}", "maker_id": maker["id"],
        "goal_id": goal["id"], "proposal_artifact_id": "ar_proposal", "piece": "{}", "stream_id": "stream-history",
        "source_artifact_id": artifact["id"], "payer": "user:owner", "own_key": 0, "key_id": "demo-key",
        "model": "mock/echo", "tools": "[]", "cap_usd": 0, "step_cap_usd": 0, "step_window_s": 60,
        "max_steps": 1, "expires_at": "2026-11-12T00:00:00Z", "consent_digest": "demo-consent", "state": "stopped",
        "created_at": "2026-11-11T00:00:00Z", "updated_at": "2026-11-12T00:00:00Z"})
    found = invoke("goal_history", artifact["id"], 0)
    assert goal["id"] in found and unrelated["id"] not in found


def test_requester_review_continues_without_replaying_the_request(client):
    from hive.tests.test_review_gate import _request, propose

    original, requester, maker, digest = _request(client)
    assert propose(client, maker, original, digest, {"draft": 1}).json()["status"] == "submitted"
    assert client.post(f"/api/agent/goals/{original}/review", headers=agent_headers(requester),
                       json={"decision": "accept"}).status_code == 200
    hive = client.app.state.hive
    source = hive.goals.for_agent(maker, original)
    request_id = source["binding"]["request_id"]
    before = hive.db.one("SELECT * FROM requests WHERE id = ?", (request_id,))
    follow = client.post(f"/api/agent/goals/{original}/continue", headers=agent_headers(maker),
                         json={"instruction": "Expand the draft"}).json()
    assert follow["binding"]["continued_from"] == original and "request_id" not in follow["binding"]
    assert set(follow["binding"]) <= CONTINUATION_KEYS
    assert client.post(f"/api/agent/goals/{follow['id']}/claim", headers=agent_headers(maker)).status_code == 200
    assert propose(client, maker, follow["id"], follow["binding_digest"], {"draft": 2}).json()["status"] == "submitted"
    assert client.get(f"/api/agent/goals/{follow['id']}", headers=agent_headers(requester)).status_code == 200
    assert client.post(f"/api/agent/goals/{follow['id']}/review", headers=agent_headers(requester),
                       json={"decision": "accept"}).status_code == 200
    inbox = client.get("/api/agent/inbox", headers=agent_headers(requester)).json()["messages"]
    assert any("REVIEW-WAITING " + follow["id"] in message["text"] for message in inbox)
    assert hive.db.one("SELECT * FROM requests WHERE id = ?", (request_id,)) == before
