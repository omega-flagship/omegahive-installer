"""Create - Code: the MeTTa coding controller (R3.11.5, root-suggest) driving a Code request on the host
(hive/core/code_controller_engine.py). The reducer runs for real in PeTTa; the host routes, request, lease, spawn,
proposal-test issuance and binding are the real ones. Only the Code service is faked, at the HTTP boundary
(Code.proxy for the person-scope readback, Code.relay_agent for prepare/launch), in the wire forms recorded live
(attempts 14-21: request_binding.digest is BARE 64-hex; launch receipt as omegacode-sandbox-dispatch-result/1).
No model, no Code process, no sandbox."""
import asyncio
import base64
import hashlib
import json
import pathlib

import httpx
import pytest

from hive.core import code_controller_engine as cce
from hive.tests.test_code_test_context_lookup import readback
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import accepted, enabled, service, w  # noqa: F401  (fixture)
from hive.tests.test_proposal_tests import SUGGESTION, origin

ROOT = pathlib.Path(__file__).resolve().parents[2]
FORK = "ws_" + "b2" * 16
EXE = "/invented/venv/bin/python"
SUGG2 = "suggestion_" + "1e" * 16
TESTS_SHA256 = "877142357df5670b0625cf989433e9b3c581831195572584482f795195ce57bb"           # R3.11.5 tests
R3_12_TESTS_SHA256 = "8370b7fc36e15489b4c8909def3a498784a2e3e3b35298e60cc4714c3f749d18"     # R3.12 tests (306/306)
R3_13_TESTS_SHA256 = "06441d838fbc75ee4fe1ac1072944cb2680aa59cb40c0d0a79d9f36645da7cba"     # R3.13 tests (353/353)

CALCULATOR = "def add(a, b):\n    return a - b\n"          # bytes 28..29 are the '-' the person scopes
FILES = {"calculator.py": CALCULATOR,
         "test_calculator.py": "from calculator import add\n\nassert add(2, 3) == 5, add(2, 3)\nprint('calculator passed')\n"}
ORIGIN = {"Origin": "http://127.0.0.1:8700"}          # the §G person gate's loopback origin (HIVE_PORT default)


def run(coro):
    return asyncio.run(coro)


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def hexsha(raw):
    return hashlib.sha256(raw).hexdigest()


def claims_of(bearer):
    payload = bearer.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


class FakeCode:
    """OmegaCode at the hive's HTTP boundary. Prepare binds through the hive's real service route handler, as Code does;
    an application answers Code's application_receipt wire form."""

    def __init__(self, x, outcomes, apply_status=201):
        self.x, self.outcomes, self.calls, self.applied, self.apply_status = x, list(outcomes), [], [], apply_status
        self.members, self.unreadable, self.applications, self.ws_generation = set(), set(), {}, 1
        self.files = {}

    async def proxy(self, principal, method, path, query, body, task_id, grant_id, repository_id):
        """The person relay (read scope): retained proposals, files, the workspace and applications."""
        self.calls.append(("proxy", method, path))
        ws = WS_OF(self.x)
        if path == f"/v1/workspaces/{ws}/files":
            name = query.get("path")
            files = {**FILES, **self.files}
            if name not in files or name in self.unreadable:
                return 403, canon({"error": "path_scope", "message": "outside the grant"}), "application/json"
            raw = files[name].encode()
            return 200, canon({"path": name, "content": files[name], "digest": hexsha(raw), "generation": 1,
                               "tree_digest": "a3" * 32}), "application/json"
        if path == f"/v1/workspaces/{ws}":
            return 200, canon({"id": ws, "generation": self.ws_generation, "tree_digest": "a3" * 32}), "application/json"
        if "/proposal-applications/" in path:
            app = self.applications.get(path.rsplit("/", 1)[-1])
            if app is None:
                return 404, canon({"error": "not_found"}), "application/json"
            return 200, canon({"application": app, "currency": "current", "workspace": {}, "undo": None}), "application/json"
        sid = path.rsplit("/", 1)[-1]
        child = self.x.hive.db.one("SELECT id FROM mind_children WHERE request_id = ?", (self.x.rq["request_id"],))["id"]
        saved = json.loads(readback(self.x, child, proposal_id=sid))
        saved["content"]["hunks"] = [{"path": "calculator.py", "start_byte": 28, "end_byte": 29, "replacement": "+",
                                      "before_digest": hexsha(b"-"), "expected_file_digest": hexsha(CALCULATOR.encode())}]
        return 200, canon(saved), "application/json"

    async def relay_agent(self, member_token, bearer, method, path, raw_query, body):
        self.calls.append(("relay", method, path))
        self.members.add(member_token)
        claims = claims_of(bearer)
        if path.endswith("/proposal-applications"):
            payload = json.loads(body)
            c = claims["copy_apply"]
            assert claims["actions"] == ["proposal-apply"] and c["proposal"]["suggestion_id"] == payload["suggestion_id"]
            assert c["proposal"]["suggestion_digest"] == payload["suggestion_digest"] == "e1" * 32     # bare hex, as Code
            assert set(payload) == {"operation_id", "request_id", "suggestion_id", "suggestion_digest", "expected_generation",
                                    "expected_tree_digest", "scope_id", "scope_digest"}
            app_id = "application_" + "ab" * 16
            if self.apply_status == "lost":           # the connection dropped: Code may or may not have it
                from hive.core.code import CodeError
                raise CodeError(502, "relay_proof_failed", "connection lost")
            if self.apply_status == "garbled":        # applied, but the answer is not a receipt the host can trust
                self.applications[app_id] = {"id": app_id, "suggestion_id": payload["suggestion_id"], "after_generation": 2,
                                             "after_tree_digest": "c4" * 32}
                return 500, canon({"application_id": app_id}), "application/json"
            if self.apply_status != 201:
                return self.apply_status, canon({"error": "copy_effect_policy_unavailable", "message": "original deletion policy is not connected"}), "application/json"
            self.applied.append(payload)
            return 201, canon({"application_id": app_id, "request_id": payload["request_id"], "workspace_id": WS_OF(self.x),
                               "suggestion_id": payload["suggestion_id"], "suggestion_digest": payload["suggestion_digest"],
                               "change_id": "change_1", "before": {"generation": 1, "tree_digest": "a3" * 32},
                               "after": {"generation": 2, "tree_digest": "c4" * 32}, "workspace": {},
                               "undo": {"application_id": app_id, "expected_generation": 2, "expected_tree_digest": "c4" * 32},
                               "effect": "workspace-copy-write"}), "application/json"
        p = claims["proposal_test"]
        if path == "/v1/proposal-tests":
            status, raw = self.x.hive.proposal_tests.bind(self.x.service, p["test_id"], {
                "capability_id": claims["id"], "operation_id": "op-bind-" + p["test_id"][3:15], "fork_workspace_id": FORK,
                "proposal": p["proposal"], "parent": p["parent"], "test_tree_digest": "sha256:" + "88" * 32,
                "preparation_digest": "sha256:" + "99" * 32})
            return 200, canon({"test_id": p["test_id"], "ack": json.loads(raw), "launch_authority": False,
                               "accepted_source": False}), "application/json"
        assert path == f"/v1/proposal-tests/{p['test_id']}/launches"
        launch = json.loads(body)
        ok, out = self.outcomes.pop(0)
        return 202, canon(self.launch(claims, launch, ok, out)), "application/json"

    @staticmethod
    def launch(claims, launch, ok, stdout):
        p = claims["proposal_test"]
        raw_out, raw_err = stdout.encode(), b""

        def meta(raw):
            return {"digest": "sha256:" + hexsha(raw), "retained_bytes": len(raw), "observed_bytes": len(raw), "eof": True,
                    "truncated": False, "complete": True}
        binding = {"schema": "omegacode-project-test-binding/1", "service_id": claims["aud"], "capability_id": claims["id"],
                   **{k: p[k] for k in ("test_id", "request_id", "lease_id", "controller_id", "issuer", "proposal", "parent",
                                        "fork")},
                   "repository_id": claims["repository_id"], "test_tree_digest": "sha256:" + "88" * 32,
                   **{k: launch[k] for k in ("runtime", "argv", "runtime_seconds")}}
        receipt = {"schema": "omegacode-sandbox-test-result/1", "binding": binding, "snapshot_digest": "sha256:" + "66" * 32,
                   "streams": {"stdout": meta(raw_out), "stderr": meta(raw_err)},
                   "command_outcome": "succeeded" if ok else "not_succeeded", "exit_code": 0 if ok else 1,
                   "output_complete": True, "execution_backend": "sandbox-exec",
                   "cleanup": {"complete": True, "original_process_reaped": True, "original_group_absent": True,
                               "job_removed": True, "descendants": "FORK_DENIED", "errors": []},
                   "primary_error": None, "authorization_error": None, "accepted_source": False,
                   "independent_evaluation": False}
        receipt["digest"] = "sha256:" + hexsha(canon(receipt))
        record = {"schema": "omegacode-sandbox-dispatch-result/1", "test_id": p["test_id"], "launch_key": launch["launch_key"],
                  "receipt": receipt, "captures": {"stdout": base64.b64encode(raw_out).decode(), "stderr": ""}}
        return {"record": record, "currency": "current", "execution_currency": "current", "tested": ok,
                "accepted_source": False}


