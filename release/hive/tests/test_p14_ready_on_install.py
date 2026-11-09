"""App platform P14: apps work as soon as they're installed.

Install is a durable admin review bound to the pinned release, placement, deps and audience; a person app opens straight
into each person's own context (one per person and app, validated before every reuse, failing closed into "Set up
again"); a template app's first open is P2's own card, then P2's own ensure; opening never spends; paid work runs on the
person's own key only; creation is bounded hive-wide; failures are fixed reason codes. Synthetic only: invented apps,
people and keys, no provider call."""
import json
import os
import threading

import pytest

from hive.core.person_apps import REASONS, PersonApps
from hive.core.programs import Programs
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_key_owner_oi13 import ANN, BOB, CY, K_BOB, MODEL, code, w  # noqa: F401
from hive.tests.test_visibility import person

APP_PY = """def describe():
    return {'contract': '0.2', 'kinds': [{'id': 'k', 'role': 'claim'}], 'relations': [], 'actions': []}

def view(ctx, focus=None, stage=None):
    return {'revision': 'r1', 'items': []}

def act(ctx, action, items, params):
    return {'status': 'done'}
"""
TEMPLATE = {"minds": [{"slot": "errands", "name": "Errands", "model": MODEL, "budget_usd": 1},
                      {"slot": "watcher", "name": "Watcher", "model": MODEL}],
            "rules": [{"skill": "code-*", "mode": "deny"}]}
SOLO, HELPERS, SHARED = "solo-app", "helper-app", "shared-app"
ANN_P, BOB_P, CY_P = f"user:{ANN}", f"user:{BOB}", f"user:{CY}"
MANIFESTS = {
    SOLO: {"name": "Solo", "version": "1.0.0", "capabilities": [], "placement": "person"},
    HELPERS: {"name": "Helpers", "version": "1.0.0", "capabilities": ["person_swarm"], "placement": "person",
              "swarm_templates": {"helpers": TEMPLATE}},
    SHARED: {"name": "Shared", "version": "1.0.0", "capabilities": []},
}


def write(root, app_id, manifest):
    folder = root / app_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plugin.json").write_text(json.dumps({"id": app_id, **manifest}))
    (folder / "program.py").write_text(APP_PY)
    return folder


def mount(x, monkeypatch, manifests):
    for app_id, manifest in manifests.items():
        write(x.root, app_id, manifest)
    pins = {app_id: {"release": str(x.root / app_id), "digest": Programs.source_digest(x.root / app_id)}
            for app_id in manifests}
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(x.root))
    monkeypatch.setenv("HIVE_APP_PINS", json.dumps(pins))
    x.hive.programs.reload()
    for app_id in manifests:
        assert x.hive.programs.get(app_id)["error"] is None, x.hive.programs.get(app_id)["error"]


@pytest.fixture()
def x(w, tmp_path, monkeypatch):
    monkeypatch.setattr(w.hive.supervisor, "verify_stopped", lambda agent_id: None, raising=False)
    w.root = tmp_path / "apps"
    w.root.mkdir()
    mount(w, monkeypatch, MANIFESTS)
    w.monkeypatch = monkeypatch
    w.cy = person(w.client, CY)
    for app_id in (SOLO, HELPERS):
        assert install(w, app_id).status_code == 200
    return w


def status(x, app_id, headers=None):
    return x.client.get(f"/api/programs/{app_id}/install", headers=headers or x.ann).json()


def install(x, app_id, headers=None, **extra):
    s = status(x, app_id)
    body = {"release_digest": s["release_digest"], "placement": s["placement"], **extra}
    return x.client.post(f"/api/programs/{app_id}/install", headers=headers or x.ann, json=body)


def open_app(x, app_id, headers):
    return x.client.post(f"/api/programs/{app_id}/person-context", headers=headers, json={})


def opened(x, app_id, headers):
    r = open_app(x, app_id, headers)
    assert r.status_code == 200, r.text
    return r.json()


def failure(r, reason):
    assert r.status_code == REASONS[reason][0], r.text
    err = r.json()["error"]
    assert err == {"code": "app_unavailable", "message": REASONS[reason][1], "reason": reason, "action": REASONS[reason][2]}


def counts(hive):
    return {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"]
            for t in ("swarms", "agents", "app_person_contexts", "app_person_activations", "app_person_swarms",
                      "app_install_reviews", "usage")}


def month(x, headers, usd=10):
    assert x.client.put("/api/me/key-limits/self", headers=headers, json={"month_usd": usd}).status_code == 200


def p2_card(x, headers=None):
    r = x.client.get(f"/api/me/app-swarms/{HELPERS}/helpers", headers=headers or x.bob)
    assert r.status_code == 200, r.text
    return r.json()


SHOWN = ("template_digest", "key_id", "month_usd", "consent_revision", "authority_revision")


def p2_consent(x, card, headers=None):
    return x.client.post(f"/api/me/app-swarms/{HELPERS}/helpers/consent", headers=headers or x.bob,
                         json={k: card[k] for k in SHOWN})


