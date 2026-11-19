"""Create plans: each piece built by a real per-change task (the coding controller's R3.14 plan-member profile).

The plan engine's `build` effect (piece-started or a route-fix) goes here; there is no other builder:
  - the piece's fork is made first (space.ensure_fork), then code_controller.adopt_member(plan_id, piece,
    origin {task_id, grant_id, repository_id, workspace_id: the fork}, the piece's paths, its resolved assignee mind,
    budget_ref, review policy plan-reviewed, person, task=<the plan's build op>, brief=<what to build: the sentence,
    the piece's title and brief, the acceptance criteria, the person's answers, and on a fix the plan's failing
    output, each bounded and marked when truncated>) opens one member run. The plan's effect waits on
    `member:<task_id>` (no goal; never a poll). adopt_member is idempotent, so a re-performed build (a restart) whose
    member is already ready takes its candidate at once;
  - the member's helper writes only the piece's files on the fork and checkpoints them; its test is THIS module's
    run_test, registered as code_controller.member_ports.run_test: the plan's acceptance check (sandboxed, the check
    from the base checkpoint) on the candidate. A piece passes its own test when the check passes, or fails only on
    files the piece does not own (the other pieces are not built yet): the piece's part is satisfied. The answer keeps
    the check's verdict (the files it fails and its notes), which the member journals with the output: a repair is
    shown it, and a member that blocks on it says it on the person's hold card (check_failure);
  - a candidate is CHECKED, never trusted: before it is snapshotted (and before it is tested), every file that differs
    from the fork's origin must be one of the piece's own files, never checks/ or a reserved path (candidate_scope).
    Anything else is a definite refusal: `refused` in the member, `piece-blocked` in the plan;
  - code.controller.member_ready {plan_id, piece, cand, task_id} wakes the plan (engine.on_event -> collect): the
    candidate becomes `piece-ready (p op cand)`;
  - after the plan journals `integrated`, member_integrated(task_id, op, cand, ckpt) delivers the member. A delivery
    lost to a crash between the two is made again, idempotently, from the plan's journal (settle, and before any build);
  - a route-fix before integration reopens the same member with member_refix(task_id, op, cand, failing_ref, failing);
    after integration (the member is delivered) a fix is a new member on a fresh fork from the integration head;
  - when the plan blocks or stops (for any reason), member_budget_ended(task_id) for every member still open, so no
    helper goal lingers. A build still waiting on an ended member is read back after the plan resumes (unknown ->
    reconcile -> a fresh member under a new attempt key).
"""
from __future__ import annotations

import json
import logging
import re

from .create_plan_ports import CHECK_PATH, ScopeError

log = logging.getLogger(__name__)

TERMINAL = ("delivered", "stopped")
RESTING = ("blocked", "stopped", "deployed")             # plan phases in which no member should keep working
BRIEF_TEXT, BRIEF_ANSWERS, BRIEF_FAILING, BRIEF_PROBE = 3000, 12000, 16000, 6000   # characters; the member's brief limit is 40000
CHECK_SAID = 200                                         # characters of the check's own note a hold card quotes


def _bounded(value, limit):
    """value as it is when its JSON is at most `limit` characters; else {"truncated": true, "text": <the first
    limit characters of its JSON>} so the mind knows it saw only part of it."""
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(text) <= limit:
        return value
    return {"truncated": True, "chars": len(text), "text": text[:limit]}


