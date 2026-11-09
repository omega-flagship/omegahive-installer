"""Error checking across minds: classify what each mind's commands returned, find patterns, say what to do.

Everything here is computed from records the hive already keeps (traces, approvals, mind status, the
spending rules), so it needs no new storage and cannot drift from what actually happened.  The live
check runs on every recorded trace and raises one ``health.alert`` event per new pattern.
"""

import datetime
import json
import logging
import re
import time

from .db import latest_stamp, new_id, now, parse_stamp, stamp_of
from .rooms import COFFEE as ROOM_COFFEE, HEALTH_SENDER, TEAM as ROOM_TEAM

HEALTH_QUESTION = "health_question"     # the event of Health's idle question: never counted as the mind's input
HEALTH_QUESTION_TAG = "[HEALTH-QUESTION "   # how its text starts (hive.py: never shown as a hive note in another's chat)
log = logging.getLogger("hive")

def for_people(sender, text):
    """The words of a message as people read them: Health's question without its id tag. The tag is for the mind (it
    names the question the mind answers) and stays on the mind's own message; a room copy, which people read, has none."""
    text = str(text or "")
    if sender == HEALTH_SENDER and text.startswith(HEALTH_QUESTION_TAG):
        end = text.find("]", len(HEALTH_QUESTION_TAG))
        if end != -1:
            return text[end + 1:].lstrip()
    return text


def people_message(view):
    """A message as a person reads it (Peter on omegahive#50): only a verified Health question (Hive.message_view marked
    it health_check, from its stored event, never from its text) loses its id tag. Anything else, a mind or a person
    quoting the tag included, is returned exactly as it was. The stored row and what minds receive keep the tag."""
    if isinstance(view, dict) and view.get("health_check") is True and view.get("sender") == HEALTH_SENDER:
        return {**view, "text": for_people(HEALTH_SENDER, view.get("text"))}
    return view


def people_frame(text):
    """A serialized event frame as a person's socket (/api/events) receives it: a "message" event carrying a verified
    Health question, its text through people_message; every other frame byte for byte. Decided by parsing the frame (Kimi
    on 7cf0ca57: never by how a field happens to be spelled in it); Health's sender name is only the cheap pre-check."""
    if HEALTH_SENDER not in text:
        return text
    try:
        event = json.loads(text)
    except ValueError:
        return text
    if not isinstance(event, dict) or event.get("type") != "message" or not isinstance(event.get("message"), dict):
        return text
    message = people_message(event["message"])
    return text if message is event["message"] else json.dumps({**event, "message": message})


# kind -> (severity, what it means, what to do)
KINDS = {
    "crash": ("high", "the mind's process stopped with an error", "Open the mind and read its last log; restart it after fixing the cause."),
    "budget": ("high", "a paid call was refused by a spending limit or a missing key", "Raise or reset the limit in Usage, or assign a working key in the mind's settings."),
    "loop": ("high", "the mind keeps getting the same failure", "Read the repeated result; tell the mind what to do differently, or fix the skill it is calling."),
    "unconnected": ("high", "the mind was started but never connected to the hive",
                    "Its process cannot reach the hive (address, port or sandbox): read its last log, fix the cause, then stop and start it."),
    "unreachable": ("medium", "a service the mind needs did not answer", "Check that the service is running (Code service, a program, the network)."),
    "error": ("medium", "a skill or service returned an error", "Read the example; it usually names the cause."),
    "denied": ("medium", "the policy gate refused a command", "If the mind should be allowed, add an allow rule for that skill; otherwise tell the mind not to use it."),
    "refused": ("low", "a request was refused for ownership or scope (not a fault)", "Usually the mind needs to claim its task first, or the item belongs to someone else."),
    "unknown-skill": ("low", "the mind called a skill that does not exist", "The mind may remember an old name; tell it the current one, or add an alias."),
    "parse": ("low", "the mind wrote a malformed command", "Occasional ones are normal; many in a row mean its prompt or model needs attention."),
    "waiting": ("low", "an approval is waiting for a person", "Approve or deny it in Approvals."),
    "team-room": ("medium", "the mind's swarm has no usable room, so the other minds in its swarm cannot reach it there",
                  "Read the example. An admin repairs it (POST /api/swarms/<swarm>/team-room/repair): a swarm room archived by hand "
                  "reopens with its history; a room holding its alias keeps its own members and history and gives the alias up."),
    "stale": ("info", "an edit was refused because the file changed first (expected with people editing too)", "Nothing to do unless it repeats."),
}
SEVERITY_RANK = {"high": 3, "medium": 2, "low": 1, "info": 0}

