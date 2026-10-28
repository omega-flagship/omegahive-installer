"""Own hive, round H1 (coordination/omegareview/PLATFORM_OWN_HIVE_CONNECTIONS_PLAN_R1.md, approved by the owner 2026-10-13).

A hive is one person's hive. This module holds the four things H1 adds; nothing here crosses to another hive (H2/H3).

1. The owner. Each hive has exactly one owner, stored in ``hive_owner`` (one row). An existing hive is migrated without
   changing anyone's access: the earliest-created enabled admin becomes the owner (``via = "first-admin"``), stored the
   first time anything asks. A hive with no named admin yet is owned by the loopback operator (``user:operator``, not
   stored, so the first admin to arrive becomes the owner). Admins keep every right they had (H1 changes no one's
   access, the owner's row included); ownership transfer and protection come with the rebuilt hives.

2. Limits on your own keys. A person sets monthly limits on the provider keys THEY own (a key's ``owner``; keys with no
   person owner, the hive's environment keys and the old operator-set keys, are the hive owner's): one limit for their
   own use (``grantee = "self"``) and one per grant for what they share (``grantee = user:u_...``), on one key or on all
   their keys (``key_id = "*"``). They are rows in ``key_limits``, enforced at call time inside Budgets.applicable /
   Budgets.check as scope ``keyuse:<hash of owner, key, grantee>`` (month; H1.1), so admission, the reservation snapshot
   and reservation subjects all count every call in that scope, whichever limit row was live when it was admitted, and
   hold them like any other limit. A grant replaces the member default for that person on that owner's keys; the
   member default (HIVE_MEMBER_MONTHLY_USD, admin rules) stays only as the compatibility fallback.

3. Visibility (the owner, verbatim: "minds and swarms and hives can be set as public or private and have access granted within
   both public and private ... anything private would be invite only - anything public would either be 'access but use
   own key' or 'access with hives key' depending on permissions"). Minds and swarms keep visibility.py's levels (private,
   shared = private with access grants, public) and gain ``pays``: ``own-key`` or ``hive-key``. The hive itself is
   ``private`` (invite only: today's sign-in) or ``public`` (a verified Google account with no invitation is let in as a
   public visitor), with its own ``pays``. Defaults change nothing: the hive is private, things keep their visibility,
   and ``pays`` is ``own-key``.

4. "Use my hive" invites. An invitation of kind ``use`` (owner only) carries a monthly limit; accepting it makes the
   person a guest (``people.access = "guest"``) with a key grant on all the owner's keys at that limit (``source =
   invite:<id>``). Sign-in already gives every person a personal mind and swarm (personal.py), so a guest has both,
   running on the owner's key within the invite limit (option A). The invite keeps ``terms`` (a JSON object) so "join my
   hive" (H2) and "move out" (H4) add kinds without reshaping it. A person may ask a key owner for a limit
   (``limit_requests``); the owner approves, adjusts or declines, and an approval writes the grant.

Who may use whose key, checked at every paid call (use_check, from Budgets.check):
- the key's owner, and anyone the owner granted (their grant's limit applies);
- people who were in the hive before H1 (``people.access`` NULL) keep today's access: the member default or their rule;
- a guest or public visitor with no grant: on a public mind, swarm or hive (the first public one, in that order) whose
  ``pays`` is ``hive-key``, the hive owner's key pays (their visitor limit applies); where it is ``own-key`` only their own
  key may pay (402 ``own_key_required``; the gateway picks their own key for the provider when they have one); anything
  else is refused (402 ``no_key_grant``).
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import re
import sqlite3

from .db import new_id, now

PAYS = ("own-key", "hive-key")
HIVE_LEVELS = ("private", "public")
INVITE_KINDS = ("member", "use")
LATER_KINDS = {"join": "H2 (hive-to-hive connections)", "move-out": "H4"}
ACCESS = ("guest", "public")            # people.access; NULL = in the hive before H1 (today's access, unchanged)
DECISIONS = ("approve", "adjust", "decline")
MAX_LIMIT = 1_000_000.0
LIMIT_ID = re.compile(r"^kl_[0-9a-f]{8}$")
PERSON = re.compile(r"^user:u_[A-Za-z0-9_-]{1,40}$")
KEY_ID = re.compile(r"^(\*|k_[0-9a-f]{8}|env:[a-z0-9_-]+)$")
HOLD_KEY = re.compile(r"^(k_[0-9a-f]{8}|env:[a-z0-9_-]+)$")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS hive_owner (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, via TEXT NOT NULL,
  set_at TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', pays TEXT NOT NULL DEFAULT 'own-key',
  visitor_month_usd REAL, updated_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS key_limits (id TEXT PRIMARY KEY, owner TEXT NOT NULL, key_id TEXT NOT NULL,
  grantee TEXT NOT NULL, month_usd REAL NOT NULL, ends_at TEXT, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT)""",
    "CREATE UNIQUE INDEX IF NOT EXISTS key_limits_live ON key_limits(owner, key_id, grantee) WHERE revoked_at IS NULL",
    # H1.1: every change of owner after the first migration (a claim), with who did it and why
    """CREATE TABLE IF NOT EXISTS hive_owner_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, previous TEXT,
  owner TEXT NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS limit_requests (id TEXT PRIMARY KEY, requested_by TEXT NOT NULL, owner TEXT NOT NULL,
  key_id TEXT NOT NULL, agent_id TEXT, amount_usd REAL NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, granted_usd REAL, limit_id TEXT,
  created_at TEXT NOT NULL)""",
]

SAY = {
    "owner_only": "Only this hive's owner can do that.",
    "key_owner_only": "Only the person who owns that key sets its limits.",
    "no_key_grant": "This mind runs on someone else's key, and they haven't given you a limit on it. Ask them for one.",
    "own_key_required": "Here you use your own key. Add one for this model's provider, then try again.",
    "own_key_needed": "This mind would run on someone else's key. Add your own key in Keys, then try again.",
    "bad_limit": "A monthly limit is a number from 0 to 1,000,000.",
    "bad_request": "That isn't in a shape the hive understands.",
}


