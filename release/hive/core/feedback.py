# Purpose: what the hive itself adds to a person's feedback or bug report, and where reports go: the one setting that
# names the destination, whether the feedback board is public yet, the release and kind of hive a report names, the
# recent error answers each person met (each with the id the page was given), the hand-off to a report service, and
# what a person's exported logs hold from the hive: their recent requests and errors, or an admin's whole hive's, with
# other people's error answers by route, status and code only and every message cleaned on the hive first.
"""Feedback and bug reports, the hive's side (the page builds and shows the report: hive/ui/src/features/feedback).

Where reports go is one setting: HIVE_FEEDBACK_TO in the hive's environment (hive.env, which the installers write),
else the FEEDBACK_TO the hive's release was built with (install/macos/make-mac-release.sh and its Windows twin write
it beside RELEASE_VERSION), so a release sets it for every hive that takes it and an install's own line still wins:
  unset                          the team's feedback board, BOARD
  https://github.com/OWNER/REPO  a feedback board: the page opens its prefilled new-issue form for a person with a
                                 GitHub account, once the repository answers as public
  any other https address        a report service: the hive posts the report there (POST /api/feedback/send)
  none                           no direct route: the person copies the report or saves it
Whatever the destination, the page also offers the copy for the testers' group and the saved file.

A report service that asks for a token gets it from a file: HIVE_FEEDBACK_TOKEN_FILE names it, and each report then
goes with `Authorization: Bearer <the file's text>`. The token is read at each send, so a new file needs no restart,
and it is never logged, answered or put in an error's words. A file that is set and cannot be read sends nothing.

A report to a report service may also carry the person's recent requests, the errors and the hive's own log lines
(`recent_requests`, `errors`, `logs`), when the person left them in: the page shows them and sends them, the hive
checks their shape and size (report_problems) and cleans every text in them again before the report leaves (send).

Every error answer the hive gives carries an id (e-xxxxxxxx) in its X-Hive-Error-Id header, and the hive keeps the
most recent ones with the person who met them, so a report can name what failed by id, code and route, and for an
unexpected error where in the hive it was raised. The id goes in a header so no answer's body changes: an unknown
thing and one the person may not see still answer alike.

What is kept of an answer's words names no key id or person of this hive (keyview.strip_identities), whoever met it:
GET /api/feedback answers them on a 200, which the key projection does not rewrite, and a report leaves the hive.
The hive also keeps each person's last requests, by route pattern, status and how long the answer took to start
(RecentRequests), and its own newest warnings and errors (LogRing), for the logs file a person can save from the
feedback area and send the team (GET /api/feedback/logs). A person's logs hold their own requests and error answers;
an admin's hold the whole hive's, and only theirs hold the hive's log lines, which name no one person's work. Another
person's error answers show there by time, id, route, status and code, never their message, which can carry words they
typed for a private space or mind (Jon on #388). Nothing kept names an id, a query or a body, every message is cleaned
as it is kept (redact.clean: keys, emails, home folders, ids, OAuth codes, cookies, addresses), and the page cleans
the whole file again before showing it (report.ts redact).
"""
from __future__ import annotations

import collections
import datetime
import json
import logging
import os
import pathlib
import platform as _platform
import re
import secrets
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from . import keyview
from .db import now
from .redact import clean

log = logging.getLogger("hive.feedback")

