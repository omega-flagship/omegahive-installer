"""Create plan members: one plan piece run as a coding controller in its own right (reducer R3.14, profile plan-member).

Host mapping: modules/code/controller/R3_14_HOST_MAPPING.md. The decisions stay in the reducer; this module performs a
member's actions and journals what it observed, through the same engine journal (code_controller_engine.py):

  adopt_member                     a run with no minds request: the run row carries the piece's origin (the plan's Code
                                   task, the person's grant, the piece fork), its paths, its assignee and its budget ref
                                   (the Ctx epoch slot); profile plan-member, policy plan-reviewed | review-required
  (do (piece-open t))              the piece fork is read in the person's scope; `opened`
  (do (host-read g))               the piece's own files are read; `read` (no model)
  (think make-the-smallest-change | repair-from-the-failing-output)
                                   `think-started (attempt assignee)`, then a goal for the piece's assignee with a packet
                                   (its paths, their current text, the failing reference on a repair). Its finished goal
                                   carries {"files": {path: text}}: only in-piece paths are written to the fork and
                                   checkpointed, then `changed (ckpt ())`; anything else is `think-failed` (one repair)
  propose_member_edit              a model's edit proposal outside a think: `proposed (pid edit d)`; at selection the
                                   host checks the paths: out of piece -> `scope-refused (pid)`, else selected, executed
                                   (`proposal-executing` / `proposal-done`), written and `changed`
  (do (code-exec t))               `dispatched`, then the plan's test port on the candidate; tests-pass / -fail / unknown
  (do (review-request c))          (review-required only) the engine's second opinion, with a member packet
  (tell member-ready c)            event code.controller.member_ready {plan_id, piece, cand}; nobody is asked to apply
  member_integrated / member_refix the plan's callbacks: `integrated (op cand ckpt)` (the only delivery) and
                                   `member-refix (op cand failing-ref)` (one repair, the failing output kept as evidence)
  member_budget_ended              `cancelled`

There are no person routes for a member: the person speaks to the plan. The engine's Apply / Ask for changes / Discard
refuse a member run (profile gate), and the reducer refuses approval, apply and changes kinds under plan-member.
"""
from __future__ import annotations

import hashlib
import json

from .db import new_id, now

PROFILE = "plan-member"
POLICIES = ("plan-reviewed", "review-required")


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class MemberPorts:
    """The member's I/O. open/read/write go through the person relay (Code.proxy) on the plan's task with the person's
    grant, as the plan engine's OmegaCodeSpace does. run_test is the plan's: a Create piece is tested by the plan's
    acceptance check, which the plan engine registers here (engine.member_ports.run_test = ...). Until it does, a test
    cannot run and the member says so (a definite refusal), never a pass."""

    def __init__(self, engine):
        self.engine, self.hive = engine, engine.hive
        self.run_test = None            # async (run, cand) -> {"passed": bool, "exit_code", "stdout", "stderr", "argv"}

    def _origin(self, run):
        return member_of(run)["origin"]

    async def _call(self, run, method, path, body=None, query=None):
        o = self._origin(run)
        status, raw, _ = await self.hive.code.proxy(run["person"], method, path, dict(query or {}),
                                                    None if body is None else json.dumps(body).encode(),
                                                    o["task_id"], o["grant_id"], o["repository_id"])
        try:
            return status, json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return status, None

    async def open(self, run):
        o = self._origin(run)
        status, ws = await self._call(run, "GET", f"/v1/workspaces/{o['workspace_id']}")
        if status != 200 or not isinstance(ws, dict):
            return {"refused": f"the piece fork could not be read ({status})"}
        return {"workspace_id": ws.get("id"), "generation": ws.get("generation"), "tree_digest": ws.get("tree_digest")}

    async def read(self, run):
        """{path: {"content": text | None, "digest": hex | None}} for the piece's own paths (a new file is None)."""
        o, out = self._origin(run), {}
        for path in member_of(run)["paths"]:
            status, row = await self._call(run, "GET", f"/v1/workspaces/{o['workspace_id']}/files", query={"path": path})
            out[path] = ({"content": row["content"], "digest": row.get("digest")}
                         if status == 200 and isinstance(row, dict) and isinstance(row.get("content"), str)
                         else {"content": None, "digest": None})
        return out

    async def write(self, run, files, label):
        """One guarded patch of in-piece files onto the fork (each edit's expected digest is the file's current one),
        then a checkpoint: its id is the candidate."""
        o = self._origin(run)
        status, ws = await self._call(run, "GET", f"/v1/workspaces/{o['workspace_id']}")
        if status != 200:
            raise RuntimeError(f"the piece fork could not be read ({status})")
        current = await self.read(run)
        edits = [{"path": p, "expected_digest": (current.get(p) or {}).get("digest"), "content": text}
                 for p, text in sorted(files.items())]
        op = f"cce.member.{run['request_id'][3:19]}.{new_id('x')[2:14]}"
        status, value = await self._call(run, "POST", f"/v1/workspaces/{o['workspace_id']}/patches",
                                         {"operation_id": op + ".patch", "expected_generation": ws["generation"],
                                          "expected_tree_digest": ws["tree_digest"], "edits": edits})
        if status not in (200, 201):
            raise RuntimeError(f"the piece patch was refused ({status} {(value or {}).get('error')})")
        status, ws = await self._call(run, "GET", f"/v1/workspaces/{o['workspace_id']}")
        status, cp = await self._call(run, "POST", f"/v1/workspaces/{o['workspace_id']}/checkpoints",
                                      {"operation_id": op + ".ck", "expected_generation": ws["generation"],
                                       "expected_tree_digest": ws["tree_digest"], "label": label[:200]})
        if status not in (200, 201) or not isinstance(cp, dict) or not cp.get("id"):
            raise RuntimeError(f"the piece checkpoint was refused ({status})")
        return {"ckpt": cp["id"], "generation": cp.get("generation"), "files": sorted(files)}


