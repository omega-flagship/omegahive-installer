"""Mind fitness fix 3 (2026-10-06): finding and review-result refusals explain themselves.

2026-10-04 review trial: 244 hive-finding calls, 13 accepted. 108 failed "give a JSON object", 44 invalid_target and
42 evidence_scope, none saying what would have worked. Every refusal now carries the shape and, once the mind holds
the request, a corrected example built from it: posting that example as it stands is accepted."""
import importlib.util
import json
import pathlib
import re

from hive.core import collab
from hive.tests.test_collab import PLAN1, call, held_goal, mind
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hive_commons_feedback", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)
MANDATE = {"id": "security", "version": "1"}


def _setup(client):
    R, P, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("FbReq", "FbPlan", "FbRev"))
    p, v = mind(client, P, "Planner"), mind(client, V, "Sec", MANDATE)
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    gP = held_goal(client, P, p)
    art = call(client, p, "POST", "/api/agent/artifacts", {"kind": "plan", "title": "t"}).json()
    call(client, p, "POST", f"/api/agent/artifacts/{art['id']}/revisions", {"body": json.dumps(PLAN1), "parent": None})
    rq = call(client, p, "POST", "/api/agent/requests", {"kind": "review", "to_swarm": V["id"], "title": "r", "from_goal": gP["id"],
                                                        "subject": {"artifact_id": art["id"], "revision": 1}, "context_refs": ["ev:notes"],
                                                        "constraints": {"mandates": [MANDATE]}}).json()
    call(client, v, "POST", f"/api/agent/goals/{rq['receiving_goal']}/claim")
    return rq, v


def _example(message, skill):
    found = re.search(rf"Corrected example: {skill} (?:\S+ )?(\{{.*\}})$", message)
    assert found, message
    return json.loads(found.group(1))


def _finding(client, v, body):
    return call(client, v, "POST", "/api/agent/findings", body)


def test_a_wrong_step_names_the_real_steps_and_its_corrected_example_is_accepted(client):
    rq, v = _setup(client)
    bad = _finding(client, v, {"request_id": rq["id"], "mandate": MANDATE, "target": {"step": "step-1"},
                               "severity": "major", "recommendation": "threat model first"})
    error = bad.json()["error"]
    assert bad.status_code == 400 and error["code"] == "invalid_target"
    assert 'the steps of r1 are ["s1", "s2", "s3"]' in error["message"] and collab.FINDING_SHAPE in error["message"]
    example = _example(error["message"], "hive-finding")
    assert example["recommendation"] == "threat model first" and example["target"] == {"step": "s1"}
    assert collab.finding_shape_problems(example) == []
    assert _finding(client, v, example).status_code == 200


def test_unexhibited_evidence_lists_what_was_exhibited_and_the_example_is_accepted(client):
    rq, v = _setup(client)
    bad = _finding(client, v, {"request_id": rq["id"], "mandate": MANDATE, "target": {"step": "s2"}, "severity": "minor",
                               "recommendation": "x", "evidence_refs": ["synthetic-evidence-2"]})
    error = bad.json()["error"]
    assert error["code"] == "evidence_scope" and 'it exhibited ["ev:notes"]' in error["message"]
    assert _finding(client, v, _example(error["message"], "hive-finding")).status_code == 200


def test_a_wrong_mandate_names_the_assigned_one(client):
    rq, v = _setup(client)
    bad = _finding(client, v, {"request_id": rq["id"], "mandate": {"id": "alternatives", "version": "1"}, "target": {"step": "s1"},
                               "severity": "major", "recommendation": "x"})
    error = bad.json()["error"]
    assert error["code"] == "mandate_unassigned" and json.dumps([MANDATE]) in error["message"]
    assert _example(error["message"], "hive-finding")["mandate"] == MANDATE


def test_harmless_variants_are_accepted_as_their_canonical_form(client):
    rq, v = _setup(client)
    out = _finding(client, v, {"request_id": rq["receiving_goal"],                  # the goal id the mind holds
                               "mandate": {"id": "security", "version": 1},          # version as a number
                               "target": {"step": "s1"}, "severity": " Major ",      # case and spaces
                               "recommendation": "x", "evidence_refs": "ev:notes"})  # one reference as text
    assert out.status_code == 200, out.text
    f = out.json()
    assert f["request_id"] == rq["id"] and f["mandate"] == MANDATE and f["severity"] == "major" and f["evidence_refs"] == ["ev:notes"]


