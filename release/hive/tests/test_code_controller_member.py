# Purpose: tests of Create plan members on the host engine: the assignee's files, the second opinion, refixes, the
# profile gate, the budget and delivery to the plan.
"""Create plan members (reducer R3.14, profile plan-member) on the host engine (hive/core/code_controller_member.py).
The reducer runs for real in PeTTa; the journal, effects, goals and the second opinion are the real ones. Only the
Code service is faked at the person relay (Code.proxy: the piece fork's workspace, files, patches and checkpoints) and
the plan's test port is a stand-in for the plan engine's acceptance check. No model, no Code process, no sandbox."""
import asyncio
import hashlib
import json

import pytest

from hive.core import code_controller_engine as cce
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import enabled, w  # noqa: F401  (fixture)
from hive.tests.test_result_schema import STORED_AS

FORK = "ws_" + "f0" * 16
CALCULATOR = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"


def run(coro):
    return asyncio.run(coro)


def hexsha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class FakeFork:
    """The piece fork at the person relay: workspace, files, guarded patches, checkpoints."""

    def __init__(self, files):
        self.files, self.generation, self.checkpoints, self.patches, self.calls = dict(files), 1, {}, [], []

    def tree(self):
        return hexsha(json.dumps(self.files, sort_keys=True))

    async def proxy(self, principal, method, path, query, body, task_id, grant_id, repository_id):
        self.calls.append((principal, method, path, task_id, grant_id))
        ok = lambda v, s=200: (s, json.dumps(v).encode(), "application/json")
        if path == f"/v1/workspaces/{FORK}" and method == "GET":
            return ok({"id": FORK, "generation": self.generation, "tree_digest": self.tree()})
        if path == f"/v1/workspaces/{FORK}/tree":
            return ok({"generation": self.generation, "files": [{"path": p} for p in sorted(self.files)]})
        if path == f"/v1/workspaces/{FORK}/files":
            name = query["path"]
            if name not in self.files:
                return ok({"error": "not_found"}, 404)
            return ok({"path": name, "content": self.files[name], "digest": hexsha(self.files[name]),
                       "generation": self.generation})
        data = json.loads(body) if body else {}
        if path == f"/v1/workspaces/{FORK}/patches":
            assert data["expected_generation"] == self.generation
            for e in data["edits"]:
                assert e["expected_digest"] == (hexsha(self.files[e["path"]]) if e["path"] in self.files else None)
                self.files[e["path"]] = e["content"]
            self.patches.append(sorted(e["path"] for e in data["edits"]))
            self.generation += 1
            return ok({"generation": self.generation}, 201)
        if path == f"/v1/workspaces/{FORK}/checkpoints":
            ck = f"cp_{len(self.checkpoints) + 1:04d}"
            self.checkpoints[ck] = dict(self.files)
            return ok({"id": ck, "generation": self.generation}, 201)
        raise AssertionError(f"unexpected {method} {path}")


@pytest.fixture()
def m(w, monkeypatch):
    w.hive.settings.code_controller_engine = True
    enabled(w)
    w.engine = w.hive.code_controller
    monkeypatch.setattr(w.engine, "kick", lambda rid: None)
    w.fork = FakeFork({"calculator.py": CALCULATOR, "test_calculator.py": "assert add(2, 3) == 5\n"})
    monkeypatch.setattr(w.hive.code, "proxy", w.fork.proxy)
    w.tests = []

    async def plan_check(run_row, cand):           # stand-in for the plan engine's acceptance check on the candidate
        files = w.fork.checkpoints[cand]
        passed = "a + b" in files["calculator.py"]
        w.tests.append(cand)
        return {"passed": passed, "exit_code": 0 if passed else 1, "argv": ["python", "test_calculator.py"],
                "stdout": "calculator passed\n" if passed else "", "stderr": "" if passed else "AssertionError: -1 != 5\n"}
    w.engine.member_ports.run_test = plan_check
    w.events = []
    real = w.hive.events.publish
    monkeypatch.setattr(w.hive.events, "publish", lambda kind, **kw: (w.events.append((kind, kw)), real(kind, **kw)))
    return w