def WS_OF(x):
    return origin(x)["workspace_id"]


@pytest.fixture()
def x(w, monkeypatch):
    monkeypatch.setattr(type(w.hive.code), "_loaded_release_mismatch", lambda self: None)
    w.svc = service(w)
    w.service = w.hive.db.one("SELECT * FROM services WHERE id = 'svc_code'")
    w.hive.settings.proposal_test_claims = True
    w.hive.settings.copy_apply_claims = True
    w.hive.settings.proposal_test_argv_prefixes = [[EXE, "test_calculator.py"]]      # attempt 21's operator command
    w.hive.settings.code_controller_engine = True
    enabled(w)
    w.engine = w.hive.code_controller
    monkeypatch.setattr(w.engine, "kick", lambda rid: None)        # the test drives the loop itself (no app-loop task)
    # The engine acts as itself (in-process host paths, its own credential): no mind token, no supervisor workspace.
    monkeypatch.setattr(w.hive.supervisor, "workspace", None, raising=False)
    w.rq = accepted(w, origin=origin(w))
    w.rid = w.rq["request_id"]
    return w


def fake(x, monkeypatch, outcomes, **kw):
    code = FakeCode(x, outcomes, **kw)
    monkeypatch.setattr(x.hive.code, "proxy", code.proxy)
    monkeypatch.setattr(x.hive.code, "relay_agent", code.relay_agent)
    return code


def add_reviewer(x):
    """The foundation reviewer role (foundation._review_role's record) on a mind of the Code team."""
    role = reviewer_role(x)
    agent = x.client.post("/api/agents", json={"name": "Second opinion", "swarm_id": x.team["id"], "budget_usd": 5}).json()
    x.hive.db.update("agents", agent["id"], {"role_id": role})
    x.reviewer = agent
    return agent


def reviewer_role(x):
    """The foundation reviewer role every hive installs at start (foundation._review_role, with its asleep reviewer)."""
    return x.hive.db.one("SELECT id FROM roles WHERE name = 'Foundation proposal reviewer'")["id"]


def no_reviewer_can_run(x):
    x.hive.db.execute("UPDATE agents SET desired = 'paused' WHERE role_id = ?", (reviewer_role(x),))


def helper_finishes(x, attempt, sid):
    """The helper (a fake mind) claims its work goal and proposes with the retained suggestion id."""
    eff = x.hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'helper' AND seq = ?",
                        (x.rid, attempt))
    body = json.loads(eff["body"])
    child = x.hive.agent(body["child_id"])
    x.hive.goals.claim(child, body["goal_id"])
    run(x.hive.goals.result(child, body["goal_id"], "done", f"retained {sid}", {"proposal_id": sid}))
    run(x.engine.on_event({"type": "goal.updated", "goal": {"id": body["goal_id"]}}))     # the event the watcher receives
    return body


def reviewer_finishes(x, decision="pass", notes=None):
    eff = x.hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'review' AND "
                        "state = 'waiting' ORDER BY seq DESC LIMIT 1", (x.rid,))
    body = json.loads(eff["body"])
    agent = x.hive.agent(body["reviewer_id"])
    x.hive.goals.claim(agent, body["goal_id"])
    data = {"decision": decision} | ({"notes": notes} if notes else {})
    run(x.hive.goals.result(agent, body["goal_id"], "done", f"review {decision}", data))
    run(x.engine.on_event({"type": "goal.updated", "goal": {"id": body["goal_id"]}}))
    return body


def kinds(x):
    return [r["kind"] for r in x.hive.db.all("SELECT kind FROM code_controller_journal WHERE request_id = ? ORDER BY seq",
                                              (x.rid,))]


def person(x, action, body=None, headers=None):
    return x.client.post(f"/api/requests/{x.rid}/controller/{action}", headers={**(headers or x.jon), **ORIGIN},
                         json=body if body is not None else None)


def to_ready(x, monkeypatch, outcomes=((True, "calculator passed\n"),), **kw):
    code = fake(x, monkeypatch, list(outcomes), **kw)
    add_reviewer(x)
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    assert x.engine.view(x.rid)["status"] == "reviewing"
    reviewer_finishes(x, "pass")
    assert x.engine.view(x.rid)["status"] == "ready_for_you"
    return code


# ---- vendoring and mapping -------------------------------------------------------------------------------------

# ---- vendoring and mapping -------------------------------------------------------------------------------------

