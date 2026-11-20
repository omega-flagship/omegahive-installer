# Purpose: tests of Create's play check: the probe grammar the host takes from a test author (probe_problem), the
# runner that plays a probe on an app's page (hive/plugins/create_acceptance_check/tools/probe.mjs, run here by Node as
# the sandbox runs it), how a case that waits on a piece not built yet is kept off the piece being built
# (create_plan_members.counted_check), and how the ports write a probe, refuse a bad one and play it on a checkpoint.
"""The play check (create_plan_ports.PROBE_PATH): a test author writes checks/probe.json, cases of steps and
assertions, and the runner plays each case on a fresh headless page of the app as the hive's frame composes it.

The apps here are small Create-shaped pages (index.html loading ./style.css and ./app.js as a module): a tic tac toe
that works, the same with a rule broken, the scaffold before anything is built, one that throws while it loads, one
that reads localStorage, one that asks the network, and boards wired in ways the app frame's CSP refuses, as written or
while they run. Production runs the runner in sandbox_run on the node runtime
(SandboxChecks.run_probe); here Node runs it directly in a fresh folder, as the Python check's tests run it in a
subprocess."""
import asyncio
import json
import pathlib
import re
import shutil
import subprocess
import sys

import pytest

from hive.core import create_plan_ports as cpp
from hive.core.create_plan_ports import PROBE_PATH, Ports, frame_document, parse_check_output, probe_problem
from hive.core.create_plan_members import counted_check

ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNNER = ROOT / "hive/plugins/create_acceptance_check/tools/probe.mjs"
NODE = shutil.which("node") or str(pathlib.Path(sys.base_prefix) / "bin" / "node")

PAGE = ('<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body>\n'
        '<h1>Tic tac toe</h1><p id="status">X to play</p>\n<div id="board">'
        + "".join(f'<button id="c{i}" class="cell"></button>' for i in range(9)) +
        '</div><button id="reset">New game</button>\n<script type="module" src="./app.js"></script></body></html>\n')
STYLE = "#board { display: grid; grid-template-columns: repeat(3, 3em); }\n.cell { height: 3em; }\n"
LINES = "[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]"
APP = """const cells = [...document.querySelectorAll('#board .cell')]
const status = document.querySelector('#status')
let board, turn, over
const lines = %s
function start() {
  board = Array(9).fill(''); turn = 'X'; over = false
  cells.forEach(c => { c.textContent = '' })
  status.textContent = 'X to play'
}
cells.forEach((cell, i) => cell.addEventListener('click', () => {
  if (over || board[i]) return
  board[i] = turn; cell.textContent = turn
  if (lines.some(l => l.every(k => board[k] === turn))) { status.textContent = turn + ' wins'; over = true; return }
  if (board.every(Boolean)) { status.textContent = 'A draw'; over = true; return }
  turn = turn === 'X' ? 'O' : 'X'; status.textContent = turn + ' to play'
}))
document.querySelector('#reset').addEventListener('click', start)
start()
""" % LINES
APP_NO_DRAW = APP.replace("  if (board.every(Boolean)) { status.textContent = 'A draw'; over = true; return }\n", "")
APP_THROWS = "throw new Error('the board is not ready')\n" + APP
SCAFFOLD = {"index.html": '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body>\n'
                          '<script type="module" src="./app.js"></script></body></html>\n',
            "style.css": "", "app.js": ""}
WORKING = {"index.html": PAGE, "style.css": STYLE, "app.js": APP}
OWNED = ["index.html", "style.css", "app.js"]


def clicks(*cells):
    return [{"kind": "click", "selector": f"#c{i}"} for i in cells]


