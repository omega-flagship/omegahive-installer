# Purpose: tests of the Create plan engine on the real reducer, hive, routes and releases with the model calls, builds
# and workspace faked, and of how its ports read a mind's finished goal.
"""Create plans: the host engine for the MeTTa plan controller R4.0 (hive/core/create_plan_engine.py), slice 1.

"make me a small web page that shows the phases of the moon": the plan reducer runs for real in PeTTa; the hive, its
routes, the foundation bindings, the assignee resolver, the journal, the events and the preview/deploy releases are the
real ones. Faked: the model calls (planner, test author, reviewers: FakeMinds answers what a mind would put in its
goal's result data), the per-change engine the pieces are built by (FakePerChangeEngine: the R3.14 members API, whose
helper is the piece assignee's FakeMinds answer; PerChangeBuilds, the adapter under test, is real) and the build
workspace (MemorySpace, the OmegaCode space's interface in memory). Real members on the real OmegaCode are exercised in
test_create_plan_engine_live_service.py. The acceptance check is REAL Python, written by the "test author"
and run in a subprocess (SubprocessChecks; production runs it in sandbox_run): red on the scaffold, red again on a
buggy app.js (routed to the code piece), then green.
"""
import asyncio
import json
import os
import pathlib
import subprocess
import sys
import tempfile

import pytest

from hive.core import create_plan_engine as cpe
from hive.core import create_plan_ports as cpp
from hive.core.create_plan_members import PerChangeBuilds
from hive.core.create_plan_ports import (PROBE_PATH, ROUND_CONTRACT, AppReleases, GoalMinds, Ports, frame_document,
                                         parse_check_output)
from hive.core.goals import STEP_BUDGET_FLOOR_USD
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_result_schema import STORED_AS

ROOT = pathlib.Path(__file__).resolve().parents[2]
ORIGIN = {"Origin": "http://127.0.0.1:8700"}
SENTENCE = "make me a small web page that shows the phases of the moon"
PHASES = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous", "Full Moon", "Waning Gibbous",
          "Last Quarter", "Waning Crescent"]

SCAFFOLD = {
    "index.html": '<!doctype html>\n<html><head><link rel="stylesheet" href="./style.css"></head>\n<body>\n'
                  '<script type="module" src="./app.js"></script>\n</body></html>\n',
    "style.css": "",
    "app.js": "",
    "README.md": "Create web scaffold\n",
}

CHECK = r'''
import json, pathlib
from html.parser import HTMLParser

failing, notes = set(), []
def read(p):
    f = pathlib.Path(p)
    return f.read_text() if f.is_file() else ""

class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.h1 = ""; self.in_h1 = False; self.ids = set(); self.css = False; self.js = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "h1": self.in_h1 = True
        if a.get("id"): self.ids.add((tag, a["id"]))
        if tag == "link" and a.get("rel") == "stylesheet" and a.get("href") == "./style.css": self.css = True
        if tag == "script" and a.get("type") == "module" and a.get("src") == "./app.js": self.js = True
    def handle_endtag(self, tag):
        if tag == "h1": self.in_h1 = False
    def handle_data(self, data):
        if self.in_h1: self.h1 += data

page = Page(); page.feed(read("index.html"))
if "moon" not in page.h1.lower(): failing.add("index.html"); notes.append("the heading names the moon")
if ("ul", "phases") not in page.ids: failing.add("index.html"); notes.append("a list with id phases")
if not (page.css and page.js): failing.add("index.html"); notes.append("appFrame contract: ./style.css and ./app.js")
css = read("style.css")
if "#phases" not in css: failing.add("style.css"); notes.append("the phase list is styled")
js = read("app.js")
for name in %r:
    if name not in js: failing.add("app.js"); notes.append("app.js lists " + name)
if 'getElementById("phases")' not in js: failing.add("app.js"); notes.append("app.js fills #phases")
print("CREATE-CHECK " + json.dumps({"passed": not failing, "failing": sorted(failing), "notes": notes}))
''' % (PHASES,)

PAGE = ('<!doctype html>\n<html><head><link rel="stylesheet" href="./style.css"></head>\n<body>\n'
        '<h1>Phases of the Moon</h1>\n<ul id="phases"></ul>\n<script type="module" src="./app.js"></script>\n</body></html>\n')
STYLE = "body { font-family: system-ui; background: #0b1020; color: #e8ecff; }\n#phases { list-style: none; padding: 0; }\n"
APP_BUGGY = ("const phases = %s;\nconst list = document.getElementById(\"phases\");\n"
             "for (const p of phases) { const li = document.createElement('li'); li.textContent = p; list.append(li); }\n"
             % json.dumps(PHASES[:-1]))
APP_FIXED = APP_BUGGY.replace(json.dumps(PHASES[:-1]), json.dumps(PHASES))


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


# ---- fakes: the build space in memory, the minds' answers, the check in a subprocess ---------------------------------

class MemorySpace:
    """The OmegaCodeSpace interface in memory: an integration workspace, a fork per piece, checkpoints, and a three-way
    merge (base = the piece's last integrated candidate, else its fork origin) into the integration workspace."""

    def __init__(self, engine, scaffold):
        self.engine, self.scaffold = engine, dict(scaffold)
        self.ckpts, self.heads, self.forks, self.origin, self.merged = {}, {}, {}, {}, {}
        self.n, self.adopted = 0, set()

    def _ck(self, files):
        self.n += 1
        ck = f"ckpt_{self.n:03d}"
        self.ckpts[ck] = dict(files)
        return ck

    async def open(self, run):
        ck = self._ck(self.scaffold)
        self.integration = ck
        return {"integration": "ws_integration", "scaffold": ck, "task_id": "task_mem", "grant_id": "grant_mem",
                "repository_id": "repo_mem"}

    async def write(self, run, files, label):
        self.integration = self._ck({**self.ckpts[self.integration], **files})
        return self.integration

    async def ensure_fork(self, run, piece):
        if piece not in self.forks:
            self.forks[piece] = self.integration
            self.origin[piece] = self.integration
        return f"ws_{piece}"

    def member_write(self, piece, files):
        """What a member's helper does on the piece's fork: write its files, checkpoint (the candidate)."""
        start = self.heads.get(piece) or self.forks[piece]
        ck = self._ck({**self.ckpts[start], **files})
        self.heads[piece] = ck
        return ck

    async def adopt_checkpoint(self, run, piece, ckpt, allowed):
        from hive.core.create_plan_ports import candidate_scope
        assert self.heads.get(piece) == ckpt, "a candidate is the fork's current checkpoint"
        candidate_scope(self.ckpts[self.origin[piece]], self.ckpts[ckpt], set(allowed))
        self.adopted.add(ckpt)
        return ckpt

    async def merge(self, run, piece, cand):
        base = self.ckpts[self.merged.get(piece) or self.origin[piece]]
        ours, incoming = dict(self.ckpts[self.integration]), self.ckpts[cand]
        conflicts = []
        for path in set(incoming) | set(base):
            b, o, i = base.get(path), ours.get(path), incoming.get(path)
            if i == b:
                continue
            if o != b and o != i:
                conflicts.append(path)
            else:
                ours[path] = i
        if conflicts:
            return {"conflict": sorted(conflicts)}
        self.integration = self._ck(ours)
        self.merged[piece] = cand
        return {"ckpt": self.integration}

    async def files(self, run, ckpt):
        return dict(self.ckpts[ckpt])


class SubprocessChecks:
    """TEST ONLY: the authored check in a child process, isolated like the sandbox runner: the files under test in
    build/ (the working directory), the check at its own path among them (build/checks/acceptance_check.py), python -I
    so nothing in build is importable. Production: SandboxChecks."""

    async def run(self, files, suite):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as d:
            build = pathlib.Path(d, "build")
            build.mkdir()
            for path, content in files.items():
                f = build / path
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(content)
            proc = subprocess.run([sys.executable, "-I", str(build / suite)], cwd=build,
                                  capture_output=True, text=True, timeout=30)
        return parse_check_output(proc.stdout, proc.returncode, proc.stderr)

    async def run_probe(self, document, probe, owned):
        """TEST ONLY: the play check's runner (tools/probe.mjs) by Node in a fresh folder. Production: SandboxChecks."""
        from hive.tests.test_create_probe import NODE, RUNNER
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as d:
            pathlib.Path(d, "snapshot.json").write_text(json.dumps({"document": document, "probe": probe, "owned": owned}))
            proc = subprocess.run([NODE, str(RUNNER)], cwd=d, capture_output=True, text=True, timeout=120)
        return parse_check_output(proc.stdout, proc.returncode, proc.stderr)


class FakePerChangeEngine:
    """TEST ONLY: the R3.14 members API (adopt_member, member_refix, member_integrated, member_budget_ended,
    member_ports, the run row) without the reducer. A member's helper is its assignee's FakeMinds build answer, given
    the packet the real member sends (the plan's brief, the failing output on a repair). defer=True leaves each member
    working until the test finishes it (finish), then code.controller.member_ready wakes the plan."""

    def __init__(self, minds, space, defer=False):
        import types
        self.minds, self.space, self.defer = minds, space, defer
        self.member_ports = types.SimpleNamespace(run_test=None)
        self.runs, self.calls, self.held = {}, [], {}
        self.plant = {}                 # piece -> {path: text} someone else writes onto that piece's fork
        self.fail_delivery = set()      # pieces whose first member_integrated is lost (a crash)
        self.refused = {}               # task_id -> its last refusal's evidence (last_refused: goal_status, goal_reason)
        self.failing = {}               # task_id -> its newest failing since its last version (_failing_output)
        self.refusals = {}              # task_id -> the member's last refusal in words (last_refusal)
        self.summaries = {}             # (task_id, cand) -> the builder's own summary (member_summary)
        self.checks = {}                # piece -> its member's finished test evidence (member_check); none: not run

    def _run(self, task_id):
        return self.runs.get(task_id)

    def adopt_member(self, plan_id, piece, origin, paths, assignee, budget_ref, review_policy, person,
                     controller_id=None, task=None, brief=None, contract=None):
        import hashlib
        assert review_policy == "plan-reviewed" and origin["workspace_id"] == f"ws_{piece}"
        tid = "mt_" + hashlib.sha256(f"{plan_id}|{piece}|{task}".encode()).hexdigest()[:32]
        assert len(json.dumps(brief, sort_keys=True, separators=(",", ":"), ensure_ascii=False)) <= 40000
        self.calls.append(("adopt", piece, task, assignee))
        if tid not in self.runs:
            self.runs[tid] = {"request_id": tid, "profile": "plan-member", "phase": "claimed", "status": "accepted",
                              "next_action": None, "candidate": None, "last_error": None, "member": json.dumps(
                                  {"plan_id": plan_id, "piece": piece, "paths": sorted(paths), "assignee": assignee,
                                   "brief": brief, **({"contract": contract} if contract else {})})}
            self._helper(tid, (brief or {}).get("failing"))
        return {"task_id": tid, "plan_id": plan_id, "piece": piece}

    def _helper(self, tid, failing):
        if self.defer:
            self.held[tid] = failing
            return
        r, m = self.runs[tid], json.loads(self.runs[tid]["member"])
        packet = {"piece": m["piece"], "paths": m["paths"], "brief": m["brief"], "answers": m["brief"]["answers"],
                  "failing": failing}
        self.minds.calls.append(("build", m["assignee"], packet))
        answer = self.minds._answer("build", {"piece": m["piece"], "failing": failing}, packet, m["assignee"])
        assert set(answer["files"]) <= set(m["paths"])
        ck = self.space.member_write(m["piece"], {**answer["files"], **self.plant.get(m["piece"], {})})
        self.summaries[(tid, ck)] = answer.get("summary")
        r.update(phase="ready", status="ready_for_you", candidate=ck, next_action=f"(tell member-ready {ck})")

    def finish(self, tid):
        self.defer, failing = False, self.held.pop(tid)
        try:
            self._helper(tid, failing)
        finally:
            self.defer = True
        m = json.loads(self.runs[tid]["member"])
        return {"type": "code.controller.member_ready", "plan_id": m["plan_id"], "piece": m["piece"],
                "cand": self.runs[tid]["candidate"], "task_id": tid}

    def last_refused(self, task_id):
        return self.refused.get(task_id)

    def _failing_output(self, task_id):
        return self.failing.get(task_id)

    def last_refusal(self, task_id):
        return self.refusals.get(task_id)

    def member_summary(self, task_id, cand):
        return self.summaries.get((task_id, cand))

    def member_check(self, task_id, cand):
        return self.checks.get(json.loads(self.runs[task_id]["member"])["piece"])

    async def member_refix(self, task_id, op, cand, failing_ref, failing=None):
        assert self.runs[task_id]["candidate"] == cand
        self.calls.append(("refix", json.loads(self.runs[task_id]["member"])["piece"], op, failing_ref))
        self.runs[task_id].update(phase="red", status="working", next_action="(think repair-from-the-failing-output)")
        self._helper(task_id, failing)

    async def member_integrated(self, task_id, op, cand, ckpt):
        assert self.runs[task_id]["candidate"] == cand
        piece = json.loads(self.runs[task_id]["member"])["piece"]
        if piece in self.fail_delivery:
            self.fail_delivery.discard(piece)
            raise ConnectionError("the hive went down before the member heard")
        self.calls.append(("integrated", json.loads(self.runs[task_id]["member"])["piece"], op, ckpt))
        self.runs[task_id].update(phase="delivered", status="delivered", next_action="(rest delivered)")

    async def member_budget_ended(self, task_id, why="the plan's budget for this piece ended"):
        self.calls.append(("budget-ended", json.loads(self.runs[task_id]["member"])["piece"], why))
        self.runs[task_id].update(phase="stopped", status="stopped", next_action="(rest stopped)")


class FakeMinds:
    """What each resolved mind would put in its goal's result data. Records every call (kind, who, packet)."""

    def __init__(self, engine, question=True, review=None, pending=()):
        self.engine, self.calls, self.question = engine, [], question
        self.review = review or {}
        self.pending, self.held, self.finished = set(pending), {}, set()
        self.app_builds = 0
        self.extra = {}                 # piece -> {path: text}: more files that piece owns and builds (assets)
        self.authored = []              # check sources the test author writes first, in order; then CHECK
        self.always = None              # a check source the test author always writes (a permanently broken author)
        self.probe = None               # a probe the test author writes instead of a Python check (the play check)

    def _who(self, run, kind, body):
        from hive.core.create_plan_ports import GoalMinds
        return GoalMinds._who(self, run, kind, body)

    async def call(self, run, kind, body, packet):
        who = self._who(run, kind, body)
        agent = who.get("agent_id")
        self.calls.append((kind, agent, packet))
        answer = self._answer(kind, body, packet, agent)
        if kind in self.pending:
            gid = f"g_fake_{len(self.calls)}"
            self.held[gid] = answer
            return {"pending": gid}
        return answer

    async def collect(self, run, kind, body, goal_id):
        """Like a goal row: nothing until the mind finished it (self.finished), then its answer."""
        if goal_id not in self.finished:
            return None
        return self.held.pop(goal_id, None)

    def finish_all(self):
        self.finished |= set(self.held)
        return list(self.held)

    async def withdraw(self, run, goal_id):
        self.held.pop(goal_id, None)
        return {"goal": goal_id, "withdrawn": True}

    def _answer(self, kind, body, packet, agent):
        if kind == "plan":
            questions = [{"q": "q-emoji", "about": "plan", "text": "Show a moon emoji beside each phase?",
                          "choices": ["Yes", "No"]}] if self.question else []
            return {"by": agent, "plan": {
                # a planner titles a later round by its change, as a real model does ("Tip choice of 15, 18 or 20
                # percent" for a tip calculator's second round)
                "title": "Tonight's heading" if packet.get("change") else "Moon phases", "pieces": [
                    {"id": "page", "kinds": ["design"], "title": "Page layout",
                     "files": ["index.html", *sorted(set(self.extra.get("page", {})) - {"index.html"})],
                     "brief": "Heading and an empty list #phases."},
                    {"id": "style", "kinds": ["design"], "title": "Look", "files": ["style.css"], "brief": "Night sky."},
                    {"id": "app", "kinds": ["code"], "title": "Fill the list", "deps": ["page"], "files": ["app.js"],
                     "brief": "List the eight phases in #phases."}],
                "acceptance": ["The heading names the moon", "All eight phases are listed", "It loads in the app frame"],
                "questions": questions, "needs": {"design": "no-design", "tests": "author"}}}
        if kind == "author-tests":
            assert "index.html" in packet["scaffold"]
            if packet.get("change"):           # a later round: a probe for what the change asks, red on the app now
                return {"by": agent, "files": {PROBE_PATH: ROUND_PROBE}}
            if self.probe is not None:
                return {"by": agent, "files": {PROBE_PATH: self.probe}}
            src = self.always or (self.authored.pop(0) if self.authored else CHECK)
            return {"by": agent, "files": {cpe.CHECK_PATH: src}}
        if kind == "build":
            p = body["piece"]
            if p == "page":
                page = self.extra.get("page", {}).get("index.html", PAGE)
                # a later round's change: its context names the change, where a first build begun from a saved
                # creation has only what the person has now
                if ((body.get("brief") or packet.get("brief") or {}).get("change") or {}).get("change"):
                    page = PAGE.replace("Phases of the Moon", "Moon phases tonight")
                return {"by": agent, "files": {**self.extra.get("page", {}), "index.html": page},
                        "summary": "heading + list"}
            if p == "style":
                return {"by": agent, "files": {"style.css": STYLE}, "summary": "night sky"}
            self.app_builds += 1
            if body.get("failing"):
                assert "app.js" in body["failing"]["failing"]
                return {"by": agent, "files": {"app.js": APP_FIXED}, "summary": "all eight phases"}
            return {"by": agent, "files": {"app.js": APP_BUGGY}, "summary": "phases"}
        if kind == "review":
            decision = self.review.get(body["piece"], "pass")
            if body["rule"]["review_kind"] == "design-review":
                assert body["evidence"]["ref"].startswith("render-")
            return {"reviewer": agent, "decision": decision, "notes": "ok" if decision == "pass" else "too dark"}
        raise AssertionError(kind)


