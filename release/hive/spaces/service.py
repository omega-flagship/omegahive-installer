"""Purpose: shared swarm spaces: lib_hive.metta running in an embedded PeTTa.

All interpreter calls run on one worker thread.  PeTTa itself has no persistence: every write to the commons is
appended to an operations log (``spaces.log.jsonl``, see ``oplog``) and fsynced before the write returns, and the log
is replayed on start, so the commons survive restarts. One lock covers each write's apply and its append, so the log
holds writes in the order they were applied. On start a torn last line (a crash mid-append) is dropped with a
warning; any other line that cannot be replayed stops the start, naming it. Once replaying the log's tail costs more
than its last compaction did, the log is compacted: rewritten atomically as a snapshot, one record per atom the
spaces hold, so a start costs what the commons hold rather than every write since the hive began.

Swarm ``s`` owns ``&commons_s`` and ``&vocab_s``; grants live in ``&hive_acl``.
Agent input is validated by ``sexpr`` and passed as quoted data to evaluated MeTTa calls.

Repository map revisions are read-only spaces ``repo:<repo>@<sha>`` (handle ``&repo_<hash>``, see ``repo_space``). Only
the hive's repo-map loader (core/repomap.py) mounts or unmounts them, from atoms it encoded itself; no agent input, publish
or op-log entry ever writes one. They are not op-logged: the hive database holds the loaded atoms and the loader mounts them
again after a restart.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import pathlib
import queue
import sys
import threading
import time
from concurrent.futures import Future

from . import sexpr
from .oplog import LogCorrupt, OpLog

log = logging.getLogger("omegahive.spaces")

LIB_HIVE = pathlib.Path(__file__).resolve().with_name("lib_hive.metta")
REPO_CHUNK = 2000   # atoms per interpreter job when mounting a repo space, so other spaces' calls interleave
REPO_JOB_SECONDS = 120        # one repo job (a chunk, a clear, a count)
REPO_SETTLE_SECONDS = 600     # cleanup after a failure: it queues behind any job that timed out, which still runs
OUTCOMES = {"adopted", "revised", "chosen", "kept", "duplicate", "quarantined", "denied"}
# Publishes the log never records: a denied or duplicate one changes nothing, and a quarantine note lasts only until
# the next start.
UNLOGGED = {"denied", "quarantined", "duplicate"}


class SpaceError(RuntimeError):
    pass


class RepoMountIncomplete(SpaceError):
    """A repo space mount failed and its cleanup did not finish (it failed, or is still queued behind a job that timed out):
    what the space holds is unknown until a later mount or unmount settles it."""


def _ev_atom(item):
    """An evidence id "ev:a_1:3" as the atom (ev a_1 3), refusing anything else."""
    parts = str(item).split(":")
    if len(parts) != 3 or parts[0] != "ev" or not (parts[2].isascii() and parts[2].isdigit()):
        raise sexpr.SexprError(f"bad evidence id {item!r}")
    return f"(ev {sexpr.safe_symbol(parts[1])} {int(parts[2])})"


def _stamp_atoms(stamp):
    """["ev:a_1:3", ...] -> "((ev a_1 3) ...)" with validated parts, sorted by their text: a publish's stamp."""
    return "(" + " ".join(sorted(_ev_atom(item) for item in stamp)) + ")"


def _stamp_text(stamp):
    """The same in the order given: a stamp the commons already held, put back exactly as it was (a revised belief's
    stamp is in lib_hive's sort order, which is not the text order _stamp_atoms uses)."""
    return "(" + " ".join(_ev_atom(item) for item in stamp) + ")"


def _stamp_json(value):
    return [f"ev:{e[1]}:{e[2]}" for e in (value or []) if isinstance(e, list) and len(e) == 3]


def _tv(value):
    if isinstance(value, list) and len(value) == 3 and value[0] == "stv":
        return {"f": round(float(value[1]), 6), "c": round(float(value[2]), 6)}
    raise SpaceError(f"not a truth value: {value!r}")


def _stv(f, c):
    return f"(stv {float(f)!r} {float(c)!r})"


def _real(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"not a finite number: {value!r}")
    return number


def _evidence(value):
    if not isinstance(value, list):
        raise ValueError(f"not a list of evidence ids: {value!r}")
    for item in value:
        _ev_atom(item)
    return [str(item) for item in value]