# one case for each acceptance criterion, as the test author is asked to write them
PROBE = {"cases": [
    {"name": "Turns alternate", "files": ["app.js"], "steps": clicks(0, 4),
     "assertions": [{"kind": "text", "selector": "#c0", "expected": "X"}, {"kind": "text", "selector": "#c4", "expected": "O"},
                    {"kind": "contains", "selector": "#status", "expected": "X to play"}]},
    {"name": "X's top row wins and play stops", "files": ["app.js"], "steps": clicks(0, 3, 1, 4, 2, 5),
     "assertions": [{"kind": "text", "selector": "#status", "expected": "X wins"},
                    {"kind": "text", "selector": "#c5", "expected": ""}]},
    {"name": "A full board with no line is a draw", "files": ["app.js"], "steps": clicks(0, 1, 2, 4, 3, 5, 7, 6, 8),
     "assertions": [{"kind": "matches", "selector": "#status", "expected": "[Dd]raw"}]},
    {"name": "A taken square is refused", "files": ["app.js"], "steps": clicks(0, 0),
     "assertions": [{"kind": "text", "selector": "#c0", "expected": "X"}, {"kind": "contains", "selector": "#status", "expected": "O"}]},
    {"name": "New game clears the board", "files": ["app.js", "index.html"], "steps": clicks(0, 4) + [{"kind": "click", "selector": "#reset"}],
     "assertions": [{"kind": "count", "selector": "#board .cell", "expected": 9}, {"kind": "text", "selector": "#c0", "expected": ""},
                    {"kind": "visible", "selector": "#board", "expected": True}]},
]}


def play(files, probe=PROBE, owned=OWNED, tmp=None):
    """The runner on the page as the frame composes it, the way SandboxChecks.run_probe hands it over; its verdict
    read by the host's own parser."""
    try:
        document = frame_document(files)
    except ValueError as exc:
        document, probe = None, dict(probe, page_problem=str(exc))
    (tmp / "snapshot.json").write_text(json.dumps({"document": document, "probe": probe, "owned": owned}))
    proc = subprocess.run([NODE, str(RUNNER)], cwd=tmp, capture_output=True, text=True, timeout=120)
    return parse_check_output(proc.stdout, proc.returncode, proc.stderr)


@pytest.fixture()
def job(tmp_path):
    if not pathlib.Path(NODE).exists():
        pytest.fail("the play check's runner needs Node 22, which every install's toolchain has; none on this host")
    return tmp_path


# ---- the grammar the host takes -------------------------------------------------------------------------------------

def test_a_well_formed_probe_is_taken():
    assert probe_problem(PROBE) is None
    assert probe_problem({"cases": [{"name": "waits", "steps": [{"kind": "wait", "ms": 200}, {"kind": "wait", "selector": "#a"}],
                                     "assertions": [{"kind": "checked", "selector": "#b", "expected": False}]}]}) is None


@pytest.mark.parametrize("probe,says", [
    ([], 'a probe is {"cases": [...]}'),
    ({"cases": []}, "1-30 cases"),
    ({"cases": [{"name": "", "steps": [], "assertions": [{"kind": "text", "selector": "#a", "expected": "x"}]}]}, "a name"),
    ({"cases": [{"name": "n", "steps": [], "assertions": []}]}, "assertions is a list of 1-40"),
    ({"cases": [{"name": "n", "steps": [{"kind": "hover", "selector": "#a"}], "assertions": [{"kind": "text", "selector": "#a", "expected": "x"}]}]}, "kind is one of"),
    ({"cases": [{"name": "n", "steps": [{"kind": "fill", "selector": "#a"}], "assertions": [{"kind": "text", "selector": "#a", "expected": "x"}]}]}, "a fill needs value"),
    ({"cases": [{"name": "n", "steps": [{"kind": "click"}], "assertions": [{"kind": "text", "selector": "#a", "expected": "x"}]}]}, "a click needs a selector"),
    ({"cases": [{"name": "n", "steps": [{"kind": "wait", "ms": 9000}], "assertions": [{"kind": "text", "selector": "#a", "expected": "x"}]}]}, "ms from 0 to 3000"),
    ({"cases": [{"name": "n", "steps": [], "assertions": [{"kind": "count", "selector": "li", "expected": "8"}]}]}, "a whole number"),
    ({"cases": [{"name": "n", "steps": [], "assertions": [{"kind": "visible", "selector": "li", "expected": "yes"}]}]}, "true or false"),
    ({"cases": [{"name": "n", "files": "app.js", "steps": [], "assertions": [{"kind": "text", "selector": "#a", "expected": "x"}]}]}, "files is a list"),
])
def test_a_malformed_probe_is_refused_in_words_its_author_can_fix(probe, says):
    problem = probe_problem(probe)
    assert problem and says in problem, problem


