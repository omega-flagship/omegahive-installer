import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import stat
import tempfile
import time
from types import SimpleNamespace

import pytest

from hive.core import code_local_enrolment as local, services as registry
from hive.core.code import Code, CodeError
from hive.core.db import Database
from hive.core.services import LOCAL_CODE_REGISTRATION, ServiceError, Services


@pytest.fixture
def socket_root(monkeypatch):
    monkeypatch.delenv("HIVE_HOST", raising=False)
    monkeypatch.delenv("HIVE_PORT", raising=False)
    # Keep within Darwin's Unix socket path bound regardless of pytest's path.
    with tempfile.TemporaryDirectory(prefix="code-enrol-", dir=Path("/tmp").resolve()) as path:
        yield Path(path)


def services_for(path):
    return Services(SimpleNamespace(db=Database(path)))


async def query(path, request):
    reader, writer = await asyncio.open_unix_connection(path)
    try:
        wire = json.dumps(request).encode() + b"\n" if isinstance(request, dict) else request
        writer.write(wire)
        await writer.drain()
        raw = await reader.readline()
        return json.loads(raw) if raw else None
    finally:
        writer.close()
        await writer.wait_closed()


async def status(bridge, registration=None):
    return await query(bridge.path, {"op": "status", "registration": registration})


def credentials(response):
    return {key: (response[key] if key in response else response["receipt"][key])
            for key in ("service_id", "service_token", "operation_id", "request_digest")}


async def issue(bridge):
    operation, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
    request = {"op": "issue", "hive_id": bridge.hive_id, "operation_id": operation, "token": token}
    assert await query(bridge.path, request) == {"status": "issued", "hive_id": bridge.hive_id}
    return request


async def register(bridge, request):
    return await query(bridge.path, {"op": "register", "hive_id": bridge.hive_id, "token": request["token"],
                                     "body": LOCAL_CODE_REGISTRATION | {"operation_id": request["operation_id"]}})


async def ack(bridge, registration):
    return await query(bridge.path, {"op": "ack", "hive_id": bridge.hive_id,
                                     "token": registration["service_token"],
                                     "operation_id": registration["operation_id"]})