_SYMBOL, _STATEMENT = sexpr.safe_symbol, sexpr.safe_commons_statement
# Every record the log holds, as {field: check} in the order it is written. Write records re-run a write, in order.
# Snapshot records (SNAPSHOT_OPS), which only a compaction writes and only at the head of the file, put one atom back
# each, so they load in time linear in what the spaces hold. DEFAULTS keeps the one default replay always gave: a vocab
# record without agent_id was applied as the hive's (_apply_vocab's signature).
RECORDS = {
    "grant": {"agent_id": _SYMBOL, "swarm_id": _SYMBOL},
    "revoke": {"agent_id": _SYMBOL, "swarm_id": _SYMBOL},
    "vocab": {"swarm_id": _SYMBOL, "term": _SYMBOL, "agent_id": _SYMBOL},
    "publish": {"swarm_id": _SYMBOL, "agent_id": _SYMBOL, "statement": _STATEMENT, "f": _real, "c": _real,
                "stamp": _evidence},
    "member": {"agent_id": _SYMBOL, "swarm_id": _SYMBOL},
    "term": {"swarm_id": _SYMBOL, "term": _SYMBOL},
    "asserted": {"swarm_id": _SYMBOL, "agent_id": _SYMBOL, "statement": _STATEMENT, "f": _real, "c": _real,
                 "stamp": _evidence},
    "current": {"swarm_id": _SYMBOL, "statement": _STATEMENT, "f": _real, "c": _real, "stamp": _evidence},
    "chosen": {"swarm_id": _SYMBOL, "statement": _STATEMENT, "kept": _evidence, "rejected": _evidence},
}
DEFAULTS = {"vocab": {"agent_id": "hive"}}
SNAPSHOT_OPS = frozenset({"member", "term", "asserted", "current", "chosen"})


def _record(op, fields):
    """A record as the log holds it, every field checked before anything runs: KeyError or TypeError when it is not
    one of RECORDS' shapes, SexprError when the commons' grammar refuses a value, ValueError for a number or a stamp
    that is not one."""
    checks = RECORDS[op]
    fields = {**DEFAULTS.get(op, {}), **fields}
    if set(fields) != set(checks):
        raise TypeError(f"a {op} record has the fields {', '.join(checks)}, not {', '.join(sorted(fields))}")
    return {"op": op, **{name: check(fields[name]) for name, check in checks.items()}}


