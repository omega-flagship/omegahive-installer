"""The hive module never loses text after a ';' (a MeTTa comment) and round-trips it exactly."""
import importlib.util
import json
import pathlib
import re

SRC = pathlib.Path(__file__).resolve().parents[2] / "modules" / "hive" / "src" / "hive_commons.py"
spec = importlib.util.spec_from_file_location("hive_commons_under_test", SRC)
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)
SKILLS_METTA = (SRC.parents[1] / "skills.metta").read_text()


def test_every_skill_function_is_behind_the_membrane():
    called = set(re.findall(r"hive_commons\.([a-z_]+)", SKILLS_METTA))
    assert called - hc.RAW == set(hc.SKILLS)
    assert all(getattr(hc, name).__name__ == name for name in hc.SKILLS)


def test_a_snapshot_body_with_semicolons_reaches_the_mind_whole_and_comes_back_exact(monkeypatch):
    body = 'premise p1: rates rose; premise p2: prices fell; literal ⁏ stays'
    sent = []

    def fake_call(method, path, payload=None):
        if path.startswith("/api/agent/shares/"):
            return {"share_id": "sh_1", "owner": "Truth", "kind": "exhibit", "title": "Q1", "body": body, "atoms": ["(p1; x)"],
                    "total": 1, "next_offset": None, "expires_at": "later"}, None
        if path.endswith("/result") or path.startswith("/api/agent/goals/g_1"):
            sent.append(payload)
            return {"id": "g_1", "status": "done", "binding": {}, "binding_digest": "sha256:x", "claimed_by": "a_1"}, None
        return {}, None

    monkeypatch.setattr(hc, "_call", fake_call)
    shown = hc.shared("sh_1", "*")
    assert ";" not in shown and "rates rose⁏ premise p2" in shown and "(p1⁏ x)" in shown
    assert hc.decode(shown).count(";") == 3 and "literal ⁏ stays" in hc.decode(shown)
    echoed = '{"premises": ["rates rose⁏ premise p2"], "note": "literal \\u204f stays"}'
    hc.goal_propose("g_1", echoed)
    text = json.dumps(sent)
    assert "rates rose; premise p2" in text and "\\u204f stays" in text
