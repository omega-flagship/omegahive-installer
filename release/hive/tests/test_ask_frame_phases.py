# Purpose: check that the page reads every frame the host stores in an Ask turn: each phase by name, and a research
# hand-over turn's frames, live and as a personal turn stores them, exactly as the page's tests play them.
"""A turn's frames share one seq (Ask._frame). The page applies them strictly in order and holds everything after a
frame it has not placed (hive/ui/src/store/ask.ts accept), so a phase its checkAskEvent did not know was once dropped
like a lost frame: on v0.31 every hand-over's intent frame was, and the answer after it showed as incomplete. The page
now keeps an unknown phase's place but reads nothing of it, so this test keeps the host's phases and the page's cases
together."""
import ast
import json
import pathlib
import re

import pytest

from hive.core.ask import Ask
from hive.tests.test_ask_conductor import on  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_research_request import _claim_and_fetch, _finish, dispatch_research, report, row_of

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHECKER = ROOT / "hive" / "ui" / "src" / "api" / "ask.ts"
# a research hand-over turn's frames as the page's tests play them (hive/ui/src/store/ask.test.ts)
FIXTURE = ROOT / "hive" / "ui" / "src" / "store" / "handOver.fixture.json"
# keys whose values differ from run to run: ids stand in by order of first sight, times and spends by one value
IDS = ("operation_id", "turn_id", "intent_id", "dispatch_id", "request_id", "goal_id", "message_id", "id", "ref", "mind_id")
TIME, SPENT = "2026-11-16T05:23:00Z", 0.01


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    yield


def host_phases():
    """{phase: where} for every literal phase passed to Ask._frame or to the conductor's _emit(st, "phase", ...): a call
    through the Ask (self.ask._frame, self.hive.ask._frame), the Ask's own self._frame, or the conductor's own
    self._emit. Other classes' own _frame and _emit take something else second: Intents._frame an intent id, never a
    literal, and Research._frame a research request's state ("held", "resumed"), which reaches the page inside the
    Ask's "research" frame it forwards. Time: one parse of each hive/core module."""
    own = {"_frame": "Ask", "_emit": "Conductor"}
    phases = {}

    def visit(node, path, cls):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                visit(child, path, child.name)
                continue
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute) and child.func.attr in own \
                    and len(child.args) >= 2 and isinstance(child.args[1], ast.Constant) \
                    and isinstance(child.args[1].value, str):
                receiver = child.func.value
                through_ask = isinstance(receiver, ast.Attribute) and receiver.attr == "ask"
                own_method = isinstance(receiver, ast.Name) and receiver.id == "self" and cls == own[child.func.attr]
                if through_ask or own_method:
                    phases.setdefault(child.args[1].value, f"{path.name}:{child.lineno}")
            visit(child, path, cls)

    for path in sorted((ROOT / "hive" / "core").glob("*.py")):
        visit(ast.parse(path.read_text(), str(path)), path, None)
    return phases


def page_phases():
    """The phases checkAskEvent has a case for (its switch on f.phase)."""
    source = CHECKER.read_text()
    body = source[source.index("export function checkAskEvent"):]
    body = body[:body.index("\nexport function", 1)]
    return set(re.findall(r"case '([a-z_-]+)':", body))


def test_every_phase_the_host_stores_in_a_turn_is_one_the_page_reads():
    host = host_phases()
    # the scan sees a hand-over turn's frames, a direct link and the report that comes back after done
    assert {"accepted", "intent", "dispatched", "answer", "done", "link", "research"} <= set(host)
    missing = {phase: where for phase, where in host.items() if phase not in page_phases()}
    assert missing == {}, f"the host stores these phases and the page's checkAskEvent has no case for them: {missing}"


def stand_in(frames):
    """The frames with what differs from run to run replaced: each distinct id by key and order of first sight (the
    same id twice is the same stand-in twice), every time (a key `at` or ending in _at), every spend, and a spawned
    mind's random name suffix."""
    seen = {}

    def walk(v, key=None):
        if isinstance(v, dict):
            return {k: walk(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x, key) for x in v]
        if key in IDS and isinstance(v, str):
            return seen.setdefault(v, f"{key.replace('_', '-')}-{sum(1 for x in seen.values() if x.startswith(key.replace('_', '-') + '-')) + 1}")
        if key and (key == "at" or key.endswith("_at")) and v is not None:
            return TIME
        if key and key.endswith("spent_usd") and v is not None:
            return SPENT
        if key == "name" and isinstance(v, str) and re.fullmatch(r".+ [0-9a-f]{4}", v):
            return v[:-4] + "0000"   # a spawned mind's name ends in four random hex digits (Minds.spawn)
        return v
    return walk(frames)


def hand_over(client, on, monkeypatch):
    """A research hand-over turn, start to report: Ann asks, the scripted conductor dispatches research.request, the
    researcher finishes with one cited claim and one uncited. Its frames as the bus delivers them to Ann's page (live:
    Events.publish adds type and its own at) and as stored, in seq order."""
    hive = on["hive"]
    # research spends under the hive's total, the one cap its owner sets, and nothing of its own, as a hive with a key
    # starts with one (HIVE_START_LIMIT_MONTH_USD): test_research_request's hive_total, which this module doesn't run
    hive.budgets.set("hive", "month", 1000)
    published, real = [], hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **f: (published.append((kind, f)), real(kind, **f))[1])
    dispatch_research(client, on)
    row = row_of(hive)
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids"])
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": fetched[0]["fetched_at"],
                                                "title": fetched[0]["title"]}, {"url": "https://example.org/never-fetched",
                                                                               "fetched_at": fetched[0]["fetched_at"]}))
    live = sorted((dict(type=kind, at=TIME, **f) for kind, f in published if kind == "ask" and f.get("operation_id") == "op-res-001"),
                  key=lambda f: f["seq"])
    turn = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-res-001'")
    stored = [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (turn["id"],))]
    return live, stored


def test_a_research_hand_over_turn_is_the_frames_the_pages_tests_play(client, on, monkeypatch):
    """The page's store tests play a hand-over from this fixture: live as Ann's page receives it, and stored as a
    personal turn keeps it (Ask.content_free, which the host applies at store time to a personal turn's frames). If the
    hive changes a frame of this turn, this test fails until the fixture, and so the page's tests, follow it."""
    live, stored = hand_over(client, on, monkeypatch)
    fixture = json.loads(FIXTURE.read_text())
    assert [f["phase"] for f in live] == [f["phase"] for f in stored]
    assert stand_in(live) == fixture["live"]
    assert stand_in([Ask.content_free(f) for f in stored]) == fixture["stored"]
