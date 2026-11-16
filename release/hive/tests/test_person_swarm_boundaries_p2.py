"""Synthetic P2 boundary regressions. No process or provider is launched.

Production guards, HTTP approvals and the real Supervisor state machine use
invented programs/people/keys and a driver whose execution is just a Python set.
"""
import asyncio
import json
import sqlite3
import threading
from types import SimpleNamespace

import pytest

from hive.core.hive import HiveError
from hive.core.gateway import SEND_GATE
from hive.core.person_swarms import parse_templates
from hive.supervisor.drivers import Supervisor
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_key_owner_oi13 import K_BOB, MODEL, add_key, w  # noqa: F401
from hive.tests.test_person_swarms_p2 import APP, BOB_P, TEMPLATE, card, consent, ensure, host_person_action, install, opts, p  # noqa: F401

NEW_KEY = "k_000b0b0c"


def mint(p, template=None):
    if template is not None:
        install(p.hive, template)
    assert consent(p).status_code == 200
    out = ensure(p)
    assert out["status"] == "ready"
    agent_id = out["minds"]["errands"]
    return p.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))


def revoke(p):
    # A newly loaded trusted template has a different digest. No ensure call.
    changed = {**TEMPLATE, "minds": [{**TEMPLATE["minds"][0], "persona": "A changed reviewed persona."}, TEMPLATE["minds"][1]]}
    install(p.hive, changed)


def awake(p, agent_id):
    p.hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (agent_id,))


def stored(p, agent_id):
    return p.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))


@pytest.mark.parametrize("read", ["agent", "raw", "list", "swarm", "messages"])
def test_next_read_sleeps_revoked_mind_without_ensure_and_refreshes_projection(p, read):
    agent = mint(p)
    awake(p, agent["id"])
    revoke(p)
    before = p.hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    if read == "agent":
        assert p.hive.agent(agent["id"])["status"] == "asleep"
    elif read == "raw":
        assert p.hive._agent_row(agent["id"])["status"] == "asleep"
    elif read == "list":
        assert next(a for a in p.hive.agents() if a["id"] == agent["id"])["status"] == "asleep"
    elif read == "swarm":
        p.hive.swarm(agent["swarm_id"])
    else:
        p.hive.messages(agent["id"])
    assert (stored(p, agent["id"])["status"], stored(p, agent["id"])["desired"]) == ("asleep", "asleep")
    assert p.hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"] == before
    assert p.hive.db.one("SELECT 1 FROM app_person_minds WHERE agent_id = ?", (agent["id"],))
    assert stored(p, p.bob_mind["id"])["desired"] != "asleep"


@pytest.mark.parametrize("action", ["start", "wake"])
def test_lifecycle_refuses_revoked_setup_without_ensure_or_start(p, action):
    agent = mint(p)
    revoke(p)
    before = list(p.hive.supervisor.calls)
    with pytest.raises(HiveError) as exc:
        p.hive.lifecycle(agent["id"], action)
    assert exc.value.code == "app_swarm_revoked"
    assert ("start", agent["id"]) not in p.hive.supervisor.calls[len(before):]
    assert stored(p, agent["id"])["desired"] == "asleep"


class SetDriver:
    def __init__(self):
        self.running, self.starts = set(), []

    def start(self, agent, env):
        self.starts.append(agent["id"])
        self.running.add(agent["id"])

    def stop(self, agent_id):
        self.running.discard(agent_id)

    def status(self, agent_id):
        return "running" if agent_id in self.running else "stopped"

    def execution(self, agent_id):
        return "synthetic-execution" if agent_id in self.running else None


def actual_supervisor(p, monkeypatch):
    supervisor = Supervisor.__new__(Supervisor)
    supervisor.hive, supervisor.settings = p.hive, p.hive.settings
    supervisor._locks, supervisor._transitions, supervisor._generations, supervisor._restarts = {}, {}, {}, {}
    supervisor._locks_guard, supervisor._stop = threading.Lock(), threading.Event()
    driver = SetDriver()
    supervisor.drivers = {"local": driver, "docker": driver, p.hive.settings.default_driver: driver}
    supervisor.workspace = SimpleNamespace(write_studio_skills=lambda *a: None, write_tools=lambda *a: None,
                                           write_prompt=lambda *a: None, tools_plan=lambda *a: None)
    supervisor.env = lambda agent: {}
    monkeypatch.setattr(p.hive, "supervisor", supervisor)
    return supervisor, driver


