"""Screen blocks a screen asked for that nothing draws yet (hive/ui screens/buildTasks.ts), filed once as hive tasks.

When MeTTa composes a screen and a part names a block the renderer does not have, the part falls back to its role's block
and the block is "missing". Browsers report each one, best-effort and batched. The host keeps ONE row per
(screen, wanted): the reporting release is only counted (it comes from the caller, so it never makes a new task). The
first time an ADMIN's report names a block with no task, the host files ONE task in Create's Code swarm through the
goals API (created_by host:screens), at most FILE_LIMIT filings per FILE_WINDOW across the hive. Members' reports are
counted and never file. Rows hold no person data: who reported a block is used only to pace reports, in memory.

Fail-closed: with no Code swarm (person_minds purpose foundation_create_code) nothing is stored and nothing is filed.
"""
from __future__ import annotations

import datetime
import logging
import re
import threading
import time
from collections import deque

from .db import now

log = logging.getLogger(__name__)

CODE_PURPOSE = "foundation_create_code"
CREATED_BY = "host:screens"
NAME = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
RELEASE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_ITEMS = 20                     # per report
LIMIT, WINDOW = 60, 600.0          # items one principal may report per window (seconds)
FILE_LIMIT, FILE_WINDOW = 10, 3600.0  # tasks the whole hive may file per window
STALE_CLAIM = datetime.timedelta(minutes=5)  # a claim with no task this old was cut off mid-filing: claim it again

SCHEMA = """CREATE TABLE IF NOT EXISTS screens_missing (
  screen TEXT NOT NULL, wanted TEXT NOT NULL, drawn_as TEXT, last_release TEXT NOT NULL,
  task_id TEXT, claimed_at TEXT, reports INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  PRIMARY KEY (screen, wanted))"""


def _older_than(stamp: str | None, age: datetime.timedelta) -> bool:
    if not stamp:
        return True
    try:
        then = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return True
    if then.tzinfo is None:
        then = then.replace(tzinfo=datetime.timezone.utc)
    return datetime.datetime.now(datetime.timezone.utc) - then > age