_RULES = [
    ("parse", re.compile(r"^\[?'?syntax-error|^\(syntax-error|METTA-SYNTAX-ERROR")),
    ("unknown-skill", re.compile(r"unknown command head|no such skill|unknown skill", re.I)),
    ("budget", re.compile(r"spend_limit|key_unavailable|HIVE-BUDGET|budget exhausted|\b402\b")),
    ("denied", re.compile(r"^HIVE-DENIED")),
    ("waiting", re.compile(r"^(HIVE-APPROVAL-PENDING|CODE-APPROVAL-NEEDED)")),
    ("stale", re.compile(r"^CODE-STALE")),
    ("unreachable", re.compile(r"UNREACHABLE|ConnectError|ConnectTimeout|timed out|Connection refused", re.I)),
    ("refused", re.compile(r"^CODE-REFUSED|\b(goal_not_owned|not_assigned|not_open|not_claimed)\b|^HIVE-ERROR forbidden")),
    ("error", re.compile(r"^(HIVE-ERROR|CODE-ERROR|ERROR)|Traceback|Exception:", re.I)),
]


def classify(command, result):
    """The kind of problem a command's result shows, or None when it is fine."""
    command, result = str(command or "").strip(), str(result or "").strip()
    if command.startswith("(syntax-error"):
        return "parse"
    for kind, pattern in _RULES:
        if pattern.search(result):
            return kind
    return None


def _skill(command):
    m = re.match(r"\(\s*([^\s()]+)", str(command or ""))
    return m.group(1) if m else "?"


def signature(command, result):
    """What makes two failures 'the same': the skill plus the result with ids and numbers blurred."""
    text = re.sub(r"\b[a-z]{1,4}_[0-9a-f]{6,}\b", "<id>", str(result or "")[:160])
    text = re.sub(r"\d+(\.\d+)?", "<n>", text)
    return f"{_skill(command)} :: {text}"


