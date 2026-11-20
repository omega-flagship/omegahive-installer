# Purpose: swarm goals: posting, claiming and leases, the results minds finish them with, and the one reader of a
# finished goal's structured result.
"""Swarm goals: posted by people or minds, claimed and finished by minds.

Anti-drift rules (docs/omegadots/DRIFT.md):
- A claim is a lease.  The claimer renews it with a heartbeat; when it lapses
  the goal goes back to the swarm, and after MAX_ATTEMPTS lapses it is
  ``stalled`` until a person looks at it, instead of being re-tried forever.
- ``waiting`` means "delivered, waiting on a person": not failing, so the
  claimer does not keep re-sending, and its lease is paused.
- ``done`` needs a result that says what was done.
- Splitting is bounded in depth and fan-out, so one goal cannot spawn an
  unbounded tree of subgoals.
"""

from __future__ import annotations

import datetime
import hashlib
import inspect
import json
import sqlite3

from .db import new_id, now
from .result_schema import SchemaError, check_schema, validate as validate_result

STATUSES = {"open", "claimed", "waiting", "stalled", "submitted", "done", "failed", "cancelled"}
# Where a status change may not go from: a finished goal stays finished (a retry of a failed goal is a fresh start).
TERMINAL_NEXT = {"done": set(), "cancelled": set(), "failed": {"open"}}
UNFINISHED = ("open", "claimed", "waiting", "stalled", "submitted")
# No answer comes from a goal in these without a person: it failed, was cancelled, or stalled (its claims lapsed
# MAX_ATTEMPTS times with no result). Whoever waits on its answer ends the wait here, never at an update that may
# not come: a Create builder that claimed its goal and went quiet left its plan writing with no error.
UNANSWERED = ("failed", "cancelled", "stalled")
MAX_RETURNS = 3   # a reviewer may send work back this many times; then the goal fails rather than loop
MAX_ATTEMPTS = 3
MAX_DEPTH = 4
MAX_CHILDREN = 12
MAX_BINDING_BYTES = 16 * 1024
MAX_RESULT_DATA_BYTES = 256 * 1024
MAX_DETAIL_CHARS = 4000   # a task's stored detail
BINDING_KEYS = ("request_id", "base_revision", "snapshot_digest")
# What continue_goal writes into a follow-up's binding: the completed task it continues and the result checks it
# inherits. A binding of these keys alone ties its task to no request, snapshot, share or session.
CONTINUATION_KEYS = frozenset({"continued_from", "review", "result_schema", "validate", "from_swarm", "review_request_id"})

WORK_SQL = "COALESCE(json_extract(binding, '$.kind'), '') != 'ask.thread'"

STOP_CAUSES = {
    "failed": "This task could not be finished.",
    "stalled": "This task stopped making progress and needs attention.",
    "deadline": "The time allowed for this task ended before a result arrived.",
    "leases": "This task was picked up repeatedly, but no result arrived before each claim expired.",
    "review": "The reviewer returned this task repeatedly, so work stopped.",
    "research_start": "No researcher could be started for this task.",
    "replies": "This task's mind stopped answering.",
    "marked_failed": "This task was marked as failed. No further reason was recorded.",
    "marked_stalled": "This task was marked as stalled. No further reason was recorded.",
}


def binding_digest(binding):
    """A stable digest of a goal's binding, so a proposal can prove which request it answers."""
    return "sha256:" + hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def continuation_only(binding):
    """True for a binding continue_goal wrote. result() applies the checks it carries to every result itself, so a
    result for such a task may come without an echo of the binding: a mind's plain hive-goal-done sends none."""
    return bool(binding.get("continued_from")) and set(binding) <= CONTINUATION_KEYS


def proposal_of(data):
    """The structured result in a goal's result data: data["proposal"] when there is one, else the data as stored.
    A mind's hive-goal-propose stores {"binding_digest": ..., "proposal": {...}} (modules/hive/src/hive_commons.py
    goal_propose), the MCP hive-goal-done stores {"proposal": ...} (mcp.py) and text that is not JSON is kept as
    {"proposal": {"text": ...}} (_check_result); a direct API call stores its object as given. The result schema and
    the app validator judge this object, so whoever reads the result reads the object that was judged."""
    return data["proposal"] if isinstance(data, dict) and "proposal" in data else data


def stored_proposal(goal):
    """A finished goal's structured result as an object, read from its stored result data and never its result text:
    proposal_of the stored data when that is a JSON object, else {} (no data, invalid JSON, a list or a string)."""
    try:
        proposal = proposal_of(json.loads(goal["result_data"])) if goal.get("result_data") else {}
    except ValueError:
        return {}
    return proposal if isinstance(proposal, dict) else {}


def _later(minutes):
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


REVIEWS_SCHEMA = """CREATE TABLE IF NOT EXISTS goal_reviews (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, at TEXT NOT NULL,
  by TEXT NOT NULL, action TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', result_digest TEXT)"""
ATTEMPTS_SCHEMA = """CREATE TABLE IF NOT EXISTS goal_attempts (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  at TEXT NOT NULL, ok INTEGER NOT NULL, errors TEXT NOT NULL, raw TEXT NOT NULL, digest TEXT NOT NULL)"""
FILES_SCHEMA = """CREATE TABLE IF NOT EXISTS goal_files (goal_id TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL,
  agent_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (goal_id, path))"""
# A goal's staged files (Goals.stage_file) last only while something may still read them. Whichever path changes the
# goal's row, this trigger deletes them when its claim passes or ends (a new claimer, a release), when it fails or is
# cancelled, and when it is done with no Create plan to take its answer; a Create plan's taker deletes them once it has
# finished with the goal (Goals.drop_staged). Before, nothing deleted them, and a goal claimed again handed its new
# claimer's answer the old claim's files as well, since the takers read every file staged on the goal.
FILES_END_TRIGGER = """CREATE TRIGGER IF NOT EXISTS goal_files_end AFTER UPDATE OF status, claimed_by ON goals
  WHEN NEW.claimed_by IS NOT OLD.claimed_by OR (NEW.status IS NOT OLD.status AND (NEW.status IN ('failed', 'cancelled')
    OR (NEW.status = 'done' AND NEW.created_by NOT LIKE 'create-plan:%')))
  BEGIN DELETE FROM goal_files WHERE goal_id = NEW.id; END"""
# A task's own budget (Goals.give_step_budget): kept beside the goal, not in its binding, which a bound task's result
# must echo. spent_at_start is started_by's stored spend at its claim, both NULL until a mind claims the task; the
# budget applies (check_budget), and the goal list gives it as step_budget_usd, only while started_by holds the task.
BUDGETS_SCHEMA = """CREATE TABLE IF NOT EXISTS goal_budgets (goal_id TEXT PRIMARY KEY, budget_usd REAL NOT NULL,
  spent_at_start REAL, started_by TEXT)"""
# The least a Create step may spend: the most one step spent in the Make runs of 19 Nov was 0.69 USD (a test author
# writing its check eight times), and a tenth of a fresh hive's day (0.50) or the 0.25 floor of a 2 USD test hive would
# have held that step and others like it.
STEP_BUDGET_FLOOR_USD = 1.0
# The most files one goal may hold staged: twice the 20 a Create piece may own, so a piece's files and its rewrites fit.
MAX_STAGED_FILES = 40


