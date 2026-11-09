"""A mind's Code call relayed by the hive (2026-10-29): Code R1.4+ accepts hc1 only on a connection the host proved,
so minds reach Code through /api/agent/code/relay. The hive forwards the exact request and adds no authority."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from hive.core.relay_proof import RelayProofError, expected_proof, proved_request
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

SECRET = "s" * 43
SERVICE = "svc_code"
MEMBER = "member-token-abc"


async def _read(reader):
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:] if l)}
    body = await reader.readexactly(int(headers.get("content-length", "0")))
    return lines[0], headers, body


def _reply(writer, status, obj):
    raw = json.dumps(obj).encode()
    writer.write(f"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n".encode() + raw)


async def _serve(seen):
    """A fake Code listener that proves itself, then records the one bound request with all its headers."""
    async def handle(reader, writer):
        _line, _h, body = await _read(reader)
        c = json.loads(body)
        cid = "c" * 22
        bound = {k: c[k] for k in ("service_id", "nonce", "method", "path", "body_sha256")} | {"challenge_id": cid}
        _reply(writer, 200, {"version": 1, "challenge_id": cid, "proof": expected_proof(SECRET, bound)})
        await writer.drain()
        line, headers, body = await asyncio.wait_for(_read(reader), timeout=2)
        seen.append((line, headers, body))
        _reply(writer, 200, {"ok": True})
        await writer.drain()
        writer.close()
    return await asyncio.start_server(handle, "127.0.0.1", 0)


def _code(port, monkeypatch):
    import hive.core.code as code_module
    from hive.core.code import Code

    class NoPool:
        async def request(self, *a, **k):
            raise AssertionError("a proved relay never uses the pooled client")
    monkeypatch.setattr(code_module, "RELAY_PROOF_RELEASES", frozenset({code_module.INTENDED_SERVICE_RELEASE}))
    code = Code.__new__(Code)
    code.client = NoPool()
    code.require_intended_release = lambda: None
    code.hive = SimpleNamespace(services=SimpleNamespace(
        by_name=lambda n: {"id": SERVICE, "address": f"http://127.0.0.1:{port}", "capability_secret": SECRET}))
    return code


def _relay(monkeypatch, method, path, query, body, bearer="hc1.payload.sig", seen=None):
    seen = [] if seen is None else seen

    async def main():
        server = await _serve(seen)
        port = server.sockets[0].getsockname()[1]
        try:
            return await _code(port, monkeypatch).relay_agent(MEMBER, bearer, method, path, query, body)
        finally:
            server.close()
            await server.wait_closed()
    return asyncio.run(main()), seen


def test_a_minds_call_is_forwarded_exactly_on_a_proved_connection_with_its_member_token(monkeypatch):
    (status, content, _ctype), seen = _relay(monkeypatch, "GET", "/v1/workspaces/ws_a/tree", "expected_generation=2", b"")
    assert status == 200 and json.loads(content) == {"ok": True}
    [(line, headers, body)] = seen
    assert line == "GET /v1/workspaces/ws_a/tree?expected_generation=2 HTTP/1.1"
    assert headers["authorization"] == "Bearer hc1.payload.sig"
    assert headers["x-hive-token"] == MEMBER
    assert headers["x-omegacode-relay-challenge"] == "c" * 22
    assert body == b""


def test_a_post_body_is_forwarded_byte_for_byte(monkeypatch):
    raw = b'{"operation_id":"op-1","base_commit":"abc"}'
    (status, _c, _t), seen = _relay(monkeypatch, "POST", "/v1/workspaces", "", raw)
    assert status == 200 and seen[0][0] == "POST /v1/workspaces HTTP/1.1" and seen[0][2] == raw


@pytest.mark.parametrize("path", ["/v1/relay-challenge", "/v1/operator/grants", "/v1/operator/register",
                                  "/v1/workspaces/ws_a/suggestions/sug_a/candidate",
                                  "/v1/lifecycle", "/v1/register", "/v1/workspaces/../operator/grants",
                                  "/v2/anything", "/v1/workspaces/ws_a\r\nX-Evil: 1", "/v1/%6Fperator/grants",
                                  "/v1/workspaces/ws_a%2F..%2Foperator"])
def test_host_only_and_odd_paths_are_never_relayed(path, monkeypatch):
    from hive.core.code import CodeError
    seen = []
    with pytest.raises(CodeError) as caught:
        _relay(monkeypatch, "GET", path, "", b"", seen=seen)
    assert caught.value.status == 404
    assert seen == []


def test_only_an_hc1_capability_is_relayed(monkeypatch):
    from hive.core.code import CodeError
    for bearer in ("", "oc1.x.y", "operator-token"):
        with pytest.raises(CodeError) as caught:
            _relay(monkeypatch, "GET", "/v1/workspaces/ws_a/tree", "", b"", bearer=bearer)
        assert caught.value.status == 403


def test_only_get_and_post_are_relayed(monkeypatch):
    from hive.core.code import CodeError
    with pytest.raises(CodeError) as caught:
        _relay(monkeypatch, "DELETE", "/v1/workspaces/ws_a", "", b"")
    assert caught.value.status == 405


@pytest.mark.parametrize("extra", [{"X-Other": "v"}, {"X-Hive-Token": "a\r\nb"}, {"X-Hive-Token": ""}])
def test_proved_request_adds_only_a_well_formed_member_token_header(extra):
    with pytest.raises(RelayProofError):
        asyncio.run(proved_request("http://127.0.0.1:9", SERVICE, SECRET, "GET", "/v1/x", b"", bearer="hc1.a.b",
                                   extra_headers=extra))


def test_the_route_refuses_a_caller_without_a_valid_member_token(client):  # noqa: F811
    for headers in ({}, {"X-Hive-Token": "not-a-member"}):
        response = client.get("/api/agent/code/relay/v1/workspaces/ws_a/tree",
                               headers={"Authorization": "Bearer hc1.a.b", **headers})
        assert response.status_code == 401


def test_the_minds_client_points_at_the_hive_relay(monkeypatch):
    import importlib
    import sys
    import pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "modules" / "code" / "src"))
    try:
        oc = importlib.import_module("omega_code")
    finally:
        sys.path.pop(0)
    captured = {}

    class Fake:
        def __init__(self, hive, token, code_url):
            captured.update(hive=hive, token=token, code_url=code_url)
    monkeypatch.setitem(sys.modules, "omegacode.client", SimpleNamespace(NativeClient=Fake))
    monkeypatch.setenv("HIVE_API_URL", "http://127.0.0.1:8700/")
    monkeypatch.setenv("HIVE_WS_TOKEN", MEMBER)
    monkeypatch.setenv("OMEGACODE_URL", "http://127.0.0.1:8724")
    client_, problem = oc._client()
    assert problem is None and captured["code_url"] == "http://127.0.0.1:8700/api/agent/code/relay"