def test_the_engine_runs_the_pinned_r3_14_and_keeps_the_earlier_reducers_beside_it_unchanged():
    assert cce.REDUCER.name == "coding_controller_r3_14.metta" and cce.REDUCER_VERSION == "R3.14"
    assert hexsha(cce.REDUCER.read_bytes()) == cce.REDUCER_SHA256 == \
        "5dafb7b9d942dac3b620b48cf6efe26d762d994ef8628049c65bb0da3aa472d9"
    assert hexsha((ROOT / "modules/code/controller/test_coding_controller_r3_14.metta").read_bytes()) == \
        "0e97fe07e9cf46c6dd0925b4122533ca7b7066010af3bb0796a185fb23a57c5a"
    assert hexsha(cce.REDUCER_R3_13.read_bytes()) == cce.REDUCER_R3_13_SHA256 == \
        "0d70b97750eafc8f72a7dad5c99e3783af369b736a095dc311cd7165c889ebdd"
    assert hexsha((ROOT / "modules/code/controller/test_coding_controller_r3_13.metta").read_bytes()) == R3_13_TESTS_SHA256
    assert hexsha(cce.REDUCER_R3_12.read_bytes()) == cce.REDUCER_R3_12_SHA256 == \
        "ce0e22a38977436ede3e1cd89d6bafe25662d7b5f27c9a949979903c9f32e865"
    assert hexsha((ROOT / "modules/code/controller/test_coding_controller_r3_12.metta").read_bytes()) == R3_12_TESTS_SHA256
    assert hexsha(cce.REDUCER_R3_11.read_bytes()) == cce.REDUCER_R3_11_SHA256 == \
        "3e9770edc7458c476f2b4e5e8bc14f5da956a0f7b9f005d46c15d61f7472d786"
    assert hexsha((ROOT / "modules/code/controller/test_coding_controller_r3_11.metta").read_bytes()) == TESTS_SHA256


def test_observation_text_round_trips_and_refuses_what_is_not_a_reference():
    text = cce.render(["O", cce.q("cand-x"), "candidate-retained", cce.q("rq_1"), cce.q("ls_1"),
                       [cce.q(SUGGESTION), [], cce.q("sha256:" + "a" * 64)]])
    assert text == f'(O "cand-x" candidate-retained "rq_1" "ls_1" ("{SUGGESTION}" () "sha256:{"a" * 64}"))'
    assert cce.parse(text)[5][0] == SUGGESTION and isinstance(cce.parse(text)[5][0], cce.Str)
    for bad in ('a"b', "a b", "(x)", ""):
        with pytest.raises(cce.EngineError):
            cce.q(bad)


def test_the_reducer_maps_root_suggest_actions(tmp_path):
    from hive.core.config import load_settings
    red = cce.Reducer(load_settings(data_dir=tmp_path, admin_password="pw").petta_path)
    ctx = '(Ctx "rq_1" "ls_1" "user:u_jon" ("a_ctl") 2 root-suggest review-required)'

    def act(log):
        return run(red.run(f'(let $s (replay {ctx} (start-state) ({log})) ($s (next-action-for root-suggest $s "rq_1" "default")))'))

    def o(i, kind, fields):
        return f'(O "{i}" {kind} "rq_1" "ls_1" {fields})'
    try:
        s, a = act("")
        assert cce.state_view(s)["phase"] == "claimed" and a == ["do", ["code-open-readonly", "rq_1"]]
        # R3.12 (1): reading is the host's, never a think
        assert act(o("open", "opened", "()"))[1] == ["do", ["host-read", "find-the-relevant-code"]]
        log = o("open", "opened", "()") + o("r1", "read", "()")
        assert act(log)[1] == ["think", "make-the-smallest-change"]
        log += o("t1", "think-started", '("think-1" "cce.spawn.rq_1.1")')
        assert act(log)[1] == ["rest", "awaiting-helper"]                     # R3.12 (2): never a second spawn
        log += o("c1", "candidate-retained", f'("{SUGGESTION}" () "img")')
        s, a = act(log)
        assert cce.state_view(s)["phase"] == "edited" and a == ["do", ["proposal-test", SUGGESTION, "default"]]
        # an origin edit is not in this profile; a test result for an undispatched run is refused
        verdict = run(red.run(f'(let ($s2 $v) (apply-obs {ctx} (replay {ctx} (start-state) ({log})) '
                              f'{o("t", "tests-pass", chr(40) + chr(34) + SUGGESTION + chr(34) + " " + chr(34) + "run-9" + chr(34) + chr(41))}) $v)'))
        assert verdict == ["rejected", "run-not-dispatched-for-this-candidate"]
    finally:
        red.close()




# ---- the host loop, end to end -----------------------------------------------------------------------------------