def member_of(run):
    return json.loads(run["member"]) if run and run["member"] else None


def is_member(run):
    return bool(run) and run["profile"] == PROFILE


# ---- adoption and the plan's callbacks ----------------------------------------------------------------------------

def adopt_member(engine, plan_id, piece, origin, paths, assignee, budget_ref, review_policy, person,
                 controller_id=None, task=None, brief=None):
    """A member run with no minds request. Idempotent for (plan_id, piece, task). Returns {"task_id": ...}.
    `brief` is what the plan asks of the piece (the person's sentence, the piece's title and brief, the acceptance
    criteria, the person's answers, a fix's failing output): data the helper's packet carries, never a decision."""
    from .code_controller_engine import EngineError, MAX_REPAIRS, REDUCER_SHA256, q
    if review_policy not in POLICIES:
        raise EngineError(f"a member's review policy is one of {list(POLICIES)}", 400, "bad_request")
    for key in ("task_id", "grant_id", "repository_id", "workspace_id"):
        if not isinstance(origin, dict) or not isinstance(origin.get(key), str) or not origin[key]:
            raise EngineError(f"origin.{key} is required", 400, "bad_request")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p and ".." not in p.split("/")
                                                           and not p.startswith("/") for p in paths):
        raise EngineError("paths are the piece's own relative file paths", 400, "bad_request")
    for ref in (plan_id, piece, budget_ref, assignee, person):
        q(ref)                                                   # every reference the reducer carries is checked
    if engine.hive.db.one("SELECT 1 FROM agents WHERE id = ? AND deleted = 0", (assignee,)) is None:
        raise EngineError("the piece's assignee is not a mind of this hive", 404, "assignee_unknown")
    task_id = "mt_" + hashlib.sha256(f"{plan_id}|{piece}|{task or budget_ref}".encode()).hexdigest()[:32]
    member = {"plan_id": plan_id, "piece": piece, "origin": {k: origin[k] for k in (
        "task_id", "grant_id", "repository_id", "workspace_id")}, "paths": sorted(set(paths)), "assignee": assignee,
        "budget_ref": budget_ref}
    if brief is not None:
        if not isinstance(brief, dict) or len(_canonical(brief)) > 40000:
            raise EngineError("brief is a JSON object of at most 40000 characters", 400, "bad_request")
        member["brief"] = brief
    at = now()
    engine.db.execute("INSERT OR IGNORE INTO code_controller_runs (request_id, lease_id, controller_id, person, profile, "
                      "max_repairs, reducer_sha256, phase, status, candidate, next_action, review, last_error, created_at, "
                      "updated_at, review_policy, member) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', 'accepted', NULL, NULL, "
                      "NULL, NULL, ?, ?, ?, ?)",
                      (task_id, budget_ref, controller_id or f"plan:{plan_id}", person, PROFILE, MAX_REPAIRS,
                       REDUCER_SHA256, at, at, review_policy, _canonical(member)))
    engine.kick(task_id)
    return {"task_id": task_id, "plan_id": plan_id, "piece": piece}