def _stamp_ago(seconds):
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Health:
    REPEAT = 3          # the same failure this many times within WINDOW commands is a loop
    WINDOW = 12
    ALERT_QUIET_S = 1800
    RECENT_S = 3600     # problems older than this no longer count toward a mind's health
    UNCONNECTED_S = 120  # a start that has not reached the hub after this long is reported, not waited on

    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        self.alerted = {}   # (agent_id, signature) -> time of last alert
        self.pending = []   # alerts waiting to be delivered to the health mind
        self.idle = IdleWatch(self)   # idle minds: notice, ask once, record the answer (never a limit)

    def on_mind_message(self, agent_id, message):
        return self.idle.on_mind_message(agent_id, message)

    # ---- reports -----------------------------------------------------------------------------

    def mind(self, agent, traces=200):
        rows = self.db.all("SELECT commands, iteration, created_at FROM traces WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
                           (agent["id"], traces))
        issues, recent = {}, []
        for row in rows:
            for item in json.loads(row["commands"] or "[]"):
                kind = classify(item.get("command"), item.get("result"))
                recent.append((kind, item, row))
        for kind, item, row in recent:
            if kind is None:
                continue
            self._add(issues, kind, item, row)
        # loops: the same non-trivial failure repeated in a short stretch
        for i in range(len(recent)):
            window = [r for r in recent[i:i + self.WINDOW] if r[0] not in (None, "waiting", "stale")]
            counts = {}
            for kind, item, row in window:
                counts.setdefault(signature(item.get("command"), item.get("result")), []).append((kind, item, row))
            for sig, hits in counts.items():
                if len(hits) >= self.REPEAT and ("loop", sig) not in issues:
                    self._add(issues, "loop", hits[0][1], hits[0][2], key=("loop", sig), count=len(hits))
        refused = self.hive.refusals.get(agent["id"])
        if refused and refused.get("count"):
            issues[("budget", "model-call")] = self._issue("budget", {"command": "(model call)", "result": f"{refused['code']}: {refused['message']}"},
                                                         {"created_at": refused["last_at"], "iteration": None}, refused["count"])
        # started but never joined the hub: 'starting' only becomes 'awake' when the mind connects (2026-10-08: cloud
        # minds dialled an address the server does not listen on and sat at 'starting' while health said ok)
        started = _ago(agent.get("last_active_at"))   # by time, never as text (Kimi idle-minds r2 #4); no stamp counts as old
        if agent.get("status") == "starting" and (started is None or started > self.UNCONNECTED_S):
            issues[("unconnected", "")] = self._issue("unconnected", {"command": "", "result": f"starting since {agent.get('last_active_at')}"},
                                                       None, 1)
        rooms = getattr(self.hive, "rooms", None)
        problem = rooms.team_problem(agent) if rooms is not None else None
        if problem:   # a wedged or hand-archived team room is said here, not only in the log (Kimi K2/K3)
            issues[("team-room", "")] = self._issue("team-room", {"command": "", "result": problem}, None, 1)
        if agent.get("status") == "error" or agent.get("last_error"):
            issues[("crash", "")] = self._issue("crash", {"command": "", "result": agent.get("last_error") or "error"},
                                                 None, 1)
        pending = self.db.all("SELECT id, skill, created_at FROM approvals WHERE agent_id = ? AND status = 'pending'",
                              (agent["id"],))
        if pending:
            issues[("waiting", "")] = self._issue("waiting", {"command": pending[0]["skill"], "result": f"{len(pending)} approval(s) waiting"},
                                                   {"created_at": pending[0]["created_at"], "iteration": None}, len(pending))
        # the trace-derived 'waiting' kind is replaced by the live approvals count above
        issues = {k: v for k, v in issues.items() if k[0] != "waiting" or k == ("waiting", "")}
        cutoff = _stamp_ago(self.RECENT_S)
        for issue in issues.values():
            # a problem counts toward the mind's health only while it is recent; older ones stay listed as "earlier"
            issue["recent"] = issue["kind"] in ("crash", "waiting", "unconnected", "team-room") or bool(issue["last_at"] and issue["last_at"] >= cutoff)
        listed = sorted(issues.values(), key=lambda x: (not x["recent"], -SEVERITY_RANK[x["severity"]], -x["count"]))
        current = [x for x in listed if x["recent"]]
        worst = max((x["severity"] for x in current), key=lambda v: SEVERITY_RANK[v], default="ok")
        return {"id": agent["id"], "name": agent["name"], "swarm_id": agent.get("swarm_id"), "status": agent.get("status"),
                "health": "ok" if worst in ("ok", "info") else worst, "issues": listed,
                "checked_commands": len(recent)}

    def _issue(self, kind, item, row, count):
        severity, meaning, hint = KINDS[kind]
        return {"kind": kind, "severity": severity, "meaning": meaning, "hint": hint, "count": count,
                "skill": _skill(item.get("command")), "example": {"command": str(item.get("command", ""))[:300],
                                                                    "result": str(item.get("result", ""))[:500]},
                "last_at": row["created_at"] if row else None, "iteration": row["iteration"] if row else None}

    def _add(self, issues, kind, item, row, key=None, count=1):
        key = key or (kind, _skill(item.get("command")))
        if key in issues:
            issues[key]["count"] += count
        else:
            issues[key] = self._issue(kind, item, row, count)

    def overview(self, swarm_id=None):
        agents = [a for a in self.hive.agents() if not swarm_id or a.get("swarm_id") == swarm_id]
        minds = [self.mind(a) for a in agents]
        totals = {s: sum(1 for m in minds if m["health"] == s) for s in ("high", "medium", "low", "ok")}
        minds.sort(key=lambda m: (-SEVERITY_RANK.get(m["health"], -1), m["name"]))
        return {"minds": minds, "totals": totals, "kinds": {k: {"severity": v[0], "meaning": v[1], "hint": v[2]} for k, v in KINDS.items()}}

    # ---- the health mind (R8) -------------------------------------------------------------------
    # One mind may be named the hive's health mind: it is told of every alert and may read the health overview.
    # The hive's own checks (alerts, the Health page) stay outside it, so a failed health mind is still noticed.

    def _mind_file(self):
        return self.hive.settings.data_dir / "health-mind.json"

    def mind_id(self):
        try:
            return json.loads(self._mind_file().read_text()).get("agent_id")
        except (OSError, ValueError):
            return None

    def set_mind(self, agent_id, by):
        if agent_id:
            self.hive.agent(agent_id)
        self._mind_file().write_text(json.dumps({"agent_id": agent_id or None, "set_by": by, "at": time.time()}))
        return {"agent_id": agent_id or None}

    async def deliver(self):
        """Tell the health mind about alerts raised since the last pass."""
        mind, batch, self.pending = self.mind_id(), self.pending, []
        if not mind:
            return 0
        for a in batch:
            text = (f"[HEALTH-ALERT] {a['name']} ({a['agent_id']}): {a['kind']} at {a['skill']}, {a['count']}x. "
                    f"Last result: {a['result'][:200]}. Suggested: {a['hint']} "
                    "Investigate with hive-health; propose a fix to the people running this hive; never act outside your gates.")
            await self.hive.send_to_agent(mind, text, sender=HEALTH_SENDER, extra={"event": "health_alert", "about": a["agent_id"]})
        return len(batch)

    # ---- live check ----------------------------------------------------------------------------

    def check_unconnected(self):
        """Each reconcile pass: a mind started more than UNCONNECTED_S ago that has not joined the hub raises one alert
        per start (no traces exist to trigger on_trace: the mind never got as far as running a command)."""
        # compared by time, never as text (Kimi idle-minds r2 #4); a start with no stamp is left out, as before
        rows = [r for r in self.db.all("SELECT id, name, last_active_at FROM agents WHERE deleted = 0 AND status = 'starting' "
                                       "AND last_active_at IS NOT NULL")
                if (_ago(r["last_active_at"]) or 0) > self.UNCONNECTED_S]
        raised = []
        for row in rows:
            key = (row["id"], "unconnected:" + (row["last_active_at"] or ""))
            if key in self.alerted:
                continue
            self.alerted[key] = time.time()
            alert = {"agent_id": row["id"], "name": row["name"], "kind": "unconnected", "severity": "high", "count": 1,
                     "skill": "?", "result": f"starting since {row['last_active_at']}", "hint": KINDS["unconnected"][2]}
            self.hive.events.publish("health.alert", alert=alert)
            if self.mind_id() and alert["agent_id"] != self.mind_id():
                self.pending.append(alert)
            raised.append(alert)
        return raised

    def on_trace(self, agent, trace):
        """After each trace: if a failure has now repeated, raise one alert for it (then stay quiet a while)."""
        commands = [c for c in trace.get("commands", []) if classify(c.get("command"), c.get("result")) not in (None, "waiting", "stale")]
        if not commands:
            return None
        rows = self.db.all("SELECT commands FROM traces WHERE agent_id = ? ORDER BY id DESC LIMIT ?", (agent["id"], self.WINDOW))
        seen = {}
        for row in rows:
            for item in json.loads(row["commands"] or "[]"):
                if classify(item.get("command"), item.get("result")) not in (None, "waiting", "stale"):
                    sig = signature(item.get("command"), item.get("result"))
                    seen[sig] = seen.get(sig, 0) + 1
        for c in commands:
            sig = signature(c.get("command"), c.get("result"))
            kind = classify(c.get("command"), c.get("result"))
            repeated = seen.get(sig, 0) >= self.REPEAT
            if not repeated and kind not in ("budget", "crash"):
                continue
            last = self.alerted.get((agent["id"], sig), 0)
            if time.time() - last < self.ALERT_QUIET_S:
                continue
            self.alerted[(agent["id"], sig)] = time.time()
            alert = {"agent_id": agent["id"], "name": agent["name"], "kind": "loop" if repeated else kind,
                     "severity": "high", "count": seen.get(sig, 1), "skill": _skill(c.get("command")),
                     "result": str(c.get("result", ""))[:300], "hint": KINDS["loop" if repeated else kind][2]}
            self.hive.events.publish("health.alert", alert=alert)
            if self.mind_id() and alert["agent_id"] != self.mind_id():
                self.pending.append(alert)   # delivered to the health mind on the next reconcile pass
            return alert
        return None