def test_happy_path_helper_test_second_opinion_ready_then_the_persons_apply(x, monkeypatch):
    code = fake(x, monkeypatch, [(True, "calculator passed\n")])
    reviewer = add_reviewer(x)
    view = run(x.engine.step(x.rid))
    # opened read-only, host read, one helper spawned with a host-composed prompt; now waiting for its work goal
    assert kinds(x) == ["opened", "read", "think-started"] and view["status"] == "writing"
    req = x.hive.minds._request(x.rid)
    assert x.hive.goals.get(req["receiving_goal"])["claimed_by"] == x.ctl["id"]
    children = x.hive.db.all("SELECT * FROM mind_children WHERE request_id = ?", (x.rid,))
    assert len(children) == 1 and children[0]["controller_id"] == x.ctl["id"]
    prompt = x.hive.db.one("SELECT text FROM mind_prompts WHERE child_id = ? AND rev = 1", (children[0]["id"],))["text"]
    assert origin(x)["workspace_id"] in prompt and "code-propose " + origin(x)["workspace_id"] in prompt
    assert run(x.engine.step(x.rid))["status"] == "writing"           # idempotent: still one helper, nothing new
    assert len(x.hive.db.all("SELECT id FROM mind_children WHERE request_id = ?", (x.rid,))) == 1

    helper_finishes(x, 1, SUGGESTION)
    view = x.engine.view(x.rid)
    assert kinds(x) == ["opened", "read", "think-started", "candidate-retained", "dispatched", "tests-pass", "dispatched"]
    assert view["status"] == "reviewing" and view["second_opinion"]["reviewer_id"] == reviewer["id"]
    # the review is a goal for the reviewer mind plus a packet message: hunks read in the person's scope, test evidence
    review = json.loads(x.hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'review'",
                                      (x.rid,))["body"])
    goal = x.hive.goals.get(review["goal_id"])
    assert goal["assignee"] == reviewer["id"] and goal["swarm_id"] == x.team["id"]
    packet = x.hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller'",
                           (reviewer["id"],))["text"]
    assert review["goal_id"] in packet and "calculator passed" in packet and "UNTRUSTED_DATA" in packet
    assert "code-proposal-second-opinion" in packet

    reviewer_finishes(x, "pass")
    view = x.engine.view(x.rid)
    assert kinds(x)[-1] == "review-pass"
    assert view["phase"] == "ready" and view["status"] == "ready_for_you" and view["candidate"] == SUGGESTION
    assert view["next_action"] == f'(tell confirm-to-apply "{SUGGESTION}")'
    assert view["test"]["exit_code"] == 0 and view["test"]["tested"] is True
    assert view["test"]["streams"]["stdout"]["digest"] == "sha256:" + hexsha(b"calculator passed\n")
    cand = next(r for r in view["journal"] if r["kind"] == "candidate-retained")
    assert cand["evidence"]["proposal"]["proposal_digest"] == "sha256:" + "e1" * 32   # bare hex from Code, prefixed by host
    assert [c[2] for c in code.calls if c[0] == "relay"] == ["/v1/proposal-tests",
                                                             f"/v1/proposal-tests/{view['test']['test_id']}/launches"]
    actions = {a["name"]: a for a in view["actions"]}
    assert actions["apply"]["available"] and actions["changes"]["available"] and actions["discard"]["available"]
    assert actions["apply"] | {"available": None, "why_not": None} == {
        "name": "apply", "label": "Apply", "method": "POST", "path": f"/api/requests/{x.rid}/controller/apply", "body": {},
        "available": None, "why_not": None}
    out = x.client.get(f"/api/requests/{x.rid}/controller", headers=x.jon)
    assert out.status_code == 200 and out.json()["status"] == "ready_for_you"

    # nothing is applied until the person's own Apply; never a mind, never another person
    assert code.applied == []
    assert x.client.post(f"/api/requests/{x.rid}/controller/apply", headers=agent_headers(x.ctl) | ORIGIN).status_code in (401, 403)
    assert person(x, "apply", headers=x.ann).status_code == 403
    out = person(x, "apply")
    assert out.status_code == 200, out.text
    view = out.json()
    assert kinds(x)[-3:] == ["approval-needed", "approved", "applied"]
    assert view["phase"] == "delivered" and view["status"] == "applied" and len(code.applied) == 1
    consent = x.hive.db.one("SELECT * FROM copy_apply_consents WHERE request_id = ?", (x.rid,))
    assert consent["principal"] == "user:u_jon" and consent["spent_at"] is not None     # the person's consent, spent once
    assert x.hive.goals.get(req["receiving_goal"])["status"] == "done"                     # closed on delivery
    assert not any(a["available"] for a in view["actions"])


