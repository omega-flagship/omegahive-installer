"""Synthetic real-HTTP P4b regressions. Source proposal; qualification is recorded separately."""

import base64
import hashlib
import json
import os
import time
import types
import uuid

import pytest

from hive.core.db import now
from hive.core.hive import token_hash
from hive.core.me_decisions import MeDecisions
import hive.core.me_decisions as me_decisions_module
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401
from hive.tests.test_visibility import person


ROUTES = ("/api/me/decisions", "/api/me/studio-sessions")
CATEGORIES = ("approvals", "limit_requests", "own_requests", "ask_intents", "studio_sessions")


@pytest.fixture
def me_env(monkeypatch):
    monkeypatch.setenv("HIVE_SSO_USERS", "family")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "0")
    monkeypatch.setenv("HIVE_APP_GRANT_RENEWAL", "{}")


@pytest.fixture
def c(me_env, request):
    # Resolve the inherited real app fixture only after the synthetic environment is fixed.
    return request.getfixturevalue("client")


def session(c, principal="user:u_p4b_alice", kind="sso", expires=None):
    token = "p4b-synthetic-" + uuid.uuid4().hex
    c.app.state.hive.db.insert("sessions", {"token_hash": token_hash(token), "kind": kind, "principal": principal,
                                         "expires_at": time.time() + 3600 if expires is None else expires, "created_at": now()})
    return {"Authorization": "Bearer " + token}


def human(c, name="u_p4b_alice", role="member"):
    person(c, name, role=role)
    return session(c, "user:" + name)


def request_row(hive, principal, suffix="one", **changes):
    row = {"id": "pr_p4b_" + suffix, "kind": "allowance", "requested_by": principal, "payload": "{}",
           "note": "not in the projection", "status": "pending", "created_at": "2026-10-01T00:00:00Z"}
    row.update(changes)
    hive.db.insert("person_requests", row)
    return row


def approval(hive, agent, suffix="one", **changes):
    row = {"id": "p_p4b_" + suffix, "agent_id": agent["id"], "skill": "write-file", "command": "PRIVATE_COMMAND_SENTINEL",
           "reason": "PRIVATE_REASON_SENTINEL", "risk": "medium", "status": "pending", "created_at": "2026-10-01T00:00:00Z"}
    row.update(changes)
    hive.db.insert("approvals", row)
    return row


def studio_row(hive, principal, swarm_id, state="active"):
    key = uuid.uuid4().hex[:24]
    row = {"id": "ss_" + key, "intent_id": "i_" + key, "principal": principal, "ask_turn_id": "at_" + key,
           "thread_id": None, "swarm_id": swarm_id, "program_id": "p4b", "app_pin": "{}", "maker_id": "a_" + key[:8],
           "goal_id": "g_" + key, "proposal_artifact_id": "art_" + key, "piece": "{\"private\":\"PIECE_SENTINEL\"}",
           "stream_id": "as_" + key, "source_artifact_id": None, "payer": principal, "own_key": 1,
           "key_id": "k_1234abcd", "model": "mock/echo", "role_id": None, "tools": "[]", "cap_usd": 1,
           "step_cap_usd": 0.1, "step_window_s": 180, "max_steps": 1, "expires_at": "2099-01-01T00:00:00Z",
           "consent_digest": "sha256:" + "0" * 64, "consent_payload_version": 2, "state": state, "state_reason": None,
           "created_at": now(), "updated_at": now()}
    hive.db.insert("studio_sessions", row)
    return row


def items(response, category):
    assert response.status_code == 200
    return response.json()["categories"][category]["items"]


@pytest.mark.parametrize("route", ROUTES)
def test_empty_human_read_is_closed_and_does_not_migrate_owner(c, route):
    hive = c.app.state.hive
    before = hive.db._conn.total_changes
    owners = hive.db.all("SELECT * FROM hive_owner")
    r = c.get(route)
    assert r.status_code == 200
    if route.endswith("decisions"):
        assert set(r.json()) == {"schema", "categories"}
        assert set(r.json()["categories"]) == set(CATEGORIES)
        assert all(p == {"items": [], "next_cursor": None} for p in r.json()["categories"].values())
    else:
        assert r.json() == {"schema": "hive.me-studio-sessions/1", "items": [], "next_cursor": None}
    assert hive.db._conn.total_changes == before and hive.db.all("SELECT * FROM hive_owner") == owners


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("populated", (False, True))
@pytest.mark.parametrize("bad", ("missing", "expired", "disabled", "service", "sso-bootstrap", "unknown", "password_other", "sso_missing", "malformed_expiry", "malformed_principal"))
def test_nonhuman_or_stale_auth_is_401_before_empty_or_query_parsing(c, route, populated, bad):
    hive = c.app.state.hive
    valid = human(c)
    if populated:
        request_row(hive, "user:u_p4b_alice")
    if bad == "missing":
        headers = {"Authorization": ""}       # overrides the inherited client's operator header
    elif bad == "expired":
        headers = session(c, expires=time.time() - 1)
    elif bad == "disabled":
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_p4b_alice'")
        headers = valid
    elif bad == "password_other":
        headers = session(c, kind="password")
    elif bad == "sso_missing":
        headers = session(c, principal=None)
    elif bad == "malformed_expiry":
        headers = session(c, expires="not-a-time")
    elif bad == "malformed_principal":
        headers = session(c, principal="not-a-person")
    else:
        headers = session(c, kind=bad)
    before = hive.db._conn.total_changes
    r = c.get(route + "?include=personal&limit=0&limit=2", headers=headers)
    assert r.status_code == 401
    assert hive.db._conn.total_changes == before


