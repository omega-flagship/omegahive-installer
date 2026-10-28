"""J3 host round R5 (O1): the person's steer reaches the Studio maker as a queued direction, coalesced at the step boundary.

Plan PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md §4 as amended by r1.1 K6 and r1.5 H3.3. Ask.steer (ask.py) asks
steer_session() right after its replay check and before its "conducting refused" and "closed -> fresh paid turn"
branches. When the person's own Studio session is bound to the steered turn (its setup turn, or a turn on its thread
during the session's time), direction() records the words in ask_steers (outcome 'studio', the session's next
studio_seq) in Ask's transaction; nothing is pushed to the maker. The words wait in the queue and reach the maker only
through the next step's in-step context read (studio_steps.context), and the sweep's predicate ("queued directions
exist") makes them work for a next step. With Studio off, or no bound session, steer_session() is None and Ask.steer is
byte-identical to before.

Limits (§4.6): text <= MAX_TEXT (Ask's body check); the person's PER_MINUTE / PER_DAY counters, counted over their Ask
turns and their Studio directions together; at most MAX_UNREAD_DIRECTIONS directions queued and not yet read per session.
A session that is stopping or has ended refuses with 409 studio_session_closed and writes nothing (K6); a paused or held
session queues and says so.
"""

from __future__ import annotations

import time

from .db import now
from .minds import canonical

CLOSED_STATES = ("stopping", "stopped")


class StudioSteers:
    """Mixed into StudioSessions through StudioSteps: hive, enabled, _err, _session_event, MAX_UNREAD (studio_steps)."""

    def steer_session(self, principal, turn):
        """The person's consent-v2 Studio session this Ask turn steers, or None (and Ask.steer goes on as before).
        Bound: the session's own setup turn, or a turn on the session's thread that began before the session ended. A turn
        begun after the session ended is an ordinary Ask turn again (decision recorded in the R5 handoff)."""
        if not getattr(self, "enabled", False) or turn is None:
            return None
        from .studio_sessions import CONSENT_PAYLOAD_VERSION
        rows = self.hive.db.all(
            "SELECT * FROM studio_sessions WHERE principal = ? AND consent_payload_version >= ? AND (ask_turn_id = ? OR "
            "(thread_id IS NOT NULL AND thread_id = ?)) ORDER BY created_at DESC, rowid DESC",
            (principal, CONSENT_PAYLOAD_VERSION, turn["id"], turn.get("thread_id") or ""))
        for row in rows:
            if row["state"] != "stopped":
                return row                                   # active, paused, held or stopping
            ended = row.get("stopped_at") or row.get("updated_at")
            if row["ask_turn_id"] == turn["id"] or (ended and str(turn["created_at"]) <= str(ended)):
                return row                                   # ended: its own turns get studio_session_closed
        return None

    def _steer_quota_ok(self, principal):
        """§4.6: the same per-person counters as Ask requests (ask.PER_MINUTE / PER_DAY), over the person's Ask turns and
        their Studio directions together."""
        from .ask import PER_DAY, PER_MINUTE, _iso
        t = time.time()
        minute, day = _iso(t - 60), _iso(t - 86400)
        db = self.hive.db
        turns = db.one("SELECT SUM(created_at >= ?) AS minute, COUNT(*) AS day FROM ask_turns WHERE principal = ? AND "
                       "created_at >= ?", (minute, principal, day))
        steers = db.one("SELECT SUM(created_at >= ?) AS minute, COUNT(*) AS day FROM ask_steers WHERE principal = ? AND "
                        "outcome = 'studio' AND created_at >= ?", (minute, principal, day))
        return ((turns["minute"] or 0) + (steers["minute"] or 0) < PER_MINUTE
                and (turns["day"] or 0) + (steers["day"] or 0) < PER_DAY)

    def direction(self, ask, viewer, turn, ses, body, body_digest):
        """Inside Ask.steer's transaction: record one direction for the session (plan §4.2) and return (answer, frame,
        room_id). Raises the refusal (and writes nothing) for a closed session or a limit."""
        from .ask import refusal
        from .studio_steps import MAX_UNREAD_DIRECTIONS
        hive, db = self.hive, self.hive.db
        ses = db.one("SELECT * FROM studio_sessions WHERE id = ?", (ses["id"],))     # re-read in this transaction
        if ses["state"] in CLOSED_STATES:
            raise self._err(409, "studio_session_closed", "That Studio session has ended; your words were not sent.",
                            session_id=ses["id"], state=ses["state"])
        if body["at_seq"] >= turn["next_seq"]:       # the page cannot have seen a frame the turn has not sent
            raise refusal(hive, "invalid")
        unread = db.one("SELECT COUNT(*) AS n FROM ask_steers WHERE studio_session_id = ? AND studio_read_at IS NULL AND "
                        "studio_cancelled_at IS NULL", (ses["id"],))["n"]
        if unread >= MAX_UNREAD_DIRECTIONS:
            raise refusal(hive, "rate_limited", limit_steers=MAX_UNREAD_DIRECTIONS)
        if not self._steer_quota_ok(viewer.principal):
            raise refusal(hive, "rate_limited")
        seq = ses["next_dir_seq"]
        db.execute("UPDATE studio_sessions SET next_dir_seq = next_dir_seq + 1, updated_at = ? WHERE id = ? AND "
                   "next_dir_seq = ?", (now(), ses["id"], seq))
        # the words stay in the person's conversation (as an open turn's steer does), and reach no mind from there
        thread = db.one("SELECT * FROM work_sessions WHERE id = ?", (turn["thread_id"],)) if turn.get("thread_id") else None
        room_id = thread["room_id"] if thread and thread.get("room_id") else None
        room_msg = hive.rooms._append(room_id, viewer.principal, body["text"], [], 0) if room_id else None
        studio = {"session_id": ses["id"], "seq": seq}
        frame = ask._frame(turn["id"], "steer", steer_id=body["steer_id"], text=body["text"], at_seq=body["at_seq"],
                           via=body["via"], studio=studio)
        answer = {"steer_id": body["steer_id"], "operation_id": turn["operation_id"], "turn_id": turn["id"],
                  "new_turn": False, "seq": frame["seq"] if frame else None, "via": body["via"],
                  "studio": {**studio, "state": "queued", "session_state": ses["state"]}}
        # the words are kept for the maker, even on a personal turn (plan §4.2, disclosed on the card, §10 item 8)
        db.insert("ask_steers", {
            "principal": viewer.principal, "steer_id": body["steer_id"], "turn_id": turn["id"], "body_digest": body_digest,
            "text": body["text"], "via": body["via"], "at_seq": body["at_seq"], "seq": answer["seq"],
            "room_message_id": room_msg["id"] if room_msg else "", "delivery_message_id": "", "created_at": now(),
            "outcome": "studio", "new_operation_id": None, "studio_session_id": ses["id"], "studio_seq": seq,
            "studio_step": None, "studio_read_at": None, "studio_answer": canonical(answer)})
        return answer, frame, room_id