class Goals:
    def __init__(self, hive):
        self.hive = hive
        self.db = hive.db
        self.db.execute(ATTEMPTS_SCHEMA)
        self.db.execute(FILES_SCHEMA)
        self.db.execute(FILES_END_TRIGGER)
        self.db.execute(REVIEWS_SCHEMA)
        self.db.execute(BUDGETS_SCHEMA)
        self.db.execute("CREATE INDEX IF NOT EXISTS goal_attempts_goal ON goal_attempts(goal_id, at)")
        self.db.execute("""CREATE TABLE IF NOT EXISTS goal_stops (
            id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, principal TEXT NOT NULL, mind_id TEXT,
            title TEXT NOT NULL, status TEXT NOT NULL, cause TEXT NOT NULL, reason TEXT NOT NULL,
            stopped_at TEXT NOT NULL, acknowledged_at TEXT)""")
        self.db.execute("CREATE INDEX IF NOT EXISTS goal_stops_person ON goal_stops(principal, acknowledged_at)")

    @staticmethod
    def is_ask_thread(goal):
        binding = goal.get("binding")
        if isinstance(binding, str):
            binding = json.loads(binding)
        return isinstance(binding, dict) and binding.get("kind") == "ask.thread"

    def record_stop(self, goal_id, cause=None, detail=None):
        """Keep the person's receipt with the transition, without sending a message to the mind."""
        goal = self.get(goal_id)
        if goal["status"] not in ("failed", "stalled") or self.is_ask_thread(goal):
            return
        principal = goal["created_by"]
        if principal.startswith("request:"):
            request = self.db.one("SELECT from_principal FROM requests WHERE id = ?", (principal[8:],))
            principal = request["from_principal"] if request else ""
        if not principal.startswith("user:"):
            return
        cause = cause or goal["status"]
        reason = STOP_CAUSES[cause]
        detail = str(goal.get("result") or "" if detail is None else detail).strip()
        if detail:
            reason += " " + detail[:4000]
        self.db.execute("INSERT INTO goal_stops "
                        "(id, goal_id, principal, mind_id, title, status, cause, reason, stopped_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_id("gs"), goal_id, principal, goal.get("claimed_by") or goal.get("assignee"),
                         goal["title"], goal["status"], cause, reason, goal["updated_at"]))

    def stop(self, goal_id, status, cause, detail="", *, emit=True, expected=None, **values):
        """A host stop and its durable person receipt commit together."""
        with self.db.transaction():
            current = self.get(goal_id)
            if expected is not None and any(current[key] != expected[key] for key in ("status", "updated_at")):
                return None
            self.db.update("goals", goal_id, {**values, "status": status, "result": detail or STOP_CAUSES[cause],
                                             "lease_until": None, "updated_at": now()})
            self.record_stop(goal_id, cause, detail)
        return self._emit(goal_id) if emit else self.view(self.get(goal_id))

    def stop_held(self, agent_id, cause, detail):
        """End every work goal a mind holds and is working on (claimed) as failed, with the host's cause and words, one
        stop each. A mind whose runtime rests after its replies kept being refused (Hive.record_trace) still holds them
        under a lease its live loop renews, so whoever waits on one, a Create plan step or a Code repair, would wait
        with nothing said; failed is how the hive already ends a goal it judges won't finish (a lapsed deadline, too
        many review returns), and its result is the detail goal_ended passes on as goal_reason. A goal waiting on a
        person and the Ask's own conversation stay as they are. Time: one select and one stop per held goal."""
        stopped = []
        for goal in self.db.all(f"SELECT * FROM goals WHERE claimed_by = ? AND status = 'claimed' AND {WORK_SQL}",
                                (agent_id,)):
            if self.stop(goal["id"], "failed", cause, detail, expected=goal) is not None:
                stopped.append(goal["id"])
        return stopped

    # ---- a task's own budget: a step the hive hands a mind spends at most this, whatever its turns ------------------

    def give_step_budget(self, goal_id, agent_id):
        """Give a task handed to this mind (a Create plan's step) its own budget: Budgets.task_budget, what a work session
        given none may spend, and at least STEP_BUDGET_FLOOR_USD. A mind holding a goal with its own budget gets its
        turns back while it holds it (hive_helpers.held_goal reads step_budget_usd from list), so a builder whose tool
        calls keep failing would otherwise spend on until a limit for the whole hive or mind stopped it. The budget
        starts when a mind claims the task (_start_budget); the mind's own limits and the hive's still apply to every
        call."""
        budget = max(self.hive.budgets.task_budget(self.hive.agent(agent_id)), STEP_BUDGET_FLOOR_USD)
        self.db.execute("INSERT INTO goal_budgets (goal_id, budget_usd) VALUES (?, ?) "
                        "ON CONFLICT(goal_id) DO UPDATE SET budget_usd = excluded.budget_usd", (goal_id, float(budget)))
        return budget

    def _start_budget(self, agent_id, goal_id):
        """A task's budget counts from its holder's claim: the claimer's stored spend then. The same mind claiming it
        again (after its lease lapsed) keeps its start, so it cannot begin the budget afresh; another mind claiming it
        (its first holder deleted, or that holder's lease lapsed) starts from its own spend, which the first holder's
        start does not measure. Spend before the claim (another task's, the packet's reading) is not the task's."""
        self.db.execute("UPDATE goal_budgets SET spent_at_start = (SELECT COALESCE(spent_usd, 0) FROM agents WHERE id = ?), "
                        "started_by = ? WHERE goal_id = ? AND started_by IS NOT ?", (agent_id, agent_id, goal_id, agent_id))

    def check_budget(self, agent, estimate):
        """Refuse a paid call once a task the mind holds has spent its budget (give_step_budget, started at this mind's
        claim): what the mind has spent since the claim, counted as a work session counts it (the mind's stored spend,
        since calls cannot be told apart by task). The call's worst case is not added: real Create calls reserve up to 1.34
        USD and settle near 0.15 at most, so a worst-case check held steps far below their budget; the step can pass
        it by one call. Holding several, the first one spent refuses. The refusal names the task (scope task:<id>, as
        agent:<id> and swarm:<id> name theirs, in the hive's word for the work, test_host_wording), so
        note_refusal keeps the mind held for spending and a Create plan waiting on it says so. Time: one join of the
        mind's held, started budgets per paid call. estimate stays for the refusal's words."""
        rows = self.db.all("SELECT g.id, b.budget_usd, b.spent_at_start FROM goal_budgets b JOIN goals g ON g.id = b.goal_id "
                           "WHERE g.claimed_by = ? AND b.started_by = g.claimed_by AND g.status IN ('claimed', 'waiting')",
                           (agent["id"],))
        if not rows:
            return
        spent_now = float(self.hive._agent_row(agent["id"])["spent_usd"] or 0)
        for row in rows:
            budget = float(row["budget_usd"])
            spent = max(0.0, spent_now - float(row["spent_at_start"]))
            if spent >= budget:
                raise self.hive.error(402, "spend_limit",
                                      f"{agent['name']} has spent ${spent:.2f} of the ${budget:.2f} its task allows; "
                                      f"this call could cost up to ${estimate:.4f}",
                                      {"scope": f"task:{row['id']}", "period": "total", "limit_usd": budget,
                                       "spent_usd": round(spent, 6)})

    # ---- result schemas: the shape a result must have before the goal is done (hive/core/result_schema.py) ----

    def result_schema(self, goal):
        """The goal's own binding.result_schema, else its request's constraints.result_schema, else None."""
        binding = json.loads(goal["binding"]) if goal.get("binding") else {}
        if isinstance(binding.get("result_schema"), dict):
            return binding["result_schema"]
        if binding.get("request_id"):
            req = self.db.one("SELECT constraints FROM requests WHERE id = ?", (binding["request_id"],))
            constraints = json.loads(req["constraints"]) if req and req.get("constraints") else {}
            if isinstance(constraints.get("result_schema"), dict):
                return constraints["result_schema"]
        return None

    def attempts(self, goal_id):
        self.get(goal_id)
        rows = self.db.all("SELECT * FROM goal_attempts WHERE goal_id = ? ORDER BY at, rowid", (goal_id,))
        return [{**r, "ok": bool(r["ok"]), "errors": json.loads(r["errors"])} for r in rows]

    def stage_file(self, agent, goal_id, path, text):
        """One whole file staged on a goal the mind holds and is working on (hive-goal-file), for whoever takes the
        goal's answer: a Create piece's builder or test author writes each file as its own command, so a reply cut off
        at its room keeps the files it finished, where one JSON holding them all was lost whole. A path staged again
        keeps its last text. Refused: a goal the mind doesn't hold, a path that isn't a plain relative one, a file over
        MAX_RESULT_DATA_BYTES (the most result data a goal keeps), more than MAX_STAGED_FILES on one goal. Nothing is
        emitted: the goal's answer, when it comes, reads these (staged_files), and they go once nothing will read them
        (FILES_END_TRIGGER, drop_staged)."""
        goal = self.get(goal_id)
        self._fence(agent, goal)
        if goal["claimed_by"] != agent["id"] or goal["status"] != "claimed":
            raise self._unheld(agent, goal, 409, "not_claimed", "you do not hold this task")
        path = str(path or "").strip()
        if (not path or len(path) > 300 or path.startswith("/") or "\\" in path
                or any(part in ("", ".", "..") for part in path.split("/"))):
            raise self.hive.error(400, "bad_path", "a staged file's path is a plain relative path, such as app.js")
        text = "" if text is None else str(text)
        size = len(text.encode("utf-8"))
        if size > MAX_RESULT_DATA_BYTES:
            raise self.hive.error(413, "file_too_large", f"a staged file holds at most {MAX_RESULT_DATA_BYTES} bytes")
        with self.db.transaction():
            others = self.db.one("SELECT COUNT(*) AS n FROM goal_files WHERE goal_id = ? AND path != ?",
                                 (goal_id, path))["n"]
            if others >= MAX_STAGED_FILES:
                raise self.hive.error(409, "too_many_files", f"a task holds at most {MAX_STAGED_FILES} staged files")
            self.db.execute("INSERT INTO goal_files (goal_id, path, text, agent_id, at) VALUES (?, ?, ?, ?, ?) "
                            "ON CONFLICT(goal_id, path) DO UPDATE SET text = excluded.text, "
                            "agent_id = excluded.agent_id, at = excluded.at", (goal_id, path, text, agent["id"], now()))
        return {"goal_id": goal_id, "path": path, "bytes": size}

    def staged_files(self, goal_id):
        """The files staged on a goal (stage_file), {path: text}, for its answer's taker to read beside the answer."""
        return {r["path"]: r["text"] for r in self.db.all("SELECT path, text FROM goal_files WHERE goal_id = ? "
                                                         "ORDER BY path", (goal_id,))}

    def drop_staged(self, goal_id):
        """Delete the files staged on a goal, once the Create plan that takes its answer has finished with it: the plan
        engine once it journalled the goal's result, the code controller once its member step settled. Every other end
        of a goal deletes them in the goals table's own trigger (FILES_END_TRIGGER)."""
        self.db.execute("DELETE FROM goal_files WHERE goal_id = ?", (goal_id,))

    def _record_attempt(self, goal_id, agent_id, raw, errors):
        text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False, sort_keys=True)
        self.db.insert("goal_attempts", {"id": new_id("ga"), "goal_id": goal_id, "agent_id": agent_id, "at": now(),
                                         "ok": int(not errors), "errors": json.dumps(errors), "raw": text[:MAX_RESULT_DATA_BYTES],
                                         "digest": "sha256:" + hashlib.sha256(text.encode()).hexdigest()})

    def _check_result(self, goal, agent, data):
        """With a result schema, refuse a done result of the wrong shape (the goal stays claimed for repair)."""
        schema = self.result_schema(goal)
        data = data or {}
        if schema is None:
            if "proposal_text" in data:   # no schema: unparseable text is kept as text, as before
                data = {**{k: v for k, v in data.items() if k not in ("proposal_text", "parse_error")}, "proposal": {"text": data["proposal_text"]}}
            return data
        if "proposal_text" in data:
            raw, errors = data["proposal_text"], [f"$: not valid JSON ({data.get('parse_error') or 'could not parse'}); send the result as one JSON object"]
        elif "proposal" in data:
            raw = data["proposal"]
            errors = validate_result(raw, schema)
            if errors and isinstance(raw, dict) and set(raw) == {"text"} and "text" not in (schema.get("properties") or {}):
                errors.insert(0, "$: your result was plain text, not JSON; send one JSON object that fits the schema")
        else:
            raw, errors = data, ["$: no result object; finish with hive-goal-propose <task id> <JSON result>"]
        self._record_attempt(goal["id"], agent["id"], raw, errors)
        if errors:
            raise self.hive.error(422, "result_invalid",
                                  f"result does not fit this task's result schema ({len(errors)} problem(s)): " + "; ".join(errors)
                                  + ". The task is still yours: fix these and propose again.", {"errors": errors})
        return {k: v for k, v in data.items() if k != "parse_error"}

    # ---- R17: an app's own rule check, then a reviewer marks it done ------------------------------------

    def _bound(self, goal, key):
        """A goal's own binding[key], else its request's constraints[key]."""
        binding = json.loads(goal["binding"]) if goal.get("binding") else {}
        if key in binding:
            return binding[key]
        if binding.get("request_id"):
            req = self.db.one("SELECT constraints, kind FROM requests WHERE id = ?", (binding["request_id"],))
            constraints = json.loads(req["constraints"]) if req and req.get("constraints") else {}
            if key in constraints:
                return constraints[key]
        return None

    def validator(self, goal):
        v = self._bound(goal, "validate")
        return v if isinstance(v, str) and v.startswith("program:") else None

    def review_spec(self, goal):
        """Who must accept this goal's result: none | requester | person | agent:<id> | mandate:<id>.
        Cross-swarm requests default to the requester (review requests finish through their own receipts)."""
        spec = self._bound(goal, "review")
        if isinstance(spec, dict):
            spec = spec.get("by")
        if spec in (None, ""):
            binding = json.loads(goal["binding"]) if goal.get("binding") else {}
            # only a real cross-swarm request (the hive wrote from_swarm into its binding), never an app's own request ids
            real = binding.get("from_swarm") and binding.get("request_id") and self.db.one("SELECT 1 FROM requests WHERE id = ?", (binding["request_id"],))
            return "requester" if real and binding.get("kind") != "review" else "none"
        spec = str(spec)
        if spec in ("none", "requester", "person") or spec.startswith(("agent:a_", "mandate:")):
            return spec
        return "person"   # an unknown spec never means "no review"

    async def _run_validator(self, goal, agent, raw):
        target = self.validator(goal)
        if not target:
            return []
        try:
            out = self.hive.programs.validate_goal_result(target[8:], self.view(goal), raw)
            if inspect.isawaitable(out):   # an app's validate_result may be async (r2.9)
                out = await out
        except Exception as exc:   # a missing or failing validator refuses completion; nothing private leaks
            return [f"$: the result could not be checked by {target} ({getattr(exc, 'message', type(exc).__name__)}); try again later"]
        return out

    def _record_review(self, goal_id, by, action, notes="", result_digest=None):
        self.db.insert("goal_reviews", {"id": new_id("gr"), "goal_id": goal_id, "at": now(), "by": by, "action": action,
                                        "notes": str(notes or "")[:4000], "result_digest": result_digest})

    def _notify_reviewer(self, goal):
        """Tell the reviewer that work is waiting (a named mind, or the requesting mind); people see it on the board."""
        spec = self.review_spec(goal)
        target = None
        if spec.startswith("agent:"):
            target = spec[6:]
        elif spec == "requester":
            binding = json.loads(goal["binding"]) if goal.get("binding") else {}
            request_id = binding.get("request_id") or binding.get("review_request_id")
            req = self.db.one("SELECT from_principal FROM requests WHERE id = ?", (request_id,)) if request_id else None
            if req and str(req["from_principal"]).startswith("agent:"):
                target = req["from_principal"][6:]
        if not target:
            return
        note = (f"[REVIEW-WAITING {goal['id']}] {goal['title']}: submitted for your review. Read it with hive-goal-get {goal['id']}, "
                f"then hive-goal-review {goal['id']} accept|return \"notes\". You may never review your own work.")
        try:
            import asyncio
            asyncio.get_running_loop().create_task(self.hive.send_to_agent(target, note, sender="hive:goals",
                                                                          extra={"event": "review_waiting", "goal_id": goal["id"]}))
        except RuntimeError:
            pass

    def reviews(self, goal_id):
        self.get(goal_id)
        return self.db.all("SELECT * FROM goal_reviews WHERE goal_id = ? ORDER BY at, rowid", (goal_id,))

    def may_review(self, goal, reviewer):
        """reviewer: {"kind": "agent", "agent": row} or {"kind": "person", "principal", "admin"}. Returns (ok, why)."""
        spec = self.review_spec(goal)
        if spec == "none":
            return False, "this task does not take a review"
        if reviewer["kind"] == "agent" and reviewer["agent"]["id"] == goal["claimed_by"]:
            return False, "the author cannot review its own work"
        if reviewer["kind"] == "person":
            if reviewer.get("admin"):
                return True, "admin person"
            return (spec == "person", "a named person reviews this task" if spec == "person" else f"this task is reviewed by {spec}")
        agent = reviewer["agent"]
        if spec == f"agent:{agent['id']}":
            return True, "named reviewer"
        if spec.startswith("mandate:"):
            role = self.db.one("SELECT mandate FROM roles WHERE id = ?", (agent.get("role_id"),)) if agent.get("role_id") else None
            mandate = json.loads(role["mandate"]) if role and role.get("mandate") else None
            return (bool(mandate) and mandate.get("id") == spec[8:], f"needs a mind holding the {spec[8:]} mandate")
        if spec == "requester":
            binding = json.loads(goal["binding"]) if goal.get("binding") else {}
            return (agent.get("swarm_id") == binding.get("from_swarm"), "a mind of the requesting swarm reviews this task")
        return False, f"this task is reviewed by {spec}"

    async def review(self, goal_id, reviewer, decision, notes=""):
        """Accept a submitted result (the goal is done) or return it with notes (back to the same mind)."""
        goal = self.get(goal_id)
        if goal["status"] != "submitted":
            raise self.hive.error(409, "not_submitted", f"task is {goal['status']}, not waiting for review")
        ok, why = self.may_review(goal, reviewer)
        if not ok:
            raise self.hive.error(403, "not_reviewer", why)
        by = f"agent:{reviewer['agent']['id']}" if reviewer["kind"] == "agent" else reviewer["principal"]
        digest = "sha256:" + hashlib.sha256((goal.get("result_data") or goal.get("result") or "").encode()).hexdigest()
        if decision == "accept":
            self.db.update("goals", goal_id, {"status": "done", "reviewed_by": by, "reviewed_at": now(), "updated_at": now()})
            self._record_review(goal_id, by, "accept", notes, digest)
            out = self._emit(goal_id)
            await self.notify_parent(out)
            return out
        if decision != "return":
            raise self.hive.error(400, "bad_request", "decision is accept or return")
        if not str(notes or "").strip():
            raise self.hive.error(400, "bad_request", "say what to change when returning work")
        returns = int(goal.get("returns") or 0) + 1
        self._record_review(goal_id, by, "return", notes, digest)
        if returns >= MAX_RETURNS:
            stopped = self.stop(goal_id, "failed", "review", f"returned {returns} times by its reviewer; last notes: {str(notes)[:300]}",
                                expected=goal, returns=returns, review_notes=str(notes)[:4000])
            if stopped is None:
                raise self.hive.error(409, "goal_changed", "this task changed while it was being reviewed; read it again")
            return stopped
        # Back to its holder only while the holder is a live mind, judged in the write itself (stand-in r3): a holder
        # deleted between the read and this write never gets the work back; it reopens, unclaimed, for another mind.
        back = self.db.execute(
            "UPDATE goals SET status = 'claimed', returns = ?, review_notes = ?, lease_until = ?, updated_at = ? "
            "WHERE id = ? AND status = 'submitted' AND claimed_by IS ? AND claimed_by IS NOT NULL "
            "AND EXISTS (SELECT 1 FROM agents WHERE id = goals.claimed_by AND deleted = 0)",
            (returns, str(notes)[:4000], _later(self.hive.settings.goal_lease_minutes), now(), goal_id, goal["claimed_by"]))
        if back.rowcount != 1:
            opened = self.db.execute(
                "UPDATE goals SET status = 'open', claimed_by = NULL, assignee = NULL, lease_until = NULL, returns = ?, "
                "review_notes = ?, updated_at = ? WHERE id = ? AND status = 'submitted'",
                (returns, str(notes)[:4000], now(), goal_id))
            if opened.rowcount != 1:
                raise self.hive.error(409, "goal_changed", "this task changed while it was being reviewed; read it again")
            reopened = self._emit(goal_id)
            await self.announce(reopened)
            return reopened
        if goal["claimed_by"]:
            await self.hive.send_to_agent(goal["claimed_by"], f"[GOAL-RETURNED {goal_id}] {goal['title']}: your reviewer sent it back "
                                          f"({returns} of {MAX_RETURNS - 1} returns). Their notes: {str(notes)[:1500]}. Fix this and propose again.",
                                          sender="hive:goals", extra={"event": "goal_returned", "goal_id": goal_id})
        return self._emit(goal_id)

    def get(self, goal_id):
        row = self.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
        if row is None:
            raise self.hive.error(404, "not_found", f"no task {goal_id}")
        return row

    @staticmethod
    def view(row):
        out = dict(row)
        for key in ("binding", "result_data"):
            out[key] = json.loads(row[key]) if row.get(key) else None
        out["binding_digest"] = binding_digest(out["binding"]) if out["binding"] else None
        return out

    def view_full(self, row):
        out = self.view(row)
        out["review_by"] = self.review_spec(row)
        out["validate"] = self.validator(row)
        return out

    def list(self, swarm_id, status=None):
        # step_budget_usd: the task's own budget while the mind holding it is the one that started it (give_step_budget,
        # _start_budget), the condition check_budget applies; a mind holding such a goal gets its turns back
        # (hive_helpers.held_goal). Time: one goal_budgets primary-key lookup per listed goal.
        sql = ("SELECT *, (SELECT b.budget_usd FROM goal_budgets b WHERE b.goal_id = goals.id "
               f"AND b.started_by = goals.claimed_by) AS step_budget_usd FROM goals WHERE swarm_id = ? AND {WORK_SQL}")
        params = [swarm_id]
        if status:
            sql += " AND status = ?"
            params.append(status)
        # review_by on list rows and goal.updated events too, so a board can show "awaiting review" (Surface audit 8)
        return [{**self.view(r), "review_by": self.review_spec(r)}
                for r in self.db.all(sql + " ORDER BY priority DESC, created_at", params)]

    def _fence(self, agent, goal):
        """Minds cannot work conversation bookkeeping; a research task belongs only to its own researcher."""
        if self.is_ask_thread(goal):
            raise self.hive.error(409, "ask_thread", "this task belongs to an Ask conversation; it is not work to claim or finish")
        research = getattr(self.hive, "research", None)
        if research is not None:
            research.fence(agent, goal)

    def for_agent(self, agent, goal_id):
        goal = self.get(goal_id)
        self._fence(agent, goal)
        if goal["swarm_id"] != agent["swarm_id"] and not (goal["status"] == "submitted" and self.may_review(goal, {"kind": "agent", "agent": agent})[0]):
            raise self.hive.error(403, "forbidden", "task is in another swarm")
        return {**self.view_full(goal), "result_schema": self.result_schema(goal)}

    def history(self, agent, query="", offset=0):
        """Completed work visible to this mind, newest first; three excerpts fit an Iter tool result. An Ask thread's
        goal is bookkeeping, never work (WORK_SQL), so it is never listed."""
        from .hive import HiveError
        if offset < 0:
            raise self.hive.error(400, "bad_request", "offset must be nonnegative")
        if not agent.get("swarm_id"):
            return {"goals": [], "next_offset": None}
        sql = f"SELECT id, binding FROM goals WHERE swarm_id = ? AND status = 'done' AND {WORK_SQL}"
        params = [agent["swarm_id"]]
        related = {row["goal_id"] for row in self.db.all(
            "SELECT goal_id FROM studio_sessions WHERE source_artifact_id = ? OR proposal_artifact_id = ?",
            (query, query))} if query else set()
        needle = query.casefold()
        # Time: sort n completed task identities in n log n comparisons, then scan visible text until a page is found.
        # Space: n identities and bindings, plus one page and one search candidate's full result.
        rows = self.db.all(sql + " ORDER BY updated_at DESC, rowid DESC", params)
        rows = self.hive.research.visible_goals(agent, rows)
        visible = []
        # A fence runs before reading result text; pagination counts only visible matches.
        for row in rows:
            try:
                self._fence(agent, row)
            except HiveError as exc:
                if exc.status == 403:
                    continue
                raise
            if query and row["id"] not in related:
                goal = self.view(self.get(row["id"]))
                text = "\n".join(str(goal.get(key) or "") for key in ("title", "detail", "result"))
                text += json.dumps({key: goal.get(key) for key in ("binding", "result_data")}, ensure_ascii=False)
                if needle not in text.casefold():
                    continue
            visible.append(row)
            if len(visible) > offset + 3:
                break
        page = visible[offset:offset + 3]
        return {"goals": [self.view_full(self.get(row["id"])) for row in page],
                "next_offset": offset + 3 if len(visible) > offset + 3 else None}

    def output(self, agent, goal_id, offset=0):
        """Read the visible task record in character pages so no instruction or structured result is lost."""
        goal = self.for_agent(agent, goal_id)
        if offset < 0:
            raise self.hive.error(400, "bad_request", "offset must be nonnegative")
        text = json.dumps(goal, ensure_ascii=False)
        end = offset + 3000   # room for framing within Iter's 5000-character tool result
        return {"text": text[offset:end], "next_offset": end if end < len(text) else None}

    @staticmethod
    def continuation_detail(source, instruction):
        """A follow-up's detail: the new instruction whole, then the source's recorded result and its instructions, so
        one read holds the work to continue. The source's text is cut to fit MAX_DETAIL_CHARS, its instructions before
        its result, and a cut names the read that has all of it."""
        head = (f"New instruction:\n{instruction.strip()}\n\n"
                f"This continues completed task {source['id']} ({str(source['title'])[:200]}).")
        data = source.get("result_data")
        sections = [("Its result", str(source.get("result") or "") + ("\n" + json.dumps(data, ensure_ascii=False) if data else "")),
                    ("Its instructions", str(source.get("detail") or ""))]
        marker = " [cut at {} of {} characters; hive-goal-output " + source["id"] + " 0 reads all of it]"
        room = MAX_DETAIL_CHARS - len(head) - sum(len(f"\n{label}:\n") + len(marker) + 12 for label, _ in sections)
        # The result is the work being continued, so the instructions give way first: they keep at most a quarter of
        # the room unless the result leaves more.
        keep = min(len(sections[1][1]), max(room // 4, room - len(sections[0][1])))
        text = head
        for (label, body), limit in zip(sections, (max(0, room - keep), max(0, keep))):
            if body:
                text += f"\n{label}:\n" + (body if len(body) <= limit else body[:limit] + marker.format(limit, len(body)))
        return text

    async def continue_goal(self, agent, goal_id, instruction):
        """Continue settled work as a fresh root held by the mind that asked, carrying the source's instructions and
        result and its result checks, never its grants. A research task is never continued."""
        source = self.for_agent(agent, goal_id)
        row = self.get(goal_id)
        research = getattr(self.hive, "research", None)
        # A follow-up's detail would copy the report into an ordinary task, outside the research route that keeps it to
        # its asker and admins (research.py), so this holds whoever can read the task. More research is a new request.
        if research is not None and research.is_task(row):
            raise self.hive.error(409, "research_task", "a research task can't be continued: more research is a new "
                                  "research request")
        if source["status"] != "done":
            raise self.hive.error(409, "not_done", "continue a completed task; claim unfinished work instead")
        if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 3500:
            raise self.hive.error(400, "bad_request", "instruction must be nonempty text of at most 3500 characters")
        # Only CONTINUATION_KEYS, so result() accepts the follow-up's plain done without a binding echo.
        binding = {"continued_from": goal_id, "review": self.review_spec(row)}
        if source.get("result_schema") is not None:
            binding["result_schema"] = source["result_schema"]
        if self.validator(row):
            binding["validate"] = self.validator(row)
        if binding["review"] == "requester":
            previous = source.get("binding") or {}
            binding["from_swarm"] = previous.get("from_swarm")
            # This id routes a review notification only; request completion still has no request_id to replay.
            binding["review_request_id"] = previous.get("request_id") or previous.get("review_request_id")
        newhive = getattr(self.hive, "newhive", None)
        if newhive is not None:   # the claim's readiness gate, checked before the write so a refusal leaves no task
            newhive.require_coding("goal_claim")
        # The person asked this mind for the work, so the follow-up is created as its claim and announced to no one:
        # a mind finishing it needs no claim and no read of the source before its done.
        follow = self._create_record(agent["swarm_id"], f"Continue: {source['title']}", self.continuation_detail(source, instruction),
                                     source["priority"], created_by=f"agent:{agent['id']}", binding=binding, emit=False)
        return self.claim(agent, follow["id"])

    def depth(self, goal):
        depth = 0
        while goal["parent_id"] and depth < MAX_DEPTH + 1:
            goal = self.get(goal["parent_id"])
            depth += 1
        return depth

    def _emit(self, goal_id):
        row = self.get(goal_id)
        goal = {**self.view(row), "review_by": self.review_spec(row)}
        if not self.is_ask_thread(row):
            self.hive.events.publish("goal.updated", goal=goal)
        return goal

    async def create(self, swarm_id, title, detail="", priority=0.5, parent_id=None, created_by="user:operator",
                     assignee=None, binding=None, deadline_minutes=None):
        goal = self._create_record(swarm_id, title, detail, priority, parent_id, created_by,
                                   assignee, binding, deadline_minutes)
        await self.announce(goal)
        return goal

    def _create_record(self, swarm_id, title, detail="", priority=0.5, parent_id=None, created_by="user:operator",
                     assignee=None, binding=None, deadline_minutes=None, *, goal_id=None, emit=True):
        self.hive.swarm(swarm_id)
        self.hive.require_open_swarm(swarm_id)
        if not str(title).strip():
            raise self.hive.error(400, "bad_request", "title is required")
        assignee_id = None
        if assignee:
            rows = self.db.all("SELECT id, name FROM agents WHERE swarm_id = ? AND deleted = 0", (swarm_id,))
            match = [r for r in rows if r["id"] == assignee] or [r for r in rows if r["name"].lower() == str(assignee).lower()]
            if not match:
                raise self.hive.error(404, "not_found", f"no mind {assignee!r} in this swarm to assign")
            assignee_id = match[0]["id"]
        if binding is not None:
            if not isinstance(binding, dict):
                raise self.hive.error(400, "bad_request", "binding must be an object")
            if len(json.dumps(binding)) > MAX_BINDING_BYTES:
                raise self.hive.error(413, "too_large", "a binding is limited to 16 KB")
            if "result_schema" in binding:
                try:
                    check_schema(binding["result_schema"])
                except SchemaError as exc:
                    raise self.hive.error(400, "bad_result_schema", str(exc))
        research = getattr(self.hive, "research", None)
        if created_by.startswith("agent:") and research is not None and research.child(created_by[6:]) is not None:
            raise self.hive.error(403, "forbidden", "a researcher works only on its own research task")
        if parent_id:
            parent = self.get(parent_id)
            if self.is_ask_thread(parent):
                raise self.hive.error(409, "ask_thread", "an Ask conversation cannot be split into subtasks")
            if parent["swarm_id"] != swarm_id:
                raise self.hive.error(400, "bad_request", "parent task is in another swarm")
            author = created_by.removeprefix("agent:")
            if created_by.startswith("agent:") and parent["claimed_by"] != author:
                raise self.hive.error(403, "forbidden", "only the mind that claimed a task can split it")
            if self.depth(parent) + 1 >= MAX_DEPTH:
                raise self.hive.error(400, "too_deep", f"tasks can be split at most {MAX_DEPTH - 1} levels deep")
            children = self.db.one("SELECT COUNT(*) AS n FROM goals WHERE parent_id = ?", (parent_id,))["n"]
            if children >= MAX_CHILDREN:
                raise self.hive.error(400, "too_many_subgoals", f"a task can have at most {MAX_CHILDREN} subtasks")
        stamp = now()
        row = {"id": goal_id or new_id("g"), "swarm_id": swarm_id, "parent_id": parent_id or None,
               "title": str(title).strip()[:300], "detail": str(detail or "")[:MAX_DETAIL_CHARS],
               "priority": max(0.0, min(1.0, float(priority if priority is not None else 0.5))),
               "status": "open", "created_by": created_by, "claimed_by": None, "result": None,
               "assignee": assignee_id, "binding": json.dumps(binding) if binding is not None else None,
               "deadline_at": _later(float(deadline_minutes)) if deadline_minutes else None,
               "created_at": stamp, "updated_at": stamp, "asked_at": self._creator_asked(created_by, stamp)}
        if parent_id:
            # Admission and cancellation on another DB connection serialize at
            # the INSERT: a stale held-parent check never creates late children.
            cols=", ".join(row);marks=", ".join("?" for _ in row)
            guard="id=? AND status IN ('open','claimed','waiting')"
            args=[parent_id]
            if created_by.startswith("agent:"):
                guard+=" AND claimed_by=? AND status IN ('claimed','waiting')"
                args.append(created_by[6:])
            with self.hive.swarm_membership(swarm_id):   # fenced while its swarm is deleted or restored
                inserted=self.db.execute(f"INSERT INTO goals ({cols}) SELECT {marks} WHERE EXISTS (SELECT 1 FROM goals WHERE {guard}) AND {self.hive.OPEN_SWARM_SQL}",(*row.values(),*args,swarm_id))
            if inserted.rowcount!=1:
                self.hive.require_open_swarm(swarm_id)   # an archived swarm says so, rather than blaming the parent
                raise self.hive.error(409,"parent_inactive","the parent no longer admits subtasks")
        else:
            self.hive.insert_into_open_swarm("goals", row, swarm_id)   # atomic with archive (OmegaReview)
        return self._emit(row["id"]) if emit else self.view(self.get(row["id"]))

    async def announce(self, goal):
        """Tell the awake swarm or the assignee, except its author. Conversation bookkeeping is never announced;
        a Studio session gets only its maker's step prompt."""
        binding = goal.get("binding")
        if isinstance(binding, str):
            try:
                binding = json.loads(binding)
            except ValueError:
                binding = None
        if isinstance(binding, dict) and binding.get("kind") in ("studio.session", "ask.thread"):
            return
        author = goal["created_by"].removeprefix("agent:")
        envelope_text = (f"New goal {goal['id']} (priority {goal['priority']:.2f}): {goal['title']}"
                         + (f" - {goal['detail']}" if goal["detail"] else ""))
        if goal.get("assignee"):
            envelope_text = (f"Assigned to you: {envelope_text}. Read it with hive-goal-get {goal['id']}, claim it with "
                             f"hive-goal-claim {goal['id']}, and finish with hive-goal-propose {goal['id']} {{json}} or "
                             f"hive-goal-done {goal['id']} <what was done>.")
        for member in self.db.all("SELECT id, status, kind FROM agents WHERE swarm_id = ? AND deleted = 0",
                                  (goal["swarm_id"],)):
            if goal.get("assignee") and member["id"] != goal["assignee"]:
                continue
            if member["id"] == author:
                continue
            # An assignee always hears about its goal, even while stopped: the message waits in its inbox, so a
            # mind started later still learns it holds the goal (found 2026-10-03: a stopped Scientist never did).
            if not goal.get("assignee") and member["kind"] != "module" and member["status"] not in ("awake", "starting"):
                continue
            await self.hive.send_to_agent(member["id"], envelope_text, sender="hive:goals",
                                          extra={"event": "goal", "goal_id": goal["id"]})

    def update(self, goal_id, changes):
        with self.db.transaction():
            goal = self.get(goal_id)
            if self.is_ask_thread(goal):
                raise self.hive.error(409, "ask_thread", "end the Ask conversation to close this task")
            values = {}
            if "status" in changes:
                if goal["status"] == "submitted" and changes["status"] == "done":
                    raise self.hive.error(409, "needs_review", "this result is waiting for its reviewer: accept or return it with a review")
                if changes["status"] not in STATUSES:
                    raise self.hive.error(400, "bad_request", f"status must be one of {sorted(STATUSES)}")
                if changes["status"] != goal["status"] and changes["status"] not in TERMINAL_NEXT.get(goal["status"], STATUSES):
                    raise self.hive.error(409, "goal_closed", f"this task is {goal['status']}; it cannot be moved to {changes['status']}")
                values["status"] = changes["status"]
                if changes["status"] == "open":
                    # Re-opening (e.g. a stalled goal) is a fresh start: no holder, no lapses.
                    values.update(claimed_by=None, lease_until=None, attempts=0)
            if "priority" in changes:
                values["priority"] = max(0.0, min(1.0, float(changes["priority"])))
            for key in ("title", "detail"):
                if key in changes:
                    values[key] = str(changes[key])
            if values:
                values["updated_at"] = now()
                self.db.update("goals", goal["id"], values)
                if values.get("status") in ("failed", "stalled") and values["status"] != goal["status"]:
                    self.record_stop(goal_id, "marked_" + values["status"], detail="")
        return self._emit(goal_id)

    async def notify_cancelled(self, goal_id):
        """Tell whoever holds (or was assigned) a cancelled goal, so it stops and acknowledges."""
        goal = self.get(goal_id)
        if goal["status"] != "cancelled":
            return
        await self._close_bound(goal, "GOAL-CANCELLED", "goal_cancelled")

    async def _close_bound(self, goal, tag, event):
        """Revoke a bound goal's snapshot shares and tell its holder or assignee to stop."""
        binding = json.loads(goal["binding"]) if goal.get("binding") else {}
        for share_id in binding.get("share_ids") or []:
            try:
                await self.hive.shares.revoke(share_id)   # the snapshot stops being readable
            except Exception as exc:  # already closed shares are fine
                if getattr(exc, "status", None) not in (404, 409):
                    raise
        for agent_id in {goal["claimed_by"], goal.get("assignee")} - {None}:
            await self.hive.send_to_agent(agent_id, f"[{tag} {goal['id']}] {goal['title']} - stop and "
                                                    f"acknowledge with cancel-ack", sender="hive:goals",
                                          extra={"event": event, "goal_id": goal["id"]})

    def cancel_ack(self, agent, goal_id):
        goal = self.get(goal_id)
        self._fence(agent, goal)
        expired = goal["status"] == "failed" and goal.get("deadline_at") and goal["deadline_at"] < now()
        if goal["status"] != "cancelled" and not expired:
            raise self.hive.error(409, "not_cancelled", f"task is {goal['status']}")
        if agent["id"] not in (goal["claimed_by"], goal.get("assignee")):
            raise self.hive.error(403, "forbidden", "only the holder or assignee acknowledges a cancellation")
        if not goal.get("cancel_ack_at"):
            self.db.update("goals", goal_id, {"cancel_ack_at": now(), "cancel_ack_by": agent["id"]})
        return self._emit(goal_id)

    def claim(self, agent, goal_id):
        if getattr(self.hive, "newhive", None) is not None:   # new-hive R1a: unclassified work holds before readiness
            self.hive.newhive.require_coding("goal_claim")
        goal = self.get(goal_id)
        if goal["swarm_id"] != agent["swarm_id"]:
            raise self.hive.error(403, "forbidden", "task is in another swarm")
        self._fence(agent, goal)
        if goal.get("assignee") and goal["assignee"] != agent["id"]:
            raise self.hive.error(403, "not_assigned", "this task is assigned to another mind")
        # One conditional UPDATE, so two minds claiming at once cannot both win.
        # ...and only by a live mind, in the same statement (stand-in r3): a claim authenticated before its mind's delete
        # cannot land after the release that delete made.
        cursor = self.db.execute(
            "UPDATE goals SET status = 'claimed', claimed_by = ?, lease_until = ?, attempts = attempts + 1, "
            "updated_at = ? WHERE id = ? AND status = 'open' "
            "AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted = 0)",
            (agent["id"], _later(self.hive.settings.goal_lease_minutes), now(), goal_id, agent["id"]))
        if cursor.rowcount != 1:
            if not self.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (agent["id"],)):
                raise self.hive.error(409, "mind_deleted", "this mind was deleted; it cannot claim work")
            goal = self.get(goal_id)
            if goal["claimed_by"] == agent["id"] and goal["status"] in ("claimed", "waiting"):
                return self.heartbeat(agent, goal_id)  # claiming a goal you already hold renews it
            raise self.hive.error(409, "not_open", f"task is {goal['status']}"
                                  + (f" by {goal['claimed_by']}" if goal["claimed_by"] else ""))
        self._start_budget(agent["id"], goal_id)
        self._mark_goal_input(agent["id"], goal_id)   # a claim is real input; it carries the goal's asking
        return self._emit(goal_id)

    def _unheld(self, agent, goal, status, code, message):
        """The refusal for an action that needs a task the mind doesn't hold. An open task assigned to that mind names
        the claim first: on a tester's hive on 20 Nov a model heartbeated its open plan goal turn after turn, told only
        "you do not hold this task", and never claimed it."""
        if goal["status"] == "open" and goal.get("assignee") == agent["id"]:
            return self.hive.error(409, "not_claimed", f"this task is open and assigned to you: claim it with "
                                   f"hive-goal-claim {goal['id']}, then finish it with hive-goal-propose {goal['id']}")
        return self.hive.error(status, code, message)

    def person_behind(self, created_by):
        """The person a goal's creator stands for, as 'user:...', or None when the hive doesn't know of one. Resolved only
        from what the hive already records, never guessed: a person (user:...) is themselves; a request (request:<id>, as
        the Code controller, research and collaboration file it) is its requests.from_principal when that is a person (as
        record_stop reads it); a Create plan (create-plan:<id>) is its create_plan_runs.person (as visibility._plan_person
        reads it). A mind's (agent:...), a program's (program:...) and the hive's own (host:..., hive:...) have none."""
        creator = str(created_by or "")
        person = None
        if creator.startswith("user:"):
            person = creator
        elif creator.startswith("request:"):
            row = self._read("SELECT from_principal AS who FROM requests WHERE id = ?", creator[len("request:"):])
            person = row["who"] if row else None
        elif creator.startswith("create-plan:"):
            row = self._read("SELECT person AS who FROM create_plan_runs WHERE plan_id = ?", creator[len("create-plan:"):])
            person = row["who"] if row else None
        return person if isinstance(person, str) and person.startswith("user:") else None

    def _read(self, sql, key):
        """One row, or None on a hive without that table (the plan engine's or collaboration's not created yet)."""
        try:
            return self.db.one(sql, (key,))
        except sqlite3.OperationalError:
            return None

    def _mind_behind(self, created_by):
        """The mind a goal's creator stands for, by id, or None: a mind itself (agent:<id>), or a request a mind filed."""
        creator = str(created_by or "")
        if creator.startswith("request:"):
            row = self._read("SELECT from_principal AS who FROM requests WHERE id = ?", creator[len("request:"):])
            creator = str(row["who"]) if row else ""
        return creator[len("agent:"):] if creator.startswith("agent:") else None

    def person_made(self, goal):
        """Whether a person stands behind this goal, or behind the root of its tree for a subtask (person_behind): work a
        person asked for. A goal a mind made for itself or another mind is not, however deep. Time: one read per level,
        a few past MAX_DEPTH at most (a parent loop, or a chain deeper than any split allows, reads as no person's)."""
        seen = set()
        while goal is not None and goal["id"] not in seen and len(seen) <= MAX_DEPTH + 8:
            seen.add(goal["id"])
            if not goal.get("parent_id"):
                return self.person_behind(goal.get("created_by")) is not None
            goal = self.db.one("SELECT * FROM goals WHERE id = ?", (goal["parent_id"],))
        return False

    def _creator_asked(self, created_by, stamp):
        """The freshness a new goal carries (goals.asked_at): a goal a person stands behind (person_behind: a person's
        own, their request's, their Create plan's) was asked as it was made; a mind's, or a request a mind filed, carries
        that mind's own last_asked_at (none if no one asked it), so its subtasks run on the asking that started the tree
        and rest with it; anything else (a program's, the hive's own) carries none."""
        if self.person_behind(created_by) is not None:
            return stamp
        mind = self._mind_behind(created_by)
        if mind is not None:
            row = self.db.one("SELECT last_asked_at FROM agents WHERE id = ?", (mind,))
            return row["last_asked_at"] if row else None
        return None

    def asking(self, goal_id):
        """The asking a goal passes on (goals.asked_at), resolved when it is passed on if it was none when the goal was
        made: every request path (collaboration, research, a Code instruction) writes its receiving goal before its
        requests row, so at creation person_behind finds nobody. Resolved now: a person behind it, its own created_at;
        a mind behind it (itself, or the request it filed), that mind's last_asked_at now; else none. A found stamp is
        kept on the goal (only where it is still none), so later claims read it. Time: one read, two more when none."""
        goal = self.db.one("SELECT id, asked_at, created_by, created_at FROM goals WHERE id = ?", (goal_id,))
        if goal is None:
            return None
        if goal["asked_at"]:
            return goal["asked_at"]
        stamp = self._creator_asked(goal["created_by"], goal["created_at"])
        if stamp:
            self.db.execute("UPDATE goals SET asked_at = ? WHERE id = ? AND asked_at IS NULL", (stamp, goal_id))
        return stamp

    def _mark_goal_input(self, agent_id, goal_id):
        """A claim or heartbeat: input to the idle signal always (Hive.mark_input); the mind's asking (last_asked_at, which
        the free route reads) becomes the later of its own and the goal's (asking, Hive.pass_asked), so a mind claiming
        goals it made itself, no one having asked it, can't keep itself awake."""
        self.hive.mark_input(agent_id)
        self.hive.pass_asked(agent_id, self.asking(goal_id))

    def heartbeat(self, agent, goal_id):
        """Renew the claimer's lease; also resumes a goal that was waiting on a person."""
        goal = self.get(goal_id)
        self._fence(agent, goal)
        if goal["claimed_by"] != agent["id"] or goal["status"] not in ("claimed", "waiting"):
            raise self._unheld(agent, goal, 409, "not_claimed", "you do not hold this task")
        lease = _later(self.hive.settings.goal_lease_minutes)
        if goal.get("deadline_at"):
            # a heartbeat never outlives the hard deadline: past it the goal is expired, not renewable
            if goal["deadline_at"] <= now():
                raise self.hive.error(409, "goal_expired", "this task's deadline has passed")
            lease = min(lease, goal["deadline_at"])
        # Only while nothing changed since the read and the holder is a live mind, in the same statement (stand-in r4):
        # a heartbeat racing a delete's release can never put the task back to claimed with no holder.
        cur = self.db.execute(
            "UPDATE goals SET status = 'claimed', updated_at = ?, lease_until = ? WHERE id = ? AND status = ? "
            "AND claimed_by IS ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted = 0)",
            (now(), lease, goal_id, goal["status"], agent["id"], agent["id"]))
        if cur.rowcount != 1:   # released, reassigned or its mind deleted meanwhile: as if the lease had lapsed
            raise self.hive.error(409, "not_claimed", "you do not hold this task")
        self._mark_goal_input(agent["id"], goal_id)   # the holder saying it is still on owed work
        return self._emit(goal_id)

    async def result(self, agent, goal_id, status, result, data=None, trusted_review=False, top_digest=None, strict_binding=False):
        goal = self.get(goal_id)
        self._fence(agent, goal)
        if goal["status"] == "cancelled":
            raise self.hive.error(409, "goal_cancelled", "this task was cancelled; acknowledge with cancel-ack")
        if goal.get("deadline_at") and goal["deadline_at"] < now() and goal["status"] not in ("done", "failed"):
            raise self.hive.error(409, "goal_expired", "this task's deadline has passed")
        if goal["claimed_by"] != agent["id"]:
            raise self._unheld(agent, goal, 403, "forbidden", "only the mind that claimed a task can finish it")
        if data is not None:
            if not isinstance(data, dict):
                raise self.hive.error(400, "bad_request", "data must be an object")
            if len(json.dumps(data)) > MAX_RESULT_DATA_BYTES:
                raise self.hive.error(413, "too_large", "result data is limited to 256 KB")
        if goal.get("binding"):
            binding = json.loads(goal["binding"])
            if binding.get("kind") == "review" and status == "done" and not trusted_review:
                # a review is finished only through its structured receipt, never a generic "done"
                raise self.hive.error(409, "review_needs_receipt", "finish a review with hive-review-complete "
                                      "(its findings, recommendation and rationale); a plain done is not a review")
            echoed = (data or {}).get("binding")
            expected = binding_digest(binding)
            # A follow-up continue_goal made may be finished with no echo at all; an echo that is sent must be exact.
            unechoed = continuation_only(binding) and echoed is None and top_digest is None \
                and (data or {}).get("binding_digest") is None
            if strict_binding and status == "done" and top_digest != expected and not unechoed:
                # the MCP bridge: the digest is top-level and exact, and mandatory on a bound goal that is no follow-up
                raise self.hive.error(409, "binding_mismatch", "a result for a bound task must carry its binding_digest exactly")
            if status == "done" and not strict_binding and not unechoed and echoed != binding \
                    and (data or {}).get("binding_digest") != expected and top_digest != expected:
                # a mind's plain done sends no echo; its propose command reads the task and sends the digest
                raise self.hive.error(409, "binding_mismatch",
                                      "a result for a bound task must echo its binding (or binding_digest) exactly: "
                                      "finish it with hive-goal-propose <task id> <result>, which sends the binding_digest")
        elif strict_binding and top_digest is not None and status == "done":
            raise self.hive.error(409, "binding_mismatch", "this task has no binding, so a binding_digest does not apply")
        text_in = str(result or "").strip()
        if goal["status"] in ("done", "failed") and goal["status"] == status and len(text_in) <= 4000 \
                and (goal.get("result") or "") == text_in \
                and (json.loads(goal["result_data"]) if goal.get("result_data") else None) == data:
            return self.view(goal)   # an identical retry (e.g. after a lost response) is accepted once more
        if goal["status"] not in ("claimed", "waiting"):
            raise self.hive.error(409, "not_claimed", f"task is {goal['status']}")
        if status not in ("done", "failed", "waiting"):
            raise self.hive.error(400, "bad_request", "status must be done, failed or waiting")
        text = str(result or "").strip()
        if status == "done" and not text:
            raise self.hive.error(400, "no_result", "say what was done: a task is not done without a result")
        if status == "failed" and not text:
            raise self.hive.error(400, "no_result", "say why this task could not be finished")
        submit = False
        read_guards = ()
        if status == "done" and not trusted_review:
            data = self._check_result(goal, agent, data)
            raw = proposal_of(data)
            problems = await self._run_validator(goal, agent, raw)
            read_guards = getattr(problems, "read_guards", ())
            if problems:
                self._record_attempt(goal["id"], agent["id"], raw, problems)
                raise self.hive.error(422, "result_invalid", f"result refused by {self.validator(goal)} ({len(problems)} problem(s)): "
                                      + "; ".join(problems[:12]) + ". The task is still yours: fix these and propose again.",
                                      {"errors": problems[:12]})
            submit = self.review_spec(goal) != "none"
        elif status == "done" and trusted_review:
            # a review receipt is admitted on the trusted path, but if the request names a reviewer of the review
            # (e.g. OmegaReview's QC mind) it still goes to that reviewer first (bypass found by OmegaReview)
            explicit = self._bound(goal, "review")
            submit = explicit not in (None, "", "none") and self.review_spec(goal) != "none"
        values = {"status": "submitted" if submit else status, "result": text[:4000], "updated_at": now()}
        if submit:
            values.update(submitted_at=now(), lease_until=None)
        if data is not None:
            values["result_data"] = json.dumps(data)
        if status == "waiting":
            values["lease_until"] = None
        # Save only if nothing changed the goal while its result was being checked (a cancel or re-open during a slow
        # app validator must win, not be overwritten; race found by OmegaMatch).
        sets = ", ".join(f"{k} = ?" for k in values)
        sql = f"UPDATE goals SET {sets} WHERE id = ? AND status = ? AND claimed_by IS ? AND updated_at = ?"
        params = (*values.values(), goal_id, goal["status"], goal["claimed_by"], goal["updated_at"])
        with self.db.transaction():
            cur = self.db.guarded_execute(sql, params, read_guards) if read_guards else self.db.execute(sql, params)
            if cur is not None and cur.rowcount == 1 and status == "failed":
                self.record_stop(goal_id)
        if cur is None:
            raise self.hive.error(409, "validation_context_changed", "the stored review context changed while this result was checked; read it again and propose again")
        if cur.rowcount != 1:
            raise self.hive.error(409, "goal_changed", "this task changed while your result was being checked "
                                  "(cancelled, re-opened or reassigned); read it again before doing anything else")
        if submit:
            # every submission for review is kept whole, so a return-and-resubmit never loses what was first submitted
            # (the schema gate already records its attempts; trusted receipts and unschema'd results did not; found by OmegaReview)
            if trusted_review or self.result_schema(goal) is None:
                self._record_attempt(goal_id, agent["id"], {"result": text, "data": data}, [])
            self._record_review(goal_id, f"agent:{agent['id']}", "submit", "", "sha256:" + hashlib.sha256(text.encode()).hexdigest())
            self._notify_reviewer(goal)
        self.hive.mark_input(agent["id"])   # a result is meaningful output
        return self._emit(goal_id)

    def holds_create_step(self, agent_id):
        """Whether the mind is working on a step of a Create plan (a claimed goal the plan stamped create-plan:<plan>:
        a build, the acceptance check, the plan, a design or a review). Such an answer holds whole files or a whole plan
        in one reply, and a reply cut off at its room is thrown away whole, so the model route gives these calls the
        model's whole room at once. Time: one lookup."""
        return self.db.one("SELECT 1 FROM goals WHERE claimed_by = ? AND status = 'claimed' AND created_by LIKE "
                           "'create-plan:%' LIMIT 1", (agent_id,)) is not None

    def release_rows(self, agent_id, by, why):
        """A deleted mind's unfinished work, released in the caller's transaction (its soft delete); events after commit.
        open / claimed / waiting / stalled where it is assignee or holder: back to open, unassigned and unclaimed, and
        nothing else (attempts and returns stay). submitted: the submission and its history stay pending review and
        only the dead assignee is cleared; a return then reopens it (see review), never to the deleted mind. Each change
        is conditional on the row read and is noted on the task's review trail. Returns the changed task ids."""
        changed = []
        for goal in self.db.all("SELECT * FROM goals WHERE (assignee = ? OR claimed_by = ?) "
                                "AND status IN ('open', 'claimed', 'waiting', 'stalled', 'submitted')", (agent_id, agent_id)):
            if self.is_ask_thread(goal):
                continue
            if goal["status"] == "submitted":
                if goal.get("assignee") != agent_id:
                    continue   # the submitter's own record stays; a return reopens it
                sets, note = "assignee = NULL", why + "; the submission stays for review"
            else:
                # only what makes it claimable: attempts, returns, results and reviews stay as history (Kimi K4)
                sets = "status = 'open', assignee = NULL, claimed_by = NULL, lease_until = NULL"
                note = why
            cur = self.db.execute(f"UPDATE goals SET {sets}, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?",
                                  (now(), goal["id"], goal["status"], goal["updated_at"]))
            if cur.rowcount == 1:
                self._record_review(goal["id"], by, "released", note)
                changed.append(goal["id"])
        return changed

    async def expire(self, moment=None):
        """Release claims whose lease lapsed; stall goals that keep lapsing."""
        moment = moment or now()
        released = []
        # A deadline is a hard time budget: past it the goal fails, its snapshot shares are revoked and the
        # holder is told, whatever state it is in.
        for goal in self.db.all("SELECT * FROM goals WHERE deadline_at IS NOT NULL AND deadline_at < ? "
                                "AND status IN ('open', 'claimed', 'waiting', 'stalled')", (moment,)):
            if self.stop(goal["id"], "failed", "deadline", emit=False, expected=goal) is None:
                continue
            await self._close_bound(goal, "GOAL-EXPIRED", "goal_expired")
            self._emit(goal["id"])
            released.append(goal["id"])
        for goal in self.db.all("SELECT * FROM goals WHERE status = 'claimed' AND lease_until IS NOT NULL "
                                "AND lease_until < ?", (moment,)):
            if goal["attempts"] >= MAX_ATTEMPTS:
                self.stop(goal["id"], "stalled", "leases", expected=goal)
            else:
                self.db.update("goals", goal["id"], {"status": "open", "claimed_by": None, "lease_until": None,
                                                     "updated_at": now()})
                await self.announce(self._emit(goal["id"]))
            released.append(goal["id"])
        return released

    async def notify_parent(self, goal):
        """When the last subgoal finishes, tell whoever holds the parent, with the results."""
        if not goal["parent_id"]:
            return
        parent = self.get(goal["parent_id"])
        children = self.db.all("SELECT * FROM goals WHERE parent_id = ?", (parent["id"],))
        if parent["status"] != "claimed" or any(c["status"] in UNFINISHED for c in children):
            return
        summary = "; ".join(f"{c['title']}: {c['status']} - {c['result'] or ''}".strip(" -") for c in children)
        await self.hive.send_to_agent(parent["claimed_by"], f"[SUBGOALS-DONE {parent['id']}] {summary}",
                                      sender="hive:goals", extra={"event": "subgoals_done", "goal_id": parent["id"]})

    @staticmethod
    def dumps(value):
        return json.dumps(value)
