"""J3 host round R4 (money at call time): a Studio maker's paid calls, bound to one step and one execution.

Plan: PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md §3.6 "Gateway", §6, r1.1 S1 (the monthly total at
every reservation), S2/E2 (the fence after Stop), S5 (drift at call time and the change routes), K5/E6.3 (O2-e'), r1.2
E1 (reservation metadata, the send gate on the reservation's own step, settlement on its own labels), E6.1, r1.3 F1 and
r1.4 G1/G3 (the captured epoch, re-checked inside every consuming transaction), r1.8 L6 (op-id uniqueness) with the
spec r2.5 amendment (L6 moved to R4). Contract J3_ASK_SETS_UP_STUDIO_CONTRACT_R4_3.md §6 wins where it differs.

The rule, for the maker of a live session only (G3: every other mind gets None and is untouched; Studio off: None):
- at the door (studio_steps.gateway_fence, R3): a fenced execution never calls; a maker calls only inside its admitted
  step, with the token epoch captured when this request was authenticated;
- gateway_call() binds the call to the step admitted then, and the reservation's metadata records {studio_session,
  studio_step, execution_id, maker_execution, token_epoch} (immutable, part of the reservation's binding hash);
- inside the reservation transaction (StudioCall.budgets) the same step must still be admitted, the captured epoch must be
  its epoch and not fenced, the maker's boundary its execution; the binding the person consented to must not have
  drifted (S5); the person's monthly total must exist (S1). Then studio:<sid> and studiostep:<sid>:<n> join the rows, so
  limit >= spent + held + ceiling holds for the monthly total, the session cap and the step cap together;
- the call is reserved, not dispatched. At SEND_GATE (StudioCall.gate) the reservation's OWN step is re-read in one
  transaction with the dispatch: anything other than "still admitted, same epoch, unfenced, same boundary" releases the
  hold and aborts with nothing sent;
- settlement and the unknown moves act on that reservation, so its cost stays on step n's labels whatever came after.
A refusal inside the reservation ends the step (refused_budget, or interrupted for drift) and pauses or holds the session,
written after the refused transaction rolled back. Nothing here reserves, holds or refunds anything by itself.
"""

from __future__ import annotations

import json
import re
import time

from .db import now

OP_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")
MAX_OP_IDS = 16                       # contract r4.3 line 120: 1-16 items, distinct op_ids
OP_ID_OUTCOMES = ("applied", "refused", "accepted-no-source-change")   # receiver-validated: it names the op ids it read

SCHEMA = [
    # r1.8 L6: every op id a session's proposals declared, for the session's whole life (every mount and segment)
    """CREATE TABLE IF NOT EXISTS studio_op_ids (session_id TEXT NOT NULL, op_id TEXT NOT NULL, step INTEGER NOT NULL,
  revision INTEGER, at TEXT NOT NULL, PRIMARY KEY (session_id, op_id))""",
]
STEP_COLUMNS = [("closed_reason", "TEXT"), ("op_ids", "TEXT")]


class StudioRefused(Exception):
    """A maker call refused inside the reservation transaction or at the send gate. ``error`` is the HiveError to answer;
    ``after`` is (session state, reason, step state) to write once the refused transaction has rolled back, or None."""

    def __init__(self, error, after=None):
        super().__init__(getattr(error, "code", "studio_refused"))
        self.error, self.after = error, after


class StudioCall:
    """One paid call of a live session's maker, bound to the step admitted when it entered the gateway."""

    def __init__(self, studio, agent, row, step):
        self.studio = studio
        self.maker_id = agent["id"]
        self.token_epoch = agent.get("token_epoch")
        self.session_id, self.principal = row["id"], row["principal"]
        self.n, self.execution_id, self.maker_execution = step["n"], step["execution_id"], step["maker_execution"]
        self.reservation = None
        self.started = False
        self.on_dispatch = None          # r4.1: a route's own record of the dispatch, written in the gate's transaction

    def metadata(self, base):
        """The reservation's metadata: the host's own fields plus the step and execution this call belongs to (E1)."""
        return {**base, "studio_session": self.session_id, "studio_step": self.n, "execution_id": self.execution_id,
                "maker_execution": self.maker_execution, "token_epoch": self.token_epoch}

    def budgets(self, base):
        """Wraps the route's own current_budgets(): the Studio checks and rows, inside the reservation transaction."""
        def rows():
            out = list(base())
            for label, limit, spent in self.studio._call_rows(self, out):
                out.append((label, limit, spent))
            return out
        return rows

    async def gate(self):
        """SEND_GATE: awaited at the transport's send-header boundary (gateway._send_trace), after any wait for a pooled
        connection and after connecting, for chat, embeddings and media alike (r4.1). Passing it marks the reservation
        dispatched; a refusal releases it and raises, so nothing is sent."""
        self.dispatch()

    def dispatch(self):
        if self.started or self.reservation is None:
            return
        self.studio._gate(self)
        self.started = True

    def unsent(self):
        """The call failed before it reached the send boundary: nothing left this process, so its hold is released
        (abort_before_dispatch, conditional), never held unknown and never marked dispatched. Returns True if released."""
        if self.started or self.reservation is None:
            return False
        db = self.studio.hive.db
        with db.transaction():
            return db.execute("UPDATE cost_reservations SET state = 'released' WHERE id = ? AND state = 'reserved'",
                              (self.reservation,)).rowcount == 1

    def made(self):
        """The provider answered without passing a transport's send boundary: the call was made all the same."""
        if not self.started and self.reservation is not None:
            try:
                self.studio.reservations.dispatch(self.reservation)
            except ValueError:
                pass            # released meanwhile: settle() records a late answer on a released hold, flagged
            self.started = True