def _publish_outcome(result):
    outcome = result if isinstance(result, str) else (result[0] if result else "error")
    if outcome not in OUTCOMES:
        raise SpaceError(f"unexpected publish result: {result!r}")
    return outcome


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
        started = time.perf_counter()
        threading.Thread(target=self._worker, name="hive-petta", daemon=True).start()
        self._ready.wait(60)
        self.start_seconds = time.perf_counter() - started   # what starting PeTTa costs: the floor for compaction
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
        self._oplog = OpLog(self.log_path)
        self._writes = threading.RLock()   # held across each write's apply and append, and across a compaction
        self._stopped = None               # why writes stopped, once one may have changed the spaces unlogged
        self._swarms = set()               # every swarm a record named: the spaces a snapshot reads
        # The tail's cost the next compaction waits for: what loading the log's snapshot cost, what writing the last
        # compaction cost, or, after a compaction that failed, twice the tail it failed at.
        self._compact_after = 0.0
        self._tail_seconds = 0.0           # what applying the records after the snapshot cost
        self._replay()

    def run(self, code, timeout=30):
        return self._interp.run(code, timeout)

    def run_one(self, code):
        results = self.run(code)
        return sexpr.read_result(results[-1]) if results else None

    # ---- persistence -----------------------------------------------------------------

    def _replay(self):
        """Load the log: check each record, then apply it, in order. A torn last line is dropped and truncated off with
        a warning (oplog); a record whose statement or symbol the commons' grammar now refuses is skipped with a
        warning and never run (review F1); any other line that cannot be replayed stops the start, naming its line, so
        the hive never starts on part of its commons. Then compacts if replaying the tail cost more than it should.

        Time: one interpreter job per record."""
        with self._writes:
            try:
                scan = self._oplog.scan()
            except LogCorrupt as exc:
                raise SpaceError(self._unreplayable(exc.line, exc.offset, exc.reason)) from None
            self._compact_after = self._tail_seconds = 0.0
            in_snapshot = True
            for item in scan.records:
                value = item.value
                if not isinstance(value, dict) or not isinstance(value.get("op"), str) or value["op"] not in RECORDS:
                    raise SpaceError(self._unreplayable(item.line, item.offset, f"not a record: {str(value)[:60]!r}"))
                op = value["op"]
                if op in SNAPSHOT_OPS and not in_snapshot:
                    raise SpaceError(self._unreplayable(item.line, item.offset, f"a {op} snapshot record after the "
                                                        "log's writes; a snapshot only opens the file"))
                in_snapshot = op in SNAPSHOT_OPS
                try:
                    record = _record(op, {k: v for k, v in value.items() if k != "op"})
                except sexpr.SexprError as exc:   # a stored statement that is not a logical form is never run (review F1)
                    log.warning("spaces log line %d (%s) refused: %s", item.line, op, exc)
                    continue
                except (TypeError, ValueError) as exc:
                    raise SpaceError(self._unreplayable(item.line, item.offset, str(exc))) from None
                started = time.perf_counter()
                try:
                    self._apply(record)
                except Exception as exc:
                    raise SpaceError(self._unreplayable(item.line, item.offset, f"applying it failed: {exc!r}")) from exc
                spent = time.perf_counter() - started
                if in_snapshot:
                    self._compact_after += spent
                else:
                    self._tail_seconds += spent
            for change in self._oplog.repair(scan):
                log.warning("commons log %s: %s", self.log_path, change)
        self._compact_if_due()

    def _unreplayable(self, line, offset, reason):
        return (f"commons log {self.log_path} line {line} (byte {offset}) cannot be replayed: {reason}. The hive does "
                "not start on part of its commons; every line before it is intact. Repair that line, or remove it and "
                "lose its record, then start the hive again.")

    def _apply(self, record):
        """Run one checked record on the interpreter: the one path replay and live writes share."""
        self._swarms.add(record["swarm_id"])
        return getattr(self, "_apply_" + record["op"])(**{k: v for k, v in record.items() if k != "op"})

    def _commit(self, record, logged=lambda result: True):
        """Apply a checked record, then append it to the log, fsynced, before returning, when logged(result) says the
        log keeps that result. Once the apply has started, a failure of any kind (the interpreter's, the disk's, an
        outcome nobody expected) may leave the spaces changed without the record that says so, and every later write
        would then be logged against a commons the log cannot rebuild. So writes stop there until a restart, which
        replays the log as it is on disk (as Redis refuses writes after a failed AOF write)."""
        with self._writes:
            if self._stopped:
                raise SpaceError(self._stopped)
            try:
                started = time.perf_counter()
                result = self._apply(record)
                spent = time.perf_counter() - started
                if logged(result):
                    self._oplog.append(record)
                    self._tail_seconds += spent
            except BaseException as exc:
                self._stopped = (f"commons writes stopped: a {record['op']} may have changed the spaces without "
                                 f"reaching the log ({exc!r}); restarting the hive replays the log as it is on disk")
                log.error("%s", self._stopped)
                raise
            self._compact_if_due()
            return result

    # ---- compaction --------------------------------------------------------------------

    def _compact_if_due(self):
        """Compact once applying the records after the snapshot has cost more than the snapshot did (to load, or to
        write at the last compaction) and more than starting PeTTa: a start then costs at most about twice what loading
        the spaces' own atoms costs, and compactions together cost no more than the writes they save replaying. Measured
        time, not counts: a revision costs time in proportion to its belief's stamp, so 4000 revisions of one statement
        replay in 105 s although the log holds only 4000 records, and load from a snapshot in under a second. A
        compaction that fails is tried again once the tail has doubled, so one that keeps failing (an atom with no
        record, say) costs a number of attempts logarithmic in the writes, not one per write."""
        if self._stopped or self._tail_seconds <= max(self._compact_after, self._interp.start_seconds):
            return
        try:
            self.compact()
        except Exception as exc:
            self._compact_after = 2 * self._tail_seconds
            log.error("commons log %s: compaction did not finish, and the log on disk is complete as it was: %r",
                      self.log_path, exc)

    def compact(self):
        """Rewrite the log as a snapshot: one record for every atom this service's spaces hold that a replay would
        rebuild, in each space's own order, so every reader answers after a restart exactly as it does now. Written to a
        staging file and renamed over the log (oplog), so a crash leaves the old log or the new one, each complete.
        Returns the number of records written."""
        with self._writes:
            if self._stopped:
                raise SpaceError(self._stopped)
            started = time.perf_counter()
            records = self._snapshot()
            size = self._oplog.rewrite(records)
            self._compact_after, self._tail_seconds = time.perf_counter() - started, 0.0
        log.info("commons log %s compacted to %d records (%d bytes) in %.3f s", self.log_path, len(records), size,
                 self._compact_after)
        return len(records)

    def _snapshot(self):
        """Every atom of this service's spaces that replaying the log would rebuild, as snapshot records. A Quarantined
        note is left out, since a quarantined publish is never logged and so never survives a restart. Raises
        SpaceError on any atom it has no record for, so a compaction never drops what it does not know.

        Time: one interpreter job per space; records linear in the atoms read."""
        out, prefix = [], "&commons_"
        for atom in self._atoms("&hive_acl"):
            if (isinstance(atom, list) and len(atom) == 5 and atom[0] == "Grant" and atom[4] == "publish"
                    and str(atom[2]).startswith(prefix) and str(atom[3]).startswith("$")):
                # Only grants into this service's swarms: in production it is the interpreter's one service, so that is
                # every grant (each record names its swarm, and _apply adds it); tests run several hives on it.
                if atom[2][len(prefix):] in self._swarms:
                    out.append(self._snapshot_record("member", agent_id=atom[1], swarm_id=atom[2][len(prefix):]))
                continue
            if self._read_grant(atom):
                continue   # derived from membership and the owner's setting, written again at start: no record
            raise SpaceError(f"the access list holds an atom compaction has no record for: {sexpr.render(atom)}")
        for swarm in sorted(self._swarms):
            for atom in self._atoms(f"&vocab_{swarm}"):
                if not (isinstance(atom, list) and len(atom) == 2 and atom[0] == "Term"):
                    raise SpaceError(f"&vocab_{swarm} holds an atom compaction has no record for: {sexpr.render(atom)}")
                out.append(self._snapshot_record("term", swarm_id=swarm, term=atom[1]))
            for atom in self._atoms(f"&commons_{swarm}"):
                kind = (atom[0], len(atom)) if isinstance(atom, list) and atom else None
                if kind == ("Asserted", 5):
                    f, c = self._snapshot_tv(atom[3])
                    out.append(self._snapshot_record("asserted", swarm_id=swarm, agent_id=atom[1],
                                                     statement=sexpr.render(atom[2]), f=f, c=c,
                                                     stamp=self._snapshot_stamp(atom[4])))
                elif kind == ("Current", 4):
                    f, c = self._snapshot_tv(atom[2])
                    out.append(self._snapshot_record("current", swarm_id=swarm, statement=sexpr.render(atom[1]), f=f,
                                                     c=c, stamp=self._snapshot_stamp(atom[3])))
                elif kind == ("Chosen", 4):
                    out.append(self._snapshot_record("chosen", swarm_id=swarm, statement=sexpr.render(atom[1]),
                                                     kept=self._snapshot_stamp(atom[2]),
                                                     rejected=self._snapshot_stamp(atom[3])))
                elif kind is None or kind[0] != "Quarantined":
                    raise SpaceError(f"&commons_{swarm} holds an atom compaction has no record for: "
                                     f"{sexpr.render(atom)}")
        return out

    def _atoms(self, space):
        atoms = self.run_one(f"!(collapse (match {space} $x $x))")
        if atoms in (None, "()"):
            return []
        if not isinstance(atoms, list):
            raise SpaceError(f"reading {space} did not answer a list: {atoms!r}")
        return atoms

    @staticmethod
    def _snapshot_record(op, **fields):
        try:
            return _record(op, fields)
        except (TypeError, ValueError) as exc:
            raise SpaceError(f"a {op} atom compaction cannot write back: {exc}") from None

    @staticmethod
    def _snapshot_tv(value):
        """(stv f c) with float parts, as every truth value the commons hold is; anything else stops the compaction
        rather than being written back as a different atom."""
        if isinstance(value, list) and len(value) == 3 and value[0] == "stv" and all(type(v) is float for v in value[1:]):
            return value[1], value[2]
        raise SpaceError(f"not a truth value compaction can write back: {value!r}")

    @staticmethod
    def _snapshot_stamp(value):
        if isinstance(value, list) and all(isinstance(e, list) and len(e) == 3 and e[0] == "ev"
                                           and type(e[2]) is int for e in value):
            return [f"ev:{e[1]}:{e[2]}" for e in value]
        raise SpaceError(f"not a stamp compaction can write back: {value!r}")

    # ---- grants and vocabulary --------------------------------------------------------

    def _apply_grant(self, agent_id, swarm_id):
        agent, swarm = sexpr.safe_symbol(agent_id), sexpr.safe_symbol(swarm_id)
        self.run(f"!(add-atom &hive_acl (Grant {agent} &commons_{swarm} $stmt publish))")

    _apply_member = _apply_grant   # a snapshot's grant puts back the same atom

    def _apply_revoke(self, agent_id, swarm_id):
        agent, swarm = sexpr.safe_symbol(agent_id), sexpr.safe_symbol(swarm_id)
        self.run(f"!(remove-atom &hive_acl (Grant {agent} &commons_{swarm} $stmt publish))")

    def _apply_vocab(self, swarm_id, term, agent_id="hive"):
        swarm, sym, agent = sexpr.safe_symbol(swarm_id), sexpr.safe_symbol(term), sexpr.safe_symbol(agent_id)
        self.run(f"!(hive-vocab-add! &vocab_{swarm} {sym} {agent})")

    def _apply_term(self, swarm_id, term):
        self._apply_vocab(swarm_id, term)

    def grant(self, agent_id, swarm_id):
        record = _record("grant", {"agent_id": agent_id, "swarm_id": swarm_id})
        with self._writes:   # the check and the grant are one step, so two racing grants never both add an atom
            if self.is_member(agent_id, swarm_id):
                return
            self._commit(record)

    def revoke(self, agent_id, swarm_id):
        """The mind leaves the swarm's commons, and its beliefs stop being linked there: every way out of a swarm comes
        through here, so none leaves a link behind."""
        self._commit(_record("revoke", {"agent_id": agent_id, "swarm_id": swarm_id}))
        self.link(agent_id, swarm_id, [])

    def is_member(self, agent_id, swarm_id):
        agent, swarm = sexpr.safe_symbol(agent_id), sexpr.safe_symbol(swarm_id)
        found = self.run(f"!(collapse (match &hive_acl (Grant {agent} &commons_{swarm} $s publish) True))")
        return bool(found) and found[-1] not in ("()", "")

    def add_vocab(self, swarm_id, terms, agent_id="hive"):
        with self._writes:
            known = set(self.vocab(swarm_id))
            for term in terms:
                record = _record("vocab", {"swarm_id": swarm_id, "term": term, "agent_id": agent_id})
                if record["term"] in known:
                    continue
                self._commit(record)
                known.add(record["term"])
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
        stmt = sexpr.safe_commons_statement(statement)
        # quote prevents argument translation, even if a loaded library defines a logical connective as a function.
        # hive-publish! therefore checks the grant before inspecting any part of the statement.
        code = (
            f"!(hive-publish! &commons_{swarm} &vocab_{swarm} &hive_acl {agent} "
            f"(quote {stmt}) (quote {_stv(f, c)}) (quote {_stamp_atoms(stamp)}))"
        )
        return self.run_one(code)

    # A snapshot's commons atoms, each put back as it was: no check runs and nothing is revised again.
    def _apply_asserted(self, swarm_id, agent_id, statement, f, c, stamp):
        swarm, agent = sexpr.safe_symbol(swarm_id), sexpr.safe_symbol(agent_id)
        stmt = sexpr.safe_commons_statement(statement)
        self.run(f"!(add-atom &commons_{swarm} (Asserted {agent} {stmt} {_stv(f, c)} {_stamp_text(stamp)}))")

    def _apply_current(self, swarm_id, statement, f, c, stamp):
        swarm, stmt = sexpr.safe_symbol(swarm_id), sexpr.safe_commons_statement(statement)
        self.run(f"!(add-atom &commons_{swarm} (Current {stmt} {_stv(f, c)} {_stamp_text(stamp)}))")

    def _apply_chosen(self, swarm_id, statement, kept, rejected):
        swarm, stmt = sexpr.safe_symbol(swarm_id), sexpr.safe_commons_statement(statement)
        self.run(f"!(add-atom &commons_{swarm} (Chosen {stmt} {_stamp_text(kept)} {_stamp_text(rejected)}))")

    def publish(self, swarm_id, agent_id, statement, f, c, stamp, open_vocab=True):
        record = _record("publish", {"swarm_id": swarm_id, "agent_id": agent_id, "statement": statement, "f": f,
                                     "c": c, "stamp": list(stamp)})
        if not (0.0 <= record["f"] <= 1.0 and 0.0 < record["c"] < 1.0):
            raise SpaceError("need 0 <= f <= 1 and 0 < c < 1")
        with self._writes:
            if open_vocab and self.is_member(agent_id, swarm_id):
                self.add_vocab(swarm_id, self.statement_symbols(record["statement"]), agent_id)
            result = self._commit(record, logged=lambda result: _publish_outcome(result) not in UNLOGGED)
        outcome = _publish_outcome(result)
        detail = {"outcome": outcome, "statement": record["statement"]}
        if outcome == "quarantined":
            detail["unmapped"] = [str(s) for s in result[1]]
        return detail

    # ---- linked belief spaces ------------------------------------------------------------------------------------------
    # A mind's beliefs reach its swarm through a read grant, (Grant (members &commons_s) &beliefs_m pattern read), on a
    # read-only space of (Held mind statement tv stamp) atoms. Both are derived, never op-logged: the host loads the space
    # from the mind's own last save and writes the grants from the mind's membership and its owner's setting, on join and
    # at every start (core/hive.py), so a restart, a compaction or a move rebuilds them from what they come from.

    @staticmethod
    def beliefs_space(agent_id):
        """A mind's linked belief space. Its prefix is no other space's (&commons_, &vocab_, &hive_acl, &repo_) and an
        agent id is a safe symbol, so no id spells another space's handle."""
        return "&beliefs_" + sexpr.safe_symbol(agent_id)

    @staticmethod
    def members(swarm_id):
        """The principal standing for every member of a swarm, whoever holds the publish grant into its commons."""
        return f"(members &commons_{sexpr.safe_symbol(swarm_id)})"

    @staticmethod
    def _read_grant(atom):
        return (isinstance(atom, list) and len(atom) == 5 and atom[0] == "Grant" and atom[4] == "read"
                and isinstance(atom[1], list) and len(atom[1]) == 2 and atom[1][0] == "members"
                and str(atom[2]).startswith("&beliefs_"))

    def link(self, agent_id, swarm_id, patterns):
        """Make the mind's read grants into its swarm exactly these statement patterns, each unified against a statement
        by hive-allowed?: ["$stmt"] links every belief, [] none. One interpreter job, so a reader sees the old grants or
        the new ones."""
        members, space = self.members(swarm_id), self.beliefs_space(agent_id)
        grant = f"(Grant {members} {space} $pattern read)"
        code = [f"!(collapse (match &hive_acl {grant} (remove-atom &hive_acl {grant})))"]
        code += [f"!(add-atom &hive_acl (Grant {members} {space} {sexpr.safe_link_pattern(p)} read))" for p in patterns]
        self.run("\n".join(code))

    def links(self, agent_id, swarm_id):
        """The statement patterns the mind's beliefs are linked into its swarm by, as rendered text."""
        members, space = self.members(swarm_id), self.beliefs_space(agent_id)
        value = self.run_one(f"!(collapse (match &hive_acl (Grant {members} {space} $pattern read) $pattern))") or []
        return [sexpr.render(v) for v in value]

    def mount_beliefs(self, agent_id, held):
        """Replace the mind's linked belief space with these beliefs, each (statement, f, c, stamp), statement a commons
        statement and stamp its evidence ids. One interpreter job, so a reader sees the old space or the new one.

        Time: one add-atom per belief, plus one remove per atom the space held."""
        agent, space = sexpr.safe_symbol(agent_id), self.beliefs_space(agent_id)
        code = [f"!(collapse (match {space} $atom (remove-atom {space} $atom)))"]
        for statement, f, c, stamp in held:
            stmt = sexpr.safe_commons_statement(statement)
            code.append(f"!(add-atom {space} (Held {agent} {stmt} {_stv(f, c)} {_stamp_atoms(stamp)}))")
        self.run("\n".join(code))

    def unmount_beliefs(self, agent_id):
        space = self.beliefs_space(agent_id)
        self.run(f"!(collapse (match {space} $atom (remove-atom {space} $atom)))")

    # ---- reading: each reader's one view of a swarm's beliefs ----------------------------------------------------------
    # A mind reads as itself, admitted to the linked spaces of its own swarm as a member; a person reads a swarm they can
    # see (the host checks that) as its members do. The view integrates every statement's sources by lib_hive's rule.

    def _principal(self, swarm_id, agent_id):
        return sexpr.safe_symbol(agent_id) if agent_id else self.members(swarm_id)

    def _view(self, swarm_id, agent_id, rows_of, among=None):
        """(rows, admitted Held atoms) of one reader's view, parsed; rows_of(commons) is the lib_hive call computing the
        rows from $held. among, when given, is the minds whose linked spaces the reader may see at all (a person sees a
        mind's beliefs only where the hive lets them see the mind); the grants still decide which of those count."""
        swarm, principal = sexpr.safe_symbol(swarm_id), self._principal(swarm_id, agent_id)
        held = (f"(hive-held &hive_acl {principal})" if among is None else
                f"(hive-held-among &hive_acl {principal} ({' '.join(self.beliefs_space(m) for m in among)}))")
        value = self.run_one(f"!(let $held {held} ({rows_of(f'&commons_{swarm}')} $held))")
        rows, held = value if isinstance(value, list) and len(value) == 2 else ([], [])
        return rows or [], held or []

    @staticmethod
    def _holders(held):
        """statement text -> {mind: {stamp, tv}} of the admitted Held atoms."""
        out = {}
        for _, mind, stmt, tv, stamp in held:
            out.setdefault(sexpr.render(stmt), {})[str(mind)] = {"stamp": _stamp_json(stamp), "tv": _tv(tv)}
        return out

    def beliefs(self, swarm_id, agent_id=None, among=None):
        """Every statement of the reader's view: its integrated truth value and stamp, the minds whose assertion or held
        belief shares that evidence (sources), and the minds whose own space holds it now (holders).

        Time: one interpreter job (lib_hive's hive-view-rows)."""
        rows, held = self._view(swarm_id, agent_id, lambda commons: f"(hive-view-rows {commons} $held)", among)
        holders = self._holders(held)
        out = []
        for stmt, tv, stamp, sources in rows:
            text = sexpr.render(stmt)
            out.append({"statement": text, "tv": _tv(tv), "stamp": _stamp_json(stamp),
                        "sources": sorted(str(x) for x in sources or []), "holders": sorted(holders.get(text, {}))})
        return sorted(out, key=lambda b: b["statement"])

    def count(self, swarm_id, agent_id=None, among=None):
        """How many statements the reader's view holds."""
        rows, _ = self._view(swarm_id, agent_id, lambda commons: f"(length (hive-currents {commons} $held))", among)
        return rows if isinstance(rows, int) else 0

    def belief(self, swarm_id, statement, agent_id=None, among=None):
        swarm = sexpr.safe_symbol(swarm_id)
        stmt = sexpr.safe_statement(statement)
        rows, held = self._view(swarm_id, agent_id, lambda commons: (
            f"(let $c (hive-statement-current {commons} $held (quote " + stmt + ")) "
            f"(collapse (let (Current $s $t $st) (superpose $c) ($t $st (hive-view-sources {commons} $held $s $st)))))"),
            among)
        if not rows:
            return None
        tv, stamp, sources = rows[0]
        minds = self._holders(held).get(stmt, {})
        chosen = self.run_one(f"!(collapse (match &commons_{swarm} (Chosen {stmt} $k $r) ($k $r)))") or []
        return {
            "statement": stmt,
            "tv": _tv(tv),
            "stamp": _stamp_json(stamp),
            "sources": sorted(str(x) for x in sources or []),
            "holders": sorted(minds),
            "held": [{"mind": m, **h} for m, h in sorted(minds.items())],
            "choices": [{"kept": _stamp_json(k), "rejected": _stamp_json(r)} for k, r in chosen],
        }

    def query(self, swarm_id, pattern, agent_id=None):
        """Atoms of the reader's view matching the pattern: its Currents, the Held atoms naming the mind that holds each,
        and the commons' other atoms."""
        pat = sexpr.safe_pattern(pattern)
        swarm, principal = sexpr.safe_symbol(swarm_id), self._principal(swarm_id, agent_id)
        value = self.run_one(f"!(hive-belief-view &commons_{swarm} &hive_acl {principal} (quote {pat}))") or []
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
