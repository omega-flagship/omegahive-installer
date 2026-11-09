"""Personal-mind gateway r1, rounds r1a (the money core) and r1b (the Ask route).

Plan: PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN.md (r1, r1.1, r1.2). Synthetic people, fake priced
providers, scripted models: no network and no provider calls. Every test here fails on live 4d1f94fa (the review request
records each one's fail-before), except the controls marked as such.
"""
import asyncio
import concurrent.futures
import json
import sqlite3
import threading
import time
from types import SimpleNamespace

import pytest

from hive.core import conductor as cmod
from hive.core.cost_reservations import BudgetExhausted, Reservations, host_budget_snapshot, host_subjects
from hive.core.db import now
from hive.core.hive import HiveError
from hive.core.ownhive import scope_of
from hive.core.providers import ProviderError
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

OWNER, PAT = "u_0a0b0c0d", "u_1b1b1b1b"   # the hive's owner (first admin) and a member; 8-hex ids, as the scope regexes want
KA, KB = "k_0000000a", "k_0000000b"     # Pat's two own keys
KO = "k_0000000c"                        # the owner's own key


def add_key(hive, key_id, owner, provider="openrouter"):
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": provider, "label": key_id, "owner": owner,
                                        "secret": "sk-" + key_id + "-secret", "created_at": time.time()}


def total(hive, principal, usd):
    """The person's one total monthly limit on all their keys (grantee self, key *), as PUT /api/me/key-limits/self."""
    return hive.ownhive._write_limit(principal, "*", "self", usd, None, "owner", "", principal)


def per_key(hive, principal, key_id, usd):
    return hive.ownhive._write_limit(principal, key_id, "self", usd, None, "owner", "", principal)


def spend(hive, agent_id, payer, usd, key_id):
    hive.db.insert("usage", {"agent_id": agent_id, "model": "m", "prompt_tokens": 1, "completion_tokens": 1, "cost_usd": usd,
                             "created_at": now(), "key_id": key_id, "swarm_id": None, "payer": payer,
                             "key_grantee": hive.ownhive.grantee_for(key_id, payer)})


def refusal(fn, *args, **kw):
    with pytest.raises(HiveError) as e:
        fn(*args, **kw)
    return e.value


@pytest.fixture()
def money(client):  # noqa: F811
    """The owner (first admin, so the hive's owner) and Pat, a member, each with a personal mind ($0 cap, asleep); Pat
    owns two keys, the owner one. No hive total. Vega: an ordinary mind Pat owns, with its own cap, on Pat's key."""
    hive = client.app.state.hive
    owner, pat = person(client, OWNER, role="admin"), person(client, PAT)
    for key, who in ((KA, PAT), (KB, PAT), (KO, OWNER)):
        add_key(hive, key, f"user:{who}")
    pat_mind = hive._agent_row(hive.personal.ensure(f"user:{PAT}")["id"])
    owner_mind = hive._agent_row(hive.personal.ensure(f"user:{OWNER}")["id"])
    sw = client.post("/api/swarms", headers=pat, json={"name": "Pat's lab"}).json()
    vega = client.post("/api/agents", headers=pat, json={"name": "Vega", "kind": "omega", "swarm_id": sw["id"],
                                                         "model": "openrouter/test/vega", "budget_usd": 100,
                                                         "options": {"key": KA}}).json()
    assert hive.budgets.panel_total() is None
    return {"client": client, "hive": hive, "owner": owner, "pat": pat, "P": f"user:{PAT}", "O": f"user:{OWNER}",
            "mine": pat_mind, "owners": owner_mind, "vega": hive._agent_row(vega["id"])}


def labels(rows):
    return [s for s, _l, _sp in rows]


# =====================================================================================================================
# r1a: the money core
# =====================================================================================================================

# ---- T-SET: Reservations.settled is the one source of a thread's settled spend --------------------------------------

def _old_thread_spent(hive, s):
    """thread_spent exactly as live 4d1f94fa computed it (sessions.py:273-283), for comparison."""
    n = hive.db.one("SELECT COALESCE(SUM(r.actual), 0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
                    "ON c.reservation = r.id WHERE c.scope = ? AND r.state = 'settled'", (f"askthread:{s['id']}",))["n"]
    return float(s.get("carried_usd") or 0) + n / 1_000_000


@pytest.mark.parametrize("history,owner", [("mixed", "turn"), ("mixed", "mind"), ("conductor", "turn"), ("conductor", "mind")])
@pytest.mark.parametrize("state", ("reserved", "dispatched", "unknown", "released", "settled"))
@pytest.mark.parametrize("settle", ["before", "after", "never"])
def test_T_SET_settled_equals_the_old_thread_spent_on_the_ask_limits_fixtures(tmp_path, history, owner, state, settle):
    """The ask-limits r1.2 fixture (_Legacy: every reservation state, settled before or after the move, or never; turn or
    mind owned; mixed or conductor-only history): Reservations.settled(label) is the old query, and thread_spent is
    carried + settled, at every step."""
    from hive.tests.test_ask_limits_r1 import _Legacy
    if state == "settled" and settle != "before":
        pytest.skip("a settled hold settled before the move by definition")
    lg = _Legacy(tmp_path, mixed=history == "mixed")

    def same():
        t = lg.thread()
        n = lg.db.one("SELECT COALESCE(SUM(r.actual), 0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
                      "ON c.reservation = r.id WHERE c.scope = ? AND r.state = 'settled'", (lg.label,))["n"] / 1_000_000
        assert lg.res.settled(lg.label) == pytest.approx(n)
        assert lg.sessions.thread_spent(t) == pytest.approx(_old_thread_spent(lg, t))
        turn = "askturn:" + lg.TURN
        assert lg.res.settled(turn) == pytest.approx(lg.db.one(
            "SELECT COALESCE(SUM(r.actual), 0) AS n FROM cost_reservations r JOIN cost_reservation_scopes c "
            "ON c.reservation = r.id WHERE c.scope = ? AND r.state = 'settled'", (turn,))["n"] / 1_000_000)
    labels_ = [f"agent:{lg.MIND}:total"] + (["askturn:" + lg.TURN] if owner == "turn" else [])
    lg.hold("legacy", 0.8, labels_)
    same()
    if state != "settled":
        lg.to_state("legacy", state)
    if settle == "before" or state == "settled":
        lg.settle("legacy")
    same()
    lg.sessions.adopt_ask_threads()
    same()
    if settle == "after":
        lg.settle("legacy")
    same()


# ---- T-NB1/2: an own key, a personal mind, a turn-bound call: no no_budget and no zero agent total row -----------------

def test_T_NB1_2_own_key_turn_bound_call_is_admitted_under_the_monthly_total(money):
    hive, mine, P = money["hive"], money["mine"], money["P"]
    total(hive, P, 10.0)
    hive.check_budget(mine, True, 0.05, KA, P, True, turn_bound=True)          # admitted: no 402 no_budget
    rows = host_budget_snapshot(hive, mine["id"], KA, P, True, turn_bound=True)
    assert f"agent:{mine['id']}:total" not in labels(rows)                    # gate 2: no zero lifetime row
    star = scope_of(P, "*", "self") + ":month"
    assert dict((s, (l, sp)) for s, l, sp in rows)[star] == (10.0, 0.0)
    assert hive.budgets.own_key_bound(mine, P, True, KA, True)[:3] == (scope_of(P, "*", "self"), "month", 10.0)
    # and it reserves and settles, counted against that total
    res = Reservations(hive.db)
    res.reserve("nb1", {"x": 1}, 0.05, lambda: host_budget_snapshot(hive, mine["id"], KA, P, True, turn_bound=True),
                {"agent": mine["id"], "payer": P, "key": KA}, dispatched=True,
                subjects=host_subjects(hive, mine["id"], KA, P, True, turn_bound=True))
    res.settle("nb1", 0.04, lambda: hive.record_usage(mine, "openrouter/x", {"prompt_tokens": 1, "completion_tokens": 1,
                                                                            "cost_usd": 0.04, "key_id": KA}, None, P))
    assert hive.ownhive.spent(scope_of(P, "*", "self")) == pytest.approx(0.04)


def test_T_NB3_callers_without_turn_bound_are_unchanged(money):
    """Control: every caller that does not pass turn_bound (the chat route, media, the conductor, the agent-token route)
    meets the two live gates exactly as before, with or without a monthly total."""
    hive, mine, P = money["hive"], money["mine"], money["P"]
    for with_total in (False, True):
        if with_total:
            total(hive, P, 10.0)
        assert refusal(hive.check_budget, mine, True, 0.05, KA, P, True).code == "no_budget"            # gate 1
        assert f"agent:{mine['id']}:total" in labels(host_budget_snapshot(hive, mine["id"], KA, P, True))  # gate 2, at 0
        assert hive.budgets.own_key_bound(mine, P, True, KA, False) is None
    # the hive-money personal path (allowance_pays) is as it was: Pat's member allowance admits, no lifetime row
    hive.check_budget(mine, True, 0.05, None, P, False)
    assert f"agent:{mine['id']}:total" not in labels(host_budget_snapshot(hive, mine["id"], None, P, False))
    assert "person:" + PAT + ":month" in labels(host_budget_snapshot(hive, mine["id"], None, P, False))


# ---- T-NB4 / T-MT1: no monthly total -> one clear 402, before any reservation -----------------------------------------