# ---- the runner, playing real pages -----------------------------------------------------------------------------------

def test_a_working_game_passes_every_case(job):
    out = play(WORKING, tmp=job)
    assert out["outcome"] == "pass", out
    assert sum(line.endswith(": passed") for line in out["output"].splitlines()) == len(PROBE["cases"])


def test_a_broken_rule_fails_its_own_case_naming_the_files_it_exercises(job):
    out = play({**WORKING, "app.js": APP_NO_DRAW}, tmp=job)
    assert out["outcome"] == "fail" and out["failing"] == ["app.js"], out
    assert len(out["notes"]) == 1 and out["notes"][0].startswith("A full board with no line is a draw: check 1:"), out


def test_the_scaffold_is_red_on_every_case(job):
    out = play(SCAFFOLD, tmp=job)
    assert out["outcome"] == "fail" and set(out["failing"]) == {"app.js", "index.html"}, out
    assert len(out["notes"]) == len(PROBE["cases"])
    assert "nothing matches" in out["notes"][0]


def test_the_verdict_names_each_case_with_the_files_it_is_blamed_on_and_its_result(job):
    out = play({**WORKING, "app.js": APP_NO_DRAW}, tmp=job)
    assert [(c["name"], c["files"], c["passed"]) for c in out["cases"]] == [
        (c["name"], c["files"], c["name"] != "A full board with no line is a draw") for c in PROBE["cases"]]


# The frame's CSP (frame_document) runs only the nonce'd app.js and style.css: a board wired with onclick attributes,
# or with its logic in an inline script, is dead there, and happy-dom, which has no CSP, used to run both.
APP_GLOBALS = (APP.replace("cells.forEach((cell, i) => cell.addEventListener('click', () => {",
                           "window.play = cell => { const i = cells.indexOf(cell)")
                  .replace("}))\ndocument.querySelector('#reset').addEventListener('click', start)", "}\nwindow.start = start"))
ONCLICK = {"index.html": PAGE.replace('<button id="c', '<button onclick="play(this)" id="c')
                             .replace('<button id="reset"', '<button id="reset" onclick="start()"'),
           "style.css": STYLE, "app.js": APP_GLOBALS}
INLINE = {"index.html": PAGE.replace("</body>", "<script>" + APP + "</script></body>"), "style.css": STYLE, "app.js": ""}


def test_a_board_wired_with_onclick_attributes_fails_on_index_html_saying_listeners_belong_in_app_js(job):
    assert "window.play = cell =>" in APP_GLOBALS and "addEventListener" not in APP_GLOBALS
    out = play(ONCLICK, tmp=job)
    assert out["outcome"] == "fail" and "index.html" in out["failing"], out
    note = out["notes"][0]
    assert note.startswith("index.html as the app frame runs it: attach listeners in app.js with addEventListener"), note
    assert "onclick (10 times)" in note, note
    assert out["cases"][0] == {"name": "index.html as the app frame runs it", "files": ["index.html"], "passed": False}


def test_a_board_whose_logic_is_an_inline_script_fails_on_index_html_too(job):
    out = play(INLINE, tmp=job)
    assert out["outcome"] == "fail" and "index.html" in out["failing"], out
    assert "an inline <script>" in out["notes"][0] and out["notes"][0].startswith("index.html as the app frame runs it")