def _member_run(engine, task_id):
    from .code_controller_engine import EngineError
    run = engine._run(task_id)
    if not is_member(run):
        raise EngineError("no such plan member", 404, "not_found")
    return run


async def integrated(engine, task_id, op, cand, ckpt):
    """The plan integrated this member's candidate at checkpoint ckpt: the only delivery of a member."""
    from .code_controller_engine import q, render_any
    async with engine._lock(task_id):
        run = _member_run(engine, task_id)
        verdict = await engine.observe(run, f"integrated-{op}", "integrated", [q(op), q(cand), q(ckpt)],
                                       {"ckpt": ckpt, "by": "plan"})
        await engine._step(task_id)
    return {"verdict": render_any(verdict), **(engine.view(task_id) or {})}


async def refix(engine, task_id, op, cand, failing_ref, failing=None):
    """The plan's check (or review, or merge) failed for the member-ready candidate: one repair, with the failing output
    kept as evidence for the helper's repair prompt."""
    from .code_controller_engine import q, render_any
    async with engine._lock(task_id):
        run = _member_run(engine, task_id)
        verdict = await engine.observe(run, f"member-refix-{op}", "member-refix", [q(op), q(cand), q(failing_ref)],
                                       {"failing_ref": failing_ref, "failing": failing, "by": "plan"})
        await engine._step(task_id)
    return {"verdict": render_any(verdict), **(engine.view(task_id) or {})}


async def budget_ended(engine, task_id, why="the plan's budget for this piece ended"):
    async with engine._lock(task_id):
        run = _member_run(engine, task_id)
        verdict = await engine.observe(run, f"budget-ended-{engine._next(task_id, 'budget-ended')}", "cancelled", [],
                                       {"reason": why})
        await engine._step(task_id)
    return verdict


async def propose_edit(engine, task_id, files, by):
    """A model's edit proposal for the piece outside a think (R3.8 path): journalled as `proposed (pid edit d)` with the
    files kept in its effect row. Selection checks the paths (scope-refused when any is outside the piece)."""
    from .code_controller_engine import EngineError, q, render_any
    if not isinstance(files, dict) or not files or not all(isinstance(k, str) and isinstance(v, str) for k, v in files.items()):
        raise EngineError("files is {path: text}", 400, "bad_request")
    async with engine._lock(task_id):
        run = _member_run(engine, task_id)
        n = engine._next(task_id, "proposed")
        pid, digest = f"prop-{n}", "sha256:" + hashlib.sha256(_canonical(files).encode()).hexdigest()
        verdict, effect = await engine.observe(run, f"proposed-{n}", "proposed", [q(pid), "edit", q(digest)],
                                               {"paths": sorted(files), "by": by},
                                               effect=("proposal", {"pid": pid, "digest": digest, "files": files, "by": by}))
        if engine.accepted(verdict):
            await engine._step(task_id)
    return {"verdict": render_any(verdict), "pid": pid}


# ---- actions ------------------------------------------------------------------------------------------------------

async def act(engine, run, view, action):
    """A member's next action; True when something was journalled and the loop should reduce again."""
    from .code_controller_engine import EngineError
    tid, head = run["request_id"], action[0]
    if head == "rest":
        if action == ["rest", "awaiting-helper"]:
            for e in engine._effects(tid, "helper"):
                if e["state"] == "journaled":
                    return await _helper_effect(engine, run, e)
        if action == ["rest", "awaiting-results"]:
            for e in engine._effects(tid):
                if e["state"] == "journaled" and e["kind"] == "test":
                    return await _test_effect(engine, run, e)
                if e["state"] == "journaled" and e["kind"] == "review":
                    return await engine._deliver_review(run, e)
        return False
    if head == "tell" and action[1] == "member-ready":
        cand = str(action[2])
        if not engine.db.one("SELECT 1 FROM code_controller_effects WHERE request_id = ? AND kind = 'tell' AND "
                             "json_extract(body, '$.candidate') = ?", (tid, cand)):
            effect = engine._effect_new(tid, "tell", {"candidate": cand})
            engine._effect_set(effect["id"], "done")
            m = member_of(run)
            engine.hive.events.publish("code.controller.member_ready", plan_id=m["plan_id"], piece=m["piece"],
                                       cand=cand, task_id=tid)
        return False
    if head == "think":
        if action[1] in ("make-the-smallest-change", "repair-from-the-failing-output"):
            return await _think(engine, run, action[1])
        raise EngineError(f"no member mapping for (think {action[1]})")
    if head == "do":
        name, what = action[1][0], action[1]
        if name == "piece-open":
            return await _open(engine, run)
        if name == "host-read":
            return await _read(engine, run, str(what[1]))
        if name == "code-exec":
            return await _test(engine, run)
        if name == "review-request":
            return await engine._review(run, str(what[1]))
        if name == "select-proposal":
            return await _select(engine, run, str(what[1]))
        if name == "execute-proposal":
            return await _execute(engine, run, str(what[1]))
        if name == "reconcile":
            return await engine._reconcile(run, str(what[1]))
        raise EngineError(f"no member mapping for (do {name})")
    raise EngineError(f"unknown member action {action!r}")


