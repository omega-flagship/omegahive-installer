"""P3b synthetic source regressions. No qualification is implied by this file."""
import json
import time
import uuid

import pytest
from starlette.requests import Request

import hive.core.app as app_module
from hive.core.db import now
from hive.core.hive import HiveError, token_hash
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_visibility import person


ANSWERS = (
    ("approve", {}, "approved"),
    ("remember", {"remember": True}, "approved"),
    ("deny", None, "denied"),
    ("once", {"decision": "once"}, "approved"),
    ("for", {"decision": "for", "minutes": 5}, "approved"),
    ("always", {"decision": "always"}, "approved"),
    ("no", {"decision": "no"}, "denied"),
    ("never", {"decision": "never"}, "denied"),
)


@pytest.fixture
def env(client, monkeypatch):
    hive = client.app.state.hive
    headers = {}
    for name, role in (("owner", "member"), ("member", "member"), ("admin", "admin"), ("hiveowner", "member")):
        headers[name] = person(client, "u_p3b_" + name, role)
        token = headers[name]["Authorization"].split(" ", 1)[1]
        hive.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (time.time() + 3600, token_hash(token)))
    stamp = now()
    hive.db.execute("INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, ?, 'first-admin', ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, via=excluded.via, set_at=excluded.set_at, updated_at=excluded.updated_at",
                    ("user:u_p3b_hiveowner", stamp, stamp))
    assert hive.ownhive.is_owner("user:u_p3b_hiveowner")
    assert not hive.ownhive.is_owner("user:u_p3b_owner")
    made = client.post("/api/agents", headers=headers["owner"], json={"name": "Owner's mind", "kind": "module", "visibility": "public"})
    assert made.status_code == 200, made.text
    mind = made.json()
    events, sent, audits, programs = [], [], [], []
    monkeypatch.setattr(hive.events, "publish", lambda kind, **payload: events.append((kind, payload)))
    monkeypatch.setattr(hive.governance, "record", lambda *args: audits.append(args))

    async def send(*args, **kwargs):
        sent.append((args, kwargs))

    async def notify(row):
        programs.append(dict(row))

    monkeypatch.setattr(hive, "send_to_agent", send)
    monkeypatch.setattr(hive.program_actions, "notify_decision", notify)
    return {"c": client, "h": hive, "headers": headers, "mind": mind,
            "events": events, "sent": sent, "audits": audits, "programs": programs}


def configure(e, enabled=True):
    r = e["c"].patch("/api/agents/" + e["mind"]["id"], headers=e["headers"]["owner"],
                     json={"options": {"approvals": "owner_only"} if enabled else {}})
    assert r.status_code == 200, r.text
    for key in ("events", "sent", "audits", "programs"):
        e[key].clear()


def pending(e, program=False, risk="medium"):
    row = {"id": "p_p3b_" + uuid.uuid4().hex[:12], "agent_id": e["mind"]["id"],
           "skill": "program:synthetic:save" if program else "write-file", "command": "P3B_SYNTHETIC_ACTION",
           "reason": "synthetic approval", "risk": risk, "status": "pending", "created_at": now()}
    e["h"].db.insert("approvals", row)
    return row


def answer(e, row, actor, name, payload):
    route = "approve" if name in ("approve", "remember") else "deny" if name == "deny" else "decide"
    return e["c"].post(f"/api/approvals/{row['id']}/{route}", headers=e["headers"][actor], json=payload)


def unchanged(e, row):
    assert e["h"].policy.approval(row["id"])["status"] == "pending"
    assert not e["h"].policy.rules()
    assert not e["events"] and not e["sent"] and not e["audits"] and not e["programs"]


@pytest.mark.parametrize("name,payload,status", ANSWERS)
@pytest.mark.parametrize("actor", ("owner", "member", "admin", "hiveowner"))
@pytest.mark.parametrize("program", (False, True))
def test_owner_only_all_answer_routes_and_program_rows(env, name, payload, status, actor, program):
    configure(env)
    row = pending(env, program)
    r = answer(env, row, actor, name, payload)
    if actor != "owner":
        assert r.status_code == 403, r.text
        unchanged(env, row)
    elif program and name in ("remember", "for", "always"):
        assert r.status_code == 400 and r.json()["error"]["code"] == "exact_only", r.text
        unchanged(env, row)
    else:
        assert r.status_code == 200, r.text
        assert r.json()["status"] == status and r.json()["decided_by"] == "user:u_p3b_owner"
        assert len(env["sent"]) == len(env["audits"]) == 1
        assert len(env["programs"]) == int(program)


