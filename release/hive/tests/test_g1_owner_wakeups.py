"""G1: scheduling spends the mind owner's money; viewing a mind is not write permission."""

import asyncio
from contextlib import ExitStack
import datetime
import json

import pytest
from starlette.requests import Request

from hive.core.hive import token_hash
from hive.core.sso import SSO
from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client  # noqa: F401 (fixture)
from hive.tests.test_visibility import person


def mind_for(client, owner, visibility="public"):
    response = client.post("/api/swarms", headers=owner, json={"name": "Wakeup lab", "visibility": visibility})
    assert response.status_code == 200, response.text
    response = client.post("/api/agents", headers=owner, json={
        "name": "Clock", "kind": "module", "swarm_id": response.json()["id"], "visibility": visibility,
    })
    assert response.status_code == 200, response.text
    return response.json()


def create_wakeup(client, mind, headers, text="owner's private reminder"):
    response = client.post(f"/api/agents/{mind['id']}/wakeups", headers=headers,
                           json={"at": "2099-01-01T00:00:00Z", "text": text})
    assert response.status_code == 200, response.text
    return response.json()


def set_hive_owner(hive, principal):
    hive.ownhive.ensure_owner()
    # A password-only fixture has no named admin: ensure_owner returns user:operator
    # without storing a row. An UPDATE alone would silently leave this person a member.
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    hive.db.execute(
        "INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, ?, 'test-assignment', ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, updated_at = excluded.updated_at",
        (principal, stamp, stamp),
    )
    assert hive.ownhive.owner() == principal
    assert hive.ownhive.is_owner(principal)


def invalidate_auth(hive, headers, principal, invalidation):
    digest = token_hash(headers["Authorization"].split(" ", 1)[1])
    if invalidation == "disabled":
        # Keep the session row: the enabled-person check must work independently of token deletion.
        hive.db.update("people", principal[5:], {"disabled": 1})
        assert hive.db.one("SELECT 1 FROM sessions WHERE token_hash = ?", (digest,)) is not None
    elif invalidation == "revoked":
        hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (digest,))
    else:
        assert invalidation == "expired"
        hive.db.execute("UPDATE sessions SET expires_at = 1 WHERE token_hash = ?", (digest,))


def test_public_viewer_cannot_create_patch_or_delete_wakeups(client):
    owner, outsider = person(client, "u_wake_owner"), person(client, "u_wake_outsider")
    mind = mind_for(client, owner)
    wakeup = create_wakeup(client, mind, owner)
    hive = client.app.state.hive
    before = hive.scheduler.list(mind["id"])
    # The viewer can discover the id; neither that id nor a forged body grants permission.
    assert client.get(f"/api/agents/{mind['id']}/wakeups", headers=outsider).json()[0]["id"] == wakeup["id"]
    responses = [
        client.post(f"/api/agents/{mind['id']}/wakeups", headers=outsider, json={
            "at": "2099-01-01T00:00:00Z", "text": "spend someone else's money", "principal": "user:u_wake_owner",
        }),
        client.patch(f"/api/wakeups/{wakeup['id']}", headers=outsider, json={"text": "changed", "enabled": False}),
        client.delete(f"/api/wakeups/{wakeup['id']}", headers=outsider),
    ]
    assert [response.status_code for response in responses] == [404, 404, 404]
    assert hive.scheduler.list(mind["id"]) == before


@pytest.mark.parametrize("privilege", ["mind_owner", "admin", "hive_owner"])
def test_owner_admin_and_hive_owner_can_manage_private_wakeups(client, privilege):
    owner = person(client, "u_wake_owner")
    mind = mind_for(client, owner, "private")
    if privilege == "mind_owner":
        caller = owner
    elif privilege == "admin":
        caller = person(client, "u_wake_admin", role="admin")
    else:
        caller = person(client, "u_wake_hive_owner")  # a member, independently of the admin role
        set_hive_owner(client.app.state.hive, "user:u_wake_hive_owner")
    wakeup = create_wakeup(client, mind, caller)
    listed = client.get(f"/api/agents/{mind['id']}/wakeups", headers=caller)
    if privilege == "hive_owner":
        assert wakeup["text"] == "text hidden"
        assert listed.status_code == 404  # write authority does not add private-mind read visibility
    else:
        assert listed.status_code == 200 and listed.json()[0]["text"] == wakeup["text"]
    changed = client.patch(f"/api/wakeups/{wakeup['id']}", headers=caller, json={"text": "revised", "enabled": False})
    assert changed.status_code == 200 and not changed.json()["enabled"]
    assert changed.json()["text"] == ("text hidden" if privilege == "hive_owner" else "revised")
    deleted = client.delete(f"/api/wakeups/{wakeup['id']}", headers=caller)
    assert deleted.status_code == 200 and deleted.json() == {"ok": True}
    assert client.app.state.hive.scheduler.list(mind["id"]) == []


