"""Private, shared or public minds and swarms (R13).

Own hive H1 (the owner 2026-10-13: public or private, with access granted within both): ``shared`` is private with access
grants (shared_with); grants can be added to a public thing too. A public mind or swarm also says who pays (``pays``:
own-key or hive-key, ownhive.py); the hive itself is private (invite only) or public (ownhive.py, people.py).

- private: the owner (who created it) and the hive's admins (admins keep sight: auditability, no true secrets)
- shared:  additionally the people named in shared_with (principals such as user:u_ab12)
- public:  every signed-in person of this hive

Chosen at creation (new ones default to private) and changeable later by the owner or an admin. Things that existed
before this rule stay public. Enforcement is central: every operator route checks the mind, swarm or goal in its
path; lists and the live event stream are filtered per person. A person who may not see something gets 'not found'
(never 'forbidden'), so its existence is not revealed. Visibility governs who sees; policy governs what minds do.
"""

from __future__ import annotations

import html
import json
import logging
import re
import sqlite3
import time
import unicodedata
import urllib.parse

LEVELS = ("private", "shared", "public")


# ---- naming a mind in what a person sends an app (r16, r16.1) -------------------------------------------------------
# The one supported spelling is `mind:<id>` or `agent:<id>` (lowercase, no space, id as stored). The host scans every
# decoded string (keys and values, nested, embedded JSON) in that spelling AND in every spelling an app could decode it
# from (percent-encoding, `+`, HTML entities, backslash escapes, Unicode compatibility forms, invisible format characters,
# any letter case, space around the colon). Any mind found either way must be one the person may see; a mind found only
# in another spelling is then refused as an unsupported spelling, so an app never receives one (stand-in r16 #1, #2;
# Kimi r16 #2, #3). Apps resolve minds through ProgramContext.agents()/mind(), which apply the same visibility.
MIND_REF = re.compile(r"(?:mind|agent):(a_[a-z0-9_-]{1,64})")
_MIND_REF_ANY = re.compile(r"(?:mind|agent)\s*:\s*(a_[a-z0-9_-]{1,64})")
_ESCAPE = re.compile(r"\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([ntrfvb0/\\\"']))")
_SIMPLE = {"n": "\n", "t": "\t", "r": "\r", "f": "\f", "v": "\v", "b": "\b", "0": "\0"}


def _unescape(text):
    def one(m):
        code = m.group(1) or m.group(2) or m.group(3)
        if code:
            try:
                return chr(int(code, 16))
            except (ValueError, OverflowError):
                return m.group(0)
        return _SIMPLE.get(m.group(4), m.group(4))
    return _ESCAPE.sub(one, text)


def _plain(text):
    text = unicodedata.normalize("NFKC", text)
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cf")


# Each decoder with the cheap test that says it could change a string; one that cannot is never run.
_DECODERS = ((_plain, lambda t: not t.isascii()), (urllib.parse.unquote, lambda t: "%" in t),
             (urllib.parse.unquote_plus, lambda t: "%" in t or "+" in t), (html.unescape, lambda t: "&" in t),
             (_unescape, lambda t: "\\" in t))
# One work budget per request, shared by every decoding and every embedded-JSON parse, so no input can make the scan
# expensive (stand-in r16.1 #1); running out refuses the request instead of letting it through (stand-in r16.1 #2).
# The budget is a fixed allowance plus a small constant per string and per character sent, so the work is at most
# linear in the request's own size: ordinary large requests fit, and no short input can amplify into a long scan.
SCAN_STEPS, SCAN_BYTES, SCAN_DEPTH = 256, 1024 * 1024, 6
SCAN_STEPS_PER_STRING, SCAN_BYTES_PER_CHAR = 4, 6
_STILL_ENCODED = re.compile(r"%[0-9A-Fa-f]{2}|&#[0-9]+;|&#[xX][0-9a-fA-F]+;|\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2})")
_NAMES_HINT = re.compile(r"mind|agent|a_")


class _Unresolved(Exception):
    pass


