"""Purpose: expose hive collaboration and task tools to Omega minds through authenticated host requests."""

import hashlib
import json
import time
import threading
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

TIMEOUT = 20


def _call(method, path, payload=None):
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_WS_TOKEN", "")
    if not base or not token:
        return None, "HIVE-NOT-CONFIGURED set HIVE_API_URL and HIVE_WS_TOKEN"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(base + path, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode()), None
    except urllib.error.HTTPError as exc:
        try:
            error = json.loads(exc.read().decode()).get("error", {})
            return None, f"HIVE-ERROR {error.get('code', exc.code)}: {error.get('message', '')}"
        except ValueError:
            return None, f"HIVE-ERROR {exc.code}"
    except OSError as exc:
        return None, f"HIVE-UNREACHABLE {exc}"


def _text(value):
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].replace('\\"', '"')
    return text


def flows():
    value,error=_call('GET','/api/agent/flows')
    return error or 'HIVE-FLOWS '+json.dumps(value)


def flow_drafts():
    value,error=_call('GET','/api/agent/flows/drafts')
    return error or 'HIVE-FLOW-DRAFTS '+json.dumps(value)


def flow_publish(text):
    value,error=_json_arg(text)
    if error:return error
    result,error=_call('POST','/api/agent/flows/skills',value)
    return error or 'HIVE-FLOW-SKILL '+json.dumps(result)


def flow_run(name,text):
    value,error=_json_arg(text)
    if error:return error
    result,error=_call('POST',f'/api/agent/flows/skills/{urllib.parse.quote(_text(name),safe="")}/runs',value)
    return error or 'HIVE-FLOW-RUN '+json.dumps(result)


def flow_retire(name):
    result,error=_call('POST',f'/api/agent/flows/skills/{urllib.parse.quote(_text(name),safe="")}/retire',{})
    return error or 'HIVE-FLOW-RETIRED '+json.dumps(result)


def flow_run_get(rid):
    result,error=_call('GET',f'/api/agent/flow-runs/{urllib.parse.quote(_text(rid),safe="")}')
    return error or 'HIVE-FLOW-RUN '+json.dumps(result)


def flow_cancel(rid):
    result,error=_call('POST',f'/api/agent/flow-runs/{urllib.parse.quote(_text(rid),safe="")}/cancel',{})
    return error or 'HIVE-FLOW-CANCELLED '+json.dumps(result)


def flow_draft(text):
    value,error=_json_arg(text)
    if error:return error
    result,error=_call('POST','/api/agent/flows',value)
    return error or 'HIVE-FLOW-DRAFT '+json.dumps(result)


def flow_revise(artifact_id,text):
    value,error=_json_arg(text)
    if error:return error
    result,error=_call('POST',f'/api/agent/flows/{_text(artifact_id)}/revisions',value)
    return error or 'HIVE-FLOW-REVISION '+json.dumps(result)


def flow_read(artifact_id,n):
    result,error=_call('GET',f'/api/agent/flows/{_text(artifact_id)}/revisions/{int(float(n))}')
    return error or 'HIVE-FLOW '+json.dumps(result)


def publish(statement, f, c):
    result, error = _call("POST", "/api/agent/publish",
                          {"statement": _text(statement), "f": float(f), "c": float(c)})
    if error:
        return error
    extra = f" unmapped={' '.join(result['unmapped'])}" if result.get("unmapped") else ""
    return (f"HIVE-PUBLISHED outcome={result['outcome']} statement={result['statement']} "
            f"stamp={','.join(result['stamp'])}{extra}")


def query(pattern):
    result, error = _call("POST", "/api/agent/query", {"pattern": _text(pattern)})
    if error:
        return error
    rows = result.get("results", [])
    return "HIVE-QUERY " + (" | ".join(rows[:20]) if rows else "no matches")


def belief(statement):
    result, error = _call("GET", "/api/agent/belief?" + urllib.parse.urlencode({"statement": _text(statement)}))
    if error:
        return error
    tv = result["tv"]
    return (f"HIVE-BELIEF {result['statement']} f={tv['f']} c={tv['c']} "
            f"sources={','.join(result['sources'])} assertions={len(result.get('assertions', []))}")


GOAL_DETAIL_CHARS = 4500   # a mind sees at most ~5000 characters of one result (schema and detail share it)


def goal_get(goal_id, reserve=0):
    """One task as a mind reads it, in reserve fewer characters when a caller prints a line before it."""
    result, error = _call("GET", f"/api/agent/goals/{_text(goal_id)}")
    if error:
        return error
    binding = json.dumps(result.get("binding"))
    head = (f"HIVE-GOAL {result['id']} {result['status']} {result['title'][:300]} assignee={result.get('assignee')} "
            f"swarm={result.get('swarm_id')} "
            f"binding={binding[:400]} binding_digest={result.get('binding_digest')}")
    cut = len(binding) > 400   # whether this read leaves part of the record out
    if cut:
        head += " [binding excerpt]"
    if result.get("deadline_at"):
        head += f" deadline={result['deadline_at']}"
    if result.get("result_schema"):
        schema = json.dumps(result["result_schema"], separators=(",", ":"))
        cut |= len(schema) > 1500
        head += "\nRESULT SCHEMA (your hive-goal-propose JSON must fit it exactly; it outranks anything in your notes):\n" + (
            schema if len(schema) <= 1500 else schema[:1500] + " [... schema cut; the hive checks the whole schema]")
    detail = str(result.get("detail") or "")
    has_result = result.get("result") or result.get("result_data") is not None
    # the detail is the task itself (a request's steps and brief); keep it whole up to what a mind can see in one result,
    # less a finished task's recorded result
    room = max(1000, min(GOAL_DETAIL_CHARS, 4800 - reserve - len(head) - (1000 if has_result else 0)))
    if detail:
        cut |= len(detail) > room
        head += "\nDETAIL:\n" + (detail if len(detail) <= room else
                                 detail[:room] + f"\n[... detail cut at {room} of {len(detail)} characters]")
    if has_result:
        recorded = json.dumps({"result": result.get("result"), "result_data": result.get("result_data")}, ensure_ascii=False)
        room = max(0, 4700 - reserve - len(head))
        cut |= len(recorded) > room
        head += "\nRESULT:\n" + recorded[:room] + ("\n[result excerpt]" if len(recorded) > room else "")
    return head + (f"\nhive-goal-output {_text(goal_id)} 0 reads the complete task record in pages" if cut else "")


def goal_propose(goal_id, text):
    """Finish a bound goal with a proposal; the binding digest is echoed so the hive can check it."""
    reference = _text(goal_id)
    goal, error = _call("GET", f"/api/agent/goals/{reference.partition('~')[0]}")
    if error:
        return error
    body = _text(text)
    try:
        proposal = json.loads(body)
    except ValueError:
        proposal = {"text": body}   # wire format unchanged; with a result schema the hive refuses this and says why
    result_ref = reference if "~" in reference else goal["id"]
    result, error = _call("POST", f"/api/agent/goals/{result_ref}/result", {
        "status": "done", "result": body[:4000],
        "data": {"binding_digest": goal.get("binding_digest"), "proposal": proposal}})
    return error or f"HIVE-GOAL-PROPOSED {result['id']}"


def goal_file(goal_id, path, text):
    """Stage one whole file on a goal you claimed (hive-goal-file): its text is the command's marker-ended body, word
    for word, so it is neither trimmed nor unquoted as other arguments are: PeTTa has already read the string literal and
    hands over its text, so a file that starts and ends with a quote mark (a quoted CSV, a JSON string) keeps them. The
    goal's answer takes it beside its own files map."""
    result, error = _call("POST", f"/api/agent/goals/{_text(goal_id)}/files", {"path": _text(path), "text": str(text)})
    return error or f"HIVE-GOAL-FILE-STAGED {result['path']} ({result['bytes']} bytes)"


def plan_return(request_id, artifact_id, revision):
    """Submit canonical review rows without asking a mind to copy or shorten them."""
    from urllib.parse import urlencode
    rq, art, number = _text(request_id), _text(artifact_id), int(float(revision))
    context, error = _call("GET", f"/api/agent/requests/{rq}/review-context?" +
                           urlencode({"artifact_id": art, "revision": number}))
    if error:
        return error
    request, error = _call("GET", f"/api/agent/requests/{rq}")
    if error:
        return error
    stored, error = _call("GET", f"/api/agent/artifacts/{art}/revisions/{number}")
    if error:
        return error
    proposal = {"plan": stored, "findings": context["findings"],
                "reviews": context["reviews"], "execution_authorized": False}
    goal, error = _call("GET", f"/api/agent/goals/{request['receiving_goal']}")
    if error:
        return error
    result, error = _call("POST", f"/api/agent/goals/{goal['id']}/result", {
        "status": "done", "result": "Reviewed plan returned with canonical findings and receipts",
        "data": {"binding_digest": goal.get("binding_digest"), "proposal": proposal}})
    return error or f"HIVE-GOAL-PROPOSED {result['id']}"


def goal_heartbeat(goal_id):
    """Renew the lease on a goal this mind holds (a held goal whose lease runs out is reopened for others)."""
    result, error = _call("POST", f"/api/agent/goals/{urllib.parse.quote(_text(goal_id), safe='')}/heartbeat", {})
    return error or f"HIVE-GOAL-HEARTBEAT {result['id']} {result['status']} lease_until={result.get('lease_until')}"


def goal_cancel_ack(goal_id):
    result, error = _call("POST", f"/api/agent/goals/{_text(goal_id)}/cancel-ack", {})
    return error or f"HIVE-GOAL-CANCEL-ACKED {result['id']}"


# ---- timed sharing of private memory ------------------------------------------------------

def shares():
    result, error = _call("GET", "/api/agent/shares")
    if error:
        return error
    if not result:
        return "HIVE-SHARES none"
    return "HIVE-SHARES " + " | ".join(
        f"{s['id']} {s['status']} {s['kind']} owner={s['owner_name']} reader={s['grantee_name']} "
        f"{s.get('space') or (s.get('exhibit') or {}).get('title', '')} until={s['expires_at']}" for s in result[:20])