def test_T_NB4_own_key_with_no_total_is_monthly_total_required(money):
    hive, mine, P = money["hive"], money["mine"], money["P"]
    e = refusal(hive.check_budget, mine, True, 0.05, KA, P, True, turn_bound=True)
    assert (e.status, e.code) == (402, "spend_limit")
    assert e.details == {"kind": "own_key_limit", "reason": "monthly_total_required", "scope": None, "period": None,
                         "limit_usd": None, "spent_usd": None}
    assert "Set your monthly limit" in e.message
    # the shared limit frame names it, figures null; the conductor's own sentence says it
    detail = cmod.check_detail(hive, mine, e, 0.05)
    assert cmod.limit_frame(detail) == {"kind": "own_key_limit", "current_usd": None, "limit_usd": None,
                                        "estimate_usd": None, "reason": "monthly_total_required"}
    assert "set your monthly limit" in cmod.stop_say(cmod._Stop("spend_cap", detail))
    # nothing can be reserved without it either (the snapshot itself refuses)
    with pytest.raises(ValueError, match="monthly_total_required"):
        host_budget_snapshot(hive, mine["id"], KA, P, True, turn_bound=True)
    # a refusal leaves nothing behind
    assert hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == 0


def test_T_MT1_hive_key_admin_with_no_month_rule_is_monthly_total_required(money):
    """The owner (an admin) has no allowance and no month rule: a turn-bound call on the hive's money is refused with the
    one word, kind member_allowance (live: 402 no_budget, no reason). With a month rule it is admitted under it."""
    hive, mine, O = money["hive"], money["owners"], money["O"]
    e = refusal(hive.check_budget, mine, True, 0.05, None, O, False, turn_bound=True)
    assert (e.code, e.details["kind"], e.details["reason"]) == ("spend_limit", "member_allowance", "monthly_total_required")
    hive.budgets.set("person:" + OWNER, "month", 3.0)
    hive.check_budget(mine, True, 0.05, None, O, False, turn_bound=True)
    assert "person:" + OWNER + ":month" in labels(host_budget_snapshot(hive, mine["id"], None, O, False, turn_bound=True))


def test_T_MT1_a_member_on_hive_money_is_governed_by_the_member_allowance(money):
    hive, mine, P = money["hive"], money["mine"], money["P"]
    assert hive.budgets.monthly_total(mine, P, False, None) == ("person:" + PAT, "month", 50.0, "member-default")
    hive.check_budget(mine, True, 0.05, None, P, False, turn_bound=True)


# ---- T-NB5: per-key limits restrict their own key below the total ----------------------------------------------------

def test_T_NB5_a_per_key_limit_refuses_the_second_call_at_its_own_figure(money):
    hive, mine, P = money["hive"], money["mine"], money["P"]
    total(hive, P, 10.0)
    per_key(hive, P, KA, 1.0)
    hive.check_budget(mine, True, 0.6, KA, P, True, turn_bound=True)
    spend(hive, mine["id"], P, 0.6, KA)                                       # the first call settled at $0.60
    e = refusal(hive.check_budget, mine, True, 0.6, KA, P, True, turn_bound=True)
    assert e.code == "spend_limit" and e.details["scope"] == scope_of(P, KA, "self") and e.details["limit_usd"] == 1.0
    assert cmod.check_detail(hive, mine, e, 0.6)["kind"] == "own_key_limit"
    hive.check_budget(mine, True, 0.6, KB, P, True, turn_bound=True)          # key B: only the total binds it


# ---- T-NB6: the same outcome in shared and local mode --------------------------------------------------------------

@pytest.mark.parametrize("local", ["", "1"])
def test_T_NB6_the_same_fixture_gives_the_same_outcome_with_and_without_local_owner(money, monkeypatch, local):
    """Kimi item 3: nothing branches on HIVE_LOCAL_OWNER. The same person and key shapes (a member's own key, the hive
    owner's own key) give the same refusal without a total and the same rows with one, in either mode."""
    monkeypatch.setenv("HIVE_LOCAL_OWNER", local)
    hive = money["hive"]
    for who, mind, key in ((money["P"], money["mine"], KA), (money["O"], money["owners"], KO)):
        e = refusal(hive.check_budget, mind, True, 0.05, key, who, True, turn_bound=True)
        assert (e.status, e.code, e.details["kind"], e.details["reason"]) == (402, "spend_limit", "own_key_limit",
                                                                             "monthly_total_required")
        total(hive, who, 5.0)
        hive.check_budget(mind, True, 0.05, key, who, True, turn_bound=True)
        rows = dict((s_, l) for s_, l, _sp in host_budget_snapshot(hive, mind["id"], key, who, True, turn_bound=True))
        assert rows[scope_of(who, "*", "self") + ":month"] == 5.0 and f"agent:{mind['id']}:total" not in rows


# ---- T-MT2 (r1.2): one total across all own-key spend ----------------------------------------------------------------

def test_T_MT2_per_key_limits_alone_never_satisfy_the_total(money):
    hive, mine, P = money["hive"], money["mine"], money["P"]
    per_key(hive, P, KA, 10.0)
    per_key(hive, P, KB, 10.0)
    for key in (KA, KB):
        e = refusal(hive.check_budget, mine, True, 0.05, key, P, True, turn_bound=True)
        assert e.details["reason"] == "monthly_total_required"
    # an admin's person rule is not a substitute either
    hive.budgets.set("person:" + PAT, "month", 20.0)
    assert refusal(hive.check_budget, mine, True, 0.05, KA, P, True, turn_bound=True).details["reason"] == "monthly_total_required"


def test_T_MT2_an_admin_person_rule_is_an_additional_row_on_own_key(money):
    hive, mine, P = money["hive"], money["mine"], money["P"]
    total(hive, P, 10.0)
    hive.budgets.set("person:" + PAT, "month", 0.5)
    rows = host_budget_snapshot(hive, mine["id"], KA, P, True, turn_bound=True)
    assert "person:" + PAT + ":month" in labels(rows) and scope_of(P, "*", "self") + ":month" in labels(rows)
    assert "person:" + PAT in host_subjects(hive, mine["id"], KA, P, True, turn_bound=True)
    assert refusal(hive.check_budget, mine, True, 0.6, KA, P, True, turn_bound=True).details["scope"] == "person:" + PAT
    # not on any other route: the agent-token chat on Pat's own key is held as before (no person row)
    assert "person:" + PAT + ":month" not in labels(host_budget_snapshot(hive, money["vega"]["id"], KA, P, True))