def test_migrated_password_and_allowlisted_family_are_human_but_not_other_people(c):
    hive = c.app.state.hive
    human(c)
    request_row(hive, "user:u_p4b_alice")
    old = session(c, principal=None, kind="password")
    token = old["Authorization"][7:]
    hive.db.execute("UPDATE sessions SET expires_at = NULL WHERE token_hash = ?", (token_hash(token),))
    assert c.get(ROUTES[0], headers=old).status_code == 200
    family = session(c, principal="user:family")
    assert items(c.get(ROUTES[0], headers=family), "own_requests") == []
    assert c.get(ROUTES[0], headers=session(c, principal="user:not-allowlisted")).status_code == 401


def test_own_requests_do_not_turn_admin_audit_into_ownership(c):
    hive = c.app.state.hive
    alice, bob, admin = human(c), human(c, "u_p4b_bob"), human(c, "u_p4b_admin", "admin")
    row = request_row(hive, "user:u_p4b_alice")
    mine = items(c.get(ROUTES[0], headers=alice), "own_requests")
    assert mine == [{"kind": "own_request", "id": row["id"], "request_kind": "allowance", "state": "pending", "created_at": row["created_at"]}]
    assert items(c.get(ROUTES[0], headers=bob), "own_requests") == []
    assert items(c.get(ROUTES[0], headers=admin), "own_requests") == []


def test_pending_own_access_request_stays_informational_before_swarm_access(c):
    alice, bob = human(c), human(c, "u_p4b_bob")
    swarm = c.post("/api/swarms", headers=bob, json={"name": "Bob private"}).json()
    assert c.get("/api/swarms/" + swarm["id"], headers=alice).status_code == 404
    made = c.post("/api/asks", headers=alice, json={"kind": "swarm_access", "payload": {"swarm_id": swarm["id"]}})
    assert made.status_code == 200
    r = c.get(ROUTES[0], headers=alice)
    assert [x["id"] for x in items(r, "own_requests")] == [made.json()["id"]]
    assert swarm["id"] not in r.text and "payload" not in r.text


def test_own_admin_request_keeps_existing_personal_list_suppression(c):
    hive = c.app.state.hive
    admin, bob = human(c, "u_p4b_admin", "admin"), human(c, "u_p4b_bob")
    swarm = c.post("/api/swarms", headers=bob, json={"name": "Bob personal"}).json()
    hive.db.execute("UPDATE swarms SET personal_of = 'user:u_p4b_bob', visibility = 'private' WHERE id = ?", (swarm["id"],))
    request_row(hive, "user:u_p4b_admin", payload=json.dumps({"swarm_id": swarm["id"]}))
    assert items(c.get(ROUTES[0], headers=admin), "own_requests") == []


@pytest.mark.parametrize("state", ("active", "paused", "stopping", "stopped", "held"))
def test_same_minimal_own_studio_projection_on_both_routes(c, state):
    hive = c.app.state.hive
    alice, admin = human(c), human(c, "u_p4b_admin", "admin")
    swarm = c.post("/api/swarms", headers=alice, json={"name": "Own"}).json()
    row = studio_row(hive, "user:u_p4b_alice", swarm["id"], state)
    a = items(c.get(ROUTES[0], headers=alice), "studio_sessions")
    b = c.get(ROUTES[1], headers=alice)
    assert b.status_code == 200 and b.json()["items"] == a
    assert a == [{"kind": "studio_session", "id": row["id"], "state": state, "created_at": row["created_at"], "updated_at": row["updated_at"]}]
    assert c.get(ROUTES[1], headers=admin).json()["items"] == []
    assert "PIECE_SENTINEL" not in b.text and "key_id" not in b.text and "stop" not in b.json()["items"][0]


def test_current_studio_visibility_and_named_role_are_rechecked(c):
    hive = c.app.state.hive
    alice, bob = human(c), human(c, "u_p4b_bob")
    swarm = c.post("/api/swarms", headers=alice, json={"name": "Home"}).json()
    studio_row(hive, "user:u_p4b_alice", swarm["id"])
    assert len(c.get(ROUTES[1], headers=alice).json()["items"]) == 1
    hive.db.execute("UPDATE swarms SET owner = 'user:u_p4b_bob', visibility = 'private', shared_with = '[]' WHERE id = ?", (swarm["id"],))
    assert c.get(ROUTES[1], headers=alice).json()["items"] == []
    hive.db.execute("UPDATE people SET role = 'unknown' WHERE id = 'u_p4b_alice'")
    assert c.get(ROUTES[1], headers=alice).status_code == 401


@pytest.mark.parametrize("risk,skill,cap,positive,never", (
    ("medium", "write-file", None, True, True), ("high", "shell", None, False, True),
    ("medium", "write-file", "ask", False, True), ("medium", "write-file", "deny", False, False)))
def test_approval_lasting_allow_and_never_are_distinct_and_capped(c, risk, skill, cap, positive, never):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    row = approval(hive, agent, risk=risk, skill=skill)
    if cap:
        hive.db.insert("app_template_rules", {"agent_id": agent["id"], "skill": skill, "mode": cap, "program_id": "p4b", "template_digest": "synthetic"})
    result = items(c.get(ROUTES[0]), "approvals")
    if cap == "deny":
        assert result == []
    else:
        assert result[0]["id"] == row["id"]
        assert result[0]["answers"] == {"once": True, "for": positive, "always": positive, "no": True, "never": never}
        assert "PRIVATE_COMMAND_SENTINEL" not in json.dumps(result) and "command" not in result[0]


def exact_program(hive, agent, *, folder=None, digest=None):
    module = types.ModuleType("p4b_synthetic")
    hive.programs.programs["p4b"] = {"id": "p4b", "module": module, "error": None,
                                     "path": str(folder or "/unopened-p4b-synthetic"), "digest": digest,
                                     "describe": {"actions": [{"id": "save", "agents": True}]}}
    binding = {"principal": "agent:" + agent["id"], "actor": agent["id"], "swarm_id": agent["swarm_id"],
               "program": "p4b", "action": "save", "items": [], "binding_params": {}, "payload_digest": "synthetic",
               "base_revision": None, "idempotency_key": "p4b.once"}
    return approval(hive, agent, skill="program:p4b:save", binding=json.dumps(binding))


