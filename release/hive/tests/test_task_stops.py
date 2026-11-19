# Purpose: verify durable person-scoped stop receipts and atomic task creation from Ask.
import pytest

from hive.core.goals import MAX_ATTEMPTS, MAX_RETURNS, STOP_CAUSES
from hive.core.hive import HiveError
from hive.tests.test_ask import ask, world
from hive.tests.test_ask_conductor import Script, _answers, call, on, script  # noqa: F401
from hive.tests.test_core_api import agent_headers, client  # noqa: F401
from hive.tests.test_mind_fitness_iter import through, tool
from hive.tests.test_personal_mind_ask import _on


@pytest.fixture(autouse=True)
def _intent_origin(client):
    client.headers["Origin"] = "http://127.0.0.1:8700"


def task(client, w, **extra):
    r = client.post(f"/api/swarms/{w['swarm']['id']}/goals", headers=w["ann"],
                    json={"title": "Find the observatory hours", "detail": "Use its published opening hours.",
                          "assignee": w["coord"]["id"], **extra})
    assert r.status_code == 200, r.text
    return r.json()


def stops(client, who):
    r = client.get("/api/me/task-stops", headers=who)
    assert r.status_code == 200, r.text
    return r.json()["stops"]


@pytest.mark.parametrize("how,cause", [("mind", "failed"), ("admin", "marked_failed"), ("stall", "marked_stalled"),
                                        ("deadline", "deadline"), ("leases", "leases"), ("review", "review")])
def test_every_stop_path_keeps_one_receipt_until_its_person_acknowledges(client, how, cause):
    w = world(client)
    hive = w["hive"]
    goal = task(client, w, **({"binding": {"review": "person"}} if how == "review" else {}))
    gid = goal["id"]
    ah = agent_headers(w["coord"])
    if how in ("mind", "leases", "review"):
        assert client.post(f"/api/agent/goals/{gid}/claim", headers=ah).status_code == 200
    if how == "mind":
        body = {"status": "failed", "result": "The observatory has not published its opening hours."}
        assert client.post(f"/api/agent/goals/{gid}/result", headers=ah, json=body).status_code == 200
        assert client.post(f"/api/agent/goals/{gid}/result", headers=ah, json=body).status_code == 200
    elif how in ("admin", "stall"):
        for _ in range(2):
            assert client.patch(f"/api/goals/{gid}", headers=w["jon"],
                                json={"status": "stalled" if how == "stall" else "failed"}).status_code == 200
    elif how == "review":
        for _ in range(MAX_RETURNS):
            assert client.post(f"/api/agent/goals/{gid}/result", headers=ah,
                               json={"status": "done", "result": "The hours.",
                                     "data": {"binding_digest": goal["binding_digest"]}}).status_code == 200
            assert client.post(f"/api/goals/{gid}/review", headers=w["jon"],
                               json={"decision": "return", "notes": "The source is missing."}).status_code == 200
    else:
        if how == "deadline":
            hive.db.update("goals", gid, {"deadline_at": "2000-01-01T00:00:00Z"})
        else:
            hive.db.update("goals", gid, {"attempts": MAX_ATTEMPTS, "lease_until": "2000-01-01T00:00:00Z"})
        client.portal.call(hive.goals.expire)
        client.portal.call(hive.goals.expire)
    receipt, = stops(client, w["ann"])
    assert receipt["goal_id"] == gid and receipt["mind_id"] == w["coord"]["id"]
    assert receipt["title"] == goal["title"] and STOP_CAUSES[cause] in receipt["reason"]
    if how in ("deadline", "leases"):
        assert hive.goals.get(gid)["result"] == STOP_CAUSES[cause]
    if how == "mind":
        assert "has not published" in receipt["reason"]
    assert stops(client, w["bob"]) == [] and stops(client, w["jon"]) == []
    path = f"/api/me/task-stops/{receipt['id']}/acknowledge"
    for who in (w["bob"], w["jon"]):
        foreign = client.post(path, headers=who)
        missing = client.post("/api/me/task-stops/missing/acknowledge", headers=who)
        assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()
    assert client.patch(f"/api/goals/{gid}", headers=w["jon"], json={"status": "open"}).status_code == 200
    assert stops(client, w["ann"]) == [receipt]
    for _ in range(2):
        assert client.post(path, headers=w["ann"]).status_code == 200
    assert stops(client, w["ann"]) == []