@pytest.fixture()
def world(client, monkeypatch, tmp_path):  # noqa: F811
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(tmp_path / "create" / "apps"))
    hive = client.app.state.hive
    hive.settings.create_plan_engine = True
    engine = hive.create_plans
    # the person, signed in (a named person's session), and their Make (Studio) mind's binding, as studio_makers.ensure
    # records it (person_minds purpose studio_maker): the default resolution of the design capability
    from hive.core.hive import token_hash
    from hive.core.db import now
    hive.db.insert("people", {"id": "u_jon", "email": "jon@example.test", "name": "Jon", "role": "admin", "created_at": now()})
    hive.db.insert("sessions", {"token_hash": token_hash("jon-session"), "created_at": now(), "kind": "sso",
                                "principal": "user:u_jon"})
    make = client.post("/api/swarms", json={"name": "Make"}).json()
    maker = client.post("/api/agents", json={"name": "Maker", "swarm_id": make["id"]}).json()
    hive.db.execute("INSERT INTO person_minds (principal, purpose, agent_id, swarm_id, created_at, updated_at) VALUES "
                    "(?, 'studio_maker', ?, ?, ?, ?)", ("user:u_jon", maker["id"], make["id"], now(), now()))
    # the person's own Make team and mind, as studio_makers.ensure makes them (owned by the person)
    hive.db.execute("UPDATE swarms SET owner = 'user:u_jon' WHERE id = ?", (make["id"],))
    hive.db.execute("UPDATE agents SET owner = 'user:u_jon' WHERE id = ?", (maker["id"],))
    # Create (Studio) on in that team, as studio-on.py turns it on, so a deployed app has a place to go
    hive.db.execute("INSERT INTO app_activations VALUES (?, ?, 1, ?)", ("omegadesign", make["id"], "user:u_jon"))
    minds = FakeMinds(engine)
    space = MemorySpace(engine, SCAFFOLD)
    code = FakePerChangeEngine(minds, space)
    engine.ports = Ports(engine, minds, space, SubprocessChecks(), AppReleases(engine, tmp_path / "create"))
    engine.ports.members = PerChangeBuilds(engine, engine.ports, code=code)
    events = []
    real_publish = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append((kind, kw)), real_publish(kind, **kw))[1])
    w = type("W", (), {})()
    w.client, w.hive, w.engine, w.minds, w.events, w.maker, w.make = client, hive, engine, minds, events, maker, make
    w.code, w.space = code, space
    w.jon = {"Authorization": "Bearer jon-session", **ORIGIN}
    w.tmp = tmp_path
    return w


def kinds(view):
    return [r["kind"] for r in view["journal"]]


@pytest.mark.parametrize("version,tests,count", [("R4.4", "test_create_plan_controller_r4_4.metta", 327),
                                                 ("R4.3", "test_create_plan_controller_r4_3.metta", 277),
                                                 ("R4.2", "test_create_plan_controller_r4_2.metta", 253),
                                                 ("R4.1", "test_create_plan_controller_r4_1.metta", 228)])
def test_reducers_are_pinned_and_their_own_tests_pass(version, tests, count):
    import hashlib
    sha = next(k for k, v in cpe.REDUCERS.items() if v[1] == version)
    assert hashlib.sha256(cpe.REDUCERS[sha][0].read_bytes()).hexdigest() == sha
    env = dict(os.environ, PATH=os.environ.get("PATH", "") + ":/opt/homebrew/bin")
    out = subprocess.run(["/bin/sh", str(pathlib.Path(os.environ["PETTA_PATH"]) / "run.sh"), tests, "--silent"],
                         cwd=cpe.REDUCER.parent, capture_output=True, text=True, env=env, timeout=300)
    passed = [x for x in out.stdout.splitlines() if x.rstrip().endswith("\u2705")]
    assert "\u274c" not in out.stdout and len(passed) == count, out.stdout[-2000:]


def test_slice1_end_to_end_plan_test_first_red_build_review_fix_green_preview_go(world):
    w = world
    started = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon)
    assert started.status_code == 200, started.text
    view = started.json()
    pid = view["plan_id"]
    # the planner made a typed plan with an open question about the plan: every new effect waits for Jon's answer
    assert view["phase"] == "planned" and view["status"] == "asking_you", [(r["kind"], r["fields"][:200], r["verdict"]) for r in view["journal"]]
    assert kinds(view) == ["plan-started", "planned", "question-asked"]
    assert view["questions"] == [{"q": "q-emoji", "about": "plan", "text": "Show a moon emoji beside each phase?",
                                  "choices": ["Yes", "No"], "answered": False, "answer": None}]
    assert {(p["id"], p["team"], p["assignee"]["resolved"]) for p in view["pieces"]} == {
        ("page", "Make", True), ("style", "Make", True), ("app", "Create · Code", True)}
    assert next(a for a in view["actions"] if a["name"] == "answer")["available"] is True
    assert ("create.plan.question", {"plan_id": pid, "q": "q-emoji", "about": "plan",
                                     "text": "Show a moon emoji beside each phase?", "choices": ["Yes", "No"],
                                     "answered": False}) in w.events

    # someone else cannot answer (same 404 as no plan); the plan's person can
    from hive.core.hive import token_hash
    from hive.core.db import now
    w.hive.db.insert("people", {"id": "u_eve", "email": "eve@example.test", "name": "Eve", "role": "admin", "created_at": now()})
    w.hive.db.insert("sessions", {"token_hash": token_hash("eve-session"), "created_at": now(), "kind": "sso",
                                  "principal": "user:u_eve"})
    eve = {"Authorization": "Bearer eve-session", **ORIGIN}
    assert w.client.post(f"/api/create/plans/{pid}/answers", json={"q": "q-emoji", "text": "no"}, headers=eve).status_code == 404
    assert w.client.get(f"/api/create/plans/{pid}", headers=eve).status_code == 404

    answered = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": "q-emoji", "text": "No emoji, words only"},
                             headers=w.jon)
    assert answered.status_code == 200, answered.text
    view = answered.json()
    j = kinds(view)
    # tests first: the check is authored into the build workspace, and its first run on the scaffold is red
    first_build = j.index("piece-started")
    assert j[:first_build] == ["plan-started", "planned", "question-asked", "answered", "dispatched", "tests-authored",
                               "dispatched", "check-fail"]
    base_check = view["checks"][0]
    assert base_check["base"] is True and base_check["state"] == "fail"
    assert set(base_check["failing"]) == {"index.html", "style.css", "app.js"}
    # the answer reached every later model call
    assert all(c[2]["answers"] == [{"q": "q-emoji", "question": "Show a moon emoji beside each phase?",
                                    "text": "No emoji, words only"}] for c in w.minds.calls[1:])

    # Studio and Code together: page and style built by the person's Make mind, app by Create · Code after page merged;
    # each studio piece got a design review with the host's render evidence, the code piece a code review
    assert view["phase"] == "ready-to-deploy" and view["status"] == "ready_to_deploy", (view["phase"], view["last_error"])
    pieces = {p["id"]: p for p in view["pieces"]}
    assert pieces["page"]["builder"] == w.maker["id"] and pieces["style"]["builder"] == w.maker["id"]
    code_ctl = w.hive.db.one("SELECT agent_id FROM person_minds WHERE purpose = 'foundation_create_code'")["agent_id"]
    reviewer = w.hive.db.one("SELECT agent_id FROM person_minds WHERE purpose = 'foundation_review'")["agent_id"]
    assert pieces["app"]["builder"] == code_ctl
    assert pieces["page"]["review"]["kind"] == "design-review" and pieces["page"]["review"]["evidence"]["ref"].startswith("render-")
    assert pieces["app"]["review"]["kind"] == "review" and pieces["app"]["review"]["reviewer"] == reviewer
    assert all(p["state"] == "integrated" for p in pieces.values())
    # red -> fix -> green: the integrated build first failed on app.js (owned by app), the fix went back to app's own
    # assignee with the failing output, and the next check passed
    checks = view["checks"]
    assert [c["state"] for c in checks] == ["fail", "fail", "pass"]
    assert checks[1]["failing"] == ["app.js"] and checks[1]["base"] is False
    assert pieces["app"]["repairs"] == 1 and w.minds.app_builds == 2
    fix_call = [c for c in w.minds.calls if c[0] == "build" and c[2]["failing"]]
    assert len(fix_call) == 1 and fix_call[0][1] == code_ctl
    # every piece was built by a per-change member: adopted on its own fork with the plan's brief, delivered only by
    # the plan's integration; the post-integration fix is a NEW member for app carrying the failing check output
    assert w.code.member_ports.run_test == w.engine.ports.members.run_test        # the plan's check is each member's test
    adopts = [c for c in w.code.calls if c[0] == "adopt"]
    # the look's design review renders the page, so style is built after page and app (page_before_design)
    assert [c[1] for c in adopts] == ["page", "app", "style", "app"] and adopts[-1][2].startswith("fix-for-")
    assert adopts[1][3] == adopts[3][3] == code_ctl
    assert fix_call[0][2]["brief"]["title"] == "Fill the list" and fix_call[0][2]["brief"]["failing"]["failing"] == ["app.js"]
    assert [c[1] for c in w.code.calls if c[0] == "integrated"] == ["page", "app", "style", "app"]
    assert all(r["phase"] == "delivered" for r in w.code.runs.values())
    assert all(p["member"] in w.code.runs for p in pieces.values())
    # the order the reducer chose (journal before every effect)
    for want in ["piece-started", "piece-ready", "review-pass", "integrated", "check-pass", "preview-deployed"]:
        assert want in kinds(view)
    passes = [r["fields"] for r in view["journal"] if r["kind"] == "review-pass"]
    assert sum("design-review" in f and "(render \"render-" in f for f in passes) >= 2       # (render ref) evidence
    assert any(" review " in f and f.endswith(" none)") for f in passes)                      # code review, no evidence
    started = [r["fields"] for r in view["journal"] if r["kind"] == "piece-started"]
    assert all("(team " in f for f in started)                                                 # the resolved assignee
    rejected = [r for r in view["journal"] if r["verdict"] != "accepted"]
    assert rejected == [], rejected
    # the preview: a pinned UI bundle the canvas can show (verified against its lock), and the appFrame accepts it
    assert view["preview"]["ref"].startswith("preview-")
    pv = w.client.get(f"/api/create/plans/{pid}/preview", headers=w.jon).json()
    assert pv["files"]["app.js"] == APP_FIXED and pv["files"]["index.html"] == PAGE
    frame_document(pv["files"])
    got = w.client.get(f"/api/create/plans/{pid}/files", params={"path": "app.js"}, headers=w.jon).json()
    assert got["content"] == APP_FIXED
    assert any(k == "create.plan.preview" and kw["plan_id"] == pid for k, kw in w.events)
    assert next(a for a in view["actions"] if a["name"] == "deploy")["available"] is True
    assert view["installed"] is None

    # the person's go: deploy-approved journalled first, then the deploy, then `deployed`; the app is installed
    deployed = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon)
    assert deployed.status_code == 200, deployed.text
    view = deployed.json()
    assert view["phase"] == "deployed" and view["status"] == "deployed", (view["last_error"], view["journal"][-1]["evidence"])
    assert kinds(view)[-2:] == ["deploy-approved", "deployed"]
    assert view["journal"][-2]["fields"].endswith("confirm-deploy)")                           # the form the person saw
    app_id = view["installed"]["program_id"]
    assert app_id.endswith(pid[len("plan_"):])                                                 # one app per plan, full id
    ui = w.hive.programs.ui_bundle(app_id)
    assert ui["files"]["app.js"] == APP_FIXED
    # it's in the person's Apps where Create is, so Open finds it: v0.35 rc1 installed it on in no swarm, and its Open
    # said "This app isn't available to you here" under "It's in your Apps now"
    apps = w.client.get("/api/me/apps", headers=w.jon).json()["apps"]
    assert [a["open"] for a in apps if a["id"] == app_id] == [{"kind": "swarm", "swarm_id": w.make["id"],
                                                                "swarm_name": "Make"}], apps
    # typed events across the run
    seen = {k for k, _ in w.events}
    assert {"create.plan.status", "create.plan.piece", "create.plan.question", "create.plan.preview"} <= seen
    statuses = [kw["status"] for k, kw in w.events if k == "create.plan.status" and kw["plan_id"] == pid]
    assert statuses[0] == "planning" and statuses[-1] == "deployed"
    # a second go is refused by the reducer (terminal), and no second deploy runs
    again = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon)
    assert again.status_code == 409


def _to_ready(w):
    pid = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()["plan_id"]
    view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": "q-emoji", "text": "words only"},
                         headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    return view


def test_the_builders_summary_reaches_the_plans_record_its_reviewer_and_the_person(world):
    """A builder's summary ("say so in your summary" when a check looks wrong) stayed in the member's journal; the plan
    recorded "built by per-change member ...". It is now the piece-ready record's summary, in the review packet and in
    the piece the person sees."""
    w = world
    view = _to_ready(w)
    ready = [r["evidence"] for r in view["journal"] if r["kind"] == "piece-ready"]
    said = {"page": "heading + list", "style": "night sky", "app": "all eight phases"}
    assert {e["summary"] for e in ready} == {"heading + list", "night sky", "phases", "all eight phases"}
    assert not [e for e in ready if e["summary"].startswith("built by per-change member")]
    reviews = [c[2] for c in w.minds.calls if c[0] == "review"]
    by_piece = {}
    for r in reviews:
        by_piece.setdefault(r["piece"]["id"], []).append(r["builder_summary"])
    assert by_piece == {"page": ["heading + list"], "style": ["night sky"], "app": ["phases", "all eight phases"]}
    assert {p["id"]: p["summary"] for p in view["pieces"]} == said        # the person sees the latest candidate's


def test_every_review_packet_says_whether_the_check_passed_failed_or_was_not_run(world):
    """A reviewer could not tell a passing build from an unchecked one: a code review's evidence is none. Each review
    packet now carries the acceptance check's outcome on that candidate (from the member's own test run)."""
    w = world
    w.code.checks = {
        "page": {"passed": True, "outcome": "fail", "exit_code": 1,          # failed only on other pieces' files
                 "logs": {"stdout": {"text": 'CREATE-CHECK {"passed": false, "failing": ["app.js"]}'}}},
        "style": {"passed": False, "outcome": "fail", "exit_code": 1, "logs": {"stdout": {"text": "style.css empty"}}},
        "app": {"passed": None, "outcome": "unknown", "logs": {}}}            # ran, no verdict: not run
    view = _to_ready(w)
    reviews = {c[2]["piece"]["id"]: c[2] for c in w.minds.calls if c[0] == "review"}
    assert {p: r["check"] for p, r in reviews.items()} == {"page": "passed", "style": "failed", "app": "not run"}
    assert reviews["page"]["check_detail"] == {"outcome": "fail", "exit_code": 1,
                                               "output": 'CREATE-CHECK {"passed": false, "failing": ["app.js"]}'}
    assert reviews["style"]["check_detail"]["output"] == "style.css empty" and "check_detail" not in reviews["app"]
    assert reviews["app"]["rule"]["evidence"] == "none" and reviews["app"]["evidence"] is None   # a code review
    w.code.checks = {}                                                    # no finished run at all: not run
    assert w.engine.ports.members.check_for(w.engine._run(view["plan_id"]), "app", "cp_none") == {"check": "not run"}


# the play check for the moon page: one case for each acceptance criterion, each naming the owned files it exercises
MOON_PROBE = {"cases": [
    {"name": "The heading names the moon", "files": ["index.html"], "steps": [],
     "assertions": [{"kind": "contains", "selector": "h1", "expected": "Moon"}]},
    {"name": "All eight phases are listed", "files": ["app.js"], "steps": [],
     "assertions": [{"kind": "count", "selector": "#phases li", "expected": 8},
                    {"kind": "text", "selector": "#phases li:last-child", "expected": "Waning Crescent"}]},
    {"name": "It loads in the app frame", "files": ["index.html"], "steps": [],
     "assertions": [{"kind": "visible", "selector": "#phases", "expected": True}]},
]}


def test_slice1_with_the_play_check_red_on_the_scaffold_red_on_the_bug_then_green(world):
    """The same plan, its check a probe the test author wrote (checks/probe.json) and the runner played on the page:
    red on the scaffold, red on the build missing a phase (routed to app.js's piece), green on the fix, then deployed."""
    w = world
    w.minds.probe = MOON_PROBE
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": "q-emoji", "text": "No emoji, words only"},
                         headers=w.jon).json()
    # the test author was asked for a probe, told the plan's own files, and its probe is the base the check runs from
    author = next(c for c in w.minds.calls if c[0] == "author-tests")[2]
    assert author["check_path"] == PROBE_PATH and author["owned_files"] == ["app.js", "index.html", "style.css"]
    assert "the check that plays the app" in author["contract"]
    checks = view["checks"]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"], [c["state"] for c in checks])
    assert [c["state"] for c in checks] == ["fail", "fail", "pass"]
    assert checks[0]["base"] is True and set(checks[0]["failing"]) == {"index.html", "app.js"}
    assert checks[1]["failing"] == ["app.js"] and "All eight phases are listed" in checks[1]["output"]
    assert all(p["tests"] == [PROBE_PATH] for p in view["pieces"])
    # every builder was given the probe it is played by, so it builds to its selectors
    builds = [c for c in w.minds.calls if c[0] == "build"]
    assert builds and all("#phases li" in json.dumps(c[2]["brief"]["probe"]) for c in builds)
    deployed = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    assert deployed["phase"] == "deployed", deployed["last_error"]
    assert w.hive.programs.ui_bundle(deployed["installed"]["program_id"])["files"]["app.js"] == APP_FIXED


def test_a_piece_built_before_the_script_a_case_needs_is_not_blamed_for_that_case(world):
    """A probe case names every file it exercises. On a Make run of a tic-tac-toe each gameplay case named app.js and
    index.html, the board was built before the game logic, and the board's own check blamed it for every such case
    until its repairs ran out. Now a case naming a piece not built yet waits: the page passes while the phase list,
    which needs app.js, waits on it, and once app.js's piece is integrated the same case counts against the page too."""
    w = world
    w.minds.question = False
    w.code.defer = True
    listed = dict(MOON_PROBE["cases"][1], files=["app.js", "index.html"])
    w.minds.probe = {"cases": [MOON_PROBE["cases"][0], listed, MOON_PROBE["cases"][2]]}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    run = w.engine._run(view["plan_id"])
    _tid, mrun = next((t, r) for t, r in w.code.runs.items() if json.loads(r["member"])["piece"] == "page")
    cand = w.space.member_write("page", {"index.html": PAGE})
    out = w.client.portal.call(w.engine.ports.members.run_test, {"member": mrun["member"]}, cand)
    assert out["passed"] is True and out["failing"] == [] and not out["notes"], out
    assert out["waits"] == ["All eight phases are listed waits on app.js"], out
    members = w.engine.ports.members
    members._remember(run, "app", dict(members._members(run).get("app") or {}, integrated=True))
    out = w.client.portal.call(w.engine.ports.members.run_test, {"member": mrun["member"]}, cand)
    assert out["passed"] is False and out["failing"] == ["app.js", "index.html"] and not out["waits"], out