def test_T_MT2_browser_chat_and_media_on_two_keys_draw_down_one_total(money):
    """With the all-keys total at $10, concurrent browser-mind (turn-bound), agent-token chat and media reservations on
    both of Pat's keys, some settling, some held unknown, never together exceed $10; once it is spent every route
    refuses. A per-key limit still holds its own key lower."""
    hive, mine, vega, P = money["hive"], money["mine"], money["vega"], money["P"]
    total(hive, P, 10.0)
    per_key(hive, P, KA, 3.0)
    assert hive.payer_for(vega, P) == (P, True)
    res = Reservations(hive.db)
    star = scope_of(P, "*", "self")
    routes = {"browser": (mine, True), "chat": (vega, False), "media": (vega, False)}
    outcomes, lock = [], threading.Lock()

    def one(i):
        kind = ("browser", "chat", "media")[i % 3]
        agent, bound = routes[kind]
        key = (KA, KB)[(i // 3) % 2]
        rid = f"mt2-{i}"
        try:
            res.reserve(rid, {"i": i}, 0.6, lambda: host_budget_snapshot(hive, agent["id"], key, P, True, turn_bound=bound),
                        {"agent": agent["id"], "payer": P, "key": key, "kind": kind}, dispatched=True,
                        subjects=host_subjects(hive, agent["id"], key, P, True, turn_bound=bound))
        except BudgetExhausted as exc:
            with lock:
                outcomes.append(("refused", kind, key, exc.scope))
            return
        if i % 4 == 0:
            res.unknown(rid)                                                   # held at its worst case, never released
            state = "unknown"
        else:
            res.settle(rid, 0.5, lambda: hive.record_usage(agent, "openrouter/x", {"prompt_tokens": 1, "completion_tokens": 1,
                                                                                    "cost_usd": 0.5, "key_id": key}, None, P))
            state = "settled"
        with lock:
            outcomes.append((state, kind, key, None))

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        list(pool.map(one, range(60)))
    settled = hive.ownhive.spent(star)
    held = res.pending(star + ":month") / 1_000_000
    assert settled + held <= 10.0 + 1e-9, (settled, held)
    assert {k for s, k, _, _ in outcomes if s != "refused"} == {"browser", "chat", "media"}
    assert {k for s, _, k, _ in outcomes if s != "refused"} == {KA, KB}
    # key A never went past its own $3, under the total
    assert hive.ownhive.spent(scope_of(P, KA, "self")) + res.pending(scope_of(P, KA, "self") + ":month") / 1e6 <= 3.0 + 1e-9
    refused = {s for st, _, _, s in outcomes if st == "refused"}
    assert star + ":month" in refused
    # spent: every route refuses now, on the same total
    for agent, bound in ((mine, True), (vega, False)):
        e = refusal(hive.check_budget, agent, True, 0.6, KB, P, True, turn_bound=bound) if settled + 0.6 > 10 else None
        if e is not None:
            assert e.details["scope"] == star
        with pytest.raises(BudgetExhausted) as x:
            res.reserve(f"after-{agent['id']}", {"z": 1}, 0.6,
                        lambda: host_budget_snapshot(hive, agent["id"], KB, P, True, turn_bound=bound), {"agent": agent["id"]})
        assert x.value.scope == star + ":month"


# ---- T-MT3: the monthly row is in every browser reservation --------------------------------------------------------

def test_T_MT3_the_monthly_row_is_in_every_turn_bound_snapshot(money):
    hive, mine, P, O = money["hive"], money["mine"], money["P"], money["O"]
    total(hive, P, 10.0)
    assert scope_of(P, "*", "self") + ":month" in labels(host_budget_snapshot(hive, mine["id"], KB, P, True, turn_bound=True))
    assert "person:" + PAT + ":month" in labels(host_budget_snapshot(hive, mine["id"], None, P, False, turn_bound=True))
    # named explicitly by the snapshot, not only through applicable: with applicable missing it, it is still there
    real = hive.budgets.applicable
    hive.budgets.applicable = lambda *a, **k: [r for r in real(*a, **k) if not r[0].startswith(("keyuse:", "person:"))]
    try:
        assert scope_of(P, "*", "self") + ":month" in labels(host_budget_snapshot(hive, mine["id"], KB, P, True, turn_bound=True))
    finally:
        hive.budgets.applicable = real
    del O


# ---- T-KEY1: POST /api/keys with month_usd writes the key and the total together -------------------------------------

@pytest.fixture()
def money_gw(money, monkeypatch):
    """money, with HIVE_MIND_GATEWAY=1: POST /api/keys reads month_usd only with the flag (r1ab.2)."""
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    return money


def _verify_stub(hive, calls):
    async def verify(name, key):
        calls.append(name)
        return {"label": "test key"}
    hive.providers.verify = verify


def test_T_KEY1_post_keys_with_month_usd_writes_the_key_and_its_all_keys_total(money_gw):
    client, hive, pat, P = money_gw["client"], money_gw["hive"], money_gw["pat"], money_gw["P"]
    calls = []
    _verify_stub(hive, calls)
    r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-pat-new", "month_usd": 12.5})
    assert r.status_code == 200, r.text
    key_id = r.json()["id"]
    assert hive.keyring.ring["keys"][key_id]["owner"] == P
    row = hive.ownhive.total_row(P)
    assert (row["key_id"], row["grantee"], row["month_usd"]) == ("*", "self", 12.5)
    assert client.get("/api/me/key-limits", headers=pat).json()["own"][0]["key_id"] == "*"
    # without month_usd: as before, no limit is written
    before = hive.db.one("SELECT COUNT(*) AS n FROM key_limits")["n"]
    assert client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-pat-other"}).status_code == 200
    assert hive.db.one("SELECT COUNT(*) AS n FROM key_limits")["n"] == before


def test_T_KEY1_a_bad_total_or_a_failed_lowering_write_adds_no_key(money_gw, monkeypatch):
    client, hive, pat, P = money_gw["client"], money_gw["hive"], money_gw["pat"], money_gw["P"]
    calls = []
    _verify_stub(hive, calls)
    keys = dict(hive.keyring.ring["keys"])
    r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-bad", "month_usd": -1})
    assert (r.status_code, r.json()["error"]["code"]) == (400, "bad_limit") and calls == []   # refused before the key step
    # a lower total is written before the key: if that write fails, nothing else happens
    total(hive, P, 50.0)

    def boom(*a, **k):
        raise RuntimeError("disk full")
    monkeypatch.setattr(hive.ownhive, "_write_limit", boom)
    with pytest.raises(RuntimeError):
        client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-boom", "month_usd": 5})
    assert hive.keyring.ring["keys"] == keys and calls == []   # the key step never ran: nothing verified or written
    assert not hive.keyring.path.exists() or "sk-or-boom" not in hive.keyring.path.read_text()
    assert hive.ownhive.total_row(P)["month_usd"] == 50.0


def test_T_KEY1_r1ab1_a_failed_limit_write_keeps_the_previous_provider_default(money_gw, monkeypatch):
    """r1ab.1 (stand-in P1), in r1ab.3's order: an admin adds a key with default:true and a LOWER month_usd while the
    provider already has a default. The limit write (first) fails: no key, and the previous default stands, in memory
    and on disk."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    hive.keyring._write()
    total(hive, O, 50.0)

    def boom(*a, **k):
        raise RuntimeError("disk full")
    monkeypatch.setattr(hive.ownhive, "_write_limit", boom)
    with pytest.raises(RuntimeError):
        client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-new-default",
                                                     "default": True, "month_usd": 5})
    assert all(r["secret"] != "sk-or-new-default" for r in hive.keyring.ring["keys"].values())
    assert hive.keyring.ring["defaults"].get("openrouter") == KO
    assert json.loads(hive.keyring.path.read_text())["defaults"].get("openrouter") == KO
    assert hive.ownhive.total_row(O)["month_usd"] == 50.0


@pytest.mark.parametrize("prior", [None, 5.0, 50.0])
def test_T_KEY1_default_true_with_month_usd_switches_the_default_and_writes_the_total(money_gw, prior):
    """Success control: a first total ($20), a raise ($5 → $20) and a lowering ($50 → $20)."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    if prior is not None:
        total(hive, O, prior)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-new-default2",
                                                     "default": True, "month_usd": 20})
    assert r.status_code == 200, r.text
    assert r.json()["default"] is True and hive.keyring.ring["defaults"]["openrouter"] == r.json()["id"]
    assert hive.ownhive.total_row(O)["month_usd"] == 20


# ---- r1ab.2/r1ab.3: the default switch is a unit; a total is never raised provisionally -----------------------------

def _fail_nth_write(hive, monkeypatch, n):
    """The keyring's n-th file write (counting from now) raises; every other write is real."""
    real, seen = hive.keyring._write, {"n": 0}

    def write():
        seen["n"] += 1
        if seen["n"] == n:
            raise OSError("disk full")
        return real()
    monkeypatch.setattr(hive.keyring, "_write", write)
    return seen


def _total(hive, owner):
    row = hive.ownhive.total_row(owner)
    return None if row is None else row["month_usd"]


def _usable_within(hive, money, key_id):
    """The bound a turn-bound call by the owner's personal mind on this key is held to (None: refused)."""
    bound = hive.budgets.own_key_bound(money["owners"], money["O"], True, key_id, True)
    return None if bound is None else bound[2]


def test_r1ab2_update_key_with_a_failed_write_changes_nothing_in_memory(money_gw, monkeypatch):
    """Stand-in r1ab.1 P1-1, at the provider: update_key replaced the default in memory before _write; a failed write
    left memory switched. Fail-before (1d3603d6): defaults point at the new key after the failed write."""
    hive = money_gw["hive"]
    hive.keyring.ring["defaults"]["openrouter"] = KO
    hive.keyring._write()
    _fail_nth_write(hive, monkeypatch, 1)
    with pytest.raises(OSError):
        hive.keyring.update_key(KA, label="renamed", default=True)
    assert hive.keyring.ring["defaults"]["openrouter"] == KO and hive.keyring.ring["keys"][KA]["label"] == KA
    assert json.loads(hive.keyring.path.read_text())["defaults"]["openrouter"] == KO


@pytest.mark.parametrize("prior,after", [(None, None), (5.0, 5.0), (50.0, 20.0)])
def test_r1ab2_a_failed_default_switch_keeps_the_previous_default_and_never_a_higher_total(money_gw, monkeypatch,
                                                                                           prior, after):
    """Stand-in r1ab.1 P1-1/P1-2 through the route: the default switch's own file write fails. The new key is gone, the
    previous default is still the default (memory and disk). A raise ($20 over none or $5) was never written; a lowering
    ($50 → $20) was written first and stays, the safe direction. Fail-before (1d3603d6): defaults {} and the total $20."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    hive.keyring._write()
    if prior is not None:
        total(hive, O, prior)
    _fail_nth_write(hive, monkeypatch, 2)   # 1: add_key stores the key; 2: update_key switches the default
    with pytest.raises(OSError):
        client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-switch-fails",
                                                     "default": True, "month_usd": 20})
    assert all(r["secret"] != "sk-or-switch-fails" for r in hive.keyring.ring["keys"].values())
    assert hive.keyring.ring["defaults"].get("openrouter") == KO
    assert json.loads(hive.keyring.path.read_text())["defaults"].get("openrouter") == KO
    assert _total(hive, O) == after


def test_r1ab3_standin_a_a_failed_lowering_never_undoes_a_concurrent_successful_lowering(money_gw, monkeypatch):
    """Stand-in r1ab.2 P1 (a): $50; A lowers to $5; a concurrent successful update also writes $5; A fails. Nothing is
    restored: the cap is $5. Fail-before (be0b7a6a): A's rollback put $50 back."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    total(hive, O, 50.0)

    def boom(*a, **k):
        total(hive, O, 5.0)              # the concurrent successful PUT /api/me/key-limits/self
        raise RuntimeError("switch failed")
    monkeypatch.setattr(hive.keyring, "update_key", boom)
    with pytest.raises(RuntimeError):
        client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-a",
                                                     "default": True, "month_usd": 5})
    assert _total(hive, O) == 5.0 and hive.keyring.ring["defaults"]["openrouter"] == KO