def test_a_stop_receipt_rolls_back_with_the_transition(client, monkeypatch):
    w = world(client)
    goal = task(client, w)
    def refuse(*args, **kwargs):
        raise RuntimeError("receipt storage refused")
    monkeypatch.setattr(w["hive"].goals, "record_stop", refuse)
    with pytest.raises(RuntimeError, match="receipt storage refused"):
        w["hive"].goals.update(goal["id"], {"status": "failed"})
    assert w["hive"].goals.get(goal["id"])["status"] == "open"


def test_ask_dispatch_sends_one_assigned_task_at_once_and_replays_its_receipt(client, on):
    hive = on["hive"]
    script(client, Script([call("dispatch", kind="task.create",
                               request={"title": "Observatory hours", "instruction": "Find the published opening hours."})],
                          "The task was created."))
    response = ask(client, on["ann"], "op-task-create-1", context=on["ctx"])
    assert response.status_code == 202
    frames, _ = _answers(hive, "op-task-create-1")
    assert any(f["phase"] == "dispatched" and f["intent_kind"] == "task.create" for f in frames)
    intent = hive.db.one("SELECT * FROM ask_intents WHERE kind = 'task.create'")
    assert intent["state"] == "linked"
    goal = hive.goals.get(intent["receiving_goal"])
    assert goal["assignee"] == on["coord"]["id"] and goal["created_by"] == "user:u_ann"
    assert goal["detail"] == "Find the published opening hours."
    path = f"/api/ask/intents/{intent['id']}/submit"
    first = client.post(path, headers=on["ann"], json={})
    second = client.post(path, headers=on["ann"], json={})
    assert first.status_code == second.status_code == 201 and first.content == second.content
    assert hive.db.one("SELECT COUNT(*) AS n FROM goals WHERE title = 'Observatory hours'")["n"] == 1


def test_task_admission_rolls_back_when_the_intent_cannot_link(client, monkeypatch):
    w = world(client)
    asked = ask(client, w["ann"], "op-task-rollback", context={"swarm_id": w["swarm"]["id"]})
    assert asked.status_code == 202
    intent = client.post("/api/ask/op-task-rollback/intents", headers=w["ann"],
                         json={"kind": "task.create", "request": {"title": "Hours", "instruction": "Read the website."}})
    assert intent.status_code == 201, intent.text
    iid = intent.json()["intent_id"]
    def refuse(*args, **kwargs):
        raise HiveError(409, "operation_conflict", "The receipt changed.")
    monkeypatch.setattr(w["hive"].ask.intents, "_link", refuse)
    r = client.post(f"/api/ask/intents/{iid}/submit", headers=w["ann"], json={})
    assert r.status_code == 409
    assert w["hive"].db.one("SELECT id FROM goals WHERE title = 'Hours'") is None
    assert w["hive"].db.one("SELECT operation_id FROM mind_operations WHERE operation_id = ?", ("ask." + iid,)) is None


def test_a_mind_still_creates_work_with_its_goal_create_tool_while_an_ask_is_open(client):
    w = world(client)
    assert ask(client, w["ann"], "op-skill-create-1", context={"swarm_id": w["swarm"]["id"]}).status_code == 202
    made = through(client, w["coord"], tool("hive_goal_create")).run("none", "Check the telescope", "Read its maintenance log.")
    assert made.startswith("created g_"), made
    gid = made.split()[1].rstrip(":")
    goal = w["hive"].goals.get(gid)
    assert goal["created_by"] == f"agent:{w['coord']['id']}" and goal["detail"] == "Read its maintenance log."
    assert client.post(f"/api/agent/goals/{gid}/claim", headers=agent_headers(w["coord"])).status_code == 200


@pytest.mark.parametrize("payload", [{}, {"title": "Hours", "instruction": "Read", "swarm_id": "other"},
                                      {"title": " ", "instruction": "Read"}, {"title": "Hours", "instruction": 5}])
def test_task_dispatch_refuses_fields_that_could_choose_authority_or_omit_the_work(client, payload):
    w = world(client)
    assert ask(client, w["ann"], "op-task-fields-1", context={"swarm_id": w["swarm"]["id"]}).status_code == 202
    r = client.post("/api/ask/op-task-fields-1/intents", headers=w["ann"], json={"kind": "task.create", "request": payload})
    assert r.status_code == 400
    assert w["hive"].db.one("SELECT COUNT(*) AS n FROM ask_intents")["n"] == 0


