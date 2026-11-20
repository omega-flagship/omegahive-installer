# Purpose: the effect ports the Create plan engine acts through: the minds it asks as goals and reads answers from, the
# members, the build space, the checks and the releases.
"""Create plans: the effect ports the plan engine (create_plan_engine.py) performs its actions through.

The engine decides nothing here; it calls one port per journalled effect. Ports compose four parts, each replaceable:
  minds   model calls (planner, test author, reviewer, designer) as hive goals assigned to the RESOLVED
          mind, with a typed packet in its messages; the finished goal's result data is the answer (wake: goal.updated).
          Same delivery as the per-change engine's second opinion (goals._create_record + send_to_agent).
          A step's own rules (its packet's contract) go in the goal's detail and the message's head, outside the
          packet's UNTRUSTED_DATA, so hive-goal-get shows them in whichever turn writes the answer.
  members each piece's build: one real R3.14 per-change member per piece (create_plan_members.PerChangeBuilds).
  space   the hive-owned build workspace: one integration workspace from the Create scaffold repository, one fork per
          piece, checkpoints, and cross-fork merges, all through the hive's OmegaCode relay (OmegaCodeSpace).
  checks  the authored acceptance check, run on a checkpoint's files inside the hive sandbox (sandbox_run, the pinned
          host bundle hive/plugins/create_acceptance_check): no network, a fresh job folder, CPU and size limits.
  apps    preview = a pinned program UI bundle (index.html, style.css, app.js, every other file the pieces built such
          as an icon.svg, + ui/bundle.lock.json, the format programs.ui_bundle verifies) the canvas shows in its opaque appFrame; deploy = the same release installed as
          a hive app under the Create apps folder and loaded with programs.reload_one.

The check contract (what the test author writes and the runner reads). An app with a page is checked by playing it:
the author writes checks/probe.json, cases of steps and assertions (PROBE_SHAPE; probe_problem says what one may hold),
which tools/probe.mjs plays on the candidate's page as the frame composes it (frame_document), one fresh headless
window a case, in the sandbox on the node runtime. A repository's own Python check, checks/acceptance_check.py, Python
stdlib only, still runs at that path among the checkpoint's files, with their root as its working directory, so a
relative path or dirname(__file__)/.. reaches the app, and a walk over the app's files skips checks/, where the
check itself sits (it would find the text it looks for in its own source). Either way the LAST stdout line is
    CREATE-CHECK {"passed": true|false, "failing": ["<owned file>", ...], "notes": ["...", ...]}
`failing` names the files whose content made it fail (so the reducer routes the fix to their owners).
Any other result is unknown (never a pass), with a reason class: crashed (non-zero exit, no CREATE-CHECK line; the
error tail is kept), no-verdict (it ran but gave no readable verdict), timeout, or sandbox (the runner could not run it).
The host only classifies; the reducer (R4.4) decides: a crashed / no-verdict check goes back to its author, and so does
a probe the runner can't play (a bad selector or pattern), which it reports as no verdict, never as the app failing.

PLAN_VIEW_FIELDS (GET /api/create/plans/{id}; Surface's provisional contract 2026-11-08):
  plan_id, engine, reducer_sha256, sentence, title, summary, acceptance[], phase, status, review_policy, unreviewed,
  next_action, last_error,
  pieces[{id, title, kind, team (display), assignee {selector, kind, ref, resolved, display, detail}, deps, files, state,
          status, builder, editing, draft, candidate, summary (the builder's own words about that candidate) | null,
          repairs, unreviewed, review {kind, state, decision, reviewer, notes, evidence, candidate} | null, tests}],
  questions[{q, about, text, choices, answered, answer}], checks[{run, ckpt, base, state, reason, failing, line, output}],
  checkpoint {ckpt, workspace}, preview {ref, ckpt, digest, files} | null, installed {program_id, digest} | null,
  actions[{name, label, method, path, body, available, why_not}], journal[], effects[], updated_at.
Events: create.plan.status {plan_id, phase, status, next_action}; create.plan.piece {plan_id, piece, state, candidate,
  repairs}; create.plan.question {plan_id, q, about, text, choices, answered}; create.plan.preview {plan_id, ckpt, preview}.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import logging
import os
import pathlib
import re
import shutil

from .create_plan_engine import PLAN_RULES, TERMINAL, goal_creator
from .db import new_id, now
from .goals import UNANSWERED, stored_proposal
from .ui_parts import ascii_lower, frame_script, frame_tags

log = logging.getLogger(__name__)

CHECK_PATH = "checks/acceptance_check.py"
PROBE_PATH = "checks/probe.json"
CHECK_LINE = re.compile(r"^CREATE-CHECK (\{.*\})\s*$")
UI_FILES = ("index.html", "style.css", "app.js")
# The preview bundle: every file of the verified checkpoint except the check (checks/). Paths are plain relative names
# (no dot-files, no "..", no lock name); text only (OmegaCode files are text); bounded like programs.ui_bundle.
BUNDLE_PATH = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,7}")
BUNDLE_MAX_FILES, BUNDLE_FILE_MAX, BUNDLE_MAX = 64, 600_000, 4_000_000
CONTENT_TYPES = {"html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
                 "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
                 "json": "application/json", "svg": "image/svg+xml", "txt": "text/plain; charset=utf-8",
                 "md": "text/markdown; charset=utf-8", "csv": "text/csv; charset=utf-8", "xml": "application/xml",
                 "webmanifest": "application/manifest+json"}
PLUGIN_DIR = pathlib.Path(__file__).resolve().parents[1] / "plugins" / "create_acceptance_check"
CHECK_PROGRAM = "create-acceptance-check"
APP_ID = re.compile(r"create-[0-9a-f]{32}")


# ---- the probe: a check that plays the app (tools/probe.mjs plays it) ----------------------------------------------

# The steps and assertions a probe may hold, IterBrow's probe.json grammar (click and fill; text, value, count and
# visible) with the kinds Playwright's actions and web-first assertions add, and each assertion's expected type. The
# runner's limits (MAX_CASES and the rest in probe.mjs) are these.
PROBE_STEPS = {"click": (), "fill": ("value",), "select": ("value",), "press": (), "check": (), "uncheck": (),
               "wait": ()}
PROBE_EXPECTS = {"text": str, "contains": str, "matches": str, "value": str, "count": int, "visible": bool,
                 "checked": bool, "enabled": bool}
PROBE_CASES, PROBE_STEPS_MAX, PROBE_ASSERTIONS, PROBE_WAIT_MS = 30, 60, 40, 3000
PROBE_SHAPE = ('{"cases": [{"name": "the acceptance criterion it checks", "files": [the owned files it exercises], '
               '"steps": [{"kind": "click"|"fill"|"select"|"press"|"check"|"uncheck"|"wait", "selector": a CSS '
               'selector, "value": the text to fill, the option to select (its value or its text) or the key to press '
               '(Enter if left out); a wait takes a selector to wait for, or "ms" up to 3000}], '
               '"assertions": [{"kind": "text" (its whole text, whitespace collapsed)|"contains"|"matches" (a '
               'JavaScript regular expression)|"value" (a field\'s value)|"count" (how many elements match)|'
               '"visible"|"checked"|"enabled" (true or false), "selector": a CSS selector, "expected": ...}]}]}')


# What an author who wrote a Python check (checks/acceptance_check.py, the earlier contract, still taken) is told on its
# repair, so the check it fixes gives a verdict: the rules every Python check's verdict line follows.
PYTHON_CHECK_RULES = ("A Python check is Python stdlib only, run with the build's files as the working directory, so "
                      "skip checks/, where this check itself sits, when you walk the app's files. The "
                      "LAST line it prints to stdout must be exactly: CREATE-CHECK {\"passed\": bool, \"failing\": "
                      "[owned files], \"notes\": [..]}; when passed is false, failing names at least one file a piece "
                      "owns. Without that line the check has no verdict. A unittest file does not print it by itself: "
                      "run the tests programmatically (for example unittest.TextTestRunner(stream=sys.stderr).run(suite)), "
                      "then print the CREATE-CHECK line from its failures, or raise if it has errors. Tell failures from "
                      "errors as unittest's TestResult does. A criterion the app misses is a failure: its file goes in "
                      "failing. A missing file is a failure too, so never stop early on one: keep checking and print the "
                      "CREATE-CHECK line last, before any exit. Any other exception in the check's own code is an error: "
                      "don't catch it, let it raise, and the hive sends the check back to you.")


def probe_problem(probe):
    """None when `probe` is one tools/probe.mjs can play; else what is wrong with it, in words for its author.
    Time: one pass over its cases, steps and assertions."""
    if not isinstance(probe, dict) or not isinstance(probe.get("cases"), list):
        return 'a probe is {"cases": [...]}'
    cases = probe["cases"]
    if not 1 <= len(cases) <= PROBE_CASES:
        return f"a probe has 1-{PROBE_CASES} cases, one for each acceptance criterion"
    for n, case in enumerate(cases, 1):
        where = f"case {n}"
        if not isinstance(case, dict) or not isinstance(case.get("name"), str) or not 1 <= len(case["name"]) <= 200:
            return f"{where} needs a name of 1-200 characters"
        where = f"case {n} ({case['name'][:60]})"
        files = case.get("files", [])
        if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
            return f"{where}: files is a list of the owned files it exercises"
        steps, checks = case.get("steps", []), case.get("assertions")
        if not isinstance(steps, list) or len(steps) > PROBE_STEPS_MAX:
            return f"{where}: steps is a list of at most {PROBE_STEPS_MAX}"
        if not isinstance(checks, list) or not 1 <= len(checks) <= PROBE_ASSERTIONS:
            return f"{where}: assertions is a list of 1-{PROBE_ASSERTIONS}"
        for i, step in enumerate(steps, 1):
            kind = step.get("kind") if isinstance(step, dict) else None
            if kind not in PROBE_STEPS:
                return f"{where}, step {i}: kind is one of {', '.join(PROBE_STEPS)}"
            selector = step.get("selector")
            if selector is not None and (not isinstance(selector, str) or not 1 <= len(selector) <= 500):
                return f"{where}, step {i}: selector is a CSS selector of 1-500 characters"
            if kind == "wait":
                ms = step.get("ms")
                if selector is None and not (isinstance(ms, int) and not isinstance(ms, bool) and 0 <= ms <= PROBE_WAIT_MS):
                    return f"{where}, step {i}: a wait takes a selector, or ms from 0 to {PROBE_WAIT_MS}"
            elif selector is None:
                return f"{where}, step {i}: a {kind} needs a selector"
            for field in PROBE_STEPS[kind]:
                if not isinstance(step.get(field), str):
                    return f"{where}, step {i}: a {kind} needs {field} as text"
            if "value" in step and (not isinstance(step["value"], str) or len(step["value"]) > 2000):
                return f"{where}, step {i}: value is text of at most 2000 characters"
        for i, check in enumerate(checks, 1):
            kind = check.get("kind") if isinstance(check, dict) else None
            if kind not in PROBE_EXPECTS:
                return f"{where}, assertion {i}: kind is one of {', '.join(PROBE_EXPECTS)}"
            if not isinstance(check.get("selector"), str) or not 1 <= len(check["selector"]) <= 500:
                return f"{where}, assertion {i}: selector is a CSS selector of 1-500 characters"
            want, expected = PROBE_EXPECTS[kind], check.get("expected")
            if want is int and (not isinstance(expected, int) or isinstance(expected, bool) or expected < 0):
                return f"{where}, assertion {i}: a count expects a whole number"
            if want is bool and not isinstance(expected, bool):
                return f"{where}, assertion {i}: a {kind} assertion expects true or false"
            if want is str and (not isinstance(expected, str) or len(expected) > 2000):
                return f"{where}, assertion {i}: a {kind} assertion expects text of at most 2000 characters"
    return None


# ---- the appFrame contract, server side ---------------------------------------------------------------------------

class ScopeError(ValueError):
    """A candidate that changed files its piece may not change (named in .paths): refused, never snapshotted."""

    def __init__(self, paths):
        self.paths = sorted(paths)
        super().__init__("the candidate changed files outside its piece: " + ", ".join(self.paths[:20]))


def candidate_scope(origin_files, cand_files, allowed):
    """Every path whose content differs between the fork's origin and the candidate (added, changed or removed) must be
    in `allowed` (the piece's own files minus checks/ and reserved paths). Raises ScopeError naming the others."""
    changed = {p for p in set(origin_files) | set(cand_files) if origin_files.get(p) != cand_files.get(p)}
    outside = {p for p in changed if p not in allowed or p.startswith("checks/")}
    if outside:
        raise ScopeError(outside)


def content_type(path):
    """The content type a bundle file is served with, from its extension (text/plain when the extension is unknown)."""
    ext = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
    return CONTENT_TYPES.get(ext, "text/plain; charset=utf-8")


def bundle_files(files):
    """The app bundle of a checkpoint's files: everything but the check, path-safe and bounded. Raises ValueError."""
    out = {k: v for k, v in files.items() if not k.startswith("checks/")}
    if len(out) > BUNDLE_MAX_FILES:
        raise ValueError(f"the app has more than {BUNDLE_MAX_FILES} files")
    total = 0
    for path, text in out.items():
        if not isinstance(path, str) or not BUNDLE_PATH.fullmatch(path) or path == "bundle.lock.json" or \
                ".." in path.split("/"):
            raise ValueError(f"not a safe app file path: {str(path)[:120]!r}")
        if not isinstance(text, str):
            raise ValueError(f"{path} is not text")
        size = len(text.encode("utf-8"))
        if size > BUNDLE_FILE_MAX:
            raise ValueError(f"{path} is larger than {BUNDLE_FILE_MAX} bytes")
        total += size
    if total > BUNDLE_MAX:
        raise ValueError(f"the app is larger than {BUNDLE_MAX} bytes")
    return out


def _asset_uri(files, path):
    raw = files[path].encode("utf-8")
    return f"data:{content_type(path).split(';')[0]};base64," + base64.b64encode(raw).decode("ascii")


def _inline_assets(text, files, in_css):
    """./<path> references to the bundle's other files become data: URIs (the frame's CSP admits img/font data: only;
    it loads nothing by URL). In HTML: src="./x" / href="./x" (not the frame's own ./app.js and ./style.css); in CSS:
    url(./x), url("./x"), url('./x'). A reference to a file the bundle does not have is left as it is."""
    def known(path):
        return path in files and path not in UI_FILES and not path.startswith("checks/")
    if in_css:
        return re.sub(r"""url\(\s*(["']?)\./([A-Za-z0-9._/-]+)\1\s*\)""",
                      lambda m: f'url("{_asset_uri(files, m.group(2))}")' if known(m.group(2)) else m.group(0), text)
    return re.sub(r"""\b(src|href)=(["'])\./([A-Za-z0-9._/-]+)\2""",
                  lambda m: f'{m.group(1)}="{_asset_uri(files, m.group(3))}"' if known(m.group(3)) else m.group(0), text)


def frame_document(files):
    """The same rules as hive/ui/src/lib/appFrame.ts appDocument (single-file mode): index.html must load ./style.css
    with a stylesheet link and ./app.js with a script, written any way the browser reads them (ui_parts.frame_tags
    and frame_script): the style is inlined in its place, a module script in its place as a module, a classic one
    as a classic script where the browser would run it (in place, or at the end of body when it is deferred); the CSP
    is the document's first element.
    Raises ValueError like appDocument throws. Used for the design review's render evidence, the preview's own
    check and the acceptance check's page verdict (page_problem). The bundle's other files (an icon.svg, a font)
    are inlined as data: URIs where index.html or style.css reference them as ./<path>, the only way the frame's CSP lets them load (img-src data:, font-src data:)."""
    html0 = files.get("index.html")
    if not isinstance(html0, str) or not isinstance(files.get("style.css"), str) or not isinstance(files.get("app.js"), str):
        raise ValueError("Unexpected app interface format")
    nonce = "00000000-0000-0000-0000-000000000000"
    csp = (f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; style-src-attr 'unsafe-inline'; "
           "connect-src 'none'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'")
    css = _inline_assets(files["style.css"], files, True)
    html = _inline_assets(html0, files, False)          # other files' data: URIs change no tag boundary
    link, _module = frame_tags(html)
    script, kind = frame_script(html)
    if link is None or script is None:
        raise ValueError("Unexpected app interface format")
    style = f'<style nonce="{nonce}">' + re.sub(r"</style", r"<\\/style", css, flags=re.I) + "</style>"
    code = re.sub(r"</script", r"<\\/script", files["app.js"], flags=re.I)
    if kind == "module":
        edits = [(link, style), (script, f'<script type="module" nonce="{nonce}">' + code + "</script>")]
    elif kind == "classic":                              # a classic script runs where it stands, so it is inlined there
        edits = [(link, style), (script, f'<script nonce="{nonce}">' + code + "</script>")]
    else:   # deferred (defer or async): it runs once the page is parsed, so it goes at the end of body, still classic
        body_end = ascii_lower(html).rfind("</body")
        at = body_end if body_end > script[1] else len(html)
        edits = [(link, style), (script, ""), ((at, at), f'<script nonce="{nonce}">' + code + "</script>")]
    for (start, end), text in sorted(edits, reverse=True):   # the later one first
        html = html[:start] + text + html[end:]
    return ('<!doctype html><html data-app-host-origin="https://hive.invalid" data-app-channel="render"><head>'
            f'<meta http-equiv="Content-Security-Policy" content="{csp}">' + html)


def page_problem(files):
    """Why the app frame can't show a candidate's page, in words its builder can act on, or None when it can or the
    app has no page (no index.html): frame_document's rule, index.html loading ./style.css with a stylesheet link and
    ./app.js with a script, all three files present."""
    if not isinstance(files.get("index.html"), str):
        return None
    gone = [f for f in ("style.css", "app.js") if not isinstance(files.get(f), str)]
    if gone:
        return "the app frame can't show this page: " + " and ".join(gone) + (" is" if len(gone) == 1 else " are") + " missing"
    try:
        frame_document(files)
        return None
    except ValueError:
        link, _module = frame_tags(files["index.html"])
        script, _kind = frame_script(files["index.html"])     # a module or a classic script both count, as in the frame
        lacks = [tag for tag, found in (('<link rel="stylesheet" href="./style.css">', link),
                                        ('<script type="module" src="./app.js"></script>', script)) if found is None]
        return ("the app frame can't show this page: index.html must load " + " and ".join(lacks or ["its style and script"])
                + " (Unexpected app interface format)")


TIMEOUT_EXITS = (-9, -24, 137, 152)      # SIGKILL / SIGXCPU (the CPU limit), as a signal or a shell status
SANDBOX_EXITS = (78,)                    # the sandbox launcher refused to start (EX_CONFIG), before the check ran


def tail(text, n=20, limit=4000):
    lines = [x for x in (text or "").splitlines() if x.strip()]
    return "\n".join(lines[-n:])[-limit:]


def _no_verdict(why, exit_code, stdout_lines, stderr):
    """An unknown result with its reason class. The sandbox's own output is kept as evidence (the check's error tail)."""
    if exit_code is None:
        reason = "sandbox"
    elif exit_code in TIMEOUT_EXITS:
        reason = "timeout"
    elif exit_code in SANDBOX_EXITS:
        reason = "sandbox"
    else:
        reason = "crashed" if exit_code != 0 else "no-verdict"
    out = {"outcome": "unknown", "reason": reason, "why": why, "exit_code": exit_code}
    if stdout_lines:
        out["output"] = "\n".join(stdout_lines[-20:])[-4000:]
    if tail(stderr):
        out["stderr"] = tail(stderr)
    return out


def _own_fault(out):
    """It printed a CREATE-CHECK line the host cannot read as a verdict: the check's own fault (no-verdict), unless
    the run itself was cut short (timeout) or never really ran (sandbox)."""
    return out if out["reason"] in ("timeout", "sandbox") else {**out, "reason": "no-verdict"}


def parse_check_output(stdout, exit_code, stderr=None):
    """The check's verdict from its last CREATE-CHECK line; anything else is unknown (never a pass), with a reason:
    crashed (non-zero exit), no-verdict (exit 0), timeout or sandbox (see TIMEOUT_EXITS / SANDBOX_EXITS)."""
    lines = [x for x in (stdout or "").splitlines() if x.strip()]
    if not lines:
        return _no_verdict("no output", exit_code, lines, stderr)
    m = CHECK_LINE.match(lines[-1])
    if not m:
        return _no_verdict("no CREATE-CHECK line", exit_code, lines, stderr)
    try:
        data = json.loads(m.group(1))
        if not isinstance(data, dict):
            raise ValueError("not an object")
    except ValueError:
        return _own_fault(_no_verdict("unreadable CREATE-CHECK line", exit_code, lines, stderr))
    passed = data.get("passed")
    failing = [f for f in data.get("failing") or [] if isinstance(f, str)][:50]
    notes = [str(n)[:300] for n in data.get("notes") or []][:30]
    cases = check_cases(data.get("cases"))
    if passed is True and exit_code == 0:
        return {"outcome": "pass", "failing": [], "notes": notes, "line": lines[-1][:2000], "exit_code": exit_code,
                "output": "\n".join(lines[-20:])[:4000], **({"cases": cases} if cases else {})}
    if passed is False and failing:
        return {"outcome": "fail", "failing": failing, "notes": notes, "line": lines[-1][:2000], "exit_code": exit_code,
                "output": "\n".join(lines[-20:])[:4000], **({"cases": cases} if cases else {})}
    # a CREATE-CHECK line that contradicts itself or its exit code: the check's own fault, never a pass
    return {**_own_fault(_no_verdict("inconsistent verdict", exit_code, lines, stderr)), "line": lines[-1][:2000]}


def check_cases(cases):
    """A probe's report of each case it played (tools/probe.mjs): its name, the owned files it is blamed on and whether it
    passed, bounded as the probe is (PROBE_CASES, and the runner's own cases for what the app frame refused, one for
    index.html's markup and one for what app.js adds while it runs). [] for a check that reports none, as a Python
    check doesn't."""
    if not isinstance(cases, list):
        return []
    return [{"name": str(c.get("name") or "")[:200], "passed": c["passed"],
             "files": [f for f in c.get("files") or [] if isinstance(f, str)][:50]}
            for c in cases[:PROBE_CASES + 2] if isinstance(c, dict) and isinstance(c.get("passed"), bool)]


# ---- the composed ports -------------------------------------------------------------------------------------------

# The hive's own self-knowledge, so a mind in Create never asks what Omega is (Jon 11-09: "I mean OmegaHives and
# OmegaMinds and OmegaCodes, I mean you"). Public-safe: the same words as the public README and white paper.
OMEGA_SELF = ("Omega is this platform: OmegaHive (a hive where people and AI minds work together, built on the "
              "Hyperon/MeTTa stack), OmegaMinds (the AI minds living in a hive, each person's own personal mind among "
              "them), OmegaCode (the hive's coding service) and Create (where you are now: one sentence becomes a "
              "planned, built and tested app). When the person says Omega, omegas or 'you', they mean this platform "
              "and its minds, not the Greek letter, fatty acids or watches.")


class Ports:
    def __init__(self, engine, minds, space, checks, apps, members=None):
        from .create_plan_members import PerChangeBuilds
        self.engine, self.minds, self.space, self.checks, self.apps = engine, minds, space, checks, apps
        # every piece is built by a real R3.14 per-change member (create_plan_members.PerChangeBuilds); there is no
        # other builder. `members` replaces it (a test's fake per-change engine)
        self.members = members if members is not None else PerChangeBuilds(engine, self)

    # build space
    async def open_space(self, run):
        return await self.space.open(run)

    async def files(self, run, ckpt):
        return await self.space.files(run, ckpt)

    async def integrate(self, run, piece, cand, integration):
        return await self.space.merge(run, piece, cand)

    # model calls: ask, then post-process the typed answer (now, or when the goal's event arrives)
    async def plan(self, run, body):
        # the hive's own reviews, which every piece of those kinds gets anyway: on a fresh install's first real plan the
        # planner, knowing none of them, added a "code" review of code, which resolved to the piece's own builders
        reviews = [{k: r[k] for k in ("artifact_kind", "review_kind", "evidence")} for r in self.engine.assignees.review_for()]
        packet = {"sentence": run["sentence"], "hive_reviews": reviews,
                  "scaffold_has_acceptance_check": await self.scaffold_has_check(run),
                  # the kinds someone in this hive builds: a Mac install offers no design, and a design piece asked
                  # its person forever for a builder they couldn't make available
                  "staffed_kinds": self.engine.staffed_kinds(run["person"])}
        refused = self.engine.previous_plan_refusal(run["plan_id"])
        if refused:   # the last plan was refused: what it broke, so the planner fixes that instead of answering it again
            packet["last_plan_refused"] = refused
        return await self._call(run, "plan", body, packet)

    async def scaffold_has_check(self, run):
        """Whether the scaffold the plan builds on already has the acceptance check, which tests "detect" would use;
        on a fresh install's small-app scaffold it doesn't, and a plan that chose detect asked for it four times."""
        return CHECK_PATH in await self.space.files(run, self.engine._space(run)["scaffold"])

    async def design(self, run, body, plan):
        return await self._call(run, "design", body, {"sentence": run["sentence"], "plan": plan})

    async def author_tests(self, run, body, plan):
        space = self.engine._space(run)
        scaffold = await self.space.files(run, space["scaffold"])
        # the files a case may name: the plan routes a failure to their owners and blocks on a file nobody owns
        owned = sorted({f for p in (plan or {}).get("pieces", []) for f in p.get("files", [])})
        packet = {
            "sentence": run["sentence"], "plan": plan, "check_path": PROBE_PATH, "scaffold": scaffold,
            "owned_files": owned,
            "contract": "Write " + PROBE_PATH + ", the check that plays the app: " + PROBE_SHAPE + ". Write one case "
                        "for each acceptance criterion. Each case is played on a fresh load of the page in a headless "
                        "browser with no network and no storage, as the hive's frame runs it: its steps are taken in "
                        "order, then each assertion must hold within a second. Use the ids and classes the pieces "
                        "will give their elements, stable ones such as #bill or #board button, never layout paths: "
                        "every builder is given this probe and builds to its selectors. Work every expected number "
                        "out from the example's inputs. A case fails when an assertion doesn't hold, a step can't be "
                        "taken or the page throws, and its failure goes to the builders of the owned files it names "
                        "in files (all the page's files when it names none). It must FAIL on the scaffold."}
        refused = space.get("author_refusal")
        if refused:   # the host refused the last answer: say why, so the author fixes that instead of resending it
            packet["your_last_answer_was_refused"] = refused
            packet["contract"] += " Your last answer was refused (" + refused + "); fix that and answer again."
        previous = self.engine.previous_check_error(run["plan_id"])
        if previous:
            # the last check this author wrote ran but gave no verdict: show what happened so it fixes that check
            suite = space.get("suite") or CHECK_PATH
            if space.get("base"):
                with contextlib.suppress(Exception):
                    old = (await self.space.files(run, space["base"])).get(suite)
                    if old:
                        previous["check"] = old[:20000]
            packet["previous_attempt"] = previous
            if suite == PROBE_PATH:
                # the runner gives no verdict only for a probe it can't play: a bad shape, selector or pattern
                packet["contract"] += (" Your previous probe could not be played (" + str(previous.get("reason")) +
                                       "); previous_attempt holds what the runner said. Fix that probe.")
            else:
                packet["contract"] += (" Your previous check, in Python, did not give a verdict (" +
                                       str(previous.get("reason")) + "); previous_attempt holds its error output. A "
                                       "probe gives a verdict by itself; if you fix the Python check instead: " +
                                       PYTHON_CHECK_RULES)
            if suite != PROBE_PATH and previous.get("reason") == "crashed" and \
                    previous.get("why") == "no CREATE-CHECK line" and previous.get("output"):
                # it printed findings, then exited before its verdict: on 18 Nov four checks in a row printed
                # "FAIL: missing file index.html" and exited 1 on the scaffold, before their CREATE-CHECK line
                packet["contract"] += (" It printed its findings and stopped (exit " + str(previous.get("exit_code")) +
                                       ") before its CREATE-CHECK line: record each finding in failing and keep "
                                       "going, then print the CREATE-CHECK line last.")
        return await self._call(run, "author-tests", body, packet)

    async def detect_tests(self, run, body):
        space = self.engine._space(run)
        files = await self.space.files(run, space["scaffold"])
        if CHECK_PATH not in files:
            return {"unknown": "no acceptance check in the repository"}
        return {"base": space["scaffold"], "suite": CHECK_PATH, "files": [CHECK_PATH], "by": None}

    async def build(self, run, body, spec, plan, base):
        return await self.members.build(run, body, spec)

    async def review(self, run, body, plan):
        files = await self.space.files(run, body["candidate"])
        spec = self.engine._piece_spec(run["plan_id"], body["piece"]) or {}
        return await self._call(run, "review", body, {
            "sentence": run["sentence"], "plan": plan, "piece": spec, "rule": body["rule"],
            "files": {k: v for k, v in files.items() if k in spec.get("files", []) or k in UI_FILES},
            "builder_summary": self.engine._built_summary(run["plan_id"], body["candidate"]),
            # the acceptance check on this candidate, so a reviewer can tell a passing build from an unchecked one
            **self.members.check_for(run, body["piece"], body["candidate"]),
            "evidence": body.get("evidence")})

    async def _call(self, run, kind, body, packet):
        answers = self.engine.answers(run["plan_id"])
        packet = dict(packet, answers=answers)
        if answers:   # said plainly, so no step waits on a question the person already answered
            packet["the_person_already_answered"] = [
                f"Q: {a.get('question') or a['q']} A: {a.get('text')}" for a in answers if a.get("text")]
        packet["what_omega_is"] = OMEGA_SELF
        stopped = self.engine.last_stop(run["plan_id"], kind, body.get("piece"))
        if stopped:   # this step's last attempt ended with a reason (its mind's own, or the hive's when the mind stopped)
            packet["your_last_attempt_stopped"] = stopped
        
        out = await self.minds.call(run, kind, body, packet)
        if isinstance(out, dict) and out.get("pending"):
            return out
        return await self.post(run, kind, body, out)

    async def collect(self, run, kind, body, goal_id):
        if str(goal_id).startswith("member:"):
            return await self.members.collect(run, body, goal_id)
        out = await self.minds.collect(run, kind, body, goal_id)
        if out is None:
            return None
        return await self.post(run, kind, body, out)

    async def post(self, run, kind, body, out):
        """The host's half of a model answer: typed, bounded, and written only where that mind may write."""
        if not isinstance(out, dict) or "unknown" in out or out.get("failed") or out.get("blocked"):
            return out if isinstance(out, dict) else {"unknown": "no answer"}
        if kind in ("plan", "design"):
            return out
        if kind == "author-tests":
            files = out.get("files") or {}
            if set(files) == {PROBE_PATH}:
                probe = files[PROBE_PATH]
                if isinstance(probe, str):
                    try:
                        probe = json.loads(probe)
                    except ValueError as exc:
                        return self._author_refused(run, f"{PROBE_PATH} is not JSON ({exc})")
                problem = probe_problem(probe)
                if problem:
                    return self._author_refused(run, problem)
                text = json.dumps(probe, ensure_ascii=False, indent=1)
                if len(text) > 200_000:
                    return self._author_refused(run, f"{PROBE_PATH} is over 200,000 characters")
                ckpt = await self.space.write(run, {PROBE_PATH: text}, "acceptance probe (tests first)")
                self.engine._space_set(run["plan_id"], author_refusal=None, probe=text)
                return {"base": ckpt, "suite": PROBE_PATH, "files": [PROBE_PATH], "by": out.get("by")}
            # a repository's own Python check, the earlier contract, still taken
            if set(files) != {CHECK_PATH} or not isinstance(files[CHECK_PATH], str) or len(files[CHECK_PATH]) > 200_000:
                return self._author_refused(run, f"the test author writes exactly {PROBE_PATH} and nothing else")
            ckpt = await self.space.write(run, files, "acceptance check (tests first)")
            self.engine._space_set(run["plan_id"], author_refusal=None)
            return {"base": ckpt, "suite": CHECK_PATH, "files": [CHECK_PATH], "by": out.get("by")}
        if kind == "review":
            reviewer = (body.get("reviewer") or {}).get("agent_id")
            if out.get("reviewer") != reviewer:
                return {"unknown": "the verdict is not from the selected reviewer"}
            return {"decision": out.get("decision"), "reviewer": reviewer, "notes": str(out.get("notes") or "")[:3000],
                    "evidence": body.get("evidence")}
        return out

    def _author_refused(self, run, why):
        """The test author's answer, refused before it is written: kept for its next try (author_tests says why) and
        journalled as unknown, which the reducer reconciles and asks again within the plan's retries."""
        why = str(why)[:1000]
        self.engine._space_set(run["plan_id"], author_refusal=why)
        return {"unknown": f"the test author's answer was refused: {why}"[:600]}

    # checks, preview, deploy
    async def run_check(self, run, ckpt, suite, base):
        """The files under test come from ckpt; the check itself ALWAYS comes from the base checkpoint the test author
        wrote (review F2): nothing a builder writes can replace or edit the check that judges it."""
        files = await self.space.files(run, ckpt)
        judge = await self.space.files(run, base) if base else {}
        if not suite or suite not in judge:
            return {"outcome": "unknown", "reason": "sandbox", "why": "the suite is not in the base checkpoint"}
        files = {k: v for k, v in files.items() if not k.startswith("checks/")}
        if suite == PROBE_PATH:
            try:
                probe = json.loads(judge[suite])
            except ValueError:
                return {"outcome": "unknown", "reason": "no-verdict", "why": f"{PROBE_PATH} in the base is not JSON"}
            try:
                document = frame_document(files)
            except ValueError as exc:            # the runner fails every case on the page's own files, with this
                document, probe = None, dict(probe, page_problem=str(exc))
            plan = self.engine._plan(run["plan_id"]) or {}
            owned = sorted({f for p in plan.get("pieces", []) for f in p.get("files", [])})
            return await self.checks.run_probe(document, probe, owned)
        files[suite] = judge[suite]
        out = await self.checks.run(files, suite)
        # a built page the app frame can't show fails whatever the suite says, naming index.html, so the plan sends it
        # to the page's builder as a repair: at the preview it was refused until the plan blocked, and Try again
        # previewed the same files (a v0.39 tester build's tip calculator). The scaffold that holds the check (ckpt is
        # the base) is judged as before, so a page it can't show never makes a vacuous check look red.
        problem = None if ckpt == base else page_problem(files)
        if problem:
            out = dict(out, outcome="fail", failing=sorted({*(out.get("failing") or []), "index.html"}),
                       notes=[problem, *(out.get("notes") or [])])
        return out

    async def preview(self, run, ckpt, plan):
        files = await self.space.files(run, ckpt)
        return self.apps.preview(run, files, plan)

    async def deploy(self, run, body, plan):
        out = self.apps.deploy(run, body, plan)
        if isinstance(out, dict) and out.get("program_id"):
            swarms = self.apps.turn_on(run["person"], out["program_id"])
            log.info("create plan %s: %s turned on in %s", run["plan_id"], out["program_id"], swarms or "no swarm")
        return out

    async def deploy_readback(self, run, body, plan):
        """A deploy that answered "unknown" settles here: when the read back finds it deployed, it is turned on as a
        definite deploy would have been, or the app would sit installed but on in no swarm."""
        out = self.apps.readback(run, body, plan)
        if isinstance(out, dict) and out.get("deployed") is True and out.get("program_id"):
            swarms = self.apps.turn_on(run["person"], out["program_id"])
            log.info("create plan %s: %s read back deployed, turned on in %s", run["plan_id"], out["program_id"],
                     swarms or "no swarm")
        return out

    async def integrated(self, run, piece, op, cand, ckpt):
        try:
            await self.members.integrated(run, piece, op, cand, ckpt)
        except Exception:                            # as a crash would: the journal has it; settle delivers it again
            log.exception("create plan %s: delivering %s's member failed", run["plan_id"], piece)

    async def settle(self, run):
        """After every plan step: the members catch up with the plan (lost deliveries, ended when the plan rests), and
        once the plan has finished or stopped, the goals its other steps still wait on (the planner's, test author's,
        designer's or reviewer's) are withdrawn: a mind holding a goal keeps its turns until the goal ends, so one left
        claimed on a stopped plan would work on for nothing. Time: one select of the plan's waiting effects."""
        await self.members.settle(run)
        if str(self.engine._run(run["plan_id"])["phase"]) in TERMINAL:
            for effect in self.engine._effects(run["plan_id"], state="waiting"):
                if effect["goal_id"] and not str(effect["goal_id"]).startswith("member:"):
                    await self.minds.withdraw(run, effect["goal_id"])

    async def readback(self, run, body, kind, goal_id):
        if str(goal_id or "").startswith("member:"):
            return await self.members.readback(run, body, goal_id)
        if goal_id:
            return await self.minds.withdraw(run, goal_id)
        return {"kind": kind}


# ---- minds: model calls as hive goals for the resolved mind ------------------------------------------------------

# what the planner answers: the fields with their types, then every rule the plan check refuses a plan for, read from
# every rule a plan must pass, the host's check's and the reducer's, from their one table (create_plan_engine.PLAN_RULES,
# which a test reads back from both), so the prompt can't drift from the checks; on a fresh install's first real plans
# the model, told only the fields' names, wrote evidence as a sentence, a selector as "code", a piece with no files, a
# review of code by its own builders and a design step beside design pieces, one refused plan after another
PLAN_SHAPE = ('{"plan": {"title": str, "pieces": [{"id": word, "kinds": [code or design, only kinds in staffed_kinds], "assignee": optional ["team", '
              'swarm] | ["mind", agent] | ["capability", cap] | ["hive", hive, cap] | ["open", cap], "title", "brief", '
              '"deps": [piece ids], "files": [paths it writes]}], "acceptance": [what the finished thing must do, each a sentence; an '
              'example with numbers writes its working out, such as \"two 3.50 items with 10% tax: 7.00 + 0.70 = '
              '7.70\"], "questions": [{"q": word, '
              '"about": "plan"|"deploy"|{"piece": id}, "text", "choices": [str]}], "needs": {"design": '
              '"design"|"no-design", "tests": "author"|"detect", "reviews": optional [{"artifact_kind": word, '
              '"review_kind": word, "evidence": word}], "caps": optional [{"selector": a list as for assignee, "n": '
              'whole number}]}}}. A word is a letter, then letters, digits, _ or -, 48 at most. Add a review only when '
              'the hive\'s own (hive_reviews in the packet, which every piece of their kind gets anyway) lack it, its '
              'review_kind a capability some team or mind offers, such as security, never the piece\'s own kind.')
ANSWER_SHAPES = {
    "plan": PLAN_SHAPE + " The plan check refuses a plan unless " + "; ".join(PLAN_RULES.values()) + ".",
    "design": '{"ref": "a design reference"}',
    # the goal text's shape is what a test author answers with, whatever its contract says, so it names the probe: with
    # the Python file here a real author on 19 November wrote three Python checks before its fourth answer, a probe
    "author-tests": '{"files": {"' + PROBE_PATH + '": <the probe as one JSON object, {"cases": [...]}, as the contract '
                    'describes>}}',
    "review": '{"decision": "pass"|"fail", "notes": str}',
}
PURPOSE = {"plan": "plan", "design": "design", "author-tests": "test-author", "review": "review"}
FILE_ANSWERS = frozenset({"author-tests"})   # the steps whose answer holds files, which may come one command each
# The most of a goal's detail every mind reads in one result: the Iter template's hive_goal_get DETAIL_CHARS (3500),
# the smaller of it and the hive skill's GOAL_DETAIL_CHARS (4500); test_create_step_rules_in_goal rebuilds it from both.
TASK_READ_CHARS = 3500


def _quote(sentence, room, most=200):
    """`sentence` as a JSON string of at most `room` characters: whole where it fits, else cut with an ellipsis, and
    never more than `most` of its characters, so with the command ahead of it the quote stays inside the first 700
    characters a later turn keeps of each message (helper_metta.context_recent_history_entries). Time: one json.dumps
    a pass, and another pass only where escaping overflowed the cut."""
    n = min(len(sentence), most)
    while True:
        quoted = json.dumps(sentence if n == len(sentence) else sentence[:n] + "…", ensure_ascii=False)
        if len(quoted) <= room or n == 0:
            return quoted
        n = max(0, n - (len(quoted) - room))


class GoalMinds:
    """Model calls as goals assigned to the resolved mind (the planner and test author resolve through the same
    assignee defaults: capabilities plan / test-author), each claimed for that mind as it is made. The step's whole task
    (task_text) is the goal's detail and the message the mind is sent; its finished goal's result data is the typed
    answer. Wake: goal.updated (engine.goal_changed); never polled."""

    def __init__(self, engine):
        self.engine, self.hive = engine, engine.hive

    def _who(self, run, kind, body):
        if kind == "review":
            return body["reviewer"]
        cap = {"plan": "plan", "design": "design", "author-tests": "test-author"}[kind]
        return self.engine.assignees.resolve(["capability", cap], run["person"])

    async def call(self, run, kind, body, packet):
        who = self._who(run, kind, body)
        agent = who.get("agent_id") if who.get("resolved") else None
        if not agent:
            if kind == "review":
                return {"unavailable": who.get("detail") or "no reviewer mind"}
            return {"unknown": f"nobody can {PURPOSE[kind]} now ({who.get('detail')})"}
        swarm = who.get("swarm_id") or self.hive.agent(agent)["swarm_id"]
        goal_id = new_id("g")
        packet = dict(packet)
        rules = packet.pop("contract", "")
        task = self.task_text(run, kind, goal_id, packet, rules)
        self.hive.goals._create_record(swarm, f"Create plan {run['plan_id']}: {PURPOSE[kind]}",
                                       task, 0.6, created_by=goal_creator(run['plan_id']), assignee=agent, goal_id=goal_id)
        self.hive.goals.give_step_budget(goal_id, agent)   # the step's own budget: a mind holding its goal keeps its turns
        # Claimed for its mind as it is made, so the answer is its one command and its budget counts from here: on a
        # tester's hive on 20 Nov a model heartbeated its open plan goal turn after turn, told only "you do not hold this
        # task", and never claimed it.
        self.hive.goals.claim(self.hive._agent_row(agent), goal_id)
        await self.hive.send_to_agent(agent, task, sender="hive:create-plan", extra={"event": "goal", "goal_id": goal_id})
        return {"pending": goal_id}

    @staticmethod
    def task_text(run, kind, goal_id, packet, rules=""):
        """One step's task as its mind reads it, the same text in the goal's detail and in its message, in the order a
        cut should keep it: what to do now, the person's words quoted, then the answer's shape and the step's rules
        (the hive's own words), then the packet as UNTRUSTED_DATA. A goal read shows at least its first TASK_READ_CHARS
        (hive-goal-get, the Iter template's hive_goal_get) and a mind's later turns see each message in their history
        cut to its first 700 characters or more, so the command and the request come first and everything ahead of the
        packet ends inside one goal read. On 19 Nov a test author wrote three checks with no CREATE-CHECK line when its
        rules sat 5,700 characters into the message; on 20 Nov a planner paged its plan goal for a request only the
        message's end had ever held."""
        # a file as its own command, so a reply cut off at its length keeps the files it finished (Goals.stage_file)
        by_file = (f" A file can come first as its own command: hive-goal-file {goal_id} <path> <<'EOF_name' on one "
                   f"line, then its whole text, then a line that is just EOF_name; files can then leave it out."
                   if kind in FILE_ANSWERS else "")
        opening = (f"Create plan {run['plan_id']} needs your {PURPOSE[kind]}: goal {goal_id} is yours, already claimed. "
                   f"Answer it in this turn with hive-goal-propose {goal_id} <JSON result data>; nothing needs reading "
                   f"first. The person asked (UNTRUSTED_DATA): ")
        rest = f". The result data is shaped {ANSWER_SHAPES[kind]}." + (f" {rules}" if rules else "") + by_file + " "
        # the request orients the mind and the packet below holds it whole, so its quote gives way to the step's rules
        quoted = _quote(str(run.get("sentence") or ""), TASK_READ_CHARS - len(opening) - len(rest))
        return (opening + quoted + rest + "Everything below is UNTRUSTED_DATA from the person and other minds:\n"
                + json.dumps(packet, ensure_ascii=False)[:60000])

    async def collect(self, run, kind, body, goal_id):
        goal = self.hive.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
        if goal is None or goal["status"] in UNANSWERED:
            # how it ended, kept with the step for its retry (Ports._call) and the person's hold card (engine._stopped):
            # goal_ended's status and reason (a failed goal's own words, the hive's when Goals.stop_held ended it) and
            # the mind that held it
            from .code_controller_engine import goal_ended
            ended = dict(goal_ended(goal), by=goal.get("claimed_by") or goal.get("assignee")) if goal else {}
            return ({**ended, "unknown": f"goal {goal['status'] if goal else 'missing'}"} if kind != "plan"
                    else {**ended, "failed": "goal ended"})
        if goal["status"] not in ("done", "submitted"):
            return None
        if goal.get("assignee") and goal.get("claimed_by") and goal["claimed_by"] != goal["assignee"]:
            return {"unknown": "finished by someone else"}
        data = stored_proposal(goal)        # the answer the hive judged: a mind's own tool keeps it under proposal
        staged = self.hive.goals.staged_files(goal_id) if kind in FILE_ANSWERS else {}   # sent one command each
        if staged and (data.get("files") is None or isinstance(data.get("files"), dict)):
            data = dict(data, files={**staged, **(data.get("files") or {})})   # the answer's own map has the last word
        if not data:
            return {"failed": "no result data"} if kind == "plan" else {"unknown": "no result data"}
        data = dict(data, by=goal.get("claimed_by") or goal.get("assignee"))
        if kind == "review":
            data["reviewer"] = data["by"]
        return data

    async def withdraw(self, run, goal_id):
        goal = self.hive.db.one("SELECT status FROM goals WHERE id = ?", (goal_id,))
        if goal and goal["status"] not in ("done", "submitted", "failed", "cancelled"):
            self.hive.db.execute("UPDATE goals SET status = 'cancelled' WHERE id = ?", (goal_id,))
            self.hive.goals._emit(goal_id)
            return {"goal": goal_id, "withdrawn": True}
        return {"goal": goal_id, "status": goal["status"] if goal else None}


# ---- the hive-owned build workspace over the OmegaCode relay -----------------------------------------------------

class OmegaCodeSpace:
    """One Create task per plan on the person's own authority (code.open of the Create scaffold repository: a goal on
    Code local and the person's edit grant), an integration workspace, a fork per piece, checkpoints and cross-fork merge
    previews applied into the integration workspace. Every call goes through hive.code.proxy, the same relay the person's
    canvas uses (never a direct service call).

    Two integration modes, chosen by what the relay serves (never by guessing authority):
      fork-merge  POST .../forks + cross-fork merge preview/apply (OmegaCode's merge), when the relay carries the forks
                  route. Code holds that route today until it names its actions (code.py: "held per Code").
      patch       until then: each piece gets its own workspace on the same task, brought to the integration head's
                  content, and integration is one guarded patch of the piece's changed files onto the integration
                  workspace, each edit's expected_digest being the file's digest where the piece started (OmegaCode
                  refuses the patch if the integration moved under it: that is the merge-conflict).

    OmegaCode reads only a workspace's CURRENT generation, so when the host makes a checkpoint it reads that generation's
    files once and keeps them (create_plan_snapshots, each row with the service's own digest): later reads of that
    checkpoint (a review, a check, the canvas) come from the snapshot, re-verified by digest."""

    SCAFFOLD_REPO = os.environ.get("HIVE_CREATE_SCAFFOLD_REPO", "create-web-scaffold")
    SCHEMA = """CREATE TABLE IF NOT EXISTS create_plan_snapshots (plan_id TEXT NOT NULL, ckpt TEXT NOT NULL,
      path TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (plan_id, ckpt, path))"""

    def __init__(self, engine, mode=None):
        self.engine, self.hive = engine, engine.hive
        self.hive.db.execute(self.SCHEMA)
        self.mode = mode

    def _mode(self):
        if self.mode:
            return self.mode
        from .code import PROXY_ROUTES
        relayed = any(r[0] == "POST" and re.fullmatch(r[1], "/v1/workspaces/ws_a/forks") for r in PROXY_ROUTES)
        return "fork-merge" if relayed else "patch"

    def _s(self, run):
        return self.engine._space(self.engine._run(run["plan_id"]))

    def _set(self, run, **changes):
        return self.engine._space_set(run["plan_id"], **changes)

    async def _call(self, run, method, path, body=None, query=None):
        s = self._s(run)
        status, content, _ = await self.hive.code.proxy(run["person"], method, path, dict(query or {}),
                                                        None if body is None else json.dumps(body).encode(),
                                                        s["task_id"], s["grant_id"], s["repository_id"])
        try:
            value = json.loads(content) if content else None
        except ValueError:
            value = None
        return status, value

    async def _ok(self, run, method, path, body=None, query=None, want=(200, 201)):
        status, value = await self._call(run, method, path, body, query)
        if status not in want:
            err = value.get("error") if isinstance(value, dict) else None
            raise RuntimeError(f"OmegaCode {method} {path} answered {status} {err}")
        return value

    def _op(self, run, what):
        return f"cpe.{run['plan_id'][5:21]}.{what}.{new_id('x')[2:14]}"[:160]

    async def open(self, run):
        opened = await self.hive.code.open("repo:" + self.SCAFFOLD_REPO, run["person"])
        self._set(run, task_id=opened["task_id"], grant_id=opened["grant_id"], repository_id=opened["repository_id"],
                  base_commit=opened["base_commit"])
        ws = await self._ok(run, "POST", "/v1/workspaces", {"operation_id": self._op(run, "ws"),
                                                           "repository_id": opened["repository_id"],
                                                           "task_id": opened["task_id"],
                                                           "base_commit": opened["base_commit"]})
        self._set(run, integration=ws["id"])
        ck = await self._checkpoint(run, ws, "scaffold")
        return {"integration": ws["id"], "scaffold": ck}

    async def _ws(self, run, ws_id):
        return await self._ok(run, "GET", f"/v1/workspaces/{ws_id}")

    async def _checkpoint(self, run, ws, label):
        cp = await self._ok(run, "POST", f"/v1/workspaces/{ws['id']}/checkpoints",
                            {"operation_id": self._op(run, "ck"), "expected_generation": ws["generation"],
                             "expected_tree_digest": ws["tree_digest"], "label": label[:200]})
        ck = cp["id"]
        tree = await self._ok(run, "GET", f"/v1/workspaces/{ws['id']}/tree")
        if tree.get("generation") != cp["generation"]:
            raise RuntimeError("the workspace moved while its checkpoint was read")
        rows = []
        for entry in tree.get("files") or []:
            got = await self._ok(run, "GET", f"/v1/workspaces/{ws['id']}/files",
                                 query={"path": entry["path"], "expected_generation": cp["generation"]})
            rows.append((run["plan_id"], ck, got["path"], got["digest"], got["content"]))
        with self.hive.db.transaction():
            for r in rows:
                self.hive.db.execute("INSERT OR REPLACE INTO create_plan_snapshots (plan_id, ckpt, path, digest, content) "
                                     "VALUES (?, ?, ?, ?, ?)", r)
        s = self._s(run)
        self._set(run, ckpt_ws={**(s.get("ckpt_ws") or {}), ck: ws["id"]})
        return ck

    async def _patch(self, run, ws_id, files):
        ws = await self._ws(run, ws_id)
        edits = []
        for path, content in files.items():          # content None deletes the file
            status, value = await self._call(run, "GET", f"/v1/workspaces/{ws_id}/files", query={"path": path})
            expected = value.get("digest") if status == 200 and isinstance(value, dict) else None
            if content is None and expected is None:
                continue
            edits.append({"path": path, "expected_digest": expected, "content": content})
        if not edits:
            return ws
        await self._ok(run, "POST", f"/v1/workspaces/{ws_id}/patches",
                       {"operation_id": self._op(run, "patch"), "expected_generation": ws["generation"],
                        "expected_tree_digest": ws["tree_digest"], "edits": edits})
        return await self._ws(run, ws_id)

    async def write(self, run, files, label):
        ws = await self._patch(run, self._s(run)["integration"], files)
        return await self._checkpoint(run, ws, label)

    def _head(self, s):
        return (s.get("ckpts") or [None])[-1] or s.get("base")

    async def ensure_fork(self, run, piece):
        """The piece's own workspace (a fork, or in patch mode a same-task workspace brought to the integration head);
        made once per round of the piece, again after it was merged. Returns its workspace id."""
        s = self._s(run)
        fork = (s.get("forks") or {}).get(piece)
        if fork is not None:
            return fork
        origin = self._head(s)
        if self._mode() == "fork-merge":
            parent = await self._ws(run, s["integration"])
            made = await self._ok(run, "POST", f"/v1/workspaces/{s['integration']}/forks",
                                  {"operation_id": self._op(run, "fork"), "expected_generation": parent["generation"],
                                   "expected_tree_digest": parent["tree_digest"]})
        else:                                        # same task, same base commit, then the integration head's content
            made = await self._ok(run, "POST", "/v1/workspaces", {"operation_id": self._op(run, "ws"),
                                                                 "repository_id": s["repository_id"],
                                                                 "task_id": s["task_id"], "base_commit": s["base_commit"]})
            head = await self.files(run, origin)
            status, tree = await self._call(run, "GET", f"/v1/workspaces/{made['id']}/tree")
            have = {}
            for entry in (tree or {}).get("files") or []:
                got = await self._ok(run, "GET", f"/v1/workspaces/{made['id']}/files", query={"path": entry["path"]})
                have[entry["path"]] = got["content"]
            diff = {k: v for k, v in head.items() if have.get(k) != v}
            diff.update({k: None for k in have if k not in head})   # and nothing the head does not have
            if diff:
                await self._patch(run, made["id"], diff)
        fork = made["id"]
        s = self._s(run)
        self._set(run, forks={**(s.get("forks") or {}), piece: fork},
                  fork_origin={**(s.get("fork_origin") or {}), piece: origin})
        return fork

    async def adopt_checkpoint(self, run, piece, ckpt, allowed):
        """A candidate checkpoint someone else made on the piece's fork (a plan member): verified to be that fork's
        CURRENT checkpoint and to change nothing but `allowed` against the fork's origin (candidate_scope: anything
        else holding a relay grant for the task could have written to the fork), then snapshotted like the host's own
        (create_plan_snapshots). Idempotent."""
        if self.hive.db.one("SELECT 1 FROM create_plan_snapshots WHERE plan_id = ? AND ckpt = ?", (run["plan_id"], ckpt)):
            return ckpt
        s = self._s(run)
        fork = (s.get("forks") or {}).get(piece)
        if fork is None:
            raise RuntimeError("the piece has no fork")
        ws = await self._ws(run, fork)
        cps = await self._ok(run, "GET", f"/v1/workspaces/{fork}/checkpoints")
        cp = next((c for c in cps.get("checkpoints", []) if c.get("id") == ckpt), None)
        if cp is None or cp.get("generation") != ws["generation"] or cp.get("tree_digest") != ws["tree_digest"]:
            raise RuntimeError("the candidate is not the piece fork's current checkpoint")
        tree = await self._ok(run, "GET", f"/v1/workspaces/{fork}/tree")
        rows = []
        for entry in tree.get("files") or []:
            got = await self._ok(run, "GET", f"/v1/workspaces/{fork}/files",
                                 query={"path": entry["path"], "expected_generation": cp["generation"]})
            rows.append((run["plan_id"], ckpt, got["path"], got["digest"], got["content"]))
        origin = (s.get("fork_origin") or {}).get(piece)
        if origin is None:
            raise RuntimeError("the piece's fork has no recorded origin")
        candidate_scope(await self.files(run, origin), {r[2]: r[4] for r in rows}, set(allowed))
        with self.hive.db.transaction():
            for r in rows:
                self.hive.db.execute("INSERT OR REPLACE INTO create_plan_snapshots (plan_id, ckpt, path, digest, content) "
                                     "VALUES (?, ?, ?, ?, ?)", r)
        s = self._s(run)
        self._set(run, ckpt_ws={**(s.get("ckpt_ws") or {}), ckpt: fork})
        return ckpt

    async def merge(self, run, piece, cand):
        """Three-way with base = the integration checkpoint the piece's fork was made from (OmegaCode requires a common
        ancestor), so only the piece's own changes come in, never a revert of another piece's work. Once merged, the
        piece's next fix forks afresh from the integration head (its own merged work included)."""
        s = self._s(run)
        ws = await self._ws(run, s["integration"])
        base = (s.get("fork_origin") or {}).get(piece) or s.get("base")
        if self._mode() == "patch":
            return await self._patch_merge(run, piece, cand, base)
        preview = await self._ok(run, "POST", f"/v1/workspaces/{s['integration']}/merges",
                                 {"operation_id": self._op(run, "merge"), "expected_generation": ws["generation"],
                                  "expected_tree_digest": ws["tree_digest"], "base_checkpoint_id": base,
                                  "incoming_checkpoint_id": cand})
        if preview.get("conflict_count"):
            page = await self._ok(run, "GET", f"/v1/workspaces/{s['integration']}/merges/{preview['id']}",
                                  query={"limit": 100})
            return {"conflict": [f["path"] for f in page.get("files", []) if f.get("conflict")], "preview": preview["id"]}
        await self._ok(run, "POST", f"/v1/workspaces/{s['integration']}/merges/{preview['id']}/apply",
                       {"operation_id": self._op(run, "apply"), "preview_id": preview["id"],
                        "expected_generation": ws["generation"], "expected_tree_digest": ws["tree_digest"]})
        ws = await self._ws(run, s["integration"])
        ck = await self._checkpoint(run, ws, f"integrated {piece}")
        forks = dict(self._s(run).get("forks") or {})
        forks.pop(piece, None)                       # the next fix of this piece starts from the new integration head
        self._set(run, forks=forks, merged={**(self._s(run).get("merged") or {}), piece: cand})
        return {"ckpt": ck, "merge": preview["id"]}

    async def _patch_merge(self, run, piece, cand, base):
        s = self._s(run)
        origin = {r["path"]: r["digest"] for r in self.hive.db.all(
            "SELECT path, digest FROM create_plan_snapshots WHERE plan_id = ? AND ckpt = ?", (run["plan_id"], base))}
        incoming = await self.files(run, cand)
        before = await self.files(run, base)
        changed = {k: v for k, v in incoming.items() if before.get(k) != v}
        ws = await self._ws(run, s["integration"])
        if changed:
            edits = [{"path": k, "expected_digest": origin.get(k), "content": v} for k, v in changed.items()]
            status, value = await self._call(run, "POST", f"/v1/workspaces/{s['integration']}/patches",
                                             {"operation_id": self._op(run, "integrate"),
                                              "expected_generation": ws["generation"],
                                              "expected_tree_digest": ws["tree_digest"], "edits": edits})
            err = value.get("error") if isinstance(value, dict) else None
            code = err.get("code") if isinstance(err, dict) else err
            if status == 409 and code == "stale_file":     # the integration moved under this piece: a real conflict
                return {"conflict": sorted(changed), "why": code}
            if status not in (200, 201):
                raise RuntimeError(f"OmegaCode integration patch answered {status} {value}")
            ws = await self._ws(run, s["integration"])
        ck = await self._checkpoint(run, ws, f"integrated {piece}")
        forks = dict(self._s(run).get("forks") or {})
        forks.pop(piece, None)
        self._set(run, forks=forks, merged={**(self._s(run).get("merged") or {}), piece: cand})
        return {"ckpt": ck, "mode": "patch", "paths": sorted(changed)}

    async def files(self, run, ckpt):
        rows = self.hive.db.all("SELECT path, digest, content FROM create_plan_snapshots WHERE plan_id = ? AND ckpt = ?",
                                (run["plan_id"], ckpt))
        if not rows:
            raise RuntimeError("unknown checkpoint")
        out = {}
        for r in rows:
            if hashlib.sha256(r["content"].encode("utf-8")).hexdigest() != r["digest"].removeprefix("sha256:"):
                raise RuntimeError("a checkpoint snapshot does not match its digest")
            out[r["path"]] = r["content"]
        return out


# ---- the acceptance check in the hive sandbox ----------------------------------------------------------------------

class SandboxChecks:
    """The authored check runs inside sandbox_run (no network, fresh job folder, limits) through the pinned host bundle
    hive/plugins/create_acceptance_check (operator allowlist: HIVE_SANDBOX_RUN_APPS must include it)."""

    async def run(self, files, suite):
        program = {"id": CHECK_PROGRAM, "path": str(PLUGIN_DIR), "capabilities": ["sandbox:run"]}
        snapshot = json.dumps({"files": files, "check": suite}).encode()
        return await self._run(program, "run.py", "python", snapshot, cpu_seconds=10, timeout=30)

    async def run_probe(self, document, probe, owned):
        """The probe played by tools/probe.mjs on the node runtime: happy-dom runs the page's scripts in a VM context
        that is no isolation of its own (CVE-2025-61927), so the sandbox is the boundary. Its CPU and wall limits are
        wider than the Python check's: a case waits up to a second for each step and assertion, and a probe on the
        scaffold, where nothing it waits for exists, takes a second or so for each of its cases."""
        program = {"id": CHECK_PROGRAM, "path": str(PLUGIN_DIR), "capabilities": ["sandbox:run"]}
        snapshot = json.dumps({"document": document, "probe": probe, "owned": owned}).encode()
        return await self._run(program, "probe.mjs", "node", snapshot, cpu_seconds=30, timeout=90)

    @staticmethod
    async def _run(program, entry, runtime, snapshot, cpu_seconds, timeout):
        from . import run_backends
        try:
            result = await run_backends.get().run(program, entry, inputs={"snapshot.json": snapshot}, runtime=runtime,
                                                  bundle="tools", cpu_seconds=cpu_seconds, timeout=timeout,
                                                  file_bytes=8 * 1024 * 1024)
        except TimeoutError as exc:              # the work deadline (the check never finished): a lost run
            return {"outcome": "unknown", "reason": "timeout", "why": f"timeout: {exc}"[:300]}
        except Exception as exc:                 # the runner could not start or finish cleanly: never the check's verdict
            return {"outcome": "unknown", "reason": "sandbox", "why": f"sandbox: {exc}"[:300]}

        def text(name):
            raw = result.get(name)
            return raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw or "")
        return parse_check_output(text("stdout"), result.get("exit"), text("stderr"))


