"""Body-level client for the warm Assume FabricPC organ.

This module owns the daemon process for the current the agent runtime. It does not
own the graph: &assume remains canonical, and the daemon only holds warm,
reloadable executable views.
"""

from __future__ import annotations

import atexit
import json
import os
import pathlib
import re
import select
import subprocess
import sys
import time
from typing import Any

MODULE_SRC = pathlib.Path(__file__).resolve().parent
if str(MODULE_SRC) not in sys.path:
    sys.path.insert(0, str(MODULE_SRC))

import assume


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_FABRICPC_REPO = CORE_ROOT.parent / "FabricPC"
DEFAULT_FABRICPC_PYTHON = DEFAULT_FABRICPC_REPO / ".venv/bin/python"
TRACE_PATH = pathlib.Path(
    os.environ.get("OMEGACLAW_ASSUME_TRACE_PATH", str(CORE_ROOT / "memory" / "assume_trace.metta"))
)
ASSUME_PATH = pathlib.Path(
    os.environ.get("OMEGACLAW_ASSUME_PATH", str(CORE_ROOT / "memory" / "assume.metta"))
)
DEMO_DIR = pathlib.Path(
    os.environ.get("OMEGACLAW_ASSUME_DEMO_DIR", str(CORE_ROOT / "demos" / "assume"))
)
STDERR_PATH = pathlib.Path(
    os.environ.get("OMEGACLAW_ASSUME_STDERR_PATH", str(CORE_ROOT / "memory" / "assume_fabricd.stderr.log"))
)

_current_module = sys.modules.get(__name__)
if _current_module is not None:
    sys.modules.setdefault("assume_client", _current_module)

_PROC: subprocess.Popen | None = None
_READY: dict[str, Any] | None = None
_LOADED: dict[str, dict[str, Any]] = {}
_STDERR_HANDLE = None


def _request_timeout_seconds() -> float:
    try:
        return max(0.1, float(os.environ.get("OMEGACLAW_ASSUME_REQUEST_TIMEOUT_SECONDS", "30")))
    except Exception:
        return 30.0


def _graph_id(domain, situation) -> str:
    return f"{str(domain)}::{str(situation)}"


def atom_text(value) -> str:
    """Return one valid MeTTa atom value for an Assume graph identifier."""
    return assume._atom_symbol(value)


def _fabric_python() -> pathlib.Path:
    return pathlib.Path(os.environ.get("FABRICPC_PYTHON", DEFAULT_FABRICPC_PYTHON))


def _fabric_repo() -> pathlib.Path:
    return pathlib.Path(os.environ.get("FABRICPC_REPO", DEFAULT_FABRICPC_REPO))


def _topology_hash(domain, situation, atoms_repr) -> str:
    context, actions, edges, _feedback = assume.atomspace_feature_graph(
        atoms_repr,
        str(domain),
        str(situation),
    )
    assume.validate_feature_graph(atoms_repr, context, actions, edges)
    features = sorted({item.feature for item in context} | {edge.feature for edge in edges})
    actions = sorted(actions)
    mask = assume._feature_action_mask(features, actions, edges)
    payload = json.dumps(
        {"features": features, "actions": actions, "mask": mask},
        sort_keys=True,
        separators=(",", ":"),
    )
    import hashlib

    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _request(payload: dict[str, Any]) -> dict[str, Any]:
    proc = _ensure_process()
    assert proc.stdin is not None
    assert proc.stdout is not None
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    line = _readline_with_timeout(proc, "request")
    if not line:
        detail = _read_stderr_tail()
        _clear_process()
        raise RuntimeError(f"assume-fabricd stopped without response {detail}".strip())
    try:
        return json.loads(line)
    except Exception:
        detail = _read_stderr_tail()
        _clear_process()
        raise RuntimeError(f"assume-fabricd returned invalid json: {line.strip()} {detail}".strip())


def _readline_with_timeout(proc: subprocess.Popen, phase: str) -> str:
    assert proc.stdout is not None
    timeout = _request_timeout_seconds()
    ready, _writable, _errors = select.select([proc.stdout], [], [], timeout)
    if not ready:
        _clear_process()
        raise TimeoutError(f"assume-fabricd {phase} timed out after {timeout:.3g}s")
    return proc.stdout.readline()


def _ensure_process() -> subprocess.Popen:
    global _PROC, _READY, _STDERR_HANDLE
    if _PROC is not None and _PROC.poll() is None:
        return _PROC

    python = _fabric_python()
    if not python.exists():
        raise RuntimeError(f"FabricPC python not found: {python}")
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([
        str(MODULE_SRC),
        str(CORE_ROOT / "src"),
        str(_fabric_repo()),
    ])
    env["PYTHONNOUSERSITE"] = "1"
    STDERR_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STDERR_HANDLE = STDERR_PATH.open("a", encoding="utf-8")
    _PROC = subprocess.Popen(
        [str(python), "-u", str(MODULE_SRC / "assume_fabricd.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=_STDERR_HANDLE,
        text=True,
        cwd=str(CORE_ROOT),
        env=env,
    )
    assert _PROC.stdout is not None
    line = _readline_with_timeout(_PROC, "startup")
    if not line:
        detail = _read_stderr_tail()
        _clear_process()
        raise RuntimeError(f"assume-fabricd failed to start {detail}".strip())
    try:
        _READY = json.loads(line)
    except Exception:
        detail = _read_stderr_tail()
        _clear_process()
        raise RuntimeError(f"assume-fabricd returned invalid startup json: {line.strip()} {detail}".strip())
    return _PROC


def _read_stderr_tail(limit: int = 500) -> str:
    try:
        if STDERR_PATH.exists():
            with STDERR_PATH.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - limit))
                return handle.read().decode("utf-8", errors="replace")
    except Exception:
        pass
    return ""


def _clear_process() -> None:
    global _PROC, _READY, _LOADED, _STDERR_HANDLE
    proc = _PROC
    if proc is not None:
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                    proc.wait(timeout=2)
                except Exception:
                    pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None and not stream.closed:
                    stream.close()
            except Exception:
                pass
    try:
        if _STDERR_HANDLE is not None and not _STDERR_HANDLE.closed:
            _STDERR_HANDLE.close()
    except Exception:
        pass
    _PROC = None
    _READY = None
    _LOADED = {}
    _STDERR_HANDLE = None


def start() -> str:
    try:
        proc = _ensure_process()
        return f"ASSUME-ORGAN-STARTED pid={proc.pid} ready={json.dumps(_READY, sort_keys=True)}"
    except Exception as exc:
        return f"ASSUME-ORGAN-START-ERROR {type(exc).__name__}: {exc}"


def stop() -> str:
    global _PROC
    proc = _PROC
    if proc is None or proc.poll() is not None:
        _clear_process()
        return "ASSUME-ORGAN-STOPPED already-stopped"
    try:
        _request({"cmd": "stop"})
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=10)
        except Exception:
            pass
    finally:
        _clear_process()
    return "ASSUME-ORGAN-STOPPED"


def status(atoms_repr="") -> str:
    alive = _PROC is not None and _PROC.poll() is None
    if not alive:
        return "ASSUME-STATUS daemon=stopped loaded=0"
    parts = [f"ASSUME-STATUS daemon=alive pid={_PROC.pid} loaded={len(_LOADED)}"]
    atom_text = str(atoms_repr or "")
    for graph_id, record in sorted(_LOADED.items()):
        stale = "unknown"
        if atom_text:
            try:
                current = _topology_hash(record["domain"], record["situation"], atom_text)
                stale = str(current != record["topology_hash"]).lower()
            except Exception as exc:
                stale = f"error:{type(exc).__name__}"
        try:
            remote = _request({"cmd": "status", "id": graph_id})
            dirty = str(remote.get("dirty", "unknown")).lower()
            targets = int(remote.get("target_count", 0) or 0)
        except Exception:
            dirty = "unknown"
            targets = 0
        parts.append(
            f"graph={graph_id} topology={record['topology_hash']} stale={stale} dirty={dirty} targets={targets}"
        )
    return " ".join(parts)