# a later round's probe: the change it asks for (red on the app as it runs) and what the app already does (kept)
ROUND_PROBE = {"cases": [
    {"name": "The heading says tonight", "files": ["index.html"], "steps": [],
     "assertions": [{"kind": "contains", "selector": "h1", "expected": "tonight"}]},
    {"name": "All eight phases are still listed", "files": ["app.js"], "steps": [],
     "assertions": [{"kind": "count", "selector": "#phases li", "expected": 8}]},
]}


def test_a_made_app_is_changed_in_place_by_a_round_and_put_back_by_undo(world):
    """A change asked about an app Create made is a round on the same plan: planned, checked and built from the app as
    it runs now, deployed over the same app, kept as a revision; undo puts the app back to the revision it was built
    from. A round is its own run inside; the person sees one plan id throughout."""
    w = world
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    w.client.post(f"/api/create/plans/{pid}/answers", json={"q": "q-emoji", "text": "No emoji, words only"}, headers=w.jon)
    first = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    app_id = first["installed"]["program_id"]
    assert first["round"] == 1 and [r["round"] for r in first["revisions"]] == [1] and first["revisions"][0]["current"]
    assert next(a for a in first["actions"] if a["name"] == "undo")["available"] is False

    # refusals: no words, someone else, a revision that isn't there
    assert w.client.post(f"/api/create/plans/{pid}/revise", json={"words": " "}, headers=w.jon).status_code == 400
    missing = w.client.post(f"/api/create/plans/{pid}/revert", json={"round": 7}, headers=w.jon)
    assert missing.status_code == 409, missing.text

    w.minds.question = False
    w.events.clear()
    changed = w.client.post(f"/api/create/plans/{pid}/revise", json={"words": "Call the heading Moon phases tonight"},
                            headers=w.jon)
    assert changed.status_code == 200, changed.text
    view = changed.json()
    assert view["plan_id"] == pid and view["round"] == 2 and view["round_words"] == "Call the heading Moon phases tonight"
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"], [c["state"] for c in view["checks"]])
    # the round's check was written for the change, red on the app as it ran, then green on the change
    assert [c["state"] for c in view["checks"]][0] == "fail" and view["checks"][-1]["state"] == "pass"
    assert view["checks"][0]["failing"] == ["index.html"]
    # the planner, the test author and the builders were given the change and the app as it runs now
    planner = [c[2] for c in w.minds.calls if c[0] == "plan"][-1]
    assert planner["change"] == "Call the heading Moon phases tonight" and planner["the_app_now"]["app.js"] == APP_FIXED
    page_build = [c[2] for c in w.minds.calls if c[0] == "build" and c[2]["piece"] == "page"][-1]
    assert page_build["brief"]["change"]["the_app_now"] == {"index.html": PAGE}
    # the round's rule is the planner's contract and each builder's trusted contract, never part of the change's data
    first_plan = [c[2] for c in w.minds.calls if c[0] == "plan"][0]
    assert planner["contract"] == ROUND_CONTRACT and "contract" not in first_plan
    assert "rule" not in planner and "rule" not in page_build["brief"]["change"]
    contracts = {(json.loads(r["member"])["brief"]["sentence"], json.loads(r["member"]).get("contract"))
                 for r in w.code.runs.values()}
    assert contracts == {(SENTENCE, None), ("Call the heading Moon phases tonight", ROUND_CONTRACT)}, contracts
    # while the round runs, the app stays as it was, and the round's events speak as the plan the person sees
    assert view["installed"]["program_id"] == app_id
    assert w.client.post(f"/api/create/plans/{pid}/revise", json={"words": "again"}, headers=w.jon).status_code == 409
    assert {kw["plan_id"] for k, kw in w.events if k.startswith("create.plan.")} == {pid}

    second = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    assert second["phase"] == "deployed" and second["installed"]["program_id"] == app_id     # in place, one app
    assert "tonight" in w.hive.programs.ui_bundle(app_id)["files"]["index.html"]
    assert [(r["round"], r["from"], r["current"]) for r in second["revisions"]] == [(1, None, False), (2, 1, True)]
    # the app keeps its own name through a round titled by its change, and runs exactly its current revision's preview
    assert (second["title"], second["summary"]) == ("Moon phases", "Moon phases")
    assert second["round_title"] == "Tonight's heading"
    assert installed_name(w, app_id) == "Moon phases"
    assert second["installed"]["digest"] == w.engine._current_revision(pid)["preview"]["source_digest"]
    undo = next(a for a in second["actions"] if a["name"] == "undo")
    assert undo["available"] is True and undo["body"] == {"round": 1}
    listed = w.client.get("/api/create/plans", headers=w.jon).json()
    assert [(p["plan_id"], p["title"]) for p in listed] == [(pid, "Moon phases")]   # listed by the app's name too

    back = w.client.post(f"/api/create/plans/{pid}/revert", json=undo["body"], headers=w.jon)
    assert back.status_code == 200, back.text
    back = back.json()
    assert w.hive.programs.ui_bundle(app_id)["files"]["index.html"] == PAGE
    assert [(r["round"], r["current"]) for r in back["revisions"]] == [(1, True), (2, False)]
    assert "tonight" not in back["preview"]["files"]["index.html"] if "files" in (back["preview"] or {}) else True
    # undo installs revision 1's own package again, under the app's name
    assert back["installed"]["digest"] == w.engine._current_revision(pid)["preview"]["source_digest"]
    assert installed_name(w, app_id) == "Moon phases" and back["title"] == "Moon phases"

    # and putting revision 2 back installs its package again
    again = w.client.post(f"/api/create/plans/{pid}/revert", json={"round": 2}, headers=w.jon)
    assert again.status_code == 200, again.text
    again = again.json()
    assert [(r["round"], r["current"]) for r in again["revisions"]] == [(1, False), (2, True)]
    assert "tonight" in w.hive.programs.ui_bundle(app_id)["files"]["index.html"]
    assert again["installed"]["digest"] == w.engine._current_revision(pid)["preview"]["source_digest"]
    assert installed_name(w, app_id) == "Moon phases"


def test_a_builders_contract_is_in_its_trusted_instructions():
    """The plan's rule for a piece (a round's keep-what-the-change-doesn't-touch) reaches its builder before the
    UNTRUSTED_DATA its brief and files are in, where a real run's builder read the brief's own rules out of view."""
    from hive.core.code_controller_member import _packet
    member = {"plan_id": "plan_x", "piece": "page", "paths": ["index.html"], "brief": {"change": {"change": "x"}}}
    head = _packet(None, {"member": json.dumps(dict(member, contract=ROUND_CONTRACT))}, {}, "build", None, "g_1")
    assert ROUND_CONTRACT in head.split("UNTRUSTED_DATA")[0]
    assert ROUND_CONTRACT not in _packet(None, {"member": json.dumps(member)}, {}, "build", None, "g_1")


def installed_name(w, app_id):
    """The name an installed Create app shows: its plugin.json's, under the apps folder AppReleases deploys to."""
    return json.loads((w.engine.ports.apps.root / "apps" / app_id / "plugin.json").read_text())["name"]


def test_two_apps_with_the_same_files_each_get_their_own_release(world):
    """A preview release is addressed by its files and by the app it is, since its plugin.json names the app: two plans
    whose builds come out byte for byte the same each get a release under their own id, so neither previews or reverts
    to the other's."""
    w = world
    w.minds.question = False
    a = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    assert a["phase"] == "ready-to-deploy", (a["phase"], a["last_error"])
    w.minds.pending = {"plan"}          # a second plan, still planning, previews exactly a's files
    b = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    apps = w.engine.ports.apps
    same = apps.preview(w.engine._run(b["plan_id"]), apps.preview_files(a["preview"]["ref"]), None)
    assert same["digest"] == a["preview"]["digest"] and same["ref"] != a["preview"]["ref"]
    for ref, pid in ((a["preview"]["ref"], a["plan_id"]), (same["ref"], b["plan_id"])):
        folder = apps.root / "previews" / ref[len("preview-"):]
        assert json.loads((folder / "plugin.json").read_text())["id"] == "create-" + pid[len("plan_"):]
    w.minds.pending = set()


def test_a_stopped_change_leaves_the_app_as_it_was(world):
    """A change the person stops is no version: the app keeps running the version it ran, the view's preview is that
    version's again, and the plan takes the next change, which is a round of its own."""
    w = world
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    w.client.post(f"/api/create/plans/{pid}/answers", json={"q": "q-emoji", "text": "No emoji, words only"}, headers=w.jon)
    first = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    w.minds.question = False
    w.minds.pending = {"plan"}          # the round's planner is still thinking when the person stops it
    words = "Call the heading Moon phases tonight"
    changed = w.client.post(f"/api/create/plans/{pid}/revise", json={"words": words}, headers=w.jon).json()
    assert changed["round"] == 2 and changed["phase"] == "planning", (changed["phase"], changed["last_error"])
    assert next(a for a in changed["actions"] if a["name"] == "revise")["available"] is False
    stopped = w.client.post(f"/api/create/plans/{pid}/stop", headers=w.jon)
    assert stopped.status_code == 200, stopped.text
    view = w.client.get(f"/api/create/plans/{pid}", headers=w.jon).json()
    assert view["plan_id"] == pid and view["round"] == 2 and view["phase"] == "stopped"
    assert [(r["round"], r["current"]) for r in view["revisions"]] == [(1, True)]
    assert view["preview"] == first["preview"] and view["installed"] == first["installed"]
    assert next(a for a in view["actions"] if a["name"] == "revise")["available"] is True
    w.minds.pending = set()
    again = w.client.post(f"/api/create/plans/{pid}/revise", json={"words": words}, headers=w.jon).json()
    assert again["round"] == 3 and again["phase"] == "ready-to-deploy", (again["phase"], again["last_error"])


BASE_PAGE = ('<!doctype html>\n<html><head><title>Moon</title></head>\n<body>\n<h1>My moon page</h1>\n'
             '<p>Tonight the moon is full.</p>\n</body></html>\n')
BASE_VIEW = '(Screen moon "Moon")\n(Part moon 10 header ((title "Moon") (body "Tonight the moon is full.")))\n'


def test_a_first_build_from_a_saved_creation_starts_from_what_the_person_has(world):
    """A plan started from a saved creation the person may read (plan_for's artifact, which a mind's change offer
    passes) gives the planner that creation as what they have now. An HTML view's page is the page the build starts
    from; a MeTTa view's source goes to the planner as words, and the build starts from the scaffold. A creation the
    person can't read, or one that isn't there, is refused as not found, as an unknown plan is."""
    w = world
    w.minds.question = False
    maker = w.hive.db.one("SELECT * FROM agents WHERE id = ?", (w.maker["id"],))
    page = w.hive.collab.create_artifact(maker, {"kind": "view", "title": "Moon page", "body": BASE_PAGE})
    assert w.engine.plan_for("user:u_jon", page["id"]) == {"artifact_id": page["id"], "revision": 1}
    view = w.client.portal.call(w.engine.start, "user:u_jon", SENTENCE, page["id"])
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    planner = next(c[2] for c in w.minds.calls if c[0] == "plan")
    assert planner["what_they_have_now"] == {"artifact_id": page["id"], "revision": 1, "title": "Moon page",
                                             "kind": "view", "body": BASE_PAGE}
    assert "change" not in planner and "the_app_now" not in planner     # a first build: no app of theirs to keep
    space = w.engine._space(w.engine._run(view["plan_id"]))
    assert w.space.ckpts[space["scaffold"]]["index.html"] == BASE_PAGE
    # the check was red on the page they had, and green once the build made the page the sentence asks for
    assert view["checks"][0]["state"] == "fail" and view["checks"][-1]["state"] == "pass"

    before = len(w.minds.calls)
    drawn = w.hive.collab.create_artifact(maker, {"kind": "view", "title": "Moon", "body": BASE_VIEW})
    view = w.client.portal.call(w.engine.start, "user:u_jon", SENTENCE, drawn["id"])
    assert next(c[2] for c in w.minds.calls[before:] if c[0] == "plan")["what_they_have_now"]["body"] == BASE_VIEW
    space = w.engine._space(w.engine._run(view["plan_id"]))
    assert "seed_files" not in space and w.space.ckpts[space["scaffold"]] == SCAFFOLD

    # one that isn't there, and one in a private team of someone else's, as Ada sees it
    notes = w.client.post("/api/swarms", json={"name": "Jon's notes"}).json()
    w.hive.db.execute("UPDATE swarms SET owner = 'user:u_jon', visibility = 'private' WHERE id = ?", (notes["id"],))
    scribe = w.client.post("/api/agents", json={"name": "Scribe", "swarm_id": notes["id"]}).json()
    private = w.hive.collab.create_artifact(w.hive.db.one("SELECT * FROM agents WHERE id = ?", (scribe["id"],)),
                                            {"kind": "view", "title": "Notes", "body": BASE_PAGE})
    assert w.engine.plan_for("user:u_jon", private["id"]) and w.engine.plan_for("user:u_ada", private["id"]) is None
    for who, ref in (("user:u_ada", private["id"]), ("user:u_jon", "ar_nothing")):
        with pytest.raises(cpe.EngineError) as refused:
            w.client.portal.call(w.engine.start, who, SENTENCE, ref)
        assert (refused.value.status, refused.value.code) == (404, "not_found")


def test_a_plan_begun_from_a_saved_creation_keeps_its_name_through_deploys_rounds_and_reverts(world):
    """A plan begun from a saved creation is that creation changed, so the app keeps the creation's title: the view's
    title and summary and the name it is installed under, through its first deploy, a round and a revert, while
    round_title gives the planner's own title for each change. Named by the planner's title instead, a change offer
    naming such a plan read 'Your mind can change make the board bigger and say whose turn it is above it in Create'
    (a dry run of 19 Nov)."""
    w = world
    w.minds.question = False
    maker = w.hive.db.one("SELECT * FROM agents WHERE id = ?", (w.maker["id"],))
    page = w.hive.collab.create_artifact(maker, {"kind": "view", "title": "Moon page", "body": BASE_PAGE})
    view = w.client.portal.call(w.engine.start, "user:u_jon", SENTENCE, page["id"])
    pid = view["plan_id"]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    assert (view["title"], view["summary"], view["round_title"]) == ("Moon page", "Moon page", "Moon phases")
    first = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    app_id = first["installed"]["program_id"]
    assert first["title"] == "Moon page" and installed_name(w, app_id) == "Moon page"

    changed = w.client.post(f"/api/create/plans/{pid}/revise", json={"words": "Call the heading Moon phases tonight"},
                            headers=w.jon).json()
    assert changed["phase"] == "ready-to-deploy", (changed["phase"], changed["last_error"])
    second = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    assert (second["title"], second["summary"], second["round_title"]) == ("Moon page", "Moon page", "Tonight's heading")
    assert installed_name(w, app_id) == "Moon page"
    listed = w.client.get("/api/create/plans", headers=w.jon).json()
    assert [(p["plan_id"], p["title"]) for p in listed] == [(pid, "Moon page")]   # the made list names it so too

    undo = next(a for a in second["actions"] if a["name"] == "undo")
    back = w.client.post(f"/api/create/plans/{pid}/revert", json=undo["body"], headers=w.jon).json()
    assert back["title"] == "Moon page" and installed_name(w, app_id) == "Moon page"
    # the revert installs revision 1's own release, addressed by the same name it was previewed under
    assert back["installed"]["digest"] == w.engine._current_revision(pid)["preview"]["source_digest"]


def test_a_design_review_fail_goes_back_to_the_studio_piece(world):
    w = world
    w.minds.question = False
    reviews = iter(["fail", "pass"])
    w.minds.review = type("R", (dict,), {"get": lambda self, p, d=None: next(reviews) if p == "style" else "pass"})()
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    j = kinds(view)
    assert "review-fail" in j and j.count("dispatched") >= 8
    pieces = {p["id"]: p for p in view["pieces"]}
    assert pieces["style"]["repairs"] == 1
    # a fix before integration reopens the same member with the review's failing output (member_refix)
    refix = [c for c in w.code.calls if c[0] == "refix"]
    assert [c[1] for c in refix] == ["style"] and refix[0][3].startswith("review")
    assert [c[1] for c in w.code.calls if c[0] == "adopt"].count("style") == 1
    assert w.code.runs[pieces["style"]["member"]]["phase"] == "delivered"


def test_a_working_member_wakes_the_plan_with_member_ready_only(world):
    """A real member answers later: the build effect waits on member:<task>, nothing polls, and the per-change engine's
    code.controller.member_ready event (engine.on_event) brings the candidate in as piece-ready."""
    w = world
    w.minds.question = False
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    for _ in range(10):
        waiting = [e for e in w.engine.view(pid)["effects"] if e["state"] == "waiting"]
        if not w.code.held:
            break
        assert waiting and all(e["goal_id"].startswith("member:") for e in waiting)
        assert w.client.portal.call(w.engine.goal_changed, waiting[0]["goal_id"]) is None    # still working: no change
        tid = next(iter(w.code.held))
        w.client.portal.call(w.engine.on_event, w.code.finish(tid))
    view = w.engine.view(pid)
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    assert "unknown" not in kinds(view)


def test_a_member_that_blocks_wakes_its_plan_which_says_why(world):
    """A member refused three answers and blocked; its plan, woken only by member_ready, stayed building with no error
    and asked nobody. Every member status change wakes it now, and the blocked piece says the builder's last refusal."""
    w = world
    w.minds.question = False
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid, tid = view["plan_id"], next(iter(w.code.held))
    w.code.held.pop(tid)
    w.code.runs[tid].update(phase="blocked", status="needs_you")
    w.code.refusals[tid] = "The last attempt was refused: it wrote summary outside this piece's files."
    w.client.portal.call(w.engine.on_event, {"type": "code.controller.status", "request_id": tid, "status": "needs_you",
                                             "phase": "blocked", "candidate": None})
    view = w.engine.view(pid)
    assert view["phase"] == "blocked" and view["status"] == "needs_you", (view["phase"], view["last_error"])
    assert "it wrote summary" in json.dumps(view)


def test_stop_ends_every_open_member(world):
    w = world
    w.minds.question = False
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert w.code.held
    stopped = w.client.post(f"/api/create/plans/{pid}/stop", headers=w.jon).json()
    assert stopped["phase"] == "stopped"
    opened = set(w.code.runs)
    assert opened and all(w.code.runs[t]["phase"] == "stopped" for t in opened)
    ended = [c for c in w.code.calls if c[0] == "budget-ended"]
    assert len(ended) == len(opened), w.code.calls                               # once each, not again on readback


