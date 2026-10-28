"""Per-person app drafts (Surface Studio slice 2, Design's contract in DESIGN_REPLY_TO_SURFACE.md §1).

A draft belongs to exactly (principal, program, swarm, key). It is never visible to another person, never a published
artifact and never adoption. Revisions are optimistic: a save names the revision it expects, and a mismatch is a 409
carrying the current one. The last DRAFT_KEEP revisions per key are kept; a key idle for DRAFT_IDLE_DAYS expires."""
from __future__ import annotations

import datetime
import json
import re

from .db import now

DRAFT_KEEP = 20
DRAFT_IDLE_DAYS = 30
DRAFT_MAX_BYTES = 256 * 1024
KEY = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")

SCHEMA = """CREATE TABLE IF NOT EXISTS app_drafts (
  program TEXT NOT NULL, swarm TEXT NOT NULL, principal TEXT NOT NULL, draft_key TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT NOT NULL, source_ref TEXT, saved_at TEXT NOT NULL,
  PRIMARY KEY (program, swarm, principal, draft_key, revision))"""
# The last revision ever issued per key. Deleting or expiring a draft removes its content, never this, so a revision
# number is never reused and a stale editor's expected_revision cannot match a recreated draft (OmegaReview next8 B2).
KEYS = """CREATE TABLE IF NOT EXISTS app_draft_keys (
  program TEXT NOT NULL, swarm TEXT NOT NULL, principal TEXT NOT NULL, draft_key TEXT NOT NULL, last_revision INTEGER NOT NULL,
  PRIMARY KEY (program, swarm, principal, draft_key))"""


