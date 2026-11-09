"""The personal-mind gateway, round r1c (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.1, §2.2, r1.1 §A, §J, §K).

Off unless HIVE_MIND_GATEWAY=1: with it unset both routes answer exactly as an unknown path does.

The mind token (POST / DELETE /api/me/mind/session)
- Minted by a named, signed-in admin or member (the §G person gate: exact Origin, Bearer header only, never the
  password session) who is an enabled person. `mt_` + 32 random bytes; only its sha256 is stored (mind_tokens), bound
  to the person, their personal mind and the parent session (by the session's own token hash). 30 minutes; at most 4
  live per session (a fifth mint revokes the oldest); at most MINTS_PER_HOUR (10) mints per person in any hour, across
  all their sessions, revoked tokens included (429 mint_rate_limited); at most HIVE_MIND_TOKEN_MAX_CALLS (100) gateway
  calls each. The broker re-mints at most once per 401 (plan §6.4), so ten an hour covers a re-mint every token
  lifetime with room for retries.
- A token is registered with the redactor while it is live and unregistered when it is revoked or found expired.
- It is in neither `sessions` nor `agents.token_hash`, so no other route accepts it; there is no list route. The row is
  all that is recorded: the token is never logged, returned again or reflected. A client that puts one in a URL anyway
  is refused, and the access log never keeps it, in every mode and after a restart (scrub_logged, applied by
  hive/__main__'s access-log filter, by the token's shape alone; the redactor itself is on only for a local owner).

MindTokens.resolve (used only by the gateway; on every call, and again at the send gate):
- Origin present and in the hive's allowed set (`null` refused); no query string; exactly one Authorization header,
  `Bearer mt_...`;
- the token's row unrevoked and unexpired; its parent session row still there, unexpired, the same person, and an
  `sso` session when the request is public (as session_for);
- the person still enabled; their personal mind still the token's mind.
So sign-out (the session row is deleted), disabling the person and deleting the mind revoke it with no hooks.

The gateway (POST /api/me/mind/llm/v1/chat/completions): see MindGateway.chat. One browser turn's calls, billed to
its person under the chat route's payer and key rules, reserved under the person's monthly total (turn_bound) plus
the turn's and the thread's own caps, and sent only through the shared send gate (gated_call.py) with the whole
resolution re-checked there.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import time
import urllib.parse
import uuid

import httpx

from .ask import BROWSER_LIVE_SQL, BROWSER_ROUTE, browser_live_params, browser_past_deadline
from .cost_reservations import BudgetExhausted, host_budget_snapshot, host_subjects, host_use_check
from .gated_call import GateClosed, gated_chat
from .config import is_subscription
from .gateway import GatewayError, billable, split_model
from .hive import HiveError, token_hash
from .mind_idempotency import KeyTaken, MindIdempotency, Slot, call_id_for, expired as key_expired, in_progress
from .sessions import own_scope, thread_scope

TOKEN_PREFIX = "mt_"
TOKEN_BYTES = 32
TOKEN_CHARS = 43   # secrets.token_urlsafe(TOKEN_BYTES): unpadded base64url, alphabet A-Z a-z 0-9 _ -
TOKEN_TTL = 1800.0
MAX_PER_SESSION = 4
MINTS_PER_HOUR = 10   # per person, every session together (gate A, browser-Iter plan r7.7 §11; Dot 3 Nov)
MAX_BODY = 1024 * 1024
BODY_KEYS = {"messages", "tools", "tool_choice", "max_tokens", "enable_thinking", "model"}
DEFAULT_MAX_TOKENS = MAX_TOKENS = 4096

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS mind_tokens (token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, mind_id TEXT NOT NULL,
  session_hash TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, revoked_at REAL,
  calls INTEGER NOT NULL DEFAULT 0)""",
    "CREATE INDEX IF NOT EXISTS mind_tokens_session ON mind_tokens(session_hash, created_at)",
]