# ---- idle minds: the hive noticing itself (owner 2026-10-10) -----------------------------------------------------------
# "Health should notice an idle mind and take action to either tell it to sleep, or remind it of a task it owes" and
# "The hive is supposed to monitor itself right - rather than strict rules for free minds". So nothing here limits a
# mind: Health notices (model spend with no input, owed goals without a heartbeat, messages left unanswered), asks the
# mind ONE question through the normal message path, and records the question and the answer. The mind decides. The
# only hard limits stay the budgets and spend caps people set; an owner's idle_sleep_minutes stays the owner's choice.

def _since_text(stamp):
    moment = parse_stamp(stamp)
    return moment.strftime("%Y-%m-%d %H:%M") + " UTC" if moment else "an unknown time"


def _ago(stamp):
    """Seconds since a stamp (parsed, never compared as text: Kimi r1 K5/K7), or None when it does not parse."""
    moment = parse_stamp(stamp)
    return (datetime.datetime.now(datetime.timezone.utc) - moment).total_seconds() if moment else None


def _after(a, b):
    """Whether stamp a is later than stamp b, by time; False when either does not parse."""
    ma, mb = parse_stamp(a), parse_stamp(b)
    return bool(ma and mb and ma > mb)


class IdleWatch:
    NOTICE_S = 3600             # an hour awake with no input (spending or silent), or owed work this long without a heartbeat
    OWED_MESSAGE_CANDIDATES = 50   # unanswered messages read per pass per mind (oldest first; one owed item per conversation)
    ASK_QUIET_S = 6 * 3600      # Health asks a mind on its own at most once in this long (and once per idle stretch)
    DAY_S = 86400               # the window the spend and call counts cover
    UNANSWERED_S = 7 * 86400    # messages older than this are history, not owed
    PASS_S = 60                 # the reconcile loop runs the pass at most this often
    REMIND_QUIET_S = 60         # a person's Remind twice within this long is one question (double clicks)

    def __init__(self, health):
        self.health = health
        self.hive = health.hive
        self.db = health.db
        self._last_pass = 0.0

    # ---- what Health sees ------------------------------------------------------------------------------------------

    @staticmethod
    def last_input(row):
        """The idle signal: real input or own action (last_input_at; a start or own action on last_active_at)."""
        return latest_stamp(row.get("last_input_at"), row.get("last_active_at")) or row.get("created_at")

    def owed(self, row):
        """What this mind owes, oldest first: goals it holds with no heartbeat for NOTICE_S, open goals assigned to
        it that long, and messages from a person or mind that long without a reply in their conversation."""
        cutoff, items = _stamp_ago(self.NOTICE_S), []
        for g in self.db.all("SELECT id, title, status, updated_at FROM goals WHERE claimed_by = ? "
                             "AND status IN ('claimed', 'waiting') AND updated_at < ? ORDER BY updated_at", (row["id"], cutoff)):
            items.append({"type": "goal", "goal_id": g["id"], "title": g["title"], "goal_status": g["status"],
                          "since": g["updated_at"]})
        for g in self.db.all("SELECT id, title, updated_at FROM goals WHERE assignee = ? AND status = 'open' "
                             "AND updated_at < ? ORDER BY updated_at", (row["id"], cutoff)):
            items.append({"type": "assigned_goal", "goal_id": g["id"], "title": g["title"], "goal_status": "open",
                          "since": g["updated_at"]})
        # one owed reply per conversation, from its oldest unanswered message; Coffee Room and team-room talk is not
        # necessarily addressed to this mind. Both are decided before the cap, so older room talk or one busy
        # conversation can never crowd an unanswered direct message out of it (stand-in idle-minds r2 P2).
        rows = self.db.all(
            "SELECT id, conversation_id, sender, created_at FROM ("
            "SELECT m.id, m.conversation_id, m.sender, m.created_at, ROW_NUMBER() OVER "
            "(PARTITION BY m.conversation_id ORDER BY m.created_at, m.rowid) AS nth FROM messages m WHERE m.agent_id = ? "
            "AND m.direction = 'in' AND (m.sender LIKE 'user:%' OR m.sender LIKE 'agent:%') AND m.text != '' "
            "AND m.conversation_id NOT LIKE 'ask:%' AND m.created_at < ? AND m.created_at > ? "
            "AND NOT EXISTS (SELECT 1 FROM rooms r WHERE (r.id = m.conversation_id OR r.alias = m.conversation_id) "
            "AND (r.kind = ? OR (r.archived = 0 AND r.swarm_id IS NOT NULL AND r.swarm_id != '' "
            "AND r.alias = ? || r.swarm_id))) "
            "AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.agent_id = m.agent_id AND o.direction = 'out' "
            "AND o.conversation_id = m.conversation_id AND o.created_at >= m.created_at)"
            ") WHERE nth = 1 ORDER BY created_at LIMIT ?",
            (row["id"], cutoff, _stamp_ago(self.UNANSWERED_S), ROOM_COFFEE, ROOM_TEAM, self.OWED_MESSAGE_CANDIDATES))
        for m in rows:
            items.append({"type": "message", "message_id": m["id"], "conversation_id": m["conversation_id"],
                          "from": m["sender"], "from_name": self.hive.sender_name(m["sender"]), "since": m["created_at"]})
        floor = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
        return sorted(items, key=lambda i: parse_stamp(i["since"]) or floor)

    def facts(self, row):
        last = self.last_input(row)
        quiet_s = _ago(last)
        # the spend window: since the later of the last input and a day ago, by time, written in the store's stamp
        # format (usage rows are stamped by db.now(), so the SQL text comparison is a time comparison)
        day_ago = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=self.DAY_S)
        seen = parse_stamp(last)
        since = stamp_of(max(seen, day_ago) if seen else day_ago)
        u = self.db.one("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM usage "
                        "WHERE agent_id = ? AND created_at > ?", (row["id"], since))
        awake = row.get("status") == "awake"
        owed = self.owed(row) if awake else []
        quiet = awake and quiet_s is not None and quiet_s > self.NOTICE_S
        # Two signals, neither a limit: model calls with no input (spend), and, for a mind that has stopped spending
        # (one answering only `wait`), awake with no input and no output at all for NOTICE_S (Kimi r1: the cheaper the
        # wait, the less a stuck mind shows on spend; this is the non-cost signal).
        kind = "owed" if owed else ("idle" if quiet and u["n"] else ("silent" if quiet else None))
        hours = min(self.DAY_S, quiet_s) / 3600 if quiet_s is not None and quiet_s > 0 else 0.0
        return {"last_input_at": last, "idle_calls_24h": int(u["n"]), "idle_spend_24h": round(float(u["usd"]), 6),
                "idle_hours": round(hours, 2), "owed": owed, "kind": kind}

    @staticmethod
    def question(facts):
        """The one question Health asks. Owed work first; otherwise the spend with no input; otherwise the silence."""
        owed = facts["owed"]
        if owed:
            first, more = owed[0], len(owed) - 1
            if first["type"] == "goal":
                text = f'You hold task "{first["title"]}" ({first["goal_id"]}) since {_since_text(first["since"])}: finish, hand off or release it?'
            elif first["type"] == "assigned_goal":
                text = (f'Task "{first["title"]}" ({first["goal_id"]}) is assigned to you and open since '
                        f'{_since_text(first["since"])}: claim it, hand it off or release it?')
            else:
                who = first.get("from_name") or first["from"]
                text = f"{who} wrote to you at {_since_text(first['since'])} and has no reply yet: answer, or say what you are waiting for?"
            return text + (f" ({more} more owed.)" if more > 0 else "")
        hours = facts["idle_hours"]
        if facts["idle_calls_24h"] or facts["kind"] == "idle":
            span = f"{hours:.1f} hours" if hours < 24 else "the last 24 hours"
            return f"You've spent ${facts['idle_spend_24h']:.2f} over {span} with no input: sleep, or tell me what you're waiting for?"
        span = f"{hours:.1f} hours" if hours < 24 else "more than 24 hours"
        return f"You've been awake {span} with no input and no output: sleep, or tell me what you're waiting for?"

    # ---- the record ----------------------------------------------------------------------------------------------

    def _latest(self, agent_id):
        return self.db.one("SELECT * FROM health_idle WHERE agent_id = ? ORDER BY asked_at DESC, rowid DESC LIMIT 1", (agent_id,))

    def _open(self, agent_id):
        return self.db.one("SELECT * FROM health_idle WHERE agent_id = ? AND status = 'asked' ORDER BY asked_at DESC LIMIT 1",
                           (agent_id,))

    def close_settled(self):
        """Open questions whose mind is no longer awake end as 'slept'; those the mind has had input since end as
        'resolved' (an answer in the question's conversation is recorded as 'replied' when it arrives)."""
        for q in self.db.all("SELECT h.id, h.asked_at, a.status, a.deleted, a.last_input_at, a.last_active_at, a.created_at "
                             "FROM health_idle h LEFT JOIN agents a ON a.id = h.agent_id WHERE h.status = 'asked'"):
            if q["status"] is None or q["deleted"] or q["status"] not in ("awake", "starting"):
                self.db.execute("UPDATE health_idle SET status = 'slept', closed_at = ? WHERE id = ? AND status = 'asked'",
                                (now(), q["id"]))
            elif _after(self.last_input(q), q["asked_at"]):
                self.db.execute("UPDATE health_idle SET status = 'resolved', closed_at = ? WHERE id = ? AND status = 'asked'",
                                (now(), q["id"]))

    def on_mind_message(self, agent_id, message):
        """A message from the mind in the conversation of its open Health question is its answer."""
        q = self._open(agent_id)
        if q is None or (q.get("conversation_id") and message.get("conversation_id") != q["conversation_id"]):
            return None
        self.db.execute("UPDATE health_idle SET status = 'replied', reply = ?, replied_at = ?, reply_message_id = ?, "
                        "closed_at = ? WHERE id = ? AND status = 'asked'",
                        (str(message.get("text") or "")[:4000], message["created_at"], message["id"], message["created_at"], q["id"]))
        return q["id"]

    def conversation(self, row):
        """Where Health's question goes. A personal mind's: its person's own conversation with it, c_<mind>~<person>
        (stand-in r1 P1: never c_<mind>, whose DM room belongs to user:operator; no room is made or extended). Any other
        mind's: c_<mind>, where every hive note to a mind goes (goal, review, alert, schedule notes), mirrored to its DM
        room with the operator, as those notes are; the text is kept out of other people's transcripts (hive.py)."""
        person = row.get("personal_of")
        return self.hive.person_conversation(row["id"], person) if person else f"c_{row['id']}"

    async def ask(self, row, by, facts=None):
        """Ask the mind its one question now, through the normal message path, and record it."""
        facts = facts or self.facts(row)
        text = self.question(facts)
        at, qid = now(), new_id("hq")
        conversation = self.conversation(row)
        with self.db.transaction():
            # a person's Remind replaces an open question (one open question per mind, ever)
            self.db.execute("UPDATE health_idle SET status = 'superseded', closed_at = ? WHERE agent_id = ? AND status = 'asked'",
                            (at, row["id"]))
            self.db.insert("health_idle", {
                "id": qid, "agent_id": row["id"], "kind": facts["kind"] or ("owed" if facts["owed"] else "idle"),
                "owed": json.dumps(facts["owed"][:20]), "observed_at": at, "last_noticed_at": at,
                "last_input_at": facts["last_input_at"], "idle_calls": facts["idle_calls_24h"],
                "idle_spend_usd": facts["idle_spend_24h"], "question": text, "asked_at": at, "asked_by": by,
                "conversation_id": conversation, "status": "asked"})
        try:
            sent = await self.hive.send_to_agent(row["id"], f"[HEALTH-QUESTION {qid}] {text}", conversation_id=conversation,
                                                 sender=HEALTH_SENDER,
                                                 extra={"event": HEALTH_QUESTION, "question_id": qid})
        except Exception:
            self.db.execute("UPDATE health_idle SET status = 'unsent', closed_at = ? WHERE id = ?", (now(), qid))
            raise
        self.db.execute("UPDATE health_idle SET message_id = ? WHERE id = ?", (sent.get("id"), qid))
        return qid

    async def run(self, force=False):
        """One idle pass (the reconcile loop's, at most every PASS_S): settle open questions, then for each awake mind
        Health notices, ask once, never again while that question is open, never twice in one idle stretch (no input
        since the last question), and never more often than ASK_QUIET_S on its own."""
        if not force and time.monotonic() - self._last_pass < self.PASS_S:
            return []
        self._last_pass = time.monotonic()
        self.close_settled()
        asked = []
        for row in self.db.all("SELECT * FROM agents WHERE deleted = 0 AND status = 'awake'"):
            try:
                facts = self.facts(row)
                if not facts["kind"]:
                    continue
                q = self._open(row["id"])
                if q is not None:
                    self.db.execute("UPDATE health_idle SET last_noticed_at = ?, idle_calls = ?, idle_spend_usd = ? WHERE id = ?",
                                    (now(), facts["idle_calls_24h"], facts["idle_spend_24h"], q["id"]))
                    continue
                latest = self._latest(row["id"])
                if latest and facts["last_input_at"] and _after(latest["asked_at"], facts["last_input_at"]):
                    continue                    # already asked in this idle stretch: the owner sees it; a person may Remind
                auto = self.db.one("SELECT MAX(asked_at) AS at FROM health_idle WHERE agent_id = ? AND asked_by = ?",
                                   (row["id"], HEALTH_SENDER))
                if auto and auto["at"] and (_ago(auto["at"]) is None or _ago(auto["at"]) < self.ASK_QUIET_S):
                    continue
                asked.append(await self.ask(row, HEALTH_SENDER, facts))
            except Exception:
                log.exception("health idle pass failed for %s", row["id"])
        return asked

    async def remind(self, agent_id, by):
        """A person's Remind: the Health question, now (one per REMIND_QUIET_S, so a double click is one question)."""
        row = self.hive._agent_row(agent_id)
        q = self._open(agent_id)
        if q is not None and (_ago(q["asked_at"]) is None or _ago(q["asked_at"]) < self.REMIND_QUIET_S):
            return q["id"]
        return await self.ask(row, by)

    # ---- views (hive/core/app.py routes; shapes in PLATFORM_IDLE_MINDS_R1_SHAPES.md) -----

    def view(self, row, history=False):
        facts = self.facts(row)
        last = self._latest(row["id"])
        if last and last["status"] == "asked":
            status = "asked"
        elif facts["kind"]:
            status = "noticed"
        else:
            status = last["status"] if last else "quiet"
        out = {"id": row["id"], "agent_id": row["id"], "name": row["name"], "swarm_id": row.get("swarm_id"),
               "mind_status": row.get("status"), "personal": bool(row.get("personal_of")),
               "idle_calls_24h": facts["idle_calls_24h"], "idle_spend_24h": facts["idle_spend_24h"],
               "last_input_at": facts["last_input_at"], "noticed": bool(facts["kind"]), "kind": facts["kind"],
               "owed": facts["owed"][:20], "idle_sleep_minutes": row.get("idle_sleep_minutes") or 0,
               "question_id": last["id"] if last else None, "question": last["question"] if last else None,
               "question_at": last["asked_at"] if last else None, "question_by": last["asked_by"] if last else None,
               "reply": last["reply"] if last else None, "reply_at": last["replied_at"] if last else None,
               "status": status,
               "actions": {"remind": row.get("status") == "awake", "sleep": row.get("status") == "awake"}}
        if history:
            out["history"] = [self._record(r) for r in self.db.all(
                "SELECT * FROM health_idle WHERE agent_id = ? ORDER BY asked_at DESC, rowid DESC LIMIT 20", (row["id"],))]
        return out

    @staticmethod
    def _record(r):
        return {"question_id": r["id"], "kind": r["kind"], "owed": json.loads(r["owed"] or "[]"),
                "observed_at": r["observed_at"], "last_noticed_at": r["last_noticed_at"], "last_input_at": r["last_input_at"],
                "idle_calls_24h": r["idle_calls"], "idle_spend_24h": r["idle_spend_usd"], "question": r["question"],
                "question_at": r["asked_at"], "question_by": r["asked_by"], "reply": r["reply"], "reply_at": r["replied_at"],
                "status": r["status"], "closed_at": r["closed_at"]}

    def overview(self):
        """Every awake mind, and every mind with a Health question in the last week, worst first (app.py filters)."""
        week = _stamp_ago(7 * 86400)
        rows = self.db.all("SELECT * FROM agents WHERE deleted = 0 AND (status = 'awake' OR id IN "
                           "(SELECT agent_id FROM health_idle WHERE asked_at > ?))", (week,))
        minds = [self.view(r) for r in rows]
        rank = {"asked": 0, "noticed": 1, "replied": 2, "resolved": 3, "slept": 3, "superseded": 3, "unsent": 1, "quiet": 4}
        minds.sort(key=lambda m: (rank.get(m["status"], 4), -m["idle_spend_24h"], m["name"]))
        return minds