def test_fresh_database_replays_one_reservation_and_registration(socket_root):
    async def run():
        services = services_for(socket_root / "first.db")
        async with local.running(SimpleNamespace(services=services)):
            bridge = SimpleNamespace(path=socket_root / "code.sock")
            fresh = await status(bridge)
            assert fresh["status"] == "fresh"
            assert fresh["hive_url"] == "http://127.0.0.1:8700"
            bridge.hive_id = fresh["hive_id"]
            assert local.HIVE_ID.fullmatch(bridge.hive_id)
            assert stat.S_IMODE(bridge.path.lstat().st_mode) == 0o600
            before_issue = time.time()
            request = await issue(bridge)
            after_issue = time.time()
            expiry = services.db.one("SELECT expires_at FROM service_enrolments")["expires_at"]
            assert before_issue + 86400 <= expiry <= after_issue + 86400
            assert await query(bridge.path, request) == {"status": "issued", "hive_id": bridge.hive_id}
            assert services.db.one("SELECT expires_at FROM service_enrolments")["expires_at"] == expiry
            changed = request | {"token": secrets.token_urlsafe(32)}
            assert await query(bridge.path, changed) == {
                "status": "hold", "hive_id": bridge.hive_id, "hive_url": "http://127.0.0.1:8700"}
            assert (await query(bridge.path, changed | {"operation_id": secrets.token_urlsafe(24)}))["status"] == "hold"

            body = LOCAL_CODE_REGISTRATION | {"operation_id": request["operation_id"]}
            with pytest.raises(ServiceError) as blocked:
                services.register(request["token"], body, "127.0.0.1")
            assert blocked.value.code == "local_only"
            manual = services.enrol("omegacode", "user:invented")
            with pytest.raises(ServiceError) as conflict:
                services.register(manual["enrol_token"], body | {"operation_id": secrets.token_urlsafe(24)},
                                  "127.0.0.1")
            assert conflict.value.code == "local_code_enrolment"
            with pytest.raises(ServiceError) as legacy_conflict:
                services.register(manual["enrol_token"], LOCAL_CODE_REGISTRATION, "127.0.0.1")
            assert legacy_conflict.value.code == "local_code_enrolment"

            first = await register(bridge, request)
            assert first["http_status"] == 200 and first["body"]["receipt"]["status"] == "pending"
            assert first == await register(bridge, request)
            assert (await query(bridge.path, request))["status"] == "issued"
            registration = credentials(first["body"])
            assert (await status(bridge))["status"] == "hold"
            assert (await status(bridge, registration))["status"] == "pending"
            with pytest.raises(ServiceError) as blocked_ack:
                services.acknowledge(registration["operation_id"], registration["service_token"])
            assert blocked_ack.value.code == "local_only"
            acknowledged = await ack(bridge, registration)
            assert acknowledged["body"]["status"] == "active"
            assert acknowledged == await ack(bridge, registration)
            assert (await status(bridge, registration))["status"] == "current"
            assert (await status(bridge, registration | {"service_token": None}))["status"] == "recognized"
            assert (await status(bridge, registration | {"service_token": secrets.token_urlsafe(32)}))["status"] == "hold"
            assert (await register(bridge, request))["body"]["error"] == "operation_complete"
            assert services.db.one("SELECT COUNT(*) AS n FROM services")["n"] == 1
            assert services.db.one("SELECT COUNT(*) AS n FROM service_operations")["n"] == 1
            assert services.db.one("SELECT pending_token FROM service_operations")["pending_token"] is None
            services.set_enabled(registration["service_id"], False)
            assert (await status(bridge, registration))["status"] == "hold"
            assert (await status(bridge, registration | {"service_token": None}))["status"] == "hold"
            services.remove(registration["service_id"])
            assert (await status(bridge, registration))["status"] == "hold"
            assert (await query(bridge.path, changed | {"operation_id": secrets.token_urlsafe(24)}))["status"] == "hold"
        assert not (socket_root / "code.sock").exists()

    with pytest.MonkeyPatch.context() as patch:
        patch.setenv(local.ENV_SOCKET, str(socket_root / "code.sock"))
        asyncio.run(run())


def test_expired_pending_registration_holds_without_a_successor(socket_root, monkeypatch):
    async def run():
        services = services_for(socket_root / "hive.db")
        hive = SimpleNamespace(services=services)
        async with local.running(hive):
            bridge = hive.code_local_enrolment
            request = await issue(bridge)
            pending = credentials((await register(bridge, request))["body"])
            services.db.execute("UPDATE service_enrolments SET expires_at = ?", (time.time() - 1,))
            assert (await status(bridge, pending))["status"] == "hold"
            successor = request | {"operation_id": secrets.token_urlsafe(24), "token": secrets.token_urlsafe(32)}
            assert (await query(bridge.path, successor))["status"] == "hold"
            assert (await ack(bridge, pending))["body"]["error"] == "operation_expired"
            assert services.list() == []
            assert (await query(bridge.path, successor))["status"] == "hold"
            assert services.db.one("SELECT COUNT(*) AS n FROM service_operations")["n"] == 1

    monkeypatch.setenv(local.ENV_SOCKET, str(socket_root / "code.sock"))
    asyncio.run(run())


