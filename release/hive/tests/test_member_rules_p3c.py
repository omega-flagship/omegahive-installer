"""Focused P3c source regressions: real HTTP/store; existing fake process fixture.

Unexecuted source until separate admission. Synthetic auth callbacks re-read the
actual test session table; client input never supplies rule provenance.
"""

import contextlib
import time
import uuid

import pytest
from starlette.requests import Request

from hive.core.db import now
from hive.core.hive import HiveError, token_hash
from hive.core.policy import ORIGIN_MEMBER
from hive.tests.test_core_api import client  # noqa: F401


@pytest.fixture
def c(monkeypatch, request):
    monkeypatch.setenv("HIVE_SSO_USERS", "family")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "0")
    return request.getfixturevalue("client")


def person(c, suffix, role="member"):
    hive = c.app.state.hive
    hive.db.insert("people", {"id": suffix, "email": suffix + "@example.test", "name": suffix,
                              "role": role, "created_at": now()})
    token = "p3c-synthetic-" + uuid.uuid4().hex
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                "principal": "user:" + suffix, "expires_at": time.time() + 3600})
    return {"Authorization": "Bearer " + token}


def host_auth(c, headers):
    """Trusted synthetic adapter: re-read persisted auth on every invocation."""
    hive = c.app.state.hive
    key = token_hash(headers["Authorization"].removeprefix("Bearer "))

    def authenticate():
        session = hive.db.one("SELECT * FROM sessions WHERE token_hash = ?", (key,))
        if (session is None or session.get("kind") != "sso"
                or type(session.get("expires_at")) not in (int, float)
                or session["expires_at"] <= time.time()):
            raise HiveError(401, "unauthorized", "synthetic session is no longer current")
        return session["principal"]
    return authenticate


@pytest.fixture
def owned(c):
    hive = c.app.state.hive
    alice, bob = person(c, "u_p3c_alice"), person(c, "u_p3c_bob")
    swarm = c.post("/api/swarms", json={"name": "P3c synthetic"}).json()
    response = c.post("/api/agents", json={"name": "Owned", "kind": "module", "swarm_id": swarm["id"]})
    assert response.status_code == 200
    mind = response.json()
    hive.db.update("agents", mind["id"], {"owner": "user:u_p3c_alice", "visibility": "private"})
    return hive, mind, alice, bob


def rows(hive):
    return hive.db.all("SELECT * FROM policy_rules ORDER BY id")


def add(c, owned, mode="deny", skill="write-file*", note="my restriction"):
    _, mind, alice, _ = owned
    response = c.post("/api/policy", headers=alice,
                      json={"scope": "agent:" + mind["id"], "skill": skill, "mode": mode, "note": note})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("mode", ("ask", "deny"))
def test_member_http_add_has_host_provenance_and_can_delete_exact_row(c, owned, mode):
    hive, mind, alice, _ = owned
    rule = add(c, owned, mode)
    stored = hive.db.one("SELECT * FROM policy_rules WHERE id = ?", (rule["id"],))
    assert stored["scope"] == "agent:" + mind["id"] and stored["mode"] == mode
    assert stored["origin"] == ORIGIN_MEMBER and stored["granted_by"] == "user:u_p3c_alice"
    assert stored["note"] == "my restriction" and stored["expires_at"] is None
    response = c.delete("/api/policy/" + rule["id"], headers=alice)
    assert response.status_code == 200 and response.json() == {"ok": True}
    assert hive.db.one("SELECT * FROM policy_rules WHERE id = ?", (rule["id"],)) is None


@pytest.mark.parametrize("field,value", (("origin", "answer"), ("granted_by", "user:u_p3c_bob"),
                                        ("expires_at", 9999999999), ("publish", False), ("extra", "value")))
