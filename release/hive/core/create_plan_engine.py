# Purpose: the Create plan engine: journals each plan, runs the MeTTa plan controller over it, performs the effects
# it decides, and says which person's live plan waits on a mind.
"""Create plans: the host engine for the MeTTa plan controller R4.4 (slice 1: "make me a small web page that shows X").

Every decision lives in the vendored reducer modules/create/controller/create_plan_controller_r4_4.metta (R4.4, sha-pinned
below, run unchanged in a disposable PeTTa child per call). Host mapping: modules/create/controller/R4_HOST_MAPPING.md.
This module only journals, translates and performs effects:
  - one journal per plan (create_plan_journal, insert-only, idempotent by observation id) holding (O id kind plan epoch
    fields); an effect is performed only after its journalling observation is ACCEPTED (plan-started, dispatched,
    piece-started, deploy-approved), and its effect row commits in the same transaction;
  - the journal is replayed through the reducer for the state and `next-action`; the action is performed by a port:
      (think make-the-plan)            planner mind call -> typed plan, validated -> `planned` (or `plan-failed`)
      (think author-acceptance-tests)  test author -> a stdlib check written into the hive-owned build workspace and
                                       checkpointed as the base -> `tests-authored`; the first run on base must be red
      (do (run-checks base|ckpt))      the authored check on that checkpoint -> check-pass / check-fail /
                                       check-broken (crashed | no-verdict: the check itself gave no verdict; R4.4 sends
                                       it back to its author with the error tail) / check-unknown (timeout, sandbox)
      (do (start-piece p))             the piece's assignee resolved by the host resolver (create_assignees.py) ->
                                       `piece-started (p task builder)` -> the builder port; its candidate is a checkpoint
                                       of the piece's own fork -> `piece-ready (p cand)` / `piece-blocked (p)`
      (do (request-review p c))        reviewer resolved (never an author, builder or the person) -> review-pass/-fail,
      (do (request-design-review p c)) design review with the host's render evidence (the appFrame document digest),
                                       or review-unavailable when nobody can review
      (do (integrate p c))             build space merge of the piece's candidate into the integration workspace, with a
                                       new checkpoint -> `integrated` / `merge-conflict`
      (do (route-fix p run))           the piece's own assignee again, with the failing output of run
      (tell ask-person q)              a question card + create.plan.question, then `question-asked`
      (do (preview-deploy ckpt))       a pinned UI bundle preview of the checkpoint -> `preview-deployed` / `preview-failed`
      (tell confirm-deploy plan)       ready: the person's go (route) journals `deploy-approved (op person)`
      (do (deploy op))                 install as a hive app -> `deployed` / `deploy-refused` / `unknown`
      (do (reconcile op))              read back the operation -> `reconciled`
  - wake-ups are host events (goal.updated for a pending mind call) and the person's routes; nothing polls with a model.

Who builds or reviews is never hard-coded: pieces carry an assignee selector, resolved over what exists (see
create_assignees.py). Effects run through ports (create_plan_ports.py holds the hive's own); tests replace them.
Reused from the per-change engine (code_controller_engine.py, unchanged): Reducer (the disposable PeTTa child), render,
parse, q/Str, EngineError and the journal/effect pattern.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import pathlib
import re
import sys
import tempfile

from .code_controller_engine import GOAL_REASON_SAID, EngineError, Reducer, Str, parse, q, render, render_any
from .db import new_id, now
from .goals import UNFINISHED

log = logging.getLogger("hive")

ROOT = pathlib.Path(__file__).resolve().parents[2]
REDUCER = ROOT / "modules/create/controller/create_plan_controller_r4_4.metta"
REDUCER_SHA256 = "1a761627e2c838d94d5dae2e9b7a0edfdf2f1a9430fab3120921e8872091e178"   # R4.4 (327/327)
REDUCER_VERSION = "R4.4"
# R4.3, R4.2 and R4.1 stay vendored beside it, unchanged: a plan started under one keeps replaying with it, and the engine
# writes that version's shapes for it (Caps fields, Needs fields, tests-authored fields; see _caps/_needs/_suite).
REDUCER_R4_2 = ROOT / "modules/create/controller/create_plan_controller_r4_2.metta"
REDUCER_R4_2_SHA256 = "490c7ae05b36b779ab63a3fc982e18a93e984a0b1e53445695eef2c8ea0a974c"   # R4.2 (253/253)
# R4.0 (create_plan_controller_r4.metta) also stays in the folder; its shapes predate this engine's R4.1 mapping, so no
# plan is ever started or replayed under it here.
REDUCER_R4_1 = ROOT / "modules/create/controller/create_plan_controller_r4_1.metta"
REDUCER_R4_1_SHA256 = "b48a178d756757d4c7effdc46bfa9eaae5ae52fac53b6d9677edf4ada6076209"   # R4.1 (228/228)
REDUCER_R4_3 = ROOT / "modules/create/controller/create_plan_controller_r4_3.metta"
REDUCER_R4_3_SHA256 = "24c3987d33218263bdd8cbd192d1ff39187e1d993dc1a614a35c039978b4f223"   # R4.3 (277/277)
REDUCERS = {REDUCER_SHA256: (REDUCER, "R4.4"), REDUCER_R4_3_SHA256: (REDUCER_R4_3, "R4.3"),
            REDUCER_R4_2_SHA256: (REDUCER_R4_2, "R4.2"),
            REDUCER_R4_1_SHA256: (REDUCER_R4_1, "R4.1")}
# R4.4 carries R4.3's shapes and adds check-broken (run why); plans under R4.1-R4.3 get check-unknown for it instead.
BROKEN_CHECK = ("crashed", "no-verdict")       # SandboxChecks reasons that mean the check itself is broken
# R4.3 Needs (Reserved path...): paths no piece may own, as data (create_plan_settings 'reserved_paths', seeded here):
# the check itself and the stdlib module files the check contract imports (json, pathlib, re, html.parser and their
# imports), so no piece can even own a file that could shadow them. The runner also never puts the build on the
# check's import path, and the host refuses any piece .py file named like a stdlib module (validate_plan).
CHECK_IMPORTS = ("json", "pathlib", "re", "html", "_markupbase", "sys", "os", "io", "codecs", "encodings", "string",
                 "collections", "functools", "itertools", "operator", "keyword", "types", "typing", "enum", "abc",
                 "copyreg", "reprlib", "weakref", "warnings", "stat", "posixpath", "genericpath", "fnmatch", "ntpath",
                 "urllib", "sre_compile", "sre_parse", "sre_constants", "runpy", "importlib", "contextlib")
DEFAULT_RETRIES = 3          # seeds the create_plan_settings row 'retries' (an owner changes the row, not this code)
REVIEW_POLICIES = ("review-required", "review-waivable")
PIECE_REPAIRS, FIX_ROUNDS, BUDGET = 2, 2, 2    # slice 1: 2 repairs a piece, 2 fix rounds, 2 pieces building at once
MAX_STEPS = 48
MAX_SENTENCE = 2000
MAX_PIECES = 12                                 # goals.py MAX_CHILDREN: a plan is a goal tree of at most 12 pieces
CHECK_PATH = "checks/acceptance_check.py"
CHECK_DIR = "checks/"
MAX_FILES_PER_PIECE = 20
FILE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./-]{0,159}")
ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,47}")
TERMINAL = ("deployed", "stopped")
# Every goal a plan gives a mind (create_plan_ports.GoalMinds: planner, designer, test author, reviewer; and
# code_controller_member: a piece's build) names the plan as its creator, which no other writer uses (a mind's own goals
# are agent:<id>), so the hive can tell a mind is doing a person's plan (CreatePlanEngine.waiting_on).
GOAL_CREATOR = "create-plan:"
# The states of such a goal the plan still waits on: unfinished and not yet submitted, since the plan reads a submitted
# goal's proposal as the answer (GoalMinds.collect, code_controller_member.helper_result). A Code request reads its
# second opinion's goal the same way (CodeControllerEngine.waiting_on and review_goal).
AWAITED = tuple(s for s in UNFINISHED if s != "submitted")


def goal_creator(plan_id):
    return GOAL_CREATOR + plan_id

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS create_plan_runs (plan_id TEXT PRIMARY KEY, person TEXT NOT NULL, sentence TEXT NOT NULL,
  epoch TEXT NOT NULL, reducer_sha256 TEXT NOT NULL, review_policy TEXT NOT NULL, lease INTEGER NOT NULL,
  piece_cap INTEGER NOT NULL, fix_cap INTEGER NOT NULL, phase TEXT, status TEXT NOT NULL, next_action TEXT,
  last_error TEXT, space TEXT, installed TEXT, state TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS create_plan_journal (plan_id TEXT NOT NULL, seq INTEGER NOT NULL, obs_id TEXT NOT NULL,
  kind TEXT NOT NULL, fields TEXT NOT NULL, verdict TEXT NOT NULL, evidence TEXT, at TEXT NOT NULL,
  UNIQUE (plan_id, seq), UNIQUE (plan_id, obs_id))""",
    """CREATE TABLE IF NOT EXISTS create_plan_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TRIGGER IF NOT EXISTS create_plan_journal_u BEFORE UPDATE ON create_plan_journal
  BEGIN SELECT RAISE(ABORT, 'the plan journal is insert-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS create_plan_journal_d BEFORE DELETE ON create_plan_journal
  BEGIN SELECT RAISE(ABORT, 'the plan journal is insert-only'); END""",
    # host effects, journalled with the observation that admits them
    """CREATE TABLE IF NOT EXISTS create_plan_effects (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, kind TEXT NOT NULL,
  op TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, result TEXT, goal_id TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE (plan_id, kind, op))""",
]


def qp(path):
    """A file path as a quoted MeTTa string. Paths carry '/', which the per-change engine's q() (ids only) refuses, so
    they get their own check: the FILE pattern (no quote, backslash, space or '..' segment) before quoting."""
    path = str(path)
    if not FILE.fullmatch(path) or ".." in path.split("/"):
        raise EngineError(f"not a file path the controller carries: {path!r}")
    return Str(path)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _digest(value):
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _plain(value):
    """Reducer output -> JSON: strings stay strings, symbols stay strings, lists stay lists."""
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value if isinstance(value, int) else str(value)


class PlanReducer(Reducer):
    """The per-change engine's disposable-PeTTa-child runner, pinned to the plan reducer instead."""

    def __init__(self, petta_path, path=REDUCER, sha=REDUCER_SHA256, version=REDUCER_VERSION):
        self.petta = pathlib.Path(petta_path)
        raw = pathlib.Path(path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != sha:
            raise EngineError(f"the vendored plan controller is not the pinned {version}")
        self.version, self.raw, self.name = version, raw, pathlib.Path(path).name
        self.stem = pathlib.Path(path).stem
        self._fresh_dir()

    def _fresh_dir(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="create-plan-"))
        (self.dir / self.name).write_bytes(self.raw)

    async def run(self, expr, timeout=60):
        """As the per-change Reducer.run; a scratch folder removed under it (a temp sweep) is made again from the
        pinned bytes it already verified, never re-read from disk."""
        if not (self.dir / self.name).is_file():
            self._fresh_dir()
        return await super().run(expr, timeout)


def state_view(s):
    """The reducer's key/value state as a dict (seen dropped)."""
    if not isinstance(s, list) or not all(isinstance(e, list) and len(e) == 2 for e in s):
        raise EngineError("the reducer did not answer a state")
    view = {str(k): v for k, v in s}
    view.pop("seen", None)
    if "phase" not in view:
        raise EngineError("the reducer did not answer a state")
    return view


# ---- the typed plan (OmegaPlanner shapes) -----------------------------------------------------------------------

#: the evidence a review can be given: none, or the host's render of the candidate (_review_prepare makes no other)
REVIEW_EVIDENCE = ("none", "render")
#: every rule a plan is refused for, by validate_plan or by the reducer's on-planned (create_plan_controller_r4_4.metta),
#: each keyed by its refusal code with the words a planner follows to pass it. The planner's answer shape states every
#: rule (create_plan_ports.ANSWER_SHAPES), and a refused plan's next packet names the rule it broke: on a fresh install's
#: first real plans the planner, told only the fields' names, broke one rule after another and repeated itself, and
#: told the reducer's bare code design-pieces-carry-the-design it sent the same plan four times
# the kinds a piece can be (create_plan_ports.PLAN_SHAPE says the same: code, or design for a designed look)
PIECE_KINDS = ("code", "design")