def _target_actions_atom(actions: Any) -> str:
    items = [assume._atom_symbol(item) for item in sorted(actions or [])]
    return "(TargetActions" + ("" if not items else " " + " ".join(items)) + ")"


def _proposal_count(domain, situation, atoms_repr) -> int:
    graph_id = _graph_id(domain, situation)
    response = _request({
        "cmd": "growth_proposals",
        "id": graph_id,
        "atoms": str(atoms_repr or ""),
    })
    if not response.get("ok"):
        return 0
    return len(assume._atom_rows(response.get("atoms", ""), "AssumeProposedFeatureEdge"))


def state(domain, situation, atoms_repr="") -> str:
    graph_id = _graph_id(domain, situation)
    domain_atom = assume._atom_symbol(domain)
    situation_atom = assume._atom_symbol(situation)
    alive = _PROC is not None and _PROC.poll() is None
    daemon = "alive" if alive else "stopped"
    loaded = _LOADED.get(graph_id)
    if daemon != "alive":
        return (
            f"(AssumeState {domain_atom} {situation_atom} (Daemon {daemon}) "
            f"(Loaded false) (Dirty false) (Stale unknown) (Targets 0) "
            f"(TargetActions) (Proposals 0) (Topology unknown))"
        )
    if loaded is None:
        return (
            f"(AssumeState {domain_atom} {situation_atom} (Daemon {daemon}) "
            f"(Loaded false) (Dirty false) (Stale unknown) (Targets 0) "
            f"(TargetActions) (Proposals 0) (Topology unknown))"
        )
    stale = "unknown"
    atom_text = str(atoms_repr or "")
    if atom_text:
        try:
            stale = str(_topology_hash(domain, situation, atom_text) != loaded.get("topology_hash")).lower()
        except Exception as exc:
            stale = assume._atom_symbol(f"error:{type(exc).__name__}")
    try:
        remote = _request({"cmd": "status", "id": graph_id})
        if not remote.get("ok"):
            raise RuntimeError(remote.get("error"))
        dirty = str(bool(remote.get("dirty"))).lower()
        target_actions = remote.get("target_actions", []) or []
        target_count = int(remote.get("target_count", len(target_actions)) or 0)
        proposal_count = _proposal_count(domain, situation, atom_text) if atom_text else 0
    except Exception as exc:
        return (
            f"(AssumeState {domain_atom} {situation_atom} (Daemon {daemon}) "
            f"(Loaded true) (Error {assume._atom_symbol(f'{type(exc).__name__}: {exc}')}) "
            f"(Dirty unknown) (Stale {stale}) (Targets 0) (TargetActions) "
            f"(Proposals 0) (Topology {assume._atom_symbol(str(loaded.get('topology_hash', 'unknown')))}) )"
        )
    return (
        f"(AssumeState {domain_atom} {situation_atom} (Daemon {daemon}) "
        f"(Loaded true) (Dirty {dirty}) (Stale {stale}) "
        f"(Targets {target_count}) {_target_actions_atom(target_actions)} "
        f"(Proposals {proposal_count}) "
        f"(Topology {assume._atom_symbol(str(loaded.get('topology_hash', 'unknown')))}) )"
    )


def load(domain, situation, atoms_repr) -> str:
    return _load(domain, situation, atoms_repr, verb="ASSUME-LOADED")


def reload(domain, situation, atoms_repr) -> str:
    return _load(domain, situation, atoms_repr, verb="ASSUME-RELOADED")


def _demo_path(name: Any) -> pathlib.Path:
    raw = str(name or "").strip()
    if not raw:
        raise ValueError("demo name is required")
    candidate = raw if raw.endswith(".metta") else f"{raw}.metta"
    if "/" in candidate or "\\" in candidate or candidate.startswith("."):
        raise ValueError(f"unsafe demo name: {raw}")
    path = DEMO_DIR / candidate
    if not path.exists():
        available = ", ".join(sorted(item.stem for item in DEMO_DIR.glob("*.metta"))) or "none"
        raise FileNotFoundError(f"demo not found: {raw}; available={available}")
    return path


def demo_atoms(name: Any) -> str:
    return _demo_path(name).read_text(encoding="utf-8")


def demo_index() -> str:
    rows = []
    for path in sorted(DEMO_DIR.glob("*.metta")):
        try:
            atoms = path.read_text(encoding="utf-8")
            meta = assume._atom_rows(atoms, "AssumeDemoSpace")
            domain = meta[0][1] if meta and len(meta[0]) >= 2 else "unknown"
            situations = sorted({
                row[1]
                for row in assume._atom_rows(atoms, "AssumeSituation")
                if len(row) >= 2 and row[0] == domain
            })
            rows.append(
                "(AssumeDemo "
                f"{assume._atom_symbol(path.stem)} {assume._atom_symbol(domain)} "
                f"(Situations {' '.join(assume._atom_symbol(item) for item in situations)}))"
            )
        except Exception as exc:
            rows.append(
                "(AssumeDemoError "
                f"{assume._atom_symbol(path.stem)} {assume._atom_symbol(f'{type(exc).__name__}: {exc}')})"
            )
    return "(AssumeDemoIndex" + ("" if not rows else " " + " ".join(rows)) + ")"


def demo_load(name, domain, situation) -> str:
    return _load(domain, situation, demo_atoms(name), verb="ASSUME-DEMO-LOADED")


def demo_predict(name, domain, situation) -> str:
    return predict(domain, situation, demo_atoms(name))


def demo_audit(name, domain, situation, action) -> str:
    return audit(domain, situation, action, demo_atoms(name))


def demo_learn(name, domain, situation, targets_json) -> str:
    return learn(domain, situation, demo_atoms(name), targets_json)


def demo_writeback(name, domain, situation) -> str:
    _demo_path(name)
    return writeback(domain, situation)


def _validate_demo_atom(atom_text: str) -> str:
    for atom_name in (
        "AssumeDemoSpace",
        "AssumeSituation",
        "AssumeContextFeature",
        "AssumeAction",
        "AssumeFeatureEdge",
        "AssumeOutcome",
        "AssumeError",
    ):
        rows = assume._atom_rows(atom_text, atom_name)
        if not rows:
            continue
        if len(rows) != 1:
            raise ValueError(f"expected one {atom_name} atom")
        row = rows[0]
        if atom_name == "AssumeContextFeature":
            if len(row) < 6:
                raise ValueError(f"bad AssumeContextFeature arity: {row}")
            assume._to_float(row[3])
            assume._to_float(row[4])
        elif atom_name == "AssumeFeatureEdge":
            if len(row) < 6:
                raise ValueError(f"bad AssumeFeatureEdge arity: {row}")
            assume._to_float(row[3])
            assume._to_float(row[4])
            assume._to_float(row[5])
        elif atom_name in {"AssumeOutcome", "AssumeError"}:
            if len(row) < 6:
                raise ValueError(f"bad {atom_name} arity: {row}")
            assume._to_float(row[5])
        elif len(row) < 2:
            raise ValueError(f"bad {atom_name} arity: {row}")
        return atom_name
    raise ValueError(f"unsupported demo atom: {atom_text[:120]}")