def adopt(m, policy="plan-reviewed", paths=("calculator.py",)):
    out = m.engine.adopt_member("pl_one", "p1", {"task_id": m.task["id"], "grant_id": m.grant["id"],
                                                  "repository_id": "synthetic", "workspace_id": FORK},
                                list(paths), m.helper["id"], "budget.pl_one.p1", policy, "user:u_jon", task="task-1")
    m.tid = out["task_id"]
    return out


def kinds(m):
    return [r["kind"] for r in m.hive.db.all("SELECT kind FROM code_controller_journal WHERE request_id = ? ORDER BY seq",
                                             (m.tid,))]


def assignee_finishes(m, files, seq=None, shape="direct"):
    """shape: how the answer is stored, one of hive.tests.test_result_schema.STORED_AS."""
    effects = m.engine._effects(m.tid, "helper")
    body = json.loads((effects[seq - 1] if seq else effects[-1])["body"])
    agent = m.hive.agent(m.helper["id"])
    m.hive.goals.claim(agent, body["goal_id"])
    run(m.hive.goals.result(agent, body["goal_id"], "done", "wrote it",
                            STORED_AS[shape]({"files": files, "summary": "fixed add"})))
    run(m.engine.on_event({"type": "goal.updated", "goal": {"id": body["goal_id"]}}))
    return body


def add_reviewer(m):
    # asleep, as a mind a person's form makes and starts is between messages: a mind never started can't review (#104)
    role = m.hive.db.one("SELECT id FROM roles WHERE name = 'Foundation proposal reviewer'")["id"]
    agent = m.client.post("/api/agents", json={"name": "Second opinion", "swarm_id": m.team["id"], "budget_usd": 5}).json()
    m.hive.db.update("agents", agent["id"], {"role_id": role, "status": "asleep", "desired": "asleep"})
    return agent


def reviewer_passes(m):
    body = json.loads(m.engine._effects(m.tid, "review")[-1]["body"])
    agent = m.hive.agent(body["reviewer_id"])
    m.hive.goals.claim(agent, body["goal_id"])
    run(m.hive.goals.result(agent, body["goal_id"], "done", "ok", {"decision": "pass"}))
    run(m.engine.on_event({"type": "goal.updated", "goal": {"id": body["goal_id"]}}))
    return body


def member_ready_events(m):
    return [kw for kind, kw in m.events if kind == "code.controller.member_ready"]


def test_a_plan_reviewed_member_reaches_member_ready_and_only_integrated_delivers(m):
    adopt(m)
    view = run(m.engine.step(m.tid))
    assert kinds(m) == ["opened", "read", "think-started"] and view["status"] == "writing"
    assert view["profile"] == "plan-member" and view["plan"]["plan_id"] == "pl_one" and view["actions"] == []
    run_row = m.engine._run(m.tid)
    assert run_row["lease_id"] == "budget.pl_one.p1"                      # the Ctx epoch slot is the plan budget ref
    goal_msg = m.hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller'",
                             (m.helper["id"],))["text"]
    assert "files holds only these paths: calculator.py" in goal_msg
    assert goal_msg.index('"summary"') < goal_msg.index('"files"')   # summary first, so it is never nested in files
    assignee_finishes(m, {"calculator.py": FIXED})
    view = m.engine.view(m.tid)
    assert kinds(m) == ["opened", "read", "think-started", "changed", "dispatched", "tests-pass"]
    assert view["status"] == "member_ready" and view["next_action"].startswith("(tell member-ready")
    assert "review-request" not in json.dumps(view["journal"])          # plan-reviewed: no per-piece review
    cand = view["candidate"]
    assert member_ready_events(m) == [{"plan_id": "pl_one", "piece": "p1", "cand": cand, "task_id": m.tid}]
    assert m.fork.patches == [["calculator.py"]] and m.fork.checkpoints[cand]["calculator.py"] == FIXED
    # every relay call is the person's own scope on the plan's task
    assert {(c[0], c[3], c[4]) for c in m.fork.calls} == {("user:u_jon", m.task["id"], m.grant["id"])}
    out = run(m.engine.member_integrated(m.tid, "integrate-1", cand, "cp_int_0001"))
    assert out["verdict"] == "accepted" and out["status"] == "integrated" and out["phase"] == "delivered"
    again = run(m.engine.member_integrated(m.tid, "integrate-2", cand, "cp_int_0002"))
    assert again["verdict"].startswith("(rejected")                    # delivered stays delivered