def test_member_http_rejects_client_provenance_or_extra_fields(c, owned, field, value):
    hive, mind, alice, _ = owned
    before = rows(hive)
    payload = {"scope": "agent:" + mind["id"], "skill": "read-file", "mode": "deny", field: value}
    assert c.post("/api/policy", headers=alice, json=payload).status_code == 400
    assert rows(hive) == before


@pytest.mark.parametrize("change,status", (({"mode": "allow"}, 403), ({"mode": None}, 400),
    ({"mode": []}, 400), ({"mode": "unknown"}, 400), ({"scope": "hive"}, 403),
    ({"scope": "swarm:s_other"}, 403), ({"scope": "agent:"}, 400), ({"scope": None}, 400),
    ({"scope": "unknown:s_other"}, 400), ({"skill": " "}, 400), ({"skill": []}, 400),
    ({"note": None}, 400), ({"note": "role:pretend"}, 400),
    ({"mode": "unknown", "scope": "hive"}, 400), ({"mode": "allow", "skill": []}, 400)))
def test_member_http_invalid_restriction_does_not_mutate(c, owned, change, status):
    hive, mind, alice, _ = owned
    payload = {"scope": "agent:" + mind["id"], "skill": "read-file", "mode": "deny"}
    payload.update(change)
    before = rows(hive)
    response = c.post("/api/policy", headers=alice, json=payload)
    expected_code = "bad_request" if status == 400 else "admin_only"
    assert (response.status_code, response.json()["error"]["code"]) == (status, expected_code)
    assert rows(hive) == before


@pytest.mark.parametrize("target", ("other_owner", "deleted", "missing", "legacy_unowned"))
def test_member_may_not_restrict_a_mind_they_do_not_currently_own(c, owned, target):
    hive, mind, alice, _ = owned
    agent_id = mind["id"]
    if target == "other_owner":
        hive.db.update("agents", agent_id, {"owner": "user:u_p3c_bob"})
    elif target == "deleted":
        hive.db.update("agents", agent_id, {"deleted": 1})
    elif target == "missing":
        agent_id = "a_p3c_missing"
    else:
        hive.db.update("agents", agent_id, {"owner": None})
    before = rows(hive)
    response = c.post("/api/policy", headers=alice,
                      json={"scope": "agent:" + agent_id, "skill": "read-file", "mode": "deny"})
    assert response.status_code == 403 and response.json()["error"]["code"] == "owner_only"
    assert rows(hive) == before


@pytest.mark.parametrize("origin,grantor,mode", (("", "user:u_p3c_alice", "deny"),
    ("answer", "user:u_p3c_alice", "deny"), ("role", "user:u_p3c_alice", "ask"),
    ("template", "user:u_p3c_alice", "deny"), ("admin", "user:operator", "deny"),
    ("member", "user:u_p3c_bob", "deny"), ("member", "user:u_p3c_alice", "allow")))
def test_member_delete_rejects_nonmember_rows_other_creators_and_allow(c, owned, origin, grantor, mode):
    hive, mind, alice, _ = owned
    rule = hive.policy.add_rule("agent:" + mind["id"], "read-file", mode, origin=origin, granted_by=grantor)
    before = rows(hive)
    assert c.delete("/api/policy/" + rule["id"], headers=alice).status_code == 403
    assert rows(hive) == before


@pytest.mark.parametrize("scope", ("hive", "swarm:s_other"))
def test_host_marked_member_origin_does_not_make_other_scopes_deletable(c, owned, scope):
    hive, _, alice, _ = owned
    rule = hive.policy.add_rule(scope, "read-file", "deny", origin=ORIGIN_MEMBER, granted_by="user:u_p3c_alice")
    before = rows(hive)
    assert c.delete("/api/policy/" + rule["id"], headers=alice).status_code == 403
    assert rows(hive) == before