def test_red_then_repair_then_green(x, monkeypatch):
    fake(x, monkeypatch, [(False, "FAIL: add(-1, 1) == 0\n"), (True, "calculator passed\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    first = helper_finishes(x, 1, SUGGESTION)
    view = x.engine.view(x.rid)
    assert view["phase"] == "red" and view["status"] == "repairing" and view["test"]["exit_code"] == 1
    fail = next(r for r in view["journal"] if r["kind"] == "tests-fail")
    assert fail["evidence"]["command_outcome"] == "not_succeeded"
    # the repair re-prompts the same helper (one child per request) with the failing output and a new work goal
    assert len(x.hive.db.all("SELECT id FROM mind_children WHERE request_id = ?", (x.rid,))) == 1
    repair = x.hive.db.one("SELECT text FROM mind_prompts WHERE child_id = ? AND rev = 2", (first["child_id"],))["text"]
    assert "FAIL: add(-1, 1) == 0" in repair and "exit code 1" in repair
    second = helper_finishes(x, 2, SUGG2)
    assert second["goal_id"] != first["goal_id"]
    reviewer_finishes(x, "pass")
    view = x.engine.view(x.rid)
    assert view["phase"] == "ready" and view["candidate"] == SUGG2 and view["status"] == "ready_for_you"
    assert kinds(x).count("candidate-retained") == 2 and kinds(x).count("tests-fail") == 1


def test_a_reviewer_who_fails_sends_the_helper_back_with_its_notes(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n"), (True, "ok\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    first = helper_finishes(x, 1, SUGGESTION)
    reviewer_finishes(x, "fail", "name the edge case in a comment")
    assert x.engine.view(x.rid)["status"] == "writing"
    again = x.hive.db.one("SELECT text FROM mind_prompts WHERE child_id = ? AND rev = 2", (first["child_id"],))["text"]
    assert "A reviewer asked for changes" in again and "name the edge case in a comment" in again


def test_no_reviewer_under_review_required_is_review_unavailable_and_needs_the_person(x, monkeypatch):
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    no_reviewer_can_run(x)
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    view = x.engine.view(x.rid)
    unavailable = next(r for r in view["journal"] if r["kind"] == "review-unavailable")
    assert unavailable["verdict"] == "(accepted (review-unavailable blocked))" and "review-pass" not in kinds(x)
    assert "reviewer" in unavailable["evidence"]["reason"]
    assert view["phase"] == "blocked" and view["status"] == "needs_you" and view["review_policy"] == "review-required"
    assert not {a["name"]: a for a in view["actions"]}["apply"]["available"]
    assert run(x.engine.step(x.rid))["status"] == "needs_you" and kinds(x).count("review-unavailable") == 1


def test_no_reviewer_under_the_persons_waivable_policy_is_ready_and_says_unreviewed(x, monkeypatch):
    out = x.client.put("/api/me/code-controller", headers={**x.jon, **ORIGIN}, json={"review_policy": "review-waivable"})
    assert out.status_code == 200 and x.client.get("/api/me/code-controller", headers=x.jon).json()["review_policy"] == \
        "review-waivable"
    x.rq = accepted(x, origin=origin(x), operation_id="op-request-waivable")     # the policy is fixed per new request
    x.rid = x.rq["request_id"]
    code = fake(x, monkeypatch, [(True, "calculator passed\n")])
    no_reviewer_can_run(x)
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    view = x.engine.view(x.rid)
    assert view["status"] == "ready_for_you" and view["unreviewed"] is True and view["review_policy"] == "review-waivable"
    assert view["next_action"] == f'(tell confirm-unreviewed-to-apply "{SUGGESTION}")'
    assert person(x, "apply").json()["status"] == "applied" and len(code.applied) == 1


def test_the_foundation_reviewer_is_found_and_woken_when_the_team_has_none(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    view = x.engine.view(x.rid)
    review = x.hive.agent(view["second_opinion"]["reviewer_id"])
    assert view["status"] == "reviewing" and review["name"] == "Review controller" and review["swarm_id"] != x.team["id"]


def test_the_author_controller_and_helpers_are_never_the_reviewer(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    no_reviewer_can_run(x)
    role = {"id": reviewer_role(x)}
    x.hive.db.update("agents", x.ctl["id"], {"role_id": role["id"]})          # the controller wears the role
    run(x.engine.step(x.rid))
    child = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])["child_id"]
    x.hive.db.update("agents", child, {"role_id": role["id"]})               # and so does the helper (the author)
    helper_finishes(x, 1, SUGGESTION)
    assert x.engine.view(x.rid)["status"] == "needs_you" and "review-unavailable" in kinds(x)


def test_ask_for_changes_is_a_new_think_with_the_persons_words(x, monkeypatch):
    to_ready(x, monkeypatch, [(True, "ok\n"), (True, "ok\n")])
    assert person(x, "changes", {"text": ""}).status_code == 400
    assert person(x, "changes", {"text": "x"}, headers=x.ann).status_code == 403
    out = person(x, "changes", {"text": "Also handle floats, please."})
    assert out.status_code == 200, out.text
    assert out.json()["status"] == "writing" and "dispatched" not in kinds(x)[-3:]   # no forged review
    fail = next(r for r in out.json()["journal"] if r["kind"] == "changes-requested")
    assert fail["evidence"] == {"notes": "Also handle floats, please.", "by": "person"} and '"user:u_jon"' in fail["fields"]
    child = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])["child_id"]
    prompt = x.hive.db.one("SELECT text FROM mind_prompts WHERE child_id = ? AND rev = 2", (child,))["text"]
    assert "The person asked for changes" in prompt and "Also handle floats, please." in prompt
    assert person(x, "changes", {"text": "again"}).status_code == 409        # only while a tested proposal waits
    helper_finishes(x, 2, SUGG2)
    reviewer_finishes(x, "pass")
    assert x.engine.view(x.rid)["candidate"] == SUGG2 and x.engine.view(x.rid)["status"] == "ready_for_you"


def test_discard_cancels_closes_the_goal_and_stops_the_helper(x, monkeypatch):
    fake(x, monkeypatch, [])
    run(x.engine.step(x.rid))
    out = person(x, "discard")
    assert out.status_code == 200, out.text
    view = out.json()
    assert view["phase"] == "stopped" and "cancelled" in kinds(x)
    assert any(e["kind"] == "cleanup" for e in view["effects"])
    req = x.hive.minds._request(x.rid)
    assert x.hive.goals.get(req["receiving_goal"])["status"] == "cancelled"
    assert person(x, "apply").status_code == 409


def test_lease_end_cancels_and_closes_the_receiving_goal(x, monkeypatch):
    fake(x, monkeypatch, [])
    run(x.engine.step(x.rid))
    x.hive.db.execute("UPDATE mind_leases SET until = '2000-01-01T00:00:00Z' WHERE request_id = ?", (x.rid,))
    view = run(x.engine.step(x.rid))
    assert view["phase"] == "stopped" and kinds(x)[-1] == "cancelled"
    req = x.hive.minds._request(x.rid)
    assert x.hive.goals.get(req["receiving_goal"])["status"] == "cancelled"


def test_a_refused_apply_at_code_applies_nothing_and_needs_the_person(x, monkeypatch):
    # the pinned release's production answer: no copy-effect policy adapter, 503 before any edit
    code = to_ready(x, monkeypatch, apply_status=503)
    out = person(x, "apply")
    assert out.status_code == 200, out.text
    # R3.12 (7): a definite no from Code: apply-refused, no debt, ready again (a new Apply uses a new approval)
    assert kinds(x)[-3:] == ["approval-needed", "approved", "apply-refused"] and "applied" not in kinds(x)
    assert out.json()["status"] == "ready_for_you" and code.applied == []
    apply = x.engine._effects(x.rid, "apply")[0]
    assert apply["state"] == "refused" and json.loads(apply["result"])["code"] == "copy_effect_policy_unavailable"


def test_red_past_max_repairs_needs_the_person(x, monkeypatch):
    fake(x, monkeypatch, [(False, "FAIL\n")] * 3)
    run(x.engine.step(x.rid))
    for attempt, sid in ((1, SUGGESTION), (2, SUGG2), (3, "suggestion_" + "2d" * 16)):
        helper_finishes(x, attempt, sid)
    view = x.engine.view(x.rid)
    assert view["phase"] == "blocked" and view["status"] == "needs_you" and kinds(x).count("tests-fail") == 3


def test_cancel_stops_the_run_and_its_helper(x, monkeypatch):
    fake(x, monkeypatch, [])
    run(x.engine.step(x.rid))
    out = x.client.post(f"/api/requests/{x.rid}/cancel", headers=x.jon)
    assert out.status_code == 200, out.text
    view = run(x.engine.on_event({"type": "request.updated", "request": {"id": x.rid}})) or x.engine.view(x.rid)
    assert view["phase"] == "stopped" and "cancelled" in kinds(x)
    assert any(e["kind"] == "cleanup" for e in view["effects"])


# ---- review fixes (e5885f3b APPROVE-WITH-FIXES) --------------------------------------------------------------------

def test_F1_a_refused_dispatch_performs_no_effect_now_or_on_the_next_wake(x, monkeypatch):
    code = fake(x, monkeypatch, [(True, "x\n")])
    calls = []

    async def no_effect(run_row, effect):
        calls.append(json.loads(effect["body"])["run_id"])
        return False
    monkeypatch.setattr(x.engine, "_test_effect", no_effect)
    row = x.engine._run(x.rid)
    run(x.engine.observe(row, "opened", "opened", []))
    # an operation id the task already used once: the reducer refuses its reuse
    assert run(x.engine.observe(row, "earlier", "dispatched", [cce.q("run-2"), "test", cce.q(SUGGESTION)])) == "accepted"
    assert run(x.engine.observe(row, "disp-run-1", "dispatched", [cce.q("run-2"), "test", cce.q(SUGGESTION)])) == \
        ["rejected", "run-id-reused"]
    # the same id and fields again answers the stored refusal, never "duplicate"-as-accepted
    assert run(x.engine.observe(row, "disp-run-1", "dispatched", [cce.q("run-2"), "test", cce.q(SUGGESTION)])) == \
        ["rejected", "run-id-reused"]
    # first wake: run-2 (the journal's count) is refused for reuse; no effect row, no effect
    with pytest.raises(cce.EngineError):
        run(x.engine._test(x.engine._run(x.rid), SUGGESTION))
    assert calls == [] and x.engine._effects(x.rid, "test") == [] and code.calls == []
    # second wake: a fresh id from the journal, never the refused one
    run(x.engine._test(x.engine._run(x.rid), SUGGESTION))
    assert calls == ["run-3"] and [json.loads(e["body"])["run_id"] for e in x.engine._effects(x.rid, "test")] == ["run-3"]


def test_F2_the_effect_row_commits_with_its_journal_row_and_resumes_after_a_restart(x, monkeypatch):
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    # the helper's goal finishes; stop right after the candidate (as if the process died before the test dispatch ran)
    body = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])
    child = x.hive.agent(body["child_id"])
    x.hive.goals.claim(child, body["goal_id"])
    run(x.hive.goals.result(child, body["goal_id"], "done", "r", {"proposal_id": SUGGESTION}))
    with monkeypatch.context() as m:
        m.setattr(x.engine, "_step", lambda rid: asyncio.sleep(0))
        run(x.engine.helper_goal(body["goal_id"]))
    assert kinds(x)[-1] == "candidate-retained" and x.engine._effects(x.rid, "test") == []
    row = x.engine._run(x.rid)
    verdict, effect = run(x.engine.observe(row, "disp-run-1", "dispatched", [cce.q("run-1"), "test", cce.q(SUGGESTION)],
                                           effect=("test", {"run_id": "run-1", "candidate": SUGGESTION,
                                                            "operation_id": f"cce.prep.{x.rid}.1",
                                                            "launch_key": f"cce.run.{x.rid}.1"})))
    assert verdict == "accepted" and effect["state"] == "journaled"                      # one transaction, both rows
    # "restart": the reducer says (rest awaiting-results); the journalled effect resumes with its same ids
    view = run(x.engine.step(x.rid))
    assert kinds(x)[-3:] == ["dispatched", "tests-pass", "dispatched"] and view["status"] == "reviewing"