@pytest.mark.parametrize("actor,name,payload", (("member", "approve", {}), ("admin", "approve", {}),
                                                ("hiveowner", "approve", {}), ("admin", "remember", {"remember": True}),
                                                ("hiveowner", "always", {"decision": "always"})))
def test_absent_setting_keeps_existing_visible_and_durable_authorities(env, actor, name, payload):
    if actor == "hiveowner" and name == "always":
        # money port r1.1 (Dot): a lasting answer needs the hive owner still an enabled admin, as every owner power
        env["h"].db.execute("UPDATE people SET role = 'admin' WHERE id = 'u_p3b_hiveowner'")
    row = pending(env)
    r = answer(env, row, actor, name, payload)
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text


def test_a_hive_owner_who_is_not_an_admin_gives_no_lasting_answer(env):
    """money port r1.1 (Dot): the recorded hive owner, demoted to member, may still answer this one request on a mind
    they see, but a lasting answer (always) is refused (403 owner_only) and writes no rule."""
    row = pending(env)
    r = answer(env, row, "hiveowner", "always", {"decision": "always"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
    assert env["h"].policy.approval(row["id"])["status"] == "pending" and not env["h"].policy.rules()
    assert answer(env, row, "hiveowner", "approve", {}).status_code == 200


@pytest.mark.parametrize("actor", ("member", "admin", "hiveowner"))
@pytest.mark.parametrize("clear", (False, True))
def test_nonowner_cannot_set_or_clear_by_full_options_replacement(env, actor, clear):
    if clear:
        configure(env)
    before = env["h"].agent(env["mind"]["id"])["options"]
    r = env["c"].patch("/api/agents/" + env["mind"]["id"], headers=env["headers"][actor],
                       json={"options": {} if clear else {"approvals": "owner_only"}})
    assert r.status_code == 403, r.text
    assert env["h"].agent(env["mind"]["id"])["options"] == before
    assert not env["events"]


def test_owner_setting_roundtrip_and_opted_in_creation(env):
    configure(env)
    assert env["h"].agent(env["mind"]["id"])["options"]["approvals"] == "owner_only"
    configure(env, False)
    assert "approvals" not in env["h"].agent(env["mind"]["id"])["options"]
    default_row = pending(env)
    default_answer = answer(env, default_row, "admin", "approve", {})
    assert default_answer.status_code == 200 and default_answer.json()["status"] == "approved", default_answer.text
    r = env["c"].post("/api/agents", headers=env["headers"]["owner"],
                      json={"name": "Another owned mind", "kind": "module", "options": {"approvals": "owner_only"}})
    assert r.status_code == 200 and r.json()["owner"] == "user:u_p3b_owner", r.text
    assert r.json()["options"]["approvals"] == "owner_only"


@pytest.mark.parametrize("value", (None, True, "shared", ["owner_only"]))
def test_malformed_setting_is_not_silently_dropped(env, value):
    r = env["c"].patch("/api/agents/" + env["mind"]["id"], headers=env["headers"]["owner"], json={"options": {"approvals": value}})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_options", r.text
    assert "approvals" not in env["h"].agent(env["mind"]["id"])["options"]


@pytest.mark.parametrize("operation", ("create", "update"))
def test_central_writer_does_not_trust_privileged_nonowner(env, operation):
    h = env["h"]
    with pytest.raises(HiveError) as caught:
        if operation == "create":
            h.create_agent("Wrong writer", kind="module", owner="user:u_p3b_owner", by="user:u_p3b_admin", options={"approvals": "owner_only"})
        else:
            h.update_agent(env["mind"]["id"], {"options": {"approvals": "owner_only"}}, by="user:u_p3b_admin", privileged=True)
    assert caught.value.code == "approval_owner_only"
    assert "approvals" not in h.agent(env["mind"]["id"])["options"]


def test_admin_audit_and_track_record_remain_reads(env):
    configure(env)
    row = pending(env)
    r = env["c"].get("/api/approvals", headers=env["headers"]["admin"])
    assert r.status_code == 200 and row["id"] in [item["id"] for item in r.json()]
    r = env["c"].get(f"/api/approvals/{row['id']}/track-record", headers=env["headers"]["admin"])
    assert r.status_code == 200, r.text
    unchanged(env, row)


def test_hidden_mind_is_still_not_found_and_admin_audit_is_not_an_answer(env):
    configure(env)
    row = pending(env)
    env["h"].db.execute("UPDATE agents SET visibility='private', shared_with='[]' WHERE id=?", (row["agent_id"],))
    hidden = answer(env, row, "member", "approve", {})
    assert hidden.status_code == 404, hidden.text
    audit = answer(env, row, "admin", "approve", {})
    assert audit.status_code == 403, audit.text
    unchanged(env, row)


@pytest.mark.parametrize("actor", ("owner", "member", "admin", "hiveowner"))
def test_person_actionability_matches_owner_only_answers(env, actor):
    configure(env)
    row = pending(env)
    r = env["c"].get("/api/me/decisions", headers=env["headers"][actor])
    assert r.status_code == 200, r.text
    ids = [item["id"] for item in r.json()["categories"]["approvals"]["items"]]
    assert (row["id"] in ids) == (actor == "owner")


@pytest.mark.parametrize("name,payload", (("approve", {}), ("for", {"decision": "for", "minutes": 5})))
@pytest.mark.parametrize("change", ("revoke", "expire", "disable", "owner", "new_flag"))
def test_current_auth_owner_and_flag_are_rechecked_after_body(env, monkeypatch, name, payload, change):
    configure(env, change != "new_flag")
    row = pending(env)
    actor = "admin" if change == "new_flag" else "owner"
    original = Request.json

    async def changed(request):
        data = await original(request)
        if request.url.path.startswith("/api/approvals/"):
            h = env["h"]
            token = env["headers"][actor]["Authorization"].split(" ", 1)[1]
            if change == "revoke":
                h.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
            elif change == "expire":
                h.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (time.time() - 1, token_hash(token)))
            elif change == "disable":
                h.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", ("u_p3b_" + actor,))
            elif change == "owner":
                h.db.execute("UPDATE agents SET owner = ? WHERE id = ?", ("user:u_p3b_member", row["agent_id"]))
            else:
                h.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"approvals": "owner_only"}), row["agent_id"]))
        return data

    monkeypatch.setattr(Request, "json", changed)
    r = answer(env, row, actor, name, payload)
    assert r.status_code == (401 if change in ("revoke", "expire", "disable") else 403), r.text
    unchanged(env, row)