def persist_demo(name, path: str | None = None) -> str:
    """Import a bundled Assume demo into canonical &assume storage.

    The demo remains ordinary Assume atoms after import. the agent can then use the
    normal assume-load/predict/audit/learn affordances instead of demo-only
    wrappers. This function only appends validated atoms that are not already
    present; it never rewrites the agent's existing graph.
    """
    target = pathlib.Path(path) if path else ASSUME_PATH
    try:
        atoms = _top_level_atom_texts(demo_atoms(name))
        if not atoms:
            raise ValueError("demo contains no atoms")
        existing = target.read_text(encoding="utf-8") if target.exists() else ""
        target.parent.mkdir(parents=True, exist_ok=True)
        added_atoms = []
        duplicates = 0
        atom_types: dict[str, int] = {}
        domain = "unknown"
        for atom_text in atoms:
            atom_name = _validate_demo_atom(atom_text)
            atom_types[atom_name] = atom_types.get(atom_name, 0) + 1
            meta_rows = assume._atom_rows(atom_text, "AssumeDemoSpace")
            situation_rows = assume._atom_rows(atom_text, "AssumeSituation")
            if meta_rows and len(meta_rows[0]) >= 2:
                domain = meta_rows[0][1]
            elif domain == "unknown" and situation_rows and situation_rows[0]:
                domain = situation_rows[0][0]
            if _atom_already_present(existing, atom_text):
                duplicates += 1
                continue
            added_atoms.append(atom_text)
            existing = existing.rstrip() + "\n" + atom_text + "\n"
        target.write_text(existing, encoding="utf-8")
        trace = "not-needed"
        if added_atoms:
            trace = record_trace(domain, "demo-import", "(" + " ".join(added_atoms) + ")")
        type_summary = ",".join(f"{key}:{atom_types[key]}" for key in sorted(atom_types))
        return (
            f"ASSUME-DEMO-IMPORTED name={assume._atom_symbol(name)} path={target} "
            f"domain={assume._atom_symbol(domain)} added={len(added_atoms)} "
            f"duplicates={duplicates} total={len(atoms)} types={assume._atom_symbol(type_summary)} "
            f"trace={assume._atom_symbol(trace)}"
        )
    except Exception as exc:
        return f"ASSUME-DEMO-IMPORT-ERROR {type(exc).__name__}: {exc}"


def persist_demo_result(name, path: str | None = None) -> str:
    result = persist_demo(name, path)
    if result.startswith("ASSUME-DEMO-IMPORTED"):
        return (
            f"(AssumeDemoPersisted {assume._atom_symbol(name)} "
            f"{assume._atom_symbol(result)})"
        )
    return (
        f"(AssumeDemoPersistError {assume._atom_symbol(name)} "
        f"{assume._atom_symbol(result)})"
    )


def _load(domain, situation, atoms_repr, verb: str) -> str:
    graph_id = _graph_id(domain, situation)
    response = _request({
        "cmd": "load",
        "id": graph_id,
        "domain": str(domain),
        "situation": str(situation),
        "atoms": str(atoms_repr or ""),
    })
    if not response.get("ok"):
        error = response.get("error")
        readiness = _graph_readiness_atom(domain, situation, atoms_repr, error)
        return f"{verb}-ERROR {error} {readiness}"
    _LOADED[graph_id] = {
        "domain": str(domain),
        "situation": str(situation),
        "topology_hash": response.get("topology_hash"),
    }
    return (
        f"{verb} graph={graph_id} features={response.get('features')} "
        f"actions={response.get('actions')} edges={response.get('edges')} "
        f"topology={response.get('topology_hash')}"
    )


def _loaded_graph_status(graph_id: str) -> dict[str, Any]:
    response = _request({"cmd": "status", "id": graph_id})
    if not response.get("ok"):
        raise RuntimeError(response.get("error"))
    return response


def _dirty_topology_conflict(graph_id: str, loaded_hash: str, current_hash: str) -> str:
    return (
        "ASSUME-DIRTY-TOPOLOGY-CONFLICT "
        f"graph={graph_id} loaded_topology={loaded_hash} current_topology={current_hash} "
        "dirty=true action=save-or-discard-before-reload"
    )


def _bundle_error(atom_name: str, domain, situation, message: Any) -> str:
    """Return a one-atom MeTTa bundle suitable for observe-* atomization."""
    return (
        f"(({atom_name} {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(str(message))}))"
    )


def _graph_readiness_atom(domain, situation, atoms_repr, message: Any) -> str:
    """Expose graph absence as symbolic state, not as hidden recovery logic."""
    try:
        status = situation_status(domain, situation, atoms_repr)
    except Exception as exc:
        status = (
            f"(AssumeSituationStatusError {assume._atom_symbol(domain)} "
            f"{assume._atom_symbol(situation)} {assume._atom_symbol(f'{type(exc).__name__}: {exc}')})"
        )
    return (
        f"(AssumeGraphNotReady {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"(SearchedSpace assume) (Reason {assume._atom_symbol(str(message))}) "
        f"(Status {status}) "
        f"(NextActions assume-situation-status assume-init-situation assume-add-context-feature "
        f"assume-add-action assume-add-feature-edge assume-learn-from-atoms))"
    )


def _bundle_error_with_readiness(atom_name: str, domain, situation, message: Any, atoms_repr) -> str:
    error_atom = (
        f"({atom_name} {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(str(message))})"
    )
    readiness_atom = _graph_readiness_atom(domain, situation, atoms_repr, message)
    return f"({error_atom} {readiness_atom})"


def _ensure_loaded(domain, situation, atoms_repr) -> str:
    graph_id = _graph_id(domain, situation)
    current = _topology_hash(domain, situation, atoms_repr)
    loaded = _LOADED.get(graph_id)
    if loaded is not None and loaded.get("topology_hash") != current:
        remote = _loaded_graph_status(graph_id)
        if bool(remote.get("dirty")):
            raise RuntimeError(
                _dirty_topology_conflict(graph_id, str(loaded.get("topology_hash")), current)
            )
    if loaded is None or loaded.get("topology_hash") != current:
        result = _load(domain, situation, atoms_repr, verb="ASSUME-AUTO-LOADED")
        if graph_id not in _LOADED:
            raise RuntimeError(result)
    return graph_id


def predict(domain, situation, atoms_repr) -> str:
    try:
        graph_id = _ensure_loaded(domain, situation, atoms_repr)
        response = _request({"cmd": "predict", "id": graph_id, "atoms": str(atoms_repr or "")})
        if not response.get("ok"):
            return _bundle_error_with_readiness(
                "AssumePredictError", domain, situation, response.get("error"), atoms_repr
            )
        return response.get("report_atoms", "")
    except Exception as exc:
        return _bundle_error_with_readiness(
            "AssumePredictError", domain, situation, f"{type(exc).__name__}: {exc}", atoms_repr
        )


def audit(domain, situation, action, atoms_repr) -> str:
    try:
        graph_id = _ensure_loaded(domain, situation, atoms_repr)
        response = _request({
            "cmd": "audit",
            "id": graph_id,
            "action": str(action),
            "atoms": str(atoms_repr or ""),
        })
        if not response.get("ok"):
            return _bundle_error_with_readiness(
                "AssumeAuditError", domain, situation, response.get("error"), atoms_repr
            )
        return response.get("report_atoms", "")
    except Exception as exc:
        return _bundle_error_with_readiness(
            "AssumeAuditError", domain, situation, f"{type(exc).__name__}: {exc}", atoms_repr
        )


