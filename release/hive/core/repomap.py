"""Repository maps (repo-map/1), Slice A: a platform-owned loader and one read engine for people, minds and MCP.

PLATFORM_REPO_MAP_SLICE_A_CONTRACT_R1_20261011.md is the contract; Code's
PREDEGA_REPO_MAP_INTERFACE_R1_20261011.md is the envelope.

- The JSON envelope is the authority. It is validated once, on load, by an admin; a loaded revision is never changed in
  place (same digest: idempotent; different digest: 409 map_exists). The last KEEP_REVISIONS revisions per repo are kept,
  plus any pinned one.
- The host derives the inert atoms itself, with one encoder (``atoms``); excerpts stay in the JSON, never in atoms. The
  atoms are kept beside the revision (repo_map_atoms, the durable copy) and mounted into the read-only SpaceService space
  ``repo:<repo>@<sha>`` (spaces/service.py ``mount_repo``), which only this loader writes; after a restart they are mounted
  again from the database. The read routes answer from the database rows; the space is not yet queried by members (raw
  MeTTa patterns are a later, reviewed, non-executing subset).
- Reads go through ``RepoMaps`` only: the HTTP routes, the minds' ``repo-query`` skill (which calls those routes with the
  mind's own token) and the MCP tool ``hive_repo_query`` all call the same methods as the caller. Nothing here writes for
  a member or a mind, and nothing here is evidence, a truth value or a permission.
- A map the caller may not see answers 404 not_found, exactly like an unknown one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import threading
import time

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from ..spaces import sexpr
from ..spaces.service import RepoMountIncomplete
from .db import now, parse_stamp

SCHEMA_ID = "repo-map/1"
STATES = ("ready", "partial", "stale", "unavailable", "failed")
NODE_KINDS = ("file", "module", "def", "import", "test", "doc")
BASES = ("declared", "syntax", "heuristic")
LIMIT_DEFAULT, LIMIT_MAX = 50, 200
RESPONSE_CAP = 256 * 1024      # every read response (page, detail, header) fits in this many bytes as sent
COVERAGE_MAX = 192 * 1024      # coverage travels whole in the header; the rest of the header stays far below 64 KiB
CURSOR_SECONDS = 3600
TIME_BOUND = 2.0               # seconds a query may take before it answers partial (reason time_bound)
KEEP_REVISIONS = 5
MAX_BODY = 32 * 1024 * 1024    # the loader's body
MAX_NODES, MAX_EDGES, MAX_REFS = 100_000, 400_000, 16
EXCERPT_MAX, TEXT_MAX, ID_MAX, PARAM_MAX = 1000, 1000, 512, 512

REPO = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
SHA = re.compile(r"[0-9a-f]{7,64}\Z")   # hex only: drift cursors bind "<from>..<to>", which no valid sha can spell
EDGE_KIND = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
SWARM = re.compile(r"swarm:(s_[A-Za-z0-9_-]{1,64})\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
ATOM_CONTROL = re.compile(r"[\x00-\x1f\x7f]")   # strings that become atoms: no line breaks or tabs either

ENVELOPE_KEYS = ("schema", "repo", "sha", "snapshot_digest", "extractor", "generated_at", "receipt", "state", "reason",
                 "coverage", "nodes", "edges", "truncated", "next_cursor")
NODE_KEYS, NODE_OPTIONAL = ("id", "kind", "label", "source_digest", "refs"), ("declaration",)
EDGE_KEYS = ("id", "kind", "from", "to", "basis", "refs")

SCHEMA = """
CREATE TABLE IF NOT EXISTS repo_maps (
  repo TEXT NOT NULL, sha TEXT NOT NULL, digest TEXT NOT NULL, schema TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
  visibility TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, header TEXT NOT NULL, counts TEXT NOT NULL,
  loaded_by TEXT NOT NULL, loaded_at TEXT NOT NULL, PRIMARY KEY (repo, sha)
);
CREATE TABLE IF NOT EXISTS repo_map_nodes (
  repo TEXT NOT NULL, sha TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT,
  search TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (repo, sha, id)
);
CREATE INDEX IF NOT EXISTS repo_map_nodes_seq ON repo_map_nodes(repo, sha, seq);
CREATE INDEX IF NOT EXISTS repo_map_nodes_path ON repo_map_nodes(repo, sha, path);
CREATE TABLE IF NOT EXISTS repo_map_edges (
  repo TEXT NOT NULL, sha TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, src TEXT NOT NULL,
  dst TEXT NOT NULL, basis TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (repo, sha, id)
);
CREATE INDEX IF NOT EXISTS repo_map_edges_src ON repo_map_edges(repo, sha, src);
CREATE INDEX IF NOT EXISTS repo_map_edges_dst ON repo_map_edges(repo, sha, dst);
CREATE TABLE IF NOT EXISTS repo_map_grants (
  repo TEXT NOT NULL, principal TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, PRIMARY KEY (repo, principal)
);
CREATE TABLE IF NOT EXISTS repo_map_atoms (
  repo TEXT NOT NULL, sha TEXT NOT NULL, seq INTEGER NOT NULL, atom TEXT NOT NULL, PRIMARY KEY (repo, sha, seq)
);
"""

# Code's preset list. Each takes exactly these params (True = required); a node is chosen by node_id or by path.
_NODE = {"node_id": False, "path": False}
PRESETS = {
    "imports": {"params": _NODE, "pick": True,
                "description": "what the chosen nodes import (outgoing imports edges)",
                "basis_note": "syntactic import statements only; an import is not a resolved runtime dependency"},
    "potential-dependents": {"params": {**_NODE, "max_depth": False}, "pick": True,
                             "description": "what imports or calls the chosen nodes, followed transitively (cycle-safe) over incoming "
                                            "imports and calls-expression edges; each dependent carries its distance; max_depth 1 "
                                            "gives direct links only",
                             "basis_note": "static imports and call expressions followed transitively; possible dependents, "
                                           "not runtime impact and not a resolved call graph"},
    "defines": {"params": _NODE, "pick": True,
                "description": "what the chosen nodes define (outgoing defines edges)",
                "basis_note": "syntactic definitions only"},
    "calls-expression": {"params": _NODE, "pick": True,
                         "description": "call expressions written in the chosen nodes (outgoing calls-expression edges)",
                         "basis_note": "call expressions by name; not resolved calls"},
    "source-search": {"params": {"q": True, "kind": False, "path_prefix": False}, "pick": False,
                      "description": "nodes whose id, label, paths or excerpts contain q (case-insensitive)",
                      "basis_note": "lexical match on ids, labels, paths and excerpts only"},
    "test-doc-links": {"params": _NODE, "pick": True,
                       "description": "test and doc links to or from the chosen nodes, each with its basis",
                       "basis_note": "declared and static links only; not runtime coverage"},
    "drift": {"params": {"from": True}, "pick": False,
              "description": "nodes added, removed, changed or moved between revision 'from' and this one",
              "basis_note": "node identity is the map's logical id; moved only with unique source_digest evidence"},
}
_EDGE_PRESETS = {  # preset -> (edge kinds, direction from the chosen nodes)
    "imports": (("imports",), "out"),
    "defines": (("defines",), "out"), "calls-expression": (("calls-expression",), "out"),
    "test-doc-links": (("test-doc-link",), "both"),
}


def _canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest_of(envelope):
    """The revision's content digest: sha256 over the canonical JSON of the whole envelope as loaded."""
    return "sha256:" + hashlib.sha256(_canon(envelope).encode()).hexdigest()