class StudioGateway:
    """Mixed into StudioSteps. Uses its hive, reservations, enabled, live_session_of, _open_step, _step, _session,
    fenced, _retired, _boundary, _drift, _end_execution, _requeue, _set_state, _step_event, _err."""

    GATEWAY_EXECUTION_HOOK = True      # r1.3 F4.2 component: maker calls are bound to their step at reservation (R4)
    SEND_GATE_WIRING = True            # r1.3 F4.2 component: and gated at send on the reservation's own step (R4)

    def _init_gateway(self):
        db = self.hive.db
        for statement in SCHEMA:
            db.execute(statement)
        have = {r["name"] for r in db.all("SELECT name FROM pragma_table_info('studio_steps')")}
        for column, kind in STEP_COLUMNS:
            if column not in have:
                db.execute(f"ALTER TABLE studio_steps ADD COLUMN {column} {kind}")

    # ---- the door and the binding ------------------------------------------------------------------------------------

    def gateway_call(self, agent):
        """After gateway_fence at the door (studio_steps.py). None with Studio off and for every mind that is not a live
        session's maker (G3). For the maker: the call bound to the step admitted now; raises if none is (a race with the
        door)."""
        if not getattr(self, "enabled", False):
            return None
        row = self.live_session_of(agent["id"])
        if row is None:
            return None
        step = self._open_step(row["id"])
        if step is None:
            raise self._err(409, "studio_step_closed", "This mind is making a Studio piece; it works only inside an open "
                            "step.", session_id=row["id"])
        return StudioCall(self, agent, row, step)

    def _call_refusal(self, call):
        """r1.4 G1, against rows read in the caller's transaction: (i) the reservation's own bound step is admitted,
        (ii) the epoch captured at authentication is that step's, (iii) that (maker, epoch) is not fenced; and the
        maker's current boundary is the step's execution. Returns the refusal or None. Never "the latest step"."""
        if self.fenced(call.maker_id, call.token_epoch):
            return self._err(409, "studio_fenced", "This mind's Studio execution has ended; it makes no more calls.")
        row = self._session(call.session_id)
        step = self._step(call.session_id, call.n)
        if row is None or row["state"] not in ("active", "paused"):
            return self._err(409, "studio_step_closed", "This Studio session is not open for work.",
                             session_id=call.session_id)
        from .studio_handoff import _passed
        if _passed(row.get("expires_at")):
            # R8.1 (stand-in R8.0 P1): the session window, re-read in the reservation transaction and at SEND_GATE, for
            # every maker call (chat, embeddings, media). A call admitted inside the window that crosses expires_at before
            # it is sent is refused and its hold released (abort_before_dispatch), even before the expiry Stop has run.
            return self._err(409, "studio_step_closed", "This Studio session's window has ended; it makes no more calls.",
                             session_id=call.session_id, reason="window_ended")
        agent ={"id": call.maker_id, "token_epoch": call.token_epoch}
        if step is None or step["execution_id"] != call.execution_id or self._retired(agent, step) is not None \
                or self._boundary(call.maker_id)[1] != step["maker_execution"]:
            return self._err(409, "execution_retired", "That execution is not the open step's.", session_id=call.session_id)
        return None

    def _monthly_present(self, row):
        """r1.1 S1 at reservation: the person's required monthly total still exists (own key: a live self all-keys
        limit; the hive's key: their person month rule or the member default). Its row is in the route's snapshot
        (Budgets.applicable / ownhive.rules), so the reservation's own arithmetic applies it."""
        hive = self.hive
        principal = row["principal"]
        if row["own_key"]:
            rows = hive.db.all("SELECT * FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*' "
                               "AND revoked_at IS NULL", (principal,))
            return bool(hive.ownhive._active(rows))
        return self._allowance(principal, row["maker_id"], row["key_id"]) is not None

    def _call_rows(self, call, base_rows):
        """Inside the reservation transaction: every check, then the two exact-label rows (K5: subject_of is None for
        both, so each counts only holds carrying its own exact label)."""
        from .studio_sessions import scope_label, step_label
        refused = self._call_refusal(call)
        if refused is not None:
            raise StudioRefused(refused)
        row = self._session(call.session_id)
        drift = self._drift(row)                                    # S5 at call time, with the route's payer check
        if drift:
            raise StudioRefused(self._err(409, drift, "This Studio session's maker changed since you agreed to it; "
                                          "continuing needs your agreement again.", session_id=row["id"]),
                                after=("held", "binding_drift:" + drift, "interrupted"))
        if not self._monthly_present(row):                          # S1 at every reservation
            raise StudioRefused(self._err(402, "spend_limit", "Set your monthly total first; Studio spends under it.",
                                          reason="monthly_total_required", session_id=row["id"]),
                                after=("paused", "monthly_total_required", "refused_budget"))
        labels = {label for label, _, _ in base_rows}
        session, step = scope_label(row["id"]), step_label(row["id"], call.n)
        if session in labels or step in labels:
            raise StudioRefused(self._err(409, "execution_retired", "That execution is not the open step's."))
        out = [(session, float(row["cap_usd"]), self.scope_spent(session)),
               (step, float(row["step_cap_usd"]), self.scope_spent(step))]
        if not row["own_key"]:
            # the person's month allowance on the hive's money is a row at every reservation, with the same arithmetic as
            # the member default's row (Budgets.applicable): the owner on the hive's key has no member default there (an
            # admin), so _allowance's answer is added as that row; concurrent sessions then share it (74df4002 review P1)
            scope = "person:" + row["principal"][5:]
            if scope + ":month" not in labels:
                allowance = self._allowance(row["principal"], row["maker_id"], row["key_id"])
                if allowance is not None:
                    out.append((scope + ":month", float(allowance), self.hive.budgets.spent(scope, "month")))
        return out

    def reserve_call(self, call, reservations, key, payload, estimate, budgets, metadata, subjects=None):
        """A maker's reservation (E1, F1, G1): the step and the captured epoch in its metadata, the Studio checks and rows
        inside its transaction, reserved and not dispatched (the send gate dispatches). A refusal reserves nothing; it
        ends the step and pauses or holds the session after the rollback, and raises the HiveError to answer."""
        from .cost_reservations import BudgetExhausted
        from .hive import HiveError
        call.reservation = key
        try:
            return reservations.reserve(key, payload, estimate, call.budgets(budgets), metadata=call.metadata(metadata),
                                        dispatched=False, subjects=subjects)
        except StudioRefused as exc:
            self.gateway_refused(call, exc.after)
            raise exc.error from None
        except BudgetExhausted as exc:
            self.gateway_refused(call, ("paused", "budget_exhausted", "refused_budget"))
            raise self._err(402, "reservation_refused", str(exc), scope=exc.scope) from None
        except HiveError as exc:
            if exc.status == 402:   # money port r1.2: use refused in the transaction (host_use_check), as studio_check
                self.gateway_refused(call, ("paused", "budget_exhausted", "refused_budget"))
            raise
        except ValueError as exc:
            if "payer changed" in str(exc):
                self.gateway_refused(call, ("held", "binding_drift:payer_changed", "interrupted"))
            raise

    def _gate(self, call):
        """E1/G1 at SEND_GATE, one transaction: the reservation's own step re-read and the dispatch commit together, or
        the hold is released and nothing is sent."""
        db = self.hive.db
        refused = None
        with db.transaction():
            refused = self._call_refusal(call)
            if refused is None:
                held = db.one("SELECT state FROM cost_reservations WHERE id = ?", (call.reservation,))
                if held is None or held["state"] != "reserved":
                    # released meanwhile (a handoff fence or Stop released it): never sent
                    refused = self._err(409, "execution_retired", "That execution is not the open step's.")
                else:
                    db.execute("UPDATE cost_reservations SET state = 'dispatched', dispatched_at = ? WHERE id = ? AND "
                               "state = 'reserved'", (time.time(), call.reservation))
                    if call.on_dispatch is not None:
                        call.on_dispatch()
            if refused is not None:
                # abort_before_dispatch, conditional: nothing was sent, so nothing stays held
                db.execute("UPDATE cost_reservations SET state = 'released' WHERE id = ? AND state = 'reserved'",
                           (call.reservation,))
        if refused is not None:
            raise StudioRefused(refused)

    def gateway_refused(self, call, after):
        """After a refused reservation's transaction rolled back: the bound step ends (its execution fenced, directions
        back to the queue when nothing was published) and the session pauses or holds with the reason. Only if that
        step is still the admitted one; a session already stopping, stopped or held is left as it is."""
        if call is None or not after:
            return
        state, reason, step_state = after
        db = self.hive.db
        with db.transaction():
            row = self._session(call.session_id)
            step = self._step(call.session_id, call.n)
            if row is None:
                return
            if step is not None and step["state"] == "admitted" and step["execution_id"] == call.execution_id:
                stamp = now()
                db.execute("UPDATE studio_steps SET state = ?, closed_reason = ?, closed_at = ? WHERE session_id = ? "
                           "AND n = ? AND state = 'admitted'", (step_state, reason, stamp, row["id"], step["n"]))
                self._end_execution(row, step, step_state)
                if step["proposal_n"] is None:
                    self._requeue(row["id"], step["n"])
                self._step_event(row["id"], step["n"], "closed")
            if row["state"] in ("active", "paused"):
                self._set_state(row["id"], state, reason)

    # ---- who a maker's call is for, and the dedicated maker (plan §3.6, O2-i) ------------------------------------------

    def call_principal(self, agent_id):
        """Hive.user_for's first check: while a session is live, every call its maker makes is for the session's person."""
        if not getattr(self, "enabled", False):
            return None
        row = self.live_session_of(agent_id)
        return row["principal"] if row is not None else None

    def maker_busy(self, agent_id):
        """Ask turns and ordinary Sessions addressed to a mind Studio owns are refused (coordinator_busy): the host cannot
        tell its calls apart by purpose, so while it makes a piece every call it makes is the session's."""
        return bool(getattr(self, "enabled", False)) and self.studio_owns(agent_id)

    def change_refusal(self, agent_id, changes):
        """S5: while Studio owns the maker, the routes that change its model, role, options (tools, key), driver or swarm
        refuse 409 studio_session_live. Stop first."""
        touched = {"model", "role_id", "options", "driver", "swarm_id"} & set(changes or {})
        if touched and self.maker_busy(agent_id):
            return self._err(409, "studio_session_live", "This mind is making a Studio piece; stop the session before "
                             "changing it.", fields=sorted(touched))
        return None

    # ---- L6: op ids are unique for the session's lifetime -----------------------------------------------------------

    def _op_ids(self, value, required=True):
        """1-16 distinct op ids, each 1-80 letters, digits or . _ : - (not starting with punctuation), or None."""
        if value is None and not required:
            return None
        if not (isinstance(value, list) and 1 <= len(value) <= MAX_OP_IDS
                and all(isinstance(v, str) and OP_ID.fullmatch(v) for v in value) and len(set(value)) == len(value)):
            raise self._err(400, "bad_request", "op_ids is the proposal's 1-16 distinct operation ids, as in its items")
        return list(value)

    def op_ids_check(self, session_id, op_ids):
        """L6 at publication, in add_revision's transaction: an op id any earlier proposal of this session declared, in
        any step, mount or segment, is refused (op_id_reused) and nothing is written."""
        marks = ",".join("?" for _ in op_ids)
        used = self.hive.db.all(f"SELECT op_id, step FROM studio_op_ids WHERE session_id = ? AND op_id IN ({marks}) "
                                "ORDER BY op_id", (session_id, *op_ids))
        if used:
            raise self._err(409, "op_id_reused", "Those operation ids were already used in this Studio session; "
                            "a new proposal needs new ones.", op_ids=[u["op_id"] for u in used],
                            steps=sorted({u["step"] for u in used}))

    def op_ids_record(self, session_id, n, revision, op_ids):
        stamp = now()
        for op_id in op_ids:
            self.hive.db.execute("INSERT INTO studio_op_ids (session_id, op_id, step, revision, at) VALUES (?,?,?,?,?)",
                                 (session_id, op_id, n, revision, stamp))
        self.hive.db.execute("UPDATE studio_steps SET op_ids = ? WHERE session_id = ? AND n = ?",
                             (json.dumps(op_ids), session_id, n))

    def op_ids_outcome(self, step, outcome, op_ids):
        """L6 at the outcome: the receiver names the op ids it validated in the exact artifact (contract r4.3 line 120).
        For a validated outcome (applied, refused, accepted-no-source-change) they are required and must be exactly the
        ones the proposal declared; anything else is held, never skipped (409 op_ids_mismatch)."""
        if op_ids is None:
            if outcome in OP_ID_OUTCOMES:
                raise self._err(400, "bad_request", "op_ids is required for an applied, refused or "
                                "accepted-no-source-change outcome: the operation ids the receiver read")
            return
        declared = json.loads(step["op_ids"]) if step.get("op_ids") else None
        if declared is None or sorted(op_ids) != sorted(declared):
            raise self._err(409, "op_ids_mismatch", "Those aren't the operation ids this step's proposal declared; hold, "
                            "do not skip.", op_ids=declared)