PLAN_RULES = {
    "plan_not_an_object": "the plan is one JSON object",
    "step_count_limit": f"a plan has 1 to {MAX_PIECES} pieces",
    "invalid_step": "each piece has an id (a word) and kinds, a list of words (code, or design for a designed look)",
    "invalid_assignee": "an assignee, when given, is a selector list",
    "invalid_dependencies": "deps lists the ids of other pieces, each once",
    "duplicate_step": "no two pieces have the same id",
    "unknown_dependency": "deps names only pieces of this plan",
    "dependency_cycle": "deps never loop back: no piece depends on itself through other pieces",
    "invalid_files": f"each piece names the 1 to {MAX_FILES_PER_PIECE} files it writes, as plain relative paths: the "
                     "scaffold's index.html, style.css and app.js, or new files beside them",
    "file_owned_twice": "no two pieces write the same file",
    "piece_owns_the_acceptance_check": f"no piece writes {CHECK_PATH} or anything else under {CHECK_DIR}",
    "piece_file_shadows_a_stdlib_module": "no piece's .py file is named like a Python standard library module",
    "no_acceptance_criteria": "acceptance lists, as sentences, what the finished thing must do",
    "invalid_unknowns": "each question has its own q (a word) and about: plan, deploy or {\"piece\": id} naming a piece "
                        "of this plan",
    "invalid_needs": "needs.design is design or no-design and needs.tests author or detect; a review names its kinds as "
                     "words and its evidence as " + " or ".join(REVIEW_EVIDENCE) + "; a cap's selector is a list and its "
                     "n a whole number above 0",
    "piece_owns_a_reserved_path": "no piece writes a path the hive reserves",
    "detect_without_a_check": f"needs.tests is detect only when the scaffold already has {CHECK_PATH} "
                              "(scaffold_has_acceptance_check in the packet); otherwise author",
    "design_step_unstaffed": "needs.design is design only when design is in staffed_kinds: a hive with no design maker "
                             "can't take a design step, so there the look goes in code pieces and needs.design is "
                             "no-design",
    "design-pieces-carry-the-design": "needs.design is design only when no piece has the kind design: a piece of kind "
                                      "design carries the look itself, so a plan with one says no-design",
    # short: the plan shape and every rule share one goal read with the request's first 200 characters
    # (create_plan_ports.task_text, TASK_READ_CHARS), and the host adds the dependencies it can itself
    "design_piece_before_its_page": "no piece writing index.html depends on a design piece, even through others, "
                                    "since a design review renders the page",
    "no-review-for-artifact-kind": "every kind a piece has is reviewed, by one of the hive's own reviews (hive_reviews) "
                                   "or by one the plan adds",
}
#: the reducer's codes for rules the host checks first under its own code: either refusal finds the same words
PLAN_RULE_ALIASES = {"invalid_plan_object": "plan_not_an_object", "piece-owns-reserved-path": "piece_owns_a_reserved_path",
                     "reducer-symbol-kind": "invalid_step"}


def plan_rule(code):
    """The words of the rule a refusal code names, or the code itself when no rule has words for it."""
    return PLAN_RULES.get(PLAN_RULE_ALIASES.get(code, code), code)


def validate_plan(plan):
    """A planner result -> (normalised plan, None) or (None, why). The reducer validates the graph again (its
    validate_plan codes); this only checks the types the host must translate."""
    if not isinstance(plan, dict):
        return None, "plan_not_an_object"
    pieces = plan.get("pieces")
    if not isinstance(pieces, list) or not 1 <= len(pieces) <= MAX_PIECES:
        return None, "step_count_limit"
    out = []
    for p in pieces:
        if not isinstance(p, dict) or not ID.fullmatch(str(p.get("id", ""))):
            return None, "invalid_step"
        kinds = p.get("kinds") or ([p["kind"]] if isinstance(p.get("kind"), str) else None)
        if not isinstance(kinds, list) or not kinds or not all(symbol_ok(k) for k in kinds):
            return None, "invalid_step"
        assignee = p.get("assignee")
        if assignee is not None and not valid_selector(assignee):
            return None, "invalid_assignee"
        deps, files = p.get("deps", []), p.get("files", [])
        if not isinstance(deps, list) or not all(isinstance(d, str) and ID.fullmatch(d) for d in deps):
            return None, "invalid_dependencies"
        if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES_PER_PIECE or \
                not all(isinstance(f, str) and FILE.fullmatch(f) and ".." not in f.split("/") for f in files):
            return None, "invalid_files"
        if any(f == CHECK_PATH or f.startswith(CHECK_DIR) for f in files):
            return None, "piece_owns_the_acceptance_check"   # a builder may never write the check that judges it
        if any(f.endswith(".py") and f.split("/")[0].removesuffix(".py") in sys.stdlib_module_names for f in files):
            return None, "piece_file_shadows_a_stdlib_module"
        out.append({"id": p["id"], "kinds": kinds, "assignee": assignee, "deps": deps, "files": files,
                    "title": str(p.get("title") or p["id"])[:120], "brief": str(p.get("brief") or "")[:4000]})
    acceptance = [str(a)[:500] for a in plan.get("acceptance", []) if isinstance(a, str)][:20]
    if not acceptance:
        return None, "no_acceptance_criteria"
    questions = []
    for qq in plan.get("questions", []) or []:
        if not isinstance(qq, dict) or not ID.fullmatch(str(qq.get("q", ""))):
            return None, "invalid_unknowns"
        about = qq.get("about", "plan")
        if not (about in ("plan", "deploy") or (isinstance(about, dict) and set(about) == {"piece"})):
            return None, "invalid_unknowns"
        choices = [str(c)[:200] for c in qq.get("choices", []) if isinstance(c, str)][:8]
        questions.append({"q": qq["q"], "about": about, "text": str(qq.get("text") or "")[:1000], "choices": choices})
    needs = plan.get("needs") or {}
    design = needs.get("design", "no-design")
    tests = needs.get("tests", "author")
    if design not in ("design", "no-design") or tests not in ("author", "detect"):
        return None, "invalid_needs"
    reviews = []
    for r in needs.get("reviews") or []:
        if not (isinstance(r, dict) and all(symbol_ok(r.get(k)) for k in ("artifact_kind", "review_kind"))
                and r.get("evidence") in REVIEW_EVIDENCE):   # evidence nothing produces would hold the review forever
            return None, "invalid_needs"
        reviews.append({k: r[k] for k in ("artifact_kind", "review_kind", "evidence")})
    caps = []
    for c in needs.get("caps") or []:
        if not (isinstance(c, dict) and valid_selector(c.get("selector")) and type(c.get("n")) is int and c["n"] > 0):
            return None, "invalid_needs"
        caps.append({"selector": c["selector"], "n": c["n"]})
    return {"title": str(plan.get("title") or "")[:120], "pieces": out, "acceptance": acceptance,
            "questions": questions, "needs": {"design": design, "tests": tests, "reviews": reviews, "caps": caps}}, None


def page_before_design(pieces):
    """Make each design piece depend on the pieces writing the page its design review renders (the frame's UI files
    over the integration checkpoint): the piece writing index.html, whatever its kind, and every code piece writing
    style.css or app.js. Until they are built the review sees the scaffold's placeholder for their files: on v0.41's
    Linux check (20 Nov) a tip calculator's plan gave its look piece (style.css) no deps, the reducer built it before
    the piece writing index.html and app.js, and its design review failed six times on the placeholder while that
    piece waited, until the plan stopped at 360 s. A dependency the plan's own order already gives is not added again,
    and a writer the plan builds after the look keeps that order, except the index.html writer after a look that
    doesn't write it: that review can only see the placeholder, so the plan is refused. Which edges are added is read
    from the plan's own order alone, so it doesn't depend on the pieces' order in the list. Returns the ids of the
    design pieces such an order puts first, leaving the plan as it came, else [] with every piece's deps updated.
    Time: one walk of the graph per piece, then one per design piece, at most 2p * (p + e) steps for p pieces and e
    deps edges, plus p * p file comparisons."""
    from .create_plan_ports import UI_FILES          # the files the render reads; imported here as _render does
    deps = {x["id"]: list(x["deps"]) for x in pieces}

    def reach(start):   # every piece `start` depends on, directly or through other pieces
        seen, todo = set(), list(deps.get(start, ()))
        while todo:
            d = todo.pop()
            if d not in seen:
                seen.add(d)
                todo.extend(deps.get(d, ()))
        return seen

    first = {x["id"]: reach(x["id"]) for x in pieces}     # the plan's own order, before anything is added
    late = []
    for x in pieces:
        if "design" not in x["kinds"]:
            continue
        for w in pieces:
            writes = set(w["files"]) & set(UI_FILES)
            if w is x or not writes or ("design" in w["kinds"] and "index.html" not in writes):
                continue
            if x["id"] in first[w["id"]]:                 # the plan builds this writer after the look
                if "index.html" in writes and "index.html" not in x["files"] and x["id"] not in late:
                    late.append(x["id"])
            elif w["id"] not in first[x["id"]]:
                deps[x["id"]].append(w["id"])
    # an added edge closing a loop through other added edges is an order no dependency can fix either
    late += [x["id"] for x in pieces if "design" in x["kinds"] and x["id"] not in late and x["id"] in reach(x["id"])]
    if late:
        return late
    for x in pieces:
        x["deps"] = deps[x["id"]]
    return []


def own_the_app(pieces):
    """In a change round, give each of the app's UI files no piece writes (index.html, style.css, app.js) to the piece
    best placed for it, within a piece's file limit: style.css to a design piece first, the others to a code piece
    first, a piece already writing a UI file before one that writes none, then the plan's order, taking the first of
    those whose new file keeps page_before_design accepting the plan. The round changes an app whose look lives in
    style.css and whose behaviour lives in app.js, and a piece barred from one of them can't make a change that needs
    it: on v0.41's Mac check (20 Nov) a change round planned one piece writing index.html alone for a Quick 20% button,
    app.js, which no piece could write, marked both 20% buttons active where the change's probe wanted one, and the
    plan held after 0.70 USD with only Try again or Stop. A piece may write a file it is given without having to, and
    the probe's cases for what the app already does keep the rest as it was. Giving index.html to a code piece that
    waits on a look would make page_before_design refuse a plan it accepted (a look writing style.css, a code piece
    writing app.js after it: a probe of 20 Nov found 120 of 3,299 small plans turned so), so a piece
    placed lower that keeps the plan, such as a piece with no deps, is taken first; only when none does is the
    best-placed piece taken anyway, and the plan comes back to its planner as page_before_design's rule.
    Time: per file, a sort of p pieces and at most p trial runs of page_before_design, each p * (p + e)."""
    from .create_plan_ports import UI_FILES          # the frame's files; imported here as _render does
    owned = {f for x in pieces for f in x["files"]}
    for f in UI_FILES:
        if f in owned:
            continue
        design = f == "style.css"
        ranked = sorted(pieces, key=lambda x: (("design" in x["kinds"]) != design,
                                               not set(x["files"]) & set(UI_FILES), pieces.index(x)))
        room = [x for x in ranked if len(x["files"]) < MAX_FILES_PER_PIECE]

        def keeps(x):   # the plan with f given to x, as page_before_design reads it, on copies
            trial = [{**p, "files": [*p["files"], f] if p is x else list(p["files"]), "deps": list(p["deps"])}
                     for p in pieces]
            return not page_before_design(trial)
        to = next((x for x in room if keeps(x)), room[0] if room else None)
        if to is not None:
            to["files"] = [*to["files"], f]
            owned.add(f)


RESERVED = {"none", "True", "False", "Empty", "base", "blocked", "plan", "deploy"}   # reducer symbols, never data


def symbol_ok(x):
    return isinstance(x, str) and bool(ID.fullmatch(x)) and x not in RESERVED