ERROR_ID_HEADER = "X-Hive-Error-Id"
# The team's feedback board (omega-flagship/omegahive-feedback): private until the code repositories are public
# (Janaina, standup 13 Nov), so the page offers it only once GitHub answers it as public.
BOARD = "https://github.com/omega-flagship/omegahive-feedback"
# How many error answers the hive keeps, across everyone: Claude Code's bug report carries up to its last 100 errors.
KEEP_ERRORS = 100
# How many of one person's errors a report carries.
REPORT_ERRORS = 10
# How many requests the hive keeps with each person, for the logs they export: Sentry's SDK keeps an event's last 100
# breadcrumbs (DEFAULT_MAX_BREADCRUMBS, sentry_sdk/consts.py). A run of one request answered alike is one line with its
# count, as syslog folds a repeated message, so the page's polls don't push out what just happened.
KEEP_REQUESTS = 100
# How many of the hive's own warnings and errors it keeps for an admin's logs, and how much of each message (an error
# answer's message is cut to the same).
KEEP_LOG = 100
LOG_CHARS = 300
# How much of a message is cleaned before it is cut to LOG_CHARS: a key or token that starts inside the part kept is
# then seen whole, so no piece of one survives the cut (a 43-character sign-in token starting at character 290).
CLEAN_CHARS = 4 * LOG_CHARS
# What another person's error answer shows in an admin's logs: where and how it failed, never what it said.
OTHERS_ERROR = ("id", "at", "method", "route", "status", "code")
# How old an answer about the board's visibility may be before it is asked again: a board that goes public reaches
# every hive within this long, and GitHub's unauthenticated limit (60 an hour for one address) is never near.
BOARD_FRESH_S = 15 * 60
# An outside call waits at most this long (GitHub's own API, a report service); the page's request never waits on the
# board check, which runs in the background.
BOARD_TIMEOUT_S = 10
SEND_TIMEOUT_S = 30
# A report with its picture, base64: a 1440x900 screen as PNG is well under 4 MB.
SEND_MAX_BYTES = 12 * 1024 * 1024
# What a report may carry beside the person's words, when they left it in: at most this many of their recent requests,
# error answers (all the hive keeps) and log lines, and this much of the three together as JSON. The hive keeps 100
# requests a person and 100 log lines, so a page that sends more is not the hive's own page.
SEND_REQUESTS = 50
SEND_ERRORS = KEEP_ERRORS
SEND_LOGS = 400
SEND_EXTRAS_BYTES = 200 * 1024
# The parts a request and an error may have in a report (the page's HiveRequestLine and ReportError; the feedback
# relay's REQUEST_PARTS and ERROR_PARTS, omegahive-deploy feedback-relay/relay.py), each a text or a whole number.
REQUEST_PARTS = ("at", "method", "route", "status", "ms", "count", "who")
ERROR_PARTS = ("at", "status", "source", "code", "method", "route", "where", "id", "message", "raised", "who")
# A token as a header can carry it: printable ASCII with no space, so no line break can add a header of its own.
TOKEN = re.compile(r"[\x21-\x7e]{1,4096}")
REPORT_ID = re.compile(r"HR-[0-9a-f]{8}")
KINDS = ("bug", "ux", "idea")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
# The folder this code was laid out from: a release keeps RELEASE_VERSION and, when built with one, FEEDBACK_TO here.
RELEASE_ROOT = pathlib.Path(__file__).resolve().parents[2]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """No redirect is followed when a report is sent: urllib would carry the Authorization header on to wherever the
    answer points."""

    def redirect_request(self, *args, **kwargs):
        return None


_SEND = urllib.request.build_opener(_NoRedirect)


def configured(env_value: str | None, root: pathlib.Path = RELEASE_ROOT) -> str | None:
    """The destination setting as written: HIVE_FEEDBACK_TO when the hive's environment sets it (an empty line, the
    way hive.env leaves a setting, sets nothing), else the release's FEEDBACK_TO, else None (the board)."""
    if env_value and env_value.strip():
        return env_value
    try:
        return (root / "FEEDBACK_TO").read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def destination(raw: str | None) -> dict:
    """Where reports go, from the setting as written (`configured`; None when nothing sets it). A value the hive cannot
    use is said, never dropped: {"kind": "invalid", "reason": ...}, and the page offers the copy and the file meanwhile."""
    text = BOARD if raw is None else raw.strip()
    if text.lower() in ("", "none", "off"):
        return {"kind": "none"}
    parts = urlsplit(text)
    local = parts.scheme == "http" and parts.hostname in LOOPBACK   # a report service on this machine
    if parts.scheme != "https" and not local:
        return {"kind": "invalid", "reason": "the feedback destination must be an https address, or none"}
    if not parts.hostname:
        return {"kind": "invalid", "reason": "the feedback destination names no host"}
    if parts.hostname == "github.com":
        path = [p for p in parts.path.split("/") if p]
        if len(path) != 2 or parts.query or parts.fragment:
            return {"kind": "invalid", "reason": "a GitHub destination names a repository: https://github.com/OWNER/REPO"}
        owner, repo = path[0], path[1].removesuffix(".git")
        return {"kind": "board", "owner": owner, "repo": repo, "url": f"https://github.com/{owner}/{repo}"}
    return {"kind": "service", "url": text, "host": parts.hostname}