def share_request(owner, space, minutes, reason):
    result, error = _call("POST", "/api/agent/shares/request", {"owner": _text(owner), "space": _text(space),
                                                                 "minutes": float(minutes), "reason": _text(reason)})
    return error or f"HIVE-SHARE-REQUESTED {result['id']} {result['status']} owner={result['owner_name']}"


def share_grant(share_id):
    result, error = _call("POST", f"/api/agent/shares/{_text(share_id)}/grant", {})
    return error or f"HIVE-SHARE-GRANTED {result['id']} to {result['grantee_name']} until {result['expires_at']}"


def share_deny(share_id, reason):
    result, error = _call("POST", f"/api/agent/shares/{_text(share_id)}/deny", {"reason": _text(reason)})
    return error or f"HIVE-SHARE-DENIED {result['id']}"


def share_offer(grantee, space, minutes):
    result, error = _call("POST", "/api/agent/shares/offer", {"grantee": _text(grantee), "space": _text(space),
                                                               "minutes": float(minutes)})
    return error or f"HIVE-SHARE-OFFERED {result['id']} to {result['grantee_name']} until {result['expires_at']}"


SHARED_OUTPUT_CHARS = 3000   # a mind sees only the last 5000 characters of one step's results (maxLastResultsContext)
BODY_INLINE_CHARS = 600      # longer share texts are read in parts with hive-shared-body
BODY_PART_CHARS = 1200       # encoded characters per part, so several fit in one step's results

# Percent-encoding for share text: quotes, backslashes, newlines, apostrophes and semicolons never appear
# raw, so the harness's repr/string-safe and MeTTa comments cannot alter them; decoding is exact.
_PCT = {"%": "%25", '"': "%22", "\\": "%5C", "\n": "%0A", "\r": "%0D", "\t": "%09", "'": "%27", ";": "%3B"}


def pct_encode(text):
    return "".join(_PCT.get(ch, ch) for ch in text)


def pct_decode(text):
    import urllib.parse
    return urllib.parse.unquote(text)


def body_parts(body):
    """Split the encoded body into parts of at most BODY_PART_CHARS without cutting an escape."""
    parts, current = [], ""
    for ch in body:
        enc = pct_encode(ch)
        if current and len(current) + len(enc) > BODY_PART_CHARS:
            parts.append(current)
            current = ""
        current += enc
    if current or not parts:
        parts.append(current)
    return parts


def shared(share_id, text_filter, offset=0):
    """Read a share page by page, up to an output budget. When it cannot fit, it says exactly
    how much is missing and how to continue, so partial work is never mistaken for the whole."""
    sid, flt = _text(share_id), _text(text_filter) or "*"
    start = int(float(offset or 0))
    atoms, first, cursor = [], None, start
    while True:
        query = urllib.parse.urlencode({"q": flt, "limit": 500, "offset": cursor})
        result, error = _call("GET", f"/api/agent/shares/{sid}/atoms?{query}")
        if error:
            return error
        first = first or result
        atoms += result["atoms"]
        cursor = result["next_offset"]
        if cursor is None or sum(len(a) + 1 for a in atoms) > SHARED_OUTPUT_CHARS:
            break
    shown, used = [], 0
    for atom in atoms:
        if used + len(atom) + 1 > SHARED_OUTPUT_CHARS and shown:
            break
        shown.append(atom)
        used += len(atom) + 1
    end = start + len(shown)
    total = first["total"]
    head = (f"HIVE-SHARED {first['share_id']} from={first['owner']} "
            + (f"exhibit={first['title']!r} " if first["kind"] == "exhibit" else f"space={first['space']} ")
            + f"atoms {start + 1 if shown else start}-{end} of {total} until={first['expires_at']}")
    raw_body = first.get("body") or ""
    if not raw_body:
        body = ""
    elif len(raw_body) <= BODY_INLINE_CHARS:
        body = f" text: {raw_body}"
    else:
        body = (f" text: NOT SHOWN HERE ({len(raw_body.encode())} bytes in {len(body_parts(raw_body))} parts, "
                f"sha256:{hashlib.sha256(raw_body.encode()).hexdigest()}); read it with hive-shared-body {sid} 1")
    tail = ("" if end >= total else
            f"\nTRUNCATED: {total - end} more atoms not shown. Continue with hive-shared-page {sid} {end} {flt}")
    return head + body + "".join(f"\n{a}" for a in shown) + tail


# The shapes the hive checks (kept equal to hive/core/collab.py FINDING_SHAPE / REVIEW_SHAPE by a test). A reply that
# could not even be read as JSON says what is expected and shows one exact example; once the JSON reaches the hive,
# its refusals carry a corrected example built from the mind's own request.
FINDING_SHAPE = ('{"request_id": "rq_...", "mandate": {"id": "...", "version": "..."}, "target": {"step": "s1"} or '
                 '{"whole": true}, "severity": "blocker|major|minor|note", "recommendation": "what to change and why", '
                 '"evidence_refs": ["a reference the request exhibited"] (optional)}')
REVIEW_SHAPE = ('{"recommendation": "proceed|revise|hold|unresolved", "rationale": "why (at most 4000 characters)", '
                '"finding_ids": ["fd_..."] (every finding you raised on this request, or [] if none), '
                '"coverage": ["what you checked"] (optional, at most 50 texts of 200 characters)}')
FINDING_EXAMPLE = ('hive-finding {"request_id": "rq_1a2b3c4d", "mandate": {"id": "security", "version": "1"}, '
                   '"target": {"step": "s1"}, "severity": "major", '
                   '"recommendation": "Record consent before s1 exports contact fields.", "evidence_refs": []}')
REVIEW_EXAMPLE = ('hive-review-complete rq_1a2b3c4d {"recommendation": "revise", '
                  '"rationale": "s1 exports contacts without recorded consent.", "finding_ids": ["fd_5e6f7a8b"], "coverage": ["steps s1-s3"]}')
_JSON_GUIDE = {"finding": (FINDING_SHAPE, FINDING_EXAMPLE), "review": (REVIEW_SHAPE, REVIEW_EXAMPLE)}


def _json_arg(text, guide=None):
    try:
        value = json.loads(_text(text))
    except ValueError as exc:
        error = f"HIVE-ERROR bad_request: give a JSON object ({exc})"
    else:
        if isinstance(value, dict):
            return value, None
        error = "HIVE-ERROR bad_request: give a JSON object"
    if guide in _JSON_GUIDE:
        shape, example = _JSON_GUIDE[guide]
        error += (f". Expected: {shape}. Example (use the request id and mandate from hive-goal-get on the review goal "
                  f"you hold): {example}")
    return None, error


_CALENDAR_QUERY_KEYS = {"op", "time_min", "time_max", "limit"}
_CALENDAR_BAD_QUERY = ("HIVE-ERROR bad_request: calendar-read needs timezone-aware RFC3339 time_min and time_max "
                       "within 31 days, limit 1..100 (default 20), and no other fields")
_CALENDAR_BAD_REPLY = "HIVE-ERROR invalid_response: Calendar reply was not a bounded minimal read result"
_CALENDAR_RFC3339 = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)\Z")


def _calendar_time(value):
    if not isinstance(value, str) or len(value) > 64 or not _CALENDAR_RFC3339.fullmatch(value):
        raise ValueError("RFC3339 timestamp required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Timezone required")
    return parsed


def calendar_read(text):
    """Read a connected owner's Calendar as this authenticated mind, never a caller-selected person.

    This skill stays outside LOCAL_ALLOW. The host repeats live ownership, exact per-mind
    consent and policy checks at execution; a successful preflight is not a grant.
    """
    def pairs(rows):
        value = {}
        for key, item in rows:
            if key in value:
                raise ValueError("Duplicate field")
            value[key] = item
        return value

    def constant(_value):
        raise ValueError("Non-finite JSON")

    try:
        raw = _text(text)
        if len(raw.encode("utf-8")) > 4096:
            return _CALENDAR_BAD_QUERY
        query = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        if (not isinstance(query, dict) or set(query) - _CALENDAR_QUERY_KEYS
                or query.get("op", "calendar.read") != "calendar.read"):
            return _CALENDAR_BAD_QUERY
        start, end = _calendar_time(query.get("time_min")), _calendar_time(query.get("time_max"))
        limit = query.get("limit", 20)
        if type(limit) is not int or not 1 <= limit <= 100 or not timedelta(0) < end - start <= timedelta(days=31):
            return _CALENDAR_BAD_QUERY
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        return _CALENDAR_BAD_QUERY

    body = {"op": "calendar.read", "time_min": query["time_min"], "time_max": query["time_max"], "limit": limit}
    result, error = _call("POST", "/api/agent/connectors/google/operations", body)
    if error:
        # Even a faulty host's error body must not become a token-bearing mind reply.
        return ("HIVE-ERROR google_calendar_unavailable: Calendar read was refused or unavailable. "
                "Check the person's Google connection and this mind's permission on the host's You page")
    if (not isinstance(result, dict) or set(result) != {"op", "events", "truncated"}
            or result.get("op") != "calendar.read" or type(result.get("truncated")) is not bool
            or not isinstance(result.get("events"), list) or len(result["events"]) > limit):
        return _CALENDAR_BAD_REPLY
    for event in result["events"]:
        if (not isinstance(event, dict) or set(event) != {"title", "start", "end", "busy"}
                or not isinstance(event["title"], str) or len(event["title"]) > 200
                or any(not isinstance(event[key], str) or not 0 < len(event[key]) <= 128 for key in ("start", "end"))
                or type(event["busy"]) is not bool):
            return _CALENDAR_BAD_REPLY
    try:
        answer = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        size = len(answer.encode("utf-8"))
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return _CALENDAR_BAD_REPLY
    if size > 16000:
        return "HIVE-ERROR too_large: Calendar reply does not fit; ask for a shorter interval or smaller limit"
    return "HIVE-CALENDAR " + answer