class ScreensMissing:
    def __init__(self, hive, *, limit: int = LIMIT, window: float = WINDOW, file_limit: int = FILE_LIMIT,
                 file_window: float = FILE_WINDOW, clock=time.monotonic):
        self.hive, self.db = hive, hive.db
        self.limit, self.window, self.clock = limit, window, clock
        self.file_limit, self.file_window = file_limit, file_window
        self._seen: dict[str, deque] = {}
        self._filed: deque = deque()
        self._lock = threading.Lock()
        self.db.execute(SCHEMA)

    def _paced(self, principal: str, n: int) -> None:
        """At most `limit` items per principal per window; over that the whole report is refused (429)."""
        t = self.clock()
        with self._lock:
            for who in [k for k, q in self._seen.items() if q and t - q[-1] > self.window]:
                del self._seen[who]           # nobody's empty history is kept
            q = self._seen.setdefault(principal, deque())
            while q and t - q[0] > self.window:
                q.popleft()
            if len(q) + n > self.limit:
                raise self.hive.error(429, "too_many_reports", "too many missing-block reports; try again later")
            q.extend([t] * n)

    def _may_file(self) -> bool:
        """The hive-wide filing allowance: at most `file_limit` new tasks per window."""
        t = self.clock()
        with self._lock:
            while self._filed and t - self._filed[0] > self.file_window:
                self._filed.popleft()
            if len(self._filed) >= self.file_limit:
                return False
            self._filed.append(t)
            return True

    def _code_swarm(self) -> str:
        if self.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_minds'") is None:
            row = None
        else:
            row = self.db.one("SELECT swarm_id FROM person_minds WHERE purpose = ?", (CODE_PURPOSE,))
        if not row or not isinstance(row["swarm_id"], str) or not row["swarm_id"]:
            raise self.hive.error(409, "code_swarm_missing", "this hive has no Code swarm to build screen blocks")
        return row["swarm_id"]

    @staticmethod
    def _items(items) -> list[dict]:
        if not isinstance(items, list) or not items or len(items) > MAX_ITEMS:
            raise ValueError(f"items must be a list of 1 to {MAX_ITEMS} missing blocks")
        out = []
        for it in items:
            if not isinstance(it, dict):
                raise ValueError("each item is an object")
            release, screen, wanted = it.get("ui_release"), it.get("screen"), it.get("wanted")
            drawn = it.get("drawn_as")
            if not (isinstance(release, str) and RELEASE.match(release)):
                raise ValueError("ui_release must be a short release name")
            if not (isinstance(screen, str) and NAME.match(screen) and isinstance(wanted, str) and NAME.match(wanted)):
                raise ValueError("screen and wanted must be plain names")
            if drawn is not None and not (isinstance(drawn, str) and NAME.match(drawn)):
                raise ValueError("drawn_as must be a plain name or absent")
            out.append({"ui_release": release, "screen": screen, "wanted": wanted, "drawn_as": drawn})
        return out

    def _count(self, it: dict, may_claim: bool) -> tuple[bool, str | None]:
        """One transaction: count the report, and claim the block for filing when it has no task (nor a live claim) and
        this report may file. Returns (claimed, task_id)."""
        stamp = now()
        key = (it["screen"], it["wanted"])
        with self.db.transaction():
            row = self.db.one("SELECT task_id, claimed_at FROM screens_missing WHERE screen = ? AND wanted = ?", key)
            if row is None:
                self.db.execute("INSERT INTO screens_missing (screen, wanted, drawn_as, last_release, claimed_at, first_seen, last_seen) "
                                "VALUES (?, ?, ?, ?, ?, ?, ?)", (*key, it["drawn_as"], it["ui_release"], stamp if may_claim else None, stamp, stamp))
                return may_claim, None
            claim = may_claim and row["task_id"] is None and _older_than(row["claimed_at"], STALE_CLAIM)
            self.db.execute("UPDATE screens_missing SET reports = reports + 1, last_seen = ?, last_release = ?, drawn_as = ?"
                            + (", claimed_at = ?" if claim else "") + " WHERE screen = ? AND wanted = ?",
                            (stamp, it["ui_release"], it["drawn_as"], *([stamp] if claim else []), *key))
            return claim, row["task_id"]

    async def _file(self, swarm: str, it: dict) -> str | None:
        """File the block's one task. The record and its task id are saved together before anyone is told, so a
        failure to announce never makes a second task; a failure to save gives the claim back."""
        key = (it["screen"], it["wanted"])
        try:
            goal = self.hive.goals._create_record(
                swarm, f"Build the screen block '{it['wanted']}'",
                f"The {it['screen']} screen asks for a block named '{it['wanted']}' that nothing draws yet. Until it "
                f"exists the part is drawn as '{it['drawn_as'] or 'nothing'}'. Add it to hive/ui screens (its Block, "
                "Prefer and RoleDepth atoms in lib_screens.metta, a renderer in Screen.tsx, a README row and tests).",
                0.3, created_by=CREATED_BY)
        except Exception:
            self.db.execute("UPDATE screens_missing SET claimed_at = NULL WHERE screen = ? AND wanted = ? AND task_id IS NULL", key)
            raise
        self.db.execute("UPDATE screens_missing SET task_id = ?, claimed_at = NULL WHERE screen = ? AND wanted = ?", (goal["id"], *key))
        try:
            await self.hive.goals.announce(goal)
        except Exception:   # the task stands; the swarm hears of it on its next read
            log.warning("screens_missing: task %s filed but not announced", goal["id"], exc_info=True)
        return goal["id"]

    async def report(self, principal: str, items, *, admin: bool = False) -> dict:
        try:
            batch = self._items(items)
        except ValueError as exc:
            raise self.hive.error(400, "bad_request", str(exc)) from exc
        self._paced(principal, len(batch))      # every report is paced, a refused one too
        swarm = self._code_swarm()               # fail-closed before anything is stored
        results = []
        for it in batch:
            claimed, task_id = self._count(it, may_claim=admin)
            filed = False
            if claimed:
                if self._may_file():
                    task_id = await self._file(swarm, it)
                    filed = True
                else:   # over the hive's allowance: give the claim back, a later report files it
                    self.db.execute("UPDATE screens_missing SET claimed_at = NULL WHERE screen = ? AND wanted = ? AND task_id IS NULL",
                                    (it["screen"], it["wanted"]))
            item = {"screen": it["screen"], "wanted": it["wanted"], "filed": filed}
            if admin:
                item["task_id"] = task_id
            results.append(item)
        return {"items": results}

    def list(self) -> list[dict]:
        rows = self.db.all("SELECT screen, wanted, drawn_as, last_release, task_id, reports, first_seen, last_seen "
                           "FROM screens_missing ORDER BY first_seen, screen, wanted")
        return [dict(r) for r in rows]