def test_F3_concurrent_wakes_serialize_on_the_request_lock(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    body = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])
    child = x.hive.agent(body["child_id"])
    x.hive.goals.claim(child, body["goal_id"])
    run(x.hive.goals.result(child, body["goal_id"], "done", "r", {"proposal_id": SUGGESTION}))

    async def both():
        await asyncio.gather(x.engine.helper_goal(body["goal_id"]), x.engine.step(x.rid), x.engine.helper_goal(body["goal_id"]))
    run(both())
    ks = kinds(x)
    assert ks.count("candidate-retained") == 1 and ks.count("tests-pass") == 1 and len(x.engine._effects(x.rid, "test")) == 1


def test_F4_a_dropped_goal_frame_is_found_by_the_sweep_and_handled_as_a_task(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    body = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])
    child = x.hive.agent(body["child_id"])
    x.hive.goals.claim(child, body["goal_id"])
    run(x.hive.goals.result(child, body["goal_id"], "done", "r", {"proposal_id": SUGGESTION}))   # no event delivered

    async def sweep():
        x.engine.sweep()
        await asyncio.gather(*list(x.engine._tasks))
    run(sweep())
    assert "tests-pass" in kinds(x)


def test_F5_startup_wakes_work_in_progress_not_runs_resting_on_the_person(x, monkeypatch):
    to_ready(x, monkeypatch)
    assert x.engine.resume_candidates() == []                      # ready_for_you: no PeTTa child until the person acts
    x.engine._save(x.rid, status="testing")
    assert x.engine.resume_candidates() == [x.rid]


def test_the_journal_is_insert_only_and_ids_are_idempotent(x):
    row = x.engine._run(x.rid)
    assert run(x.engine.observe(row, "opened", "opened", [])) == "accepted"
    assert run(x.engine.observe(row, "opened", "opened", [])) == "accepted"          # the stored verdict
    assert run(x.engine.observe(row, "opened", "read", [])) == ["rejected", "conflicting-duplicate"]
    import sqlite3
    with pytest.raises(sqlite3.DatabaseError):
        x.hive.db.execute("DELETE FROM code_controller_journal WHERE request_id = ?", (x.rid,))


def test_switched_off_keeps_the_controller_mind_path(w):
    assert w.hive.settings.code_controller_engine is False        # shared fixture: HIVE_CODE_CONTROLLER_ENGINE=0
    rq = accepted(w)
    assert w.hive.code_controller.view(rq["request_id"]) is None
    goal = w.hive.goals.get(rq["receiving_goal"])
    assert "code-mind-work" in goal["detail"]


def test_a_reviewer_on_another_team_is_never_sent_the_packet(x, monkeypatch):
    """Review R1: the packet (instruction, hunks, test output) never goes to another team's mind, whatever its role."""
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    no_reviewer_can_run(x)                                            # the Code team's and the bound reviewer are paused
    other = x.client.post("/api/swarms", json={"name": "Elsewhere"}).json()
    outsider = x.client.post("/api/agents", json={"name": "Outside reviewer", "swarm_id": other["id"], "budget_usd": 5}).json()
    x.hive.db.update("agents", outsider["id"], {"role_id": reviewer_role(x)})     # the very same reviewer role
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    view = x.engine.view(x.rid)
    assert view["status"] == "needs_you" and "review-unavailable" in kinds(x)
    assert x.hive.db.one("SELECT COUNT(*) AS n FROM goals WHERE assignee = ?", (outsider["id"],))["n"] == 0


def test_the_helper_reads_its_instruction_with_its_own_tool_never_pasted_into_the_prompt(x, monkeypatch):
    """Jon: no shortcuts. The instruction is not prompt text: the prompt names code-helper-instruction, a no-argument read
    the host answers only for this helper's own request."""
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    run(x.engine.step(x.rid))
    eff = x.hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'helper'", (x.rid,))
    child = json.loads(eff["body"])["child_id"]
    texts = " ".join(r["text"] for r in x.hive.db.all("SELECT text FROM mind_prompts WHERE child_id = ?", (child,)))
    req = x.hive.minds._request(x.rid)
    instruction = (json.loads(req["context_refs"]).get("instruction") or {}).get("text")
    assert "code-helper-instruction" in texts and instruction not in texts and "code-mind-work" not in texts
    out = x.client.get("/api/agent/code/helper-instruction", headers={"Authorization": f"Bearer {x.tokens[child]}"})
    assert out.status_code == 200, out.text
    assert out.json()["request_id"] == x.rid and out.json()["instruction"]["text"] == instruction
    assert out.json()["classification"] == "UNTRUSTED_DATA"
    # no request can be named: a query is ignored, the answer is still the helper's own request
    other = x.client.get("/api/agent/code/helper-instruction?request_id=rq_" + "0" * 32,
                         headers={"Authorization": f"Bearer {x.tokens[child]}"})
    assert other.json()["request_id"] == x.rid
    # never the controller, never another mind
    for agent in (x.ctl, x.helper):
        refused = x.client.get("/api/agent/code/helper-instruction", headers=agent_headers(agent))
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "not_request_helper"


def test_the_engine_acts_as_itself_never_with_a_minds_token(x, monkeypatch):
    code = to_ready(x, monkeypatch)
    assert code.members == {x.engine.credential} and x.ctl["token"] not in code.members
    caps = x.hive.db.all("SELECT * FROM capabilities WHERE json_extract(claims, '$.proposal_test.request_id') = ?", (x.rid,))
    assert caps and {c["issued_by"] for c in caps} == {"host:code-controller-engine"}
    assert all(json.loads(c["claims"])["member_hash"] == hexsha(x.engine.credential.encode()) for c in caps)
    assert all(json.loads(c["claims"])["actor"] == x.ctl["id"] for c in caps)         # the lease's authority, exactly
    child = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])["child_id"]
    assert x.hive.db.one("SELECT by FROM mind_prompts WHERE child_id = ? AND rev = 1", (child,))["by"] == \
        "host:code-controller-engine"
    assert person(x, "apply").status_code == 200
    apply_cap = x.hive.db.one("SELECT * FROM capabilities WHERE json_extract(claims, '$.copy_apply.request_id') = ?", (x.rid,))
    assert apply_cap["issued_by"] == "host:code-controller-engine"
    assert x.engine.credential not in json.dumps(x.engine.view(x.rid))                # never shown, never journalled