def request(text):
    """Ask another swarm for work: {kind, to_swarm, title, from_goal, subject?, constraints?, context_refs?, budget_usd?}."""
    body, error = _json_arg(text)
    if error:
        return error
    result, error = _call("POST", "/api/agent/requests", body)
    return error or f"HIVE-REQUEST {result['id']} {result['state']} -> goal {result['receiving_goal']} in {result['to_swarm']}"


def artifact_create(text):
    """A new artifact your swarm owns: {kind, title, body?, dependency_graph?}. With body its text is saved as revision 1
    in the same step; without it nothing is saved until hive-revision, so the answer names that step with the new id.
    The hive refuses any other field, so nothing a mind sends is dropped while it is told the artifact was made. Once
    its text is saved, the answer names hive-show with the new id: saving puts it on nobody's screen."""
    body, error = _json_arg(text)
    if error:
        if len(_text(text)) > 4000:
            error += (". A long body may have been cut off by your per-turn output limit: create the artifact without "
                      "body, then send the text in parts, one per turn, with hive-revision-part ar_id 1 <text>, "
                      'hive-revision-part ar_id 2 <text> ..., then hive-revision ar_id {"parent": null, "body_parts": '
                      "<number of parts>}")
        return error
    if isinstance(body.get("body"), (dict, list)):   # stored as its JSON text, as hive-revision stores one
        body["body"] = json.dumps(body["body"], ensure_ascii=False, indent=2)
    result, error = _call("POST", "/api/agent/artifacts", body)
    if error:
        return error
    made = f"HIVE-ARTIFACT {result['id']} ({result['kind']}) {result['title']}"
    if result.get("revision"):
        return f"{made} r{result['revision']} {result['digest']}{_show_step(result['id'])}"
    return (f"{made}. Nothing is saved in it yet: save its text with hive-revision {result['id']} "
            '{"body": "...", "parent": null}')


def _show_step(artifact_id):
    """The step after a creation's first saved text. On v0.31 a mind asked to make a picture and show it saved it, was
    answered with its id and digest alone, and told its person it should appear on their Artifacts screen, never calling
    hive-show. Kept apart from the digest by " - ", so the digest a mind copies stays whole."""
    return f" - to show it to the person you are answering, in the middle of their screen: hive-show {artifact_id}"


# ---- long revision bodies in parts (mind fitness 2026-10-06) ------------------------------------------------
# One model turn writes at most maxOutputToken (6000) tokens. On 2026-10-04 four Design revisions of 8-9k characters
# were cut mid-string at exactly that limit (usage: completion_tokens=6000) and refused as unterminated JSON. A body
# can now be staged in parts, one per turn, in the mind's own memory folder, then posted whole by one hive-revision
# (the only step that reaches the hive, and the one the gate decides). Bounded: REVISION_PARTS parts of at most
# REVISION_PART_CHARS characters, the joined body at most the hive's 256 KB.
REVISION_PARTS = 32
REVISION_PART_CHARS = 12000
REVISION_MAX_BYTES = 256 * 1024
_ARTIFACT_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def _raw(value):
    """A text argument exactly as written: surrounding quotes removed, nothing stripped (parts join byte for byte)."""
    text = str(value)
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].replace('\\"', '"')
    return text


# Containment (Correction 1, Review B1 on 03f0bb8). Every staged read, write, listing, reset and cleanup happens
# inside <memory root>/revision_parts/<artifact>, reached hop by hop from an open descriptor of the memory root:
# each directory and file is opened relative to its parent's descriptor with O_NOFOLLOW (a symlink at any component is
# refused, never followed), its inode is checked against the parent's own entry for it after opening, and its real
# path is checked to be under the root. Part files must be regular files with a single link (no hard link to anything
# outside); only such files, named <n>.txt, are ever unlinked, and nothing is removed recursively.
# Correction 2 (Review on d23fce3): an existing inode is never written or truncated. A part is written to a fresh
# private file (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600, random name) relative to the held directory descriptor, fsynced,
# and renamed into place relative to the same descriptor (renameat). A link made to <n>.txt after any check therefore
# keeps its old bytes: the rename replaces the directory entry, never the linked inode's content.
# Stated limit: this contains what the mind's own skill does, not what another process running as the same user does
# at the same moment. Such a process can still rename the held staging directory elsewhere, or link to the fresh
# file before it is renamed (gaining a copy of the new bytes). Neither lets this skill modify or delete the contents
# of any file it did not itself create; unlinking only ever removes a name inside the held staging directory.
_PART_NAME = re.compile(r"^(\d{1,2})\.txt$")
_NOFOLLOW_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


class _Unsafe(Exception):
    """The staging area is not a plain directory tree inside the mind's memory root."""


def _memory_root():
    return os.path.realpath(os.environ.get("OMEGACLAW_MEMORY_DIR") or os.getcwd())


def _open_dir(parent_fd, name, create, root):
    """A subdirectory of parent_fd, never through a link; None if it does not exist and create is False."""
    try:
        st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        if not create:
            return None
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    import stat as _stat
    if not _stat.S_ISDIR(st.st_mode):
        raise _Unsafe(f"{name} is not a plain directory (a link or a file)")
    try:
        fd = os.open(name, _NOFOLLOW_DIR, dir_fd=parent_fd)
    except OSError as exc:
        raise _Unsafe(f"{name} could not be opened as a plain directory ({exc.strerror})") from None
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino) != (st.st_dev, st.st_ino):
        os.close(fd)
        raise _Unsafe(f"{name} changed while it was opened")
    real = _fd_path(fd)
    if real is not None and real != root and not real.startswith(root + os.sep):
        os.close(fd)
        raise _Unsafe(f"{name} resolves outside the memory folder")
    return fd


def _fd_path(fd):
    """The real path of an open directory where the platform can say (macOS F_GETPATH, Linux /proc)."""
    try:
        import fcntl
        if hasattr(fcntl, "F_GETPATH"):
            return os.path.realpath(fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0" * 1024).split(b"\0", 1)[0].decode())
    except OSError:
        return None
    proc = f"/proc/self/fd/{fd}"
    return os.path.realpath(os.readlink(proc)) if os.path.exists(proc) else None


class _Staging:
    """The open staging directory of one artifact: <memory root>/revision_parts/<artifact>."""

    def __init__(self, artifact_id, create):
        if not _ARTIFACT_ID.match(artifact_id):
            raise _Unsafe("the artifact is an id such as ar_1a2b3c4d")
        self.root = _memory_root()
        self.fds = []
        try:
            self.fds.append(os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)))
            for name in ("revision_parts", artifact_id):
                fd = _open_dir(self.fds[-1], name, create, self.root)
                if fd is None:
                    break
                self.fds.append(fd)
        except BaseException:
            self.close()
            raise
        self.fd = self.fds[-1] if len(self.fds) == 3 else None

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _check_file(self, name):
        import stat as _stat
        st = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        if not _stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise _Unsafe(f"{name} is not a plain staged file (a link, or linked elsewhere)")
        return st

    def _names(self):
        """The directory's entries, listed through a descriptor opened now: self.fd was opened before the parts were
        renamed in, and POSIX leaves it unspecified whether readdir on it shows them; tmpfs on some Linux kernels does
        not (omega-flagship/omegahive#623). "." relative to self.fd is the same directory, with no path lookup."""
        fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=self.fd)
        try:
            return os.listdir(fd)
        finally:
            os.close(fd)

    def parts(self):
        """{n: size} of the staged parts; any entry that is not a plain part file is refused, never followed."""
        if self.fd is None:
            return {}
        out = {}
        for name in self._names():
            found = _PART_NAME.match(name)
            if found:
                out[int(found.group(1))] = self._check_file(name).st_size
        return out

    def write(self, k, text):
        """Install part k as a fresh inode: never opens, truncates or writes an existing <k>.txt."""
        import secrets as _secrets
        import stat as _stat
        data = text.encode("utf-8")
        if len(data) > REVISION_PART_CHARS * 4:
            raise _Unsafe("a part is larger than its byte bound")
        name = f"{k}.txt"
        try:
            self._check_file(name)                  # a link already there is refused; the rename never follows it
        except FileNotFoundError:
            pass
        tmp = f".part-{k}-{_secrets.token_hex(8)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o600,
                     dir_fd=self.fd)
        installed = False
        try:
            st = os.fstat(fd)
            if not _stat.S_ISREG(st.st_mode):
                raise _Unsafe("the new part file is not a plain file")
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
            os.close(fd)
            fd = None
            os.rename(tmp, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)     # renameat within the held directory
            installed = True
        finally:
            if fd is not None:
                os.close(fd)
            if not installed:
                try:
                    os.unlink(tmp, dir_fd=self.fd)
                except FileNotFoundError:
                    pass

    def read(self, k):
        name = f"{k}.txt"
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=self.fd)
        try:
            import stat as _stat
            st = os.fstat(fd)
            if not _stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise _Unsafe(f"{name} is not a plain staged file (a link, or linked elsewhere)")
            chunks = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8")
        finally:
            os.close(fd)

    def clear(self, done=None):
        """Unlink the staged part files (plain, single-link <n>.txt only); anything else stays and is reported.
        Each removal is recorded in done as it happens, so a later refusal can say what was already removed."""
        for k in sorted(self.parts()):              # parts() already refuses links and foreign entries
            os.unlink(f"{k}.txt", dir_fd=self.fd)
            if done is not None:
                done.append(f"removed part {k}")

    def remove_if_empty(self, artifact_id):
        if self.fd is not None and not self._names():
            os.rmdir(artifact_id, dir_fd=self.fds[1])


def _unsafe_reply(exc, done=()):
    """A refusal that says exactly what had already happened before the problem was found."""
    if done:
        return f"HIVE-ERROR unsafe_staging: {exc}. Already done before this was found: {', '.join(done)}"
    return f"HIVE-ERROR unsafe_staging: {exc}. Nothing was staged, read or removed"


