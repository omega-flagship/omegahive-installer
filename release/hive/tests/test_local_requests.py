# Purpose: which requests count as local, against the real app (flagship #111: "public versus local is decided by
# forwarded headers").
"""Requests count as local only when they come straight from this machine (sso.direct_local): a loopback peer,
addressed to a loopback name, from no other site's page, with no base path and no proxy's header. A header can only make
a request public. The operator password login is the local-only route most cases use, since it answers 403
password_login_local_only to anything public."""

import pytest
from fastapi.testclient import TestClient

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def refused(response, status, code):
    assert response.status_code == status and response.json()["error"]["code"] == code, response.text


def login(app, peer, base="http://127.0.0.1:8700", headers=None):
    """The operator password login from a client at ``peer`` addressing the hive as ``base``."""
    return TestClient(app, client=peer, base_url=base).post("/api/auth/login", json={"password": "pw"}, headers=headers or {})


LOOPBACK = ("127.0.0.1", 41000)
# the socket a page served at http://127.0.0.1:8700 opens (the test client names its own host otherwise)
EVENTS = "ws://127.0.0.1:8700/api/events"


@pytest.mark.parametrize("peer,base,headers", [
    (LOOPBACK, "http://127.0.0.1:8700", {}),
    (LOOPBACK, "http://localhost:8700", {"Origin": "http://localhost:8700"}),
    (("::1", 41000), "http://[::1]:8700", {}),
    (LOOPBACK, "http://127.0.0.1:8710", {"Origin": "http://127.0.0.1:8710"}),   # an SSH tunnel's local end
], ids=["loopback", "localhost same-origin", "ipv6 loopback", "tunnelled port"])
def test_a_request_straight_from_this_machine_is_local(client, peer, base, headers):
    r = login(client.app, peer, base, headers)
    assert r.status_code == 200 and r.json()["token"], r.text


@pytest.mark.parametrize("peer,base,headers", [
    (("203.0.113.9", 41000), "http://127.0.0.1:8700", {}),                     # another machine, HIVE_HOST beyond loopback
    (("192.168.1.20", 41000), "http://192.168.1.5:8700", {}),                   # a LAN neighbour
    (LOOPBACK, "http://rebound.example:8700", {}),                             # DNS rebinding: a page's own name
    (LOOPBACK, "http://0.0.0.0:8700", {}),                                     # the 0.0.0.0 address, no loopback name
    (LOOPBACK, "http://127.0.0.1:8700", {"Origin": "https://evil.example"}),  # another site's page in this browser
    (LOOPBACK, "http://127.0.0.1:8700", {"Origin": "null"}),                  # a sandboxed app frame
    (LOOPBACK, "http://127.0.0.1:8700", {"Origin": "http://127.0.0.1:3000"}), # a page from another local server
    (LOOPBACK, "http://127.0.0.1:8700", {"Via": "1.1 nginx"}),                # relayed: RFC 9110 Via
    (LOOPBACK, "http://127.0.0.1:8700", {"X-Forwarded-Proto": "https"}),      # relayed: any X-Forwarded-*
    (LOOPBACK, "http://127.0.0.1:8700", {"X-Forwarded-For": "127.0.0.1"}),    # a header only ever makes it public
], ids=["remote peer", "lan peer", "rebound host", "0.0.0.0", "cross-site origin", "null origin", "other local port",
        "via", "x-forwarded-proto", "x-forwarded-for"])
def test_a_request_not_straight_from_this_machine_is_public(client, peer, base, headers):
    refused(login(client.app, peer, base, headers), 403, "password_login_local_only")


def test_the_live_events_socket_from_another_sites_page_gets_no_operator_session(client):
    from starlette.websockets import WebSocketDisconnect
    token = client.headers["Authorization"].removeprefix("Bearer ")
    browser = TestClient(client.app, client=LOOPBACK, base_url="http://127.0.0.1:8700")
    with pytest.raises(WebSocketDisconnect) as closed:
        with browser.websocket_connect(f"{EVENTS}?token={token}", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_text()
    assert closed.value.code == 4401
    with browser.websocket_connect(f"{EVENTS}?token={token}", headers={"Origin": "http://127.0.0.1:8700"}) as ws:
        assert ws.receive_json()["type"]   # the hive's own page: its first frame arrives


def test_from_another_machine_an_operator_session_does_not_count_and_minds_routes_do_not_answer(client):
    token = client.headers["Authorization"]
    remote = TestClient(client.app, client=("203.0.113.9", 41000), base_url="http://127.0.0.1:8700")
    refused(remote.get("/api/agents", headers={"Authorization": token}), 401, "unauthorized")
    refused(remote.get("/api/agent/inbox", headers={"Authorization": token}), 404, "not_found")
    local = TestClient(client.app, client=LOOPBACK, base_url="http://127.0.0.1:8700")
    assert local.get("/api/agents", headers={"Authorization": token}).status_code == 200