def check_failure(failing, paths):
    """What the acceptance check last said about a builder's piece, as a sentence for the person's hold card, or None.
    `failing` is the member's newest failing since its last version (Code controller _failing_output). It counts only
    when that is the member's own test (tests-fail, which keeps the check's verdict: the files it fails and its notes,
    as parse_check_output gives them) and no refused attempt came after it. The check runs on the whole app, so it
    also fails the files of pieces not built yet: a note is the piece's when it names one of the piece's failing
    files, or when the check fails nothing else. With no such note, the piece's failing files are named instead."""
    if failing.get("kind") != "tests-fail" or failing.get("refused"):
        return None
    every = [str(f) for f in failing.get("failing") or []]
    files = [f for f in every if f in paths]
    # a file is named as a whole name: "app.js is missing" names app.js, "webapp.js" or "app.json is missing" does not
    names = [re.compile(rf"(?<![\w./-]){re.escape(f)}(?![\w/-]|\.\w)") for f in files]
    only_ours = set(every) <= set(paths)
    note = next((n for n in (str(x).strip() for x in failing.get("notes") or [])
                 if n and (only_ours or any(name.search(n) for name in names))), None)
    if note:
        said = note if len(note) <= CHECK_SAID else note[:CHECK_SAID - 1] + "…"
        return f"Its last version still fails the acceptance check, which says “{said}”."
    if files:
        return ("Its last version still fails the acceptance check on "
                + (" and ".join([", ".join(files[:-1]), files[-1]]) if len(files) > 1 else files[0]) + ".")
    return None


def counted_check(out, built):
    """A failed check as it counts against the piece being built, whose files and the integrated pieces' are `built`.
    A probe reports each case with the files it is blamed on (create_plan_ports.check_cases). A failed case naming a
    file outside `built` can't pass until a later piece is built, so it waits: its files and its note leave failing
    and notes, which the repair's packet and the hold card read, and "<case> waits on <file>" goes in waits. On a
    Make run of a tic-tac-toe the board was built before the game logic, every gameplay case named app.js and
    index.html, and the board was blamed for them until its repairs ran out. A check that reports no cases (a Python
    check) and a run with every piece built count as they came. Time: one pass over the cases and the notes."""
    waiting = [(c, sorted(set(c["files"]) - built)) for c in out.get("cases") or [] if not c["passed"]]
    waiting = [(c, missing) for c, missing in waiting if missing]
    if not waiting:
        return out
    counted = [c for c in out["cases"] if not c["passed"] and set(c["files"]) <= built]
    names = tuple(c["name"] + ": " for c, _ in waiting)
    return dict(out, failing=sorted({f for c in counted for f in c["files"]}),
                notes=[n for n in out.get("notes") or [] if not n.startswith(names)],
                waits=[f"{c['name']} waits on {', '.join(missing)}" for c, missing in waiting])


