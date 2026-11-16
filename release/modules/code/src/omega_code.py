"""Membrane between an Omega mind and OmegaCode, through Codex's NativeClient.

The mind works as itself: every call asks the hive for a short capability for *its* member token, on a
goal it holds.  This membrane keeps a small per-mind state file (current goal, repository, workspace,
the version of each file the mind last read, and operations waiting for approval):

- edits are made against the file digest and workspace generation the mind last *read*, so a person's
  edit in between makes the mind's edit stale (refused), never silently overwritten;
- an operation that needs approval is remembered exactly (same operation id, same payload); when the
  mind repeats the same command after "[APPROVED p_…]", it is retried with that approval id.
"""

import hashlib
import json
import os
import pathlib
import shlex
import sys
import time
import urllib.request

_SRC = os.environ.get("OMEGACODE_SRC", "")
if _SRC and _SRC not in sys.path:
    sys.path.insert(0, _SRC)

STATE_NAME = "omegahive-code.json"
MAX_SHOW = 6000


def _state_path():
    base = os.environ.get("OMEGACLAW_MEMORY_DIR") or "."
    return pathlib.Path(base) / STATE_NAME


def _load():
    try:
        return json.loads(_state_path().read_text())
    except (OSError, ValueError):
        return {"files": {}, "pending": {}}


def _save(state):
    path = _state_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, path)


def _text(value):
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].replace('\\"', '"')
    return text.replace("_newline_", "\n").replace("_quote_", '"')


def _client():
    try:
        from omegacode.client import NativeClient
    except ImportError:
        return None, "CODE-UNAVAILABLE the OmegaCode client is not installed for this mind (OMEGACODE_SRC)"
    hive, token = os.environ.get("HIVE_API_URL"), os.environ.get("HIVE_WS_TOKEN")
    if not hive or not token:
        return None, "CODE-UNAVAILABLE this mind has no hive identity"
    # A mind reaches Code through the hive's relay, which proves the Code listener on the same connection before the
    # capability is sent. Code R1.4+ refuses an hc1 capability that arrives without that proof (2026-10-29).
    return NativeClient(hive, token, hive.rstrip("/") + "/api/agent/code/relay"), None


def _error(result):
    body = result.get("result") or {}
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, str):  # OmegaCode: {"error": "approval_required", "message": ..., "details": {...}}
        return err, str(body.get("message") or ""), body.get("details") or {}
    if isinstance(err, dict):  # the hive's shape: {"error": {"code", "message", ...}}
        return err.get("code", "error"), err.get("message", ""), err.get("details") or {k: v for k, v in err.items() if k not in ("code", "message")}
    if isinstance(body, dict) and body.get("detail"):
        return "error", str(body["detail"])[:300], {}
    return "error", json.dumps(body)[:300], {}


def _call(action, payload, state, key=None):
    """One operation, with exact-approval retry.  Returns (ok, body_or_message)."""
    if not state.get("goal") or not state.get("repo"):
        return False, "CODE-NO-WORKSPACE open one first: code-open g_id repository"
    pending = state.setdefault("pending", {})
    if key and key in pending:
        payload = pending[key]["payload"]  # exactly what was approved
        approval = pending[key].get("approval_id")
        if approval:
            payload = dict(payload, approval_id=approval)
    client, problem = _client()
    if client is None:
        return False, problem
    try:
        result = client.call(action, state["goal"], state["repo"], payload)
    except Exception as exc:  # network, bad response
        return False, f"CODE-UNREACHABLE {type(exc).__name__}"
    finally:
        client.close()
    if result.get("ok"):
        if key:
            pending.pop(key, None)
        return True, result.get("result")
    code, message, details = _error(result)
    if code == "approval_required" and key:
        pending[key] = {"payload": {k: v for k, v in payload.items() if k != "approval_id"},
                        "approval_id": details.get("approval_id"), "at": time.time()}
        return False, (f"CODE-APPROVAL-NEEDED {details.get('approval_id')} for {details.get('skill', action)}: a person must approve it. "
                       "When you receive [APPROVED ...], repeat exactly the same command.")
    if result.get("phase") == "capability":
        return False, f"CODE-REFUSED {code}: {message} (you need a claimed goal in your own swarm)"
    if code in ("stale", "stale_generation", "stale_file", "conflict", "generation_mismatch", "digest_mismatch") or (result.get("http_status") == 409 and code != "artifact_corrupt"):
        if key:
            pending.pop(key, None)
        return False, f"CODE-STALE {code}: the workspace changed since you read it (perhaps a person edited it). Read the file again, then redo your change."
    if key:
        pending.pop(key, None)
    return False, f"CODE-ERROR {code}: {message}"


def _track(state, workspace):
    if isinstance(workspace, dict) and workspace.get("id"):
        state["ws"] = workspace["id"]
        state["generation"] = workspace.get("generation")
        state["tree_digest"] = workspace.get("tree_digest")


def _key(*parts):
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:24]


# ---- skills ----------------------------------------------------------------------------------

def repos():
    base, token = os.environ.get("HIVE_API_URL", "").rstrip("/"), os.environ.get("HIVE_WS_TOKEN", "")
    try:
        request = urllib.request.Request(base + "/api/agent/code/repositories", headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=15) as response:
            items = json.loads(response.read().decode())
    except Exception as exc:
        return f"CODE-UNREACHABLE {type(exc).__name__}"
    return "CODE-REPOS " + " | ".join(f"{r['id']} - {r.get('label', '')}" for r in items) if items else "CODE-REPOS none"


def open_workspace(goal, repository):
    goal, repository = _text(goal), _text(repository)
    previous = _load()
    # a repeated open of the same goal and repository keeps its waiting approval (exact-approval retry)
    pending = previous.get("pending", {}) if previous.get("goal") == goal and previous.get("repo") == repository else {}
    state = {"goal": goal, "repo": repository, "files": {}, "pending": pending}
    base, token = os.environ.get("HIVE_API_URL", "").rstrip("/"), os.environ.get("HIVE_WS_TOKEN", "")
    try:
        request = urllib.request.Request(base + "/api/agent/code/repositories", headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=15) as response:
            commit = next((r["commit"] for r in json.loads(response.read().decode()) if r["id"] == repository), None)
    except Exception:
        commit = None
    if not commit:
        return f"CODE-ERROR unknown_repository: {repository} is not open to minds; try code-repos"
    ok, body = _call("workspace", {"operation_id": f"open-{goal}-{repository}", "base_commit": commit}, state, key=_key("open", goal, repository))
    if not ok:
        _save(state) if "APPROVAL" in str(body) else None
        return body
    _track(state, body)
    _save(state)
    return f"CODE-OPEN {state['ws']} generation {state['generation']} of {repository} for {goal}. Next: code-search or code-read a file."