def visible_swarms(x, headers):
    return {s["id"] for s in x.client.get("/api/swarms", headers=headers).json()}


# ---- manifest -------------------------------------------------------------------------------------------------------

def test_placement_defaults_to_swarm_and_is_listed(x):
    listed = {p["id"]: p for p in x.client.get("/api/programs", headers=x.bob).json()}
    assert (listed[SOLO]["placement"], listed[SHARED]["placement"]) == ("person", "swarm")


@pytest.mark.parametrize("manifest", [
    {"placement": "everyone"},
    {"person_allow": "all"},                                     # person_allow without placement person
    {"placement": "person", "person_allow": ["bob"]},
    {"placement": "person", "person_allow": []},
])
def test_a_bad_placement_or_audience_does_not_load(x, monkeypatch, manifest):
    write(x.root, "odd-app", {"name": "Odd", "capabilities": [], **manifest})
    x.hive.programs.reload()
    assert x.hive.programs.get("odd-app")["error"].startswith("ValueError")


# ---- install is the review -------------------------------------------------------------------------------------------

def test_install_is_a_named_admin_act_and_the_local_operator_is_refused(x):
    assert (status(x, SOLO)["review"]["by"], status(x, SOLO)["installed"]) == (ANN_P, True)
    r = x.client.post(f"/api/programs/{SOLO}/install", json={"release_digest": status(x, SOLO)["release_digest"],
                                                             "placement": "person"})   # the password session
    assert (r.status_code, code(r)) == (403, "person_required")
    r = install(x, SOLO, headers=x.bob)
    assert r.status_code == 403
    assert "review" not in status(x, SOLO, headers=x.bob)


def test_a_person_app_with_more_than_one_template_is_refused_at_install(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, "two-app": {"name": "Two", "capabilities": ["person_swarm"], "placement": "person",
                                                    "swarm_templates": {"a": TEMPLATE, "b": TEMPLATE}}})
    r = install(x, "two-app")
    assert (r.status_code, code(r)) == (409, "placement_templates")
    assert x.hive.db.one("SELECT 1 FROM app_install_reviews WHERE program = 'two-app'") is None


def test_install_refuses_a_stale_release_or_a_wider_audience(x, monkeypatch):
    r = x.client.post(f"/api/programs/{SOLO}/install", headers=x.ann,
                      json={"release_digest": "sha256:" + "0" * 64, "placement": "person"})
    assert (r.status_code, code(r)) == (409, "card_changed")
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    r = install(x, SOLO, person_allow=[BOB_P, CY_P])
    assert (r.status_code, code(r)) == (409, "audience_wider")


def test_reload_startup_and_member_opens_never_create_a_review(x, monkeypatch):
    x.hive.db.execute("DELETE FROM app_install_reviews WHERE program = ?", (SOLO,))
    x.hive.programs.reload()
    PersonApps(x.hive)                                           # what a restart constructs
    failure(open_app(x, SOLO, x.bob), "not_reviewed")
    assert x.hive.db.one("SELECT 1 FROM app_install_reviews WHERE program = ?", (SOLO,)) is None


def test_the_review_is_consumed_only_for_its_release_and_an_update_needs_a_new_review(x, monkeypatch):
    first = opened(x, SOLO, x.bob)["swarm_id"]
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "version": "1.0.1"}})   # an update: a new digest
    failure(open_app(x, SOLO, x.bob), "release_changed")
    assert not x.hive.app_attachments.active(SOLO, first)        # the scoped activation follows the review
    assert install(x, SOLO).status_code == 200
    assert opened(x, SOLO, x.bob)["swarm_id"] == first           # same context, not a new one


def test_a_changed_scope_is_not_the_reviewed_one(x):
    row = x.hive.db.one("SELECT deps FROM app_install_reviews WHERE program = ?", (HELPERS,))
    deps = json.loads(row["deps"])
    deps["capabilities"] = []
    x.hive.db.execute("UPDATE app_install_reviews SET deps = ? WHERE program = ?", (json.dumps(deps), HELPERS))
    failure(open_app(x, HELPERS, x.bob), "release_changed")
    x.hive.db.execute("UPDATE app_install_reviews SET placement = 'swarm' WHERE program = ?", (SOLO,))
    failure(open_app(x, SOLO, x.bob), "release_changed")


# ---- a fresh member opens a person app ------------------------------------------------------------------------------------

def test_a_fresh_member_lands_straight_in_their_own_context(x):
    before = counts(x.hive)
    out = opened(x, SOLO, x.bob)
    assert out["state"] == "ready" and out["private"] == "Private to you; hive admins can audit."
    swarm = x.hive.db.one("SELECT * FROM swarms WHERE id = ?", (out["swarm_id"],))
    assert (swarm["owner"], swarm["visibility"], json.loads(swarm["shared_with"])) == (BOB_P, "private", [])
    assert counts(x.hive)["swarms"] == before["swarms"] + 1 and counts(x.hive)["agents"] == before["agents"]
    assert opened(x, SOLO, x.bob)["swarm_id"] == out["swarm_id"]  # reopen reuses
    assert out["swarm_id"] in visible_swarms(x, x.bob)


