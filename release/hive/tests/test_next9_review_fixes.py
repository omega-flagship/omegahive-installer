"""OmegaReview next9 FIX-FIRST (2026-10-05): B1 reads write nothing, B2 file intents retain metadata only,
B3 non-finite JSON is undeliverable and admits no one."""
import base64
import json

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person
from hive.tests.test_program_confirm import confirmed

APP = """
import asyncio
SAW = []

def describe():
    return {"contract": "0.2", "kinds": [{"id": "k", "label": "K", "role": "claim"}], "relations": [],
            "reads": [{"id": "write-goal"}, {"id": "write-exhibit"}, {"id": "nan"}, {"id": "inf"}, {"id": "ok"}],
            "actions": [{"id": "capture", "label": "Capture", "applies_to": ["k"], "person_activity": True,
                         "accepts_file": {"mimes": ["text/plain"], "max_bytes": 1024}}]}

def view(ctx, focus, stage):
    return {"revision": "r1", "items": [{"id": "i1", "kind": "k", "label": "i"}]}

async def read(ctx, query, params):
    if query == "write-goal":
        await ctx.create_goal("should not exist")
    if query == "write-exhibit":
        await ctx.exhibit("leak", "swarm")
    if query == "nan":
        return {"deep": [{"x": float("nan")}]}
    if query == "inf":
        return {"x": float("inf")}
    return {"fine": 1}

def act(ctx, action, items, params):
    SAW.append((ctx.file, (ctx.command or {}).get("recorded_result")))
    if ctx.file is None:                       # a recovery: answer from what the hive retained
        return {"status": "done", "detail": {"recovered": True}}
    return {"status": "done", "detail": {"echo": ctx.file["bytes"].decode()}, "receipt": {"state": "committed", "id": "rc-" + ctx.file["bytes"].decode()}}
"""


def mounted(client, tmp_path, monkeypatch):
    sw = client.post("/api/swarms", json={"name": "N9", "visibility": "public"}).json()["id"]
    folder = tmp_path / "n9"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "n9", "name": "N9", "capabilities": ["goals:write", "exhibits:write"]}))
    (folder / "program.py").write_text(APP)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    monkeypatch.setenv("HIVE_APP_HOMES", json.dumps({"n9": [sw]}))
    client.post("/api/programs/reload").raise_for_status()
    return sw, client.app.state.hive.programs.programs["n9"]["module"]


def test_b1_a_read_writes_nothing_through_the_hive(client, tmp_path, monkeypatch):
    sw, _ = mounted(client, tmp_path, monkeypatch)
    owner = person(client, "u_n9a", "member")
    hive = client.app.state.hive
    goals = hive.db.one("SELECT COUNT(*) AS n FROM goals")["n"]
    for query in ("write-goal", "write-exhibit"):
        r = client.post("/api/programs/n9/read", json={"swarm_id": sw, "query": query}, headers=owner)
        assert r.status_code == 403 and r.json()["error"]["code"] == "read_only", (query, r.text)
    assert hive.db.one("SELECT COUNT(*) AS n FROM goals")["n"] == goals
    assert not hive.programs.admitted("user:u_n9a", "n9", sw)
    assert client.post("/api/programs/n9/read", json={"swarm_id": sw, "query": "ok"}, headers=owner).status_code == 200


def test_b2_a_file_intent_retains_metadata_only_including_on_recovery(client, tmp_path, monkeypatch):
    sw, module = mounted(client, tmp_path, monkeypatch)
    owner = person(client, "u_n9b", "member")
    client.post("/api/programs/n9/view", json={"swarm_id": sw}, headers=owner)
    marker = "UPLOAD-MARKER-7f3c"
    body = {"swarm_id": sw, "action": "capture", "items": ["i1"], "params": {}, "idempotency_key": "cap-1",
            "file": {"name": "n.txt", "mime": "text/plain", "size": len(marker),
                     "content_base64": base64.b64encode(marker.encode()).decode()}}
    body = confirmed(client, owner, "n9", body)
    first = client.post("/api/programs/n9/act", headers=owner, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["detail"]["echo"] == marker                                        # the person gets the answer
    db = client.app.state.hive.db
    stored = db.one("SELECT result FROM program_actions WHERE idempotency_key = 'cap-1'")["result"]
    assert marker not in stored and base64.b64encode(marker.encode()).decode() not in stored
    kept = json.loads(stored)
    assert kept["retained"] == "metadata-only" and kept["receipt"] == {"state": "committed"}
    assert kept["result_digest"].startswith("sha256:") and kept["file"]["size"] == len(marker)
    again = client.post("/api/programs/n9/act", headers=owner, json=body)              # recovery of a done intent
    assert again.status_code == 200
    file_seen, recorded = module.SAW[-1]
    assert file_seen is None and marker not in json.dumps(recorded)
    assert marker not in db.one("SELECT result FROM program_actions WHERE idempotency_key = 'cap-1'")["result"]


def test_b3_non_finite_json_is_undeliverable_and_admits_no_one(client, tmp_path, monkeypatch):
    sw, _ = mounted(client, tmp_path, monkeypatch)
    owner = person(client, "u_n9c", "member")
    for query in ("nan", "inf"):
        r = client.post("/api/programs/n9/read", json={"swarm_id": sw, "query": query}, headers=owner)
        assert r.status_code == 500 and r.json()["error"]["code"] == "bad_result", (query, r.text)
        assert not client.app.state.hive.programs.admitted("user:u_n9c", "n9", sw), query


def test_every_write_capability_a_context_can_need_is_blocked_when_read_only():
    """Kimi next9-r3: read_only holds only while WRITE_CAPABILITIES lists every write capability ProgramContext can
    _need. A new write method under a new capability (e.g. drafts:write) must fail this test, not silently pass."""
    import inspect
    import re
    from hive.core.programs import ProgramContext
    source = inspect.getsource(ProgramContext)
    # direct _need("…") calls and the helpers that pass a capability through (_evolve, OmegaReview next10 follow-up)
    needed = set(re.findall(r'_(?:need|evolve)\(\s*"([^"]+)"', source))
    assert "_need(capability)" not in source.replace("def _need(self, capability)", "") or "_evolve(self, capability)" in source, \
        "a new pass-through to _need must be added to this test's pattern"
    assert needed, "parse regressed: no capabilities found"
    writes = {c for c in needed if c.endswith(":write")}
    assert writes and writes <= ProgramContext.WRITE_CAPABILITIES, writes - ProgramContext.WRITE_CAPABILITIES
    # reviewed exceptions: reachable under read_only because they never mutate the hive (sandbox:run writes only a
    # fresh temp job folder, Kimi next9-r3). A new one must be added here deliberately.
    reviewed = {"sandbox:run"}
    assert {c for c in needed if not c.endswith((":write", ":read"))} <= reviewed