@pytest.mark.parametrize("through_swarm", [False, True])
def test_task_goes_to_the_speaking_mind_and_a_personal_thread_keeps_no_request_words(client, monkeypatch, through_swarm):
    w = _on(client, monkeypatch)
    if through_swarm:
        w["hive"].db.update("agents", w["coord"]["id"], {"budget_usd": 1.0})
    secret = "Private telescope plans that must not become a thread title"
    script(client, Script([call("dispatch", kind="task.create",
                               request={"title": "Telescope care", "instruction": "Find the published maintenance manual."})],
                          "The task was created."))
    response = ask(client, w["ann"], "op-task-personal", text=secret,
                   **({"context": {"swarm_id": w["swarm"]["id"]}} if through_swarm else {}))
    assert response.status_code == 202
    frames, _ = _answers(w["hive"], "op-task-personal")
    session = w["hive"].db.one("SELECT * FROM work_sessions WHERE id = ?", (response.json()["thread"]["id"],))
    if not through_swarm:
        assert session["title"] == f"Ask with {w['mine']['name']}"
        assert secret not in str(w["hive"].goals.get(session["goal_id"]))
    intent = w["hive"].db.one("SELECT * FROM ask_intents WHERE kind = 'task.create'")
    assert intent is not None, frames
    assert intent["state"] == "linked"
    assert w["hive"].goals.get(intent["receiving_goal"])["assignee"] == w["mine"]["id"]


def test_an_old_failed_ask_bookkeeping_task_is_repaired_on_startup(client):
    from hive.core.ask import Ask
    from hive.core.sessions import Sessions
    w = world(client)
    response = ask(client, w["ann"], "op-legacy-thread", text="Find telescope instructions", context={"swarm_id": w["swarm"]["id"]})
    session = w["hive"].db.one("SELECT * FROM work_sessions WHERE id = ?", (response.json()["thread"]["id"],))
    w["hive"].db.update("work_sessions", session["id"], {"title": "Ask thread"})
    w["hive"].db.update("goals", session["goal_id"], {"title": "Ask thread", "binding": None,
                       "status": "failed", "assignee": w["coord"]["id"], "claimed_by": w["coord"]["id"]})
    Sessions(w["hive"])
    Ask(w["hive"])
    repaired = w["hive"].goals.get(session["goal_id"])
    assert repaired["title"] == "Find telescope instructions" and repaired["status"] == "open"
    assert repaired["assignee"] is None and repaired["claimed_by"] is None
    assert w["hive"].goals.list(w["swarm"]["id"]) == []


def test_a_later_stop_gets_a_new_receipt_even_in_the_same_clock_tick(client, monkeypatch):
    from hive.core import goals
    w = world(client)
    goal = task(client, w)
    monkeypatch.setattr(goals, "now", lambda: "2026-11-17T06:00:00.000Z")
    for _ in range(2):
        w["hive"].goals.update(goal["id"], {"status": "failed"})
        w["hive"].goals.update(goal["id"], {"status": "open"})
    receipts = stops(client, w["ann"])
    assert len(receipts) == 2 and receipts[0]["id"] != receipts[1]["id"]


def test_research_start_failure_is_a_durable_person_receipt(client, on, monkeypatch):
    from hive.tests.test_research_request import dispatch_research
    async def refuse(*args, **kwargs):
        raise HiveError(403, "spawn_disabled", "off")
    monkeypatch.setattr(on["hive"].minds, "spawn", refuse)
    dispatch_research(client, on)
    receipt, = stops(client, on["ann"])
    assert receipt["reason"] == STOP_CAUSES["research_start"]
    assert on["hive"].goals.get(receipt["goal_id"])["result"] == STOP_CAUSES["research_start"]
    assert stops(client, on["bob"]) == []


def test_task_admission_rechecks_the_persons_access_to_the_answering_mind(client):
    w = world(client)
    assert ask(client, w["ann"], "op-task-access-1", context={"swarm_id": w["swarm"]["id"]}).status_code == 202
    recorded = client.post("/api/ask/op-task-access-1/intents", headers=w["ann"],
                           json={"kind": "task.create", "request": {"title": "Hours", "instruction": "Read the website."}})
    assert recorded.status_code == 201
    w["hive"].db.update("swarms", w["swarm"]["id"], {"shared_with": "[]", "visibility": "private"})
    sent = client.post(f"/api/ask/intents/{recorded.json()['intent_id']}/submit", headers=w["ann"], json={})
    assert sent.status_code == 404
    assert w["hive"].db.one("SELECT id FROM goals WHERE title = 'Hours'") is None


