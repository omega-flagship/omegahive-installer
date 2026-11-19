# Purpose: tests the hive's side of feedback and bug reports (hive/core/feedback.py and its routes): the one destination
# setting, the release or build and hive a report names, every error answer's id kept with the person who met it and
# its words with no key id or person of the hive, the unexpected error answered by id, the board's visibility check,
# the hand-off to a report service, and what the logs a person exports hold from the hive: their requests and errors,
# or an admin's whole hive's with its own log lines and
# other people's error answers by where and how they failed only, every message cleaned by the hive as it keeps it with
# the page's own rules (hive/core/redact.py clean, case for case with report.ts).
import asyncio
import http.server
import io
import json
import logging
import pathlib
import re
import secrets
import threading
import urllib.error

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from hive.core import feedback as fb
from hive.core import updates as updates_mod
from hive.core.hive import HiveError
from hive.core import redact
from hive.tests.test_core_api import client  # noqa: F401  (fixture: local operator)
from hive.tests.test_visibility import person

# the cases the page's redact runs too (report.test.ts), so the hive and the page clean a line alike
SHARED_CASES = json.loads((pathlib.Path(__file__).resolve().parents[1] / "ui/src/features/feedback/redact.cases.json").read_text())["cases"]


@pytest.mark.parametrize("raw, want", [
    (None, {"kind": "board", "owner": "omega-flagship", "repo": "omegahive-feedback"}),
    ("https://github.com/acme/board", {"kind": "board", "owner": "acme", "repo": "board"}),
    ("https://github.com/acme/board.git/", {"kind": "board", "owner": "acme", "repo": "board"}),
    ("https://reports.example.org/in", {"kind": "service", "host": "reports.example.org"}),
    ("http://127.0.0.1:9000/in", {"kind": "service", "host": "127.0.0.1"}),
    ("none", {"kind": "none"}),
    ("", {"kind": "none"}),
    ("http://reports.example.org/in", {"kind": "invalid"}),
    ("https://github.com/acme/board/issues", {"kind": "invalid"}),
    ("https://github.com/acme", {"kind": "invalid"}),
    ("reports.example.org", {"kind": "invalid"}),
])
def test_the_destination_is_one_setting_read_whole(raw, want):
    got = fb.destination(raw)
    assert {k: got.get(k) for k in want} == want, got
    if got["kind"] == "invalid":
        assert got["reason"]   # said, never dropped


def test_the_setting_is_the_hives_own_line_else_the_releases_else_the_board(tmp_path):
    # a release built without FEEDBACK_TO, and a hive.env that sets nothing (an empty line sets nothing either)
    assert fb.configured(None, tmp_path) is None
    assert fb.configured("", tmp_path) is None
    assert fb.destination(fb.configured(None, tmp_path))["url"] == fb.BOARD
    # a release built with one: every hive that takes it reports there
    (tmp_path / "FEEDBACK_TO").write_text("https://reports.example.org/hive\n")
    assert fb.configured(None, tmp_path) == "https://reports.example.org/hive"
    assert fb.configured(" ", tmp_path) == "https://reports.example.org/hive"
    # the hive's own line wins, none included
    assert fb.configured("none", tmp_path) == "none"
    assert fb.configured("https://github.com/acme/board", tmp_path) == "https://github.com/acme/board"


def test_a_report_names_the_release_or_the_build():
    release = {"version": "0.31", "commit": "f9648d4386aa77"}
    assert fb.version_line("Mac", release, None) == "Mac v0.31 (build f9648d4386)"
    assert fb.version_line("Windows", {"version": None, "commit": "c09333acbaff"}, None) == "Windows build c09333acba"
    assert fb.version_line("Linux", None, "5b1290bfc5503a4f") == "build 5b1290bfc5"
    assert fb.version_line("Linux", None, None) == "build unknown"
    assert fb.which_hive("Mac", release, "http://127.0.0.1:8700") == "own hive, Mac install"
    assert fb.which_hive("Linux", None, "https://staging.example.org") == "the hive at staging.example.org"
    assert fb.which_hive("Linux", None, "http://127.0.0.1:8700") == "a hive run from source on Linux"


