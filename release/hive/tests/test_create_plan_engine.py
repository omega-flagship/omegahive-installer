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
from hive.core.create_plan_members import PerChangeBuilds
from hive.core.create_plan_ports import AppReleases, Ports, frame_document, parse_check_output
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

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
    build/ (the working directory), the check in judge/, python -I so neither is importable. Production: SandboxChecks."""

    async def run(self, files, suite):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as d:
            build, judge = pathlib.Path(d, "build"), pathlib.Path(d, "judge")
            build.mkdir(); judge.mkdir()
            for path, content in files.items():
                if path == suite:
                    continue
                f = build / path
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(content)
            (judge / "acceptance_check.py").write_text(files[suite])
            proc = subprocess.run([sys.executable, "-I", str(judge / "acceptance_check.py")], cwd=build,
                                  capture_output=True, text=True, timeout=30)
        return parse_check_output(proc.stdout, proc.returncode)


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

    def _run(self, task_id):
        return self.runs.get(task_id)

    def adopt_member(self, plan_id, piece, origin, paths, assignee, budget_ref, review_policy, person,
                     controller_id=None, task=None, brief=None):
        import hashlib
        assert review_policy == "plan-reviewed" and origin["workspace_id"] == f"ws_{piece}"
        tid = "mt_" + hashlib.sha256(f"{plan_id}|{piece}|{task}".encode()).hexdigest()[:32]
        assert len(json.dumps(brief, sort_keys=True, separators=(",", ":"), ensure_ascii=False)) <= 40000
        self.calls.append(("adopt", piece, task, assignee))
        if tid not in self.runs:
            self.runs[tid] = {"request_id": tid, "profile": "plan-member", "phase": "claimed", "status": "accepted",
                              "next_action": None, "candidate": None, "last_error": None, "member": json.dumps(
                                  {"plan_id": plan_id, "piece": piece, "paths": sorted(paths), "assignee": assignee,
                                   "brief": brief})}
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
                "title": "Moon phases", "pieces": [
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
            return {"by": agent, "files": {cpe.CHECK_PATH: CHECK}}
        if kind == "build":
            p = body["piece"]
            if p == "page":
                page = self.extra.get("page", {}).get("index.html", PAGE)
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


@pytest.mark.parametrize("version,tests,count", [("R4.3", "test_create_plan_controller_r4_3.metta", 277),
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
    assert all(c[2]["answers"] == [{"q": "q-emoji", "text": "No emoji, words only"}] for c in w.minds.calls[1:])

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
    assert [c[1] for c in adopts] == ["page", "style", "app", "app"] and adopts[-1][2].startswith("fix-for-")
    assert adopts[2][3] == adopts[3][3] == code_ctl
    assert fix_call[0][2]["brief"]["title"] == "Fill the list" and fix_call[0][2]["brief"]["failing"]["failing"] == ["app.js"]
    assert [c[1] for c in w.code.calls if c[0] == "integrated"] == ["page", "style", "app", "app"]
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
    # typed events across the run
    seen = {k for k, _ in w.events}
    assert {"create.plan.status", "create.plan.piece", "create.plan.question", "create.plan.preview"} <= seen
    statuses = [kw["status"] for k, kw in w.events if k == "create.plan.status" and kw["plan_id"] == pid]
    assert statuses[0] == "planning" and statuses[-1] == "deployed"
    # a second go is refused by the reducer (terminal), and no second deploy runs
    again = w.client.post(f"/api/create/plans/{pid}/deploy", headers=w.jon)
    assert again.status_code == 409


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
    assert kinds(view).count("assignee-unavailable") == 2 and "piece-started" not in kinds(view)  # app waits on page
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
    assert view["engine"] == "metta-plan-controller/R4.3"
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
    assert [c[1] for c in w.code.calls if c[0] == "adopt"] == ["page", "style", "app", "app"]
    assert [c[1] for c in w.code.calls if c[0] == "integrated"] == ["page", "style", "app", "app"]
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