def test_exact_program_approval_is_once_only_and_current(c):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    exact_program(hive, agent)
    answer = items(c.get(ROUTES[0]), "approvals")[0]["answers"]
    assert answer == {"once": True, "for": False, "always": False, "no": True, "never": False}
    hive.programs.disabled.add("p4b")
    assert items(c.get(ROUTES[0]), "approvals") == []


def test_program_grants_revoked_and_pending_restore_are_not_active_authority(c):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    exact_program(hive, agent)
    hive.db.insert("app_authority", {"program": "p4b", "grants_revoked": 1})
    assert items(c.get(ROUTES[0]), "approvals") == []
    hive.db.execute("UPDATE app_authority SET grants_revoked = 0, restored_at = ?, restore_applied_at = NULL WHERE program = 'p4b'", (now(),))
    assert items(c.get(ROUTES[0]), "approvals") == []


def pinned_program(hive, agent, tmp_path):
    folder = tmp_path / "p4b-release"
    (folder / "a").mkdir(parents=True)
    (folder / "ui").mkdir()
    bodies = (("plugin.json", b'{"id":"p4b"}'), ("a/b.py", b"nested = 1\n"), ("a.py", b"sibling = 2\n"),
              ("ui/bundle.lock.json", b'{}\n'))
    digest = hashlib.sha256()
    for rel, data in bodies:      # independently fixed Path order, deliberately different from string order
        (folder / rel).write_bytes(data)
        digest.update(rel.encode() + b"\0" + data + b"\0")
    want = "sha256:" + digest.hexdigest()
    exact_program(hive, agent, folder=folder, digest=want)
    hive.programs.pins["p4b"] = {"release": str(folder), "digest": want,
                                  "files": {"a.py": hashlib.sha256(b"sibling = 2\n").hexdigest()}}
    return folder


def test_pinned_program_bounded_reader_preserves_source_order_and_skip_rules(c, tmp_path):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    folder = pinned_program(hive, agent, tmp_path)
    (folder / "data").mkdir()
    (folder / "data/private.py").write_text("never read this ignored fixture\n")
    assert len(items(c.get(ROUTES[0]), "approvals")) == 1
    (folder / "a.py").write_text("changed = 3\n")
    assert c.get(ROUTES[0]).status_code == 409


def test_pinned_program_unknown_symlink_is_bounded_failure_not_empty_success(c, tmp_path):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    folder = pinned_program(hive, agent, tmp_path)
    (folder / "alias.py").symlink_to(folder / "a.py")
    assert c.get(ROUTES[0]).status_code == 503


def test_program_inspector_counts_ignored_entries_before_sorting(c, tmp_path):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    folder = pinned_program(hive, agent, tmp_path)
    for number in range(4097):
        (folder / f"ignored-{number}.txt").touch()
    assert c.get(ROUTES[0]).status_code == 503


def limit_world(c):
    hive = c.app.state.hive
    owner, alice = human(c, "u_p4b_owner", "admin"), human(c)
    key = "k_1234abcd"
    hive.keyring.ring["keys"][key] = {"id": key, "provider": "mock", "owner": "user:u_p4b_owner"}
    swarm = c.post("/api/swarms", headers=alice, json={"name": "Alice"}).json()
    agent = c.post("/api/agents", headers=alice, json={"name": "Alice mind", "kind": "omega", "swarm_id": swarm["id"], "model": "mock/echo"}).json()
    hive.db.execute("UPDATE agents SET options = ?, visibility = 'public' WHERE id = ?", (json.dumps({"key": key}), agent["id"]))
    made = c.post("/api/me/limit-requests", headers=alice, json={"agent_id": agent["id"], "amount_usd": 10})
    assert made.status_code == 200
    return hive, owner, alice, agent, made.json()


def test_first_grant_request_can_be_current_while_key_owner_currently_pays(c):
    hive, owner, alice, agent, row = limit_world(c)
    got = items(c.get(ROUTES[0], headers=owner), "limit_requests")
    assert got == [{"kind": "limit_request", "id": row["id"], "agent_id": agent["id"], "state": "pending", "created_at": row["created_at"],
                    "answers": {"approve": True, "adjust": True, "decline": True}}]
    assert items(c.get(ROUTES[0], headers=alice), "limit_requests") == []
    assert hive.db.one("SELECT 1 FROM key_limits WHERE grantee = 'user:u_p4b_alice'") is None


@pytest.mark.parametrize("change", ("deleted_key", "key_owner", "assigned_key", "mind_payer", "requester_disabled", "requester_visibility"))
def test_limit_request_never_inherits_stale_key_owner_or_mind_authority(c, change):
    hive, owner, alice, agent, _row = limit_world(c)
    if change == "deleted_key":
        hive.keyring.ring["keys"].pop("k_1234abcd")
    elif change == "key_owner":
        human(c, "u_p4b_other")
        hive.keyring.ring["keys"]["k_1234abcd"]["owner"] = "user:u_p4b_other"
    elif change == "assigned_key":
        hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": "k_9999abcd"}), agent["id"]))
    elif change == "mind_payer":
        human(c, "u_p4b_other")
        hive.db.execute("UPDATE agents SET owner = 'user:u_p4b_other' WHERE id = ?", (agent["id"],))
    elif change == "requester_disabled":
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_p4b_alice'")
    else:
        hive.db.execute("UPDATE agents SET owner = 'user:u_p4b_owner', visibility = 'private', shared_with = '[]' WHERE id = ?", (agent["id"],))
    before = hive.db._conn.total_changes
    assert items(c.get(ROUTES[0], headers=owner), "limit_requests") == []
    assert hive.db._conn.total_changes == before