def test_the_context_names_the_release_an_installed_hive_was_laid_out_from(client, monkeypatch, tmp_path):
    """An installed hive runs a release folder, no git checkout: its report names the release by the RELEASE_COMMIT and
    RELEASE_VERSION the release builder wrote beside hive/, as the hive read them at start (Updates.running_release)."""
    hive = client.app.state.hive
    monkeypatch.setattr(fb, "system_name", lambda: "Mac")
    assert "install" not in client.get("/api/feedback").json()["which"]     # this checkout has neither file
    (tmp_path / "RELEASE_COMMIT").write_text("f9648d4386aa77\n")
    (tmp_path / "RELEASE_VERSION").write_text("0.31\n")
    monkeypatch.setattr(updates_mod, "ROOT", tmp_path)
    monkeypatch.setattr(hive, "updates", updates_mod.Updates(hive))      # a hive started from that folder
    ctx = client.get("/api/feedback").json()
    assert ctx["version"] == "Mac v0.31 (build f9648d4386)" and ctx["which"] == "own hive, Mac install"
    (tmp_path / "RELEASE_COMMIT").write_text("")
    assert updates_mod._release() is None       # an empty RELEASE_COMMIT names no release


def test_every_error_answer_has_an_id_kept_with_the_person_who_met_it(client):
    ana, ben = person(client, "u_ana"), person(client, "u_ben")
    r = client.get("/api/swarms/no-such-swarm", headers=ana)
    assert r.status_code == 404
    error_id = r.headers[fb.ERROR_ID_HEADER]
    assert error_id.startswith("e-") and len(error_id) == 10
    assert "id" not in r.json()["error"]     # in the header: no answer's body changes
    mine = client.get("/api/feedback", headers=ana).json()["errors"]
    assert mine[0]["id"] == error_id and mine[0]["status"] == 404 and mine[0]["code"] == r.json()["error"]["code"]
    # by the route's pattern, so no id from the address is kept
    assert mine[0]["route"] == "/api/swarms/{swarm_id}" and mine[0]["method"] == "GET"
    assert "principal" not in mine[0]
    assert error_id not in [e["id"] for e in client.get("/api/feedback", headers=ben).json()["errors"]]


def test_an_unknown_thing_and_a_hidden_one_still_answer_alike(client):
    ana, ben = person(client, "u_ana"), person(client, "u_ben")
    private = client.post("/api/swarms", headers=ana, json={"name": "Ana's"}).json()
    hidden, unknown = client.get(f"/api/swarms/{private['id']}", headers=ben), client.get("/api/swarms/s_unknown", headers=ben)
    assert hidden.status_code == unknown.status_code == 404 and hidden.json() == unknown.json()
    assert hidden.headers[fb.ERROR_ID_HEADER] != unknown.headers[fb.ERROR_ID_HEADER]   # random: they say nothing


def test_an_answer_to_nobody_signed_in_is_kept_with_nobody(client):
    r = client.get("/api/swarms", headers={"Authorization": "Bearer not-a-session"})
    assert r.status_code == 401 and r.headers[fb.ERROR_ID_HEADER].startswith("e-")
    assert r.headers[fb.ERROR_ID_HEADER] not in [e["id"] for e in client.get("/api/feedback").json()["errors"]]


def test_a_person_sees_only_their_most_recent_errors_newest_first(client):
    ana = person(client, "u_ana")
    ids = [client.get(f"/api/swarms/missing-{i}", headers=ana).headers[fb.ERROR_ID_HEADER] for i in range(fb.REPORT_ERRORS + 3)]
    shown = [e["id"] for e in client.get("/api/feedback", headers=ana).json()["errors"]]
    assert shown == list(reversed(ids))[:fb.REPORT_ERRORS]