def tools():
    state = _load()
    ok, body = _call("toolchains", {"workspace_id": state.get("ws")}, state)
    return ("CODE-TOOLS " + json.dumps(body)[:MAX_SHOW]) if ok else body


def read(path):
    state = _load()
    path = _text(path)
    # always a fresh read of the current workspace; only edits carry the version the mind saw
    ok, body = _call("read", {"workspace_id": state.get("ws"), "path": path}, state)
    if not ok:
        return body
    state.setdefault("files", {})[path] = {"digest": body.get("digest"), "content": body.get("content", ""), "generation": body.get("generation"),
                                           "tree_digest": body.get("tree_digest")}
    if body.get("tree_digest"):
        state["tree_digest"], state["generation"] = body["tree_digest"], body.get("generation", state.get("generation"))
    _save(state)
    content = body.get("content", "")  # the wrapper encodes the whole result once
    shown = content if len(content) <= MAX_SHOW else content[:MAX_SHOW] + f"\n… ({len(content) - MAX_SHOW} more characters)"
    return f"CODE-FILE {path} (generation {body.get('generation')}):\n{shown}"


def search(query):
    state = _load()
    ok, body = _call("search", {"workspace_id": state.get("ws"), "query": _text(query), "limit": 20}, state)
    return ("CODE-FOUND " + json.dumps(body)[:MAX_SHOW]) if ok else body


def replace(path, change):
    state = _load()
    path, change = _text(path), _text(change)
    seen = state.get("files", {}).get(path)
    if not seen:
        return f"CODE-READ-FIRST read {path} with code-read before changing it"
    if "==>" not in change:
        return "CODE-ERROR bad_change: write it as  old text ==> new text"
    old, new = (part.strip() for part in change.split("==>", 1))
    raw = seen["content"]
    span = raw_span(raw, old)
    if span is None:
        return f"CODE-ERROR no_unique_match: the old text must appear exactly once in {path} as you last read it"
    content = raw[:span[0]] + decode(new) + raw[span[1]:]
    key = _key("replace", state["ws"], path, seen["digest"], old, new)
    payload = {"workspace_id": state.get("ws"), "operation_id": f"edit-{key}", "expected_generation": seen.get("generation") or state.get("generation"),
               "expected_tree_digest": seen.get("tree_digest") or state.get("tree_digest"), "edits": [{"path": path, "expected_digest": seen["digest"], "content": content}]}
    ok, body = _call("edit", payload, state, key=key)
    if not ok:
        _save(state)
        return body
    _track(state, body.get("workspace"))
    state["files"].pop(path, None)  # read again before the next change
    _save(state)
    return f"CODE-CHANGED {path}: workspace is now generation {state.get('generation')}. Run the tests with code-exec."



def create(path, content):
    state = _load()
    if not state.get("ws"):
        return "CODE-NO-WORKSPACE"
    path, content = _text(path), decode(_text(content))
    key = _key("create", state["ws"], state.get("generation"), state.get("tree_digest"), path, content)
    payload = {"workspace_id": state["ws"], "operation_id": f"create-{key}",
               "expected_generation": state.get("generation"), "expected_tree_digest": state.get("tree_digest"),
               "edits": [{"path": path, "expected_digest": None, "content": content}]}
    ok, body = _call("edit", payload, state, key=key)
    if ok:
        _track(state, body.get("workspace"))
        state.setdefault("files", {}).pop(path, None)
    _save(state)
    return f"CODE-CREATED {path}: generation {state.get('generation')}. Read it before changing it." if ok else body


def move(source, target):
    state = _load()
    source, target = _text(source), _text(target)
    if source == target:
        return "CODE-ERROR same_path: choose a different destination"
    seen = state.get("files", {}).get(source)
    if not seen:
        return f"CODE-READ-FIRST read {source} with code-read before moving it"
    key = _key("move", state.get("ws"), source, target, seen["digest"], seen.get("generation"))
    payload = {"workspace_id": state.get("ws"), "operation_id": f"move-{key}",
               "expected_generation": seen.get("generation"), "expected_tree_digest": seen.get("tree_digest"),
               "edits": [{"path": source, "expected_digest": seen["digest"], "content": None},
                         {"path": target, "expected_digest": None, "content": seen["content"]}]}
    ok, body = _call("edit", payload, state, key=key)
    if ok:
        _track(state, body.get("workspace"))
        state["files"].pop(source, None); state["files"].pop(target, None)
    _save(state)
    return f"CODE-MOVED {source} to {target}: generation {state.get('generation')}. Read the new path before changing it." if ok else body


def remove(path):
    state = _load()
    path = _text(path)
    seen = state.get("files", {}).get(path)
    if not seen:
        return f"CODE-READ-FIRST read {path} with code-read before removing it"
    key = _key("remove", state.get("ws"), path, seen["digest"], seen.get("generation"))
    payload = {"workspace_id": state.get("ws"), "operation_id": f"remove-{key}",
               "expected_generation": seen.get("generation"), "expected_tree_digest": seen.get("tree_digest"),
               "edits": [{"path": path, "expected_digest": seen["digest"], "content": None}]}
    ok, body = _call("edit", payload, state, key=key)
    if ok:
        _track(state, body.get("workspace"))
        state["files"].pop(path, None)
    _save(state)
    return f"CODE-REMOVED {path} from the candidate: generation {state.get('generation')}." if ok else body