def valid_selector(sel):
    """["team", swarm] | ["mind", agent] | ["capability", cap] | ["hive", hive, cap] | ["open", cap]."""
    if not isinstance(sel, list) or not sel or not all(isinstance(x, str) for x in sel):
        return False
    shape = {"team": 2, "mind": 2, "capability": 2, "hive": 3, "open": 2}.get(sel[0])
    if shape != len(sel):
        return False
    if sel[0] in ("team", "mind"):
        return bool(re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", sel[1]))
    if sel[0] == "hive":
        return bool(re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", sel[1])) and symbol_ok(sel[2])
    return symbol_ok(sel[1])


def selector_atom(sel):
    """A selector as the reducer's (Assignee ...) atom: ids cross as strings, capability names as symbols."""
    if sel[0] in ("team", "mind"):
        return ["Assignee", sel[0], q(sel[1])]
    if sel[0] == "hive":
        return ["Assignee", "hive", q(sel[1]), sel[2]]
    return ["Assignee", sel[0], sel[1]]


def review_atom(r):
    return ["ReviewFor", r["artifact_kind"], r["review_kind"], r["evidence"]]


def about_atom(about):
    if isinstance(about, dict):
        return ["piece", q(about["piece"])]
    return about


def about_json(atom):
    if isinstance(atom, list) and atom[:1] == ["piece"]:
        return {"piece": str(atom[1])}
    return str(atom)


class CreatePlanEngine:
    def __init__(self, hive, ports=None):
        self.hive, self.db = hive, hive.db
        for statement in SCHEMA:
            self.db.execute(statement)
        if "retry_cap" not in {r["name"] for r in self.db.all("PRAGMA table_info(create_plan_runs)")}:
            # R4.2: the plan's lost-operation budget (Ctx Caps third field), fixed per plan so every replay agrees
            self.db.execute("ALTER TABLE create_plan_runs ADD COLUMN retry_cap INTEGER")
        self.db.execute("INSERT OR IGNORE INTO create_plan_settings (key, value, updated_at) VALUES ('retries', ?, ?)",
                        (str(DEFAULT_RETRIES), now()))
        reserved = [CHECK_PATH] + [p for m in CHECK_IMPORTS for p in (f"{m}.py", f"{m}/__init__.py")]
        self.db.execute("INSERT OR IGNORE INTO create_plan_settings (key, value, updated_at) VALUES ('reserved_paths', ?, ?)",
                        (json.dumps(reserved), now()))
        from .create_assignees import AssigneeResolver
        self.assignees = AssigneeResolver(hive)
        self._reducer = None
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: set[asyncio.Task] = set()
        self._watch = None
        if ports is None:
            from .create_plan_ports import HivePorts
            ports = HivePorts(self)
        self.ports = ports
        self.principal = "host:create-plan-engine"
        self._piece_seen: dict[str, dict] = {}

    # ---- wiring ------------------------------------------------------------------------------------------------

    def enabled(self):
        return bool(getattr(self.hive.settings, "create_plan_engine", False))

    def waiting_on(self, agent_id):
        """The person whose live plan waits on this mind, or None: the plan gave it a goal it hasn't answered yet (AWAITED)
        and is neither deployed nor stopped, while the engine runs. Only a person starts a plan (start), so what the mind
        spends on it is that person's own work (Hive.present_for). Time: one scan of goals (no index on assignee) and of
        the plan runs."""
        if not self.enabled():
            return None
        row = self.db.one(f"SELECT r.person FROM goals g JOIN create_plan_runs r ON g.created_by = ? || r.plan_id "
                          f"WHERE g.assignee = ? AND g.status IN ({','.join('?' * len(AWAITED))}) "
                          f"AND COALESCE(r.phase, '') NOT IN ({','.join('?' * len(TERMINAL))}) ORDER BY r.created_at LIMIT 1",
                          (GOAL_CREATOR, agent_id, *AWAITED, *TERMINAL))
        return row["person"] if row else None

    @property
    def reducer(self):
        return self.reducer_for(REDUCER_SHA256)

    def reducer_for(self, sha):
        if self._reducer is None:
            self._reducer = {}
        if sha not in self._reducer:
            if sha not in REDUCERS:
                raise EngineError(f"no vendored plan controller with sha {sha[:12]}")
            path, version = REDUCERS[sha]
            self._reducer[sha] = PlanReducer(self.hive.settings.petta_path, path, sha, version)
        return self._reducer[sha]

    def setting(self, key, default=None):
        row = self.db.one("SELECT value FROM create_plan_settings WHERE key = ?", (key,))
        return row["value"] if row else default

    def set_setting(self, key, value):
        self.db.execute("INSERT INTO create_plan_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO "
                        "UPDATE SET value = excluded.value, updated_at = excluded.updated_at", (key, str(value), now()))

    def close(self):
        if self._watch is not None:
            self._watch.cancel()
        for reducer in (self._reducer or {}).values():
            reducer.close()
        self._reducer = None

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
            log.exception("create plan: %s failed", label)

    def ensure_watch(self):
        if self._watch is None or self._watch.done():
            with contextlib.suppress(RuntimeError):
                self._watch = asyncio.get_running_loop().create_task(self.watch())

    async def watch(self):
        """Host events only: a pending mind call's goal changed. Never a model poll."""
        queue = self.hive.events.subscribe()
        try:
            for r in self.db.all("SELECT plan_id FROM create_plan_runs WHERE phase IS NULL OR phase NOT IN "
                                 "('deployed', 'stopped')"):
                self._spawn(self.step(r["plan_id"]), "resume")
            while True:
                frame = json.loads(await queue.get())
                self._spawn(self.on_event(frame), "event")
        finally:
            self.hive.events.unsubscribe(queue)

    async def on_event(self, frame):
        if frame.get("type") == "code.controller.member_ready" and frame.get("task_id"):
            return await self.goal_changed(f"member:{frame['task_id']}")    # a piece's per-change member is ready
        if frame.get("type") == "code.controller.status" and frame.get("request_id"):
            # any member's change of status or phase, a block included: a member that blocked after its retries left
            # its plan building with no error, since only member_ready woke it
            return await self.goal_changed(f"member:{frame['request_id']}")
        if frame.get("type") != "goal.updated":
            return None
        gid = (frame.get("goal") or {}).get("id")
        return await self.goal_changed(gid) if gid else None

    async def goal_changed(self, goal_id):
        e = self.db.one("SELECT plan_id FROM create_plan_effects WHERE goal_id = ? AND state = 'waiting'", (goal_id,))
        if e is None:
            return None
        pid = e["plan_id"]
        async with self._lock(pid):
            effect = self.db.one("SELECT * FROM create_plan_effects WHERE goal_id = ? AND state = 'waiting'", (goal_id,))
            if effect is None:
                return None
            out = await self.ports.collect(self._run(pid), effect["kind"], self._body(effect), goal_id)
            if out is None:
                return None                                   # not finished yet
            await self._finish(self._run(pid), effect, out)
            return await self._step(pid)

    def _lock(self, pid):
        return self._locks.setdefault(pid, asyncio.Lock())

    # ---- journal -----------------------------------------------------------------------------------------------

    def _run(self, pid):
        return self.db.one("SELECT * FROM create_plan_runs WHERE plan_id = ?", (pid,))

    def _journal(self, pid):
        return self.db.all("SELECT * FROM create_plan_journal WHERE plan_id = ? ORDER BY seq", (pid,))

    def previous_check_error(self, pid):
        """The last broken check's evidence (reason, exit code, error tail), when no suite was authored since: the
        test author's next brief carries it, so it fixes its own check instead of writing the same one again."""
        last = None
        for r in self.db.all("SELECT kind, evidence FROM create_plan_journal WHERE plan_id = ? AND verdict = 'accepted' "
                             "AND kind IN ('check-broken', 'tests-authored') ORDER BY seq", (pid,)):
            last = (json.loads(r["evidence"] or "{}") if r["kind"] == "check-broken" else None)
        if not last:
            return None
        return {k: last.get(k) for k in ("reason", "why", "exit_code", "output", "stderr") if last.get(k) is not None}

    def staffed_kinds(self, person):
        """The piece kinds this hive can build for `person` now: each kind whose default assignee resolves to a team or
        mind that offers it. The planner is told them, since a Mac install has no design maker: a design piece there
        found nobody, and R4.1 asks its person to make one available, which a tester can't. Time: one resolution per
        kind in PIECE_KINDS."""
        return [k for k in PIECE_KINDS if self.assignees.resolve(self.assignees.default_selector(k), person)["resolved"]]

    def previous_plan_refusal(self, pid):
        """Why the last plan was refused, when none was accepted since: {code, rule}, the refusal's code and the words of
        the rule it names (plan_rule), whether the host's check or the reducer refused it; {refused} with the reducer's
        rendered answer when it named no code. The planner's next packet carries it, so it fixes that and doesn't
        answer the same plan again."""
        last = None
        for r in self.db.all("SELECT kind, evidence FROM create_plan_journal WHERE plan_id = ? AND kind IN ('plan-failed', "
                             "'planned') AND verdict = 'accepted' ORDER BY seq", (pid,)):
            last = json.loads(r["evidence"] or "{}") if r["kind"] == "plan-failed" else None
        if not last:
            return None
        code = last.get("invalid") or last.get("code")
        if code:
            out = {"code": code, "rule": plan_rule(code)}
            return {**out, "paths": last["paths"]} if last.get("paths") else out
        return {"refused": last["refused"]} if last.get("refused") else None

    def _evidence(self, pid, obs_id):
        row = self.db.one("SELECT evidence FROM create_plan_journal WHERE plan_id = ? AND obs_id = ?", (pid, obs_id))
        return json.loads(row["evidence"]) if row and row["evidence"] else {}

    def _plan(self, pid):
        """The accepted typed plan (the `planned` observation's evidence), or None."""
        row = self.db.one("SELECT evidence FROM create_plan_journal WHERE plan_id = ? AND kind = 'planned' AND "
                          "verdict = 'accepted' ORDER BY seq DESC LIMIT 1", (pid,))
        return json.loads(row["evidence"])["plan"] if row and row["evidence"] else None

    def _authors(self, run):
        """Ctx authors: the planner and the test author (every mind that wrote the plan or its tests). Builders are
        excluded from review by the reducer itself (builder-named?), the person by Ctx person."""
        out = [self.principal]
        for r in self.db.all("SELECT kind, evidence FROM create_plan_journal WHERE plan_id = ? AND kind IN ('planned', "
                             "'tests-authored') AND verdict = 'accepted' ORDER BY seq", (run["plan_id"],)):
            by = (json.loads(r["evidence"] or "{}")).get("by")
            if by:
                out.append(by)
        return list(dict.fromkeys(out))

    def _ctx(self, run):
        return render(["Ctx", q(run["plan_id"]), q(run["epoch"]), q(run["person"]), [q(a) for a in self._authors(run)],
                       self._caps(run), int(run["lease"]), run["review_policy"],
                       [review_atom(r) for r in self._reviews(run)]])

    def _needs(self, run, needs, reserved):
        head = ["Needs", needs["design"], needs["tests"], [review_atom(r) for r in needs["reviews"]],
                [["AssigneeCap", selector_atom(c["selector"]), c["n"]] for c in needs["caps"]]]
        if run["reducer_sha256"] in (REDUCER_R4_1_SHA256, REDUCER_R4_2_SHA256):
            return head                                         # four fields before R4.3
        return head + [[["Reserved", *[qp(x) for x in reserved]]] if reserved else []]

    def _suite(self, run, op, base, paths):
        if run["reducer_sha256"] in (REDUCER_R4_1_SHA256, REDUCER_R4_2_SHA256):
            return [q(op), q(base)]
        return [q(op), q(base), [qp(x) for x in paths]]

    @staticmethod
    def _caps(run):
        if run["reducer_sha256"] == REDUCER_R4_1_SHA256:      # a plan started under R4.1 keeps its two-field Caps
            return ["Caps", int(run["piece_cap"]), int(run["fix_cap"])]
        return ["Caps", int(run["piece_cap"]), int(run["fix_cap"]), int(run["retry_cap"] or DEFAULT_RETRIES)]

    def _reviews(self, run):
        """The hive's review catalogue for this plan, fixed when the plan started (so every replay uses the same Ctx)."""
        space = self._space(run)
        if "review_for" not in space:
            space = self._space_set(run["plan_id"], review_for=[{k: r[k] for k in ("artifact_kind", "review_kind", "evidence")}
                                                                for r in self.assignees.review_for()])
        return space["review_for"]

    def _obs(self, run, obs_id, kind, body):
        return f"(O {render(q(obs_id))} {kind} {render(q(run['plan_id']))} {render(q(run['epoch']))} {body})"

    async def _reduce(self, run, new=None):
        pid = run["plan_id"]
        ctx = self._ctx(run)
        log_text = "(" + " ".join(self._obs(run, r["obs_id"], r["kind"], r["fields"]) for r in self._journal(pid)) + ")"
        if new is None:
            s2, action = await self.reducer_for(run["reducer_sha256"]).run(f"(let $s2 (replay {ctx} (start-state) {log_text}) ($s2 (next-action {ctx} $s2)))")
            return None, state_view(s2), action
        expr = (f"(let $s (replay {ctx} (start-state) {log_text}) (let ($s2 $v) (apply-obs {ctx} $s {new}) "
                f"($v $s2 (next-action {ctx} $s2))))")
        verdict, s2, action = await self.reducer_for(run["reducer_sha256"]).run(expr)
        return verdict, state_view(s2), action

    @staticmethod
    def accepted(verdict):
        return verdict == "accepted" or (isinstance(verdict, list) and verdict[:1] == ["accepted"])

    async def observe(self, run, obs_id, kind, fields, evidence=None, effect=None):
        """Journal one observation BEFORE any effect it admits (callers hold the plan's lock). A repeated id answers its
        journalled verdict; the same id with other fields is a conflicting duplicate. effect=(kind, op, body): the
        effect row is written in the same transaction as an ACCEPTED journal row; returns (verdict, effect row|None)."""
        pid = run["plan_id"]
        body = render(fields)
        prior = self.db.one("SELECT * FROM create_plan_journal WHERE plan_id = ? AND obs_id = ?", (pid, obs_id))
        if prior is not None:
            verdict = parse(prior["verdict"]) if (prior["kind"], prior["fields"]) == (kind, body) \
                else ["rejected", "conflicting-duplicate"]
            if effect is None:
                return verdict
            return verdict, self.db.one("SELECT * FROM create_plan_effects WHERE plan_id = ? AND kind = ? AND op = ?",
                                        (pid, effect[0], effect[1]))
        verdict, _view, _action = await self._reduce(run, self._obs(run, obs_id, kind, body))
        row = None
        with self.db.transaction():
            seq = self.db.one("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM create_plan_journal WHERE plan_id = ?",
                              (pid,))["n"]
            self.db.insert("create_plan_journal", {"plan_id": pid, "seq": seq, "obs_id": obs_id, "kind": kind,
                                                   "fields": body, "verdict": render_any(verdict),
                                                   "evidence": _canonical(evidence) if evidence is not None else None,
                                                   "at": now()})
            if effect is not None and self.accepted(verdict):
                row = {"id": f"cpe_{new_id('e')[2:]}", "plan_id": pid, "kind": effect[0], "op": effect[1],
                       "state": "journaled", "body": _canonical(effect[2]), "result": None, "goal_id": None,
                       "created_at": now(), "updated_at": now()}
                self.db.insert("create_plan_effects", row)
        if not self.accepted(verdict):
            log.info("create plan %s: %s %s refused: %s", pid, kind, obs_id, render_any(verdict))
        return verdict if effect is None else (verdict, row)

    def _next(self, pid, prefix):
        """Operation ids from the journal: a refused id is never reused (lifetime-unique)."""
        return f"{prefix}-{1 + self.db.one('SELECT COUNT(*) AS n FROM create_plan_journal WHERE plan_id = ? AND obs_id LIKE ?', (pid, f'%:{prefix}-%'))['n']}"

    # ---- effects -----------------------------------------------------------------------------------------------

    def _effects(self, pid, kind=None, state=None):
        sql, args = "SELECT * FROM create_plan_effects WHERE plan_id = ?", [pid]
        if kind:
            sql += " AND kind = ?"; args.append(kind)
        if state:
            sql += " AND state = ?"; args.append(state)
        return self.db.all(sql + " ORDER BY created_at, id", tuple(args))

    def _effect(self, pid, op, kind=None):
        sql, args = "SELECT * FROM create_plan_effects WHERE plan_id = ? AND op = ?", [pid, op]
        if kind:
            sql += " AND kind = ?"; args.append(kind)
        return self.db.one(sql + " ORDER BY created_at DESC LIMIT 1", tuple(args))

    @staticmethod
    def _body(effect):
        return json.loads(effect["body"])

    def _effect_set(self, effect_id, state, result=None, goal_id=None, body=None):
        changes = {"state": state, "updated_at": now()}
        if result is not None:
            changes["result"] = _canonical(result)
        if goal_id is not None:
            changes["goal_id"] = goal_id
        if body is not None:
            changes["body"] = _canonical(body)
        sets = ", ".join(f"{k} = ?" for k in changes)
        self.db.execute(f"UPDATE create_plan_effects SET {sets} WHERE id = ?", (*changes.values(), effect_id))

    def _space(self, run):
        return json.loads(run["space"]) if run["space"] else {}

    def _space_set(self, pid, **changes):
        run = self._run(pid)
        space = dict(self._space(run), **changes)
        self.db.execute("UPDATE create_plan_runs SET space = ?, updated_at = ? WHERE plan_id = ?",
                        (_canonical(space), now(), pid))
        return space

    # ---- the person's routes -----------------------------------------------------------------------------------

    def _person(self, run, principal):
        if run is None:
            raise EngineError("no such plan", 404, "not_found")
        if principal != run["person"]:
            raise EngineError("only the person who started this plan acts on it", 404, "not_found")

    def review_policy(self, principal):
        """The person's one review setting (the Code controller's prefs table: review-required or review-waivable)."""
        try:
            return self.hive.code_controller.review_policy(principal)
        except Exception:
            return "review-required"

    async def start(self, principal, sentence, base=None, conversation_id=None, exchanges=None):
        """POST /api/create/plans {sentence}: the Create bench. The person's own words start one plan. `base`, a saved
        creation the person may read (plan_for's artifact), is what they have now: its source goes to the planner and
        the builders, so the app keeps what it does; an HTML view's body is the page the build starts from."""
        sentence = str(sentence or "").strip()
        if not sentence or len(sentence) > MAX_SENTENCE:
            raise EngineError(f"say what to make in 1-{MAX_SENTENCE} characters", 400, "bad_request")
        if not str(principal).startswith("user:"):
            raise EngineError("a plan is started by a person", 403, "person_required")
        space = {}
        if base is not None:
            found = self.plan_for(principal, base)
            if not found or "artifact_id" not in found:
                raise EngineError("no saved creation of yours by that id", 404, "not_found")
            art = self.hive.collab.artifact(found["artifact_id"])
            rev = self.db.one("SELECT n, body FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                              (found["artifact_id"], found["revision"]))
            body = (rev or {}).get("body") or ""
            space["base_creation"] = {"artifact_id": found["artifact_id"], "revision": found["revision"],
                                      "title": art["title"], "kind": art["kind"], "body": body[:20000]}
            if body.lstrip()[:1] == "<":
                space["seed_files"] = {"index.html": body}
        if conversation_id or exchanges:
            space["exchanges"] = self._exchanges(principal, conversation_id, exchanges)
        pid = self._insert_run(principal, sentence, space or None)
        self.ensure_watch()
        return await self.step(pid)

    def _insert_run(self, principal, sentence, space=None):
        """One new plan run in its first phase; a later round's run carries its app plan and seed in `space`."""
        pid = "plan_" + new_id("x")[2:]
        at = now()
        policy = self.review_policy(principal)
        self.db.insert("create_plan_runs", {"plan_id": pid, "person": principal, "sentence": sentence,
                                            "epoch": "ep-" + new_id("x")[2:14], "reducer_sha256": REDUCER_SHA256,
                                            "retry_cap": max(1, int(self.setting("retries", DEFAULT_RETRIES))),
                                            "review_policy": policy if policy in REVIEW_POLICIES else "review-required",
                                            "lease": BUDGET, "piece_cap": PIECE_REPAIRS, "fix_cap": FIX_ROUNDS,
                                            "phase": "claimed", "status": "planning", "next_action": None,
                                            "last_error": None, "space": _canonical(space) if space else None,
                                            "installed": None, "state": None,
                                            "created_at": at, "updated_at": at})
        return pid

    # ---- rounds: a made app changed in place ---------------------------------------------------------------------
    # A plan's first run builds the app; each change the person asks for later is a round, its own plan run (its own
    # journal, epoch and effects, so every rule above holds per run), whose space names the app plan, whose build
    # space starts from the app's current files, and whose deploy lands on the app plan's app. The app plan's id is
    # the one the person sees: it answers for the newest round in the view, the routes and the events, and its space
    # keeps the rounds, the revisions (every deployed round) and which revision the app runs now.

    def app_plan(self, pid):
        """The app plan a run belongs to: its own id for an app's first build, its app plan's for a later round."""
        run = self._run(pid)
        return (self._space(run).get("app_plan") or pid) if run else pid

    def app_name(self, app):
        """The app's name, kept by every round and revert: the title of the saved creation its first build began from
        (start's base), since that plan is the creation changed, else its first round's plan title. Named by the
        planner's title for the change, a plan begun from a saved Tic Tac Toe was called "make the board bigger and
        say whose turn it is above it" in a change offer naming it (a dry run of 19 Nov), and was installed so."""
        run = self._run(app)
        base = (self._space(run).get("base_creation") or {}).get("title") if run else None
        return base or (self._plan(app) or {}).get("title")

    def _rounds(self, app):
        """Every round of an app plan, oldest first: the app plan itself, then each later round's run id."""
        run = self._run(app)
        return [app, *(self._space(run).get("rounds") or [])] if run else []

    def _newest(self, pid):
        """The run a route on an app plan acts on: its newest round."""
        return self._rounds(self.app_plan(pid))[-1]

    def _revisions(self, app):
        return list(self._space(self._run(app)).get("revisions") or [])

    def _current_revision(self, app):
        space = self._space(self._run(app))
        return next((r for r in space.get("revisions") or [] if r["round"] == space.get("current")), None)

    def _record_revision(self, pid, installed):
        """A round's deploy landed: it is a revision of its app, and the one the app runs now."""
        run = self._run(pid)
        space, app = self._space(run), self.app_plan(pid)
        n = space.get("round") or 1
        preview = self._last_preview(pid)
        rev = {"round": n, "words": run["sentence"], "from": space.get("from"), "preview": preview,
               "deployed_at": (installed or {}).get("installed_at") or now()}
        revs = sorted([r for r in self._revisions(app) if r["round"] != n] + [rev], key=lambda r: r["round"])
        self._space_set(app, revisions=revs, current=n)
        if app != pid:   # the app plan's installed is the app as it runs now, whichever round put it there
            self.db.execute("UPDATE create_plan_runs SET installed = ? WHERE plan_id = ?", (_canonical(installed), app))

    def _last_preview(self, pid):
        done = [e for e in self._effects(pid, "preview") if e["state"] == "done"]
        return (json.loads(done[-1]["result"]) | {"ckpt": self._body(done[-1])["ckpt"]}) if done else None

    def plan_for(self, principal, ref):
        """What a change to `ref` changes, for this person: {"plan_id": app plan} for a plan, a round of one or its
        installed app (create-<hex>), {"artifact_id", "revision"} for a saved creation they may read, else None."""
        ref = str(ref or "").strip()
        if ref.startswith("create-"):
            ref = "plan_" + ref[len("create-"):]
        if ref.startswith("plan_"):
            run = self._run(ref)
            if run is None or run["person"] != principal:
                return None
            return {"plan_id": self.app_plan(ref)}
        if ref.startswith("ar_"):
            try:
                art = self.hive.collab.artifact(ref)
            except Exception:
                return None
            if not self._may_read(principal, art):
                return None
            last = self.db.one("SELECT MAX(n) AS n FROM artifact_revisions WHERE artifact_id = ?", (ref,))
            return {"artifact_id": ref, "revision": last["n"] if last else None}
        return None

    def _may_read(self, principal, art):
        """Whether the person may read a saved creation: the hive's own visibility rule for its owning swarm."""
        from .visibility import Viewer
        swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (art["owner_swarm"],))
        person = self.db.one("SELECT role FROM people WHERE id = ?", (str(principal)[5:],)) \
            if str(principal).startswith("user:") else None
        return bool(swarm) and Viewer(principal, bool(person and person["role"] == "admin"), audit=False).sees(swarm)

    def _exchanges(self, principal, conversation_id=None, exchanges=None):
        """The recent conversation a change came from, at most 12 exchanges and 12,000 characters, the newest kept:
        what the caller passes (the Ask's make passes what its turn carries), else the hive's own copy of that chat."""
        rows = []
        if exchanges:
            rows = [{"who": str(x.get("who") or "")[:60], "text": str(x.get("text") or "")} for x in exchanges
                    if isinstance(x, dict) and x.get("text")]
        elif conversation_id:
            rows = [{"who": "person" if r["direction"] == "in" else "mind", "text": r["text"]} for r in reversed(
                self.db.all("SELECT direction, text FROM messages WHERE conversation_id = ? ORDER BY hub_seq DESC "
                            "LIMIT 12", (str(conversation_id),)))]
        rows, total, kept = rows[-12:], 0, []
        for x in reversed(rows):
            total += len(x["text"])
            if total > 12000:
                break
            kept.append(x)
        return list(reversed(kept))

    async def revise(self, principal, pid, words, conversation_id=None, exchanges=None):
        """POST /api/create/plans/{id}/revise {words}: a change to a made app, a new round from its current revision."""
        words = str(words or "").strip()
        if not words or len(words) > MAX_SENTENCE:
            raise EngineError(f"say what to change in 1-{MAX_SENTENCE} characters", 400, "bad_request")
        app = self.app_plan(pid)
        app_run = self._run(app)
        self._person(app_run, principal)
        async with self._lock(app):
            rounds = self._rounds(app)
            if self._run(rounds[-1])["phase"] not in TERMINAL:
                raise EngineError("a change to this app is still being made", 409, "not_revisable")
            current = self._current_revision(app)
            if current is None or not current.get("preview"):
                raise EngineError("nothing of this app has been deployed yet", 409, "not_revisable")
            files = self.ports.apps.preview_files(current["preview"]["ref"])
            space = {"app_plan": app, "round": len(rounds) + 1, "from": current["round"], "seed_files": files,
                     "app_so_far": [r["words"] for r in self._revisions(app)],
                     "exchanges": self._exchanges(principal, conversation_id, exchanges)}
            child = self._insert_run(principal, words, space)
            self._space_set(app, rounds=[*rounds[1:], child])
        self.ensure_watch()
        await self.step(child)
        return self.view(app)

    async def revert(self, principal, pid, round_n):
        """POST /api/create/plans/{id}/revert {round}: the app put back to one of its revisions, which becomes the one
        it runs now (undo is the revert to the revision the current one was built from)."""
        if isinstance(round_n, bool) or not isinstance(round_n, int):
            raise EngineError("round is a revision's round number", 400, "bad_request")
        app = self.app_plan(pid)
        app_run = self._run(app)
        self._person(app_run, principal)
        async with self._lock(app):
            if self._run(self._rounds(app)[-1])["phase"] not in TERMINAL:
                raise EngineError("a change to this app is still being made", 409, "not_revisable")
            rev = next((r for r in self._revisions(app) if r["round"] == round_n), None)
            if rev is None or not rev.get("preview"):
                raise EngineError(f"this app has no revision {round_n}", 409, "not_revisable")
            out = self.ports.apps.deploy(app_run, {"preview": ["preview", rev["preview"]["ref"]]}, self._plan(app))
            if not isinstance(out, dict) or not out.get("program_id"):
                raise EngineError(f"the app could not be put back: {(out or {}).get('refused') or (out or {}).get('unknown')}",
                                  409, "revert_refused")
            self.db.execute("UPDATE create_plan_runs SET installed = ?, updated_at = ? WHERE plan_id = ?",
                            (_canonical(out), now(), app))
            self._space_set(app, current=round_n)
            self.hive.events.publish("create.plan.status", plan_id=app, phase=self._run(self._rounds(app)[-1])["phase"],
                                     status="reverted", next_action=None)
        return self.view(app)

    async def answer(self, pid, principal, qid, text):
        pid = self._newest(pid)                  # an app plan's id answers for its newest round
        run = self._run(pid)
        self._person(run, principal)
        text = str(text or "").strip()
        if not text or len(text) > 4000:
            raise EngineError("an answer is 1-4000 characters", 400, "bad_request")
        # "Stop" on a hold card (hold-* / who-*, choices Try again|Go again / Stop) stops the plan. The reducer reads any
        # answer to a blocked hold as "release it and go on", so the words must reach the stop path, never the answer.
        if str(qid).startswith(("hold-", "who-")) and text.casefold() in ("stop", "stop it", "stop the plan"):
            return await self.stop(pid, principal)
        async with self._lock(pid):
            ref = self._next(pid, "ans")
            verdict = await self.observe(run, f"answered:{ref}", "answered", [q(qid), q(principal), q(ref)],
                                         {"text": text, "by": principal})
            if not self.accepted(verdict):
                raise EngineError(f"that answer was not taken: {render_any(verdict)}", 409, "answer_refused")
            self.hive.events.publish("create.plan.question", plan_id=self.app_plan(pid), q=str(qid), answered=True)
            await self._step(pid)
        return self.view(pid)

    async def deploy(self, pid, principal):
        """The person's go: journals deploy-approved (op person); the deploy effect follows only if it is accepted."""
        pid = self._newest(pid)
        run = self._run(pid)
        self._person(run, principal)
        async with self._lock(pid):
            op = self._next(pid, "deploy")
            nxt = run["next_action"] or ""
            form = "confirm-unreviewed-deploy" if nxt.startswith("(tell confirm-unreviewed-deploy") else "confirm-deploy"
            verdict = await self.observe(run, f"deploy-approved:{op}", "deploy-approved", [q(op), q(principal), form],
                                         {"by": principal, "form": form})
            if not self.accepted(verdict):
                raise EngineError(f"not ready to deploy: {render_any(verdict)}", 409, "deploy_refused")
            await self._step(pid)
        return self.view(pid)

    async def stop(self, pid, principal):
        pid = self._newest(pid)
        self._person(self._run(pid), principal)
        async with self._lock(pid):
            run = self._run(pid)                     # read under the lock: a step may have just finished the plan
            if run["phase"] not in TERMINAL:
                await self.observe(run, f"cancelled:{self._next(pid, 'stop')}", "cancelled", [], {"by": principal})
            await self._step(pid)
        return self.view(pid)

    async def files(self, pid, principal, path=None, ckpt=None):
        pid = self._newest(pid)
        run = self._run(pid)
        self._person(run, principal)
        ckpt = ckpt or self._latest_ckpt(run)
        if not ckpt:
            raise EngineError("nothing is built yet", 404, "not_found")
        if ckpt not in self._known_ckpts(run):
            raise EngineError("not a checkpoint of this plan", 404, "not_found")
        files = await self.ports.files(run, ckpt)
        if path is not None:
            if path not in files:
                raise EngineError("no such file at that checkpoint", 404, "not_found")
            return {"ckpt": ckpt, "path": path, "content": files[path]}
        return {"ckpt": ckpt, "files": files}

    # ---- the loop ----------------------------------------------------------------------------------------------

    async def step(self, pid):
        async with self._lock(pid):
            return await self._step(pid)

    async def _collect_waiting(self, pid):
        """A waiting mind call whose goal finished while nobody listened (a restart, a dropped frame): read its goal
        (a DB read through the port, never a model) and journal the result. True when something was journalled."""
        for e in self._effects(pid, state="waiting"):
            if not e["goal_id"]:
                continue
            out = await self.ports.collect(self._run(pid), e["kind"], self._body(e), e["goal_id"])
            if out is not None:
                await self._finish(self._run(pid), e, out)
                return True
        return False

    @staticmethod
    def _admitting(effect):
        kind, op = effect["kind"], effect["op"]
        if kind == "plan":
            return f"plan-started:{op}"
        if kind == "deploy":
            return f"deploy-approved:{op}"
        if kind == "build" and op.startswith("task-"):
            return f"piece-started:{op}"
        return f"dispatched:{op}"

    async def _step(self, pid):
        try:
            return await self._step_once(pid)
        finally:                                     # every step, so also on resume: the ports catch up with the plan
            run = self._run(pid)                     # (per-change members: lost deliveries, ended when the plan rests)
            if run is not None and hasattr(self.ports, "settle"):
                try:
                    await self.ports.settle(run)
                except Exception:
                    log.exception("create plan %s: settling the ports failed", pid)

    async def _step_once(self, pid):
        await self._collect_waiting(pid)
        for _ in range(MAX_STEPS):
            run = self._run(pid)
            if run is None:
                return None
            try:
                _, view, action = await self._reduce(run)
            except EngineError as exc:
                self._save(pid, last_error=str(exc), status="engine_error")
                return self.view(pid)
            self._save(pid, phase=str(view["phase"]), next_action=render_any(action),
                       status=self._status(view, action), state=view)
            try:
                again = await self._act(self._run(pid), view, action)
            except EngineError as exc:
                self._save(pid, last_error=str(exc))
                return self.view(pid)
            if not again:
                # the effect may have journalled something without asking for more (a pending call, a shown question):
                # record what the journal says now, without acting on it
                run = self._run(pid)
                with contextlib.suppress(EngineError):
                    _, view2, action2 = await self._reduce(run)
                    status = run["status"] if run["status"] == "assignee_unavailable" else self._status(view2, action2)
                    self._save(pid, phase=str(view2["phase"]), next_action=render_any(action2), status=status, state=view2)
                break
        return self.view(pid)

    def _save(self, pid, state=None, **changes):
        before = self._run(pid)
        changes["updated_at"] = now()
        if state is not None:
            changes["state"] = _canonical({k: _plain(v) for k, v in state.items()})
        sets = ", ".join(f"{k} = ?" for k in changes)
        self.db.execute(f"UPDATE create_plan_runs SET {sets} WHERE plan_id = ?", (*changes.values(), pid))
        after = self._run(pid)
        if before is None or any(before[k] != after[k] for k in ("status", "phase", "next_action")):
            self.hive.events.publish("create.plan.status", plan_id=self.app_plan(pid), phase=after["phase"],
                                     status=after["status"], next_action=after["next_action"])
        if state is not None:
            self._piece_events(pid, state)

    def _piece_events(self, pid, view):
        """create.plan.piece once per change of a piece's (status, candidate, repairs)."""
        seen = self._piece_seen.setdefault(pid, {})
        for r in view.get("pieces") or []:
            p, status, cand, reps = str(r[1]), str(r[2]), _plain(r[3]), r[4]
            key = (status, cand, reps)
            if seen.get(p) != key:
                seen[p] = key
                self.hive.events.publish("create.plan.piece", plan_id=self.app_plan(pid), piece=p, state=status,
                                         candidate=None if cand == "none" else cand, repairs=reps)

    @staticmethod
    def _status(view, action):
        ph = str(view["phase"])
        head = action[0] if isinstance(action, list) else action
        if ph in TERMINAL:
            return ph
        if ph == "blocked":
            return "needs_you"
        if head == "tell" and action[1] == "ask-person" or action == ["rest", "awaiting-answer"]:
            return "asking_you"
        if head == "tell" and action[1] in ("confirm-deploy", "confirm-unreviewed-deploy"):
            return "ready_to_deploy"
        if head == "do" and isinstance(action[1], list) and action[1][0] == "deploy":
            return "deploying"
        if head == "do" and isinstance(action[1], list) and action[1][0] == "reconcile":
            return "checking_back"
        return {"claimed": "planning", "planning": "planning", "planned": "writing_tests", "designing": "designing",
                "designed": "writing_tests", "testing-authored": "checking_tests_are_red", "building": "building",
                "fixing": "fixing", "integrating": "integrating", "checking": "checking", "previewing": "previewing",
                "ready-to-deploy": "ready_to_deploy"}.get(ph, ph)

    async def _act(self, run, view, action):
        pid = run["plan_id"]
        head = action[0]
        if head == "rest":
            # an effect journalled before a restart resumes with its same operation id, unless its result is already
            # journalled (a stop between the two writes): then it is never performed twice
            for e in self._effects(pid, state="journaled"):
                if self._has_result(pid, e["op"], self._admitting(e)):
                    self._effect_set(e["id"], "done", {"recovered": "result already journalled"})
                    continue
                return await self._perform(run, e)
            return await self._collect_waiting(pid)
        if head == "think":
            goal = action[1]
            if goal == "make-the-plan":
                op = self._next(pid, "plan")
                verdict, effect = await self.observe(run, f"plan-started:{op}", "plan-started", [q(op)],
                                                     effect=("plan", op, {"sentence": run["sentence"]}))
                return await self._admitted(run, verdict, effect)
            if goal == "author-acceptance-tests":
                ref = str(view["plan"][0])
                op = self._next(pid, "tests")
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "author-tests", q(ref)],
                                                     effect=("author-tests", op, {"plan_ref": ref}))
                return await self._admitted(run, verdict, effect)
            if goal == "make-the-design":
                ref = str(view["plan"][0])
                op = self._next(pid, "design")
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "design", q(ref)],
                                                     effect=("design", op, {"plan_ref": ref}))
                return await self._admitted(run, verdict, effect)
            raise EngineError(f"no host mapping for (think {goal})")
        if head == "tell":
            if action[1] == "ask-person":
                return await self._ask(run, view, action[2])
            if action[1] in ("confirm-deploy", "confirm-unreviewed-deploy"):
                return False                                   # the person's go route acts
            raise EngineError(f"no host mapping for (tell {action[1]})")
        if head == "do":
            what = action[1]
            name = what[0]
            if name == "detect-tests":
                op = self._next(pid, "tests")
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "detect-tests", "none"],
                                                     effect=("detect-tests", op, {}))
                return await self._admitted(run, verdict, effect)
            if name == "run-checks":
                target = what[1]
                op = self._next(pid, "run")
                subject = target if target == "base" else q(target)
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "run-checks", subject],
                                                     effect=("run-checks", op, {"target": str(target)}))
                return await self._admitted(run, verdict, effect)
            if name == "start-piece":
                return await self._start_piece(run, view, str(what[1]))
            if name == "request-review":
                return await self._request_review(run, view, str(what[1]), str(what[2]), str(what[3]))
            if name == "integrate":
                p, c = str(what[1]), str(what[2])
                op = self._next(pid, "merge")
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "integrate", [q(p), q(c)]],
                                                     effect=("integrate", op, {"piece": p, "candidate": c}))
                return await self._admitted(run, verdict, effect)
            if name == "route-fix":
                p, failing_op = str(what[1]), str(what[2])
                op = self._next(pid, "fix")
                body = {"piece": p, "failing_op": failing_op, "failing": self._failing(pid, failing_op, p)}
                assignment = self._piece_assignment(run, p)
                got = assignment["assignee"]
                if not got["resolved"]:              # nobody the selector names can repair it: hold and ask the person
                    return await self._unassignable(run, p, got)
                repairer = got.get("agent_id") or got["ref"]
                body.update(assignment, builder=repairer)
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched",
                                                     [q(op), "route-fix", [q(p), q(repairer)]], effect=("build", op, body))
                return await self._admitted(run, verdict, effect)
            if name == "preview-deploy":
                ck = str(what[1])
                op = self._next(pid, "preview")
                verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "preview", q(ck)],
                                                     effect=("preview", op, {"ckpt": ck}))
                return await self._admitted(run, verdict, effect)
            if name == "deploy":
                op = str(what[1])
                effect = self._effect(pid, op, "deploy")
                if effect is None:
                    with self.db.transaction():
                        self.db.insert("create_plan_effects", {
                            "id": f"cpe_{new_id('e')[2:]}", "plan_id": pid, "kind": "deploy", "op": op, "state": "journaled",
                            "body": _canonical({"ckpt": str(view["ckpt"]), "preview": _plain(view["preview"])}),
                            "result": None, "goal_id": None, "created_at": now(), "updated_at": now()})
                    effect = self._effect(pid, op, "deploy")
                if effect["state"] != "journaled":
                    return False
                return await self._perform(run, effect)
            if name == "reconcile":
                return await self._reconcile(run, str(what[1]))
            raise EngineError(f"no host mapping for (do {name})")
        raise EngineError(f"unknown action {action!r}")

    async def _admitted(self, run, verdict, effect):
        if not self.accepted(verdict) or effect is None:
            raise EngineError(f"the reducer refused the journal entry: {render_any(verdict)}")   # no effect
        return await self._perform(run, effect)

    # ---- questions ---------------------------------------------------------------------------------------------

    async def _ask(self, run, view, qatom):
        """Show the question (a card + create.plan.question), then journal question-asked (q about)."""
        pid = run["plan_id"]
        if isinstance(qatom, list) and qatom[:1] == ["blocked"]:
            why = _plain(qatom[1])
            qid = self._next(pid, "hold")
            about, text = "blocked", _blocked_text(why, self._stopped(pid, why))
            choices = ["Try again", "Stop"]
        elif isinstance(qatom, list) and qatom[:1] == ["assignee-unavailable"]:
            p = str(qatom[1])
            qid = self._next(pid, "who")
            spec = self._piece_spec(pid, p) or {}
            got = self._piece_assignment(run, p)["assignee"]
            about = ["piece", q(p)]
            text = (f"Nobody can take \u201c{spec.get('title', p)}\u201d right now ({got.get('detail')}). Make one available "
                    "(or change who does it), then say go; or stop.")
            choices = ["Go again", "Stop"]
        else:
            qid = str(qatom)
            plan = self._plan(pid) or {}
            card = next((x for x in plan.get("questions", []) if x["q"] == qid), None)
            if card is None:
                raise EngineError(f"the reducer raised question {qid} the plan does not carry")
            about, text, choices = about_atom(card["about"]), card["text"], card["choices"]
        if self._effect(pid, qid, "question") is None:
            self.db.insert("create_plan_effects", {
                "id": f"cpe_{new_id('e')[2:]}", "plan_id": pid, "kind": "question", "op": qid, "state": "shown",
                "body": _canonical({"q": qid, "about": about_json(about), "text": text, "choices": choices}),
                "result": None, "goal_id": None, "created_at": now(), "updated_at": now()})
            self.hive.events.publish("create.plan.question", plan_id=self.app_plan(pid), q=qid, about=about_json(about), text=text,
                                     choices=choices, answered=False)
        verdict = await self.observe(run, f"question-asked:{qid}", "question-asked", [q(qid), about],
                                     {"text": text, "choices": choices})
        return self.accepted(verdict)

    # ---- pieces: assignment, build, review ---------------------------------------------------------------------

    def last_stop(self, pid, kind, piece=None):
        """Why this step's previous attempt ended unanswered, when its goal gave a reason (GoalMinds.collect keeps
        goal_ended's goal_reason with the lost step), for the next attempt's packet; else None. Only the attempt just
        before the current one counts (same kind, same piece), so an attempt that answered is never told an older stop.
        Time: this kind's effects and two journal reads."""
        effects = [e for e in self._effects(pid, kind) if self._body(e).get("piece") == piece]
        if len(effects) < 2:
            return None
        op = effects[-2]["op"]
        evidence = self._evidence(pid, f"unknown:{op}") or self._evidence(pid, f"plan-failed:{op}")
        return evidence.get("goal_reason") or None

    def _stopped(self, pid, why):
        """Who stopped and why, as sentences for the person's hold card, when the hold came from a mind whose goal ended
        with a reason: the newest lost step (GoalMinds.collect) for lost operations, the piece's builder
        (PerChangeBuilds.collect) for a blocked piece. The reason is goal_reason: a mind's own hive-goal-fail words, or
        the hive's when the mind stopped after its replies kept being refused (Goals.stop_held). A builder whose
        repairs ran out against the acceptance check has check_failure instead: what the check still says about its
        piece (create_plan_members.check_failure). None otherwise, and the card keeps its general words.
        Time: the plan's journal rows of that kind, newest first, and one mind read."""
        if why == ["cap-exceeded", "lost-operations"]:
            kind, piece = "unknown", None
        elif isinstance(why, list) and why[:1] == ["piece-blocked"]:
            kind, piece = "piece-blocked", str(why[1])
        else:
            return None
        evidence = {}
        for row in self.db.all("SELECT fields, evidence FROM create_plan_journal WHERE plan_id = ? AND kind = ? AND "
                               "verdict = 'accepted' ORDER BY seq DESC", (pid, kind)):
            if piece is None or str(parse(row["fields"])[0]) == piece:   # the hold's own piece, not the newest of any
                evidence = json.loads(row["evidence"]) if row["evidence"] else {}
                break
        reason = str(evidence.get("goal_reason") or evidence.get("check_failure") or "").strip()[:GOAL_REASON_SAID]
        if not reason:
            return None
        mind = self.db.one("SELECT name FROM agents WHERE id = ?", (evidence.get("by"),)) if evidence.get("by") else None
        who = mind["name"] if mind else "The mind doing it"
        if piece is not None:
            who += f" stopped building “{(self._piece_spec(pid, piece) or {}).get('title') or piece}”."
        else:
            who += " stopped."
        return f"{who} {reason if reason[-1] in '.!?' else reason + '.'}"

    def answers(self, pid):
        """The person's answers so far ({q, text}), handed to every later model call."""
        # Each answer carries the question it answers, in words: the q id alone ("omega-meaning") left the test author
        # unable to see that "No, I mean OmegaHives" answered "What do you mean by omegas?" (Jon 11-09), so it
        # refused three times and spent the plan's retries.
        asked = {}
        for r in self.db.all("SELECT fields, evidence FROM create_plan_journal WHERE plan_id = ? AND kind = 'question-asked' "
                             "AND verdict = 'accepted' ORDER BY seq", (pid,)):
            asked[str(parse(r["fields"])[0])] = (json.loads(r["evidence"] or "{}")).get("text")
        out = []
        for r in self.db.all("SELECT fields, evidence FROM create_plan_journal WHERE plan_id = ? AND kind = 'answered' AND "
                             "verdict = 'accepted' ORDER BY seq", (pid,)):
            qid = str(parse(r["fields"])[0])
            out.append({"q": qid, "question": asked.get(qid), "text": (json.loads(r["evidence"] or "{}")).get("text")})
        return out

    def _piece_spec(self, pid, p):
        plan = self._plan(pid) or {}
        return next((x for x in plan.get("pieces", []) if x["id"] == p), None)

    def _selector(self, spec):
        return spec.get("assignee") or self.assignees.default_selector((spec.get("kinds") or ["none"])[0])

    def _piece_assignment(self, run, p):
        spec = self._piece_spec(run["plan_id"], p) or {}
        got = self.assignees.resolve(self._selector(spec), run["person"])
        return {"assignee": got}

    async def _unassignable(self, run, p, got):
        """R4.1: nobody the selector names can take the piece. Journal assignee-unavailable (p); never fall back to
        someone else. The reducer holds the piece and asks the person."""
        pid = run["plan_id"]
        self._save(pid, last_error=f"nobody can take piece {p} now ({got.get('detail')})")
        return self.accepted(await self.observe(run, f"assignee-unavailable:{self._next(pid, 'who')}", "assignee-unavailable",
                                                [q(p)], {"selector": got.get("selector"), "detail": got.get("detail")}))

    async def _start_piece(self, run, view, p):
        pid = run["plan_id"]
        assignment = self._piece_assignment(run, p)
        got = assignment["assignee"]
        if not got["resolved"]:
            return await self._unassignable(run, p, got)
        from .create_assignees import resolved_atom
        builder = got.get("agent_id") or got["ref"]
        task = self._next(pid, "task")
        verdict, effect = await self.observe(run, f"piece-started:{task}", "piece-started",
                                             [q(p), q(task), q(builder), resolved_atom(got)], {"assignee": got},
                                             effect=("build", task, {"piece": p, "task": task, "builder": builder,
                                                                     **assignment}))
        return await self._admitted(run, verdict, effect)

    def _built_summary(self, pid, cand):
        """What the builder said about candidate `cand` (its piece-ready record's summary), or None."""
        row = self.db.one("SELECT evidence FROM create_plan_journal WHERE plan_id = ? AND kind = 'piece-ready' AND "
                          "verdict = 'accepted' AND json_extract(evidence, '$.candidate') = ? ORDER BY seq DESC LIMIT 1",
                          (pid, cand))
        return (json.loads(row["evidence"] or "{}").get("summary") or None) if row else None

    def _builders(self, pid):
        out = set()
        for r in self.db.all("SELECT fields FROM create_plan_journal WHERE plan_id = ? AND kind = 'piece-started'", (pid,)):
            out.add(str(parse(r["fields"])[2]))
        return out

    async def _request_review(self, run, view, p, c, rk):
        pid = run["plan_id"]
        spec = self._piece_spec(pid, p) or {}
        rule = self.assignees.review_rule(spec.get("kinds", []), rk)
        plan_rule = next((r for r in (self._plan(pid) or {}).get("needs", {}).get("reviews", [])
                          if r["artifact_kind"] in spec.get("kinds", []) and r["review_kind"] == rk), None)
        if rule is None and plan_rule is not None:      # a review the plan added: reviewed by whoever offers that kind
            rule = dict(plan_rule, reviewer=["capability", rk])
        if rule is None:
            raise EngineError(f"no reviewer rule for {rk} on {spec.get('kinds')}")
        op = self._next(pid, "review")
        verdict, effect = await self.observe(run, f"dispatched:{op}", "dispatched", [q(op), "review", [q(p), q(c), rk]],
                                             effect=("review", op, {"piece": p, "candidate": c, "rule": rule}))
        return await self._admitted(run, verdict, effect)

    def _failing(self, pid, op, p):
        """The failing output a fix is routed with: a check run, a review op or a merge-conflict op."""
        e = self._effect(pid, op)
        if e is None or not e["result"]:
            return {"op": op}
        result = json.loads(e["result"])
        return {"op": op, "kind": e["kind"], "piece": p,
                **{k: result.get(k) for k in ("failing", "output", "notes", "conflict", "decision") if k in result}}

    # ---- performing effects (ports), and their results ---------------------------------------------------------

    async def _perform(self, run, effect):
        """Run a journalled effect through its port. Model calls may answer {pending: goal_id}: the goal's event resumes."""
        pid, body, kind = run["plan_id"], self._body(effect), effect["kind"]
        try:
            if kind == "plan":
                await self._ensure_space(run)            # the planner is told what the scaffold holds (its check)
                out = await self.ports.plan(self._run(pid), body)
            elif kind == "design":
                out = await self.ports.design(run, body, self._plan(pid))
            elif kind == "author-tests":
                await self._ensure_space(run)
                out = await self.ports.author_tests(self._run(pid), body, self._plan(pid))
            elif kind == "detect-tests":
                await self._ensure_space(run)
                out = await self.ports.detect_tests(self._run(pid), body)
            elif kind == "run-checks":
                space = self._space(self._run(pid))
                ckpt = space.get("base") if body["target"] == "base" else body["target"]
                out = await self.ports.run_check(run, ckpt, space.get("suite"), space.get("base"))
            elif kind == "build":
                spec = self._piece_spec(pid, body["piece"])
                base = self._space(run).get("base")
                out = await self.ports.build(run, body, spec, self._plan(pid), base)
            elif kind == "review":
                if "reviewer" not in body:
                    # the reviewer and the evidence are chosen once and stored in the effect BEFORE the call, so an
                    # answer that comes later (any real mind) is matched to the reviewer who was asked (review F1)
                    prepared = await self._review_prepare(run, body)
                    if "unavailable" in prepared:
                        return await self._finish(self._run(pid), effect, prepared)
                    body = prepared
                    self._effect_set(effect["id"], "journaled", body=body)
                out = await self.ports.review(run, body, self._plan(pid))
            elif kind == "integrate":
                out = await self.ports.integrate(run, body["piece"], body["candidate"], self._space(run).get("integration"))
            elif kind == "preview":
                out = await self.ports.preview(run, body["ckpt"], self._plan(pid))
            elif kind == "deploy":
                out = await self.ports.deploy(run, body, self._plan(pid))
            else:
                raise EngineError(f"no port for effect {kind}")
        except EngineError:
            raise
        except Exception as exc:                      # a port that failed after the journal entry: outcome unknown
            log.exception("create plan %s: %s effect failed", pid, kind)
            out = {"unknown": f"{type(exc).__name__}: {str(exc)[:300]}"}
        if isinstance(out, dict) and out.get("pending"):
            self._effect_set(effect["id"], "waiting", goal_id=out["pending"])
            return False
        return await self._finish(self._run(pid), effect, out)

    async def _ensure_space(self, run):
        if not self._space(run).get("integration"):
            space = await self.ports.open_space(run)
            self._space_set(run["plan_id"], **space)
            fresh = self._run(run["plan_id"])
            seed = self._space(fresh).get("seed_files")
            if seed:   # a later round builds on the app as it runs now: those files are its scaffold
                n = self._space(fresh).get("round")
                ckpt = await self.ports.space.write(fresh, seed, f"the app as it runs now, before change {n}" if n
                                                    else "the creation this app starts from")
                self._space_set(run["plan_id"], scaffold=ckpt)

    async def _review_prepare(self, run, body):
        pid, p, c, rule = run["plan_id"], body["piece"], body["candidate"], body["rule"]
        exclude = self._builders(pid) | set(self._authors(run)) | {run["person"]}
        reviewer = self.assignees.resolve(rule["reviewer"], run["person"], exclude=exclude)
        if not reviewer["resolved"] or not reviewer.get("agent_id") or reviewer["agent_id"] in exclude:
            return {"unavailable": reviewer.get("detail") or "no independent reviewer"}
        evidence = None
        if rule["evidence"] == "render":                # the evidence kind the ReviewFor row names
            evidence = await self._render(run, p, c)
            if evidence.get("error"):
                return {"unavailable": f"render failed: {evidence['error']}"}
        return {**body, "reviewer": reviewer, "evidence": evidence}

    async def _render(self, run, p, c):
        """The host renders a studio candidate: the appFrame document (index.html + style.css + app.js, CSP first) of
        the candidate's files over the integration checkpoint, retained by digest as the review's render evidence."""
        from .create_plan_ports import frame_document
        files = await self.ports.files(run, c)
        try:
            doc = frame_document(files)
        except ValueError as exc:
            return {"error": str(exc)}
        ref = "render-" + hashlib.sha256(doc.encode("utf-8")).hexdigest()[:40]
        self._space_set(run["plan_id"], renders={**self._space(run).get("renders", {}), ref: {"piece": p, "ckpt": c}})
        return {"ref": ref, "document_digest": "sha256:" + hashlib.sha256(doc.encode()).hexdigest(), "ckpt": c}

    async def _finish(self, run, effect, out):
        """Journal the result observation for an effect's port answer, THEN record the effect's state (review F4: an
        effect is never marked done before its result is journalled). A result the host cannot translate (a model's
        unquotable path, a missing reference) or one the reducer refuses becomes `unknown (op)`: a readback, never a
        guess and never an exception that wedges the plan. Once that is recorded, the files a mind staged on the
        effect's goal one command each are deleted (Goals.drop_staged): the plan has taken them and reads them no more."""
        try:
            finished = await self._finish_typed(run, effect, out)
        except EngineError as exc:
            finished = await self._unknown(run, effect, {"unknown": f"untranslatable result: {exc}"[:300]})
        if effect.get("goal_id"):
            self.hive.goals.drop_staged(effect["goal_id"])
        return finished

    async def _unknown(self, run, effect, why):
        op = effect["op"]
        verdict = await self.observe(run, f"unknown:{op}", "unknown", [q(op)], why)
        self._effect_set(effect["id"], "unknown", why)
        return self.accepted(verdict)

    async def _result(self, run, effect, state, obs_id, kind, fields, evidence, after=None):
        verdict = await self.observe(run, obs_id, kind, fields, evidence)
        if self.accepted(verdict) or verdict == "duplicate":
            self._effect_set(effect["id"], state, evidence)
            if after is not None:
                after()
            return True
        self._effect_set(effect["id"], "result-refused", {"verdict": render_any(verdict), "result": evidence})
        return await self._unknown(run, effect, {"unknown": f"the reducer refused {kind}: {render_any(verdict)}"})

    async def _finish_typed(self, run, effect, out):
        pid, kind, op, body = run["plan_id"], effect["kind"], effect["op"], self._body(effect)
        out = out if isinstance(out, dict) else {"unknown": "port answered nothing"}
        if "unknown" in out:
            return await self._unknown(run, effect, out)
        R = lambda state, obs_id, k, fields, ev=out, after=None: self._result(run, effect, state, obs_id, k, fields, ev, after)
        if kind == "plan":
            if out.get("failed"):
                return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)])
            plan, why = validate_plan(out.get("plan"))
            if plan is None:
                return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)], {"invalid": why, "by": out.get("by")})
            for x in plan["pieces"]:
                x["assignee"] = self._selector(x)        # the default selector is fixed into the journalled plan
            plan["reserved"] = sorted(set(json.loads(self.setting("reserved_paths", "[]"))))
            if plan["needs"]["tests"] == "detect" and not await self.ports.scaffold_has_check(run):
                # detect finds the scaffold's own check: with none there, the plan's tests step could never answer
                return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)],
                               {"invalid": "detect_without_a_check", "by": out.get("by")})
            if plan["needs"]["design"] == "design" and "design" not in self.staffed_kinds(run["person"]):
                # a design step resolves the design capability as a piece does: with no maker it answers unknown,
                # spends the retry budget and asks the person, who on a Mac install can't make a designer available
                return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)],
                               {"invalid": "design_step_unstaffed", "by": out.get("by")})
            owned = {f for x in plan["pieces"] for f in x["files"]}
            if owned & set(plan["reserved"]):            # the host refuses it too, before the reducer does
                return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)],
                               {"invalid": "piece_owns_a_reserved_path", "paths": sorted(owned & set(plan["reserved"])),
                                "by": out.get("by")})
            if self._space(run).get("app_plan"):   # a change round: every UI file of the app has a piece that may write it
                own_the_app(plan["pieces"])
            late = page_before_design(plan["pieces"])
            if late:   # the page's piece waits on a design piece whose review renders that page
                return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)],
                               {"invalid": "design_piece_before_its_page", "pieces": late, "by": out.get("by")})
            digest = _digest(plan)
            ref = f"planref-{digest[7:23]}"
            graph = [["Piece", q(x["id"]), selector_atom(x["assignee"]), list(x["kinds"]), [q(d) for d in x["deps"]],
                      [qp(f) for f in x["files"]]] for x in plan["pieces"]]
            unknowns = [[q(x["q"]), about_atom(x["about"])] for x in plan["questions"]]
            fields = [q(op), ["Plan", q(ref), 1, q(digest), "none"], graph, unknowns,
                      self._needs(run, plan["needs"], plan["reserved"])]
            verdict = await self.observe(run, f"planned:{op}", "planned", fields,
                                         {"plan": plan, "ref": ref, "digest": digest, "by": out.get("by")})
            if self.accepted(verdict):
                self._effect_set(effect["id"], "done", {"ref": ref, "digest": digest})
                return True
            # an invalid graph is refused and op stays open: report the attempt failed (one retry)
            code = str(verdict[1]) if isinstance(verdict, list) and len(verdict) == 2 and verdict[0] == "rejected" else None
            return await R("failed", f"plan-failed:{op}", "plan-failed", [q(op)],
                           {"refused": render_any(verdict), **({"code": code} if code else {}), "by": out.get("by")})
        if kind in ("author-tests", "detect-tests"):
            if not out.get("suite") or not out.get("base"):
                return await self._unknown(run, effect, {"unknown": "no suite"})
            obs = "tests-authored" if kind == "author-tests" else "tests-detected"
            return await R("done", f"{obs}:{op}", obs, self._suite(run, op, out["base"], out.get("files") or [out["suite"]]),
                           {"by": out.get("by"), "suite": out["suite"], "files": out.get("files"), "base": out["base"]},
                           lambda: self._space_set(pid, base=out["base"], suite=out["suite"]))
        if kind == "design":
            if not out.get("ref"):
                return await self._unknown(run, effect, {"unknown": "the design answered no reference"})
            return await R("done", f"designed:{op}", "designed", [q(op), q(out["ref"])])
        if kind == "run-checks":
            target = "base" if body["target"] == "base" else q(body["target"])
            outcome = out.get("outcome")
            if outcome == "pass":
                return await R("done", f"check-pass:{op}", "check-pass", [q(op), target])
            if outcome == "fail" and out.get("failing"):
                return await R("done", f"check-fail:{op}", "check-fail", [q(op), target, [qp(f) for f in out["failing"]]])
            if out.get("reason") in BROKEN_CHECK and run["reducer_sha256"] not in (
                    REDUCER_R4_1_SHA256, REDUCER_R4_2_SHA256, REDUCER_R4_3_SHA256):
                # the check ran and gave no verdict: R4.4 decides (back to its author, within the retry budget); the
                # evidence (reason, exit code, error tail) is journalled for the author's next brief
                return await R("done", f"check-broken:{op}", "check-broken", [q(op), out["reason"]])
            return await R("done", f"check-unknown:{op}", "check-unknown", [q(op)])
        if kind == "build":
            p = body["piece"]
            if out.get("blocked"):
                return await R("failed", f"piece-blocked:{op}", "piece-blocked", [q(p), q(op)])
            cand = out.get("candidate")
            if not cand:
                return await self._unknown(run, effect, {"unknown": "the builder answered no candidate"})
            return await R("done", f"piece-ready:{op}:{cand}", "piece-ready", [q(p), q(op), q(cand)],
                           {"op": op, "builder": body.get("builder"), "files": out.get("files"),
                            "summary": out.get("summary"), "candidate": cand},
                           lambda: self._space_set(pid, candidates={**self._space(self._run(pid)).get("candidates", {}),
                                                                    cand: {"piece": p, "op": op}}))
        if kind == "review":
            p, c, rule = body["piece"], body["candidate"], body["rule"]
            rk = rule["review_kind"]
            if "unavailable" in out:
                return await R("unavailable", f"review-unavailable:{op}", "review-unavailable", [q(p), q(c), rk])
            reviewer = out.get("reviewer")
            decision = out.get("decision")
            if not reviewer or decision not in ("pass", "fail"):
                return await self._unknown(run, effect, {"unknown": "no structured review verdict"})
            ev = out.get("evidence") or {}
            evidence = [rule["evidence"], q(ev["ref"])] if rule["evidence"] != "none" and ev.get("ref") else "none"
            obs = "review-" + decision
            return await R("done", f"{obs}:{op}", obs, [q(p), q(c), rk, q(reviewer), evidence])
        if kind == "integrate":
            p = body["piece"]
            if out.get("conflict"):
                return await R("conflict", f"merge-conflict:{op}", "merge-conflict", [q(op), q(p)])
            ck = out.get("ckpt")
            if not ck:
                return await self._unknown(run, effect, {"unknown": "merge answered no checkpoint"})
            landed = {}
            ok = await R("done", f"integrated:{op}", "integrated", [q(op), q(p), q(body["candidate"]), q(ck)], out,
                         lambda: (self._space_set(pid, ckpts=self._space(self._run(pid)).get("ckpts", []) + [ck]),
                                  landed.update(yes=True)))
            if landed:                                   # the piece's per-change member is delivered by this integration
                await self.ports.integrated(self._run(pid), p, op, body["candidate"], ck)
            return ok
        if kind == "preview":
            if out.get("failed"):
                return await R("failed", f"preview-failed:{op}", "preview-failed", [q(op)])
            if not out.get("ref"):
                return await self._unknown(run, effect, {"unknown": "the preview answered no reference"})
            return await R("done", f"preview-deployed:{op}", "preview-deployed", [q(op), q(body["ckpt"]), q(out["ref"])],
                           out, lambda: self.hive.events.publish("create.plan.preview", plan_id=self.app_plan(pid),
                                                                 ckpt=body["ckpt"], preview=out["ref"]))
        if kind == "deploy":
            if out.get("refused"):
                return await R("refused", f"deploy-refused:{op}", "deploy-refused", [q(op)])
            return await R("done", f"deployed:{op}", "deployed", [q(op)], out,
                           lambda: (self.db.execute("UPDATE create_plan_runs SET installed = ? WHERE plan_id = ?",
                                                    (_canonical(out), pid)), self._record_revision(pid, out)))
        raise EngineError(f"no result mapping for effect {kind}")

    def _has_result(self, pid, op, admitting):
        """True when the journal already holds a result for op (a restart between journalling it and marking the
        effect): the effect must not run again."""
        for r in self.db.all("SELECT obs_id FROM create_plan_journal WHERE plan_id = ? AND (obs_id LIKE ? OR obs_id LIKE ?)",
                             (pid, f"%:{op}", f"%:{op}:%")):
            if r["obs_id"] != admitting:
                return True
        return False

    async def _reconcile(self, run, op):
        """Read back what happened to op (its effect row, and a pending mind call's goal is withdrawn), then journal
        reconciled (op). The reducer restores a lost piece's status but never releases a hold."""
        pid = run["plan_id"]
        effect = self._effect(pid, op)
        readback = {"op": op, "effect": None}
        if effect is not None and effect["kind"] == "deploy":
            # R4.1: a deploy is settled only by its own readback: deployed-confirmed (op receipt) or
            # reconciled-not-deployed (op); a plain reconciled is refused for it
            try:
                rb = await self.ports.deploy_readback(run, self._body(effect), self._plan(pid))
            except Exception as exc:
                self._save(pid, last_error=f"readback of {op} failed ({type(exc).__name__})")
                return False
            if rb.get("deployed"):
                self._effect_set(effect["id"], "done", rb)
                verdict = await self.observe(run, f"deployed-confirmed:{op}", "deployed-confirmed",
                                             [q(op), q(rb["receipt"])], rb)
                if self.accepted(verdict):
                    self.db.execute("UPDATE create_plan_runs SET installed = ? WHERE plan_id = ?", (_canonical(rb), pid))
                    self._record_revision(pid, rb)
                return self.accepted(verdict)
            if rb.get("deployed") is False:
                self._effect_set(effect["id"], "reconciled", rb)
                return self.accepted(await self.observe(run, f"reconciled-not-deployed:{op}", "reconciled-not-deployed",
                                                        [q(op)], rb))
            self._save(pid, last_error=f"the deploy {op} cannot be read back yet")
            return False
        if effect is not None:
            readback["effect"] = {"kind": effect["kind"], "state": effect["state"]}
            try:
                readback["port"] = await self.ports.readback(run, self._body(effect), effect["kind"], effect["goal_id"])
            except Exception as exc:
                self._save(pid, last_error=f"readback of {op} failed ({type(exc).__name__})")
                return False                                   # stays unresolved; a later wake retries
            if effect["state"] in ("journaled", "waiting", "unknown"):
                self._effect_set(effect["id"], "reconciled", readback)
        return self.accepted(await self.observe(run, f"reconciled:{op}", "reconciled", [q(op)], readback))

    # ---- view --------------------------------------------------------------------------------------------------

    def _latest_ckpt(self, run):
        space = self._space(run)
        return (space.get("ckpts") or [None])[-1] or space.get("base")

    def _known_ckpts(self, run):
        space = self._space(run)
        return set(space.get("ckpts") or []) | set(space.get("candidates") or {}) | ({space["base"]} if space.get("base") else set())

    def _actions(self, run, pid):
        base = f"/api/create/plans/{pid}"
        ready = run["status"] == "ready_to_deploy"
        asking = [e for e in self._effects(pid, "question") if not self._answered(pid, e["op"])]
        terminal = run["phase"] in TERMINAL
        return [
            {"name": "answer", "label": "Answer", "method": "POST", "path": base + "/answers",
             "body": {"q": "question id", "text": "string, 1-4000 characters"}, "available": bool(asking) and not terminal,
             "why_not": None if asking and not terminal else "no question is waiting for you"},
            {"name": "deploy", "label": "Deploy", "method": "POST", "path": base + "/deploy", "body": {},
             "available": ready, "why_not": None if ready else "nothing is ready to deploy yet"},
            {"name": "stop", "label": "Stop", "method": "POST", "path": base + "/stop", "body": {},
             "available": not terminal, "why_not": None if not terminal else "this plan is finished"}]

    def _answered(self, pid, qid):
        for r in self.db.all("SELECT fields, verdict FROM create_plan_journal WHERE plan_id = ? AND kind = 'answered'", (pid,)):
            if r["verdict"] == "accepted" and str(parse(r["fields"])[0]) == qid:
                return True
        return False

    def view(self, pid):
        """GET /api/create/plans/{id}: see PLAN_VIEW_FIELDS in the module docs of create_plan_ports (Surface contract).
        An app plan's view is its newest round's, under the app plan's id, with the app's rounds: round, its words,
        the revisions and the one the app runs now, the app as installed, and the actions that change it."""
        app = self.app_plan(pid)
        rounds = self._rounds(app)
        if not rounds:
            return None
        v = self._run_view(rounds[-1])
        app_run, newest = self._run(app), self._run(rounds[-1])
        settled = newest["phase"] in TERMINAL
        revisions = self._revisions(app)
        current = self._current_revision(app)
        v["plan_id"], v["round"], v["round_words"] = app, len(rounds), newest["sentence"]
        v["sentence"] = app_run["sentence"]
        # the app keeps its own name (app_name): a round's plan is titled by its change, which the view gives as
        # round_title
        app_title = self.app_name(app)
        v["round_title"], v["title"], v["summary"] = v["title"], app_title, app_title or app_run["sentence"]
        v["revisions"] = [{"round": r["round"], "words": r["words"], "from": r.get("from"),
                           "deployed_at": r.get("deployed_at"), "current": current is not None and r["round"] == current["round"]}
                          for r in revisions]
        v["installed"] = json.loads(app_run["installed"]) if app_run["installed"] else None
        if settled and current is not None and current.get("preview"):
            v["preview"] = current["preview"]          # with no change in flight, the app as it runs now
        base = f"/api/create/plans/{app}"
        undo_to = current.get("from") if current else None
        why_busy = None if settled else "a change to this app is still being made"
        v["actions"] = v["actions"] + [
            {"name": "revise", "label": "Change it", "method": "POST", "path": base + "/revise",
             "body": {"words": f"string, 1-{MAX_SENTENCE} characters"}, "available": settled and current is not None,
             "why_not": why_busy or (None if current is not None else "nothing of this app has been deployed yet")},
            {"name": "undo", "label": "Undo", "method": "POST", "path": base + "/revert", "body": {"round": undo_to},
             "available": settled and undo_to is not None,
             "why_not": why_busy or (None if undo_to is not None else "this is the app's first version")},
            {"name": "revert", "label": "Put back", "method": "POST", "path": base + "/revert",
             "body": {"round": "a revision's round"}, "available": settled and len(revisions) > 1,
             "why_not": why_busy or (None if len(revisions) > 1 else "the app has one version")}]
        return v

    def _run_view(self, pid):
        run = self._run(pid)
        if run is None:
            return None
        journal = self._journal(pid)
        plan = self._plan(pid) or {}
        specs = {x["id"]: x for x in plan.get("pieces", [])}
        effects = self._effects(pid)
        space = self._space(run)
        # piece state from the journal's accepted observations (the reducer's own view is the next_action; the per-piece
        # display follows its records, replayed from the same journal by the last step)
        pieces = []
        state = self._last_state(run)
        for r in (state.get("pieces") or []):
            p = str(r[1])
            spec = specs.get(p, {})
            assignment = self.assignees.resolve(self._selector(spec), run["person"]) if spec else {}
            builds = [e for e in effects if e["kind"] == "build" and self._body(e).get("piece") == p]
            reviews = [e for e in effects if e["kind"] == "review" and self._body(e).get("piece") == p]
            last_review = reviews[-1] if reviews else None
            rv = None
            if last_review is not None:
                rb, rr = self._body(last_review), json.loads(last_review["result"] or "{}")
                rv = {"kind": rb["rule"]["review_kind"], "state": last_review["state"], "decision": rr.get("decision"),
                      "reviewer": (rr.get("reviewer") or None), "notes": rr.get("notes"),
                      "evidence": rr.get("evidence"), "candidate": rb["candidate"]}
            cand = _plain(r[3])
            status = _plain(r[2])
            state = "unassignable" if isinstance(status, list) else status
            held = _plain(r[8]) if len(r) > 8 else None
            pieces.append({
                "id": p, "title": spec.get("title", p), "kinds": spec.get("kinds", []),
                "team": (assignment.get("display") if assignment.get("resolved") else (spec.get("kinds") or [None])[0]),
                "assignee": {"selector": self._selector(spec) if spec else None, "kind": assignment.get("kind"),
                             "ref": assignment.get("ref"), "resolved": bool(assignment.get("resolved")),
                             "display": assignment.get("display"), "detail": assignment.get("detail"),
                             "taken_by": None if held in (None, "none") else held},
                "deps": spec.get("deps", []), "files": spec.get("files", []), "state": state,
                "status": state, "passed_reviews": _plain(r[7]) if len(r) > 7 else [],
                "builder": self._body(builds[-1]).get("builder") if builds else None,
                "member": (space.get("members") or {}).get(p, {}).get("task_id"),
                "editing": state == "started", "draft": None if cand == "none" else cand,
                "candidate": None if cand == "none" else cand, "repairs": r[4],
                "summary": None if cand == "none" else self._built_summary(pid, cand),
                "unreviewed": str(r[6]) == "unreviewed", "review": rv,
                "tests": [space["suite"]] if space.get("suite") else []})
        questions = []
        for e in self._effects(pid, "question"):
            b = self._body(e)
            ans = next((self._evidence(pid, j["obs_id"]).get("text") for j in journal if j["kind"] == "answered"
                        and j["verdict"] == "accepted" and str(parse(j["fields"])[0]) == e["op"]), None)
            questions.append({"q": b["q"], "about": b["about"], "text": b["text"], "choices": b.get("choices", []),
                              "answered": ans is not None, "answer": ans})
        checks = []
        for e in self._effects(pid, "run-checks"):
            b, res = self._body(e), json.loads(e["result"] or "{}")
            checks.append({"run": e["op"], "ckpt": space.get("base") if b["target"] == "base" else b["target"],
                           "base": b["target"] == "base", "state": res.get("outcome") or e["state"], "reason": res.get("reason"),
                           "failing": res.get("failing") or [], "line": res.get("line"), "output": res.get("output")})
        previews = [json.loads(e["result"]) | {"ckpt": self._body(e)["ckpt"]} for e in self._effects(pid, "preview")
                    if e["state"] == "done"]
        nxt = run["next_action"]
        return {"plan_id": pid, "engine": f"metta-plan-controller/{REDUCERS.get(run['reducer_sha256'], (None, '?'))[1]}", "reducer_sha256": run["reducer_sha256"],
                "sentence": run["sentence"], "title": plan.get("title"), "summary": plan.get("title") or run["sentence"],
                "acceptance": plan.get("acceptance", []),
                "phase": run["phase"], "status": run["status"], "review_policy": run["review_policy"],
                "unreviewed": bool(nxt and nxt.startswith("(tell confirm-unreviewed-deploy")),
                "next_action": nxt, "last_error": run["last_error"], "waiting": self._waiting(pid, effects),
                "pieces": pieces, "questions": questions,
                "checks": checks, "checkpoint": {"ckpt": self._latest_ckpt(run), "workspace": space.get("integration")},
                "preview": previews[-1] if previews else None,
                "installed": json.loads(run["installed"]) if run["installed"] else None,
                "actions": self._actions(run, pid),
                "journal": [{"seq": r["seq"], "id": r["obs_id"], "kind": r["kind"], "fields": r["fields"],
                             "verdict": r["verdict"], "at": r["at"],
                             "evidence": json.loads(r["evidence"]) if r["evidence"] else None} for r in journal],
                "effects": [{"kind": e["kind"], "op": e["op"], "state": e["state"], "goal_id": e["goal_id"]} for e in effects],
                "updated_at": run["updated_at"]}

    def _waiting(self, pid, effects):
        """Each mind this plan waits on that can't go on now, one row a mind, as {mind, name, step, reason} and, refused
        for spending, the refusal's code and message: the plan says why it isn't moving instead of sitting at its phase
        with nothing said. reason is spending (Hive.refusals, kept until a call of its is admitted again: a test hive
        with a 1 USD month limit held its planner 30 minutes that way) or the mind's state (_held_state: on 20 Nov a
        tester's Make sat at "waiting for code review" with their reviewer stopped, and went on once they started it).
        The minds are the claimers (else assignees) of the goals of the effects waiting on one, and a build's builder
        while the build waits on its piece's member (member:<task>, no goal); step is the plan's
        words for what it waits on (_step_words); a spending message is the hive's own, which names no limit a viewer
        may not see. Time: one goal and one mind row read per waiting effect, n effects."""
        refusals = getattr(self.hive, "refusals", None) or {}
        rows, seen = [], set()
        for e in effects:
            if e["state"] != "waiting" or not e["goal_id"]:   # an effect waits on its goal's mind only while "waiting"
                continue
            if str(e["goal_id"]).startswith("member:"):
                # a build waits on its piece's member (create_plan_members), whose work its builder does and which no
                # goal row names: on 20 Nov a Make sat at "Building: 0 of 1 piece in" for 26 minutes while its builder
                # was refused for spending, and the view said nothing
                mind = self._body(e).get("builder")
            else:
                goal = self.db.one("SELECT claimed_by, assignee FROM goals WHERE id = ?", (e["goal_id"],)) or {}
                mind = goal.get("claimed_by") or goal.get("assignee")
            if not mind or mind in seen:
                continue
            row = self.db.one("SELECT name, status, desired FROM agents WHERE id = ? AND deleted = 0", (mind,))
            refused = refusals.get(mind)
            reason = "spending" if refused else _held_state(row) if row else None
            if reason is None:
                continue
            seen.add(mind)
            out = {"mind": mind, "name": row["name"] if row and row["name"] else "A mind", "step": self._step_words(pid, e),
                   "reason": reason}
            if refused:
                out.update(code=refused.get("code"),
                           message=refused.get("message") or "A spending limit has no room for this call.")
            rows.append(out)
        return rows

    def _step_words(self, pid, effect):
        """The plan's own words for what a waiting effect asks of its mind: "the plan", "building the board", "code review
        of the board"."""
        kind, body = effect["kind"], self._body(effect)
        if kind in _WAIT_WORDS:
            return _WAIT_WORDS[kind]
        spec = self._piece_spec(pid, body.get("piece")) or {}
        piece = spec.get("title") or body.get("piece") or "a piece"
        if kind == "build":
            return f"building {piece}"
        if kind == "review":
            rule = body.get("rule") or {}
            art, review = str(rule.get("artifact_kind") or ""), str(rule.get("review_kind") or "review")
            return f"{review if art and art in review else (art + ' ' + review).strip()} of {piece}".replace("-", " ")
        return kind.replace("-", " ")

    @staticmethod
    def _last_state(run):
        return json.loads(run["state"]) if run["state"] else {}

    def list_for(self, principal):
        """The person's plans, newest first: an app plan once, its later rounds inside its view, never as plans."""
        rows = self.db.all("SELECT * FROM create_plan_runs WHERE person = ? ORDER BY created_at DESC LIMIT 100", (principal,))
        out = []
        for r in rows:
            if self._space(r).get("app_plan"):
                continue
            newest = self._run(self._rounds(r["plan_id"])[-1])
            out.append({"plan_id": r["plan_id"], "sentence": r["sentence"], "title": self.app_name(r["plan_id"]),
                        "phase": newest["phase"],
                        "status": newest["status"], "round": len(self._rounds(r["plan_id"])),
                        "updated_at": max(r["updated_at"], newest["updated_at"])})
        return out

    def installed_for(self, principal):
        """Project successful deployment receipts newest first without replaying the person's plans."""
        return self.db.all(
            "SELECT json_extract(r.installed, '$.program_id') AS program_id, "
            "COALESCE(json_extract(r.installed, '$.installed_at'), "
            "(SELECT j.at FROM create_plan_journal j WHERE j.plan_id = r.plan_id "
            "AND j.kind IN ('deployed', 'deployed-confirmed') AND j.verdict = 'accepted' ORDER BY j.seq DESC LIMIT 1), "
            "r.updated_at) AS at "
            "FROM create_plan_runs r WHERE r.person = ? AND r.installed IS NOT NULL "
            "AND json_type(r.installed, '$.program_id') = 'text' ORDER BY at DESC, program_id DESC", (principal,))


