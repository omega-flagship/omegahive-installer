"""Surface G1 (2026-10-05): an app's declared, read-only, non-graph queries, read as the person, bounded, never stored."""
import json

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

APP = """
ALLOWED = {"user:u_owner"}
CALLS = []

def describe():
    return {"contract": "0.2", "kinds": [{"id": "k", "label": "K", "role": "claim"}], "relations": [], "actions": [],
            "reads": [{"id": "map", "label": "Map"}, {"id": "big"}, {"id": "list"}]}

def _gate(ctx):
    if (ctx.viewer or {}).get("principal") not in ALLOWED:
        raise PermissionError("owner person required")

def view(ctx, focus, stage):
    _gate(ctx)
    return {"revision": "r1", "items": [{"id": "i1", "kind": "k", "label": "i"}]}

def act(ctx, action, items, params):
    raise PermissionError("no actions")

def read(ctx, query, params):
    _gate(ctx)
    CALLS.append((query, ctx.viewer["principal"], params))
    if query == "big":
        return {"blob": "x" * (5 * 1024 * 1024)}
    if query == "list":
        return [1, 2, 3]
    return {"nodes": [{"id": "n1", "x": 1.5, "y": 2}], "edges": [], "limit": params.get("limit")}
"""


def mounted(client, tmp_path, monkeypatch, swarm_id):
    folder = tmp_path / "reader"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "reader", "name": "Reader", "capabilities": []}))
    (folder / "program.py").write_text(APP)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    monkeypatch.setenv("HIVE_APP_HOMES", json.dumps({"reader": [swarm_id]}))
    client.post("/api/programs/reload").raise_for_status()
    return client.app.state.hive.programs.programs["reader"]["module"]


def test_a_declared_read_answers_the_person_with_json_that_is_not_a_graph(client, tmp_path, monkeypatch):
    sw = client.post("/api/swarms", json={"name": "Read", "visibility": "public"}).json()["id"]
    module = mounted(client, tmp_path, monkeypatch, sw)
    owner = person(client, "u_owner", "member")
    r = client.post("/api/programs/reader/read", json={"swarm_id": sw, "query": "map", "params": {"limit": 600}}, headers=owner)
    assert r.status_code == 200, r.text
    assert r.json() == {"program": "reader", "query": "map",
                        "result": {"nodes": [{"id": "n1", "x": 1.5, "y": 2}], "edges": [], "limit": 600}}
    assert module.CALLS[-1] == ("map", "user:u_owner", {"limit": 600})
    assert client.app.state.hive.programs.admitted("user:u_owner", "reader", sw)      # a read admits like a view


def test_reads_refuse_the_undeclared_the_refused_the_oversized_and_identity_in_the_body(client, tmp_path, monkeypatch):
    sw = client.post("/api/swarms", json={"name": "Read2", "visibility": "public"}).json()["id"]
    mounted(client, tmp_path, monkeypatch, sw)
    owner, other = person(client, "u_owner", "member"), person(client, "u_other", "member")
    post = lambda who, **body: client.post("/api/programs/reader/read", json={"swarm_id": sw, **body}, headers=who)
    assert post(owner, query="secrets").json()["error"]["code"] == "unknown_read"
    assert post(owner, query="map", principal="user:u_owner").status_code == 400
    assert post(owner, query="map", params=[1]).status_code == 400
    assert post(other, query="map").json()["error"]["code"] == "program_refused"
    assert not client.app.state.hive.programs.admitted("user:u_other", "reader", sw)
    big = post(owner, query="big")
    assert big.status_code == 413 and big.json()["error"]["code"] == "read_too_large"


def test_a_bad_reads_declaration_does_not_load():
    import pytest
    from hive.core.programs import Programs
    base = {"kinds": [{"id": "k", "role": "claim"}]}
    with pytest.raises(ValueError):
        Programs._check_description({**base, "reads": [{"id": "../etc"}]})
    with pytest.raises(ValueError):
        Programs._check_description({**base, "actions": [{"id": "up", "accepts_file": {"mimes": ["*"], "max_bytes": 10}}]})
    ok = Programs._check_description({**base, "reads": [{"id": "map"}],
                                      "actions": [{"id": "up", "person_activity": True,
                                                   "accepts_file": {"mimes": ["application/pdf"], "max_bytes": 1024}}]})
    assert ok["reads"] == [{"id": "map"}]


def test_an_undeliverable_answer_admits_no_one(client, tmp_path, monkeypatch):
    """Kimi next9 #2, #5: admission follows a deliverable answer only, not any return value."""
    sw = client.post("/api/swarms", json={"name": "Read3", "visibility": "public"}).json()["id"]
    mounted(client, tmp_path, monkeypatch, sw)
    owner = person(client, "u_owner", "member")
    programs = client.app.state.hive.programs
    for query, status in (("big", 413), ("list", 500)):
        r = client.post("/api/programs/reader/read", json={"swarm_id": sw, "query": query}, headers=owner)
        assert r.status_code == status, (query, r.text)
        assert not programs.admitted("user:u_owner", "reader", sw), query


def test_a_read_body_is_capped_whatever_the_headers_say(client, tmp_path, monkeypatch):
    """Kimi next9-r2 nit: the read route streams its body under a 1 MB cap."""
    sw = client.post("/api/swarms", json={"name": "Read4", "visibility": "public"}).json()["id"]
    mounted(client, tmp_path, monkeypatch, sw)
    owner = person(client, "u_owner", "member")
    def chunks():
        yield b'{"swarm_id": "' + sw.encode() + b'", "query": "map", "params": {"pad": "'
        for _ in range(300):
            yield b"x" * 4096
        yield b'"}}'
    r = client.post("/api/programs/reader/read", headers={**owner, "content-type": "application/json"}, content=chunks())
    assert r.status_code == 413 and r.json()["error"]["code"] == "request_too_large"