def _size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


# ---- the one encoder: JSON -> inert atoms ------------------------------------------------------------------------------

def _s(value):
    return sexpr.Str("" if value is None else str(value))


def atoms(envelope):
    """The repo-map/1 envelope as inert MeTTa atoms (contract §2). Strings are quoted, kinds/basis/state are symbols the
    validator already restricted, lines are integers. No truth values, permissions, evidence or excerpts."""
    ext = envelope["extractor"]
    out = [[ "repo-map", _s(envelope["repo"]), _s(envelope["sha"]), envelope["state"], _s(ext["id"]), _s(ext["version"]),
             _s(envelope["snapshot_digest"])]]
    for node in envelope["nodes"]:
        out.append(["repo-node", _s(node["id"]), node["kind"], _s(node["label"]), _s(node["source_digest"])])
        out.extend(["repo-ref", _s(node["id"]), _s(ref["path"]), int(ref["line"])] for ref in node["refs"])
    for edge in envelope["edges"]:
        out.append(["repo-edge", _s(edge["id"]), edge["kind"], _s(edge["from"]), _s(edge["to"]), edge["basis"]])
        out.extend(["repo-ref", _s(edge["id"]), _s(ref["path"]), int(ref["line"])] for ref in edge["refs"])
    out.extend(["repo-unresolved", _s(u["path"]), _s(u["issue"])] for u in envelope["coverage"].get("unresolved") or [])
    return [sexpr.render(a) for a in out]


# ---- validation --------------------------------------------------------------------------------------------------------

class _Invalid(Exception):
    pass


class _TooLarge(Exception):
    pass


def _text(value, where, limit=TEXT_MAX, empty=True, atom=True):
    """atom: the string becomes part of an atom, so no control characters at all; otherwise tabs and line breaks pass."""
    if not isinstance(value, str) or len(value) > limit or (not empty and not value) or (ATOM_CONTROL if atom else CONTROL).search(value):
        raise _Invalid(f"{where}: a string of at most {limit} characters, no control characters" + ("" if empty else ", not empty"))
    return value


def _path(value, where):
    _text(value, where, ID_MAX, empty=False)
    parts = value.split("/")
    if value.startswith("/") or "\\" in value or "\n" in value or any(p in ("", ".", "..") for p in parts):
        raise _Invalid(f"{where}: a relative path inside the snapshot (no leading /, no . or .. parts, no backslash)")
    return value


def _keys(obj, where, required, optional=()):
    if not isinstance(obj, dict):
        raise _Invalid(f"{where}: an object")
    missing, unknown = [k for k in required if k not in obj], sorted(set(obj) - set(required) - set(optional))
    if missing or unknown:
        raise _Invalid(f"{where}: " + "; ".join((["missing " + ", ".join(missing)] if missing else [])
                                                 + (["unknown " + ", ".join(unknown)] if unknown else [])))


def _refs(refs, where):
    if not isinstance(refs, list) or len(refs) > MAX_REFS:
        raise _Invalid(f"{where}: a list of at most {MAX_REFS} references")
    for i, ref in enumerate(refs):
        _keys(ref, f"{where}[{i}]", ("path", "line"), ("excerpt",))
        _path(ref["path"], f"{where}[{i}].path")
        if type(ref["line"]) is not int or ref["line"] < 0:
            raise _Invalid(f"{where}[{i}].line: a non-negative integer")
        if "excerpt" in ref and (not isinstance(ref["excerpt"], str) or len(ref["excerpt"]) > EXCERPT_MAX):
            raise _Invalid(f"{where}[{i}].excerpt: a string of at most {EXCERPT_MAX} characters")
    return len(refs)


def validate(envelope):
    """The counts of a valid repo-map/1 envelope; raises _Invalid (400), or returns None for an unknown schema (422)."""
    if not isinstance(envelope, dict):
        raise _Invalid("the body is a repo-map/1 JSON object")
    if envelope.get("schema") != SCHEMA_ID:
        return None
    _keys(envelope, "$", ENVELOPE_KEYS)
    if not isinstance(envelope["repo"], str) or not REPO.fullmatch(envelope["repo"]):
        raise _Invalid("$.repo: letters, digits, dot, dash or underscore, at most 128")
    if not isinstance(envelope["sha"], str) or not SHA.fullmatch(envelope["sha"]):
        raise _Invalid("$.sha: 7 to 64 lowercase hex characters")
    _text(envelope["snapshot_digest"], "$.snapshot_digest", 200, empty=False)
    _keys(envelope["extractor"], "$.extractor", ("id", "version", "parser"))
    for key in ("id", "version"):
        _text(envelope["extractor"][key], f"$.extractor.{key}", 200, empty=False)
    _text(envelope["extractor"]["parser"], "$.extractor.parser", 200, atom=False)
    if parse_stamp(_text(envelope["generated_at"], "$.generated_at", 64, empty=False)) is None:
        raise _Invalid("$.generated_at: an ISO 8601 time")
    _keys(envelope["receipt"], "$.receipt", ("digest", "artifact_ref"))
    for key in ("digest", "artifact_ref"):
        _text(envelope["receipt"][key], f"$.receipt.{key}", ID_MAX, empty=False, atom=False)
    if envelope["state"] not in STATES:
        raise _Invalid(f"$.state: one of {', '.join(STATES)}")
    if envelope["reason"] is not None:
        _text(envelope["reason"], "$.reason", 2000, atom=False)
    coverage = envelope["coverage"]
    if not isinstance(coverage, dict):
        raise _Invalid("$.coverage: an object")
    if _size(coverage) > COVERAGE_MAX:
        raise _TooLarge(f"$.coverage is over {COVERAGE_MAX // 1024} KiB: the map header (which carries it whole) must fit a "
                        f"{RESPONSE_CAP // 1024} KiB response")
    unresolved = coverage.get("unresolved", [])
    if not isinstance(unresolved, list):
        raise _Invalid("$.coverage.unresolved: a list")
    for i, item in enumerate(unresolved):
        _keys(item, f"$.coverage.unresolved[{i}]", ("path", "issue"))
        _path(item["path"], f"$.coverage.unresolved[{i}].path")
        _text(item["issue"], f"$.coverage.unresolved[{i}].issue")
    if envelope["truncated"] is not False or envelope["next_cursor"] is not None:
        raise _Invalid("$.truncated must be false and $.next_cursor null: load the whole map, not a page of one")
    nodes, edges = envelope["nodes"], envelope["edges"]
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise _Invalid("$.nodes and $.edges: lists")
    ids, by_kind, edge_kind, basis, refs = set(), {}, {}, {}, 0
    for i, node in enumerate(nodes):
        _keys(node, f"$.nodes[{i}]", NODE_KEYS, NODE_OPTIONAL)
        _text(node["id"], f"$.nodes[{i}].id", ID_MAX, empty=False)
        if node["id"] in ids:
            raise _Invalid(f"$.nodes[{i}].id: duplicate id {node['id']!r}")
        ids.add(node["id"])
        if node["kind"] not in NODE_KINDS:
            raise _Invalid(f"$.nodes[{i}].kind: one of {', '.join(NODE_KINDS)}")
        _text(node["label"], f"$.nodes[{i}].label")
        _text(node["source_digest"], f"$.nodes[{i}].source_digest", 200)
        refs += _refs(node["refs"], f"$.nodes[{i}].refs")
        if "declaration" in node and (not isinstance(node["declaration"], dict) or _size(node["declaration"]) > 4096):
            raise _Invalid(f"$.nodes[{i}].declaration: an object of at most 4 KiB")
        by_kind[node["kind"]] = by_kind.get(node["kind"], 0) + 1
    edge_ids = set()
    for i, edge in enumerate(edges):
        _keys(edge, f"$.edges[{i}]", EDGE_KEYS)
        _text(edge["id"], f"$.edges[{i}].id", ID_MAX, empty=False)
        if edge["id"] in edge_ids or edge["id"] in ids:
            raise _Invalid(f"$.edges[{i}].id: duplicate id {edge['id']!r}")
        edge_ids.add(edge["id"])
        if not isinstance(edge["kind"], str) or not EDGE_KIND.fullmatch(edge["kind"]):
            raise _Invalid(f"$.edges[{i}].kind: a lowercase token such as imports, defines, calls-expression, test-doc-link")
        if edge["from"] not in ids:
            raise _Invalid(f"$.edges[{i}].from: must name a node of this map")
        _text(edge["to"], f"$.edges[{i}].to", ID_MAX, empty=False)   # a node id, or an unresolved target name
        if edge["basis"] not in BASES:
            raise _Invalid(f"$.edges[{i}].basis: one of {', '.join(BASES)}")
        refs += _refs(edge["refs"], f"$.edges[{i}].refs")
        edge_kind[edge["kind"]] = edge_kind.get(edge["kind"], 0) + 1
        basis[edge["basis"]] = basis.get(edge["basis"], 0) + 1
    return {"nodes": len(nodes), "edges": len(edges), "refs": refs, "unresolved": len(unresolved),
            "nodes_by_kind": dict(sorted(by_kind.items())), "edges_by_kind": dict(sorted(edge_kind.items())),
            "edges_by_basis": dict(sorted(basis.items()))}