def test_an_unexpected_error_is_answered_by_its_id_and_located_for_the_report(client, monkeypatch, caplog):
    hive = client.app.state.hive

    def broken(*_):    # whatever /api/hive passes (on some lines the viewer the summary is for)
        raise KeyError("missing_field")
    monkeypatch.setattr(hive, "summary", broken)
    quiet = TestClient(client.app, raise_server_exceptions=False)
    quiet.headers.update(client.headers)
    r = quiet.get("/api/hive")
    assert r.status_code == 500
    error_id = r.headers[fb.ERROR_ID_HEADER]
    assert r.json() == {"error": {"code": "internal_error", "message": "The hive hit an error it did not expect."}}
    assert "KeyError" not in r.text and "missing_field" not in r.text    # never the hive's insides on the page
    assert any(error_id in rec.getMessage() for rec in caplog.records)    # the log line the id points at
    kept = next(e for e in client.get("/api/feedback").json()["errors"] if e["id"] == error_id)
    assert kept["raised"].startswith("KeyError at hive/tests/test_feedback.py:") and kept["raised"].endswith("in broken")


def test_what_is_kept_of_an_answer_names_no_key_or_person_of_this_hive(client, monkeypatch):
    """GET /api/feedback answers the kept words on a 200, which the key projection does not rewrite, and a report leaves
    the hive: so a refusal's key ids, key scopes and people are kept taken out, for an admin, whose own answer names
    them, and for a member, whose answer the projection already cleaned."""
    hive = client.app.state.hive
    said = "key:k_0000b0b1 has spent its month; user:u_bob set the limit on env:openrouter"

    def refused(*_):
        raise HiveError(403, "budget_exceeded", said)
    monkeypatch.setattr(hive, "summary", refused)
    ana = person(client, "u_ana")
    for headers in (client.headers, ana):
        r = client.get("/api/hive", headers=headers)
        assert r.status_code == 403
        kept = next(e for e in client.get("/api/feedback", headers=headers).json()["errors"] if e["id"] == r.headers[fb.ERROR_ID_HEADER])
        assert kept["message"] == "key has spent its month; someone set the limit on a key"
    assert "k_0000b0b1" not in r.text and "u_bob" not in r.text      # the member's own answer named neither


class _Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _board(monkeypatch, answer):
    """A Feedback for the default board whose GitHub check answers `answer` (bytes, an HTTP status, or an OSError)."""
    def urlopen(req, timeout):
        assert req.full_url == "https://api.github.com/repos/omega-flagship/omegahive-feedback" and timeout == fb.BOARD_TIMEOUT_S
        if isinstance(answer, int):
            raise urllib.error.HTTPError(req.full_url, answer, "status", {}, None)
        if isinstance(answer, OSError):
            raise answer
        return _Answer(answer)
    monkeypatch.setattr(fb.urllib.request, "urlopen", urlopen)

    class Settings:
        offline = False
        public_url = "http://127.0.0.1:8700"

    class Hive:
        settings = Settings()
    return fb.Feedback(Hive(), None)


@pytest.mark.parametrize("answer, public", [
    (b'{"private": false, "visibility": "public"}', True),
    (b'{"private": true}', False),
    (404, False),          # private: GitHub answers 404 to anyone who cannot see it
    (503, None),           # not known
    (OSError("offline"), None),
])
def test_the_board_is_offered_once_github_answers_it_as_public(monkeypatch, answer, public):
    f = _board(monkeypatch, answer)
    f._check_board()
    assert f._board_public is public and not f._board_checking


def test_the_board_check_runs_in_the_background_and_is_kept_fresh(monkeypatch):
    f = _board(monkeypatch, b'{"private": false}')
    started = []
    monkeypatch.setattr(fb.threading, "Thread", lambda target, **kw: type("T", (), {"start": lambda self: started.append(target)})())
    assert f.board_public() is None and len(started) == 1      # the first read starts a check and waits for nothing
    assert f.board_public() is None and len(started) == 1      # one check at a time
    started[0]()
    assert f.board_public() is True and len(started) == 1      # fresh: not asked again
    f._board_checked -= fb.BOARD_FRESH_S + 1
    assert f.board_public() is True and len(started) == 2      # stale: the last answer stands while it is asked again


def _report(**over):
    report = {"schema": "omega-hive-report-1", "id": "HR-1a2b3c4d", "kind": "bug", "title": "The Ask stopped",
              "text": "Omega report HR-1a2b3c4d · bug · The Ask stopped\nSummary: it stopped\nOriginal feedback ID: HR-1a2b3c4d",
              "fields": {"summary": "it stopped"}, "form": "bug_report.yml", "picture": None}
    report.update(over)
    return report


