"""The personal-mind gateway's outcomes as evidence (gateway r1e; PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.7).

Jon's Hyperon rule: what a feature does becomes truth-valued, evidence-stamped atoms in a PeTTa commons, for NAL/PLN.
This is the `mindgateway` commons, one more GovernanceEvidence (governance_evidence.py, as placement.py uses it): the
same evidence table + &commons_mindgateway, the same lib_hive revision, each observation stamped
ev:hive-mindgateway:<n> with confidence 0.5 (one observation, k = 1).

  (--> (x <model> browser-turn) within-cap)       a browser turn closed: f = 1, or 0 on spend_cap / call_cap
  (--> (x <model> browser-turn) complete)         a browser turn closed: f = 1 when it answered, else 0
  (--> (x <kind> browser-turn) refused)           f = 1: a cap hit at close (spend_cap, call_cap, time_cap), or a
                                                  turn-bound call refused by that limit kind (monthly_total_required:
                                                  the own-key bound refusal; own_key_limit, member_allowance, ...)
  (--> (x <model> call) usage-reported)           a turn-bound call settled (f = 1) or held unknown (f = 0); the
                                                  gateway's call path (r1c) records it through call_reported()

No person, mind, turn or words appear in any statement: the subjects are a model, a fixed limit kind and fixed words.
A model is named only when it is in the hive's model catalogue (Hive.model_catalog: the operator-configured providers'
models); a custom or unrecognised value, whatever its shape, is `other-model`, so a stored model field holding a person
id or private text never reaches an atom (r1e.1). A model from the fetched OpenRouter catalogue is `other-model` too: its
ids come off the network and are never a naming source (r1e.2).
The evidence source of each record is a hash (sha256) of the turn or call id, so a retried record is a no-op and the
table holds no id either.

ADVISORY ONLY. Nothing in admission, reservation, payer or routing reads this commons or its table (test_mind_gateway_r1e
scans for it and shows decisions unchanged under 1,000 negative atoms). A failed record never blocks: every method here
swallows its own failure (logged; `mindgateway.evidence_failed`, an admin-only event, as for every commons).
Off unless HIVE_MIND_GATEWAY=1: with the flag off nothing is recorded and the table is never created. The flag is read
once, when the hive builds this (r1de.3), so a mid-process change to the environment cannot turn recording on.

Read access is the existing commons' (verified in r1e, T-EV-READ): the commons is not a swarm, so a non-admin is refused
404 by Visibility.check_path on /api/swarms/mindgateway/...; an admin can read one belief by its statement at
GET /api/swarms/mindgateway/beliefs/detail; GET .../beliefs and .../vocab are 404 for everyone (no swarm row); a mind's
own query and belief reads reach only its own swarm's commons.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re

from .governance_evidence import GovernanceEvidence, symbol

log = logging.getLogger("hive")

COMMONS = "mindgateway"
CAP_OUTCOMES = ("spend_cap", "call_cap", "time_cap")  # a turn that closed on one of these was not within its caps
CAP_HITS = ("spend_cap", "call_cap", "time_cap")     # outcomes that are a limit refusing the turn at close
# the only words a refusal's kind may be (conductor.limit_kind's enum, the gateway's own words); anything else: other
KINDS = frozenset({"monthly_total_required", "own_key_limit", "member_allowance", "per_turn", "thread", "session",
                   "mind_total", "swarm", "hive", "key", "own_key_required", "no_key_grant", "rate_limited",
                   "spend_cap", "call_cap", "time_cap", "unknown"})
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/\-]{0,95}$")


def enabled():
    return os.environ.get("HIVE_MIND_GATEWAY", "") == "1"


def hashed(kind, ident):
    """An evidence source with no id in it: the kind plus a sha256 of the id."""
    return f"{kind}:" + hashlib.sha256(str(ident).encode()).hexdigest()[:32]


def model_symbol(model, catalog=frozenset()):
    """The model's name only when it is a catalogued model id (catalog: Hive.model_catalog()); else other-model.
    The shape check stays as a second guard, so a catalogue entry can never break the statement's syntax."""
    if isinstance(model, str) and model in catalog and MODEL.match(model):
        return symbol(model)
    return "other-model"


def kind_symbol(kind):
    return symbol(kind if kind in KINDS else "other")


def within_cap_statement(model, catalog=frozenset()):
    return f"(--> (x {model_symbol(model, catalog)} browser-turn) within-cap)"


def complete_statement(model, catalog=frozenset()):
    return f"(--> (x {model_symbol(model, catalog)} browser-turn) complete)"


def refused_statement(kind):
    return f"(--> (x {kind_symbol(kind)} browser-turn) refused)"


def usage_statement(model, catalog=frozenset()):
    return f"(--> (x {model_symbol(model, catalog)} call) usage-reported)"


def refusal_kind(exc):
    """The limit kind of a refused turn-bound call (a HiveError from Hive.check_budget), as a fixed word."""
    from .conductor import limit_kind
    detail = getattr(exc, "details", None) or {}
    if detail.get("reason") == "monthly_total_required":
        return "monthly_total_required"
    code = getattr(exc, "code", "")
    if code == "rate_limited":
        return "rate_limited"
    return limit_kind(code, detail.get("scope"))


class MindGatewayEvidence:
    """Write-only from the gateway's side: observations in, nothing back out to any decision."""

    def __init__(self, hive):
        self.hive, self._commons = hive, None
        self.on = enabled()   # snapshotted with the hive, as Settings.mind_gateway is

    def commons(self):
        if self._commons is None:
            self._commons = GovernanceEvidence(self.hive, commons=COMMONS)
        return self._commons

    def _record(self, source, statement, positive):
        if not self.on:
            return None
        try:
            return self.commons().record(source, statement, positive)
        except Exception as exc:   # noqa: BLE001  advisory: never blocks the turn or the call
            log.warning("mindgateway evidence not recorded: %s", exc)
            try:
                self.hive.events.publish(f"{COMMONS}.evidence_failed", source=source, error=str(exc)[:300])
            except Exception:   # noqa: BLE001
                pass
            return None

    def _catalog(self):
        return self.hive.model_catalog() if self.on else frozenset()

    def turn_closed(self, turn_id, model, outcome):
        """A browser turn closed with this outcome (Ask.CLOSE_OUTCOME's enum)."""
        catalog = self._catalog()
        self._record(hashed("within", turn_id), within_cap_statement(model, catalog), outcome not in CAP_OUTCOMES)
        self._record(hashed("complete", turn_id), complete_statement(model, catalog), outcome == "complete")
        if outcome in CAP_HITS:
            self._record(hashed("cap", turn_id), refused_statement(outcome), True)

    def call_refused(self, call_id, kind):
        """A turn-bound call refused by a limit of this kind (call_id: the gateway's request id, or a nonce)."""
        self._record(hashed("refused", call_id), refused_statement(kind), True)

    def call_reported(self, reservation_id, model, reported):
        """A turn-bound call's usage: settled at its reported cost (True) or held unknown (False). For r1c's call path."""
        self._record(hashed("usage", reservation_id), usage_statement(model, self._catalog()), bool(reported))