# What app.js adds while the page runs is held to the same CSP: the frame compiles no on* attribute however it got
# there, runs no script or style without its nonce and no javascript: URL, and builds no code from strings. Each
# refusal fails the file that holds it, so its repair goes to the piece that can make it: index.html for what its
# markup has, its templates included, and app.js for what it adds while it runs.
CELLS = "".join(f'<button id="c{i}" class="cell"></button>' for i in range(9))
INNER = {"index.html": PAGE.replace(CELLS, ""), "style.css": STYLE,
         "app.js": "document.querySelector('#board').innerHTML = [...Array(9).keys()]"
                   ".map(i => `<button id=\"c${i}\" class=\"cell\" onclick=\"play(this)\"></button>`).join('')\n"
                   + APP_GLOBALS + "document.querySelector('#reset').addEventListener('click', start)\n"}
SET_ATTRIBUTE = {**WORKING, "app.js": APP_GLOBALS + "cells.forEach(cell => cell.setAttribute('onclick', 'play(this)'))\n"
                                                    "document.querySelector('#reset').setAttribute('onclick', 'start()')\n"}
APP_PROPERTY = (APP.replace("cells.forEach((cell, i) => cell.addEventListener('click', () => {",
                            "cells.forEach((cell, i) => { cell.onclick = () => {")
                   .replace("}))\ndocument.querySelector('#reset').addEventListener('click', start)",
                            "} })\ndocument.querySelector('#reset').onclick = start"))
SCRIPTED = {**WORKING, "app.js": "const s = document.createElement('script')\ns.textContent = %s\ndocument.body.append(s)\n"
                                 % json.dumps(APP)}
STRING_CODE = {**WORKING, "app.js": APP_GLOBALS + "cells.forEach(cell => cell.addEventListener('click', new Function('play(this)')))\n"}
TEMPLATED = {"index.html": PAGE.replace(CELLS, "").replace(
                 "</body>", '<template id="cell"><button class="cell" onclick="play(this)"></button></template></body>'),
             "style.css": STYLE,
             "app.js": "for (let i = 0; i < 9; i++) {\n"
                       "  const cell = document.querySelector('#cell').content.firstElementChild.cloneNode(true)\n"
                       "  cell.id = 'c' + i\n  document.querySelector('#board').append(cell)\n}\n"
                       + APP_GLOBALS + "document.querySelector('#reset').addEventListener('click', start)\n"}
MIXED = {"index.html": INNER["index.html"].replace('<button id="reset"', '<button id="reset" onclick="start()"'),
         "style.css": STYLE,
         "app.js": INNER["app.js"].replace("document.querySelector('#reset').addEventListener('click', start)\n", "")}
FRAME_CASES = ("index.html as the app frame runs it", "app.js as the app frame runs it")


@pytest.mark.parametrize("board", [INNER, SET_ATTRIBUTE], ids=["innerHTML", "setAttribute"])
def test_a_board_app_js_wires_with_onclick_attributes_while_it_runs_fails_on_app_js_never_index_html(job, board):
    assert 'class="cell"' not in INNER["index.html"] and "addEventListener" not in SET_ATTRIBUTE["app.js"]
    out = play(board, tmp=job)
    assert out["outcome"] == "fail" and out["failing"] == ["app.js"], out
    note = out["notes"][0]
    assert note == ("app.js as the app frame runs it: attach listeners in app.js with addEventListener, since the app "
                    "frame's content security policy refuses onclick that app.js adds"), note
    assert out["cases"][0] == {"name": "app.js as the app frame runs it", "files": ["app.js"], "passed": False}
    assert [c["name"] for c in out["cases"]].count("index.html as the app frame runs it") == 0, out
    assert "PROBE the frame refuses while the page runs: onclick that app.js adds on <button#c" in out["output"], out