def test_go_before_ready_is_refused_and_nothing_deploys(world):
    w = world
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    out = w.client.post(f"/api/create/plans/{view['plan_id']}/deploy", headers=w.jon)
    assert out.status_code == 409 and "not-ready-to-deploy" in out.text
    assert not (w.tmp / "create" / "apps").exists() or not any((w.tmp / "create" / "apps").iterdir())


def test_stop_cancels_and_a_pending_mind_call_is_read_back(world):
    w = world
    w.minds.question = False
    w.minds.pending = {"author-tests"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["status"] == "writing_tests" and any(e["state"] == "waiting" for e in view["effects"])
    stopped = w.client.post(f"/api/create/plans/{pid}/stop", headers=w.jon).json()
    assert stopped["phase"] == "stopped" and kinds(stopped)[-2:] == ["cancelled", "reconciled"]
    assert w.minds.held == {}                      # the pending goal was withdrawn
    assert next(a for a in stopped["actions"] if a["name"] == "stop")["available"] is False


def test_a_pending_mind_call_resumes_on_its_goal_event_only(world):
    w = world
    w.minds.question = False
    w.minds.pending = {"plan"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["phase"] == "planning" and kinds(view) == ["plan-started"]
    gid = next(e["goal_id"] for e in view["effects"] if e["kind"] == "plan")
    w.minds.pending = set()
    w.minds.finished.add(gid)
    w.client.portal.call(w.engine.goal_changed, gid)   # the goal.updated handler, in the hive's own loop
    view = w.engine.view(pid)
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])


def test_assignee_unavailable_holds_the_piece_and_asks_the_person(world):
    """R4.1: nobody the selector names can take the piece -> assignee-unavailable (p), never a fallback to someone else;
    the reducer asks the person about that piece; their answer returns it to the queue."""
    w = world
    w.minds.question = False
    binding = w.hive.db.one("SELECT * FROM person_minds WHERE purpose = 'studio_maker'")
    w.hive.db.execute("DELETE FROM person_minds WHERE purpose = 'studio_maker'")
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    # app and style wait on page, the only piece the plan can start
    assert kinds(view).count("assignee-unavailable") == 1 and "piece-started" not in kinds(view)
    assert view["status"] == "asking_you", (view["status"], view["last_error"])
    page = next(p for p in view["pieces"] if p["id"] == "page")
    assert page["state"] == "unassignable" and page["assignee"]["resolved"] is False
    assert page["assignee"]["selector"] == ["capability", "design"]
    asked = [qq for qq in view["questions"] if qq["about"] == {"piece": "page"}]
    assert asked and "Page layout" in asked[0]["text"]
    started = [r for r in view["journal"] if r["kind"] == "piece-started"]
    assert all('"page"' not in r["fields"] and '"style"' not in r["fields"] for r in started)
    # the person makes a Make mind available again and says go: the piece goes back to the queue and the plan finishes
    w.hive.db.insert("person_minds", dict(binding))
    for qq in [qq for qq in view["questions"] if not qq["answered"]]:
        view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": qq["q"], "text": "Go again"}, headers=w.jon).json()
    view = w.engine.view(pid)
    for _ in range(3):
        open_q = [qq for qq in view["questions"] if not qq["answered"]]
        if not open_q:
            break
        view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": open_q[0]["q"], "text": "Go again"},
                             headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])


def test_assignees_are_data_not_code(world):
    """Slice 1 resolves through the general path; an owner can point a capability at a specialist mind (a row, no code),
    and every selector form resolves over what exists."""
    w = world
    r = w.engine.assignees
    person = "user:u_jon"
    assert r.resolve(["capability", "design"], person)["ref"] == w.make["id"]
    assert r.resolve(["team", w.make["id"]], person)["display"] == "Make"
    assert r.resolve(["mind", w.maker["id"]], person)["agent_id"] == w.maker["id"]
    assert r.resolve(["hive", "this", "code"], person)["display"] == "Create · Code"
    assert r.resolve(["hive", "h_other", "code"], person)["detail"] == "federation-not-available"
    assert r.resolve(["open", "no-such-capability"], person)["resolved"] is False
    spec = w.client.post("/api/swarms", json={"name": "Shaders"}).json()
    specialist = w.client.post("/api/agents", json={"name": "Shader mind", "swarm_id": spec["id"]}).json()
    w.hive.db.execute("UPDATE swarms SET visibility = 'public' WHERE id = ?", (spec["id"],))   # offered to the hive
    w.hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = ?", (specialist["id"],))
    r.set_default("capability:design", [{"selector": ["mind", specialist["id"]]}], "a specialist")
    assert r.resolve(["capability", "design"], person)["agent_id"] == specialist["id"]
    assert r.review_rule(["design"], "design-review")["evidence"] == "render"
    assert r.review_rule(["code"], "review")["evidence"] == "none"
    assert r.default_selector("design") == ["capability", "design"] and r.default_selector("audio") == ["open", "audio"]
    src = (ROOT / "hive/core/create_plan_engine.py").read_text()
    assert "Create · Code" not in src and "foundation_review" not in src and "studio_maker" not in src


def test_routes_need_the_person_gate(world):
    w = world
    assert w.client.post("/api/create/plans", json={"sentence": SENTENCE}).status_code == 403   # no Origin
    assert w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=ORIGIN).status_code == 403  # operator
    assert w.client.post("/api/create/plans", json={"sentence": ""}, headers=w.jon).status_code == 400
    w.hive.settings.create_plan_engine = False
    assert w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).status_code == 404


def test_the_render_reads_the_app_interface_however_its_tags_are_written():
    # a fresh install's builder wrote single-quoted tags; the render refused them, and the design review read as
    # "nobody independent can review"
    files = {"index.html": "<head><link rel='stylesheet' href='./style.css'></head><body><p id=x></p>"
                           "<script type='module' src='./app.js'></script></body>",
             "style.css": "p { color: red }", "app.js": "document.getElementById('x').textContent = 'hi'"}
    doc = frame_document(files)
    assert '<style nonce="' in doc and "p { color: red }" in doc and "textContent = 'hi'" in doc
    assert "./style.css" not in doc and "./app.js" not in doc
    # a classic script would run differently inlined as a module, so it is inlined as a classic script instead
    classic = frame_document({**files, "index.html": files["index.html"].replace("type='module' ", "")})
    assert '<script nonce="' in classic and 'type="module"' not in classic and "./app.js" not in classic


def test_check_output_parsing_never_guesses_a_pass():
    assert parse_check_output("", 0)["outcome"] == "unknown"
    assert parse_check_output('CREATE-CHECK {"passed": true, "failing": []}', 1)["outcome"] == "unknown"
    assert parse_check_output('CREATE-CHECK {"passed": false, "failing": []}', 1)["outcome"] == "unknown"
    assert parse_check_output('x\nCREATE-CHECK {"passed": false, "failing": ["a.js"]}', 1)["failing"] == ["a.js"]
    assert parse_check_output('CREATE-CHECK {"passed": true, "failing": []}', 0)["outcome"] == "pass"
    with pytest.raises(ValueError):
        frame_document({"index.html": "<p>no links</p>", "style.css": "", "app.js": ""})


def test_the_authored_check_runs_in_the_hive_sandbox(monkeypatch):
    """Production's runner: the pinned create-acceptance-check bundle under sandbox_run (no network, fresh job folder).
    Red on the scaffold, green on the built page; a check that reaches for the network gets no network."""
    from hive.core import sandbox_run
    from hive.core.create_plan_ports import SandboxChecks
    monkeypatch.setenv("HIVE_SANDBOX_RUN_APPS", "create-acceptance-check")
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"python": {"exe": str(pathlib.Path(sys.executable).absolute()),
                                                                         "reads": sorted({sys.prefix, sys.base_prefix})}}))
    if not sandbox_run.available():
        pytest.skip("no OS sandbox on this host")
    sandbox_run.verify_bundle(str(ROOT / "hive/plugins/create_acceptance_check"), "tools")
    checks = SandboxChecks()
    red = asyncio.run(checks.run({**SCAFFOLD, cpe.CHECK_PATH: CHECK}, cpe.CHECK_PATH))
    assert red["outcome"] == "fail" and set(red["failing"]) == {"index.html", "style.css", "app.js"}, red
    green = asyncio.run(checks.run({**SCAFFOLD, "index.html": PAGE, "style.css": STYLE, "app.js": APP_FIXED,
                                    cpe.CHECK_PATH: CHECK}, cpe.CHECK_PATH))
    assert green["outcome"] == "pass", green
    net = ("import socket, json\ntry:\n    socket.create_connection(('1.1.1.1', 80), 2); ok = True\nexcept OSError:\n    ok = False\n"
           "print('CREATE-CHECK ' + json.dumps({'passed': False, 'failing': ['net' if ok else 'nonet']}))\n")
    out = asyncio.run(checks.run({cpe.CHECK_PATH: net}, cpe.CHECK_PATH))
    assert out["failing"] == ["nonet"], out
    # a build file named like a module the check imports is never imported (review F2): the check still judges
    shadow = 'print("CREATE-CHECK " + %r)\nraise SystemExit(0)\n' % json.dumps({"passed": True, "failing": []})
    out = asyncio.run(checks.run({**SCAFFOLD, "json.py": shadow, "html/__init__.py": shadow, "re.py": shadow,
                                  cpe.CHECK_PATH: CHECK}, cpe.CHECK_PATH))
    assert out["outcome"] == "fail", out


RUNNER = ROOT / "hive/plugins/create_acceptance_check/tools/run.py"
# Two ways a test author reads the app: by the check's own path (dirname(__file__)/..) and by the working directory.
# Each passes on an app whose index.html says it is ready, and names index.html on the scaffold or when it isn't there.
ROOT_CHECK = '''import html, json, os
here = %s
try:
    with open(os.path.join(here, "index.html"), encoding="utf-8") as f:
        ok = html.escape("<h1>Ready</h1>") in html.escape(f.read())
except OSError:
    ok = False
print("CREATE-CHECK " + json.dumps({"passed": ok, "failing": [] if ok else ["index.html"]}))
'''
BY_FILE = ROOT_CHECK % 'os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")'
BY_CWD = ROOT_CHECK % '"."'
READY = {**SCAFFOLD, "index.html": SCAFFOLD["index.html"].replace("<body>", "<body><h1>Ready</h1>")}


def _run_runner(files, check, tmp):
    """The pinned runner as the sandbox starts it (python -I tools/run.py in a fresh job folder), without the OS
    sandbox, so its layout is checked on every host; the sandbox test above checks the boundary."""
    job = pathlib.Path(tempfile.mkdtemp(dir=tmp))
    (job / "snapshot.json").write_text(json.dumps({"files": files, "check": check}))
    proc = subprocess.run([sys.executable, "-I", str(RUNNER)], cwd=job, capture_output=True, text=True, timeout=60)
    return parse_check_output(proc.stdout, proc.returncode, proc.stderr)


@pytest.mark.parametrize("check", [BY_FILE, BY_CWD], ids=["by-file", "by-cwd"])
def test_the_runner_lays_the_check_at_the_apps_root(check, tmp_path):
    """The check sits at its own path among the app's files (build/checks/acceptance_check.py) with the app's root as
    its working directory, so it finds the app either way: on 19 Nov a check reading dirname(__file__)/.. failed every
    candidate with index.html missing, since the runner had put it in a folder beside the app."""
    assert _run_runner({**READY, cpe.CHECK_PATH: check}, cpe.CHECK_PATH, tmp_path)["outcome"] == "pass"
    red = _run_runner({**SCAFFOLD, cpe.CHECK_PATH: check}, cpe.CHECK_PATH, tmp_path)
    assert red["outcome"] == "fail" and red["failing"] == ["index.html"], red
    # nothing in build is importable, its checks/ folder included: a file named like a stdlib module the check imports
    # (html, which the runner itself never imports, so only sys.path decides) never runs in its place
    shadow = 'print("CREATE-CHECK " + %r)\nraise SystemExit(0)\n' % json.dumps({"passed": True, "failing": []})
    shadowed = {**SCAFFOLD, "html.py": shadow, "html/__init__.py": shadow, "checks/html.py": shadow,
                cpe.CHECK_PATH: check}
    out = _run_runner(shadowed, cpe.CHECK_PATH, tmp_path)
    assert out["outcome"] == "fail" and out["failing"] == ["index.html"], out


def test_lost_operations_spend_the_retry_budget_then_ask_the_person(world):
    """R4.2: every lost operation spends one retry (the budget is a data row, fixed into the plan's Ctx); past it the
    plan blocks with (cap-exceeded lost-operations) and asks; the person's answer resumes with a fresh budget."""
    w = world
    w.minds.question = False
    w.engine.set_setting("retries", 2)
    space = w.engine.ports.space
    real_merge, lost = space.merge, {"n": 0}

    async def flaky_merge(run, piece, cand):
        if piece == "page" and lost["n"] < 3:
            lost["n"] += 1
            raise ConnectionError("the merge answer was lost")
        return await real_merge(run, piece, cand)
    space.merge = flaky_merge
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert w.engine._run(pid)["retry_cap"] == 2 and "(Caps 2 2 2)" in w.engine._ctx(w.engine._run(pid))
    assert view["phase"] == "blocked" and view["status"] == "needs_you", (view["phase"], view["status"])
    assert kinds(view).count("unknown") == 3 and lost["n"] == 3
    hold = [qq for qq in view["questions"] if qq["about"] == "blocked" and not qq["answered"]]
    assert hold and "lost" in hold[0]["text"]
    view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": hold[0]["q"], "text": "Try again"},
                         headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])