def test_a_mind_must_say_why_it_could_not_finish(client):
    w = world(client)
    goal = task(client, w)
    headers = agent_headers(w["coord"])
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=headers).status_code == 200
    r = client.post(f"/api/agent/goals/{goal['id']}/result", headers=headers, json={"status": "failed", "result": " "})
    assert r.status_code == 400
    assert stops(client, w["ann"]) == [] and w["hive"].goals.get(goal["id"])["status"] == "claimed"


def test_a_mind_that_stops_after_refused_replies_ends_what_it_holds_and_says_why(client, monkeypatch):
    """A mind whose runtime rested after four refused replies in a row kept its claimed task under a lease its live loop
    renews, so the task read as in progress with nothing said (a v0.38 Make plan showed "writing tests" for seven
    minutes). Its trace now says it rested and why, and every task it holds and is working on fails with that reason,
    which goal_ended passes on as goal_reason; a task waiting on its person, another mind's task and an ordinary trace
    change nothing."""
    import pathlib
    import sys
    from hive.core.code_controller_engine import goal_ended
    src = pathlib.Path(__file__).resolve().parents[2] / "modules" / "hive" / "src"
    sys.path.insert(0, str(src))
    try:
        import hive_commons
    finally:
        sys.path.remove(str(src))
    sent = []
    monkeypatch.setattr(hive_commons, "_call", lambda method, path, payload=None, **kw: sent.append((path, payload)))
    w = world(client)
    hive, ah = w["hive"], agent_headers(w["coord"])
    held, waiting = task(client, w), task(client, w)
    theirs = task(client, w, assignee=w["worker"]["id"])
    for goal, headers in ((held, ah), (waiting, ah), (theirs, agent_headers(w["worker"]))):
        assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=headers).status_code == 200
    hive.db.update("goals", waiting["id"], {"status": "waiting"})          # delivered, waiting on its person
    for rested, cause in ((False, ""), (True, "a reply cut off at its length limit")):
        # what the runtime's hive-report-trace hook sends (rests_after's verdict, last_failure_cause's words)
        assert hive_commons.trace(7, "", "", "[]", rested, cause) == "HIVE-TRACED"
        path, payload = sent[-1]
        assert path == "/api/agent/trace" and (payload["rested"], payload["failure_cause"]) == (rested, cause)
        assert client.post(path, headers=ah, json=payload).status_code == 200
        if not rested:
            assert hive.goals.get(held["id"])["status"] == "claimed" and stops(client, w["ann"]) == []
    why = "Its replies kept being refused; the last was a reply cut off at its length limit."
    assert (hive.goals.get(held["id"])["status"], hive.goals.get(held["id"])["result"]) == ("failed", why)
    assert goal_ended(hive.goals.get(held["id"])) == {"goal_status": "failed", "goal_reason": why}
    assert hive.goals.get(waiting["id"])["status"] == "waiting" and hive.goals.get(theirs["id"])["status"] == "claimed"
    receipt, = stops(client, w["ann"])
    assert (receipt["goal_id"], receipt["reason"]) == (held["id"], f"{STOP_CAUSES['replies']} {why}")


def test_deleting_a_thread_erases_request_words_from_its_bookkeeping_titles(client):
    w = world(client)
    secret = "Private telescope plans to erase"
    asked = ask(client, w["ann"], "op-delete-titles", text=secret, context={"swarm_id": w["swarm"]["id"]}).json()
    thread = w["hive"].db.one("SELECT * FROM work_sessions WHERE id = ?", (asked["thread"]["id"],))
    assert w["hive"].goals.get(thread["goal_id"])["title"] == secret
    path = f"/api/ask/threads/{thread['id']}"
    deleted = client.delete(path, headers=w["ann"])
    assert deleted.status_code == 200, deleted.text
    rows = [w["hive"].goals.get(thread["goal_id"]),
            w["hive"].db.one("SELECT * FROM work_sessions WHERE id = ?", (thread["id"],)),
            w["hive"].db.one("SELECT * FROM rooms WHERE id = ?", (thread["room_id"],))]
    assert all(secret not in str(row) for row in rows)
