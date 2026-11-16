"""P2.1 numeric totals: existing helpers keep authority; setup needs the current card.

Synthetic people, keys, usage and an in-memory driver only. No provider or process is launched.
The admitted focused job must retain the P2 boundary and P3a key-lock regressions too.
"""
import asyncio

import pytest

from hive.core.hive import HiveError
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_key_owner_oi13 import K_BOB, MODEL, add_key, w  # noqa: F401
from hive.tests.test_person_swarms_p2 import (
    APP, BOB_P, card, consent, counts, ensure, host_person_action, opts, p,  # noqa: F401
)
from hive.tests.test_person_swarm_boundaries_p2 import (
    NEW_KEY, actual_supervisor, awake, program_action, revoke, stored,
)


def setup(p):
    assert consent(p).status_code == 200
    result = ensure(p)
    assert result["status"] == "ready"
    return result


def set_total(p, total):
    response = p.client.put("/api/me/key-limits/self", headers=p.bob, json={"month_usd": total})
    assert response.status_code == 200, response.text


def reserve_person_call(p, agent_id, request_id, maximum):
    from hive.core.cost_reservations import Reservations, host_budget_snapshot, host_subjects

    reservations = Reservations(p.hive.db)
    budgets = lambda: host_budget_snapshot(p.hive, agent_id, key_id=K_BOB, payer=BOB_P, own_key=True)
    subjects = host_subjects(p.hive, agent_id, key_id=K_BOB, payer=BOB_P, own_key=True)
    row = reservations.reserve(request_id, {"test": request_id}, maximum, budgets,
                               metadata={"agent": agent_id, "payer": BOB_P, "key": K_BOB, "kind": "p2.1.1"},
                               subjects=subjects)
    return reservations, row


def assert_awake(p, agent_id):
    row = stored(p, agent_id)
    assert (row["status"], row["desired"], row["deleted"]) == ("awake", "awake", 0)
    assert opts(p.hive, agent_id) == {"key": K_BOB, "key_locked": True}
    assert p.hive.person_swarms.current(agent_id)[1] is None


@pytest.mark.parametrize("total", [10, 25, 5, 0], ids=["same", "raise", "lower", "zero"])
def test_numeric_total_does_not_quiesce_ongoing_helpers_on_reads_or_reconciliation(p, monkeypatch, total):
    original = setup(p)
    ids = set(original["minds"].values())
    supervisor, driver = actual_supervisor(p, monkeypatch)
    stops = []
    original_stop = driver.stop

    def stop(agent_id):
        stops.append(agent_id)
        original_stop(agent_id)

    monkeypatch.setattr(driver, "stop", stop)
    for agent_id in ids:
        awake(p, agent_id)
        driver.running.add(agent_id)
    before = counts(p.hive)
    set_total(p, total)
    for agent_id in ids:
        assert p.hive.agent(agent_id)["status"] == "awake"
        assert p.hive._agent_row(agent_id)["status"] == "awake"
        assert next(a for a in p.hive.agents() if a["id"] == agent_id)["status"] == "awake"
        p.hive.messages(agent_id)
        p.hive.person_swarms.require_current(agent_id)
        assert p.hive.person_swarms.ceiling(agent_id, "code-edit") == "deny"
    p.hive.swarm(original["swarm_id"])
    supervisor.check()
    assert driver.running == ids and stops == []
    assert counts(p.hive) == before
    for agent_id in ids:
        assert_awake(p, agent_id)
    if total == 10:
        assert ensure(p) == original  # the same numeric value does not need consent again


@pytest.mark.parametrize("total", [25, 5], ids=["raise", "lower"])
@pytest.mark.parametrize("phase", ["ensure", "repair"])
def test_next_setup_requires_current_total_without_stopping_the_existing_helper(p, total, phase):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    if phase == "repair":
        p.hive.db.execute("UPDATE app_person_minds SET finished = 0 WHERE agent_id = ?",
                          (original["minds"]["watcher"],))
    old_card = card(p)
    set_total(p, total)
    before, calls = counts(p.hive), list(p.hive.supervisor.calls)
    result = ensure(p)
    assert result["status"] == "consent_required"
    assert result["card"] == card(p) and result["card"]["month_usd"] == total
    assert result["card"]["key_id"] == K_BOB
    assert counts(p.hive) == before and p.hive.supervisor.calls == calls
    assert_awake(p, active)
    old = consent(p, old_card)
    assert old.status_code == 409 and old.json()["error"]["code"] == "card_changed"
    assert consent(p, result["card"]).status_code == 200
    repaired = ensure(p)
    assert repaired["status"] == "ready" and repaired["minds"]["errands"] == active
    assert_awake(p, active)
    assert ("stop", active) not in p.hive.supervisor.calls[len(calls):]
    if phase == "repair":
        assert repaired["minds"]["watcher"] != original["minds"]["watcher"]
    else:
        assert repaired == original


