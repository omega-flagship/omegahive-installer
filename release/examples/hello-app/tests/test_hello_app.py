"""hello-app passes the program contract checker, and its view and actions are valid.

Run from the repository root:  python -m pytest -q examples/hello-app/tests
No hive, no network and no PeTTa are needed.
"""

import importlib.util
import pathlib
import sys

APP = pathlib.Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hive.core.programs import STAGES, Programs, validate_graph, validate_result  # noqa: E402
from hive.programs_check import CheckError, StubContext, check  # noqa: E402


def _fresh_program():
    """A new copy of program.py, so each test starts from the seeded store."""
    spec = importlib.util.spec_from_file_location("hello_app_under_test", APP / "program.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_checker_says_compatible():
    lines = []
    assert check(APP, log=lines.append) is True
    assert any("inspect-source returns" in line for line in lines)


def test_checker_scenario_passes():
    assert check(APP, log=lambda _line: None, scenario=True) is True


def test_view_is_valid_in_every_stage():
    program = _fresh_program()
    desc = Programs._check_description(program.describe())
    for stage in STAGES:
        graph = validate_graph("hello-app", desc, program.view(StubContext(), None, stage), stage, CheckError)
        assert graph["revision"] == "r1"
        assert {i["id"] for i in graph["items"]} == {"q1", "c1", "e1", "e2"}


def test_add_note_asks_for_text_then_adds_one_item():
    program = _fresh_program()
    desc = Programs._check_description(program.describe())
    ctx = StubContext()

    asked = validate_result("hello-app", desc, program.act(ctx, "add-note", ["c1"], {"base_revision": "r1"}), CheckError)
    assert asked["status"] == "needs_input"

    done = validate_result("hello-app", desc, program.act(ctx, "add-note", ["c1"], {
        "text": "Try it with honey", "base_revision": "r1"}), CheckError)
    assert done["status"] == "done"
    assert done["graph"]["revision"] == "r2"
    assert "n1" in {i["id"] for i in done["graph"]["items"]}

    stale = validate_result("hello-app", desc, program.act(ctx, "add-note", ["c1"], {
        "text": "again", "base_revision": "r1"}), CheckError)
    assert stale["status"] == "stale"


def test_unknown_items_and_actions_are_refused():
    program = _fresh_program()
    desc = Programs._check_description(program.describe())
    ctx = StubContext()
    for action, items in (("add-note", ["nope"]), ("delete-everything", ["q1"])):
        out = validate_result("hello-app", desc, program.act(ctx, action, items, {"text": "x"}), CheckError)
        assert out["status"] == "refused"


def test_hive_plugin_dirs_finds_and_loads_it(monkeypatch):
    """The host discovers the app through HIVE_PLUGIN_DIRS and loads it without an error (no hive is started).
    This reaches into Programs' loading helpers (hive/core/programs.py _dirs, _folders, _load), not a public API."""
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(APP))
    programs = object.__new__(Programs)
    found = [(folder, source) for folder, source in programs._folders() if folder == APP]
    assert found == [(APP, "plugin-dir")]
    entry = programs._load(APP, APP / "plugin.json", "plugin-dir")
    assert entry["error"] is None
    assert entry["id"] == "hello-app"
    assert entry["capabilities"] == []
