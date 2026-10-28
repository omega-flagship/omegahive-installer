"""Share text read in parts survives the mind's actual context path, byte-exact (Truth's requirement).

The path a skill result takes into the next prompt: the loop stores (string-safe (repr $results)) and the
prompt shows helper.context_last_results(..., 5000), which keeps only the TAIL. Every part, read one per step,
must arrive whole, and the parts must reassemble to the exact bytes and digest. Uses real PeTTa for repr.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "modules" / "hive" / "src" / "hive_commons.py"
spec = importlib.util.spec_from_file_location("hive_commons_body", SRC)
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)
sys.path.insert(0, str(ROOT / "src"))
import helper_metta  # noqa: E402

PETTA = os.environ.get("PETTA_PATH")


def petta():
    if not PETTA:
        pytest.skip("PETTA_PATH not set")
    sys.path.insert(0, str(pathlib.Path(PETTA) / "python"))
    from petta import PeTTa
    return PeTTa()


def metta_string(text):
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


BODY = json.dumps({"graph": {"focus": "q-55dd2b64", "nodes": [
    {"id": f"h{i}-55dd2b64", "kind": "hypothesis", "text": f"Hypothesis {i}: growth is driven by factor {i}; it's \"likely\" if 100% of\nplots agree — naïve ✓"}
    for i in range(1, 25)] + [{"id": "hl-55dd2b64", "kind": "hypothesis", "text": "TAIL hypothesis: light, not nutrients; check ';' and \\ too"}]}},
    ensure_ascii=False, indent=1)


def string_safe(text):
    """src/utils.metta string-safe, replacement for replacement (its string-replace needs the OmegaClaw lib,
    which a bare PeTTa does not load; repr above is real PeTTa)."""
    return text.replace('""', "_quote_").replace("\n", "_newline_").replace("'", "_apostrophe_")


def test_every_part_survives_the_harness_and_reassembles_exactly(monkeypatch):
    p = petta()

    def fake_call(method, path, payload=None):
        return {"share_id": "sh_1", "owner": "Truth", "kind": "exhibit", "title": "Q", "body": BODY, "atoms": [],
                "total": 0, "next_offset": None, "expires_at": "later"}, None
    monkeypatch.setattr(hc, "_call", fake_call)

    first = hc.shared("sh_1", "*")
    assert "NOT SHOWN HERE" in first and "hive-shared-body sh_1 1" in first
    n_parts = int(re.search(r"in (\d+) parts", first).group(1))
    assert n_parts >= 3

    recovered, part = [], 1
    while True:
        out = hc.shared_body("sh_1", part)          # what the skill returns (after the ';' membrane)
        # what the loop stores and the next prompt shows: real repr, string-safe, then the 5000-char tail
        expr = f'!(repr ((COMMAND_RETURN: ((hive-shared-body "sh_1" {part}) {metta_string(out)}))))'
        stored = string_safe(p.process_metta_string(expr)[0])
        view = helper_metta.context_last_results(stored, 5000)
        assert "RESULTS-CONTEXT-TRUNCATED" not in view, f"part {part} did not fit"
        m = re.search(rf"BEGIN-PART {part}(?:_newline_|\\\\n|\n)(.*?)(?:_newline_|\\\\n|\n)END-PART {part}", view)
        assert m, f"part {part} markers lost"
        payload = m.group(1)
        assert not re.search(r"""["'\;\n]""", payload)        # nothing the harness rewrites
        recovered.append(payload)
        assert f"part={part}/{n_parts}" in view
        assert "COMPLETE" not in view
        if "END-OF-BODY" in view:
            break
        part += 1
    assert part == n_parts
    text = hc.pct_decode("".join(recovered))
    assert text.encode() == BODY.encode()
    head = re.search(r"sha256:([0-9a-f]{64})", hc.shared_body("sh_1", 1)).group(1)
    assert hashlib.sha256(text.encode()).hexdigest() == head
    assert "TAIL hypothesis" in text


def test_short_texts_stay_inline_and_bad_parts_are_refused(monkeypatch):
    monkeypatch.setattr(hc, "_call", lambda *a, **k: ({"share_id": "sh_2", "owner": "o", "kind": "exhibit", "title": "t", "body": "short",
                                                       "atoms": [], "total": 0, "next_offset": None, "expires_at": "x"}, None))
    assert "text: short" in hc.shared("sh_2", "*")
    assert hc.shared_body("sh_2", 2).startswith("HIVE-ERROR")
    assert "END-OF-BODY: last part 1/1" in hc.shared_body("sh_2", 1)


def test_jumping_to_the_last_part_never_claims_a_full_read(monkeypatch):
    monkeypatch.setattr(hc, "_call", lambda *a, **k: ({"share_id": "sh_3", "owner": "o", "kind": "exhibit", "title": "t", "body": BODY,
                                                       "atoms": [], "total": 0, "next_offset": None, "expires_at": "x"}, None))
    n = len(hc.body_parts(BODY))
    last = hc.shared_body("sh_3", n)
    assert f"END-OF-BODY: last part {n}/{n}" in last and "complete only if you have all" in last
    assert "COMPLETE" not in last and "all parts read" not in last


def test_a_revision_body_can_be_a_json_object_without_double_escaping(monkeypatch):
    sent = {}

    def fake_call(method, path, payload=None):
        sent.update(payload)
        return {"n": 1, "digest": "sha256:x", "changed_steps": [], "affected_steps": [], "whole_plan_in_scope": True}, None
    monkeypatch.setattr(hc, "_call", fake_call)
    spec = {"profile": "editorial-deck-v1", "slides": [{"title": "Café", "paragraphs": ["a \"quoted\" line"]}]}
    out = hc.revision("ar_1", json.dumps({"body": spec, "parent": None}))
    assert out.startswith("HIVE-REVISION ar_1 r1") and isinstance(sent["body"], str) and json.loads(sent["body"]) == spec
    hc.revision("ar_1", json.dumps({"body": "plain text", "parent": 1}))
    assert sent["body"] == "plain text"


def test_goal_get_shows_the_task_detail_and_deadline(monkeypatch):
    goal = {"id": "g_1", "status": "open", "title": "Deck", "assignee": None, "binding": {"request_id": "rq_1"},
            "binding_digest": "sha256:b", "deadline_at": "2026-10-04T02:18:00Z", "detail": "Steps:\n1. claim it"}
    monkeypatch.setattr(hc, "_call", lambda method, path, payload=None: (goal, None))
    out = hc.goal_get("g_1")
    assert out.startswith("HIVE-GOAL g_1 open Deck") and "deadline=2026-10-04T02:18:00Z" in out and out.endswith("DETAIL:\nSteps:\n1. claim it")
    goal["detail"] = "x" * 6000
    out = hc.goal_get("g_1")
    assert "detail cut at 4500 of 6000 characters" in out and len(out) < 5000
    goal["detail"] = ""
    assert "DETAIL" not in hc.goal_get("g_1")