class AppDrafts:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self.db.execute(SCHEMA)
        self.db.execute(KEYS)

    def _scope(self, program_id, swarm_id, principal, key=None):
        if not isinstance(principal, str) or not principal.startswith("user:"):
            raise self.hive.error(403, "person_required", "drafts belong to a signed-in person")
        if not isinstance(swarm_id, str) or not swarm_id:
            raise self.hive.error(400, "bad_request", "swarm_id is required")
        if key is not None and not KEY.fullmatch(str(key)):
            raise self.hive.error(400, "bad_draft_key", "a draft key is 1-80 letters, digits, dots, dashes or underscores")
        # unknown, disabled or drifted apps keep no drafts, and only in a swarm the app actually lives in
        if not self.hive.programs.homes(program_id, {swarm_id}):
            raise self.hive.error(404, "app_not_here", f"{program_id} is not set up in this swarm")
        # and only for a person the app itself admitted here, recently (OmegaReview next8 B1)
        if not self.hive.programs.admitted(principal, program_id, swarm_id):
            raise self.hive.error(403, "app_not_opened", f"open {program_id} in this swarm first; it decides who may use it")

    def _prune(self, program_id, swarm_id, principal):
        cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DRAFT_IDLE_DAYS)).isoformat().replace("+00:00", "Z")
        self.db.execute("DELETE FROM app_drafts WHERE program = ? AND swarm = ? AND principal = ? AND draft_key IN "
                        "(SELECT draft_key FROM app_drafts WHERE program = ? AND swarm = ? AND principal = ? "
                        "GROUP BY draft_key HAVING MAX(saved_at) < ?)",
                        (program_id, swarm_id, principal, program_id, swarm_id, principal, cutoff))

    def save(self, program_id, swarm_id, principal, key, data):
        self._scope(program_id, swarm_id, principal, key)
        if not isinstance(data, dict) or set(data) - {"swarm_id", "expected_revision", "body", "source_ref"}:
            raise self.hive.error(400, "bad_request", "a draft save takes swarm_id, expected_revision, body and source_ref")
        body, expected, ref = data.get("body"), data.get("expected_revision"), data.get("source_ref")
        if not isinstance(body, dict):
            raise self.hive.error(400, "bad_request", "body is a JSON object")
        text = json.dumps(body, separators=(",", ":"), sort_keys=True)
        if len(text.encode()) > DRAFT_MAX_BYTES:
            raise self.hive.error(413, "draft_too_large", f"a draft is limited to {DRAFT_MAX_BYTES // 1024} KB")
        if expected is not None and (type(expected) is not int or expected < 1):
            raise self.hive.error(400, "bad_request", "expected_revision is a positive integer or null")
        if ref is not None:
            if (not isinstance(ref, dict) or set(ref) != {"artifact_id", "revision", "digest"}
                    or not isinstance(ref["artifact_id"], str) or type(ref["revision"]) is not int
                    or not DIGEST.fullmatch(str(ref["digest"]))):
                raise self.hive.error(400, "bad_source_ref", "source_ref is {artifact_id, revision, digest}")
        with self.db.transaction():
            self._prune(program_id, swarm_id, principal)
            row = self.db.one("SELECT MAX(revision) AS r FROM app_drafts WHERE program = ? AND swarm = ? AND principal = ? "
                              "AND draft_key = ?", (program_id, swarm_id, principal, key))
            current = row["r"] if row and row["r"] is not None else None
            if expected != current:
                raise self.hive.error(409, "draft_conflict", "the draft changed since you loaded it",
                                      {"current_revision": current})
            issued = self.db.one("SELECT last_revision FROM app_draft_keys WHERE program = ? AND swarm = ? AND principal = ? "
                                 "AND draft_key = ?", (program_id, swarm_id, principal, key))
            revision, at = max(current or 0, issued["last_revision"] if issued else 0) + 1, now()
            self.db.execute("INSERT INTO app_draft_keys (program, swarm, principal, draft_key, last_revision) "
                            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(program, swarm, principal, draft_key) "
                            "DO UPDATE SET last_revision = excluded.last_revision",
                            (program_id, swarm_id, principal, key, revision))
            self.db.insert("app_drafts", {"program": program_id, "swarm": swarm_id, "principal": principal,
                                          "draft_key": key, "revision": revision, "body": text,
                                          "source_ref": json.dumps(ref, sort_keys=True) if ref else None, "saved_at": at})
            self.db.execute("DELETE FROM app_drafts WHERE program = ? AND swarm = ? AND principal = ? AND draft_key = ? "
                            "AND revision <= ?", (program_id, swarm_id, principal, key, revision - DRAFT_KEEP))
        return {"draft_key": key, "revision": revision, "saved_at": at}

    def list(self, program_id, swarm_id, principal):
        self._scope(program_id, swarm_id, principal)
        self._prune(program_id, swarm_id, principal)
        rows = self.db.all("SELECT draft_key, MAX(revision) AS revision, MAX(saved_at) AS saved_at FROM app_drafts "
                           "WHERE program = ? AND swarm = ? AND principal = ? GROUP BY draft_key ORDER BY saved_at DESC",
                           (program_id, swarm_id, principal))
        return {"drafts": [dict(r) for r in rows]}

    def read(self, program_id, swarm_id, principal, key):
        self._scope(program_id, swarm_id, principal, key)
        self._prune(program_id, swarm_id, principal)
        row = self.db.one("SELECT * FROM app_drafts WHERE program = ? AND swarm = ? AND principal = ? AND draft_key = ? "
                          "ORDER BY revision DESC LIMIT 1", (program_id, swarm_id, principal, key))
        if row is None:
            raise self.hive.error(404, "not_found", "no such draft")
        return {"draft_key": key, "revision": row["revision"], "saved_at": row["saved_at"], "body": json.loads(row["body"]),
                "source_ref": json.loads(row["source_ref"]) if row["source_ref"] else None}

    def delete(self, program_id, swarm_id, principal, key):
        self._scope(program_id, swarm_id, principal, key)
        self.db.execute("DELETE FROM app_drafts WHERE program = ? AND swarm = ? AND principal = ? AND draft_key = ?",
                        (program_id, swarm_id, principal, key))
        return {"deleted": key}