def test_an_onclick_in_a_template_index_html_holds_is_index_htmls_though_app_js_clones_it(job):
    out = play(TEMPLATED, tmp=job)
    assert out["outcome"] == "fail" and "index.html" in out["failing"], out
    assert out["notes"][0] == ("index.html as the app frame runs it: attach listeners in app.js with addEventListener, since "
                               "the app frame's content security policy refuses onclick"), out
    assert [c["name"] for c in out["cases"] if c["name"] in FRAME_CASES] == ["index.html as the app frame runs it"], out
    assert "the frame refuses while the page runs" not in out["output"], out


def test_a_page_whose_markup_and_app_js_both_add_onclick_fails_each_file_on_its_own_note(job):
    out = play(MIXED, tmp=job)
    assert out["outcome"] == "fail" and {"index.html", "app.js"} <= set(out["failing"]), out
    assert [c["name"] for c in out["cases"][:2]] == list(FRAME_CASES), out
    assert out["notes"][0].startswith("index.html as the app frame runs it: ") and out["notes"][0].endswith("refuses onclick")
    assert out["notes"][1].startswith("app.js as the app frame runs it: ") and out["notes"][1].endswith("onclick that app.js adds")


@pytest.mark.parametrize("app", [APP, APP_PROPERTY], ids=["addEventListener", "onclick property"])
def test_a_board_app_js_wires_with_listeners_or_on_properties_has_nothing_the_frame_refuses(job, app):
    assert "cell.onclick = () => {" in APP_PROPERTY and "addEventListener" not in APP_PROPERTY
    out = play({**WORKING, "app.js": app}, tmp=job)
    assert out["outcome"] == "pass", out
    assert "the frame ignores" not in out["output"] and "the frame refuses" not in out["output"], out


def test_a_script_app_js_adds_while_it_runs_is_refused_and_fails_app_js(job):
    out = play(SCRIPTED, tmp=job)
    assert out["outcome"] == "fail" and out["failing"] == ["app.js"], out
    assert out["notes"][0] == ("app.js as the app frame runs it: keep scripts in app.js, since the app frame's content "
                               "security policy refuses a <script> that app.js adds"), out


def test_a_board_that_builds_its_code_from_strings_fails_app_js_saying_so(job):
    out = play(STRING_CODE, tmp=job)
    assert out["outcome"] == "fail" and "app.js" in out["failing"], out
    assert out["notes"][0] == ("app.js as the app frame runs it: build no code from strings, since the app frame's "
                               "content security policy refuses eval or new Function"), out
    assert [c["name"] for c in out["cases"] if c["name"] in FRAME_CASES] == ["app.js as the app frame runs it"], out
    assert "Code generation from strings disallowed" in out["notes"][1], out


def test_what_the_frame_refuses_while_the_page_runs_never_runs_here_either(job):
    page = ('<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><p id="code">?</p>'
            '<script type="module" src="./app.js"></script></body></html>')
    app = """const said = []
for (const [name, run] of [['eval', () => eval('1')], ['new Function', () => new Function('return 1')()],
                           ['a function constructor', () => (() => {}).constructor('return 1')()],
                           ['WebAssembly', () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))]]) {
  try { run(); said.push(name + ' ran') } catch (e) { said.push(name + ' ' + e.name) }
}
document.querySelector('#code').textContent = said.join(', ')
setTimeout("document.body.dataset.timer = 'ran'", 0)
setInterval("document.body.dataset.interval = 'ran'", 10)
const style = document.createElement('style')
style.textContent = '#code { display: none }'
document.head.append(style)
document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="./more.css">')
document.body.insertAdjacentHTML('beforeend', '<a id="go" href="javascript:document.body.dataset.went = 1">go</a>')
"""
    probe = {"cases": [{"name": "as the frame runs it", "steps": [{"kind": "click", "selector": "#go"}, {"kind": "wait", "ms": 100}],
                        "assertions": [
                            {"kind": "text", "selector": "#code", "expected": "eval EvalError, new Function EvalError, "
                                                                              "a function constructor EvalError, WebAssembly CompileError"},
                            {"kind": "visible", "selector": "#code", "expected": True},
                            {"kind": "count", "selector": "body[data-timer], body[data-interval], body[data-went]", "expected": 0}]}]}
    out = play({"index.html": page, "style.css": "", "app.js": app}, probe=probe, tmp=job)
    assert out["outcome"] == "pass", out
    line = next(line for line in out["output"].splitlines() if line.startswith("PROBE the frame refuses while the page runs: "))
    for refused in ("a string passed to setTimeout", "a string passed to setInterval", "a <style> that app.js adds",
                    "a stylesheet <link> that app.js adds", "a javascript: URL that app.js opens"):
        assert refused in line, line


