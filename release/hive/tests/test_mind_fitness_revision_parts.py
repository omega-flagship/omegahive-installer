"""Mind fitness fix 5 (2026-10-06): revision bodies longer than one model turn go up in parts.

2026-10-04: four Design revisions of 8-9k characters were refused as unterminated JSON. They were not cut by an
argument limit: each turn ended at exactly maxOutputToken (usage completion_tokens=6000). A body is now staged in
parts in the mind's own memory folder and posted whole, byte for byte, by one hive-revision."""
import importlib.util
import json
import pathlib
import sys

import pytest

from hive.core.policy import REVIEWED_HIVE_SKILLS
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
import helper_command_parser as parser  # noqa: E402

_spec = importlib.util.spec_from_file_location("hive_commons_parts", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)

SCENE = json.dumps({"schema": "omega-scene-1", "id": "opening-c", "title": "Direction C: three small verbs",
                    "elements": [{"id": f"t{i}", "kind": "text", "text": f"Join your neighbours; trial planting {i} — ünïcode",
                                  "fontSize": 32, "color": "#2F6B3C"} for i in range(120)]}, ensure_ascii=False)


@pytest.fixture
def memory(tmp_path, monkeypatch):
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    return tmp_path


def _stage(art, body, size=5000):
    parts = [body[i:i + size] for i in range(0, len(body), size)]
    outs = [hc.revision_part(art, i, hc.encode(p)) for i, p in enumerate(parts, 1)]   # as the mind sends them: ';' encoded
    return parts, outs


def test_a_long_body_goes_up_in_parts_and_is_stored_exactly(client, memory, monkeypatch):
    swarm = client.post("/api/swarms", json={"name": "Design"}).json()
    maker = client.post("/api/agents", json={"name": "Maker", "kind": "module", "swarm_id": swarm["id"]}).json()

    def through_the_hive(method, path, payload=None):
        r = client.request(method, path, headers=agent_headers(maker), json=payload)
        return (r.json(), None) if r.status_code < 400 else (None, f"HIVE-ERROR {r.json()['error']['code']}: {r.json()['error']['message']}")
    monkeypatch.setattr(hc, "_call", through_the_hive)
    art = client.request("POST", "/api/agent/artifacts", headers=agent_headers(maker), json={"kind": "scene", "title": "Opening"}).json()["id"]
    assert len(SCENE) > 9000
    parts, outs = _stage(art, SCENE)
    n = len(parts)
    assert n >= 2 and all(o.startswith(f"HIVE-REVISION-PART {art} part ") for o in outs)
    assert f'"body_parts": {n}' in outs[-1]
    out = hc.revision(art, json.dumps({"parent": None, "body_parts": n}))
    assert out.startswith(f"HIVE-REVISION {art} r1 sha256:"), out
    stored = client.request("GET", f"/api/agent/artifacts/{art}/revisions/1", headers=agent_headers(maker)).json()
    assert stored["body"] == SCENE                                   # byte for byte, ';' and unicode included
    assert not (memory / "revision_parts" / art).exists()            # posted: the staged parts are gone
    # a refused post keeps the parts so the mind can retry with the right parent
    _stage(art, SCENE)
    refused = hc.revision(art, json.dumps({"parent": None, "body_parts": n}))
    assert "stale_parent" in refused and (memory / "revision_parts" / art / f"{n}.txt").exists()
    assert hc.revision(art, json.dumps({"parent": 1, "body_parts": n})).startswith(f"HIVE-REVISION {art} r2")


def test_parts_are_bounded_and_named_plainly(memory):
    assert "part number is 1 to 32" in hc.revision_part("ar_x", 0, "a")
    assert "part number is 1 to 32" in hc.revision_part("ar_x", 33, "a")
    assert "part number is 1 to 32" in hc.revision_part("ar_x", "two", "a")
    assert "1 to 12000 characters" in hc.revision_part("ar_x", 1, "")
    assert "1 to 12000 characters" in hc.revision_part("ar_x", 1, "x" * 12001)
    for bad in ("../escape", "ar x", "", "a/b"):
        assert "the artifact is an id" in hc.revision_part(bad, 1, "a"), bad
    for i in range(1, 22):                                           # 21 x 12000 bytes fits in 256 KB, 22 does not
        assert hc.revision_part("ar_big", i, "y" * 12000).startswith("HIVE-REVISION-PART"), i
    assert "too_large" in hc.revision_part("ar_big", 22, "y" * 12000)
    assert not (memory / "revision_parts" / "ar_big" / "22.txt").exists()


def test_part_one_starts_over_and_missing_parts_are_named(memory):
    hc.revision_part("ar_y", 1, "a")
    hc.revision_part("ar_y", 2, "b")
    hc.revision_part("ar_y", 3, "c")
    hc.revision_part("ar_y", 1, "fresh")
    assert sorted(p.name for p in (memory / "revision_parts" / "ar_y").iterdir()) == ["1.txt"]
    hc.revision_part("ar_y", 3, "c")
    assert "held for ar_y: [1, 3]" in hc.revision("ar_y", json.dumps({"parent": 1, "body_parts": 3}))
    assert "held for ar_y: [1, 3]" in hc.revision("ar_y", json.dumps({"parent": 1, "body_parts": 1}))
    assert "held for ar_z: none" in hc.revision("ar_z", json.dumps({"parent": 1, "body_parts": 2}))


def test_a_cut_off_json_body_says_how_to_send_it_in_parts():
    cut = '{"parent": 1, "body": "' + SCENE.replace('"', '\\"')[:8600]
    out = hc.revision("ar_q", cut)
    assert out.startswith("HIVE-ERROR bad_request: give a JSON object (Unterminated string")
    assert "hive-revision-part ar_q 1 <text>" in out and '"body_parts": <number of parts>' in out
    assert "hive-revision-part" not in hc.revision("ar_q", '{"parent": 1, "body": ')   # a short slip gets the short reply


def test_the_skill_is_declared_reviewed_local_and_parses_with_its_text_intact():
    for path, needle in ((ROOT / "modules/hive/signatures.metta", "(SkillSignature hive-revision-part (Arg text artifact) (Arg number n) (Arg rest-text text))"),
                         (ROOT / "modules/hive/skills.metta", "(py-call (hive_commons.revision_part $id $n $text))"),
                         (ROOT / "modules/hive/entry.metta", "(Provides omegaclaw.hive.commons (Skill hive-revision-part))"),
                         (ROOT / "modules/hive/module.toml", '"skill:hive-revision-part"'),
                         (ROOT / "modules/hive/catalog.metta", '(SkillHelp "hive-revision-part"')):
        assert needle in path.read_text(encoding="utf-8"), path
    assert "hive-revision-part" in REVIEWED_HIVE_SKILLS and "hive-revision-part" in hc.LOCAL_ALLOW and "revision_part" in hc.SKILLS
    parsed = parser.signature_balance_parentheses('hive-revision-part ar_3c4d 2 {"text": "Join your neighbours", "x": 80}')
    assert parsed == '((hive-revision-part "ar_3c4d" 2 "{\\"text\\": \\"Join your neighbours\\", \\"x\\": 80}"))', parsed