def learn(domain, situation, atoms_repr, targets_json) -> str:
    try:
        graph_id = _ensure_loaded(domain, situation, atoms_repr)
        targets = json.loads(str(targets_json or "{}"))
        if not isinstance(targets, dict):
            return "ASSUME-LEARN-ERROR targets must be a JSON object"
        response = _request({
            "cmd": "learn",
            "id": graph_id,
            "atoms": str(atoms_repr or ""),
            "targets": targets,
        })
        if not response.get("ok"):
            return f"ASSUME-LEARN-ERROR {response.get('error')}"
        return f"ASSUME-LEARNED graph={graph_id} dirty={response.get('dirty')} energy={response.get('energy')}"
    except Exception as exc:
        return f"ASSUME-LEARN-ERROR {type(exc).__name__}: {exc}"


def learn_from_atoms(domain, situation, atoms_repr) -> str:
    try:
        graph_id = _ensure_loaded(domain, situation, atoms_repr)
        response = _request({
            "cmd": "learn_from_atoms",
            "id": graph_id,
            "atoms": str(atoms_repr or ""),
        })
        if not response.get("ok"):
            return f"ASSUME-LEARN-FROM-ATOMS-ERROR {response.get('error')}"
        return f"ASSUME-LEARNED-FROM-ATOMS graph={graph_id} dirty={response.get('dirty')} energy={response.get('energy')}"
    except Exception as exc:
        return f"ASSUME-LEARN-FROM-ATOMS-ERROR {type(exc).__name__}: {exc}"


def evidence_summary(domain, situation, atoms_repr) -> str:
    try:
        graph_id = _ensure_loaded(domain, situation, atoms_repr)
        response = _request({
            "cmd": "evidence_summary",
            "id": graph_id,
            "atoms": str(atoms_repr or ""),
        })
        if not response.get("ok"):
            return _bundle_error("AssumeEvidenceSummaryError", domain, situation, response.get("error"))
        return response.get("atoms", "")
    except Exception as exc:
        return _bundle_error("AssumeEvidenceSummaryError", domain, situation, f"{type(exc).__name__}: {exc}")


def writeback(domain, situation) -> str:
    try:
        graph_id = _graph_id(domain, situation)
        response = _request({"cmd": "writeback", "id": graph_id})
        if not response.get("ok"):
            return _bundle_error("AssumeWritebackError", domain, situation, response.get("error"))
        return response.get("atoms", "")
    except Exception as exc:
        return _bundle_error("AssumeWritebackError", domain, situation, f"{type(exc).__name__}: {exc}")


def validated_writeback(domain, situation, atoms_repr) -> str:
    """Return writeback atoms only if current AtomSpace topology still matches.

    This is the commit membrane. It does not mutate AtomSpace and does not mark
    Fabric clean; callers should apply/export the returned atoms first, then
    call mark_clean only after the canonical graph commit succeeds.
    """
    try:
        graph_id = _graph_id(domain, situation)
        loaded = _LOADED.get(graph_id)
        if loaded is None:
            return _bundle_error("AssumeSaveError", domain, situation, f"unknown graph id: {graph_id}")
        current = _topology_hash(domain, situation, atoms_repr)
        loaded_hash = str(loaded.get("topology_hash"))
        if loaded_hash != current:
            return _bundle_error("AssumeSaveError", domain, situation, _dirty_topology_conflict(graph_id, loaded_hash, current))
        return writeback(domain, situation)
    except Exception as exc:
        return _bundle_error("AssumeSaveError", domain, situation, f"{type(exc).__name__}: {exc}")


def growth_proposals(domain, situation, atoms_repr) -> str:
    try:
        graph_id = _graph_id(domain, situation)
        response = _request({
            "cmd": "growth_proposals",
            "id": graph_id,
            "atoms": str(atoms_repr or ""),
        })
        if not response.get("ok"):
            return _bundle_error("AssumeGrowthProposalsError", domain, situation, response.get("error"))
        return response.get("atoms", "")
    except Exception as exc:
        return _bundle_error("AssumeGrowthProposalsError", domain, situation, f"{type(exc).__name__}: {exc}")


def growth_pressure(domain, situation, atoms_repr) -> str:
    try:
        graph_id = _graph_id(domain, situation)
        response = _request({
            "cmd": "growth_pressure",
            "id": graph_id,
            "atoms": str(atoms_repr or ""),
        })
        if not response.get("ok"):
            return _bundle_error("AssumeGrowthPressureError", domain, situation, response.get("error"))
        return response.get("atoms", "")
    except Exception as exc:
        return _bundle_error("AssumeGrowthPressureError", domain, situation, f"{type(exc).__name__}: {exc}")


def adjustment_pressure(domain, situation, atoms_repr) -> str:
    try:
        graph_id = _graph_id(domain, situation)
        response = _request({
            "cmd": "adjustment_pressure",
            "id": graph_id,
            "atoms": str(atoms_repr or ""),
        })
        if not response.get("ok"):
            return _bundle_error("AssumeAdjustmentPressureError", domain, situation, response.get("error"))
        return response.get("atoms", "")
    except Exception as exc:
        return _bundle_error("AssumeAdjustmentPressureError", domain, situation, f"{type(exc).__name__}: {exc}")


def mark_clean(domain, situation) -> str:
    try:
        graph_id = _graph_id(domain, situation)
        response = _request({"cmd": "mark_clean", "id": graph_id})
        if not response.get("ok"):
            return f"ASSUME-MARK-CLEAN-ERROR {response.get('error')}"
        loaded = _LOADED.get(graph_id)
        if loaded is not None:
            loaded["topology_hash"] = response.get("topology_hash", loaded.get("topology_hash"))
        return f"ASSUME-MARKED-CLEAN graph={graph_id} dirty={response.get('dirty')}"
    except Exception as exc:
        return f"ASSUME-MARK-CLEAN-ERROR {type(exc).__name__}: {exc}"


def _updated_feature_edges(delta_repr: str, domain: str):
    rows = []
    for row in assume._atom_rows(str(delta_repr or ""), "AssumeUpdatedFeatureEdge"):
        if len(row) < 6:
            raise ValueError(f"bad AssumeUpdatedFeatureEdge arity: {row}")
        if row[0] != domain:
            raise ValueError(f"delta domain mismatch: {row[0]} != {domain}")
        feature, action = row[1], row[2]
        weight = assume._to_float(row[3])
        confidence = assume._to_float(row[4])
        evidence = assume._to_float(row[5])
        rows.append((feature, action, weight, confidence, evidence))
    if not rows:
        raise ValueError("no AssumeUpdatedFeatureEdge atoms in delta")
    return rows


def _matching_growth_proposal(proposal_repr: str, domain: str, situation: str):
    rows = []
    for row in assume._atom_rows(str(proposal_repr or ""), "AssumeProposedFeatureEdge"):
        if len(row) < 8:
            raise ValueError(f"bad AssumeProposedFeatureEdge arity: {row}")
        if row[0] == domain and row[1] == situation:
            rows.append(row)
    if len(rows) != 1:
        raise ValueError(f"expected exactly one matching AssumeProposedFeatureEdge, found {len(rows)}")
    feature, action = rows[0][2], rows[0][3]
    weight = assume._to_float(rows[0][4])
    confidence = assume._to_float(rows[0][5])
    evidence = assume._to_float(rows[0][6])
    proposal_reason = rows[0][7]
    return feature, action, weight, confidence, evidence, proposal_reason