def run(command):
    state = _load()
    try:
        argv = shlex.split(_text(command))
    except ValueError:
        return "CODE-ERROR bad_command: could not split the command"
    if not argv:
        return "CODE-ERROR bad_command: empty"
    key = _key("run", state.get("ws"), state.get("generation"), argv)
    payload = {"operation_id": f"run-{key}", "workspace_id": state.get("ws"), "expected_generation": state.get("generation"),
               "expected_tree_digest": state.get("tree_digest"), "argv": argv, "timeout_seconds": 60}
    ok, body = _call("run", payload, state, key=key)
    if not ok:
        _save(state)
        return body
    state["run"] = body.get("id")
    _save(state)
    return f"CODE-RUN {body.get('id')} {body.get('status')} on generation {body.get('generation')}. Check it with code-status."


def status():
    state = _load()
    if not state.get("ws"):
        return "CODE-NO-WORKSPACE"
    lines = [f"workspace {state['ws']} generation {state.get('generation')} for {state.get('goal')} ({state.get('repo')})"]
    if state.get("run"):
        ok, body = _call("run-status", {"run_id": state["run"]}, state)
        if ok:
            outcome = "PASSED" if body.get("exit_code") == 0 else "FAILED" if body.get("exit_code") is not None else "not finished"
            lines.append(f"run {state['run']}: {body.get('status')}, exit code {body.get('exit_code')} ({outcome})")
            lines.append(f"output: code-output {state['run']} 0 (1024 bytes per page; follow cursor)")
    if state.get("pending"):
        lines.append(f"{len(state['pending'])} operation(s) waiting for approval")
    _save(state)
    return "CODE-STATUS " + "\n".join(lines)



def _history(action, cursor):
    state = _load()
    if not state.get("ws"):
        return "CODE-NO-WORKSPACE"
    payload = {"workspace_id": state["ws"], "limit": 5}
    cursor = _text(cursor)
    if cursor != "-":
        if not cursor or len(cursor) > 512:
            return "CODE-ERROR bad_cursor: use - for the first page or the exact next_cursor"
        payload["cursor"] = cursor
    ok, body = _call(action, payload, state)
    if not ok:
        return body
    # Keep IDs, observation tree and continuation intact; never cut JSON mid-cursor.
    fields = ("id", "run_id", "generation", "tree_digest", "status", "outcome", "currency", "exit_code", "created_at")
    page = {k: body.get(k) for k in ("workspace_id", "generation", "tree_digest", "next_cursor")}
    page["items"] = [{k: item[k] for k in fields if k in item} for item in body.get("items", [])]
    return "CODE-HISTORY " + json.dumps(page, ensure_ascii=True)


def runs(cursor):
    return _history("run-history", cursor)


def verifications(cursor):
    return _history("verification-history", cursor)


def output(run_id, after):
    state = _load()
    run_id, after = _text(run_id), _text(after)
    if not run_id or not after.isascii() or not after.isdecimal() or len(after) > 7 or int(after) > 4194304:
        return "CODE-ERROR bad_output_cursor: use an exact run ID and byte offset from 0 to 4194304"
    ok, body = _call("run-output", {"run_id": run_id, "after": int(after), "limit": 1024}, state)
    # Base64 preserves binary and split UTF-8. EOF is not completion; both flags remain explicit.
    return ("CODE-OUTPUT " + json.dumps(body, ensure_ascii=True)) if ok else body


def retrieve(query):
    state = _load()
    query = decode(_text(query))
    if not query.strip() or len(query)>4000:
        return "CODE-ERROR bad_query: use 1..4000 nonblank characters"
    payload = {'workspace_id':state.get('ws'), 'expected_generation':state.get('generation'),
               'expected_tree_digest':state.get('tree_digest'), 'query':query, 'limit':5}
    ok, body = _call('repository-retrieval', payload, state)
    if not ok: return body
    page = {k:body.get(k) for k in ('workspace_id','generation','tree_digest','index_digest',
        'facts_digest','mode','symbolic_filter','provider_calls','symbolic_publication','scope')}
    page['results'] = [{**item,'text':item.get('text','')[:600],
                        'text_truncated':len(item.get('text',''))>600} for item in body.get('results',[])[:5]]
    page['total_returned'] = len(body.get('results',[]))
    while len(json.dumps(page,ensure_ascii=True))>MAX_SHOW and page['results']:
        page['results'].pop()
    page['shown'] = len(page['results'])
    page['display_truncated'] = page['shown']<page['total_returned']
    if len(json.dumps(page,ensure_ascii=True))>MAX_SHOW:
        return 'CODE-ERROR retrieval_view_too_large: metadata exceeds the native view; inspect the repository-retrieval API result'
    return 'CODE-RETRIEVAL lexical/syntax only ' + json.dumps(page,ensure_ascii=True)


def proof_result(run_id):
    state = _load()
    run_id = _text(run_id)
    if not run_id or len(run_id)>160:
        return 'CODE-ERROR bad_run: use an exact proof run ID'
    ok, body = _call('proof-result', {'run_id':run_id}, state)
    if not ok: return body
    result = body.get('result') or {}
    page = {k:body.get(k) for k in ('run_id','workspace_id','generation','tree_digest','run_status',
        'status','currency','output_digest','implementation_applicability','sandboxed','checker','reason')}
    page['theorems'] = [{'theorem':r['theorem'], 'axioms':r['axioms']} for r in result.get('theorems',[])[:10]]
    page['total_theorems'] = len(result.get('theorems',[]))
    page['total_declaration_dependencies'] = len(result.get('declaration_dependencies',[]))
    page['diagnostic_excerpt'] = (result.get('reason') or result.get('audit_output') or result.get('compile_output') or '')[:400]
    # A short native view is not the full proof/assumption record; exact output is
    # retained and readable using code-output on this same run.
    page['details_complete'] = False
    page['details_command'] = 'code-output ' + run_id + ' 0'
    while len(json.dumps(page,ensure_ascii=True))>MAX_SHOW and page['theorems']:
        page['theorems'].pop()
    page['shown_theorems'] = len(page['theorems'])
    if len(json.dumps(page,ensure_ascii=True))>MAX_SHOW:
        return 'CODE-ERROR proof_view_too_large: inspect code-output '+run_id+' 0 for the full record'
    return 'CODE-PROOF-RESULT ' + json.dumps(page,ensure_ascii=True)