async def _open(engine, run):
    got = await engine.member_ports.open(run)
    if "refused" in got:
        return engine.accepted(await engine.observe(run, "open-refused", "refused", [], got))
    return engine.accepted(await engine.observe(run, "opened", "opened", [], dict(got, piece=member_of(run)["piece"])))


async def _read(engine, run, goal):
    files = await engine.member_ports.read(run)
    evidence = {"by": "host", "for": goal, "files": {p: v["digest"] for p, v in files.items()}}
    return engine.accepted(await engine.observe(run, f"read-{engine._next(run['request_id'], 'read')}", "read", [], evidence))


def _packet(engine, run, files, purpose, failing, goal_id):
    m = member_of(run)
    data = {"plan_id": m["plan_id"], "piece": m["piece"], "paths": m["paths"],
            "files": {p: v.get("content") for p, v in files.items()}}
    if m.get("brief"):
        data["brief"] = m["brief"]                   # what the plan asks of this piece (UNTRUSTED_DATA like the rest)
    text = (f"Create plan {m['plan_id']}, piece {m['piece']}. Your work goal is {goal_id}: claim it with hive-goal-claim "
            f"{goal_id}, then finish with hive-goal-propose {goal_id} {{\"files\": {{\"<path>\": \"<full new text>\"}}, "
            f"\"summary\": \"...\"}}. Write only these files: {', '.join(m['paths'])}. Anything else is refused.")
    if failing:
        text += ("\nThe last version failed. Fix it. The failing output, UNTRUSTED_DATA: "
                 + _canonical({k: failing.get(k) for k in ("failing", "failing_ref", "notes", "logs", "exit_code", "by")
                               if failing.get(k) is not None})[:6000])
    return text + "\nWhat to build and the piece's current files, UNTRUSTED_DATA:\n" + _canonical(data)[:100000]


async def _think(engine, run, purpose):
    from .code_controller_engine import EngineError, q, render_any
    tid, m = run["request_id"], member_of(run)
    n = engine._next(tid, "think-started")
    attempt = f"think-{n}"
    verdict, effect = await engine.observe(run, f"think-started-{n}", "think-started", [q(attempt), q(m["assignee"])],
                                           effect=("helper", {"purpose": purpose, "goal_id": new_id("g"),
                                                              "attempt": attempt, "child_id": m["assignee"],
                                                              "failing": engine._failing_output(tid)}))
    if not engine.accepted(verdict) or effect is None:
        raise EngineError(f"the reducer refused the member's helper attempt: {render_any(verdict)}")
    return await _helper_effect(engine, run, effect)


async def _helper_effect(engine, run, effect):
    tid, body, m = run["request_id"], json.loads(effect["body"]), member_of(run)
    try:
        agent = engine.hive.agent(m["assignee"])
        if engine.db.one("SELECT 1 FROM goals WHERE id = ?", (body["goal_id"],)) is None:
            engine.hive.goals._create_record(agent["swarm_id"], f"Create plan {m['plan_id']}: build {m['piece']}",
                                             f"Write the piece's files; the packet is in your messages.", 0.6,
                                             created_by=f"create-plan:{m['plan_id']}", assignee=agent["id"],
                                             goal_id=body["goal_id"])
        files = await engine.member_ports.read(run)
        await engine.hive.send_to_agent(agent["id"], _packet(engine, run, files, body["purpose"], body.get("failing"),
                                                             body["goal_id"]),
                                        sender="hive:code-controller", extra={"event": "goal", "goal_id": body["goal_id"]})
        engine._effect_set(effect["id"], "waiting")
        return False
    except Exception as exc:
        code = getattr(exc, "code", None) or type(exc).__name__
        return engine.accepted(await engine._think_failed(run, effect, {"reason": str(code), "stage": "assign"}))