def _accepted_growth_review(review_repr: str, domain: str, situation: str, feature: str, action: str):
    rows = []
    for row in assume._atom_rows(str(review_repr or ""), "AssumeGrowthJudgement"):
        if len(row) < 11:
            raise ValueError(f"bad AssumeGrowthJudgement arity: {row}")
        if row[1] == domain and row[2] == situation and row[3] == feature and row[4] == action:
            rows.append(row)
    if len(rows) != 1:
        raise ValueError(f"expected exactly one matching AssumeGrowthJudgement, found {len(rows)}")
    row = rows[0]
    decision = row[5]
    expectation = assume._to_float(row[6])
    target = assume._to_float(row[7])
    confidence = assume._to_float(row[8])
    conflict = assume._to_float(row[9])
    pressure = assume._to_float(row[10])
    if decision != "acceptable":
        raise ValueError(f"growth review decision is {decision}, not acceptable")
    if conflict >= 0.6:
        raise ValueError(f"growth review conflict too high: {conflict:.12g}")
    if pressure <= 0:
        raise ValueError("growth review pressure must be positive")
    return expectation, target, confidence, conflict, pressure


def _feature_edge_exists(atoms_repr: str, domain: str, feature: str, action: str) -> bool:
    for row in assume._atom_rows(str(atoms_repr or ""), "AssumeFeatureEdge"):
        if len(row) >= 3 and row[0] == domain and row[1] == feature and row[2] == action:
            return True
    return False


def _matching_feature_edge_rows(atoms_repr: str, domain: str, feature: str, action: str):
    rows = []
    for row in assume._atom_rows(str(atoms_repr or ""), "AssumeFeatureEdge"):
        if len(row) >= 6 and row[0] == domain and row[1] == feature and row[2] == action:
            rows.append(row)
    return rows


def _replace_feature_edge_atom(
    text: str,
    domain: str,
    feature: str,
    action: str,
    weight: float,
    confidence: float,
    evidence: float,
) -> tuple[str, int, str]:
    domain_atom = assume._atom_symbol(domain)
    feature_atom = assume._atom_symbol(feature)
    action_atom = assume._atom_symbol(action)
    atom = (
        f"(AssumeFeatureEdge {domain_atom} "
        f"{feature_atom} {action_atom} "
        f"{weight:.12g} {confidence:.12g} {evidence:.12g})"
    )
    pattern = re.compile(
        r"\(AssumeFeatureEdge\s+"
        + re.escape(domain_atom)
        + r"\s+"
        + re.escape(feature_atom)
        + r"\s+"
        + re.escape(action_atom)
        + r"\s+[^()\s]+\s+[^()\s]+\s+[^()\s]+\)"
    )
    replaced, count = pattern.subn(atom, str(text or ""), count=1)
    return replaced, count, atom


def _atom_already_present(text: str, atom_text: str) -> bool:
    needle = str(atom_text or "").strip()
    return any(line.strip() == needle for line in str(text or "").splitlines())


def _append_unique_atom(atom_text: str, path: str | None = None) -> tuple[bool, pathlib.Path]:
    target = pathlib.Path(path) if path else ASSUME_PATH
    atom_text = str(atom_text or "").strip()
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    if _atom_already_present(existing, atom_text):
        return True, target
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        if existing and not existing.endswith("\n"):
            handle.write("\n")
        handle.write(atom_text)
        handle.write("\n")
    return False, target


def _ensure_single_atom(atom_text: str, atom_name: str) -> list[str]:
    rows = assume._atom_rows(atom_text, atom_name)
    if len(rows) != 1:
        raise ValueError(f"expected exactly one {atom_name} atom")
    return rows[0]


def _is_canonical_assume_path(path: pathlib.Path) -> bool:
    try:
        return path.resolve() == ASSUME_PATH.resolve()
    except Exception:
        return False


def _format_assume_status_atom(name: str, domain, situation, message: str) -> str:
    return (
        f"({name} {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(str(message))})"
    )


def persist_structural_atom(atom_text, atom_name: str, path: str | None = None) -> str:
    """Persist one safe structural &assume atom.

    This is the narrow birth/write membrane for the agent-created prediction
    situations. It validates only known Assume atom shapes and appends exactly
    the atom the agent asked for; it does not infer or auto-fill graph structure.
    Canonical writes also append an exact mutation trace. Duplicate writes and
    temp/test-path writes are not cognitive mutations and do not create trace.
    """
    atom_text = str(atom_text or "").strip()
    atom_name = str(atom_name or "").strip()
    try:
        if atom_name not in {
            "AssumeSituation",
            "AssumeContextFeature",
            "AssumeAction",
            "AssumeFeatureEdge",
        }:
            raise ValueError(f"unsupported structural atom: {atom_name}")
        row = _ensure_single_atom(atom_text, atom_name)
        if atom_name == "AssumeSituation":
            if len(row) < 3:
                raise ValueError(f"bad AssumeSituation arity: {row}")
        elif atom_name == "AssumeContextFeature":
            if len(row) < 6:
                raise ValueError(f"bad AssumeContextFeature arity: {row}")
            assume._to_float(row[3])
            assume._to_float(row[4])
        elif atom_name == "AssumeAction":
            if len(row) < 3:
                raise ValueError(f"bad AssumeAction arity: {row}")
        elif atom_name == "AssumeFeatureEdge":
            if len(row) < 6:
                raise ValueError(f"bad AssumeFeatureEdge arity: {row}")
            assume._to_float(row[3])
            assume._to_float(row[4])
            assume._to_float(row[5])
        duplicate, target = _append_unique_atom(atom_text, path)
        trace = "not-needed"
        if not duplicate and _is_canonical_assume_path(target):
            domain = row[0] if row else "unknown"
            situation = (
                row[1]
                if atom_name in {"AssumeSituation", "AssumeContextFeature"} and len(row) > 1
                else "structural"
            )
            trace = record_trace(domain, situation, atom_text)
        return (
            f"ASSUME-STRUCTURAL-ATOM-PERSISTED path={target} "
            f"atom={atom_name} duplicate={str(duplicate).lower()} "
            f"trace={assume._atom_symbol(trace)}"
        )
    except Exception as exc:
        return f"ASSUME-STRUCTURAL-ATOM-PERSIST-ERROR {type(exc).__name__}: {exc}"


def persist_structural_atom_result(atom_text, atom_name: str, path: str | None = None) -> str:
    result = persist_structural_atom(atom_text, atom_name, path)
    if result.startswith("ASSUME-STRUCTURAL-ATOM-PERSISTED"):
        return (
            f"(AssumeStructuralPersisted {assume._atom_symbol(atom_name)} "
            f"{assume._atom_symbol(result)})"
        )
    return (
        f"(AssumeStructuralPersistError {assume._atom_symbol(atom_name)} "
        f"{assume._atom_symbol(result)})"
    )


def assume_situation_atom(domain, situation, reason) -> str:
    return (
        f"(AssumeSituation {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(str(reason or 'created-by-omega'))})"
    )


def assume_context_feature_atom(domain, situation, feature, strength, confidence, source) -> str:
    return (
        f"(AssumeContextFeature {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(feature)} {assume._to_float(strength):.12g} "
        f"{assume._to_float(confidence):.12g} {assume._atom_symbol(source)})"
    )


def assume_action_atom(domain, action, kind) -> str:
    return (
        f"(AssumeAction {assume._atom_symbol(domain)} {assume._atom_symbol(action)} "
        f"{assume._atom_symbol(kind)})"
    )


def assume_feature_edge_atom(domain, feature, action, weight, confidence, evidence) -> str:
    return (
        f"(AssumeFeatureEdge {assume._atom_symbol(domain)} {assume._atom_symbol(feature)} "
        f"{assume._atom_symbol(action)} {assume._to_float(weight):.12g} "
        f"{assume._to_float(confidence):.12g} {assume._to_float(evidence):.12g})"
    )