def proof_check(runtime_id, path):
    state = _load()
    runtime_id, path = _text(runtime_id), _text(path)
    seen = state.get('files',{}).get(path)
    if (not runtime_id or len(runtime_id)>160 or not path.endswith('.lean') or not seen
            or seen.get('generation') is None or not seen.get('tree_digest')):
        return 'CODE-ERROR proof_source: read the saved .lean file first; select an enabled Lean runtime from code-tools'
    ok, tools = _call('toolchains', {'workspace_id':state.get('ws')}, state)
    if not ok: return tools
    matches = [t for t in tools.get('toolchains',[]) if t.get('id')==runtime_id]
    if len(matches)!=1 or 'lean-single-module-check' not in matches[0].get('capabilities',[]):
        return 'CODE-ERROR proof_runtime: select one operator-enabled Lean checker'
    prefix = matches[0].get('check_argv_prefix')
    if type(prefix) is not list or len(prefix)!=1 or type(prefix[0]) is not str or not prefix[0].startswith('/') or '\x00' in prefix[0]:
        return 'CODE-ERROR proof_runtime: enabled runtime has no exact command prefix'
    key = _key('proof',state.get('ws'),runtime_id,path,seen['generation'],seen['tree_digest'])
    payload = {'operation_id':'proof-'+key, 'workspace_id':state.get('ws'),
               'expected_generation':seen['generation'], 'expected_tree_digest':seen['tree_digest'],
               'argv':[prefix[0],path], 'timeout_seconds':60, 'proof_runtime_id':runtime_id}
    ok, body = _call('run',payload,state,key=key)
    if not ok:
        _save(state)
        return body
    state['run'] = body.get('id');_save(state)
    return 'CODE-PROOF-RUN '+str(body.get('id'))+' '+str(body.get('status'))+'; inspect with code-proof-result '+str(body.get('id'))


def diagnostics(path):
    state = _load()
    if not state.get("ws"):
        return "CODE-NO-WORKSPACE"
    path = _text(path)
    payload = {"workspace_id": state["ws"], "path": path}
    seen = state.get("files", {}).get(path)
    if seen and seen.get("generation") is not None:
        payload["generation"] = seen["generation"]
    ok, body = _call("diagnostics", payload, state)
    if not ok:
        return body
    # Structural warnings only. Omit verbose duplicated messages but retain source custody and positions.
    result = {k: v for k, v in body.items() if k != "diagnostics"}
    result["diagnostics"] = [{k: d[k] for k in ("line", "column", "offset_utf16", "code", "severity") if k in d}
                             for d in body.get("diagnostics", [])[:20]]
    result["shown"] = len(result["diagnostics"])
    result["total_returned"] = len(body.get("diagnostics", []))
    result["display_truncated"] = result["shown"] < result["total_returned"]
    return "CODE-DIAGNOSTICS structural only, no evaluation or semantic validation " + json.dumps(result, ensure_ascii=True)


def changes():
    state = _load()
    ok, body = _call("changes", {"workspace_id": state.get("ws")}, state)
    if not ok:
        return body
    diff = body.get("diff") or body.get("unified_diff") or json.dumps(body)
    return "CODE-DIFF\n" + diff[:MAX_SHOW]


def verify():
    state = _load()
    if not state.get("run"):
        return "CODE-ERROR no_run: run the tests first"
    key = _key("verify", state["run"])
    ok, body = _call("verify", {"operation_id": f"verify-{key}", "run_id": state["run"]}, state, key=key)
    _save(state)
    return (f"CODE-VERIFIED {body.get('id')}: {body.get('outcome') or body.get('status')} ({body.get('currency', '')})") if ok else body


# Frozen source review never replaces what the mind last read for ordinary edits.
def git_context():
    state = _load()
    ok, body = _call("git-context", {"workspace_id":state.get("ws")}, state)
    return "CODE-GIT " + json.dumps(body) if ok else body


def review_create(target):
    state = _load(); target = _text(target)
    payload = {"workspace_id":state.get("ws"), "expected_generation":state.get("generation"),
               "expected_tree_digest":state.get("tree_digest"), "target":"base" if target=="base" else "checkpoint"}
    if target != "base": payload["checkpoint_id"] = target
    ok, body = _call("review-create", payload, state)
    if ok:
        state.setdefault("reviews", {})[body["id"]] = {k:body[k] for k in ("generation", "tree_digest")}
        _save(state)
    return "CODE-REVIEW " + json.dumps(body) if ok else body


def review_hunks(review_id, after):
    state = _load()
    try: offset = int(_text(after))
    except ValueError: return "CODE-ERROR invalid_cursor"
    ok, body = _call("review-state", {"workspace_id":state.get("ws"), "review_id":_text(review_id), "after":offset, "limit":5}, state)
    return "CODE-HUNKS " + json.dumps(body) if ok else body


def review_content(review_id, hunk_id, side, after):
    state = _load()
    try: offset = int(_text(after))
    except ValueError: return "CODE-ERROR invalid_cursor"
    ok, body = _call("review-content", {"workspace_id":state.get("ws"),"review_id":_text(review_id),
        "hunk_id":_text(hunk_id),"side":_text(side),"after":offset,"limit":1024}, state)
    return "CODE-HUNK-BYTES " + json.dumps(body) if ok else body


def review_apply(review_id, selection):
    state = _load(); review_id = _text(review_id)
    ids = sorted(_text(selection).split())
    if not ids or len(ids)!=len(set(ids)): return "CODE-ERROR select unique nonempty hunk IDs"
    reviewed = state.get("reviews", {}).get(review_id)
    if not reviewed: return "CODE-ERROR create a frozen review first"
    key = _key("source-selection",state.get("ws"),review_id,ids)
    ok, body = _call("review-apply", {"workspace_id":state.get("ws"),"operation_id":"select-"+key,
        "review_id":review_id,"hunk_ids":ids,"expected_generation":reviewed["generation"],
        "expected_tree_digest":reviewed["tree_digest"]}, state, key=key)
    if ok:
        _track(state, body["workspace"]); state["files"] = {}
    _save(state)
    if not ok: return body
    change = body["change"]; ws = body["workspace"]
    return "CODE-SELECTED " + json.dumps({"change_id":change["id"],"workspace_id":ws["id"],
        "generation":ws["generation"],"tree_digest":ws["tree_digest"],"review_id":review_id,
        "selected_count":len(ids),"paths":change.get("paths", [])[:5],"paths_truncated":len(change.get("paths", []))>5})