def test_two_concurrent_first_opens_give_one_context(x):
    outs, barrier = [], threading.Barrier(4)

    def go():
        barrier.wait()
        outs.append(x.hive.person_apps.open(BOB_P, SOLO)["swarm_id"])
    threads = [threading.Thread(target=go) for _ in range(4)]
    [t.start() for t in threads]
    [t.join(10) for t in threads]
    assert len(outs) == 4 and len(set(outs)) == 1
    assert x.hive.db.one("SELECT COUNT(*) AS n FROM app_person_contexts WHERE principal = ?", (BOB_P,))["n"] == 1


def test_another_person_cannot_see_or_reach_it(x):
    bob_space = opened(x, SOLO, x.bob)["swarm_id"]
    cy_space = opened(x, SOLO, x.cy)["swarm_id"]
    assert bob_space != cy_space
    assert bob_space not in visible_swarms(x, x.cy)
    r = x.client.post(f"/api/programs/{SOLO}/view", headers=x.cy, json={"swarm_id": bob_space})
    assert r.status_code in (403, 404)
    r = x.client.post(f"/api/programs/{SOLO}/person-context", headers=x.cy, json={"swarm_id": bob_space, "principal": BOB_P})
    assert r.json()["swarm_id"] == cy_space                       # forged selectors are ignored: the session decides


def test_admins_can_audit_and_it_says_so(x):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    assert x.client.get(f"/api/swarms/{space}", headers=x.ann).status_code == 200


def test_a_member_outside_person_allow_gets_not_available_and_nothing_is_made(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    assert install(x, SOLO).status_code == 200
    before = counts(x.hive)
    failure(open_app(x, SOLO, x.cy), "not_available_to_you")
    assert counts(x.hive) == before
    assert opened(x, SOLO, x.bob)["state"] == "ready"


def test_the_admin_can_restrict_allowed_people_and_it_fences_at_once(x):
    space = opened(x, SOLO, x.cy)["swarm_id"]
    r = x.client.put(f"/api/programs/{SOLO}/install/person-allow", headers=x.ann, json={"person_allow": [BOB_P]})
    assert r.status_code == 200, r.text
    failure(open_app(x, SOLO, x.cy), "not_available_to_you")
    assert not x.hive.app_attachments.active(SOLO, space)
    assert opened(x, SOLO, x.bob)["state"] == "ready"
    r = x.client.put(f"/api/programs/{SOLO}/install/person-allow", headers=x.ann, json={"person_allow": [BOB_P, CY_P]})
    assert (r.status_code, code(r)) == (409, "audience_wider")    # widening needs a new install review


def test_disabling_or_revoking_gives_the_honest_failure_card(x):
    opened(x, SOLO, x.bob)
    assert x.client.post(f"/api/programs/{SOLO}/disable", headers=x.ann).status_code == 200
    failure(open_app(x, SOLO, x.bob), "app_turned_off")
    assert x.client.post(f"/api/programs/{SOLO}/enable", headers=x.ann).status_code == 200
    assert opened(x, SOLO, x.bob)["state"] == "ready"
    assert x.client.delete(f"/api/programs/{SOLO}/install", headers=x.ann).status_code == 200
    failure(open_app(x, SOLO, x.bob), "app_turned_off")


def test_the_failure_card_leaks_nothing(x):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (space,))
    r = open_app(x, SOLO, x.bob)
    failure(r, "space_needs_setup")
    text = r.text
    for secret in (space, K_BOB, BOB_P, str(x.root), "Traceback", "app_person"):
        assert secret not in text
    assert set(REASONS) == {"not_available_to_you", "app_turned_off", "not_reviewed", "release_changed",
                            "space_needs_setup", "space_failed", "busy"}


# ---- the binding fails closed -----------------------------------------------------------------------------------------

def test_archive_then_open_creates_no_new_context_and_set_up_again_is_the_one_way_out(x):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (space,))
    before = counts(x.hive)
    for _ in range(3):
        failure(open_app(x, SOLO, x.bob), "space_needs_setup")
    assert counts(x.hive) == before
    r = x.client.post(f"/api/programs/{SOLO}/person-context/reset", headers=x.bob, json={})
    assert r.status_code == 200 and r.json()["swarm_id"] != space
    assert x.hive.db.one("SELECT swarm_id FROM app_person_contexts_retired WHERE principal = ?", (BOB_P,))["swarm_id"] == space
    assert x.hive.db.one("SELECT 1 FROM swarms WHERE id = ?", (space,))       # never deleted


@pytest.mark.parametrize("change", [
    "UPDATE swarms SET visibility = 'public' WHERE id = ?",
    "UPDATE swarms SET shared_with = '[\"user:u_0c0c0c0c\"]' WHERE id = ?",
    "UPDATE swarms SET owner = 'user:u_0c0c0c0c' WHERE id = ?",
])
def test_an_invalid_binding_is_never_silently_replaced(x, change):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    x.hive.db.execute(change, (space,))
    failure(open_app(x, SOLO, x.bob), "space_needs_setup")
    assert x.hive.db.one("SELECT swarm_id FROM app_person_contexts WHERE principal = ?", (BOB_P,))["swarm_id"] == space