def test_same_socket_and_new_database_expose_stale_registration(socket_root):
    async def run():
        path = socket_root / "code.sock"
        previous = local.CodeLocalEnrolment(services_for(socket_root / "old.db"), path)
        await previous.start()
        try:
            request = await issue(previous)
            registration = credentials((await register(previous, request))["body"])
            await ack(previous, registration)
        finally:
            await previous.stop()

        restarted = local.CodeLocalEnrolment(services_for(socket_root / "old.db"), path)
        await restarted.start()
        try:
            assert restarted.hive_id == previous.hive_id
            assert (await status(restarted, registration))["status"] == "current"
        finally:
            await restarted.stop()

        replacement = local.CodeLocalEnrolment(services_for(socket_root / "new.db"), path)
        await replacement.start()
        try:
            assert replacement.hive_id != previous.hive_id
            assert (await status(replacement))["status"] == "fresh"
            assert (await status(replacement, registration | {"service_token": None}))["status"] == "unrecognized"
            assert (await query(path, request))["status"] == "hold"
            fresh = await issue(replacement)
            new = credentials((await register(replacement, fresh))["body"])
            await ack(replacement, new)
            assert new["service_id"] != registration["service_id"]
            assert (await status(replacement, new))["status"] == "current"
            assert replacement.db.one("SELECT COUNT(*) AS n FROM services")["n"] == 1
            assert previous.db.one("SELECT COUNT(*) AS n FROM services")["n"] == 1
        finally:
            await replacement.stop()

    asyncio.run(run())


def test_peer_and_frames_are_checked_before_db_effects(socket_root, monkeypatch):
    async def run():
        bridge = local.CodeLocalEnrolment(services_for(socket_root / "hive.db"), socket_root / "code.sock")
        await bridge.start()
        try:
            original_peer = local.peer_uid
            monkeypatch.setattr(local, "peer_uid", lambda _: os.geteuid() + 1)
            assert await query(bridge.path, {"op": "status", "registration": None}) is None
            monkeypatch.setattr(local, "peer_uid", original_peer)
            assert await query(bridge.path, b'{"op":"status","op":"status","registration":null}\n') is None
            assert await query(bridge.path, b"x" * (local.MAX_LINE + 1) + b"\n") is None
            assert (await status(bridge))["status"] == "fresh"
            assert bridge.db.one("SELECT COUNT(*) AS n FROM service_enrolments")["n"] == 0
        finally:
            await bridge.stop()

    asyncio.run(run())


def test_socket_reclaims_only_stale_owned_inode_and_does_not_unlink_replacement(socket_root):
    async def run():
        path = socket_root / "code.sock"
        bridge = local.CodeLocalEnrolment(services_for(socket_root / "hive.db"), path)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
            stale.bind(str(path))
            path.chmod(0o755)
            inode = path.lstat().st_ino
            stale.listen()
            with pytest.raises(ValueError, match="already has a listener"):
                await bridge.start()
            assert path.lstat().st_ino == inode
        await bridge.start()
        assert bridge.ready()
        assert stat.S_IMODE(path.lstat().st_mode) == 0o600
        # A second server cannot unlink the first live socket even if it
        # opens the same private lock path under the same process UID.
        with pytest.raises(BlockingIOError):
            await local.CodeLocalEnrolment(bridge.services, path).start()
        assert (await status(bridge))["status"] == "fresh"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as foreign:
            old = socket_root / "old.sock"
            path.rename(old)
            foreign.bind(str(path))
            path.chmod(0o600)
            assert not bridge.ready()
            await bridge.stop()
            assert path.is_socket()
            assert old.is_socket()

    asyncio.run(run())