def _assume_evidence_atom(atom_name, domain, situation, action, polarity, strength, note) -> str:
    return (
        f"({atom_name} {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(action)} {assume._atom_symbol(polarity)} "
        f"{assume._atom_symbol(note)} {assume._to_float(strength):.12g})"
    )


def assume_outcome_atom(domain, situation, action, polarity, strength, note) -> str:
    return _assume_evidence_atom(
        "AssumeOutcome", domain, situation, action, polarity, strength, note
    )


def assume_error_atom(domain, situation, action, polarity, strength, note) -> str:
    return _assume_evidence_atom(
        "AssumeError", domain, situation, action, polarity, strength, note
    )


def situation_status(domain, situation, atoms_repr) -> str:
    """Return inspectable readiness/coverage status for one Assume situation."""
    domain = str(domain)
    situation = str(situation)
    try:
        atom_text = str(atoms_repr or "")
        context, actions, edges, _feedback = assume.atomspace_feature_graph(
            atom_text,
            domain,
            situation,
        )
        assume.validate_feature_graph(atom_text, context, actions, edges)
        outcome_count = sum(
            1
            for row in assume._atom_rows(atom_text, "AssumeOutcome")
            if len(row) >= 3 and row[0] == domain and row[1] == situation
        )
        error_count = sum(
            1
            for row in assume._atom_rows(atom_text, "AssumeError")
            if len(row) >= 3 and row[0] == domain and row[1] == situation
        )
        situation_count = sum(
            1
            for row in assume._atom_rows(atom_text, "AssumeSituation")
            if len(row) >= 2 and row[0] == domain and row[1] == situation
        )
        feature_names = {item.feature for item in context}
        edge_features = {edge.feature for edge in edges}
        covered = feature_names & edge_features
        if not context:
            coverage = "no-context"
            advice = "add-context-features"
        elif not actions:
            coverage = "no-actions"
            advice = "add-actions"
        elif not edges:
            coverage = "zero-edge"
            advice = "learn-from-atoms-then-growth"
        elif len(covered) < len(feature_names):
            coverage = "partial-covered"
            advice = "review-growth-for-uncovered-features"
        elif outcome_count + error_count <= 0:
            coverage = "graph-no-evidence"
            advice = "gather-outcome-evidence"
        else:
            coverage = "usable-for-audit"
            advice = "predict-audit-review"
        return (
            f"(AssumeSituationStatus {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"(Situations {situation_count}) (Features {len(context)}) "
            f"(Actions {len(actions)}) (Edges {len(edges)}) "
            f"(CoveredFeatures {len(covered)}) (Outcomes {outcome_count}) "
            f"(Errors {error_count}) (Coverage {assume._atom_symbol(coverage)}) "
            f"(Advice {assume._atom_symbol(advice)}))"
        )
    except Exception as exc:
        return _format_assume_status_atom(
            "AssumeSituationStatusError",
            domain,
            situation,
            f"{type(exc).__name__}: {exc}",
        )


def persist_evidence_atom(atom_text, path: str | None = None) -> str:
    """Persist one explicit AssumeOutcome/AssumeError atom.

    Evidence is canonical symbolic input, not a transient daemon side-effect.
    The accepted shape mirrors helper.assume_outcome_atom/helper.assume_error_atom.
    Canonical writes also append an exact mutation trace. Duplicate writes and
    temp/test-path writes are not cognitive mutations and do not create trace.
    """
    target = pathlib.Path(path) if path else ASSUME_PATH
    atom_text = str(atom_text or "").strip()
    try:
        if not atom_text:
            raise ValueError("empty evidence atom")
        outcome_rows = assume._atom_rows(atom_text, "AssumeOutcome")
        error_rows = assume._atom_rows(atom_text, "AssumeError")
        rows = outcome_rows + error_rows
        if len(rows) != 1:
            raise ValueError("expected exactly one AssumeOutcome or AssumeError atom")
        row = rows[0]
        if len(row) < 6:
            raise ValueError(f"bad evidence arity: {row}")
        assume._to_float(row[5])
        existing = target.read_text(encoding="utf-8") if target.exists() else ""
        if atom_text in existing:
            return (
                f"ASSUME-EVIDENCE-PERSISTED path={target} "
                f"domain={assume._atom_symbol(row[0])} situation={assume._atom_symbol(row[1])} "
                f"duplicate=true trace={assume._atom_symbol('not-needed')}"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            if existing and not existing.endswith("\n"):
                handle.write("\n")
            handle.write(atom_text)
            handle.write("\n")
        trace = "not-needed"
        if _is_canonical_assume_path(target):
            trace = record_trace(row[0], row[1], atom_text)
        return (
            f"ASSUME-EVIDENCE-PERSISTED path={target} "
            f"domain={assume._atom_symbol(row[0])} situation={assume._atom_symbol(row[1])} "
            f"duplicate=false trace={assume._atom_symbol(trace)}"
        )
    except Exception as exc:
        return f"ASSUME-EVIDENCE-PERSIST-ERROR {type(exc).__name__}: {exc}"


def persist_evidence_atom_result(atom_text, path: str | None = None) -> str:
    result = persist_evidence_atom(atom_text, path)
    if result.startswith("ASSUME-EVIDENCE-PERSISTED"):
        return f"(AssumeEvidencePersisted {assume._atom_symbol(result)})"
    return f"(AssumeEvidencePersistError {assume._atom_symbol(result)})"


def persist_writeback_delta(domain, situation, delta_repr, path: str | None = None) -> str:
    """Persist only reviewed AssumeUpdatedFeatureEdge deltas.

    This intentionally does not export a whole AtomSpace. Temporary/rebound
    &assume spaces can be useful for tests, but they must never overwrite the
    canonical graph. The commit unit is the reviewed edge delta.
    """
    target = pathlib.Path(path) if path else ASSUME_PATH
    domain = str(domain)
    try:
        edges = _updated_feature_edges(str(delta_repr or ""), domain)
        text = target.read_text(encoding="utf-8") if target.exists() else ""
        updated = 0
        appended = 0
        for feature, action, weight, confidence, evidence in edges:
            text, count, _atom = _replace_feature_edge_atom(
                text,
                domain,
                feature,
                action,
                weight,
                confidence,
                evidence,
            )
            if count:
                updated += 1
            else:
                raise ValueError(
                    "missing canonical AssumeFeatureEdge for "
                    f"{domain}/{feature}/{action}; structural growth needs explicit delta atoms"
                )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return (
            f"ASSUME-DELTA-PERSISTED path={target} domain={assume._atom_symbol(domain)} "
            f"situation={assume._atom_symbol(situation)} updated={updated} appended={appended}"
        )
    except Exception as exc:
        return f"ASSUME-DELTA-PERSIST-ERROR {type(exc).__name__}: {exc}"


def commit_growth_edge(domain, situation, proposal_repr, review_repr, atoms_repr, reason="", path: str | None = None) -> str:
    """Persist one explicitly reviewed structural growth edge.

    This is the structural-growth membrane. Fabric may propose a missing edge,
    but the agent must first produce an acceptable MeTTa review. Only then do we add
    the canonical edge, reload the warm graph, verify prediction is possible,
    and record a quiet mutation trace.
    """
    target = pathlib.Path(path) if path else ASSUME_PATH
    domain = str(domain)
    situation = str(situation)
    try:
        feature, action, weight, confidence, evidence, proposal_reason = _matching_growth_proposal(
            str(proposal_repr or ""),
            domain,
            situation,
        )
        expectation, target_truth, review_confidence, conflict, pressure = _accepted_growth_review(
            str(review_repr or ""),
            domain,
            situation,
            feature,
            action,
        )
        atom_text = str(atoms_repr or "")
        if _feature_edge_exists(atom_text, domain, feature, action):
            raise ValueError(f"canonical AssumeFeatureEdge already exists for {domain}/{feature}/{action}")
        context, actions, edges, _feedback = assume.atomspace_feature_graph(atom_text, domain, situation)
        assume.validate_feature_graph(atom_text, context, actions, edges)
        active_features = {item.feature for item in context}
        if feature not in active_features:
            raise ValueError(f"feature is not active in situation: {feature}")
        if action not in set(actions):
            raise ValueError(f"action is not known in domain/situation: {action}")

        text = target.read_text(encoding="utf-8") if target.exists() else ""
        if _feature_edge_exists(text, domain, feature, action):
            raise ValueError(f"target already contains AssumeFeatureEdge for {domain}/{feature}/{action}")

        edge_atom = (
            f"(AssumeFeatureEdge {assume._atom_symbol(domain)} {assume._atom_symbol(feature)} "
            f"{assume._atom_symbol(action)} {weight:.12g} {confidence:.12g} {evidence:.12g})"
        )
        accepted_atom = (
            f"(AssumeAcceptedFeatureEdge {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
            f"{weight:.12g} {confidence:.12g} {evidence:.12g} "
            f"{assume._atom_symbol(proposal_reason)} {assume._atom_symbol(str(reason or 'reviewed-growth'))})"
        )
        review_atom = (
            f"(AssumeGrowthReview symbolic-review {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} acceptable "
            f"{expectation:.12g} {target_truth:.12g} {review_confidence:.12g} {conflict:.12g} {pressure:.12g})"
        )
        block = "\n".join(["", edge_atom, accepted_atom, review_atom, ""])
        target.parent.mkdir(parents=True, exist_ok=True)
        previous_text = text
        grown_text = text.rstrip() + block
        grown_atoms = atom_text.rstrip() + block
        target.write_text(grown_text, encoding="utf-8")
        try:
            loaded = reload(domain, situation, grown_atoms)
            if not loaded.startswith("ASSUME-RELOADED"):
                raise RuntimeError(loaded)
            prediction = audit(domain, situation, action, grown_atoms)
            matched_score = None
            for row in assume._atom_rows(prediction, "AssumePrediction"):
                if len(row) >= 4 and row[0] == domain and row[1] == situation and row[2] == action:
                    matched_score = assume._to_float(row[3])
                    break
            if matched_score is None:
                raise RuntimeError(f"accepted edge not visible in audit: {prediction}")
        except Exception:
            target.write_text(previous_text, encoding="utf-8")
            try:
                reload(domain, situation, atom_text)
            except Exception:
                pass
            raise
        trace_payload = f"({edge_atom} {accepted_atom} {review_atom})"
        trace = record_trace(domain, situation, trace_payload)
        return (
            f"(AssumeGrowthCommitted {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
            f"{weight:.12g} {confidence:.12g} {evidence:.12g} "
            f"(Score {matched_score:.12g}) (Reload {assume._atom_symbol(loaded)}) "
            f"(Trace {assume._atom_symbol(trace)}))"
        )
    except Exception as exc:
        return (
            f"(AssumeGrowthCommitError {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(str(exc))})"
        )


def commit_growth_edge_explicit(
    domain,
    situation,
    feature,
    action,
    weight,
    confidence,
    evidence,
    proposal_reason,
    decision,
    expectation,
    target_truth,
    review_confidence,
    conflict,
    pressure,
    atoms_repr,
    reason="",
) -> str:
    proposal = (
        f"(AssumeProposedFeatureEdge {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
        f"{assume._to_float(weight):.12g} {assume._to_float(confidence):.12g} {assume._to_float(evidence):.12g} "
        f"{assume._atom_symbol(proposal_reason)})"
    )
    review = (
        f"(AssumeGrowthJudgement symbolic-review {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
        f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} {assume._atom_symbol(decision)} "
        f"{assume._to_float(expectation):.12g} {assume._to_float(target_truth):.12g} "
        f"{assume._to_float(review_confidence):.12g} {assume._to_float(conflict):.12g} "
        f"{assume._to_float(pressure):.12g})"
    )
    return commit_growth_edge(domain, situation, proposal, review, atoms_repr, reason)


