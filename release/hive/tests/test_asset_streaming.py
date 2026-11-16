"""Uploads stream to disk in chunks, hashed as they arrive, then move into place atomically (assets.Spool); no 100 MB cap
on the local store; an optional operator cap; cloud stores keep their own limit; a disconnect leaves nothing behind.

Big bodies are generated chunk by chunk and driven straight into the ASGI app (the test client would buffer them), so
nothing large is ever held in memory or written outside the hive's own temp data folder."""
import hashlib
import tracemalloc

import httpx
import pytest
from starlette.requests import Request

from hive.core import assets as assets_mod
from hive.core.assets import S3Store, Spool
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)

CHUNK = 256 * 1024


def generated(total, chunk=CHUNK):
    """(chunks iterator, sha256 holder): distinct bytes per chunk, produced on demand."""
    base = bytes(range(256)) * (chunk // 256)
    digest = hashlib.sha256()

    def chunks():
        sent, n = 0, 0
        while sent < total:
            piece = (n.to_bytes(8, "big") + base[8:])[: min(chunk, total - sent)]
            digest.update(piece)
            sent += len(piece)
            n += 1
            yield piece
    return chunks(), digest


def asgi_call(client, method, path, query, headers, chunks, disconnect_after=None):
    """Drive one request through the running app with the body in separate ASGI messages. Returns (status, body) or the
    exception the app raised."""
    app = client.app
    token = client.headers["Authorization"]
    # a browser on this machine: a loopback peer naming the hive's loopback address (sso.direct_local); with another
    # Host the request is public, and the operator's password session counts only on this machine
    hdrs = [(b"host", b"127.0.0.1:8700"), (b"authorization", token.encode())] + [(k.encode(), v.encode()) for k, v in headers.items()]
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": query.encode(), "headers": hdrs,
             "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8700), "root_path": ""}
    out = {"status": None, "body": b""}

    async def run():
        it = iter(chunks)
        count = 0
        pending = next(it, None)

        async def receive():
            nonlocal pending, count
            if disconnect_after is not None and count >= disconnect_after:
                return {"type": "http.disconnect"}
            if pending is None:
                return {"type": "http.request", "body": b"", "more_body": False}
            chunk, pending = pending, next(it, None)
            count += 1
            return {"type": "http.request", "body": chunk, "more_body": pending is not None or disconnect_after is not None}

        async def send(message):
            if message["type"] == "http.response.start":
                out["status"] = message["status"]
            elif message["type"] == "http.response.body":
                out["body"] += message.get("body", b"")

        try:
            await app(scope, receive, send)
        except Exception as exc:   # a disconnect may surface as the app's exception
            out["error"] = exc
    client.portal.call(run)
    return out


def incoming(client):
    return sorted(client.app.state.hive.assets.incoming.glob("*.part"))


def test_a_large_generated_upload_streams_in_chunks_with_flat_memory(client, monkeypatch):
    total = 48 * 1024 * 1024   # over a third of the old cap; memory must stay far below it
    writes = []
    real_write = Spool.write
    monkeypatch.setattr(Spool, "write", lambda self, chunk: (chunk and writes.append(len(chunk)), real_write(self, chunk))[1])

    async def no_whole_body(self):
        raise AssertionError("the upload was read whole")
    monkeypatch.setattr(Request, "body", no_whole_body)
    chunks, digest = generated(total)
    tracemalloc.start()
    try:
        out = asgi_call(client, "POST", "/api/assets", "name=big.bin", {"content-type": "application/octet-stream"}, chunks)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert out["status"] == 200, out
    assert len(writes) == total // CHUNK and max(writes) == CHUNK     # chunked reads, one write per arriving piece
    assert peak < 12 * 1024 * 1024, peak                              # nowhere near the 48 MB body
    hive = client.app.state.hive
    row = hive.assets.row(digest.hexdigest())
    assert row["bytes"] == total and row["name"] == "big.bin"
    assert hive.assets.stores["local"]._path(digest.hexdigest()).stat().st_size == total
    assert assets_mod.file_sha256(hive.assets.stores["local"]._path(digest.hexdigest())) == digest.hexdigest()
    assert incoming(client) == []


def test_over_100_mb_declared_is_no_longer_refused_up_front(client):
    # the declared length alone used to be refused at 100 MB; now only a configured cap refuses it
    chunks, digest = generated(2 * CHUNK)
    out = asgi_call(client, "POST", "/api/assets", "", {"content-type": "application/octet-stream", "content-length": str(2 * CHUNK)}, chunks)
    assert out["status"] == 200 and digest.hexdigest() in out["body"].decode()
    stores = {s["name"]: s for s in client.get("/api/asset-stores").json()}
    assert stores["local"]["max_bytes"] is None


def test_hash_is_correct_for_small_and_streamed_uploads(client):
    data = b"exact bytes for the hash check" * 1000
    up = client.post("/api/assets?name=a.txt", content=data, headers={"content-type": "text/plain"}).json()
    assert up["sha256"] == hashlib.sha256(data).hexdigest() and up["bytes"] == len(data) and up["mime"] == "text/plain"
    assert client.get(f"/api/assets/{up['sha256']}").content == data
    chunks, digest = generated(3 * CHUNK + 17)
    out = asgi_call(client, "POST", "/api/assets", "", {"content-type": "application/octet-stream"}, chunks)
    assert out["status"] == 200 and f'"sha256":"{digest.hexdigest()}"' in out["body"].decode()


def test_a_disconnect_mid_upload_removes_the_temp_file_and_stores_nothing(client):
    hive = client.app.state.hive
    before = hive.db.one("SELECT COUNT(*) AS n FROM assets")["n"]
    chunks, _ = generated(20 * CHUNK)
    out = asgi_call(client, "POST", "/api/assets", "name=cut.bin", {"content-type": "application/octet-stream"}, chunks, disconnect_after=3)
    assert out["status"] in (None, 400, 499, 500) or "error" in out
    assert incoming(client) == []
    assert hive.db.one("SELECT COUNT(*) AS n FROM assets")["n"] == before


def test_the_operator_cap_refuses_and_cleans_up(client):
    hive = client.app.state.hive
    hive.settings.asset_max_bytes = CHUNK
    chunks, _ = generated(3 * CHUNK)
    out = asgi_call(client, "POST", "/api/assets", "", {"content-type": "application/octet-stream"}, chunks)
    assert out["status"] == 413 and b"too_large" in out["body"]
    declared = client.post("/api/assets", content=b"x" * (CHUNK + 1))
    assert declared.status_code == 413
    assert incoming(client) == []
    assert {s["name"]: s for s in client.get("/api/asset-stores").json()}["local"]["max_bytes"] == CHUNK


def test_cloud_stores_keep_their_own_limit(client, monkeypatch):
    hive = client.app.state.hive
    hive.assets.stores["cloud"] = S3Store("https://s3.example.test", "omegahive", "auto", "key", "secret",
                                          transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    monkeypatch.setattr(assets_mod, "MEMORY_MAX_BYTES", CHUNK)
    assert {s["name"]: s for s in client.get("/api/asset-stores").json()}["cloud"]["max_bytes"] == CHUNK
    chunks, _ = generated(2 * CHUNK)
    out = asgi_call(client, "POST", "/api/assets", "store=cloud", {"content-type": "application/octet-stream"}, chunks)
    assert out["status"] == 413 and incoming(client) == []
    # a large local file cannot be copied to the cloud either
    big = client.post("/api/assets", content=b"y" * (2 * CHUNK)).json()
    assert client.post(f"/api/assets/{big['sha256']}/transfer", json={"to": "cloud"}).status_code == 413


def test_minds_upload_by_stream_too(client):
    _, (a, _) = make_swarm_and_agents(client)
    data = b"mind upload" * 5000
    up = client.post("/api/agent/assets?name=m.bin", content=data, headers=agent_headers(a) | {"content-type": "application/octet-stream"}).json()
    assert up["sha256"] == hashlib.sha256(data).hexdigest()
    assert client.get(f"/api/agent/assets/{up['sha256']}", headers=agent_headers(a)).content == data
    assert incoming(client) == []


def test_large_downloads_stream_and_a_tampered_copy_is_cut(client, monkeypatch):
    monkeypatch.setattr(assets_mod, "STREAM_FROM", 1000)
    monkeypatch.setattr(assets_mod, "CHUNK", 777)
    data = bytes(range(256)) * 40
    sha = client.post("/api/assets", content=data, headers={"content-type": "application/octet-stream"}).json()["sha256"]
    r = client.get(f"/api/assets/{sha}")
    assert r.status_code == 200 and r.content == data and r.headers["content-length"] == str(len(data))
    path = client.app.state.hive.assets.stores["local"]._path(sha)
    path.write_bytes(b"\0" * len(data))   # same size, different bytes: caught by the trailing hash check
    with pytest.raises(Exception):
        client.get(f"/api/assets/{sha}")
    path.write_bytes(b"short")            # a size mismatch is refused before a byte is sent
    assert client.get(f"/api/assets/{sha}").status_code == 500


def _serve(app):
    """The app on a real uvicorn server on an ephemeral loopback port (lifespan already running in the test client)."""
    import asyncio
    import socket
    import threading
    import uvicorn
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(16)
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="critical"))
    thread = threading.Thread(target=lambda: asyncio.run(server.serve(sockets=[sock])), daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        import time
        time.sleep(0.02)
    return server, thread, f"http://127.0.0.1:{sock.getsockname()[1]}"


def test_a_tampered_streamed_download_never_completes_on_a_real_client(client, monkeypatch):
    monkeypatch.setattr(assets_mod, "STREAM_FROM", 1000)
    monkeypatch.setattr(assets_mod, "CHUNK", 777)
    data = bytes(range(256)) * 40
    sha = client.post("/api/assets", content=data, headers={"content-type": "application/octet-stream"}).json()["sha256"]
    server, thread, base = _serve(client.app)
    try:
        auth = {"Authorization": client.headers["Authorization"]}
        good = httpx.get(f"{base}/api/assets/{sha}", headers=auth, timeout=10)
        assert good.status_code == 200 and good.content == data
        tampered = bytearray(data)
        tampered[-1] ^= 0xFF   # only the last byte differs: the held-back final chunk must never be sent
        client.app.state.hive.assets.stores["local"]._path(sha).write_bytes(bytes(tampered))
        got = bytearray()
        with pytest.raises((httpx.RemoteProtocolError, httpx.ReadError)):
            with httpx.stream("GET", f"{base}/api/assets/{sha}", headers=auth, timeout=10) as r:
                for part in r.iter_bytes():
                    got += part
        assert len(got) < len(data) and bytes(got) != bytes(tampered)
    finally:
        server.should_exit = True
        thread.join(10)


def test_the_free_space_floor_and_the_mind_cap(client):
    import shutil
    hive = client.app.state.hive
    hive.settings.min_free_bytes = shutil.disk_usage(hive.assets.incoming.parent).free + 10 * 1024 ** 3
    r = client.post("/api/assets", content=b"x" * 100)
    assert r.status_code == 507 and r.json()["error"]["code"] == "insufficient_storage" and incoming(client) == []
    hive.settings.min_free_bytes = 0
    assert client.post("/api/assets", content=b"x" * 100).status_code == 200
    hive.settings.mind_upload_max_bytes = 1000
    _, (a, _) = make_swarm_and_agents(client)
    refused = client.post("/api/agent/assets", content=b"m" * 2000, headers=agent_headers(a) | {"content-type": "application/octet-stream"})
    assert refused.status_code == 413 and incoming(client) == []
    assert client.post("/api/assets", content=b"p" * 2000).status_code == 200   # people keep no cap above the floor
    assert hive.settings.asset_max_bytes is None