@pytest.mark.parametrize("shape", ["native", "mcp"])
def test_an_assignee_that_finishes_with_its_own_tool_has_its_files_written(m, shape):
    """A real assignee finishes with its own hive-goal-propose or the MCP hive-goal-done, which keep its answer under
    proposal; its files and summary are read from there, so the candidate holds the files it wrote."""
    adopt(m)
    run(m.engine.step(m.tid))
    assignee_finishes(m, {"calculator.py": FIXED}, shape=shape)
    view = m.engine.view(m.tid)
    assert kinds(m) == ["opened", "read", "think-started", "changed", "dispatched", "tests-pass"]
    assert m.fork.checkpoints[view["candidate"]]["calculator.py"] == FIXED
    assert next(r for r in view["journal"] if r["kind"] == "changed")["evidence"]["summary"] == "fixed add"


def test_a_review_required_member_gets_an_independent_second_opinion_first(m):
    reviewer = add_reviewer(m)
    adopt(m, policy="review-required")
    run(m.engine.step(m.tid))
    assignee_finishes(m, {"calculator.py": FIXED})
    view = m.engine.view(m.tid)
    assert view["status"] == "reviewing" and view["second_opinion"]["reviewer_id"] == reviewer["id"]
    packet = m.hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller'",
                           (reviewer["id"],))["text"]
    assert "-    return a - b" in packet and "+    return a + b" in packet and "piece p1" in packet
    assert not member_ready_events(m)
    reviewer_passes(m)
    view = m.engine.view(m.tid)
    assert kinds(m)[-1] == "review-pass" and view["status"] == "member_ready" and len(member_ready_events(m)) == 1
    # the assignee is in the author set: it can never pass its own review
    forged = run(m.engine.observe(m.engine._run(m.tid), "forged", "review-pass",
                                  [cce.q(view["candidate"]), cce.q(m.helper["id"]), cce.q("review-1")]))
    assert forged[0] == "rejected"


def test_member_refix_is_one_repair_with_the_plans_failing_output_then_a_new_candidate(m):
    adopt(m)
    run(m.engine.step(m.tid))
    assignee_finishes(m, {"calculator.py": FIXED})
    first = m.engine.view(m.tid)["candidate"]
    out = run(m.engine.member_refix(m.tid, "refix-1", first, "check-run-7",
                                    {"notes": "the plan's check: add(-1, -1) must be -2", "by": "plan"}))
    assert out["verdict"] == "accepted" and kinds(m)[-2:] == ["member-refix", "think-started"]
    assert out["status"] == "repairing"
    prompt = m.hive.db.all("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller' ORDER BY "
                           "created_at", (m.helper["id"],))[-1]["text"]
    assert "The last version failed" in prompt and "add(-1, -1) must be -2" in prompt and "check-run-7" in prompt
    assignee_finishes(m, {"calculator.py": FIXED + "\n# handles negatives\n"})
    view = m.engine.view(m.tid)
    assert view["status"] == "member_ready" and view["candidate"] != first and len(member_ready_events(m)) == 2
    stale = run(m.engine.member_refix(m.tid, "refix-2", first, "check-run-8"))   # a refix for the superseded candidate
    assert stale["verdict"] == "(rejected not-the-member-ready-candidate)"


def packets(m):
    """The data of every packet the assignee was sent, oldest first."""
    rows = m.hive.db.all("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller' ORDER BY "
                         "created_at", (m.helper["id"],))
    return [json.loads(r["text"].rsplit("UNTRUSTED_DATA:\n", 1)[1]) for r in rows]


def test_the_assignee_reads_the_forks_other_files_and_writes_only_its_own(m):
    """On a fresh install a builder of app.js was sent only app.js, asked for the index.html another piece had built,
    and stalled: its mind has no Code client, and reading is the host's. The packet carries the rest of the fork."""
    m.fork.files["index.html"] = '<input id="bill">\n'
    adopt(m)
    run(m.engine.step(m.tid))
    data = packets(m)[0]
    assert data["files"] == {"calculator.py": CALCULATOR}
    assert data["read_only"] == {"index.html": m.fork.files["index.html"], "test_calculator.py": "assert add(2, 3) == 5\n"}
    assert "read_only_left_out" not in data
    # read only: writing one of them is still out of the piece, and the repair is sent them again
    assignee_finishes(m, {"calculator.py": FIXED, "index.html": "<p>mine now</p>\n"})
    assert "changed" not in kinds(m) and m.fork.patches == []
    assert packets(m)[-1]["read_only"]["index.html"] == '<input id="bill">\n'


