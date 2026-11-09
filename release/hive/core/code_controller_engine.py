"""Create - Code: the MeTTa coding controller drives every Code request (host side of R3.12, root-suggest profile).

The procedure and every decision live in the vendored reducer modules/code/controller/coding_controller_r3_12.metta
(R3.12, sha-pinned below, run unchanged in a disposable PeTTa child; R3.11.5 stays vendored beside it and still replays
runs adopted under it). Host mapping: modules/code/controller/R3_12_HOST_MAPPING.md. This module only:
  - journals observations (O id kind task epoch fields) per request, insert-only, idempotent by id, BEFORE any effect
    they authorize (a rejected observation means the effect is never performed); effect rows commit with them;
  - replays the journal through the reducer (Ctx: the authors set and the person's review policy) to get the state and
    `next-action-for root-suggest`;
  - performs the action with the host functions that already exist, as itself (code_controller_client.py: its own
    credential, issued_by host:code-controller-engine, the lease controller's authority exactly), then journals:
      (do (code-open-readonly t))   controller holds the receiving goal (goals.claim); `opened`
      (do (host-read g))            the person's scope is host-known and current; `read` (no model)
      (think make-the-smallest-change | repair-from-the-failing-output)
                                    `think-started (attempt helper)` first, then ONE helper child (minds.spawn with the
                                    foundation helper role) or a re-prompt (minds.prompt); its prompt names
                                    code-helper-instruction. Its finished work goal -> `candidate-retained`; an attempt
                                    with no usable proposal -> `think-failed (attempt)` (one repair)
      (rest awaiting-helper)        wait for the helper's goal event (a journalled attempt resumes after a restart)
      (do (proposal-test c t))      `dispatched`, then prepare + run; `tests-pass` / `tests-fail` / `unknown`
      (do (proposal-review c))      `dispatched`, then a review goal + a complete read-only packet to a second-opinion
                                    mind (never an author); its verdict -> `review-pass` / `review-fail`; no reviewer
                                    that can run -> `review-unavailable (c)` (blocked, or unreviewed under review-waivable)
      (tell confirm-to-apply c | confirm-unreviewed-to-apply c)
                                    the request shows "ready for you" (status + event); nothing is applied
      (do (reconcile op))           a readback first; `reconciled-current (op c)` when it proves the origin untouched and
                                    the candidate current, else `reconciled (op)`
      person's Apply (route)        the person's own consent, `approval-needed` + `approved`, the controller's copy_apply
                                    capability and Code's proposal-applications, then `applied` (the only producer),
                                    `apply-refused (op)` (a definite no: ready again) or `unknown`
      person's Ask for changes      `changes-requested (c person)` with their words; the helper is asked again
      Discard / cancel / lease end  `cancelled`; the receiving goal is closed on delivery and on cancel
A language model is called only through the helper child (think) and the reviewer. Wake-ups are host events (goal
updates, request updates) and finished effects; nothing polls with a model.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import importlib.util
import json
import logging
import os
import pathlib
import re
import shutil
import tempfile

from .db import new_id, now

log = logging.getLogger("hive")

ROOT = pathlib.Path(__file__).resolve().parents[2]
REDUCER = ROOT / "modules/code/controller/coding_controller_r3_14.metta"
REDUCER_SHA256 = "5dafb7b9d942dac3b620b48cf6efe26d762d994ef8628049c65bb0da3aa472d9"   # R3.14 (430/430)
REDUCER_VERSION = "R3.14"
REDUCER_R3_13 = ROOT / "modules/code/controller/coding_controller_r3_13.metta"
REDUCER_R3_13_SHA256 = "0d70b97750eafc8f72a7dad5c99e3783af369b736a095dc311cd7165c889ebdd"   # R3.13 (353/353)
# Earlier pins stay vendored beside it, unchanged; a run adopted under one keeps replaying with it.
REDUCER_R3_12 = ROOT / "modules/code/controller/coding_controller_r3_12.metta"
REDUCER_R3_12_SHA256 = "ce0e22a38977436ede3e1cd89d6bafe25662d7b5f27c9a949979903c9f32e865"   # R3.12 (306/306)
# R3.11.5 stays vendored beside it, unchanged: a run adopted under it keeps replaying with it (its Ctx shape and kinds).
REDUCER_R3_11 = ROOT / "modules/code/controller/coding_controller_r3_11.metta"
REDUCER_R3_11_SHA256 = "3e9770edc7458c476f2b4e5e8bc14f5da956a0f7b9f005d46c15d61f7472d786"   # R3.11.5 SHIP
# 2026-11-09: the four reducers' header comment named an internal note path (mirror scrub); only that comment line changed,
# so a run journalled under the old bytes replays under the new ones. Old sha -> new sha, logic byte-identical otherwise.
REDUCER_SHA_ALIASES = {
    "f7347985e6df4e86df58e786d32a60e604810c31756a6784fb67bab9eaf92029": REDUCER_R3_11_SHA256,
    "10ede004ab373325285db4914be126bed6a1a7d51e7ee22c69dbe2ee58182e24": REDUCER_R3_12_SHA256,
    "dcf7979ba9101d7f4de168f1081132babdf2e02607a401024842323adc5c9368": REDUCER_R3_13_SHA256,
    "caeff1ce1ce27533af07fd5cec90f2229c5cb9dc453f82d4fd7170f818f00d59": REDUCER_SHA256,
}
REDUCERS = {REDUCER_SHA256: (REDUCER, "R3.14"), REDUCER_R3_13_SHA256: (REDUCER_R3_13, "R3.13"),
            REDUCER_R3_12_SHA256: (REDUCER_R3_12, "R3.12"),
            REDUCER_R3_11_SHA256: (REDUCER_R3_11, "R3.11.5")}
REVIEW_POLICIES = ("review-required", "review-waivable")
PROFILE = "root-suggest"
MAX_REPAIRS = 2
TEST_NAME = "default"                  # the operator's one declared test command (simple run form, no words)
MAX_STEPS = 16
SWEEP_SECONDS = 60          # host-only backstop for a dropped event frame: a DB read, never a model or a PeTTa child
REVIEWER_ROLE = "Foundation proposal reviewer"
RESTING = ("ready_for_you", "waiting_for_your_apply", "needs_you", "applied", "stopped")
REF = re.compile(r"[A-Za-z0-9_.:-]{1,160}")
SUGGESTION = re.compile(r"suggestion_[0-9a-f]{32}")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS code_controller_runs (request_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
  controller_id TEXT NOT NULL, person TEXT NOT NULL, profile TEXT NOT NULL, max_repairs INTEGER NOT NULL,
  reducer_sha256 TEXT NOT NULL, phase TEXT, status TEXT NOT NULL, candidate TEXT, next_action TEXT, review TEXT,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS code_controller_journal (request_id TEXT NOT NULL, seq INTEGER NOT NULL,
  obs_id TEXT NOT NULL, kind TEXT NOT NULL, fields TEXT NOT NULL, verdict TEXT NOT NULL, evidence TEXT, at TEXT NOT NULL,
  UNIQUE (request_id, seq), UNIQUE (request_id, obs_id))""",
    """CREATE TRIGGER IF NOT EXISTS code_controller_journal_u BEFORE UPDATE ON code_controller_journal
  BEGIN SELECT RAISE(ABORT, 'the controller journal is insert-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS code_controller_journal_d BEFORE DELETE ON code_controller_journal
  BEGIN SELECT RAISE(ABORT, 'the controller journal is insert-only'); END""",
    # host effects, journalled before they run: helper attempts, test runs, reviews, readbacks, cleanup
    """CREATE TABLE IF NOT EXISTS code_controller_effects (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, kind TEXT NOT NULL,
  seq INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (request_id, kind, seq))""",
]


class EngineError(Exception):
    def __init__(self, message, status=409, code="controller_refused"):
        super().__init__(message)
        self.status, self.code = status, code


# ---- MeTTa text in and out --------------------------------------------------------------------------------------

class Str(str):
    """A quoted MeTTa string (every host id crosses as one; kinds and actions stay symbols)."""


def q(value):
    value = str(value)
    if not REF.fullmatch(value):
        raise EngineError(f"not a reference the controller carries: {value!r}")
    return Str(value)


def render(value):
    if isinstance(value, Str):
        return '"' + value + '"'
    if isinstance(value, bool):
        raise EngineError("no booleans in observations")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (list, tuple)):
        return "(" + " ".join(render(v) for v in value) + ")"
    value = str(value)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", value):
        raise EngineError(f"not a symbol: {value!r}")
    return value


def parse(text):
    tokens, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch in "()":
            tokens.append(ch); i += 1
        elif ch == '"':
            j = text.index('"', i + 1)
            tokens.append(Str(text[i + 1:j])); i = j + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '()"':
                j += 1
            tokens.append(text[i:j]); i = j
    pos = 0

    def read():
        nonlocal pos
        tok = tokens[pos]; pos += 1
        if tok == "(":
            out = []
            while tokens[pos] != ")":
                out.append(read())
            pos += 1
            return out
        if isinstance(tok, Str):
            return tok
        return int(tok) if re.fullmatch(r"-?\d+", tok) else tok

    value = read()
    if pos != len(tokens):
        raise EngineError("trailing reducer output")
    return value


STATE_FIELDS = ("phase", "repairs", "pending", "confirmed", "candidate", "tested", "reviewed", "required", "done",
                "unresolved", "dispatched", "prop", "seen")


def state_view(s):
    if not (isinstance(s, list) and len(s) == 14 and s[0] == "S"):
        raise EngineError("the reducer did not answer a state")
    view = dict(zip(STATE_FIELDS, s[1:]))
    view.pop("seen")
    return view


