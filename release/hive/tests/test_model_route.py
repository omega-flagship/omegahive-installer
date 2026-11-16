"""The hive's one model-choice entry (model_route, the D18 Choir router's stand-in) and fresh-install gap 2: a personal
mind thinks with a route the host itself pays for, priced, from the reviewed roster; only a model the host set is ever
moved; a person's own key, a held non-default key or an unpriced model never counts. Invented keys only."""

import asyncio

import pytest

from hive.core import conductor, model_route
from hive.core.model_route import RouteFact, choose, facts, held, is_demo, roster, rule
from hive.tests.test_personal_mind import _client, _env, _person, _personal

HEAD = "openrouter/anthropic/claude-sonnet-5.5"
ENV = ("OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HIVE_DEFAULT_MODEL", "HIVE_ASK_CONDUCTOR_MODEL",
       "HIVE_ASK_CONDUCTOR_AB_MODELS")


@pytest.fixture
def hive_app(monkeypatch):
    for v in ENV:
        monkeypatch.delenv(v, raising=False)
    app, google, sup, _ = _env(monkeypatch)
    # the providers are shared objects (config.DEFAULT_PROVIDERS), which other tests may have keyed or priced: each test
    # here starts from a known state (no stored key, the roster unpriced) and everything is undone after it
    roster_names = {m.partition("/")[2] for m in roster()}
    for p in app.state.hive.keyring.providers.values():
        monkeypatch.setattr(p, "stored_key", "")
        monkeypatch.setattr(p, "prices", {k: v for k, v in p.prices.items() if k not in roster_names})
    c, admin = _client(app)
    yield app.state.hive, c, admin, google, sup
    c.__exit__(None, None, None)


@pytest.fixture
def price(monkeypatch):
    """Price a model for one test only: the providers are shared objects, so the change is undone afterwards."""
    def set_price(hive, model=HEAD):
        provider, _, name = model.partition("/")
        p = hive.keyring.provider(provider)
        monkeypatch.setattr(p, "prices", {**p.prices, name: {"in": 3, "out": 15}})
    return set_price


def route(hive):
    return choose("personal-mind:dialogue", hive.keyring, hive.ownhive)


# ---- the seam: facts, the one rule, a route or a refusal ------------------------------------------------------------

def test_the_rule_is_the_first_priced_host_paid_fact_in_roster_order():
    fs = [RouteFact("a/x", "a", False, True), RouteFact("b/y", "b", True, False), RouteFact("c/z", "c", True, True), RouteFact("d/w", "d", True, True)]
    assert rule("personal-mind:dialogue", fs).model == "c/z"
    assert rule("personal-mind:dialogue", fs[:2]) is None


def test_both_defaults_come_from_the_one_entry_unchanged(monkeypatch):
    for v in ENV:
        monkeypatch.delenv(v, raising=False)
    assert conductor.default_model() == HEAD == model_route.ROSTER_DEFAULT
    assert conductor.ab_models() == roster() == [HEAD, "openrouter/openai/gpt-6.1-sol"]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "anthropic/claude-sonnet-5-5")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_AB_MODELS", "openai/gpt-6.1")
    assert conductor.default_model() == "anthropic/claude-sonnet-5-5"
    assert conductor.ab_models() == ["anthropic/claude-sonnet-5-5", HEAD, "openrouter/openai/gpt-6.1-sol", "openai/gpt-6.1"]


def test_no_key_refuses_with_no_fallback(hive_app, price):
    hive = hive_app[0]
    price(hive)
    assert route(hive) == {"refused": "no_priced_host_paid_route"}
    assert choose("something-else", hive.keyring, hive.ownhive) == {"refused": "unknown_need"}


def test_an_environment_key_routes_only_to_a_priced_model(hive_app, monkeypatch, price):
    hive = hive_app[0]
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    assert route(hive) == {"refused": "no_priced_host_paid_route"}, "unpriced: never chosen (the conductor's rule)"
    price(hive)
    assert route(hive)["route"] == HEAD