def git_export(branch, message):
    return _git_export_mode(branch, message)


def git_original_export(branch, message):
    return _git_export_mode(branch, message, 'original')


def _git_export_mode(branch, message, mode=None):
    state = _load(); branch = _text(branch); message = decode(_text(message))
    prefix = 'git-original-export' if mode else 'git-export'
    marker = _key(mode, branch, message) if mode else _key(branch, message)
    key = _key(prefix, state.get("ws"), branch, message, state.get("generation"), state.get("tree_digest"))
    # Keep the pending key stable even if an intervening status refresh observes a new generation.
    # _call retains exact pending payload; a separate state marker never enters the API body.
    key = state.setdefault("export_pending", {}).get(marker, key)
    payload = {"workspace_id":state.get("ws"),"operation_id":prefix+'-'+key,"branch":branch,"message":message,
        "expected_generation":state.get("generation"),"expected_tree_digest":state.get("tree_digest")}
    if mode: payload['history_mode'] = mode
    ok, body = _call("git-export",payload,state,key=key)
    if not ok and key in state.get("pending", {}): state["export_pending"][marker] = key
    else: state["export_pending"].pop(marker,None)
    if ok: state["last_git_export"] = body["id"]
    _save(state)
    return "CODE-GIT-EXPORT " + json.dumps(body,ensure_ascii=True) if ok else body


def git_export_state(export_id):
    state = _load()
    ok, body = _call("git-export-state",{"workspace_id":state.get("ws"),"export_id":_text(export_id)},state)
    return "CODE-GIT-EXPORT " + json.dumps(body,ensure_ascii=True) if ok else body


def git_export_patch(export_id, after):
    state = _load()
    try: offset = int(_text(after))
    except ValueError: return "CODE-ERROR invalid_cursor"
    ok, body = _call("git-export-patch",{"workspace_id":state.get("ws"),"export_id":_text(export_id),"after":offset,"limit":1024},state)
    return "CODE-GIT-PATCH " + json.dumps(body,ensure_ascii=True) if ok else body


def merge_create(base_checkpoint, incoming_checkpoint):
    state = _load()
    ok, body = _call("merge-create", {"workspace_id":state.get("ws"),
        "base_checkpoint_id":_text(base_checkpoint), "incoming_checkpoint_id":_text(incoming_checkpoint),
        "expected_generation":state.get("generation"), "expected_tree_digest":state.get("tree_digest")}, state)
    if ok:
        state.setdefault("merges", {})[body["id"]] = {k:body[k] for k in ("generation","tree_digest")}
        _save(state)
    return "CODE-MERGE " + json.dumps(body,ensure_ascii=True) if ok else body


def merge_files(preview_id, after):
    state = _load()
    try: offset = int(_text(after))
    except ValueError: return "CODE-ERROR invalid_cursor"
    if offset < 0: return "CODE-ERROR invalid_cursor"
    ok, body = _call("merge-state", {"workspace_id":state.get("ws"), "preview_id":_text(preview_id), "after":offset, "limit":5}, state)
    if ok:
        state.setdefault("merges", {})[_text(preview_id)] = {k:body[k] for k in ("generation","tree_digest")}
        _save(state)
    return "CODE-MERGE-FILES " + json.dumps(body,ensure_ascii=True) if ok else body


def merge_bytes(preview_id, path, side, after):
    state = _load()
    try: offset = int(_text(after))
    except ValueError: return "CODE-ERROR invalid_cursor"
    if offset < 0: return "CODE-ERROR invalid_cursor"
    ok, body = _call("merge-content", {"workspace_id":state.get("ws"), "preview_id":_text(preview_id),
        "path":_text(path), "side":_text(side), "after":offset, "limit":1024}, state)
    return "CODE-MERGE-BYTES " + json.dumps(body,ensure_ascii=True) if ok else body


def merge_apply(preview_id, resolution_json):
    state = _load(); preview_id = _text(preview_id)
    reviewed = state.get("merges", {}).get(preview_id)
    if not reviewed: return "CODE-ERROR inspect a frozen merge first"
    try:
        choices = json.loads(decode(_text(resolution_json)))
        if not isinstance(choices,list) or len(choices)>2000 or any(not isinstance(c,dict) or not isinstance(c.get("path"),str) for c in choices):
            raise ValueError()
        choices = sorted(choices,key=lambda c:c["path"])
        if len({c["path"] for c in choices}) != len(choices): raise ValueError()
    except (ValueError,TypeError): return "CODE-ERROR resolutions must be a JSON list of unique file choices"
    key = _key("merge-apply",state.get("ws"),preview_id,choices)
    ok, body = _call("merge-apply", {"workspace_id":state.get("ws"),"operation_id":"merge-"+key,
        "preview_id":preview_id,"expected_generation":reviewed["generation"],
        "expected_tree_digest":reviewed["tree_digest"],"resolutions":choices}, state, key=key)
    if ok:
        if body["workspace"]["generation"] >= state.get("generation",0): _track(state,body["workspace"])
        state["files"] = {}
    _save(state)
    if not ok: return body
    change = body.get("change") or {}
    return "CODE-MERGED " + json.dumps({"preview_id":preview_id,"change_id":change.get("id"),
        "workspace_id":body["workspace"]["id"],"generation":body["workspace"]["generation"],
        "tree_digest":body["workspace"]["tree_digest"],"no_change":body["no_change"],
        "affected_paths_count":len(change.get("paths",[])),"paths":change.get("paths",[])[:5]},ensure_ascii=True)


# ---- results back into MeTTa -------------------------------------------------------------------
# A ';' in a skill's result starts a MeTTa comment inside the runtime and loses the result (observed
# 2026-10-03 with code-repos).  Results are encoded: ';' is shown as SEMI, and a literal SEMI already in
# a file is shown as the six characters LIT, so the two never collide.  Edits never decode the mind's
# copy of the old text: they find it in the encoded view and map that exact span back to the raw file,
# so the raw bytes outside the edited span cannot change.  New text is decoded (LIT -> SEMI, SEMI -> ';').