@pytest.mark.parametrize("visibility", ["public", "shared"])
def test_viewers_get_metadata_but_only_privileged_people_get_text(client, visibility):
    owner, outsider = person(client, "u_wake_owner"), person(client, "u_wake_outsider")
    mind = mind_for(client, owner, "public")
    if visibility == "shared":
        response = client.put(f"/api/agents/{mind['id']}/visibility", headers=owner,
                              json={"visibility": "shared", "shared_with": ["user:u_wake_outsider"]})
        assert response.status_code == 200
    wakeup = create_wakeup(client, mind, owner)
    listed = client.get(f"/api/agents/{mind['id']}/wakeups", headers=outsider)
    assert listed.status_code == 200
    assert listed.json() == [dict(wakeup, text="text hidden")]
    assert client.get(f"/api/agents/{mind['id']}/wakeups", headers=owner).json() == [wakeup]
    assert client.get(f"/api/agents/{mind['id']}/wakeups").json() == [wakeup]  # local admin
    assert client.app.state.hive.scheduler.get(wakeup["id"])["text"] == wakeup["text"]


@pytest.mark.parametrize("method", ["patch", "delete"])
def test_unknown_private_and_deleted_wakeups_have_the_same_404(client, method):
    owner, outsider = person(client, "u_wake_owner"), person(client, "u_wake_outsider")
    mind = mind_for(client, owner, "private")
    wakeup = create_wakeup(client, mind, owner)

    def request(wakeup_id, headers):
        options = {"json": {"text": "probe"}} if method == "patch" else {}
        return client.request(method.upper(), f"/api/wakeups/{wakeup_id}", headers=headers, **options)

    missing, hidden = request("w_unknown", outsider), request(wakeup["id"], outsider)
    assert missing.status_code == hidden.status_code == 404
    assert missing.json() == hidden.json() == {"error": {"code": "not_found", "message": "no such wakeup"}}
    client.app.state.hive.db.update("agents", mind["id"], {"deleted": 1})
    deleted = request(wakeup["id"], owner)
    assert deleted.status_code == 404 and deleted.json() == missing.json()


@pytest.mark.parametrize("action", ["create", "patch"])
@pytest.mark.parametrize("privilege", ["mind_owner", "admin", "hive_owner"])
def test_privilege_is_rechecked_after_request_body(client, monkeypatch, action, privilege):
    owner = person(client, "u_wake_owner")
    mind = mind_for(client, owner, "private")
    wakeup = create_wakeup(client, mind, owner)
    hive = client.app.state.hive
    if privilege == "mind_owner":
        caller = owner
        revoke = lambda: hive.db.update("agents", mind["id"], {"owner": "user:u_new_owner"})
    elif privilege == "admin":
        caller = person(client, "u_wake_admin", role="admin")
        revoke = lambda: hive.db.update("people", "u_wake_admin", {"role": "member"})
    else:
        caller = person(client, "u_wake_hive_owner")
        set_hive_owner(hive, "user:u_wake_hive_owner")
        revoke = lambda: set_hive_owner(hive, "user:operator")
    path = f"/api/agents/{mind['id']}/wakeups" if action == "create" else f"/api/wakeups/{wakeup['id']}"
    original_json = Request.json

    async def read_and_revoke(request):
        data = await original_json(request)
        if request.url.path == path:
            revoke()
        return data

    monkeypatch.setattr(Request, "json", read_and_revoke)
    response = client.request("POST" if action == "create" else "PATCH", path, headers=caller,
                              json={"at": "2099-02-01T00:00:00Z", "text": "after revocation"})
    assert response.status_code == 404
    assert hive.scheduler.list(mind["id"]) == [wakeup]


