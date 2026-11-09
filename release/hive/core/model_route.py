"""The hive's one model-choice entry: a stand-in carrier for the Choir router (OmegaV2 D18, Provider Boundary and Choir
Routing, 2026-08-07; Jon 11-05: the model router is to be hyperonized; Patrick and Peter choose its form).

D18's shape, kept so a Hyperon Choir router can take the rule over without any caller changing:
- a ROLE NEED (what the call is for): 'ask-conductor', 'personal-mind:dialogue';
- ROUTE FACTS, one per candidate on the reviewed ROSTER: the model, its provider, whether the hive can bound it in money
  (priced, the conductor's rule), and whether the host pays for it. For a person's mind that last fact is the call's own
  SETTLEMENT (Budgets.settlement: the gateway's paying key, payer_for, the governing limits for that key and payer), so
  what is chosen is exactly what a call would be billed to; with no mind to settle for, it is the provider's default or
  environment key with no named person owning it (a preview only: nothing is moved or made on it);
- ONE RULE, replaceable: today 'the first priced, host-paid model in roster order'. It is not D18's calibrated score
  (no outcome evidence is kept yet), so it never claims to be.
- a CHOSEN ROUTE or a REFUSAL, with the reason, and no fallback: an unknown provider gives no fact, and no candidate
  gives a refusal; the caller then keeps what it had (a new personal mind stays on the hive default).

One decision call, choose(need, ...), serves both needs, each under a named policy:
- 'ask-conductor': CONFIGURED. The operator's pin (HIVE_ASK_CONDUCTOR_MODEL), else the roster's head. The conductor
  checks the price at each turn (conductor.priced), so this policy needs no route facts. conductor.default_model and
  ab_models call it.
- 'personal-mind:dialogue': ROUTED. The operator's pin is a named policy inside it (operator-pin) and, when the host is
  about to MOVE a person's mind onto it (pins='check'), it must pass the same bar as any route (priced and host-paid; a
  demonstration pin never counts), or the answer is a refusal (pin_not_host_payable, pin_is_demo). Else the rule over
  route facts (roster-rule). PersonalMinds.default_model and the pickup call it.
- 'foundation-code:proposal' / 'foundation-review:second-opinion': FOUNDATION-FUNDED.
  The same entry and roster use the actual successful settlement's separate facts:
  priced/local + successful bounded settlement, including host-paid, authorized
  own/shared-key or real local/free. host_paid
  keeps its old meaning; personal-mind's host-only rule stays unchanged. Existing
  operator/default pins remain selections; selected= validates the current model
  without replacing it. A demonstration, unauthorized or unbounded route refuses.
Not routed here: Studio's own maker model (studio_makers.model_setting, HIVE_STUDIO_MAKER_MODEL) is a separate,
reviewed selector and stays one.

Provenance: a model the host chose for a personal mind is recorded (host_models); any model change by anyone else
forgets it, in the same transaction as the change, so only a model the host itself set is ever moved again.
"""
from __future__ import annotations

import dataclasses
import os

#: the reviewed roster (moved here from conductor.py, unchanged): the Ask conductor's default and its A/B models
ROSTER_DEFAULT = "openrouter/anthropic/claude-sonnet-5.5"
ROSTER_AB = ("openrouter/anthropic/claude-sonnet-5.5", "openrouter/openai/gpt-6.1-sol")
NEEDS = {"ask-conductor": "configured", "personal-mind:dialogue": "routed",
         "foundation-code:proposal": "foundation-funded", "foundation-review:second-opinion": "foundation-funded"}
DEMO_PREFIX = "mock/"
HOST_ACTOR = "host:model-route"