class _Service(http.server.BaseHTTPRequestHandler):
    got: list = []
    status = 201

    def do_POST(self):
        _Service.got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        body = json.dumps({"reference": "FB-200"}).encode()
        self.send_response(_Service.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture()
def service():
    server = http.server.HTTPServer(("127.0.0.1", 0), _Service)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _Service.got, _Service.status = [], 201
    yield f"http://127.0.0.1:{server.server_address[1]}/reports"
    server.shutdown()


def test_a_report_service_gets_the_report_as_the_person_saw_it(client, service):
    hive = client.app.state.hive
    hive.feedback.to = fb.destination(service)
    report = _report(picture="data:image/png;base64,iVBORw0KGgo=")
    r = client.post("/api/feedback/send", json=report)
    assert r.status_code == 200, r.text
    assert r.json() == {"sent": True, "to": "127.0.0.1", "reference": "FB-200"}
    assert _Service.got == [report]     # passed on as it is: nothing added, nothing taken out


def test_a_service_that_refuses_is_said_not_hidden(client, service):
    client.app.state.hive.feedback.to = fb.destination(service)
    _Service.status = 500
    r = client.post("/api/feedback/send", json=_report())
    assert r.status_code == 502 and r.json()["error"]["code"] == "report_not_delivered"
    assert "answered 500" in r.json()["error"]["message"]


@pytest.mark.parametrize("over, problem", [
    ({"schema": "v0"}, "schema"), ({"id": "FB-001"}, "id"), ({"kind": "rant"}, "kind"), ({"text": " "}, "text"),
    ({"fields": {"summary": 3}}, "fields"), ({"picture": "https://example.org/x.png"}, "picture"),
])
def test_a_report_the_hive_would_not_pass_on_is_refused(client, service, over, problem):
    client.app.state.hive.feedback.to = fb.destination(service)
    r = client.post("/api/feedback/send", json=_report(**over))
    assert r.status_code == 400 and problem in r.json()["error"]["message"]
    assert _Service.got == []


def test_without_a_report_service_nothing_is_sent(client):
    assert client.app.state.hive.feedback.to["kind"] == "board"
    r = client.post("/api/feedback/send", json=_report())
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_report_service"


def test_a_report_too_large_is_refused_before_it_is_read_whole(client, service):
    client.app.state.hive.feedback.to = fb.destination(service)
    huge = _report(picture="data:image/png;base64," + "A" * fb.SEND_MAX_BYTES)
    assert client.post("/api/feedback/send", json=huge).status_code == 413
    assert _Service.got == []


# ---- the logs a person exports (GET /api/feedback/logs) ------------------------------------------------------------

def test_each_request_is_kept_with_the_person_who_made_it_by_route_and_status(client):
    ana, ben = person(client, "u_ana"), person(client, "u_ben")
    client.get("/api/swarms/s_no_such_swarm", headers=ana)
    logs = client.get("/api/feedback/logs", headers=ana).json()
    assert logs["scope"] == "person" and logs["log"] == [] and logs["version"] and logs["which"]
    line = next(r for r in logs["requests"] if r["route"] == "/api/swarms/{swarm_id}")
    assert (line["method"], line["status"], line["count"], line["who"]) == ("GET", 404, 1, "you") and line["ms"] >= 0
    assert logs["errors"][0]["route"] == "/api/swarms/{swarm_id}" and logs["errors"][0]["status"] == 404
    bens = client.get("/api/feedback/logs", headers=ben).json()
    assert "/api/swarms/{swarm_id}" not in [r["route"] for r in bens["requests"]] and bens["errors"] == []   # Ana's are hers


def test_a_run_of_one_request_answered_alike_is_one_line_with_its_count(client):
    ana = person(client, "u_ana")
    for _ in range(3):
        client.get("/api/swarms", headers=ana)
    client.get("/api/swarms/s_missing", headers=ana)
    requests = client.get("/api/feedback/logs", headers=ana).json()["requests"]
    assert [(r["route"], r["status"], r["count"]) for r in requests[:2]] == [("/api/swarms/{swarm_id}", 404, 1), ("/api/swarms", 200, 3)]


def test_nothing_kept_names_an_id_a_query_or_a_body(client):
    ana = person(client, "u_ana")
    secret = secrets.token_urlsafe(32)
    client.get(f"/api/swarms/s_{secret[:12]}?code={secret}", headers=ana)
    client.post("/api/swarms", headers=ana, json={"name": f"Ana's {secret}"})
    client.get(f"/api/no-such-place/{secret}/x", headers=ana)   # no route: the path's first two parts
    logs = client.get("/api/feedback/logs", headers=ana).json()
    assert secret not in json.dumps(logs) and secret[:12] not in json.dumps(logs)
    assert {"/api/swarms/{swarm_id}", "/api/swarms"} <= {r["route"] for r in logs["requests"]}
    # no route ran, so no session was looked up: it is kept with no one, and only the admin's whole hive shows it
    whole = client.get("/api/feedback/logs").json()
    assert secret not in json.dumps(whole)
    assert {"route": "/api/no-such-place/…", "status": 404, "who": "no session"}.items() <= next(
        r for r in whole["requests"] if r["route"] == "/api/no-such-place/…").items()


def test_an_admins_logs_hold_the_whole_hive_and_its_log_lines_a_persons_only_their_own(client):
    ana = person(client, "u_ana")
    marker = "logs-test-" + secrets.token_hex(4)
    client.get("/api/swarms/s_gone", headers=ana)
    logging.getLogger("hive").warning("free inference: %s still answered 429", marker)
    logging.getLogger("hive").info("%s is only information", marker)
    whole = client.get("/api/feedback/logs").json()
    assert whole["scope"] == "hive"
    assert any(r["route"] == "/api/swarms/{swarm_id}" and r["who"] == "another person" for r in whole["requests"])
    assert any(e["route"] == "/api/swarms/{swarm_id}" and e["who"] == "another person" for e in whole["errors"])
    mine = [line for line in whole["log"] if marker in line["message"]]
    assert [(line["level"], line["logger"], line["message"]) for line in mine] == [("WARNING", "hive", f"free inference: {marker} still answered 429")]
    theirs = client.get("/api/feedback/logs", headers=ana).json()
    assert theirs["scope"] == "person" and theirs["log"] == [] and {r["who"] for r in theirs["requests"]} == {"you"}


def _met(client, principal, message, route="/api/spaces", status=409, code="conflict"):
    """An error answer the hive kept for `principal` (None: no session), as noting it from a route would."""
    request = Request({"type": "http", "method": "POST", "path": route, "headers": []})
    return client.app.state.hive.feedback.noted(request, principal, status, code, message)


def test_another_persons_error_shows_in_an_admins_logs_by_where_and_how_it_failed_only(client):
    # Jon on #388: a private space named after someone's health notes reached the admin's file word for word
    ana = person(client, "u_ana")
    theirs = _met(client, "user:u_ana", "a space named Ana's health notes exists already")
    nobodys = _met(client, None, "no account for the address typed, ana.lopez@example.org", route="/api/signin", status=401, code="unauthorized")
    mine = client.get("/api/swarms/s_the_admins_own").headers[fb.ERROR_ID_HEADER]
    whole = client.get("/api/feedback/logs").json()
    assert "health notes" not in json.dumps(whole) and "ana.lopez" not in json.dumps(whole)
    by_id = {e["id"]: e for e in whole["errors"]}
    assert by_id[theirs] == {"id": theirs, "at": by_id[theirs]["at"], "method": "POST", "route": "/api/spaces", "status": 409,
                             "code": "conflict", "who": "another person"}
    assert set(by_id[nobodys]) == {*fb.OTHERS_ERROR, "who"} and by_id[nobodys]["who"] == "no session"
    # the admin's own keep their words; Ana's own logs keep hers, and say nothing of whose since all are hers
    assert by_id[mine]["who"] == "you" and by_id[mine]["message"]
    hers = client.get("/api/feedback/logs", headers=ana).json()["errors"]
    assert [e["message"] for e in hers if e["id"] == theirs] == ["a space named Ana's health notes exists already"]
    assert all("who" not in e for e in hers)


def test_the_hive_cleans_its_own_log_lines_and_error_messages_as_it_keeps_them(client):
    ana = person(client, "u_ana")
    token = secrets.token_urlsafe(32)   # a sign-in token's shape: 43 letters, digits, - and _
    marker = "clean-test-" + secrets.token_hex(4)
    logging.getLogger("hive").warning("%s sign-in for ana@example.org from 203.0.113.9 with code=4f2a91c, cookie omega_session=%s",
                                      marker, token)
    # a token that starts inside the part kept and runs past the cut: cleaned whole first, so no piece of it stays
    logging.getLogger("hive").warning("%s %s %s", marker, "x" * (fb.LOG_CHARS - len(marker) - 12), token)
    kept = _met(client, "user:u_ana", f"no space for {token} at /home/ana/work, ask ana@example.org")
    whole = client.get("/api/feedback/logs").json()
    lines = [line["message"] for line in whole["log"] if marker in line["message"]]
    assert lines[1] == f"{marker} sign-in for [email] from [address] with code=[code], cookie omega_session=[cookie]"
    assert lines[0].endswith(" [token]") and len(lines[0]) <= fb.LOG_CHARS
    hers = client.get("/api/feedback", headers=ana).json()["errors"]
    assert [e["message"] for e in hers if e["id"] == kept] == ["no space for [token] at ~/work, ask [email]"]
    for answer in (whole, client.get("/api/feedback/logs", headers=ana).json()):
        assert token[:8] not in json.dumps(answer) and "ana@example.org" not in json.dumps(answer)


@pytest.mark.parametrize("case", SHARED_CASES, ids=lambda c: c["in"][:40])
def test_the_hive_cleans_a_line_as_the_page_does(case):
    assert redact.shared(case["in"]) == case["out"]


def test_clean_takes_out_the_keys_this_hive_holds_on_any_hive(monkeypatch):
    key = "zz" + secrets.token_hex(12)   # 26 characters: no rule knows its shape, only its registration does
    monkeypatch.setattr(redact.REDACTOR, "enabled", False)   # a hive no local owner runs: scrub() is off, clean() is not
    assert redact.clean(f"the provider refused {key}") == f"the provider refused {key}"   # unknown to the hive yet
    redact.register(key)
    try:
        assert redact.clean(f"the provider refused {key}") == "the provider refused [key]"
        assert redact.clean("x-api-key: abcdefgh12") == "x-api-key: [key]"
    finally:
        # dropped from the set; the snapshot scrub() and clean() read keeps it until the next registration rebuilds it
        redact.unregister(key)


def test_every_cookie_the_hive_sets_is_one_clean_takes_out():
    # the cookie names the hive's own code declares, read from its source, so a cookie added there is checked here
    names = {m.group(1) for f in pathlib.Path(fb.__file__).parent.glob("*.py")
             for m in re.finditer(r'^[A-Z_]*COOKIE\s*=\s*"([^"]+)"', f.read_text(), re.M)}
    assert {"hive_signin", "hive_oauth", "omega_session", "hive_google_connector"} <= names
    for name in names:
        assert redact.clean(f"{name}=v4lue123x; Path=/") == f"{name}=[cookie]; Path=/", name


def test_the_hives_log_lines_name_an_exception_by_its_type_and_cut_long_messages():
    ring = fb.LogRing(keep=2)
    log = logging.getLogger("hive.logs-test")
    log.addHandler(ring)
    try:
        try:
            raise KeyError("missing_field")
        except KeyError:
            log.error("the Ask could not close %s", "op-1", exc_info=True)
        log.warning("x" * (fb.LOG_CHARS + 50))
        log.warning("newest")
    finally:
        log.removeHandler(ring)
    lines = ring.lines()
    assert [line["message"] for line in lines] == ["newest", "x" * fb.LOG_CHARS]   # newest first, two kept, cut
    assert lines[0]["at"].endswith("Z") and lines[0]["level"] == "WARNING"
    named = fb.LogRing()
    named.emit(logging.LogRecord("hive", logging.ERROR, __file__, 1, "the Ask could not close %s", ("op-1",), (KeyError, KeyError("k"), None)))
    assert named.lines()[0]["message"] == "the Ask could not close op-1 (KeyError)"   # the type, never the traceback



def test_the_ring_adds_to_the_hives_log_and_never_takes_a_warning_from_it(capsys):
    # Studio's startup self-check warned before the hive's own handlers existed: the ring was the only handler on the
    # way up, so Python never used its last resort and the warning reached the admin's export but not hive.log (20 Nov)
    ring = fb.LogRing()
    hive_log, root = logging.getLogger("hive"), logging.getLogger()
    saved = (hive_log.handlers[:], hive_log.propagate, root.handlers[:])
    hive_log.handlers[:], hive_log.propagate, root.handlers[:] = [ring], True, []
    try:
        logging.getLogger("hive.studio-test").warning("HIVE_STUDIO_SESSIONS is on but this build lacks: %s", "x")
        assert "HIVE_STUDIO_SESSIONS is on but this build lacks: x" in capsys.readouterr().err
        logging.getLogger("hive.studio-test").info("an info line is the ring's to skip, as the last resort skips it")
        assert capsys.readouterr().err == ""
        # once the hive has a handler of its own, that handler has the warning once and the last resort stays quiet
        stream = io.StringIO()
        root.addHandler(logging.StreamHandler(stream))
        logging.getLogger("hive.studio-test").warning("configured now")
        assert stream.getvalue() == "configured now\n"
        assert capsys.readouterr().err == ""
    finally:
        hive_log.handlers[:], hive_log.propagate, root.handlers[:] = saved
    assert [line["message"] for line in ring.lines()] == ["configured now", "HIVE_STUDIO_SESSIONS is on but this build lacks: x"]

@pytest.mark.parametrize("in_schema, status, kept", [(False, 200, False), (False, 404, True), (True, 200, True)])
def test_a_page_file_that_loaded_is_not_kept_but_a_failure_on_a_page_route_is(in_schema, status, kept):
    got = []

    class Ring:
        def requested(self, *args):
            got.append(args)

    class Route:
        path, include_in_schema = "/{path:path}", in_schema

    async def app(scope, receive, send):
        scope["route"] = Route()
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def nothing(message):
        return None

    middleware = fb.RecentRequests(app, feedback=Ring(), who=lambda session: "user:u_ana")
    asyncio.run(middleware({"type": "http", "method": "GET", "path": "/assets/index-1a2b.js"}, None, nothing))
    assert len(got) == int(kept)
    if kept:   # a page route names its path's first two parts, never its catch-all pattern
        assert got[0][3] == ("/{path:path}" if in_schema else "/assets/index-1a2b.js")


def test_an_error_the_hive_did_not_expect_is_kept_as_its_500(client, monkeypatch):
    hive = client.app.state.hive

    def broken(*_):
        raise KeyError("missing_field")
    monkeypatch.setattr(hive, "summary", broken)
    quiet = TestClient(client.app, raise_server_exceptions=False)
    quiet.headers.update(client.headers)
    assert quiet.get("/api/hive").status_code == 500
    line = next(r for r in client.get("/api/feedback/logs").json()["requests"] if r["route"] == "/api/hive")
    assert (line["status"], line["who"]) == (500, "you")


def test_each_person_keeps_only_their_newest_hundred_requests(client):
    feedback = client.app.state.hive.feedback
    for i in range(fb.KEEP_REQUESTS + 20):   # two routes in turn, so no run folds
        feedback.requested("user:u_zed", False, "GET", f"/api/r{i % 2}", 200, 1.0, f"2026-11-17T00:{i // 60:02d}:{i % 60:02d}.000Z")
    assert len(feedback._requests["user:u_zed"]) == fb.KEEP_REQUESTS   # the hive holds no more than that a person
    kept = feedback.requests_for("user:u_zed", False)
    assert len(kept) == fb.KEEP_REQUESTS and kept[0]["at"] == "2026-11-17T00:01:59.000Z" and kept[-1]["at"] == "2026-11-17T00:00:20.000Z"