def test_wildcard_is_explicit_addressed_owner_not_a_provider_default(c):
    hive = c.app.state.hive
    owner, alice, other = human(c, "u_p4b_owner", "admin"), human(c), human(c, "u_p4b_other", "admin")
    made = c.post("/api/me/limit-requests", headers=alice, json={"owner": "user:u_p4b_owner", "amount_usd": 5})
    assert made.status_code == 200 and made.json()["key_id"] == "*"
    assert [x["id"] for x in items(c.get(ROUTES[0], headers=owner), "limit_requests")] == [made.json()["id"]]
    assert items(c.get(ROUTES[0], headers=other), "limit_requests") == []
    hive.db.execute("UPDATE limit_requests SET agent_id = 'a_1234abcd' WHERE id = ?", (made.json()["id"],))
    assert items(c.get(ROUTES[0], headers=owner), "limit_requests") == []


def test_keyset_pages_sort_ties_and_cursors_never_select_another_principal(c):
    hive = c.app.state.hive
    alice, bob = human(c), human(c, "u_p4b_bob")
    for i in range(56):
        request_row(hive, "user:u_p4b_alice", f"{i:03d}")
        request_row(hive, "user:u_p4b_bob", f"hidden-{i:03d}")
    r = c.get(ROUTES[0] + "?limit=50", headers=alice)
    page = r.json()["categories"]["own_requests"]
    assert len(page["items"]) == 50 and page["items"][0]["id"].endswith("055") and page["items"][-1]["id"].endswith("006")
    cursor = page["next_cursor"]
    assert cursor is not None and len(cursor.encode()) <= 512
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    assert decoded["id"] == page["items"][-1]["id"] and "hidden" not in decoded["id"]
    second = c.get(ROUTES[0], params={"limit": 50, "own_requests_cursor": cursor}, headers=alice)
    assert len(items(second, "own_requests")) == 6 and second.json()["categories"]["own_requests"]["next_cursor"] is None
    assert c.get(ROUTES[0], params={"own_requests_cursor": cursor}, headers=bob).status_code == 409
    assert c.get(ROUTES[0], params={"approvals_cursor": cursor}, headers=alice).status_code == 400
    hive.db.execute("DELETE FROM person_requests WHERE id = ?", (decoded["id"],))
    assert c.get(ROUTES[0], params={"own_requests_cursor": cursor}, headers=alice).status_code == 409


@pytest.mark.parametrize("query", ("limit=0", "limit=51", "limit=true", "limit=1&limit=2", "extra=1", "own_requests_cursor=bad", "own_requests_cursor=" + "a" * 513))
def test_authenticated_query_and_cursor_are_closed(c, query):
    assert c.get(ROUTES[0] + "?" + query).status_code == 400


def test_500_hidden_candidates_cannot_fabricate_an_empty_complete_page(c):
    hive = c.app.state.hive
    alice = human(c)
    _, (agent, _) = make_swarm_and_agents(c)
    hive.db.execute("UPDATE agents SET owner = 'user:operator', visibility = 'private', shared_with = '[]' WHERE id = ?", (agent["id"],))
    for i in range(501):
        approval(hive, agent, f"hidden{i:04d}")
    r = c.get(ROUTES[0], headers=alice)
    assert r.status_code == 503 and r.json()["error"]["code"] == "read_scan_bound"
    assert "hidden0000" not in r.text and "501" not in r.text


def test_final_emit_rechecks_real_session_after_projection(c, monkeypatch):
    hive = c.app.state.hive
    alice = human(c)
    request_row(hive, "user:u_p4b_alice")
    original = MeDecisions._finish
    def revoke_then_finish(self, answer, maximum):
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_p4b_alice'")
        return original(self, answer, maximum)
    monkeypatch.setattr(MeDecisions, "_finish", revoke_then_finish)
    r = c.get(ROUTES[0], headers=alice)
    assert r.status_code == 401 and "pr_p4b_one" not in r.text


def test_projection_utf8_and_no_write_or_ensure_publication(c, monkeypatch):
    hive = c.app.state.hive
    alice = human(c)
    request_row(hive, "user:u_p4b_alice", "雪" * 50)
    def forbidden(*args, **kwargs):
        raise AssertionError("a person GET attempted an effect")
    monkeypatch.setattr(hive.events, "publish", forbidden)
    monkeypatch.setattr(hive.person_swarms, "ensure", forbidden)
    monkeypatch.setattr(hive.ownhive, "ensure_owner", forbidden)
    before = hive.db._conn.total_changes
    r = c.get(ROUTES[0], headers=alice)
    assert r.status_code == 200 and len(r.content) <= 1048576 and len(r.content) > len(r.text)
    item = r.json()["categories"]["own_requests"]["items"][0]
    assert set(item) == {"kind", "id", "request_kind", "state", "created_at"}
    assert "not in the projection" not in r.text and hive.db._conn.total_changes == before


def test_unknown_projectable_state_refuses_instead_of_stringifying(c):
    hive = c.app.state.hive
    alice = human(c)
    request_row(hive, "user:u_p4b_alice", status="unknown")
    r = c.get(ROUTES[0], headers=alice)
    assert r.status_code == 409 and r.json()["error"]["code"] == "read_unavailable"