def revision_part(artifact_id, n, text):
    """Stage part n of a long revision body (part 1 starts a new body). Joined exactly, in order, by hive-revision."""
    art = _text(artifact_id)
    if not _ARTIFACT_ID.match(art):
        return "HIVE-ERROR bad_request: the artifact is an id such as ar_1a2b3c4d"
    try:
        k = int(float(n))
    except (TypeError, ValueError):
        k = 0
    if not 1 <= k <= REVISION_PARTS:
        return f"HIVE-ERROR bad_request: the part number is 1 to {REVISION_PARTS}"
    part = _raw(text)
    if not part or len(part) > REVISION_PART_CHARS:
        return f"HIVE-ERROR bad_request: a part is 1 to {REVISION_PART_CHARS} characters (this one has {len(part)})"
    done = []
    try:
        with _Staging(art, create=True) as staging:
            if k == 1:
                staging.clear(done)
            held = staging.parts()
            if sum(size for i, size in held.items() if i != k) + len(part.encode()) > REVISION_MAX_BYTES:
                return f"HIVE-ERROR too_large: the parts would exceed {REVISION_MAX_BYTES // 1024} KB, the most a revision holds"
            staging.write(k, part)
            done.append(f"staged part {k}")
            held = staging.parts()
    except (_Unsafe, OSError) as exc:
        return _unsafe_reply(exc, done)
    numbers = sorted(held)
    return (f"HIVE-REVISION-PART {art} part {k} stored ({len(part)} characters). Held: parts {numbers}, {sum(held.values())} bytes. "
            f"Next: hive-revision-part {art} {k + 1} <the next text>, or when the body is complete: "
            f'hive-revision {art} {{"parent": <latest revision number or null>, "body_parts": {numbers[-1]}}}')


def _joined_parts(art, count):
    if not _ARTIFACT_ID.match(art):
        return None, "HIVE-ERROR bad_request: the artifact is an id such as ar_1a2b3c4d"
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = 0
    try:
        with _Staging(art, create=False) as staging:
            held = staging.parts()
            if count < 1 or sorted(held) != list(range(1, count + 1)):
                return None, (f"HIVE-ERROR bad_request: body_parts is the number of parts you stored with hive-revision-part, "
                              f"all of them from 1 (held for {art}: {sorted(held) or 'none'})")
            return "".join(staging.read(i) for i in range(1, count + 1)), None
    except (_Unsafe, OSError) as exc:
        return None, _unsafe_reply(exc)


def _clear_staged(art):
    """After the hive accepted the revision: unlink the staged parts, then the empty artifact folder. Never recursive."""
    try:
        with _Staging(art, create=False) as staging:
            staging.clear()
            staging.remove_if_empty(art)
    except (_Unsafe, OSError):
        pass   # the revision is posted; a staging area that is no longer plain is left for a person to look at


def revision(artifact_id, text):
    """A new immutable revision: {body, parent, dependency_graph?}. A JSON object or list as body is stored as its JSON text.
    {parent, body_parts: N} instead of body posts the N parts staged with hive-revision-part, joined exactly."""
    body, error = _json_arg(text)
    if error:
        if len(_text(text)) > 4000:
            art = _text(artifact_id)
            error += (". A long body may have been cut off by your per-turn output limit: send it in parts, one per turn, "
                      f"with hive-revision-part {art} 1 <text>, hive-revision-part {art} 2 <text> ..., then "
                      f'hive-revision {art} {{"parent": <latest revision number or null>, "body_parts": <number of parts>}}')
        return error
    staged = "body_parts" in body and "body" not in body
    if staged:
        joined, error = _joined_parts(_text(artifact_id), body.pop("body_parts"))
        if error:
            return error
        body["body"] = joined
    if isinstance(body.get("body"), (dict, list)):   # no double escaping: the exact stored text is in the revision's digest
        body["body"] = json.dumps(body["body"], ensure_ascii=False, indent=2)
    result, error = _call("POST", f"/api/agent/artifacts/{_text(artifact_id)}/revisions", body)
    if not error and staged:
        _clear_staged(_text(artifact_id))   # posted: the staged parts are done with
    if error:
        return error
    # the first saved text of a creation made without one (a long body sent in parts) is when it can first be shown
    return (f"HIVE-REVISION {_text(artifact_id)} r{result['n']} {result['digest']} changed={result['changed_steps']} "
            f"affected={result['affected_steps']} whole_plan={result.get('whole_plan_in_scope')}"
            + (_show_step(_text(artifact_id)) if result["n"] == 1 else ""))


def revision_read(artifact_id, n):
    result, error = _call("GET", f"/api/agent/artifacts/{_text(artifact_id)}/revisions/{int(float(n))}")
    return error or f"HIVE-REVISION {_text(artifact_id)} r{result['n']} {result['digest']}\n{result['body']}"


def finding(text):
    """Raise a finding on the request you hold: {request_id, mandate, target, severity, recommendation, evidence_refs?}."""
    body, error = _json_arg(text, "finding")
    if error:
        return error
    result, error = _call("POST", "/api/agent/findings", body)
    return error or f"HIVE-FINDING {result['id']} {result['severity']} on r{result['raised_on']['revision']}"


REPORT_SHAPE = ('{"kind": "bug"|"ux"|"idea", "title": "<one line>", "words": "<what happened, in your person\'s terms>", '
                '"steps"?: "...", "expected"?: "...", "conversation"?: "<its id>"}')


def report_problem(text):
    """Draft a report in your person's feedback area: {kind, title, words, steps?, expected?, conversation?}. Nothing is
    sent until your person says yes there; the same title again replaces that draft."""
    body, error = _json_arg(text)
    if error:
        return f"{error}. Expected: {REPORT_SHAPE}"
    result, error = _call("POST", "/api/feedback/drafts", body)
    # no semicolon: the skill wrapper turns one into SEMI, since MeTTa reads it as a comment
    return error or (f"HIVE-REPORT-DRAFT {result['id']} waits in {result['for']}'s feedback area. Nothing is sent until "
                     "they say yes there.")


def _complete_json(prefix, value):
    body = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if len(body) > 16000:
        return "HIVE-ERROR read_limit: canonical feedback exceeds 16000 characters; no partial record returned"
    return prefix + " " + body


def findings_read(artifact_id):
    result, error = _call("GET", f"/api/agent/artifacts/{_text(artifact_id)}/findings")
    return error or _complete_json("HIVE-FINDINGS", result)


def plan_review_context(request_id, artifact_id, revision):
    query = urllib.parse.urlencode({"artifact_id": _text(artifact_id), "revision": int(float(revision))})
    result, error = _call("GET", f"/api/agent/requests/{_text(request_id)}/review-context?" + query)
    return error or _complete_json("HIVE-PLAN-REVIEW-CONTEXT", result)


def finding_response(finding_id, text):
    body, error = _json_arg(text)
    if error:
        return error
    result, error = _call("POST", f"/api/agent/findings/{_text(finding_id)}/response", body)
    return error or f"HIVE-FINDING-RESPONSE {result['id']} planner claim recorded; disposition unchanged"


def finding_disposition(finding_id, text):
    body, error = _json_arg(text)
    if error:
        return error
    result, error = _call("POST", f"/api/agent/findings/{_text(finding_id)}/disposition", body)
    return error or f"HIVE-FINDING-DISPOSITION {result['id']} reviewer judgment recorded"


def review_complete(request_id, text):
    """Finish a review: {recommendation: proceed|revise|hold|unresolved, rationale (text, at most 4000 chars), finding_ids: [every finding you raised on it], coverage?: [at most 50 texts]}."""
    body, error = _json_arg(text, "review")
    if error:
        return error
    result, error = _call("POST", f"/api/agent/requests/{_text(request_id)}/review-complete", body)
    if error:
        return error
    r = result["receipt"]
    return f"HIVE-REVIEW-COMPLETE {r['request_id']} findings={len(r['findings'])} empty={r['empty']} recommendation={r['recommendation']}"


FILES_DIR = "files"            # a mind shares files only from <its folder>/files, never its token, log or memory
MAX_ASSET_BYTES = 100 * 1024 * 1024


def _files_root():
    root = os.path.realpath(os.path.join(os.getcwd(), FILES_DIR))
    os.makedirs(root, exist_ok=True)
    return root


def _confined(path):
    """A path inside <mind folder>/files, with no escape by .. or symlink."""
    root = _files_root()
    full = os.path.realpath(os.path.join(root, _text(path)))
    if full != root and not full.startswith(root + os.sep):
        return None
    return full