SEMI = "\u204f"
LIT = "\\u204f"


def encode(raw):
    return raw.replace(SEMI, LIT).replace(";", SEMI)


def decode(text):
    marker = "\x00LIT\x00"
    return text.replace(LIT, marker).replace(SEMI, ";").replace(marker, SEMI)


def raw_span(raw, shown_old):
    """The raw [start, end) whose encoding is exactly the one occurrence of shown_old, else None."""
    if not shown_old:
        return None
    starts, pos = [], 0
    for ch in raw:
        starts.append(pos)
        pos += len(LIT) if ch == SEMI else 1
    shown = encode(raw)
    if shown.count(shown_old) != 1:
        return None
    a = shown.index(shown_old)
    b = a + len(shown_old)
    boundaries = {p: i for i, p in enumerate(starts)}
    boundaries[len(shown)] = len(raw)
    if a not in boundaries or b not in boundaries:
        return None  # the match cuts through an encoded character
    return boundaries[a], boundaries[b]


def _out(fn):
    def wrapped(*args):
        result = fn(*args)
        return encode(result) if isinstance(result, str) else result
    wrapped.__name__ = fn.__name__
    return wrapped


def _search_shown(query):
    return _search_raw(decode(_text(query)))


_search_raw = search
repos = _out(repos)
open_workspace = _out(open_workspace)
tools = _out(tools)
read = _out(read)
search = _out(_search_shown)
replace = _out(replace)
run = _out(run)
status = _out(status)
changes = _out(changes)
verify = _out(verify)

runs = _out(runs)
verifications = _out(verifications)
output = _out(output)
diagnostics = _out(diagnostics)

create = _out(create)
move = _out(move)
remove = _out(remove)

git_context = _out(git_context)
review_create = _out(review_create)
review_hunks = _out(review_hunks)
review_content = _out(review_content)
review_apply = _out(review_apply)

git_export = _out(git_export)
git_original_export = _out(git_original_export)
git_export_state = _out(git_export_state)
git_export_patch = _out(git_export_patch)

merge_create = _out(merge_create)
merge_files = _out(merge_files)
merge_bytes = _out(merge_bytes)
merge_apply = _out(merge_apply)

retrieve = _out(retrieve)
proof_result = _out(proof_result)
proof_check = _out(proof_check)


# Module-local mind client is shipped and digest-checked before any native skill loads.
_MIND_CLIENT_SHA256 = "b24162a4693501baf823a0aa318ff5410e4d563380d22b23e020c59412a15079"


def _load_mind_client_binding():
    import types
    path = pathlib.Path(__file__).resolve().with_name("mind_control_client.py")
    try:
        source = path.read_bytes()
    except OSError:
        raise ImportError("CODE-MIND-INSTALL-REFUSED pinned client Source unavailable") from None
    if hashlib.sha256(source).hexdigest() != _MIND_CLIENT_SHA256:
        raise ImportError("CODE-MIND-INSTALL-REFUSED pinned client Source digest mismatch") from None
    module = types.ModuleType("_omega_code_pinned_mind_client_r2")
    module.__file__ = str(path)
    try:
        exec(compile(source, str(path), "exec", dont_inherit=True), module.__dict__)
    except ImportError:
        raise ImportError("CODE-MIND-INSTALL-REFUSED client public dependency unavailable (httpx)") from None
    return module


_MIND_SDK = _load_mind_client_binding()


def _mind_client():
    hive, token = os.environ.get("HIVE_API_URL"), os.environ.get("HIVE_WS_TOKEN")
    if not hive or not token:
        return None, "CODE-MIND-UNAVAILABLE this mind has no hive identity"
    return _MIND_SDK.MindControlClient(hive, token), None


def _mind_payload(text):
    raw = str(text).strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1].replace('\\"', '"')
    raw = decode(raw)
    if len(raw.encode("utf-8")) > 65536:
        raise ValueError("mind payload is too large")
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate mind payload key")
            result[key] = item
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError("mind payload must be an object")
    return value


def _mind_call(invoke):
    # Deliberate client callback, no runtime replacement of client._call.
    client = None
    dispatched = False
    original_callback = None
    try:
        client, problem = _mind_client()
        if client is None:
            return problem
        original_callback = client.before_request
        def before_request(method, path, *, body=None, query=None, status, contract=None):
            nonlocal dispatched
            if original_callback is not None:
                original_callback(method, path, body=body, query=query, status=status, contract=contract)
            if method == "POST":
                _retain_mind_write(client, method, path, body, contract)
            dispatched = True
        client.before_request = before_request
        with client:
            result = invoke(client)
        rendered = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(rendered) > 24000:
            return "CODE-MIND-UNCONFIRMED response too large; retain original operation_id and exact payload, or read a narrower child selection"
        return "CODE-MIND " + rendered
    except _MindJournalUnavailable:
        return "CODE-MIND-UNAVAILABLE retained request unavailable; retain original operation_id and exact payload; retry same key when available; do not rekey"
    except _MindJournalError as exc:
        return "CODE-MIND-JOURNAL-REFUSED " + exc.code + "; retain original operation_id and exact payload; do not rekey"
    except _MindPayloadInvalid as exc:
        if dispatched:
            return "CODE-MIND-UNCONFIRMED response or presentation failed; retain original operation_id and exact payload"
        return "CODE-MIND-INVALID " + str(exc)
    except (ValueError, TypeError):
        if dispatched:
            return "CODE-MIND-UNCONFIRMED response or presentation failed; retain original operation_id and exact payload"
        return "CODE-MIND-INVALID exact caller operation and payload required"
    except Exception as exc:
        if isinstance(exc, _MIND_SDK.MindControlError):
            return "CODE-MIND-REFUSED " + str(exc.status) + " " + str(exc.code)
        if isinstance(exc, _MIND_SDK.MindProtocolError):
            return "CODE-MIND-UNCONFIRMED host response is unusable; do not infer delivery or stop"
        return "CODE-MIND-UNCONFIRMED " + type(exc).__name__ + "; retain the original operation_id and exact payload"
    finally:
        if client is not None:
            client.before_request = original_callback