def intent_row(c, principal, kind="studio.session", state="pending", expired=False):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    key = uuid.uuid4().hex
    turn = {"id": "at_" + key, "operation_id": "p4b.ask." + key, "principal": principal, "body_digest": "synthetic",
            "thread_id": "ws_" + key, "mind_id": agent["id"], "swarm_id": agent["swarm_id"], "text": "PRIVATE_ASK_SENTINEL",
            "via": "typing", "context_resolved": "{}", "state": "done", "room_message_id": "m_" + key,
            "delivery_message_id": "d_" + key, "deadline": time.time() + 3600, "mind_spent_at_start": 0, "next_seq": 1, "created_at": now()}
    hive.db.insert("ask_turns", turn)
    row = {"id": "ai_" + key, "turn_id": turn["id"], "principal": principal, "kind": kind,
           "request_operation_id": "ask." + key, "body": "{}", "request_digest": "synthetic", "destination": "{}",
           "instruction_digest": "synthetic", "state": state, "created_at": now(), "updated_at": now(),
           "expires_at": "2000-01-01T00:00:00Z" if expired else "2099-01-01T00:00:00Z"}
    hive.db.insert("ask_intents", row)
    return turn, row


@pytest.mark.parametrize("kind,role,visible", (("studio.session", "member", True), ("studio.session", "admin", True),
                                               ("code.request", "member", False), ("code.request", "admin", True)))
@pytest.mark.parametrize("state", ("pending", "refused", "dispatching"))
def test_intent_own_kind_roles_open_states_and_minimal_projection(c, kind, role, visible, state):
    alice = human(c, role=role)
    _, row = intent_row(c, "user:u_p4b_alice", kind, state)
    result = items(c.get(ROUTES[0], headers=alice), "ask_intents")
    if visible:
        assert result == [{"kind": "ask_intent", "id": row["id"], "intent_kind": kind, "state": state,
                           "created_at": row["created_at"], "updated_at": row["updated_at"]}]
    else:
        assert result == []
    assert "PRIVATE_ASK_SENTINEL" not in json.dumps(result) and "destination" not in json.dumps(result)


@pytest.mark.parametrize("change", ("other_person", "other_admin", "deleted_turn", "deleted_intent", "expired", "linked", "abandoned"))
def test_intents_never_become_an_admin_audit_or_a_recovery_dispatch(c, change):
    hive = c.app.state.hive
    alice = human(c)
    turn, row = intent_row(c, "user:u_p4b_alice")
    headers = alice
    if change in ("other_person", "other_admin"):
        headers = human(c, "u_p4b_other", "admin" if change == "other_admin" else "member")
    elif change == "deleted_turn":
        hive.db.execute("UPDATE ask_turns SET deleted_at = ? WHERE id = ?", (now(), turn["id"]))
    elif change == "deleted_intent":
        hive.db.execute("UPDATE ask_intents SET deleted_at = ? WHERE id = ?", (now(), row["id"]))
    elif change == "expired":
        hive.db.execute("UPDATE ask_intents SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?", (row["id"],))
    else:
        hive.db.execute("UPDATE ask_intents SET state = ? WHERE id = ?", (change, row["id"]))
    before = hive.db._conn.total_changes
    assert items(c.get(ROUTES[0], headers=headers), "ask_intents") == []
    assert hive.db._conn.total_changes == before


def test_dispatching_expired_intent_is_information_only_and_audit_conflict_is_409(c):
    hive = c.app.state.hive
    alice = human(c)
    _, row = intent_row(c, "user:u_p4b_alice", state="dispatching", expired=True)
    assert items(c.get(ROUTES[0], headers=alice), "ask_intents")[0]["state"] == "dispatching"
    hive.db.insert("mind_operations", {"scope": "user:u_p4b_alice", "operation_id": row["request_operation_id"],
                                      "digest": "conflicting", "status": 201, "body": "{}", "created_at": now()})
    before = hive.db._conn.total_changes
    r = c.get(ROUTES[0], headers=alice)
    assert r.status_code == 409 and r.json()["error"]["code"] == "operation_conflict"
    assert hive.db._conn.total_changes == before


def test_program_pin_failure_does_not_publish_or_mark_the_registered_entry(c, tmp_path, monkeypatch):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    folder = pinned_program(hive, agent, tmp_path)
    (folder / "a.py").write_text("drift = True\n")
    def forbidden(*args, **kwargs):
        raise AssertionError("read published or repaired authority")
    monkeypatch.setattr(hive.events, "publish", forbidden)
    before = hive.db._conn.total_changes
    r = c.get(ROUTES[0])
    assert r.status_code == 409 and hive.programs.programs["p4b"]["error"] is None
    assert hive.db._conn.total_changes == before and str(folder) not in r.text


def test_program_regular_to_fifo_swap_refuses_without_blocking_open(c, tmp_path, monkeypatch):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    folder = pinned_program(hive, agent, tmp_path)
    original = MeDecisions._read_program_file
    injected = []
    def swap_once(self, root, relative, signature, budget):
        if relative == "a.py" and not injected:
            (folder / "a.py").unlink()
            os.mkfifo(folder / "a.py")
            injected.append(True)
        return original(self, root, relative, signature, budget)
    monkeypatch.setattr(MeDecisions, "_read_program_file", swap_once)
    r = c.get(ROUTES[0])
    assert r.status_code == 503 and injected == [True]


def test_pinned_environment_is_rechecked_before_final_response(c, tmp_path, monkeypatch):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    pinned_program(hive, agent, tmp_path)
    monkeypatch.setenv("P4B_SYNTHETIC_PIN", "before")
    hive.programs.pins["p4b"]["env"] = {"P4B_SYNTHETIC_PIN": "before"}
    original = MeDecisions._finish
    def changed_then_finish(self, answer, maximum):
        monkeypatch.setenv("P4B_SYNTHETIC_PIN", "after")
        return original(self, answer, maximum)
    monkeypatch.setattr(MeDecisions, "_finish", changed_then_finish)
    assert c.get(ROUTES[0]).status_code == 409