def test_r1ab3_standin_b_two_failed_raises_leave_the_cap_where_it_was(money_gw, monkeypatch):
    """Stand-in r1ab.2 P1 (b): $5; A asks for $50 and B for $100, and both fail. A raise is written only after the
    switch, so no request ever sees another's provisional raise (B cannot snapshot $50): both see $5 at their switch, and
    $5 is left. Fail-before (be0b7a6a): $50 survived."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    total(hive, O, 5.0)
    seen = []

    def boom(*a, **k):
        seen.append(_total(hive, O))
        raise RuntimeError("switch failed")
    monkeypatch.setattr(hive.keyring, "update_key", boom)
    for key, month in (("sk-or-a", 50), ("sk-or-b", 100)):
        with pytest.raises(RuntimeError):
            client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": key, "default": True,
                                                         "month_usd": month})
    assert seen == [5.0, 5.0] and _total(hive, O) == 5.0


@pytest.mark.parametrize("prior", [5.0, None])
def test_r1ab3_a_raise_write_that_fails_after_the_switch_leaves_the_old_cap_governing_the_key(money_gw, monkeypatch,
                                                                                              prior):
    """Dot's r1ab.3 ruling: the raise is the last write. If it fails, the key and its default stand (what was asked),
    the old cap is unchanged, and the key is usable within it ($5), or, with no total, refused (turn-bound). r1ab.4: the
    answer is the retryable 503 limit_not_raised, naming the key and the total that governs now."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    if prior is not None:
        total(hive, O, prior)

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error")   # before the commit
    monkeypatch.setattr(hive.ownhive, "set_limit", boom)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-raise",
                                                     "default": True, "month_usd": 50})
    key_id = next(k for k, r in hive.keyring.ring["keys"].items() if r["secret"] == "sk-or-raise")
    assert r.status_code == 503
    assert set(r.json()["error"]) == {"code", "message", "key_id", "provider", "monthly_total_usd"}
    assert r.json()["error"]["code"] == "limit_not_raised"
    assert (r.json()["error"]["key_id"], r.json()["error"]["provider"], r.json()["error"]["monthly_total_usd"]) == \
        (key_id, "openrouter", prior)
    assert "sk-or-raise" not in r.text
    assert hive.keyring.ring["defaults"]["openrouter"] == key_id
    assert json.loads(hive.keyring.path.read_text())["defaults"]["openrouter"] == key_id
    assert _total(hive, O) == prior and _usable_within(hive, money_gw, key_id) == prior


@pytest.mark.parametrize("fail", ["limit", "switch"])
def test_r1ab2_kimi_first_key_auto_default_follows_the_same_rule(money_gw, monkeypatch, fail):
    """Kimi r1ab.1: the first key of a provider (no stored default, no env key, `default` absent) is stored as a
    non-default and becomes the default only after it is stored, like an explicit default. A first total is a raise
    (with none, turn-bound calls are refused), so it is written last. A failed switch: no key, no default, no total. A
    failed total: the key and its default stand, with no total (turn-bound refused)."""
    client, hive, pat, P = money_gw["client"], money_gw["hive"], money_gw["pat"], money_gw["P"]
    _verify_stub(hive, [])
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    hive.keyring.ring["defaults"].pop("openrouter", None)
    hive.keyring._write()

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error") if fail == "limit" else RuntimeError("failed")
    monkeypatch.setattr(hive.ownhive if fail == "limit" else hive.keyring, "set_limit" if fail == "limit" else "update_key",
                        boom)
    if fail == "switch":
        with pytest.raises(RuntimeError):
            client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-first", "month_usd": 5})
    else:   # r1ab.4: the failed raise is the retryable 503
        r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-first", "month_usd": 5})
        assert (r.status_code, r.json()["error"]["code"]) == (503, "limit_not_raised")
    stored = [k for k, r in hive.keyring.ring["keys"].items() if r["secret"] == "sk-or-first"]
    disk = json.loads(hive.keyring.path.read_text())["defaults"]
    if fail == "switch":
        assert stored == [] and "openrouter" not in hive.keyring.ring["defaults"] and "openrouter" not in disk
    else:
        assert hive.keyring.ring["defaults"]["openrouter"] == stored[0] == disk["openrouter"]
    assert _total(hive, P) is None


def test_r1ab2_first_key_auto_default_control_becomes_the_default_on_success(money_gw, monkeypatch):
    client, hive, pat, P = money_gw["client"], money_gw["hive"], money_gw["pat"], money_gw["P"]
    _verify_stub(hive, [])
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    hive.keyring.ring["defaults"].pop("openrouter", None)
    r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-first-ok", "month_usd": 5})
    assert r.status_code == 200 and r.json()["default"] is True
    assert hive.keyring.ring["defaults"]["openrouter"] == r.json()["id"] and hive.ownhive.total_row(P)["month_usd"] == 5
    # a second key with month_usd and no `default` does not take the default
    r2 = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-second", "month_usd": 6})
    assert r2.status_code == 200 and r2.json()["default"] is False and hive.ownhive.total_row(P)["month_usd"] == 6


def test_r1ab3_kimi_3_a_failed_removal_keeps_the_original_error_as_its_cause(money_gw, monkeypatch):
    client, hive, owner = money_gw["client"], money_gw["hive"], money_gw["owner"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO

    def switch(*a, **k):
        raise RuntimeError("switch failed")

    def remove(*a, **k):
        raise OSError("remove failed")
    monkeypatch.setattr(hive.keyring, "update_key", switch)
    monkeypatch.setattr(hive.keyring, "remove_key_id", remove)
    with pytest.raises(OSError) as e:
        client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-chain",
                                                     "default": True, "month_usd": 5})
    assert isinstance(e.value.__cause__, RuntimeError) and str(e.value.__cause__) == "switch failed"


def test_r1ab3_kimi_a_folder_fsync_failure_after_the_rename_counts_as_written(money_gw, monkeypatch):
    """Kimi r1ab.2's sharpest point: once os.replace succeeded the new keyring is the file. A failed folder fsync after
    it is logged and not raised, so _commit never restores memory to the old keyring while the file holds the new.
    Fail-before (be0b7a6a): update_key raised and memory said KO while the file said KA."""
    from hive.core import providers as pmod
    hive = money_gw["hive"]
    hive.keyring.ring["defaults"]["openrouter"] = KO
    hive.keyring._write()
    real, n = pmod.os.fsync, {"n": 0}

    def fsync(fd):
        n["n"] += 1
        if n["n"] == 2:                  # 1: the temp file, before the rename; 2: the folder, after it
            raise OSError("disk full")
        return real(fd)
    monkeypatch.setattr(pmod.os, "fsync", fsync)
    hive.keyring.update_key(KA, default=True)
    assert hive.keyring.ring["defaults"]["openrouter"] == KA
    assert json.loads(hive.keyring.path.read_text())["defaults"]["openrouter"] == KA


def test_r1ab3_kimi_4_a_keyring_change_inside_a_keyring_change_is_refused(money_gw):
    hive = money_gw["hive"]
    before = json.dumps(hive.keyring.ring, sort_keys=True)
    with pytest.raises(RuntimeError):
        hive.keyring._commit(lambda: hive.keyring.update_key(KA, label="nested"))
    assert json.dumps(hive.keyring.ring, sort_keys=True) == before


# ---- r1ab.4 (Dot's T-KEY1 ruling): a failed raise is a retryable 503, and an identical retry completes it ----------

def _fail_raise_once(hive, monkeypatch):
    real, n = hive.ownhive.set_limit, {"n": 0}

    def set_limit(*a, **k):
        n["n"] += 1
        if n["n"] == 1:
            raise sqlite3.OperationalError("disk I/O error")
        return real(*a, **k)
    monkeypatch.setattr(hive.ownhive, "set_limit", set_limit)


def test_r1ab4_an_identical_retry_after_a_failed_raise_completes_with_200_and_the_raised_total(money_gw, monkeypatch,
                                                                                                caplog):
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    calls = []
    _verify_stub(hive, calls)
    hive.keyring.ring["defaults"]["openrouter"] = KO
    total(hive, O, 5.0)
    _fail_raise_once(hive, monkeypatch)
    caplog.set_level("DEBUG")
    req = {"provider": "openrouter", "key": "sk-or-retry-material", "default": True, "month_usd": 50}
    first = client.post("/api/keys", headers=owner, json=req)
    assert (first.status_code, first.json()["error"]["monthly_total_usd"]) == (503, 5.0)
    again = client.post("/api/keys", headers=owner, json=req)
    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["error"]["key_id"] and again.json()["default"] is True
    assert _total(hive, O) == 50.0 and calls == ["openrouter"]   # stored and verified once, never added twice
    assert [r["secret"] for r in hive.keyring.ring["keys"].values()].count("sk-or-retry-material") == 1
    # nothing logged, and no answer, carries the key material
    assert "sk-or-retry-material" not in caplog.text
    assert "sk-or-retry-material" not in first.text + again.text


def test_r1ab4_an_identical_retry_of_a_lowering_or_a_completed_request_is_200_and_never_raises(money_gw):
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    total(hive, O, 50.0)
    req = {"provider": "openrouter", "key": "sk-or-lower", "month_usd": 20}
    a = client.post("/api/keys", headers=owner, json=req)
    b = client.post("/api/keys", headers=owner, json=req)
    assert (a.status_code, b.status_code) == (200, 200) and a.json()["id"] == b.json()["id"] and _total(hive, O) == 20


def test_r1ab4_the_same_material_from_another_person_is_their_own_row_and_with_the_flag_unset_is_duplicate_key(money_gw,
                                                                                                               monkeypatch):
    client, hive, owner, pat = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["pat"]
    calls = []
    _verify_stub(hive, calls)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-mine"})
    assert r.status_code == 200
    first = r.json()["id"]
    # sol on 46f13f98: duplicates are per owner. Another person's copy is verified and stored as THEIR row, and their
    # total is written as for any new key; nothing tells them the owner holds the same secret
    r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-mine", "month_usd": 5})
    assert r.status_code == 200 and r.json()["id"] != first and "sk-or-mine" not in r.text
    assert hive.keyring.ring["keys"][r.json()["id"]]["owner"] == money_gw["P"] and len(calls) == 2
    assert float(hive.ownhive.total_row(money_gw["P"])["month_usd"]) == 5.0
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-mine"})
    assert (r.status_code, r.json()["error"]["code"]) == (409, "duplicate_key")   # as on 56b2dbfc


