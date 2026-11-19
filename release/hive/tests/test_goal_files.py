"""Purpose: test hive-goal-file's route. A mind stages whole files on a goal it holds, one command each, for the goal's
answer to take beside its own files map; a path staged again keeps its last text; a goal it doesn't hold, a path that
isn't a plain relative one, a file over the result-data limit and one file too many are refused."""
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