def bound_template(hive, agent):
    principal = "user:u_p4b_alice"
    digest = "sha256:" + "a" * 64
    hive.keyring.ring["keys"]["k_1234abcd"] = {"id": "k_1234abcd", "owner": principal, "provider": "mock", "created_at": 10}
    hive.db.execute("UPDATE agents SET owner = ?, options = ?, visibility = 'public' WHERE id = ?",
                    (principal, json.dumps({"key": "k_1234abcd", "key_locked": True}), agent["id"]))
    hive.programs.programs["p4b"] = {"id": "p4b", "module": types.ModuleType("p4b_template"), "error": None,
                                     "path": "/unopened-p4b-template", "digest": None, "capabilities": ["person_swarm"],
                                     "swarm_templates": {"team": {"digest": digest, "minds": [{"model": "mock/echo"}]}},
                                     "describe": {"actions": []}}
    hive.db.insert("app_person_consents", {"principal": principal, "program_id": "p4b", "template_id": "team",
                                           "template_digest": digest, "key_id": "k_1234abcd", "month_usd": 5, "granted_at": now()})
    hive.db.insert("app_person_minds", {"principal": principal, "program_id": "p4b", "template_id": "team", "slot": "helper",
                                        "agent_id": agent["id"], "template_digest": digest, "finished": 1, "created_at": now()})
    hive.db.insert("key_limits", {"id": "kl_1234abcd", "owner": principal, "key_id": "*", "grantee": "self", "month_usd": 5,
                                  "source": "self", "created_by": principal, "created_at": now(), "updated_at": now()})


@pytest.mark.parametrize("change", ("none", "withdrawn", "template", "disabled_program", "earlier_key", "month", "unlocked", "unfinished", "disabled_person"))
def test_template_current_authority_is_pure_and_rechecks_all_consent_inputs(c, monkeypatch, change):
    hive = c.app.state.hive
    human(c)
    _, (agent, _) = make_swarm_and_agents(c)
    bound_template(hive, agent)
    approval(hive, agent)
    if change == "withdrawn":
        hive.db.execute("UPDATE app_person_consents SET withdrawn_at = ?", (now(),))
    elif change == "template":
        hive.programs.programs["p4b"]["swarm_templates"]["team"]["digest"] = "sha256:" + "b" * 64
    elif change == "disabled_program":
        hive.programs.disabled.add("p4b")
    elif change == "earlier_key":
        hive.keyring.ring["keys"]["k_0000abcd"] = {"id": "k_0000abcd", "owner": "user:u_p4b_alice", "provider": "mock", "created_at": 1}
    elif change == "month":
        hive.db.execute("UPDATE key_limits SET month_usd = 6 WHERE id = 'kl_1234abcd'")
    elif change == "unlocked":
        hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": "k_1234abcd", "key_locked": False}), agent["id"]))
    elif change == "unfinished":
        hive.db.execute("UPDATE app_person_minds SET finished = 0")
    elif change == "disabled_person":
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_p4b_alice'")
    def forbidden(*args, **kwargs):
        raise AssertionError("a read called legacy mutating authority traversal")
    monkeypatch.setattr(hive.person_swarms, "current", forbidden)
    monkeypatch.setattr(hive.person_swarms, "ensure", forbidden)
    monkeypatch.setattr(hive.programs, "_ready", forbidden)
    monkeypatch.setattr(hive.programs, "check_integrity", forbidden)
    monkeypatch.setattr(hive.events, "publish", forbidden)
    before = hive.db._conn.total_changes
    result = items(c.get(ROUTES[0]), "approvals")
    assert len(result) == (1 if change == "none" else 0)
    assert hive.db._conn.total_changes == before


@pytest.mark.parametrize("change", ("none", "expires", "binding", "deactivated", "deny"))
def test_exact_attachment_is_current_without_program_hooks_or_policy_writes(c, monkeypatch, change):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    row = exact_program(hive, agent)
    def forbidden(*args, **kwargs):
        raise AssertionError("read invoked an app or authority effect")
    hive.programs.programs["p4b"]["module"].bind = forbidden
    aid = "aa_p4b_current"
    hive.db.insert("app_activations", {"program": "p4b", "swarm": agent["swarm_id"], "active": 1, "by_person": "user:operator"})
    hive.db.insert("app_attachments", {"id": aid, "program": "p4b", "swarm": agent["swarm_id"], "mind": agent["id"],
                                       "actor": "agent:" + agent["id"], "scope": json.dumps({"actions": ["save"], "channels": []}),
                                       "expires": "2099-01-01T00:00:00Z", "status": "active", "by_person": "user:operator",
                                       "request_key": "p4b.attachment", "binding": json.dumps({"scope": "invented"})})
    binding = json.loads(row["binding"])
    binding.update(attachment_id=aid, attachment_binding={"scope": "invented"})
    hive.db.execute("UPDATE approvals SET binding = ? WHERE id = ?", (json.dumps(binding), row["id"]))
    hive.db.insert("policy_rules", {"id": "rule_p4b", "scope": "agent:" + agent["id"], "skill": "program:p4b:save",
                                    "mode": "ask", "note": "attachment:" + aid, "created_at": now()})
    if change == "expires":
        hive.db.execute("UPDATE app_attachments SET expires = '2000-01-01T00:00:00Z' WHERE id = ?", (aid,))
    elif change == "binding":
        hive.db.execute("UPDATE app_attachments SET binding = '{}' WHERE id = ?", (aid,))
    elif change == "deactivated":
        hive.db.execute("UPDATE app_activations SET active = 0 WHERE program = 'p4b'")
    elif change == "deny":
        hive.db.execute("UPDATE policy_rules SET mode = 'deny' WHERE id = 'rule_p4b'")
    monkeypatch.setattr(hive.events, "publish", forbidden)
    monkeypatch.setattr(hive.programs, "_ready", forbidden)
    before = hive.db._conn.total_changes
    result = items(c.get(ROUTES[0]), "approvals")
    assert len(result) == (1 if change == "none" else 0)
    assert hive.db._conn.total_changes == before