def test_r1ab4_own_key_compares_in_constant_time_and_only_the_owners_own_key(money_gw, monkeypatch):
    from hive.core import providers as pmod
    hive = money_gw["hive"]
    seen = []
    real = pmod.hmac.compare_digest

    def compare(a, b):
        seen.append(1)
        return real(a, b)
    monkeypatch.setattr(pmod.hmac, "compare_digest", compare)
    secret = hive.keyring.ring["keys"][KA]["secret"]
    assert hive.keyring.own_key("openrouter", secret, money_gw["P"]) == KA
    assert hive.keyring.own_key("openrouter", secret, money_gw["O"]) is None
    assert hive.keyring.own_key("openrouter", secret + "x", money_gw["P"]) is None
    assert len(seen) == 3 * len(hive.keyring.ring["keys"])   # every record compared, whatever matched


# ---- r1ab.5 (Dot's ruling on the stand-in r1ab.4 P1s; Kimi r1ab.4 #3, #5) ------------------------------------------

@pytest.mark.parametrize("when", ["at_the_write", "before_the_decision"])
def test_r1ab5_standin_p1_1_a_total_set_meanwhile_is_never_overwritten_by_a_stale_lowering(money_gw, monkeypatch, when):
    """The stand-in's exact interleaving: $50; A decides $20 is a lowering; B writes $5; A writes $20; A fails key
    verification. at_the_write: B is a real concurrent writer (its own thread) arriving as A writes. A decides and
    writes in one transaction, so B waits for its commit and lands after it: $5. before_the_decision: B lands first; A's
    decision reads $5, $20 is no lowering, nothing is written early, and A fails before any raise: $5.
    Fail-before (9a3e3f0e), at_the_write: A's stale decision wrote $20 after B's $5, and A added no key."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    total(hive, O, 50.0)
    b = threading.Thread(target=total, args=(hive, O, 5.0))
    if when == "at_the_write":
        real = hive.ownhive.set_limit

        def set_limit(*a, **k):
            b.start()
            b.join(0.5)                  # done at once with no transaction open; else it waits for A's commit
            return real(*a, **k)
        monkeypatch.setattr(hive.ownhive, "set_limit", set_limit)
    else:
        real = hive.ownhive.check_total

        def check_total(*a, **k):
            real(*a, **k)
            b.start()
            b.join()
        monkeypatch.setattr(hive.ownhive, "check_total", check_total)

    async def verify(name, key):
        raise ProviderError(400, "bad_key", "that key was refused")
    hive.providers.verify = verify
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-stale", "month_usd": 20})
    b.join()
    assert r.status_code == 400 and _total(hive, O) == 5.0
    assert all(r["secret"] != "sk-or-stale" for r in hive.keyring.ring["keys"].values())


@pytest.mark.parametrize("theirs", [8.0, 50.0, 100.0])
def test_r1ab5_raise_last_leaves_a_total_set_meanwhile_and_says_so_in_the_200(money_gw, monkeypatch, theirs):
    """The raise-last counterpart: $5; A asks for $50 (a raise, written last); while A switches the default, B sets
    $8 (or $50, or $100). A's last write finds the live total changed since it first read it: B's stands. The key is
    added (200) with monthly_total_applied false (true only when B's equals A's) and the total that governs.
    Fail-before (9a3e3f0e): A's $50 overwrote B's $8 and $100."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    total(hive, O, 5.0)
    real = hive.keyring.update_key

    def update_key(*a, **k):
        total(hive, O, theirs)
        return real(*a, **k)
    monkeypatch.setattr(hive.keyring, "update_key", update_key)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-meanwhile",
                                                     "default": True, "month_usd": 50})
    assert r.status_code == 200, r.text
    assert (r.json()["monthly_total_applied"], r.json()["monthly_total_usd"]) == (theirs == 50.0, theirs)
    assert _total(hive, O) == theirs and r.json()["default"] is True


def test_r1ab5_an_applied_total_says_so(money_gw):
    client, hive, pat, P = money_gw["client"], money_gw["hive"], money_gw["pat"], money_gw["P"]
    _verify_stub(hive, [])
    r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-applied", "month_usd": 9})
    assert (r.json()["monthly_total_applied"], r.json()["monthly_total_usd"]) == (True, 9.0)


@pytest.mark.parametrize("prior", [5.0, 50.0])
def test_r1ab5_standin_p1_2_a_notice_failing_after_the_commit_never_turns_a_written_total_into_an_error(money_gw,
                                                                                                       monkeypatch,
                                                                                                       prior):
    """$5 → $50 (written last) or $50 → $20 (written first), and the budgets notice raises after the commit.
    Committed is committed: 200, applied, and the total is the new one. Fail-before (9a3e3f0e): 503 limit_not_raised
    although the cap was $50 (and a raw error for the lowering)."""
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    total(hive, O, prior)
    want = 50.0 if prior == 5.0 else 20.0

    def announce():
        raise RuntimeError("notice failed")
    monkeypatch.setattr(hive.ownhive, "_announce", announce)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-notice",
                                                     "month_usd": want})
    assert r.status_code == 200, r.text
    assert (r.json()["monthly_total_applied"], r.json()["monthly_total_usd"]) == (True, want)
    assert _total(hive, O) == want


def test_r1ab5_write_total_returns_only_once_committed_and_raises_only_before(money_gw, monkeypatch):
    """The distinction in code: write_total returns (written, seen) once its transaction committed, whatever its notices
    do; a failure before the commit raises and leaves the row as it was."""
    hive, P = money_gw["hive"], money_gw["P"]
    total(hive, P, 5.0)
    me = type("V", (), {"principal": P})()
    written, seen = hive.ownhive.write_total(me, 7)
    assert written is False and _total(hive, P) == 5.0          # a raise: nothing written first
    real = hive.ownhive._announce
    monkeypatch.setattr(hive.ownhive, "_announce", lambda: (_ for _ in ()).throw(RuntimeError("notice failed")))
    assert hive.ownhive.write_total(me, 7, seen)[0] is True and _total(hive, P) == 7.0
    monkeypatch.setattr(hive.ownhive, "_announce", real)
    total(hive, P, 5.0)
    written, seen = hive.ownhive.write_total(me, 7)

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(hive.ownhive, "_write_limit", boom)
    with pytest.raises(sqlite3.OperationalError):
        hive.ownhive.write_total(me, 7, seen)
    assert _total(hive, P) == 5.0