def commit_adjustment_explicit(
    domain,
    situation,
    feature,
    action,
    weight,
    confidence,
    evidence,
    proposal_direction,
    decision,
    old,
    new,
    delta,
    target_truth,
    score,
    signed_error,
    pressure,
    review_direction,
    conflict,
    atoms_repr,
    reason="",
    path: str | None = None,
) -> str:
    """Persist one reviewed weight adjustment and reload the warm graph.

    This is deliberately narrower than assume-apply-writeback: the agent chooses a
    specific reviewed edge, and the commit fails closed unless the MeTTa review
    says acceptable.
    """
    target_path = pathlib.Path(path) if path else ASSUME_PATH
    domain = str(domain)
    situation = str(situation)
    feature = str(feature)
    action = str(action)
    try:
        weight_f = assume._to_float(weight)
        confidence_f = assume._to_float(confidence)
        evidence_f = assume._to_float(evidence)
        old_f = assume._to_float(old)
        new_f = assume._to_float(new)
        delta_f = assume._to_float(delta)
        target_f = assume._to_float(target_truth)
        score_f = assume._to_float(score)
        signed_error_f = assume._to_float(signed_error)
        pressure_f = assume._to_float(pressure)
        conflict_f = assume._to_float(conflict)
        decision = str(decision)
        proposal_direction = str(proposal_direction)
        review_direction = str(review_direction)
        if decision != "acceptable":
            raise ValueError(f"adjustment review decision is {decision}, not acceptable")
        if proposal_direction != review_direction:
            raise ValueError(f"proposal/review direction mismatch: {proposal_direction} != {review_direction}")
        if proposal_direction == "hold":
            raise ValueError("hold direction cannot be committed")
        if abs(weight_f - new_f) > 1e-9:
            raise ValueError(f"proposal weight {weight_f:.12g} does not match reviewed new weight {new_f:.12g}")
        if abs(delta_f) <= 1e-9:
            raise ValueError("adjustment delta must be non-zero")
        if pressure_f <= 0:
            raise ValueError("adjustment pressure must be positive")
        if conflict_f >= 0.6:
            raise ValueError(f"adjustment conflict too high: {conflict_f:.12g}")

        atom_text = str(atoms_repr or "")
        runtime_rows = _matching_feature_edge_rows(atom_text, domain, feature, action)
        if len(runtime_rows) != 1:
            raise ValueError(
                f"expected exactly one runtime AssumeFeatureEdge for {domain}/{feature}/{action}, "
                f"found {len(runtime_rows)}"
            )
        runtime_old = assume._to_float(runtime_rows[0][3])
        if abs(runtime_old - old_f) > 1e-9:
            raise ValueError(f"runtime old weight {runtime_old:.12g} does not match reviewed old weight {old_f:.12g}")

        text = target_path.read_text(encoding="utf-8") if target_path.exists() else ""
        file_rows = _matching_feature_edge_rows(text, domain, feature, action)
        if len(file_rows) != 1:
            raise ValueError(
                f"expected exactly one canonical AssumeFeatureEdge for {domain}/{feature}/{action}, "
                f"found {len(file_rows)}"
            )
        file_old = assume._to_float(file_rows[0][3])
        if abs(file_old - old_f) > 1e-9:
            raise ValueError(f"canonical old weight {file_old:.12g} does not match reviewed old weight {old_f:.12g}")

        updated_text, file_count, edge_atom = _replace_feature_edge_atom(
            text,
            domain,
            feature,
            action,
            weight_f,
            confidence_f,
            evidence_f,
        )
        updated_atoms, runtime_count, _runtime_edge = _replace_feature_edge_atom(
            atom_text,
            domain,
            feature,
            action,
            weight_f,
            confidence_f,
            evidence_f,
        )
        if file_count != 1 or runtime_count != 1:
            raise ValueError("edge replacement failed")

        accepted_atom = (
            f"(AssumeAcceptedAdjustment {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
            f"{weight_f:.12g} {confidence_f:.12g} {evidence_f:.12g} "
            f"{assume._atom_symbol(proposal_direction)} {assume._atom_symbol(str(reason or 'reviewed-adjustment'))})"
        )
        review_atom = (
            f"(AssumeAdjustmentReview symbolic-review {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} acceptable "
            f"{old_f:.12g} {new_f:.12g} {delta_f:.12g} {target_f:.12g} {score_f:.12g} "
            f"{signed_error_f:.12g} {pressure_f:.12g} {assume._atom_symbol(review_direction)} {conflict_f:.12g})"
        )
        block = "\n".join(["", accepted_atom, review_atom, ""])
        previous_text = text
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(updated_text.rstrip() + block, encoding="utf-8")
        reloaded_atoms = updated_atoms.rstrip() + block
        try:
            loaded = reload(domain, situation, reloaded_atoms)
            if not loaded.startswith("ASSUME-RELOADED"):
                raise RuntimeError(loaded)
            prediction = audit(domain, situation, action, reloaded_atoms)
            matched_score = None
            for row in assume._atom_rows(prediction, "AssumePrediction"):
                if len(row) >= 4 and row[0] == domain and row[1] == situation and row[2] == action:
                    matched_score = assume._to_float(row[3])
                    break
            if matched_score is None:
                raise RuntimeError(f"accepted adjustment not visible in audit: {prediction}")
        except Exception:
            target_path.write_text(previous_text, encoding="utf-8")
            try:
                reload(domain, situation, atom_text)
            except Exception:
                pass
            raise
        trace_payload = f"({edge_atom} {accepted_atom} {review_atom})"
        trace = record_trace(domain, situation, trace_payload)
        return (
            f"(AssumeAdjustmentCommitted {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(feature)} {assume._atom_symbol(action)} "
            f"{weight_f:.12g} {confidence_f:.12g} {evidence_f:.12g} "
            f"(Score {matched_score:.12g}) (Reload {assume._atom_symbol(loaded)}) "
            f"(Trace {assume._atom_symbol(trace)}))"
        )
    except Exception as exc:
        return (
            f"(AssumeAdjustmentCommitError {assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(str(exc))})"
        )