def test_required_fields_are_still_required_and_the_target_shape_stays_exact(client):
    rq, v = _setup(client)
    base = {"request_id": rq["id"], "mandate": MANDATE, "target": {"step": "s1"}, "severity": "major", "recommendation": "x"}
    for missing in ("mandate", "recommendation", "severity", "target"):
        body = {k: val for k, val in base.items() if k != missing}
        response = _finding(client, v, body)
        assert response.status_code in (400, 403), missing
        assert collab.FINDING_SHAPE in response.json()["error"]["message"], missing
    for target in ("s1", "whole", {"whole": "true"}):
        assert _finding(client, v, dict(base, target=target)).status_code == 400, target
    assert _finding(client, v, dict(base, evidence_refs="")).json()["error"]["code"] == "evidence_scope"
    assert _finding(client, v, dict(base, severity="critical")).status_code == 400
    assert _finding(client, v, dict(base, execute=True)).json()["error"]["code"] == "no_execution"
    nope = _finding(client, v, dict(base, request_id="synthetic-booking-rollout-issue-1"))
    assert nope.status_code == 404 and "hive-goal-get" in nope.json()["error"]["message"]


def test_a_refused_review_result_shows_the_findings_to_list_and_its_example_is_accepted(client):
    rq, v = _setup(client)
    f1 = _finding(client, v, {"request_id": rq["id"], "mandate": MANDATE, "target": {"step": "s1"}, "severity": "major",
                              "recommendation": "threat model"}).json()
    url = f"/api/agent/requests/{rq['id']}/review-complete"
    bad = call(client, v, "POST", url, {"recommendation": "request changes", "rationale": "s1 lacks a threat model"})
    error = bad.json()["error"]
    assert bad.status_code == 400 and collab.REVIEW_SHAPE in error["message"]
    example = _example(error["message"], "hive-review-complete")
    assert example["finding_ids"] == [f1["id"]] and example["rationale"] == "s1 lacks a threat model"
    assert collab.review_shape_problems(example) == []
    done = call(client, v, "POST", f"/api/agent/requests/{rq['receiving_goal']}/review-complete", example)   # by goal id too
    assert done.status_code == 200, done.text
    assert done.json()["receipt"]["findings"][0]["id"] == f1["id"]


def test_one_finding_id_and_one_coverage_text_are_taken_as_lists(client):
    rq, v = _setup(client)
    f1 = _finding(client, v, {"request_id": rq["id"], "mandate": MANDATE, "target": {"step": "s1"}, "severity": "minor",
                              "recommendation": "x"}).json()
    out = call(client, v, "POST", f"/api/agent/requests/{rq['id']}/review-complete",
               {"recommendation": "Revise", "rationale": "r", "finding_ids": f1["id"], "coverage": "s1"})
    assert out.status_code == 200, out.text
    receipt = out.json()["receipt"]
    assert receipt["recommendation"] == "revise" and receipt["coverage"] == ["s1"] and receipt["findings"][0]["id"] == f1["id"]


def test_a_reply_that_is_not_json_shows_the_shape_and_an_example_that_is_well_formed():
    for skill, args, shape, example, check in (
            ("finding", ("synthetic-issue-1 major Step s1 exports contacts",), hc.FINDING_SHAPE, hc.FINDING_EXAMPLE,
             collab.finding_shape_problems),
            ("review_complete", ("rq_1", "request_id:rq_1 recommendation:revise"), hc.REVIEW_SHAPE, hc.REVIEW_EXAMPLE,
             collab.review_shape_problems)):
        out = getattr(hc, skill)(*args)
        assert out.startswith("HIVE-ERROR bad_request: give a JSON object") and shape in out and example in out, out
        assert check(json.loads(example[example.index("{"):])) == []
    assert hc.FINDING_SHAPE == collab.FINDING_SHAPE and hc.REVIEW_SHAPE == collab.REVIEW_SHAPE
    assert "Expected" not in hc.request("not json")   # other JSON skills keep their short reply
