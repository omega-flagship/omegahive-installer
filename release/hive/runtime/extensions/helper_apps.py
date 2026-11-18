"""Purpose: call app actions through the hive's policy and exact-approval boundary."""

import json
import os
from pathlib import Path
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_INPUT = 8192
MAX_OUTPUT = 32768
MAX_SAVED = MAX_INPUT + 1024
# A refusal's body is read only to tell a request the host is still running (409 in_progress) from other
# conflicts; none of it reaches the mind.
MAX_ERROR = 4096


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Keep the member bearer token on the configured hive endpoint."""
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


class _Unknown(Exception):
    """The request may have reached the host and its outcome is not known. reason is a fixed word, never text
    from the host or the error, which may hold credentials or untrusted content."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _atom(head, *fields):
    # App content stays in quoted data, even if it contains MeTTa expressions.
    # PeTTa reads Unicode literally; it does not decode JSON's unicode escapes.
    atom = "(" + head + " " + " ".join(json.dumps(field, ensure_ascii=False) for field in fields) + " authority-none)"
    atom.encode("utf-8")
    return atom


def _request(program, body):
    if not isinstance(program, str) or not program or program in (".", ".."):
        raise ValueError("invalid-program")
    if not isinstance(body, dict) or set(body) != {"action", "items", "params", "idempotency_key"}:
        raise ValueError("invalid-action-body")
    if not isinstance(body["action"], str) or not body["action"]:
        raise ValueError("invalid-action")
    if not isinstance(body["items"], list) or not all(isinstance(item, str) for item in body["items"]):
        raise ValueError("invalid-items")
    if not isinstance(body["params"], dict):
        raise ValueError("invalid-params")


def _path(key):
    if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}", key):
        raise ValueError("invalid-resume-key")
    memory = Path(os.environ.get("OMEGACLAW_MEMORY_DIR", Path(__file__).resolve().parents[3] / "memory"))
    return memory / "app-actions" / (key + ".json")


def _save(key, saved):
    path = _path(key)
    wire = _json(saved).encode("utf-8")
    if len(wire) > MAX_SAVED:
        raise ValueError("saved-envelope")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Saved before the request leaves, so a key the mind is given always names a request on disk, and an answer
    # lost on the way back can be asked for again under the same key. Kept while a resume may still need it.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(wire.decode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())


def _forget(key):
    """Drop a saved request whose answer the mind already has, since nothing will resume it."""
    try:
        _path(key).unlink()
    except OSError:
        pass   # a leftover file is only an unused convenience; the answer stands


def _load(key):
    with _path(key).open("rb") as stream:
        wire = stream.read(MAX_SAVED + 1)
    if len(wire) > MAX_SAVED:
        raise ValueError("saved-envelope")
    saved = json.loads(wire)
    if not isinstance(saved, dict) or set(saved) != {"program", "body"}:
        raise ValueError("invalid-saved-request")
    _request(saved["program"], saved["body"])
    if saved["body"]["idempotency_key"] != "app-" + key:
        raise ValueError("different-request-key")
    return saved


def _endpoint(program):
    """The act address and the mind's token, checked before anything is saved or sent."""
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_WS_TOKEN", "")
    url = urllib.parse.urlsplit(base)
    if not token or url.scheme not in {"http", "https"} or not url.hostname or url.query or url.fragment or url.username:
        raise ValueError("host-action-not-configured")
    return base + "/api/agent/programs/" + urllib.parse.quote(program, safe="") + "/act", token


def _transport(error):
    """The word for a request that failed in transport: host-unreachable only when no connection was made, so
    nothing reached the host; timeout and connection-failed when it may have run there."""
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, (ConnectionRefusedError, socket.gaierror)):
        return "host-unreachable"
    if isinstance(reason, TimeoutError):
        return "timeout"
    return "connection-failed"


def _refusal_code(error):
    """The host's error code from a refusal body read within MAX_ERROR bytes, or None."""
    try:
        answer = json.loads(error.read(MAX_ERROR))
        code = answer["error"]["code"]
        return code if isinstance(code, str) else None
    except Exception:
        return None