def test_a_person_owned_default_is_not_the_hosts_and_a_hive_owned_one_is(hive_app, price):
    hive = hive_app[0]
    price(hive)
    store = hive.keyring
    store.ring["keys"]["k_0000aa01"] = {"id": "k_0000aa01", "provider": "openrouter", "label": "Ann's", "owner": "user:u_ann", "secret": "sk-or-ann"}
    store.ring["defaults"]["openrouter"] = "k_0000aa01"
    store._apply_defaults()                                             # the real path that copies the default's secret
    assert store.provider("openrouter").api_key == "sk-or-ann"
    assert route(hive) == {"refused": "no_priced_host_paid_route"}, "the sole key is a person's: not host-payable"
    store.ring["keys"]["k_0000aa02"] = {"id": "k_0000aa02", "provider": "openrouter", "label": "hive", "owner": "hive", "secret": "sk-or-hive"}
    store.ring["defaults"]["openrouter"] = "k_0000aa02"
    store._apply_defaults()
    assert route(hive)["route"] == HEAD


def test_a_held_non_default_hive_key_is_not_a_paying_route(hive_app, price):
    hive = hive_app[0]
    price(hive)
    store = hive.keyring
    store.ring["keys"]["k_0000aa03"] = {"id": "k_0000aa03", "provider": "openrouter", "label": "spare", "owner": "hive", "secret": "sk-or-spare"}
    store._apply_defaults()                                             # not the default, no environment key
    assert route(hive) == {"refused": "no_priced_host_paid_route"}


def test_an_unknown_provider_is_no_fact_and_pins_stand(hive_app, monkeypatch, price):
    hive = hive_app[0]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_AB_MODELS", "nowhere/model")
    assert all(f.provider != "nowhere" for f in facts(roster(), hive.keyring, hive.ownhive))
    monkeypatch.setenv("HIVE_DEFAULT_MODEL", "openai/gpt-5.4")
    assert route(hive) == {"route": "openai/gpt-5.4", "policy": "operator-pin", "fact": None}, "an explicit hive default pins a personal mind"
    assert conductor.default_model() == HEAD, "it never pins the conductor"
    monkeypatch.setenv("HIVE_DEFAULT_MODEL", "mock/echo")              # the demonstration model is not a pin
    assert "refused" in route(hive)


# ---- the personal mind ------------------------------------------------------------------------------------------------