def mind_templates(team_id):
    return _mind_call(lambda client: client.templates(_mind_argument(team_id)))


class _MindPayloadInvalid(ValueError):
    """A refusal before dispatch whose text names what is wrong: one plain line, no quotes or parentheses."""


_SPAWN_REQUIRED = ("operation_id", "request_id", "team_id", "template_id", "initial_prompt", "allocation_usd")
_SPAWN_OPTIONAL = ("lifecycle_mode", "lifecycle_limits", "model_id")
_SPAWN_RENAMES = {"prompt": "use initial_prompt not prompt",
                  "goal_id": "name the work goal id inside initial_prompt, not as goal_id",
                  "work_goal_id": "name the work goal id inside initial_prompt, not as work_goal_id"}
_SPAWN_SHAPE = ("required " + " ".join(_SPAWN_REQUIRED) + "; optional " + " ".join(_SPAWN_OPTIONAL)
                + "; see the code-mind-spawn card example")


def _plain(text):
    """One line the MeTTa loop can carry: no quotes, parentheses, brackets, braces or newlines."""
    kept = "".join(" " if ch in "\"'`()[]{}\r\n\t\\" else ch for ch in str(text))
    return " ".join(kept.split())[:300]


def _mind_spawn_fields(payload):
    """Check the spawn payload's fields before any client call, and say exactly which are missing or unknown."""
    try:
        fields = _mind_payload(payload)
    except (ValueError, TypeError) as exc:
        raise _MindPayloadInvalid("spawn payload must be one JSON object, " + _plain(exc) + "; " + _SPAWN_SHAPE) from None
    missing = [name for name in _SPAWN_REQUIRED if name not in fields]
    unknown = sorted(name for name in fields if name not in _SPAWN_REQUIRED and name not in _SPAWN_OPTIONAL)
    if missing or unknown:
        parts = ["spawn payload"]
        if missing:
            parts.append("missing " + " ".join(missing))
        if unknown:
            parts.append("unknown " + " ".join(_plain(name) for name in unknown))
        problem = " ".join(parts[:2]) + ("; " + parts[2] if len(parts) > 2 else "")
        hints = [_SPAWN_RENAMES[name] for name in unknown if name in _SPAWN_RENAMES]
        raise _MindPayloadInvalid("; ".join([problem] + hints + [_SPAWN_SHAPE]))
    try:
        _MIND_SDK._spawn_body(**fields)                   # the pinned client's own value checks, before dispatch
    except (ValueError, TypeError) as exc:
        raise _MindPayloadInvalid("spawn payload " + _plain(exc) + "; " + _SPAWN_SHAPE) from None
    return fields


def mind_spawn(payload):
    # operation_id is supplied by the caller and retained by that caller before dispatch.
    return _mind_call(lambda client: client.spawn(**_mind_spawn_fields(payload)))


def mind_prompt(child_id, payload):
    return _mind_call(lambda client: client.prompt(_mind_argument(child_id), **_mind_payload(payload)))


def mind_control(child_id, operation_id, action):
    return _mind_call(lambda client: client.control(_mind_argument(child_id), operation_id=_mind_argument(operation_id), action=_mind_argument(action)))


def mind_status(child_id, team_id, controller_id):
    def observe(client):
        report = client.status(child_id=_mind_argument(child_id))
        for child in report["children"]:
            if child["team_id"] != _mind_argument(team_id) or child["controller_id"] != _mind_argument(controller_id):
                raise _MIND_SDK.MindProtocolError("child team/controller mismatch")
        return report
    return _mind_call(observe)


def mind_scan(team_id, controller_id, max_pages):
    def observe(client):
        bound = _mind_argument(max_pages)
        if not bound.isascii() or not bound.isdecimal():
            raise ValueError("max_pages must be explicit decimal")
        return client.scan_team(_mind_argument(team_id), controller_id=_mind_argument(controller_id), max_pages=int(bound))
    return _mind_call(observe)


mind_templates = _out(mind_templates)
mind_spawn = _out(mind_spawn)
mind_prompt = _out(mind_prompt)
mind_control = _out(mind_control)
mind_status = _out(mind_status)
mind_scan = _out(mind_scan)


class _MindJournalUnavailable(RuntimeError):
    """I/O cannot establish absence; preserve the original operation key."""


class _MindJournalError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _mind_canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def _retain_mind_write(client, method, path, body, contract):
    """Private per-mind request outbox, not a lifecycle registry or authority cache.

    Lock is released before network I/O. Every explicit retry still reaches the host.
    Prepared records never assert host admission, prompt acknowledgement or child state.
    """
    import fcntl
    import stat
    import tempfile
    memory = os.environ.get("OMEGACLAW_MEMORY_DIR")
    if not memory:
        raise _MindJournalError("memory_required")
    try:
        directory = pathlib.Path(memory).resolve()
        _MIND_SDK.validate_retained_request(method, path, body, contract)
        meta = directory.stat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o022:
            raise _MindJournalError("memory_scope_unusable")
        scope = _mind_scope(client)
        intent = {"scope": scope, "operation_id": body["operation_id"], "method": method, "path": path, "body": body, "contract": contract}
        digest = hashlib.sha256(_mind_canonical(intent).encode()).hexdigest()
        key = hashlib.sha256(_mind_canonical([scope, body["operation_id"]]).encode()).hexdigest()
        lock_path = directory / ".omegacode-mind-requests.lock"
        journal = directory / "omegacode-mind-requests.json"
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
        lock_fd = os.open(lock_path, flags, 0o600)
        with os.fdopen(lock_fd, "r+") as lock:
            lm = os.fstat(lock.fileno())
            if not stat.S_ISREG(lm.st_mode) or lm.st_uid != os.getuid() or lm.st_mode & 0o077:
                raise _MindJournalError("journal_lock_unusable")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                fd = os.open(journal, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                data = {"schema": 1, "requests": {}}
            else:
                with os.fdopen(fd) as source:
                    jm = os.fstat(source.fileno())
                    if not stat.S_ISREG(jm.st_mode) or jm.st_uid != os.getuid() or jm.st_mode & 0o077 or jm.st_size > 70000000:
                        raise _MindJournalError("journal_unusable")
                    data = _read_mind_journal(source)
            previous = data["requests"].get(key)
            if previous:
                if previous["digest"] != digest:
                    raise _MindJournalError("operation_changed")
                return
            if len(data["requests"]) >= 1000:
                raise _MindJournalError("journal_capacity")
            data["requests"][key] = {"intent": intent, "digest": digest}
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, prefix=".mind-request-", delete=False) as target:
                    temporary = pathlib.Path(target.name)
                    os.fchmod(target.fileno(), 0o600)
                    target.write(_mind_canonical(data))
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, journal)
                temporary = None
                dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
    except _MindJournalError:
        raise
    except OSError:
        raise _MindJournalUnavailable() from None
    except (ValueError, TypeError, KeyError):
        raise _MindJournalError("journal_corrupt") from None