def forbid_global_personal_lists(hive, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("P4b collected a global personal visibility inventory")
    for name in ("filter_items", "hide_others_personal", "hidden_ids", "hidden_personal"):
        monkeypatch.setattr(hive.visibility, name, forbidden)


def test_admin_personal_suppression_uses_only_each_item_named_targets(c, monkeypatch):
    hive = c.app.state.hive
    admin, bob = human(c, "u_p4b_admin", "admin"), human(c, "u_p4b_bob")
    swarm, (ordinary, personal) = make_swarm_and_agents(c)
    hive.db.execute("UPDATE agents SET owner = 'user:u_p4b_bob', visibility = 'private', personal_of = NULL WHERE id = ?", (ordinary["id"],))
    hive.db.execute("UPDATE agents SET owner = 'user:u_p4b_bob', visibility = 'private', personal_of = 'user:u_p4b_bob' WHERE id = ?", (personal["id"],))
    approval(hive, ordinary, "ordinary")
    approval(hive, personal, "personal")
    request_row(hive, "user:u_p4b_admin")
    own_swarm = c.post("/api/swarms", headers=admin, json={"name": "Admin home"}).json()
    own_session = studio_row(hive, "user:u_p4b_admin", own_swarm["id"], "stopped")
    forbid_global_personal_lists(hive, monkeypatch)
    before = hive.db._conn.total_changes
    r = c.get(ROUTES[0], headers=admin)
    assert [x["id"] for x in items(r, "approvals")] == ["p_p4b_ordinary"]
    assert [x["id"] for x in items(r, "own_requests")] == ["pr_p4b_one"]
    assert [x["id"] for x in items(r, "studio_sessions")] == [own_session["id"]]
    assert hive.db._conn.total_changes == before


def test_current_limit_requester_visibility_never_uses_global_inventory(c, monkeypatch):
    hive, owner, alice, agent, row = limit_world(c)
    forbid_global_personal_lists(hive, monkeypatch)
    before = hive.db._conn.total_changes
    assert [x["id"] for x in items(c.get(ROUTES[0], headers=owner), "limit_requests")] == [row["id"]]
    assert hive.db._conn.total_changes == before


def test_personal_visibility_rechecks_before_final_emission(c, monkeypatch):
    hive = c.app.state.hive
    human(c, "u_p4b_bob")
    _, (agent, _) = make_swarm_and_agents(c)
    hive.db.execute("UPDATE agents SET owner = 'user:u_p4b_bob', visibility = 'private', personal_of = NULL WHERE id = ?", (agent["id"],))
    approval(hive, agent)
    original = MeDecisions._finish
    def changed_then_finish(self, answer, maximum):
        hive.db.execute("UPDATE agents SET personal_of = 'user:u_p4b_bob' WHERE id = ?", (agent["id"],))
        return original(self, answer, maximum)
    monkeypatch.setattr(MeDecisions, "_finish", changed_then_finish)
    forbid_global_personal_lists(hive, monkeypatch)
    r = c.get(ROUTES[0])
    assert r.status_code == 409 and "p_p4b_one" not in r.text


def test_named_target_extraction_bound_refuses_before_target_queries(c, monkeypatch):
    hive = c.app.state.hive
    admin = human(c, "u_p4b_admin", "admin")
    request_row(hive, "user:u_p4b_admin", payload=json.dumps({"owners": [f"s_{i:08x}" for i in range(65)]}))
    queried = []
    original = MeDecisions._visibility_one
    def record(self, sql, args):
        queried.append(True)
        return original(self, sql, args)
    monkeypatch.setattr(MeDecisions, "_visibility_one", record)
    r = c.get(ROUTES[0], headers=admin)
    assert r.status_code == 503 and queried == []
    assert "s_00000000" not in r.text


@pytest.mark.parametrize("skill", ("shell-confirm", "metta", "space-transform", "remove-atom", "restart-omega"))
def test_high_risk_skill_overrides_inconsistent_stored_medium_flag(c, skill):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    row = approval(hive, agent, skill=skill, risk="medium")
    answer = items(c.get(ROUTES[0]), "approvals")[0]["answers"]
    assert answer == {"once": True, "for": False, "always": False, "no": True, "never": True}
    denied = c.post("/api/approvals/" + row["id"] + "/approve", json={"remember": True})
    assert denied.status_code == 400 and denied.json()["error"]["code"] == "one_at_a_time"
    assert hive.db.one("SELECT status FROM approvals WHERE id = ?", (row["id"],))["status"] == "pending"


@pytest.mark.parametrize("pins", (None, [], {"p4b": None}, {"p4b": False}, {"p4b": []}, {"p4b": {}}, {"p4b": "invalid"}))
def test_declared_invalid_pin_never_becomes_an_unpinned_app(c, monkeypatch, pins):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    exact_program(hive, agent)
    hive.programs.pins = pins
    def forbidden(*args, **kwargs):
        raise AssertionError("pin validation attempted an authority effect")
    monkeypatch.setattr(hive.events, "publish", forbidden)
    before = hive.db._conn.total_changes
    r = c.get(ROUTES[0])
    assert r.status_code == 503 and r.json()["error"]["code"] == "authority_unavailable"
    assert hive.programs.programs["p4b"]["error"] is None and hive.db._conn.total_changes == before


def test_pin_becoming_declared_null_at_final_gate_is_not_disclosed(c, monkeypatch):
    hive = c.app.state.hive
    _, (agent, _) = make_swarm_and_agents(c)
    exact_program(hive, agent)
    hive.programs.pins = {}
    original = MeDecisions._finish
    def changed_then_finish(self, answer, maximum):
        hive.programs.pins["p4b"] = None
        return original(self, answer, maximum)
    monkeypatch.setattr(MeDecisions, "_finish", changed_then_finish)
    r = c.get(ROUTES[0])
    assert r.status_code == 503 and "p_p4b_one" not in r.text


def test_required_operator_wildcard_owner_missing_is_explicit_unknown_without_migration(c, monkeypatch):
    hive = c.app.state.hive
    alice = human(c)
    hive.db.execute("DELETE FROM hive_owner")
    made = c.post("/api/me/limit-requests", headers=alice, json={"amount_usd": 5})
    assert made.status_code == 200 and made.json()["owner"] == "user:operator"
    assert hive.db.one("SELECT * FROM hive_owner") is None
    def forbidden(*args, **kwargs):
        raise AssertionError("GET attempted owner migration")
    monkeypatch.setattr(hive.ownhive, "ensure_owner", forbidden)
    before = hive.db._conn.total_changes
    r = c.get(ROUTES[0])
    assert r.status_code == 503 and r.json()["error"]["code"] == "authority_unavailable"
    assert hive.db.one("SELECT * FROM hive_owner") is None and hive.db._conn.total_changes == before


def test_named_wildcard_owner_does_not_need_a_hive_owner_migration(c, monkeypatch):
    hive = c.app.state.hive
    owner, alice = human(c, "u_p4b_owner", "admin"), human(c)
    made = c.post("/api/me/limit-requests", headers=alice, json={"owner": "user:u_p4b_owner", "amount_usd": 5})
    assert made.status_code == 200
    hive.db.execute("DELETE FROM hive_owner")
    def forbidden(*args, **kwargs):
        raise AssertionError("named key-owner read tried hive migration")
    monkeypatch.setattr(hive.ownhive, "ensure_owner", forbidden)
    before = hive.db._conn.total_changes
    assert [x["id"] for x in items(c.get(ROUTES[0], headers=owner), "limit_requests")] == [made.json()["id"]]
    assert hive.db._conn.total_changes == before


def test_standalone_studio_real_keyset_pages_own_scope_wrong_category_and_stale_anchor(c):
    hive = c.app.state.hive
    alice, bob = human(c), human(c, "u_p4b_bob")
    home = c.post("/api/swarms", headers=alice, json={"name": "Alice home"}).json()
    other_home = c.post("/api/swarms", headers=bob, json={"name": "Bob home"}).json()
    own = []
    for _ in range(56):
        own.append(studio_row(hive, "user:u_p4b_alice", home["id"], "stopped")["id"])
        studio_row(hive, "user:u_p4b_bob", other_home["id"], "stopped")
    stamp = "2026-10-01T00:00:00Z"
    hive.db.execute("UPDATE studio_sessions SET created_at = ?, updated_at = ?", (stamp, stamp))
    first = c.get(ROUTES[1], params={"limit": 50}, headers=alice)
    assert first.status_code == 200 and set(first.json()) == {"schema", "items", "next_cursor"}
    assert first.json()["schema"] == "hive.me-studio-sessions/1"
    assert [x["id"] for x in first.json()["items"]] == sorted(own, reverse=True)[:50]
    cursor = first.json()["next_cursor"]
    assert cursor and len(cursor.encode("utf-8")) <= 512
    anchor = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    assert anchor["id"] == first.json()["items"][-1]["id"] and anchor["category"] == "studio_sessions"
    second = c.get(ROUTES[1], params={"limit": 50, "cursor": cursor}, headers=alice)
    assert [x["id"] for x in second.json()["items"]] == sorted(own, reverse=True)[50:]
    assert second.json()["next_cursor"] is None
    assert c.get(ROUTES[1], params={"cursor": cursor}, headers=bob).status_code == 409
    wrong = dict(anchor, category="own_requests")
    wrong_cursor = base64.urlsafe_b64encode(json.dumps(wrong).encode()).decode().rstrip("=")
    assert c.get(ROUTES[1], params={"cursor": wrong_cursor}, headers=alice).status_code == 400
    hive.db.execute("UPDATE swarms SET owner = 'user:u_p4b_bob', visibility = 'private', shared_with = '[]' WHERE id = ?", (home["id"],))
    assert c.get(ROUTES[1], params={"cursor": cursor}, headers=alice).status_code == 409


@pytest.mark.parametrize("query", ("limit=0", "limit=51", "limit=true", "limit=1&limit=2", "extra=1", "cursor=bad",
                                  "cursor=" + "a" * 513, "cursor=one&cursor=two", "studio_sessions_cursor=one"))
def test_standalone_studio_authenticated_query_contract_is_closed(c, query):
    alice = human(c)
    assert c.get(ROUTES[1] + "?" + query, headers=alice).status_code == 400


def test_standalone_studio_default_utf8_wire_bound_and_reduced_cap_negative_control(c, monkeypatch):
    hive = c.app.state.hive
    alice = human(c)
    home = c.post("/api/swarms", headers=alice, json={"name": "Unicode private 雪"}).json()
    row = studio_row(hive, "user:u_p4b_alice", home["id"], "stopped")
    hive.db.execute("UPDATE studio_sessions SET piece = ? WHERE id = ?", (json.dumps({"private": "雪" * 10000}), row["id"]))
    r = c.get(ROUTES[1], headers=alice)
    assert r.status_code == 200 and set(r.json()) == {"schema", "items", "next_cursor"}
    assert len(r.content) <= 262144 and r.content.decode("utf-8").encode("utf-8") == r.content
    assert "雪" not in r.text and "piece" not in r.text
    assert set(r.json()["items"][0]) == {"kind", "id", "state", "created_at", "updated_at"}
    assert r.content == json.dumps(r.json(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # Separate reduced-cap HTTP negative control; this is not an assertion that closed50-item default metadata
    # can reach262144 bytes, nor a product/load or arbitrary-Unicode-id qualification.
    monkeypatch.setattr(me_decisions_module, "STUDIO_BYTES", len(r.content) - 1)
    before = hive.db._conn.total_changes
    refused = c.get(ROUTES[1], headers=alice)
    assert refused.status_code == 503 and refused.json()["error"]["code"] == "read_response_bound"
    assert hive.db._conn.total_changes == before
