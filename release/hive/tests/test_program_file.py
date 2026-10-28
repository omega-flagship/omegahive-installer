"""Surface G2 (2026-10-05): one file from the person's device to an app action; checked, handed over, never stored."""
import base64
import hashlib
import json

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person
from hive.tests.test_program_confirm import confirmed

APP = """
GOT = []

def describe():
    return {"contract": "0.2", "kinds": [{"id": "k", "label": "K", "role": "claim"}], "relations": [],
            "actions": [{"id": "capture", "label": "Capture", "applies_to": ["k"], "agents": True,
                         "person_activity": True,
                         "accepts_file": {"mimes": ["application/pdf", "text/plain"], "max_bytes": 64}},
                        {"id": "plain", "label": "Plain", "applies_to": ["k"], "agents": True}]}

def view(ctx, focus, stage):
    if (ctx.viewer or {}).get("principal") != "user:u_owner":
        raise PermissionError("owner person required")
    return {"revision": "r1", "items": [{"id": "i1", "kind": "k", "label": "i"}]}

def act(ctx, action, items, params):
    GOT.append((ctx.file, dict(ctx.actor or {}).get("recovery"), (ctx.command or {}).get("file")))
    return {"status": "done", "detail": {"size": (ctx.file or {}).get("size")}}
"""


def setup(client, tmp_path, monkeypatch):
    sw = client.post("/api/swarms", json={"name": "Files", "visibility": "public"}).json()["id"]
    folder = tmp_path / "filer"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "filer", "name": "Filer", "capabilities": []}))
    (folder / "program.py").write_text(APP)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    monkeypatch.setenv("HIVE_APP_HOMES", json.dumps({"filer": [sw]}))
    client.post("/api/programs/reload").raise_for_status()
    return sw, client.app.state.hive.programs.programs["filer"]["module"]


def file(data=b"hello", mime="text/plain", **over):
    return {"name": "note.txt", "mime": mime, "size": len(data), "content_base64": base64.b64encode(data).decode(), **over}


def test_an_admitted_person_hands_a_declared_file_to_the_app_and_the_hive_keeps_no_bytes(client, tmp_path, monkeypatch):
    sw, module = setup(client, tmp_path, monkeypatch)
    owner = person(client, "u_owner", "member")
    assert client.post("/api/programs/filer/view", json={"swarm_id": sw}, headers=owner).status_code == 200
    r = client.post("/api/programs/filer/act", headers=owner, json=confirmed(client, owner, "filer",
                    {"swarm_id": sw, "action": "capture", "items": ["i1"], "params": {}, "file": file(), "idempotency_key": "f1"}))
    assert r.status_code == 200, r.text
    got = module.GOT[-1][0]
    assert got["bytes"] == b"hello" and got["mime"] == "text/plain" and got["sha256"] == "sha256:" + hashlib.sha256(b"hello").hexdigest()
    db = client.app.state.hive.db
    dump = "\n".join(str(tuple(row)) for t in ("program_actions", "assets") for row in
                     (db.all(f"SELECT * FROM {t}") if db.one("SELECT 1 FROM sqlite_master WHERE name = ?", (t,)) else []))
    assert "hello" not in dump and base64.b64encode(b"hello").decode() not in dump


def test_files_are_refused_unless_declared_typed_sized_admitted_and_from_a_person(client, tmp_path, monkeypatch):
    sw, module = setup(client, tmp_path, monkeypatch)
    owner, other = person(client, "u_owner", "member"), person(client, "u_other", "member")
    act = lambda who, action="capture", **f: client.post("/api/programs/filer/act", headers=who, json={
        "swarm_id": sw, "action": action, "items": ["i1"], "params": {}, "file": file(**f), "idempotency_key": "f2"})
    code = lambda r: (r.status_code, r.json()["error"]["code"])
    assert code(act(owner)) == (403, "app_not_opened")                      # not opened yet
    client.post("/api/programs/filer/view", json={"swarm_id": sw}, headers=owner)
    assert code(act(owner, action="plain")) == (400, "file_not_accepted")
    assert code(act(owner, mime="image/svg+xml")) == (415, "file_type_refused")
    assert code(act(owner, data=b"x" * 65)) == (413, "file_too_large")
    assert code(act(owner, size=4)) == (400, "bad_file")
    assert code(act(owner, content_base64="!!!")) == (400, "bad_file")
    assert code(act(other)) == (403, "app_not_opened")                      # the app never admitted them
    assert code(client.post("/api/programs/filer/act", json={
        "swarm_id": sw, "action": "capture", "items": ["i1"], "params": {}, "file": file(),
        "idempotency_key": "f3"})) == (403, "person_required")
    assert module.GOT == []