def _windows_subsystem() -> bool:
    """Linux under WSL, where the Windows installer runs the hive."""
    try:
        with open("/proc/version", encoding="utf-8") as f:
            return "microsoft" in f.read().lower()
    except OSError:
        return False


def system_name() -> str:
    """The system the hive runs on, in the words a person uses: Mac, Windows (the installer runs it in WSL) or Linux."""
    if sys.platform == "darwin":
        return "Mac"
    if sys.platform.startswith("linux"):
        return "Windows" if _windows_subsystem() else "Linux"
    return _platform.system() or sys.platform


def version_line(system: str, release: dict | None, build: str | None) -> str:
    """The hive's version as a report quotes it: "Mac v0.31 (build f9648d4386)" for an installed release, the build
    alone for a git checkout, with the 10 characters of the build that Settings shows."""
    if release and release.get("commit"):
        number = release.get("version")
        return f"{system} v{number} (build {release['commit'][:10]})" if number else f"{system} build {release['commit'][:10]}"
    return f"build {build[:10]}" if build else "build unknown"


def which_hive(system: str, release: dict | None, public_url: str) -> str:
    """Which hive this is, for a report: an own hive from an installer, or a shared hive by its address (a test hive or
    staging), or one run from source on a machine."""
    if release:
        return f"own hive, {system} install"
    host = urlsplit(public_url or "").hostname or ""
    if host and host not in LOOPBACK:
        return f"the hive at {host}"
    return f"a hive run from source on {system}"


def _raised_at(exc: BaseException) -> str:
    """Where an unexpected error was raised, as the hive's own source names it: "KeyError at hive/core/ask.py:1130 in
    _close". The deepest frame inside this checkout, the path relative to it, so no home folder is named.
    Time: one pass over the traceback's frames."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    here = None
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename.startswith(root + os.sep):
            here = frame
    name = type(exc).__name__
    if here is None:
        return name
    return f"{name} at {os.path.relpath(here.filename, root)}:{here.lineno} in {here.name}"


def route_pattern(scope) -> str:
    """The route a request matched, by its pattern ("/api/apps/{program_id}/drafts"), so no id is named; a path no route
    of the hive's API matched (none, or a page route such as the page's catch-all) keeps its first two parts."""
    route = scope.get("route")
    pattern = getattr(route, "path", None)
    if isinstance(pattern, str) and getattr(route, "include_in_schema", True):
        return pattern
    parts = [p for p in scope.get("path", "").split("/") if p]
    return "/" + "/".join(parts[:2]) + ("/…" if len(parts) > 2 else "")


class RecentRequests:
    """ASGI middleware: each request the hive's routes answer is kept with whoever made it (Feedback.requested), by its
    method, its route's pattern, its status and how long the answer took to start. A page file that loaded (a route
    outside the API schema, as the page's catch-all and the sign-in page are) is not kept; a failure there is. `who`
    names the person a session is for (app.py _who)."""

    def __init__(self, app, feedback: Feedback, who):
        self.app, self.feedback, self.who = app, feedback, who

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        scope.setdefault("state", {})   # so the session a route finds is in this scope too, whatever passes it on
        started, at = time.monotonic(), now()
        answered = False

        async def watched(message):
            nonlocal answered
            if message["type"] == "http.response.start" and not answered:
                answered = True
                self._keep(scope, message["status"], started, at)
            await send(message)

        try:
            await self.app(scope, receive, watched)
        except Exception:
            if not answered:   # an error the hive did not expect: its 500 is made outside this middleware
                self._keep(scope, 500, started, at)
            raise

    def _keep(self, scope, status: int, started: float, at: str) -> None:
        route = scope.get("route")
        if route is not None and not getattr(route, "include_in_schema", True) and status < 400:
            return
        state = scope.get("state") or {}
        session = state.get("hive_session")
        self.feedback.requested(self.who(session) if session else None, bool(state.get("answers_a_mind")), scope["method"],
                                route_pattern(scope), status, (time.monotonic() - started) * 1000, at)


class LogRing(logging.Handler):
    """The hive's newest warnings and errors as its log has them, for an admin's logs: each record's time, level, logger
    and message, the message cleaned (redact.clean) and cut to LOG_CHARS and an exception named by its type (the hive's
    own log keeps the traceback). One per process (log_ring), on the hive's loggers.
    It adds to the hive's log and never takes from it: Python writes a record to stderr through logging.lastResort only
    when no handler is found on the way up (Logger.callHandlers), and the ring would count as one, so a warning logged
    before the hive's own handlers exist (Studio's startup self-check, for one) would reach the ring and not hive.log.
    So a record the ring alone handles also goes to lastResort, as it would have without the ring.
    Time: one clean of at most CLEAN_CHARS characters per warning or error logged, and a walk of its logger's parents."""

    def __init__(self, keep: int = KEEP_LOG):
        super().__init__(level=logging.WARNING)
        self._lines: collections.deque = collections.deque(maxlen=keep)

    def _alone(self, record: logging.LogRecord) -> bool:
        """Whether this ring is the only handler on the record's way up, counted as Logger.callHandlers counts: every
        handler on each logger up to the root or the first that doesn't propagate, whatever its level."""
        logger: logging.Logger | None = logging.getLogger(record.name)
        while logger is not None:
            if any(h is not self for h in logger.handlers):
                return False
            if not logger.propagate:
                return True
            logger = logger.parent
        return True

    def handle(self, record: logging.LogRecord) -> bool:
        kept = super().handle(record)
        last = logging.lastResort
        if kept and last is not None and record.levelno >= last.level and self._alone(record):
            last.handle(record)
        return kept

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
        except Exception:   # a record whose arguments don't fit its format still says what it can
            message = str(record.msg)
        if record.exc_info and record.exc_info[0] is not None:
            message = f"{message} ({record.exc_info[0].__name__})"
        at = datetime.datetime.fromtimestamp(record.created, datetime.timezone.utc).isoformat(timespec="milliseconds")
        self._lines.append({"at": at.replace("+00:00", "Z"), "level": record.levelname, "logger": record.name,
                            "message": clean(message[:CLEAN_CHARS])[:LOG_CHARS]})

    def lines(self) -> list[dict]:
        """The lines kept, newest first, read under the lock emit runs under (logging.Handler.handle)."""
        self.acquire()
        try:
            return list(reversed(self._lines))
        finally:
            self.release()


