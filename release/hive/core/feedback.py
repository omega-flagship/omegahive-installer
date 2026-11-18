# Purpose: what the hive itself adds to a person's feedback or bug report, and where reports go: the one setting that
# names the destination, whether the feedback board is public yet, the release and kind of hive a report names, the
# recent error answers each person met (each with the id the page was given), and the hand-off to a report service.
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

Every error answer the hive gives carries an id (e-xxxxxxxx) in its X-Hive-Error-Id header, and the hive keeps the
most recent ones with the person who met them, so a report can name what failed by id, code and route, and for an
unexpected error where in the hive it was raised. The id goes in a header so no answer's body changes: an unknown
thing and one the person may not see still answer alike.

What is kept of an answer's words names no key id or person of this hive (keyview.strip_identities), whoever met it:
GET /api/feedback answers them on a 200, which the key projection does not rewrite, and a report leaves the hive.
"""
from __future__ import annotations

import collections
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

log = logging.getLogger("hive.feedback")

ERROR_ID_HEADER = "X-Hive-Error-Id"
# The team's feedback board (omega-flagship/omegahive-feedback): private until the code repositories are public
# (Janaina, standup 13 Nov), so the page offers it only once GitHub answers it as public.
BOARD = "https://github.com/omega-flagship/omegahive-feedback"
# How many error answers the hive keeps, across everyone: Claude Code's bug report carries up to its last 100 errors.
KEEP_ERRORS = 100
# How many of one person's errors a report carries.
REPORT_ERRORS = 10
# How old an answer about the board's visibility may be before it is asked again: a board that goes public reaches
# every hive within this long, and GitHub's unauthenticated limit (60 an hour for one address) is never near.
BOARD_FRESH_S = 15 * 60
# An outside call waits at most this long (GitHub's own API, a report service); the page's request never waits on the
# board check, which runs in the background.
BOARD_TIMEOUT_S = 10
SEND_TIMEOUT_S = 30
# A report with its picture, base64: a 1440x900 screen as PNG is well under 4 MB.
SEND_MAX_BYTES = 12 * 1024 * 1024
REPORT_ID = re.compile(r"HR-[0-9a-f]{8}")
KINDS = ("bug", "ux", "idea")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
# The folder this code was laid out from: a release keeps RELEASE_VERSION and, when built with one, FEEDBACK_TO here.
RELEASE_ROOT = pathlib.Path(__file__).resolve().parents[2]


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


def _route_of(request) -> str:
    """The route a request matched, by its pattern ("/api/apps/{program_id}/drafts"), so no id is named; a path no route
    matched keeps its first two parts."""
    route = request.scope.get("route")
    pattern = getattr(route, "path", None)
    if isinstance(pattern, str):
        return pattern
    parts = [p for p in request.url.path.split("/") if p]
    return "/" + "/".join(parts[:2]) + ("/…" if len(parts) > 2 else "")


class Feedback:
    """The hive's side of feedback: its destination, the board's visibility, and the recent error answers."""

    def __init__(self, hive, raw_destination: str | None):
        self.hive = hive
        self.to = destination(configured(raw_destination))
        self._errors: collections.deque = collections.deque(maxlen=KEEP_ERRORS)
        self._lock = threading.Lock()
        # the board's visibility: True, False, or None while not known (never asked, or GitHub could not be reached)
        self._board_public: bool | None = None
        self._board_checked = 0.0
        self._board_checking = False

    # ---- error answers ----------------------------------------------------------------------------------------------

    def noted(self, request, principal: str | None, status: int, code: str, message: str, exc: BaseException | None = None) -> str:
        """Keep one error answer with the person who met it and return its id, which the answer carries. An answer to
        a request no session was found for (principal None, as for a 401) is kept with nobody, so no report names it.
        Its words are kept as a report may carry them: "key:k_0000b0b1 has spent its month" as "key has spent its
        month", each of this hive's key ids and people taken out before the cut, so no id is left half cut."""
        error_id = "e-" + secrets.token_hex(4)
        entry = {"id": error_id, "at": now(), "method": request.method, "route": _route_of(request), "status": status,
                 "code": code, "message": keyview.strip_identities(str(message))[:300], "principal": principal}
        if exc is not None:
            entry["raised"] = _raised_at(exc)
        with self._lock:
            self._errors.append(entry)
        return error_id

    def errors_for(self, principal: str) -> list[dict]:
        """One person's most recent error answers, newest first. Time: one pass over the KEEP_ERRORS kept."""
        with self._lock:
            mine = [e for e in self._errors if e["principal"] == principal]
        return [{k: v for k, v in e.items() if k != "principal"} for e in reversed(mine[-REPORT_ERRORS:])]

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
        updates = self.hive.updates
        release = getattr(updates, "running_release", None)
        system = system_name()
        to = dict(self.to)
        if to["kind"] == "board":
            to["public"] = self.board_public()
        return {"version": version_line(system, release, updates.running_build), "which": which_hive(system, release, self.hive.settings.public_url),
                "system": system, "to": to, "errors": self.errors_for(principal)}

    # ---- handing a report to a report service -----------------------------------------------------------------------

    def send(self, report: dict) -> dict:
        """Post a person's report to the report service HIVE_FEEDBACK_TO names. The page sends only what the person saw
        and said yes to; the hive adds nothing. Raises ValueError for a report the hive refuses to pass on, and
        RuntimeError, with words for the person, when the service could not take it."""
        if self.to.get("kind") != "service":
            raise LookupError("this hive has no report service to send to")
        problems = report_problems(report)
        if problems:
            raise ValueError(problems)
        data = json.dumps(report).encode("utf-8")
        req = urllib.request.Request(self.to["url"], data=data, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "omegahive"})
        host = self.to["host"]
        try:
            with urllib.request.urlopen(req, timeout=SEND_TIMEOUT_S) as resp:
                body = resp.read(64 * 1024)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"The report service at {host} answered {e.code}.") from e
        except OSError as e:
            raise RuntimeError(f"Could not reach the report service at {host}.") from e
        reference = None
        try:
            answer = json.loads(body.decode("utf-8") or "null")
            if isinstance(answer, dict):
                reference = next((answer[k] for k in ("reference", "url", "id") if isinstance(answer.get(k), str)), None)
        except ValueError:
            pass
        return {"sent": True, "to": host, "reference": reference}


def report_problems(report) -> str:
    """Why a report cannot be passed on, or "" when it can: the shape the page builds (features/feedback/report.ts
    payload), schema omega-hive-report-1."""
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
    return ""
