"""Same-connection relay proof: the bearer reaches only a listener that proved the enrolled secret on that socket."""
import asyncio
import json

import pytest

from hive.core.relay_proof import RelayProofError, expected_proof, proved_request

SECRET = "s" * 43
SERVICE = "svc_code"


async def _read(reader):
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:] if l)}
    body = await reader.readexactly(int(headers.get("content-length", "0")))
    return lines[0], headers, body


def _reply(writer, status, obj):
    raw = json.dumps(obj).encode()
    writer.write(f"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n".encode() + raw)


async def _serve(mode, seen):
    """A fake Code listener. mode: good | bad-proof | close-after-challenge | malformed."""
    async def handle(reader, writer):
        line, _h, body = await _read(reader)
        assert line == "POST /v1/relay-challenge HTTP/1.1"
        c = json.loads(body)
        cid = "c" * 22
        bound = {k: c[k] for k in ("service_id", "nonce", "method", "path", "body_sha256")} | {"challenge_id": cid}
        proof = expected_proof(SECRET if mode != "bad-proof" else "x" * 43, bound)
        if mode == "malformed":
            _reply(writer, 200, {"version": 1, "proof": proof})
        else:
            _reply(writer, 200, {"version": 1, "challenge_id": cid, "proof": proof})
        await writer.drain()
        if mode == "close-after-challenge":
            writer.close()
            return
        try:
            line, headers, body = await asyncio.wait_for(_read(reader), timeout=2)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError):
            writer.close()
            return
        seen.append((line, headers.get("authorization"), headers.get("x-omegacode-relay-challenge"), body))
        _reply(writer, 200, {"ok": True})
        await writer.drain()
        writer.close()
    return await asyncio.start_server(handle, "127.0.0.1", 0)


def _run(mode):
    async def main():
        seen = []
        server = await _serve(mode, seen)
        port = server.sockets[0].getsockname()[1]
        try:
            result = await proved_request(f"http://127.0.0.1:{port}", SERVICE, SECRET, "POST", "/v1/workspaces?x=1",
                                          b'{"a":1}', bearer="BEARER-TOKEN")
            return result, seen
        finally:
            server.close()
            await server.wait_closed()
    return asyncio.run(main())


def test_proved_listener_gets_exactly_one_bound_request_with_the_bearer():
    (status, _headers, body), seen = _run("good")
    assert status == 200 and json.loads(body) == {"ok": True}
    assert seen == [("POST /v1/workspaces?x=1 HTTP/1.1", "Bearer BEARER-TOKEN", "c" * 22, b'{"a":1}')]


@pytest.mark.parametrize("mode", ["bad-proof", "close-after-challenge", "malformed"])
def test_no_bearer_without_a_valid_proof_on_the_same_connection(mode):
    seen = []
    async def main():
        server = await _serve(mode, seen)
        port = server.sockets[0].getsockname()[1]
        try:
            with pytest.raises(RelayProofError):
                await proved_request(f"http://127.0.0.1:{port}", SERVICE, SECRET, "GET", "/v1/health", b"",
                                     bearer="BEARER-TOKEN")
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(main())
    assert all(s[1] is None for s in seen) and not any("BEARER-TOKEN" in str(s) for s in seen)


@pytest.mark.parametrize("address", ["http://0.0.0.0:8724", "https://127.0.0.1:8724", "http://localhost:8724",
                                     "http://127.0.0.1:8724/prefix", "http://127.0.0.1"])
def test_only_a_loopback_http_listener_is_accepted(address):
    with pytest.raises(RelayProofError):
        asyncio.run(proved_request(address, SERVICE, SECRET, "GET", "/v1/health", b"", bearer="B"))


def test_non_canonical_path_or_method_refuses_before_connecting():
    for method, path in (("get", "/v1/health"), ("GET", "v1/health"), ("GET", "/v1/a b")):
        with pytest.raises(RelayProofError):
            asyncio.run(proved_request("http://127.0.0.1:1", SERVICE, SECRET, method, path, b"", bearer="B"))