def test_a_plan_started_under_r4_1_keeps_replaying_under_r4_1(world):
    w = world
    w.minds.question = False
    w.minds.pending = {"plan"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["engine"] == "metta-plan-controller/R4.4"
    w.hive.db.execute("UPDATE create_plan_runs SET reducer_sha256 = ? WHERE plan_id = ?", (cpe.REDUCER_R4_1_SHA256, pid))
    assert "(Caps 2 2)" in w.engine._ctx(w.engine._run(pid))
    gid = next(e["goal_id"] for e in view["effects"] if e["kind"] == "plan")
    w.minds.pending = set()
    w.minds.finished.add(gid)
    w.client.portal.call(w.engine.goal_changed, gid)
    view = w.engine.view(pid)
    assert view["engine"] == "metta-plan-controller/R4.1" and view["phase"] == "ready-to-deploy", view["last_error"]


def test_a_review_that_answers_later_finishes(world):
    """Review F1: every real mind answers later. The reviewer and the render evidence are stored in the effect before the
    call, so the later answer is matched to the reviewer who was asked; nothing loops."""
    w = world
    w.minds.question = False
    w.minds.pending = {"review"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    for _ in range(20):
        waiting = [e for e in w.engine.view(pid)["effects"] if e["state"] == "waiting"]
        if not waiting:
            break
        stored = json.loads(w.hive.db.one("SELECT body FROM create_plan_effects WHERE goal_id = ?", (waiting[0]["goal_id"],))["body"])
        assert stored["reviewer"]["agent_id"] and ("evidence" in stored)
        w.minds.finished.add(waiting[0]["goal_id"])
        w.client.portal.call(w.engine.goal_changed, waiting[0]["goal_id"])
    view = w.engine.view(pid)
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    dispatched_reviews = [r for r in view["journal"] if r["kind"] == "dispatched" and " review " in r["fields"]]
    assert len(dispatched_reviews) == 4 and "unknown" not in kinds(view)        # page, style, app twice (after its fix)


def test_a_plan_waiting_on_a_mind_refused_for_spending_says_which_and_why(world):
    """A test hive with a 1 USD month limit refused its planner's calls for spending, and the plan sat at "planning"
    with no line, no error and no question for 30 minutes. The view names the waiting mind and the hive's words."""
    w = world
    w.minds.question = False
    w.minds.pending = {"plan"}
    pid = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()["plan_id"]
    assert w.engine.view(pid)["waiting"] is None
    effect = next(e for e in w.engine.view(pid)["effects"] if e["state"] == "waiting")
    # the planner's goal as GoalMinds makes it (the fake minds only name it): assigned to the Maker
    w.hive.goals._create_record(w.make["id"], f"Create plan {pid}: plan", "Finish with result data", 0.6,
                                created_by=f"create-plan:{pid}", assignee=w.maker["id"], goal_id=effect["goal_id"])
    mind = w.hive.agent(w.maker["id"])
    said = "Spending faster than this month allows: a call this size fits again in about 999 minutes."
    w.hive.note_refusal(mind, "spend_rate", said)
    assert w.engine.view(pid)["waiting"] == {"mind": mind["id"], "name": mind["name"], "code": "spend_rate", "message": said}
    w.hive.note_admitted(mind)                       # a call of its admitted again: nothing to say
    assert w.engine.view(pid)["waiting"] is None


def test_a_held_builder_whose_calls_keep_failing_stops_at_its_steps_budget(world):
    """A mind holding its step's goal gets its turns back while it holds it, so a builder whose tool calls keep failing
    (on a Make run of a game, every workspace it opened) would spend on until a limit for the whole hive stopped it.
    Each step the plan hands a mind carries its own budget, the larger of what a work session given no budget gets
    (Budgets.task_budget) and a dollar: calls past it are refused, the plan says which mind is held for spending,
    other minds go on, and once the plan withdraws the step the mind's calls are admitted again."""
    from hive.core.hive import HiveError
    w = world
    # a small hive limit: a work session given no budget gets a tenth of the mind's room, and with no automatic mind
    # limits a mind's room is the hive's, so 5 dollars leave it 0.50 and the step gets the dollar floor
    w.hive.budgets.set("hive", "month", 5.0)
    team = w.client.post("/api/swarms", json={"name": "Builders"}).json()
    builder, other = (w.client.post("/api/agents", json={"name": name, "swarm_id": team["id"]}).json()
                      for name in ("Builder", "Other"))
    w.minds.question = False
    w.minds.pending = {"plan"}
    pid = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()["plan_id"]
    effect = next(e for e in w.engine.view(pid)["effects"] if e["state"] == "waiting")
    w.hive.goals._create_record(team["id"], f"Create plan {pid}: plan", "Finish with result data", 0.6,
                                created_by=f"create-plan:{pid}", assignee=builder["id"], goal_id=effect["goal_id"])
    budget = w.hive.goals.give_step_budget(effect["goal_id"], builder["id"])
    assert w.hive.budgets.task_budget(w.hive.agent(builder["id"])) <= 0.5 < budget == 1.0   # at least a dollar a step
    w.hive.record_usage(w.hive.agent(builder["id"]), "x", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.3})
    w.hive.goals.claim(w.hive.agent(builder["id"]), effect["goal_id"])
    row = w.hive.db.one("SELECT budget_usd, spent_at_start FROM goal_budgets WHERE goal_id = ?", (effect["goal_id"],))
    assert (row["budget_usd"], row["spent_at_start"]) == (budget, 0.3)   # counted from the claim, not before it
    assert w.hive.goals.get(effect["goal_id"])["binding"] is None       # not a bound task: its answer echoes nothing
    # real calls reserve up to 1.34 USD worst case and settle near 0.06: the step counts what was spent, not the reserve
    w.hive.check_budget(w.hive.agent(builder["id"]), paid=True, estimate=1.34)
    call, spent = 0.06, 0.0
    with pytest.raises(HiveError) as refused:
        for _ in range(100):                      # each call's tool command fails, and the held mind calls again
            w.hive.check_budget(w.hive.agent(builder["id"]), paid=True, estimate=0.17)
            w.hive.record_usage(w.hive.agent(builder["id"]), "x", {"prompt_tokens": 1, "completion_tokens": 1,
                                                                   "cost_usd": call})
            spent += call
    assert (refused.value.status, refused.value.code) == (402, "spend_limit")
    assert refused.value.details["scope"] == f"task:{effect['goal_id']}"
    assert spent - call < budget <= spent + 1e-9                     # it spent its budget, passing it by one call at most
    assert w.engine.view(pid)["waiting"] == {"mind": builder["id"], "name": "Builder", "code": "spend_limit",
                                             "message": "A spending limit has no room for this call."}
    w.hive.check_budget(w.hive.agent(other["id"]), paid=True, estimate=call)      # the step held its mind, not the hive
    w.client.portal.call(GoalMinds(w.engine).withdraw, {"plan_id": pid}, effect["goal_id"])   # the plan withdrew it
    assert w.hive.goals.get(effect["goal_id"])["status"] == "cancelled"
    w.hive.check_budget(w.hive.agent(builder["id"]), paid=True, estimate=call)    # the step ended: admitted again


def test_each_step_the_plan_hands_a_mind_carries_its_own_budget(world):
    """GoalMinds.call gives the step's goal its own budget (Goals.give_step_budget): the larger of Budgets.task_budget
    and STEP_BUDGET_FLOOR_USD, in goal_budgets rather than the goal's binding, which a bound task's answer would have to
    echo, and started at the claim GoalMinds makes for the step's mind as it hands the step over (Goals._start_budget):
    the mind's stored spend then."""
    w = world
    team = w.client.post("/api/swarms", json={"name": "Reviewers"}).json()
    mind = w.client.post("/api/agents", json={"name": "Reviewer", "swarm_id": team["id"]}).json()
    who = w.engine.assignees.resolve(["mind", mind["id"]], "user:operator")
    out = w.client.portal.call(GoalMinds(w.engine).call, {"plan_id": "pl_budget", "person": "user:operator"}, "review",
                               {"reviewer": who}, {"instruction": "review it"})
    row = w.hive.db.one("SELECT budget_usd, spent_at_start, started_by FROM goal_budgets WHERE goal_id = ?",
                        (out["pending"],))
    budget = max(w.hive.budgets.task_budget(w.hive.agent(mind["id"])), STEP_BUDGET_FLOOR_USD)
    spent = w.hive.db.one("SELECT COALESCE(spent_usd, 0) AS spent FROM agents WHERE id = ?", (mind["id"],))["spent"]
    assert (row["budget_usd"], row["spent_at_start"], row["started_by"]) == (budget, spent, mind["id"])
    assert w.hive.goals.get(out["pending"])["binding"] is None


def test_only_a_step_its_holder_claimed_lists_a_budget(world):
    """The runtime gives a mind back its turns only for a goal whose step_budget_usd the goal list gives
    (hive_helpers.held_goal): a Create step once its mind has claimed it. A person's task and a sub-goal the mind made
    have no budget of their own, so a mind holding one keeps the turns a message or a wake buys, as before."""
    w = world
    team = w.client.post("/api/swarms", json={"name": "Builders"}).json()
    mind = w.client.post("/api/agents", json={"name": "Builder", "swarm_id": team["id"]}).json()
    step = w.hive.goals._create_record(team["id"], "Create plan p1: build board", "Finish with result data", 0.6,
                                       created_by="create-plan:p1", assignee=mind["id"])["id"]
    budget = w.hive.goals.give_step_budget(step, mind["id"])
    task = w.hive.goals._create_record(team["id"], "Sort the inbox", assignee=mind["id"])["id"]   # a person's task
    sub = w.client.post("/api/agent/goals", headers=agent_headers(mind), json={"title": "Read the inbox"}).json()["id"]

    def listed(status):
        goals = w.client.get(f"/api/agent/goals?status={status}", headers=agent_headers(mind)).json()
        return {g["id"]: g["step_budget_usd"] for g in goals}

    assert listed("open")[step] is None                       # given, but no mind has started it
    for goal_id in (step, task, sub):
        w.hive.goals.claim(w.hive.agent(mind["id"]), goal_id)
    assert listed("claimed") == {step: budget, task: None, sub: None}


def test_a_mind_claiming_a_step_after_another_starts_its_budget_from_its_own_spend(world):
    """A step's budget counts from its holder's own claim: the same mind claiming it again after its lease lapsed keeps
    its start, so it cannot begin its budget afresh, and a mind claiming it after the first was deleted starts from
    its own spend, so the first mind's start neither hides that mind's spending nor counts against it."""
    from hive.core.hive import HiveError
    w = world
    w.hive.budgets.set("hive", "month", 50.0)                    # a fresh hive's starting limit
    team = w.client.post("/api/swarms", json={"name": "Builders"}).json()
    first, second = (w.client.post("/api/agents", json={"name": name, "swarm_id": team["id"]}).json()
                     for name in ("First", "Second"))
    step = w.hive.goals._create_record(team["id"], "Create plan p1: build board", "Finish with result data", 0.6,
                                       created_by="create-plan:p1", assignee=first["id"])["id"]
    budget = w.hive.goals.give_step_budget(step, first["id"])
    mind = lambda m: w.hive.agent(m["id"])
    pay = lambda m, usd: w.hive.record_usage(mind(m), "x", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": usd})

    def start():
        row = w.hive.db.one("SELECT spent_at_start, started_by FROM goal_budgets WHERE goal_id = ?", (step,))
        return row["spent_at_start"], row["started_by"]

    pay(first, 0.3)
    w.hive.goals.claim(mind(first), step)
    assert start() == (pytest.approx(0.3), first["id"])
    pay(first, 0.2)
    w.client.portal.call(w.hive.goals.expire, "9999-12-31T00:00:00+00:00")      # its lease lapsed
    assert w.hive.goals.get(step)["status"] == "open"
    w.hive.goals.claim(mind(first), step)
    assert start() == (pytest.approx(0.3), first["id"])                         # the same mind's start stands
    assert w.client.delete(f"/api/agents/{first['id']}").status_code == 200     # its delete releases the step
    assert w.hive.goals.get(step)["claimed_by"] is None
    pay(second, 0.05)
    w.hive.goals.claim(mind(second), step)
    assert start() == (pytest.approx(0.05), second["id"])
    w.hive.check_budget(mind(second), paid=True, estimate=0.17)
    pay(second, budget)
    with pytest.raises(HiveError) as refused:    # counted from its own 0.05: the first mind's 0.3 would admit it
        w.hive.check_budget(mind(second), paid=True, estimate=0.17)
    assert refused.value.details["scope"] == f"task:{step}"


def test_a_stopped_plan_withdraws_the_goals_its_steps_still_wait_on(world):
    """A mind holding a goal keeps its turns until the goal ends, so a plan the person stops withdraws the goal its
    planner (or test author, designer, reviewer) still holds, as it ends its builders; the mind then rests."""
    w = world
    w.minds.question = False
    w.minds.pending = {"plan"}
    pid = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()["plan_id"]
    effect = next(e for e in w.engine.view(pid)["effects"] if e["state"] == "waiting")
    assert effect["goal_id"] in w.minds.held
    assert w.client.post(f"/api/create/plans/{pid}/stop", headers=w.jon).status_code == 200
    assert w.engine.view(pid)["phase"] == "stopped"
    assert effect["goal_id"] not in w.minds.held                     # withdrawn: the mind no longer holds it


def test_a_step_whose_mind_stopped_after_refused_replies_is_tried_again_told_why_then_named(world):
    """A v0.38 Make plan showed "writing tests" for seven minutes while its test author rested after its replies kept
    being cut off, its goal still claimed. The mind's trace now ends that goal with the hive's reason (Goals.stop_held):
    the step is lost and tried again within the plan's retries, the next attempt is told why, and past the retries the
    hold card says which mind stopped and why, beside Try again and Stop."""
    w = world
    w.minds.question = False
    w.minds.pending = {"author-tests"}
    w.minds.collect = GoalMinds(w.engine).collect         # the goal rows below answer, as a real mind's goal does
    w.engine.set_setting("retries", 1)
    pid = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()["plan_id"]
    mind = w.hive.agent(w.maker["id"])
    why = "Its replies kept being refused; the last was a reply cut off at its length limit."
    for attempt in range(2):
        gid = next(e["goal_id"] for e in w.engine.view(pid)["effects"]
                   if e["kind"] == "author-tests" and e["state"] == "waiting")
        w.hive.goals._create_record(w.make["id"], f"Create plan {pid}: test-author", "Finish with result data", 0.6,
                                    created_by=f"create-plan:{pid}", assignee=mind["id"], goal_id=gid)
        w.hive.goals.claim(mind, gid)
        r = w.client.post("/api/agent/trace", headers=agent_headers(w.maker), json={
            "iteration": 3 + attempt, "response": "", "rested": True, "failure_cause": "a reply cut off at its length limit"})
        assert r.status_code == 200, r.text
        assert (w.hive.goals.get(gid)["status"], w.hive.goals.get(gid)["result"]) == ("failed", why)
        w.client.portal.call(w.engine.goal_changed, gid)   # the goal.updated handler, in the hive's own loop
    packets = [p for k, _a, p in w.minds.calls if k == "author-tests"]
    assert len(packets) == 2 and "your_last_attempt_stopped" not in packets[0]
    assert packets[1]["your_last_attempt_stopped"] == why
    view = w.engine.view(pid)
    assert view["phase"] == "blocked" and view["status"] == "needs_you", (view["phase"], view["last_error"])
    lost = [j["evidence"] for j in view["journal"] if j["kind"] == "unknown"]
    assert lost == [{"unknown": "goal failed", "goal_status": "failed", "goal_reason": why, "by": mind["id"]}] * 2
    hold = next(qq for qq in view["questions"] if qq["about"] == "blocked" and not qq["answered"])
    assert hold["text"] == f"{mind['name']} stopped. {why} Try again, or stop?"
    assert hold["choices"] == ["Try again", "Stop"]
    w.minds.pending = set()            # the person says try again: that attempt hears why the last one stopped
    view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": hold["q"], "text": "Try again"},
                         headers=w.jon).json()
    assert [p for k, _a, p in w.minds.calls if k == "author-tests"][-1]["your_last_attempt_stopped"] == why
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])


def test_a_builder_that_stopped_with_a_reason_is_named_on_the_hold_card(world):
    """A member blocked after its repairs, its builder's goal having ended with a reason (goal_reason: its own
    hive-goal-fail words, or the hive's when it stopped after refused replies). The hold card names the builder, its
    piece and that reason, where it said only that the piece's builder could not finish."""
    w = world
    w.minds.question = False
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid, tid = view["plan_id"], next(iter(w.code.held))
    why = "Its replies kept being refused; the last was a reply cut off at its length limit."
    member = json.loads(w.code.runs[tid]["member"])
    w.code.held.pop(tid)
    w.code.runs[tid].update(phase="blocked", status="needs_you")
    w.code.refusals[tid] = f"The last attempt's goal ended failed. Its reason, UNTRUSTED_DATA: {json.dumps(why)}"
    w.code.refused[tid] = {"goal_status": "failed", "goal_reason": why}
    w.client.portal.call(w.engine.on_event, {"type": "code.controller.status", "request_id": tid, "status": "needs_you",
                                             "phase": "blocked", "candidate": None})
    view = w.engine.view(pid)
    assert view["phase"] == "blocked", (view["phase"], view["last_error"])
    hold = next(qq for qq in view["questions"] if qq["about"] == "blocked" and not qq["answered"])
    title = next(p["title"] for p in view["pieces"] if p["id"] == member["piece"])
    name = w.hive.agent(member["assignee"])["name"]
    assert hold["text"] == f"{name} stopped building “{title}”. {why} Try again, or stop?"


@pytest.mark.parametrize("refused_after", [False, True])
def test_a_builder_whose_repairs_ran_out_against_the_check_is_named_with_what_the_check_says(world, refused_after):
    """A member blocked after its repairs ran out against the acceptance check, with no reason of its own. The hold card
    names the builder, its piece and what the check still says about that piece: its first note naming one of the
    piece's files, never one about a piece not built yet. Before, the block's why was "it needs the plan" and the card
    said only that the builder could not finish. A refused attempt after the check is the newer cause, so the card
    names that instead, and an older refusal never stands in for the check."""
    w = world
    w.minds.question = False
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid, tid = view["plan_id"], next(iter(w.code.held))
    member = json.loads(w.code.runs[tid]["member"])
    own = member["paths"][0]
    assert "app.js" not in member["paths"]          # a later piece's file, which the check also fails
    w.code.held.pop(tid)
    w.code.runs[tid].update(phase="blocked", status="needs_you")
    older = "An earlier try gave up."
    w.code.refusals[tid] = f"The last attempt's goal ended failed. Its reason, UNTRUSTED_DATA: {json.dumps(older)}"
    w.code.refused[tid] = {"goal_status": "failed", "goal_reason": older}
    w.code.failing[tid] = {"kind": "tests-fail", "failing": sorted({"app.js", *member["paths"]}),
                           "notes": ["app.js is missing", f"{own} is missing"]}
    if refused_after:
        w.code.failing[tid]["refused"] = w.code.refusals[tid]
    w.client.portal.call(w.engine.on_event, {"type": "code.controller.status", "request_id": tid, "status": "needs_you",
                                             "phase": "blocked", "candidate": None})
    view = w.engine.view(pid)
    assert view["phase"] == "blocked", (view["phase"], view["last_error"])
    hold = next(qq for qq in view["questions"] if qq["about"] == "blocked" and not qq["answered"])
    title = next(p["title"] for p in view["pieces"] if p["id"] == member["piece"])
    name = w.hive.agent(member["assignee"])["name"]
    blocked = next(j["evidence"] for j in view["journal"] if j["kind"] == "piece-blocked")
    if refused_after:
        assert hold["text"] == f"{name} stopped building “{title}”. {older} Try again, or stop?"
        assert "check_failure" not in blocked
    else:
        said = f"Its last version still fails the acceptance check, which says “{own} is missing”."
        assert hold["text"] == f"{name} stopped building “{title}”. {said} Try again, or stop?"
        assert blocked["blocked"] == f"the piece's builder stopped: {said}" and "goal_reason" not in blocked