def test_a_usable_binding_is_never_reset(x):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    r = x.client.post(f"/api/programs/{SOLO}/person-context/reset", headers=x.bob, json={})
    assert r.json()["swarm_id"] == space


def test_set_up_again_is_bounded(x):
    for _ in range(3):
        space = opened(x, SOLO, x.bob)["swarm_id"]
        x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (space,))
        x.client.post(f"/api/programs/{SOLO}/person-context/reset", headers=x.bob, json={})
    space = x.hive.person_apps.binding(BOB_P, SOLO)["swarm_id"]
    x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (space,))
    failure(x.client.post(f"/api/programs/{SOLO}/person-context/reset", headers=x.bob, json={}), "busy")


# ---- a narrow activation ----------------------------------------------------------------------------------------------------

def test_activating_for_one_person_makes_the_app_attachment_required_nowhere_else(x):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    attachments, entry = x.hive.app_attachments, x.hive.programs.get(SOLO)
    assert attachments.active(SOLO, space)
    assert not attachments.required(entry)
    assert not attachments.active(SOLO, x.bob_swarm["id"]) and not attachments.active(SHARED, space)
    assert x.hive.db.one("SELECT COUNT(*) AS n FROM app_activations")["n"] == 0
    x.hive.db.execute("INSERT INTO app_activations VALUES (?, ?, 0, ?)", (SOLO, space, ANN_P))
    assert not attachments.active(SOLO, space)                    # an explicit admin decision still wins


# ---- swarm apps keep today's flow, plus "Use in" ------------------------------------------------------------------------------

def test_a_swarm_app_is_unchanged_and_install_offers_use_in(x):
    failure(open_app(x, SHARED, x.bob), "not_available_to_you")   # never a person context
    assert x.client.get(f"/api/programs/{SHARED}/homes", headers=x.bob).json()["homes"] == []
    r = install(x, SHARED, use_in=[x.bob_swarm["id"]])
    assert r.status_code == 200, r.text
    assert x.hive.app_attachments.active(SHARED, x.bob_swarm["id"])
    homes = x.client.get(f"/api/programs/{SHARED}/homes", headers=x.bob).json()["homes"]
    assert [h["swarm_id"] for h in homes] == [x.bob_swarm["id"]]
    r = install(x, SOLO, use_in=[x.bob_swarm["id"]])
    assert r.status_code == 400                                   # person apps never take chosen swarms


# ---- dependencies: the key card, P2's card, P2's ensure ------------------------------------------------------------------------

def test_no_ai_key_keeps_the_app_open_with_the_key_card_and_spends_nothing(x):
    before = counts(x.hive)
    out = opened(x, HELPERS, x.cy)
    assert (out["state"], out["helpers"], out["needs"]) == ("ready", "key_required", ["ai_key", "monthly_total"])
    after = counts(x.hive)                                          # one empty private context, bound; no helper
    assert (after["swarms"], after["app_person_contexts"], after["agents"]) == \
        (before["swarms"] + 1, before["app_person_contexts"] + 1, before["agents"])
    assert x.hive.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ?", (CY_P,))["swarm_id"] == out["swarm_id"]
    solo = opened(x, SOLO, x.cy)                                    # an app without a template still opens
    assert solo["state"] == "ready" and solo["needs"] == ["ai_key", "monthly_total"]
    assert counts(x.hive)["usage"] == before["usage"]


def test_the_first_open_card_is_p2s_card_unchanged_and_declining_creates_nothing(x):
    month(x, x.bob)
    before = counts(x.hive)
    out = opened(x, HELPERS, x.bob)
    assert (out["state"], out["helpers"]) == ("ready", "consent_required")
    assert out["card"] == p2_card(x)
    assert out["space_line"] == "Helpers will set up your space with Errands and Watcher, on your own AI key, within $10.00 a month."
    assert "space_line" not in out["card"]
    after = counts(x.hive)                                          # declining is simply not consenting: no helper
    assert (after["agents"], after["swarms"]) == (before["agents"], before["swarms"] + 1)
    assert opened(x, HELPERS, x.bob)["swarm_id"] == out["swarm_id"] and counts(x.hive) == after
    stale = dict(out["card"], month_usd=99)
    r = p2_consent(x, stale)
    assert (r.status_code, code(r)) == (409, "card_changed")


def test_one_tap_then_p2_ensure_deploys_the_configured_swarm(x):
    month(x, x.bob)
    assert p2_consent(x, opened(x, HELPERS, x.bob)["card"]).status_code == 200
    first = x.hive.person_apps.binding(BOB_P, HELPERS)["swarm_id"]
    out = opened(x, HELPERS, x.bob)
    assert (out["state"], out["helpers"], out["swarm_id"]) == ("ready", "ready", first)   # the same context, now filled
    home = x.hive.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ?", (BOB_P,))["swarm_id"]
    assert out["swarm_id"] == home
    minds = x.hive.db.all("SELECT status, owner FROM agents WHERE swarm_id = ? AND deleted = 0", (home,))
    assert len(minds) == 2 and {(m["status"], m["owner"]) for m in minds} == {("asleep", BOB_P)}
    assert opened(x, HELPERS, x.bob)["swarm_id"] == home