def test_a_fresh_hive_with_a_priced_host_key_makes_a_mind_that_thinks_and_records_the_hosts_choice(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    _, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{ana_id}")[0]
    assert mind["model"] == HEAD and held(hive.db, mind["id"]) == HEAD
    assert sup.starts == []


def test_a_demonstration_mind_the_host_set_moves_when_the_host_gains_a_route_also_through_first_lights_read(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{ana_id}")[0]
    assert is_demo(mind["model"]) and held(hive.db, mind["id"]) == mind["model"], "made on the hive default, by the host"
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert c.get("/api/me/mind", headers=ana).status_code == 200          # First Light's read of her mind
    assert _personal(hive, f"user:{ana_id}")[0]["model"] == HEAD and held(hive.db, mind["id"]) == HEAD
    assert sup.starts == []


def test_an_owner_who_chooses_the_demonstration_model_is_never_moved(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    mind = _personal(hive, principal)[0]
    hive.update_agent(mind["id"], {"model": "mock/echo"}, by=principal)  # her own choice, the same value as before
    assert held(hive.db, mind["id"]) is None, "her change forgot the host's record"
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert hive.personal.ensure(principal)["model"] == "mock/echo"


def test_an_older_mind_with_no_record_is_left_alone(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    mind = _personal(hive, principal)[0]
    model_route.forget(hive.db, mind["id"])                            # as a mind made before provenance was kept
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert is_demo(hive.personal.ensure(principal)["model"])


def test_a_concurrent_owner_edit_wins_the_race(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    stale = _personal(hive, principal)[0]                               # read by the pickup
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    hive.db.execute("UPDATE agents SET model = 'openai/gpt-5.4' WHERE id = ?", (stale["id"],))   # her edit lands first
    model_route.record(hive.db, stale["id"], "mock/echo", "personal-mind:dialogue")              # (provenance read stale too)
    row = hive.personal.pick_up_host_provider(stale)
    assert row["model"] == "openai/gpt-5.4", "the conditional move refused: her model stands"


def test_an_operator_pin_on_the_demonstration_model_moves_nothing(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/echo")
    _, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{ana_id}"
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert hive.personal.ensure(principal)["model"] == "mock/echo", "the operator pinned it; the pin is the route"


# ---- R2 (Dot, 1afc3895): the wallet, the race under the lock, checked pins, one decision call, boot, the view --------

def moved(hive, c, admin, google, monkeypatch, price, email="ana@example.com", name="Ana"):
    headers, pid = _person(c, admin, google, email, name)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    row = hive.personal.ensure(f"user:{pid}")
    return headers, f"user:{pid}", row


def test_the_wallet_a_moved_mind_is_paid_by_the_hive_and_stopped_by_the_persons_allowance(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    headers, principal, row = moved(hive, c, admin, google, monkeypatch, price)
    assert row["model"] == HEAD
    agent = hive._agent_row(row["id"])                                  # the stored row, as the gateway passes it
    payer, own_key = hive.payer_for(agent, key_owner=hive.ownhive.key_person("env:openrouter"))
    assert (payer, own_key) == (principal, False), "the hive's money, for her"
    hive.check_budget(agent, paid=True, estimate=1.0, key_id="env:openrouter", payer=payer, own_key=own_key)   # admitted
    from hive.core.db import now
    hive.db.execute("INSERT INTO usage (agent_id, model, prompt_tokens, completion_tokens, cost_usd, created_at, payer) "
                    "VALUES (?, ?, 0, 0, ?, ?, ?)", (row["id"], HEAD, 49.5, now(), principal))   # her month, nearly spent
    with pytest.raises(Exception) as refused:
        hive.check_budget(agent, paid=True, estimate=1.0, key_id="env:openrouter", payer=payer, own_key=own_key)
    assert getattr(refused.value, "status", None) == 402, refused.value
    body = c.get("/api/me/mind", headers=headers).json()["mind"]
    assert body["paid_by"] == "the hive, within your monthly allowance" and body["allowance_usd"] == 50.0


def test_an_admin_with_no_allowance_and_no_hive_total_is_not_moved(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    headers, pid = _person(c, admin, google, "ann@example.com", "Ann")
    principal = f"user:{pid}"
    hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", (pid,))
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert is_demo(hive.personal.ensure(principal)["model"]), "no allowance would bound it: nothing moves"


def test_a_pin_must_pass_the_bar_before_a_persons_mind_is_moved_onto_it(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{pid}"
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "openrouter/openai/gpt-6.1-sol")        # unpriced here
    assert choose("personal-mind:dialogue", hive.keyring, hive.ownhive, pins="check") == {"refused": "pin_not_host_payable"}
    assert is_demo(hive.personal.ensure(principal)["model"])
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "anthropic/claude-sonnet-5-5")          # priced, but the host has no key
    assert choose("personal-mind:dialogue", hive.keyring, hive.ownhive, pins="check") == {"refused": "pin_not_host_payable"}
    assert is_demo(hive.personal.ensure(principal)["model"])
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/echo")
    assert choose("personal-mind:dialogue", hive.keyring, hive.ownhive, pins="check") == {"refused": "pin_is_demo"}
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", HEAD)                                   # priced and host-paid
    assert hive.personal.ensure(principal)["model"] == HEAD


def test_a_demonstration_pin_is_never_recorded_as_the_hosts(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/echo")
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{pid}")[0]
    assert mind["model"] == "mock/echo" and held(hive.db, mind["id"]) is None


def test_one_decision_call_serves_both_needs_under_named_policies(monkeypatch):
    for v in ENV:
        monkeypatch.delenv(v, raising=False)
    assert choose("ask-conductor") == {"route": HEAD, "policy": "roster-head", "fact": None}
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "openai/gpt-6.1")
    assert choose("ask-conductor") == {"route": "openai/gpt-6.1", "policy": "operator-pin", "fact": None}
    assert conductor.default_model() == "openai/gpt-6.1"
    asked = []
    def injected(need, *a, **k):                                           # the conductor must ASK the decision call
        asked.append(need)
        return {"route": "injected/decision", "policy": "test", "fact": None}
    monkeypatch.setattr(conductor, "_choose", injected)
    assert conductor.default_model() == "injected/decision" and asked == ["ask-conductor"]


def test_race_the_owner_re_saves_the_same_model_between_the_check_and_the_lock(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{pid}"
    stale = _personal(hive, principal)[0]
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    real_lock = hive._mind_lock
    def lock_after_her_edit(agent_id):
        monkeypatch.setattr(hive, "_mind_lock", real_lock)
        hive.update_agent(agent_id, {"model": "mock/echo"}, by=principal)    # the same value, re-saved by her
        return real_lock(agent_id)
    monkeypatch.setattr(hive, "_mind_lock", lock_after_her_edit)
    assert hive.personal.pick_up_host_provider(stale)["model"] == "mock/echo", "her choice stands"


def test_race_the_owner_changes_away_and_back_before_the_pickup(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{pid}"
    mind = _personal(hive, principal)[0]
    hive.update_agent(mind["id"], {"model": "openai/gpt-5.4"}, by=principal)
    hive.update_agent(mind["id"], {"model": "mock/echo"}, by=principal)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert hive.personal.ensure(principal)["model"] == "mock/echo"


def test_creation_provenance_is_forgotten_by_an_edit_right_after_creation(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    real_create = hive.create_agent
    def create_then_edited(*a, **k):
        agent = real_create(*a, **k)
        hive.update_agent(agent["id"], {"model": "openai/gpt-5.4"}, by=k.get("personal_of"))   # an edit right after
        return agent
    monkeypatch.setattr(hive, "create_agent", create_then_edited)
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{pid}")[0]
    assert mind["model"] == "openai/gpt-5.4" and held(hive.db, mind["id"]) is None


def test_boot_backfill_moves_nothing(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{pid}"
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    real_row = hive.personal.mind_row
    seen = []
    def made_meanwhile(who):                     # another creator makes her mind between backfill's check and its ensure
        seen.append(who)
        return None if who == principal and seen.count(who) == 1 else real_row(who)
    monkeypatch.setattr(hive.personal, "mind_row", made_meanwhile)
    hive.personal.backfill()
    monkeypatch.setattr(hive.personal, "mind_row", real_row)
    assert seen.count(principal) >= 2, "backfill reached ensure for a mind that already existed"
    assert is_demo(_personal(hive, principal)[0]["model"]), "boot never moves a mind, even one it finds made"


def test_provenance_is_written_in_the_same_transaction_as_the_model_change(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    principal = f"user:{pid}"
    mind = _personal(hive, principal)[0]
    def broken(db, agent_id):
        raise RuntimeError("provenance write failed")
    monkeypatch.setattr(model_route, "forget", broken)
    with pytest.raises(RuntimeError):
        hive.update_agent(mind["id"], {"model": "openai/gpt-5.4"}, by=principal)
    assert _personal(hive, principal)[0]["model"] == mind["model"], "the model change rolled back with it"


# ---- R3 (Dot, 50998399): one settlement for pickup, creation and the page; atomic creation provenance; explicit demo ----

def grant(hive, owner, key_id, grantee, usd=1.0):
    from hive.core.db import now
    stamp = now()
    hive.db.execute("INSERT INTO key_limits (id, owner, key_id, grantee, month_usd, ends_at, source, note, created_by, "
                    "created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'grant', '', ?, ?, ?)",
                    (f"kl_{grantee[-6:]}{key_id[-4:]}", owner, key_id, grantee, usd, owner, stamp, stamp))


def admin_without_allowance(hive, c, admin, google, email="ann@example.com", name="Ann"):
    """An admin who is not the hive's owner (Olga, an earlier admin, owns it): no allowance, and the hive has no total."""
    _, olga = _person(c, admin, google, "olga@example.com", "Olga")
    hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", (olga,))
    assert hive.ownhive.owner() == f"user:{olga}"
    _, pid = _person(c, admin, google, email, name)
    hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", (pid,))
    return f"user:{pid}"


def test_settlement_an_unrelated_grant_is_no_bound_for_the_hives_key(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, bob = _person(c, admin, google, "bob@example.com", "Bob")
    principal = admin_without_allowance(hive, c, admin, google)
    hive.keyring.ring["keys"]["k_0000bb01"] = {"id": "k_0000bb01", "provider": "openai", "label": "Bob's", "owner": f"user:{bob}", "secret": "sk-bob"}
    grant(hive, f"user:{bob}", "k_0000bb01", principal)                            # $1 on Bob's key, nothing to do with this one
    assert hive.ownhive.has_grant(principal)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    mind = _personal(hive, principal)[0]
    assert is_demo(hive.personal.ensure(principal)["model"]), "the unrelated grant moved nothing"
    s = hive.personal.settlement(mind, HEAD)
    assert s["key_id"] == "env:openrouter" and s["hive_key"] and not s["bounded"] and not s["host_paid"]
    assert not hive.budgets.paid_without_cap({**mind, "model": HEAD}, payer=principal, key_id="env:openrouter"), \
        "admission: a grant counts only on the key it is for"
    grant(hive, hive.ownhive.owner(), "env:openrouter", principal)                 # a grant on THIS key does bound it
    assert hive.personal.settlement(mind, HEAD)["host_paid"]


def test_settlement_a_person_owned_default_never_carries_a_pinned_mind(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    _, bob = _person(c, admin, google, "bob@example.com", "Bob")
    price(hive)
    store = hive.keyring
    store.ring["keys"]["k_0000bb02"] = {"id": "k_0000bb02", "provider": "openrouter", "label": "Bob's", "owner": f"user:{bob}", "secret": "sk-or-bob"}
    store.ring["defaults"]["openrouter"] = "k_0000bb02"
    store._apply_defaults()
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", HEAD)                           # an operator pin, priced
    headers, ana = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{ana}")[0]
    assert is_demo(mind["model"]), "creation: the pin would settle on Bob's key, so it is not used"
    s = hive.personal.settlement(mind, HEAD)
    assert s["key_id"] == "k_0000bb02" and s["key_owner"] == f"user:{bob}" and not s["hive_key"] and not s["host_paid"]
    model_route.record(hive.db, mind["id"], mind["model"], "personal-mind:dialogue")
    assert is_demo(hive.personal.ensure(f"user:{ana}")["model"]), "pickup: the same"
    grant(hive, f"user:{bob}", "k_0000bb02", f"user:{ana}", 20.0)                   # Bob lets her use his key, held to $20
    s = hive.personal.settlement(mind, HEAD)
    assert s["payer"] == f"user:{ana}" and not s["own_key"] and s["bounded"], "admitted and bounded: by Bob's grant"
    assert not s["hive_key"] and not s["host_paid"], "but Bob's money is not the host's"
    assert is_demo(hive.personal.ensure(f"user:{ana}")["model"]), "so the host never moves her onto it"
    hive.update_agent(mind["id"], {"model": HEAD}, by=f"user:{ana}")
    assert "another person's key" in c.get("/api/me/mind", headers=headers).json()["mind"]["paid_by"]


def test_settlement_a_key_rule_never_stands_in_for_the_persons_bound(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    ann = admin_without_allowance(hive, c, admin, google)                          # made before the host has a route
    headers, principal, row = moved(hive, c, admin, google, monkeypatch, price)
    assert row["model"] == HEAD
    hive.budgets.set("key:env:openrouter", "month", 500.0)                          # a generous rule on the key itself
    s = hive.personal.settlement(row, HEAD)
    assert s["host_paid"] and [g[0] for g in s["governing_limits"]] == ["person:" + principal[5:]], s["governing_limits"]
    mind = _personal(hive, ann)[0]
    s = hive.personal.settlement(mind, HEAD)
    assert not s["bounded"] and not s["host_paid"], "the key's own rule is not her bound"
    assert is_demo(hive.personal.ensure(ann)["model"])
    hive.budgets.set("hive", "month", 100.0)                                        # a hive total alone: her browser calls
    s = hive.personal.settlement(mind, HEAD)                                         # would be refused (no monthly total),
    assert not s["host_paid"] and s["reason"] == "monthly_total_required"           # so she is never moved there
    assert is_demo(hive.personal.ensure(ann)["model"])


def test_the_page_says_what_the_settlement_says(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    headers, principal, row = moved(hive, c, admin, google, monkeypatch, price)
    mine = {"id": "k_0000cc01", "provider": "openrouter", "label": "mine", "owner": principal, "secret": "sk-or-mine"}
    hive.keyring.ring["keys"]["k_0000cc01"] = mine
    hive.keyring.ring["defaults"]["openrouter"] = "k_0000cc01"                      # no assigned key: the default is hers
    hive.keyring._apply_defaults()
    s = hive.personal.settlement(hive._agent_row(row["id"]), HEAD)
    assert s["key_id"] == "k_0000cc01" and s["own_key"]
    assert c.get("/api/me/mind", headers=headers).json()["mind"]["paid_by"].startswith("you, on your own key")


def test_creation_provenance_does_not_survive_a_same_value_edit(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    real_create = hive.create_agent
    def create_then_resaved(*a, **k):
        agent = real_create(*a, **k)
        hive.update_agent(agent["id"], {"model": agent["model"]}, by=k.get("personal_of"))   # she saves the same model
        return agent
    monkeypatch.setattr(hive, "create_agent", create_then_resaved)
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{pid}")[0]
    assert is_demo(mind["model"]) and held(hive.db, mind["id"]) is None, "her save made it hers"
    monkeypatch.setattr(hive, "create_agent", real_create)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    price(hive)
    assert is_demo(hive.personal.ensure(f"user:{pid}")["model"])


def test_creation_provenance_does_not_survive_an_edit_away_and_back(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    real_create = hive.create_agent
    def create_then_away_and_back(*a, **k):
        agent = real_create(*a, **k)
        hive.update_agent(agent["id"], {"model": "openai/gpt-5.4"}, by=k.get("personal_of"))
        hive.update_agent(agent["id"], {"model": agent["model"]}, by=k.get("personal_of"))
        return agent
    monkeypatch.setattr(hive, "create_agent", create_then_away_and_back)
    _, pid = _person(c, admin, google, "ana@example.com", "Ana")
    assert held(hive.db, _personal(hive, f"user:{pid}")[0]["id"]) is None


def test_an_explicit_demonstration_default_is_the_operators_and_the_implicit_one_the_hosts(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    monkeypatch.setenv("HIVE_DEFAULT_MODEL", "mock/2")
    monkeypatch.setattr(hive.settings, "default_model", "mock/2")
    _, ana = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{ana}")[0]
    assert mind["model"] == "mock/2" and held(hive.db, mind["id"]) is None, "set by the operator: never recorded"
    monkeypatch.delenv("HIVE_DEFAULT_MODEL")
    monkeypatch.setattr(hive.settings, "default_model", "mock/echo")
    _, bea = _person(c, admin, google, "zoe@example.com", "Zoe")
    mind = _personal(hive, f"user:{bea}")[0]
    assert mind["model"] == "mock/echo" and held(hive.db, mind["id"]) == "mock/echo", "the built-in fallback: the host's"


# ---- R4 (Dot, 0f88cf5d): a refused default is never reinstalled; host provenance dies on an away-and-back edit -------

def test_a_refused_explicit_default_is_not_installed_and_the_fallback_is_the_hosts(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    monkeypatch.setenv("HIVE_DEFAULT_MODEL", "openai/gpt-5.4")                       # explicit, unpriced, no key: refused
    monkeypatch.setattr(hive.settings, "default_model", "openai/gpt-5.4")
    _, ana = _person(c, admin, google, "ana@example.com", "Ana")
    mind = _personal(hive, f"user:{ana}")[0]
    assert mind["model"] == model_route.DEMO_DEFAULT, "never the default that the bar just refused"
    assert held(hive.db, mind["id"]) == model_route.DEMO_DEFAULT, "the built-in fallback is the host's"


def test_a_host_moved_model_edited_away_and_back_is_the_owners(hive_app, monkeypatch, price):
    hive, c, admin, google, sup = hive_app
    headers, principal, row = moved(hive, c, admin, google, monkeypatch, price)
    assert row["model"] == HEAD and held(hive.db, row["id"]) == HEAD
    hive.update_agent(row["id"], {"model": "mock/echo"}, by=principal)
    hive.update_agent(row["id"], {"model": HEAD}, by=principal)
    assert held(hive.db, row["id"]) is None, "her edits made it hers, though it is the model the host had set"


# ---- follow-ups (Dot, 1781eb52; sol on 61b67662): an unpriced model is never bounded, whatever allow_unpriced says ----

@pytest.mark.parametrize("allow", [False, True])
def test_an_unpriced_model_is_never_bounded_and_the_page_says_so(hive_app, monkeypatch, allow):
    hive, c, admin, google, sup = hive_app
    headers, pid = _person(c, admin, google, "ana@example.com", "Ana")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented")
    monkeypatch.setattr(hive.settings, "allow_unpriced", allow)                    # HIVE_ALLOW_UNPRICED: permission only
    mind = _personal(hive, f"user:{pid}")[0]
    s = hive.personal.settlement(mind, HEAD)
    assert (s["reason"], s["bounded"], s["host_paid"]) == ("unpriced_model", False, False), "no price, no bound"
    assert is_demo(hive.personal.ensure(f"user:{pid}")["model"]), "so the host never moves a mind onto it"
    hive.update_agent(mind["id"], {"model": HEAD}, by=f"user:{pid}")                # she picks it herself
    paid_by = c.get("/api/me/mind", headers=headers).json()["mind"]["paid_by"]
    assert paid_by == "no one yet: a call on this model would be refused (unpriced_model)", paid_by