def commit_writeback_delta(domain, situation, delta_repr) -> str:
    """Persist a reviewed writeback delta, then mark the warm graph clean.

    If the canonical file commit fails, the Fabric graph intentionally remains
    dirty so the agent can retry, discard, or inspect the mismatch.
    """
    persisted = persist_writeback_delta(domain, situation, delta_repr)
    if not persisted.startswith("ASSUME-DELTA-PERSISTED"):
        return f"ASSUME-COMMIT-ERROR persist={assume._atom_symbol(persisted)}"
    clean = mark_clean(domain, situation)
    if not clean.startswith("ASSUME-MARKED-CLEAN"):
        return f"ASSUME-COMMIT-ERROR persist={assume._atom_symbol(persisted)} clean={assume._atom_symbol(clean)}"
    trace = record_trace(domain, situation, delta_repr)
    if not trace.startswith("ASSUME-TRACE-RECORDED"):
        return f"ASSUME-COMMIT-WARNING persist={assume._atom_symbol(persisted)} clean={assume._atom_symbol(clean)} trace={assume._atom_symbol(trace)}"
    return f"ASSUME-COMMITTED persist={assume._atom_symbol(persisted)} clean={assume._atom_symbol(clean)} trace={assume._atom_symbol(trace)}"


def commit_writeback_delta_result(domain, situation, delta_repr) -> str:
    result = commit_writeback_delta(domain, situation, delta_repr)
    if result.startswith("ASSUME-COMMITTED") or result.startswith("ASSUME-COMMIT-WARNING"):
        return (
            f"(AssumeWritebackCommitSucceeded {assume._atom_symbol(domain)} "
            f"{assume._atom_symbol(situation)} {assume._atom_symbol(result)})"
        )
    return (
        f"(AssumeWritebackCommitError {assume._atom_symbol(domain)} "
        f"{assume._atom_symbol(situation)} {assume._atom_symbol(result)})"
    )


def _top_level_atom_texts(text: Any) -> list[str]:
    """Split a MeTTa atom bundle into direct atom strings, preserving quotes."""
    source = str(text or "").strip()
    if not source:
        return []

    def scan(segment: str) -> list[str]:
        atoms: list[str] = []
        start: int | None = None
        depth = 0
        in_quote = False
        escaped = False
        for index, ch in enumerate(segment):
            if in_quote:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_quote = False
                continue
            if ch == '"':
                in_quote = True
            elif ch == "(":
                if depth == 0:
                    start = index
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and start is not None:
                    atoms.append(segment[start:index + 1])
                    start = None
        return atoms

    atoms = scan(source)
    if len(atoms) == 1 and atoms[0].startswith("(") and atoms[0].endswith(")"):
        inner = atoms[0][1:-1].strip()
        inner_atoms = scan(inner)
        if inner_atoms:
            return inner_atoms
    return atoms


def record_trace(domain, situation, writes_repr) -> str:
    try:
        TRACE_PATH.parent.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        rows = [(
            f"(AssumeMutationTrace {assume._atom_symbol(stamp)} "
            f"{assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
            f"{assume._atom_symbol(str(writes_repr or ''))})\n"
        )]
        for atom_text in _top_level_atom_texts(writes_repr):
            rows.append(
                f"(AssumeMutation {assume._atom_symbol(stamp)} "
                f"{assume._atom_symbol(domain)} {assume._atom_symbol(situation)} "
                f"{atom_text})\n"
            )
        with TRACE_PATH.open("a", encoding="utf-8") as handle:
            handle.write("".join(rows))
        return f"ASSUME-TRACE-RECORDED path={TRACE_PATH}"
    except Exception as exc:
        return f"ASSUME-TRACE-ERROR {type(exc).__name__}: {exc}"


def trace(limit=20) -> str:
    try:
        if not TRACE_PATH.exists():
            return "()"
        rows = TRACE_PATH.read_text(encoding="utf-8").splitlines()
        try:
            count = max(1, int(float(str(limit))))
        except Exception:
            count = 20
        return "\n".join(rows[-count:])
    except Exception as exc:
        return f"ASSUME-TRACE-ERROR {type(exc).__name__}: {exc}"


def discard(domain, situation, atoms_repr) -> str:
    try:
        result = reload(domain, situation, atoms_repr)
        if result.startswith("ASSUME-RELOADED"):
            return result.replace("ASSUME-RELOADED", "ASSUME-DISCARDED", 1)
        return result.replace("ASSUME-RELOADED-ERROR", "ASSUME-DISCARD-ERROR", 1)
    except Exception as exc:
        return f"ASSUME-DISCARD-ERROR {type(exc).__name__}: {exc}"


def apply_writeback(domain, situation) -> str:
    # MeTTa applies writeback atomically into &assume. This function only returns
    # the candidate atoms, preserving the daemon as non-canonical.
    return writeback(domain, situation)


def _cleanup() -> None:
    try:
        stop()
    except Exception:
        pass


atexit.register(_cleanup)