@pytest.mark.parametrize("change", ("transfer", "deleted"))
def test_original_creator_cannot_delete_after_losing_current_ownership(c, owned, change):
    hive, mind, alice, _ = owned
    rule = add(c, owned)
    hive.db.update("agents", mind["id"], {"owner": "user:u_p3c_bob"} if change == "transfer" else {"deleted": 1})
    before = rows(hive)
    response = c.delete("/api/policy/" + rule["id"], headers=alice)
    assert response.status_code == 403 and response.json()["error"]["code"] == "owner_only"
    assert rows(hive) == before


def test_new_owner_cannot_delete_previous_owners_member_rule(c, owned):
    hive, mind, _, bob = owned
    rule = add(c, owned)
    hive.db.update("agents", mind["id"], {"owner": "user:u_p3c_bob"})
    before = rows(hive)
    assert c.delete("/api/policy/" + rule["id"], headers=bob).status_code == 403
    assert rows(hive) == before


def test_expired_own_member_rule_can_be_removed_without_removing_other_rules(c, owned):
    hive, mind, alice, _ = owned
    rule = add(c, owned)
    keep = hive.policy.add_rule("agent:" + mind["id"], "query", "allow", origin="answer", granted_by="user:operator")
    hive.db.execute("UPDATE policy_rules SET expires_at = ? WHERE id = ?", (time.time() - 1, rule["id"]))
    assert rule["id"] not in {r["id"] for r in hive.policy.rules()}
    assert c.delete("/api/policy/" + rule["id"], headers=alice).status_code == 200
    assert hive.db.one("SELECT id FROM policy_rules WHERE id = ?", (keep["id"],)) == {"id": keep["id"]}


@pytest.mark.parametrize("suffix", ("u_p3c_named", "plain-member-name"))
def test_real_people_row_not_suffix_spelling_is_member_authority(c, owned, suffix):
    hive, mind, _, _ = owned
    headers = person(c, suffix)
    hive.db.update("agents", mind["id"], {"owner": "user:" + suffix})
    # This is the trusted central-helper contract, not HTTP family-SSO admission.
    # The HTTP path still requires a current host role and preserves existing family-admin dispatch.
    authenticate = host_auth(c, headers)
    rule = hive.policy.member_add_rule("agent:" + mind["id"], "read-file", "ask", authenticate=authenticate)
    assert rule["granted_by"] == "user:" + suffix and rule["origin"] == ORIGIN_MEMBER
    assert hive.policy.member_delete_rule(rule["id"], authenticate=authenticate) == {"ok": True}


@pytest.mark.parametrize("state", ("missing", "disabled", "admin", "unknown_principal", "empty", "nonuser"))
def test_central_member_helper_requires_current_actual_member_row(c, owned, state):
    hive, mind, _, _ = owned
    principal = "user:u_p3c_alice"
    if state == "missing":
        hive.db.execute("DELETE FROM people WHERE id = ?", ("u_p3c_alice",))
    elif state == "disabled":
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", ("u_p3c_alice",))
    elif state == "admin":
        hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", ("u_p3c_alice",))
    else:
        principal = {"unknown_principal": "user:missing-p3c", "empty": "user:", "nonuser": "agent:a_fake"}[state]
    before = rows(hive)
    with pytest.raises(HiveError) as exc:
        hive.policy.member_add_rule("agent:" + mind["id"], "read-file", "deny", authenticate=lambda: principal)
    assert exc.value.status == 403 and rows(hive) == before


