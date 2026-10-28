"""Nothing a mind did is deleted, only moved: trace archive and log rotation.

- Traces: the database keeps each mind's most recent ones (TRACE_KEEP). Older traces are first appended to a
  compressed archive, one file per mind per day (archive/traces/<mind>/<YYYY-MM-DD>.jsonl.gz), indexed, and only
  then removed from the database. They stay readable through the API.
- Logs: a mind's raw process log rolls over at LOG_LIMIT bytes into archive/logs/<mind>/agent-<stamp>.log.gz
  (these logs compress about tenfold), recorded with its sha256; the platform never cuts a log.
- A mind's own memory (spaces, history, notes) is never pruned by the platform: consolidating or forgetting is the
  mind's own business.
Archives live in the hive's data directory (outside every mind's sandbox); moving them to cloud storage goes
through the asset store's verified transfer.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import time

from .db import now

TRACE_KEEP = 2000
LOG_LIMIT = 10 * 1024 * 1024

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS trace_archive (agent_id TEXT NOT NULL, day TEXT NOT NULL, entries INTEGER NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, day))""",
    """CREATE TABLE IF NOT EXISTS log_archive (agent_id TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, file))""",
]


class Archive:
    def __init__(self, hive):
        self.hive = hive
        for s in SCHEMA:
            hive.db.execute(s)
        self.root = hive.settings.data_dir / "archive"

    # ---- traces ----------------------------------------------------------------------------------

    def _trace_file(self, agent_id, day):
        return self.root / "traces" / agent_id / f"{day}.jsonl.gz"

    def archive_traces(self, agent_id, keep=TRACE_KEEP, slack=0):
        """Move every trace older than the newest `keep` into the day archives, then remove them from the database.
        With `slack`, nothing happens until more than keep + slack are held, so archiving runs in batches."""
        db = self.hive.db
        if slack and db.one("SELECT id FROM traces WHERE agent_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?", (agent_id, keep + slack)) is None:
            return 0
        cutoff = db.one("SELECT id FROM traces WHERE agent_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?", (agent_id, keep))
        if cutoff is None:
            return 0
        rows = db.all("SELECT * FROM traces WHERE agent_id = ? AND id <= ? ORDER BY id", (agent_id, cutoff["id"]))
        by_day = {}
        for r in rows:
            by_day.setdefault(str(r["created_at"])[:10], []).append(r)
        for day, items in by_day.items():
            path = self._trace_file(agent_id, day)
            path.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(path, "at", encoding="utf-8") as f:   # appended gzip members read back as one stream
                for r in items:
                    f.write(json.dumps(r, default=str) + "\n")
            db.execute("INSERT INTO trace_archive VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, day) DO UPDATE SET "
                       "entries = entries + excluded.entries, updated_at = excluded.updated_at",
                       (agent_id, day, len(items), now()))
        # only after every row is written
        db.execute("DELETE FROM traces WHERE agent_id = ? AND id <= ?", (agent_id, cutoff["id"]))
        return len(rows)

    def trace_days(self, agent_id):
        return self.hive.db.all("SELECT day, entries, updated_at FROM trace_archive WHERE agent_id = ? ORDER BY day DESC", (agent_id,))

    def read_day(self, agent_id, day, limit=500, offset=0):
        path = self._trace_file(agent_id, day)
        if not path.exists():
            raise self.hive.error(404, "not_found", "no archive for that day")
        out = []
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i < offset:
                    continue
                if len(out) >= limit:
                    break
                row = json.loads(line)
                out.append(self.hive.trace_view(row) if hasattr(self.hive, "trace_view") else row)
        return out

    # ---- logs ------------------------------------------------------------------------------------

    def rotate_logs(self, limit=LOG_LIMIT):
        """Roll over any mind's process log past `limit`: compress a copy into the archive, record it, then empty
        the live file (minds append, so the next line simply starts the fresh file)."""
        rolled = []
        agents_dir = self.hive.settings.agents_dir
        if not agents_dir.exists():
            return rolled
        for live in agents_dir.glob("*/agent.log"):
            try:
                if live.stat().st_size <= limit:
                    continue
            except OSError:
                continue
            agent_id = live.parent.name
            stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
            dest = self.root / "logs" / agent_id / f"agent-{stamp}.log.gz"
            dest.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with open(live, "rb") as src, gzip.open(dest, "wb") as out:
                for chunk in iter(lambda: src.read(1 << 20), b""):
                    digest.update(chunk)
                    out.write(chunk)
                copied = src.tell()
            # empty only what was copied; anything appended meanwhile is kept at the start of the live file
            with open(live, "r+b") as f:
                f.seek(copied)
                tail = f.read()
                f.seek(0)
                f.write(tail)
                f.truncate(len(tail))
            self.hive.db.execute("INSERT OR REPLACE INTO log_archive VALUES (?, ?, ?, ?, ?)",
                                 (agent_id, dest.name, copied, "sha256:" + digest.hexdigest(), now()))
            rolled.append({"agent_id": agent_id, "file": dest.name, "bytes": copied})
        return rolled

    def logs(self, agent_id):
        return self.hive.db.all("SELECT file, bytes, sha256, created_at FROM log_archive WHERE agent_id = ? ORDER BY created_at DESC", (agent_id,))