def test_a_slow_challenge_answer_never_receives_the_bearer(monkeypatch):
    import hive.core.relay_proof as module
    monkeypatch.setattr(module, "PROOF_WINDOW", 0.3)
    seen = []
    async def main():
        async def handle(reader, writer):
            await _read(reader)
            await asyncio.sleep(0.6)                                     # answers after the proof window
            _reply(writer, 200, {"version": 1, "challenge_id": "c" * 22, "proof": "0" * 64})
            await writer.drain()
            try:
                seen.append(await asyncio.wait_for(_read(reader), timeout=1))
            except Exception:  # noqa: BLE001
                pass
            writer.close()
        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            with pytest.raises(RelayProofError):
                await proved_request(f"http://127.0.0.1:{port}", SERVICE, SECRET, "GET", "/v1/health", b"", bearer="B")
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(main())
    assert seen == []


def _proxying_code(port, monkeypatch, client=None):
    from types import SimpleNamespace
    import hive.core.code as code_module
    from hive.core.code import Code
    monkeypatch.setattr(code_module, "RELAY_PROOF_RELEASES", frozenset({code_module.INTENDED_SERVICE_RELEASE}))
    code = Code.__new__(Code)
    code.client = client
    code.require_intended_release = lambda: None
    code._capability = lambda *a, **k: "BEARER-TOKEN"
    code.hive = SimpleNamespace(settings=SimpleNamespace(copy_apply_claims=False), services=SimpleNamespace(
        by_name=lambda n: {"id": SERVICE, "address": f"http://127.0.0.1:{port}", "capability_secret": SECRET}))
    return code


@pytest.mark.parametrize("mode", ["good", "bad-proof"])
def test_the_code_proxy_relays_only_through_a_proved_connection_when_the_pin_requires_it(mode, monkeypatch):
    """With the pinned release in RELAY_PROOF_RELEASES, Code.proxy never uses the pooled client: it proves the listener
    and sends the bearer on that connection, path and query bound; a failed proof is a 502 with no bearer sent."""
    from hive.core.code import CodeError
    class NoPool:
        async def request(self, *a, **k):
            raise AssertionError("the pooled client must not carry a bearer when proof is required")
    seen = []
    async def main():
        server = await _serve(mode, seen)
        port = server.sockets[0].getsockname()[1]
        code = _proxying_code(port, monkeypatch, NoPool())
        try:
            return await code.proxy("user:operator", "POST", "/v1/workspaces/ws_a/repository-retrieval",
                                    {}, b'{"query":"q"}', "g_a", None, "synthetic")
        finally:
            server.close()
            await server.wait_closed()
    if mode == "good":
        status, body, _ctype = asyncio.run(main())
        assert status == 200 and json.loads(body) == {"ok": True}
        assert seen == [("POST /v1/workspaces/ws_a/repository-retrieval HTTP/1.1", "Bearer BEARER-TOKEN", "c" * 22,
                         b'{"query":"q"}')]
    else:
        with pytest.raises(CodeError) as caught:
            asyncio.run(main())
        assert caught.value.args and "relay_proof_failed" in repr(caught.value.__dict__) + repr(caught.value.args)
        assert all(s[1] is None for s in seen)


def test_the_pinned_release_requires_the_relay_proof_and_serves_its_challenge_route():
    """R13 pin (R1.4) is in RELAY_PROOF_RELEASES, and the route stays host-only (never person-relayed)."""
    import hive.core.code as code_module
    assert code_module.INTENDED_SERVICE_RELEASE in code_module.RELAY_PROOF_RELEASES
    assert ("POST", "/v1/relay-challenge") in code_module.UNRELAYED_SERVICE_ROUTES
    assert not any(r[0] == "POST" and __import__("re").fullmatch(r[1], "/v1/relay-challenge") for r in code_module.PROXY_ROUTES)


def test_relay_proof_allowlist_keeps_intended_release_and_rollback():
    """Both the new intended listener and rollback listener must require proof."""
    import hive.core.code as code_module
    assert code_module.INTENDED_SERVICE_RELEASE == "b6283f467b3691566b48c7a420e25f699c801ce6c97b6bbc8946db986c91cdce"
    assert {
        "c63d17cb8886a119fd35358108b4fd5daeb16074cdf74de0a108f218a070d319",
        "309df6d5c9c35427c53e7b6525e1be2729c95d04cbab6057207071c82f3fdbfe",
    } <= code_module.RELAY_PROOF_RELEASES