def test_concurrent_first_opens_make_one_context_and_one_p2_ensure(x, monkeypatch):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    calls, real = [], x.hive.person_swarms.ensure

    def counted(*args):
        calls.append(args)
        return real(*args)
    monkeypatch.setattr(x.hive.person_swarms, "ensure", counted)
    outs, barrier = [], threading.Barrier(3)

    def go():
        barrier.wait()
        outs.append(x.hive.person_apps.open(BOB_P, HELPERS)["swarm_id"])
    threads = [threading.Thread(target=go) for _ in range(3)]
    [t.start() for t in threads]
    [t.join(20) for t in threads]
    assert len(outs) == 3 and len(set(outs)) == 1 and len(calls) == 1


def test_withdrawal_brings_the_card_back_and_creates_nothing(x):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    opened(x, HELPERS, x.bob)
    before = counts(x.hive)
    assert x.client.post(f"/api/me/app-swarms/{HELPERS}/helpers/withdraw", headers=x.bob).status_code == 200
    assert opened(x, HELPERS, x.bob)["helpers"] == "consent_required"
    assert counts(x.hive) == before


def test_open_and_withdraw_from_two_sessions_never_deadlock(x):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    errors = []

    def opening():
        for _ in range(5):
            try:
                x.hive.person_apps.open(BOB_P, HELPERS)
            except Exception as exc:   # noqa: BLE001
                errors.append(exc)

    def withdrawing():
        for _ in range(5):
            x.hive.person_swarms.withdraw(BOB_P, HELPERS, "helpers")
    threads = [threading.Thread(target=opening), threading.Thread(target=withdrawing)]
    [t.start() for t in threads]
    [t.join(20) for t in threads]
    assert not any(t.is_alive() for t in threads)
    assert all(getattr(e, "code", None) == "app_unavailable" for e in errors)


def test_disable_fences_an_in_flight_open(x, monkeypatch):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    real = x.hive.person_swarms.ensure

    def disabled_meanwhile(*args):
        out = real(*args)
        x.hive.programs.set_enabled(HELPERS, False, ANN_P)        # lands after P2 ensure, before the binding
        return out
    monkeypatch.setattr(x.hive.person_swarms, "ensure", disabled_meanwhile)
    failure(open_app(x, HELPERS, x.bob), "app_turned_off")
    for m in helpers_of(x, BOB_P):
        assert m["desired"] == "asleep"
        refused(x, m["id"], "app_unavailable", "app_swarm_revoked")   # P14's fence, or P2's own for a disabled app


# ---- helpers never escape the fence ------------------------------------------------------------------------------------------

def helpers_of(x, principal):
    return x.hive.db.all("SELECT a.* FROM agents a JOIN app_person_minds b ON b.agent_id = a.id WHERE b.principal = ? "
                         "AND a.deleted = 0", (principal,))


def refused(x, agent_id, *codes):
    with pytest.raises(Exception) as e:
        x.hive.person_apps.authorize_agent(agent_id)
    assert getattr(e.value, "code", None) in (codes or ("app_unavailable",)), e.value


def deployed(x):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    assert opened(x, HELPERS, x.bob)["helpers"] == "ready"
    minds = helpers_of(x, BOB_P)
    assert len(minds) == 2
    for m in minds:
        x.hive.person_apps.authorize_agent(m["id"])                 # the control: a bound, reviewed helper dispatches
    return minds


@pytest.mark.parametrize("withdraw_access", ["revoke", "restrict"])
def test_revoke_or_restrict_between_ensure_and_the_final_check_leaves_no_live_helper(x, monkeypatch, withdraw_access):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    real = x.hive.person_swarms.ensure

    def meanwhile(*args):
        out = real(*args)
        if withdraw_access == "revoke":
            assert x.client.delete(f"/api/programs/{HELPERS}/install", headers=x.ann).status_code == 200
        else:
            assert x.client.put(f"/api/programs/{HELPERS}/install/person-allow", headers=x.ann,
                                json={"person_allow": [CY_P]}).status_code == 200
        return out
    monkeypatch.setattr(x.hive.person_swarms, "ensure", meanwhile)
    failure(open_app(x, HELPERS, x.bob), "app_turned_off" if withdraw_access == "revoke" else "not_available_to_you")
    minds = helpers_of(x, BOB_P)
    assert len(minds) == 2
    for m in minds:
        refused(x, m["id"])