def _read_mind_journal(source):
    def unique(pairs):
        result = {}
        for name, item in pairs:
            if name in result:
                raise _MindJournalError("journal_corrupt")
            result[name] = item
        return result
    data = json.load(source, object_pairs_hook=unique)
    if not isinstance(data, dict) or type(data.get("schema")) is not int or data.get("schema") != 1 or not isinstance(data.get("requests"), dict) or len(data["requests"]) > 1000:
        raise _MindJournalError("journal_corrupt")
    for saved_key, record in data["requests"].items():
        if not isinstance(record, dict) or not isinstance(record.get("intent"), dict):
            raise _MindJournalError("journal_corrupt")
        saved = record["intent"]
        if set(saved) not in ({"scope", "operation_id", "method", "path", "body"}, {"scope", "operation_id", "method", "path", "body", "contract"}) or not isinstance(saved["body"], dict) or saved["operation_id"] != saved["body"].get("operation_id") or saved["method"] != "POST":
            raise _MindJournalError("journal_corrupt")
        try:
            _MIND_SDK._same_origin_relative_path(saved["path"])
            if "contract" in saved:
                _MIND_SDK.validate_retained_request(saved["method"], saved["path"], saved["body"], saved["contract"])
        except (ValueError, TypeError, KeyError):
            raise _MindJournalError("journal_corrupt") from None
        if hashlib.sha256(_mind_canonical(saved).encode()).hexdigest() != record.get("digest") or hashlib.sha256(_mind_canonical([saved["scope"], saved["operation_id"]]).encode()).hexdigest() != saved_key:
            raise _MindJournalError("journal_corrupt")
    return data


def _mind_scope(client):
    return hashlib.sha256(_mind_canonical([
        str(client._client.base_url),
        hashlib.sha256(client._client.headers["Authorization"].encode()).hexdigest()
    ]).encode()).hexdigest()


def _retained_mind_request(client, operation_id):
    """Read one exact local intent in current credential scope, without authority inference."""
    import fcntl
    import stat
    operation_id = _MIND_SDK._operation(operation_id)
    memory = os.environ.get("OMEGACLAW_MEMORY_DIR")
    if not memory:
        raise _MindJournalError("memory_required")
    try:
        directory = pathlib.Path(memory).resolve()
        dm = directory.stat()
        if not stat.S_ISDIR(dm.st_mode) or dm.st_uid != os.getuid() or dm.st_mode & 0o022:
            raise _MindJournalError("memory_scope_unusable")
        key = hashlib.sha256(_mind_canonical([_mind_scope(client), operation_id]).encode()).hexdigest()
        try:
            fd = os.open(directory / ".omegacode-mind-requests.lock", os.O_RDWR | os.O_NOFOLLOW)
        except FileNotFoundError:
            raise _MindJournalUnavailable() from None
        with os.fdopen(fd, "r+") as lock:
            lm = os.fstat(lock.fileno())
            if not stat.S_ISREG(lm.st_mode) or lm.st_uid != os.getuid() or lm.st_mode & 0o077:
                raise _MindJournalError("journal_lock_unusable")
            fcntl.flock(lock.fileno(), fcntl.LOCK_SH)
            try:
                fd = os.open(directory / "omegacode-mind-requests.json", os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                raise _MindJournalUnavailable() from None
            with os.fdopen(fd) as source:
                jm = os.fstat(source.fileno())
                if not stat.S_ISREG(jm.st_mode) or jm.st_uid != os.getuid() or jm.st_mode & 0o077 or jm.st_size > 70000000:
                    raise _MindJournalError("journal_unusable")
                data = _read_mind_journal(source)
            record = data["requests"].get(key)
            if record is None:
                raise _MindJournalError("request_not_retained")
            return record["intent"]
    except _MindJournalError:
        raise
    except OSError:
        raise _MindJournalUnavailable() from None
    except (ValueError, TypeError, KeyError):
        raise _MindJournalError("journal_corrupt") from None


def mind_request(operation_id):
    def inspect(client):
        intent = _retained_mind_request(client, _mind_argument(operation_id))
        return {"source": "local_retained_request", "host_admission": "not_established", "method": intent["method"], "path": intent["path"], "body": intent["body"]}
    return _mind_call(inspect)


def mind_retry(operation_id):
    def retry(client):
        intent = _retained_mind_request(client, _mind_argument(operation_id))
        if "contract" not in intent:
            raise _MindJournalError("legacy_contract_missing_operator_migration_required")
        return client.replay_retained(intent["method"], intent["path"], intent["body"], intent["contract"])
    return _mind_call(retry)


mind_request = _out(mind_request)
mind_retry = _out(mind_retry)


def _mind_argument(value):
    """Remove native string quoting without expanding legacy source-text placeholders.

    Reference grammar is validated by the reviewed client; accepted underscore
    sequences in IDs must remain byte-for-byte equal to the original reference.
    """
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].replace('\\"', '"')
    return text


def mind_work(request_id, receiving_team):
    """Read host-authorized cross-swarm request; this confers no child/lease authority."""
    def read_work(client):
        expected = _mind_argument(request_id)
        result = client.request(expected)
        if result.get("id") != expected or result["to_swarm"] != _mind_argument(receiving_team):
            raise _MIND_SDK.MindProtocolError("work request identity/receiving swarm mismatch")
        return {"source": "host_work_request", "request": result}
    return _mind_call(read_work)


mind_work = _out(mind_work)