@pytest.mark.parametrize("total", [25, 5], ids=["raise", "lower"])
def test_total_change_before_first_setup_returns_current_card_and_mints_nothing(p, total):
    assert consent(p).status_code == 200
    before = counts(p.hive)
    set_total(p, total)
    result = ensure(p)
    assert result["status"] == "consent_required" and result["card"]["month_usd"] == total
    assert counts(p.hive) == before


@pytest.mark.parametrize("total", [25, 5], ids=["raise", "lower"])
@pytest.mark.parametrize("point", ["before_slot", "after_last_slot"])
def test_total_change_inside_ensure_returns_current_card_without_sleep(p, monkeypatch, total, point):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    if point == "before_slot":
        # A pending repair must not delete/recreate its slot after the shown total becomes stale.
        p.hive.db.execute("UPDATE app_person_minds SET finished = 0 WHERE agent_id = ?",
                          (original["minds"]["watcher"],))
    before, calls = counts(p.hive), list(p.hive.supervisor.calls)
    original_slot = p.hive.person_swarms._slot
    entered = []

    def slot(*args):
        entered.append(args[3]["slot"])
        if point == "before_slot" and len(entered) == 1:
            set_total(p, total)
        result = original_slot(*args)
        if point == "after_last_slot" and len(entered) == len(original["minds"]):
            set_total(p, total)
        return result

    monkeypatch.setattr(p.hive.person_swarms, "_slot", slot)
    result = ensure(p)
    assert result["status"] == "consent_required" and result["card"]["month_usd"] == total
    assert counts(p.hive) == before and p.hive.supervisor.calls == calls
    assert entered == (["errands"] if point == "before_slot" else ["errands", "watcher"])
    assert_awake(p, active)


@pytest.mark.parametrize("total,spent,allowed_before,allowed_after", [
    (10, 9.5, True, True), (25, 12, False, True), (5, 6, True, False), (0, 0, True, False),
], ids=["same", "raise-above-old-cap", "lower-below-spent", "zero-cap"])
def test_paid_call_admission_uses_current_total_and_retains_the_assigned_own_key(
        p, total, spent, allowed_before, allowed_after):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    # Other usage on the same owner's key counts against this helper's current own-key total.
    p.hive.record_usage(p.bob_mind, MODEL, {"prompt_tokens": 1, "completion_tokens": 1,
                                         "cost_usd": spent, "key_id": K_BOB}, payer=BOB_P)
    gateway = p.client.app.state.gateway

    def admit(allowed, limit):
        row = stored(p, active)
        key_id, _secret = gateway.paying_key(row, "openrouter")
        assert key_id == K_BOB
        payer, own_key = p.hive.payer_for(row, key_owner=BOB_P)
        assert (payer, own_key) == (BOB_P, True)
        if allowed:
            p.hive.check_budget(row, paid=True, estimate=0.1, key_id=key_id, payer=payer, own_key=own_key)
        else:
            with pytest.raises(HiveError) as exc:
                p.hive.check_budget(row, paid=True, estimate=0.1, key_id=key_id, payer=payer, own_key=own_key)
            assert exc.value.code == "spend_limit"
            assert exc.value.details["limit_usd"] == limit and exc.value.details["spent_usd"] == spent

    calls = list(p.hive.supervisor.calls)
    admit(allowed_before, 10)
    set_total(p, total)
    admit(allowed_after, total)
    assert p.hive.supervisor.calls == calls
    assert_awake(p, active)


def test_lowered_total_refuses_a_new_call_while_an_owner_key_hold_is_open(p):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    hold_id = "p2-1-1-lowered-total-open-hold"
    reservations, hold = reserve_person_call(p, active, hold_id, 0.10)
    assert hold["state"] == "reserved"
    set_total(p, 0.1005)

    from hive.core.cost_reservations import BudgetExhausted, Reservations, host_budget_snapshot, host_subjects
    rows = host_budget_snapshot(p.hive, active, key_id=K_BOB, payer=BOB_P, own_key=True)
    own_limit = next(scope for scope, _limit, _spent in rows if scope.startswith("keyuse:") and scope.endswith(":month"))
    with pytest.raises(BudgetExhausted) as exc:
        reserve_person_call(p, active, "p2-1-1-lowered-total-next-call", 0.001)
    assert exc.value.scope == own_limit and exc.value.limit_usd == 0.1005
    assert exc.value.estimate_usd == 0.001 < exc.value.limit_usd
    assert exc.value.held_usd >= 0.10 and exc.value.held_usd + exc.value.estimate_usd > exc.value.limit_usd
    assert reservations.get(hold_id)["state"] == "reserved"
    reservations.abort_before_dispatch(hold_id)
    released_retry = reserve_person_call(p, active, "p2-1-1-lowered-total-next-call", 0.001)[1]
    assert released_retry["state"] == "reserved"
    assert_awake(p, active)


