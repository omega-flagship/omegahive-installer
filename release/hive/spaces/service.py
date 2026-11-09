"""Shared swarm spaces: lib_hive.metta running in an embedded PeTTa.

All interpreter calls run on one worker thread.  Mutations are appended to an
operations log (``spaces.log.jsonl``) and replayed on start, so the commons
survive restarts; PeTTa itself has no persistence.

Swarm ``s`` owns ``&commons_s`` and ``&vocab_s``; grants live in ``&hive_acl``.
Agent input is validated by ``sexpr`` before it is spliced into MeTTa.

Repository map revisions are read-only spaces ``repo:<repo>@<sha>`` (handle ``&repo_<hash>``, see ``repo_space``). Only
the hive's repo-map loader (core/repomap.py) mounts or unmounts them, from atoms it encoded itself; no agent input, publish
or op-log entry ever writes one. They are not op-logged: the hive database holds the loaded atoms and the loader mounts them
again after a restart.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import queue
import sys
import threading
from concurrent.futures import Future

from . import sexpr

LIB_HIVE = pathlib.Path(__file__).resolve().with_name("lib_hive.metta")
REPO_CHUNK = 2000   # atoms per interpreter job when mounting a repo space, so other spaces' calls interleave
REPO_JOB_SECONDS = 120        # one repo job (a chunk, a clear, a count)
REPO_SETTLE_SECONDS = 600     # cleanup after a failure: it queues behind any job that timed out, which still runs
OUTCOMES = {"adopted", "revised", "chosen", "kept", "duplicate", "quarantined", "denied"}


class SpaceError(RuntimeError):
    pass


class RepoMountIncomplete(SpaceError):
    """A repo space mount failed and its cleanup did not finish (it failed, or is still queued behind a job that timed out):
    what the space holds is unknown until a later mount or unmount settles it."""


def _stamp_atoms(stamp):
    """["ev:a_1:3", ...] -> "((ev a_1 3) ...)" with validated parts."""
    parts = []
    for item in stamp:
        kind, agent, number = str(item).split(":")
        if kind != "ev" or not number.isdigit():
            raise sexpr.SexprError(f"bad evidence id {item!r}")
        parts.append(f"(ev {sexpr.safe_symbol(agent)} {int(number)})")
    return "(" + " ".join(sorted(parts)) + ")"


def _stamp_json(value):
    return [f"ev:{e[1]}:{e[2]}" for e in (value or []) if isinstance(e, list) and len(e) == 3]


def _tv(value):
    if isinstance(value, list) and len(value) == 3 and value[0] == "stv":
        return {"f": round(float(value[1]), 6), "c": round(float(value[2]), 6)}
    raise SpaceError(f"not a truth value: {value!r}")


class _Interpreter:
    """The process-wide PeTTa interpreter and the one thread allowed to use it.

    janus ties the interpreter to the thread that first calls it; a second
    thread calling in deadlocks, so every service shares this worker.
    """

    _instance = None
    _lock = threading.Lock()
    _startup_path_lock = threading.Lock()  # Short cooperative path edits only.

    @classmethod
    def get(cls, petta_path):
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(petta_path)
            return cls._instance

    def __init__(self, petta_path):
        self.petta_path = petta_path
        self._jobs: queue.Queue = queue.Queue()
        self._ready = threading.Event()
        self._error = None
        self._path_cleanup_state = "NOT_ATTEMPTED"
        threading.Thread(target=self._worker, name="hive-petta", daemon=True).start()
        self._ready.wait(60)
        if self._error:
            suffix = ("" if self._path_cleanup_state == "REMOVED" else
                      f" (path cleanup: {self._path_cleanup_state})")
            raise SpaceError(f"PeTTa failed to start: {self._error}{suffix}")

    def _remove_failed_startup_path(self, paths, entry):
        if paths is None or entry is None:
            return "NOT_INSERTED"
        try:
            with _Interpreter._startup_path_lock:
                if sys.path is not paths:
                    return "REPLACED"
                matches = [i for i, item in enumerate(paths) if item is entry]
                if len(matches) != 1:
                    return "MISSING" if not matches else "AMBIGUOUS"
                del paths[matches[0]]  # Cooperative indexed deletion, not atomic rollback.
                return "UNREMOVED" if any(item is entry for item in paths) else "REMOVED"
        except BaseException:
            return "UNKNOWN"  # Preserve the original startup error; no retry.

    def _worker(self):
        paths = entry = None
        try:
            entry = str(pathlib.Path(self.petta_path) / "python")
            paths = sys.path
            with _Interpreter._startup_path_lock:
                paths.insert(0, entry)
            os.environ.setdefault("LANG", "C.UTF-8")
            from petta import PeTTa

            metta = PeTTa(verbose=False, petta_path=self.petta_path)
            metta.load_metta_file(str(LIB_HIVE))
        except Exception as exc:  # pragma: no cover - environment failure
            self._error = exc
            self._path_cleanup_state = self._remove_failed_startup_path(paths, entry)
            self._ready.set()
            return
        self._ready.set()
        while True:
            code, future = self._jobs.get()
            try:
                future.set_result(metta.process_metta_string(code))
            except Exception as exc:
                future.set_exception(exc)

    def run(self, code, timeout=30):
        future: Future = Future()
        self._jobs.put((code, future))
        return future.result(timeout)


class SpaceService:
    """One per process: spaces are global to the interpreter."""

    def __init__(self, data_dir, petta_path=None):
        self.data_dir = pathlib.Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_path = self.data_dir / "spaces.log.jsonl"
        self.petta_path = petta_path or os.environ.get("PETTA_PATH") or str(pathlib.Path.home() / "PeTTa")
        self._interp = _Interpreter.get(self.petta_path)
        self._replay()

    def run(self, code, timeout=30):
        return self._interp.run(code, timeout)

    def run_one(self, code):
        results = self.run(code)
        return sexpr.read_result(results[-1]) if results else None

    # ---- persistence -----------------------------------------------------------------

    def _log(self, op, **fields):
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(dict(op=op, **fields)) + "\n")

    def _replay(self):
        if not self.log_path.exists():
            return
        for line in self.log_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            op = entry.pop("op")
            getattr(self, f"_apply_{op}")(**entry)

    # ---- grants and vocabulary --------------------------------------------------------

    def _apply_grant(self, agent_id, swarm_id):
        agent, swarm = sexpr.safe_symbol(agent_id), sexpr.safe_symbol(swarm_id)
        self.run(f"!(add-atom &hive_acl (Grant {agent} &commons_{swarm} $stmt publish))")

    def _apply_revoke(self, agent_id, swarm_id):
        agent, swarm = sexpr.safe_symbol(agent_id), sexpr.safe_symbol(swarm_id)
        self.run(f"!(remove-atom &hive_acl (Grant {agent} &commons_{swarm} $stmt publish))")

    def _apply_vocab(self, swarm_id, term, agent_id="hive"):
        swarm, sym, agent = sexpr.safe_symbol(swarm_id), sexpr.safe_symbol(term), sexpr.safe_symbol(agent_id)
        self.run(f"!(hive-vocab-add! &vocab_{swarm} {sym} {agent})")

    def grant(self, agent_id, swarm_id):
        if self.is_member(agent_id, swarm_id):
            return
        self._apply_grant(agent_id, swarm_id)
        self._log("grant", agent_id=agent_id, swarm_id=swarm_id)

    def revoke(self, agent_id, swarm_id):
        self._apply_revoke(agent_id, swarm_id)
        self._log("revoke", agent_id=agent_id, swarm_id=swarm_id)

    def is_member(self, agent_id, swarm_id):
        agent, swarm = sexpr.safe_symbol(agent_id), sexpr.safe_symbol(swarm_id)
        found = self.run(f"!(collapse (match &hive_acl (Grant {agent} &commons_{swarm} $s publish) True))")
        return bool(found) and found[-1] not in ("()", "")

    def add_vocab(self, swarm_id, terms, agent_id="hive"):
        known = set(self.vocab(swarm_id))
        for term in terms:
            term = sexpr.safe_symbol(term)
            if term in known:
                continue
            self._apply_vocab(swarm_id, term, agent_id)
            self._log("vocab", swarm_id=swarm_id, term=term, agent_id=agent_id)
            known.add(term)
        return self.vocab(swarm_id)

    def vocab(self, swarm_id):
        swarm = sexpr.safe_symbol(swarm_id)
        value = self.run_one(f"!(collapse (match &vocab_{swarm} (Term $t) $t))")
        return sorted(str(v) for v in (value or []))

    @staticmethod
    def statement_text(statement):
        return sexpr.safe_statement(statement)

    def statement_symbols(self, statement):
        structural = {"-->", "<->", "==>", "<=>", "&&", "||", "--", "stv"}
        out = []

        def walk(node):
            if isinstance(node, list):
                for item in node:
                    walk(item)
            elif isinstance(node, str) and not isinstance(node, sexpr.Str) and node not in structural:
                out.append(node)

        walk(sexpr.parse(statement))
        return sorted(set(out))

    # ---- publishing ---------------------------------------------------------------------

    def _apply_publish(self, swarm_id, agent_id, statement, f, c, stamp):
        swarm, agent = sexpr.safe_symbol(swarm_id), sexpr.safe_symbol(agent_id)
        stmt = sexpr.safe_statement(statement)
        tv = f"(stv {float(f)!r} {float(c)!r})"
        code = (
            f"!(hive-publish! &commons_{swarm} &vocab_{swarm} &hive_acl {agent} "
            f"{stmt} {tv} {_stamp_atoms(stamp)})"
        )
        return self.run_one(code)

    def publish(self, swarm_id, agent_id, statement, f, c, stamp, open_vocab=True):
        statement = sexpr.safe_statement(statement)
        f, c = float(f), float(c)
        if not (0.0 <= f <= 1.0 and 0.0 < c < 1.0):
            raise SpaceError("need 0 <= f <= 1 and 0 < c < 1")
        if open_vocab and self.is_member(agent_id, swarm_id):
            self.add_vocab(swarm_id, self.statement_symbols(statement), agent_id)
        result = self._apply_publish(swarm_id, agent_id, statement, f, c, stamp)
        outcome = result if isinstance(result, str) else (result[0] if result else "error")
        if outcome not in OUTCOMES:
            raise SpaceError(f"unexpected publish result: {result!r}")
        if outcome not in ("denied", "quarantined", "duplicate"):
            self._log("publish", swarm_id=swarm_id, agent_id=agent_id, statement=statement,
                      f=f, c=c, stamp=list(stamp))
        detail = {"outcome": outcome, "statement": statement}
        if outcome == "quarantined":
            detail["unmapped"] = [str(s) for s in result[1]]
        return detail

    # ---- reading ---------------------------------------------------------------------------

    def beliefs(self, swarm_id):
        swarm = sexpr.safe_symbol(swarm_id)
        value = self.run_one(f"!(collapse (match &commons_{swarm} (Current $s $t $st) ($s $t $st)))")
        out = []
        for stmt, tv, stamp in value or []:
            out.append({"statement": sexpr.render(stmt), "tv": _tv(tv), "stamp": _stamp_json(stamp)})
        return out

    def belief(self, swarm_id, statement):
        swarm = sexpr.safe_symbol(swarm_id)
        stmt = sexpr.safe_statement(statement)
        cur = self.run_one(f"!(collapse (match &commons_{swarm} (Current {stmt} $t $st) ($t $st)))")
        if not cur:
            return None
        tv, stamp = cur[0]
        sources = self.run_one(f"!(hive-sources &commons_{swarm} {stmt})") or []
        chosen = self.run_one(f"!(collapse (match &commons_{swarm} (Chosen {stmt} $k $r) ($k $r)))") or []
        return {
            "statement": stmt,
            "tv": _tv(tv),
            "stamp": _stamp_json(stamp),
            "sources": [str(s) for s in sources],
            "choices": [{"kept": _stamp_json(k), "rejected": _stamp_json(r)} for k, r in chosen],
        }

    def query(self, swarm_ids, pattern):
        pat = sexpr.safe_pattern(pattern)
        spaces = " ".join(f"&commons_{sexpr.safe_symbol(s)}" for s in swarm_ids)
        value = self.run_one(f"!(hive-view ({spaces}) {pat})") or []
        return [sexpr.render(v) for v in value]

    # ---- read-only repository map spaces (written only by core/repomap.py) ---------------------------------------------

    @staticmethod
    def repo_space(repo, sha):
        """(logical id, MeTTa handle) of a repo map revision's space. The handle is a hash, so no repo name or sha can
        spell another space's handle (&commons_*, &vocab_*, &hive_acl)."""
        space_id = f"repo:{repo}@{sha}"
        return space_id, "&repo_" + hashlib.sha256(space_id.encode()).hexdigest()[:24]

    # Every repo space operation runs under one process-wide reentrant lock (the interpreter is process-wide too), so a
    # revision's clear / add / count sequence is never interleaved with another repo operation, from this service or
    # another instance. Commons operations do not take it: their jobs queue on the interpreter between a mount's chunks.
    # The lock is mechanical sequencing only, not a scheduler or a grant; RepoMaps holds it around its state changes.
    repo_lock = threading.RLock()

    def mount_repo(self, repo, sha, atoms, progress=None):
        """Replace the space's content with these atoms (the loader's own encoding). Every atom is re-parsed, without
        variables, before anything is cleared. progress(added, total), if given, is called after each chunk. On any failure the space is cleared again before the error propagates; the
        clear queues behind every earlier job, including one whose wait timed out (a timed-out job is not cancelled, it
        still runs), and a clear only counts once a typed count after it reads exactly 0 (``_repo_clear``). If that clear fails or does not finish in
        REPO_SETTLE_SECONDS, RepoMountIncomplete is raised. Returns the number of atoms the space holds (= len(atoms))."""
        _, handle = self.repo_space(repo, sha)
        safe = [sexpr.render(sexpr.parse(a, allow_vars=False)) for a in atoms]
        with self.repo_lock:
            try:
                self._repo_clear(handle, REPO_JOB_SECONDS)
                for start in range(0, len(safe), REPO_CHUNK):
                    self.run("\n".join(f"!(add-atom {handle} {a})" for a in safe[start:start + REPO_CHUNK]), timeout=REPO_JOB_SECONDS)
                    if progress:
                        progress(min(start + REPO_CHUNK, len(safe)), len(safe))
                held = self._repo_count(handle)
                if held != len(safe):
                    raise SpaceError(f"repo space holds {held} atoms, not {len(safe)}")
                return held
            except Exception:
                try:
                    self._repo_clear(handle, REPO_SETTLE_SECONDS)
                except Exception as cleanup:
                    raise RepoMountIncomplete(f"repo space {repo}@{sha}: mount failed and cleanup did not finish") from cleanup
                raise

    def unmount_repo(self, repo, sha):
        """Clear the space. Raises RepoMountIncomplete if the clear fails or does not finish in REPO_SETTLE_SECONDS."""
        _, handle = self.repo_space(repo, sha)
        with self.repo_lock:
            try:
                self._repo_clear(handle, REPO_SETTLE_SECONDS)
            except Exception as exc:
                raise RepoMountIncomplete(f"repo space {repo}@{sha}: clear did not finish") from exc

    def repo_count(self, repo, sha):
        _, handle = self.repo_space(repo, sha)
        with self.repo_lock:
            return self._repo_count(handle)

    def _repo_clear(self, handle, timeout):
        """Remove every atom, then prove it: the clear must answer a typed count and a fresh count must be exactly 0. A
        missing or malformed reply never counts as a finished clear."""
        self._repo_int(self.run(f"!(length (collapse (match {handle} $atom (remove-atom {handle} $atom))))", timeout=timeout), "clear")
        left = self._repo_int(self.run(f"!(length (collapse (match {handle} $atom $atom)))", timeout=timeout), "count after clear")
        if left != 0:
            raise SpaceError(f"repo space still holds {left} atoms after a clear")

    def _repo_count(self, handle):
        return self._repo_int(self.run(f"!(length (collapse (match {handle} $atom $atom)))", timeout=REPO_JOB_SECONDS), "count")

    @staticmethod
    def _repo_int(results, what):
        """The interpreter's answer to a length query as a non-negative int; anything else (no reply, an empty list, a
        fraction, a quoted number, a negative) is refused, never read as 0."""
        try:
            value = sexpr.read_result(results[-1]) if results else None
        except (IndexError, ValueError):
            value = None
        if type(value) is not int or value < 0:
            raise SpaceError(f"repo space {what} did not answer a non-negative integer")
        return value

    def repo_match(self, repo, sha, pattern):
        """Atoms of a repo space matching a pattern (read only; for the loader's own checks; not a member query route)."""
        _, handle = self.repo_space(repo, sha)
        pat = sexpr.safe_pattern(pattern)
        with self.repo_lock:
            return [sexpr.render(v) for v in (self.run_one(f"!(collapse (match {handle} {pat} {pat}))") or [])]