# take 5's shape: the board (index.html, style.css) is built before the game logic (app.js), and a case names every
# file it exercises, so its gameplay cases name app.js beside the page
BOARD_CASE = {"name": "The board has nine squares and a status", "files": ["index.html"], "steps": [],
              "assertions": [{"kind": "count", "selector": "#board .cell", "expected": 9},
                             {"kind": "visible", "selector": "#status", "expected": True}]}
SHARED = {"cases": [BOARD_CASE] + [dict(c, files=["app.js", "index.html"]) for c in PROBE["cases"]]}
BOARD = {"index.html", "style.css"}


def test_a_board_built_before_its_game_logic_is_not_blamed_for_the_cases_that_wait_on_it(job):
    out = counted_check(play({**WORKING, "app.js": ""}, probe=SHARED, tmp=job), BOARD)
    assert out["outcome"] == "fail" and out["failing"] == [] and out["notes"] == [], out
    assert out["waits"] == [f"{c['name']} waits on app.js" for c in PROBE["cases"]
                            if c["name"] != "New game clears the board"], out   # that one holds with no script


def test_a_failed_case_naming_only_built_files_still_counts(job):
    page = PAGE.replace('<button id="c8" class="cell"></button>', "")
    out = counted_check(play({**WORKING, "index.html": page, "app.js": ""}, probe=SHARED, tmp=job), BOARD)
    assert out["failing"] == ["index.html"] and len(out["notes"]) == 1, out
    assert out["notes"][0].startswith("The board has nine squares and a status: check 1:") and out["waits"], out


def test_the_last_pieces_run_and_a_check_without_cases_count_as_they_came(job):
    out = play({**WORKING, "app.js": ""}, probe=SHARED, tmp=job)
    assert counted_check(out, set(OWNED)) == out                         # every piece built: every case judged
    python = parse_check_output('CREATE-CHECK {"passed": false, "failing": ["index.html"], "notes": ["n"]}', 0)
    assert "cases" not in python and counted_check(python, set()) == python


def test_a_page_that_throws_while_it_loads_fails_with_the_error(job):
    out = play({**WORKING, "app.js": APP_THROWS}, tmp=job)
    assert out["outcome"] == "fail", out
    assert all("the page threw while loading: the board is not ready" in n for n in out["notes"]), out


def test_storage_and_the_network_are_refused_as_the_frame_refuses_them(job):
    page = '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><p id="s">?</p><p id="n">?</p>' \
           '<script type="module" src="./app.js"></script></body></html>'
    app = ("try { localStorage.getItem('k'); document.querySelector('#s').textContent = 'stored' }\n"
           "catch (e) { document.querySelector('#s').textContent = e.name }\n"
           "fetch('https://example.com/').then(() => { document.querySelector('#n').textContent = 'online' },\n"
           "  () => { document.querySelector('#n').textContent = 'offline' })\n")
    probe = {"cases": [{"name": "as the frame", "steps": [], "assertions": [
        {"kind": "text", "selector": "#s", "expected": "SecurityError"}, {"kind": "text", "selector": "#n", "expected": "offline"}]}]}
    out = play({"index.html": page, "style.css": "", "app.js": app}, probe=probe, tmp=job)
    assert out["outcome"] == "pass", out