def test_total_changed_after_preflight_is_rechecked_at_real_reservation(p):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    row = stored(p, active)
    p.hive.check_budget(row, paid=True, estimate=0.001, key_id=K_BOB, payer=BOB_P, own_key=True)
    set_total(p, 0)

    from hive.core.cost_reservations import BudgetExhausted, Reservations, host_budget_snapshot, host_subjects
    rows = host_budget_snapshot(p.hive, active, key_id=K_BOB, payer=BOB_P, own_key=True)
    own_limit = next(scope for scope, _limit, _spent in rows if scope.startswith("keyuse:") and scope.endswith(":month"))
    reservations = Reservations(p.hive.db)
    budgets = lambda: host_budget_snapshot(p.hive, active, key_id=K_BOB, payer=BOB_P, own_key=True)
    subjects = host_subjects(p.hive, active, key_id=K_BOB, payer=BOB_P, own_key=True)
    with pytest.raises(BudgetExhausted) as exc:
        reservations.reserve("p2-1-1-changed-after-preflight", {"test": "preflight-race"}, 0.001,
                             budgets, metadata={"agent": active, "payer": BOB_P, "key": K_BOB}, subjects=subjects)
    assert exc.value.scope == own_limit and exc.value.limit_usd == 0
    assert exc.value.held_usd == 0 and exc.value.estimate_usd == 0.001
    assert reservations.get("p2-1-1-changed-after-preflight") is None
    assert_awake(p, active)


def test_first_setup_total_change_after_first_helper_waits_for_fresh_consent(p, monkeypatch):
    assert consent(p).status_code == 200
    before = counts(p.hive)
    original_slot = p.hive.person_swarms._slot
    entered = []

    def slot(*args):
        entered.append(args[3]["slot"])
        result = original_slot(*args)
        if len(entered) == 1:
            set_total(p, 5)
        return result

    monkeypatch.setattr(p.hive.person_swarms, "_slot", slot)
    result = ensure(p)
    assert result["status"] == "consent_required" and result["card"]["month_usd"] == 5
    assert entered == ["errands", "watcher"]
    assert p.hive.db.all("SELECT slot FROM app_person_minds WHERE principal = ? AND program_id = ? AND template_id = ? "
                         "ORDER BY slot", (BOB_P, APP, "helpers")) == [{"slot": "errands"}]
    after = counts(p.hive)
    assert after["agents"] == before["agents"] + 1
    assert after["swarms"] == before["swarms"] + 1
    assert after["app_person_minds"] == before["app_person_minds"] + 1
    assert after["app_person_swarms"] == before["app_person_swarms"] + 1
    assert consent(p).status_code == 200
    resumed = ensure(p)
    assert resumed["status"] == "ready" and set(resumed["minds"]) == {"errands", "watcher"}


def test_total_change_after_final_live_consent_returns_content_free_ready_hint(p, monkeypatch):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    original_slot = p.hive.person_swarms._slot
    original_live = p.hive.person_swarms._live_consent
    slots, changed = [], []

    def slot(*args):
        result = original_slot(*args)
        slots.append(args[3]["slot"])
        return result

    def live(*args):
        result = original_live(*args)
        if result is not None and len(slots) == len(original["minds"]) and not changed:
            set_total(p, 5)  # after the real final live-consent check, before the advisory total read
            changed.append(True)
        return result

    monkeypatch.setattr(p.hive.person_swarms, "_slot", slot)
    monkeypatch.setattr(p.hive.person_swarms, "_live_consent", live)
    result = ensure(p)
    assert result["status"] == "ready" and result["total_changed_during_setup"] is True
    assert "card" not in result and "month_usd" not in result and "key_id" not in result
    assert slots == ["errands", "watcher"] and changed == [True]
    assert_awake(p, active)
    before_slots = list(slots)
    stale = ensure(p)
    assert stale["status"] == "consent_required" and stale["card"]["month_usd"] == 5
    assert slots == before_slots  # the advisory hint did not authorize a later setup