# The token's own shape, wherever it appears: no word boundary (a token after `x` or `_` is still one), the prefix in
# any case. After a restart the redactor holds no raw token at all (MindTokens._raw is this process's), so for a token
# that is still valid this shape is the only defence a log line has: it must be complete on its own.
LOGGED_TOKEN = re.compile(r"(?i:mt_)[A-Za-z0-9_\-]{%d}" % TOKEN_CHARS)
LOGGED_MARK = TOKEN_PREFIX + "REDACTED"
UNLOGGABLE = "[path withheld]"
MAX_DECODES = 8
ROUTES = ("/api/me/mind/session", "/api/me/mind/llm/")   # this module's own (not the inbox, whose ?after= stays)


def _decodings(text):
    """text and each percent-decoding of it, until it stops changing; None when that is not safe (bytes that are not
    UTF-8, or still changing after MAX_DECODES)."""
    forms = [text]
    for _ in range(MAX_DECODES):
        try:
            nxt = urllib.parse.unquote(forms[-1], errors="strict")
        except UnicodeDecodeError:
            return None
        if nxt == forms[-1]:
            return forms
        forms.append(nxt)
    return None


def _clean(forms):
    return forms is not None and not any(LOGGED_TOKEN.search(f) for f in forms)


def scrub_logged(text):
    """A request line, or one part of it, as an access log writes it, with no usable mind token left (r1c, in every
    mode). The query string goes whole on this module's routes. Then the token shape is redacted in the raw text; if a
    decoding of what is left (single, double, any case of hex) still holds one, the fully decoded text is logged with it
    redacted instead; if that is not clean either, or the text cannot be decoded safely, the whole text is withheld
    (fail closed). A text that holds no token at any decoding is returned as it was."""
    path, sep, query = text.partition("?")
    if sep and any(r in path for r in ROUTES):
        text = path + "?REDACTED"
    forms = _decodings(text)
    if forms is None:
        return UNLOGGABLE
    if _clean(forms):
        return text
    for candidate in (LOGGED_TOKEN.sub(LOGGED_MARK, text), LOGGED_TOKEN.sub(LOGGED_MARK, forms[-1])):
        if _clean(_decodings(candidate)):
            return candidate
    return UNLOGGABLE


def _int_env(name, default):
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(1, value)


def token_max_calls():
    """Calls one mind token may carry (r1.1 §K); a fresh mint every 30 minutes."""
    return _int_env("HIVE_MIND_TOKEN_MAX_CALLS", 100)


def turn_max_calls():
    """The interim call ceiling of one browser turn (plan §3.2, r1.1 §C)."""
    return _int_env("HIVE_MIND_TURN_MAX_CALLS", 50)


def _err(status, code, message, details=None):
    return HiveError(status, code, message, details)


def expired():
    return _err(401, "mind_token_expired", "this mind token is no longer valid; ask for a new one")


def required():
    return _err(401, "mind_token_required", "this route needs a mind token")