@pytest.mark.parametrize("mutation", ("revoked", "expired", "disabled", "role", "identity"))
def test_body_await_invalidation_refuses_member_mutation(c, owned, monkeypatch, mutation):
    hive, mind, alice, _ = owned
    key = token_hash(alice["Authorization"].removeprefix("Bearer "))
    original = Request.stream
    injections = []

    async def changed(request):
        async for chunk in original(request):
            yield chunk
        # bounded_body consumes stream(), not json(). Invalidate after the real
        # request bytes drain and before the body reader can complete.
        if request.url.path == "/api/policy":
            injections.append(mutation)
            if mutation == "revoked":
                hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (key,))
            elif mutation == "expired":
                hive.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (time.time() - 1, key))
            elif mutation == "disabled":
                hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", ("u_p3c_alice",))
            elif mutation == "role":
                hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", ("u_p3c_alice",))
            else:
                hive.db.execute("UPDATE sessions SET principal = ? WHERE token_hash = ?", ("user:u_p3c_bob", key))
    monkeypatch.setattr(Request, "stream", changed)
    before = rows(hive)
    response = c.post("/api/policy", headers=alice,
                      json={"scope": "agent:" + mind["id"], "skill": "read-file", "mode": "deny"})
    assert injections == [mutation]
    assert response.status_code in (401, 403) and rows(hive) == before


@pytest.mark.parametrize("operation", ("add", "delete"))
@pytest.mark.parametrize("mutation", ("revoked", "expired", "disabled", "role", "identity", "owner", "deleted"))
def test_fresh_authority_and_owner_are_rechecked_after_mind_lock(c, owned, monkeypatch, operation, mutation):
    hive, mind, alice, _ = owned
    rule = add(c, owned) if operation == "delete" else None
    key = token_hash(alice["Authorization"].removeprefix("Bearer "))
    original = hive._mind_lock
    before = rows(hive)

    @contextlib.contextmanager
    def changed(agent_id):
        with original(agent_id):
            if mutation == "revoked":
                hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (key,))
            elif mutation == "expired":
                hive.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (time.time() - 1, key))
            elif mutation == "disabled":
                hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", ("u_p3c_alice",))
            elif mutation == "role":
                hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", ("u_p3c_alice",))
            elif mutation == "identity":
                hive.db.execute("UPDATE sessions SET principal = ? WHERE token_hash = ?", ("user:u_p3c_bob", key))
            elif mutation == "owner":
                hive.db.update("agents", agent_id, {"owner": "user:u_p3c_bob"})
            else:
                hive.db.update("agents", agent_id, {"deleted": 1})
            yield
    monkeypatch.setattr(hive, "_mind_lock", changed)
    authenticate = host_auth(c, alice)
    with pytest.raises(HiveError) as exc:
        if operation == "add":
            hive.policy.member_add_rule("agent:" + mind["id"], "read-file", "deny", authenticate=authenticate)
        else:
            hive.policy.member_delete_rule(rule["id"], authenticate=authenticate)
    assert exc.value.status in (401, 403, 404) and rows(hive) == before


@pytest.mark.parametrize("replacement", ("scope", "origin", "creator", "mode", "note", "removed"))
def test_delete_rejects_rule_replacement_between_lookup_and_lock(c, owned, monkeypatch, replacement):
    hive, _, alice, _ = owned
    rule = add(c, owned)
    original = hive._mind_lock
    expected = None

    @contextlib.contextmanager
    def changed(agent_id):
        nonlocal expected
        with original(agent_id):
            if replacement == "removed":
                hive.db.execute("DELETE FROM policy_rules WHERE id = ?", (rule["id"],))
            else:
                field, value = {"scope": ("scope", "hive"), "origin": ("origin", "answer"),
                                "creator": ("granted_by", "user:u_p3c_bob"), "mode": ("mode", "allow"),
                                "note": ("note", "a concurrent host edit")}[replacement]
                hive.db.execute("UPDATE policy_rules SET " + field + " = ? WHERE id = ?", (value, rule["id"]))
            expected = rows(hive)
            yield
    monkeypatch.setattr(hive, "_mind_lock", changed)
    with pytest.raises(HiveError) as exc:
        hive.policy.member_delete_rule(rule["id"], authenticate=host_auth(c, alice))
    assert exc.value.status == 409 and rows(hive) == expected