def test_r1ab5_kimi_3_a_retry_whose_default_switch_fails_keeps_the_key_it_found(money_gw, monkeypatch):
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"]["openrouter"] = KO
    total(hive, O, 5.0)
    _fail_raise_once(hive, monkeypatch)
    req = {"provider": "openrouter", "key": "sk-or-found", "default": False, "month_usd": 50}
    first = client.post("/api/keys", headers=owner, json=req)
    assert first.status_code == 503
    key_id = first.json()["error"]["key_id"]

    def switch(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(hive.keyring, "update_key", switch)
    with pytest.raises(OSError):
        client.post("/api/keys", headers=owner, json={**req, "default": True})
    assert key_id in hive.keyring.ring["keys"] and hive.keyring.ring["defaults"]["openrouter"] == KO


def test_r1ab5_kimi_5_a_refusal_in_the_last_write_is_not_retryable_and_the_503_total_is_rounded(money_gw, monkeypatch):
    client, hive, owner, O = money_gw["client"], money_gw["hive"], money_gw["owner"], money_gw["O"]
    _verify_stub(hive, [])
    total(hive, O, 5.1234567)

    def refuse(*a, **k):
        raise HiveError(403, "key_owner_only", "Only the person who owns that key sets its limits.")
    monkeypatch.setattr(hive.ownhive, "set_limit", refuse)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-403", "month_usd": 50})
    assert (r.status_code, r.json()["error"]["code"]) == (403, "key_owner_only")

    def boom(*a, **k):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(hive.ownhive, "set_limit", boom)
    r = client.post("/api/keys", headers=owner, json={"provider": "openrouter", "key": "sk-or-503", "month_usd": 50})
    assert (r.status_code, r.json()["error"]["monthly_total_usd"]) == (503, 5.123457)


def test_r1ab2_flag_unset_month_usd_is_ignored_as_on_live(money, monkeypatch):
    """Control (passes on 56b2dbfc): with HIVE_MIND_GATEWAY unset POST /api/keys ignores month_usd. No limit is written,
    an existing lower total is untouched, and the first key of a provider still becomes its default inside add_key."""
    client, hive, pat, P = money["client"], money["hive"], money["pat"], money["P"]
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    _verify_stub(hive, [])
    hive.keyring.ring["defaults"].pop("openrouter", None)
    total(hive, P, 5.0)
    r = client.post("/api/keys", headers=pat, json={"provider": "openrouter", "key": "sk-or-flag-off", "month_usd": 50})
    assert r.status_code == 200 and r.json()["default"] is True
    assert hive.ownhive.total_row(P)["month_usd"] == 5.0
    assert hive.db.one("SELECT COUNT(*) AS n FROM key_limits")["n"] == 1


# ---- the shared helpers (r1.1 §A, plan §2.2): one implementation for the conductor and the gateway --------------------

def test_the_limit_detail_helpers_are_module_level_and_shared(money):
    hive, mine = money["hive"], money["mine"]
    c = hive.ask.conductor
    e = HiveError(402, "spend_limit", "x", {"scope": "person:" + PAT, "period": "month", "limit_usd": 5, "spent_usd": 4})
    assert c._check_detail(mine, e, 0.1) == cmod.check_detail(hive, mine, e, 0.1)
    assert cmod.check_detail(hive, mine, e, 0.1)["kind"] == "member_allowance"
    b = BudgetExhausted("askturn:at_1", 0.25, 0.2, 0.05, 0.1)
    assert c._reserve_detail(mine, b) == cmod.reserve_detail(hive, b) and cmod.reserve_detail(hive, b)["kind"] == "per_turn"


class _Res:
    """A reservation ledger stand-in that records what the helper did."""
    def __init__(self):
        self.log = []

    def dispatch(self, rid):
        self.log.append(("dispatch", rid))

    def abort_before_dispatch(self, rid):
        self.log.append(("release", rid))


class _Transport:
    """A provider whose 'connection' is blocked until released, then awaits the send gate as httpcore does."""
    def __init__(self):
        self.sent, self.release = [], None

    async def chat(self, agent, body):
        from hive.core.gateway import signal_send
        await self.release.wait()        # waiting for a pooled connection
        await signal_send()              # send_request_headers.started: may abort, nothing sent
        self.sent.append(body)
        return {"choices": [{"message": {"content": "ok"}}]}, {"cost_usd": 0.01}


def _run(coro):
    return asyncio.run(coro)


def test_T_GATE_mechanism_a_close_while_the_connection_is_blocked_sends_nothing_and_releases():
    from hive.core.gated_call import GateClosed, gated_chat

    async def scenario():
        tr, res, open_ = _Transport(), _Res(), {"v": True}
        tr.release = asyncio.Event()
        g = gated_chat(tr, res, {"id": "a"}, {"m": 1}, "r1", lambda: open_["v"])
        task = asyncio.ensure_future(g.run())
        await asyncio.sleep(0.01)
        open_["v"] = False               # Stop / expiry / revocation lands while it waits for the connection
        tr.release.set()
        with pytest.raises(GateClosed):
            await task
        g.release()
        return tr, res, g
    tr, res, g = _run(scenario())
    assert tr.sent == [] and g.started is False and res.log == [("release", "r1")]


def test_T_GATE_mechanism_a_passing_gate_dispatches_once_and_a_later_close_never_releases():
    from hive.core.gated_call import gated_chat

    async def scenario():
        tr, res, open_ = _Transport(), _Res(), {"v": True}
        tr.release = asyncio.Event()
        tr.release.set()
        g = gated_chat(tr, res, {"id": "a"}, {"m": 1}, "r2", lambda: open_["v"])
        out = await g.run()
        open_["v"] = False               # the turn closes after the call was sent: it stays a liability
        g.release()
        return tr, res, g, out
    tr, res, g, out = _run(scenario())
    assert len(tr.sent) == 1 and g.started is True and out[1]["cost_usd"] == 0.01
    assert res.log == [("dispatch", "r2")]


def test_T_GATE_mechanism_a_still_valid_that_raises_aborts_with_its_own_exception():
    """The conductor's still_valid raises its own _Closed (its loop's close path); the helper lets it through."""
    from hive.core.gated_call import gated_chat

    def closed():
        raise cmod._Closed()

    async def scenario():
        tr, res = _Transport(), _Res()
        tr.release = asyncio.Event()
        tr.release.set()
        g = gated_chat(tr, res, {"id": "a"}, {}, None, closed)
        with pytest.raises(cmod._Closed):
            await g.run()
        return tr, g
    tr, g = _run(scenario())
    assert tr.sent == [] and g.started is False


def test_T_GATE_mechanism_the_gate_yields_once_after_dispatch_before_the_write():
    """r1ab.2: GatedCall.gate has the live conductor's commitment point (omegahive#9): once dispatched it yields one loop
    step before the transport writes, so a close committed in that step is seen before the bytes leave."""
    from hive.core.gated_call import gated_chat

    async def scenario():
        tr, res, order, at_gate = _Transport(), _Res(), [], []
        tr.release = asyncio.Event()
        tr.release.set()

        def still_valid():
            at_gate.append(1)
            if len(at_gate) == 2:        # the gate's own check: a step queued now runs in the gate's yield
                asyncio.get_running_loop().call_soon(order.append, "loop step")
            return True
        g = gated_chat(tr, res, {"id": "a"}, {"m": 1}, "r3", still_valid)
        real = tr.chat

        async def chat(agent, body):
            out = await real(agent, body)
            order.append("sent")
            return out
        tr.chat = chat
        await g.run()
        return res, order
    res, order = _run(scenario())
    assert res.log == [("dispatch", "r3")] and order == ["loop step", "sent"]


def test_T_GATE_mechanism_the_conductor_keeps_its_live_gate_and_the_helper_matches_it():
    """r1ab.2 (Dot's ruling): the conductor's live send gate (gate/go/release, omegahive#9) is not moved onto
    gated_call.py in this round. Both yield once after dispatch, and the limit-detail helpers are the shared ones."""
    import inspect
    from hive.core import gated_call
    src = inspect.getsource(cmod.Conductor._model)
    assert "SEND_GATE.set(gate)" in src and "gated_chat(" not in src
    assert "self.reservations.dispatch(reservation)\n            started = True\n            await asyncio.sleep(0)" in src
    gsrc = inspect.getsource(gated_call.GatedCall.gate)
    assert "self.reservations.dispatch(self.reservation)\n        self.started = True\n        await asyncio.sleep(0)" in gsrc
    assert "return check_detail(self.hive" in inspect.getsource(cmod.Conductor._check_detail)
    assert "return reserve_detail(self.hive" in inspect.getsource(cmod.Conductor._reserve_detail)


# =====================================================================================================================
# r1b: the Ask route (browser_mind), /done, deadlines, the preference and the flag
# =====================================================================================================================

from hive.core import ask as amod  # noqa: E402
from hive.tests.test_ask import ask, counts, world  # noqa: E402
from hive.tests.test_ask_conductor import Script, script  # noqa: E402

ORIGIN = {"Origin": "http://127.0.0.1:8700"}
BROWSER = {"answer_in": "browser"}


@pytest.fixture()
def bw(client, monkeypatch):  # noqa: F811
    """HIVE_MIND_GATEWAY=1, conductor off; Ann (a member) and Jon (an admin) each have their personal mind (asleep)."""
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    w = world(client)
    hive = w["hive"]
    w["mine"] = hive.personal.ensure("user:u_ann")
    w["jons"] = hive.personal.ensure("user:u_jon")
    w["client"] = client
    return w


def turn(hive, op, principal="user:u_ann"):
    return hive.db.one("SELECT * FROM ask_turns WHERE operation_id = ? AND principal = ?", (op, principal))


def stored_frames(hive, op, principal="user:u_ann"):
    t = turn(hive, op, principal)
    return [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (t["id"],))]


def done_post(client, headers, op, outcome, **extra):  # noqa: F811
    return client.post(f"/api/ask/{op}/done", headers={**headers, **ORIGIN}, json={"outcome": outcome, **extra})


# ---- T-RT1/2: flag and preference on, marker present: a browser turn; nothing reaches the room, hub or conductor ------

def test_T_RT1_a_marked_ask_to_the_personal_mind_is_a_browser_turn(bw):
    client, hive, mine = bw["client"], bw["hive"], bw["mine"]
    before = counts(hive)
    starts = list(client.supervisor.calls)
    r = ask(client, bw["ann"], "op-bw-rt1-01", text="private words", **BROWSER)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["route"] == "browser_mind" and body["state"] == "browser" and body["cap_usd"] == 0.25
    assert body["acting_as"] == {"mind_id": mine["id"], "name": mine["name"]} and "conductor" not in body
    assert body["thread"]["mind"]["id"] == mine["id"] and body["text"] == ""
    t = turn(hive, "op-bw-rt1-01")
    assert (t["state"], t["route"], t["personal"], t["calls"], t["text"], t["context_resolved"]) == \
        ("browser", "browser_mind", 1, 0, "", "{}")
    assert t["last_call_at"] is not None and t["deadline"] - time.time() > 590
    after = counts(hive)
    assert after["room_messages"] == before["room_messages"] and after["messages"] == before["messages"]
    assert hive.agent(mine["id"])["status"] == "asleep" and client.supervisor.calls == starts   # never woken
    assert hive.db.one("SELECT cap_scope FROM work_sessions WHERE id = ?", (t["thread_id"],))["cap_scope"] == "thread"
    assert [f["phase"] for f in stored_frames(hive, "op-bw-rt1-01")] == ["accepted"]


def test_T_RT2_also_with_the_conductor_on_no_conductor_runs(bw, monkeypatch):
    client, hive = bw["client"], bw["hive"]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    s = script(client, Script("never", repeat_last=True))
    r = ask(client, bw["ann"], "op-bw-rt2-01", **BROWSER)
    assert r.status_code == 202, r.text and r.json()["route"] == "browser_mind"
    time.sleep(0.2)
    assert s.bodies == [] and not hive.ask.conductor.tasks and turn(hive, "op-bw-rt2-01")["conductor_model"] is None
    assert turn(hive, "op-bw-rt2-01")["state"] == "browser"


# ---- T-RT5 (r1.1 §E): the marker is required, and the carve-out is only for the asker's own personal mind ---------------

def test_T_RT5_no_marker_is_routed_exactly_as_today_with_the_preference_on(bw, monkeypatch):
    client, hive = bw["client"], bw["hive"]
    r = ask(client, bw["ann"], "op-bw-rt5-01")                          # conductor off: the personal mind is asleep
    assert (r.status_code, r.json()["error"]["code"]) == (409, "mind_asleep")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    script(client, Script("ok", repeat_last=True))
    r = ask(client, bw["ann"], "op-bw-rt5-02")                          # conductor on: a conductor turn, as today
    assert r.status_code == 202 and "route" not in r.json() and "conductor" in r.json()   # speaking as the mind, its model
    assert turn(hive, "op-bw-rt5-02")["route"] is None and turn(hive, "op-bw-rt5-02")["conductor_model"]