def test_a_probe_the_runner_cannot_play_is_its_authors_fault_never_the_apps(job):
    probe = {"cases": [{"name": "bad selector", "steps": [], "assertions": [{"kind": "text", "selector": "#[", "expected": "x"}]}]}
    out = play(WORKING, probe=probe, tmp=job)
    assert out["outcome"] == "unknown" and out["reason"] == "no-verdict", out    # back to the author, not to a builder
    assert "is not a CSS selector" in out["output"]


@pytest.mark.parametrize("selector, names", [
    ("#tip-presets button:has-text('Quick 20%')", ":has-text"),   # base12's Quick 20% probe, held twice on a right build
    ("#status:text-is('X to play')", ":text-is"),                  # Playwright's
    ("#reset:visible", ":visible"),
    ("#board .cell:contains('X')", ":contains"),                   # jQuery's
    ("#reset:enabled", ":enabled"),                                # CSS's own, which happy-dom leaves unmatched
    ("#status::before", "::before"),
    ("#board .cell:hover:nth-match(.cell, 2)", ":hover and :nth-match"),
])
def test_a_selector_the_pages_browser_never_matches_is_its_authors_fault_never_the_apps(job, selector, names):
    # happy-dom answers these with no match where a browser refuses them, so the case would fail the app's files
    probe = {"cases": [{"name": "unmatched pseudo", "steps": [], "assertions": [{"kind": "count", "selector": selector, "expected": 1}]}]}
    out = play(WORKING, probe=probe, tmp=job)
    assert out["outcome"] == "unknown" and out["reason"] == "no-verdict", out    # back to the author, not to a builder
    assert f"uses {names}, which the page's browser never matches" in out["output"], out["output"]


@pytest.mark.parametrize("selector", ["#board .cell:first-child", "#board .cell:nth-child(5)", "#board:has(> .cell)",
                                      "button:not(:disabled):is(#reset)", "#c0:not([data-x='a:has-text(b)'])",
                                      "h1:first-of-type", "#board button:where(.cell):last-child"])
def test_selectors_naming_only_pseudo_classes_the_page_matches_are_played(job, selector):
    probe = {"cases": [{"name": "matched pseudo", "steps": [], "assertions": [{"kind": "count", "selector": selector, "expected": 1}]}]}
    out = play(WORKING, probe=probe, tmp=job)
    assert out["outcome"] == "pass", out


def test_the_runners_pseudo_classes_are_exactly_those_its_happy_dom_matches():
    # An upgrade of the vendored happy-dom that adds or drops a pseudo-class fails here, not in a tester's round: the
    # list is read from probe.mjs and the cases from the bundle's own matcher, up to its silent `default:return null`.
    bundle = (RUNNER.parent / "vendor/happy-dom.mjs").read_text()
    start = re.search(r"matchPseudoItem\([a-zA-Z,]*\)\{", bundle)
    assert start, "happy-dom's matchPseudoItem is gone: read its selector matcher again"
    body = bundle[start.end():bundle.index("default:return null}", start.end())]
    engine = set(re.findall(r'case"([a-z-]+)":', body))
    listed = RUNNER.read_text().split("const PSEUDO_CLASSES = new Set([", 1)[1].split("])", 1)[0]
    assert engine and set(re.findall(r"'([a-z-]+)'", listed)) == engine


def test_an_app_with_no_page_to_compose_fails_on_its_page_files(job):
    out = play({"index.html": "<p>no scripts</p>", "style.css": "", "app.js": ""}, tmp=job)
    assert out["outcome"] == "fail" and set(out["failing"]) == set(OWNED), out
    assert out["notes"][0].startswith("the page could not be loaded:"), out


# ---- the ports: what the test author's answer becomes, and the check run on a checkpoint ---------------------------

class Space:
    def __init__(self):
        self.ckpts, self.n = {}, 0

    async def write(self, run, files, label):
        self.n += 1
        self.ckpts[f"ck{self.n}"] = dict(files)
        return f"ck{self.n}"

    async def files(self, run, ckpt):
        return dict(self.ckpts[ckpt])


