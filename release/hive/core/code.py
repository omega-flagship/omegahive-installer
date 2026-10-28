"""R2: edit the code of anything running in the hive, from inside the hive.

Edit targets are what is running: the hive platform, each mounted program, each mind (its runtime is
the platform's OmegaClaw code; its persona lives in its Model tab), and registered services.  Each
target names its source root, git repository and running revision, owner, privacy and what applying
a change would do.  Opening a target creates a task (a hive goal in the "Code local" swarm) with an
edit grant for the person, so OmegaCode's workspace, edits, runs and evidence are bound to it exactly
as for a mind.  The browser talks only to the hive: /api/code/proxy forwards a small allow-list of
OmegaCode routes with a short-lived hive-signed capability, never a service secret.
"""

from __future__ import annotations

import json
import base64
import os
import pathlib
import re
import subprocess
import time

import httpx

from .services import scope_allows

def relayed_error(status, content):
    """A service refusal in the hive's own error envelope, marked as the service's (Surface 2026-10-05): the UI reads
    one shape, keeps the service's code (stale vs revoked), and a service 401 (a refused capability) becomes 403, so it
    is never mistaken for the person's hive session ending."""
    try:
        data = json.loads(content or b"null")
    except ValueError:
        data = None
    inner = data.get("error") if isinstance(data, dict) else None
    if isinstance(inner, dict):
        error = dict(inner)
    else:
        error = {k: v for k, v in data.items() if k != "error"} if isinstance(data, dict) else {}
        error["code"] = inner if isinstance(inner, str) and inner else "service_error"
    error.setdefault("message", "OmegaCode refused the request")
    error.update(source="omegacode", upstream_status=status)
    return (403 if status == 401 else status), json.dumps({"error": error}).encode(), "application/json"


# The reviewed OmegaCode service release these routes were written for. The parity test checks every route against its
# handlers and, on the hive's own machine, that the Code service actually loads it (Kimi next7-r3).
INTENDED_SERVICE_RELEASE = "345fde5378300dd2090f7141627c65f79c2e419e9e85393d7f5758241a13d2dd"
# 345fde53 (Code canonical-runner r1: patch interpreter-canonical-env-r1 75e7df75; Kimi + stand-in SHIP,
# STANDIN_CODE_CANONICAL_RUNNER_VERDICT_20261007) differs from bdfb0591 in omegacode/runner.py only; api.py is
# byte-identical (sha256 b94ca803..., checked by the parity test), so the routes and relay tables are bdfb0591's unchanged.
# bdfb0591 (Code snippet-service-preview-r1 on the reviewed copy-apply r9 chain; Kimi + stand-in SHIP,
# STANDIN_CODE_ADOPTION_bdfb0591_VERDICT_20261007) serves 72 routes, 66 from ed66 plus six:
# - proposal-applications GET, POST and POST .../undo: in COPY_APPLY_ROUTES, still held behind HIVE_COPY_APPLY_CLAIMS;
# - GET suggestion-scopes/{scope_id}, POST proposal-test-receipts and GET proposal-test-receipts/{receipt_id}: NOT
#   relayed (UNRELAYED_SERVICE_ROUTES). Platform's linkage spec defines no person relay for them (b.9: receipts are never
#   relayed as "Test this"); slice 3 did not adopt them. Each needs its own host review before it joins PROXY_ROUTES.
# Request bodies are forwarded as sent (no host schema), so bdfb0591's additive fields pass through unchanged: retrieval
# corpus="text" on repository-retrieval and the completion preview profile "editor-snippet-template-v1".

