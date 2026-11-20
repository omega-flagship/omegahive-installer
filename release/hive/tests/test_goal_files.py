"""Purpose: test hive-goal-file's route. A mind stages whole files on a goal it holds, one command each, for the goal's
answer to take beside its own files map; a path staged again keeps its last text; a goal it doesn't hold, a path that
isn't a plain relative one, a file over the result-data limit and one file too many are refused; and the files go once
nothing will read them."""
from hive.core.goals import MAX_RESULT_DATA_BYTES, MAX_STAGED_FILES
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def _held(client):
    """A Create step's goal held by mind a; b is another mind of the same team."""
    hive = client.app.state.hive
    _, (a, b) = make_swarm_and_agents(client)
    hive.goals._create_record(a["swarm_id"], "Create plan pl_files: build board", "Write the piece's files", 0.6,
                              created_by="create-plan:pl_files", assignee=a["id"], goal_id="g_files")
    assert client.post("/api/agent/goals/g_files/claim", headers=agent_headers(a)).status_code == 200
    return hive, a, b


def _stage(client, mind, path, text):
    return client.post("/api/agent/goals/g_files/files", headers=agent_headers(mind), json={"path": path, "text": text})


def test_a_mind_stages_each_file_on_the_goal_it_holds_and_a_second_staging_replaces_the_first(client):
    hive, a, _ = _held(client)
    app = 'const s = "x(";\n/* """ */\n    indented();\n'
    r = _stage(client, a, "index.html", "<p>hi</p>")
    assert r.status_code == 200 and r.json() == {"goal_id": "g_files", "path": "index.html", "bytes": 9}
    assert _stage(client, a, "src/app.js", "old").status_code == 200
    assert _stage(client, a, "src/app.js", app).status_code == 200
    assert hive.goals.staged_files("g_files") == {"index.html": "<p>hi</p>", "src/app.js": app}


def test_a_goal_the_mind_doesnt_hold_and_a_path_that_isnt_plain_are_refused(client):
    hive, a, b = _held(client)
    assert _stage(client, b, "app.js", "x").status_code == 409
    for path in ("", "/etc/passwd", "../app.js", "src//app.js", "src\\app.js", "./app.js", "x" * 301):
        assert _stage(client, a, path, "x").status_code == 400, path
    assert hive.goals.staged_files("g_files") == {}


def test_a_file_over_the_result_data_limit_and_one_file_too_many_are_refused(client):
    hive, a, _ = _held(client)
    assert _stage(client, a, "big.js", "x" * (MAX_RESULT_DATA_BYTES + 1)).status_code == 413
    for n in range(MAX_STAGED_FILES):
        assert _stage(client, a, f"f{n}.js", str(n)).status_code == 200
    assert _stage(client, a, "one-more.js", "x").status_code == 409
    assert _stage(client, a, "f0.js", "again").status_code == 200        # a path it already staged still replaces
    assert len(hive.goals.staged_files("g_files")) == MAX_STAGED_FILES


def test_an_open_goal_assigned_to_the_mind_names_its_claim_wherever_an_action_is_refused(client):
    """On a tester's hive on 20 Nov a model heartbeated its open plan goal turn after turn, told only "you do not hold
    this task". A heartbeat, a staged file and an answer on a goal assigned to the mind and still open name the claim;
    another mind of the team is refused as before."""
    hive = client.app.state.hive
    _, (a, b) = make_swarm_and_agents(client)
    hive.goals._create_record(a["swarm_id"], "Create plan pl_open: plan", "Plan it", 0.6, created_by="create-plan:pl_open",
                              assignee=a["id"], goal_id="g_open")
    claim = "claim it with hive-goal-claim g_open, then finish it with hive-goal-propose g_open"
    for action, body in (("heartbeat", None), ("files", {"path": "app.js", "text": "x"}),
                         ("result", {"status": "done", "result": "{}"})):
        r = client.post(f"/api/agent/goals/g_open/{action}", headers=agent_headers(a), json=body)
        assert r.status_code == 409 and r.json()["error"]["code"] == "not_claimed", (action, r.json())
        assert claim in r.json()["error"]["message"], (action, r.json())
    r = client.post("/api/agent/goals/g_open/heartbeat", headers=agent_headers(b))
    assert r.status_code == 409 and r.json()["error"]["message"] == "you do not hold this task"
    assert hive.goals.get("g_open")["status"] == "open" and hive.goals.staged_files("g_open") == {}


def test_a_claims_files_go_when_the_goal_passes_to_another_mind_fails_or_is_cancelled(client):
    """Nothing deleted staged files, and a goal claimed again handed its new claimer's answer the old claim's files."""
    hive, a, b = _held(client)
    assert _stage(client, a, "a.js", "a's").status_code == 200
    with hive.db.transaction():
        assert hive.goals.release_rows(a["id"], "test", "a was deleted") == ["g_files"]
    assert hive.goals.staged_files("g_files") == {}
    assert client.post("/api/agent/goals/g_files/claim", headers=agent_headers(b)).status_code == 200
    assert _stage(client, b, "b.js", "b's").status_code == 200
    assert hive.goals.staged_files("g_files") == {"b.js": "b's"}
    hive.db.execute("UPDATE goals SET status = 'cancelled' WHERE id = 'g_files'")   # as a plan withdraws its step
    assert hive.goals.staged_files("g_files") == {}
    hive.goals._create_record(b["swarm_id"], "Create plan pl_files: test-author", "Write the check", 0.6,
                              created_by="create-plan:pl_files", assignee=b["id"], goal_id="g_check")
    hive.goals.claim(hive.agent(b["id"]), "g_check")
    hive.goals.stage_file(hive.agent(b["id"]), "g_check", "check.py", "x")
    hive.goals.stop("g_check", "failed", "deadline")
    assert hive.goals.staged_files("g_check") == {}


def test_a_create_steps_files_stay_through_done_until_its_plan_takes_them(client):
    """A Create plan reads a done step's staged files after it is done, so they stay until the plan has taken them
    (Goals.drop_staged); a done goal no plan reads the answer of keeps none."""
    hive, a, _ = _held(client)
    assert _stage(client, a, "a.js", "x").status_code == 200
    hive.db.execute("UPDATE goals SET status = 'done' WHERE id = 'g_files'")
    assert hive.goals.staged_files("g_files") == {"a.js": "x"}
    hive.goals.drop_staged("g_files")
    assert hive.goals.staged_files("g_files") == {}
    hive.goals._create_record(a["swarm_id"], "Tidy the notes", "A person's task", 0.5, created_by="user:u_jon",
                              assignee=a["id"], goal_id="g_task")
    hive.goals.claim(hive.agent(a["id"]), "g_task")
    hive.goals.stage_file(hive.agent(a["id"]), "g_task", "notes.md", "x")
    hive.db.execute("UPDATE goals SET status = 'done' WHERE id = 'g_task'")
    assert hive.goals.staged_files("g_task") == {}