_log_ring: LogRing | None = None
_log_ring_lock = threading.Lock()


def log_ring() -> LogRing:
    """The process's one LogRing, put on the hive's loggers (hive, and omegahive for its MCP server) the first time a hive
    asks for it, so every hive in the process reads the same lines and none is added twice."""
    global _log_ring
    with _log_ring_lock:
        if _log_ring is None:
            _log_ring = LogRing()
            for name in ("hive", "omegahive"):
                logging.getLogger(name).addHandler(_log_ring)
        return _log_ring


class Feedback:
    """The hive's side of feedback: its destination, the board's visibility, the recent error answers and requests,
    and the hive's own newest log lines."""

    def __init__(self, hive, raw_destination: str | None):
        self.hive = hive
        self.to = destination(configured(raw_destination))
        # the file holding the report service's token (HIVE_FEEDBACK_TOKEN_FILE), or None when it asks for none
        self.token_file: str | None = (getattr(hive.settings, "feedback_token_file", None) or "").strip() or None
        self._errors: collections.deque = collections.deque(maxlen=KEEP_ERRORS)
        # each person's last requests, by the principal of their session; None for requests no person's session made
        self._requests: dict[str | None, collections.deque] = {}
        # the order requests were kept in, across everyone: two answered in one millisecond have one time between them
        self._kept = 0
        self._lock = threading.Lock()
        self.log = log_ring()
        # the board's visibility: True, False, or None while not known (never asked, or GitHub could not be reached)
        self._board_public: bool | None = None
        self._board_checked = 0.0
        self._board_checking = False

    # ---- error answers ----------------------------------------------------------------------------------------------

    def noted(self, request, principal: str | None, status: int, code: str, message: str, exc: BaseException | None = None) -> str:
        """Keep one error answer with the person who met it and return its id, which the answer carries. An answer to
        a request no session was found for (principal None, as for a 401) is kept with nobody, so no report names it.
        Its words are kept as a report may carry them: "key:k_0000b0b1 has spent its month" as "key has spent its
        month", each of this hive's key ids and people taken out before the cut, so no id is left half cut, then cleaned (redact.clean) and cut to LOG_CHARS."""
        error_id = "e-" + secrets.token_hex(4)
        entry = {"id": error_id, "at": now(), "method": request.method, "route": route_pattern(request.scope), "status": status,
                 "code": code, "message": clean(keyview.strip_identities(str(message))[:CLEAN_CHARS])[:LOG_CHARS], "principal": principal}
        if exc is not None:
            entry["raised"] = _raised_at(exc)
        with self._lock:
            self._errors.append(entry)
        return error_id

    def errors_for(self, principal: str) -> list[dict]:
        """One person's REPORT_ERRORS most recent error answers, newest first."""
        return self.errors_of(principal, False)[:REPORT_ERRORS]

    def errors_of(self, principal: str, everyone: bool) -> list[dict]:
        """Every error answer kept that this person met, newest first, or for an admin (`everyone`) every one, each then
        saying whose it is: the admin's own whole, and every other one (another person's, or one no session met) by
        OTHERS_ERROR only, without the message or where it was raised. Time: one pass over the KEEP_ERRORS kept."""
        with self._lock:
            kept = [e for e in self._errors if everyone or e["principal"] == principal]
        out = []
        for e in reversed(kept):
            who = e["principal"]
            own = who == principal
            line = {k: v for k, v in e.items() if k != "principal"} if own else {k: e[k] for k in OTHERS_ERROR}
            if everyone:
                line["who"] = "you" if own else "no session" if who is None else "another person"
            out.append(line)
        return out

    # ---- requests ---------------------------------------------------------------------------------------------------

    def requested(self, principal: str | None, mind: bool, method: str, route: str, status: int, ms: float, at: str) -> None:
        """Keep one request with whoever made it: a person's session's principal, or None (a mind on its gateway, or a
        request no session came with). One like the request before it (method, route, status, a mind's or not) folds
        into that line: its count grows, its time is the newest and its ms the slowest. Each line also keeps when it
        was last added to, as a count (`seq`), which orders two lines of one millisecond. Time: O(1)."""
        ms = round(ms)
        with self._lock:
            self._kept += 1
            ring = self._requests.get(principal)
            if ring is None:
                ring = self._requests[principal] = collections.deque(maxlen=KEEP_REQUESTS)
            last = ring[-1] if ring else None
            if last is not None and (last["method"], last["route"], last["status"], last["mind"]) == (method, route, status, mind):
                last.update(at=at, count=last["count"] + 1, ms=max(last["ms"], ms), seq=self._kept)
            else:
                ring.append({"at": at, "method": method, "route": route, "status": status, "ms": ms, "count": 1, "mind": mind,
                             "seq": self._kept})

    def requests_for(self, principal: str, everyone: bool) -> list[dict]:
        """The newest KEEP_REQUESTS requests, newest first: this person's own, or for an admin (`everyone`) the whole
        hive's, each saying who made it. Two of one time (the stamp is to the millisecond) come in the order they were
        kept, the later first. Time: r log r comparisons, r the requests kept (KEEP_REQUESTS a person)."""
        with self._lock:
            kept = [(who, dict(e)) for who, ring in self._requests.items() if everyone or who == principal for e in ring]
        lines = []
        for who, e in kept:
            mind = e.pop("mind")
            e["who"] = "you" if who == principal else "a mind" if mind else "no session" if who is None else "another person"
            lines.append(e)
        lines.sort(key=lambda e: (e["at"], e["seq"]), reverse=True)
        lines = lines[:KEEP_REQUESTS]
        for e in lines:
            del e["seq"]
        return lines

    # ---- the board --------------------------------------------------------------------------------------------------

    def board_public(self) -> bool | None:
        """Whether the board answers as public, as last found; a stale answer starts a fresh check in the background,
        so no request waits on GitHub."""
        if self.to.get("kind") != "board" or self.hive.settings.offline:
            return None
        with self._lock:
            stale = time.monotonic() - self._board_checked > BOARD_FRESH_S or self._board_checked == 0.0
            start = stale and not self._board_checking
            if start:
                self._board_checking = True
        if start:
            threading.Thread(target=self._check_board, name="feedback-board-check", daemon=True).start()
        return self._board_public

    def _check_board(self):
        url = f"https://api.github.com/repos/{self.to['owner']}/{self.to['repo']}"
        found: bool | None = None
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "omegahive"})
            with urllib.request.urlopen(req, timeout=BOARD_TIMEOUT_S) as resp:
                found = json.loads(resp.read().decode("utf-8")).get("private") is False
        except urllib.error.HTTPError as e:
            # GitHub answers 404 for a private repository to anyone who cannot see it
            found = False if e.code == 404 else None
            if found is None:
                log.info("feedback board check: GitHub answered %s for %s", e.code, url)
        except (OSError, ValueError) as e:
            log.info("feedback board check: could not reach %s (%s)", url, e)
        with self._lock:
            if found is not None:
                self._board_public = found
            self._board_checked = time.monotonic()
            self._board_checking = False

    # ---- what a report carries from the hive ------------------------------------------------------------------------

    def context(self, principal: str) -> dict:
        """What the page adds to a person's report from the hive: its version, which hive it is, where reports go, and
        that person's recent error answers."""
        to = dict(self.to)
        if to["kind"] == "board":
            to["public"] = self.board_public()
        return {**self._about(), "to": to, "errors": self.errors_for(principal)}

    def logs(self, principal: str, everyone: bool) -> dict:
        """What a person's logs file holds from the hive (GET /api/feedback/logs): its version, which hive it is, and the
        recent requests and error answers, the person's own or for an admin (`everyone`) the whole hive's, with the
        hive's own newest warnings and errors, which only an admin's carry since they name no one person's work."""
        return {**self._about(), "scope": "hive" if everyone else "person", "requests": self.requests_for(principal, everyone),
                "errors": self.errors_of(principal, everyone), "log": self.log.lines() if everyone else []}

    def _about(self) -> dict:
        """The hive's version, which hive it is and the system it runs on, as a report and the logs name them."""
        updates = self.hive.updates
        release = getattr(updates, "running_release", None)
        system = system_name()
        return {"version": version_line(system, release, updates.running_build),
                "which": which_hive(system, release, self.hive.settings.public_url), "system": system}

    # ---- handing a report to a report service -----------------------------------------------------------------------

    def _token(self) -> str | None:
        """The report service's token from the file HIVE_FEEDBACK_TOKEN_FILE names, without the white space around it,
        or None when no file is named. Raises RuntimeError, with words for the person and never the token or the
        system's own words, when the file is set and cannot be read, is empty, or holds what no header can carry."""
        if not self.token_file:
            return None
        try:
            with open(self.token_file, encoding="utf-8") as f:
                token = f.read(8192).strip()
        except (OSError, ValueError):
            token = ""
        if not TOKEN.fullmatch(token):
            log.warning("feedback: the report service's token file could not be read, or holds no token; no report is sent")
            raise RuntimeError("This hive could not read its token for the report service, so the report was not sent. "
                               "Whoever runs this hive can check the file HIVE_FEEDBACK_TOKEN_FILE names.")
        return token

    def send(self, report: dict) -> dict:
        """Post a person's report to the report service HIVE_FEEDBACK_TO names. The page sends only what the person saw
        and said yes to; the hive adds nothing. It only takes out: every text in the requests, errors and log lines a
        report carries is cleaned again here (cleaned_extras), since the hive knows keys the page does not. With
        HIVE_FEEDBACK_TOKEN_FILE set, the post carries that file's token as its bearer. Raises ValueError for a report
        the hive refuses to pass on, and RuntimeError, with words for the person, when the service could not take it
        or the token could not be read."""
        if self.to.get("kind") != "service":
            raise LookupError("this hive has no report service to send to")
        problems = report_problems(report)
        if problems:
            raise ValueError(problems)
        headers = {"Content-Type": "application/json", "User-Agent": "omegahive"}
        token = self._token()
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(cleaned_extras(report)).encode("utf-8")
        req = urllib.request.Request(self.to["url"], data=data, method="POST", headers=headers)
        host = self.to["host"]
        # `from None` below: an error's chain is logged with its traceback, and the request it names holds the token
        try:
            with _SEND.open(req, timeout=SEND_TIMEOUT_S) as resp:
                body = resp.read(64 * 1024)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"The report service at {host} answered {e.code}.") from None
        except OSError:
            raise RuntimeError(f"Could not reach the report service at {host}.") from None
        reference = None
        try:
            answer = json.loads(body.decode("utf-8") or "null")
            if isinstance(answer, dict):
                reference = next((answer[k] for k in ("reference", "url", "id") if isinstance(answer.get(k), str)), None)
        except ValueError:
            pass
        return {"sent": True, "to": host, "reference": reference}