async def helper_result(engine, run, effect, goal_id):
    """The assignee's goal changed: only in-piece files are written; then `changed (ckpt ())`."""
    from .code_controller_engine import q, render_any
    m = member_of(run)
    goal = engine.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
    if goal["status"] in ("failed", "cancelled"):
        return await engine._think_failed(run, effect, {"goal_status": goal["status"]})
    if goal["status"] not in ("done", "submitted"):
        return None
    if goal.get("claimed_by") != m["assignee"]:
        return await engine._think_failed(run, effect, {"reason": "finished_by_someone_else"})
    data = json.loads(goal["result_data"] or "null") if goal.get("result_data") else None
    files = (data or {}).get("files") if isinstance(data, dict) else None
    if not isinstance(files, dict) or not files or not all(isinstance(k, str) and isinstance(v, str) for k, v in files.items()):
        return await engine._think_failed(run, effect, {"reason": "no_files"})
    outside = sorted(set(files) - set(m["paths"]))
    if outside:                                  # the host never journals an out-of-piece change
        return await engine._think_failed(run, effect, {"reason": "outside_the_piece", "paths": outside})
    try:
        before = {k: v["content"] for k, v in (await engine.member_ports.read(run)).items() if k in files}
        wrote = await engine.member_ports.write(run, files, f"{m['piece']} attempt {json.loads(effect['body'])['attempt']}")
    except Exception as exc:
        return await engine._think_failed(run, effect, {"reason": "write_refused", "detail": str(exc)[:300]})
    verdict = await engine.observe(run, f"changed-{wrote['ckpt']}", "changed", [q(wrote["ckpt"]), []],
                                   dict(wrote, by=m["assignee"], summary=str((data or {}).get("summary") or "")[:2000],
                                        files_text={k: v[:20000] for k, v in files.items()},
                                        before={k: (v or "")[:20000] for k, v in before.items()}))
    if not engine.accepted(verdict):
        return await engine._think_failed(run, effect, {"reason": "candidate_rejected", "verdict": render_any(verdict)})
    engine._effect_set(effect["id"], "done", {"candidate": wrote["ckpt"]})
    return verdict


async def _select(engine, run, pid):
    from .code_controller_engine import q
    tid, m = run["request_id"], member_of(run)
    effect = engine.db.one("SELECT * FROM code_controller_effects WHERE request_id = ? AND kind = 'proposal' AND "
                           "json_extract(body, '$.pid') = ?", (tid, pid))
    body = json.loads(effect["body"])
    outside = sorted(set(body["files"]) - set(m["paths"]))
    if outside:                                  # checked at selection, before any execution (R3.14)
        engine._effect_set(effect["id"], "refused", {"outside": outside})
        return engine.accepted(await engine.observe(run, f"scope-refused-{pid}", "scope-refused", [q(pid)],
                                                    {"outside": outside}))
    return engine.accepted(await engine.observe(run, f"proposal-selected-{pid}", "proposal-selected",
                                                [q(pid), "edit", q(body["digest"])], {"paths": sorted(body["files"])}))


async def _execute(engine, run, pid):
    from .code_controller_engine import q
    tid, m = run["request_id"], member_of(run)
    effect = engine.db.one("SELECT * FROM code_controller_effects WHERE request_id = ? AND kind = 'proposal' AND "
                           "json_extract(body, '$.pid') = ?", (tid, pid))
    body = json.loads(effect["body"])
    op = f"exec-{engine._next(tid, 'proposal-executing')}"
    if not engine.accepted(await engine.observe(run, f"proposal-executing-{pid}", "proposal-executing", [q(pid), q(op)])):
        return True
    try:
        before = {k: v["content"] for k, v in (await engine.member_ports.read(run)).items() if k in body["files"]}
        wrote = await engine.member_ports.write(run, body["files"], f"{m['piece']} proposal {pid}")
    except Exception as exc:
        engine._effect_set(effect["id"], "unknown", {"detail": str(exc)[:300]})
        return engine.accepted(await engine.observe(run, f"unknown-{op}", "unknown", [q(op)], {"detail": str(exc)[:300]}))
    await engine.observe(run, f"proposal-done-{pid}", "proposal-done", [q(pid), q(op)], wrote)
    engine._effect_set(effect["id"], "done", wrote)
    return engine.accepted(await engine.observe(run, f"changed-{wrote['ckpt']}", "changed", [q(wrote["ckpt"]), []],
                                                dict(wrote, by=body.get("by"),
                                                     files_text={k: v[:20000] for k, v in body["files"].items()},
                                                     before={k: (v or "")[:20000] for k, v in before.items()})))