def test_a_helper_whose_binding_was_lost_never_dispatches_and_a_reopen_rebinds_it(x, monkeypatch):
    minds = deployed(x)
    home = x.hive.person_apps.binding(BOB_P, HELPERS)["swarm_id"]
    # the crash window: P2's helpers and home stand, the P14 binding does not
    x.hive.db.execute("DELETE FROM app_person_contexts WHERE principal = ?", (BOB_P,))
    for m in minds:
        refused(x, m["id"])
    clock = [5000.0]
    x.hive.person_apps.clock = lambda: clock[0]
    x.hive.person_apps._created.extend([clock[0]] * 20)           # the creation limit is full
    out = opened(x, HELPERS, x.bob)                                 # adopting the existing home is not a create
    assert (out["swarm_id"], out["helpers"]) == (home, "ready")
    for m in minds:
        x.hive.person_apps.authorize_agent(m["id"])


def test_a_p2_helper_made_without_any_p14_open_cannot_dispatch(x):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    out = x.hive.person_swarms.ensure(BOB_P, HELPERS, "helpers")   # P2's own path, never through P14's open
    assert out["status"] == "ready"
    for agent_id in out["minds"].values():
        refused(x, agent_id)


def test_set_up_again_for_a_template_app_is_refused_with_nothing_made(x):
    deployed(x)
    home = x.hive.person_apps.binding(BOB_P, HELPERS)["swarm_id"]
    x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (home,))
    failure(open_app(x, HELPERS, x.bob), "space_needs_setup")
    before = counts(x.hive)
    failure(x.client.post(f"/api/programs/{HELPERS}/person-context/reset", headers=x.bob, json={}), "space_failed")
    assert counts(x.hive) == before
    assert x.hive.person_apps.binding(BOB_P, HELPERS)["swarm_id"] == home


def test_an_unusable_p2_home_is_never_replaced_by_a_second_one(x):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    x.hive.person_swarms.ensure(BOB_P, HELPERS, "helpers")
    home = x.hive.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ?", (BOB_P,))["swarm_id"]
    x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (home,))
    before = counts(x.hive)
    failure(open_app(x, HELPERS, x.bob), "space_failed")
    assert counts(x.hive) == before


# ---- one own key -------------------------------------------------------------------------------------------------------------

def test_a_template_contexts_dispatch_is_pinned_to_the_consented_key(x):
    minds = deployed(x)
    x.hive.db.execute("UPDATE app_person_consents SET key_id = 'k_other' WHERE principal = ?", (BOB_P,))
    with pytest.raises(Exception):                                 # P2 or P14: never a key the card did not name
        x.hive.person_apps.authorize_agent(minds[0]["id"])


def test_a_plain_context_keeps_the_first_own_key_it_paid_with(x):
    from hive.tests.test_key_owner_oi13 import add_key
    month(x, x.bob)
    space = opened(x, SOLO, x.bob)["swarm_id"]
    mind = x.client.post("/api/agents", headers=x.bob, json={"name": "Helper", "kind": "omega", "swarm_id": space,
                                                             "model": MODEL}).json()
    x.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": K_BOB, "key_locked": True}), mind["id"]))
    x.hive.person_apps.authorize_agent(mind["id"])
    assert x.hive.person_apps.binding(BOB_P, SOLO)["key_id"] == K_BOB
    add_key(x.hive, "k_000b0b0c", BOB_P)                            # a second own key, same provider
    x.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": "k_000b0b0c", "key_locked": True}),
                                                                    mind["id"]))
    refused(x, mind["id"], "own_key_needed")


# ---- own key only ----------------------------------------------------------------------------------------------------------

def test_a_paid_dispatch_never_falls_back_to_another_payer(x):
    month(x, x.bob)
    space = opened(x, SOLO, x.bob)["swarm_id"]
    mind = x.client.post("/api/agents", headers=x.bob, json={"name": "Helper", "kind": "omega", "swarm_id": space,
                                                             "model": MODEL}).json()
    assert mind.get("id"), mind
    with pytest.raises(Exception) as e:                            # no key: the hive's env key never stands in
        x.hive.person_apps.authorize_agent(mind["id"])
    assert e.value.code == "own_key_needed"
    x.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": K_BOB}), mind["id"]))
    with pytest.raises(Exception):                                 # own key but not locked to it
        x.hive.person_apps.authorize_agent(mind["id"])
    x.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": K_BOB, "key_locked": True}), mind["id"]))
    x.hive.person_apps.authorize_agent(mind["id"])
    x.hive.db.execute("UPDATE key_limits SET revoked_at = '2026-10-27T00:00:00Z' WHERE owner = ?", (BOB_P,))
    with pytest.raises(Exception) as e:                            # a missing personal limit stops paid work
        x.hive.person_apps.authorize_agent(mind["id"])
    assert e.value.code == "monthly_total_required"
    month(x, x.bob)
    x.client.post(f"/api/programs/{SOLO}/disable", headers=x.ann)
    with pytest.raises(Exception) as e:
        x.hive.person_apps.authorize_agent(mind["id"])
    assert e.value.code == "app_unavailable"


def test_the_gateway_checks_every_paid_dispatch_through_p14(x):
    assert x.client.app.state.gateway.authorize_agent == x.hive.person_apps.authorize_agent