def asset_put(path, name):
    """Upload one file from your files/ folder to the hive's asset store, as yourself. Returns its sha256."""
    import mimetypes
    full = _confined(path)
    if full is None or not os.path.isfile(full):
        return f"HIVE-ERROR not_found: put the file in your {FILES_DIR}/ folder and give its path inside it"
    size = os.path.getsize(full)
    if size == 0 or size > MAX_ASSET_BYTES:
        return f"HIVE-ERROR bad_size: a file is 1 byte to {MAX_ASSET_BYTES // (1024 * 1024)} MB"
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_WS_TOKEN", "")
    if not base or not token:
        return "HIVE-NOT-CONFIGURED set HIVE_API_URL and HIVE_WS_TOKEN"
    mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
    label = _text(name) or os.path.basename(full)
    with open(full, "rb") as f:
        data = f.read()
    request = urllib.request.Request(f"{base}/api/agent/assets?name={urllib.parse.quote(label[:200])}", data=data, method="POST",
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": mime})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            out = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            error = json.loads(exc.read().decode()).get("error", {})
            return f"HIVE-ERROR {error.get('code', exc.code)}: {error.get('message', '')}"
        except ValueError:
            return f"HIVE-ERROR {exc.code}"
    except OSError as exc:
        return f"HIVE-UNREACHABLE {exc}"
    return f"HIVE-ASSET {out['sha256']} {out['mime']} {out['bytes']} bytes \"{out['name']}\""


def asset_get(sha, where):
    """Fetch an asset you may read into your files/ folder, its text shown when it is a text file or a PDF (the host reads
    a PDF's text). where: "-" for your own swarm's file, or "ar_id revision"."""
    sha = _text(sha)
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        return "HIVE-ERROR bad_request: give the 64-character sha256"
    where = _text(where)
    query = ""
    if where and where != "-":
        parts = where.split()
        if len(parts) != 2 or not parts[1].isdigit():
            return "HIVE-ERROR bad_request: where is - or \"ar_id revision\""
        query = f"?artifact={urllib.parse.quote(parts[0])}&revision={int(parts[1])}"
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_WS_TOKEN", "")
    request = urllib.request.Request(f"{base}/api/agent/assets/{sha}{query}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            data = response.read()
            mime = response.headers.get("X-Hive-Asset-Type") or response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        return f"HIVE-ERROR {exc.code}: no such asset for you"
    except OSError as exc:
        return f"HIVE-UNREACHABLE {exc}"
    if hashlib.sha256(data).hexdigest() != sha:
        return "HIVE-ERROR corrupt: the bytes do not match their sha256; nothing saved"
    folder = os.path.join(_files_root(), "assets")
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, sha)
    with open(target, "wb") as f:
        f.write(data)
    out = f"HIVE-ASSET-SAVED files/assets/{sha} {len(data)} bytes {mime}"
    text, whole = _readable_text(data, mime), sha
    if text is None and str(mime or "").split(";")[0].strip().lower() == "application/pdf":
        # a PDF's text comes from the host's PDF reader (mind_files.pdf_text); saved beside the PDF for read-file
        result, error = _call("GET", f"/api/agent/assets/{sha}/text{query}")
        if error:
            return f"{out}\n(its text could not be read: {error})"
        text, whole = result["text"], f"{sha}.txt"
        with open(target + ".txt", "w", encoding="utf-8") as f:
            f.write(text)
        if not text.strip():
            return f"{out}\n(the PDF holds no text to read: its pages may be scanned images)"
    if text is not None:   # a text file or a PDF's text is shown too, bounded, so the mind can answer in the same turn
        shown = text[:ASSET_TEXT_MAX]
        more = f" (first {len(shown)} of {len(text)} characters; the rest is in files/assets/{whole})" if len(text) > len(shown) else ""
        out += f"\n--- content{more} ---\n{shown}\n--- end of content ---"
    return out


ASSET_TEXT_MAX = 6000      # characters of a fetched text file shown in the result
TEXT_TYPES = {"application/json", "application/xml", "application/x-yaml", "application/yaml", "application/csv",
              "application/x-sh", "application/javascript", "application/sql", "application/toml"}


def _readable_text(data, mime):
    """The file as text when its type is text and it decodes as UTF-8, else None (binaries are only saved)."""
    kind = str(mime or "").split(";")[0].strip().lower()
    if not (kind.startswith("text/") or kind in TEXT_TYPES or kind.endswith("+json") or kind.endswith("+xml")):
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


ASSET_LIST_MAX = 12000     # characters of one listing a mind receives


def asset_list(cursor):
    """The files you may read (your swarm's, ones a live request to your swarm lists, and for a person's own mind its
    person's), newest first, one page at a time; then linked folders. cursor: "-" for the first page."""
    cursor = _text(cursor)
    query = "?limit=50" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor and cursor != "-" else "")
    result, error = _call("GET", f"/api/agent/assets{query}")
    if error:
        return error
    files, folders = result.get("files") or [], result.get("folders") or []
    lines = [f"HIVE-ASSETS {len(files)} of {result.get('total', len(files))}"
             + (f" next={result['next_cursor']}" if result.get("next_cursor") else "")]
    for f in files:
        who = f.get("added_by_name") or f.get("added_by") or "-"
        lines.append(f"- {f['sha256']} \"{f.get('name')}\" {f.get('mime')} {f.get('bytes')} bytes added {f.get('added_at')} "
                     f"by {who} [{f.get('source')}] read: {f.get('read')}")
    for d in folders:
        lines.append(f"- folder {d['id']} \"{d.get('label')}\" read-only [{d.get('source')}] list: {d.get('list')}")
    if not files and not folders:
        lines.append("(no files yet)")
    out = "\n".join(lines)
    if len(out) > ASSET_LIST_MAX:
        out = out[:ASSET_LIST_MAX] + "\n(cut short; ask for the next page with its cursor)"
    return out


def review_receipts(subject_digest):
    """Coordinator: every specialist receipt on one exact subject, with its reviewer-of-review decisions (dissent kept)."""
    result, error = _call("GET", f"/api/agent/review-receipts?subject_digest={urllib.parse.quote(_text(subject_digest))}")
    if error:
        return error
    lines = [f"HIVE-REVIEW-RECEIPTS {result['count']} on {result['subject_digest'][:20]}"]
    for r in result["requests"]:
        rec = r.get("receipt") or {}
        qc = "; ".join(f"{q['action']}{(': ' + q['notes'][:200]) if q.get('notes') else ''}" for q in r.get("qc") or [])
        lines.append(f"- {r['request_id']} mandate={((rec.get('mandate') or {}).get('id'))} state={r['state']} "
                     f"recommendation={rec.get('recommendation')} findings={len(rec.get('findings') or [])} rationale={str(rec.get('rationale'))[:300]} qc=[{qc}]")
    return "\n".join(lines)


REPO_VIEWS = {"maps", "map", "presets", "nodes", "node", "query", "drift"}
REPO_PAGED = {"nodes", "node", "query", "drift"}
REPO_TEXT_MAX = 12000   # characters of one reply a mind receives