async def _test(engine, run):
    from .code_controller_engine import EngineError, q, render_any
    tid = run["request_id"]
    cand = run["candidate"]
    n = engine._next(tid, "disp-run")
    run_id = f"run-{n}"
    verdict, effect = await engine.observe(run, f"disp-{run_id}", "dispatched", [q(run_id), "test", q(cand)],
                                           effect=("test", {"run_id": run_id, "candidate": cand}))
    if not engine.accepted(verdict) or effect is None:
        raise EngineError(f"the reducer refused the member test dispatch: {render_any(verdict)}")
    return await _test_effect(engine, run, effect)


async def _test_effect(engine, run, effect):
    from .code_controller_engine import q
    body = json.loads(effect["body"])
    cand, run_id = body["candidate"], body["run_id"]
    port = engine.member_ports.run_test
    if port is None:
        engine._effect_set(effect["id"], "refused", {"reason": "no plan test port"})
        return engine.accepted(await engine.observe(run, f"refused-{run_id}", "refused", [],
                                                    {"reason": "no test runner is registered for plan members"}))
    try:
        result = await port(run, cand)
    except Exception as exc:
        engine._effect_set(effect["id"], "unknown", {"detail": str(exc)[:300]})
        return engine.accepted(await engine.observe(run, f"unknown-{run_id}", "unknown", [q(run_id)],
                                                    {"detail": str(exc)[:300]}))
    if result.get("refused"):                    # the plan refuses to test this candidate (a definite answer)
        engine._effect_set(effect["id"], "refused", {"reason": str(result["refused"])[:300]})
        return engine.accepted(await engine.observe(run, f"refused-{run_id}", "refused", [],
                                                    {"reason": str(result["refused"])[:500]}))
    evidence = {k: result.get(k) for k in ("passed", "exit_code", "argv", "outcome")} | {
        "logs": {s: {"text": str(result.get(s) or "")[:2000]} for s in ("stdout", "stderr")}}
    engine._effect_set(effect["id"], "done", evidence)
    if result.get("passed") is True:
        kind = "tests-pass"
    elif result.get("passed") is False:
        kind = "tests-fail"
    else:
        return engine.accepted(await engine.observe(run, f"unknown-{run_id}", "unknown", [q(run_id)], evidence))
    return engine.accepted(await engine.observe(run, f"{kind}-{run_id}", kind, [q(cand), q(run_id)], evidence))


async def review_packet(engine, run, cand, goal_id):
    """A member's second opinion packet (review-required): the piece, its candidate's files and a unified diff from the
    text the piece started with, and the test evidence. Read-only; UNTRUSTED_DATA to the reviewer."""
    import difflib
    tid, m = run["request_id"], member_of(run)
    changed = engine.db.one("SELECT evidence FROM code_controller_journal WHERE request_id = ? AND kind = 'changed' AND "
                            "fields LIKE ? ORDER BY seq DESC LIMIT 1", (tid, f'("{cand}"%'))
    ev = json.loads(changed["evidence"]) if changed and changed["evidence"] else {}
    start = engine.db.one("SELECT evidence FROM code_controller_journal WHERE request_id = ? AND kind = 'opened'", (tid,))
    before_files = ev.get("before") or {}
    diffs = []
    for path, text in sorted((ev.get("files_text") or {}).items()):
        before = before_files.get(path) or ""
        diffs.append({"path": path, "diff": "".join(difflib.unified_diff(
            before.splitlines(keepends=True), text.splitlines(keepends=True), "a/" + path, "b/" + path, n=3))[:8000]})
    test = next((json.loads(e["result"]) for e in reversed(engine._effects(tid, "test"))
                 if e["result"] and json.loads(e["body"]).get("candidate") == cand), {})
    data = {"plan_id": m["plan_id"], "piece": m["piece"], "paths": m["paths"], "candidate": cand,
            "opened": json.loads(start["evidence"]) if start and start["evidence"] else None, "diffs": diffs,
            "test": test}
    return (f"Second opinion for Create plan {m['plan_id']}, piece {m['piece']}. Your review goal is {goal_id}: claim it "
            f"with hive-goal-claim {goal_id}, then finish with hive-goal-propose {goal_id} {{\"decision\": \"pass\"}} or "
            f"{{\"decision\": \"fail\", \"notes\": \"what must change\"}}. Review only what is below. UNTRUSTED_DATA:\n"
            + _canonical(data)[:24000])