def _money(value, code="bad_limit"):
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise ValueError(code) from None
    if out != out or not 0 <= out <= MAX_LIMIT:
        raise ValueError(code)
    return round(out, 6)


def scope_of(owner, key_id, grantee):
    """The subject a key limit counts by: one per (key owner, key or *, grantee), whatever limit rows come and go."""
    return "keyuse:" + hashlib.sha256(f"{owner}|{key_id}|{grantee}".encode()).hexdigest()[:16]


def _month_start():
    moment = datetime.datetime.now(datetime.timezone.utc)
    start = moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return start.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class OwnHive:
    def __init__(self, hive):
        self.hive = hive
        db = hive.db
        for statement in SCHEMA:
            db.execute(statement)
        for table in ("swarms", "agents"):   # additive: every existing thing pays own-key (only matters once public)
            columns = {r["name"] for r in db.all(f"PRAGMA table_info({table})")}
            if "pays" not in columns:
                db.execute(f"ALTER TABLE {table} ADD COLUMN pays TEXT NOT NULL DEFAULT 'own-key'")
            if "pays_by" not in columns:   # H1.1: who set pays; hive-key counts only when the hive owner set it
                db.execute(f"ALTER TABLE {table} ADD COLUMN pays_by TEXT")
        # H1.1: a key limit's scope (owner, key, grantee) is what spend and held liabilities are counted by, so a limit
        # made, revoked or remade after a call was admitted still sees that call
        if "scope" not in {r["name"] for r in db.all("PRAGMA table_info(key_limits)")}:
            db.execute("ALTER TABLE key_limits ADD COLUMN scope TEXT")
        for r in db.all("SELECT id, owner, key_id, grantee FROM key_limits WHERE scope IS NULL"):
            db.execute("UPDATE key_limits SET scope = ? WHERE id = ?", (scope_of(r["owner"], r["key_id"], r["grantee"]), r["id"]))
        # H1.1: whose limit scope each call was recorded under (OwnHive.grantee_for at record time); NULL before H1.1
        if "key_grantee" not in {r["name"] for r in db.all("PRAGMA table_info(usage)")}:
            db.execute("ALTER TABLE usage ADD COLUMN key_grantee TEXT")

    @property
    def db(self):
        return self.hive.db

    def _error(self, status, code, message=None, details=None):
        return self.hive.error(status, code, message or SAY.get(code, code), details)

    # ---- people columns (people.py's tables; added here so a Hive without sign-in still works) ---------------------

    @staticmethod
    def migrate_people(db):
        """Additive columns on people.py's tables, run by People at startup: people.access, invites.kind/limit_usd/terms."""
        people = {r["name"] for r in db.all("PRAGMA table_info(people)")}
        if "access" not in people:
            db.execute("ALTER TABLE people ADD COLUMN access TEXT")
        invites = {r["name"] for r in db.all("PRAGMA table_info(invites)")}
        if "kind" not in invites:
            db.execute("ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'member'")
        if "limit_usd" not in invites:
            db.execute("ALTER TABLE invites ADD COLUMN limit_usd REAL")
        if "terms" not in invites:
            db.execute("ALTER TABLE invites ADD COLUMN terms TEXT NOT NULL DEFAULT '{}'")

    # ---- 1. the owner -------------------------------------------------------------------------------------------------

    def _row(self):
        return self.db.one("SELECT * FROM hive_owner WHERE id = 1")

    def _first_admin(self):
        try:
            return self.db.one("SELECT id FROM people WHERE role = 'admin' AND disabled = 0 ORDER BY created_at, id LIMIT 1")
        except sqlite3.OperationalError:   # no people table (a Hive without sign-in)
            return None

    def ensure_owner(self):
        """The owner's principal, migrating an existing hive on first use: a stored owner stays; else the first enabled
        admin is stored as owner (via first-admin); else the loopback operator (user:operator), not stored as a person,
        so the first admin to arrive becomes the owner. A stored operator row (settings saved before any admin) is
        upgraded the same way, keeping its settings."""
        row = self._row()
        if row is not None and row["owner"] != "user:operator":
            return row["owner"]
        first = self._first_admin()
        if first is None:
            return "user:operator"
        owner, stamp = "user:" + first["id"], now()
        with self.db.transaction():
            if self._row() is None:
                self.db.execute("INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, ?, 'first-admin', ?, ?)",
                                (owner, stamp, stamp))
            else:
                self.db.execute("UPDATE hive_owner SET owner = ?, via = 'first-admin', set_at = ?, updated_at = ? "
                                "WHERE id = 1 AND owner = 'user:operator'", (owner, stamp, stamp))
        return self._row()["owner"]

    def owner(self):
        return self.ensure_owner()

    def is_owner(self, principal):
        return bool(principal) and principal == self.owner()

    def require_owner(self, viewer):
        if not self.is_owner(getattr(viewer, "principal", None)):
            raise self._error(403, "owner_only")

    def require_person_or_owner(self, viewer):
        """Route gate for the /api/me/key-limits writes (H1.1): a named person, or the owner (the operator, before any
        admin), before the body is read; the key-ownership checks then run in the handler."""
        principal = getattr(viewer, "principal", None)
        if not (str(principal or "").startswith("user:u_") or self.is_owner(principal)):
            raise self._error(403, "key_owner_only")

    def stranded(self):
        """Why the stored owner can no longer act (disabled, no longer an admin, gone), or None."""
        owner = self.owner()
        if owner == "user:operator":
            return None
        person = self._person(owner)
        if person is None:
            return "gone"
        if person.get("disabled"):
            return "disabled"
        if person.get("role") != "admin":
            return "not-admin"
        return None

    def claim(self, viewer, data):
        """POST /api/hive/own/claim (H1.1 recovery): when the stored owner is disabled, no longer an admin or gone, an
        enabled admin claims the hive for themselves, or the operator hands it to a named enabled admin (``to``). Logged
        in hive_owner_log and the hive log. Demotion is never blocked: this is how a hive recovers from one."""
        data = data if isinstance(data, dict) else {}
        why = self.stranded()
        if why is None:
            raise self._error(409, "owner_present", "This hive's owner can still act; they can hand it over later.")
        me = getattr(viewer, "principal", None)
        if not getattr(viewer, "admin", False):
            raise self._error(403, "admin_only", "Only a hive admin can claim a hive whose owner can't act.")
        target = data.get("to") or me
        if me != "user:operator" and target != me:
            raise self._error(403, "admin_only", "An admin claims the hive for themselves.")
        person = self._person(target)
        if person is None or person.get("disabled") or person.get("role") != "admin":
            raise self._error(400, "bad_request", "The new owner must be an enabled admin of this hive.")
        previous, stamp = self.owner(), now()
        with self.db.transaction():
            self.db.execute("UPDATE hive_owner SET owner = ?, via = 'claimed', set_at = ?, updated_at = ? WHERE id = 1",
                            (target, stamp, stamp))
            self.db.execute("INSERT INTO hive_owner_log (at, previous, owner, by, reason) VALUES (?, ?, ?, ?, ?)",
                            (stamp, previous, target, me, f"previous owner {why}"))
        logging.getLogger("hive").warning("own hive: ownership claimed by %s for %s (previous %s, %s)", me, target, previous, why)
        return self.view(viewer)

    def settings(self):
        row = self._row()
        if row is None:
            return {"visibility": "private", "pays": "own-key", "visitor_month_usd": None}
        return {"visibility": row["visibility"], "pays": row["pays"], "visitor_month_usd": row["visitor_month_usd"]}

    def view(self, viewer):
        """GET /api/hive/own."""
        owner = self.owner()
        row = self._row()
        person = self._person(owner)
        return {"owner": owner, "owner_name": (person or {}).get("name") or None,
                "via": row["via"] if row and row["owner"] == owner else "operator",
                "set_at": row["set_at"] if row and row["owner"] == owner else None, **self.settings(),
                "you_are_owner": owner == getattr(viewer, "principal", None),
                "your_access": self.access(getattr(viewer, "principal", None))}

    def set_settings(self, viewer, data):
        """PUT /api/hive/own (owner only): visibility (private|public), pays (own-key|hive-key), visitor_month_usd."""
        self.require_owner(viewer)
        if not isinstance(data, dict) or set(data) - {"visibility", "pays", "visitor_month_usd"}:
            raise self._error(400, "bad_request", "send visibility, pays and/or visitor_month_usd")
        changes = {}
        if "visibility" in data:
            if data["visibility"] not in HIVE_LEVELS:
                raise self._error(400, "bad_visibility", "a hive is private or public")
            changes["visibility"] = data["visibility"]
        if "pays" in data:
            if data["pays"] not in PAYS:
                raise self._error(400, "bad_pays", "pays is own-key or hive-key")
            changes["pays"] = data["pays"]
        if "visitor_month_usd" in data:
            try:
                changes["visitor_month_usd"] = None if data["visitor_month_usd"] is None else _money(data["visitor_month_usd"])
            except ValueError:
                raise self._error(400, "bad_limit") from None
        owner, stamp = self.owner(), now()
        with self.db.transaction():
            if self._row() is None:
                self.db.execute("INSERT INTO hive_owner (id, owner, via, set_at, updated_at) VALUES (1, ?, ?, ?, ?)",
                                (owner, "operator" if owner == "user:operator" else "first-admin", stamp, stamp))
            if changes:
                sets = ", ".join(f"{k} = ?" for k in changes)
                self.db.execute(f"UPDATE hive_owner SET {sets}, updated_at = ? WHERE id = 1", (*changes.values(), stamp))
        return self.view(viewer)

    # ---- who is who ---------------------------------------------------------------------------------------------------

    def _person(self, principal):
        if not isinstance(principal, str) or not principal.startswith("user:u_"):
            return None
        try:
            return self.db.one("SELECT * FROM people WHERE id = ?", (principal[5:],))
        except sqlite3.OperationalError:
            return None

    def access(self, principal):
        """'owner', 'legacy' (in the hive before H1, or anyone who is not a named person: today's rules), 'guest',
        'public', or None for a disabled or unknown person."""
        if principal and principal == self.owner():
            return "owner"
        if not isinstance(principal, str) or not principal.startswith("user:u_"):
            return "legacy"
        person = self._person(principal)
        if person is None or person.get("disabled"):
            return None
        return person.get("access") or "legacy"

    def key_person(self, key_id):
        """The named person whose own key this is, or None for the hive's own keys (environment keys, owner 'hive', the
        old operator-set keys, anything not a named person) and for no key. The one "is this a hive key" predicate:
        key_owner, payer_for's billing and the app's assignment check (OI-13) all read it."""
        keyring = getattr(self.hive, "keyring", None)
        record = ((keyring.ring.get("keys") if keyring else None) or {}).get(key_id) if key_id else None
        owner = (record or {}).get("owner") or ""
        return owner if owner.startswith("user:u_") else None

    def key_owner(self, key_id):
        """The person who owns a key: its stored owner when that is a named person; the hive owner for the hive's own
        keys (environment keys, the old operator-set keys) and for a call with no key (key_id None)."""
        return self.key_person(key_id) or self.owner()

    def _payer_person(self, payer):
        """The person a call is for: 'hive' (a hive mind with no person) is the hive owner's own use."""
        return self.owner() if payer in (None, "", "hive") else payer

    def _others_keys(self, owner):
        """Key ids in the ring that belong to a person other than this owner."""
        keyring = getattr(self.hive, "keyring", None)
        return [k for k in (((keyring.ring.get("keys") if keyring else None) or {})) if self.key_owner(k) != owner]

    def _owner_keys(self, owner):
        """Every key id whose owner (key_owner) is this person, for an all-keys limit's spend."""
        keyring = getattr(self.hive, "keyring", None)
        keys = [k for k, r in (((keyring.ring.get("keys") if keyring else None) or {}).items())
                if self.key_owner(k) == owner]
        if owner == self.owner():
            keys += [f"env:{name}" for name in (getattr(self.hive.settings, "providers", None) or {})]
        return keys

    # ---- 2. limits on your own keys -----------------------------------------------------------------------------------

    def _active(self, rows):
        stamp = now()
        return [r for r in rows if not r["revoked_at"] and (not r["ends_at"] or r["ends_at"] > stamp)]

    def _grant_rows(self, owner, key_id, grantee):
        keys = ("*", key_id) if key_id else ("*",)
        rows = self.db.all(f"SELECT * FROM key_limits WHERE owner = ? AND grantee = ? AND revoked_at IS NULL "
                           f"AND key_id IN ({', '.join('?' for _ in keys)}) ORDER BY created_at", (owner, grantee, *keys))
        return self._active(rows)

    def grantee_for(self, key_id, payer):
        """Whose limit on the key's owner's keys a call counts under: 'self' (the owner's own use) for the owner, a hive
        mind of the hive owner's, anyone who is not a named person, and anyone in the hive before H1 with no grant from
        that owner (their calls are billed as before, to the key's owner: H1.1); else the person (a grant, a guest, a
        public visitor)."""
        owner, person = self.key_owner(key_id), self._payer_person(payer)
        if person == owner or not isinstance(person, str) or not person.startswith("user:u_"):
            return "self"
        if self._grant_rows(owner, key_id, person):
            return person
        return "self" if self.access(person) == "legacy" else person

    def rows_for(self, key_id, payer):
        """The live key_limits rows a call on this key, for this payer, is held to (grantee_for decides whose)."""
        return self._grant_rows(self.key_owner(key_id), key_id, self.grantee_for(key_id, payer))

    def subjects(self, key_id, payer):
        """Reservation subjects for a call: the scopes of the key and of all the owner's keys, whether or not a limit
        exists on them yet, so a limit made later counts the hold. Conservative (H1.2): a call for a person other than
        the key's owner is counted under both the owner's own scope and that person's, since a grant made or revoked
        while it is held would move it from one to the other."""
        owner, person = self.key_owner(key_id), self._payer_person(payer)
        grantees = ["self"]
        if isinstance(person, str) and person.startswith("user:u_") and person != owner:
            grantees.append(person)
        keys = ["*"] + ([key_id] if key_id else [])
        return [scope_of(owner, k, g) for g in grantees for k in keys]

    def _hold_subjects(self, raw):
        """The subjects for one recorded hold (H1.3: every field validated): the rule a new reservation uses when its payer
        is a non-empty string and its key a key id or null (null only where it was recorded as null, or for embeddings,
        which never carried one); anything else, or any failure working it out, is '*' (counted against every scope)."""
        try:
            meta = json.loads(raw) if isinstance(raw, (str, bytes)) and raw else None
            if not isinstance(meta, dict):
                return ["*"]
            payer, key = meta.get("payer"), meta.get("key")
            if not isinstance(payer, str) or not payer or len(payer) > 200:
                return ["*"]
            if key is None:
                if "key" not in meta and meta.get("kind") != "embeddings":
                    return ["*"]
            elif not isinstance(key, str) or not HOLD_KEY.match(key):
                return ["*"]
            subjects = self.subjects(key, payer)
            return subjects if subjects and all(isinstance(x, str) for x in subjects) else ["*"]
        except Exception:   # noqa: BLE001  (never fail startup over one record)
            logging.getLogger("hive").exception("own hive: unreadable hold metadata; counted against every scope")
            return ["*"]

    def count_open_holds_everywhere(self):
        """H1.3 fallback when the upgrade itself fails: every open hold with no key-limit scope is marked '*' (counted by
        every limit), in one plain statement that needs nothing but the reservation tables. Returns the rows marked."""
        return self.db.execute(
            "INSERT OR IGNORE INTO cost_reservation_subjects (reservation, subject) SELECT r.id, '*' FROM cost_reservations r "
            "WHERE r.state IN ('reserved', 'dispatched', 'unknown') AND NOT EXISTS (SELECT 1 FROM cost_reservation_subjects j "
            "WHERE j.reservation = r.id AND (j.subject LIKE 'keyuse:%' OR j.subject = '*'))").rowcount

    def backfill_hold_scopes(self):
        """H1.2 upgrade: every open hold (reserved, dispatched, unknown) that carries no key-limit scope yet, including
        holds from before H1, gets the scopes a new reservation would get (subjects, from its recorded key and payer), so
        a key limit made after the upgrade counts it. A hold whose key or payer cannot be read from what was recorded is
        marked '*', which every scope's limit counts (the existing conservative marker). Idempotent; run at startup once
        the keyring is attached. Returns (scoped, unattributed)."""
        try:
            rows = self.db.all(
                "SELECT r.id, d.metadata FROM cost_reservations r LEFT JOIN cost_reservation_details d ON d.reservation = r.id "
                "WHERE r.state IN ('reserved', 'dispatched', 'unknown') AND NOT EXISTS (SELECT 1 FROM cost_reservation_subjects j "
                "WHERE j.reservation = r.id AND (j.subject LIKE 'keyuse:%' OR j.subject = '*'))")
        except sqlite3.OperationalError:   # no reservations table (a Hive without the model route)
            return 0, 0
        scoped = unattributed = 0
        for row in rows:
            subjects = self._hold_subjects(row.get("metadata"))
            try:
                with self.db.transaction():
                    for subject in subjects:
                        self.db.execute("INSERT OR IGNORE INTO cost_reservation_subjects (reservation, subject) VALUES (?, ?)",
                                        (row["id"], subject))
            except Exception:   # noqa: BLE001  (H1.3: one row never stops startup; it is counted under '*' instead)
                logging.getLogger("hive").exception("own hive: could not scope open hold %s; counting it everywhere", row["id"])
                subjects = ["*"]
                try:
                    self.db.execute("INSERT OR IGNORE INTO cost_reservation_subjects (reservation, subject) VALUES (?, '*')",
                                    (row["id"],))
                except Exception:   # noqa: BLE001
                    continue
            scoped += 1
            unattributed += 1 if subjects == ["*"] else 0
        if scoped:
            logging.getLogger("hive").warning("own hive: key-limit scopes added to %d open holds (%d unattributed, counted "
                                              "against every scope)", scoped, unattributed)
        return scoped, unattributed

    def has_grant(self, payer, owner=None):
        """Whether this person holds any live grant (from this owner, or from anyone)."""
        if not isinstance(payer, str) or not payer.startswith("user:"):
            return False
        sql, params = "SELECT * FROM key_limits WHERE grantee = ? AND revoked_at IS NULL", [payer]
        if owner:
            sql += " AND owner = ?"
            params.append(owner)
        return bool(self._active(self.db.all(sql, params)))

    def rules(self, key_id, payer):
        """(scope, period, limit, origin) for Budgets.applicable."""
        out = []
        for r in self.rows_for(key_id, payer):
            origin = "own" if r["grantee"] == "self" else ("invite" if str(r["source"]).startswith("invite:") else "grant")
            out.append((r["scope"], "month", float(r["month_usd"]), origin))
        return out

    def spent(self, scope, since=None):
        """This month's spend under one key-limit scope (owner, key or *, grantee): usage on that key (or all the owner's
        keys) recorded under that grantee (usage.key_grantee, set at record time from the same rule that admits the
        call, so Ask turns, sessions and media count where they were held); a row from before H1.1 by its payer."""
        row = self.db.one("SELECT owner, key_id, grantee FROM key_limits WHERE scope = ? ORDER BY created_at DESC LIMIT 1",
                          (scope,))
        if row is None:
            return 0.0
        owner = row["owner"]
        payers = [owner] + (["hive"] if owner == self.owner() else []) if row["grantee"] == "self" else [row["grantee"]]
        sql = (f"SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE (key_grantee = ? OR (key_grantee IS NULL AND "
               f"payer IN ({', '.join('?' for _ in payers)}))) AND created_at >= ?")
        params = [row["grantee"], *payers, since or _month_start()]
        if row["key_id"] == "*" and owner == self.owner():
            # H1.3: the hive owner's keys are every key key_owner gives them: any env:<provider> (listed or not), keys
            # with no person owner, keys no longer in the ring, and no key; i.e. all but other people's keys
            others = self._others_keys(owner)
            clause = f"key_id IS NULL OR key_id NOT IN ({', '.join('?' for _ in others)})" if others else "1"
            sql += f" AND ({clause})"
            params += others
        elif row["key_id"] == "*":
            keys = self._owner_keys(owner)
            sql += " AND " + (f"key_id IN ({', '.join('?' for _ in keys)})" if keys else "0")
            params += keys
        else:
            sql += " AND key_id = ?"
            params.append(row["key_id"])
        return float(self.db.one(sql, params)["s"])

    def limit_view(self, row):
        return {"id": row["id"], "owner": row["owner"], "key_id": row["key_id"], "grantee": row["grantee"],
                "month_usd": row["month_usd"], "ends_at": row["ends_at"], "source": row["source"], "note": row["note"],
                "created_at": row["created_at"], "updated_at": row["updated_at"], "revoked_at": row["revoked_at"],
                "spent_usd": round(self.spent(row["scope"]), 6),
                "active": not row["revoked_at"] and (not row["ends_at"] or row["ends_at"] > now())}

    def _check_key(self, owner, key_id):
        if not isinstance(key_id, str) or not KEY_ID.match(key_id):
            raise self._error(400, "bad_request", "key_id is a key id, or * for all your keys")
        if key_id != "*":
            keyring = getattr(self.hive, "keyring", None)
            known = key_id in ((keyring.ring.get("keys") if keyring else None) or {}) or key_id.startswith("env:")
            if not known or self.key_owner(key_id) != owner:
                raise self._error(403, "key_owner_only")

    def set_limit(self, viewer, grantee, data, source="owner"):
        """Create or replace the caller's limit on their own key(s) for `grantee` ('self' or a person). One live row per
        (owner, key, grantee): a new value replaces the old one in place."""
        owner = getattr(viewer, "principal", None)
        if not isinstance(owner, str) or not (owner.startswith("user:u_") or owner == self.owner()):
            raise self._error(403, "key_owner_only")
        data = data if isinstance(data, dict) else {}
        key_id = data.get("key_id", "*")
        self._check_key(owner, key_id)
        if grantee != "self":
            if not isinstance(grantee, str) or not PERSON.match(grantee) or grantee == owner:
                raise self._error(400, "bad_request", "grant to a person by principal, e.g. user:u_ab12")
            if self._person(grantee) is None:
                raise self._error(404, "not_found", "no such person in this hive")
        try:
            month = _money(data.get("month_usd"))
        except ValueError:
            raise self._error(400, "bad_limit") from None
        ends_at = data.get("ends_at")
        if ends_at is not None and (not isinstance(ends_at, str) or len(ends_at) > 40):
            raise self._error(400, "bad_request", "ends_at is an ISO time, or null")
        note = str(data.get("note") or "")[:200]
        return self._write_limit(owner, key_id, grantee, month, ends_at, source, note, owner)

    def _write_limit(self, owner, key_id, grantee, month, ends_at, source, note, by):
        stamp = now()
        with self.db.transaction():
            live = self.db.one("SELECT * FROM key_limits WHERE owner = ? AND key_id = ? AND grantee = ? AND revoked_at IS NULL",
                               (owner, key_id, grantee))
            links = getattr(self.hive, "app_links", None)
            if links is not None and grantee == "self" and (not live or live["month_usd"] != month or live["ends_at"] != ends_at):
                links.limits_changed(owner) # raw fence before write; no app/allocator or new lock
            if live:
                self.db.execute("UPDATE key_limits SET month_usd = ?, ends_at = ?, source = ?, note = ?, updated_at = ? "
                                "WHERE id = ?", (month, ends_at, source, note, stamp, live["id"]))
                limit_id = live["id"]
            else:
                limit_id = new_id("kl")
                self.db.insert("key_limits", {"id": limit_id, "owner": owner, "key_id": key_id, "grantee": grantee,
                                              "month_usd": month, "ends_at": ends_at, "source": source, "note": note,
                                              "created_by": by, "created_at": stamp, "updated_at": stamp,
                                              "scope": scope_of(owner, key_id, grantee)})
        self.db.after_commit(self._announce)
        return self.limit_view(self.db.one("SELECT * FROM key_limits WHERE id = ?", (limit_id,)))

    def _announce(self):
        """budgets.updated in its published shape (admins only, visibility.py); key limits are read on /api/me/key-limits."""
        self.hive.events.publish("budgets.updated", budgets=self.hive.budgets.overview())

    def revoke_limit(self, viewer, limit_id):
        """DELETE /api/me/key-limits/{id}: the owner ends a limit or grant at once (a revoked grant leaves no access)."""
        row = self.db.one("SELECT * FROM key_limits WHERE id = ?", (limit_id,)) if LIMIT_ID.match(str(limit_id)) else None
        if row is None or row["owner"] != getattr(viewer, "principal", None):
            raise self._error(404, "not_found", "no such limit of yours")
        links = getattr(self.hive, "app_links", None)
        if links is not None and row["grantee"] == "self" and row["revoked_at"] is None:
            links.limits_changed(row["owner"])
        self.db.execute("UPDATE key_limits SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL",
                        (now(), viewer.principal, limit_id))
        self._announce()
        return self.limit_view(self.db.one("SELECT * FROM key_limits WHERE id = ?", (limit_id,)))

    def mine(self, viewer):
        """GET /api/me/key-limits: the caller's keys, the limits they set (own and grants), and grants made to them."""
        me = getattr(viewer, "principal", None)
        keyring = getattr(self.hive, "keyring", None)
        records = ((keyring.ring.get("keys") if keyring else None) or {}).values()
        keys = [{"id": r["id"], "provider": r["provider"], "label": r["label"], "hint": keyring.hint(r.get("secret") or "")}
                for r in records if self.key_owner(r["id"]) == me]
        given = [self.limit_view(r) for r in self.db.all("SELECT * FROM key_limits WHERE owner = ? AND revoked_at IS NULL "
                                                          "ORDER BY created_at", (me,))]
        received = [self.limit_view(r) for r in self.db.all("SELECT * FROM key_limits WHERE grantee = ? AND revoked_at IS NULL "
                                                             "ORDER BY created_at", (me,))]
        for r in received:   # a guest never sees the host's keys: who granted it and on how many, never which key
            r["keys"] = "all" if r.pop("key_id") == "*" else "one"
        return {"principal": me, "access": self.access(me), "keys": keys,
                "own": [g for g in given if g["grantee"] == "self"], "grants": [g for g in given if g["grantee"] != "self"],
                "received": received}

    # ---- 3. visibility: who pays for public access --------------------------------------------------------------------

    def pays_for(self, agent):
        """The pays setting of the first public level over this mind (the mind, its swarm, the hive), or None if none of
        them is public."""
        owner = self.owner()

        def said(r):   # H1.1: hive-key only on the hive owner's say-so; anyone else's setting reads as own-key
            return "hive-key" if r.get("pays") == "hive-key" and r.get("pays_by") == owner else "own-key"
        row = self.db.one("SELECT visibility, pays, pays_by, swarm_id FROM agents WHERE id = ?", (agent.get("id"),)) or {}
        if (row.get("visibility") or agent.get("visibility")) == "public":
            return said(row)
        swarm_id = row.get("swarm_id") or agent.get("swarm_id")
        swarm = self.db.one("SELECT visibility, pays, pays_by FROM swarms WHERE id = ?", (swarm_id,)) if swarm_id else None
        if swarm and swarm["visibility"] == "public":
            return said(swarm)
        hive = self.settings()
        return hive["pays"] if hive["visibility"] == "public" else None

    def person_key_check(self, agent, key_id, user=None):
        """OI-13 r1.1 (the owner 2026-10-19: "everyone needs studio, they just need to use their own keys"): a person's own key,
        assigned to the mind or the provider default it falls back to, pays only for that person, someone they granted a
        limit on it, or a hive mind with no person behind it. Anyone else is refused (402 own_key_needed) before any
        reservation or dispatch, however payer_for would bill the call. Guests and public visitors are held by the H1
        rules in use_check (no_key_grant / own_key_required, or the owner's public hive-key terms). The hive's own keys
        are unchanged: their calls are held by the person's allowance as before. user: who the call is for when a
        caller checks ahead of time as if for someone (Studio's submit preflight); else Hive.user_for, as a call reads it."""
        holder = self.key_person(key_id)
        if not holder:
            return
        user = user or self.hive.user_for(agent)
        if user == holder or not isinstance(user, str) or not user.startswith("user:u_") or self.access(user) in ACCESS:
            return
        if self._grant_rows(holder, key_id, user):
            return
        raise self._error(402, "own_key_needed", details={"scope": "use", "pays": "own-key"})

    def use_check(self, agent, key_id, payer, user=None):
        """Refuse (402) a paid call on a key its payer may not use. Called by Budgets.check, so every paid route, the
        reservation-free preflight included, runs it before any limit."""
        self.person_key_check(agent, key_id, user)   # OI-13 r1.1: never another person's key, whoever payer_for bills
        owner, person = self.key_owner(key_id), self._payer_person(payer)
        if person == owner or not isinstance(person, str) or not person.startswith("user:u_"):
            return
        if self._grant_rows(owner, key_id, person):
            return                                           # a grant: its limit applies (Budgets.applicable)
        access = self.access(person)
        if access in ("legacy", "owner"):
            return                                           # in the hive before H1: today's rules, unchanged
        terms = self.pays_for(agent)
        if terms == "hive-key" and owner == self.owner():
            return                                           # public, on the hive's key: the visitor limit applies
        if terms == "own-key":
            raise self._error(402, "own_key_required", details={"scope": "use", "pays": "own-key"})
        raise self._error(402, "no_key_grant", details={"scope": "use", "owner": owner})

    def own_key_for(self, agent, provider_name, user=None):
        """Gateway.paying_key hook: a guest or public visitor with no grant on the paying key pays with their own key for
        this provider, when they have one. Nobody in the hive before H1, and nobody holding a grant, is ever switched."""
        keyring = getattr(self.hive, "keyring", None)
        if keyring is None:
            return None
        person = user or self.hive.user_for(agent)   # user: who the call is for, when the caller knows (the Ask conductor)
        default = keyring.ring["defaults"].get(provider_name) or f"env:{provider_name}"
        holder = self.key_person(default)
        # OI-13 r1.1: anyone whose call would otherwise fall back to another person's own key is switched to their own
        # key for this provider too (person_key_check refuses that default unless they hold a grant on it)
        if self.access(person) not in ACCESS and not (holder and isinstance(person, str) and person.startswith("user:u_")
                                                     and holder != person):
            return None
        if self.key_owner(default) == person or self._grant_rows(self.key_owner(default), default, person):
            return None
        own = sorted((r for r in keyring.ring["keys"].values() if r.get("owner") == person and r["provider"] == provider_name),
                     key=lambda r: r.get("created_at") or 0)
        return own[0]["id"] if own else None

    # ---- 4. "use my hive" invites -------------------------------------------------------------------------------------

    def clean_invite(self, viewer_principal, kind, limit_usd, terms):
        """Validate an invite's kind, limit and terms. 'use' is owner only and needs a monthly limit."""
        kind = kind or "member"
        if kind in LATER_KINDS:
            raise self._error(501, "not_yet", f"'{kind}' invitations come with {LATER_KINDS[kind]}")
        if kind not in INVITE_KINDS:
            raise self._error(400, "bad_kind", "kind is member or use")
        if terms is None:
            terms = {}
        if not isinstance(terms, dict) or len(json.dumps(terms)) > 2000:
            raise self._error(400, "bad_request", "terms is a small JSON object")
        if kind == "member":
            if limit_usd is not None:
                raise self._error(400, "bad_request", "only a use invitation carries a limit")
            return kind, None, terms
        if not self.is_owner(viewer_principal):
            raise self._error(403, "owner_only", "Only this hive's owner can invite someone to use it.")
        try:
            limit = _money(limit_usd)
        except ValueError:
            raise self._error(400, "bad_limit") from None
        return kind, limit, terms

    def accepted(self, invite, person_id, new_person):
        """people.py, inside the acceptance transaction: a use invitation makes the person a guest (when it made or
        re-enabled their row) and grants them the invite's monthly limit on all the owner's keys."""
        if (invite.get("kind") or "member") != "use":
            return
        if invite.get("limit_usd") is None:   # H1.1: never a silent $0 grant; clean_invite requires one at creation
            from .people import SignInError
            raise SignInError(410, "invite_unavailable", "this invitation has no limit set; ask for a new one")
        principal = "user:" + person_id
        if new_person:
            self.db.execute("UPDATE people SET access = 'guest' WHERE id = ?", (person_id,))
        owner = self.owner()
        if owner == principal:
            return
        self._write_limit(owner, "*", principal, float(invite["limit_usd"]), None, f"invite:{invite['id']}",
                          "use my hive", invite.get("created_by") or owner)

    # ---- asking for a limit -------------------------------------------------------------------------------------------

    def request_view(self, row):
        return dict(row)

    def ask(self, viewer, data):
        """POST /api/me/limit-requests: ask a key owner for a monthly limit. Names a mind (whose paying key's owner is
        asked), or a person (owner), or neither (the hive owner). amount_usd is the monthly limit asked for."""
        me = getattr(viewer, "principal", None)
        if not str(me or "").startswith("user:u_") or self._person(me) is None:
            raise self._error(403, "person_required", "Asking for a limit needs a signed-in person.")
        data = data if isinstance(data, dict) else {}
        try:
            amount = _money(data.get("amount_usd"))
        except ValueError:
            raise self._error(400, "bad_limit") from None
        agent_id, key_id, owner = data.get("agent_id"), "*", data.get("owner")
        if agent_id:
            row = self.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if row is None or not (viewer.admin or viewer.sees(row)):
                raise self._error(404, "not_found", "no such mind")
            gateway_key = self._mind_key(row)
            owner, key_id = self.key_owner(gateway_key), gateway_key or "*"
        elif owner is not None:
            if not isinstance(owner, str) or self._person(owner) is None:
                raise self._error(404, "not_found", "no such person in this hive")
        else:
            owner = self.owner()
        if owner == me:
            raise self._error(400, "bad_request", "that key is yours: set your own limit instead")
        if self.db.one("SELECT 1 FROM limit_requests WHERE requested_by = ? AND owner = ? AND key_id = ? AND status = 'pending'",
                       (me, owner, key_id)):
            raise self._error(409, "already_asked", "You've already asked; they haven't answered yet.")
        row = {"id": new_id("lr"), "requested_by": me, "owner": owner, "key_id": key_id, "agent_id": agent_id,
               "amount_usd": amount, "note": str(data.get("note") or "")[:300], "status": "pending", "created_at": now()}
        self.db.insert("limit_requests", row)
        self.hive.events.publish("person_request.created", request={"id": row["id"], "kind": "limit", "requested_by": me})
        return self.request_view(self.db.one("SELECT * FROM limit_requests WHERE id = ?", (row["id"],)))

    def _mind_key(self, row):
        """The key that pays for a mind's calls: its assigned key, else its provider's default (never a secret)."""
        keyring = getattr(self.hive, "keyring", None)
        try:
            options = json.loads(row.get("options") or "{}")
        except ValueError:
            options = {}
        if options.get("key"):
            return options["key"]
        provider = str(row.get("model") or self.hive.settings.default_model or "").partition("/")[0]
        return ((keyring.ring.get("defaults") if keyring else None) or {}).get(provider) or (f"env:{provider}" if provider else None)

    def requests(self, viewer):
        """GET /api/me/limit-requests: what I asked, and what was asked of me."""
        me = getattr(viewer, "principal", None)
        asked = self.db.all("SELECT * FROM limit_requests WHERE requested_by = ? ORDER BY created_at DESC LIMIT 200", (me,))
        to_me = self.db.all("SELECT * FROM limit_requests WHERE owner = ? ORDER BY created_at DESC LIMIT 200", (me,))
        return {"asked": [self.request_view(r) for r in asked], "to_decide": [self.request_view(r) for r in to_me]}

    def decide(self, viewer, request_id, data):
        """POST /api/me/limit-requests/{id}/decide (the asked owner only): approve (the amount asked), adjust (amount_usd
        given) or decline. Approve and adjust write the grant, replacing any live one for that key and person."""
        row = self.db.one("SELECT * FROM limit_requests WHERE id = ?", (request_id,))
        if row is None or row["owner"] != getattr(viewer, "principal", None):
            raise self._error(404, "not_found", "no such request to you")
        data = data if isinstance(data, dict) else {}
        decision = data.get("decision")
        if decision not in DECISIONS:
            raise self._error(400, "bad_request", "decision is approve, adjust or decline")
        if row["status"] != "pending":
            raise self._error(409, "already_decided", "That request has already been answered.")
        granted, limit_id = None, None
        if decision != "decline":
            try:
                granted = _money(row["amount_usd"] if decision == "approve" else data.get("amount_usd"))
            except ValueError:
                raise self._error(400, "bad_limit") from None
            if self._person(row["requested_by"]) is None:
                raise self._error(409, "person_gone", "That person is no longer in this hive.")
            source = "request:" + row["id"]
            live = self.db.one("SELECT source FROM key_limits WHERE owner = ? AND key_id = ? AND grantee = ? AND "
                               "revoked_at IS NULL", (row["owner"], row["key_id"], row["requested_by"]))
            if live:
                source = live["source"]                      # H1.1: a live grant keeps its source (invite, owner, request)
            limit_id = self._write_limit(row["owner"], row["key_id"], row["requested_by"], granted, None, source,
                                         row["note"][:200], viewer.principal)["id"]
        self.db.execute("UPDATE limit_requests SET status = ?, decided_by = ?, decided_at = ?, granted_usd = ?, limit_id = ? "
                        "WHERE id = ? AND status = 'pending'",
                        ({"approve": "approved", "adjust": "adjusted", "decline": "declined"}[decision], viewer.principal,
                         now(), granted, limit_id, row["id"]))
        self.hive.events.publish("person_request.updated", request={"id": row["id"], "kind": "limit",
                                                                    "requested_by": row["requested_by"]})
        return self.request_view(self.db.one("SELECT * FROM limit_requests WHERE id = ?", (row["id"],)))

    # ---- First Light (onboarding.py) ----------------------------------------------------------------------------------

    def setup_limit(self, principal, own_keys):
        """The monthly_limit item's truth for First Light, or None for today's (allowance) item: a person with keys of
        their own sees their own limit on them (enforced_by 'own'); a guest sees their invite limit (enforced_by
        'invite') and any limit request still waiting."""
        if self.access(principal) == "guest":
            grant = self.db.one("SELECT * FROM key_limits WHERE grantee = ? AND owner = ? AND key_id = '*' AND "
                                "revoked_at IS NULL", (principal, self.owner()))
            pending = self.db.one("SELECT id, amount_usd, created_at FROM limit_requests WHERE requested_by = ? AND "
                                  "status = 'pending' ORDER BY created_at DESC LIMIT 1", (principal,))
            view = self.limit_view(grant) if grant else None
            host = self._person(self.owner())
            return {"done": True, "enforced": bool(view and view["active"]), "enforced_by": "invite",
                    "limit_usd": view["month_usd"] if view else None, "spent_usd": view["spent_usd"] if view else 0.0,
                    "host_name": (host or {}).get("name") or None, "ask_route": "POST /api/me/limit-requests",
                    "pending_request": dict(pending) if pending else None}
        if own_keys <= 0:
            return None
        row = self.db.one("SELECT * FROM key_limits WHERE owner = ? AND grantee = 'self' AND key_id = '*' AND "
                          "revoked_at IS NULL", (principal,))
        view = self.limit_view(row) if row else None
        return {"done": view is not None, "enforced": bool(view and view["active"]), "enforced_by": "own" if view else None,
                "limit_usd": view["month_usd"] if view else None, "spent_usd": view["spent_usd"] if view else 0.0,
                "set_route": "PUT /api/me/key-limits/self"}