# Each relayed route carries the exact, minimal OmegaCode actions it needs (Code's PROXY_ACTIONS_RESPONSE, Kimi
# 2026-10-05): a read route never holds edit or run authority. Actions are a subset of HUMAN_ACTIONS.
PROXY_ROUTES = [
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/repository-facts$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/repository-retrieval$", ("read",)),
    ("GET", r"^/v1/runs/run_[A-Za-z0-9_-]+/proof-result$", ("read", "events",)),
    ("GET", r"^/v1/tasks/g_[A-Za-z0-9_-]+/workspaces$", ("read",)),
    # Merge creation can capture another fork's checkpoint into this workspace's custody: it needs checkpoint on the
    # destination as well as read (Code's CROSS_FORK_MERGE_PROXY_AUTHORITY_DIRECTION.json), which service faabc61e also
    # enforces itself (Review SHIP of the custody and replay correction)
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/merges$", ("read", "checkpoint")),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/merges/merge_[A-Za-z0-9_-]+$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/merges/merge_[A-Za-z0-9_-]+/content$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/merges/merge_[A-Za-z0-9_-]+/apply$", ("read", "edit",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/git/exports$", ("read", "edit",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/git/exports/gx_[A-Za-z0-9_-]+$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/git/exports/gx_[A-Za-z0-9_-]+/patch$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/git/context$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/reviews$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/reviews/review_[A-Za-z0-9_-]+$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/reviews/review_[A-Za-z0-9_-]+/hunks/h_[a-f0-9]{64}$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/reviews/review_[A-Za-z0-9_-]+/apply$", ("edit",)),
    ("GET", r"^/v1/capabilities$", ("read",)),
    ("POST", r"^/v1/workspaces$", ("workspace",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/files$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/tree$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/toolchains$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/search$", ("search",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/patches$", ("edit",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/changes$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/checkpoints$", ("checkpoint",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/checkpoints$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/restores$", ("edit",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/(runs|verifications|diagnostics)$", ("read",)),
    ("GET", r"^/v1/runs/run_[A-Za-z0-9_-]+/source$", ("read",)),
    ("GET", r"^/v1/runs/run_[A-Za-z0-9_-]+/output$", ("read", "events",)),
    ("POST", r"^/v1/runs$", ("run",)),
    ("GET", r"^/v1/runs/run_[A-Za-z0-9_-]+$", ("read",)),
    ("POST", r"^/v1/runs/run_[A-Za-z0-9_-]+/cancel$", ("cancel",)),
    ("POST", r"^/v1/verifications$", ("verify",)),
    ("GET", r"^/v1/verifications/[A-Za-z0-9_-]+$", ("read",)),
    ("GET", r"^/v1/events$", ("events",)),
    ("GET", r"^/v1/artifacts/[a-f0-9]{64}$", ("artifact",)),
    # Workbench routes (Code host-workbench-proxy-candidate, b1f59476…), each with Code's minimal actions.
    # Held until a reviewed service implements them (OmegaReview next7): the four run-result routes
    # (POST /v1/runs/{id}/results; GET run-results/{rr}, …/source; POST …/import). See RUN_RESULT_PROXY_ROUTE_DIRECTION.json.
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/suggestion-scopes$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/function-scopes$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/function-scope-preview$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/suggestions$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/suggestions$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/suggestions/[A-Za-z0-9_-]+$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/suggestion-decisions$", ("edit", "read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/iterations$", ("checkpoint", "read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/iterations/[A-Za-z0-9_-]+$", ("read",)),
    # Surface PTY and saved language bridge (Code host-next7-language-proxy 54fa42d3), exact service actions:
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/language/servers$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/language$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/language/completion-previews$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/language/completion-applies$", ("edit",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/language/renames$", ("edit",)),
    ("POST", r"^/v1/runs/run_[A-Za-z0-9_-]+/terminal$", ("run",)),
    # Terminal-control status is served by ebb40f48 (api.py:545; Code's loaded-terminal-status receipt): read only.
    ("GET", r"^/v1/runs/run_[A-Za-z0-9_-]+/terminal/tc_[A-Za-z0-9_-]+$", ("read",)),
    # Run results, served from 93e49926 (Review SHIP); actions exactly as Code's RUN_RESULT_PROXY_ROUTE_DIRECTION.json
    ("POST", r"^/v1/runs/run_[A-Za-z0-9_-]+/results$", ("checkpoint", "read")),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/run-results/rr_[A-Za-z0-9_-]+$", ("read",)),
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/run-results/rr_[A-Za-z0-9_-]+/source$", ("read",)),
    ("POST", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/run-results/rr_[A-Za-z0-9_-]+/import$", ("edit", "read")),
    # Merge review packet, served by ed66f4dd (api.py:620): read only; the service itself requires full-workspace read
    # scope (service.py merge_scope). Code owner ruling CODE_CANVAS_P1_OWNER_DECISIONS_20261006 item 3.
    ("GET", r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/merge-review/[A-Za-z0-9_-]+$", ("read",)),
]
# Routes the pinned release serves that the hive deliberately does not relay (see INTENDED_SERVICE_RELEASE). The parity
# test requires every served route to be relayed, copy-apply-held or listed here, so a new release cannot add a route
# silently. The four default-off purpose routes (/v1/proposal-tests...) are installed outside api.py and are never relayed.
UNRELAYED_SERVICE_ROUTES = [
    ("POST", "/v1/operator/register"),                            # operator administration: service secret, never relayed
    ("POST", "/v1/operator/grants"),
    ("DELETE", "/v1/operator/grants/{id}"),
    ("POST", "/v1/workspaces/{id}/forks"),                        # held per Code: actions not named
    ("GET", "/v1/workspaces/{id}/suggestions/{suggestion_id}/hunks/{hunk_id}/before"),  # unrelayed since ed66; not adopted
    ("GET", "/v1/workspaces/{id}/suggestion-scopes/{scope_id}"),
    ("POST", "/v1/workspaces/{id}/proposal-test-receipts"),
    ("GET", "/v1/workspaces/{id}/proposal-test-receipts/{receipt_id}"),
]
# Per-route query allow-lists (Code MERGE_REVIEW_QUERY_OWNER_RULING_20261006). A route listed here forwards only the
# named keys, keeps every repeated value (never last-one-wins) and refuses anything else, so no unknown key can later
# become authority-bearing. Values are caller-selected references, never attested evidence. Routes not listed keep the
# existing behaviour (one value per key) until Code rules on them.
QUERY_RULES = {
    r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/merge-review/[A-Za-z0-9_-]+$": {"verification_id": (100, 160)},
}


def checked_query(route_pattern, pairs):
    """The query to forward for a route: `pairs` is [(key, value), ...] as the client sent it."""
    pairs = list(pairs.items()) if isinstance(pairs, dict) else list(pairs)
    rules = QUERY_RULES.get(route_pattern)
    if rules is None:
        return dict(pairs)
    for key, value in pairs:
        if key not in rules:
            raise CodeError(400, "query_not_allowed", f"{key!r} is not accepted on this route")
        if not 1 <= len(value) <= rules[key][1]:
            raise CodeError(400, "query_value", f"each {key} must be 1 to {rules[key][1]} characters")
    for key, (most, _) in rules.items():
        values = [v for k, v in pairs if k == key]
        if len(values) > most or len(values) != len(set(values)):
            raise CodeError(400, "query_value", f"use at most {most} unique {key} values")
    return pairs


HUMAN_ACTIONS = ["workspace", "read", "search", "edit", "run", "cancel", "verify", "events", "artifact", "checkpoint"]

# Linkage slice 3: Code's r6/r7 workspace copy-apply routes (R6_COMPLETE_PROXY_ADOPTION_DIRECTION_20261007.json d7eb5829,
# inbox 20261007-024952; contract WORKSPACE_COPY_APPLICATION_UNDO_CONTRACT_R1). HELD: they join the person relay only when
# the operator sets HIVE_COPY_APPLY_CLAIMS=on. The pinned release (345fde53, routes as bdfb0591) serves them; the switch stays off by default.
_APPLICATION = r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/proposal-applications/application_[a-f0-9]{32}"
# One declared table (Kimi s3-b40fa13 #5): each route's person relay actions, or None when it is purpose-only, and the
# purpose capabilities the service accepts on it. Every entry is held behind HIVE_COPY_APPLY_CLAIMS; the relay's 403-vs-404
# answer is derived from this table only (copy_apply_route).
# - GET application: a person reads it with "read"; the controller recovers its own application with "proposal-apply".
# - POST undo: person only, "edit" exactly as Code r7 authorizes it (copy_application.py undo -> service.edit ->
#   _operation(principal, "edit"); kind must be human), on the person's own active edit grant covering the workspace, with
#   the grant's path scope carried into the capability.
# - POST applications: purpose only. The controller presents its host-issued copy_apply capability to the service itself;
#   the person relay never applies a proposal and never mints edit/read in its place (Code: person application POST is
#   HELD, application_binding_unavailable). "proposal-apply" is never in HUMAN_ACTIONS.
COPY_APPLY_ROUTES = [
    {"method": "GET", "pattern": _APPLICATION + "$", "person": ("read",), "human_only": False,
     "purpose": {"copy_apply": ("proposal-apply",)}},
    {"method": "POST", "pattern": _APPLICATION + "/undo$", "person": ("edit",), "human_only": True, "purpose": {}},
    {"method": "POST", "pattern": r"^/v1/workspaces/ws_[A-Za-z0-9_-]+/proposal-applications$", "person": None,
     "human_only": False, "purpose": {"copy_apply": ("proposal-apply",)}},
]
# Views derived from the table (never maintained by hand):
COPY_APPLY_PERSON_ROUTES = [(r["method"], r["pattern"], r["person"]) for r in COPY_APPLY_ROUTES if r["person"]]
HUMAN_ONLY_ROUTES = {r["pattern"] for r in COPY_APPLY_ROUTES if r["human_only"]}
PURPOSE_ROUTES = {purpose: [(r["method"], r["pattern"], r["purpose"][purpose]) for r in COPY_APPLY_ROUTES if purpose in r["purpose"]]
                  for purpose in sorted({p for r in COPY_APPLY_ROUTES for p in r["purpose"]})}
COPY_APPLY_PURPOSE_ROUTES = PURPOSE_ROUTES["copy_apply"]


def copy_apply_route(method, path, switched_on):
    """(decision, entry) for a copy-apply table route, else (None, None). decision: "relay" (a person route, switch on),
    "held" (a person route, switch off: 404 not_relayed) or "purpose_only" (no person relay at all: 403)."""
    entry = next((r for r in COPY_APPLY_ROUTES if r["method"] == method and re.fullmatch(r["pattern"], path)), None)
    if entry is None:
        return None, None
    if entry["person"] is None:
        return "purpose_only", entry
    return ("relay" if switched_on else "held"), entry


def purpose_route(purpose, method, path):
    """The (method, pattern, actions) entry a purpose capability may present to the service on, else None."""
    return next((r for r in PURPOSE_ROUTES.get(purpose, ()) if r[0] == method and re.fullmatch(r[1], path)), None)


# Mirrors Code's own safe_path (omegacode/common.py, r7): a relative POSIX path inside the workspace, never repository
# metadata or a credential file. The host has no shared validator (app.py's agent paths check is a narrower inline test).
PATH_MAX = 512
PROTECTED_NAMES = {".git", ".env", ".netrc", ".npmrc", "credentials", "token", "id_rsa", "id_ed25519"}


def scoped_path_ok(value):
    """True for one entry of a capability path scope: a nonempty relative POSIX path of at most PATH_MAX characters, with
    no backslash, NUL or other control character, no leading '/', and no empty, '.' or '..' segment (so no './' prefix,
    no '//' and no trailing '/'), and no repository-metadata or credential segment."""
    if not isinstance(value, str) or not value or len(value) > PATH_MAX:
        return False
    if "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value) or value.startswith("/"):
        return False
    parts = value.split("/")
    return not any(part in ("", ".", "..") or part in PROTECTED_NAMES or part.startswith(".env.") for part in parts)


def grant_path_scope(grant):
    """The path scope a person's grant stores, as the capability's paths. Only a missing or None scope means the whole
    repository (goal_grants keeps no path column on this host today). A stored scope must be a nonempty JSON list of
    nonempty strings (a `paths` field); a blank, empty or unreadable one is refused, never widened to the whole repository
    (as Services.issue refuses an explicit empty list)."""
    raw = grant.get("paths") if grant else None
    if raw is None:
        return None
    try:
        paths = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        paths = None
    if not isinstance(paths, list) or not paths or len(paths) > 200 or not all(scoped_path_ok(x) for x in paths):
        raise CodeError(403, "edit_grant_required", "your grant's path scope is blank, empty, unreadable or not relative paths")
    return sorted(paths)


def _git(root, *args):
    try:
        out = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


class CodeError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class Code:
    def __init__(self, hive, client: httpx.AsyncClient):
        self.hive, self.client = hive, client
        # who owns which source tree, and whether its code is private: [{"prefix", "owner", "private"}]
        try:
            self.owners = json.loads(os.environ.get("HIVE_CODE_OWNERS", "[]"))
        except ValueError:
            self.owners = []
        self.platform_root = pathlib.Path(hive.settings.core_root)
        # OmegaCode repositories: the service's own config is the one source of which repositories exist and can be
        # edited (HIVE_CODE_SERVICE_CONFIG, the file the service runs with). HIVE_CODE_REPOS only adds hive-side
        # metadata (label, argv_prefixes) to those ids. The two lists drifted, so the hive offered targets the service
        # refused with 403 repository_unregistered (the owner never saw a workspace, 2026-10-05).
        try:
            extra = json.loads(os.environ.get("HIVE_CODE_REPOS", "{}"))
        except ValueError:
            extra = {}
        extra = extra if isinstance(extra, dict) else {}
        registered = self._service_repositories()
        if registered is None:                       # no service config named: the hive's list is all there is
            self.repos = extra
        else:
            self.repos = {rid: {**(extra.get(rid) or {}), "path": path} for rid, path in registered.items()}
        # private targets open only when their owners have agreed (target ids, comma-separated)
        self.allow_private = {t.strip() for t in os.environ.get("HIVE_CODE_ALLOW_PRIVATE", "").split(",") if t.strip()}
        self._caps = {}  # (principal, task, repo, grant) -> (token, exp)

    @staticmethod
    def _service_repositories():
        """{repository id: path} from the OmegaCode service's config file, or None when no file is named."""
        name = os.environ.get("HIVE_CODE_SERVICE_CONFIG", "").strip()
        if not name:
            return None
        try:
            repos = json.loads(pathlib.Path(name).read_text()).get("repositories") or {}
        except (OSError, ValueError, AttributeError):
            return {}                                  # named but unreadable: nothing is editable, never a guess
        if not isinstance(repos, dict):               # a list or other shape is not a registry: nothing editable
            return {}
        return {str(k): str((v or {}).get("path", "")) for k, v in repos.items() if isinstance(v, dict)}

    # ---- targets ---------------------------------------------------------------------------------

    def _owner(self, path):
        best = None
        for rule in self.owners:
            prefix = str(pathlib.Path(rule.get("prefix", "")).expanduser())
            if prefix and str(path).startswith(prefix) and (best is None or len(prefix) > len(best[0])):
                best = (prefix, rule)
        rule = best[1] if best else {}
        return rule.get("owner", "this hive"), bool(rule.get("private", False))

    def _repo(self, path):
        top = _git(path, "rev-parse", "--show-toplevel")
        # a repository at the home directory is an anchor that ignores everything, not source control
        if top is None or pathlib.Path(top).resolve() == pathlib.Path.home().resolve():
            return None
        return {"root": top, "commit": _git(top, "rev-parse", "HEAD"), "branch": _git(top, "rev-parse", "--abbrev-ref", "HEAD"),
                "dirty": bool(_git(top, "status", "--porcelain", "--untracked-files=no")),
                "subdir": os.path.relpath(path, top) if str(path) != top else ""}

    def targets(self):
        out = self._targets()
        for t in out:
            t["closed_reason"] = self._closed_reason(t)
            t["openable"] = t["closed_reason"] is None
        return out

    def _closed_reason(self, t):
        """Why this target cannot be opened for editing, in plain words, or None."""
        if not t.get("repo") or not t["repo"].get("commit"):
            return "it has no git source"
        if t["private"] and t["id"] not in self.allow_private:
            return f"it is private; its owner ({t['owner']}) has to agree first"
        if t.get("repository_id") not in self.repos:
            return "the Code service has no editable copy of it registered"
        return None

    def _targets(self):
        out = []
        platform = self._repo(self.platform_root)
        platform_owner, private = self._owner(self.platform_root)
        owner = platform_owner
        out.append({"id": "platform", "kind": "hive", "label": "OmegaHive platform",
                    "detail": "The hive server, its interface and the Omega runtime every mind runs on",
                    "source": str(self.platform_root), "repository_id": "platform", "repo": platform,
                    "owner": owner, "private": private,
                    "apply": {"how": "canary", "ready": False, "note": "a candidate hive on a scratch canary first, then the live hive with one-step rollback"}})
        for entry in sorted(self.hive.programs.programs.values(), key=lambda e: e["name"]):
            path = pathlib.Path(entry.get("path") or "")
            owner, private = self._owner(path)
            out.append({"id": f"program:{entry['id']}", "kind": "program", "label": entry["name"],
                        "detail": entry.get("description") or "", "source": str(path), "repository_id": f"program:{entry['id']}",
                        "repo": self._repo(path) if path.exists() else None, "owner": owner, "private": private,
                        "built_in": entry.get("source") == "built-in",
                        "apply": {"how": "reload", "ready": True, "note": "reload programs; open sessions refetch their view"}})
        for agent in self.hive.agents():
            if agent["kind"] == "module":
                continue  # external members run their own code elsewhere
            out.append({"id": f"mind:{agent['id']}", "kind": "mind", "label": agent["name"],
                        "detail": f"{agent['kind']} mind on {agent['model']}", "source": str(self.platform_root),
                        "repository_id": "platform", "repo": platform, "owner": platform_owner, "private": False,
                        "mind": {"id": agent["id"], "hue": agent["hue"], "status": agent["status"]},
                        "apply": {"how": "restart", "ready": True, "note": "restart this mind on the changed runtime; its memory stays"}})
        for repo_id, spec in sorted(self.repos.items()):
            path = pathlib.Path(str(spec.get("path", ""))).expanduser()
            out.append({"id": f"repo:{repo_id}", "kind": "repository", "label": spec.get("label") or repo_id,
                        "detail": spec.get("detail") or "Registered OmegaCode repository", "source": str(path),
                        "repository_id": repo_id, "repo": self._repo(path) if path.exists() else None,
                        "owner": spec.get("owner") or "OmegaCode", "private": False,
                        "apply": {"how": "candidate", "ready": False, "note": "candidate only; nothing runs live from it"}})
        for svc in self.hive.services.list():
            out.append({"id": f"service:{svc['name']}", "kind": "service", "label": svc["name"],
                        "detail": f"registered service at {svc['address']}", "source": None,
                        "repository_id": f"service:{svc['name']}", "repo": None, "owner": "its owner", "private": False,
                        "apply": {"how": "owner", "ready": False, "note": "its owner restarts the service"}})
        return out

    def target(self, target_id):
        for t in self.targets():
            if t["id"] == target_id:
                return t
        raise CodeError(404, "not_found", f"no edit target {target_id}")

    def openable(self, target_id):
        t = self.target(target_id)
        if t["private"] and target_id not in self.allow_private:
            raise CodeError(403, "private_target", f"{t['label']} is private; its owner ({t['owner']}) has to agree before it can be opened here")
        return t

    def tree(self, target_id, limit=4000):
        t = self.openable(target_id)
        repo = t.get("repo")
        if not repo or not repo.get("commit"):
            raise CodeError(409, "no_source", "this target has no git source to browse")
        args = ["ls-tree", "-r", "--name-only", repo["commit"]]
        if repo.get("subdir"):
            args.append(repo["subdir"])
        listing = _git(repo["root"], *args)
        files = [f for f in (listing or "").splitlines() if f and not f.startswith(".")][:limit]
        return {"target": target_id, "commit": repo["commit"], "subdir": repo.get("subdir", ""), "files": files,
                "truncated": len(files) >= limit}

    def repositories(self):
        """The registered repositories a mind may open, with their current commit."""
        out = []
        for repo_id, spec in sorted(self.repos.items()):
            repo = self._repo(pathlib.Path(str(spec.get("path", ""))).expanduser())
            if repo and repo.get("commit"):
                out.append({"id": repo_id, "label": spec.get("label") or repo_id, "commit": repo["commit"]})
        return out

    # ---- opening a target as a task --------------------------------------------------------------

    def code_swarm(self):
        for swarm in self.hive.swarms():
            if swarm["name"] == "Code local":
                return swarm
        return self.hive.create_swarm("Code local", "Coding tasks: edits to what runs in this hive", 205)

    async def open(self, target_id, principal):
        self.require_intended_release()
        t = self.openable(target_id)
        if not t.get("repo") or not t["repo"].get("commit"):
            raise CodeError(409, "no_source", "this target has no git source to open")
        if t.get("repository_id") not in self.repos:   # refuse before creating a task and grant that cannot work
            raise CodeError(409, "not_editable", f"{t['label']} cannot be opened for editing: {self._closed_reason(t)}")
        swarm = self.code_swarm()
        goal = await self.hive.goals.create(swarm["id"], f"Edit code: {t['label']}",
                                            f"target={t['id']} repository={t['repository_id']} commit={t['repo']['commit']}",
                                            0.5, None, created_by=principal)
        grant = self.hive.services.grant(goal["id"], principal, "edit", None, 12 * 60, by=principal)
        return {"target": t, "task_id": goal["id"], "swarm_id": swarm["id"], "grant_id": grant["id"],
                "repository_id": t["repository_id"], "base_commit": t["repo"]["commit"]}

    # ---- the relay ---------------------------------------------------------------------------------

    async def attach(self, task_id, workspace_id, repository_id, principal):
        self.require_intended_release()
        """Admin explicitly joins an existing active coding workspace; never creates a goal."""
        if not re.fullmatch(r"ws_[A-Za-z0-9_-]+", workspace_id):
            raise CodeError(400, "bad_workspace", "name an existing workspace")
        if repository_id not in self.repos:
            raise CodeError(403, "repository_unregistered", "this repository is not registered for coding")
        target = self.openable("repo:" + repository_id)
        goal = self.hive.goals.get(task_id)
        if goal["status"] in ("done", "failed", "cancelled"):
            raise CodeError(409, "task_closed", "this task is closed; it cannot be reopened by attaching")
        grant = self.hive.services.grant(task_id, principal, "edit", workspace_id, 120, by=principal)
        try:
            status, content, _ = await self.proxy(principal, "GET", "/v1/workspaces/" + workspace_id,
                                                 {}, None, task_id, grant["id"], repository_id)
            if status != 200:
                raise CodeError(403, "workspace_refused", "workspace is unavailable or outside this task/repository")
            workspace = json.loads(content)
            if not isinstance(workspace, dict) or not workspace.get("base_commit"):
                raise CodeError(502, "workspace_invalid", "coding service returned an invalid workspace")
            if any(workspace.get(k) != v for k, v in {"id":workspace_id, "task_id":task_id,
                   "swarm_id":goal["swarm_id"], "repository_id":repository_id}.items()):
                raise CodeError(403, "workspace_mismatch", "workspace does not match this task/swarm/repository")
        except Exception:
            self.hive.services.revoke_grant(task_id, grant["id"])
            raise
        return {"target":target, "task_id":task_id, "swarm_id":goal["swarm_id"], "grant_id":grant["id"],
                "repository_id":repository_id, "base_commit":workspace["base_commit"], "workspace_id":workspace_id}

    def select_target(self, task_id, repository_id, principal):
        self.require_intended_release()
        """Admin explicitly picks the repository for an existing task that has no workspace or target yet.
        Keeps the exact task: no goal is created, changed or reopened; only an edit grant is added for the person."""
        if not re.fullmatch(r"g_[A-Za-z0-9_-]+", task_id or ""):
            raise CodeError(400, "bad_task", "name an existing task")
        if repository_id not in self.repos:
            raise CodeError(403, "repository_unregistered", "this repository is not registered for coding")
        target = self.openable("repo:" + repository_id)
        if not target.get("repo") or not target["repo"].get("commit"):
            raise CodeError(409, "no_source", "this target has no git source to open")
        goal = self.hive.db.one("SELECT id, swarm_id, status FROM goals WHERE id = ?", (task_id,))
        if goal is None:
            raise CodeError(404, "not_found", f"no task {task_id}")
        if goal["status"] in ("done", "failed", "cancelled"):
            raise CodeError(409, "task_closed", "this task is closed; it cannot be reopened by choosing a target")
        grant = self.hive.services.grant(task_id, principal, "edit", None, 12 * 60, by=principal)
        return {"target": target, "task_id": task_id, "swarm_id": goal["swarm_id"], "grant_id": grant["id"],
                "repository_id": repository_id, "base_commit": target["repo"]["commit"]}

    def _capability(self, principal, task_id, grant_id, repository_id, actions, paths=None, family=None):
        actions = tuple(sorted(set(actions)))
        if not actions or not set(actions) <= set(HUMAN_ACTIONS):
            raise CodeError(500, "route_actions_invalid", "a relayed route must name a nonempty subset of OmegaCode actions")
        # tokens never shared across action sets, path scopes, or with a copy-apply route family (Kimi s3-b40fa13)
        key = (principal, task_id, repository_id, grant_id, actions, tuple(paths) if paths else None, family)
        token, exp, cap_id = (self._caps.get(key) or (None, 0, None)) + ((None,) if len(self._caps.get(key) or ()) == 2 else ())
        if token and exp - 60 > time.time():
            svc = self.hive.services.by_name("omegacode")
            # A revoked capability or withdrawn grant is never reused from the cache (Kimi 2026-10-05).
            if cap_id and self.hive.services.capability_status(svc, cap_id).get("active"):
                return token
            self._caps.pop(key, None)
        svc = self.hive.services.by_name("omegacode")
        goal = self.hive.db.one("SELECT swarm_id FROM goals WHERE id = ?", (task_id,))
        if goal is None:
            raise CodeError(404, "not_found", f"no task {task_id}")
        prefixes = self.repos.get(repository_id, {}).get("argv_prefixes", [])
        if not isinstance(prefixes, list) or any(not isinstance(p, list) or not p or
                any(not isinstance(a, str) or not a or "\x00" in a for a in p) for p in prefixes):
            raise CodeError(503, "repository_config_invalid", "operator argv_prefixes must be nonempty arrays of command arguments")
        issued = self.hive.services.issue(svc["id"], actor=principal, kind="human", task_id=task_id, swarm_id=goal["swarm_id"],
                                          repository_id=repository_id, actions=list(actions), ttl_seconds=900,
                                          grant_id=grant_id, argv_prefixes=prefixes, by=principal,
                                          paths=list(paths) if paths else None)
        self._caps[key] = (issued["token"], issued["claims"]["exp"], issued["claims"]["id"])
        return issued["token"]

    CODE_AGENT_PLIST = os.environ.get("HIVE_CODE_AGENT_PLIST",
                                      str(pathlib.Path.home() / "Library/LaunchAgents/family.omegahive.omegacode.plist"))

    def _loaded_release_mismatch(self):
        """The routes are written for INTENDED_SERVICE_RELEASE; if the Code service on this machine is configured to import
        omegacode from anything else, relaying would mint authority for routes that service may treat differently (Kimi
        next13 #4). Reads the LaunchAgent's PYTHONPATH in import order (re-read when the file changes): the first entry that
        provides an omegacode package must be exactly .../releases/<pin>, and no other entry may provide one (OmegaReview
        next15 B1: a wrong release earlier in the path shadowed the right one). An agent that exists but cannot be read
        fails closed; no agent on this machine means nothing to check. Configuration only: rollout receipts still check the
        running process."""
        import plistlib
        agent = pathlib.Path(self.CODE_AGENT_PLIST)
        try:
            st = agent.stat()
            stamp = (st.st_mtime_ns, st.st_size)          # a same-second rewrite still changes one of these (Kimi)
        except FileNotFoundError:
            if not getattr(self, "_no_agent_logged", False):
                self._no_agent_logged = True
                import logging
                logging.getLogger("hive").warning("no Code service LaunchAgent at %s: the release guard checks nothing here",
                                                  agent)
            return None
        except OSError:
            return "agent unreadable"
        if getattr(self, "_release_check", (None, None))[0] != stamp:
            self._release_check = (stamp, self._configured_release_problem(agent, plistlib))
        return self._release_check[1]

    @staticmethod
    def _configured_release_problem(agent, plistlib):
        """Ask Python's own path finder which omegacode the configured service would import, over the same search
        order it uses: the working directory first when started with -m, then PYTHONPATH. It must be exactly
        releases/<pin>/omegacode, and no other entry may offer a real module or package (a plain omegacode.py, a
        compiled or extension module, another package): Code showed a module file shadowing the release
        (OmegaReview next15 B1, Code module-shadow finding). Namespace-only directories never win over a package."""
        import importlib.machinery
        try:
            config = plistlib.loads(agent.read_bytes())
            entries = str(config["EnvironmentVariables"]["PYTHONPATH"]).split(":")
            argv = [str(a) for a in config.get("ProgramArguments", [])]
            workdir = config.get("WorkingDirectory")
        except Exception:
            return "agent unreadable"
        # Relative or empty entries resolve against the service's own directory, not the hive's, so their meaning cannot
        # be checked from here: refuse them, and require an absolute working directory for -m (OmegaReview next15 B1).
        if any(not e or not pathlib.Path(e).is_absolute() for e in entries):
            return "relative or empty entry on the configured path"
        if "-m" in argv:
            if not workdir or not pathlib.Path(str(workdir)).is_absolute():
                return "no absolute working directory for a -m service"
            entries = [str(workdir)] + entries
        finder = importlib.machinery.PathFinder
        spec = finder.find_spec("omegacode", entries)
        if spec is None or spec.origin is None:
            return "no omegacode package on the configured path"
        chosen = pathlib.Path(spec.origin)
        release = chosen.parent.parent
        if chosen.name != "__init__.py" or chosen.parent.name != "omegacode" or release.name != INTENDED_SERVICE_RELEASE \
                or release.parent.name != "releases":
            return f"configured import is {spec.origin}"
        # judged on the real files, not the spelling: a symlinked release or package resolving elsewhere is refused (Kimi)
        real = chosen.resolve()
        if not real.is_file() or real.parent.parent != release.resolve() or release.resolve().name != INTENDED_SERVICE_RELEASE \
                or release.resolve().parent.name != "releases" or real.parent.name != "omegacode":
            return f"configured import resolves to {real}"
        others = [e for e in entries if pathlib.Path(e) != release
                  and (lambda s: s is not None and s.origin is not None)(finder.find_spec("omegacode", [e]))]
        if others:
            return "another omegacode module or package is on the configured path"
        return None

    def require_intended_release(self):
        """Every place that issues Code authority asks this first: open, attach, select_target, the two capability routes
        and the relay (Kimi next15: the relay alone was guarded while grants and capabilities were minted unchecked)."""
        problem = self._loaded_release_mismatch()
        if problem is not None:
            raise CodeError(503, "service_release_mismatch",
                            f"the Code service is configured to load another release than the hive's routes were written for "
                            f"({INTENDED_SERVICE_RELEASE[:8]}): {problem}")

    async def proxy(self, principal, method, path, query, body, task_id, grant_id, repository_id):
        self.require_intended_release()
        # fullmatch: a trailing newline or extra characters never match an allowlisted route (Code 54fa42d3)
        decision, entry = copy_apply_route(method, path, self.hive.settings.copy_apply_claims)
        if decision == "purpose_only":
            raise CodeError(403, "purpose_only", "applying a proposal needs the controller's copy_apply capability; "
                                                 "the person relay never applies one")
        if decision == "held":
            raise CodeError(404, "not_relayed", f"{method} {path} is held until copy-apply is switched on")
        route = (entry["method"], entry["pattern"], entry["person"]) if entry else \
            next((r for r in PROXY_ROUTES if r[0] == method and re.fullmatch(r[1], path)), None)
        if route is None:
            raise CodeError(404, "not_relayed", f"{method} {path} is not available through the hive")
        paths = None
        if entry and entry["human_only"]:
            # Undo: the person's own active edit grant on this task covering this workspace (principal, task, not revoked,
            # not expired, edit scope, workspace); every refusal is edit_grant_required. Never the operator login without
            # a grant, never a mind (this relay only ever mints kind=human). The grant's path scope goes into the claim.
            grant = self.hive.db.one("SELECT * FROM goal_grants WHERE id = ?", (grant_id,)) if grant_id else None
            workspace = path.split("/")[3]
            if grant is None or grant["principal"] != principal or grant["goal_id"] != task_id or grant["revoked_at"] \
                    or grant["expires_at"] <= time.time() or grant["scope"] != "edit" or grant["workspace_id"] not in (None, workspace):
                raise CodeError(403, "edit_grant_required", "Undo needs your own active edit grant on this task and workspace")
            paths = grant_path_scope(grant)
        discovery = re.fullmatch(r'/v1/tasks/(g_[A-Za-z0-9_-]+)/workspaces', path)
        if discovery and discovery.group(1) != task_id:
            raise CodeError(403, 'task_mismatch', 'workspace discovery path must match the capability task')
        if grant_id:
            grant = self.hive.db.one("SELECT * FROM goal_grants WHERE id = ?", (grant_id,))
            if grant is None or grant["principal"] != principal or grant["goal_id"] != task_id \
                    or grant["revoked_at"] or grant["expires_at"] <= time.time():
                raise CodeError(403, "grant_invalid", "no active edit grant for you on that task")
            if not scope_allows(grant["scope"], route[2]):
                # a read grant never yields edit, run, checkpoint or any other write-capable capability
                raise CodeError(403, "grant_scope", f"your {grant['scope']} grant does not allow {method} {path}")
        elif principal != "user:operator":
            raise CodeError(403, "grant_required", "open the target first")
        svc = self.hive.services.by_name("omegacode")
        query = checked_query(route[1], query)
        token = self._capability(principal, task_id, grant_id, repository_id, route[2], paths=paths,
                                 family=entry["pattern"] if entry else None)
        try:
            response = await self.client.request(method, svc["address"] + path, params=query,
                                                 content=body if body else None,
                                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                                                 timeout=60)
        except httpx.HTTPError as exc:
            raise CodeError(502, "service_unreachable", f"OmegaCode did not answer: {exc}") from exc
        if response.status_code == 200 and path.startswith("/v1/artifacts/"):
            result = {"digest": path.rsplit("/", 1)[-1], "size_bytes": len(response.content),
                      "content_base64": base64.b64encode(response.content).decode()}
            return 200, json.dumps(result).encode(), "application/json"
        if response.status_code >= 400:
            return relayed_error(response.status_code, response.content)
        return response.status_code, response.content, response.headers.get("content-type", "application/json")