def _again(text: str) -> str:
    """A text a report carries, cleaned as the hive cleans what it keeps: this hive's key ids and people out
    (keyview.strip_identities), then keys, emails, home folders, ids, codes, cookies and addresses (redact.clean)."""
    return clean(keyview.strip_identities(text))


def cleaned_extras(report: dict) -> dict:
    """The report with every text in its recent requests, errors and log lines cleaned again; a report without them
    is returned as it is, and nothing else in a report is touched. Only a report report_problems passed comes here.
    Time: one cleaning pass over each text, at most SEND_EXTRAS_BYTES in all."""
    if not any(report.get(name) for name in ("recent_requests", "errors", "logs")):
        return report
    out = dict(report)
    for name in ("recent_requests", "errors"):
        if report.get(name):
            out[name] = [{k: _again(v) if isinstance(v, str) else v for k, v in line.items()} for line in report[name]]
    if report.get("logs"):
        out["logs"] = [_again(line) for line in report["logs"]]
    return out


def _lines_problem(name: str, lines, most: int, parts: tuple[str, ...] | None) -> str:
    """Why one of a report's lists is refused, or "": a list of at most `most`, each a text (`parts` None) or an
    object of the named parts, each a text or a whole number."""
    if not isinstance(lines, list):
        return f"{name} is a list, when given"
    if len(lines) > most:
        return f"{name} holds at most {most}"
    for line in lines:
        if parts is None:
            if not isinstance(line, str):
                return f"{name} is a list of lines of text"
        elif not isinstance(line, dict) or not all(
                k in parts and isinstance(v, (str, int)) and not isinstance(v, bool) for k, v in line.items()):
            return f"each of {name} has only {', '.join(parts)}, each a text or a whole number"
    return ""