class MindTokens:
    def __init__(self, hive):
        self.public_session_allowed = lambda session: session.get("kind") == "sso"
        self.hive = hive
        for statement in SCHEMA:
            hive.db.execute(statement)
        self._raw: dict[str, str] = {}   # token hash -> token, for this process's live tokens (redactor unregister)

    @property
    def db(self):
        return self.hive.db

    # ---- minting and revoking ----------------------------------------------------------------------------------------

    def mint(self, principal, mind_id, session_hash, now=None):
        from . import redact
        now = time.time() if now is None else now
        self.sweep(now)
        raw = TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)
        digest = token_hash(raw)
        revoked = []
        with self.db.transaction():   # the count and the insert are one step, so concurrent mints never pass the limit
            recent = self.db.one("SELECT COUNT(*) AS n FROM mind_tokens WHERE principal = ? AND created_at > ?",
                                 (principal, now - 3600))["n"]
            if recent >= MINTS_PER_HOUR:
                raise _err(429, "mint_rate_limited", f"at most {MINTS_PER_HOUR} mind tokens an hour; try again later")
            self.db.insert("mind_tokens", {"token_hash": digest, "principal": principal, "mind_id": mind_id,
                                           "session_hash": session_hash, "created_at": now, "expires_at": now + TOKEN_TTL,
                                           "revoked_at": None, "calls": 0})
            live = self.db.all("SELECT token_hash FROM mind_tokens WHERE session_hash = ? AND revoked_at IS NULL "
                               "AND expires_at > ? ORDER BY created_at, rowid", (session_hash, now))
            for row in live[:max(0, len(live) - MAX_PER_SESSION)]:   # a fifth mint revokes the oldest
                self.db.execute("UPDATE mind_tokens SET revoked_at = ? WHERE token_hash = ?", (now, row["token_hash"]))
                revoked.append(row["token_hash"])
        self._raw[digest] = raw
        redact.register(raw)
        self._forget(revoked)
        return raw, now + TOKEN_TTL

    def revoke_session(self, session_hash, now=None):
        """DELETE /api/me/mind/session: every live token of the caller's session. Returns how many."""
        now = time.time() if now is None else now
        with self.db.transaction():
            rows = self.db.all("SELECT token_hash FROM mind_tokens WHERE session_hash = ? AND revoked_at IS NULL",
                               (session_hash,))
            self.db.execute("UPDATE mind_tokens SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
                            (now, session_hash))
        self._forget([r["token_hash"] for r in rows])
        return len(rows)

    def sweep(self, now=None):
        """Tokens past their time, or whose parent session is gone, are marked revoked and leave the redactor. Called on
        every mint, revoke and resolve, and by the reconcile loop. Returns how many it ended."""
        now = time.time() if now is None else now
        with self.db.transaction():
            rows = self.db.all("SELECT token_hash FROM mind_tokens m WHERE revoked_at IS NULL AND (expires_at <= ? OR NOT "
                               "EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = m.session_hash))", (now,))
            for r in rows:
                self.db.execute("UPDATE mind_tokens SET revoked_at = ? WHERE token_hash = ?", (now, r["token_hash"]))
        live = {r["token_hash"] for r in self.db.all("SELECT token_hash FROM mind_tokens WHERE revoked_at IS NULL")}
        self._forget([h for h in list(self._raw) if h not in live])   # revoked anywhere (sign-out sweep, DELETE, a fifth mint)
        return len(rows)

    def _forget(self, hashes):
        from . import redact
        for h in set(hashes):
            raw = self._raw.pop(h, None)
            if raw is not None:
                redact.unregister(raw)

    # ---- resolving (the gateway only) ------------------------------------------------------------------------------

    @staticmethod
    def request_token(request, origins):
        """Origin, query and the one Bearer header (plan §2.1), before any lookup. Returns the raw token."""
        origins_seen = request.headers.getlist("origin")
        if not origins_seen:
            raise _err(403, "origin_required", "this request needs its Origin")
        if len(origins_seen) != 1 or origins_seen[0] not in origins:   # `null` is never in the set
            raise _err(403, "origin_refused", "this request's Origin is not this hive")
        if request.scope.get("query_string"):
            raise _err(400, "invalid", "this route takes no query string")
        auth = request.headers.getlist("authorization")
        if len(auth) != 1 or not auth[0].lower().startswith("bearer "):
            raise required()
        raw = auth[0][7:].strip()
        if not raw.startswith(TOKEN_PREFIX):
            raise required()
        return raw

    def resolve(self, raw, public, now=None):
        """The token's row, if the token, its parent session, its person and its mind all still hold; else 401."""
        now = time.time() if now is None else now
        row = self.db.one("SELECT * FROM mind_tokens WHERE token_hash = ?", (token_hash(raw),))
        if row is None:
            raise required()
        if row["revoked_at"] is not None or row["expires_at"] <= now:
            self.sweep(now)
            raise expired()
        session = self.db.one("SELECT * FROM sessions WHERE token_hash = ?", (row["session_hash"],))
        if session is None or (session.get("expires_at") and session["expires_at"] <= now) \
                or (public and not self.public_session_allowed(session)) or session.get("principal") != row["principal"]:
            raise expired()
        if self.hive.personal.person(row["principal"]) is None:
            raise expired()
        mind = self.hive.personal.mind_row(row["principal"])
        if mind is None or mind["id"] != row["mind_id"]:
            raise expired()
        return row

    def count(self, row, now=None):
        """One more call on this token, atomically under its ceiling (r1.1 §K); past it: 401 mind_token_expired."""
        now = time.time() if now is None else now
        moved = self.db.execute("UPDATE mind_tokens SET calls = calls + 1 WHERE token_hash = ? AND revoked_at IS NULL "
                                "AND expires_at > ? AND calls < ?", (row["token_hash"], now, token_max_calls())).rowcount
        if moved != 1:
            raise expired()