def test_missing_total_restored_after_advisory_read_still_denies_setup(p, monkeypatch):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    swarms = p.hive.person_swarms
    original_month_total = swarms._month_total
    original_live_consent = swarms._live_consent
    original_slot = swarms._slot
    slots = []
    final_check = []
    transition = []
    restoring = False

    def slot(*args):
        result = original_slot(*args)
        slots.append(args[3]["slot"])
        return result

    def live(*args):
        result = original_live_consent(*args)
        if result is not None and len(slots) == len(original["minds"]) and not final_check:
            final_check.append(True)
        return result

    def month_total(principal):
        nonlocal restoring
        if final_check and not transition and not restoring:
            p.hive.db.execute("DELETE FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*'",
                              (principal,))
            observed = original_month_total(principal)
            assert observed is None
            restoring = True
            try:
                set_total(p, 5)  # restore through the real key-limit API before runtime consent is re-read
                transition.append(True)
            finally:
                restoring = False
            return observed
        return original_month_total(principal)

    monkeypatch.setattr(swarms, "_slot", slot)
    monkeypatch.setattr(swarms, "_live_consent", live)
    monkeypatch.setattr(swarms, "_month_total", month_total)
    result = ensure(p)
    assert result["status"] == "consent_required" and result["card"]["month_usd"] == 5
    assert "total_changed_during_setup" not in result
    assert final_check == [True] and transition == [True]
    assert_awake(p, active)


def test_card_spend_note_is_fixed_and_outside_consent_binding(p):
    shown = card(p)
    assert shown["spend_note"] == (
        "Your monthly total is checked before each request. A single request can cost a little more than expected, "
        "so the total can be passed by up to one request."
    )
    changed_copy = {**shown, "spend_note": "display copy is not part of consent"}
    bound = p.hive.person_swarms.consent(BOB_P, APP, "helpers", changed_copy)
    assert bound["spend_note"] == shown["spend_note"]
    assert (bound["template_digest"], bound["key_id"], bound["month_usd"]) == (
        shown["template_digest"], shown["key_id"], shown["month_usd"]
    )


@pytest.mark.parametrize("total", [25, 5], ids=["raise", "lower"])
def test_existing_helper_can_finish_an_authorised_program_action_after_total_change(p, monkeypatch, total):
    agent, effects, body = program_action(p, monkeypatch, None)
    awake(p, agent["id"])
    calls = list(p.hive.supervisor.calls)
    set_total(p, total)
    asyncio.run(p.hive.program_actions.agent_act(agent, APP, body))
    assert effects == ["synthetic-effect"] and p.hive.supervisor.calls == calls
    assert_awake(p, agent["id"])


@pytest.mark.parametrize("total", [25, 5], ids=["raise", "lower"])
def test_next_recorded_person_setup_gets_only_consent_required_while_helper_keeps_working(p, monkeypatch, total):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    set_total(p, total)
    before = counts(p.hive)

    async def hook(ctx, _action, _items, _payload):
        assert ctx.ensure_person_swarm("helpers") == {"status": "consent_required"}
        return {"status": "done"}

    asyncio.run(host_person_action(p, monkeypatch, hook))
    assert counts(p.hive) == before
    assert_awake(p, active)
    assert card(p)["month_usd"] == total  # the private host card, rather than the app result, shows the total


@pytest.mark.parametrize("change", ["template", "key", "withdraw", "uninstall", "missing_total", "revoked_total", "expired_total"])
def test_numeric_change_does_not_remove_existing_authority_revocation(p, change):
    original = setup(p)
    active = original["minds"]["errands"]
    awake(p, active)
    set_total(p, 25)
    if change == "template":
        revoke(p)
    elif change == "key":
        p.hive.keyring.ring["keys"].pop(K_BOB)
        add_key(p.hive, NEW_KEY, BOB_P)
    elif change == "withdraw":
        p.hive.person_swarms.withdraw(BOB_P, APP, "helpers")
    elif change == "uninstall":
        response = p.client.delete(f"/api/programs/{APP}", headers=p.ann)
        assert response.status_code == 200, response.text
    elif change == "missing_total":
        p.hive.db.execute("DELETE FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*'", (BOB_P,))
    elif change == "expired_total":
        p.hive.db.execute("UPDATE key_limits SET ends_at = ? WHERE owner = ? AND grantee = 'self' AND key_id = '*' "
                          "AND revoked_at IS NULL", ("1970-01-01T00:00:00+00:00", BOB_P))
    else:
        limit = p.hive.db.one("SELECT id FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*' "
                              "AND revoked_at IS NULL", (BOB_P,))
        response = p.client.delete(f"/api/me/key-limits/{limit['id']}", headers=p.bob)
        assert response.status_code == 200, response.text
    assert p.hive.agent(active)["status"] == "asleep"
    with pytest.raises(HiveError) as exc:
        p.hive.lifecycle(active, "wake")
    assert exc.value.code == "app_swarm_revoked"
    assert stored(p, active)["deleted"] == 0