class _Scan:
    """Mind references across JSON values, under one bounded budget. ``unresolved`` is set when the budget runs out or
    decoding stops at something that still looks encoded or nested next to a mind-like name: the caller refuses."""

    def __init__(self):
        self.steps = self.bytes = 0
        self.every, self.other, self.unresolved = set(), False, False
        self._done = set()          # (state, root literal, depth) already expanded: memoized across the whole request

    def _spend(self, size):
        self.steps += 1
        self.bytes += size
        if self.steps > self.max_steps or self.bytes > self.max_bytes:
            raise _Unresolved()

    def run(self, values):
        strings = chars = 0
        stack = list(values)
        while stack:                    # size the budget from the request itself (no recursion, no decoding)
            v = stack.pop()
            if isinstance(v, str):
                strings, chars = strings + 1, chars + len(v)
            elif isinstance(v, dict):
                stack.extend(v.keys())
                stack.extend(v.values())
            elif isinstance(v, (list, tuple)):
                stack.extend(v)
        self.max_steps = SCAN_STEPS + SCAN_STEPS_PER_STRING * strings
        self.max_bytes = SCAN_BYTES + SCAN_BYTES_PER_CHAR * chars
        try:
            for value in values:
                self._walk(value, 0)
        except (_Unresolved, RecursionError):
            self.unresolved = True
        return self

    def _walk(self, value, depth):
        if isinstance(value, str):
            self._text(value, depth)
        elif isinstance(value, dict):
            for k, v in value.items():
                self._walk(k, depth)
                self._walk(v, depth)
        elif isinstance(value, (list, tuple)):
            for v in value:
                self._walk(v, depth)

    def _text(self, root, depth):
        from collections import Counter
        literal = MIND_REF.findall(root)
        self.every.update(literal)
        if "a_" not in root.casefold() and not any(c in root for c in "%\\&+") and root.isascii():
            return          # nothing here can decode to a mind id (fast path for ordinary text)
        want = Counter(literal)
        key = tuple(sorted(want.items()))
        queue = [root]
        while queue:
            view = queue.pop(0)
            if (view, key, depth) in self._done:
                continue
            self._done.add((view, key, depth))
            plain = _plain(view).casefold() if not view.isascii() else view.casefold()
            found = _MIND_REF_ANY.findall(plain)
            self.every.update(found)
            if depth == 0 and Counter(found) != want:
                self.other = True
            stripped = view.strip()
            if stripped[:1] in ("{", "[", '"'):
                if depth >= SCAN_DEPTH:
                    if _NAMES_HINT.search(plain):
                        raise _Unresolved()     # nested deeper than we follow, next to a mind-like name
                else:
                    self._spend(len(stripped))
                    try:
                        inner = json.loads(stripped)
                    except ValueError:
                        inner = None
                    if inner is not None and not isinstance(inner, (int, float, bool)):
                        self._walk(inner, depth + 1)
            changed = False
            for decode, may_change in _DECODERS:
                if not may_change(view):
                    continue
                self._spend(len(view))
                try:
                    nxt = decode(view)
                except Exception:
                    continue
                if nxt != view:
                    changed = True
                    if (nxt, key, depth) not in self._done:
                        queue.append(nxt)
            if not changed and _STILL_ENCODED.search(view) and _NAMES_HINT.search(plain):
                raise _Unresolved()             # decoding stopped at something still encoded beside a mind-like name


def mind_refs(*values):
    """(every mind id named in any spelling, whether any is written other than as the supported spelling, whether the
    scan could not finish) across JSON values: each string's keys and values, nested, and JSON embedded in a string. A
    string conforms only when every decoded view of it names exactly the minds its supported-spelling references name.
    The whole scan shares one budget (decodings and parses, and the characters they read; see SCAN_*); when it runs
    out, or decoding stops at something still encoded beside a mind-like name, the third value is True and the request
    must be refused, never passed on."""
    scan = _Scan().run(values)
    return scan.every, scan.other, scan.unresolved


def migrate(db):
    for table in ("swarms", "agents"):
        columns = {r["name"] for r in db.all(f"PRAGMA table_info({table})")}
        if "owner" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN owner TEXT")
        if "visibility" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'")
        if "shared_with" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN shared_with TEXT NOT NULL DEFAULT '[]'")


