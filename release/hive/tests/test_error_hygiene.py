"""Errors minds hit that are not real refusals: parse errors reach the mind; re-claiming your own goal renews it."""
from hive.core.policy import _only_text_arguments


def test_text_only_syntax_errors_pass_and_nothing_else_does():
    assert _only_text_arguments('(syntax-error "code-open" "missing repository; card: code-open g_id repo")')
    assert _only_text_arguments('(syntax-error "x" "a \\"quoted\\" word")')
    assert not _only_text_arguments('(syntax-error "x" (shell "rm -rf /"))')
    assert not _only_text_arguments('(syntax-error "x") (shell "ls")')
    assert not _only_text_arguments('(syntax-error "x" "y" unquoted)')
    assert not _only_text_arguments('(shell "syntax-error")')


from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: E402,F401  (fixture)


def test_a_deny_all_mind_still_hears_its_own_parse_error_but_nothing_else(client):
    _, (a, _) = make_swarm_and_agents(client)
    client.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "*", "mode": "deny"})
    ask = lambda c: client.post("/api/agent/authorize", headers=agent_headers(a), json={"command": c}).json()["decision"]
    assert ask('(syntax-error "code-open" "missing repository")') == "allow"
    assert ask('(syntax-error "x" (send "smuggled"))') == "deny"
    assert ask('(send "hi")') == "deny"


def test_reclaiming_a_goal_you_hold_renews_it_and_others_still_cannot(client):
    swarm, (a, b) = make_swarm_and_agents(client)
    goal = client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Fix it"}).json()
    first = client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a)).json()
    again = client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a))
    assert again.status_code == 200 and again.json()["claimed_by"] == a["id"] and again.json()["lease_until"] >= first["lease_until"]
    assert client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(b)).status_code == 409


def test_file_skills_stay_inside_the_minds_own_folder(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    folder = hive.settings.agents_dir / a["id"]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "notes.txt").write_text("mine")
    (folder / "escape").symlink_to(hive.settings.data_dir)
    ask = lambda c: client.post("/api/agent/authorize", headers=agent_headers(a), json={"command": c}).json()["decision"]
    assert ask('(read-file "notes.txt")') == "allow"
    assert ask(f'(read-file "{folder}/notes.txt")') == "allow"
    for bad in [f'(read-file "{hive.settings.data_dir}/admin-password")', '(read-file "../../hive.db")',
                '(read-file "escape/admin-password")', '(read-file "~/.ssh/id_rsa")', '(read-file "/etc/passwd")',
                '(read-file (string-append "/et" "c/passwd"))', '(read-file $p)', '(read-file)',
                f'(append-file "{hive.settings.data_dir}/x" "y")']:
        assert ask(bad) == "deny", bad
    assert ask('(write-file "out.txt" "x")') == "pending"   # inside the folder: still a person's call (ask)