def test_the_engine_brief_never_carries_the_controller_minds_energy_line(x, w=None):
    goal = x.hive.goals.get(x.hive.minds._request(x.rid)["receiving_goal"])
    assert "set-energy-mode" not in goal["detail"] and "host coding controller" in goal["detail"]


def test_no_brief_carries_the_energy_line_even_with_the_engine_off(w):
    rq = accepted(w)
    detail = w.hive.goals.get(rq["receiving_goal"])["detail"]
    assert "set-energy-mode" not in detail and "code-mind-work" in detail


def test_the_review_packet_carries_the_diff_with_context_the_test_command_and_the_test_file(x, monkeypatch):
    fake(x, monkeypatch, [(True, "calculator passed\n")])
    reviewer = add_reviewer(x)
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    packet = x.hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller'",
                           (reviewer["id"],))["text"]
    data = json.loads(packet.split("UNTRUSTED_DATA:\n", 1)[1])
    diff = data["diffs"][0]
    assert diff["path"] == "calculator.py" and diff["note"] is None
    assert "-    return a - b" in diff["diff"] and "+    return a + b" in diff["diff"] and " def add(a, b):" in diff["diff"]
    assert data["test"]["argv"] == [EXE, "test_calculator.py"] and data["test"]["exit_code"] == 0
    assert data["test"]["stdout"] == "calculator passed\n"
    assert data["test"]["files"] == [{"path": "test_calculator.py", "content": FILES["test_calculator.py"], "truncated": False}]
    assert data["instruction"] == "Make add() handle negatives."


def test_a_test_file_outside_the_persons_scope_is_said_not_shown(x, monkeypatch):
    code = fake(x, monkeypatch, [(True, "calculator passed\n")])
    code.unreadable.add("test_calculator.py")
    reviewer = add_reviewer(x)
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    packet = x.hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:code-controller'",
                           (reviewer["id"],))["text"]
    files = json.loads(packet.split("UNTRUSTED_DATA:\n", 1)[1])["test"]["files"]
    assert files == [{"path": "test_calculator.py", "content": None,
                      "note": "not shown: the person's read scope does not cover this file"}]


def test_an_unknown_apply_proven_landed_by_codes_application_is_applied_confirmed_and_delivers(x, monkeypatch):
    code = to_ready(x, monkeypatch, apply_status="garbled")
    out = person(x, "apply")
    assert out.status_code == 200, out.text
    tail = out.json()["journal"][-2:]
    assert [r["kind"] for r in tail] == ["unknown", "applied-confirmed"]          # R3.13: no host-only hold
    assert tail[1]["fields"] == f'("apply-1" "{SUGGESTION}" "application_{"ab" * 16}")'
    assert tail[1]["evidence"]["applied"] is True and out.json()["status"] == "applied" and out.json()["phase"] == "delivered"
    assert len(x.engine._effects(x.rid, "helper")) == 1                          # nothing was rewritten
    assert ("proxy", "GET", f"/v1/workspaces/{WS_OF(x)}/proposal-applications/application_{'ab' * 16}") in code.calls
    assert x.hive.goals.get(x.hive.minds._request(x.rid)["receiving_goal"])["status"] == "done"


def test_a_lost_apply_reads_the_workspace_back_and_an_unmoved_one_proves_nothing_was_applied(x, monkeypatch):
    code = to_ready(x, monkeypatch, apply_status="lost")
    out = person(x, "apply")
    # R3.13: proven not landed and the candidate still the origin's: reconciled-not-applied, ready again (re-approve)
    rec = next(r for r in out.json()["journal"] if r["kind"] == "reconciled-not-applied")
    assert rec["evidence"]["applied"] is False and rec["evidence"]["workspace"]["generation"] == 1
    assert rec["verdict"] == "accepted" and out.json()["status"] == "ready_for_you"
    assert ("proxy", "GET", f"/v1/workspaces/{WS_OF(x)}") in code.calls
    assert len(x.engine._effects(x.rid, "helper")) == 1 and kinds(x).count("tests-pass") == 1


def _journal_apply_without_effect(x):
    """What the Apply route writes before the effect (consent, approval-needed, approved + its effect row), then stops:
    the state a crash between the journal and the effect leaves."""
    view = x.engine.view(x.rid)
    cand = view["candidate"]
    ev = x.engine._evidence(x.rid, f"cand-{cand}")
    digest = ev["proposal"]["proposal_digest"].removeprefix("sha256:")
    x.hive.minds.copy_apply_consent("user:u_jon", x.rid, cand, {"suggestion_digest": digest}, "accept")
    row = x.engine._run(x.rid)
    assert run(x.engine.observe(row, "approval-needed-apply-1", "approval-needed", [cce.q("apply-1")])) == "accepted"
    verdict, effect = run(x.engine.observe(row, "approved-apply-1", "approved", [cce.q("apply-1"), cce.q("user:u_jon")],
                                           effect=("apply", {"op": "apply-1", "candidate": cand, "digest": digest,
                                                             "expected": {"generation": ev["parent"]["generation"],
                                                                          "tree_digest": ev["parent"]["tree_digest"].removeprefix("sha256:")}})))
    assert verdict == "accepted" and effect["state"] == "journaled"
    return effect


def test_a_journalled_apply_resumes_after_a_restart(x, monkeypatch):
    code = to_ready(x, monkeypatch)
    _journal_apply_without_effect(x)
    assert code.applied == []
    view = run(x.engine.step(x.rid))                                     # "restart": the reducer rests on the apply
    assert view["status"] == "applied" and len(code.applied) == 1 and kinds(x)[-1] == "applied"


def test_an_apply_interrupted_mid_flight_becomes_unknown_never_a_second_post(x, monkeypatch):
    code = to_ready(x, monkeypatch)
    effect = _journal_apply_without_effect(x)
    x.engine._effect_set(effect["id"], "dispatching")                   # it may have reached Code before the crash
    run(x.engine.step(x.rid))
    assert kinds(x)[-2:] == ["unknown", "reconciled-not-applied"] and x.engine.view(x.rid)["status"] == "ready_for_you"
    assert code.applied == [] and not [c for c in code.calls if c[2].endswith("/proposal-applications")]


# ---- R3.12 mapping and the Create UI's typed events ----------------------------------------------------------------