def repo_query(text):
    """Read repository maps (repo-map/1), read-only, through the same routes people use, as this mind. A reply is always
    the host's whole JSON, never cut: a paged view that would not fit REPO_TEXT_MAX is asked again with a smaller limit
    (the cursor stays valid: it is not bound to the limit), and one result that alone does not fit is refused as
    too_large."""
    value, error = _json_arg(text)
    if error:
        return error
    view, q = value.get("view") or "maps", urllib.parse.quote
    if view not in REPO_VIEWS:
        return "HIVE-ERROR bad_request: view is one of " + ", ".join(sorted(REPO_VIEWS))
    repo, sha = q(str(value.get("repo") or ""), safe=""), q(str(value.get("sha") or ""), safe="")

    def fetch(limit):
        paging = {"limit": limit} if limit is not None else {}
        if value.get("cursor") is not None:
            paging["cursor"] = value["cursor"]
        if view == "maps":
            return _call("GET", "/api/repo-maps")
        if view == "map":
            return _call("GET", f"/api/repo-maps/{repo}/{sha}")
        if view == "presets":
            return _call("GET", f"/api/repo-maps/{repo}/presets")
        if view == "nodes":
            args = {k: value[k] for k in ("kind", "path_prefix", "q") if value.get(k)} | paging
            return _call("GET", f"/api/repo-maps/{repo}/{sha}/nodes?" + urllib.parse.urlencode(args))
        if view == "node":
            node = q(str(value.get("node_id") or ""), safe="")
            return _call("GET", f"/api/repo-maps/{repo}/{sha}/nodes/{node}?" + urllib.parse.urlencode(paging))
        if view == "query":
            return _call("POST", f"/api/repo-maps/{repo}/{sha}/query",
                         {"preset": value.get("preset"), "params": value.get("params") or {}} | paging)
        args = {"from": value.get("from") or "", "to": value.get("to") or ""} | paging
        return _call("GET", f"/api/repo-maps/{repo}/drift?" + urllib.parse.urlencode(args))

    asked = value.get("limit")
    if isinstance(asked, str) and asked.isdigit():
        asked = int(asked)
    limit = asked if view in REPO_PAGED else None   # None: the host's default (50); a bad value gets the host's 400
    while True:
        result, error = fetch(limit)
        if error:
            return error
        out = json.dumps(result)
        if len(out) <= REPO_TEXT_MAX:
            return "HIVE-REPO " + out
        if view not in REPO_PAGED:
            return (f"HIVE-ERROR too_large: this {view} answer is {len(out)} characters, more than one reply holds "
                    f"({REPO_TEXT_MAX}); it is not cut")
        current = limit if isinstance(limit, int) else 50
        if current <= 1:
            return (f"HIVE-ERROR too_large: one result here is {len(out)} characters, more than one reply holds "
                    f"({REPO_TEXT_MAX}); it is not cut. Read a narrower node or query")
        limit = max(1, current // 2)


def goal_review(goal_id, decision, notes):
    """Review work submitted to you: accept (done) or return with what to change."""
    result, error = _call("POST", f"/api/agent/goals/{_text(goal_id)}/review", {"decision": _text(decision), "notes": _text(notes)})
    return error or f"HIVE-GOAL-REVIEWED {result['id']} {result['status']}"


def rooms():
    """The rooms you are in: id, kind, name and members."""
    result, error = _call("GET", "/api/agent/rooms")
    if error:
        return error
    if not result:
        return "HIVE-ROOMS none"
    return "HIVE-ROOMS " + " | ".join(f"{r['id']} {r['kind']}{' (your swarm team room)' if r.get('team') else ''} {r['name']}: {', '.join(r['members'][:8])}"
                                      for r in result[:20])


def room_post(room_id, text):
    """Speak in one of your rooms. @Name in the text reaches that mind."""
    result, error = _call("POST", f"/api/agent/rooms/{_text(room_id)}/messages", {"text": _text(text)})
    return error or f"HIVE-ROOM-POSTED {result['room_id']} #{result['seq']}" + (f" to {len(result['delivered_to'])} mind(s)" if result['delivered_to'] else "")


def coffee_note(text):
    """Share a thought with the whole hive in the Coffee Room, unprompted: something you learned, a question, an offer of
    help. Everyone in the hive can read it, so keep private memory out. At most one note an hour; it wakes no one."""
    result, error = _call("POST", "/api/agent/rooms/coffee/messages", {"text": _text(text), "note": True})
    return error or f"HIVE-COFFEE-NOTE {result['room_id']} #{result['seq']}"


def lifecycle(action, lease):
    """A coordinator runs a delegated member under a person-issued lease: start, stop or status."""
    act = _text(action)
    if act not in ("start", "stop", "status"):
        return "HIVE-ERROR bad_request: lifecycle action is start, stop or status"
    result, error = _call("POST", f"/api/agent/lifecycle/{act}", {"lease": _text(lease)})
    if error:
        return error
    return "HIVE-LIFECYCLE " + " ".join(f"{k}={v}" for k, v in result.items())


def lifecycle_start(lease):
    return lifecycle("start", lease)


def lifecycle_stop(lease):
    return lifecycle("stop", lease)


def lifecycle_status(lease):
    return lifecycle("status", lease)


def health():
    """The hive's health overview (only the health mind may read it): minds with current problems, worst first."""
    result, error = _call("GET", "/api/agent/health")
    if error:
        return error
    lines = [f"HIVE-HEALTH totals {result['totals']}"]
    for m in result["minds"]:
        current = [i for i in m["issues"] if i.get("recent")]
        if not current:
            continue
        lines.append(f"{m['name']} ({m['id']}) {m['health']}: " + "; ".join(
            f"{i['kind']} {i['skill']} x{i['count']} -> {i['example']['result'][:120]}" for i in current[:4]))
    return "\n".join(lines) if len(lines) > 1 else lines[0] + " - nothing current"


def shared_body(share_id, part):
    """Part N of a share's text, percent-encoded, with everything needed to know it is complete."""
    sid = _text(share_id)
    try:
        n = int(float(part))
    except (TypeError, ValueError):
        return "HIVE-ERROR bad_request: part is a number from 1"
    result, error = _call("GET", f"/api/agent/shares/{sid}/atoms?" + urllib.parse.urlencode({"limit": 1, "offset": 0}))
    if error:
        return error
    raw = result.get("body") or ""
    if not raw:
        return f"HIVE-SHARED-BODY {sid} has no text (its atoms are read with hive-shared {sid} *)"
    parts = body_parts(raw)
    if not 1 <= n <= len(parts):
        return f"HIVE-ERROR bad_request: part must be 1-{len(parts)}"
    head = (f"HIVE-SHARED-BODY {sid} part={n}/{len(parts)} bytes={len(raw.encode())} "
            f"sha256:{hashlib.sha256(raw.encode()).hexdigest()} encoding=percent")
    tail = (f"NEXT: hive-shared-body {sid} {n + 1} (read one part per step)" if n < len(parts)
            else f"END-OF-BODY: last part {n}/{len(parts)}. The text is complete only if you have all {len(parts)} parts and their joined, decoded text matches the sha256")
    return f"{head}\nBEGIN-PART {n}\n{parts[n - 1]}\nEND-PART {n}\n{tail}"


def shared_page(share_id, offset, text_filter):
    return shared(share_id, text_filter, offset)


def exhibit(to, minutes, text):
    title, _, body = _text(text).partition(" | ")
    atoms = [line for line in body.split("\n") if line.strip().startswith("(")]
    result, error = _call("POST", "/api/agent/exhibits", {"title": title, "to": _text(to), "minutes": float(minutes),
                                                           "body": body, "atoms": atoms})
    return error or (f"HIVE-EXHIBITED {result['exhibit_id']} {result['title']!r} to "
                     f"{len(result['shares'])} dots ({result['bytes']} bytes)")


def _stage(say, items):
    """The stage (hive/core/stage.py): only the person this turn answers sees it; a refusal comes back as HIVE-ERROR."""
    result, error = _call("POST", "/api/agent/stage", {"say": say, "items": [_text(i) for i in items]})
    return error or f"HIVE-STAGE {say} {' '.join(result['items'])}: on the screen of {result['to']}"


def stage_show(thing):
    return _stage("show", [thing])


def stage_recall(thing):
    return _stage("recall", [thing])


def stage_compare(this, that):
    return _stage("compare", [this, that])


def exhibit_space(to, space, minutes, text_filter):
    result, error = _call("POST", "/api/agent/exhibits", {"title": f"{_text(space)} snapshot", "to": _text(to),
                                                           "minutes": float(minutes), "space": _text(space),
                                                           "filter": _text(text_filter) or None})
    return error or (f"HIVE-EXHIBITED {result['exhibit_id']} {result['atoms']} atoms of {_text(space)} to "
                     f"{len(result['shares'])} dots")


# ---- policy gate -----------------------------------------------------------------------

# Skills that never leave the agent and the hive: no round trip needed.
LOCAL_ALLOW = {"send", "send-hive-to", "held-message", "wait", "pin", "query", "remember", "episodes", "hive-publish",
               "hive-query", "hive-belief", "hive-goals", "hive-goal-claim", "hive-goal-done", "hive-goal-fail",
               "hive-goal-create", "hive-shares",
               # only offers a build to the mind's person; the hive's route checks who that is, and nothing is built
               # until they press Start, so it is always open, the one way a mind builds software
               "hive-create",
               # stages text in the mind's own memory folder; only hive-revision sends it, and the gate decides that
               "hive-revision-part"}


def _skill(command):
    text = str(command).strip()
    if text.startswith("(") and len(text) > 1:
        head = text[1:].split(None, 1)
        return head[0].rstrip(")") if head else ""
    return ""


def authorize(command):
    """True to run the command, or the message the loop records instead.

    Returns a bool rather than "allow": a Python string can reach MeTTa as a
    symbol, which would never equal the string "allow".  Fails closed: if the
    hive cannot be asked, the command does not run.
    """
    command = _text(command)
    if _skill(command) in LOCAL_ALLOW:
        return True
    result, error = _call("POST", "/api/agent/authorize", {"command": command})
    if error:
        return f"HIVE-GATE-UNAVAILABLE {error}; the command was not run"
    if result.get("decision") == "allow":
        return True
    return result.get("message") or f"HIVE-DENIED {command}"


# ---- the SKILLS line a mind sees: only what its policy lets it use or ask for ---------------------
# A role's "*" deny used to leave the prompt advertising skills the gate then refused (37 agenda-active and 23
# query-skill-space denials in the 2026-10-04 review trial). The line now names only skills the hive would allow or
# ask about; discovery (skill-help ...) is always allowed by the hive (policy.DISCOVERY_SKILLS) and always shown, and
# a closing note says which kind of skill was left out and how to ask for one. The line lists common skills only, so
# the note never says that an unlisted skill is denied: "Not listed: skills your policy does not allow" made minds tell
# a person they lacked permission for web-search, hive-asset-get and hive-request, all allowed (tester report 11-13).
# Display only: the gate still decides every command, so if the hive cannot be asked the line is shown unfiltered.

SKILL_VIEW_SECONDS = 60
DISCOVERY_SKILLS = ("skill-help", "skill-card", "skill-aliases", "explain-skill", "query-skill-space")
_skill_view = {"at": 0.0, "key": None, "modes": None}
_HINT_STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')
_HINT_SEPARATOR = re.compile(r'(\s*[|;,]\s+|\.\s+|\s+or\s+)')
_HINT_LABEL = re.compile(r'^([A-Z][^:"]{0,60}:\s+)')
_HINT_TOKEN = re.compile(r'[a-z][a-z0-9]*(?:-[a-z0-9*]+)*\*?')
HIDDEN_NOTE = ("Left out above: skills your policy does not allow. A skill these lines never name may still be yours: "
               "query-skill-space topic finds it and skill-help topic shows it. If your work needs a left-out one, use "
               "it: the hive asks a hive admin to allow it, or says why it can't be allowed.")


def _skill_heads():
    try:
        from hive.runtime.extensions import helper_command_parser as parser
    except ImportError:
        from hive.runtime.extensions import helper_command_parser as parser
    return set(parser.SIGNATURE_COMMANDS)


def _named_skills(text, heads):
    """The skills a hint item is about: its leading command word, and any hyphenated skill head later in it
    ('derive it: nal-step ...'); alternatives are joined by '/', and a glob such as hive-share-* names every head it
    matches. A plain word later in an item ('metta direct query') is prose, not a skill."""
    import fnmatch
    named = []
    for i, word in enumerate(text.split()):
        for token in word.strip('.,;:"()').split("/"):
            if not _HINT_TOKEN.fullmatch(token) or (i and "-" not in token):
                continue
            named += sorted(fnmatch.filter(heads, token)) if "*" in token else ([token] if token in heads else [])
    return named


def _line_skills(line, heads):
    return [s for piece in _hint_items(line)[0] for s in _named_skills(_HINT_LABEL.sub("", piece, count=1), heads)]


def _skill_modes(skills):
    key = tuple(sorted(skills))
    if _skill_view["key"] == key and time.monotonic() - _skill_view["at"] < SKILL_VIEW_SECONDS:
        return _skill_view["modes"]
    result, error = _call("POST", "/api/agent/skills/decisions", {"skills": list(key)})
    if error or not isinstance(result, dict) or not isinstance(result.get("decisions"), dict):
        return None
    _skill_view.update(at=time.monotonic(), key=key, modes=result["decisions"])
    return result["decisions"]


def _hint_items(line):
    """(pieces, separators before each piece), split only outside parentheses."""
    pieces, seps, start, prev_sep = [], [], 0, ""
    for match in _HINT_SEPARATOR.finditer(line):
        before = line[:match.start()]
        if before.count("(") != before.count(")"):
            continue
        pieces.append(line[start:match.start()])
        seps.append(prev_sep)
        start, prev_sep = match.end(), match.group(0)
    pieces.append(line[start:])
    seps.append(prev_sep)
    return pieces, seps


def filter_hint_line(line, denied, heads):
    """One hint line without the items that name only denied skills ("" if every skill it named is denied).

    Items are split at '| ', '; ', ', ', '. ' and ' or '. An item naming no skill (the rest of a parenthesis, a
    note) goes with the item before it in its sentence. When items are dropped, the next kept item takes the
    separator and the 'Label: ' of the first dropped one, so 'Reviews: a, b' without a reads 'Reviews: b'."""
    pieces, seps = _hint_items(line)
    kept, gap_sep, gap_label, last_kept = [], None, "", True
    for sep, piece in zip(seps, pieces):
        sentence = not kept and gap_sep is None or sep.lstrip().startswith(".")
        if sentence:
            gap_label, last_kept = "", True
        found = _HINT_LABEL.match(piece)
        label, body = (found.group(1), piece[found.end():]) if found else ("", piece)
        named = _named_skills(body, heads)
        keep = (not all(s in denied for s in named)) if named else (last_kept or sentence)
        last_kept = keep
        if not keep:
            if gap_sep is None:
                gap_sep = sep
            gap_label = gap_label or label
            continue
        out_sep = sep if sentence or gap_sep is None else gap_sep
        kept.append(("" if not kept else out_sep, (label or gap_label) + body))
        gap_sep, gap_label = None, ""
    text = "".join(s + p for s, p in kept).strip()
    if _line_skills(line, heads) and not _line_skills(text, heads):
        return ""
    return text


def skill_hints(lines_repr):
    """The prompt's SKILLS line (getSkills' repr of hint strings) with denied skills left out."""
    raw = str(lines_repr)
    lines = [re.sub(r'\\(.)', r'\1', m) for m in _HINT_STRING.findall(raw)]
    if not lines:
        return raw
    try:
        heads = _skill_heads()
    except Exception:
        return raw
    # discovery is always allowed by the hive, and LOCAL_ALLOW runs without asking it: neither is ever hidden
    named = sorted({s for line in lines for s in _line_skills(line, heads)} - set(DISCOVERY_SKILLS) - LOCAL_ALLOW)
    modes = _skill_modes(named) if named else {}
    if modes is None:
        return raw
    denied = {s for s, mode in modes.items() if mode == "deny"}
    if not denied:
        return raw
    shown = [kept for kept in (filter_hint_line(line, denied, heads) for line in lines) if kept]
    shown.append(HIDDEN_NOTE)
    return "(" + " ".join('"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"' for s in shown) + ")"


# ---- traces and control ------------------------------------------------------------------

def trace(iteration, message, response, results, rested=False, cause=""):
    """Report one loop iteration to the hive's thinking timeline, with the runtime's own account of it: rested says
    this reply leaves the mind resting after refused replies (hive_helpers.rests_after), and cause says why the runtime
    refused it (hive_services.last_failure_cause). Neither is read from the reply's text, so the hive can end the work
    goals a stopped mind holds with that reason (Goals.stop_held) instead of leaving them claimed under a lease."""
    payload = {"iteration": int(iteration or 0), "input": _text(message) or None,
               "response": _text(response), "results": str(results),
               "rested": str(rested).lower() in ("true", "1"), "failure_cause": str(cause or "")}
    _call("POST", "/api/agent/trace", payload)
    return "HIVE-TRACED"


def _metta_string(text):
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


def take_control():
    """Queued memory operations as MeTTa: ((retire "space" "atom") (reset))."""
    result, error = _call("GET", "/api/agent/control")
    if error or not result:
        return "()"
    ops = []
    for op in result.get("ops", []):
        if op.get("op") == "retire":
            ops.append(f"(retire {_metta_string(op['space'])} {_metta_string(op['atom'])})")
        elif op.get("op") == "reset":
            ops.append("(reset)")
    return "(" + " ".join(ops) + ")"


# ---- boot receipt: what this mind actually registered (S4) --------------------------------------

import pathlib
import uuid

_CORE_GLOBS = ("skill_affordance*.metta", "skill_catalog*.metta", "skill_signatures*.metta")


def _source_digest(files):
    """Same function as hive/core/inventory.py source_digest: the hive recomputes it from its own copy of the sources."""
    h = hashlib.sha256()
    for path in sorted(files, key=lambda p: p.name):
        h.update(path.name.encode() + b"\0" + hashlib.sha256(path.read_bytes()).hexdigest().encode() + b"\n")
    return "sha256:" + h.hexdigest()


def _pairs(text):
    return re.findall(r"\(\s*([^()\s]+)\s+([^()\s]+)\s*\)", str(text))


def _atoms(text):
    return [a for a in re.findall(r"[^()\s]+", str(text))]


def _toml_field(text, key):
    found = re.search(rf'^{key}\s*=\s*"([^"]*)"', text, re.M)
    return found.group(1) if found else None


def _module_entry(modules_root, directory, loaded):
    """One module of the receipt: its directory, id, version, the digest of its .metta sources and the skill heads its
    signatures.metta declares, and whether the space holds its module id (``loaded``, the ids the mind loaded)."""
    toml = modules_root / directory / "module.toml"
    text = toml.read_text(encoding="utf-8") if toml.exists() else ""
    module_id = _toml_field(text, "id")
    sources = sorted((modules_root / directory).glob("*.metta"))
    heads = []
    signatures = modules_root / directory / "signatures.metta"
    if signatures.exists():
        heads = sorted(set(re.findall(r"^\(SkillSignature\s+([^\s()]+)", signatures.read_text(encoding="utf-8"), re.M)))
    entry = {"dir": directory, "configured": True, "loaded": module_id in loaded if module_id else False,
             "signature_heads": heads}
    if module_id:
        entry["id"] = module_id
    version = _toml_field(text, "version")
    if version:
        entry["version"] = version
    if sources:
        entry["source_digest"] = _source_digest(sources)
    return entry


def inventory_receipt(provides_text, modules_text, parser=None):
    """The boot receipt: the module ids this process loaded, the (module, skill) pairs its space holds, and the
    skill heads its parser registered.  ``parser`` is the helper_command_parser module (injected for tests).

    Each module the loader names but this mind leaves out, because its manifest requires what the mind lacks
    (module_selection), is listed too, never loaded, with ``left_out`` holding those unmet requires entries in the
    manifest's order, for example ["service:omegacode"]: the hive words them ("needs the OmegaCode client"), so the
    Tools page and the mind's own inventory read say why its skills are missing instead of leaving it out silently."""
    if parser is None:
        try:
            from hive.runtime.extensions import helper_command_parser as parser
        except ImportError:
            from hive.runtime.extensions import helper_command_parser as parser
    core_root = pathlib.Path(parser.CORE_ROOT)
    modules_root = pathlib.Path(parser.MODULE_DECLARATIONS_ROOT)
    loaded = set(_atoms(modules_text))
    loaders = parser._active_module_loader_paths()
    # the modules this mind runs: its loader's, less those whose manifest requires what it lacks (module_selection)
    running, off = parser.module_selection(loaders[0]) if loaders else ([], {})
    directories = list(running)
    # J3 host R6.1: a module the host loaded into this mind beyond its loader (OMEGACLAW_EXTRA_MODULES); none when unset
    directories += [d for d in getattr(parser, "_extra_module_names", lambda: [])() if d not in directories]
    modules = [_module_entry(modules_root, directory, loaded) for directory in directories]
    # a left-out module the host loads anyway is running, so it is listed once, above
    for directory, missing in off.items():
        if directory not in directories:
            modules.append({**_module_entry(modules_root, directory, ()), "left_out": [str(e) for e, _why in missing]})
    commands = {}
    for name, args in dict(parser.SIGNATURE_COMMANDS).items():
        commands[str(name)] = [[str(kind), list(map(str, arg)) if isinstance(arg, (tuple, list)) else str(arg)] for kind, arg in args]
    receipt = {"boot_id": uuid.uuid4().hex, "pid": os.getpid(), "modules": modules, "parser": commands,
               "provides": [[m, s] for m, s in _pairs(provides_text)]}
    core = sorted(p for pattern in _CORE_GLOBS for p in (core_root / "hive/runtime/extensions").glob(pattern))
    if core:
        receipt["core"] = {"source_digest": _source_digest(core)}
    if loaders:
        receipt["loader"] = {"ref": loaders[0].name, "source_digest": _source_digest([loaders[0]])}
    return receipt


INVENTORY_WAIT_SECONDS = 120     # how long a booting mind keeps starting attempts while its hub connection comes up


def _post_inventory_once(provides_text, modules_text):
    """One attempt: capture this connection's nonce, then build a fresh receipt under it and post it.
    Returns (outcome, retry): retry is True only when the hub connection is not up yet."""
    try:
        nonce, error = _call("GET", "/api/agent/inventory/nonce")
        if error:
            return f"HIVE-INVENTORY-SKIPPED {error}", error.startswith("HIVE-ERROR not_connected")
        receipt = inventory_receipt(_text(provides_text), _text(modules_text))
        receipt["boot_nonce"] = nonce["boot_nonce"]
        result, error = _call("POST", "/api/agent/inventory", receipt)
    except Exception as exc:   # an unreadable source tree must not stop a boot
        return f"HIVE-INVENTORY-SKIPPED {type(exc).__name__}", False
    if error:
        return f"HIVE-INVENTORY-SKIPPED {error}", False
    return f"HIVE-INVENTORY-POSTED revision={result['inventory_revision']}", False


def post_inventory(provides_text="()", modules_text="()", wait_seconds=None, sleep=time.sleep):
    """Boot hook: tell the hive what this process registered.  Never raises and never blocks a boot.

    The hook runs while the channel daemon is still connecting, so the first attempt can meet `not_connected`
    (Root, Tools r5 shadow 2026-10-04).  Only that condition is retried, in the background, with backoff and a hard
    time limit; each retry captures the then-current nonce and builds a fresh receipt under it.  Any other error ends
    the attempt, so nothing old is ever refreshed.  The limit is checked between attempts, so the last attempt can
    finish up to two request timeouts after it (worst case INVENTORY_WAIT_SECONDS + 2 * TIMEOUT)."""
    outcome, retry = _post_inventory_once(provides_text, modules_text)
    if not retry:
        return outcome
    limit = INVENTORY_WAIT_SECONDS if wait_seconds is None else wait_seconds

    def keep_trying():
        deadline, delay = time.monotonic() + limit, 0.5
        while time.monotonic() < deadline:
            sleep(min(delay, max(0.0, deadline - time.monotonic())))
            _, again = _post_inventory_once(provides_text, modules_text)
            if not again:
                return
            delay = min(delay * 2, 5.0)

    threading.Thread(target=keep_trying, name="hive-inventory-boot", daemon=True).start()
    return "HIVE-INVENTORY-WAITING not_connected"


# ---- goals ---------------------------------------------------------------------------------

def held_goals(statuses=("claimed", "waiting"), holder_only=False):
    """The goals in these statuses this mind holds (claimed_by) or, unless holder_only, is assigned: (goals, None), or
    (None, error). One reading of what a mind holds, for hive-goals' list and the loop's turns (hive_helpers.held_goal),
    which counts only what it claimed itself, since a goal assigned to it but claimed by another mind is not its work."""
    me = os.environ.get("HIVE_AGENT_ID", "")
    mine = []
    for status in statuses:
        held, error = _call("GET", f"/api/agent/goals?status={status}")
        if error:
            return None, error
        mine += [g for g in held or [] if me and (g.get("claimed_by") == me or (not holder_only and g.get("assignee") == me))]
    return mine, None


def goals():
    """Current held or assigned tasks, open swarm tasks, and recent completed work."""
    me = os.environ.get("HIVE_AGENT_ID", "")
    mine, error = held_goals()
    if error:
        return error
    result, error = _call("GET", "/api/agent/goals?status=open")
    if error:
        return error
    mine += [g for g in result or [] if me and g.get("assignee") == me]
    rest = [g for g in result or [] if g not in mine]
    line = lambda g: f"{g['id']} {g['status']} p={g['priority']:.2f} {g['title']}"
    page, error = _call("GET", "/api/agent/goals/history")
    if error:
        return error
    done = " | ".join(f"{g['id']} {g['updated_at']} {g['title']}: {str(g.get('result') or '')[:120]}" for g in page["goals"])
    blocks = [("yours: ", " | ".join(line(g) for g in mine[:10]) or "none"),
              ("open: ", " | ".join(f"{g['id']} p={g['priority']:.2f} {g['title']}" for g in rest[:20]) or "none")]
    # a person's message is work too, though no goal holds it (replies.py): what this mind still owes an answer
    owed, error = _call("GET", "/api/agent/replies/owed")
    if not error and isinstance(owed, dict) and owed.get("owed"):
        blocks.append(("owed answers: ", " | ".join(f'{o["from_name"]}: "{o["text"]}" (send-hive-to {o["conversation_id"]} '
                                                    "<answer>)" for o in owed["owed"])))
    blocks.append(("done: ", done or "none"))
    return "HIVE-GOALS " + " || ".join(label + text[:1500] + (" [list excerpt]" if len(text) > 1500 else "")
                                     for label, text in blocks) + " (hive-goal-history searches older work)"


def _goal_page(path, offset, query=None):
    """MeTTa numbers can arrive as 3.0; page offsets must be whole character or record counts."""
    try:
        number = float(_text(offset))
        if not number.is_integer():
            raise ValueError
    except (ValueError, OverflowError):
        return None, "HIVE-ERROR bad_request: offset must be an integer"
    params = {"offset": int(number)}
    if query is not None:
        params["q"] = _text(query)
    return _call("GET", path + "?" + urllib.parse.urlencode(params))


def goal_history(query, offset):
    page, error = _goal_page("/api/agent/goals/history", offset, query)
    if error:
        return error
    lines = []
    for goal in page["goals"]:
        lines.append(f"{goal['id']} done {goal['updated_at']} {goal['title'][:300]}\n"
                     f"result excerpt: {str(goal.get('result') or '')[:300]}\n"
                     f"data excerpt: {json.dumps(goal.get('result_data'), ensure_ascii=False)[:500]}")
    return "HIVE-GOAL-HISTORY " + ("\n".join(lines) or "none") + f"\nnext_offset={page['next_offset']} (same query); hive-goal-output reads complete output"


def goal_continue(goal_id, instruction):
    goal, error = _call("POST", f"/api/agent/goals/{_text(goal_id)}/continue", {"instruction": _text(instruction)})
    if error:
        return error
    # The follow-up is already this mind's and carries the earlier work, so this reply is all its next turn needs.
    head = (f"HIVE-GOAL-CONTINUED {goal['id']} is yours: finish it with hive-goal-done {goal['id']} <the finished work>, "
            "or hive-goal-propose if it shows a RESULT SCHEMA\n")
    return head + goal_get(goal["id"], len(head))


def goal_output(goal_id, offset):
    page, error = _goal_page(f"/api/agent/goals/{_text(goal_id)}/output", offset)
    return error or page["text"] + f"\nnext_offset={page['next_offset']}"


def rest_check():
    """Tell the hive this mind stopped calling the model, its turns spent or a wait chosen (loop_hooks.metta
    hive-rest-check, once per rest). While a person's message to it has no answer, the hive's reply comes as a message:
    HIVE-REPLY-OWED the first time, which gives the mind new turns, then a note in the person's chat (replies.py).
    The conversations this mind has answers queued for, not yet sent by the channel daemon, go along so they count as
    answered. If the hive cannot be asked, the mind just rests."""
    try:
        import hive_channel
        queued = hive_channel.unsent_conversations()
    except (ImportError, OSError):   # no hive channel in this process, or its outbox unreadable: nothing known queued
        queued = []
    _call("POST", "/api/agent/replies/rest", {"in_flight": queued})
    return "HIVE-REST-CHECKED"


def goal_claim(goal_id):
    result, error = _call("POST", f"/api/agent/goals/{_text(goal_id)}/claim")
    return error or f"HIVE-GOAL-CLAIMED {result.get('claim_ref') or result['id']} {result['title']}"


def goal_finish(goal_id, status, text):
    result, error = _call("POST", f"/api/agent/goals/{_text(goal_id)}/result",
                          {"status": status, "result": _text(text)})
    # The status the hive set: a done result for a reviewed task is submitted and waits for its reviewer.
    return error or f"HIVE-GOAL-{str(result['status']).upper()} {result['id']}"


def goal_create(parent_id, title):
    parent = _text(parent_id)
    payload = {"title": _text(title)}
    if parent and parent not in ("none", "-"):
        payload["parent_id"] = parent
    result, error = _call("POST", "/api/agent/goals", payload)
    return error or f"HIVE-GOAL-CREATED {result['id']} {result['title']}"


def create(sentence):
    """Ask Create to build software: the hive offers what to build, in the asker's words, to this mind's person, and
    Create's code minds build it once they press Start in Create on the offer card, in their Ask or the mind's chat (POST
    /api/agent/create). The offer goes to the person of the conversation the mind is answering (_reply_conversation);
    with none, the hive offers it to the mind's own person or else whoever last wrote to it. What the mind may tell
    them is the hive's own line (the answer's next, create_offers.OFFERED_NEXT)."""
    payload = {"sentence": _text(sentence)}
    conversation = _reply_conversation()
    if conversation:
        payload["conversation_id"] = conversation
    result, error = _call("POST", "/api/agent/create", payload)
    return error or f"HIVE-CREATE-OFFERED {result['id']}: {result['next']}"


def _reply_conversation():
    """The conversation a plain send would answer now (modules/channel_hive, hive_channel.reply_conversation), or ""
    when several wait for an answer or the mind has no hive channel."""
    try:
        import hive_channel
    except ImportError:
        return ""
    return hive_channel.reply_conversation()


# ---- semicolons ---------------------------------------------------------------------------------
# A ';' inside a py-call result starts a MeTTa comment, so the rest of the result is silently lost
# (found 2026-10-03 in the code module). Every skill result a mind reads is encoded the same way as
# modules/code: ';' is shown as SEMI and a literal SEMI as the six characters LIT. Text a mind sends
# back (a proposal echoing a snapshot, a message, a belief) is decoded, so round trips are exact.
# trace and take_control are the harness's own plumbing, not results a mind reads, and stay raw.

SEMI = "⁏"
LIT = "\\u204f"


def encode(raw):
    return raw.replace(SEMI, LIT).replace(";", SEMI)


def decode(text):
    marker = "\x00LIT\x00"
    return text.replace(LIT, marker).replace(SEMI, ";").replace(marker, SEMI)


def _membrane(fn):
    def wrapped(*args):
        result = fn(*(decode(a) if isinstance(a, str) else a for a in args))
        return encode(result) if isinstance(result, str) else result
    wrapped.__name__ = fn.__name__
    wrapped.__doc__ = fn.__doc__
    return wrapped


RAW = {"trace", "take_control", "post_inventory"}
SKILLS = ["repo_query", "flow_drafts", "flow_publish", "flow_run", "flow_retire", "flow_run_get", "flow_cancel", "flows", "flow_draft", "flow_revise", "flow_read", "findings_read", "plan_review_context", "finding_response", "finding_disposition", "plan_return", "review_receipts", "asset_put", "asset_get", "asset_list", "goal_review", "rooms", "room_post", "coffee_note", "request", "artifact_create", "revision", "revision_part", "revision_read", "finding", "review_complete", "lifecycle_start", "lifecycle_stop", "lifecycle_status", "health", "shared_body", "belief", "exhibit", "exhibit_space", "stage_show", "stage_recall", "stage_compare", "goal_cancel_ack", "goal_heartbeat", "goal_claim", "goal_create", "goal_finish", "goal_get", "create",
          "goal_propose", "goal_file", "goals", "goal_history", "goal_continue", "goal_output", "publish", "query", "share_deny", "share_grant", "share_offer", "share_request", "shared",
          "shared_page", "shares", "calendar_read", "report_problem"]
for _name in SKILLS:
    globals()[_name] = _membrane(globals()[_name])