@pytest.mark.parametrize("action", ["create", "patch"])
@pytest.mark.parametrize("privilege", ["mind_owner", "hive_owner"])
@pytest.mark.parametrize("invalidation", ["disabled", "revoked", "expired"])
def test_authentication_is_rechecked_after_request_body(client, monkeypatch, action, privilege, invalidation):
    owner = person(client, "u_wake_owner")
    mind = mind_for(client, owner, "private")
    wakeup = create_wakeup(client, mind, owner)
    hive = client.app.state.hive
    if privilege == "mind_owner":
        caller, principal = owner, "user:u_wake_owner"
    else:
        caller, principal = person(client, "u_wake_hive_owner"), "user:u_wake_hive_owner"
        set_hive_owner(hive, principal)
    path = f"/api/agents/{mind['id']}/wakeups" if action == "create" else f"/api/wakeups/{wakeup['id']}"
    original_json = Request.json

    async def read_and_invalidate(request):
        data = await original_json(request)
        if request.url.path == path:
            invalidate_auth(hive, caller, principal, invalidation)
        return data

    monkeypatch.setattr(Request, "json", read_and_invalidate)
    response = client.request("POST" if action == "create" else "PATCH", path, headers=caller,
                              json={"at": "2099-02-01T00:00:00Z", "text": "after invalidation"})
    assert response.status_code == 401
    assert response.json() == {"error": {"code": "unauthorized", "message": "log in first"}}
    assert hive.scheduler.list(mind["id"]) == [wakeup]


def test_patch_uses_stored_mind_and_cannot_retarget_a_wakeup(client):
    owner, outsider = person(client, "u_wake_owner"), person(client, "u_wake_outsider")
    mine, theirs = mind_for(client, owner), mind_for(client, outsider)
    wakeup = create_wakeup(client, mine, owner)
    response = client.patch(f"/api/wakeups/{wakeup['id']}", headers=owner,
                            json={"agent_id": theirs["id"], "text": "still mine"})
    assert response.status_code == 200 and response.json()["agent_id"] == mine["id"]
    assert client.app.state.hive.scheduler.list(theirs["id"]) == []


def test_operator_auth_and_unrelated_visibility_checks_are_preserved(client):
    owner, outsider = person(client, "u_wake_owner"), person(client, "u_wake_outsider")
    mind = mind_for(client, owner, "private")
    wakeup = create_wakeup(client, mind, owner)
    assert client.get(f"/api/agents/{mind['id']}/traces", headers=outsider).status_code == 404
    for headers in ({"Authorization": "Bearer invalid"}, agent_headers(mind)):
        assert client.get(f"/api/agents/{mind['id']}/wakeups", headers=headers).status_code == 401
        assert client.post(f"/api/agents/{mind['id']}/wakeups", headers=headers, json={}).status_code == 401
        assert client.patch(f"/api/wakeups/{wakeup['id']}", headers=headers, json={}).status_code == 401
        assert client.delete(f"/api/wakeups/{wakeup['id']}", headers=headers).status_code == 401


def test_live_wakeup_updates_apply_the_same_text_policy(client):
    owner, outsider = person(client, "u_wake_owner"), person(client, "u_wake_outsider")
    mind = mind_for(client, owner)
    owner_token = owner["Authorization"].split(" ", 1)[1]
    outsider_token = outsider["Authorization"].split(" ", 1)[1]
    with client.websocket_connect(f"/api/events?token={owner_token}") as owner_ws:
        assert json.loads(owner_ws.receive_text())["type"] == "hello"
        with client.websocket_connect(f"/api/events?token={outsider_token}") as outsider_ws:
            assert json.loads(outsider_ws.receive_text())["type"] == "hello"
            wakeup = create_wakeup(client, mind, owner)
            owner_frame = json.loads(owner_ws.receive_text())
            outsider_frame = json.loads(outsider_ws.receive_text())
            assert owner_frame["type"] == outsider_frame["type"] == "wakeup.updated"
            assert owner_frame["wakeup"] == wakeup
            assert outsider_frame["wakeup"] == dict(wakeup, text="text hidden")
            changed = client.patch(f"/api/wakeups/{wakeup['id']}", headers=owner, json={"text": "next secret"})
            assert changed.status_code == 200
            assert json.loads(owner_ws.receive_text())["wakeup"]["text"] == "next secret"
            assert json.loads(outsider_ws.receive_text())["wakeup"]["text"] == "text hidden"