def test_minds_cannot_send_files(client, tmp_path, monkeypatch):
    sw, _ = setup(client, tmp_path, monkeypatch)
    _, (a, _b) = make_swarm_and_agents(client)
    r = client.post("/api/agent/programs/filer/act", headers=agent_headers(a),
                    json={"action": "capture", "items": ["i1"], "params": {}, "idempotency_key": "k1", "file": file()})
    assert r.status_code == 403 and r.json()["error"]["code"] == "person_required"


def test_a_recovered_retry_never_redelivers_the_file(client, tmp_path, monkeypatch):
    """Kimi next9 #1: a done intent retried reaches the app as a recovery with the file's digest, never its bytes."""
    sw, module = setup(client, tmp_path, monkeypatch)
    owner = person(client, "u_owner", "member")
    client.post("/api/programs/filer/view", json={"swarm_id": sw}, headers=owner)
    body = confirmed(client, owner, "filer", {"swarm_id": sw, "action": "capture", "items": ["i1"], "params": {}, "file": file(),
                                              "idempotency_key": "once"})
    assert client.post("/api/programs/filer/act", headers=owner, json=body).status_code == 200
    assert client.post("/api/programs/filer/act", headers=owner, json=body).status_code == 200
    (first, rec1, _), (second, rec2, meta) = module.GOT
    assert first["bytes"] == b"hello" and not rec1
    assert second is None and rec2 is True and meta["sha256"] == first["sha256"] and "bytes" not in meta


def test_the_body_cap_holds_without_a_content_length_and_before_decoding(client, tmp_path, monkeypatch):
    """Kimi next9 #3: a streamed body is capped whatever the headers say; base64 is bounded before it is decoded."""
    import hive.core.app as app_module
    sw, module = setup(client, tmp_path, monkeypatch)
    owner = person(client, "u_owner", "member")
    client.post("/api/programs/filer/view", json={"swarm_id": sw}, headers=owner)
    monkeypatch.setattr(app_module, "ACT_MAX_BODY", 1024)
    # the route reads the cap at call time through the module global
    def chunks():
        yield b'{"swarm_id": "' + sw.encode() + b'", "pad": "'
        for _ in range(8):
            yield b"x" * 512
        yield b'"}'
    r = client.post("/api/programs/filer/act", headers={**owner, "content-type": "application/json"}, content=chunks())
    assert r.status_code == 413 and r.json()["error"]["code"] == "request_too_large"
    monkeypatch.setattr(app_module, "ACT_MAX_BODY", 28 * 1024 * 1024)
    big = file(data=b"y" * 60, content_base64="A" * 200)             # far longer than 64 bytes can encode to
    r = client.post("/api/programs/filer/act", headers=owner, json={"swarm_id": sw, "action": "capture", "items": ["i1"],
                                                                    "params": {}, "file": big, "idempotency_key": "b1"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "file_too_large" and module.GOT == []


def test_a_file_action_must_be_a_person_activity():
    import pytest
    from hive.core.programs import Programs
    with pytest.raises(ValueError):
        Programs._check_description({"kinds": [{"id": "k", "role": "claim"}],
                                     "actions": [{"id": "up", "accepts_file": {"mimes": ["text/plain"], "max_bytes": 10}}]})


def test_a_file_act_is_confirmed_for_exactly_those_bytes(client, tmp_path, monkeypatch):
    """§9d: the confirm token binds the file's name, type, size and sha256; a token for one file never carries another."""
    sw, module = setup(client, tmp_path, monkeypatch)
    owner = person(client, "u_owner", "member")
    client.post("/api/programs/filer/view", json={"swarm_id": sw}, headers=owner)
    body = {"swarm_id": sw, "action": "capture", "items": ["i1"], "params": {}, "file": file(), "idempotency_key": "c1"}
    assert client.post("/api/programs/filer/act", headers=owner, json=body).json()["error"]["code"] == "confirm_required"
    swapped = dict(confirmed(client, owner, "filer", body), file=file(data=b"HELLO"))
    r = client.post("/api/programs/filer/act", headers=owner, json=swapped)
    assert r.status_code == 403 and r.json()["error"]["code"] == "confirm_invalid" and module.GOT == []