def _node_path(node):
    if node["refs"]:
        return node["refs"][0]["path"]
    return node["label"] if node["kind"] == "file" else None


def _search_text(node):
    parts = [node["id"], node["label"]] + [r["path"] for r in node["refs"]] + [r.get("excerpt", "") for r in node["refs"]]
    return "\n".join(parts).lower()


# ---- the engine --------------------------------------------------------------------------------------------------------

class _Deadline:
    """One read's TIME_BOUND clock. late() is sticky: once the bound has passed, hit stays True and the answer is partial."""

    def __init__(self):
        self.at, self.hit = time.monotonic() + TIME_BOUND, False

    def late(self):
        if not self.hit and time.monotonic() > self.at:
            self.hit = True
        return self.hit


class Caller:
    """Who reads: a person (user:...) or a mind (agent:<id>, with its swarm)."""

    def __init__(self, principal, admin=False, swarm_id=None, agent=None):
        self.principal, self.admin, self.swarm_id, self.agent = principal, bool(admin), swarm_id, agent


class RepoMaps:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        with self.db._lock:
            self.db._conn.executescript(SCHEMA)
        # the hive's persistent cursor MAC key (motivations.py), domain-separated so no other cursor verifies here
        self._key = hmac.new(hive.motivations._key, b"omegahive repo-map/1 cursor", "sha256").digest()
        self._spaces, self._space_lock = {}, threading.Lock()   # (repo, sha) -> {"status", "atoms"}
        # After a restart PeTTa holds nothing (repo spaces are not op-logged). Mount again, on one worker, only the newest
        # revision of each repo and every pinned one; older retained revisions stay unmounted (said so) until something
        # first asks for their space (the header read). Boot cost: about 1-2 ms an atom on the shared interpreter, so
        # about 75-145 s per real-size map (74,674 atoms), per repo, with commons jobs interleaving between chunks.
        boot = self._boot_revisions()
        if boot:
            self._spaces.update({key: {"status": "queued", "atoms": 0} for key in boot})
            threading.Thread(target=self._remount, args=(boot,), name="repo-map-mount", daemon=True).start()

    def _err(self, status, code, message):
        return self.hive.error(status, code, message)

    def _boot_revisions(self):
        rows = self.db.all("SELECT repo, sha, pinned FROM repo_maps ORDER BY repo, rowid DESC")
        newest, keep = set(), []
        for r in rows:
            if r["repo"] not in newest or r["pinned"]:
                keep.append((r["repo"], r["sha"]))
            newest.add(r["repo"])
        return keep

    # ---- the read-only SpaceService space of each revision (only the loader writes it) ---------------------------

    def _mount_later(self, repo, sha, encoded=None):
        """Mount on a worker thread (a large map takes PeTTa minutes: about 1-2 ms an atom); the space says mounting
        until it holds every atom."""
        with self._space_lock:
            self._spaces[(repo, sha)] = {"status": "queued", "atoms": 0}   # waiting for the repo lock
        threading.Thread(target=self._mount, args=(repo, sha, encoded), name="repo-map-mount", daemon=True).start()
        return self.space(repo, sha)

    def _mount(self, repo, sha, encoded=None):
        """Mount one revision's space. The whole step, from the check that the revision still exists to the recorded
        state, runs under the spaces' repo lock, so a revision's mounts and unmounts (load, retry, retention, restart
        remount) never interleave; a retry waiting on the lock mounts the same atoms again from a clean space.
        States: queued (waiting for the lock), mounting (with added / total as it goes), mounted (holds every atom: the
        count after the adds equals the stored atom rows, checked by mount_repo), failed (the mount failed or the count
        disagreed, and the space was cleared: atoms 0), incomplete (a clear did not finish: atoms unknown, null)."""
        key, spaces = (repo, sha), self.hive.spaces
        with spaces.repo_lock:
            try:
                exists = self.db.one("SELECT 1 FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha)) is not None
            except Exception:   # the hive is closing
                return self.space(repo, sha)
            if not exists:      # retention dropped it before this mount ran
                with self._space_lock:
                    self._spaces.pop(key, None)
                return self.space(repo, sha)
            try:
                if encoded is None:
                    encoded = [r["atom"] for r in self.db.all("SELECT atom FROM repo_map_atoms WHERE repo = ? AND sha = ? ORDER BY seq",
                                                              (repo, sha))]

                def progress(added, total):
                    with self._space_lock:
                        self._spaces[key] = {"status": "mounting", "atoms": 0, "added": added, "total": total}

                progress(0, len(encoded))
                state = {"status": "mounted", "atoms": spaces.mount_repo(repo, sha, encoded, progress)}
            except RepoMountIncomplete as exc:
                logging.getLogger("hive").warning("repo map space %s@%s: mount failed, cleanup incomplete (%s)", repo, sha, exc)
                state = {"status": "incomplete", "atoms": None, "reason": "mount failed and the space was not cleared; contents unknown"}
            except Exception as exc:   # the map stays loaded and readable from the database
                logging.getLogger("hive").warning("repo map space %s@%s failed to mount (%s)", repo, sha, type(exc).__name__)
                state = {"status": "failed", "atoms": 0, "reason": "mount failed; the space was cleared"}
            with self._space_lock:
                self._spaces[key] = state
        return self.space(repo, sha)

    def _remount(self, keys):
        for repo, sha in keys:
            self._mount(repo, sha)

    def _unmount(self, repo, sha):
        with self.hive.spaces.repo_lock:
            try:
                self.hive.spaces.unmount_repo(repo, sha)
                state = None
            except Exception as exc:
                logging.getLogger("hive").warning("repo map space %s@%s failed to unmount (%s)", repo, sha, exc)
                state = {"status": "incomplete", "atoms": None, "reason": "dropped revision's space was not cleared; contents unknown"}
            with self._space_lock:
                if state is None:
                    self._spaces.pop((repo, sha), None)
                else:
                    self._spaces[(repo, sha)] = state

    def space(self, repo, sha, on_demand=False):
        """The revision's space state. on_demand: a retained revision not mounted (not mounted at start, or never) starts
        mounting now; failed and incomplete ones wait for an admin's idempotent reload."""
        if on_demand:
            with self._space_lock:
                idle = (repo, sha) not in self._spaces
            if idle:
                return self._mount_later(repo, sha)
        space_id, _ = self.hive.spaces.repo_space(repo, sha)
        with self._space_lock:
            state = dict(self._spaces.get((repo, sha)) or {"status": "unmounted", "atoms": 0})
        return {"id": space_id, "kind": "read-only", **state}

    # ---- loading (admin only; the route checks) -------------------------------------------------------------------

    def load(self, envelope, by, visibility=None, pinned=None):
        """visibility / pinned: None when the request did not set them (defaults hive / not pinned for a new revision).
        A loaded revision keeps its own; an idempotent reload that asked for another says so (visibility_unchanged /
        pinned_unchanged) instead of pretending it applied."""
        same = self._same_revision(envelope, visibility, pinned)
        if same is not None:
            return same
        try:
            counts = validate(envelope)
        except _Invalid as exc:
            raise self._err(400, "bad_request", str(exc)[:500]) from None
        except _TooLarge as exc:
            raise self._err(413, "too_large", str(exc)[:500]) from None
        if counts is None:
            raise self._err(422, "schema_unsupported", f"this host loads {SCHEMA_ID} only")
        if counts["nodes"] > MAX_NODES or counts["edges"] > MAX_EDGES:
            raise self._err(413, "too_large", f"a map holds at most {MAX_NODES} nodes and {MAX_EDGES} edges")
        asked_visibility, visibility = visibility, self._visibility(visibility)
        repo, sha, digest = envelope["repo"], envelope["sha"], digest_of(envelope)
        header = {k: envelope[k] for k in ENVELOPE_KEYS if k not in ("nodes", "edges", "truncated", "next_cursor")}
        encoded = atoms(envelope)
        with self.db.transaction():   # one transaction: a concurrent load of the same revision sees this one's row
            row = self.db.one("SELECT * FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
            if row is not None and row["digest"] != digest:
                raise self._err(409, "map_exists", f"{repo}@{sha} is already loaded with different content")
            if row is None:
                dropped = self._insert(envelope, header, counts, encoded, digest, visibility, bool(pinned), by)
        if row is not None:
            return self._unchanged(row, asked_visibility, pinned)
        if dropped:   # on the worker too: an unmount waits for any mount in progress, never the load's caller
            threading.Thread(target=lambda: [self._unmount(repo, gone) for gone in dropped], name="repo-map-unmount",
                             daemon=True).start()
        space = self._mount_later(repo, sha, encoded)
        return {"repo": repo, "sha": sha, "digest": digest, "state": envelope["state"], "counts": counts, "unchanged": False,
                "space": space}

    def _pin_retained_revision(self, repo, sha, expected_digest):
        """Internal retention only: pin an existing exact revision without loading, mounting or selecting it.

        The caller must already own the verified Source/assets handoff. This method adds no visibility, readiness,
        native mount, grant or authority claim; it preserves every other revision and every existing operator pin.
        Public idempotent load semantics intentionally remain unchanged.
        """
        if (type(repo) is not str or not REPO.fullmatch(repo)
                or type(sha) is not str or not SHA.fullmatch(sha)
                or type(expected_digest) is not str
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest)):
            raise self._err(400, "bad_request", "retention pin requires an exact repo, sha and canonical digest")
        with self.db.transaction():
            row = self.db.one("SELECT digest, pinned FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
            if row is None:
                raise self._err(404, "not_found", "no such repo map")
            if row["digest"] != expected_digest:
                raise self._err(409, "map_digest_mismatch", "retained repo map digest differs from expected content")
            changed = not bool(row["pinned"])
            if changed:
                self.db.execute("UPDATE repo_maps SET pinned = 1 WHERE repo = ? AND sha = ?", (repo, sha))
        return {"repo": repo, "sha": sha, "digest": expected_digest, "pinned": True, "changed": changed}

    def _same_revision(self, envelope, visibility=None, pinned=None):
        """The idempotent answer for a revision already loaded with exactly this content (same canonical digest), before
        any validation or encoding work; None otherwise (the full load path then validates, and refuses a different digest)."""
        if not isinstance(envelope, dict) or envelope.get("schema") != SCHEMA_ID:
            return None
        repo, sha = envelope.get("repo"), envelope.get("sha")
        if not isinstance(repo, str) or not isinstance(sha, str):
            return None
        row = self.db.one("SELECT * FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
        if row is None or row["digest"] != digest_of(envelope):
            return None
        return self._unchanged(row, visibility, pinned)

    def _unchanged(self, row, visibility, pinned):
        """The idempotent answer. A space that failed, is incomplete or is not mounted is mounted again from the same atoms."""
        repo, sha = row["repo"], row["sha"]
        space = self.space(repo, sha)
        if space["status"] in ("failed", "incomplete", "unmounted"):
            space = self._mount_later(repo, sha)
        out = {"repo": repo, "sha": sha, "digest": row["digest"], "state": row["state"], "counts": json.loads(row["counts"]),
               "unchanged": True, "space": space}
        if visibility is not None and visibility != row["visibility"]:
            out.update(visibility_unchanged=True, visibility=row["visibility"])
        if pinned is not None and bool(pinned) != bool(row["pinned"]):
            out.update(pinned_unchanged=True, pinned=bool(row["pinned"]))
        return out

    def _insert(self, envelope, header, counts, encoded, digest, visibility, pinned, by):
        """The revision's rows, inside the loader's transaction; returns the shas retention dropped."""
        repo, sha = envelope["repo"], envelope["sha"]
        self.db.insert("repo_maps", {"repo": repo, "sha": sha, "digest": digest, "schema": SCHEMA_ID,
                                     "state": envelope["state"], "reason": envelope["reason"], "visibility": visibility,
                                     "pinned": 1 if pinned else 0, "header": _canon(header), "counts": _canon(counts),
                                     "loaded_by": by, "loaded_at": now()})
        conn = self.db._conn
        conn.executemany("INSERT INTO repo_map_nodes (repo, sha, seq, id, kind, path, search, body) VALUES (?,?,?,?,?,?,?,?)",
                         [(repo, sha, i, n["id"], n["kind"], _node_path(n), _search_text(n), _canon(n))
                          for i, n in enumerate(envelope["nodes"])])
        conn.executemany("INSERT INTO repo_map_edges (repo, sha, seq, id, kind, src, dst, basis, body) VALUES (?,?,?,?,?,?,?,?,?)",
                         [(repo, sha, i, e["id"], e["kind"], e["from"], e["to"], e["basis"], _canon(e))
                          for i, e in enumerate(envelope["edges"])])
        conn.executemany("INSERT INTO repo_map_atoms (repo, sha, seq, atom) VALUES (?,?,?,?)",
                         [(repo, sha, i, a) for i, a in enumerate(encoded)])
        return self._retain(repo)

    def _visibility(self, value):
        value = value or "hive"
        if value in ("hive", "owner"):   # owner (repo maps 1.2): the hive owner and the principals they grant, nobody else
            return value
        match = SWARM.fullmatch(str(value))
        if not match or self.db.one("SELECT 1 FROM swarms WHERE id = ?", (match.group(1),)) is None:
            raise self._err(400, "bad_request", "visibility is hive or swarm:<id> of an existing swarm")
        return value

    def _retain(self, repo):
        """Keep the newest KEEP_REVISIONS revisions of a repo and every pinned one; the rest go, with their rows."""
        rows, dropped = self.db.all("SELECT sha, pinned FROM repo_maps WHERE repo = ? ORDER BY rowid DESC", (repo,)), []
        # new-hive R1a.1: the installation's own installed-release binding (installed SHA, committed completions, live
        # attempts) is a required reference; those revisions are never pruned. None on every other hive.
        newhive = getattr(self.hive, "newhive", None)
        protected = newhive.retained_revisions(repo) if newhive is not None else set()
        for row in rows[KEEP_REVISIONS:]:
            if row["pinned"] or row["sha"] in protected:
                continue
            for table in ("repo_maps", "repo_map_nodes", "repo_map_edges", "repo_map_atoms"):
                self.db.execute(f"DELETE FROM {table} WHERE repo = ? AND sha = ?", (repo, row["sha"]))
            dropped.append(row["sha"])
        return dropped

    # ---- who sees what ---------------------------------------------------------------------------------------------

    def owner_sees(self, principal, repo):
        """An owner-only map: the hive's owner, or a principal (person or agent:<id>) the owner granted this repo. Being
        an admin is not enough."""
        ownhive = getattr(self.hive, "ownhive", None)
        if ownhive is not None and principal == ownhive.owner():
            return True
        return self.db.one("SELECT 1 FROM repo_map_grants WHERE repo = ? AND principal = ?", (repo, principal)) is not None

    def grant(self, repo, principal, by):
        if not REPO.fullmatch(str(repo)) or not re.fullmatch(r"(user|agent):[A-Za-z0-9_.@-]{1,128}", str(principal)):
            raise self._err(400, "bad_request", "a repo name and a principal user:<id> or agent:<id>")
        self.db.execute("INSERT OR IGNORE INTO repo_map_grants (repo, principal, granted_by, granted_at) VALUES (?,?,?,?)",
                        (repo, principal, by, now()))
        return {"repo": repo, "principal": principal, "granted": True}

    def revoke_grant(self, repo, principal):
        self.db.execute("DELETE FROM repo_map_grants WHERE repo = ? AND principal = ?", (repo, principal))
        return {"repo": repo, "principal": principal, "granted": False}

    def _sees(self, caller, row):
        if row["visibility"] == "owner":
            return self.owner_sees(caller.principal, row["repo"])
        if caller.admin or row["visibility"] == "hive":
            return True
        match = SWARM.fullmatch(row["visibility"])
        if not match:
            return False
        swarm_id = match.group(1)
        if caller.principal.startswith("agent:"):
            return caller.swarm_id == swarm_id
        swarm = self.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,))
        if swarm is None:
            return False
        if swarm.get("owner") == caller.principal:
            return True
        try:
            return caller.principal in json.loads(swarm.get("shared_with") or "[]")
        except ValueError:
            return False

    def _revision(self, caller, repo, sha):
        row = None
        if isinstance(repo, str) and isinstance(sha, str):
            row = self.db.one("SELECT * FROM repo_maps WHERE repo = ? AND sha = ?", (repo, sha))
        if row is None or not self._sees(caller, row):
            raise self._err(404, "not_found", "no such repo map")
        return row

    @staticmethod
    def _revision_state(row, prefix=""):
        """The source map's own state and reason, verbatim, kept apart from the operation's state (a complete read of a
        partial map is still a read of a partial map)."""
        return {f"{prefix}revision_state": row["state"], f"{prefix}revision_reason": row["reason"]}

    @staticmethod
    def _summary(row):
        header = json.loads(row["header"])
        return {"repo": row["repo"], "sha": row["sha"], "schema": row["schema"], "state": row["state"], "reason": row["reason"],
                "extractor": header["extractor"], "generated_at": header["generated_at"], "receipt": header["receipt"],
                "counts": json.loads(row["counts"]), "digest": row["digest"], "visibility": row["visibility"],
                "pinned": bool(row["pinned"]), **RepoMaps._revision_state(row)}

    # ---- reads -----------------------------------------------------------------------------------------------------

    def list(self, caller):
        rows = self.db.all("SELECT * FROM repo_maps ORDER BY repo, rowid DESC")
        return [self._summary(r) for r in rows if self._sees(caller, r)]

    def header(self, caller, repo, sha):
        row = self._revision(caller, repo, sha)
        header = json.loads(row["header"])
        response = {**self._summary(row), "snapshot_digest": header["snapshot_digest"], "coverage": header["coverage"],
                    "space": self.space(repo, sha, on_demand=True)}
        if _size(response) > RESPONSE_CAP:   # COVERAGE_MAX keeps a loaded header under the cap; a guard, never an oversize
            raise self._err(413, "too_large", f"this header would be larger than {RESPONSE_CAP // 1024} KiB")
        return response

    def presets(self, caller, repo):
        if not any(self._sees(caller, r) for r in self.db.all("SELECT * FROM repo_maps WHERE repo = ?", (str(repo),))):
            raise self._err(404, "not_found", "no such repo map")
        out = []
        for name, spec in PRESETS.items():
            props = {k: {"type": "string", "maxLength": PARAM_MAX} for k in spec["params"]}
            schema = {"type": "object", "properties": props, "additionalProperties": False,
                      "required": [k for k, need in spec["params"].items() if need]}
            if spec["pick"]:
                schema["oneOf"] = [{"required": ["node_id"]}, {"required": ["path"]}]
            out.append({"preset": name, "description": spec["description"], "params": schema, "basis_note": spec["basis_note"]})
        return {"repo": repo, "presets": out, "limit": {"default": LIMIT_DEFAULT, "max": LIMIT_MAX}}

    def nodes(self, caller, repo, sha, kind=None, path_prefix=None, q=None, limit=None, cursor=None):
        revision = self._revision(caller, repo, sha)
        params = self._params({"kind": kind, "path_prefix": path_prefix, "q": q})
        if params.get("kind") and params["kind"] not in NODE_KINDS:
            raise self._err(400, "bad_request", f"kind is one of {', '.join(NODE_KINDS)}")
        limit = self._limit(limit)
        offset = self._cursor_read(cursor, caller, repo, sha, "nodes", params)
        clock = _Deadline()
        units = [("node", r["id"]) for r in self._node_rows(repo, sha, params, clock)]
        return self._page(caller, repo, sha, "nodes", params, offset, limit, units, clock,
                          {"repo": repo, "sha": sha, **self._revision_state(revision)})

    def node(self, caller, repo, sha, node_id, limit=None, cursor=None):
        revision = self._revision(caller, repo, sha)
        row = self.db.one("SELECT body FROM repo_map_nodes WHERE repo = ? AND sha = ? AND id = ?", (repo, sha, str(node_id)))
        if row is None:
            raise self._err(404, "not_found", "no such node in this map")
        limit = self._limit(limit)
        params = {"node_id": str(node_id)}
        offset = self._cursor_read(cursor, caller, repo, sha, "node", params)
        clock = _Deadline()
        edges = self._edges_at(repo, sha, None, "both", [str(node_id)], clock)
        return self._page(caller, repo, sha, "node", params, offset, limit, [("edge", e["id"]) for e in edges], clock,
                          {"repo": repo, "sha": sha, "node": json.loads(row["body"]), **self._revision_state(revision)}, skip={node_id})

    def query(self, caller, repo, sha, data):
        if not isinstance(data, dict) or set(data) - {"preset", "params", "limit", "cursor"}:
            raise self._err(400, "bad_request", "a query is {preset, params, limit?, cursor?}")
        revision = self._revision(caller, repo, sha)
        preset = data.get("preset")
        if not isinstance(preset, str) or preset not in PRESETS:
            raise self._err(400, "unknown_preset", f"preset is one of {', '.join(PRESETS)}")
        spec, raw = PRESETS[preset], data.get("params") or {}
        if not isinstance(raw, dict):
            raise self._err(400, "bad_request", "params is an object")
        unknown = sorted(set(raw) - set(spec["params"]))
        missing = [k for k, need in spec["params"].items() if need and not raw.get(k)]
        if unknown or missing:
            raise self._err(400, "bad_request", f"{preset} takes {', '.join(spec['params'])}"
                                               + (f"; unknown {', '.join(unknown)}" if unknown else "")
                                               + (f"; missing {', '.join(missing)}" if missing else ""))
        params = self._params(raw)
        if spec["pick"] and len({"node_id", "path"} & set(params)) != 1:
            raise self._err(400, "bad_request", f"{preset} chooses nodes by exactly one of node_id or path")
        limit = self._limit(data.get("limit"))
        if preset == "drift":
            return self.drift(caller, repo, params["from"], sha, limit, data.get("cursor"))
        offset = self._cursor_read(data.get("cursor"), caller, repo, sha, preset, params)
        clock = _Deadline()   # one 2 s bound across fetching, traversal and the page itself
        if preset == "source-search":
            units = [("node", r["id"]) for r in self._node_rows(repo, sha, params, clock)]
        elif preset == "potential-dependents":
            units = self._dependents(repo, sha, self._pick(repo, sha, params, clock), self._depth(params), clock)
        else:
            kinds, direction = _EDGE_PRESETS[preset]
            edges = self._edges_at(repo, sha, kinds, direction, sorted(self._pick(repo, sha, params, clock)), clock)
            units = [("edge", e["id"]) for e in edges]
        return self._page(caller, repo, sha, preset, params, offset, limit, units, clock,
                          {"repo": repo, "sha": sha, "preset": preset, "params": params, "basis_note": spec["basis_note"],
                           **self._revision_state(revision)})

    def drift(self, caller, repo, from_sha, to_sha, limit=None, cursor=None):
        before_row, after_row = self._revision(caller, repo, from_sha), self._revision(caller, repo, to_sha)
        limit = self._limit(limit)
        params = {"from": from_sha, "to": to_sha}
        # The drift cursor's revision slot is "<from>..<to>"; it can never equal a real revision's sha because a valid
        # sha is lowercase hex only (SHA), so ".." never appears in one. Both shas here passed SHA when they were loaded.
        assert SHA.fullmatch(from_sha) and SHA.fullmatch(to_sha), "drift cursors rely on shas never containing '..'"
        offset = self._cursor_read(cursor, caller, repo, f"{from_sha}..{to_sha}", "drift", params)
        clock = _Deadline()
        before = self._identities(repo, from_sha, clock)
        after = self._identities(repo, to_sha, clock)
        entries = drift_entries(before, after, clock) if not clock.hit else []
        return self._page(caller, repo, f"{from_sha}..{to_sha}", "drift", params, offset, limit, [("drift", e) for e in entries], clock,
                          {"repo": repo, "from": from_sha, "to": to_sha, "basis_note": PRESETS["drift"]["basis_note"],
                           **self._revision_state(after_row), **self._revision_state(before_row, "from_")}, group=True)

    # ---- helpers ---------------------------------------------------------------------------------------------------

    def _params(self, raw):
        params = {}
        for key, value in raw.items():
            if value is None or value == "":
                continue
            if not isinstance(value, str) or len(value) > PARAM_MAX or CONTROL.search(value):
                raise self._err(400, "bad_request", f"{key} is a string of at most {PARAM_MAX} characters")
            params[key] = value
        return params

    def _limit(self, value):
        if value is None or value == "":
            return LIMIT_DEFAULT
        try:
            limit = int(value)
        except (TypeError, ValueError):
            raise self._err(400, "bad_request", "limit is an integer") from None
        if isinstance(value, (bool, float)) or not 1 <= limit <= LIMIT_MAX:
            raise self._err(400, "bad_request", f"limit is 1 to {LIMIT_MAX}")
        return limit

    def _depth(self, params):
        if "max_depth" not in params:
            return None
        try:
            depth = int(params["max_depth"])
        except ValueError:
            depth = 0
        if not 1 <= depth <= 1000:
            raise self._err(400, "bad_request", "max_depth is a whole number from 1 (direct links only) to 1000")
        return depth

    def _dependents(self, repo, sha, chosen, max_depth, clock):
        """Code's conservative import impact: the transitive closure over incoming imports and calls-expression edges,
        breadth first and cycle-safe. Each dependent comes once, at its shortest distance, with the edge that reached it.
        Units carry ids (bodies are read for the page only); the clock is checked while the edge index is read and through
        the traversal, and past it the dependents found so far come back (the page then says partial)."""
        incoming = {}
        for edge in self._edges_of(repo, sha, ("imports", "calls-expression"), clock):
            incoming.setdefault(edge["dst"], []).append(edge)
        found, frontier, distance = {}, [] if clock.hit else list(chosen), 0
        seen = set(chosen)
        while frontier and (max_depth is None or distance < max_depth) and not clock.late():
            distance += 1
            following = []
            # one layer at a time, its edges in map order, so each dependent's distance and reaching edge are deterministic
            for edge in sorted((e for t in frontier for e in incoming.get(t, ())), key=lambda e: e["seq"]):
                if clock.late():
                    break
                if edge["src"] not in seen:
                    seen.add(edge["src"])
                    found[edge["src"]] = (distance, edge["id"])
                    following.append(edge["src"])
            frontier = following
        return [("dependent", (node_id, d, edge_id)) for node_id, (d, edge_id) in found.items()]

    def _scan(self, sql, args, clock, batch=1000):
        """Rows of ``sql`` (which selects seq and filters one revision) in seq order, read in batches with the clock checked
        before each; past the deadline the rows read so far come back."""
        rows, last = [], -1
        while not clock.late():
            chunk = self.db.all(sql + " AND seq > ? ORDER BY seq LIMIT ?", (*args, last, batch))
            rows.extend(chunk)
            if len(chunk) < batch:
                break
            last = chunk[-1]["seq"]
        return rows

    def _node_rows(self, repo, sha, params, clock):
        sql, args = "SELECT seq, id FROM repo_map_nodes WHERE repo = ? AND sha = ?", [repo, sha]
        if params.get("kind"):
            sql, args = sql + " AND kind = ?", args + [params["kind"]]
        if params.get("path_prefix"):
            sql, args = sql + " AND path IS NOT NULL AND substr(path, 1, ?) = ?", args + [len(params["path_prefix"]), params["path_prefix"]]
        if params.get("q"):
            sql, args = sql + " AND instr(search, ?) > 0", args + [params["q"].lower()]
        return self._scan(sql, args, clock)

    def _pick(self, repo, sha, params, clock):
        if "node_id" in params:
            return {params["node_id"]}
        return {r["id"] for r in self._scan("SELECT seq, id FROM repo_map_nodes WHERE repo = ? AND sha = ? AND path = ?",
                                            [repo, sha, params["path"]], clock)}

    def _edges_of(self, repo, sha, kinds, clock):
        """Every edge of these kinds without its body: seq, id, src, dst (bodies are read for the page only)."""
        marks = ",".join("?" * len(kinds))
        return self._scan(f"SELECT seq, id, src, dst FROM repo_map_edges WHERE repo = ? AND sha = ? AND kind IN ({marks})",
                          [repo, sha, *kinds], clock)

    def _edges_at(self, repo, sha, kinds, direction, chosen, clock):
        """Edges (seq, id, src, dst) of these kinds (None: any) leaving (out), entering (in) or touching (both) the chosen
        nodes, in map order, through the src/dst indexes; the clock is checked per batch of chosen nodes."""
        kind_sql = f" AND kind IN ({','.join('?' * len(kinds))})" if kinds else ""
        found = {}
        ends = {"out": ("src",), "in": ("dst",), "both": ("src", "dst")}[direction]
        for start in range(0, len(chosen), 500):
            if clock.late():
                break
            chunk = chosen[start:start + 500]
            marks = ",".join("?" * len(chunk))
            for end in ends:
                for row in self.db.all(f"SELECT seq, id, src, dst FROM repo_map_edges WHERE repo = ? AND sha = ?{kind_sql} "
                                       f"AND {end} IN ({marks})", (repo, sha, *(kinds or ()), *chunk)):
                    found[row["seq"]] = row
        return [found[k] for k in sorted(found)]

    def _body(self, table, repo, sha, item_id):
        row = self.db.one(f"SELECT body FROM {table} WHERE repo = ? AND sha = ? AND id = ?", (repo, sha, item_id))
        return json.loads(row["body"]) if row else None

    def _hydrate(self, repo, sha, kind, value, seen):
        """(items for the page's lists, byte cost) of one unit, its bodies read now: a node; an edge with the nodes it
        names that this page has not carried yet (an unresolved target name has no node); a dependent (its node with its
        distance, and the edge that reached it); a drift entry as it is."""
        if kind == "node":
            node = self._body("repo_map_nodes", repo, sha, value)
            return {"nodes": [node]}, _size(node) + 1
        if kind == "edge":
            edge = self._body("repo_map_edges", repo, sha, value)
            out, cost = {"edges": [edge], "nodes": []}, _size(edge) + 1
            for end in dict.fromkeys((edge["from"], edge["to"])):
                if end not in seen:
                    node = self._body("repo_map_nodes", repo, sha, end)
                    if node is not None:
                        out["nodes"].append(node)
                        cost += _size(node) + 1
            return out, cost
        if kind == "dependent":
            node_id, distance, edge_id = value
            node = dict(self._body("repo_map_nodes", repo, sha, node_id), distance=distance)
            edge = self._body("repo_map_edges", repo, sha, edge_id)
            return {"nodes": [node], "edges": [edge]}, _size(node) + _size(edge) + 2
        return {"drift": [value]}, _size(value) + 1

    def _identities(self, repo, sha, clock):
        out = {}
        for r in self._scan("SELECT seq, body FROM repo_map_nodes WHERE repo = ? AND sha = ?", [repo, sha], clock):
            node = json.loads(r["body"])
            out[node["id"]] = {"id": node["id"], "kind": node["kind"], "label": node["label"], "source_digest": node["source_digest"]}
        return out

    def _page(self, caller, repo, sha, preset, params, offset, limit, units, clock, base, skip=(), group=False):
        """The whole response: ``base`` (the envelope's own fields, the detail node included) plus one page of result units
        under the item limit, the clock and RESPONSE_CAP, measured in the bytes JSONResponse sends (UTF-8, ensure_ascii
        False, compact separators: ``_size``). The envelope's worst case (a cursor at the end, state partial) is reserved
        first, then each unit costs its bytes plus its list commas, its bodies read only now. A page stops before the unit
        that would not fit, or once the clock has run out after at least one unit, with truncated and a cursor at the next
        unit. A first unit that cannot fit even on an empty page is refused (413 too_large): it is never cut, its refs are
        never dropped, and no cursor that does not advance is ever issued. state is partial (reason time_bound) whenever the
        clock ran out, in the fetch or here."""
        skeleton = {"truncated": True, "next_cursor": self._cursor_make(caller, repo, sha, preset, params, len(units)),
                    "state": "partial", "reason": "time_bound",
                    **({c: [] for c in ("added", "removed", "changed", "moved")} if group else {"nodes": [], "edges": []})}
        budget = RESPONSE_CAP - _size({**base, **skeleton})
        lists, seen, used, i = {"nodes": [], "edges": [], "drift": []}, set(skip), 0, offset
        while i < len(units) and i - offset < limit and not (i > offset and clock.late()):
            kind, value = units[i]
            items, cost = self._hydrate(repo, sha, kind, value, seen)
            if used + cost > budget:
                if i == offset:
                    raise self._err(413, "too_large", f"one result ({kind}) is larger than a {RESPONSE_CAP // 1024} KiB response; "
                                                      "it cannot be sent whole")
                break
            used += cost
            for name, values in items.items():
                lists[name].extend(values)
            seen.update(n["id"] for n in items.get("nodes", ()))
            i += 1
        more = i < len(units)
        out = {"truncated": more, "next_cursor": self._cursor_make(caller, repo, sha, preset, params, i) if more else None,
               "state": "partial" if clock.hit else "ready", "reason": "time_bound" if clock.hit else None}
        if group:
            for change in ("added", "removed", "changed", "moved"):
                out[change] = [{k: v for k, v in e.items() if k != "change"} for e in lists["drift"] if e["change"] == change]
        else:
            out.update(nodes=lists["nodes"], edges=lists["edges"])
        response = {**base, **out}
        if _size(response) > RESPONSE_CAP:   # cannot happen by the accounting above; a guard, never a silent oversize
            raise self._err(413, "too_large", f"this response would be larger than {RESPONSE_CAP // 1024} KiB")
        return response

    # ---- cursors: opaque, HMAC'd, bound to principal + repo + sha + preset + params; one hour -------------------------

    def _cursor_make(self, caller, repo, sha, preset, params, offset):
        body = {"v": 1, "p": caller.principal, "r": repo, "s": sha, "q": preset,
                "h": hashlib.sha256(_canon(params).encode()).hexdigest(), "o": offset, "t": int(time.time())}
        raw = base64.urlsafe_b64encode(_canon(body).encode()).decode().rstrip("=")
        return raw + "." + hmac.new(self._key, raw.encode(), "sha256").hexdigest()

    def _cursor_read(self, token, caller, repo, sha, preset, params):
        if token is None or token == "":
            return 0
        bad = self._err(400, "invalid_cursor", "that cursor does not match this query")
        if not isinstance(token, str) or len(token) > 2000 or token.count(".") != 1:
            raise bad
        raw, tag = token.split(".")
        if not hmac.compare_digest(tag.encode(), hmac.new(self._key, raw.encode(), "sha256").hexdigest().encode()):
            raise bad
        try:
            body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        except (ValueError, TypeError):
            raise bad from None
        expected = {"v": 1, "p": caller.principal, "r": repo, "s": sha, "q": preset,
                    "h": hashlib.sha256(_canon(params).encode()).hexdigest()}
        if (not isinstance(body, dict) or any(body.get(k) != v for k, v in expected.items())
                or type(body.get("o")) is not int or body["o"] < 0 or type(body.get("t")) is not int):
            raise bad
        if time.time() - body["t"] > CURSOR_SECONDS:
            raise self._err(410, "cursor_expired", "that cursor is more than an hour old; start the query again")
        return body["o"]


def drift_entries(before, after, clock=None):
    """Drift entries. Node identity is the map's logical id. A node counts as moved only with explicit evidence:
    one removed and one added node of the same kind whose source_digest is unique to each of them within that kind in
    both revisions. Identical content in two places is ambiguous and stays added and removed (Code's interface). Past the
    clock's deadline the entries found so far come back (moves are then not looked for) and the clock says hit."""
    def late():
        return clock is not None and clock.late()

    added = [after[k] for k in after if k not in before]
    removed = [before[k] for k in before if k not in after]
    changed, moved, gone, came, timed_out = [], [], set(), set(), False
    for key in before:
        if late():
            timed_out = True
            break
        if key in after:
            old, new = before[key], after[key]
            what = [f for f in ("kind", "label", "source_digest") if old[f] != new[f]]
            if what:
                changed.append({"change": "changed", "id": key, "from": old, "to": new, "basis": " and ".join(what) + " changed"})

    def unique(nodes, node):
        return sum(1 for n in nodes.values() if n["kind"] == node["kind"] and n["source_digest"] == node["source_digest"]) == 1

    for old in ([] if timed_out else removed):
        if late():
            timed_out = True
            break
        if not old["source_digest"] or not unique(before, old):
            continue
        matches = [n for n in added if n["kind"] == old["kind"] and n["source_digest"] == old["source_digest"]]
        if len(matches) == 1 and unique(after, matches[0]):
            moved.append({"change": "moved", "from": old, "to": matches[0], "basis": "unique source_digest match"})
            gone.add(old["id"])
            came.add(matches[0]["id"])
    entries = ([{"change": "added", "node": n, "basis": "id absent in from"} for n in added if n["id"] not in came]
               + [{"change": "removed", "node": n, "basis": "id absent in to"} for n in removed if n["id"] not in gone]
               + changed + moved)
    return entries


# ---- routes --------------------------------------------------------------------------------------------------------------

def install_routes(app, hive, operator, admin, viewer):
    """Thin route hooks; every rule lives in RepoMaps. Members are people (session) or minds (their own token)."""
    from .mcp import _canon as command
    maps = hive.repo_maps

    def member(request: Request):
        auth = request.headers.get("authorization") or ""
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        agent = hive.authenticate_agent(token, surface="rest") if token else None
        if agent is not None:
            hive.policy.enforce(agent, "repo-query", command("repo-query", request.url.path))
            return Caller(f"agent:{agent['id']}", swarm_id=agent.get("swarm_id"), agent=agent)
        who = viewer(operator(request))
        return Caller(who.principal, admin=who.admin)

    async def json_body(request: Request, limit):
        chunks, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > limit:
                raise hive.error(413, "too_large", f"this body is limited to {limit // 1048576} MiB")
            chunks.append(chunk)
        try:
            return json.loads(b"".join(chunks) or b"null")
        except ValueError:
            raise hive.error(400, "bad_request", "expected a JSON body") from None

    @app.get("/api/repo-maps")
    async def repo_maps_list(request: Request):
        return maps.list(member(request))

    @app.get("/api/repo-maps/{repo}/presets")
    async def repo_map_presets(repo: str, request: Request):
        return maps.presets(member(request), repo)

    @app.get("/api/repo-maps/{repo}/drift")
    async def repo_map_drift(repo: str, request: Request, limit: str | None = None, cursor: str | None = None):
        q = request.query_params
        if not q.get("from") or not q.get("to"):
            raise hive.error(400, "bad_request", "drift needs from and to")
        return maps.drift(member(request), repo, q["from"], q["to"], limit, cursor)

    @app.get("/api/repo-maps/{repo}/{sha}")
    async def repo_map_header(repo: str, sha: str, request: Request):
        return maps.header(member(request), repo, sha)

    @app.get("/api/repo-maps/{repo}/{sha}/nodes")
    async def repo_map_nodes(repo: str, sha: str, request: Request, kind: str | None = None, path_prefix: str | None = None,
                             q: str | None = None, limit: str | None = None, cursor: str | None = None):
        return maps.nodes(member(request), repo, sha, kind, path_prefix, q, limit, cursor)

    @app.get("/api/repo-maps/{repo}/{sha}/nodes/{node_id:path}")
    async def repo_map_node(repo: str, sha: str, node_id: str, request: Request, limit: str | None = None,
                            cursor: str | None = None):
        return maps.node(member(request), repo, sha, node_id, limit, cursor)

    @app.post("/api/repo-maps/{repo}/{sha}/query")
    async def repo_map_query(repo: str, sha: str, request: Request):
        caller = member(request)
        data = await json_body(request, 64 * 1024)
        return maps.query(caller, repo, sha, data)

    def owner_only(request):
        who = viewer(operator(request))
        if who.principal != hive.ownhive.owner():
            raise hive.error(403, "owner_only", "only the hive's owner grants an owner-only map")
        return who

    @app.post("/api/repo-maps/{repo}/grants")
    async def repo_map_grant(repo: str, request: Request):
        who = owner_only(request)
        data = await json_body(request, 4096)
        return maps.grant(repo, str((data or {}).get("principal") or ""), who.principal)

    @app.delete("/api/repo-maps/{repo}/grants/{principal}")
    async def repo_map_revoke(repo: str, principal: str, request: Request):
        owner_only(request)
        return maps.revoke_grant(repo, principal)

    @app.post("/api/admin/repo-maps")
    async def repo_map_load(request: Request, visibility: str | None = None, pinned: str | None = None):
        session = admin(request)
        envelope = await json_body(request, MAX_BODY)
        if session.get("kind") == "sso-bootstrap":   # new-hive R1a (newhive.py): only the attempt's exact installed map
            hive.newhive.check_load(session, envelope)
        return await run_in_threadpool(maps.load, envelope, session.get("principal") or "user:operator", visibility or None,
                                       None if pinned in (None, "") else pinned in ("1", "true"))
