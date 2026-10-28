"""People's answers as evidence the hive can reason over (the owner, 2026-10-04: the parts must meet in Hyperon).

Every answer a person gives (to a mind's approval, or to a person's request) is one NAL observation, integrated into
the governance commons (&commons_governance, PeTTa) by the same lib_hive revision every swarm commons uses:
  (--> (x <mind> <skill>) approved)    f = 1 for once/for/always, 0 for no/never
  (--> (x <person> <ask-kind>) granted)
(x ...) is the NAL product, spelled in ASCII because space symbols are ASCII.
Each answer carries its own evidence id and confidence 0.5 (one observation, evidential horizon k = 1), so revision
accumulates honestly: n consistent answers give c = n/(n+1), and repeating a standing rule is not new evidence.

This is advisory and inspectable. It informs the next card ("you have approved this 4 of 4 times") and is open to
PLN/NAL, motivation and the minds through the spaces API. It never decides: authority stays with the people.
"""

from __future__ import annotations

import re

COMMONS = "governance"


def symbol(text):
    """A space-safe symbol for an id or skill (app actions such as program:studio:save keep their shape)."""
    s = re.sub(r"[^A-Za-z0-9_\-:.]", "_", str(text)).replace(":", ".")
    return s if re.match(r"^[A-Za-z_]", s) else "x_" + s


def approval_statement(agent_id, skill):
    return f"(--> (x {symbol(agent_id)} {symbol(skill)}) approved)"


def ask_statement(person, kind):
    return f"(--> (x {symbol(person)} {symbol('ask-' + kind)}) granted)"


class GovernanceEvidence:
    """One evidence log + commons. The hive keeps two: governance (people's answers) and placement (where minds run)."""

    def __init__(self, hive, commons=COMMONS):
        self.hive, self.commons = hive, commons
        self.table = f"{commons}_evidence"
        self.speaker = f"hive-{commons}"
        hive.db.execute(f"CREATE TABLE IF NOT EXISTS {self.table} (n INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT UNIQUE, "
                        "statement TEXT NOT NULL, f REAL NOT NULL, created_at TEXT NOT NULL)")

    def _spaces(self):
        return getattr(self.hive, "spaces", None)

    def record(self, source, statement, positive):
        """One answer, once: `source` (the approval or request id) makes a retried record a no-op."""
        from .db import now
        if self.hive.db.one(f"SELECT 1 FROM {self.table} WHERE source = ?", (source,)):
            return None
        self.hive.db.execute(f"INSERT INTO {self.table} (source, statement, f, created_at) VALUES (?, ?, ?, ?)",
                             (source, statement, 1.0 if positive else 0.0, now()))
        n = self.hive.db.one(f"SELECT n FROM {self.table} WHERE source = ?", (source,))["n"]
        spaces = self._spaces()
        if spaces is None:
            return None
        try:
            spaces.grant(self.speaker, self.commons)
            return spaces.publish(self.commons, self.speaker, statement, 1.0 if positive else 0.0, 0.5, [f"ev:{self.speaker}:{n}"])
        except Exception as exc:   # evidence is advisory: a failed record never blocks the person's answer
            self.hive.events.publish(f"{self.commons}.evidence_failed", source=source, error=str(exc)[:300])
            return None

    def track_record(self, statement):
        """The revised belief plus the plain count behind it, for the person deciding next."""
        rows = self.hive.db.all(f"SELECT f FROM {self.table} WHERE statement = ?", (statement,))
        out = {"statement": statement, "answers": len(rows), "positive": sum(1 for r in rows if r["f"] >= 0.5), "tv": None}
        spaces = self._spaces()
        if rows and spaces is not None:
            try:
                belief = spaces.belief(self.commons, statement)
                out["tv"] = belief["tv"] if belief else None
            except Exception:
                pass
        return out