# ---- the gateway ---------------------------------------------------------------------------------------------------

def _money(x):
    return f"{max(0.0, float(x)):.6f}"


def _note(hive, method, *args):
    """One advisory r1e record (call_refused, call_reported) in hive.mindgateway, which is never read for a decision.
    Any failure never touches the call."""
    with contextlib.suppress(Exception):
        getattr(hive.mindgateway, method)(*args)


class MindGateway:
    def __init__(self, hive, gateway, reservations, hold_unknown, overrun_flag):
        self.hive, self.gateway, self.reservations = hive, gateway, reservations
        self.hold_unknown, self.overrun_flag = hold_unknown, overrun_flag
        self.tokens = hive.mind_tokens
        self.idem = hive.mind_idempotency   # gate A r1.1: the Idempotency-Key (mind_idempotency.py)

    # ---- request shape ---------------------------------------------------------------------------------------------

    @staticmethod
    def purpose(headers):
        value = headers.get("x-mind-purpose")
        if not value:
            raise _err(400, "purpose_required", "say what this call is for (X-Mind-Purpose: turn)")
        if value == "consolidate":
            raise _err(409, "windows_unavailable", "consolidation windows are not available yet")
        if value != "turn":
            raise _err(400, "invalid", "X-Mind-Purpose is turn")

    def turn(self, row, turn_id):
        """The browser turn this call belongs to: the token's person and mind, route browser_mind, state browser. A closed
        turn is 409 turn_closed; anything else (missing, someone else's, another route) is 404, without saying which."""
        if not turn_id:
            raise _err(404, "not_available", "That isn't available.")
        self.hive.ask.expire()   # its idle and absolute deadlines first
        t = self.hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (str(turn_id)[:120],))
        if t is None or t["principal"] != row["principal"] or t["mind_id"] != row["mind_id"] or t.get("route") != BROWSER_ROUTE:
            raise _err(404, "not_available", "That isn't available.")
        if t["state"] != "browser":
            raise _err(409, "turn_closed", "this turn has ended")
        return t

    @staticmethod
    def body(data):
        if set(data) - BODY_KEYS or not isinstance(data.get("messages"), list) or not data["messages"]:
            raise _err(400, "invalid", "messages, and optionally tools, tool_choice, max_tokens, enable_thinking")
        max_tokens = data.get("max_tokens", DEFAULT_MAX_TOKENS)
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 1 <= max_tokens <= MAX_TOKENS:
            raise _err(400, "invalid", f"max_tokens is 1 to {MAX_TOKENS}")
        out = {k: v for k, v in data.items() if k != "model"}   # the mind's own model is used, whatever was named
        out["max_tokens"] = max_tokens
        return out

    # ---- money -------------------------------------------------------------------------------------------------------

    def _count_turn(self, t):
        """One more call on the turn, atomically: still open, within both its deadlines (at this one `now`; a deadline
        that passed while the body was read is never refreshed away) and under its ceiling."""
        hive, now = self.hive, time.time()
        moved = hive.db.execute("UPDATE ask_turns SET calls = calls + 1, last_call_at = ? WHERE id = ? AND state = 'browser' "
                                f"AND calls < ? AND {BROWSER_LIVE_SQL}",
                                (now, t["id"], turn_max_calls(), *browser_live_params(now))).rowcount
        if moved == 1:
            return
        fresh = hive.ask._row(t["id"])
        if fresh is not None and fresh["state"] == "browser" and browser_past_deadline(fresh, now):
            hive.ask._close(t["id"], "refused", "timed_out")   # as expire() closes it; nothing reserved or sent
            raise _err(409, "turn_closed", "this turn has ended")
        if fresh is not None and fresh["state"] == "browser":   # the ceiling: the turn closes call_cap, nothing is sent
            # r1e: the close records this call_cap refusal (Ask._close -> turn_closed), so it is not recorded twice here
            hive.ask._close(t["id"], "refused", "call_cap")
            raise _err(429, "call_cap", f"this turn reached its {turn_max_calls()} calls")
        raise _err(409, "turn_closed", "this turn has ended")

    def _refuse_spend(self, t, detail, call_id=None):
        """A spend refusal closes the turn host-side as spend_cap with that limit, and answers 402 with it. call_id: a
        refusal at the reservation, which r1e records here by its limit kind (check_budget records its own)."""
        from .conductor import limit_frame
        limit = limit_frame(detail)
        self.hive.ask._close(t["id"], "refused", "spend_limit", limit=limit)
        if call_id is not None:
            kind = detail.get("reason") if detail.get("reason") == "monthly_total_required" else detail.get("kind")
            _note(self.hive, "call_refused", call_id, kind)
        return _err(402, "spend_limit", "a spend limit refused this call", {"limit": limit})

    def _remaining(self, t):
        from .conductor import turn_cap_usd
        hive, res = self.hive, self.reservations
        label = "askturn:" + t["id"]
        turn_left = turn_cap_usd() - res.settled(label) - res.pending(label) / 1_000_000
        thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
        lefts = [turn_left]
        if own_scope(thread):
            lefts.append(float(thread["budget_usd"]) - hive.sessions.thread_spent(thread) - hive.sessions.thread_held(thread))
        return min(lefts)

    # ---- one call ------------------------------------------------------------------------------------------------------

    async def chat(self, request, origins, read_body):
        """One call (_call), with its Idempotency-Key's record kept (gate A r1.1, mind_idempotency.py): every terminal
        answer after the record is committed is stored for the retry; a call cancelled before the send drops its record;
        anything else (the process or the call breaking after the send) leaves it pending, which reads as unknown."""
        ctx = {}
        try:
            answer = await self._call(request, origins, read_body, ctx)
        except HiveError as exc:
            error = {"code": exc.code, "message": exc.message, **(exc.details or {})}
            self._keep(ctx.get("slot"), exc.status, {"error": error}, {})
            raise
        except asyncio.CancelledError:
            slot = ctx.get("slot")
            if slot is not None and slot.committed and slot.unsent:
                with contextlib.suppress(Exception):
                    self.idem.forget(slot)
            raise
        else:
            slot = ctx.get("slot")
            if slot is not None and slot.committed:
                headers = {k: v for k, v in answer.headers.items() if k.lower().startswith("x-hive-")}
                self._keep(slot, answer.status_code, json.loads(answer.body), headers)
            return answer
        finally:
            if ctx.get("slot") is not None:
                self.idem.leave(ctx["slot"])

    def _keep(self, slot, status, body, headers):
        """The terminal answer of a keyed call whose record committed. A failure to store it leaves the record pending
        (read as unknown, never as a free key) and never changes the answer."""
        if slot is None or not slot.committed:
            return
        try:
            self.idem.finish(slot, status, body, headers)
        except Exception:   # noqa: BLE001
            logging.getLogger("hive").exception("mind gateway: a keyed call's answer could not be kept")

    async def _call(self, request, origins, read_body, ctx):
        from starlette.concurrency import run_in_threadpool
        from starlette.responses import JSONResponse

        from .conductor import check_detail, reserve_detail, turn_cap_usd
        hive, gw, res = self.hive, self.gateway, self.reservations
        public = request.scope.get("hive_public", False)
        raw = MindTokens.request_token(request, origins)
        row = self.tokens.resolve(raw, public)
        self.purpose(request.headers)
        key = self.idem.key(request.headers)
        slot = None
        if key is None:   # no Idempotency-Key: no dedupe, exactly as before (the broker always sends one)
            t = self.turn(row, request.headers.get("x-mind-turn"))
            body = self.body(await read_body(request, MAX_BODY))
        else:   # a keyed retry is answered from its record before the turn is looked at (it may have closed since)
            data = await read_body(request, MAX_BODY)
            # one clock reading for this call's replay and claim (Slot.now)
            slot = Slot(row["principal"], row["mind_id"], key, MindIdempotency.digest(request.headers.get("x-mind-turn"), data),
                        time.time())
            stored = self.idem.replay(slot, self.reservations.get)
            if stored is not None:
                status, answer, headers = stored
                return JSONResponse(answer, status_code=status,
                                    headers={**headers, "Cache-Control": "no-store", "Idempotent-Replay": "true"})
            ctx["slot"] = slot
            t = self.turn(row, request.headers.get("x-mind-turn"))
            body = self.body(data)
        # the mind's own model, and of its options only who pays (its assigned key and that key's lock; Gateway.
        # payment_options): the same key Budgets.settlement shows on the person's page, and a locked key stays locked
        stored = hive._agent_row(row["mind_id"])
        agent = {**stored, "options": gw.payment_options(stored)}
        provider_name, _ = split_model(agent["model"])
        try:
            # the token's principal, for the one route that reads it (a subscription instance); every other call is unchanged
            who = {"principal": row["principal"]} if is_subscription(provider_name) else {}
            paid, estimate = gw.estimate(agent, body, hive.settings.allow_unpriced, **who)
            key_id = gw.paying_key(agent, provider_name)[0] if paid else None
        except GatewayError as exc:
            if exc.status == 402:   # unpriced_model, key_unavailable: not a spend limit; the turn ends in error
                hive.ask._close(t["id"], "refused", "failed", error=exc.code)
                raise _err(402, exc.code, "this call cannot be priced or paid for") from None
            raise _err(exc.status, exc.code, "this request was refused") from None
        # the shape and the price are checked first (estimate is pure, plus the egress rule), so a malformed or refused
        # request spends neither the token's nor the turn's call ceiling; the counts still come before any payer,
        # budget, reservation or send
        # this call's request id: its reservation's id, and r1e's evidence source. A keyed call's is derived from the person
        # and the key (gate A r1.1), so its reservation names the key after the key's record has expired.
        call_id = call_id_for(slot.principal, slot.key) if slot is not None else str(uuid.uuid4())
        # Both ceilings hold under concurrency only because count, _count_turn and Reservations.reserve all run on the
        # hive's one SQLite connection under Database._lock: each `UPDATE ... WHERE calls < ?` is atomic there. Do not move
        # either count or the reservation onto another connection or a pool without making them one transaction.
        self.tokens.count(row)
        self._count_turn(t)
        key_owner = ((gw.keyring.ring.get("keys") or {}).get(key_id) or {}).get("owner") if (key_id and gw.keyring) else None
        payer, own_key = hive.payer_for(agent, key_owner)   # exactly the chat route's rule (never the conductor's)
        try:   # a refusal here is recorded by check_budget itself (r1e), once per call id
            hive.check_budget(agent, paid, estimate, key_id, payer, own_key, turn_bound=True, evidence_id=call_id)
        except HiveError as exc:
            if exc.status == 402:
                raise self._refuse_spend(t, check_detail(hive, agent, exc, estimate)) from None
            if exc.status == 429:
                raise _err(429, "rate_limited", "too many calls just now") from None
            raise

        reservation = None
        if paid:
            reservation = call_id
            turn_label = "askturn:" + t["id"]

            def budgets():
                if slot is not None:
                    # gate A r1.1: the key's record commits with this reservation, or neither does. It must stay here,
                    # before reserve's binding check in the same transaction: the record's key arbitrates a live race
                    # (in_progress); the reservation id only guards a key whose record has expired (mind_idempotency.py)
                    self.idem.claim(slot, call_id)
                # inside the reservation's write transaction: a payer that changed since admission refuses the call
                if hive.payer_for(hive._agent_row(row["mind_id"]), key_owner) != (payer, own_key):
                    raise ValueError("payer changed during admission")
                # money port r1.2: the calling person's use of this key read again (disabled, grant revoked since the
                # preflight); its 402 rolls this transaction back, the key's record included: nothing reserved or sent
                host_use_check(hive, row["mind_id"], key_id, payer, user=row["principal"])
                rows = host_budget_snapshot(hive, row["mind_id"], key_id, payer, own_key, turn_bound=True)
                rows.append((turn_label, turn_cap_usd(), res.settled(turn_label)))   # the interim per-turn guard
                thread = hive.db.one("SELECT * FROM work_sessions WHERE id = ?", (t["thread_id"],))
                if own_scope(thread):                                                # the interim per-thread guard
                    rows.append((thread_scope(thread["id"]), float(thread["budget_usd"]), hive.sessions.thread_spent(thread)))
                return rows
            try:
                made = res.reserve(reservation, {"agent": row["mind_id"], "model": agent["model"], "body": body, "payer": payer,
                                          "key": key_id, "turn": t["id"]},
                            estimate, budgets, metadata={"agent": row["mind_id"], "model": agent["model"], "payer": payer,
                                                         "key": key_id, "kind": "browser-mind", "turn": t["id"]},
                            dispatched=False, subjects=host_subjects(hive, row["mind_id"], key_id, payer, own_key, turn_bound=True))
            except KeyTaken:
                raise in_progress() from None
            except BudgetExhausted as exc:
                raise self._refuse_spend(t, reserve_detail(hive, exc), call_id) from None
            except HiveError as exc:
                if exc.status == 402:   # host_use_check refused in the transaction: as check_budget's 402, recorded here
                    raise self._refuse_spend(t, check_detail(hive, agent, exc, estimate), call_id) from None
                raise
            except ValueError as exc:
                if slot is not None and "identity reused" in str(exc):   # this key's reservation from before, another body
                    raise key_expired(res.get(call_id)) from None
                if "payer changed" in str(exc):
                    raise _err(409, "payer_changed", "who pays for this mind changed meanwhile; ask again") from None
                if "monthly_total_required" in str(exc):
                    raise self._refuse_spend(t, check_detail(hive, agent, hive.budgets.total_required(own_key), None),
                                             call_id) from None
                raise self._refuse_spend(t, {"code": "reservation", "kind": "unknown", "estimate_usd": estimate}, call_id) from None
            if not made.get("new"):   # this key's reservation from before (its record expired): sent once, never again
                raise key_expired(made)

        if slot is not None and reservation is None:   # a free call has no reservation: its record commits on its own
            try:
                with hive.db.transaction():
                    self.idem.claim(slot, call_id)
            except KeyTaken:
                raise in_progress() from None
        if slot is not None:
            slot.committed = True   # the record stands before anything can be sent

        why = {}

        def still_valid():
            """At the send gate (r1.1 §A): the whole resolution again (token, parent session, person, mind) and the turn
            (still this person's open browser turn, within its call ceiling and both its deadlines, whether or not
            reconciliation has closed it yet). Any failure: nothing is sent. `calls == ceiling` passes: this call is
            already counted."""
            try:
                self.tokens.resolve(raw, public)
            except HiveError:
                why["token"] = True
                return False
            now_t = hive.ask._row(t["id"])
            if now_t is None or now_t["state"] != "browser" or now_t["principal"] != row["principal"] \
                    or now_t["mind_id"] != row["mind_id"] or int(now_t["calls"]) > turn_max_calls():
                return False
            if browser_past_deadline(now_t):
                why["expired"] = True
                return False
            return True

        gated = gated_chat(gw, res, agent, body, reservation, still_valid, principal=who.get("principal"))
        try:
            response, usage = await gated.run()
        except GateClosed:
            gated.release()
            if why.get("expired"):
                hive.ask.expire()   # past a deadline at the gate: the turn closes timed_out now, not at the next pass
            raise (expired() if why.get("token") else _err(409, "turn_closed", "this turn has ended")) from None
        except asyncio.CancelledError:
            if gated.started:
                if reservation:
                    self.hold_unknown(reservation)
                    _note(hive, "call_reported", reservation, agent["model"], False)
            else:
                gated.release()
                if slot is not None:
                    slot.unsent = True
            raise
        except BaseException as exc:   # the provider failed, or the connection did: never its text
            held = None
            if gated.started and reservation:
                if not self.hold_unknown(reservation, exc):   # a refusal with a charge settles; a guaranteed-unbilled one (OpenRouter 402) is released
                    _note(hive, "call_reported", reservation, agent["model"], False)
                    held = estimate
            else:
                gated.release()
            timeout = isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException))
            raise _err(504 if timeout else 502, "upstream_error", "the model's provider did not answer",
                       {"held_usd": round(held, 6)} if held else None) from None

        # answered: nothing below raises to the caller; any failure keeps the worst case held
        resolved = response.get("model") if isinstance(response, dict) else None
        if not reservation:
            await run_in_threadpool(hive.record_usage, agent, agent["model"], usage, resolved, payer)
            # plan usage (the owner's subscription) is never reported as free (CLI route R3.1 §H)
            cost, state = float(usage.get("cost_usd") or 0), ("plan" if usage.get("payer_mode") == "plan" else "free")
        else:
            cost, state = estimate, "unknown"
            try:
                observation = {"usage_origin": "usage-unverified"}
                if isinstance(response, dict):
                    for field, target in (("id", "response_id"), ("model", "resolved_model")):
                        if isinstance(response.get(field), str):
                            observation[target] = response[field][:200]
                res.observe(reservation, observation)
                if not billable(response, usage):
                    self.hold_unknown(reservation)
                else:
                    counted = isinstance(response.get("usage"), dict) and type(response["usage"].get("prompt_tokens")) is int
                    observation["usage_origin"] = ("provider-token-counters-rate-derived" if counted
                                                   else "provider-usage-cost")
                    res.observe(reservation, observation)
                    await run_in_threadpool(res.settle, reservation, usage["cost_usd"],
                                            lambda: hive.record_usage(agent, agent["model"], usage, resolved, payer),
                                            self.overrun_flag)
                    cost, state = float(usage["cost_usd"]), "settled"
            except asyncio.CancelledError:
                self.hold_unknown(reservation)
                _note(hive, "call_reported", reservation, agent["model"], False)
                raise
            except Exception:
                self.hold_unknown(reservation)
                state = "unknown"
            if state in ("settled", "unknown"):   # r1e: the call settled at its reported cost, or is held unknown
                _note(hive, "call_reported", reservation, agent["model"], state == "settled")
        fresh = hive.ask._row(t["id"]) or t
        headers = {"X-Hive-Call-Cost-USD": _money(cost), "X-Hive-Call-Cost-State": state,
                   "X-Hive-Turn-Remaining-USD": _money(self._remaining(t)),
                   "X-Hive-Turn-Calls-Remaining": str(max(0, turn_max_calls() - int(fresh["calls"]))),
                   "Cache-Control": "no-store"}
        return JSONResponse(response, headers=headers)