@pytest.mark.parametrize("path", ["direct", "reconcile", "tools"])
def test_real_supervisor_direct_paths_cannot_restart_revoked_setup(p, monkeypatch, path):
    agent = mint(p)
    supervisor, driver = actual_supervisor(p, monkeypatch)
    awake(p, agent["id"])
    if path == "tools":
        driver.running.add(agent["id"])
        supervisor.workspace.write_tools = lambda *a: revoke(p)
        with pytest.raises(HiveError):
            supervisor.reconfigure_tools(p.hive.agent_view(agent, guard=False))
    else:
        revoke(p)
        if path == "direct":
            with pytest.raises(HiveError):
                supervisor.start(agent["id"])
        else:
            supervisor.check()
    assert driver.starts == []
    assert agent["id"] not in driver.running
    assert stored(p, agent["id"])["desired"] == "asleep"


def test_final_start_gate_rechecks_after_environment_preparation(p, monkeypatch):
    agent = mint(p)
    supervisor, driver = actual_supervisor(p, monkeypatch)
    supervisor.env = lambda view: (revoke(p) or {})
    with pytest.raises(HiveError) as exc:
        supervisor.start(agent["id"])
    assert exc.value.code == "app_swarm_revoked"
    assert driver.starts == []


def test_stop_failure_is_explicit_and_never_claimed_asleep(p, monkeypatch):
    agent = mint(p)
    awake(p, agent["id"])
    revoke(p)
    def failed(agent_id):
        raise RuntimeError("synthetic stop failure")
    monkeypatch.setattr(p.hive.supervisor, "verify_stopped", failed)
    view = p.hive.agent(agent["id"])
    assert view["status"] == "error" and "stop unconfirmed" in view["last_error"]
    assert stored(p, agent["id"])["desired"] == "asleep"
    with pytest.raises(HiveError):
        p.hive.check_budget(agent)


def test_busy_read_does_not_wait_for_an_inverse_mind_lock_or_claim_stop(p):
    agent = mint(p)
    awake(p, agent["id"])
    revoke(p)
    held, release = threading.Event(), threading.Event()
    def owner():
        with p.hive.supervisor.lock(agent["id"]):
            held.set()
            assert release.wait(2)
    thread = threading.Thread(target=owner)
    thread.start()
    assert held.wait(2)
    try:
        view = p.hive.agent(agent["id"])
        assert view["status"] == "error" and "pending" in view["last_error"]
    finally:
        release.set()
        thread.join(2)
    assert not thread.is_alive()
    assert p.hive.agent(agent["id"])["status"] == "asleep"


@pytest.mark.parametrize("authority", ["missing", "disabled", "error", "integrity"])
def test_cached_template_cannot_bypass_current_readiness(p, monkeypatch, authority):
    agent = mint(p)
    awake(p, agent["id"])
    if authority == "missing":
        p.hive.programs.programs.pop(APP)
    elif authority == "disabled":
        p.hive.programs.disabled.add(APP)
    elif authority == "error":
        p.hive.programs.programs[APP]["error"] = "release_mismatch: synthetic"
    else:
        def refused(entry, *args):
            raise p.hive.error(403, "app_integrity", "synthetic drift")
        monkeypatch.setattr(p.hive.programs, "check_integrity", refused)
    with pytest.raises(HiveError):
        p.hive.person_swarms.card(BOB_P, APP, "helpers")
    assert p.hive.agent(agent["id"])["status"] == "asleep"
    with pytest.raises(HiveError):
        p.hive.lifecycle(agent["id"], "wake")