def _post(endpoint, body):
    """One POST. Returns the host's result; raises urllib.error.HTTPError for a host refusal and _Unknown when
    the request may have reached the host but its answer was lost or can't be read."""
    url, token = endpoint
    request = urllib.request.Request(url, data=_json(body).encode("utf-8"),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                                     method="POST")
    try:
        with _OPENER.open(request, timeout=10) as response:
            wire = response.read(MAX_OUTPUT + 1)
    except urllib.error.HTTPError:
        raise
    except Exception as error:
        raise _Unknown(_transport(error)) from None
    if len(wire) > MAX_OUTPUT:
        raise _Unknown("unreadable-host-answer")
    try:
        result = json.loads(wire)
    except ValueError:
        raise _Unknown("unreadable-host-answer") from None
    if not isinstance(result, dict) or not isinstance(result.get("status"), str) or not result["status"]:
        raise _Unknown("unreadable-host-answer")
    return result


def call(skill, text):
    """Return authority-none data for every outcome; send once, never retry automatically.

    app-act takes {program, action, items?, params?} and saves the request under a fresh key before it leaves.
    app-resume takes {key} or {key, approval_id} and sends that saved request again under the same idempotency
    key: after a person approves in the hive, or after AppOutcomeUnknown, once the mind has checked whether the
    action took effect. The host binds an approval to the whole request, even when the mind edits its saved JSON,
    and answers a request it already ran with its recorded result.
    Time and space: linear in the bounded input, saved request and host response.
    """
    try:
        if skill not in {"app-act", "app-resume"} or type(text) is not str or len(text.encode("utf-8")) > MAX_INPUT:
            raise ValueError("input-envelope")
        args = json.loads(text)
        if not isinstance(args, dict):
            raise ValueError("expected-object")
        if skill == "app-act":
            if not {"program", "action"} <= set(args) <= {"program", "action", "items", "params"}:
                raise ValueError("invalid-action-input")
            key = uuid.uuid4().hex
            program = args["program"]
            body = {"action": args["action"], "items": args.get("items", []), "params": args.get("params", {}),
                    "idempotency_key": "app-" + key}
            _request(program, body)
            endpoint = _endpoint(program)
            _save(key, {"program": program, "body": body})
            sent = body
        else:
            if not {"key"} <= set(args) <= {"key", "approval_id"}:
                raise ValueError("invalid-resume-input")
            if "approval_id" in args and (not isinstance(args["approval_id"], str) or not args["approval_id"]):
                raise ValueError("invalid-resume-input")
            key = args["key"]
            saved = _load(key)
            program = saved["program"]
            endpoint = _endpoint(program)
            sent = dict(saved["body"], **({"approval_id": args["approval_id"]} if "approval_id" in args else {}))
        # From here the request is saved under key: whatever happens on the way, a resume can send it again.
        try:
            result = _post(endpoint, sent)
        except urllib.error.HTTPError as error:
            conflict = _refusal_code(error) if error.code == 409 else None
            error.close()
            if conflict == "in_progress":
                return _atom("AppOutcomeUnknown", key, "in-progress")
            if error.code >= 500:
                return _atom("AppOutcomeUnknown", key, "host-http-" + str(error.code))
            if skill == "app-act":
                _forget(key)
            return _atom("AppRefused", skill, "host-http-" + str(error.code))
        except _Unknown as unknown:
            return _atom("AppOutcomeUnknown", key, unknown.reason)
        if result["status"] == "approval_required":
            approval_id = result.get("approval_id")
            if not isinstance(approval_id, str) or not approval_id:
                return _atom("AppOutcomeUnknown", key, "unreadable-host-answer")
            return _atom("AppApprovalRequired", approval_id, key)
        head = "AppRefused" if result["status"] in {"refused", "error"} else "AppResult"
        try:
            answer = _atom(head, program, _json(result))
        except ValueError:   # a value no atom can carry, such as a lone surrogate or NaN
            return _atom("AppOutcomeUnknown", key, "unreadable-host-answer")
        if skill == "app-act":
            _forget(key)
        return answer
    except Exception:
        # Error messages may contain credentials or untrusted response content.
        return _atom("AppRefused", str(skill)[:128], "invalid-input-or-host-action-unavailable")