def test_other_files_too_big_for_the_packet_leave_the_largest_out_by_name(m):
    from hive.core.code_controller_member import PACKET_CHARS
    m.fork.files["vendor.js"] = "x" * PACKET_CHARS
    m.fork.files["index.html"] = "<main></main>\n"
    adopt(m)
    run(m.engine.step(m.tid))
    data = packets(m)[0]
    assert sorted(data["read_only"]) == ["index.html", "test_calculator.py"] and data["read_only_left_out"] == ["vendor.js"]
    assert data["files"] == {"calculator.py": CALCULATOR}


def test_a_fork_whose_files_cannot_be_listed_fails_the_attempt_and_sends_nothing(m, monkeypatch):
    real = m.fork.proxy

    async def tree_down(principal, method, path, query, body, *rest):
        if path.endswith("/tree"):
            return 503, b'{"error": "unavailable"}', "application/json"
        return await real(principal, method, path, query, body, *rest)
    monkeypatch.setattr(m.hive.code, "proxy", tree_down)
    adopt(m)
    run(m.engine.step(m.tid))
    failed = [r for r in m.engine.view(m.tid)["journal"] if r["kind"] == "think-failed"]
    assert failed and failed[0]["evidence"] == {"reason": "RuntimeError", "stage": "assign"}
    assert packets(m) == []


def stall(m, goal_id):
    """The goal's claims lapse until the hive stalls it, as goals.expire does after MAX_ATTEMPTS lapsed leases."""
    from hive.core.goals import MAX_ATTEMPTS
    m.hive.db.execute("UPDATE goals SET lease_until = ?, attempts = ? WHERE id = ?",
                      ("2000-01-01T00:00:00.000Z", MAX_ATTEMPTS, goal_id))
    run(m.hive.goals.expire())
    assert m.hive.goals.get(goal_id)["status"] == "stalled"
    run(m.engine.on_event({"type": "goal.updated", "goal": {"id": goal_id}}))


def test_an_assignee_that_claims_and_goes_quiet_ends_its_attempt_when_the_goal_stalls(m):
    """No answer comes from a stalled goal: the attempt ends there (one repair, a fresh goal and packet), where before
    the member waited on it, and its plan read 'writing' with no error."""
    adopt(m)
    run(m.engine.step(m.tid))
    body = json.loads(m.engine._effects(m.tid, "helper")[-1]["body"])
    m.hive.goals.claim(m.hive.agent(m.helper["id"]), body["goal_id"])
    stall(m, body["goal_id"])
    failed = next(r for r in m.engine.view(m.tid)["journal"] if r["kind"] == "think-failed")
    assert failed["evidence"] == {"goal_status": "stalled"} and kinds(m)[-2:] == ["think-failed", "think-started"]
    assert len(packets(m)) == 2


def test_an_out_of_piece_edit_from_the_helper_is_never_written(m):
    adopt(m)
    run(m.engine.step(m.tid))
    assignee_finishes(m, {"calculator.py": FIXED, "test_calculator.py": "assert True\n"})
    ks = kinds(m)
    assert "changed" not in ks and ks[-2:] == ["think-failed", "think-started"]
    failed = next(r for r in m.engine.view(m.tid)["journal"] if r["kind"] == "think-failed")
    assert failed["evidence"]["paths"] == ["test_calculator.py"] and m.fork.patches == []


def test_a_refused_answer_is_said_to_the_next_attempt(m):
    """On a fresh install a builder put summary inside files; each retry was told only that it had failed, and it made
    the same answer three times. The next packet says why the last one was refused."""
    adopt(m)
    run(m.engine.step(m.tid))
    assignee_finishes(m, {"calculator.py": FIXED, "summary": "fixed add"})
    rows = m.hive.db.all("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller' ORDER BY "
                         "created_at", (m.helper["id"],))
    assert len(rows) == 2 and "The last attempt was refused" not in rows[0]["text"]
    retry = rows[-1]["text"]
    assert "The last attempt was refused: it wrote summary outside this piece's files" in retry
    assert "the summary goes beside files, never inside it" in retry and "The last version failed" not in retry
    assert m.engine.last_refusal(m.tid).startswith("The last attempt was refused: it wrote summary")