def test_a_finished_goal_missed_while_the_hive_was_down_is_collected_on_resume(world):
    """Review F4: a waiting effect whose goal finished with no event (a restart) resumes from the goal row."""
    w = world
    w.minds.question = False
    w.minds.pending = {"plan"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["phase"] == "planning"
    w.minds.pending = set()
    w.minds.finish_all()                                   # finished while nobody listened: no goal_changed call
    w.client.portal.call(w.engine.step, pid)               # what watch() does for every open plan at startup
    assert w.engine.view(pid)["phase"] == "ready-to-deploy"


@pytest.mark.parametrize("shape", sorted(STORED_AS))
def test_a_minds_answer_is_collected_from_the_result_the_hive_judged(world, shape):
    """A real mind finishes its plan goal with its own hive-goal-propose or the MCP hive-goal-done, which keep the
    answer under proposal; a direct API call stores it as given. GoalMinds.collect gives the engine the answer's own
    fields at the top in every case, so a planner's plan is never read as no plan."""
    w, gid = world, f"g_collect_{shape}"
    w.hive.goals._create_record(w.make["id"], "Create plan pl_x: plan", "Finish with result data shaped {}", 0.6,
                                created_by="create-plan:pl_x", assignee=w.maker["id"], goal_id=gid)
    agent = w.hive.agent(w.maker["id"])
    w.hive.goals.claim(agent, gid)
    answer = {"plan": {"title": "Moon phases", "pieces": []}}
    w.client.portal.call(w.hive.goals.result, agent, gid, "done", "planned", STORED_AS[shape](answer))
    out = w.client.portal.call(GoalMinds(w.engine).collect, {"plan_id": "pl_x"}, "plan", {}, gid)
    assert out == {"plan": answer["plan"], "by": w.maker["id"]}


def test_a_test_author_that_sends_its_check_as_its_own_command_is_read_with_its_answer(world):
    """The test author's check, sent as its own command (hive-goal-file) so a reply cut off at its length keeps it, is
    read beside an answer that leaves it out, as if its files map held it."""
    w, gid = world, "g_staged_check"
    w.hive.goals._create_record(w.make["id"], "Create plan pl_x: test-author", "Finish with result data", 0.6,
                                created_by="create-plan:pl_x", assignee=w.maker["id"], goal_id=gid)
    agent = w.hive.agent(w.maker["id"])
    w.hive.goals.claim(agent, gid)
    check = 'print("CREATE-CHECK {\\"passed\\": false, \\"failing\\": [\\"app.js\\"], \\"notes\\": []}")\n'
    w.hive.goals.stage_file(agent, gid, cpe.CHECK_PATH, check)
    w.client.portal.call(w.hive.goals.result, agent, gid, "done", "check written",
                         {"binding_digest": None, "proposal": {"notes": "staged"}})
    out = w.client.portal.call(GoalMinds(w.engine).collect, {"plan_id": "pl_x"}, "author-tests", {}, gid)
    assert out == {"notes": "staged", "files": {cpe.CHECK_PATH: check}, "by": w.maker["id"]}


def test_a_builder_cannot_own_or_replace_the_check(world):
    """Review F2: no piece may own the check or a reserved/stdlib-shadowing path (host and R4.3 both refuse); and the
    check that runs is always the base checkpoint's, whatever a candidate holds."""
    w = world
    r = cpe.validate_plan
    base = {"acceptance": ["x"], "pieces": [{"id": "p", "kinds": ["code"], "files": ["app.js"]}]}
    assert r(base)[1] is None
    for files, why in ((["checks/acceptance_check.py"], "piece_owns_the_acceptance_check"),
                       (["checks/helper.py"], "piece_owns_the_acceptance_check"),
                       (["re.py"], "piece_file_shadows_a_stdlib_module"),
                       (["html/__init__.py"], "piece_file_shadows_a_stdlib_module"),
                       (["a%d.js" % i for i in range(21)], "invalid_files")):
        assert r({**base, "pieces": [{"id": "p", "kinds": ["code"], "files": files}]}) == (None, why)
    assert r({**base, "pieces": [{"id": "p", "kinds": ["none"], "files": ["a.js"]}]}) == (None, "invalid_step")
    # a reserved path (a data row) refuses the plan with the reason, never reaching a builder
    w.minds.question = False
    w.engine.set_setting("reserved_paths", json.dumps([cpe.CHECK_PATH, "app.js"]))
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    failed = [r for r in view["journal"] if r["kind"] == "plan-failed"]
    assert failed and failed[0]["evidence"]["invalid"] == "piece_owns_a_reserved_path"
    # the check comes from the base, even when a candidate carries another one
    space = w.engine.ports.space
    run = w.engine._run(view["plan_id"])
    asyncio.run(space.open(run))
    good = asyncio.run(space.write(run, {cpe.CHECK_PATH: CHECK}, "base"))
    cheat = space._ck({**space.ckpts[good], cpe.CHECK_PATH: 'print("CREATE-CHECK " + %r)\n' % json.dumps({"passed": True, "failing": []})})
    out = asyncio.run(w.engine.ports.run_check(run, cheat, cpe.CHECK_PATH, good))
    assert out["outcome"] == "fail", out


def test_a_page_the_app_frame_cant_show_fails_the_check_naming_index_html(world):
    """A built page the app frame can't show (no stylesheet link, or no script for ./app.js) fails the acceptance
    check naming index.html and what it lacks, however the authored check judges it, so the plan routes it to the
    page's builder; at the preview it was refused until the plan blocked. The scaffold holding the check is judged
    as before."""
    import re
    from hive.core.create_plan_ports import page_problem
    w = world
    w.minds.question = False
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    space, run = w.engine.ports.space, w.engine._run(view["plan_id"])
    asyncio.run(space.open(run))
    base = asyncio.run(space.write(run, {cpe.CHECK_PATH: CHECK}, "base"))
    page = {"index.html": PAGE, "style.css": STYLE, "app.js": APP_FIXED}
    check = lambda ck, b=base: asyncio.run(w.engine.ports.run_check(run, ck, cpe.CHECK_PATH, b))   # noqa: E731
    assert check(space._ck({**space.ckpts[base], **page}))["outcome"] == "pass"
    for gone, named in ((r'<link[^>]*>', '<link rel="stylesheet" href="./style.css">'),
                        (r'<script[^>]*></script>', '<script type="module" src="./app.js"></script>')):
        broken = space._ck({**space.ckpts[base], **page, "index.html": re.sub(gone, "", PAGE)})
        out = check(broken)
        assert out["outcome"] == "fail" and "index.html" in out["failing"], out
        assert out["notes"][0].startswith("the app frame can't show this page") and named in out["notes"][0], out
    # a page loading app.js with a plain script tag frames, and one missing only its stylesheet is told only that
    classic = PAGE.replace('<script type="module" src="./app.js"></script>', "<script src='./app.js'></script>")
    framed = check(space._ck({**space.ckpts[base], **page, "index.html": classic}))   # this world's check judges its tags
    assert not any("app frame" in n for n in framed.get("notes") or []), framed
    note = check(space._ck({**space.ckpts[base], **page, "index.html": re.sub(r'<link[^>]*>', "", classic)}))["notes"][0]
    assert 'href="./style.css"' in note and "<script" not in note, note
    # the scaffold the check is written on is judged by the check alone, whatever its page
    bare = asyncio.run(space.write(run, {cpe.CHECK_PATH: CHECK, "index.html": "<p>no tags</p>"}, "base"))
    assert not any("app frame" in n for n in check(bare, bare).get("notes") or [])
    # an app without a page has no page verdict; a page missing a file names it
    assert page_problem({"main.py": "print(1)"}) is None and page_problem(page) is None
    assert page_problem({"index.html": PAGE, "style.css": STYLE}) == "the app frame can't show this page: app.js is missing"


def test_the_planner_is_told_every_rule_the_plan_check_refuses_for():
    # on a fresh install's first real plans the planner, told only the fields' names, broke one rule after another: the
    # shape now carries the check's own table, so the two can't drift
    from hive.core.create_plan_ports import ANSWER_SHAPES
    assert all(rule in ANSWER_SHAPES["plan"] for rule in cpe.PLAN_RULES.values())
    base = {"acceptance": ["x"], "pieces": [{"id": "p", "kinds": ["code"], "files": ["app.js"]}]}
    review = lambda evidence: {**base, "needs": {"reviews": [{"artifact_kind": "code", "review_kind": "security",
                                                               "evidence": evidence}]}}
    # evidence nothing produces would hold the review for ever: refused as the plan is checked
    assert cpe.validate_plan(review("tests")) == (None, "invalid_needs")
    assert all(cpe.validate_plan(review(e))[1] is None for e in cpe.REVIEW_EVIDENCE)


def test_a_refused_plan_tells_the_planner_the_rule_it_broke_and_its_corrected_plan_is_taken(world):
    # a fresh install's first plans: a piece with no files was refused again and again, no reason was given back, and
    # the planner answered the same plan each time; now the next packet names the broken rule, beside the hive's reviews
    w = world
    w.minds.question = False
    real = w.minds._answer

    def first_without_files(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan" and "last_plan_refused" not in packet:
            answer["plan"]["pieces"][0]["files"] = []
        return answer
    w.minds._answer = first_without_files
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    plans = [packet for kind, _, packet in w.minds.calls if kind == "plan"]
    assert len(plans) == 2 and "last_plan_refused" not in plans[0]
    assert plans[1]["last_plan_refused"] == {"code": "invalid_files", "rule": cpe.PLAN_RULES["invalid_files"]}
    assert {(r["artifact_kind"], r["review_kind"], r["evidence"]) for r in plans[0]["hive_reviews"]} == \
        {("code", "review", "none"), ("design", "design-review", "render")}
    assert any(r["kind"] == "planned" for r in view["journal"])   # the corrected plan is the plan


def test_the_planner_is_told_the_kinds_the_hive_staffs(world):
    """On a Mac install nobody offers design (Studio's design maker is off there), and a real plan's "Visual design"
    piece found nobody, so R4.1 asked its person again and again to make one available, which a tester can't. The
    planner is told the kinds this hive staffs, and a plan that keeps to them builds without a designer."""
    w = world
    w.minds.question = False
    assert w.engine.staffed_kinds("user:u_jon") == ["code", "design"]
    w.hive.db.execute("DELETE FROM person_minds WHERE purpose = 'studio_maker'")
    w.hive.db.execute("DELETE FROM swarm_services")
    assert w.engine.staffed_kinds("user:u_jon") == ["code"], w.engine.assignees.resolve(["capability", "design"], "user:u_jon")
    real = w.minds._answer

    def keeps_to_staffed_kinds(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan":
            for piece in answer["plan"]["pieces"]:
                piece["kinds"] = [k for k in piece["kinds"] if k in packet["staffed_kinds"]] or ["code"]
        return answer
    w.minds._answer = keeps_to_staffed_kinds
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    plans = [packet for kind, _, packet in w.minds.calls if kind == "plan"]
    assert plans[0]["staffed_kinds"] == ["code"]
    assert "kinds in staffed_kinds" in cpp.ANSWER_SHAPES["plan"]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])
    assert all(p["assignee"]["resolved"] for p in view["pieces"]) and not view["questions"]


def test_a_design_step_on_a_hive_with_no_design_maker_comes_back_to_the_planner(world):
    """A planner told only code can still keep the look as needs.design: design on code pieces, and that design step
    finds nobody, spends the retry budget and asks the person. The plan check refuses it with the rule, the planner
    answers no-design, and the plan builds without asking anyone."""
    w = world
    w.minds.question = False
    w.hive.db.execute("DELETE FROM person_minds WHERE purpose = 'studio_maker'")
    w.hive.db.execute("DELETE FROM swarm_services")
    real = w.minds._answer

    def a_design_step_first(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan":
            for piece in answer["plan"]["pieces"]:
                piece["kinds"] = [k for k in piece["kinds"] if k in packet["staffed_kinds"]] or ["code"]
            if "last_plan_refused" not in packet:
                answer["plan"]["needs"] = {**answer["plan"]["needs"], "design": "design"}
        return answer
    w.minds._answer = a_design_step_first
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    plans = [packet for kind, _, packet in w.minds.calls if kind == "plan"]
    assert len(plans) == 2
    rule = cpe.PLAN_RULES["design_step_unstaffed"]
    assert plans[1]["last_plan_refused"] == {"code": "design_step_unstaffed", "rule": rule}
    assert rule in cpp.ANSWER_SHAPES["plan"]
    assert not any(r["kind"] == "dispatched" and " design " in r["fields"] for r in view["journal"])
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])
    assert not view["questions"]


def test_a_design_piece_builds_after_the_piece_that_writes_its_page():
    # v0.41's Linux check (20 Nov): a tip calculator's look piece had no deps, was built before the piece writing
    # index.html and app.js, and its design review failed six times on the scaffold's placeholder page
    piece = lambda id, kind, files, deps=(): {"id": id, "kinds": [kind], "deps": list(deps), "files": files}
    look = lambda deps=(): piece("look", "design", ["style.css"], deps)
    calc = lambda deps=(): piece("calc", "code", ["index.html", "app.js"], deps)
    pieces = [look(), calc()]
    assert cpe.page_before_design(pieces) == [] and (pieces[0]["deps"], pieces[1]["deps"]) == (["calc"], [])
    # the page split over two code pieces: the look waits for both, in either order of the list
    split = [look(), piece("markup", "code", ["index.html"]), piece("logic", "code", ["app.js"])]
    assert cpe.page_before_design(split) == [] and split[0]["deps"] == ["markup", "logic"]
    turned = [piece("logic", "code", ["app.js"]), piece("markup", "code", ["index.html"]), look()]
    assert cpe.page_before_design(turned) == [] and turned[2]["deps"] == ["logic", "markup"]
    # a design piece writing index.html is the page, which a code piece filling it follows; a look writing style.css
    # waits for both, and one the plan already puts after them keeps the deps it has
    page, app = piece("page", "design", ["index.html"]), piece("app", "code", ["app.js"], ["page"])
    style = piece("style", "design", ["style.css"])
    assert cpe.page_before_design([page, style, app]) == []
    assert (page["deps"], style["deps"], app["deps"]) == ([], ["page", "app"], ["page"])
    after = [piece("page", "design", ["index.html"]), piece("app", "code", ["app.js"], ["page"]),
             piece("style", "design", ["style.css"], ["app"])]
    assert cpe.page_before_design(after) == [] and [x["deps"] for x in after] == [[], ["page"], ["app"]]
    # a piece writing no page file is no part of what the review renders
    other = [look(), piece("data", "code", ["data.json"])]
    assert cpe.page_before_design(other) == [] and other[0]["deps"] == []
    # a code piece the plan builds after the look keeps that order, since the look's review still sees the page's markup
    kept = [look(), piece("calc", "code", ["index.html"]), piece("logic", "code", ["app.js"], ["look"])]
    assert cpe.page_before_design(kept) == [] and [x["deps"] for x in kept] == [["calc"], [], ["look"]]
    # the index.html writer waiting on the look, directly or through another piece, is an order no dependency fixes,
    # and the plan is left as it came
    assert cpe.page_before_design([look(), calc(["look"])]) == ["look"]
    chain = [look(), piece("via", "code", ["data.js"], ["look"]), calc(["via"])]
    assert cpe.page_before_design(chain) == ["look"] and [x["deps"] for x in chain] == [[], ["look"], ["via"]]


def test_a_change_round_gives_every_ui_file_a_piece_that_may_write_it():
    # v0.41's Mac check (20 Nov): a change round's one piece wrote index.html alone, app.js stayed read-only, and the
    # change's probe, one active button, could never pass
    piece = lambda id, kind, files: {"id": id, "kinds": [kind], "deps": [], "files": list(files)}
    one = [piece("quick20", "code", ["index.html"])]
    cpe.own_the_app(one)
    assert one[0]["files"] == ["index.html", "style.css", "app.js"]
    # style.css to the design piece; app.js to the code piece already writing the page, not one writing no UI file
    three = [piece("data", "code", ["data.json"]), piece("look", "design", ["banner.svg"]), piece("calc", "code", ["index.html"])]
    cpe.own_the_app(three)
    assert [x["files"] for x in three] == [["data.json"], ["banner.svg", "style.css"], ["index.html", "app.js"]]
    # a plan that already gives every UI file a piece is left as it came
    whole = [piece("page", "design", ["index.html", "style.css"]), piece("app", "code", ["app.js"])]
    cpe.own_the_app(whole)
    assert [x["files"] for x in whole] == [["index.html", "style.css"], ["app.js"]]
    # a piece at its file limit passes the file on to the next one placed for it
    full = [piece("big", "code", ["index.html", *(f"part{i}.js" for i in range(cpe.MAX_FILES_PER_PIECE - 1))]),
            piece("small", "code", ["helper.js"])]
    cpe.own_the_app(full)
    assert len(full[0]["files"]) == cpe.MAX_FILES_PER_PIECE and full[1]["files"] == ["helper.js", "style.css", "app.js"]
    # a code piece writing app.js after a look writing style.css: index.html goes to the look, the piece with no deps,
    # since on the code piece it would make page_before_design refuse a plan it accepts
    ordered = [piece("look", "design", ["style.css"]), {**piece("code", "code", ["app.js"]), "deps": ["look"]}]
    cpe.own_the_app(ordered)
    assert [x["files"] for x in ordered] == [["style.css", "index.html"], ["app.js"]]
    assert cpe.page_before_design(ordered) == []


def test_the_change_round_file_rule_keeps_every_plan_the_design_order_accepts():
    # a probe of 20 Nov: over every change-round plan of up to three pieces, each piece's kind, one or two
    # of the UI files and data.json, and deps on earlier pieces, own_the_app then page_before_design refuses none that
    # page_before_design accepts alone, and every UI file then has a piece that may write it
    import copy
    import itertools
    from hive.core.create_plan_ports import UI_FILES
    filesets = [list(c) for r in (1, 2) for c in itertools.combinations((*UI_FILES, "data.json"), r)]

    def plans(n):
        for kinds, files in itertools.product(itertools.product(("design", "code"), repeat=n),
                                              itertools.product(filesets, repeat=n)):
            flat = [f for fs in files for f in fs]
            if len(flat) != len(set(flat)):
                continue
            for bits in itertools.product((0, 1), repeat=n * (n - 1) // 2):
                it = iter(bits)
                yield [{"id": f"p{i}", "kinds": [kinds[i]], "files": list(files[i]),
                        "deps": [f"p{j}" for j in range(i) if next(it)]} for i in range(n)]
    accepted = 0
    for n in (1, 2, 3):
        for plan in plans(n):
            if cpe.page_before_design(copy.deepcopy(plan)):
                continue
            accepted += 1
            owned = copy.deepcopy(plan)
            cpe.own_the_app(owned)
            assert set(UI_FILES) <= {f for x in owned for f in x["files"]}, plan
            assert cpe.page_before_design(owned) == [], plan
    assert accepted > 3000      # the probe's 3,299, so the space was walked whole


def test_a_change_round_planned_into_index_html_alone_may_still_change_app_js(world):
    # the round's planner gives its one piece index.html only; the planned graph lets that piece write the app's other
    # UI files too, and the round still reaches ready-to-deploy
    w = world
    w.minds.question = False
    real = w.minds._answer

    def one_piece_change(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan" and packet.get("change"):
            page = next(x for x in answer["plan"]["pieces"] if x["id"] == "page")
            answer["plan"]["pieces"] = [{**page, "kinds": ["code"], "files": ["index.html"], "deps": []}]
        return answer
    w.minds._answer = one_piece_change
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon)
    changed = w.client.post(f"/api/create/plans/{pid}/revise", json={"words": "Call the heading Moon phases tonight"},
                            headers=w.jon).json()
    planned = [r for r in changed["journal"] if r["kind"] == "planned"][-1]
    assert [(x["id"], x["files"]) for x in planned["evidence"]["plan"]["pieces"]] == [("page", ["index.html", "style.css", "app.js"])]
    assert changed["phase"] == "ready-to-deploy", (changed["phase"], changed["status"], changed["last_error"])


def test_a_plan_whose_page_waits_on_its_look_comes_back_to_the_planner_as_its_rule(world):
    # the planned graph builds the page before any design piece that styles it: a plan ordering the page after its
    # look is refused with the rule, and the corrected plan's look is made to wait on the page
    w = world
    w.minds.question = False
    real = w.minds._answer

    def first_with_the_page_after_its_look(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan" and "last_plan_refused" not in packet:
            next(x for x in answer["plan"]["pieces"] if x["id"] == "page")["deps"] = ["style"]
        return answer
    w.minds._answer = first_with_the_page_after_its_look
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    plans = [packet for kind, _, packet in w.minds.calls if kind == "plan"]
    assert len(plans) == 2
    rule = cpe.PLAN_RULES["design_piece_before_its_page"]
    assert plans[1]["last_plan_refused"] == {"code": "design_piece_before_its_page", "rule": rule}
    assert rule in cpp.ANSWER_SHAPES["plan"]
    planned = next(r for r in view["journal"] if r["kind"] == "planned")
    assert {x["id"]: x["deps"] for x in planned["evidence"]["plan"]["pieces"]} == {"page": [], "style": ["page", "app"],
                                                                                    "app": ["page"]}
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])


# the planner can never cause these: the host writes the Plan atom as revision 1 with no parent, and reports planned
# only for the open plan
HOST_INTERNAL_PLAN_CODES = {"stale_revision", "not-the-open-plan"}