def configured(need="ask-conductor"):
    """The operator's pinned route for a need, or None. HIVE_ASK_CONDUCTOR_MODEL pins both needs; for a personal mind an
    explicit HIVE_DEFAULT_MODEL that names a real model (not the demonstration one) pins it too, as it always has.
    The foundation's routed needs use that same existing pin vocabulary."""
    pinned = os.environ.get("HIVE_ASK_CONDUCTOR_MODEL", "").strip()
    if pinned or need not in {"personal-mind:dialogue", "foundation-code:proposal", "foundation-review:second-opinion"}:
        return pinned or None
    hive_default = os.environ.get("HIVE_DEFAULT_MODEL", "").strip()
    return hive_default if hive_default and not hive_default.startswith(DEMO_PREFIX) else None


def roster():
    """The candidates, in order: the pinned default (else ROSTER_DEFAULT), ROSTER_AB, then HIVE_ASK_CONDUCTOR_AB_MODELS."""
    extra = [m.strip() for m in os.environ.get("HIVE_ASK_CONDUCTOR_AB_MODELS", "").split(",") if m.strip()]
    return list(dict.fromkeys([configured() or ROSTER_DEFAULT, *ROSTER_AB, *extra]))


@dataclasses.dataclass(frozen=True)
class RouteFact:
    model: str
    provider: str
    priced: bool
    host_paid: bool


@dataclasses.dataclass(frozen=True)
class FoundationFundingFact(RouteFact):
    # Preserve the original host_paid meaning. These are independent facts from
    # the call path's successful actual settlement, not a provider/key guess.
    bounded: bool
    own_key: bool
    free: bool


def facts(models, store, ownhive, settle=None, foundation=False):
    """One fact per candidate whose provider this hive knows (an unknown provider is no fact: it cannot be chosen).
    settle(model) -> Budgets.settlement for the mind in question: host-paid is then its host_paid, nothing else.
    Foundation facts also carry the actual bounded/own-key/free fields; a key
    preview without settlement never supplies a bounded Foundation fact."""
    out = []
    for model in models:
        provider, _, name = str(model).partition("/")
        if store is None or not name or provider not in getattr(store, "providers", {}):
            continue
        p = store.provider(provider)
        settled = settle(model) if settle is not None else None
        if settle is not None:
            host_paid = bool(settled.get("host_paid"))
        else:
            route = store.paying_route(provider)
            owner = ownhive.key_person(route["key_id"]) if ownhive is not None else None
            host_paid = bool(route["secret"]) and owner is None
        # The owner's plan (any subscription instance) has no per-token price; its settlement is the bound instead: the gate's
        # day call cap plus the owner chain, so a settled plan route counts as priced here and nowhere else.
        plan = bool(settled and settled.get("payer_mode") == "plan" and settled.get("bounded"))
        args = (model, provider, bool(p.local or p.priced(name) or plan), host_paid)
        if foundation:
            out.append(FoundationFundingFact(*args, bounded=bool(settled and settled.get("bounded")),
                own_key=bool(settled and settled.get("own_key")), free=bool(settled and settled.get("free"))))
        else:
            out.append(RouteFact(*args))
    return out


def rule(need, route_facts):
    """One replaceable rule: personal is host-only; Foundation uses actual bounded settlement."""
    for f in route_facts:
        if NEEDS.get(need) == "foundation-funded":
            if (isinstance(f, FoundationFundingFact) and not is_demo(f.model) and f.priced and f.bounded):
                return f
        elif f.priced and f.host_paid:
            return f
    return None