def report_problems(report) -> str:
    """Why a report cannot be passed on, or "" when it can: the shape the page builds (features/feedback/report.ts
    payload), schema omega-hive-report-1. The recent requests, errors and log lines are each optional: a list within
    its size (SEND_REQUESTS, SEND_ERRORS, SEND_LOGS), of the shape the page sends, SEND_EXTRAS_BYTES together."""
    if not isinstance(report, dict):
        return "a report is a JSON object"
    if report.get("schema") != "omega-hive-report-1":
        return "schema must be omega-hive-report-1"
    if not isinstance(report.get("id"), str) or not REPORT_ID.fullmatch(report["id"]):
        return "id must be HR- and 8 hex digits"
    if report.get("kind") not in KINDS:
        return "kind must be bug, ux or idea"
    text = report.get("text")
    if not isinstance(text, str) or not text.strip():
        return "text is the report as the person saw it"
    if not isinstance(report.get("fields"), dict) or not all(isinstance(v, str) for v in report["fields"].values()):
        return "fields maps each form field to its text"
    picture = report.get("picture")
    if picture is not None and (not isinstance(picture, str) or not picture.startswith("data:image/png;base64,")):
        return "picture is a PNG data address, or null"
    # what a report may also carry when the person left it in; a report without them is whole
    extras = 0
    for name, most, parts in (("recent_requests", SEND_REQUESTS, REQUEST_PARTS), ("errors", SEND_ERRORS, ERROR_PARTS),
                              ("logs", SEND_LOGS, None)):
        lines = report.get(name)
        if lines is None:
            continue
        problem = _lines_problem(name, lines, most, parts)
        if problem:
            return problem
        # measured as the page measures it (logs.ts extrasBytes): compact JSON, UTF-8
        extras += len(json.dumps(lines, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace"))
    if extras > SEND_EXTRAS_BYTES:
        return f"recent_requests, errors and logs together hold at most {SEND_EXTRAS_BYTES // 1024} KB"
    return ""