def _plan_refusal_codes():
    """Every code a plan can be refused with, read from the rules themselves: validate_plan's returns and the engine's
    own refusal of a translated plan (its source), and the reducer's on-planned, graph-fault and unknowns-fault."""
    import ast
    import re
    source = pathlib.Path(cpe.__file__).read_text()
    codes = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.FunctionDef) and node.name == "validate_plan":
            codes |= {r.value.elts[1].value for r in ast.walk(node) if isinstance(r, ast.Return)
                      and isinstance(r.value, ast.Tuple) and isinstance(r.value.elts[-1], ast.Constant)
                      and isinstance(r.value.elts[-1].value, str)}
        if isinstance(node, ast.Dict):
            codes |= {v.value for k, v in zip(node.keys, node.values)
                      if isinstance(k, ast.Constant) and k.value == "invalid" and isinstance(v, ast.Constant)}
    reducer = (pathlib.Path(cpe.__file__).resolve().parents[2] / "modules/create/controller/"
               "create_plan_controller_r4_4.metta").read_text()

    def body(name):                                   # its forms without their comments, which name other things
        start = reducer.index(f"(= ({name} ")
        end = reducer.find("\n(= (", start + 1)
        return re.sub(r";[^\n]*", "", reducer[start:end])
    codes |= set(re.findall(r"\(rej \$st ([A-Za-z_][\w-]*)\)", body("on-planned")))
    for name in ("graph-fault", "unknowns-fault"):   # codes are the symbols with an underscore; functions are hyphenated
        codes |= set(re.findall(r"(?<![\w(?$-])([a-z]+(?:_[a-z]+)+)(?![\w?-])", body(name)))
    return codes


def test_every_code_a_plan_is_refused_with_has_its_rule_in_the_planners_words():
    # read from the rules themselves, so a rule the host or the reducer adds can't go unsaid: on fresh installs the
    # reducer refused a plan four times as design-pieces-carry-the-design, a rule the planner was never told
    from hive.core.create_plan_ports import ANSWER_SHAPES
    codes = _plan_refusal_codes()
    assert {"design-pieces-carry-the-design", "no-review-for-artifact-kind", "file_owned_twice", "dependency_cycle",
            "invalid_files", "piece_owns_a_reserved_path", "invalid_unknowns"} <= codes   # the reading finds them
    unsaid = {c for c in codes - HOST_INTERNAL_PLAN_CODES if cpe.plan_rule(c) == c}
    assert unsaid == set()
    assert all(cpe.plan_rule(c) in ANSWER_SHAPES["plan"] for c in codes - HOST_INTERNAL_PLAN_CODES)


def test_a_plan_the_reducer_refuses_comes_back_to_the_planner_as_its_rule(world):
    # fresh installs: the planner asked for a design step beside design pieces, and given only the reducer's code it
    # sent the same plan four times; the next packet now says the rule, and the corrected plan is taken
    w = world
    w.minds.question = False
    real = w.minds._answer

    def first_with_a_design_step(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan" and "last_plan_refused" not in packet:
            answer["plan"]["needs"] = {**answer["plan"]["needs"], "design": "design"}
        return answer
    w.minds._answer = first_with_a_design_step
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    plans = [packet for kind, _, packet in w.minds.calls if kind == "plan"]
    assert len(plans) == 2
    assert plans[1]["last_plan_refused"] == {"code": "design-pieces-carry-the-design",
                                             "rule": cpe.PLAN_RULES["design-pieces-carry-the-design"]}
    assert any(r["kind"] == "planned" for r in view["journal"])


def test_a_detect_plan_on_a_scaffold_with_no_check_comes_back_as_its_rule(world):
    # a fresh install's scaffold has no acceptance check: a plan that chose to detect one asked the scaffold for it
    # four times and stopped on lost steps; the planner is told what the scaffold holds, and such a plan is refused
    w = world
    w.minds.question = False
    real = w.minds._answer

    def first_detecting(kind, body, packet, agent):
        answer = real(kind, body, packet, agent)
        if kind == "plan" and "last_plan_refused" not in packet:
            answer["plan"]["needs"] = {**answer["plan"]["needs"], "tests": "detect"}
        return answer
    w.minds._answer = first_detecting
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    plans = [packet for kind, _, packet in w.minds.calls if kind == "plan"]
    assert len(plans) == 2 and plans[0]["scaffold_has_acceptance_check"] is False
    assert plans[1]["last_plan_refused"] == {"code": "detect_without_a_check",
                                             "rule": cpe.PLAN_RULES["detect_without_a_check"]}
    assert any(r["kind"] == "planned" for r in view["journal"])


def test_an_untranslatable_model_result_goes_to_a_readback_not_an_exception(world):
    w = world
    w.minds.question = False
    checks, real = w.engine.ports.checks, w.engine.ports.checks.run
    calls = {"n": 0}

    async def odd(files, suite):
        calls["n"] += 1
        if calls["n"] == 2:
            return {"outcome": "fail", "failing": ["not a path!"]}
        return await real(files, suite)
    checks.run = odd
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    assert "unknown" in kinds(view) and "reconciled" in kinds(view)
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])


def test_the_resolver_never_picks_someone_elses_private_mind(world):
    """Review F3: candidates are filtered by what the plan's person may see as a member; another person's private
    Make mind (or one offering the capability) is never chosen, and a mind selector naming it is unavailable."""
    w = world
    from hive.core.db import now
    w.hive.db.execute("DELETE FROM person_minds WHERE purpose = 'studio_maker'")
    eve_make = w.client.post("/api/swarms", json={"name": "Eve's Make"}).json()
    eve_maker = w.client.post("/api/agents", json={"name": "Eve's maker", "swarm_id": eve_make["id"]}).json()
    w.hive.db.execute("UPDATE swarms SET owner = 'user:u_eve', visibility = 'private' WHERE id = ?", (eve_make["id"],))
    w.hive.db.execute("UPDATE agents SET owner = 'user:u_eve', visibility = 'private' WHERE id = ?", (eve_maker["id"],))
    w.hive.db.execute("INSERT INTO person_minds (principal, purpose, agent_id, swarm_id, created_at, updated_at) VALUES "
                      "('user:u_eve', 'studio_maker', ?, ?, ?, ?)", (eve_maker["id"], eve_make["id"], now(), now()))
    w.hive.db.execute("INSERT OR REPLACE INTO swarm_services (swarm_id, kinds, set_by, updated_at) VALUES (?, ?, ?, ?)",
                      (eve_make["id"], json.dumps(["design"]), "user:u_eve", now()))
    r = w.engine.assignees
    assert r.resolve(["capability", "design"], "user:u_jon")["resolved"] is False
    assert r.resolve(["open", "design"], "user:u_jon")["resolved"] is False
    assert r.resolve(["mind", eve_maker["id"]], "user:u_jon")["resolved"] is False
    assert r.resolve(["team", eve_make["id"]], "user:u_jon")["resolved"] is False
    assert r.resolve(["capability", "design"], "user:u_eve")["agent_id"] == eve_maker["id"]


ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#ddd"/></svg>\n'


def test_the_preview_serves_every_file_the_pieces_built(world):
    """A piece's extra asset (icon.svg) is in the preview bundle: listed with its content type and digest, served one by
    one after its lock digest checks (sandboxed headers), inlined by frame_document as a data: URI, and deployed."""
    import base64
    import hashlib
    w = world
    w.minds.question = False
    page = PAGE.replace("<h1>", '<link rel="icon" href="./icon.svg"><h1><img src="./icon.svg" alt="">', 1)
    w.minds.extra = {"page": {"icon.svg": ICON, "index.html": page}}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    pv = w.client.get(f"/api/create/plans/{pid}/preview", headers=w.jon).json()
    assert set(pv["files"]) == {"index.html", "style.css", "app.js", "icon.svg", "README.md"}
    assert not any(k.startswith("checks/") for k in pv["files"])                     # the check never ships
    assert pv["files"]["icon.svg"] == ICON and pv["types"]["icon.svg"] == "image/svg+xml"
    assert pv["digests"]["icon.svg"] == "sha256:" + hashlib.sha256(ICON.encode()).hexdigest()
    one = w.client.get(f"/api/create/plans/{pid}/preview/file", params={"path": "icon.svg"}, headers=w.jon)
    assert one.status_code == 200 and one.content == ICON.encode()
    assert one.headers["content-type"].startswith("image/svg+xml") and one.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in one.headers["content-security-policy"]
    css = w.client.get(f"/api/create/plans/{pid}/preview/file", params={"path": "style.css"}, headers=w.jon)
    assert css.headers["content-type"].startswith("text/css")
    for bad in ("../icon.svg", "checks/acceptance_check.py", "ui/bundle.lock.json", "bundle.lock.json", "nope.svg"):
        assert w.client.get(f"/api/create/plans/{pid}/preview/file", params={"path": bad}, headers=w.jon).status_code == 404
    eve_less = {"Origin": ORIGIN["Origin"]}
    assert w.client.get(f"/api/create/plans/{pid}/preview/file", params={"path": "icon.svg"},
                        headers=eve_less).status_code in (401, 403, 404)
    # the frame document inlines the asset the only way its CSP admits (img-src data:)
    doc = frame_document(pv["files"])
    uri = "data:image/svg+xml;base64," + base64.b64encode(ICON.encode()).decode()
    assert doc.count(uri) == 2 and "./icon.svg" not in doc
    # a file changed on disk after the preview was pinned is refused, never served
    folder = w.tmp / "create" / "previews" / pv["ref"][len("preview-"):] / "ui"
    (folder / "icon.svg").write_text(ICON.replace("#ddd", "#f00"))
    assert w.client.get(f"/api/create/plans/{pid}/preview/file", params={"path": "icon.svg"},
                        headers=w.jon).status_code == 409
    (folder / "icon.svg").write_text(ICON)
    deployed = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon).json()
    assert deployed["phase"] == "deployed", deployed["last_error"]
    app = w.tmp / "create" / "apps" / deployed["installed"]["program_id"] / "ui"
    assert (app / "icon.svg").read_text() == ICON
    # the plan's checkpoints hold its check, but the installed app is the app alone: no checks/ folder, none locked
    assert cpe.CHECK_PATH in w.client.get(f"/api/create/plans/{pid}/files", headers=w.jon).json()["files"]
    assert not (app / "checks").exists() and not (app.parent / "checks").exists()
    assert not any(p.startswith("checks/") for p in json.loads((app / "bundle.lock.json").read_text())["files"])
    # the installed app serves its assets too (lock "assets"), for appDocument to inline as it does in the preview
    ui = w.hive.programs.ui_bundle(deployed["installed"]["program_id"])["files"]
    assert ui["icon.svg"] == ICON and ui == pv["files"]
    assert "./icon.svg" not in frame_document(ui)


def test_the_bundle_refuses_unsafe_paths():
    from hive.core.create_plan_ports import bundle_files, content_type
    ok = {"index.html": "x", "img/icon.svg": "y", "checks/acceptance_check.py": "z"}
    assert set(bundle_files(ok)) == {"index.html", "img/icon.svg"}
    for bad in ("../x.svg", "/abs.svg", ".hidden", "a/../b.svg", "bundle.lock.json", "a\\b.svg", "a b.svg"):
        with pytest.raises(ValueError):
            bundle_files({"index.html": "x", bad: "y"})
    assert content_type("icon.svg") == "image/svg+xml" and content_type("a.woff2").startswith("text/plain")


def test_the_per_change_reducer_survives_a_temp_sweep():
    """The member reducer's scratch folder removed under a running hive (a temp sweep: seen live between two plans) is
    made again from the pinned bytes it verified, as the plan reducer's is."""
    import shutil
    from hive.core.code_controller_engine import Reducer
    r = Reducer(os.environ["PETTA_PATH"])
    try:
        assert asyncio.run(r.run("(+ 1 2)")) == 3
        shutil.rmtree(r.dir)
        assert asyncio.run(r.run("(+ 1 2)")) == 3 and (r.dir / r.name).read_bytes() == r.raw
    finally:
        r.close()



@pytest.mark.parametrize("planted", [{"json.py": "raise SystemExit(0)\n"},
                                     {cpe.CHECK_PATH: 'print("CREATE-CHECK {\\"passed\\": true, \\"failing\\": []}")\n'},
                                     {"style.css": "body { display: none }\n"}])
def test_a_candidate_that_changes_anything_outside_its_piece_is_refused(world, planted):
    """Review fix 1: a member candidate is checked, not trusted. Anything else holding a relay grant for the task could
    write onto a piece's fork (a stdlib-shadowing json.py, the check, another piece's file): the candidate is refused
    before it is snapshotted, tested or merged; the piece blocks and the plan asks the person."""
    w = world
    w.minds.question = False
    w.code.plant = {"page": planted}
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    page_tid = next(t for t, r in w.code.runs.items() if json.loads(r["member"])["piece"] == "page")
    w.client.portal.call(w.engine.on_event, w.code.finish(page_tid))
    view = w.engine.view(pid)
    assert "piece-blocked" in kinds(view), kinds(view)
    blocked = [r for r in view["journal"] if r["kind"] == "piece-blocked"]
    why = w.hive.db.one("SELECT result FROM create_plan_effects WHERE plan_id = ? AND kind = 'build' AND "
                        "json_extract(body, '$.piece') = 'page'", (pid,))["result"]
    assert blocked and "outside its piece" in why and next(iter(planted)) in why, why
    assert not w.space.adopted                                        # never snapshotted
    assert next(iter(planted)) not in w.space.ckpts[w.space.integration] or \
        w.space.ckpts[w.space.integration][next(iter(planted))] != planted[next(iter(planted))]   # never merged
    # while the plan rests on the person, no member keeps working (its helper goal is ended)
    assert view["phase"] == "blocked" and view["status"] == "needs_you", (view["phase"], view["status"])
    assert w.code.runs and all(r["phase"] == "stopped" for r in w.code.runs.values()), w.code.runs
    assert any(c[0] == "budget-ended" and c[1] == "page" and "blocked" in c[2] for c in w.code.calls), w.code.calls


def test_candidate_scope_names_every_change_outside_the_allowed_files():
    from hive.core.create_plan_ports import ScopeError, candidate_scope
    origin = {"index.html": "a", "style.css": "b", "checks/acceptance_check.py": "c"}
    candidate_scope(origin, {**origin, "index.html": "A", "icon.svg": "i"}, {"index.html", "icon.svg"})
    for cand, outside in (({**origin, "json.py": "x"}, ["json.py"]),
                          ({k: v for k, v in origin.items() if k != "style.css"}, ["style.css"]),     # a deletion
                          ({**origin, "checks/acceptance_check.py": "C"}, ["checks/acceptance_check.py"])):
        with pytest.raises(ScopeError) as got:
            candidate_scope(origin, cand, {"index.html", "checks/acceptance_check.py"})
        assert got.value.paths == outside


def test_a_member_delivery_lost_to_a_crash_is_made_again_from_the_journal(world):
    """Review fix 2: the hive went down after the plan journalled `integrated` but before the member heard. The next
    build for that piece (the check's route-fix) delivers it first, so the fix is a NEW member on a fresh fork, never a
    refix of a member whose fork was merged and dropped."""
    w = world
    w.minds.question = False
    w.code.fail_delivery = {"app"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    assert not [c for c in w.code.calls if c[0] == "refix"]
    assert [c[1] for c in w.code.calls if c[0] == "adopt"] == ["page", "app", "style", "app"]
    assert [c[1] for c in w.code.calls if c[0] == "integrated"] == ["page", "app", "style", "app"]
    assert all(r["phase"] == "delivered" for r in w.code.runs.values())


def test_a_lost_delivery_with_no_later_build_is_made_on_the_next_step(world):
    w = world
    w.minds.question = False
    w.code.fail_delivery = {"page"}
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    page = next(p for p in view["pieces"] if p["id"] == "page")
    assert w.code.runs[page["member"]]["phase"] == "delivered"          # settled after the step that lost it
    w.client.portal.call(w.engine.step, pid)                            # and a resume changes nothing more
    assert [c[1] for c in w.code.calls if c[0] == "integrated"].count("page") == 1


def test_the_brief_stays_under_the_member_limit_and_says_what_was_cut(world):
    from hive.core.create_plan_members import BRIEF_ANSWERS, _bounded
    assert _bounded(["short"], 100) == ["short"]
    cut = _bounded(["x" * 500], 100)
    assert cut["truncated"] is True and len(cut["text"]) == 100 and cut["chars"] > 500
    w = world
    w.minds.question = False
    many = [{"q": f"q-{i}", "text": "words " * 660} for i in range(6)]     # six long answers (each under 4000)
    w.engine.answers = lambda pid: many
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])
    briefs = [json.loads(r["member"])["brief"] for r in w.code.runs.values()]
    assert briefs and all(b["answers"]["truncated"] is True and len(b["answers"]["text"]) == BRIEF_ANSWERS for b in briefs)
    assert all(b["title"] and not isinstance(b["title"], dict) for b in briefs)             # short fields untouched


def test_the_members_own_test_refuses_an_out_of_scope_candidate(world):
    """run_test checks scope before it tests: an out-of-piece change is a definite refusal (the member's `refused`),
    never a pass or a fail it would try to repair."""
    w = world
    w.minds.question = False
    w.code.defer = True
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    run = w.engine._run(view["plan_id"])
    tid, mrun = next((t, r) for t, r in w.code.runs.items() if json.loads(r["member"])["piece"] == "page")
    good = w.space.member_write("page", {"index.html": PAGE})
    out = w.client.portal.call(w.engine.ports.members.run_test, {"member": json.dumps(
        dict(json.loads(mrun["member"]), paths=["index.html"]))}, good)
    assert out.get("passed") is True and "refused" not in out, out
    bad = w.space.member_write("page", {"json.py": "x = 1\n"})
    out = w.client.portal.call(w.engine.ports.members.run_test, {"member": json.dumps(
        dict(json.loads(mrun["member"]), paths=["index.html"]))}, bad)
    assert "json.py" in out["refused"] and "passed" not in out
    assert run["plan_id"]


def test_stop_on_a_hold_card_stops_the_plan(world):
    """Jon 11-09: pressing Stop on "Try again, or stop?" went straight back to planning. The reducer reads any answer to
    a blocked hold as "go on", so Stop must take the stop path."""
    w = world
    w.minds.question = False
    w.engine.set_setting("retries", 2)
    space = w.engine.ports.space
    real_merge = space.merge

    async def lost_merge(run, piece, cand):
        raise ConnectionError("the merge answer was lost")
    space.merge = lost_merge
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    hold = [qq for qq in view["questions"] if qq["about"] == "blocked" and not qq["answered"]]
    assert hold, view["phase"]
    space.merge = real_merge
    view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": hold[0]["q"], "text": "Stop"},
                         headers=w.jon).json()
    assert view["phase"] in ("cancelled", "stopped"), (view["phase"], view["status"])
    assert "cancelled" in kinds(view)


def test_hold_wording_never_shows_the_reducers_code():
    from hive.core.create_plan_engine import _blocked_text
    text = _blocked_text(["cap-exceeded", "plan-failed"])
    assert "plan-failed" not in text and "planning" in text
    assert "(" not in _blocked_text("something-internal")
    assert "broken" not in _blocked_text("broken-check-on-build") and "built app" in _blocked_text("broken-check-on-build")