@pytest.mark.parametrize("privilege", ["mind_owner", "hive_owner"])
@pytest.mark.parametrize("invalidation", ["disabled", "revoked", "expired"])
def test_live_wakeup_updates_revalidate_authentication(client, privilege, invalidation):
    owner = person(client, "u_wake_owner")
    mind = mind_for(client, owner)
    wakeup = create_wakeup(client, mind, owner)
    hive = client.app.state.hive
    if privilege == "mind_owner":
        caller, principal = owner, "user:u_wake_owner"
    else:
        caller, principal = person(client, "u_wake_hive_owner"), "user:u_wake_hive_owner"
        set_hive_owner(hive, principal)
    token = caller["Authorization"].split(" ", 1)[1]
    with client.websocket_connect(f"/api/events?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        active = client.patch(f"/api/wakeups/{wakeup['id']}", json={"text": "active session text"})
        assert active.status_code == 200
        assert json.loads(ws.receive_text())["wakeup"]["text"] == ("text hidden" if privilege == "hive_owner" else "active session text")
        invalidate_auth(hive, caller, principal, invalidation)
        changed = client.patch(f"/api/wakeups/{wakeup['id']}", json={"text": "never deliver after invalidation"})
        assert changed.status_code == 200
        # This public marker follows the update in the same event queue. It bounds the negative
        # assertion without a timed receive or assuming that a ping ran after the event pump.
        hive.events.publish("programs.updated", programs=[], g1_marker="after invalidation")
        frame = json.loads(ws.receive_text())
        assert frame["type"] == "programs.updated" and frame["g1_marker"] == "after invalidation"


def through_marker(ws, marker):
    """Drain a bounded prefix ending at a public same-queue marker, without timing a negative receive."""
    frames = []
    for _ in range(20):
        frame = json.loads(ws.receive_text())
        if frame.get("type") == "programs.updated" and frame.get("g1_marker") == marker:
            return frames
        frames.append(frame)
    raise AssertionError("event marker was not reached in the bounded prefix")


@pytest.mark.parametrize("visibility", ["public", "shared"])
def test_fired_wakeup_text_is_owner_admin_only_in_HTTP_and_live_messages(client, monkeypatch, visibility):
    owner = person(client, "u_fire_owner")
    outsider = person(client, "u_fire_viewer")
    admin = person(client, "u_fire_admin", role="admin")
    hive_owner = person(client, "u_fire_hive_owner")
    hive = client.app.state.hive
    set_hive_owner(hive, "user:u_fire_hive_owner")
    mind = mind_for(client, owner)
    if visibility == "shared":
        assert client.put(f"/api/agents/{mind['id']}/visibility", headers=owner,
                          json={"visibility": "shared", "shared_with": ["user:u_fire_viewer", "user:u_fire_hive_owner"]}).status_code == 200
    wakeup = create_wakeup(client, mind, owner, "fire-time private reminder")
    expected = f"[WAKE {wakeup['id']}] fire-time private reminder"
    delivered = []

    async def capture(_agent_id, message):
        delivered.append(dict(message))

    monkeypatch.setattr(hive, "deliver", capture)
    readers = [(owner, expected), (admin, expected), (hive_owner, "text hidden"), (outsider, "text hidden")]
    with ExitStack() as stack:
        sockets = []
        for headers, wanted in readers:
            token = headers["Authorization"].split(" ", 1)[1]
            ws = stack.enter_context(client.websocket_connect(f"/api/events?token={token}"))
            assert json.loads(ws.receive_text())["type"] == "hello"
            sockets.append((ws, headers, wanted))
        due = datetime.datetime.fromisoformat(wakeup["next_run_at"].replace("Z", "+00:00"))
        assert asyncio.run(hive.scheduler.tick(at=due)) == [wakeup["id"]]
        hive.events.publish("programs.updated", programs=[], g1_marker="fired")
        for ws, headers, wanted in sockets:
            rows = client.get(f"/api/agents/{mind['id']}/messages", headers=headers).json()
            assert next(row for row in rows if row["sender"] == "hive:schedule")["text"] == wanted
            frames = through_marker(ws, "fired")
            messages = [frame["message"] for frame in frames if frame.get("type") == "message" and frame.get("message", {}).get("sender") == "hive:schedule"]
            assert len(messages) == 1 and messages[0]["text"] == wanted
            fired = [(frame.get("wakeup_id"), frame.get("agent_id")) for frame in frames if frame.get("type") == "wakeup.fired"]
            assert fired == ([(wakeup["id"], mind["id"])] if wanted == expected else [])
        assert delivered[-1]["text"] == expected
        assert hive.db.one("SELECT text FROM messages WHERE agent_id = ? AND sender = 'hive:schedule'", (mind["id"],))["text"] == expected
        assert client.delete(f"/api/wakeups/{wakeup['id']}", headers=owner).status_code == 200
        # Historical delivery privacy is attached to the stored mind, not to a wakeup row that may be deleted.
        for headers, wanted in readers:
            rows = client.get(f"/api/agents/{mind['id']}/messages", headers=headers).json()
            assert next(row for row in rows if row["sender"] == "hive:schedule")["text"] == wanted


def test_hive_owner_can_change_wakeup_without_reading_other_owners_text(client):
    owner, hive_owner = person(client, "u_write_owner"), person(client, "u_write_hive_owner")
    hive = client.app.state.hive
    mind = mind_for(client, owner)
    wakeup = create_wakeup(client, mind, owner, "never echo this to the hive owner")
    set_hive_owner(hive, "user:u_write_hive_owner")
    changed = client.patch(f"/api/wakeups/{wakeup['id']}", headers=hive_owner, json={"enabled": False})
    assert changed.status_code == 200 and changed.json()["text"] == "text hidden"
    assert changed.json()["enabled"] is False
    listed = client.get(f"/api/agents/{mind['id']}/wakeups", headers=hive_owner)
    assert listed.status_code == 200 and listed.json()[0]["text"] == "text hidden"
    assert client.get(f"/api/agents/{mind['id']}/wakeups", headers=owner).json()[0]["text"] == wakeup["text"]
    assert hive.scheduler.get(wakeup["id"])["text"] == wakeup["text"]


@pytest.fixture()
def listed_family_client(monkeypatch, request):
    # Load the actual app's legacy-family namespace with an allowed username, before its SSO object is made.
    monkeypatch.setenv("HIVE_SSO_USERS", "familywake")
    return request.getfixturevalue("client")


def test_disabled_family_SSO_person_is_refused_for_all_wakeup_routes(listed_family_client, monkeypatch):
    client = listed_family_client
    hive = client.app.state.hive
    monkeypatch.setattr(SSO, "person", lambda _self, _cookie: {
        "username": "familywake", "name": "Family Wake", "email": "", "role": "admin", "allowed": True, "expires": 4102444800,
    })
    signed_in = client.post("/api/auth/sso")
    assert signed_in.status_code == 200
    headers = {"Authorization": "Bearer " + signed_in.json()["token"]}
    assert client.get("/api/auth/me", headers=headers).json()["role"] == "admin"
    owner = person(client, "u_family_target")
    mind = mind_for(client, owner)
    wakeup = create_wakeup(client, mind, owner)
    # The people schema/update API accepts existing IDs in either user namespace. Retain the live token row
    # deliberately so the G1 disabled lookup, independently of session revocation, is exercised.
    hive.db.insert("people", {"id": "familywake", "email": "familywake@example.test", "name": "Family Wake", "role": "admin", "created_at": "2026-10-25T00:00:00Z", "disabled": 1})
    digest = token_hash(signed_in.json()["token"])
    assert hive.db.one("SELECT 1 FROM sessions WHERE token_hash = ?", (digest,)) is not None
    responses = [client.get(f"/api/agents/{mind['id']}/wakeups", headers=headers),
                 client.post(f"/api/agents/{mind['id']}/wakeups", headers=headers, json={"at": "2099-01-01T00:00:00Z"}),
                 client.patch(f"/api/wakeups/{wakeup['id']}", headers=headers, json={"enabled": False}),
                 client.delete(f"/api/wakeups/{wakeup['id']}", headers=headers)]
    assert [response.status_code for response in responses] == [401, 401, 401, 401]
    assert hive.scheduler.get(wakeup["id"])["enabled"]


def test_malformed_wakeup_event_logs_only_a_constant_warning(client, caplog):
    with client.websocket_connect(f"/api/events?token={client.operator_token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        hive = client.app.state.hive
        hive.events.publish("wakeup.updated", wakeup={"id": None, "text": "do not log this private payload"})
        hive.events.publish("programs.updated", programs=[], g1_marker="malformed")
        assert through_marker(ws, "malformed") == []
    warnings = [r for r in caplog.records if r.name == "hive" and r.levelname == "WARNING"]
    assert [r.getMessage() for r in warnings] == ["Dropped malformed wakeup.updated event"]
    assert "do not log this private payload" not in caplog.text


@pytest.mark.parametrize("visibility", ["public", "shared"])
@pytest.mark.parametrize("legacy_sender", [False, True])
@pytest.mark.parametrize("access", ["id", "alias", "direct"])
def test_converted_legacy_DM_schedule_history_stays_private(client, visibility, legacy_sender, access):
    owner, outsider = person(client, "u_room_owner"), person(client, "u_room_viewer")
    hive = client.app.state.hive
    mind = mind_for(client, owner)
    wakeup = create_wakeup(client, mind, owner, "private room history")
    due = datetime.datetime.fromisoformat(wakeup["next_run_at"].replace("Z", "+00:00"))
    assert asyncio.run(hive.scheduler.tick(at=due)) == [wakeup["id"]]
    room = hive.db.one("SELECT * FROM rooms WHERE alias = ?", ("c_" + mind["id"],))
    assert room is not None
    # The existing room API permits conversion while retaining this stored mind alias. Exercise the old
    # system:hive rows too, not only the new exact provenance retained by mirror_in.
    converted = client.patch(f"/api/rooms/{room['id']}", json={"kind": "channel", "name": "Wake history"})
    assert converted.status_code == 200, converted.text
    visible = client.patch(f"/api/rooms/{room['id']}", json={"visibility": visibility})
    assert visible.status_code == 200, visible.text
    assert client.post(f"/api/rooms/{room['id']}/members", json={"members": ["user:u_room_owner", "user:u_room_viewer"]}).status_code == 200
    if legacy_sender:
        hive.db.execute("UPDATE room_messages SET sender = 'system:hive' WHERE room_id = ? AND sender = 'hive:schedule'", (room["id"],))
    for headers, principal, wanted in ((outsider, "user:u_room_viewer", "text hidden"), (owner, "user:u_room_owner", f"[WAKE {wakeup['id']}] private room history")):
        if access == "direct":
            messages = hive.rooms.messages(Viewer(principal, False), room["alias"])
        else:
            address = room["id"] if access == "id" else room["alias"]
            response = client.get(f"/api/rooms/{address}/messages", headers=headers)
            assert response.status_code == 200, response.text
            messages = response.json()
        assert next(row for row in messages if row["sender"] in ("system:hive", "hive:schedule"))["text"] == wanted
    assert hive.db.one("SELECT text FROM room_messages WHERE room_id = ?", (room["id"],))["text"].endswith("private room history")


@pytest.mark.parametrize("change", ["disabled", "revoked", "expired", "owner_changed", "admin_demoted"])
def test_fired_message_rechecks_current_authentication_and_text_privilege(client, change):
    owner = person(client, "u_live_fire_owner")
    mind = mind_for(client, owner)
    wakeup = create_wakeup(client, mind, owner, "must not reach a stale reader")
    hive = client.app.state.hive
    caller, principal = owner, "user:u_live_fire_owner"
    if change == "admin_demoted":
        caller, principal = person(client, "u_live_fire_admin", role="admin"), "user:u_live_fire_admin"
    token = caller["Authorization"].split(" ", 1)[1]
    with client.websocket_connect(f"/api/events?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        if change in ("disabled", "revoked", "expired"):
            invalidate_auth(hive, caller, principal, change)
        elif change == "owner_changed":
            hive.db.update("agents", mind["id"], {"owner": "user:u_other_owner"})
        else:
            hive.db.update("people", "u_live_fire_admin", {"role": "member"})
        due = datetime.datetime.fromisoformat(wakeup["next_run_at"].replace("Z", "+00:00"))
        assert asyncio.run(hive.scheduler.tick(at=due)) == [wakeup["id"]]
        hive.events.publish("programs.updated", programs=[], g1_marker="current authority")
        frames = through_marker(ws, "current authority")
        scheduled = [frame["message"] for frame in frames if frame.get("type") == "message" and frame.get("message", {}).get("sender") == "hive:schedule"]
        assert [frame for frame in frames if frame.get("type") == "wakeup.fired"] == []
        if change in ("disabled", "revoked", "expired"):
            assert scheduled == []
        else:
            assert len(scheduled) == 1 and scheduled[0]["text"] == "text hidden"


def test_internal_host_scheduling_and_delivery_are_unchanged(client):
    owner = person(client, "u_wake_owner")
    mind = mind_for(client, owner, "private")
    hive = client.app.state.hive
    wakeup = hive.scheduler.create(mind["id"], at="2099-01-01T00:00:00Z", text="host reminder")
    due = datetime.datetime.fromisoformat(wakeup["next_run_at"].replace("Z", "+00:00"))
    assert asyncio.run(hive.scheduler.tick(at=due)) == [wakeup["id"]]
    assert not hive.scheduler.get(wakeup["id"])["enabled"]
    messages = client.get(f"/api/agents/{mind['id']}/messages", headers=owner).json()
    assert messages[-1]["text"] == f"[WAKE {wakeup['id']}] host reminder"