class PerChangeBuilds:
    """The `build` effect's adapter (Ports.members). `code` is the per-change engine (hive.code_controller)."""

    def __init__(self, engine, ports, code=None):
        self.engine, self.ports, self.hive = engine, ports, engine.hive
        self.code = code if code is not None else self.hive.code_controller
        self.code.member_ports.run_test = self.run_test

    # ---- bookkeeping in the plan's space ------------------------------------------------------------------------

    def _space(self, run):
        return self.engine._space(self.engine._run(run["plan_id"]))

    def _members(self, run):
        return dict(self._space(run).get("members") or {})

    def _remember(self, run, piece, rec):
        members = self._members(run)
        members[piece] = rec
        self.engine._space_set(run["plan_id"], members=members)

    def _member_run(self, task_id):
        return self.code._run(task_id)

    def allowed(self, run, piece):
        """What a piece's candidate may change: its own files, never checks/ or a reserved path (a data row)."""
        spec = self.engine._piece_spec(run["plan_id"], piece) or {}
        reserved = set(json.loads(self.engine.setting("reserved_paths", "[]") or "[]")) | {CHECK_PATH}
        return {p for p in spec.get("files", []) if p not in reserved and not p.startswith("checks/")}

    # ---- build (start or route-fix) -----------------------------------------------------------------------------

    @staticmethod
    def _op(body):
        """The plan's own name for this build: its task on a start, `fix-for-<failing op>` on a route-fix (each failing
        op is routed once per piece)."""
        return body.get("task") or f"fix-for-{body['failing_op']}"

    def _brief(self, run, spec, failing):
        plan = self.engine._plan(run["plan_id"]) or {}
        return {"sentence": _bounded(run["sentence"], BRIEF_TEXT), "title": _bounded(spec.get("title"), 400),
                "brief": _bounded(spec.get("brief"), BRIEF_TEXT),
                "acceptance": _bounded(plan.get("acceptance") or [], BRIEF_TEXT),
                "answers": _bounded(self.engine.answers(run["plan_id"]), BRIEF_ANSWERS),
                "failing": _bounded(failing, BRIEF_FAILING),
                # the probe the candidate is played by (create_plan_ports.PROBE_PATH): its selectors are the elements
                # to build, so a builder that sees it builds to them on its first try instead of in a fix round
                "probe": _bounded(self._space(run).get("probe"), BRIEF_PROBE)}

    def _task_key(self, run, op):
        """The member key for this build: the op, or op~n after n members for it were ended (a blocked or stopped plan
        resumed), so a re-dispatched build gets a fresh member rather than the ended one (adopt is idempotent)."""
        n = (self._space(run).get("member_attempts") or {}).get(op, 0)
        return op if not n else f"{op}~{n}"

    async def build(self, run, body, spec):
        piece, op = body["piece"], self._op(body)
        assignee = (body.get("assignee") or {}).get("agent_id")
        if not assignee:
            return {"blocked": "the piece's assignee has no mind that can take a per-change task"}
        if not hasattr(self.code, "adopt_member"):
            return {"blocked": "this hive has no per-change engine to build the piece"}
        await self.deliver_landed(run)                   # a delivery a crash lost comes first (it decides refix vs new)
        rec = self._members(run).get(piece)
        failing = body.get("failing")
        if rec and failing and not rec.get("integrated"):
            # the same member, reopened with the plan's failing output (one repair in R3.14)
            mrun = self._member_run(rec["task_id"])
            if mrun is not None and mrun["phase"] not in TERMINAL and rec.get("refix") == op:
                return await self._now_or_later(run, body, rec["task_id"])   # this fix was sent (a re-performed effect)
            if mrun is not None and mrun["phase"] not in TERMINAL and rec.get("cand"):
                await self.code.member_refix(rec["task_id"], op, rec["cand"], failing.get("op") or op, failing)
                self._remember(run, piece, dict(rec, cand=None, refix=op))
                return await self._now_or_later(run, body, rec["task_id"])
            if mrun is not None and mrun["phase"] not in TERMINAL:   # replaced: the old member's budget ends
                await self.code.member_budget_ended(rec["task_id"], "the plan gave this piece a new member")
        fork = await self.ports.space.ensure_fork(run, piece)
        s = self._space(run)
        origin = {"task_id": s["task_id"], "grant_id": s["grant_id"], "repository_id": s["repository_id"],
                  "workspace_id": fork}
        out = self.code.adopt_member(run["plan_id"], piece, origin, list(spec["files"]), assignee,
                                     run["plan_id"], "plan-reviewed", run["person"], task=self._task_key(run, op),
                                     brief=self._brief(run, spec, failing))
        self._remember(run, piece, {"task_id": out["task_id"], "op": op, "fork": fork, "cand": None, "integrated": False})
        return await self._now_or_later(run, body, out["task_id"])

    async def _now_or_later(self, run, body, task_id):
        got = await self.collect(run, body, f"member:{task_id}")
        return got if got is not None else {"pending": f"member:{task_id}"}

    # ---- results -----------------------------------------------------------------------------------------------

    async def collect(self, run, body, goal_id):
        """The member's state, read from its run row (an event or a restart brings us here; never a model call)."""
        task_id = goal_id.split(":", 1)[1]
        mrun = self._member_run(task_id)
        if mrun is None:
            return {"unknown": "the member run is gone"}
        if mrun["phase"] == "stopped":
            if str(self.engine._run(run["plan_id"])["phase"]) in RESTING:
                return None                              # ended while the plan rests; read back when it resumes
            return {"unknown": "the piece's member was ended before it delivered"}
        if mrun["status"] == "needs_you" or mrun["phase"] == "blocked":
            member = json.loads(mrun["member"]) if mrun["member"] else {}
            # why the builder stopped, newest cause first: its error; the acceptance check its last version still
            # fails, when no refused attempt came after it (check_failure); else its last refused attempt. The builder
            # and its reason are kept with the block for the person's hold card (engine._stopped): a refused attempt's
            # goal_reason (its hive-goal-fail words, or the hive's when its mind stopped after refused replies), or
            # what the check said
            check = None if mrun["last_error"] else check_failure(self.code._failing_output(task_id) or {},
                                                                   member.get("paths") or [])
            refused = {} if mrun["last_error"] or check else (self.code.last_refused(task_id) or {})
            why = mrun["last_error"] or check or self.code.last_refusal(task_id) or "it needs the plan"
            return {"blocked": f"the piece's builder stopped: {why}"[:500], "by": member.get("assignee"),
                    **({"goal_reason": refused["goal_reason"]} if refused.get("goal_reason") else {}),
                    **({"check_failure": check} if check else {})}
        nxt = mrun["next_action"] or ""
        if not nxt.startswith("(tell member-ready"):
            return None                                  # still working
        cand = mrun["candidate"]
        piece = body["piece"]
        rec = self._members(run).get(piece) or {}
        if rec.get("task_id") == task_id and rec.get("seen") == cand:
            return None                                  # the candidate the plan already has (before a refix lands)
        try:
            await self.ports.space.adopt_checkpoint(run, piece, cand, self.allowed(run, piece))
        except ScopeError as exc:
            return {"blocked": str(exc)[:500]}
        except Exception as exc:
            return {"unknown": f"the member's candidate could not be read: {exc}"[:300]}
        self._remember(run, piece, dict(rec, task_id=task_id, cand=cand, seen=cand))
        member = json.loads(mrun["member"]) if mrun["member"] else {}
        # the builder's own words about the change (a check that looked wrong, a part left out), recorded with the
        # piece where its reviewer and the person read them; before, they stayed in the member's journal
        summary = self.code.member_summary(task_id, cand)
        return {"candidate": cand, "files": sorted(member.get("paths") or []),
                "summary": summary or f"built by per-change member {task_id}", "by": member.get("assignee")}

    async def integrated(self, run, piece, op, cand, ckpt):
        """Deliver the member whose candidate the plan integrated. Idempotent: an already delivered member is only
        marked; the member's own journal refuses a second `integrated` for the same op."""
        rec = self._members(run).get(piece)
        if not rec or rec.get("cand") != cand or rec.get("integrated"):
            return
        mrun = self._member_run(rec["task_id"])
        if mrun is not None and mrun["phase"] not in TERMINAL:    # an ended member (the plan rested) stays ended
            await self.code.member_integrated(rec["task_id"], op, cand, ckpt)
        self._remember(run, piece, dict(rec, integrated=True))   # the space's merge already let the fork go: a later
                                                                  # fix is a new member on a fresh fork

    def _landed(self, run, cand):
        """(op, ckpt) when the plan's journal holds an accepted `integrated` for this candidate, else None."""
        pid = run["plan_id"]
        for e in self.engine._effects(pid):
            if e["kind"] != "integrate" or self.engine._body(e).get("candidate") != cand:
                continue
            row = self.engine.db.one("SELECT verdict, evidence FROM create_plan_journal WHERE plan_id = ? AND obs_id = ?",
                                     (pid, f"integrated:{e['op']}"))
            if row and row["verdict"] == "accepted":
                ck = (json.loads(row["evidence"] or "{}") or {}).get("ckpt")
                if ck:
                    return e["op"], ck
        return None

    async def deliver_landed(self, run):
        """Every member whose candidate the journal says was integrated, but which was not delivered (a crash between
        the journal entry and member_integrated): delivered now."""
        for piece, rec in self._members(run).items():
            if rec.get("cand") and not rec.get("integrated"):
                landed = self._landed(run, rec["cand"])
                if landed:
                    await self.integrated(run, piece, landed[0], rec["cand"], landed[1])

    async def settle(self, run):
        """After every plan step (and so on resume): lost deliveries made again; members ended when the plan rests."""
        await self.deliver_landed(run)
        phase = str(self.engine._run(run["plan_id"])["phase"])
        if phase in RESTING:
            await self.end_all(run, f"the plan is {phase}")

    async def end_all(self, run, why):
        attempts = dict(self._space(run).get("member_attempts") or {})
        for piece, rec in self._members(run).items():
            mrun = self._member_run(rec["task_id"])
            if mrun is not None and mrun["phase"] not in TERMINAL:
                try:
                    await self.code.member_budget_ended(rec["task_id"], why)
                    attempts[rec["op"]] = attempts.get(rec["op"], 0) + 1     # a re-dispatch gets a fresh member
                except Exception:                        # the plan's rest stands; the member is ended on a later step
                    log.exception("create plan %s: ending member %s failed", run["plan_id"], rec["task_id"])
        if attempts != (self._space(run).get("member_attempts") or {}):
            self.engine._space_set(run["plan_id"], member_attempts=attempts)

    async def readback(self, run, body, goal_id):
        task_id = goal_id.split(":", 1)[1]
        mrun = self._member_run(task_id)
        rec = self._members(run).get(body.get("piece")) or {}
        if mrun is not None and mrun["phase"] not in TERMINAL:
            await self.code.member_budget_ended(task_id, "the plan reconciled this piece's lost operation")
            if rec.get("task_id") == task_id:            # the lost build's re-dispatch gets a fresh member
                attempts = dict(self._space(run).get("member_attempts") or {})
                attempts[rec["op"]] = attempts.get(rec["op"], 0) + 1
                self.engine._space_set(run["plan_id"], member_attempts=attempts)
        return {"member": task_id, "phase": mrun["phase"] if mrun else None}

    # ---- the member's test: the plan's acceptance check -----------------------------------------------------------

    def check_for(self, run, piece, cand):
        """The acceptance check's outcome on a piece's candidate, for its review packet: "passed", "failed" or
        "not run" (no finished run, or one that gave no verdict), with what the run said. "passed" is the piece's own
        pass: the check passed, or failed only on files other pieces own (they may not be built yet)."""
        task_id = (self._members(run).get(piece) or {}).get("task_id")
        got = self.code.member_check(task_id, cand) if task_id else None
        if not got or got.get("passed") not in (True, False):
            return {"check": "not run"}
        logs = got.get("logs") or {}
        return {"check": "passed" if got["passed"] else "failed",
                "check_detail": {"outcome": got.get("outcome"), "exit_code": got.get("exit_code"),
                                 "output": str((logs.get("stdout") or {}).get("text") or "")[:1500]}}

    async def run_test(self, member_run, cand):
        m = json.loads(member_run["member"])
        run = self.engine._run(m["plan_id"])
        space = self.engine._space(run)
        try:
            await self.ports.space.adopt_checkpoint(run, m["piece"], cand, self.allowed(run, m["piece"]))
            out = await self.ports.run_check(run, cand, space.get("suite"), space.get("base"))
        except ScopeError as exc:                        # never tested: a definite refusal (the member blocks)
            return {"refused": str(exc)[:500]}
        except Exception as exc:
            return {"passed": None, "outcome": "unknown", "stderr": str(exc)[:500]}
        if out.get("outcome") == "pass":
            passed = True
        elif out.get("outcome") == "fail":
            out = counted_check(out, self._built(run, m))
            passed = not (set(out.get("failing") or []) & set(m["paths"]))   # only other pieces' files still fail
        else:
            passed = None
        return {"passed": passed, "outcome": out.get("outcome"), "exit_code": out.get("exit_code"),
                "stdout": out.get("output") or out.get("line") or "", "stderr": "", "argv": ["create-acceptance-check"],
                "failing": out.get("failing"), "notes": out.get("notes"), "waits": out.get("waits")}

    def _built(self, run, m):
        """The files a check's case may count against member `m`'s piece for: its own, and the files of the plan's
        pieces already integrated. Time: one pass over the plan's pieces."""
        integrated = {piece for piece, rec in self._members(run).items() if rec.get("integrated")}
        plan = self.engine._plan(run["plan_id"]) or {}
        return set(m["paths"]) | {f for p in plan.get("pieces", []) if p.get("id") in integrated
                                  for f in p.get("files", [])}