def test_a_plan_proposed_through_the_goal_record_is_read_as_the_plan():
    """Jon 11-09: hive-goal-propose stores {"proposal": <json>, "binding_digest": ...}; the port read the wrapper as the
    plan, so four good plans failed as plan_not_an_object."""
    import asyncio
    import json as _json
    from hive.core.create_plan_ports import GoalMinds
    plan = {"plan": {"title": "Monkey site", "pieces": [{"id": "site", "kinds": ["code"], "title": "Site", "brief": "b",
                                                         "deps": [], "files": []}], "acceptance": ["it works"]}}
    row = {"id": "g_x", "status": "done", "assignee": "a_p", "claimed_by": "a_p",
           "result_data": _json.dumps({"binding_digest": None, "proposal": plan})}

    class DB:
        def one(self, sql, args):
            return row
    ports = GoalMinds.__new__(GoalMinds)
    ports.hive = type("H", (), {"db": DB()})()
    out = asyncio.run(ports.collect({"plan_id": "p"}, "plan", {}, "g_x"))
    assert out["plan"]["title"] == "Monkey site" and out["by"] == "a_p"


@pytest.mark.parametrize("status", ["failed", "cancelled", "stalled"])
def test_a_mind_call_whose_goal_gets_no_answer_ends_at_once(status):
    """A goal the hive stalled (its claims lapsed with no result) gets no answer, as a failed or cancelled one: the plan's
    wait ends there, its plan failing and any other call read back as unknown, never waiting on an update. The answer
    keeps how the goal ended (goal_ended: its status, and a failed goal's reason) and the mind that held it."""
    import asyncio
    from hive.core.create_plan_ports import GoalMinds

    class DB:
        def one(self, sql, args):
            return {"id": "g_x", "status": status, "assignee": "a_p", "claimed_by": "a_p", "result_data": None,
                    "result": "The page asks for a server the hive can't run."}
    ports = GoalMinds.__new__(GoalMinds)
    ports.hive = type("H", (), {"db": DB()})()
    ended = {"goal_status": status, "by": "a_p"}
    if status == "failed":
        ended["goal_reason"] = "The page asks for a server the hive can't run."
    assert asyncio.run(ports.collect({"plan_id": "p"}, "plan", {}, "g_x")) == {"failed": "goal ended", **ended}
    assert asyncio.run(ports.collect({"plan_id": "p"}, "review", {}, "g_x")) == {"unknown": f"goal {status}", **ended}


# ---- a broken authored check goes back to its author (R4.4) -------------------------------------------------------

UNITTEST_CHECK = """import unittest


class Acceptance(unittest.TestCase):
    def test_heading(self):
        self.assertIn("Moon", open("index.html").read())


unittest.main()
"""
SILENT_CHECK = "print('checked the page')\n"


def test_check_output_names_why_there_is_no_verdict():
    crashed = parse_check_output("", 1, "Traceback (most recent call last):\nAssertionError: no Moon\n")
    assert crashed["outcome"] == "unknown" and crashed["reason"] == "crashed" and "AssertionError" in crashed["stderr"]
    assert parse_check_output("checked\n", 0)["reason"] == "no-verdict"
    assert parse_check_output("", 0)["reason"] == "no-verdict"
    assert parse_check_output('CREATE-CHECK {"passed": true', 0)["reason"] == "no-verdict"
    assert parse_check_output('CREATE-CHECK {"passed": true, "failing": []}', 1)["reason"] == "no-verdict"
    assert parse_check_output('CREATE-CHECK [1]', 0)["reason"] == "no-verdict"
    assert parse_check_output("", -9)["reason"] == "timeout"
    assert parse_check_output("", None)["reason"] == "sandbox"
    assert parse_check_output("", 78)["reason"] == "sandbox"
    long = parse_check_output("", 1, "\n".join(f"line {i}" for i in range(100)))
    assert long["stderr"].splitlines() == [f"line {i}" for i in range(80, 100)]
    for out in (crashed, long):
        assert out["outcome"] != "pass"


def test_the_sandbox_runner_classifies_what_it_could_not_judge(monkeypatch):
    from hive.core import sandbox_run
    from hive.core.create_plan_ports import SandboxChecks
    results = iter([TimeoutError("sandbox work deadline exceeded"), RuntimeError("sandbox unavailable"),
                    {"exit": 1, "stdout": b"", "stderr": b"Traceback\nNameError: name 'x' is not defined\n"},
                    {"exit": 0, "stdout": b"ok\n", "stderr": b""}])

    async def fake_run(*a, **k):
        r = next(results)
        if isinstance(r, Exception):
            raise r
        return r
    monkeypatch.setattr(sandbox_run, "run", fake_run)
    got = [asyncio.run(SandboxChecks().run({cpe.CHECK_PATH: "x"}, cpe.CHECK_PATH)) for _ in range(4)]
    assert [g["reason"] for g in got] == ["timeout", "sandbox", "crashed", "no-verdict"]
    assert all(g["outcome"] == "unknown" for g in got) and "NameError" in got[2]["stderr"]


def test_a_broken_check_goes_back_to_its_author_and_the_plan_recovers_without_asking(world):
    """Jon 11-09: a unittest check that never prints CREATE-CHECK was re-run until the retry cap, then "Several steps
    were lost". R4.4: the broken check returns to the test author with its error tail; the fixed check is red on the
    scaffold and the build goes on, nobody asked."""
    w = world
    w.minds.question = False
    w.minds.authored = [UNITTEST_CHECK]
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])
    assert kinds(view).count("check-broken") == 1 and "unknown" not in kinds(view)
    assert kinds(view).count("tests-authored") == 2
    assert not [qq for qq in view["questions"] if qq["about"] == "blocked"]
    briefs = [pk for k, _a, pk in w.minds.calls if k == "author-tests"]
    assert len(briefs) == 2 and "previous_attempt" not in briefs[0]
    prev = briefs[1]["previous_attempt"]
    assert prev["reason"] == "crashed" and prev["exit_code"] != 0 and "FAILED" in prev["stderr"], prev
    assert prev["check"] == UNITTEST_CHECK
    # asked for a probe first; told the Python check's verdict rules on the repair, since it wrote Python
    assert "Write checks/probe.json" in briefs[0]["contract"] and "CREATE-CHECK" not in briefs[0]["contract"]
    assert "LAST line it prints to stdout must be exactly: CREATE-CHECK" in briefs[1]["contract"]
    assert "unittest" in briefs[1]["contract"]
    # the check sits among the files it judges, so a walk that skipped nothing would read its own source
    assert "skip checks/, where this check itself sits, when you walk the app's files" in briefs[1]["contract"]
    broken = next(c for c in view["checks"] if c["state"] == "unknown")
    assert broken["reason"] == "crashed"


# the 18 Nov Windows shape: a finding printed, then an exit before the verdict, on the scaffold that has the finding
EARLY_EXIT_CHECK = ("import sys\n"
                    "page = open('index.html').read().lower()\n"
                    "if 'moon' not in page:\n"
                    "    print('FAIL: index.html has no moon heading')\n"
                    "    sys.exit(1)\n"
                    "print('CREATE-CHECK {\"passed\": true, \"failing\": [], \"notes\": []}')\n")


def test_a_check_that_stops_before_its_verdict_is_told_so_and_the_plan_recovers(world):
    """A test build's author wrote four checks that printed "FAIL: missing file index.html" and exited 1 before their
    CREATE-CHECK line, so each read crashed and the plan asked whether to try again. The contract says a finding is no
    reason to stop, and the repair brief names that exact fault."""
    w = world
    w.minds.question = False
    w.minds.authored = [EARLY_EXIT_CHECK]
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    view = w.engine.view(view["plan_id"])
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])
    briefs = [pk for k, _a, pk in w.minds.calls if k == "author-tests"]
    assert len(briefs) == 2 and "never stop early" in briefs[1]["contract"]   # the Python rules, on its repair
    prev = briefs[1]["previous_attempt"]
    assert (prev["reason"], prev["why"]) == ("crashed", "no CREATE-CHECK line") and "FAIL: index.html has no moon" in prev["output"]
    assert "It printed its findings and stopped (exit 1) before its CREATE-CHECK line" in briefs[1]["contract"]
    assert "stopped (exit" not in briefs[0]["contract"]


# two checks test authors wrote in our Make runs of a v0.39.1 test build (19 Nov), each with a bug of its own that it
# caught into a finding, so its verdict failed app files on every tree and the builders of those files blocked; here
# with that catch-all removed, as the contract now asks
CRASH_CHECKS = {"format_crash.py": "unsupported format character", "type_crash.py": "must be real number, not str"}


@pytest.mark.parametrize("name", sorted(CRASH_CHECKS))
def test_a_check_whose_own_code_fails_goes_back_to_its_author(world, name):
    """The contract tells failures from errors as unittest does: a check whose own code raises gives no verdict on
    the scaffold, so it comes back to its author with the error before any builder starts, and the plan builds on the
    author's next check."""
    w = world
    w.minds.question = False
    w.minds.authored = [(ROOT / "hive/tests/fixtures/create_checks" / name).read_text()]
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    view = w.engine.view(view["plan_id"])
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["status"], view["last_error"])
    briefs = [pk for k, _a, pk in w.minds.calls if k == "author-tests"]
    # asked for a probe first; the author wrote Python, so its repair carries the Python check's rules
    assert len(briefs) == 2 and "Write checks/probe.json" in briefs[0]["contract"]
    assert all(words in briefs[1]["contract"] for words in (
        "Tell failures from errors", "never stop early", "let it raise, and the hive sends the check back to you"))
    prev = briefs[1]["previous_attempt"]
    said = (prev.get("stderr") or "") + (prev.get("output") or "")
    assert prev["reason"] == "crashed" and CRASH_CHECKS[name] in said, prev
    broken = [r for r in view["journal"] if r["kind"] == "check-broken"]
    started = [r for r in view["journal"] if r["kind"] == "piece-started"]
    assert broken and started and broken[0]["seq"] < started[0]["seq"]


def test_a_permanently_broken_author_spends_the_budget_then_asks_in_plain_words(world):
    w = world
    w.minds.question = False
    w.minds.always = SILENT_CHECK
    w.engine.set_setting("retries", 2)
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    assert view["phase"] == "blocked" and view["status"] == "needs_you", (view["phase"], view["last_error"])
    assert kinds(view).count("check-broken") == 3 and "unknown" not in kinds(view)
    assert [k for k, _a, _p in w.minds.calls].count("author-tests") == 3
    hold = [qq for qq in view["questions"] if qq["about"] == "blocked" and not qq["answered"]]
    assert hold and hold[0]["text"] == "The acceptance check I wrote keeps failing to run. Try again, or stop?"
    assert hold[0]["choices"] == ["Try again", "Stop"]
    assert [pk for k, _a, pk in w.minds.calls if k == "author-tests"][-1]["previous_attempt"]["reason"] == "no-verdict"
    w.minds.always = None                       # the person says try again; this time the author writes a good check
    view = w.client.post(f"/api/create/plans/{pid}/answers", json={"q": hold[0]["q"], "text": "Try again"},
                         headers=w.jon).json()
    assert view["phase"] == "ready-to-deploy", (view["phase"], view["last_error"])


def test_a_plan_under_r4_3_keeps_check_unknown_for_a_broken_check(world):
    w = world
    w.minds.question = False
    w.minds.pending = {"plan"}
    w.minds.always = SILENT_CHECK
    w.engine.set_setting("retries", 1)
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    w.hive.db.execute("UPDATE create_plan_runs SET reducer_sha256 = ? WHERE plan_id = ?", (cpe.REDUCER_R4_3_SHA256, pid))
    gid = next(e["goal_id"] for e in view["effects"] if e["kind"] == "plan")
    w.minds.pending = set()
    w.minds.finished.add(gid)
    w.client.portal.call(w.engine.goal_changed, gid)
    view = w.engine.view(pid)
    assert view["engine"] == "metta-plan-controller/R4.3" and "check-broken" not in kinds(view)
    assert "check-unknown" in kinds(view) and view["phase"] == "blocked", (view["phase"], view["last_error"])


def test_later_steps_get_each_answer_with_its_question_and_what_omega_is(world):
    """Jon 11-09: the test author never saw that "No, I mean OmegaHives" answered "What do you mean by omegas?" (only
    the q id travelled), refused three times and spent the plan's retries. Every later step now gets the question with
    the answer, said plainly, and the hive's own self-description."""
    w = world
    view = w.client.post("/api/create/plans", json={"sentence": SENTENCE}, headers=w.jon).json()
    pid = view["plan_id"]
    q = next(qq for qq in view["questions"] if not qq["answered"])
    w.client.post(f"/api/create/plans/{pid}/answers", json={"q": q["q"], "text": "Yes please"}, headers=w.jon)
    later = [p for k, _, p in w.minds.calls if k != "plan"]
    assert later, [k for k, _, _ in w.minds.calls]
    pkt = later[0]
    assert pkt["answers"][0]["question"] == q["text"] and pkt["answers"][0]["text"] == "Yes please"
    assert any(q["text"] in line and "Yes please" in line for line in pkt["the_person_already_answered"])
    assert "OmegaHive" in pkt["what_omega_is"]

# frame_document's output for a module page as v0.39 rc7 framed it, which the classic-script rule must not change
MODULE_FRAME_RC7 = '<!doctype html><html data-app-host-origin="https://hive.invalid" data-app-channel="render"><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-00000000-0000-0000-0000-000000000000\'; style-src \'nonce-00000000-0000-0000-0000-000000000000\'; style-src-attr \'unsafe-inline\'; connect-src \'none\'; img-src data: blob:; font-src data:; base-uri \'none\'; form-action \'none\'"><!doctype html>\n<html lang="en">\n<head>\n  <style nonce="00000000-0000-0000-0000-000000000000">main{color:red}</style>\n</head>\n<body>\n  <main id="app"></main>\n  <script type="module" nonce="00000000-0000-0000-0000-000000000000">document.getElementById("app").textContent="hi"</script>\n</body>\n</html>\n'


def test_the_frame_runs_a_classic_app_script_where_a_browser_would():
    """A page builder on the published v0.39 rewrote the scaffold's module tag as <script src='./app.js'>, which a
    browser runs and the preview refused ("Unexpected app interface format"), so the plan blocked. The frame takes a
    classic script as one, nonce'd where the browser would run it: in place, in head, or at the end of body when it is
    deferred. A module page frames byte for byte as before, and a page that loads ./app.js neither way is refused."""
    files = {"style.css": "main{color:red}", "app.js": 'document.getElementById("app").textContent="hi"'}
    page = ('<!doctype html>\n<html lang="en">\n<head>\n  <link rel="stylesheet" href="./style.css">\n</head>\n<body>\n'
            '  <main id="app"></main>\n  <script type="module" src="./app.js"></script>\n</body>\n</html>\n')
    assert frame_document({**files, "index.html": page}) == MODULE_FRAME_RC7
    tag = '<script nonce="00000000-0000-0000-0000-000000000000">'
    end = frame_document({**files, "index.html": page.replace('<script type="module" src="./app.js">', "<script src='./app.js'>")})
    assert tag in end and 'type="module"' not in end and end.index(tag) > end.index("<main")
    module_line = '  <script type="module" src="./app.js"></script>\n'
    head_page = page.replace("</head>", "  <script src='./app.js'></script>\n</head>").replace(module_line, "")
    head = frame_document({**files, "index.html": head_page})
    assert head.index(tag) < head.index("</head>")
    deferred = frame_document({**files, "index.html": head_page.replace("<script src", "<script defer src")})
    assert deferred.index("<main") < deferred.index(tag) < deferred.index("</body>")
    with pytest.raises(ValueError):
        frame_document({**files, "index.html": page.replace(module_line, "")})


def test_a_page_builder_is_told_to_keep_the_frame_tags():
    """The builder that writes index.html is told, in its own trusted instructions, to keep the stylesheet link and the
    module script the frame loads; a builder of other files is not."""
    from hive.core.code_controller_member import _packet
    page = {"member": json.dumps({"plan_id": "plan_x", "piece": "page", "paths": ["index.html", "style.css"]})}
    head = _packet(None, page, {}, "build", None, "g_1").split("UNTRUSTED_DATA")[0]
    assert '<script type="module" src="./app.js"></script>' in head and 'href="./style.css"' in head
    logic = {"member": json.dumps({"plan_id": "plan_x", "piece": "logic", "paths": ["app.js"]})}
    assert 'type="module"' not in _packet(None, logic, {}, "build", None, "g_1").split("UNTRUSTED_DATA")[0]


def _activations(w, app_id):
    return {r["swarm"]: r["active"] for r in w.hive.db.all("SELECT swarm, active FROM app_activations WHERE program = ?",
                                                             (app_id,))}


def test_a_deploy_settled_by_read_back_turns_the_app_on(world, monkeypatch):
    # a deploy that answered "unknown" settles through deploy_readback; found deployed, the app goes where Create is,
    # as a definite deploy's would, or it sits installed but on in no swarm (QA #405 N1)
    import asyncio
    w = world
    ports = w.engine.ports
    monkeypatch.setattr(ports.apps, "readback", lambda run, body, plan: {"deployed": True, "program_id": "app_rb"})
    run = {"person": "user:u_jon", "plan_id": "plan_rb"}
    out = asyncio.run(ports.deploy_readback(run, {}, {}))
    assert out["deployed"] is True
    assert _activations(w, "app_rb") == {w.make["id"]: 1}
    # not found deployed: nothing is turned on
    monkeypatch.setattr(ports.apps, "readback", lambda run, body, plan: {"deployed": None, "app_id": "app_nr"})
    asyncio.run(ports.deploy_readback(run, {}, {}))
    assert _activations(w, "app_nr") == {}


def test_a_redeploy_keeps_an_admins_off(world):
    # the first deploy turns the app on where Create is; an admin turns it off there; a redeploy leaves it off and
    # publishes no activation for it (QA #405 N3)
    w = world
    apps = w.engine.ports.apps
    assert apps.turn_on("user:u_jon", "app_rd") == [w.make["id"]]
    w.hive.db.execute("UPDATE app_activations SET active = 0 WHERE program = ? AND swarm = ?", ("app_rd", w.make["id"]))
    w.events.clear()
    assert apps.turn_on("user:u_jon", "app_rd") == []
    assert _activations(w, "app_rd") == {w.make["id"]: 0}
    assert not [kw for k, kw in w.events if k == "program.activation" and kw.get("program") == "app_rd"]
