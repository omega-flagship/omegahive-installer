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
    files the piece does not own (the other pieces are not built yet): the piece's part is satisfied;
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

from .create_plan_ports import CHECK_PATH, ScopeError

log = logging.getLogger(__name__)

TERMINAL = ("delivered", "stopped")
RESTING = ("blocked", "stopped", "deployed")             # plan phases in which no member should keep working
BRIEF_TEXT, BRIEF_ANSWERS, BRIEF_FAILING = 3000, 12000, 16000   # characters; the member's brief limit is 40000


def _bounded(value, limit):
    """value as it is when its JSON is at most `limit` characters; else {"truncated": true, "text": <the first
    limit characters of its JSON>} so the mind knows it saw only part of it."""
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if len(text) <= limit:
        return value
    return {"truncated": True, "chars": len(text), "text": text[:limit]}


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
                "failing": _bounded(failing, BRIEF_FAILING)}

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
            return {"blocked": f"the piece's member is blocked ({mrun['last_error'] or 'needs the plan'})"}
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
        return {"candidate": cand, "files": sorted(member.get("paths") or []),
                "summary": f"built by per-change member {task_id}", "by": member.get("assignee")}

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
            passed = not (set(out.get("failing") or []) & set(m["paths"]))   # only other pieces' files still fail
        else:
            passed = None
        return {"passed": passed, "outcome": out.get("outcome"), "exit_code": out.get("exit_code"),
                "stdout": out.get("output") or out.get("line") or "", "stderr": "", "argv": ["create-acceptance-check"],
                "failing": out.get("failing")}