@pytest.mark.parametrize("kind", ("service", "sso-bootstrap", "unknown", "password"))
def test_nonhuman_session_cannot_use_the_member_route(c, owned, kind):
    hive, mind, alice, _ = owned
    key = token_hash(alice["Authorization"].removeprefix("Bearer "))
    hive.db.execute("UPDATE sessions SET kind = ? WHERE token_hash = ?", (kind, key))
    before = rows(hive)
    response = c.post("/api/policy", headers=alice,
                      json={"scope": "agent:" + mind["id"], "skill": "read-file", "mode": "deny"})
    assert response.status_code in (401, 403) and rows(hive) == before


def test_member_add_rollback_emits_no_policy_event(c, owned, monkeypatch):
    hive, mind, alice, _ = owned
    before, events = rows(hive), []
    monkeypatch.setattr(hive.events, "publish", lambda *args, **kwargs: events.append((args, kwargs)))
    original = hive.db.insert

    def interrupted(table, row):
        result = original(table, row)
        if table == "policy_rules":
            raise RuntimeError("synthetic failure after the real insert")
        return result
    monkeypatch.setattr(hive.db, "insert", interrupted)
    with pytest.raises(RuntimeError, match="after the real insert"):
        hive.policy.member_add_rule("agent:" + mind["id"], "read-file", "deny", authenticate=host_auth(c, alice))
    assert rows(hive) == before and events == []


def test_outer_rollback_drops_member_changes_and_aftercommit_events(c, owned, monkeypatch):
    hive, mind, alice, _ = owned
    existing = add(c, owned)
    before, events = rows(hive), []
    monkeypatch.setattr(hive.events, "publish", lambda *args, **kwargs: events.append((args, kwargs)))
    authenticate = host_auth(c, alice)
    with pytest.raises(RuntimeError, match="outer rollback"):
        with hive.db.transaction():
            hive.policy.member_add_rule("agent:" + mind["id"], "query", "ask", authenticate=authenticate)
            hive.policy.member_delete_rule(existing["id"], authenticate=authenticate)
            assert events == []
            raise RuntimeError("outer rollback")
    assert rows(hive) == before and events == []


def test_policy_event_is_published_only_after_outer_commit(c, owned, monkeypatch):
    hive, mind, alice, _ = owned
    observed = []

    def notice(kind, **payload):
        observed.append((kind, hive.db._conn.in_transaction, payload["rules"], rows(hive)))
    monkeypatch.setattr(hive.events, "publish", notice)
    with hive.db.transaction():
        rule = hive.policy.member_add_rule("agent:" + mind["id"], "query", "ask", authenticate=host_auth(c, alice))
        assert observed == []
    assert len(observed) == 1 and observed[0][0] == "policy.updated" and observed[0][1] is False
    assert rule["id"] in {r["id"] for r in observed[0][2]}
    assert rule["id"] in {r["id"] for r in observed[0][3]}


def test_role_reapplication_preserves_member_restriction(c, owned):
    hive, mind, _, _ = owned
    rule = add(c, owned, note="ordinary note with role: inside, not the reserved prefix")
    hive.roles.apply(mind["id"])
    stored = hive.db.one("SELECT * FROM policy_rules WHERE id = ?", (rule["id"],))
    assert stored["origin"] == ORIGIN_MEMBER and stored["mode"] == "deny"


def test_exact_member_ask_beats_same_scope_glob_deny_without_deleting_it(c, owned):
    hive, mind, _, _ = owned
    deny, ask = add(c, owned, mode="deny", skill="write-*"), add(c, owned, mode="ask", skill="write-file")
    assert hive.policy.decide(mind, "write-file")[0] == "ask"
    assert hive.policy.decide(mind, "write-file-extra")[0] == "deny"
    assert {deny["id"], ask["id"]} <= {r["id"] for r in rows(hive)}


def test_scope_then_exactness_then_restrictiveness_remain_separate(c, owned):
    hive, mind, _, _ = owned
    hive.policy.add_rule("hive", "read-file", "deny", "hive exact")
    add(c, owned, mode="ask", skill="read-*")
    assert hive.policy.decide(mind, "read-file")[0] == "ask"
    add(c, owned, mode="deny", skill="read-*")
    assert hive.policy.decide(mind, "read-file")[0] == "deny"