class Reducer:
    """The vendored reducer in a disposable PeTTa child per call (the shared hive interpreter keeps lib_hive only)."""

    def __init__(self, petta_path, sha=REDUCER_SHA256):
        self.petta = pathlib.Path(petta_path)
        path, self.version = REDUCERS[sha]
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != sha:
            raise EngineError(f"the vendored coding controller is not the pinned {self.version}")
        self.stem, self.raw, self.name = path.stem, raw, path.name
        self._fresh_dir()

    def _fresh_dir(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="code-controller-"))
        (self.dir / self.name).write_bytes(self.raw)

    async def run(self, expr, timeout=60):
        if not (self.dir / self.name).is_file():
            # a temp sweep removed the scratch folder under a long-running hive: made again from the pinned bytes this
            # reducer already verified, never re-read from disk (as the plan engine's reducer does)
            self._fresh_dir()
        path = self.dir / f"q_{new_id('x')}.metta"
        path.write_text(f"!(import! &self {self.stem})\n!{expr}\n", encoding="utf-8")
        env = dict(os.environ, LANG="C.UTF-8")
        env["PATH"] = os.pathsep.join([env.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])
        try:
            proc = await asyncio.create_subprocess_exec("/bin/sh", str(self.petta / "run.sh"), str(path), "--silent",
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                                                        env=env, cwd=str(self.dir))
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        finally:
            with contextlib.suppress(OSError):
                path.unlink()
        lines = [x for x in out.decode("utf-8", "replace").splitlines() if x.strip()]
        if proc.returncode != 0 or len(lines) != 2 or lines[0].strip() != "true":
            raise EngineError(f"the reducer run failed (exit {proc.returncode})")
        return parse(lines[-1])

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def _proposal_client_module():
    spec = importlib.util.spec_from_file_location("code_proposal_controller_engine", ROOT / "modules/code/src/code_proposal.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _digest(value):
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


class CodeControllerEngine:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        if "review_policy" not in {r["name"] for r in self.db.all("PRAGMA table_info(code_controller_runs)")}:
            # R3.12: the person's review policy, fixed per run so every replay uses the same value
            self.db.execute("ALTER TABLE code_controller_runs ADD COLUMN review_policy TEXT NOT NULL DEFAULT 'review-required'")
        if "member" not in {r["name"] for r in self.db.all("PRAGMA table_info(code_controller_runs)")}:
            # R3.14: a Create plan member's origin, paths, assignee and budget ref (code_controller_member.py)
            self.db.execute("ALTER TABLE code_controller_runs ADD COLUMN member TEXT")
        self.db.execute("""CREATE TABLE IF NOT EXISTS code_controller_prefs (principal TEXT PRIMARY KEY,
          review_policy TEXT NOT NULL CHECK (review_policy IN ('review-required', 'review-waivable')), updated_at TEXT NOT NULL)""")
        self._reducers = {}
        self._reducer = None
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()
        self._watch = None
        self._cp = None
        # Hooks (tests replace them; production defaults below)
        # The engine acts as itself (code_controller_client.py): its own per-process credential, never a mind's token.
        from .code_controller_client import ENGINE, EngineCodeClient, new_credential
        self.credential, self.principal = new_credential(), ENGINE
        self.client_factory = lambda run: EngineCodeClient(self, run)
        from .code_controller_member import MemberPorts
        self.member_ports = MemberPorts(self)       # the plan engine registers run_test (its acceptance check)

    # ---- Create plan members (R3.14 plan-member; code_controller_member.py) ---------------------------------------

    def adopt_member(self, plan_id, piece, origin, paths, assignee, budget_ref, review_policy, person,
                     controller_id=None, task=None, brief=None):
        from . import code_controller_member as member
        return member.adopt_member(self, plan_id, piece, origin, paths, assignee, budget_ref, review_policy, person,
                                   controller_id=controller_id, task=task, brief=brief)

    async def member_integrated(self, task_id, op, cand, ckpt):
        from . import code_controller_member as member
        return await member.integrated(self, task_id, op, cand, ckpt)

    async def member_refix(self, task_id, op, cand, failing_ref, failing=None):
        from . import code_controller_member as member
        return await member.refix(self, task_id, op, cand, failing_ref, failing)

    async def member_budget_ended(self, task_id, why="the plan's budget for this piece ended"):
        from . import code_controller_member as member
        return await member.budget_ended(self, task_id, why)

    async def propose_member_edit(self, task_id, files, by):
        from . import code_controller_member as member
        return await member.propose_edit(self, task_id, files, by)

    # ---- switch and wiring --------------------------------------------------------------------------------------

    def enabled(self):
        return bool(getattr(self.hive.settings, "code_controller_engine", False))

    @property
    def reducer(self):
        return self.reducer_for(REDUCER_SHA256)

    def reducer_for(self, sha):
        sha = REDUCER_SHA_ALIASES.get(sha, sha)
        if sha not in self._reducers:
            self._reducers[sha] = Reducer(self.hive.settings.petta_path, sha)
        return self._reducers[sha]

    # ---- the person's own review policy (R3.12 Ctx review-policy) ------------------------------------------------

    def review_policy(self, principal):
        row = self.db.one("SELECT review_policy FROM code_controller_prefs WHERE principal = ?", (principal,))
        return row["review_policy"] if row else "review-required"

    def set_review_policy(self, principal, policy):
        if policy not in REVIEW_POLICIES:
            raise EngineError(f"review_policy is one of {list(REVIEW_POLICIES)}", 400, "bad_request")
        self.db.execute("INSERT INTO code_controller_prefs (principal, review_policy, updated_at) VALUES (?, ?, ?) "
                        "ON CONFLICT(principal) DO UPDATE SET review_policy = excluded.review_policy, "
                        "updated_at = excluded.updated_at", (principal, policy, now()))
        return {"review_policy": policy, "applies_to": "new Code requests"}

    @property
    def cp(self):
        if self._cp is None:
            self._cp = _proposal_client_module()
        return self._cp

    def close(self):
        """At shutdown: stop the watcher and remove the reducer's scratch folder."""
        if self._watch is not None:
            self._watch.cancel()
        for reducer in self._reducers.values():
            reducer.close()
        self._reducers, self._reducer = {}, None

    def receiving_brief(self, rid, to_swarm):
        return (f"Code request {rid} for your team {to_swarm} is run by the host coding controller (MeTTa reducer "
                f"{REDUCER_VERSION}); it holds this goal. There is nothing for a mind to do here.")

    def adopt(self, rid):
        """Called by Minds.instruct after the request row, receiving goal and lease commit (engine switched on)."""
        req = self.hive.minds._request(rid)
        lease = self.hive.minds._request_lease(rid)
        at = now()
        self.db.execute("INSERT OR IGNORE INTO code_controller_runs (request_id, lease_id, controller_id, person, profile, "
                        "max_repairs, reducer_sha256, phase, status, candidate, next_action, review, last_error, created_at, "
                        "updated_at, review_policy) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', 'accepted', NULL, NULL, NULL, NULL, "
                        "?, ?, ?)",
                        (rid, lease["id"], lease["controller_id"], req["from_principal"], PROFILE, MAX_REPAIRS,
                         REDUCER_SHA256, at, at, self.review_policy(req["from_principal"])))
        self.kick(rid)

    def _spawn(self, coro, label):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            coro.close()
            return None
        task = loop.create_task(self._guard(coro, label))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    @staticmethod
    async def _guard(coro, label):
        try:
            return await coro
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("code controller: %s failed", label)

    def kick(self, rid):
        self.ensure_watch()
        return self._spawn(self.step(rid), f"step {rid}")

    def ensure_watch(self):
        if self._watch is None or self._watch.done():
            with contextlib.suppress(RuntimeError):
                self._watch = asyncio.get_running_loop().create_task(self.watch())

    async def watch(self):
        """Host events only (a helper's or reviewer's goal changing, a request changing), each handled as its own task.
        A periodic DB sweep re-finds a finished goal whose frame the bus dropped; it never calls a model."""
        queue = self.hive.events.subscribe()
        try:
            for rid in self.resume_candidates():
                self.kick(rid)
            while True:
                try:
                    raw = await asyncio.wait_for(queue.get(), SWEEP_SECONDS)
                except asyncio.TimeoutError:
                    self.sweep()
                    continue
                self._spawn(self.on_event(json.loads(raw)), "event")
        finally:
            self.hive.events.unsubscribe(queue)

    def resume_candidates(self):
        """Runs to wake at startup: not finished, and either mid-work or holding a journalled/waiting effect. A run that
        rests on the person (ready, waiting for their apply, needs them) costs no PeTTa child until they act."""
        return [r["request_id"] for r in self.db.all("SELECT request_id, status FROM code_controller_runs WHERE phase NOT IN "
                                                     "('delivered', 'stopped') ORDER BY created_at")
                if r["status"] not in RESTING or self._pending_effects(r["request_id"])]

    def _pending_effects(self, rid):
        return self.db.all("SELECT id FROM code_controller_effects WHERE request_id = ? AND state IN ('journaled', "
                           "'waiting')", (rid,))

    def sweep(self):
        for e in self.db.all("SELECT e.kind, json_extract(e.body, '$.goal_id') AS goal_id FROM code_controller_effects e "
                             "JOIN goals g ON g.id = json_extract(e.body, '$.goal_id') WHERE e.state = 'waiting' AND "
                             "e.kind IN ('helper', 'review') AND g.status IN ('done', 'submitted', 'failed', 'cancelled')"):
            handler = self.helper_goal if e["kind"] == "helper" else self.review_goal
            self._spawn(handler(e["goal_id"]), f"sweep {e['goal_id']}")
        # an inconclusive readback is retried here (R3.13: it journals nothing until the readback settles it)
        for r in self.db.all("SELECT request_id FROM code_controller_runs WHERE next_action LIKE '(do (reconcile %' "
                             "AND phase NOT IN ('delivered', 'stopped')"):
            self._spawn(self.step(r["request_id"]), f"readback {r['request_id']}")

    async def on_event(self, frame):
        if frame.get("type") == "goal.updated":
            gid = (frame.get("goal") or {}).get("id")
            effect = self.db.one("SELECT kind FROM code_controller_effects WHERE kind IN ('helper', 'review') AND "
                                 "state = 'waiting' AND json_extract(body, '$.goal_id') = ?", (gid,))
            if effect is not None:
                return await (self.helper_goal(gid) if effect["kind"] == "helper" else self.review_goal(gid))
        elif frame.get("type") == "request.updated":
            rid = (frame.get("request") or {}).get("id")
            run = self._run(rid) if rid else None
            if run is not None and run["phase"] not in ("delivered", "stopped"):
                return await self.step(rid)
        return None

    def _lock(self, rid):
        return self._locks.setdefault(rid, asyncio.Lock())

    # ---- journal ------------------------------------------------------------------------------------------------

    def _run(self, rid):
        return self.db.one("SELECT * FROM code_controller_runs WHERE request_id = ?", (rid,))

    def _journal(self, rid):
        return self.db.all("SELECT * FROM code_controller_journal WHERE request_id = ? ORDER BY seq", (rid,))

    def _authors(self, run):
        """R3.12 Ctx authors: the controller, every helper of the request and each candidate's author (the same set
        _excluded_reviewers computes, so the reducer enforces the exclusion too). It only ever gains fresh child ids."""
        rid = run["request_id"]
        out = [run["controller_id"]]
        if run["member"]:                                   # a plan member's helper is its assignee
            out.append(json.loads(run["member"])["assignee"])
        for r in self.db.all("SELECT id FROM mind_children WHERE request_id = ? ORDER BY seq", (rid,)):
            out.append(r["id"])
        for r in self.db.all("SELECT evidence FROM code_controller_journal WHERE request_id = ? AND kind = "
                             "'candidate-retained' ORDER BY seq", (rid,)):
            child = (_json(r["evidence"]) or {}).get("child_id")
            if child:
                out.append(child)
        return list(dict.fromkeys(out))

    def _ctx(self, run):
        if REDUCER_SHA_ALIASES.get(run["reducer_sha256"], run["reducer_sha256"]) == REDUCER_R3_11_SHA256:     # a run adopted under R3.11.5 keeps its Ctx shape
            return render(["Ctx", q(run["request_id"]), q(run["lease_id"]), q(run["person"]), q(run["controller_id"]),
                           int(run["max_repairs"]), run["profile"]])
        return render(["Ctx", q(run["request_id"]), q(run["lease_id"]), q(run["person"]),
                       [q(a) for a in self._authors(run)], int(run["max_repairs"]), run["profile"],
                       run["review_policy"] or "review-required"])

    async def _reduce(self, run, new=None):
        """(verdict-or-None, state view, action) for the journal (+ one new observation text)."""
        rid = run["request_id"]
        ctx, epoch, task = self._ctx(run), render(q(run["lease_id"])), render(q(rid))
        log_text = "(" + " ".join(f"(O {render(q(r['obs_id']))} {r['kind']} {task} {epoch} {r['fields']})"
                                  for r in self._journal(rid)) + ")"
        tail = f'(next-action-for {run["profile"]} $s2 {task} {render(q(TEST_NAME))})'
        if new is None:
            s2, action = await self.reducer_for(run["reducer_sha256"] or REDUCER_SHA256).run(f"(let $s2 (replay {ctx} (start-state) {log_text}) ($s2 {tail}))")
            return None, state_view(s2), action
        expr = (f"(let $s (replay {ctx} (start-state) {log_text}) (let ($s2 $v) (apply-obs {ctx} $s {new}) "
                f"($v $s2 {tail})))")
        verdict, s2, action = await self.reducer_for(run["reducer_sha256"] or REDUCER_SHA256).run(expr)
        return verdict, state_view(s2), action

    async def observe(self, run, obs_id, kind, fields, evidence=None, effect=None):
        """Journal one observation BEFORE any effect it authorizes; callers hold the request's lock. Returns the reducer's
        verdict. A repeated id answers the verdict it was journalled with (a refusal stays refused; review F1); the same
        id with other fields is a conflicting duplicate. With effect=(kind, body), the effect row is written in the SAME
        transaction as an accepted journal row (review F2), and (verdict, effect row or None) is returned."""
        rid = run["request_id"]
        body = render(fields)
        prior = self.db.one("SELECT * FROM code_controller_journal WHERE request_id = ? AND obs_id = ?", (rid, obs_id))
        if prior is not None:
            verdict = parse(prior["verdict"]) if (prior["kind"], prior["fields"]) == (kind, body) \
                else ["rejected", "conflicting-duplicate"]
            if effect is None:
                return verdict
            row = self.db.one("SELECT * FROM code_controller_effects WHERE request_id = ? AND kind = ? AND "
                              "json_extract(body, '$.obs_id') = ?", (rid, effect[0], obs_id))
            return verdict, row
        new = f"(O {render(q(obs_id))} {kind} {render(q(rid))} {render(q(run['lease_id']))} {body})"
        verdict, _view, _action = await self._reduce(run, new)
        row = None
        with self.db.transaction():
            seq = self.db.one("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM code_controller_journal WHERE request_id = ?",
                              (rid,))["n"]
            self.db.insert("code_controller_journal", {"request_id": rid, "seq": seq, "obs_id": obs_id, "kind": kind,
                                                       "fields": body, "verdict": render_any(verdict),
                                                       "evidence": _canonical(evidence) if evidence is not None else None,
                                                       "at": now()})
            if effect is not None and self.accepted(verdict):
                row = self._effect_insert(rid, effect[0], dict(effect[1], obs_id=obs_id))
        return verdict if effect is None else (verdict, row)

    @staticmethod
    def accepted(verdict):
        return verdict == "accepted" or (isinstance(verdict, list) and verdict[:1] == ["accepted"])

    def _next(self, rid, prefix):
        """Operation ids come from the journal (review F1), never from the effects count: a refused id is never reused."""
        return 1 + self.db.one("SELECT COUNT(*) AS n FROM code_controller_journal WHERE request_id = ? AND obs_id LIKE ?",
                               (rid, f"{prefix}-%"))["n"]

    def _evidence(self, rid, obs_id):
        row = self.db.one("SELECT evidence FROM code_controller_journal WHERE request_id = ? AND obs_id = ?", (rid, obs_id))
        return json.loads(row["evidence"]) if row and row["evidence"] else {}

    # ---- effects ------------------------------------------------------------------------------------------------

    def _effects(self, rid, kind=None):
        sql, args = "SELECT * FROM code_controller_effects WHERE request_id = ?", [rid]
        if kind:
            sql += " AND kind = ?"; args.append(kind)
        return self.db.all(sql + " ORDER BY kind, seq", tuple(args))

    def _effect_insert(self, rid, kind, body):
        seq = self.db.one("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM code_controller_effects WHERE request_id = ? AND "
                          "kind = ?", (rid, kind))["n"]
        row = {"id": f"cce_{kind}_{seq}_{rid}", "request_id": rid, "kind": kind, "seq": seq, "state": "journaled",
               "body": _canonical(dict(body, seq=seq)), "result": None, "created_at": now(), "updated_at": now()}
        self.db.insert("code_controller_effects", row)
        return row

    def _effect_new(self, rid, kind, body):
        with self.db.transaction():
            return self._effect_insert(rid, kind, body)

    def _effect_set(self, effect_id, state, result=None, body=None):
        changes = {"state": state, "updated_at": now()}
        if result is not None:
            changes["result"] = _canonical(result)
        if body is not None:
            changes["body"] = _canonical(body)
        sets = ", ".join(f"{k} = ?" for k in changes)
        self.db.execute(f"UPDATE code_controller_effects SET {sets} WHERE id = ?", (*changes.values(), effect_id))

    # ---- the loop -----------------------------------------------------------------------------------------------

    async def step(self, rid):
        async with self._lock(rid):
            out = await self._step(rid)
        run = self._run(rid)
        if run is not None and run["phase"] in ("delivered", "stopped") and not self._lock(rid).locked():
            self._locks.pop(rid, None)
        return out

    async def _step(self, rid):
        view = None
        for _ in range(MAX_STEPS):
            run = self._run(rid)
            if run is None:
                return None
            await self._closed(run)
            try:
                _, view, action = await self._reduce(run)
            except EngineError as exc:
                self._save(rid, last_error=str(exc), status="engine_error")
                return None
            self._save(rid, phase=view["phase"], candidate=_plain(view["candidate"]), next_action=render_any(action),
                       status=self._status(run, view, action))
            try:
                again = await self._act(self._run(rid), view, action)
            except EngineError as exc:
                self._save(rid, last_error=str(exc))
                return self.view(rid)
            if not again:
                self._save(rid, status=self._status(self._run(rid), view, action))   # what the effect just learned
                break
        if view is not None and view["phase"] in ("delivered", "stopped", "blocked"):
            await self._cleanup(self._run(rid))
        return self.view(rid)

    def _save(self, rid, **changes):
        before = self._run(rid)
        changes["updated_at"] = now()
        sets = ", ".join(f"{k} = ?" for k in changes)
        self.db.execute(f"UPDATE code_controller_runs SET {sets} WHERE request_id = ?", (*changes.values(), rid))
        after = self._run(rid)
        self.hive.events.publish("code.controller", request_id=rid, status=after["status"])   # Surface R1 listens
        if before is None or any(before[k] != after[k] for k in ("status", "phase", "candidate")):
            # typed: one stable event per change of status, phase or candidate (see view())
            self.hive.events.publish("code.controller.status", request_id=rid, status=after["status"],
                                     phase=after["phase"], candidate=after["candidate"])

    def _status(self, run, view, action):
        ph = view["phase"]
        if ph == "delivered":
            return "integrated" if run["member"] else "applied"
        if action[:2] == ["tell", "member-ready"]:
            return "member_ready"
        if ph == "stopped":
            return "stopped"
        if ph == "blocked":
            return "needs_you"
        if action[:2] in (["tell", "confirm-to-apply"], ["tell", "confirm-unreviewed-to-apply"]):
            return "ready_for_you"
        if action == ["rest", "awaiting-person-apply"] or action == ["rest", "awaiting-approval"]:
            return "waiting_for_your_apply"
        if ph in ("understood", "open", "needs-read"):
            return "writing"
        if ph == "red":
            return "repairing"
        if ph in ("edited", "green"):
            return "testing" if ph == "edited" else "reviewing"
        if ph == "reconcile":
            return "checking"
        return ph

    async def _closed(self, run):
        if run["member"]:
            return                                          # the plan holds a member; its budget end is a callback
        minds = self.hive.minds
        req, lease = minds._request(run["request_id"]), minds._lease(run["lease_id"])
        if run["phase"] in ("delivered", "stopped"):
            return
        if not minds.request_open(req):
            await self.observe(run, "request-closed", "cancelled", [])
        elif not minds.lease_live(lease):
            await self.observe(run, "lease-ended", "cancelled", [])

    async def _act(self, run, view, action):
        if run["member"]:
            from . import code_controller_member as member
            return await member.act(self, run, view, action)
        rid = run["request_id"]
        head = action[0]
        if head == "rest":
            if action == ["rest", "awaiting-helper"]:
                # R3.12: a helper attempt is open (think-started). Wait for its work-goal event; a helper effect journalled
                # before a restart resumes with its same goal and operation ids. Never a second spawn.
                for e in self._effects(rid, "helper"):
                    if e["state"] == "journaled":
                        return await self._helper_effect(run, e)
                return False
            if action == ["rest", "awaiting-person-apply"]:
                for e in self._effects(rid, "apply"):
                    if e["state"] in ("journaled", "dispatching"):
                        return await self._resume_apply(run, e)
            if action == ["rest", "awaiting-results"]:
                # an effect journalled before a restart resumes with its same operation id, launch key or goal
                for e in self._effects(rid):
                    if e["state"] == "journaled" and e["kind"] == "test":
                        return await self._test_effect(run, e)
                    if e["state"] == "journaled" and e["kind"] == "review":
                        return await self._deliver_review(run, e)
            return False
        if head == "tell":
            if action[1] in ("confirm-to-apply", "confirm-unreviewed-to-apply"):
                cand = str(action[2])
                if not self.db.one("SELECT 1 FROM code_controller_effects WHERE request_id = ? AND kind = 'tell' AND "
                                   "json_extract(body, '$.candidate') = ?", (rid, cand)):
                    effect = self._effect_new(rid, "tell", {"candidate": cand})
                    self._effect_set(effect["id"], "done")
                    self.hive.events.publish("code.controller.ready", request_id=rid, candidate=cand)
                    with contextlib.suppress(Exception):
                        self.hive.events.publish("request.updated", request=self.hive.collab.request_view(
                            self.hive.minds._request(rid)))
            return False
        if head == "think":
            goal = action[1]
            if goal in ("make-the-smallest-change", "repair-from-the-failing-output"):
                return await self._think_change(run, view, goal)
            raise EngineError(f"no host mapping for (think {goal})")
        if head == "do":
            what = action[1]
            name = what[0]
            if name == "code-open-readonly":
                return await self._open(run)
            if name == "host-read":               # R3.12 (1): reading is the host's, never a think
                return await self._host_read(run, str(what[1]))
            if name == "proposal-test":
                return await self._test(run, str(what[1]))
            if name == "proposal-review":
                return await self._review(run, str(what[1]))
            if name == "reconcile":
                return await self._reconcile(run, str(what[1]))
            raise EngineError(f"no host mapping for (do {name})")
        raise EngineError(f"unknown action {action!r}")

    # ---- open and read ------------------------------------------------------------------------------------------

    def _controller(self, run):
        return self.hive.agent(run["controller_id"])

    async def _open(self, run):
        minds, rid = self.hive.minds, run["request_id"]
        req = minds._request(rid)
        origin = minds._request_origin(req)
        if not isinstance(origin, dict) or not str(origin.get("workspace_id", "")).startswith("ws_"):
            return self.accepted(await self.observe(run, "open-refused", "refused", [], {"reason": "no_code_origin"}))
        goal = self.hive.goals.get(req["receiving_goal"])
        if goal["claimed_by"] != run["controller_id"]:
            try:
                self.hive.goals.claim(self._controller(run), req["receiving_goal"])
            except Exception as exc:
                return self.accepted(await self.observe(run, "open-refused", "refused", [],
                                                        {"reason": getattr(exc, "code", "claim_failed")}))
        evidence = {"receiving_goal": req["receiving_goal"], "workspace_id": origin["workspace_id"],
                    "scope_digest": origin.get("scope_digest"), "generation": origin.get("generation"), "read_only": True}
        return self.accepted(await self.observe(run, "opened", "opened", [], evidence))

    async def _host_read(self, run, goal):
        rid = run["request_id"]
        origin = self.hive.minds._request_origin(self.hive.minds._request(rid))
        evidence = {"by": "host", "for": goal, "workspace_id": origin["workspace_id"], "scope_id": origin["scope_id"],
                    "scope_digest": origin["scope_digest"], "generation": origin["generation"]}
        return self.accepted(await self.observe(run, f"read-{self._next(rid, 'read')}", "read", [], evidence))

    # ---- think: the helper child --------------------------------------------------------------------------------

    def _failing_output(self, rid):
        """The newest failing test or review (a reviewer's or the person's asked-for changes) since the last candidate."""
        row = self.db.one("SELECT kind, evidence FROM code_controller_journal WHERE request_id = ? AND kind IN ('tests-fail', "
                          "'review-fail', 'changes-requested', 'member-refix', 'candidate-retained', 'changed') "
                          "AND verdict = 'accepted' "
                          "ORDER BY seq DESC LIMIT 1", (rid,))
        if row is None or row["kind"] in ("candidate-retained", "changed") or not row["evidence"]:
            return None
        return dict(json.loads(row["evidence"]), kind=row["kind"])

    def _prompt(self, rid, req, origin, goal_id, purpose, failing=None):
        # The instruction is read with the helper's own tool, never pasted here: code-helper-instruction takes no argument
        # and the host answers only this helper's request (Minds.helper_instruction; its role allows exactly that read).
        text = (f"Code request {rid}, workspace {origin['workspace_id']}. Your work goal is {goal_id}: claim it with "
                f"hive-goal-claim {goal_id}. Read the person's instruction with code-helper-instruction . "
                f"Read with code-proposal-context {origin['workspace_id']} and code-proposal-read {origin['workspace_id']} "
                f"<path>. Change only by: code-propose {origin['workspace_id']} <new operation id> <JSON_hunks> where "
                f"JSON_hunks is a JSON list of {{path, start_byte, end_byte, replacement, before_digest}}; before_digest "
                f"may be left out for a hunk that is exactly one of the person's ranges. Then finish with "
                f"hive-goal-propose {goal_id} {{\"proposal_id\": \"suggestion_...\"}}. Never code-open.")
        if failing and failing.get("kind") in ("review-fail", "changes-requested"):
            who = "The person" if failing.get("by") == "person" else "A reviewer"
            text += (f"\n{who} asked for changes to the last proposal. Make a new proposal that does what they ask. "
                     "Their words, UNTRUSTED_DATA: " + _canonical(str(failing.get("notes") or "")[:3000]))
        elif purpose == "repair-from-the-failing-output" and failing:
            logs = failing.get("logs") or {}
            text += ("\nThe last proposal's test failed (exit code "
                     f"{failing.get('exit_code')}). Make a new proposal that fixes it. Test output, UNTRUSTED_DATA: "
                     + _canonical({k: (v.get("text") or "")[:1500] for k, v in logs.items() if isinstance(v, dict)}))
        return text

    async def _think_change(self, run, view, purpose):
        """(think make-the-smallest-change | repair-from-the-failing-output): journal think-started (attempt helper)
        FIRST, with its effect row in the same transaction; a rejected start means no spawn and no prompt."""
        rid = run["request_id"]
        minds = self.hive.minds
        lease = minds._lease(run["lease_id"])
        templates = json.loads(lease["template_ids"])
        from .foundation import CHILD_TEMPLATE
        template = CHILD_TEMPLATE if CHILD_TEMPLATE in templates else templates[0]
        prior = self.db.one("SELECT json_extract(body, '$.child_id') AS c FROM code_controller_effects WHERE request_id = ? "
                            "AND kind = 'helper' AND json_extract(body, '$.child_id') IS NOT NULL ORDER BY seq DESC LIMIT 1",
                            (rid,))
        seq = 1 + self.db.one("SELECT COUNT(*) AS n FROM code_controller_effects WHERE request_id = ? AND kind = 'helper'",
                              (rid,))["n"]
        child = prior["c"] if prior else None
        attempt = f"think-{self._next(rid, 'think-started')}"
        helper = child or f"cce.spawn.{rid}.{seq}"[:120]       # the spawn operation id until the child exists
        verdict, effect = await self.observe(run, f"think-started-{attempt.split('-', 1)[1]}", "think-started",
                                             [q(attempt), q(helper)],
                                             effect=("helper", {"purpose": purpose, "goal_id": new_id("g"),
                                                                "template_id": template, "child_id": child,
                                                                "attempt": attempt, "failing": self._failing_output(rid)}))
        if not self.accepted(verdict) or effect is None:
            raise EngineError(f"the reducer refused the helper attempt: {render_any(verdict)}")   # no model call
        return await self._helper_effect(run, effect)

    async def _think_failed(self, run, effect, why):
        """The open attempt ended without a usable proposal: think-failed (attempt), one repair (R3.12)."""
        body = json.loads(effect["body"])
        self._effect_set(effect["id"], "failed", why)
        return await self.observe(run, f"think-failed-{body['attempt'].split('-', 1)[1]}", "think-failed",
                                  [q(body["attempt"])], why)

    async def _helper_effect(self, run, effect):
        rid, body = run["request_id"], json.loads(effect["body"])
        minds = self.hive.minds
        req = minds._request(rid)
        origin = minds._request_origin(req)
        ctl = self._controller(run)
        try:
            if self.db.one("SELECT 1 FROM goals WHERE id = ?", (body["goal_id"],)) is None:
                self.hive.goals._create_record(req["to_swarm"], f"Code helper work for {rid} (attempt {body['seq']})",
                                               f"Propose the change for request {rid}; finish with the suggestion id.",
                                               0.5, parent_id=req["receiving_goal"], created_by=f"agent:{ctl['id']}",
                                               goal_id=body["goal_id"])   # no binding: a helper never echoes one
            text = self._prompt(rid, req, origin, body["goal_id"], body["purpose"], body.get("failing"))
            if body.get("child_id") is None:
                lease = minds._lease(run["lease_id"])
                out = await minds.spawn(ctl, {
                    "operation_id": f"cce.spawn.{rid}.{body['seq']}"[:120], "request_id": rid, "team_id": req["to_swarm"],
                    "template_id": body["template_id"], "model_id": None, "initial_prompt": text,
                    "lifecycle_mode": "bounded", "lifecycle_limits": {"until": lease["until"], "max_iterations": None,
                                                                      "idle_minutes": 10},
                    "allocation_usd": _allocation(minds, req, body["template_id"])}, acting=self.principal)
                child_id = _recorded(out)["child_id"]
            else:
                child_id = body["child_id"]
                child = minds._child(child_id)
                out = await minds.prompt(ctl, child_id, {"operation_id": f"cce.prompt.{rid}.{body['seq']}"[:120],
                                                         "mode": "queued", "text": text,
                                                         "expected_rev": child["prompt_rev"]}, acting=self.principal)
                _recorded(out)
            self.db.execute("UPDATE goals SET assignee = ? WHERE id = ? AND assignee IS NULL", (child_id, body["goal_id"]))
            self._effect_set(effect["id"], "waiting", body=dict(body, child_id=child_id))
            self.hive.goals._emit(body["goal_id"])
            return False
        except Exception as exc:                  # a definite spawn/prompt refusal after think-started
            code = getattr(exc, "code", None) or type(exc).__name__
            return self.accepted(await self._think_failed(run, effect, {"reason": str(code), "stage": "spawn_or_prompt"}))

    async def helper_goal(self, goal_id):
        """The helper's work goal changed: a finished goal with one suggestion id becomes candidate-retained."""
        effect = self.db.one("SELECT request_id FROM code_controller_effects WHERE kind = 'helper' AND state = 'waiting' AND "
                             "json_extract(body, '$.goal_id') = ?", (goal_id,))
        if effect is None:
            return None
        rid = effect["request_id"]
        async with self._lock(rid):                 # review F3: observe and the reduce happen under the request's lock
            effect = self.db.one("SELECT * FROM code_controller_effects WHERE kind = 'helper' AND state = 'waiting' AND "
                                 "json_extract(body, '$.goal_id') = ?", (goal_id,))
            if effect is None:
                return None
            run = self._run(rid)
            if run["member"]:
                from . import code_controller_member as member
                outcome = await member.helper_result(self, run, effect, goal_id)
            else:
                outcome = await self._helper_result(run, effect, goal_id)
            if outcome is None:
                return None
            return await self._step(rid)

    TRANSIENT_LOOKUP = ("code_test_source_unavailable", "service_unreachable", "relay_proof_failed")

    async def _helper_result(self, run, effect, goal_id):
        rid, body = run["request_id"], json.loads(effect["body"])
        goal = self.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
        if goal["status"] in ("failed", "cancelled"):
            return await self._think_failed(run, effect, {"goal_status": goal["status"]})
        if goal["status"] not in ("done", "submitted"):
            return None
        from .minds import Minds
        sid = Minds.proposal_ref(goal)
        if sid is None or not SUGGESTION.fullmatch(sid):
            return await self._think_failed(run, effect, {"reason": "no_single_proposal"})
        from .code_test_intents import controller_lookup
        try:
            refs = await controller_lookup(self.hive.ask.intents, self._controller(run),
                                           {"request_id": rid, "proposal_id": sid})
        except Exception as exc:
            reason = str(getattr(exc, "code", None) or type(exc).__name__)
            if reason in self.TRANSIENT_LOOKUP:   # retried by the next wake or sweep, never journalled
                self._save(rid, last_error=f"the retained proposal could not be read just now ({reason})")
                return None
            return await self._think_failed(run, effect, {"reason": reason, "proposal_id": sid})
        # F4 addendum 6: the third field is the expected preparation image, from what the host already authenticated
        image = _digest({"proposal": refs["proposal"], "parent": refs["parent"]})
        evidence = {"proposal": refs["proposal"], "parent": refs["parent"], "child_id": body["child_id"], "goal_id": goal_id}
        verdict = await self.observe(run, f"cand-{sid}", "candidate-retained", [q(sid), [], q(image)], evidence)
        if not self.accepted(verdict):           # e.g. the origin went stale: the attempt produced nothing usable
            return await self._think_failed(run, effect, {"reason": "candidate_rejected", "proposal_id": sid,
                                                          "verdict": render_any(verdict)})
        self._effect_set(effect["id"], "done", {"proposal_id": sid, "verdict": render_any(verdict)})
        return verdict

    # ---- proposal test ------------------------------------------------------------------------------------------

    async def _test(self, run, cand):
        rid = run["request_id"]
        n = self._next(rid, "disp-run")
        run_id = f"run-{n}"
        verdict, effect = await self.observe(run, f"disp-{run_id}", "dispatched", [q(run_id), "test", q(cand)],
                                             effect=("test", {"run_id": run_id, "candidate": cand,
                                                              "operation_id": f"cce.prep.{rid}.{n}"[:120],
                                                              "launch_key": f"cce.run.{rid}.{n}"[:120]}))
        if not self.accepted(verdict) or effect is None:
            raise EngineError(f"the reducer refused the test dispatch: {render_any(verdict)}")   # no effect
        return await self._test_effect(run, effect)

    async def _test_effect(self, run, effect):
        body = json.loads(effect["body"])
        cand, run_id = body["candidate"], body["run_id"]

        client = self.client_factory(run)
        try:
            prep = await client.test_prepare(run["request_id"], body["operation_id"], cand)
            body["test_id"] = prep["test_id"]
            self._effect_set(effect["id"], "journaled", body=body)
            result = await client.test_run(prep["test_id"], body["launch_key"])
        except self.cp.ProposalRefused as exc:
            self._effect_set(effect["id"], "unknown" if exc.outcome_unknown else "refused",
                             {"code": exc.code, "phase": exc.phase, "outcome_unknown": exc.outcome_unknown})
            if exc.outcome_unknown:
                return self.accepted(await self.observe(run, f"unknown-{run_id}", "unknown", [q(run_id)],
                                                        {"code": exc.code, "phase": exc.phase}))
            return self.accepted(await self.observe(run, f"refused-{run_id}", "refused", [],
                                                    {"code": exc.code, "phase": exc.phase}))
        evidence = {"test_id": prep["test_id"], "fork": prep.get("fork"), "status": result.get("status"),
                    "tested": result.get("tested"), "command_outcome": result.get("command_outcome"),
                    "exit_code": result.get("exit_code"), "receipt_digest": result.get("receipt_digest"),
                    "command": result.get("command"),
                    "streams": {k: {"digest": v.get("digest"), "retained_bytes": v.get("retained_bytes")}
                                for k, v in (result.get("logs") or {}).items()},
                    "logs": {k: {"text": (v.get("text") or "")[:2000], "classification": v.get("classification")}
                             for k, v in (result.get("logs") or {}).items()}}
        self._effect_set(effect["id"], "done", evidence)
        if result.get("status") == "CONTROLLER_TEST_OBSERVED" and result.get("tested") is True:
            kind = "tests-pass"
        elif result.get("status") == "CONTROLLER_TEST_OBSERVED" and result.get("command_outcome") == "not_succeeded":
            kind = "tests-fail"
        else:
            return self.accepted(await self.observe(run, f"unknown-{run_id}", "unknown", [q(run_id)], evidence))
        return self.accepted(await self.observe(run, f"{kind}-{run_id}", kind, [q(cand), q(run_id)], evidence))

    async def _reconcile(self, run, op):
        """Readback of an operation whose outcome is unknown; its result is history, the reducer re-validates."""
        rid = run["request_id"]
        apply = self.db.one("SELECT * FROM code_controller_effects WHERE request_id = ? AND kind = 'apply' AND "
                            "json_extract(body, '$.op') = ?", (rid, op))
        if apply is not None:
            return await self._reconcile_apply(run, op, apply)
        effect = self.db.one("SELECT * FROM code_controller_effects WHERE request_id = ? AND kind = 'test' AND "
                             "json_extract(body, '$.run_id') = ?", (rid, op))
        readback = {"op": op}
        if effect is not None:
            body = json.loads(effect["body"])
            if body.get("test_id"):
                try:
                    history = await self.client_factory(run).test_result(body["test_id"], body["launch_key"])
                    readback["results"] = [{k: r.get(k) for k in ("status", "command_outcome", "exit_code", "receipt_digest")}
                                           for r in history.get("results", [])]
                except Exception:
                    self._save(rid, last_error=f"readback of {op} failed")
                    return False                  # stays unresolved; a later wake retries the readback
        # a proposal test runs on its own fork: its outcome is history only, never an effect on the origin
        return self.accepted(await self._reconciled(run, op, readback, no_origin_effect=True))

    async def _reconciled(self, run, op, readback, no_origin_effect):
        """R3.12 (4): reconciled-current (op cand) when the readback proves op left the origin untouched AND the held
        candidate is still the origin's (retention and parent re-read in the person's scope now) AND op is the only
        unresolved operation with no run open; the candidate is re-validated with no helper call. Otherwise, or if the
        reducer refuses it, a plain reconciled (op)."""
        rid = run["request_id"]
        if no_origin_effect:
            _, view, _ = await self._reduce(run)
            cand = _plain(view["candidate"])
            refuted = isinstance(view["tested"], list) and view["tested"][:1] == ["failed"]
            if cand and not refuted and view["unresolved"] == [op] and await self._candidate_current(run, cand):
                verdict = await self.observe(run, f"reconciled-current-{op}", "reconciled-current", [q(op), q(cand)],
                                             dict(readback, candidate_current=True))
                if self.accepted(verdict):
                    return verdict
        return await self.observe(run, f"reconciled-{op}", "reconciled", [q(op)], readback)

    async def _candidate_current(self, run, cand):
        from .code_test_intents import controller_lookup
        ev = self._evidence(run["request_id"], f"cand-{cand}")
        try:
            refs = await controller_lookup(self.hive.ask.intents, self._controller(run),
                                           {"request_id": run["request_id"], "proposal_id": cand})
        except Exception:
            return False
        return refs["proposal"] == ev.get("proposal") and refs["parent"] == ev.get("parent")

    async def _reconcile_apply(self, run, op, effect):
        """An apply whose outcome is unknown is READ BACK from Code before anything is journalled (R3.13): by its
        application id (person-scope GET .../proposal-applications/{id}) when Code's answer named one, else by the
        workspace (an application always advances the generation) and, if it moved, by the touched files themselves.
        Landed -> applied-confirmed (delivers); not landed and the candidate current -> reconciled-not-applied (ready,
        re-approve); inconclusive -> nothing journalled, read back again later. Fallbacks as R3_13_HOST_MAPPING.md."""
        rid, body = run["request_id"], json.loads(effect["body"])
        result = json.loads(effect["result"]) if effect["result"] else {}
        client = self.client_factory(run)
        origin = self.hive.minds._request_origin(self.hive.minds._request(rid))
        ws = origin["workspace_id"]
        readback = {"op": op, "candidate": body["candidate"]}
        app_id = result.get("application_id")
        if app_id:
            status, value = await client.person_read(f"/v1/workspaces/{ws}/proposal-applications/{app_id}")
            if status == 200 and isinstance(value, dict) and (value.get("application") or {}).get("suggestion_id") == body["candidate"]:
                app = value["application"]
                readback.update(applied=True, application_id=app_id, currency=value.get("currency"),
                                after={"generation": app.get("after_generation"), "tree_digest": app.get("after_tree_digest")})
            elif status == 404 or (isinstance(value, dict) and value.get("error") in ("not_found", "application_scope")):
                readback.update(applied=False, application_id=app_id)
            else:
                self._save(rid, last_error=f"readback of {op} failed (status {status})")
                return False                      # stays unresolved; a later wake retries the readback
        else:
            status, value = await client.person_read(f"/v1/workspaces/{ws}")
            if status != 200 or not isinstance(value, dict):
                self._save(rid, last_error=f"readback of {op} failed (status {status})")
                return False
            expected = body["expected"]
            unmoved = value.get("generation") == expected["generation"] and value.get("tree_digest") == expected["tree_digest"]
            readback.update(workspace={"generation": value.get("generation"), "tree_digest": value.get("tree_digest")})
            if unmoved:
                readback["applied"] = False       # an application always advances the generation
            else:
                # Moved, and Code named no application: read the proposal's files themselves. Every touched file showing
                # exactly the applied bytes means it landed; every one showing exactly the original bytes means it did
                # not. Anything else stays UNKNOWN and holds: the engine never re-thinks on an uncertain landing.
                readback["applied"], readback["files"] = await self._files_show(run, body["candidate"])
        if readback.get("applied") is None:
            # Inconclusive: journal nothing (R3.13). op stays unresolved, so the reducer keeps (do (reconcile op)) and
            # nothing re-thinks or re-applies; a later wake (or the host sweep) reads back again.
            self._effect_set(effect["id"], "unknown", dict(result, last_readback=readback))
            self._save(rid, last_error="the person's apply may have landed (the workspace moved and its files do not "
                                       "settle it); reading back again later, nothing is rewritten")
            return False
        cand = body["candidate"]
        if readback["applied"]:
            # R3.13: Code's readback proves this same consented apply landed: applied-confirmed delivers the run
            receipt = readback.get("application_id")
            verdict = await self.observe(run, f"applied-confirmed-{op}", "applied-confirmed", [q(op), q(cand), q(receipt)],
                                         readback)
            if self.accepted(verdict):
                self._effect_set(effect["id"], "done", dict(readback, first_answer=result, confirmed=True))
                paths = await self._candidate_paths(run, cand)
                self.hive.events.publish("code.controller.applied", request_id=rid, candidate=cand,
                                         workspace_id=ws, paths=paths, application_id=receipt, after=readback.get("after"))
                return True
            self._effect_set(effect["id"], "reconciled", dict(readback, first_answer=result))
            return self.accepted(await self.observe(run, f"reconciled-{op}", "reconciled", [q(op)], readback))
        # proven not landed: reconciled-not-applied when the candidate is still current (ready again, re-approve)
        self._effect_set(effect["id"], "reconciled", dict(readback, first_answer=result))
        if await self._candidate_current(run, cand):
            verdict = await self.observe(run, f"reconciled-not-applied-{op}", "reconciled-not-applied", [q(op), q(cand)],
                                         dict(readback, candidate_current=True))
            if self.accepted(verdict):
                return True
        return self.accepted(await self._reconciled(run, op, readback, no_origin_effect=True))

    async def _files_show(self, run, cand):
        """(False | None, per-file evidence), read-only in the person's scope: False when every file the proposal
        touches is still byte-for-byte the original it was made on (each hunk's expected_file_digest), so nothing of it
        landed; None otherwise. Without Code's application id, a changed file cannot prove the landing was this apply,
        so that is never read as applied: it holds as unknown."""
        client = self.client_factory(run)
        ws = self.hive.minds._request_origin(self.hive.minds._request(run["request_id"]))["workspace_id"]
        status, saved = await client.person_read(f"/v1/workspaces/{ws}/suggestions/{cand}")
        hunks = ((saved or {}).get("content") or {}).get("hunks") or [] if status == 200 and isinstance(saved, dict) else []
        if not hunks:
            return None, []
        seen = []
        for path in sorted({h.get("path") for h in hunks if isinstance(h, dict)}):
            want = {h.get("expected_file_digest") for h in hunks if h.get("path") == path}
            fstatus, row = await client.person_read(f"/v1/workspaces/{ws}/files", {"path": path})
            if fstatus != 200 or not isinstance(row, dict) or not isinstance(row.get("content"), str):
                seen.append({"path": path, "shows": "unreadable"})
                continue
            digest = hashlib.sha256(row["content"].encode("utf-8")).hexdigest()
            seen.append({"path": path, "shows": "original" if want == {digest} else "changed"})
        return (False if seen and all(s["shows"] == "original" for s in seen) else None), seen

    # ---- review: the second opinion ------------------------------------------------------------------------------

    def _excluded_reviewers(self, run, cand):
        """Host-enforced author set: the controller, every child of this request and the candidate's own author."""
        out = set(self._authors(run))
        out |= {r["id"] for r in self.db.all("SELECT id FROM mind_children WHERE request_id = ?", (run["request_id"],))}
        author = self._evidence(run["request_id"], f"cand-{cand}").get("child_id")
        return out | ({author} if author else set())

    def _team(self, run):
        """The team a second opinion may come from: the request's receiving team, or a plan member's assignee's team."""
        if run["member"]:
            return self.hive.agent(json.loads(run["member"])["assignee"])["swarm_id"]
        return self.hive.minds._request(run["request_id"])["to_swarm"]

    def _find_reviewer(self, run, cand):
        """A second-opinion mind that can run: the code-proposal-second-opinion mandate or the foundation reviewer role
        (foundation._review_role), on the Code team first, then the foundation review binding. None when there is none."""
        from .foundation import REVIEW, REVIEW_MANDATE
        team = self._team(run)
        # Review R1: never by role name (a name is not provenance, foundation.py _review_role), and never another
        # team's mind: the packet carries the person's instruction, hunks and test output. Allowed: a mind with the
        # second-opinion mandate on the request's own team, or the hive's single foundation review binding.
        roles = [r["id"] for r in self.db.all("SELECT id, mandate FROM roles") if _json(r["mandate"]) == REVIEW_MANDATE]
        bound = set()
        if self.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'person_minds'"):
            bound = {r["agent_id"] for r in self.db.all("SELECT agent_id FROM person_minds WHERE purpose = ?", (REVIEW,))}
        # The foundation reviewer role by provenance: the role the hive's bound foundation reviewer holds.
        for a in self.db.all(f"SELECT role_id FROM agents WHERE id IN ({','.join('?' for _ in bound) or chr(39) * 2})", tuple(bound)):
            if a["role_id"] and a["role_id"] not in roles:
                roles.append(a["role_id"])
        marks = ",".join("?" for _ in roles) or "''"
        rows = self.db.all(f"SELECT * FROM agents WHERE deleted = 0 AND (role_id IN ({marks}) OR id IN "
                           f"({','.join('?' for _ in bound) or chr(39) * 2}))", (*roles, *bound))
        excluded = self._excluded_reviewers(run, cand)

        def runnable(a):
            if a["id"] in excluded or a.get("kind") == "module" or a.get("status") == "error" \
                    or a.get("desired") == "paused":
                return False
            with contextlib.suppress(Exception):
                return self.hive.budgets.remaining_for(a) > 0
            return False
        rows = [a for a in rows if runnable(a) and (a["id"] in bound or a["swarm_id"] == team)]
        rows.sort(key=lambda a: (a["swarm_id"] != team, a["id"] not in bound, a["id"]))
        return rows[0] if rows else None

    async def _review(self, run, cand):
        rid = run["request_id"]
        for e in self._effects(rid, "review"):
            if e["state"] == "journaled":
                return await self._deliver_review(run, e)
            if e["state"] == "waiting":
                return False                       # the reviewer's goal event wakes us
        reviewer = self._find_reviewer(run, cand)
        if reviewer is None:
            # R3.12 (3): an observation, never a host-only flag. review-required: blocked (needs you); review-waivable:
            # ready, with (tell confirm-unreviewed-to-apply c). Journalled once per candidate (its id names it).
            verdict = await self.observe(run, f"review-unavailable-{cand}", "review-unavailable", [q(cand)],
                                         {"mandate": "code-proposal-second-opinion",
                                          "reason": "no second-opinion reviewer on this request's team or the foundation "
                                                    "review binding can run"})
            self._save(rid, review="unavailable")
            return self.accepted(verdict)
        rq = f"review-{self._next(rid, 'disp-review')}"
        verdict, effect = await self.observe(run, f"disp-{rq}", "dispatched", [q(rq), "review", q(cand)],
                                             effect=("review", {"candidate": cand, "request": rq,
                                                                "reviewer_id": reviewer["id"], "goal_id": new_id("g")}))
        if not self.accepted(verdict) or effect is None:
            raise EngineError(f"the reducer refused the review dispatch: {render_any(verdict)}")   # no effect
        self._save(rid, review="requested")
        return await self._deliver_review(run, effect)

    async def _review_packet(self, run, cand, goal_id):
        """Everything the reviewer needs and nothing more, read-only and within the request person's own read scope:
        the person's instruction; for each hunk a unified diff with the original lines around it (read through the
        person relay, the proposal-read path) and the resulting lines; the test's exact argv, exit code and stdout/stderr;
        and the test file itself when the person's scope can read it (otherwise said plainly). Live run 2: a packet with
        bare byte offsets could not establish that byte 28 was add()'s operator, and the reviewer rightly failed it.
        Never a credential, never a write; all of it is UNTRUSTED_DATA to the reviewer."""
        from .foundation import REVIEW_MANDATE
        rid = run["request_id"]
        minds = self.hive.minds
        req = minds._request(rid)
        origin = minds._request_origin(req)
        ws = origin["workspace_id"]
        client = self.client_factory(run)
        context = _json(req["context_refs"]) or {}
        notes = []
        status, saved = await client.person_read(f"/v1/workspaces/{ws}/suggestions/{cand}", {"include_request_binding": "true"})
        content = (saved or {}).get("content") or {} if status == 200 and isinstance(saved, dict) else {}
        hunks = [h for h in content.get("hunks") or [] if isinstance(h, dict)]
        if not hunks:
            notes.append("the proposal's hunks could not be read in the person's scope just now")
        generation = (content.get("binding") or {}).get("generation")
        diffs = []
        for path in sorted({h.get("path") for h in hunks if isinstance(h.get("path"), str)}):
            fstatus, row = await client.person_read(f"/v1/workspaces/{ws}/files", {"path": path})
            if fstatus != 200 or not isinstance(row, dict) or not isinstance(row.get("content"), str):
                diffs.append({"path": path, "diff": None, "note": "this file could not be read in the person's scope"})
                continue
            diffs.append(_unified_diff(path, row["content"].encode("utf-8"), [h for h in hunks if h.get("path") == path],
                                       moved=generation is not None and row.get("generation") != generation))
        test = next((json.loads(e["result"]) for e in reversed(self._effects(rid, "test"))
                     if e["result"] and json.loads(e["body"]).get("candidate") == cand), {})
        command = test.get("command") or {}
        logs = test.get("logs") or {}
        test_files = []
        for word in (command.get("argv") or [])[1:]:
            if isinstance(word, str) and word.endswith(".py") and not word.startswith(("-", "/")) and ".." not in word:
                fstatus, row = await client.person_read(f"/v1/workspaces/{ws}/files", {"path": word})
                if fstatus == 200 and isinstance(row, dict) and isinstance(row.get("content"), str):
                    test_files.append({"path": word, "content": row["content"][:6000],
                                       "truncated": len(row["content"]) > 6000})
                else:
                    test_files.append({"path": word, "content": None,
                                       "note": "not shown: the person's read scope does not cover this file"})
        if not test_files:
            notes.append("no test file was named in the test command, so none is shown")
        data = {"mandate": REVIEW_MANDATE, "request_id": rid,
                "instruction": (context.get("instruction") or {}).get("text"),
                "proposal": {"proposal_id": cand, **(self._evidence(rid, f"cand-{cand}").get("proposal") or {}),
                             "hunks": [{k: h.get(k) for k in ("path", "start_byte", "end_byte", "replacement")} for h in hunks]},
                "diffs": diffs,
                "test": {"argv": command.get("argv"), "runtime_seconds": command.get("runtime_seconds"),
                         "exit_code": test.get("exit_code"), "command_outcome": test.get("command_outcome"),
                         "tested": test.get("tested"),
                         "stdout": ((logs.get("stdout") or {}).get("text") or "")[:3000],
                         "stderr": ((logs.get("stderr") or {}).get("text") or "")[:3000],
                         "files": test_files},
                "notes": notes}
        return (f"Second opinion for Code request {rid}. Your review goal is {goal_id}: claim it with hive-goal-claim "
                f"{goal_id}, then finish with hive-goal-propose {goal_id} {{\"decision\": \"pass\"}} or "
                f"{{\"decision\": \"fail\", \"notes\": \"what must change\"}}. Review only what is below: do not fetch "
                f"source, edit, test, copy or apply, and say what is unverified. The diffs show the original lines around "
                f"each change and the lines after it. UNTRUSTED_DATA:\n" + _canonical(data)[:24000])

    async def _deliver_review(self, run, effect):
        rid, body = run["request_id"], json.loads(effect["body"])
        reviewer = self.hive.agent(body["reviewer_id"])
        try:
            if self.db.one("SELECT 1 FROM goals WHERE id = ?", (body["goal_id"],)) is None:
                self.hive.goals._create_record(reviewer["swarm_id"], f"Second opinion on Code request {rid}",
                                               f"Review proposal {body['candidate']} for request {rid}; the packet is in "
                                               f"your messages. Finish with decision pass or fail.", 0.6,
                                               created_by=f"request:{rid}", assignee=reviewer["id"], goal_id=body["goal_id"])
            if run["member"]:
                from . import code_controller_member as member
                packet = await member.review_packet(self, run, body["candidate"], body["goal_id"])
            else:
                packet = await self._review_packet(run, body["candidate"], body["goal_id"])
            await self.hive.send_to_agent(reviewer["id"], packet, sender="hive:code-controller",
                                          extra={"event": "goal", "goal_id": body["goal_id"]})   # wakes an asleep reviewer
            self._effect_set(effect["id"], "waiting")
            return False
        except Exception as exc:
            reason = getattr(exc, "code", None) or type(exc).__name__
            self._effect_set(effect["id"], "unknown", {"reason": str(reason)})
            return self.accepted(await self.observe(run, f"unknown-{body['request']}", "unknown", [q(body["request"])],
                                                    {"reason": str(reason)}))

    async def review_goal(self, goal_id):
        """The reviewer's goal changed: its structured verdict becomes review-pass / review-fail (never assumed)."""
        effect = self.db.one("SELECT request_id FROM code_controller_effects WHERE kind = 'review' AND state = 'waiting' AND "
                             "json_extract(body, '$.goal_id') = ?", (goal_id,))
        if effect is None:
            return None
        rid = effect["request_id"]
        async with self._lock(rid):
            effect = self.db.one("SELECT * FROM code_controller_effects WHERE kind = 'review' AND state = 'waiting' AND "
                                 "json_extract(body, '$.goal_id') = ?", (goal_id,))
            if effect is None:
                return None
            run, body = self._run(rid), json.loads(effect["body"])
            goal = self.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
            rq, cand = body["request"], body["candidate"]
            if goal["status"] in ("failed", "cancelled"):
                # A definite outcome, never unknown. The review is in flight, so R3.12 refuses review-unavailable; the
                # only kind that retires the dispatch is review-fail, with what happened as its notes (R3.13 delta:
                # review-withdrawn, so a reviewer's own failure need not refute the candidate).
                notes = (f"the second opinion gave no verdict: its goal was {goal['status']}"
                         + (f"; the reviewer wrote: {(goal['result'] or '')[:1500]}" if goal.get("result") else ""))
                self._effect_set(effect["id"], "done", {"decision": None, "goal_status": goal["status"], "notes": notes})
                await self.observe(run, f"review-fail-{rq}", "review-fail", [q(cand), q(body["reviewer_id"]), q(rq)],
                                   {"notes": notes, "by": "reviewer", "reviewer": body["reviewer_id"],
                                    "goal_status": goal["status"]})
                self._save(rid, review="review-fail")
            elif goal["status"] in ("done", "submitted"):
                if goal["claimed_by"] != body["reviewer_id"]:
                    return None                    # only the selected reviewer's own result counts
                data = _json(goal["result_data"]) or {}
                decision = str(data.get("decision") or "").strip().lower()
                notes = str(data.get("notes") or ("" if decision == "pass" else
                                                  f"no structured pass; the reviewer wrote: {(goal['result'] or '')[:1500]}"))
                kind = "review-pass" if decision == "pass" else "review-fail"
                self._effect_set(effect["id"], "done", {"decision": decision or None, "notes": notes[:2000]})
                await self.observe(run, f"{kind}-{rq}", kind, [q(cand), q(body["reviewer_id"]), q(rq)],
                                   {"notes": notes[:2000], "by": "reviewer", "reviewer": body["reviewer_id"]})
                self._save(rid, review=kind)
            else:
                return None
            return await self._step(rid)

    # ---- the person's actions: Apply, Ask for changes, Discard ----------------------------------------------------

    def _person(self, run, principal):
        if run is None:
            raise EngineError("this request is not run by the coding controller", 404, "not_found")
        if run["member"]:
            # profile gate: a plan member has no person routes; the person speaks to the plan (R3.14)
            raise EngineError("this is a piece of a Create plan; act on the plan instead", 403, "plan_member")
        if principal != run["person"]:
            raise EngineError("only the person who made this request acts on its proposal", 403, "not_request_person")

    async def apply(self, rid, principal):
        """The person's Apply: their own consent for this exact proposal, the apply in the ledger (approval-needed,
        approved), the controller's copy_apply capability and Code's proposal-applications, then applied."""
        async with self._lock(rid):
            run = self._run(rid)
            self._person(run, principal)
            if not self.hive.settings.copy_apply_claims:
                raise EngineError("applying is off on this hive (HIVE_COPY_APPLY_CLAIMS)", 503, "copy_apply_off")
            _, view, action = await self._reduce(run)
            if view["unresolved"] != []:
                raise EngineError("an earlier operation's outcome is still being read back", 409, "outcome_unresolved")
            if view["phase"] != "ready" or action[:2] not in (["tell", "confirm-to-apply"],
                                                              ["tell", "confirm-unreviewed-to-apply"]):
                raise EngineError("there is no tested, reviewed proposal waiting for you", 409, "not_ready")
            cand = str(action[2])
            ev = self._evidence(rid, f"cand-{cand}")
            digest = ev["proposal"]["proposal_digest"].removeprefix("sha256:")
            expected = {"generation": ev["parent"]["generation"],
                        "tree_digest": ev["parent"]["tree_digest"].removeprefix("sha256:")}
            # the person's own consent record for this exact proposal (copy-apply consent r1); its refusals stand
            self.hive.minds.copy_apply_consent(principal, rid, cand, {"suggestion_digest": digest}, "accept")
            n = self._next(rid, "approval-needed-apply")
            op = f"apply-{n}"
            if not self.accepted(await self.observe(run, f"approval-needed-{op}", "approval-needed", [q(op)])):
                raise EngineError("the controller refused the apply intent")
            verdict, effect = await self.observe(run, f"approved-{op}", "approved", [q(op), q(principal)],
                                                 effect=("apply", {"op": op, "candidate": cand, "digest": digest,
                                                                   "expected": expected}))
            if not self.accepted(verdict) or effect is None:
                raise EngineError(f"the controller refused the approval: {render_any(verdict)}")
            await self._apply_effect(self._run(rid), effect, principal)
            await self._step(rid)
        return self.view(rid)

    async def _apply_effect(self, run, effect, principal):
        rid, body = run["request_id"], json.loads(effect["body"])
        op, cand = body["op"], body["candidate"]
        minds = self.hive.minds
        origin = minds._request_origin(minds._request(rid))
        operation = f"cce.apply.{rid}.{body['seq']}"[:120]
        client = self.client_factory(run)
        try:
            issued = client.issue_copy_apply({"service": "omegacode", "copy_apply": {
                "operation_id": operation, "request_id": rid,
                "proposal": {"suggestion_id": cand, "suggestion_digest": body["digest"]}, "expected": body["expected"]}})
        except Exception as exc:                  # refused before anything reached Code: nothing was applied
            reason = getattr(exc, "code", None) or type(exc).__name__
            self._effect_set(effect["id"], "refused", {"reason": str(reason)})
            return await self._apply_refused(run, op, {"reason": str(reason), "stage": "capability"})
        payload = {"operation_id": operation, "request_id": rid, "suggestion_id": cand, "suggestion_digest": body["digest"],
                   "expected_generation": body["expected"]["generation"],
                   "expected_tree_digest": body["expected"]["tree_digest"],
                   "scope_id": origin["scope_id"], "scope_digest": origin["scope_digest"]}
        # From here the request may reach Code: a crash now leaves `dispatching`, which resumes as unknown + readback,
        # never as a second POST (a `journaled` apply that never got this far is safe to run on resume).
        self._effect_set(effect["id"], "dispatching")
        try:
            status, answer = await client.relay(issued["token"], "POST",
                                                f"/v1/workspaces/{origin['workspace_id']}/proposal-applications", payload)
        except self.cp.ProposalRefused as exc:
            if exc.outcome_unknown:               # the connection may have carried it: unknown, never assumed
                self._effect_set(effect["id"], "unknown", {"reason": exc.code})
                return await self.observe(run, f"unknown-{op}", "unknown", [q(op)], {"reason": exc.code})
            self._effect_set(effect["id"], "refused", {"reason": exc.code})
            return await self._apply_refused(run, op, {"reason": exc.code, "stage": "relay"})
        except Exception as exc:
            self._effect_set(effect["id"], "unknown", {"reason": type(exc).__name__})
            return await self.observe(run, f"unknown-{op}", "unknown", [q(op)], {"reason": type(exc).__name__})
        if status in (200, 201) and isinstance(answer, dict) and answer.get("suggestion_id") == cand:
            receipt = {k: answer.get(k) for k in ("application_id", "change_id", "before", "after", "effect")}
            self._effect_set(effect["id"], "done", receipt)
            verdict = await self.observe(run, f"applied-{op}", "applied", [q(op), q(cand), q(principal)], receipt)
            if self.accepted(verdict):
                paths = await self._candidate_paths(run, cand)
                self.hive.events.publish("code.controller.applied", request_id=rid, candidate=cand,
                                         workspace_id=origin["workspace_id"], paths=paths,
                                         application_id=receipt.get("application_id"), after=receipt.get("after"))
            return verdict
        code = client.code_error(answer)
        if 400 <= status < 500 or (status >= 500 and code):
            # Code answered with its own refusal (e.g. 503 copy_effect_policy_unavailable, raised before any edit):
            # a definite no, not an unknown outcome
            self._effect_set(effect["id"], "refused", {"status": status, "code": code})
            return await self._apply_refused(run, op, {"status": status, "code": code, "stage": "code"})
        app_id = answer.get("application_id") if isinstance(answer, dict) else None
        self._effect_set(effect["id"], "unknown", {"status": status, "code": code, "application_id": app_id})
        return await self.observe(run, f"unknown-{op}", "unknown", [q(op)], {"status": status, "code": code})

    STALE_CODES = ("suggestion_stale", "generation_mismatch", "tree_mismatch", "workspace_stale", "stale_generation")

    async def _apply_refused(self, run, op, why):
        """R3.12 (7): a definite no for the confirmed apply, nothing applied: apply-refused (op) retires its ledger entry
        with no debt and the request is ready again. Code saying the origin moved is followed by `stale`. If the
        confirmation was already superseded (not-the-confirmed-apply), the refusal is the readback of a plain reconciled."""
        verdict = await self.observe(run, f"apply-refused-{op}", "apply-refused", [q(op)], why)
        if not self.accepted(verdict):
            return await self.observe(run, f"reconciled-{op}", "reconciled", [q(op)], dict(why, readback="refused"))
        if why.get("code") in self.STALE_CODES:
            await self.observe(run, f"stale-after-{op}", "stale", [], why)
        return verdict

    async def _candidate_paths(self, run, cand):
        """The files a retained proposal touches, read in the person's scope (for the UI to re-read after Apply)."""
        ws = self.hive.minds._request_origin(self.hive.minds._request(run["request_id"]))["workspace_id"]
        status, saved = await self.client_factory(run).person_read(f"/v1/workspaces/{ws}/suggestions/{cand}")
        hunks = ((saved or {}).get("content") or {}).get("hunks") or [] if status == 200 and isinstance(saved, dict) else []
        return sorted({h.get("path") for h in hunks if isinstance(h, dict) and isinstance(h.get("path"), str)})

    async def _resume_apply(self, run, effect):
        """An apply left by a restart: `journaled` never reached Code and runs now (the person's consent still bounds
        it: an expired one refuses at issuance); `dispatching` may have, so it becomes unknown and is read back."""
        body = json.loads(effect["body"])
        if effect["state"] == "journaled":
            return self.accepted(await self._apply_effect(run, effect, run["person"]))
        self._effect_set(effect["id"], "unknown", {"reason": "interrupted"})
        return self.accepted(await self.observe(run, f"unknown-{body['op']}", "unknown", [q(body["op"])],
                                                {"reason": "interrupted"}))

    async def request_changes(self, rid, principal, text):
        """The person's Ask for changes: changes-requested (cand person) with their words as evidence (R3.12 (6)). Nothing
        is dispatched and no review is forged; the candidate is refuted and the next think prompt carries their words."""
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
            raise EngineError("text is 1 to 4000 characters", 400, "bad_request")
        async with self._lock(rid):
            run = self._run(rid)
            self._person(run, principal)
            _, view, _action = await self._reduce(run)
            if view["unresolved"] != []:
                raise EngineError("an earlier operation's outcome is still being read back", 409, "outcome_unresolved")
            if view["phase"] not in ("green", "ready") or view["pending"] != "none" \
                    or view["confirmed"] != "none":
                raise EngineError("changes can be asked for once a tested proposal is waiting", 409, "not_ready")
            cand = str(view["candidate"])
            verdict = await self.observe(run, f"changes-requested-{self._next(rid, 'changes-requested')}",
                                         "changes-requested", [q(cand), q(principal)],
                                         {"notes": text.strip(), "by": "person"})
            if not self.accepted(verdict):
                raise EngineError(f"the controller refused the change request: {render_any(verdict)}")
            self._save(rid, review="changes_requested")
            await self._step(rid)
        return self.view(rid)

    async def discard(self, rid, principal):
        """The person's Discard: the request is cancelled through the existing cancel path (its goal, lease and
        children with it); the reducer then records `cancelled` and stops."""
        run = self._run(rid)
        self._person(run, principal)
        if run["phase"] not in ("delivered", "stopped"):
            await self.hive.collab.cancel_request(rid, principal)
        return await self.step(rid)

    # ---- cleanup and the read view ------------------------------------------------------------------------------

    async def _cleanup(self, run):
        rid, phase = run["request_id"], run["phase"]
        if any(json.loads(e["body"]).get("phase") == phase for e in self._effects(rid, "cleanup")):
            return
        effect = self._effect_new(rid, "cleanup", {"phase": phase})
        if run["member"]:
            # a member holds no children or receiving goal: withdraw the goals its helper or reviewer still holds
            withdrawn = []
            for e in self._effects(rid):
                gid = json.loads(e["body"]).get("goal_id")
                if e["state"] == "waiting" and gid:
                    goal = self.db.one("SELECT status FROM goals WHERE id = ?", (gid,))
                    if goal and goal["status"] not in ("done", "submitted", "failed", "cancelled"):
                        self.hive.goals.update(gid, {"status": "cancelled"})
                        withdrawn.append(gid)
            self._effect_set(effect["id"], "done", {"withdrawn": withdrawn})
            return
        stopped, closed = [], None
        for row in self.db.all("SELECT id, state FROM mind_children WHERE request_id = ?", (rid,)):
            if row["state"] in ("stopped", "retired", "stop_requested"):
                continue
            with contextlib.suppress(Exception):
                await self.hive.minds.control(self._controller(run), row["id"],
                                              {"operation_id": f"cce.stop.{row['id']}"[:120], "action": "stop"},
                                              acting=self.principal)
                stopped.append(row["id"])
        req = self.hive.minds._request(rid)
        goal = self.db.one("SELECT * FROM goals WHERE id = ?", (req["receiving_goal"],))
        if goal is not None and goal["status"] not in ("done", "failed", "cancelled"):
            if phase == "delivered":
                applied = self.db.one("SELECT evidence FROM code_controller_journal WHERE request_id = ? AND kind = 'applied' "
                                      "AND verdict = 'accepted' ORDER BY seq DESC LIMIT 1", (rid,))
                receipt = _json(applied["evidence"]) if applied else None
                try:
                    await self.hive.goals.result(self._controller(run), goal["id"], "done",
                                                 f"Applied {run['candidate']} by the person's own Apply.",
                                                 {"binding": _json(goal["binding"]), "application": receipt},
                                                 trusted_review=True)
                except Exception:
                    self.hive.goals.update(goal["id"], {"status": "done"})
                closed = "done"
            elif phase == "stopped":
                self.hive.goals.update(goal["id"], {"status": "cancelled"})
                closed = "cancelled"
        self._effect_set(effect["id"], "done", {"stopped": stopped, "receiving_goal": closed})

    def _setup_problem(self, run):
        """Plain words when this request's helper cannot carry its proposal-path restrictions (read-only check)."""
        from .foundation import CHILD_TEMPLATE
        if run["member"]:
            return None
        lease = self.hive.minds._lease(run["lease_id"])
        if lease is None or CHILD_TEMPLATE not in json.loads(lease["template_ids"] or "[]"):
            return None
        problem = getattr(getattr(self.hive, "foundation", None), "helper_role_problem", lambda: None)()
        return problem

    def _actions(self, run):
        if run["member"]:
            return []                                       # no person routes for a plan member
        rid, status, phase = run["request_id"], run["status"], run["phase"]
        base = f"/api/requests/{rid}/controller"
        terminal = phase in ("delivered", "stopped")
        apply_ok = status == "ready_for_you" and bool(self.hive.settings.copy_apply_claims)
        why_apply = None if apply_ok else ("applying is off on this hive" if status == "ready_for_you"
                                           else "nothing is ready to apply")
        changes_ok = status == "ready_for_you"
        return [
            {"name": "apply", "label": "Apply", "method": "POST", "path": base + "/apply", "body": {},
             "available": apply_ok, "why_not": why_apply},
            {"name": "changes", "label": "Ask for changes", "method": "POST", "path": base + "/changes",
             "body": {"text": "string, 1-4000 characters"}, "available": changes_ok,
             "why_not": None if changes_ok else "changes can be asked for once a tested proposal is waiting"},
            {"name": "discard", "label": "Discard", "method": "POST", "path": base + "/discard", "body": {},
             "available": not terminal, "why_not": None if not terminal else "this request is finished"}]

    def view(self, rid):
        """GET /api/requests/{rq}/controller. Fields: request_id, engine, reducer_sha256, profile, review_policy, phase,
        status, candidate, unreviewed (true when the waiting proposal had no second opinion and the person's policy
        let it go on: the UI must say so plainly), next_action, review, last_error, test, second_opinion, max_repairs,
        actions [{name, label, method, path, body, available, why_not}], journal, effects, updated_at.

        Statuses: writing, repairing, testing, reviewing, checking, ready_for_you, waiting_for_your_apply, applied,
        needs_you, stopped, engine_error ("checking" while an unknown outcome is read back; last_error says why). setup_problem says plainly when the foundation helper role is missing.

        Live events on the hive event stream (all carry request_id):
          code.controller.status   {request_id, status, phase, candidate}: one per change of any of the three
          code.controller.applied  {request_id, candidate, workspace_id, paths, application_id, after}: the person's
                                   Apply landed; the UI re-reads those paths so the editor shows the applied text
          code.controller / code.controller.ready: the earlier untyped notices, kept for Surface Create R1."""
        run = self._run(rid)
        if run is None:
            return None
        tests = [json.loads(e["result"]) | {"state": e["state"]} if e["result"] else {"state": e["state"]}
                 for e in self._effects(rid, "test")]
        reviews = [{"state": e["state"], **{k: v for k, v in json.loads(e["body"]).items() if k in ("candidate", "reviewer_id")},
                    **(json.loads(e["result"]) if e["result"] else {})} for e in self._effects(rid, "review")]
        return {"request_id": rid, "engine": f"metta-coding-controller/{REDUCERS.get(run['reducer_sha256'], (None, REDUCER_VERSION))[1]}",
                "reducer_sha256": run["reducer_sha256"],
                "profile": run["profile"], "review_policy": run["review_policy"], "phase": run["phase"],
                "status": run["status"], "candidate": run["candidate"],
                "unreviewed": bool(run["next_action"] and run["next_action"].startswith("(tell confirm-unreviewed-to-apply")),
                "next_action": run["next_action"], "review": run["review"], "last_error": run["last_error"],
                "test": tests[-1] if tests else None, "second_opinion": reviews[-1] if reviews else None,
                "plan": ({k: json.loads(run["member"])[k] for k in ("plan_id", "piece", "paths", "assignee")}
                         if run["member"] else None),
                "max_repairs": run["max_repairs"], "actions": self._actions(run), "setup_problem": self._setup_problem(run),
                "journal": [{"seq": r["seq"], "id": r["obs_id"], "kind": r["kind"], "fields": r["fields"],
                             "verdict": r["verdict"], "at": r["at"],
                             "evidence": json.loads(r["evidence"]) if r["evidence"] else None} for r in self._journal(rid)],
                "effects": [{"kind": e["kind"], "seq": e["seq"], "state": e["state"]} for e in self._effects(rid)],
                "updated_at": run["updated_at"]}


def render_any(value):
    if isinstance(value, Str):
        return '"' + value + '"'
    if isinstance(value, list):
        return "(" + " ".join(render_any(v) for v in value) + ")"
    return str(value)


def _plain(value):
    return None if value in (None, "none") else str(value)


def _json(text):
    try:
        return json.loads(text) if text else None
    except (TypeError, ValueError):
        return None


def _unified_diff(path, raw, hunks, moved=False, context=3):
    """A unified diff of one file: its current bytes (read in the person's scope) and the same bytes with the proposal's
    hunks applied by byte range, with `context` lines around each change. Each hunk's before_digest is checked against
    the bytes it replaces, so the reviewer is told when the file no longer matches what the proposal was made on."""
    import difflib
    note = "the workspace moved since the proposal was made; the context is today's file" if moved else None
    after, ok = bytearray(raw), True
    for h in sorted(hunks, key=lambda h: (h.get("start_byte") or 0), reverse=True):
        start, end, repl = h.get("start_byte"), h.get("end_byte"), h.get("replacement")
        if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(raw) or not isinstance(repl, str):
            ok = False
            continue
        if isinstance(h.get("before_digest"), str) and hashlib.sha256(raw[start:end]).hexdigest() != h["before_digest"]:
            ok = False
        after[start:end] = repl.encode("utf-8")
    if not ok:
        note = "a hunk does not match the file's current bytes; the diff may not show what the proposal was made on"
    before_text, after_text = raw.decode("utf-8", "replace"), bytes(after).decode("utf-8", "replace")
    diff = "".join(difflib.unified_diff(before_text.splitlines(keepends=True), after_text.splitlines(keepends=True),
                                        fromfile="a/" + path, tofile="b/" + path, n=context))
    return {"path": path, "diff": diff[:8000], "truncated": len(diff) > 8000, "note": note}


def _recorded(out):
    """Minds write routes answer (status, recorded bytes)."""
    if isinstance(out, tuple):
        status, raw = out[0], out[1]
        if status >= 300:
            raise EngineError(f"refused {status}")
        return json.loads(raw)
    return out


def _allocation(minds, req, template_id):
    template = minds.templates.get(template_id) or {}
    left = float(req["limit_usd"]) - float(req["allocated_usd"])
    return round(max(0.01, min(float(template.get("max_allocation_usd", 0.25)), left)), 6)