def clean(visibility, shared_with):
    if visibility is not None and visibility not in LEVELS:
        raise ValueError(f"visibility is one of {', '.join(LEVELS)}")
    people = []
    for p in shared_with or []:
        p = str(p).strip()
        if not p.startswith("user:") or len(p) > 80:
            raise ValueError("share with people by principal, e.g. user:u_ab12")
        people.append(p)
    return visibility, sorted(set(people))


class Viewer:
    def __init__(self, principal, admin, audit=False):
        # audit: an admin's explicit ?include=personal (or a by-id route), which lifts Visibility.hide_others_personal
        self.principal, self.admin, self.audit = principal or "user:operator", bool(admin), bool(audit)

    def sees(self, row):
        if self.admin or row is None:
            return self.admin
        vis = row.get("visibility") or "public"
        if vis == "public" or row.get("owner") == self.principal:
            return True
        if vis == "shared":
            try:
                return self.principal in json.loads(row.get("shared_with") or "[]")
            except ValueError:
                return False
        return False


# How each live event kind reaches people who are not admins (admins see every event). Kimi hotfix-shares r3: the old
# filter delivered any frame it found no recognisable ids in to every signed-in member, so a new event shape leaked by
# default. Now every kind is registered here, and an unregistered kind is withheld (test_every_published_event_kind_
# has_a_rule fails CI for a new emitter without a rule).
#   scoped  - names a mind, swarm, room or goal; delivered only when it names at least one and the person sees all
#   public  - hive-wide news whose HTTP counterpart every signed-in person may already read
#   admin   - operator business: policy, providers, budgets, people, app grants, harness connections, health
#   share.updated has its own rule (Shares.visible), and hive share notices follow it too.
EVENT_RULES = {
    **{k: "scoped" for k in (
        "swarm.updated", "swarm.deleted", "agent.updated", "agent.deleted", "agent.trace", "agent.thinking",
        "goal.updated", "request.updated", "message", "room", "program.action", "program.attachment",
        "program.activation", "connection.updated", "wakeup.updated", "wakeup.fired", "belief.updated",
        "belief.published", "artifact.revision", "usage", "budget.refused", "budget.overrun", "approval.created",
        "approval.updated", "mind.updated",
        # media r2.2: a mind's media breaker opening or being reset reaches whoever can see that mind, like budget.overrun
        "media.breaker_tripped", "media.breaker_reset")},
    # every signed-in person already reads these over HTTP: the app list, update holds, and lab runs with their full
    # log (/api/lab/runs is operator-only, unfiltered). If lab logs are ever redacted on one side, change both.
    # program.release_changed contains only the public app id/digest (or a content-free withdrawal), never memory or
    # theme data. This generic event filter grants no P8 operation authority; P8 still checks its host binding.
    # P14: program.install_reviewed carries only the app id and its placement (never who reviewed it or the audience)
    **{k: "public" for k in ("programs.updated", "program.updated", "program.release_changed", "program.install_reviewed",
                             "updates", "lab.run", "lab.log", "lab.case")},
    "hive.power": "public",   # {state, since} only: whether the hive is on or off, never which minds
    **{k: "admin" for k in (
        "policy.updated", "providers.updated", "budgets.updated", "people.updated",
        "harness.connected", "health.alert", "sessions.kept", "app.grants_refused", "app.grants_revoked", "app.grants_restored",
        "app.grants_restore_applied", "app.grants_renewed", "app.release_refused")},
    "share.updated": "share",
    # a person's own asks reach that person (and admins), never everyone who sees the swarm (Kimi B2)
    "person_request.created": "requester", "person_request.updated": "requester",
    # judged against the stored motivation by Motivations.readable; links also need the swarm and every goal in it
    "motivation.updated": "motivation", "motivation.links": "motivation_links",
    # Universal Ask (ask.py): frames go to the asker only, checked in event_visible before the admin bypass. Admins are NOT
    # sent other people's (the owner has not ruled on live admin sight); they read every turn in /api/ask/audit. The thread's
    # ordinary room/message/goal/trace events still follow their own rules, which admins do receive.
    "ask": "asker",
    # J3 host R2 (studio_sessions.py): a person's Studio session notice (ids and state, no body) reaches that person, judged
    # against the stored session row, and admins (the admin bypass); never everyone who sees the Studio home's swarm
    "studio.session": "studio_person",
    # J3 host R3 (studio_steps.py): each step's admitted / proposal_ready / outcome / closed notice, the same rule: ids,
    # the step, its proposal revision and outcome, never a body or direction text
    "studio.step": "studio_person",
    # G2 (notices.py): a person's notice frame goes to that person only, checked in event_visible before the admin bypass
    "notice": "person",
}