@pytest.mark.parametrize("answer", ["remember", "always", "for"])
def test_actual_HTTP_durable_approval_is_once_under_template_ask(p, answer):
    agent = mint(p)
    p.hive.policy.add_rule(f"agent:{agent['id']}", "web-fetch", "allow", publish=False)
    approval = p.hive.policy._file(agent, "web-fetch", "(web-fetch synthetic)", "asks first")
    if answer == "remember":
        response = p.client.post(f"/api/approvals/{approval['id']}/approve", headers=p.bob, json={"remember": True})
    else:
        response = p.client.post(f"/api/approvals/{approval['id']}/decide", headers=p.bob,
                                 json={"decision": answer, "minutes": 30})
    assert response.status_code == 200, response.text
    assert p.hive.policy.approval(approval["id"])["status"] == "approved"
    assert not [r for r in p.hive.policy.rules() if r.get("origin") == "answer" and r["scope"] == f"agent:{agent['id']}" and r["mode"] == "allow"]
    assert p.hive.policy.decide(agent, "web-fetch")[0] == "ask"


def program_action(p, monkeypatch, cap):
    agent = mint(p, {**TEMPLATE, "rules": [] if cap is None else [{"skill": "program:*", "mode": cap}]})
    entry = p.hive.programs.get(APP)
    entry["describe"] = {"actions": [{"id": "send", "agents": True}]}
    p.hive.policy.add_rule(f"agent:{agent['id']}", f"program:{APP}:send", "allow", publish=False)
    monkeypatch.setattr(p.hive.app_attachments, "required", lambda e: True)
    monkeypatch.setattr(p.hive.app_attachments, "authorize", lambda *a: ({"id": "synthetic-attachment"}, "allow"))
    effects = []
    async def act(*args, **kwargs):
        effects.append("synthetic-effect")
        return {"status": "ok"}
    monkeypatch.setattr(p.hive.programs, "act", act)
    return agent, effects, {"action": "send", "items": [], "params": {}, "idempotency_key": "synthetic-action"}


@pytest.mark.parametrize("scope", ["agent", "swarm", "hive"])
def test_program_template_deny_beats_explicit_and_attachment_allow(p, monkeypatch, scope):
    agent, effects, body = program_action(p, monkeypatch, "deny")
    p.hive.db.execute("DELETE FROM policy_rules WHERE skill = ?", (f"program:{APP}:send",))
    target = "hive" if scope == "hive" else f"{scope}:{agent['id'] if scope == 'agent' else agent['swarm_id']}"
    p.hive.policy.add_rule(target, f"program:{APP}:send", "allow", publish=False)
    with pytest.raises(HiveError) as exc:
        asyncio.run(p.hive.program_actions.agent_act(agent, APP, body))
    assert exc.value.code == "policy_refused" and effects == []


@pytest.mark.parametrize("scope", ["agent", "swarm", "hive"])
def test_program_template_ask_survives_attachment_and_needs_exact_approval(p, monkeypatch, scope):
    agent, effects, body = program_action(p, monkeypatch, "ask")
    p.hive.db.execute("DELETE FROM policy_rules WHERE skill = ?", (f"program:{APP}:send",))
    target = "hive" if scope == "hive" else f"{scope}:{agent['id'] if scope == 'agent' else agent['swarm_id']}"
    p.hive.policy.add_rule(target, f"program:{APP}:send", "allow", publish=False)
    first = asyncio.run(p.hive.program_actions.agent_act(agent, APP, body))
    assert first["status"] == "approval_required" and effects == []
    approved = p.client.post(f"/api/approvals/{first['approval_id']}/approve", headers=p.bob, json={})
    assert approved.status_code == 200, approved.text
    out = asyncio.run(p.hive.program_actions.agent_act(agent, APP, {**body, "approval_id": first["approval_id"]}))
    assert out["status"] == "ok" and effects == ["synthetic-effect"]


def test_revocation_before_program_approval_redemption_runs_no_hook(p, monkeypatch):
    agent, effects, body = program_action(p, monkeypatch, "ask")
    first = asyncio.run(p.hive.program_actions.agent_act(agent, APP, body))
    assert p.client.post(f"/api/approvals/{first['approval_id']}/approve", headers=p.bob, json={}).status_code == 200
    revoke(p)
    with pytest.raises(HiveError) as exc:
        asyncio.run(p.hive.program_actions.agent_act(agent, APP, {**body, "approval_id": first["approval_id"]}))
    assert exc.value.code == "app_swarm_revoked" and effects == []
    assert p.hive.policy.approval(first["approval_id"])["redeemed_at"] is None