def choose(need, store=None, ownhive=None, pins="trust", settle=None, selected=None):
    """THE decision call for every need. {'route': model, 'policy': name, 'fact': RouteFact | None} or
    {'refused': reason}. Never a fallback. pins='check': an operator pin must pass the priced + host-paid bar (and not be
    the demonstration model) before a person's mind is moved or made on it. settle: that mind's settlement (facts).
    Foundation uses its own bounded-funding rule over that same settlement; it
    does not change personal-mind's host-only policy or reinterpret host_paid."""
    policy = NEEDS.get(need)
    if policy is None:
        return {"refused": "unknown_need"}
    # A caller-owned existing selection is validated, never replaced or treated
    # as a roster/pin. Used by bounded foundation admission after model pickup.
    if selected is not None:
        if policy not in ("routed", "foundation-funded") or is_demo(selected):
            return {"refused": "selected_is_not_a_real_routed_model"}
        fact = next(iter(facts([selected], store, ownhive, settle,
                               foundation=policy == "foundation-funded")), None)
        if fact is None or rule(need, [fact]) is None:
            return {"refused": "selected_not_funded" if policy == "foundation-funded" else "selected_not_host_payable"}
        return {"route": selected, "policy": "existing-selection", "fact": fact}
    pinned = configured(need)
    if policy == "configured":
        return {"route": pinned or ROSTER_DEFAULT, "policy": "operator-pin" if pinned else "roster-head", "fact": None}
    if pinned:
        if pins != "check":
            return {"route": pinned, "policy": "operator-pin", "fact": None}
        if is_demo(pinned):
            return {"refused": "pin_is_demo"}
        pin_fact = next(iter(facts([pinned], store, ownhive, settle,
                                   foundation=policy == "foundation-funded")), None)
        if pin_fact is None or rule(need, [pin_fact]) is None:
            return {"refused": "pin_not_funded" if policy == "foundation-funded" else "pin_not_host_payable"}
        return {"route": pinned, "policy": "operator-pin", "fact": pin_fact}
    found = facts(roster(), store, ownhive, settle, foundation=policy == "foundation-funded")
    if not found:
        return {"refused": "no_known_route"}
    chosen = rule(need, found)
    if chosen is None:
        return {"refused": "no_priced_host_paid_route"}
    return {"route": chosen.model, "policy": "roster-rule", "fact": chosen}


def is_demo(model):
    return not model or str(model).startswith(DEMO_PREFIX)


#: the built-in demonstration model (config.py: HIVE_DEFAULT_MODEL's own default)
DEMO_DEFAULT = "mock/echo"


def fallback():
    """What a new personal mind is made on when no route settles, and whose choice that is: (model, the operator's?).
    The operator's demonstration pin, else an explicit demonstration HIVE_DEFAULT_MODEL, is theirs and stands as set.
    Otherwise the built-in demonstration model, the host's: never a real pin or default that was just refused (sol and
    Kimi on 0f88cf5d), which a later pickup reaches only through the same bar."""
    pinned = os.environ.get("HIVE_ASK_CONDUCTOR_MODEL", "").strip()
    if pinned and is_demo(pinned):
        return pinned, True
    explicit = operator_default()
    if explicit and is_demo(explicit):
        return explicit, True
    return DEMO_DEFAULT, False


def operator_default():
    """The hive default the operator set explicitly (HIVE_DEFAULT_MODEL, the demonstration model included), else None.
    An explicit one is the operator's, never the host's choice: a mind made on it is not recorded, so it is never moved.
    Only the implicit fallback (no HIVE_DEFAULT_MODEL: the built-in demonstration model) is the host's (sol on 50998399)."""
    return os.environ.get("HIVE_DEFAULT_MODEL", "").strip() or None


# ---- provenance: the models the host itself chose -------------------------------------------------------------------

def migrate(db):
    db.execute("CREATE TABLE IF NOT EXISTS host_models (agent_id TEXT PRIMARY KEY, model TEXT NOT NULL, need TEXT NOT NULL, "
               "set_at TEXT NOT NULL)")


def record(db, agent_id, model, need):
    from .db import now
    migrate(db)
    db.execute("INSERT INTO host_models (agent_id, model, need, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE "
               "SET model = excluded.model, need = excluded.need, set_at = excluded.set_at", (agent_id, model, need, now()))


def held(db, agent_id):
    """The model the host set for this mind, while that is still its model's provenance; else None."""
    row = db.one("SELECT model FROM host_models WHERE agent_id = ?", (agent_id,))
    return row["model"] if row else None


def forget(db, agent_id):
    """Any change by anyone but the host: the model is theirs now. (A database with no host_models yet has nothing to
    forget.)"""
    migrate(db)
    db.execute("DELETE FROM host_models WHERE agent_id = ?", (agent_id,))