_WITHHELD_LOGGED: set = set()


def event_rule(kind):
    if kind in EVENT_RULES:
        return EVENT_RULES[kind]
    if isinstance(kind, str) and kind.endswith(".evidence_failed"):   # governance_evidence: f"{commons}.evidence_failed"
        return "admin"
    return None                                                        # unregistered: withheld from members


class Visibility:
    def __init__(self, hive):
        self.hive = hive
        migrate(hive.db)

    def wakeup_principal(self, principal):
        """G1's enabled-person check covers both named and legacy family user principals.

        A family username without a directly matching people row has no disabled flag here. Its sign-in/expiry
        remains the caller's auth boundary. A missing named u_* person fails closed as before.
        """
        principal = principal or "user:operator"
        if principal.startswith("user:"):
            person = self.hive.db.one("SELECT disabled FROM people WHERE id = ?", (principal[5:],))
            if (person is not None and person["disabled"]) or (person is None and principal.startswith("user:u_")):
                raise self.hive.error(401, "unauthorized", "log in first")
        return principal

    def wakeup_text_reader(self, viewer, agent_id):
        """Current authenticated viewer only: mind owner/admin text; hive ownership grants no text read.

        Callers authenticate afresh for each request/privacy-sensitive event and supply the current admin role.
        This does not authenticate a Viewer or turn an old websocket snapshot into current authority.
        """
        principal = self.wakeup_principal(viewer.principal)
        if viewer.admin:
            return True
        mind = self.hive.db.one("SELECT owner FROM agents WHERE id = ?", (agent_id,))
        return bool(mind) and mind.get("owner") == principal

    def project_person_message(self, viewer, message, *, agent_id=None):
        """Person-facing scheduled-message text projection, reusable by HTTP, websocket and host adapters.

        Does not replace the caller's existing message/room visibility filter. Canonical messages carry agent_id;
        room callers supply it from the stored c_<mind> alias, never client data. Old room mirrors lost the sender,
        so system:hive [WAKE ...] notes in those rooms are conservatively protected without changing their bytes.
        Internal delivery, persistence, model inputs and owner-authorized exports do not call this projection.
        """
        historical = agent_id is not None and message.get("sender") == "system:hive" and str(message.get("text") or "").startswith("[WAKE ")
        if message.get("sender") != "hive:schedule" and not historical:
            return message
        reads_text = self.wakeup_text_reader(viewer, agent_id or message.get("agent_id"))
        return message if reads_text else dict(message, text="text hidden")

    def _swarm(self, sid):
        return self.hive.db.one("SELECT * FROM swarms WHERE id = ?", (sid,))

    def _agent(self, aid):
        return self.hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (aid,))

    def check_named_minds(self, viewer, *values):
        """r16: an app view, read, act or confirm that names a mind (`mind:<id>` or `agent:<id>` anywhere in what the
        person sends the app) is refused as not found unless the person may see every named mind; unknown and deleted
        ids are refused the same way, so existence is not revealed, and the app is never called. Names are found in every
        decoded string, in the supported spelling and any spelling an app could decode (see mind_refs); once every named
        mind is visible, one written in another spelling is refused (400) so apps only ever receive the supported one, and
        a request the bounded scan could not finish is refused (400 mind_reference_unresolved), never passed on."""
        every, spelled_otherwise, unresolved = mind_refs(*values)
        for agent_id in sorted(every):
            row = self._agent(agent_id)
            if row is None or not (viewer.admin or viewer.sees(row)):
                raise self.hive.error(404, "not_found", "no such mind")
        if unresolved:      # stand-in r16.1 #2: a scan that could not finish never lets the request through
            raise self.hive.error(400, "mind_reference_unresolved",
                                  "this request is encoded too deeply to check which minds it names; send it plainly")
        if spelled_otherwise:
            raise self.hive.error(400, "mind_reference_spelling", "name a mind exactly as mind:<id> or agent:<id>")

    def check_path(self, viewer, params):
        """Refuse (as not found) a route whose mind, swarm or goal this person may not see."""
        if viewer.admin:
            return
        if params.get("agent_id") and not viewer.sees(self._agent(params["agent_id"])):
            raise self.hive.error(404, "not_found", "no such mind")
        if params.get("swarm_id") and not viewer.sees(self._swarm(params["swarm_id"])):
            raise self.hive.error(404, "not_found", "no such swarm")
        if params.get("goal_id"):
            goal = self.hive.db.one("SELECT swarm_id FROM goals WHERE id = ?", (params["goal_id"],))
            if goal is None or not viewer.sees(self._swarm(goal["swarm_id"])):
                raise self.hive.error(404, "not_found", "no such task")

    def hidden_personal(self, viewer, table):
        """Ids in `table` (agents or swarms) that are another person's personal mind or swarm (personal_of, set by
        personal.ensure) which this viewer could not see as a member (the owner 2026-10-09: "I should only see my own user
        unless others give me permission to see")."""
        try:
            rows = self.hive.db.all(f"SELECT id, owner, visibility, shared_with, personal_of FROM {table} "
                                    "WHERE personal_of IS NOT NULL")
        except sqlite3.OperationalError:          # personal_of not added yet (personal.migrate runs later)
            return set()
        member = Viewer(viewer.principal, False)
        return {r["id"] for r in rows if r["personal_of"] != viewer.principal and not member.sees(r)}

    def hidden_ids(self, viewer):
        """The one source for every admin default list and live event: the mind and swarm ids an admin does not see
        unless they audit. Empty for members (Viewer.sees already hides other people's private rows) and for an audit
        viewer (?include=personal, admin only, or a by-id route). Cached on the viewer for 2 s (a live socket's viewer
        is long-lived)."""
        if viewer is None or not viewer.admin or getattr(viewer, "audit", False):
            return frozenset()
        cached = getattr(viewer, "_hidden_cache", None)
        if cached and time.monotonic() - cached[0] < 2:
            return cached[1]
        ids = frozenset(self.hidden_personal(viewer, "agents") | self.hidden_personal(viewer, "swarms"))
        viewer._hidden_cache = (time.monotonic(), ids)
        return ids

    def hides(self, viewer, *ids):
        """Whether any of these mind or swarm ids is hidden from this viewer's default lists."""
        hidden = self.hidden_ids(viewer)
        return bool(hidden) and any(i in hidden for i in ids if i)

    def hide_others_personal(self, viewer, items, key=None):
        """THE helper for every admin default list (stand-in r2: one sweep, no whack-a-mole): drop items that name a
        hidden personal mind or swarm. `key(item)` gives the mind/swarm ids an item names; by default every id the live
        event scan finds, plus the swarm of any room it names. A no-op for members and audit viewers."""
        hidden = self.hidden_ids(viewer)
        if not hidden:
            return list(items)
        key = key or self._item_ids
        return [i for i in items if not any(x in hidden for x in key(i) if x)]

    def _item_ids(self, item):
        """The admin list key: the live-event scan's ids, plus fields only lists carry (owner_swarm, owners arrays, and
        created_by/by naming a mind), at any depth the scan reaches. The member event scan (_named) is not widened: a
        goal's created_by names a mind members often cannot see, and their events must not be withheld for it."""
        if not isinstance(item, dict):
            return ()
        agent_ids, swarm_ids, room_ids = self._named(item)

        def extra(obj, depth=0):
            if depth > 3 or not isinstance(obj, dict):
                return
            for k, v in obj.items():
                if k == "owner_swarm" and isinstance(v, str):
                    swarm_ids.add(v)
                elif k == "owners" and isinstance(v, list):
                    swarm_ids.update(x for x in v if isinstance(x, str))
                elif k in ("created_by", "by") and isinstance(v, str) and v.startswith("agent:a_"):
                    agent_ids.add(v[6:])
                elif isinstance(v, dict):
                    extra(v, depth + 1)
                elif isinstance(v, list):
                    for x in v[:200]:
                        extra(x, depth + 1)
        extra(item)
        rooms = set()
        for rid in room_ids:
            r = self.hive.db.one("SELECT swarm_id FROM rooms WHERE id = ?", (rid,)) if rid != "r_unknown" else None
            if r and r.get("swarm_id"):
                rooms.add(r["swarm_id"])
        return agent_ids | swarm_ids | rooms

    def agents(self, viewer, items):
        if viewer.admin:
            return self.hide_others_personal(viewer, items, lambda a: [a.get("id"), a.get("swarm_id")])
        rows = {r["id"]: r for r in self.hive.db.all("SELECT id, owner, visibility, shared_with FROM agents")}
        return [a for a in items if viewer.sees(rows.get(a["id"]))]

    def swarms(self, viewer, items):
        if viewer.admin:
            return self.hide_others_personal(viewer, items, lambda s: [s.get("id")])
        rows = {r["id"]: r for r in self.hive.db.all("SELECT id, owner, visibility, shared_with FROM swarms")}
        return [s for s in items if viewer.sees(rows.get(s["id"]))]

    def _admin_event_visible(self, viewer, text):
        """Admins receive every live event except those naming a hidden personal mind or swarm (or a room in it), and
        never another person's chat with a mind. An audit viewer hides no personal mind or swarm, but audit lifts only
        that: another person's chat frame is still judged by Hive.chat_visible here, so live audit never streams it
        (Kimi idle-minds r2.2 #2). Admins audit people's chats over HTTP only (?include=all / ?include=personal).
        event_visible already withholds those frames first (_others_chat); this repeats the rule where the admin
        bypass lives, so the order of the two checks is never what keeps a person's chat private."""
        if viewer.audit and self._others_chat(viewer, text):
            return False
        if not self.hidden_ids(viewer):
            return True
        try:
            e = json.loads(text)
        except ValueError:
            return True
        return bool(self.hide_others_personal(viewer, [e]))

    def _share_notice_visible(self, viewer, message):
        row = self.hive.db.one("SELECT extra FROM messages WHERE id = ?", (str(message.get("id") or ""),))
        try:
            share_id = (json.loads(row["extra"]) if row and row["extra"] else {}).get("share_id")
        except ValueError:
            share_id = None
        share = self.hive.db.one("SELECT * FROM shares WHERE id = ?", (share_id,)) if share_id else None
        shares = getattr(self.hive, "shares", None)
        return bool(share) and shares is not None and shares.visible(viewer, share)

    def _ask_content(self, viewer, text):
        """Ask-derived content goes to its asker only, admins included (the owner 2026-10-05: asker-only live, admins audit).
        Checked before the admin bypass. None when the frame is not Ask content:
        - 'ask' frames, by their principal;
        - 'message' frames in an ask:<turn> conversation (the request and the mind's replies), by that turn's asker;
        - 'agent.trace' frames by the audience the host stored when the trace was created (Ask.trace_scope): one asker,
          or nobody live when uncertain; a trace with no stored scope is ordinary."""
        ask = getattr(self.hive, "ask", None)
        if text.startswith('{"type": "ask"'):
            try:
                return json.loads(text).get("principal") == viewer.principal
            except ValueError:
                return False
        if ask is None or not text.startswith(('{"type": "message"', '{"type": "agent.trace"')):
            return None
        try:
            e = json.loads(text)
        except ValueError:
            return False
        if e.get("type") == "message":
            conversation = (e.get("message") or {}).get("conversation_id")
            if isinstance(conversation, str) and conversation.startswith("ask:"):
                return ask.asker(conversation) == viewer.principal
            return None
        trace = e.get("trace") if isinstance(e.get("trace"), dict) else {}
        if trace.get("id") is None:
            return None
        try:
            scope = ask.trace_audience(trace["id"])
        except (TypeError, ValueError):
            return False
        if scope is None:          # an ordinary trace: its existing rules
            return None
        return scope["scope"] == "asker" and scope["principal"] == viewer.principal

    def _named(self, e):
        """The mind, swarm and room ids one live event names (the scoped rule's scan)."""
        agent_ids, swarm_ids, room_ids = set(), set(), set()

        def scan(obj, depth=0):
            if depth > 3 or not isinstance(obj, dict):
                return
            for k, v in obj.items():
                if k in ("agent_id", "mind_id", "mind", "about") and isinstance(v, str) and v.startswith("a_"):
                    agent_ids.add(v)
                elif k in ("swarm_id", "from_swarm", "to_swarm") and isinstance(v, str) and v:
                    # connections and requests link two swarms and are judged by both of them; their coordinator minds
                    # are implied by that link (minds are private by default; Kimi next10-events r2, r3)
                    swarm_ids.add(v)
                elif k == "room_id" and isinstance(v, str):
                    room_ids.add(v)
                elif k == "conversation_id" and isinstance(v, str) and v.startswith("r_"):
                    room_ids.add(v)   # a room message as delivered to (or answered by) a mind
                elif k == "conversation_id" and isinstance(v, str) and v.startswith("team_"):
                    # a swarm's team room is delivered under its alias: judged by that room (stand-in S2)
                    r = self.hive.db.one("SELECT id FROM rooms WHERE alias = ?", (v,))
                    room_ids.add(r["id"] if r else "r_unknown")
                elif k == "conversation_id" and isinstance(v, str) and v.startswith("ask:"):
                    ask = getattr(self.hive, "ask", None)   # an Ask turn's conversation is judged by its thread's room
                    room_ids.add((ask.room_for(v) if ask else None) or "r_unknown")
                elif k == "id" and isinstance(v, str) and v.startswith("a_"):
                    agent_ids.add(v)
                elif k == "id" and isinstance(v, str) and v.startswith("s_"):
                    swarm_ids.add(v)
                elif isinstance(v, dict):
                    scan(v, depth + 1)
        scan(e)
        return agent_ids, swarm_ids, room_ids

    def _others_chat(self, viewer, text):
        """A live 'message' frame from another person's chat with a mind (mind-chat-identity r1), either direction:
        withheld from every named person, admins included, and audit viewers too (Viewer.audit is ignored here: live
        audit never streams a person's chat; admins audit over HTTP with ?include=all, Kimi idle-minds r2.2 #2). The
        loopback operator is judged by the same Hive.chat_visible, which scopes it only on a personal mind (its
        person's conversations are theirs: Kimi idle-minds r2.1 sharpest) and leaves it the whole stream elsewhere."""
        if not text.startswith('{"type": "message"'):
            return False
        chat_visible = getattr(self.hive, "chat_visible", None)
        if chat_visible is None:
            return False
        try:
            message = json.loads(text).get("message")
        except (ValueError, AttributeError):
            return False
        return isinstance(message, dict) and chat_visible(viewer.principal, message) is False

    def event_visible(self, viewer, text):
        """Whether one serialized live event may go to this person."""
        asked = self._ask_content(viewer, text)
        if asked is not None:
            return asked
        if text.startswith('{"type": "notice"'):
            try:
                return json.loads(text).get("principal") == viewer.principal
            except ValueError:
                return False
        if self._others_chat(viewer, text):
            return False
        if viewer.admin:
            return self._admin_event_visible(viewer, text)
        try:
            e = json.loads(text)
        except ValueError:
            return False
        if isinstance(e, dict) and e.get("type") == "share.updated":
            # A share names two minds in fields the generic scan does not read (owner_id, grantee_id): judge it by the
            # same rule as GET /api/shares, against the stored row, failing closed (OmegaReview hotfix event leak).
            share = e.get("share")
            if not isinstance(share, dict) or not share.get("id"):
                return False
            row = self.hive.db.one("SELECT * FROM shares WHERE id = ?", (share["id"],))
            shares = getattr(self.hive, "shares", None)
            return bool(row) and shares is not None and shares.visible(viewer, row)
        # A hive share notice ("[SHARE-REQUEST …] … asks to read your space …") is a message to a mind, but it is
        # about a share: it goes only to people who may see that share, live or listed (Kimi hotfix-shares r3).
        message = e.get("message") if isinstance(e, dict) and e.get("type") == "message" else e
        if isinstance(message, dict) and message.get("sender") == "hive:shares" and not self._share_notice_visible(viewer, message):
            return False
        kind = e.get("type") if isinstance(e, dict) else None
        rule = event_rule(kind) if kind is not None else "scoped"         # list items (no type) keep the id scan
        if rule in ("admin", None):
            return False
        if rule in ("motivation", "motivation_links"):
            motivations = getattr(self.hive, "motivations", None)
            return isinstance(e, dict) and motivations is not None and motivations.event_visible(viewer, e, rule)
        if rule == "public":
            return True
        if rule == "studio_person":
            try:
                row = self.hive.db.one("SELECT principal FROM studio_sessions WHERE id = ?", (str(e.get("session_id") or ""),))
            except sqlite3.OperationalError:          # a hive without the Studio plane: nothing to show
                return False
            return bool(row) and row["principal"] == viewer.principal
        if rule == "requester":
            req = e.get("request") if isinstance(e.get("request"), dict) else {}
            return bool(req.get("requested_by")) and req.get("requested_by") == viewer.principal
        agent_ids, swarm_ids, room_ids = self._named(e)
        if kind is not None and not (agent_ids or swarm_ids or room_ids):
            # a scoped event that names nothing recognisable is not broadcast; say so, once per kind, so an emitter
            # whose ids hide under an unrecognised key is visible as a defect rather than silent (Kimi)
            if kind not in _WITHHELD_LOGGED:
                _WITHHELD_LOGGED.add(kind)
                logging.getLogger("hive").warning("live event %r names no mind, swarm or room; withheld from members", kind)
            return False
        rooms = getattr(self.hive, "rooms", None)
        for rid in room_ids:   # a room's events go only to those who can see the room (R15)
            r = self.hive.db.one("SELECT * FROM rooms WHERE id = ?", (rid,))
            if r is None or rooms is None or not rooms.can_see(viewer, r):
                return False
        return all(viewer.sees(self._agent(a)) for a in agent_ids) and all(viewer.sees(self._swarm(s)) for s in swarm_ids)

    def filter_items(self, viewer, items):
        """Any list whose items mention minds or swarms: keep what this person may see (admins: hide_others_personal)."""
        if viewer.admin:
            return self.hide_others_personal(viewer, items)
        return [i for i in items if self.event_visible(viewer, json.dumps(i, default=str))]

    def set(self, table, item_id, viewer, visibility=None, shared_with=None, pays=None):
        """Owner (or admin) only. ``pays`` (own hive H1, ownhive.py): who pays when this is public: own-key or hive-key."""
        row = self.hive.db.one(f"SELECT * FROM {table} WHERE id = ?", (item_id,))
        if row is None:
            raise self.hive.error(404, "not_found", "not found")
        if not viewer.admin and row.get("owner") != viewer.principal:
            raise self.hive.error(403, "owner_only", "only its owner or an admin changes who can see it")
        try:
            visibility, people = clean(visibility, shared_with)
        except ValueError as exc:
            raise self.hive.error(400, "bad_visibility", str(exc)) from None
        values = {}
        if pays is not None:
            from .ownhive import PAYS
            if pays not in PAYS:
                raise self.hive.error(400, "bad_pays", "pays is own-key or hive-key")
            if pays == "hive-key" and not self.hive.ownhive.is_owner(viewer.principal):   # H1.1: the owner's money
                raise self.hive.error(403, "owner_only", "Only this hive's owner can let the hive's key pay.")
            values["pays"], values["pays_by"] = pays, viewer.principal
        if visibility:
            values["visibility"] = visibility
        if shared_with is not None:
            values["shared_with"] = json.dumps(people)
        if values:
            self.hive.db.update(table, item_id, values)
        return values