def test_send_header_boundary_rechecks_after_an_awaited_gate(p):
    agent = mint(p)
    gateway = p.client.app.state.gateway
    async def gate():
        revoke(p)
    async def attempt():
        token = SEND_GATE.set(gate)
        try:
            await gateway._trace(agent)("http11.send_request_headers.started", {})
        finally:
            SEND_GATE.reset(token)
    with pytest.raises(HiveError) as exc:
        asyncio.run(attempt())
    assert exc.value.code == "app_swarm_revoked"
    assert stored(p, agent["id"])["desired"] == "asleep"


def test_fresh_key_consent_repairs_finished_identity_in_place(p):
    agent = mint(p)
    assert p.client.delete(f"/api/keys/{K_BOB}?force=1", headers=p.bob).status_code == 200
    add_key(p.hive, NEW_KEY, BOB_P)
    shown = card(p)
    assert shown["key_id"] == NEW_KEY
    assert consent(p, shown).status_code == 200
    out = ensure(p)
    assert out["minds"]["errands"] == agent["id"]
    assert opts(p.hive, agent["id"])["key"] == NEW_KEY
    assert opts(p.hive, agent["id"])["key_locked"] is True
    assert stored(p, agent["id"])["deleted"] == 0
    assert stored(p, agent["id"])["last_error"] is None


def test_finished_slot_owner_mismatch_refuses_without_deletion(p):
    agent = mint(p)
    p.hive.db.execute("UPDATE agents SET owner = 'user:someone-else' WHERE id = ?", (agent["id"],))
    with pytest.raises(HiveError) as exc:
        ensure(p)
    assert exc.value.code == "person_swarm_repair_required"
    assert stored(p, agent["id"])["deleted"] == 0


def test_logical_uninstall_retains_tombstone_and_requires_new_consent(p):
    agent = mint(p)
    awake(p, agent["id"])
    denied = p.client.delete(f"/api/programs/{APP}", headers=p.bob)
    assert denied.status_code == 403
    response = p.client.delete(f"/api/programs/{APP}", headers=p.ann)
    assert response.status_code == 200, response.text
    assert stored(p, agent["id"])["deleted"] == 0
    assert stored(p, agent["id"])["status"] == "asleep"
    assert not p.hive.db.all("SELECT * FROM app_template_rules WHERE agent_id = ?", (agent["id"],))
    install(p.hive)
    p.hive.programs.disabled.discard(APP)
    assert ensure(p)["status"] == "consent_required"
    with pytest.raises(HiveError):
        p.hive.lifecycle(agent["id"], "wake")
    assert consent(p).status_code == 200
    assert ensure(p)["status"] == "ready"


def test_HTTP_disable_reconciles_and_enable_keeps_an_unwithdrawn_consent(p):
    agent = mint(p)
    p.hive.programs.get(APP).update(version="synthetic", description="Invented template fixture", icon="spark", source="synthetic")
    awake(p, agent["id"])
    disabled = p.client.post(f"/api/programs/{APP}/disable", headers=p.ann)
    assert disabled.status_code == 200, disabled.text
    assert stored(p, agent["id"])["status"] == "asleep"
    with pytest.raises(HiveError):
        p.hive.lifecycle(agent["id"], "wake")
    enabled = p.client.post(f"/api/programs/{APP}/enable", headers=p.ann)
    assert enabled.status_code == 200, enabled.text
    assert ensure(p)["status"] == "ready"
    p.hive.lifecycle(agent["id"], "wake")
    assert ("start", agent["id"]) in p.hive.supervisor.calls