@pytest.mark.parametrize("ceiling", ("ask", "deny"))
def test_template_ceiling_stays_outside_member_exactness(c, owned, ceiling):
    hive, mind, _, _ = owned
    hive.db.insert("app_template_rules", {"agent_id": mind["id"], "skill": "read-*", "mode": ceiling,
                                         "program_id": "p3c-synthetic", "template_digest": "p3c-digest"})
    add(c, owned, mode="ask", skill="read-file")
    assert hive.policy.decide(mind, "read-file")[0] == ceiling


def test_missing_template_authority_cannot_be_opened_by_member_rule(c, owned, monkeypatch):
    hive, mind, _, _ = owned
    add(c, owned, mode="ask", skill="read-file")

    def unavailable(*args):
        raise RuntimeError("synthetic ceiling read unavailable")
    monkeypatch.setattr(hive.person_swarms, "ceiling", unavailable)
    assert hive.policy.decide(mind, "read-file")[0] == "deny"


def test_privileged_default_policy_write_delete_and_audit_stay_available(c, owned):
    hive, _, alice, _ = owned
    response = c.post("/api/policy", json={"scope": "hive", "skill": "query", "mode": "allow", "note": "admin"})
    assert response.status_code == 200
    rule = response.json()
    assert rule["granted_by"] == "user:operator" and rule["origin"] != ORIGIN_MEMBER
    assert rule["id"] in {r["id"] for r in c.get("/api/policy", headers=alice).json()}
    assert c.delete("/api/policy/" + rule["id"]).json() == {"ok": True}
    assert hive.db.one("SELECT * FROM policy_rules WHERE id = ?", (rule["id"],)) is None


@pytest.mark.parametrize("mode", ("ask", "deny"))
def test_program_member_restriction_beats_older_exact_allow(c, owned, mode):
    hive, mind, _, _ = owned
    skill = "program:p3c-synthetic:save"
    older = hive.policy.add_rule("agent:" + mind["id"], skill, "allow", "older explicit app grant")
    hive.db.update("policy_rules", older["id"], {"created_at": "2020-01-01T00:00:00Z"})
    newer = add(c, owned, mode=mode, skill=skill)
    assert newer["origin"] == ORIGIN_MEMBER
    assert hive.program_actions.decide(mind, skill)[0] == mode
    assert hive.db.one("SELECT mode FROM policy_rules WHERE id = ?", (older["id"],))["mode"] == "allow"


def test_program_exact_ask_beats_glob_deny_before_restrictiveness(c, owned):
    hive, mind, _, _ = owned
    skill = "program:p3c-synthetic:save"
    add(c, owned, mode="deny", skill="program:p3c-synthetic:*")
    add(c, owned, mode="ask", skill=skill)
    assert hive.program_actions.decide(mind, skill)[0] == "ask"
    hive.policy.add_rule("hive", skill, "deny", "less specific scope")
    assert hive.program_actions.decide(mind, skill)[0] == "ask"


@pytest.mark.parametrize("ceiling", ("ask", "deny"))
def test_program_template_ceiling_remains_outside_member_precedence(c, owned, ceiling):
    hive, mind, _, _ = owned
    skill = "program:p3c-synthetic:save"
    hive.policy.add_rule("agent:" + mind["id"], skill, "allow", "explicit app grant")
    hive.db.insert("app_template_rules", {"agent_id": mind["id"], "skill": "program:p3c-synthetic:*", "mode": ceiling,
                                         "program_id": "p3c-synthetic", "template_digest": "p3c-digest"})
    assert hive.program_actions.decide(mind, skill)[0] == ceiling
    add(c, owned, mode="ask", skill=skill)
    assert hive.program_actions.decide(mind, skill)[0] == ceiling
