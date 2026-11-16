# Purpose: tests the hive's side of feedback and bug reports (hive/core/feedback.py and its routes): the one destination
# setting, the version and hive a report names, every error answer's id kept with the person who met it, the
# unexpected error answered by id, the board's visibility check and the hand-off to a report service.
import http.server
import io
import json
import threading
import urllib.error

import pytest
from fastapi.testclient import TestClient

from hive.core import feedback as fb
from hive.tests.test_core_api import client  # noqa: F401  (fixture: local operator)
from hive.tests.test_visibility import person


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


def test_the_context_names_an_installed_release_when_the_hive_has_one(client, monkeypatch):
    hive = client.app.state.hive
    monkeypatch.setattr(hive.updates, "running_release", {"version": "0.31", "commit": "f9648d4386aa77"}, raising=False)
    monkeypatch.setattr(fb, "system_name", lambda: "Mac")
    ctx = client.get("/api/feedback").json()
    assert ctx["version"] == "Mac v0.31 (build f9648d4386)" and ctx["which"] == "own hive, Mac install"


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
