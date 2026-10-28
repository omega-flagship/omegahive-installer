"""Membrane between an omega Studio maker and its hive (J3 host R6.1, open item OI-11).

Three calls, each one REST request to the hive's maker routes, the same handlers the MCP tools and the Iter template
tools use, authenticated with this execution's own token (HIVE_WS_TOKEN, which the supervisor sets from the token the
restarted execution was given):

  context(session, execution)               GET  /api/agent/studio-sessions/{sid}/context?execution_id=
  publish(artifact, execution, parent, body) POST /api/agent/artifacts/{id}/revisions {body, parent, execution_id, op_ids}
  done(session, n, execution, more)          POST /api/agent/studio-sessions/{sid}/steps/{n}/done {more, execution_id}

publish sends body exactly as it reached this function (never parsed into something else, re-serialised or
re-indented); its op ids are the body's items' op_id strings, in order: 1-16, distinct, the host's shape, never minted
(the same rule as hive/core/mcp.py studio_op_ids and hive/templates/iter/tools/hive_studio_publish.py).  A body
without them is refused here with op_ids_invalid and nothing is sent.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 20
OP_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")   # the host's shape (L6 wire contract)
MAX_OPS = 16


def _open(request, timeout):
    return urllib.request.urlopen(request, timeout=timeout)


_last_error = None   # the hive's error object of the latest failed call ({code, message, ...details}), else None


def _call(method, path, payload=None):
    global _last_error
    _last_error = None
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_WS_TOKEN", "")
    if not base or not token:
        return None, "HIVE-NOT-CONFIGURED set HIVE_API_URL and HIVE_WS_TOKEN"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(base + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with _open(request, TIMEOUT) as response:
            return json.loads(response.read().decode()), None
    except urllib.error.HTTPError as exc:
        try:
            error = json.loads(exc.read().decode()).get("error", {})
            _last_error = error if isinstance(error, dict) else None
            return None, f"HIVE-ERROR {error.get('code', exc.code)}: {error.get('message', '')}"
        except ValueError:
            return None, f"HIVE-ERROR {exc.code}"
    except OSError as exc:
        return None, f"HIVE-UNREACHABLE {exc}"


def _text(value):
    """An argument as the other hive skills read it (modules/hive hive_commons._text): a quoted MeTTa string unwrapped."""
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].replace('\\"', '"')
    return text


def _quote(value):
    return urllib.parse.quote(_text(value), safe="")


def op_ids(body):
    """The op ids exactly as the body's items carry them, in order; never minted or rewritten. None unless 1-16 distinct."""
    try:
        items = json.loads(body).get("items")
    except (ValueError, AttributeError, TypeError):
        return None
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_OPS:
        return None
    ops = [item.get("op_id") if isinstance(item, dict) else None for item in items]
    if not all(isinstance(op, str) and OP_ID.fullmatch(op) for op in ops) or len(set(ops)) != len(ops):
        return None
    return ops


def context(session_id, execution_id):
    path = f"/api/agent/studio-sessions/{_quote(session_id)}/context"
    execution = _text(execution_id)
    if execution:
        path += "?" + urllib.parse.urlencode({"execution_id": execution})
    result, error = _call("GET", path)
    return error or json.dumps(result, separators=(",", ":"), ensure_ascii=False)


def publish(artifact_id, execution_id, parent, body):
    body = body if isinstance(body, str) else str(body)
    if len(body) >= 2 and body[0] == body[-1] == '"':
        body = _text(body)                 # a quoted MeTTa string, unwrapped as every hive skill does; nothing else
    ops = op_ids(body)
    if ops is None:
        return ("HIVE-ERROR op_ids_invalid: body must be omega-maker-revision-2 JSON whose items carry 1-16 distinct "
                "op_id strings; nothing was sent")
    text = _text(parent)
    if text.lower() in ("", "none", "null"):
        parent_n = None
    else:
        try:
            parent_n = int(float(text))
        except ValueError:
            return "HIVE-ERROR bad_request: parent is the context's parent number, or none; nothing was sent"
    payload = {"body": body, "parent": parent_n, "execution_id": _text(execution_id), "op_ids": ops}
    result, error = _call("POST", f"/api/agent/artifacts/{_quote(artifact_id)}/revisions", payload)
    found = _last_error
    if error and isinstance(found, dict) and found.get("code") == "step_already_published" \
            and type(found.get("revision")) is int:
        # R6.2 (Kimi R6.0): this execution's step already has its proposal (a process that ended published it before a
        # redelivery). The host checked the execution first, so it is this step's own: answer it instead of failing.
        existing, again = _call("GET", f"/api/agent/artifacts/{_quote(artifact_id)}/revisions/{found['revision']}")
        if not again:
            return (f"HIVE-STUDIO-PUBLISHED already {_text(artifact_id)} r{found['revision']} {existing.get('digest')} "
                    f"(this step's proposal was published earlier; nothing new was sent)")
    return error or (f"HIVE-STUDIO-PUBLISHED {_text(artifact_id)} r{result.get('n')} {result.get('digest')} "
                     f"op_ids={','.join(ops)}")


def done(session_id, n, execution_id, more):
    flag = _text(more).lower()
    if flag not in ("true", "false"):
        return "HIVE-ERROR bad_request: more is true or false; nothing was sent"
    try:
        step = int(float(_text(n)))
    except ValueError:
        return "HIVE-ERROR bad_request: n is the step number; nothing was sent"
    path = f"/api/agent/studio-sessions/{_quote(session_id)}/steps/{step}/done"
    result, error = _call("POST", path, {"more": flag == "true", "execution_id": _text(execution_id)})
    return error or f"HIVE-STUDIO-DONE step {result.get('n')} {result.get('state')} more={result.get('more')}"