# the plan's words for a waiting step that names no piece (_step_words); a build or review names its piece
_WAIT_WORDS = {"plan": "the plan", "design": "the design", "author-tests": "the acceptance check",
               "detect-tests": "the acceptance check"}


def _held_state(row):
    """Why a mind can't take a plan's step now, from its row, or None while it can: stopped with an error, never started
    (a new mind's 'created'), stopped or being stopped, or asleep with no wake asked for. A mind starting or awake can."""
    status, desired = row["status"], row["desired"]
    if status == "error":
        return "error"
    if status == "created":
        return "created"
    if status == "stopped" or desired == "stopped":
        return "stopped"
    if status == "asleep" and desired != "awake":
        return "asleep"
    return None


_STEP_WORDS = {"plan-failed": "planning", "fix-rounds": "fixing it", "piece-repairs": "repairing a piece",
               "preview-failed": "the preview"}   # plain words for the reducer's cap codes; never show the code itself


def _blocked_text(why, stopped=None):
    """The hold card's words for the reducer's blocked reason. `stopped` (engine._stopped) names the mind and why it
    stopped (its ended goal's reason, or the check its last version still fails), which says more than the step's
    general words."""
    if stopped and (why == ["cap-exceeded", "lost-operations"] or isinstance(why, list) and why[:1] == ["piece-blocked"]):
        return f"{stopped} Try again, or stop?"
    if why == "tests-not-red":
        return "The acceptance check already passes on the empty scaffold, so it proves nothing. Shall I write a stricter one?"
    if why == ["cap-exceeded", "broken-check"]:
        return "The acceptance check I wrote keeps failing to run. Try again, or stop?"
    if why == "broken-check-on-build":
        return "The acceptance check stopped giving a verdict on the built app. Try again, or stop?"
    if why == ["cap-exceeded", "lost-operations"]:
        return ("Several steps were lost on the way (no clear answer came back), more than the allowed number of "
                "times. Try again with a fresh allowance, or stop?")
    if isinstance(why, list) and why[:1] == ["cap-exceeded"]:
        return f"I tried {_STEP_WORDS.get(str(why[1]), 'this step')} the allowed number of times and it is still not right. Try again, or stop?"
    if isinstance(why, list) and why[:1] == ["review-unavailable"]:
        return f"Nobody independent can review {why[1]} right now. Wait and try again, or stop?"
    if isinstance(why, list) and why[:1] == ["piece-blocked"]:
        return f"The builder of {why[1]} could not finish. Try again, or stop?"
    if isinstance(why, list) and why[:1] == ["unrouted-failure"]:
        return "The check failed on a file no piece owns. Try again, or stop?"
    return "The plan is on hold. Try again, or stop?"