@pytest.mark.parametrize("operation", ("create", "update"))
def test_setting_write_revalidates_body_session(env, monkeypatch, operation):
    original = Request.json

    async def changed(request):
        data = await original(request)
        token = env["headers"]["owner"]["Authorization"].split(" ", 1)[1]
        env["h"].db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        return data

    monkeypatch.setattr(Request, "json", changed)
    before = env["h"].db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    if operation == "create":
        r = env["c"].post("/api/agents", headers=env["headers"]["owner"], json={"name": "Expired", "kind": "module", "options": {"approvals": "owner_only"}})
    else:
        r = env["c"].patch("/api/agents/" + env["mind"]["id"], headers=env["headers"]["owner"], json={"options": {"approvals": "owner_only"}})
    assert r.status_code == 401, r.text
    assert env["h"].db.one("SELECT COUNT(*) AS n FROM agents")["n"] == before
    assert "approvals" not in env["h"].agent(env["mind"]["id"])["options"]


def test_current_session_is_rechecked_at_policy_handoff(env, monkeypatch):
    configure(env)
    row = pending(env)
    original = env["h"].policy.decide_approval

    async def handed(*args, **kwargs):
        token = env["headers"]["owner"]["Authorization"].split(" ", 1)[1]
        env["h"].db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        return await original(*args, **kwargs)

    monkeypatch.setattr(env["h"].policy, "decide_approval", handed)
    r = answer(env, row, "owner", "approve", {})
    assert r.status_code == 401, r.text
    unchanged(env, row)