# ---- preview and deploy: a pinned program UI bundle, then a hive app ----------------------------------------------

PROGRAM_PY = '''"""A Create app: its own interface only (ui/), no actions. Made by a Create plan."""


def describe():
    return {"contract": "0.1", "kinds": [{"id": "page", "label": "Page", "role": "other"}], "relations": [], "actions": []}


def view(ctx, focus, stage):
    return {"revision": "create-app-1", "title": %(title)r, "items": [], "links": []}


def act(ctx, action, items, params):
    return {"status": "refused", "message": "This app has no actions."}
'''


class AppReleases:
    """Preview: a content-addressed release folder (plugin.json, program.py, ui/ + bundle.lock.json) under
    <data>/create/previews/<digest>; its files are served to the canvas only after the lock verifies (sandbox_run
    verify_bundle, as programs.ui_bundle does). Deploy: the same release copied to <data>/create/apps/<id> and loaded
    with programs.reload_one, then turned on where Create is for the person who made it (turn_on); refused (definite)
    if that folder is not on HIVE_PLUGIN_DIRS."""

    def __init__(self, engine, root=None):
        self.engine, self.hive = engine, engine.hive
        self.root = pathlib.Path(root) if root else pathlib.Path(self.hive.settings.data_dir) / "create"

    def _app_id(self, run, plan):
        """One app per plan, named by the plan's full id (never a short suffix that two plans could share). Program ids
        are at most 41 characters (programs.py), so the title goes in the app's name, not its id."""
        app_id = f"create-{run['plan_id'][5:]}"
        if not APP_ID.fullmatch(app_id):
            raise ValueError("not an app id")
        return app_id

    def _release(self, folder, files, app_id, title):
        ui = folder / "ui"
        ui.mkdir(parents=True, exist_ok=True)
        lock = {"files": {}}
        for name in sorted(bundle_files(files)):     # every app file, path-checked again before anything is written
            raw = files[name].encode("utf-8")
            target = (ui / name).resolve()
            if ui.resolve() not in target.parents:
                raise ValueError(f"not a safe app file path: {name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            lock["files"][name] = hashlib.sha256(raw).hexdigest()
        lock["assets"] = sorted(n for n in lock["files"] if n not in UI_FILES)   # served by programs.ui_bundle too
        (ui / "bundle.lock.json").write_text(json.dumps(lock, sort_keys=True))
        (folder / "plugin.json").write_text(json.dumps({
            "id": app_id, "name": title or app_id, "version": "0.1.0", "contract": "0.1",
            "description": "Made by a Create plan.", "module": "program.py", "capabilities": [], "icon": "spark",
            "placement": "swarm"}, indent=2))
        (folder / "program.py").write_text(PROGRAM_PY % {"title": title or app_id})

    def preview(self, run, files, plan):
        try:
            ui = bundle_files(files)
            frame_document(ui)
        except ValueError as exc:
            return {"failed": str(exc)}
        app_id = self._app_id(run, plan)
        digest = hashlib.sha256(json.dumps(ui, sort_keys=True).encode()).hexdigest()
        folder = self.root / "previews" / digest[:32]
        if not folder.exists():
            tmp = self.root / "previews" / f".{digest[:32]}.{new_id('x')[2:8]}"
            self._release(tmp, ui, app_id, (plan or {}).get("title"))
            tmp.rename(folder)
        from .programs import Programs
        return {"ref": f"preview-{digest[:32]}", "digest": "sha256:" + digest, "app_id": app_id,
                "source_digest": Programs.source_digest(folder)}

    def _verified(self, ref):
        from .sandbox_run import verify_bundle
        if not re.fullmatch(r"preview-[0-9a-f]{32}", ref or ""):
            raise ValueError("not a preview reference")
        folder = self.root / "previews" / ref[len("preview-"):]
        root = verify_bundle(str(folder), "ui")     # exactly the lock's files, each sha256-checked, no symlinks
        lock = json.loads((root / "bundle.lock.json").read_text())["files"]
        for name in lock:
            if not BUNDLE_PATH.fullmatch(name) or ".." in name.split("/"):
                raise ValueError(f"not a safe app file path: {name[:120]!r}")
        return root, lock

    def preview_files(self, ref):
        """The canvas's read: every file of the preview's bundle (index.html, style.css, app.js and any other file a
        piece built), each verified against the bundle's lock first."""
        root, lock = self._verified(ref)
        return {name: (root / name).read_text("utf-8") for name in sorted(lock)}

    def preview_file(self, ref, path):
        """One bundle file for the canvas: (bytes, content type, sha256 hex), verified against the lock, or None when
        the bundle has no such file. The path must be a bundle path exactly as the lock lists it."""
        root, lock = self._verified(ref)
        if not isinstance(path, str) or path not in lock:
            return None
        raw = (root / path).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != lock[path]:
            raise ValueError(f"bundle file changed: {path}")
        return raw, content_type(path), digest

    def readback(self, run, body, plan):
        """What happened to a deploy whose answer was unclear: {deployed: True, receipt} when the app is loaded from the
        Create apps folder with exactly the preview's interface; {deployed: False} when nothing is installed; else
        {deployed: None} (still unclear, read again later)."""
        preview = body.get("preview") or []
        ref = str(preview[1]) if isinstance(preview, list) and len(preview) == 2 else None
        app_id = self._app_id(run, plan)
        folder = self.root / "apps" / app_id
        if not folder.exists():
            return {"deployed": False, "app_id": app_id}
        entry = self.hive.programs.programs.get(app_id)
        try:
            want = self.preview_files(ref) if ref else None
            ui = self.hive.programs.ui_bundle(app_id)["files"] if entry and not entry.get("error") else None
            installed = self._installed(folder)
        except Exception:
            return {"deployed": None, "app_id": app_id}
        if ui is not None and want is not None and ui == want == installed:
            return {"deployed": True, "receipt": f"program-{(entry.get('digest') or '')[7:39]}", "program_id": app_id,
                    "digest": entry.get("digest")}
        return {"deployed": None, "app_id": app_id}

    @staticmethod
    def _installed(folder):
        """The installed app's whole bundle, verified against its lock (programs.ui_bundle serves the frame's three)."""
        from .sandbox_run import verify_bundle
        root = verify_bundle(str(folder), "ui")
        lock = json.loads((root / "bundle.lock.json").read_text())["files"]
        return {name: (root / name).read_text("utf-8") for name in sorted(lock)}

    def deploy(self, run, body, plan):
        preview = body.get("preview") or []
        ref = str(preview[1]) if isinstance(preview, list) and len(preview) == 2 else None
        if not ref:
            return {"refused": "no current preview"}
        try:
            files = self.preview_files(ref)
        except (ValueError, OSError) as exc:
            return {"refused": f"preview unreadable: {exc}"}
        apps = self.root / "apps"
        on_path = any(pathlib.Path(p).expanduser().resolve() == apps.resolve()
                      for p in filter(None, os.environ.get("HIVE_PLUGIN_DIRS", "").split(os.pathsep)))
        if not on_path:
            return {"refused": "the Create apps folder is not on this hive's plugin path (HIVE_PLUGIN_DIRS)"}
        app_id = self._app_id(run, plan)
        folder = apps / app_id
        tmp = apps / f".{app_id}.{new_id('x')[2:8]}"
        self._release(tmp, files, app_id, (plan or {}).get("title"))
        if folder.exists():                          # only this plan's own earlier install has this id
            old = apps / f".{app_id}.old.{new_id('x')[2:8]}"
            folder.rename(old)
            tmp.rename(folder)
            shutil.rmtree(old, ignore_errors=True)
        else:
            tmp.rename(folder)
        try:
            entry = self.hive.programs.reload_one(app_id)
        except Exception as exc:
            return {"unknown": f"installed but not loaded: {type(exc).__name__}"}
        if entry.get("error"):
            return {"refused": f"the hive did not load it: {entry['error']}"}
        return {"program_id": app_id, "digest": entry.get("digest"), "installed_at": now()}

    def turn_on(self, person, app_id):
        """A deployed app goes where Create is for the person who made it, so Open and their Apps list find it: each
        swarm Create is on in that they see (my_apps' own rule for a swarm app). Installed and loaded alone, an app is
        on in no swarm, so its Open said "This app isn't available to you here" under "It's in your Apps now" (v0.35
        rc1, a fresh Mac install). The write is the install-and-review act's own Use in (person_apps.review), an admin's,
        since the Apps page's turn-on (app_attachments.activate) takes only apps with attachment hooks and a Create app
        has no actions to attach. A member's app waits for an admin to turn it on, as any app does. Only a first deploy
        to a swarm turns it on there; a swarm where it already has a row (on, or turned off by an admin) keeps it.
        Returns the swarms it was newly turned on in. Time: one read of Create's activations, one swarm read each, one write per swarm."""
        from .my_apps import CREATE
        from .visibility import Viewer
        row = self.hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (person[5:],)) \
            if str(person).startswith("user:u_") else None
        if row is None or row["disabled"] or row["role"] != "admin":
            return []
        viewer = Viewer(person, True, audit=False)
        hidden = self.hive.visibility.hidden_ids(viewer)
        swarms = []
        for act in self.hive.db.all("SELECT swarm FROM app_activations WHERE program = ? AND active = 1 ORDER BY rowid",
                                    (CREATE,)):
            swarm = self.hive.db.one("SELECT * FROM swarms WHERE id = ?", (act["swarm"],))
            if swarm is None or swarm.get("archived_at") or not viewer.sees(swarm) or act["swarm"] in hidden:
                continue
            swarms.append(act["swarm"])
        # A swarm that already has a row keeps it: a redeploy must not turn back on an app an admin turned off there.
        added = []
        with self.hive.db.transaction():
            for sid in swarms:
                cur = self.hive.db.execute("INSERT INTO app_activations VALUES (?,?,1,?) ON CONFLICT(program,swarm) "
                                           "DO NOTHING", (app_id, sid, person))
                if cur.rowcount:
                    added.append(sid)
        for sid in added:
            self.hive.events.publish("program.activation", program=app_id, swarm_id=sid, active=True)
        return added


def HivePorts(engine):
    """Production: pieces are built by real per-change members (R3.14, Ports.members); the planner, test author and
    reviewers are goal calls; the space is OmegaCode; the check runs in the sandbox."""
    return Ports(engine, GoalMinds(engine), OmegaCodeSpace(engine), SandboxChecks(), AppReleases(engine))