def test_ask_prefs_cannot_redirect_a_person_apps_frame(x):
    space = opened(x, SOLO, x.bob)["swarm_id"]
    x.hive.db.execute("INSERT INTO ask_prefs (principal, swarm_id, thread_budget_usd, updated_at) VALUES (?, ?, 1, ?) "
                      "ON CONFLICT(principal) DO UPDATE SET swarm_id = excluded.swarm_id",
                      (BOB_P, x.shared["id"], "2026-10-27T00:00:00Z"))
    assert x.hive.app_ask._person_context(BOB_P, SOLO) == space
    assert x.hive.app_ask._person_context(BOB_P, SHARED) is None   # swarm apps unchanged
    with pytest.raises(Exception):
        x.hive.app_ask._person_context(CY_P, SOLO)                  # no context: never another swarm
    x.hive.db.execute("UPDATE swarms SET archived_at = '2026-10-27T00:00:00Z' WHERE id = ?", (space,))
    with pytest.raises(Exception):
        x.hive.person_apps.require_paid(BOB_P, SOLO, space)


# ---- limits -----------------------------------------------------------------------------------------------------------------

def test_creation_limits_hold_with_nothing_partial(x):
    apps, clock = x.hive.person_apps, [1000.0]
    apps.clock = lambda: clock[0]
    people = [person(x.client, f"u_lim{i:04d}") for i in range(21)]
    for headers in people[:20]:
        assert opened(x, SOLO, headers)["state"] == "ready"
    before = counts(x.hive)
    failure(open_app(x, SOLO, people[20]), "busy")
    assert counts(x.hive) == before
    clock[0] += 61
    assert opened(x, SOLO, people[20])["state"] == "ready"
    apps._pending = 50
    try:
        failure(open_app(x, SOLO, x.cy), "busy")
    finally:
        apps._pending = 0
    assert apps._created.maxlen == 20                               # bounded state
    assert x.hive.db.one("SELECT COUNT(*) AS n FROM app_person_contexts WHERE principal = ?", (CY_P,))["n"] == 0


def test_a_bound_template_context_is_repaired_through_p2_ensure_not_replaced(x, monkeypatch):
    month(x, x.bob)
    p2_consent(x, p2_card(x))
    home = opened(x, HELPERS, x.bob)["swarm_id"]
    x.hive.db.execute("UPDATE app_person_minds SET finished = 0 WHERE principal = ? AND slot = 'errands'", (BOB_P,))
    calls, real = [], x.hive.person_swarms.ensure
    monkeypatch.setattr(x.hive.person_swarms, "ensure", lambda *a: calls.append(a) or real(*a))
    assert opened(x, HELPERS, x.bob)["swarm_id"] == home
    assert len(calls) == 1
    assert opened(x, HELPERS, x.bob)["swarm_id"] == home and len(calls) == 1   # deployed: no further ensure


def test_a_person_apps_p1_frame_is_bound_to_its_context_not_ask_prefs(x):
    origin = "http://127.0.0.1:" + os.environ.get("HIVE_PORT", "8700")
    bob = dict(x.bob, Origin=origin)
    x.hive.db.execute("INSERT INTO ask_prefs (principal, swarm_id, thread_budget_usd, updated_at) VALUES (?, ?, 1, ?)",
                      (BOB_P, x.bob_swarm["id"], "2026-10-27T00:00:00Z"))   # a preference P1 would otherwise follow
    card = x.client.get(f"/api/programs/{SOLO}/ask/consent", headers=bob).json()
    body = {"release_digest": card["release_digest"], "frame_slot_id": "slot-p14"}
    if not card["consented"]:
        assert x.client.post(f"/api/programs/{SOLO}/ask/consent", headers=bob, json={"card_id": card["card_id"]}).status_code == 200
    r = x.client.post(f"/api/programs/{SOLO}/ask/frames", headers=bob, json=body)
    assert r.status_code == 409                                     # no context yet: never the preferred swarm instead
    space = opened(x, SOLO, x.bob)["swarm_id"]
    r = x.client.post(f"/api/programs/{SOLO}/ask/frames", headers=bob, json=body)
    assert r.status_code == 200, r.text
    swarms = {g["swarm_id"] for g in x.hive.db.all("SELECT swarm_id FROM app_ask_generations WHERE status = 'active'")}
    assert swarms == {space}


def test_the_install_status_applies_the_audience_first(x):
    assert x.client.put(f"/api/programs/{SOLO}/install/person-allow", headers=x.ann,
                        json={"person_allow": [BOB_P]}).status_code == 200
    assert status(x, SOLO, headers=x.bob)["installed"] is True
    # Ask-and-apps R1 (Dot ruling, consolidated item 5): outside the audience the app looks like no app at all
    r = x.client.get(f"/api/programs/{SOLO}/install", headers=x.cy)
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


# ---- the deployer's install review (HIVE_APP_INSTALLS) ----------------------------------------------------------------

def _fresh(x, app_id=SOLO):
    x.hive.db.execute("DELETE FROM app_install_reviews WHERE program = ?", (app_id,))