class Engine:
    def __init__(self):
        self.space = {}

    def _space_set(self, pid, **changes):
        self.space.update(changes)

    def _plan(self, pid):
        return {"pieces": [{"id": "page", "files": ["index.html", "style.css"]}, {"id": "app", "files": ["app.js"]}]}


class Checks:
    def __init__(self):
        self.probes = []

    async def run_probe(self, document, probe, owned):
        self.probes.append((document, probe, owned))
        return {"outcome": "pass"}


def ports():
    return Ports(Engine(), None, Space(), Checks(), None, members=object())   # no builds here: members unused


RUN = {"plan_id": "plan_t"}


def test_a_probe_answer_is_written_as_the_base_and_kept_for_the_builders():
    p = ports()
    out = asyncio.run(p.post(RUN, "author-tests", {}, {"by": "m", "files": {PROBE_PATH: PROBE}}))
    assert out["suite"] == PROBE_PATH and out["files"] == [PROBE_PATH], out
    assert json.loads(p.space.ckpts[out["base"]][PROBE_PATH]) == PROBE
    assert json.loads(p.engine.space["probe"]) == PROBE and p.engine.space["author_refusal"] is None
    # a probe sent as JSON text is the same answer
    again = asyncio.run(p.post(RUN, "author-tests", {}, {"by": "m", "files": {PROBE_PATH: json.dumps(PROBE)}}))
    assert again["suite"] == PROBE_PATH


def test_the_test_authors_goal_asks_for_the_probe_its_contract_describes():
    """The goal text a test author answers to ends with the answer's shape; on a fresh hive's first real tic-tac-toe
    (19 Nov) that shape still named checks/acceptance_check.py, so the author wrote three Python checks, each crashed on
    the scaffold, before it answered with the probe its contract asked for."""
    shape = cpp.ANSWER_SHAPES["author-tests"]
    assert PROBE_PATH in shape and cpp.CHECK_PATH not in shape and "python" not in shape.lower()


def test_a_bad_probe_is_refused_and_its_author_is_told_why_next_time():
    p = ports()
    out = asyncio.run(p.post(RUN, "author-tests", {}, {"by": "m", "files": {PROBE_PATH: {"cases": []}}}))
    assert "unknown" in out and "1-30 cases" in out["unknown"], out
    assert "1-30 cases" in p.engine.space["author_refusal"]
    other = asyncio.run(p.post(RUN, "author-tests", {}, {"by": "m", "files": {"checks/other.py": "x"}}))
    assert "unknown" in other and PROBE_PATH in p.engine.space["author_refusal"]


def test_the_check_run_plays_the_probe_on_the_candidates_page_with_the_plans_own_files():
    p = ports()
    base = asyncio.run(p.space.write(RUN, {**SCAFFOLD, PROBE_PATH: json.dumps(PROBE)}, "base"))
    cand = asyncio.run(p.space.write(RUN, {**WORKING, PROBE_PATH: "a builder's copy is never the judge"}, "cand"))
    out = asyncio.run(p.run_check(RUN, cand, PROBE_PATH, base))
    assert out == {"outcome": "pass"}
    document, probe, owned = p.checks.probes[0]
    assert probe == PROBE and owned == ["app.js", "index.html", "style.css"]
    assert document == frame_document(WORKING)      # the page as the frame composes it, the check's own copy excluded


def test_the_runner_is_in_the_bundle_lock_the_sandbox_checks():
    from hive.core import sandbox_run
    root = sandbox_run.verify_tool_bundle(str(ROOT / "hive/plugins/create_acceptance_check"), "tools")
    lock = json.loads((root / "bundle.lock.json").read_text())["files"]
    assert {"probe.mjs", "run.py", "vendor/happy-dom.mjs", "vendor/THIRD_PARTY_LICENSES.txt"} == set(lock)
    assert cpp.PROBE_CASES == 30 and "MAX_CASES = 30" in RUNNER.read_text()    # one limit, the runner's and the host's