def test_partial_create_serializes_with_app_uninstall_without_resurrection(p, monkeypatch):
    assert consent(p).status_code == 200
    entered, release, done = threading.Event(), threading.Event(), threading.Event()
    original = p.hive.finish_agent
    errors = []
    def paused(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(p.hive, "finish_agent", paused)
    def create():
        try:
            ensure(p)
        except Exception as exc:
            errors.append(exc)
    def uninstall():
        try:
            p.hive.programs.uninstall(APP, by=BOB_P)
        except Exception as exc:
            errors.append(exc)
        finally:
            done.set()
    first = threading.Thread(target=create)
    first.start()
    assert entered.wait(2)
    second = threading.Thread(target=uninstall)
    second.start()
    try:
        assert not done.wait(.05)
    finally:
        release.set()
        first.join(2)
        second.join(2)
    assert not first.is_alive() and not second.is_alive() and not errors
    install(p.hive)
    p.hive.programs.disabled.discard(APP)
    before = p.hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    assert ensure(p)["status"] == "consent_required"
    assert p.hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"] == before


@pytest.mark.parametrize("change", ["withdraw", "uninstall"])
def test_a_card_from_before_withdrawal_or_uninstall_cannot_reconsent(p, change):
    agent = mint(p)
    old = card(p)
    if change == "withdraw":
        assert p.client.post(f"/api/me/app-swarms/{APP}/helpers/withdraw", headers=p.bob).status_code == 200
    else:
        assert p.client.delete(f"/api/programs/{APP}", headers=p.ann).status_code == 200
        install(p.hive)
        p.hive.programs.disabled.discard(APP)
    refused = consent(p, old)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "card_changed"
    assert ensure(p)["status"] == "consent_required"
    assert stored(p, agent["id"])["deleted"] == 0
    assert consent(p).status_code == 200


def test_consent_card_includes_the_trusted_persona(p):
    assert card(p)["minds"][0]["persona"] == TEMPLATE["minds"][0]["persona"]


def test_same_clock_withdraw_reconsent_cannot_reuse_an_older_card(p, monkeypatch):
    import hive.core.person_swarms as module
    monkeypatch.setattr(module, "now", lambda: "2026-01-01T00:00:00.000Z")
    mint(p)
    old = card(p)
    p.hive.person_swarms.withdraw(BOB_P, APP, "helpers")
    assert consent(p).status_code == 200
    refused = consent(p, old)
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "card_changed"


def test_program_ordinary_deny_stays_stricter_than_template_ask(p, monkeypatch):
    agent, effects, body = program_action(p, monkeypatch, "ask")
    p.hive.db.execute("DELETE FROM policy_rules WHERE scope = ? AND skill = ?",
                      (f"agent:{agent['id']}", f"program:{APP}:send"))
    p.hive.policy.add_rule(f"agent:{agent['id']}", f"program:{APP}:send", "deny", publish=False)
    with pytest.raises(HiveError) as exc:
        asyncio.run(p.hive.program_actions.agent_act(agent, APP, body))
    assert exc.value.code == "policy_refused" and effects == []


def test_service_exact_approval_cannot_be_redeemed_after_revocation(p):
    agent = mint(p, {**TEMPLATE, "rules": [{"skill": "code-*", "mode": "ask"}]})
    binding = {"synthetic": "one-exact-request"}
    approval = p.hive.policy._file(agent, "code-edit", "(code-edit synthetic)", "asks first", binding)
    response = p.client.post(f"/api/approvals/{approval['id']}/approve", headers=p.bob, json={})
    assert response.status_code == 200
    revoke(p)
    with pytest.raises(HiveError) as exc:
        p.hive.services.redeem(approval["id"], binding)
    assert exc.value.code == "app_swarm_revoked"
    assert p.hive.policy.approval(approval["id"])["redeemed_at"] is None


def test_changed_monthly_total_keeps_run_authorised_without_another_ensure(p):
    agent = mint(p)
    assert p.client.put("/api/me/key-limits/self", headers=p.bob, json={"month_usd": 25}).status_code == 200
    p.hive.lifecycle(agent["id"], "wake")
    assert ("start", agent["id"]) in p.hive.supervisor.calls
    assert p.hive.person_swarms.current(agent["id"])[1] is None


def test_read_reconciliation_waits_until_a_reservation_transaction_releases_DB(p):
    agent = mint(p)
    awake(p, agent["id"])
    revoke(p)
    before = list(p.hive.supervisor.calls)
    with p.hive.db.transaction():
        view = p.hive.agent(agent["id"])
        assert view["status"] == "error" and "pending" in view["last_error"]
        assert ("stop", agent["id"]) not in p.hive.supervisor.calls[len(before):]
    assert ("stop", agent["id"]) in p.hive.supervisor.calls[len(before):]
    assert stored(p, agent["id"])["status"] == "asleep"


def test_two_templates_share_the_person_app_withdrawal_fence(p, monkeypatch):
    entry = p.hive.programs.get(APP)
    entry["swarm_templates"]["other"] = entry["swarm_templates"]["helpers"]
    assert consent(p).status_code == 200
    other = p.client.get(f"/api/me/app-swarms/{APP}/other", headers=p.bob).json()
    assert p.client.post(f"/api/me/app-swarms/{APP}/other/consent", headers=p.bob, json={
        k: other[k] for k in ("template_digest", "key_id", "month_usd", "consent_revision", "authority_revision")
    }).status_code == 200
    entered, release, withdrawn = threading.Event(), threading.Event(), threading.Event()
    original = p.hive.finish_agent
    failures = []
    def paused(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(p.hive, "finish_agent", paused)
    def create():
        try:
            ensure(p)
        except Exception as exc:
            failures.append(exc)
    def withdraw_other():
        try:
            p.hive.person_swarms.withdraw(BOB_P, APP, "other")
        except Exception as exc:
            failures.append(exc)
        finally:
            withdrawn.set()
    first, second = threading.Thread(target=create), threading.Thread(target=withdraw_other)
    first.start()
    assert entered.wait(2)
    second.start()
    try:
        assert not withdrawn.wait(.05)
    finally:
        release.set()
        first.join(2)
        second.join(2)
    assert not first.is_alive() and not second.is_alive() and not failures
    before = p.hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    assert p.hive.person_swarms.ensure(BOB_P, APP, "other")["status"] == "consent_required"
    assert p.hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"] == before


def test_conflicting_recorded_bindings_are_invalid_not_unbound(p):
    agent = mint(p)
    p.hive.db.execute("INSERT INTO app_person_minds (principal, program_id, template_id, slot, agent_id, "
        "template_digest, finished, created_at) SELECT principal, program_id, template_id, 'conflicting', "
        "agent_id, template_digest, finished, created_at FROM app_person_minds WHERE agent_id = ?", (agent["id"],))
    binding, reason = p.hive.person_swarms.current(agent["id"])
    assert binding is not None and "conflicting" in reason
    with pytest.raises(HiveError) as exc:
        p.hive.person_swarms.require_current(agent["id"])
    assert exc.value.code == "app_swarm_revoked"


def test_finished_repair_does_not_hold_mind_while_waiting_for_tools_fence(p, monkeypatch):
    agent = mint(p)
    assert p.client.delete(f"/api/keys/{K_BOB}?force=1", headers=p.bob).status_code == 200
    add_key(p.hive, NEW_KEY, BOB_P)
    assert consent(p).status_code == 200
    main_thread = threading.get_ident()
    attempted = threading.Event()
    real_tools_lock = p.hive._tools_choices_lock
    class ObservedToolsLock:
        def __enter__(self):
            if threading.get_ident() != main_thread:
                attempted.set()
            real_tools_lock.acquire()
            return self

        def __exit__(self, *args):
            real_tools_lock.release()
    monkeypatch.setattr(p.hive, "_tools_choices_lock", ObservedToolsLock())
    failures, outputs = [], []
    def repair():
        try:
            outputs.append(ensure(p))
        except Exception as exc:
            failures.append(exc)
    thread = threading.Thread(target=repair)
    available = False
    try:
        with p.hive._tools_choices_lock:
            thread.start()
            assert attempted.wait(2)
            # An ordinary update already owns tools and must remain able to
            # enter this mind. The old inverse order is detected without
            # making the test itself wait forever on that mind.
            lock = p.hive.supervisor.lock(agent["id"])
            available = lock.acquire(blocking=False)
            if available:
                try:
                    p.hive.update_agent(agent["id"], {"name": "Ordinary update"}, by=BOB_P)
                finally:
                    lock.release()
    finally:
        # Release tools before joining, even if an assertion failed.
        if thread.ident is not None:
            thread.join(2)
    assert not thread.is_alive() and not failures
    assert available, "repair held the mind while waiting for the ordinary update's tools fence"
    assert outputs[0]["status"] == "ready"
    assert opts(p.hive, agent["id"])["key"] == NEW_KEY


@pytest.mark.parametrize("field", ["actor", "command", "program", "all"])
def test_mutable_context_fields_cannot_select_another_person_or_app(p, monkeypatch, field):
    from hive.tests.test_key_owner_oi13 import ANN
    assert consent(p).status_code == 200  # victim Bob has live consent
    before = p.hive.db.one("SELECT COUNT(*) AS n FROM app_person_minds")["n"]
    def hook(ctx, action, items, params):
        if field in ("actor", "all"):
            ctx.actor = {"kind": "person", "principal": BOB_P}
        if field in ("command", "all"):
            ctx.command = {"record_id": "forged", "idempotency_key": "forged", "params_digest": "forged"}
        if field in ("program", "all"):
            ctx._program = {"id": "forged-other-app", "capabilities": ["person_swarm"]}
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    # The real host records Ann; changing a mutable ctx cannot select Bob's consent.
    out = asyncio.run(host_person_action(p, monkeypatch, hook, principal=f"user:{ANN}"))
    assert out["detail"] == {"status": "consent_required"}
    assert p.hive.db.one("SELECT COUNT(*) AS n FROM app_person_minds")["n"] == before
    assert set(out["detail"]) == {"status"}


def test_real_person_action_provisions_only_its_recorded_person(p, monkeypatch):
    assert consent(p).status_code == 200
    def hook(ctx, action, items, params):
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    out = asyncio.run(host_person_action(p, monkeypatch, hook))
    assert out["detail"]["status"] == "ready"
    rows = p.hive.db.all("SELECT principal, agent_id FROM app_person_minds")
    assert rows and all(r["principal"] == BOB_P for r in rows)
    assert {r["agent_id"] for r in rows} == set(out["detail"]["minds"].values())


@pytest.mark.parametrize("field", ["principal", "program", "swarm_id", "action", "idempotency_key", "params_digest", "status", "actor", "items"])
def test_changed_host_action_record_is_refused_before_provisioning(p, monkeypatch, field):
    before = p.hive.db.one("SELECT COUNT(*) AS n FROM app_person_minds")["n"]
    def hook(ctx, action, items, params):
        row_id = ctx.command["record_id"]
        changed = {"actor": json.dumps({"kind": "mind", "principal": BOB_P}), "items": '["different"]',
                   "status": "done"}.get(field, "different")
        p.hive.db.update("program_actions", row_id, {field: changed})
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    with pytest.raises(HiveError) as exc:
        asyncio.run(host_person_action(p, monkeypatch, hook))
    assert (exc.value.status, exc.value.code) == (403, "person_required")
    assert p.hive.db.one("SELECT COUNT(*) AS n FROM app_person_minds")["n"] == before


@pytest.mark.parametrize("raises", [False, True])
def test_background_copy_of_act_context_loses_authority_on_success_or_error(p, monkeypatch, raises):
    async def scenario():
        go, children = asyncio.Event(), []
        async def hook(ctx, action, items, params):
            async def later():
                await go.wait()
                try:
                    ctx.actor = {"kind": "person", "principal": BOB_P}
                    return ctx.ensure_person_swarm("helpers")
                except HiveError as exc:
                    return {"code": exc.code, "status": exc.status}
            children.append(asyncio.create_task(later()))  # inherits ContextVar; shared active flag must expire
            if raises:
                raise RuntimeError("synthetic act failure")
            return {"status": "done"}
        try:
            await host_person_action(p, monkeypatch, hook)
            assert not raises
        except HiveError as exc:
            assert raises and exc.code == "program_error"
        finally:
            go.set()
        return await asyncio.wait_for(children[0], timeout=2)
    assert asyncio.run(scenario()) == {"code": "person_required", "status": 403}


def test_legacy_person_dispatch_stays_available_but_cannot_provision(p, monkeypatch):
    from hive.core.program_actions import ProgramActions
    entry = p.hive.programs.get(APP)
    entry["describe"] = {"actions": [{"id": "plain"}]}
    calls = []
    def hook(ctx, action, items, params):
        calls.append(action)
        with pytest.raises(HiveError) as exc:
            ctx.ensure_person_swarm("helpers")
        assert exc.value.code == "person_required"
        return {"status": "done"}
    entry["module"] = SimpleNamespace(act=hook)
    session = p.hive.db.one("SELECT * FROM sessions WHERE principal = ? AND kind = 'sso'", (BOB_P,))
    actor = ProgramActions.person_actor(session, "member", p.shared["id"])
    result = asyncio.run(p.hive.program_actions.person_act(actor, APP, p.shared["id"],
                                                         {"action": "plain", "items": [], "params": {}}))
    assert result["status"] == "done" and calls == ["plain"]


def test_mind_act_cannot_forge_a_person_context(p):
    from hive.core.program_actions import ProgramActions
    entry = p.hive.programs.get(APP)
    entry["describe"] = {"actions": [{"id": "setup"}]}
    def hook(ctx, action, items, params):
        ctx.actor = {"kind": "person", "principal": BOB_P}
        ctx.command = {"record_id": "forged"}
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    entry["module"] = SimpleNamespace(act=hook)
    with pytest.raises(HiveError) as exc:
        asyncio.run(p.hive.programs.act(APP, p.shared["id"], "setup", [],
                                      actor=ProgramActions.mind_actor(p.ann_mind)))
    assert (exc.value.status, exc.value.code) == (403, "person_required")


def test_ceiling_database_fault_denies_and_logs_only_exception_type(p, monkeypatch, caplog):
    agent = mint(p)
    p.hive.policy.add_rule(f"agent:{agent['id']}", "web-fetch", "allow", publish=False)
    original = p.hive.db.all
    private_message = "synthetic private database detail must never enter a warning"
    def fault(sql, *args, **kwargs):
        if "FROM app_person_minds WHERE agent_id" in sql:
            raise sqlite3.OperationalError(private_message)
        return original(sql, *args, **kwargs)
    monkeypatch.setattr(p.hive.db, "all", fault)
    caplog.set_level("WARNING", logger="hive")
    assert p.hive.policy.decide(agent, "web-fetch")[0] == "deny"
    warnings = [r for r in caplog.records if "app template ceiling read failed" in r.getMessage()]
    assert warnings and all("OperationalError" in r.getMessage() and private_message not in r.getMessage()
                            and r.exc_info is None for r in warnings)



def test_another_context_cannot_borrow_a_live_host_call(p, monkeypatch):
    from hive.core.programs import ProgramContext
    def hook(ctx, action, items, params):
        other = ProgramContext(p.hive, p.shared["id"], p.hive.programs.get(APP))
        other.actor, other.command = dict(ctx.actor), dict(ctx.command)
        with pytest.raises(HiveError) as exc:
            other.ensure_person_swarm("helpers")
        assert exc.value.code == "person_required"
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    assert asyncio.run(host_person_action(p, monkeypatch, hook))["detail"] == {"status": "consent_required"}


def test_raw_stale_awake_row_cannot_authorize_an_actual_program_action(p, monkeypatch):
    agent, effects, body = program_action(p, monkeypatch, None)
    assert asyncio.run(p.hive.program_actions.agent_act(agent, APP, body))["status"] == "ok"
    assert effects == ["synthetic-effect"]  # positive control exercises real host authorization
    awake(p, agent["id"])
    stale = stored(p, agent["id"])
    assert stale["status"] == "awake"
    revoke(p)
    before = p.hive.db.one("SELECT COUNT(*) AS n FROM approvals")["n"]
    with pytest.raises(HiveError) as exc:
        asyncio.run(p.hive.program_actions.agent_act(stale, APP, {**body, "idempotency_key": "after-revocation"}))
    assert exc.value.code == "app_swarm_revoked"
    assert effects == ["synthetic-effect"]
    assert p.hive.db.one("SELECT COUNT(*) AS n FROM approvals")["n"] == before