def test_T_RT5_answer_in_with_an_ab_pick_is_invalid_and_an_ab_pick_is_never_a_browser_turn(bw, monkeypatch):
    client = bw["client"]
    r = ask(client, bw["jon"], "op-bw-rt5-03", conductor={"model": "mock/conductor"}, **BROWSER)
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid")          # conductor off
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    script(client, Script("ok", repeat_last=True))
    r = ask(client, bw["jon"], "op-bw-rt5-04", conductor={"model": "mock/conductor"}, **BROWSER)
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid")          # conductor on
    r = ask(client, bw["jon"], "op-bw-rt5-05", conductor={"model": "mock/conductor"})   # the admin's own personal mind
    assert r.status_code == 202 and "route" not in r.json() and r.json()["acting_as"]["mind_id"] == bw["jons"]["id"]
    assert ask(client, bw["ann"], "op-bw-rt5-06", answer_in="page").status_code == 400  # one value only


def test_T_RT5_answer_in_to_any_other_mind_is_not_available_and_mind_asleep_stays(bw):
    client, hive = bw["client"], bw["hive"]
    before = counts(hive)
    for op, extra in (("op-bw-rt5-07", {"context": {"swarm_id": bw["swarm"]["id"]}}),     # an awake coordinator
                      ("op-bw-rt5-08", {"context": {"mind": bw["worker"]["id"]}})):       # addressed in that swarm
        r = ask(client, bw["ann"], op, **extra, **BROWSER)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "not_available"), r.text
    hive.db.execute("UPDATE agents SET status = 'asleep' WHERE id = ?", (bw["coord"]["id"],))
    r = ask(client, bw["ann"], "op-bw-rt5-09", context={"swarm_id": bw["swarm"]["id"]}, **BROWSER)
    assert (r.status_code, r.json()["error"]["code"]) == (409, "not_available")
    r = ask(client, bw["ann"], "op-bw-rt5-10", context={"swarm_id": bw["swarm"]["id"]})   # no marker: mind_asleep, as today
    assert (r.status_code, r.json()["error"]["code"]) == (409, "mind_asleep")
    assert counts(hive)["ask_turns"] == before["ask_turns"]


def test_T_RT5_preference_off_refuses_the_marker(bw):
    client = bw["client"]
    assert client.post("/api/me/mind", headers=bw["ann"], json={"browser_mind": False}).status_code == 200
    r = ask(client, bw["ann"], "op-bw-rt5-11", **BROWSER)
    assert (r.status_code, r.json()["error"]["code"]) == (409, "not_available")


def test_T_RT5_a_browser_turn_takes_no_steer_and_no_takeover(bw):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-rt5-12", **BROWSER)
    before = counts(hive)
    r = client.post("/api/ask/op-bw-rt5-12/steer", headers=bw["ann"], json={"steer_id": "st-0001", "text": "more", "at_seq": 1})
    assert (r.status_code, r.json()["error"]["code"]) == (404, "not_available")
    assert client.post("/api/ask/op-bw-rt5-12/takeover", headers=bw["ann"]).status_code == 404
    assert counts(hive) == before and turn(hive, "op-bw-rt5-12")["state"] == "browser"


# ---- T-RT4: the thread stays under its own cap; browser turns are not "mixed" history -----------------------------------

def test_T_RT4_the_thread_stays_thread_scoped_and_is_not_mixed(bw):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-rt4-01", **BROWSER)
    assert done_post(client, bw["ann"], "op-bw-rt4-01", "answered").status_code == 200
    t = turn(hive, "op-bw-rt4-01")
    thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
    assert thread["cap_scope"] == "thread" and hive.sessions._mixed(thread) is False
    hive.sessions.rescope(t["mind_id"], "thread")
    assert hive.db.one("SELECT cap_scope FROM work_sessions WHERE id = ?", (t["thread_id"],))["cap_scope"] == "thread"
    assert ask(client, bw["ann"], "op-bw-rt4-02", **BROWSER).json()["thread"]["id"] == thread["id"]   # the same thread
    assert hive.ask._turns(t["mind_id"], -1) == []                      # never reached the mind: no trace audience


# ---- T-PREF / T-PREF2: one setting, on by default ---------------------------------------------------------------------

def test_T_PREF_browser_mind_alone_is_accepted_and_read_back(bw, monkeypatch):
    client = bw["client"]
    r = client.post("/api/me/mind", headers=bw["ann"], json={"browser_mind": False})
    assert r.status_code == 200, r.text
    assert r.json()["mind"]["browser_mind"] is False and r.json()["created"] is False
    got = client.get("/api/me/mind", headers=bw["ann"]).json()
    assert got["mind"]["browser_mind"] is False
    assert got["capabilities"] == {"gateway": True, "browser_mind": False, "windows": False, "device_inbox": False}
    r = client.post("/api/me/mind", headers=bw["ann"], json={"browser_mind": True, "name": "Annie"})
    assert r.json()["mind"]["browser_mind"] is True and r.json()["mind"]["name"] == "Annie"
    for bad in ({"browser_mind": 1}, {"browser_mind": "yes"}, {}, {"other": True}):
        assert client.post("/api/me/mind", headers=bw["ann"], json=bad).status_code == 400
    # r1d's frame (hive.mind_frame.available()) is what makes the capability true; fail-closed otherwise. Stubbed here
    # whether the flag was on at boot (a real MindFrame with no built frame) or off (None); the real path is r1d.2's test.
    monkeypatch.setattr(bw["hive"], "mind_frame", SimpleNamespace(available=lambda: True), raising=False)
    assert client.get("/api/me/mind", headers=bw["ann"]).json()["capabilities"]["browser_mind"] is True
    monkeypatch.setattr(bw["hive"], "mind_frame", SimpleNamespace(available=lambda: 1 / 0), raising=False)
    assert client.get("/api/me/mind", headers=bw["ann"]).json()["capabilities"]["browser_mind"] is False


def test_T_PREF2_a_new_person_reads_on_and_their_first_marked_ask_is_a_browser_turn(bw):
    client, hive = bw["client"], bw["hive"]
    newcomer = person(client, "u_new")
    assert hive.db.one("SELECT * FROM mind_prefs WHERE principal = 'user:u_new'") is None
    assert client.get("/api/me/mind", headers=newcomer).json()["mind"]["browser_mind"] is True
    r = ask(client, newcomer, "op-bw-pref2-1", **BROWSER)
    assert r.status_code == 202 and r.json()["route"] == "browser_mind"


# ---- T-DONE: the close words, the host's limit, idempotent, releases nothing ------------------------------------------

@pytest.mark.parametrize("word,state,outcome", [("answered", "done", "complete"), ("incomplete", "done", "incomplete"),
                                                ("spend_cap", "refused", "spend_cap"), ("failed", "refused", "error"),
                                                ("stopped", "refused", "cancelled")])
def test_T_DONE_each_close_word_maps_to_its_stored_outcome(bw, word, state, outcome):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-done-1", **BROWSER)
    r = done_post(client, bw["ann"], "op-bw-done-1", word)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == state and r.json()["route"] == "browser_mind" and r.json()["month_remaining_usd"] is None
    fs = stored_frames(hive, "op-bw-done-1")
    assert [f["phase"] for f in fs] == ["accepted", "done"] and fs[-1]["outcome"] == outcome
    if word == "spend_cap":   # the host's own limit: the thread is not spent, so it cannot name one
        assert fs[-1]["limit"] == {"kind": "unknown", "current_usd": None, "limit_usd": None, "estimate_usd": None}
    else:
        assert "limit" not in fs[-1]
    # idempotent: a repeat, or another word, answers the turn as it stands
    again = done_post(client, bw["ann"], "op-bw-done-1", "answered")
    assert again.status_code == 200 and again.json()["state"] == state and len(stored_frames(hive, "op-bw-done-1")) == 2


def test_T_DONE_spend_cap_names_the_hosts_thread_limit_when_the_thread_is_spent(bw):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-done-2", **BROWSER)
    t = turn(hive, "op-bw-done-2")
    hive.db.execute("UPDATE work_sessions SET carried_usd = 0.25 WHERE id = ?", (t["thread_id"],))   # spent by its measure
    done_post(client, bw["ann"], "op-bw-done-2", "spend_cap")
    assert stored_frames(hive, "op-bw-done-2")[-1]["limit"] == {"kind": "thread", "current_usd": 0.25, "limit_usd": 0.25,
                                                                "estimate_usd": None}


def test_T_DONE_gates_owner_only_browser_only_and_body_shape(bw):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-done-3", **BROWSER)
    assert client.post("/api/ask/op-bw-done-3/done", headers=bw["ann"], json={"outcome": "answered"}).status_code == 403
    assert client.post("/api/ask/op-bw-done-3/done", headers={**bw["ann"], "Origin": "null"},
                       json={"outcome": "answered"}).status_code == 403
    assert client.post("/api/ask/op-bw-done-3/done", headers={**bw["ann"], "Origin": "https://evil.example"},
                       json={"outcome": "answered"}).status_code == 403
    assert done_post(client, bw["jon"], "op-bw-done-3", "answered").status_code == 404     # someone else's turn
    for bad in ({"outcome": "complete"}, {"outcome": "answered", "limit": {"kind": "thread"}}):
        r = client.post("/api/ask/op-bw-done-3/done", headers={**bw["ann"], **ORIGIN}, json=bad)
        assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid")
    assert turn(hive, "op-bw-done-3")["state"] == "browser"
    hive.db.execute("UPDATE agents SET status = 'awake' WHERE id = ?", (bw["coord"]["id"],))
    ask(client, bw["ann"], "op-bw-done-4", context={"swarm_id": bw["swarm"]["id"]})           # an ordinary turn
    assert done_post(client, bw["ann"], "op-bw-done-4", "answered").status_code == 404