def test_failed_bridge_holds_only_code_authority(socket_root, monkeypatch, caplog):
    async def run():
        services = services_for(socket_root / "hive.db")
        hive = services.hive
        hive.services = services
        hive.settings = SimpleNamespace(core_root=socket_root)
        hive.code = Code(hive, None)
        hive.proposal_tests = SimpleNamespace(reason=lambda claims: (None, {"stage": "result"}))
        cap_ids = {}
        for name, address in (("omegacode", local.ADDRESS), ("synthetic", "http://127.0.0.1:8777")):
            enrolment = services.enrol(name, "user:invented")
            service = services.register(enrolment["enrol_token"], {"name": name, "address": address}, "127.0.0.1")
            for stage in ("ordinary", "result"):
                capability = f"cap_{name}_{stage}"
                claims = {"proposal_test": {"stage": stage}} if stage == "result" else {}
                services.db.insert("capabilities", {"id": capability, "service_id": service["service_id"],
                    "claims": json.dumps(claims), "issued_by": "user:invented", "issued_at": time.time(),
                    "expires_at": time.time() + 60})
                cap_ids[name, stage] = services.get(service["service_id"]), capability
        async with local.running(hive):
            assert not hive.code.local_enrolment_available()
            with pytest.raises(CodeError) as refusal:
                hive.code.require_intended_release()
            assert refusal.value.code == "service_release_mismatch"
            held = services.capability_status(*cap_ids["omegacode", "ordinary"])
            assert held["active"] is False and held["reason"] == "code_enrolment_unavailable"
            assert services.capability_status(*cap_ids["omegacode", "result"])["active"] is True
            assert services.capability_status(*cap_ids["synthetic", "ordinary"])["active"] is True
        assert path.read_text() == "invented retained file"
        assert str(path) not in caplog.text

    path = socket_root / "code.sock"
    path.write_text("invented retained file")
    monkeypatch.setenv(local.ENV_SOCKET, str(path))
    asyncio.run(run())


def test_unconfigured_transport_is_inert(socket_root, monkeypatch):
    async def run():
        services = services_for(socket_root / "hive.db")
        async with local.running(SimpleNamespace(services=services)):
            assert services.db.one("SELECT name FROM sqlite_master WHERE name = 'code_local_enrolment_instance'") is None

    monkeypatch.delenv(local.ENV_SOCKET, raising=False)
    asyncio.run(run())


def test_legacy_current_identity_and_configured_loopback_origin(socket_root, monkeypatch):
    async def run():
        monkeypatch.setenv("HIVE_PORT", "8701")
        services = services_for(socket_root / "hive.db")
        original_id = registry.new_id
        monkeypatch.setattr(registry, "new_id", lambda prefix: "svc_0123abcd" if prefix == "svc" else original_id(prefix))
        old = services.enrol("omegacode", "user:invented")
        operation = secrets.token_urlsafe(24)
        previous = services.register(old["enrol_token"], LOCAL_CODE_REGISTRATION | {"operation_id": operation},
                                     "127.0.0.1")
        services.acknowledge(operation, previous["service_token"])
        registration = credentials(previous)
        bridge = local.CodeLocalEnrolment(services, socket_root / "code.sock")
        await bridge.start()
        try:
            expect = {"hive_id": bridge.hive_id, "hive_url": "http://127.0.0.1:8701"}
            assert await status(bridge, registration | {"service_token": None}) == {"status": "recognized", **expect}
            assert await status(bridge, registration) == {"status": "current", **expect}
            assert (await status(bridge, registration | {"service_id": "svc_1234"})) == {"status": "hold", **expect}
        finally:
            await bridge.stop()

    asyncio.run(run())


@pytest.mark.parametrize("key,value", [("HIVE_HOST", "0.0.0.0"), ("HIVE_HOST", "localhost"), ("HIVE_PORT", "0"),
                                        ("HIVE_PORT", "65536"), ("HIVE_PORT", "invalid")])
def test_opt_in_refuses_an_unusable_http_listener(socket_root, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    services = services_for(socket_root / "hive.db")
    path = socket_root / "code.sock"
    with pytest.raises(ValueError):
        local.CodeLocalEnrolment(services, path)
    assert not path.exists()
    assert services.db.one("SELECT name FROM sqlite_master WHERE name = 'code_local_enrolment_instance'") is None


def test_unsafe_socket_directory_or_occupied_file_fails_closed(socket_root):
    async def run():
        services = services_for(socket_root / "hive.db")
        path = socket_root / "code.sock"
        path.write_text("retain")
        with pytest.raises(ValueError, match="occupied"):
            await local.CodeLocalEnrolment(services, path).start()
        assert path.read_text() == "retain"
        socket_root.chmod(0o755)
        try:
            with pytest.raises(ValueError, match="owner-only"):
                await local.CodeLocalEnrolment(services, path).start()
        finally:
            socket_root.chmod(0o700)

    asyncio.run(run())