def test_an_out_of_piece_proposal_is_scope_refused_at_selection_and_an_in_piece_one_is_executed(m):
    adopt(m)
    row = m.engine._run(m.tid)
    assert run(m.engine.observe(row, "opened", "opened", [])) == "accepted"
    assert run(m.engine.observe(row, "read-1", "read", [])) == "accepted"
    m.engine.member_ports.run_test = None                               # stop after the change: no test port
    out = run(m.engine.propose_member_edit(m.tid, {"README.md": "hello"}, m.helper["id"]))
    assert out["verdict"] == "accepted"
    assert kinds(m)[2:5] == ["proposed", "scope-refused", "think-started"] and m.fork.patches == []
    refused = next(r for r in m.engine.view(m.tid)["journal"] if r["kind"] == "scope-refused")
    assert refused["evidence"]["outside"] == ["README.md"]


def test_an_in_piece_proposal_is_selected_executed_written_and_becomes_the_candidate(m):
    adopt(m)
    row = m.engine._run(m.tid)
    run(m.engine.observe(row, "opened", "opened", []))
    run(m.engine.observe(row, "read-1", "read", []))
    out = run(m.engine.propose_member_edit(m.tid, {"calculator.py": FIXED}, m.helper["id"]))
    assert out["verdict"] == "accepted"
    assert kinds(m)[2:8] == ["proposed", "proposal-selected", "proposal-executing", "proposal-done", "changed",
                             "dispatched"]
    assert m.fork.patches == [["calculator.py"]] and m.engine.view(m.tid)["status"] == "member_ready"


def test_the_profile_gate_refuses_every_person_and_apply_kind_for_a_member(m):
    adopt(m)
    run(m.engine.step(m.tid))
    for call in (m.engine.apply(m.tid, "user:u_jon"), m.engine.request_changes(m.tid, "user:u_jon", "more"),
                 m.engine.discard(m.tid, "user:u_jon")):
        with pytest.raises(cce.EngineError) as refused:
            run(call)
        assert refused.value.status == 403 and refused.value.code == "plan_member"
    row = m.engine._run(m.tid)
    for obs, kind, fields in (("a1", "approval-needed", [cce.q("apply-1")]),
                              ("a2", "applied", [cce.q("apply-1"), cce.q("cp_x"), cce.q("user:u_jon")]),
                              ("a3", "changes-requested", [cce.q("cp_x"), cce.q("user:u_jon")])):
        assert run(m.engine.observe(row, obs, kind, fields)) == ["rejected", "not-in-plan-member-profile"], kind


def test_the_budget_ending_cancels_the_member_and_withdraws_its_goals(m):
    adopt(m)
    run(m.engine.step(m.tid))
    goal = json.loads(m.engine._effects(m.tid, "helper")[0]["body"])["goal_id"]
    run(m.engine.member_budget_ended(m.tid))
    view = m.engine.view(m.tid)
    assert view["phase"] == "stopped" and kinds(m)[-1] == "cancelled"
    assert m.hive.goals.get(goal)["status"] == "cancelled"


def test_without_the_plans_test_port_a_member_says_so_and_never_passes(m):
    m.engine.member_ports.run_test = None
    adopt(m)
    run(m.engine.step(m.tid))
    assignee_finishes(m, {"calculator.py": FIXED})
    view = m.engine.view(m.tid)
    assert "tests-pass" not in kinds(m) and view["status"] == "needs_you"
    assert "no test runner" in next(r for r in view["journal"] if r["kind"] == "refused")["evidence"]["reason"]


def test_adopt_member_checks_its_inputs_and_is_idempotent(m):
    first = adopt(m)
    assert adopt(m) == first and m.hive.db.one("SELECT COUNT(*) AS n FROM code_controller_runs WHERE request_id = ?",
                                              (first["task_id"],))["n"] == 1
    with pytest.raises(cce.EngineError):
        adopt(m, policy="review-waivable")                              # not a member policy (profile-policy-mismatch)
    with pytest.raises(cce.EngineError):
        adopt(m, paths=("../etc/passwd",))