def test_a_failed_helper_attempt_is_think_failed_one_repair_and_the_helper_is_asked_again(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    run(x.engine.step(x.rid))
    body = json.loads(x.engine._effects(x.rid, "helper")[0]["body"])
    child = x.hive.agent(body["child_id"])
    x.hive.goals.claim(child, body["goal_id"])
    run(x.hive.goals.result(child, body["goal_id"], "failed", "could not do it"))
    run(x.engine.on_event({"type": "goal.updated", "goal": {"id": body["goal_id"]}}))
    ks = kinds(x)
    assert "refused" not in ks and ks[-2:] == ["think-failed", "think-started"]      # never straight to blocked
    view = x.engine.view(x.rid)
    assert view["status"] == "writing" and len(x.engine._effects(x.rid, "helper")) == 2
    assert json.loads(x.engine._effects(x.rid, "helper")[1]["body"])["child_id"] == body["child_id"]   # re-prompted


def test_the_reducer_enforces_the_author_set_a_helper_never_passes_its_own_review(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    body = helper_finishes(x, 1, SUGGESTION)
    row = x.engine._run(x.rid)
    assert body["child_id"] in x.engine._authors(row) and x.ctl["id"] in x.engine._authors(row)
    rq = json.loads(x.engine._effects(x.rid, "review")[0]["body"])["request"]
    forged = run(x.engine.observe(row, "forged-pass", "review-pass", [cce.q(SUGGESTION), cce.q(body["child_id"]), cce.q(rq)]))
    assert forged[0] == "rejected"


def test_typed_controller_events_for_the_create_ui(x, monkeypatch):
    seen = []
    real = x.hive.events.publish
    monkeypatch.setattr(x.hive.events, "publish", lambda kind, **kw: (seen.append((kind, kw)), real(kind, **kw)))
    to_ready(x, monkeypatch)
    statuses = [kw for kind, kw in seen if kind == "code.controller.status"]
    assert statuses and all(set(kw) == {"request_id", "status", "phase", "candidate"} for kw in statuses)
    assert statuses[-1]["status"] == "ready_for_you" and statuses[-1]["candidate"] == SUGGESTION
    assert len({(s["status"], s["phase"], s["candidate"]) for s in statuses}) == len(statuses)   # one per change
    assert person(x, "apply").status_code == 200
    applied = [kw for kind, kw in seen if kind == "code.controller.applied"]
    assert applied == [{"request_id": x.rid, "candidate": SUGGESTION, "workspace_id": WS_OF(x), "paths": ["calculator.py"],
                        "application_id": "application_" + "ab" * 16, "after": {"generation": 2, "tree_digest": "c4" * 32}}]


# ---- review of 12f4292f (APPROVE-WITH-FIXES) -----------------------------------------------------------------------

def test_a_moved_workspace_with_unchanged_files_proves_nothing_landed(x, monkeypatch):
    code = to_ready(x, monkeypatch, apply_status="lost")
    code.ws_generation = 2                                   # someone else moved the workspace; our file is untouched
    out = person(x, "apply").json()
    rec = next(r for r in out["journal"] if r["kind"] == "reconciled-not-applied")
    assert rec["evidence"]["applied"] is False and rec["evidence"]["files"] == [{"path": "calculator.py", "shows": "original"}]


def test_an_inconclusive_readback_journals_nothing_retries_and_never_rethinks(x, monkeypatch):
    code = to_ready(x, monkeypatch, apply_status="lost")
    code.ws_generation, code.files = 2, {"calculator.py": CALCULATOR.replace("a - b", "a + b")}
    helpers = len(x.engine._effects(x.rid, "helper"))
    out = person(x, "apply").json()
    assert kinds(x)[-1] == "unknown" and out["status"] == "checking" and "may have landed" in out["last_error"]
    assert out["next_action"] == '(do (reconcile "apply-1"))'
    assert run(x.engine.step(x.rid))["status"] == "checking" and kinds(x)[-1] == "unknown"     # retried, still nothing
    assert len(x.engine._effects(x.rid, "helper")) == helpers and "think-started" not in kinds(x)[-3:]
    for action, body in (("changes", {"text": "x"}), ("apply", None)):
        assert person(x, action, body).json()["error"]["code"] == "outcome_unresolved", action
    # the readback settles once Code names the application: the same apply is confirmed and the run delivered
    code.applications["application_" + "ab" * 16] = {"id": "application_" + "ab" * 16, "suggestion_id": SUGGESTION,
                                                     "after_generation": 2, "after_tree_digest": "c4" * 32}
    eff = x.engine._effects(x.rid, "apply")[0]
    x.engine._effect_set(eff["id"], "unknown", {"application_id": "application_" + "ab" * 16})
    assert run(x.engine.step(x.rid))["status"] == "applied" and kinds(x)[-1] == "applied-confirmed"


def test_a_helpers_role_rules_are_written_with_its_row_before_finish_agent(x, monkeypatch):
    role = x.hive.foundation.helper_role()["id"]
    x.hive.minds.templates["native-a"] = dict(x.hive.minds.templates["native-a"], role_id=role)
    fake(x, monkeypatch, [])
    seen = []
    real = x.hive.finish_agent

    def spy(row, token, role_row, by=None):
        seen.append([r["skill"] for r in x.hive.policy.all_rules() if r["scope"] == "agent:" + row["id"]
                     and r["note"] == "role:Foundation request helper"])
        return real(row, token, role_row, by=by)
    monkeypatch.setattr(x.hive, "finish_agent", spy)
    run(x.engine.step(x.rid))
    assert seen and "code-open" in seen[0] and "code-helper-instruction" in seen[0]   # present at commit, not after


def test_a_reviewer_goal_that_fails_is_a_definite_review_fail_never_unknown(x, monkeypatch):
    fake(x, monkeypatch, [(True, "ok\n")])
    add_reviewer(x)
    run(x.engine.step(x.rid))
    helper_finishes(x, 1, SUGGESTION)
    eff = x.hive.db.one("SELECT body FROM code_controller_effects WHERE request_id = ? AND kind = 'review'", (x.rid,))
    body = json.loads(eff["body"])
    agent = x.hive.agent(body["reviewer_id"])
    x.hive.goals.claim(agent, body["goal_id"])
    run(x.hive.goals.result(agent, body["goal_id"], "failed", "cannot judge this without the module's tests"))
    run(x.engine.on_event({"type": "goal.updated", "goal": {"id": body["goal_id"]}}))
    fail = next(r for r in x.engine.view(x.rid)["journal"] if r["kind"] == "review-fail")
    assert "unknown" not in kinds(x) and fail["evidence"]["goal_status"] == "failed"
    assert "cannot judge this" in fail["evidence"]["notes"]


def test_runs_journalled_under_the_old_reducer_bytes_replay_under_the_new(tmp_path):
    """2026-11-09: only the reducers' header comment changed (mirror scrub); old shas alias to the new files."""
    from hive.core import code_controller_engine as cce
    for old, new in cce.REDUCER_SHA_ALIASES.items():
        assert new in cce.REDUCERS and old not in cce.REDUCERS