def test_T_DONE_releases_nothing(bw):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-done-5", **BROWSER)
    t = turn(hive, "op-bw-done-5")
    res = hive.ask.conductor.reservations
    res.reserve("held-1", {"x": 1}, 0.1, lambda: [("askturn:" + t["id"], 1, 0)], {"agent": t["mind_id"]}, dispatched=True)
    res.unknown("held-1")
    res.reserve("held-2", {"x": 2}, 0.1, lambda: [("askturn:" + t["id"], 1, 0)], {"agent": t["mind_id"]})
    done_post(client, bw["ann"], "op-bw-done-5", "stopped")
    assert res.get("held-1")["state"] == "unknown" and res.get("held-2")["state"] == "reserved"


# ---- T-EXP: idle and absolute deadlines close time_cap ------------------------------------------------------------

def test_T_EXP_idle_and_absolute_deadlines_close_time_cap(bw, monkeypatch):
    client, hive = bw["client"], bw["hive"]
    ask(client, bw["ann"], "op-bw-exp-1", **BROWSER)
    t = turn(hive, "op-bw-exp-1")
    hive.ask.expire(time.time() + 60)                                    # within 120 s idle: still open
    assert turn(hive, "op-bw-exp-1")["state"] == "browser"
    busy = ask(client, bw["ann"], "op-bw-exp-2", **BROWSER)              # one turn at a time on the thread
    assert busy.json()["error"]["code"] == "ask_busy"
    hive.db.execute("UPDATE ask_turns SET last_call_at = ? WHERE id = ?", (time.time() - 121, t["id"]))   # a closed tab
    r = ask(client, bw["ann"], "op-bw-exp-3", **BROWSER)                 # the idle rule frees ask_busy
    assert r.status_code == 202, r.text
    assert stored_frames(hive, "op-bw-exp-1")[-1]["outcome"] == "time_cap"
    t3 = turn(hive, "op-bw-exp-3")
    monkeypatch.setenv("HIVE_ASK_BROWSER_IDLE_SECONDS", "100000")
    hive.ask.expire(t3["deadline"] - 1)
    assert turn(hive, "op-bw-exp-3")["state"] == "browser"
    hive.ask.expire(t3["deadline"] + 1)                                  # the absolute 600 s deadline
    fs = stored_frames(hive, "op-bw-exp-3")
    assert turn(hive, "op-bw-exp-3")["reason"] == "timed_out" and fs[-1]["outcome"] == "time_cap"
    assert t3["deadline"] - t3["last_call_at"] == pytest.approx(600, abs=2)


# ---- T-OUT (r1.1 §I): one outcome map for the conductor and the browser -------------------------------------------

@pytest.mark.parametrize("reason", ["stopped", "takeover", "timed_out", "spend_limit", "answered", "incomplete", "failed",
                                    "not_available"])
@pytest.mark.parametrize("spent", [False, True])
def test_T_OUT_conductor_and_browser_closes_store_the_same_outcome_and_limit(bw, reason, spent):
    client, hive = bw["client"], bw["hive"]
    seen = {}
    for i, kind in enumerate(("browser", "conducting")):
        op = f"op-bw-out-{i}"
        hive.db.execute("UPDATE work_sessions SET carried_usd = 0")
        assert ask(client, bw["ann"], op, **BROWSER).status_code == 202
        t = turn(hive, op)
        if kind == "conducting":   # the same row as a conductor turn (no loop is running for it)
            hive.db.execute("UPDATE ask_turns SET state = 'conducting', route = NULL, conductor_model = 'mock/c' WHERE id = ?", (t["id"],))
        hive.db.execute("UPDATE work_sessions SET carried_usd = ? WHERE id = ?", (0.25 if spent else 0.0, t["thread_id"]))
        assert hive.ask._close(t["id"], "refused", reason)
        last = stored_frames(hive, op)[-1]
        seen[kind] = (last["phase"], last["outcome"], last.get("limit"), last.get("taken_over"))
    assert seen["browser"] == seen["conducting"]
    assert seen["browser"][1] == amod.CLOSE_OUTCOME.get(reason, "error")
    assert set(amod.CLOSE_OUTCOME.values()) <= set(cmod.OUTCOMES) and "incomplete" in cmod.OUTCOMES


# ---- T-LIT (r1.1 §H): no turn-state tuple outside OPEN and OPEN_HOST_MIND ---------------------------------------------

def test_T_LIT_no_inline_turn_state_tuple_in_hive_core():
    import ast
    import pathlib
    import re
    states = {"accepted", "thinking", "conducting", "browser", "done", "refused"}
    open_words = {"accepted", "thinking", "conducting", "browser"}   # a tuple of turn states names at least one of these
    sql = re.compile(r"\bstate\s+(?:NOT\s+)?IN\s*\(([^)]*)\)", re.I)
    assert amod.OPEN == ("accepted", "thinking", "conducting", "browser") and amod.OPEN_HOST_MIND == ("accepted", "thinking")
    found = []
    core = pathlib.Path(amod.__file__).parent
    for path in sorted(core.glob("*.py")):
        tree = ast.parse(path.read_text())
        allowed = set()
        if path.name == "ask.py":
            for node in tree.body:
                if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ("OPEN", "OPEN_HOST_MIND")
                                                        for t in node.targets):
                    allowed.add(id(node.value))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Tuple, ast.List, ast.Set)) and id(node) not in allowed and len(node.elts) >= 2 and all(
                    isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.elts):
                if {e.value for e in node.elts} <= states and {e.value for e in node.elts} & open_words:
                    found.append((path.name, node.lineno, [e.value for e in node.elts]))
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                for m in sql.finditer(node.value):
                    words = set(re.findall(r"'([a-z_]+)'", m.group(1)))
                    if words & {"accepted", "thinking", "conducting", "browser"}:
                        found.append((path.name, node.lineno, m.group(0)))
    assert found == []


# ---- T-PRIV (the words part; the token is r1c): no table holds a browser turn's words ---------------------------------

def test_T_PRIV_no_table_holds_a_browser_turns_words(bw):
    client, hive = bw["client"], bw["hive"]
    words = "zebra-quartz-unique-words"
    ask(client, bw["ann"], "op-bw-priv-1", text=words, context={"route": "/minds/" + words}, **BROWSER)
    done_post(client, bw["ann"], "op-bw-priv-1", "answered")
    for t in hive.db.all("SELECT name FROM sqlite_master WHERE type = 'table'"):
        for row in hive.db.all(f'SELECT * FROM "{t["name"]}"'):
            assert words not in json.dumps(row, default=str), t["name"]


# ---- the money view on the 202 ------------------------------------------------------------------------------------

def test_the_202_carries_route_turn_guard_and_the_monthly_totals_room(bw):
    from hive.core.config import Provider
    client, hive, mine = bw["client"], bw["hive"], bw["mine"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    hive.db.execute("UPDATE agents SET model = 'fakepaid/x' WHERE id = ?", (mine["id"],))
    r = ask(client, bw["ann"], "op-bw-money-1", **BROWSER).json()
    assert r["cap_usd"] == 0.25 and r["month_remaining_usd"] == 50.0            # Ann's member allowance, nothing spent
    hive.ask.conductor.reservations.reserve("m1", {"x": 1}, 2.0, lambda: [("person:u_ann:month", 50, 0)], {"agent": mine["id"]})
    assert client.get("/api/ask/op-bw-money-1", headers=bw["ann"]).json()["month_remaining_usd"] == 48.0


# ---- the flag unset: exactly today's behaviour ------------------------------------------------------------------------

def test_flag_unset_is_exactly_todays_behaviour(client, monkeypatch):  # noqa: F811
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    w = world(client)
    hive = w["hive"]
    hive.personal.ensure("user:u_ann")
    r = ask(client, w["ann"], "op-off-0001", **BROWSER)
    assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid")      # answer_in is not a key it knows
    r = ask(client, w["ann"], "op-off-0002")
    assert (r.status_code, r.json()["error"]["code"]) == (409, "mind_asleep")  # the personal mind, conductor off
    got = client.get("/api/me/mind", headers=w["ann"]).json()
    assert "capabilities" not in got and "browser_mind" not in got["mind"]
    assert set(got["mind"]) == {"id", "name", "swarm_id", "status", "budget_usd", "allowance_usd", "allowance_origin",
                                "version", "adopted_at", "previous_version_id", "created_at", "model", "paid_by"}
    assert client.post("/api/me/mind", headers=w["ann"], json={"browser_mind": True}).status_code == 400
    r = client.post("/api/me/mind", headers=w["ann"], json={"name": "Ann's mind"})
    assert r.status_code == 200 and "capabilities" not in r.json() and "browser_mind" not in r.json()["mind"]
    for headers in ({}, ORIGIN):
        a = client.post("/api/ask/op-off-0002/done", headers={**w["ann"], **headers}, json={"outcome": "answered"})
        b = client.post("/api/ask/op-off-0002/nosuch", headers={**w["ann"], **headers}, json={"outcome": "answered"})
        assert (a.status_code, a.json()) == (b.status_code, b.json()) == (404, {"detail": "Not Found"})
    # (guarded so this control also runs, and passes, on live 4d1f94fa, which has neither the column nor the table)
    if "route" in {c["name"] for c in hive.db.all("PRAGMA table_info(ask_turns)")}:
        assert hive.db.one("SELECT COUNT(*) AS n FROM ask_turns WHERE route IS NOT NULL")["n"] == 0
    if hive.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mind_prefs'"):
        assert hive.db.one("SELECT COUNT(*) AS n FROM mind_prefs")["n"] == 0
    # an ordinary Ask is admitted and reads exactly as before (no route, cap or month fields)
    v = ask(client, w["ann"], "op-off-0003", context={"swarm_id": w["swarm"]["id"]}).json()
    assert v["state"] == "accepted" and not {"route", "cap_usd", "month_remaining_usd"} & set(v)