def test_deploy_install_makes_a_pinned_person_app_ready_with_no_admin_click(x, monkeypatch):
    _fresh(x)
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: {"placement": "person", "person_allow": "all"}}))
    PersonApps(x.hive)                                           # what the deployer's restart constructs
    assert x.hive.person_apps.deploy_installs() == []            # already current: nothing to do again
    row = x.hive.db.one("SELECT * FROM app_install_reviews WHERE program = ?", (SOLO,))
    assert row["by_person"] == "operator:deploy" and row["revoked_at"] is None
    assert opened(x, SOLO, x.bob)["swarm_id"]


def test_deploy_install_only_for_the_pinned_release_and_follows_an_update(x, monkeypatch):
    _fresh(x)
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: {"placement": "person"}}))
    assert x.hive.person_apps.deploy_installs() == [SOLO]
    first = x.hive.db.one("SELECT release_digest FROM app_install_reviews WHERE program = ?", (SOLO,))["release_digest"]
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "version": "1.0.1"}})
    failure(open_app(x, SOLO, x.bob), "release_changed")         # a new release is not the reviewed one ...
    assert x.hive.person_apps.deploy_installs() == [SOLO]        # ... until the deployer's restart reviews it
    row = x.hive.db.one("SELECT release_digest FROM app_install_reviews WHERE program = ?", (SOLO,))
    assert row["release_digest"] != first
    assert opened(x, SOLO, x.bob)["swarm_id"]


def test_deploy_install_never_overrides_an_admin_revoke(x, monkeypatch):
    assert x.client.delete(f"/api/programs/{SOLO}/install", headers=x.ann).status_code in (200, 204)
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: {"placement": "person"}}))
    assert x.hive.person_apps.deploy_installs() == []
    assert x.hive.db.one("SELECT revoked_at FROM app_install_reviews WHERE program = ?", (SOLO,))["revoked_at"]
    assert open_app(x, SOLO, x.bob).status_code == 409           # still refused (turned off and revoked)


@pytest.mark.parametrize("spec", [
    {"placement": "swarm"}, {"placement": "person", "use_in": []}, {"placement": "person", "person_allow": "everyone"}, [],
])
def test_deploy_install_refuses_anything_but_a_person_install(x, monkeypatch, spec):
    _fresh(x)
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: spec}))
    assert x.hive.person_apps.deploy_installs() == []
    failure(open_app(x, SOLO, x.bob), "not_reviewed")


def test_deploy_install_refuses_swarm_apps_unpinned_apps_and_a_wider_audience(x, monkeypatch):
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "person_allow": [BOB_P]}})
    _fresh(x)
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({
        SOLO: {"placement": "person", "person_allow": "all"},    # wider than the manifest's [BOB]
        SHARED: {"placement": "person"}, "no-such-app": {"placement": "person"}}))
    assert x.hive.person_apps.deploy_installs() == []
    assert x.hive.db.one("SELECT 1 FROM app_install_reviews WHERE program = ?", (SOLO,)) is None


def test_a_bad_setting_installs_nothing(x, monkeypatch):
    _fresh(x)
    monkeypatch.setenv("HIVE_APP_INSTALLS", "{not json")
    assert x.hive.person_apps.deploy_installs() == []
    failure(open_app(x, SOLO, x.bob), "not_reviewed")


def test_deploy_install_never_re_widens_an_admin_restrict_same_release(x, monkeypatch):
    r = x.client.put(f"/api/programs/{SOLO}/install/person-allow", headers=x.ann, json={"person_allow": [BOB_P]})
    assert r.status_code == 200, r.text
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: {"placement": "person", "person_allow": "all"}}))
    assert x.hive.person_apps.deploy_installs() == []
    row = x.hive.db.one("SELECT audience FROM app_install_reviews WHERE program = ?", (SOLO,))
    assert json.loads(row["audience"]) == [BOB_P]


def test_deploy_install_keeps_an_admin_restrict_across_an_update(x, monkeypatch):
    r = x.client.put(f"/api/programs/{SOLO}/install/person-allow", headers=x.ann, json={"person_allow": [BOB_P]})
    assert r.status_code == 200, r.text
    mount(x, monkeypatch, {**MANIFESTS, SOLO: {**MANIFESTS[SOLO], "version": "1.0.1"}})
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: {"placement": "person", "person_allow": "all"}}))
    assert x.hive.person_apps.deploy_installs() == [SOLO]
    row = x.hive.db.one("SELECT audience, by_person FROM app_install_reviews WHERE program = ?", (SOLO,))
    assert json.loads(row["audience"]) == [BOB_P] and row["by_person"] == "operator:deploy"
    assert opened(x, SOLO, x.bob)["swarm_id"]
    failure(open_app(x, SOLO, x.cy), "not_available_to_you")


def test_deploy_install_leaves_a_disabled_app_turned_off(x, monkeypatch):
    x.hive.programs.set_enabled(SOLO, False, ANN_P)
    _fresh(x)
    monkeypatch.setenv("HIVE_APP_INSTALLS", json.dumps({SOLO: {"placement": "person"}}))
    x.hive.person_apps.deploy_installs()
    assert SOLO in x.hive.programs.disabled
    failure(open_app(x, SOLO, x.bob), "app_turned_off")