@pytest.mark.parametrize("decision,mode", (("for", "allow"), ("never", "deny")))
def test_durable_rule_commits_before_notification_await(env, monkeypatch, decision, mode):
    configure(env)
    row = pending(env)

    async def notification(*args, **kwargs):
        rules = env["h"].policy.rules()
        assert len(rules) == 1 and rules[0]["mode"] == mode
        assert env["h"].policy.approval(row["id"])["status"] != "pending"
        env["h"].db.execute("UPDATE agents SET owner = ? WHERE id = ?", ("user:u_p3b_member", row["agent_id"]))

    monkeypatch.setattr(env["h"], "send_to_agent", notification)
    r = answer(env, row, "owner", decision, {"decision": decision, "minutes": 5})
    assert r.status_code == 200, r.text
    assert len(env["h"].policy.rules()) == 1


def test_durable_rule_failure_rolls_back_status_without_notices(env, monkeypatch):
    configure(env)
    row = pending(env)

    def failed(*args, **kwargs):
        raise RuntimeError("synthetic durable-write fault")

    monkeypatch.setattr(env["h"].policy, "add_rule", failed)
    with pytest.raises(RuntimeError, match="synthetic durable-write fault"):
        answer(env, row, "owner", "for", {"decision": "for", "minutes": 5})
    unchanged(env, row)


@pytest.mark.parametrize("name,payload", (("remember", {"remember": True}), ("always", {"decision": "always"}),
                                          ("for", {"decision": "for", "minutes": 5})))
def test_owner_only_does_not_loosen_p2_ceiling(env, monkeypatch, name, payload):
    configure(env)
    row = pending(env)
    monkeypatch.setattr(env["h"].policy, "_ceiling", lambda *args: "ask")
    r = answer(env, row, "owner", name, payload)
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    assert not env["h"].policy.rules()


@pytest.mark.parametrize("name,payload", (("remember", {"remember": True}), ("always", {"decision": "always"}),
                                          ("for", {"decision": "for", "minutes": 5})))
def test_owner_only_does_not_loosen_high_risk_rules(env, name, payload):
    configure(env)
    row = pending(env, risk="high")
    r = answer(env, row, "owner", name, payload)
    assert r.status_code == 400 and r.json()["error"]["code"] == "one_at_a_time", r.text
    unchanged(env, row)


@pytest.mark.parametrize("change", ("flag", "replacement_key", "locked"))
def test_queued_key_unassignment_preserves_fresh_approval_policy(env, monkeypatch, change):
    h = env["h"]
    first, other = "k_1234abcd", "k_5678abcd"
    for key in (first, other):
        h.keyring.ring["keys"][key] = {"id": key, "provider": "mock", "label": "synthetic test key",
                                       "owner": "user:u_p3b_owner", "secret": "SYNTHETIC_NOT_A_PROVIDER_KEY"}
    h.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": first}), env["mind"]["id"]))
    original = app_module.run_in_threadpool
    injections = []

    async def queued(function, *args, **kwargs):
        if getattr(function, "__name__", "") in ("update_agent", "unassign_stored_key"):
            assert not injections
            injections.append(True)
            fresh = {"key": other if change == "replacement_key" else first, "approvals": "owner_only"}
            if change == "locked":
                fresh["key_locked"] = True
            h.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps(fresh), env["mind"]["id"]))
            token = env["headers"]["owner"]["Authorization"].split(" ", 1)[1]
            h.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        return await original(function, *args, **kwargs)

    monkeypatch.setattr(app_module, "run_in_threadpool", queued)
    r = env["c"].delete("/api/keys/" + first, headers=env["headers"]["owner"])
    assert r.status_code == 200, r.text
    assert injections == [True]
    options = json.loads(h.db.one("SELECT options FROM agents WHERE id = ?", (env["mind"]["id"],))["options"])
    assert options["approvals"] == "owner_only"
    if change == "flag":
        assert "key" not in options and r.json()["unassigned"] == 1
    else:
        assert options["key"] == (other if change == "replacement_key" else first)
        assert r.json()["unassigned"] == 0
        if change == "locked":
            assert options["key_locked"] is True
