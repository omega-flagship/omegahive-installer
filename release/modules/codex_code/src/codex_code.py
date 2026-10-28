"""Codex CLI coding organ for OmegaClaw.

This is a body/skill membrane. the agent remains the reasoning system; this module
runs a specialist coding harness and returns a compact, inspectable trace.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import hashlib
import re
from typing import Iterable

ROOT = pathlib.Path(__file__).resolve().parents[3]
OMEGA_ROOT = ROOT.parents[1]
TRACE_FILE = ROOT / "memory" / "runtime" / "codex_code" / "trace.jsonl"
JOBS_DIR = ROOT / "memory" / "runtime" / "codex_code" / "jobs"
EVENTS_FILE = ROOT / "memory" / "runtime" / "codex_code" / "events.metta"
DEFAULT_PROFILE = os.environ.get("OMEGACLAW_CODEX_PROFILE", "qwen-coder-next")
DEFAULT_MODEL = os.environ.get("OMEGACLAW_CODEX_MODEL", "qwen/qwen3-coder-next")
DEFAULT_CWD = pathlib.Path(os.environ.get("OMEGACLAW_CODEX_CWD", str(ROOT)))
DEFAULT_TIMEOUT = int(os.environ.get("OMEGACLAW_CODEX_TIMEOUT", "240"))
MAX_RETURN_CHARS = int(os.environ.get("OMEGACLAW_CODEX_MAX_RETURN_CHARS", "6000"))
MAX_ACTIVE_JOBS = int(os.environ.get("OMEGACLAW_CODEX_MAX_ACTIVE_JOBS", "1"))
VALID_SANDBOXES = {"read-only", "workspace-write", "danger-full-access"}


def _codex_bin() -> str | None:
    candidates = [
        os.environ.get("OMEGACLAW_CODEX_BIN"),
        str(pathlib.Path.home() / ".local" / "bin" / "codex"),
        str(pathlib.Path.home() / ".local" / "node_modules" / ".bin" / "codex"),
        shutil.which("codex"),
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).exists():
            return candidate
    return shutil.which("codex")


def _trace(event: dict) -> None:
    TRACE_FILE.parent.mkdir(parents=True, exist_ok=True)
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **event}
    with TRACE_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _tail(text: str, limit: int = MAX_RETURN_CHARS) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit // 2] + "\n...<codex-code-truncated>...\n" + text[-limit // 2 :]


def _atom_symbol(value: object) -> str:
    text = str(value).strip().lower()
    text = re.sub(r"[^a-z0-9_.:/-]+", "-", text)
    text = text.strip("-")
    return text or "unknown"


def _atom_string(value: object) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _job_symbol(value: object) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value)).strip("-") or "unknown"


def _job_dir(job_id: str) -> pathlib.Path:
    return JOBS_DIR / _job_symbol(job_id)


def _job_state_path(job_id: str) -> pathlib.Path:
    return _job_dir(job_id) / "state.json"


def _job_result_path(job_id: str) -> pathlib.Path:
    return _job_dir(job_id) / "result.txt"


def _read_job_state(job_id: str) -> dict | None:
    path = _job_state_path(job_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_job_state(state: dict) -> None:
    job_id = _job_symbol(state["id"])
    job_dir = _job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    tmp = job_dir / "state.json.tmp"
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(job_dir / "state.json")


def _pid_process_state(pid: int) -> str | None:
    stat_path = pathlib.Path("/proc") / str(pid) / "stat"
    try:
        text = stat_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    try:
        return text.split(") ", 1)[1].split()[0]
    except IndexError:
        return None


def _pid_alive(pid: object) -> bool:
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_int <= 0:
        return False
    if _pid_process_state(pid_int) == "Z":
        return False
    try:
        os.kill(pid_int, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _reap_worker(worker: subprocess.Popen) -> None:
    try:
        worker.wait()
    except Exception:
        pass


def _start_worker_reaper(worker: subprocess.Popen) -> None:
    threading.Thread(target=_reap_worker, args=(worker,), daemon=True).start()


def _list_job_states() -> list[dict]:
    if not JOBS_DIR.exists():
        return []
    states: list[dict] = []
    for path in JOBS_DIR.glob("*/state.json"):
        try:
            states.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(states, key=lambda item: item.get("created_at", ""), reverse=True)


def _refresh_stale_running_jobs() -> None:
    for state in _list_job_states():
        if state.get("status") == "running" and not _pid_alive(state.get("worker_pid")):
            state["status"] = "stale"
            state["finished_at"] = _now_iso()
            state["summary"] = "worker process is no longer running and did not write a completion event"
            _write_job_state(state)
            _append_event_atom(
                "CodexJobStale",
                state["id"],
                state.get("mode", "unknown"),
                state["summary"],
                state.get("result_path", ""),
            )


def _active_jobs() -> list[dict]:
    _refresh_stale_running_jobs()
    return [state for state in _list_job_states() if state.get("status") == "running"]


def _append_event_atom(kind: str, job_id: str, mode: str, summary: str, path: str = "") -> None:
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    atom = (
        f"({kind} {_job_symbol(job_id)} {_atom_symbol(mode)} "
        f"{_atom_string(summary)} {_atom_string(path)} {_atom_string(_now_iso())})"
    )
    with EVENTS_FILE.open("a", encoding="utf-8") as handle:
        handle.write(atom + "\n")


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _codex_sandbox(readonly: bool) -> str:
    env_name = "OMEGACLAW_CODEX_SANDBOX_READONLY" if readonly else "OMEGACLAW_CODEX_SANDBOX_EDIT"
    default = "read-only" if readonly else "workspace-write"
    sandbox = os.environ.get(env_name, default).strip() or default
    if sandbox not in VALID_SANDBOXES:
        raise ValueError(f"{env_name} must be one of {sorted(VALID_SANDBOXES)}")
    return sandbox


def _codex_sandbox_args(readonly: bool) -> tuple[str, bool, list[str]]:
    sandbox = _codex_sandbox(readonly)
    if _env_flag("OMEGACLAW_CODEX_DANGEROUS_BYPASS"):
        return sandbox, True, ["--dangerously-bypass-approvals-and-sandbox"]
    return sandbox, False, ["--sandbox", sandbox]


def _containment_mode(dangerous_bypass: bool) -> str:
    return "vm-boundary" if dangerous_bypass else "codex-sandbox"


def _containment_level(status: dict) -> str:
    if status["sandbox_error"]:
        return "invalid-config"
    if status["dangerous_bypass"]:
        return "deployment-vm-boundary"
    return "codex-cli-sandbox"


def _status_dict() -> dict:
    bin_path = _codex_bin()
    try:
        readonly_sandbox = _codex_sandbox(True)
        edit_sandbox = _codex_sandbox(False)
        sandbox_error = ""
    except ValueError as exc:
        readonly_sandbox = "invalid"
        edit_sandbox = "invalid"
        sandbox_error = str(exc)
    return {
        "codex_bin": bin_path or "missing",
        "codex_present": bool(bin_path),
        "profile": DEFAULT_PROFILE,
        "model": DEFAULT_MODEL,
        "openrouter_key_present": bool(os.environ.get("OPENROUTER_API_KEY")),
        "cwd": str(DEFAULT_CWD),
        "trace": str(TRACE_FILE),
        "jobs_dir": str(JOBS_DIR),
        "events": str(EVENTS_FILE),
        "max_active_jobs": MAX_ACTIVE_JOBS,
        "sandbox_readonly": readonly_sandbox,
        "sandbox_edit": edit_sandbox,
        "dangerous_bypass": _env_flag("OMEGACLAW_CODEX_DANGEROUS_BYPASS"),
        "sandbox_error": sandbox_error,
    }


def codex_code_status() -> str:
    status = _status_dict()
    version = "unknown"
    if status["codex_present"]:
        try:
            result = subprocess.run(
                [status["codex_bin"], "--version"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=10,
            )
            version = result.stdout.strip() or "unknown"
        except Exception as exc:  # pragma: no cover - status path
            version = f"error:{type(exc).__name__}"
    return (
        f"CODEX-CODE-STATUS present={status['codex_present']} version={version} "
        f"profile={status['profile']} model={status['model']} "
        f"openrouter_key={status['openrouter_key_present']} cwd={status['cwd']} "
        f"jobs_dir={status['jobs_dir']} max_active_jobs={status['max_active_jobs']} "
        f"sandbox_readonly={status['sandbox_readonly']} sandbox_edit={status['sandbox_edit']} "
        f"dangerous_bypass={status['dangerous_bypass']} "
        f"containment={_containment_mode(status['dangerous_bypass'])}"
    )


def codex_code_atoms() -> str:
    status = _status_dict()
    containment = _containment_mode(status["dangerous_bypass"])
    bypass_state = "active" if status["dangerous_bypass"] else "inactive"
    containment_level = _containment_level(status)
    atoms = [
        f"(CodexCodeContainment codex-code {containment})",
        f"(CodexCodeContainmentLevel codex-code {containment_level})",
        f"(CodexCodeSandboxBypass codex-code {bypass_state})",
        f"(CodexCodeSandboxReadonly codex-code {_atom_symbol(status['sandbox_readonly'])})",
        f"(CodexCodeSandboxEdit codex-code {_atom_symbol(status['sandbox_edit'])})",
        f"(CodexCodeModel codex-code {_atom_string(status['model'])})",
        f"(CodexCodeProfile codex-code {_atom_string(status['profile'])})",
        f"(CodexCodeWorkingDirectory codex-code {_atom_string(status['cwd'])})",
        f"(CodexCodeTrace codex-code {_atom_string(status['trace'])})",
        f"(CodexCodeJobsDirectory codex-code {_atom_string(status['jobs_dir'])})",
        f"(CodexCodeEvents codex-code {_atom_string(status['events'])})",
        f"(CodexCodeMaxActiveJobs codex-code {status['max_active_jobs']})",
    ]
    if status["sandbox_error"]:
        atoms.append(f"(CodexCodeSandboxConfigError codex-code {_atom_string(status['sandbox_error'])})")
    return "CODEX-CODE-ATOMS\n" + "\n".join(atoms)


def codex_code_containment_check() -> str:
    status = _status_dict()
    containment = _containment_mode(status["dangerous_bypass"])
    level = _containment_level(status)
    if status["sandbox_error"]:
        verdict = "invalid-config"
        note = status["sandbox_error"]
    elif status["dangerous_bypass"]:
        verdict = "vm-boundary-required"
        note = "Codex CLI sandbox is bypassed; containment depends on the surrounding VM boundary and host policy."
    else:
        verdict = "codex-sandbox-active"
        note = "Codex CLI sandbox flags are active; containment still depends on Codex CLI behavior and host policy."
    atoms = [
        f"(CodexCodeContainmentCheck codex-code {verdict})",
        f"(CodexCodeContainment codex-code {containment})",
        f"(CodexCodeContainmentLevel codex-code {level})",
        f"(CodexCodeSandboxBypass codex-code {'active' if status['dangerous_bypass'] else 'inactive'})",
    ]
    return (
        f"CODEX-CODE-CONTAINMENT verdict={verdict} containment={containment} "
        f"level={level} readonly={status['sandbox_readonly']} edit={status['sandbox_edit']} "
        f"note={note}\n" + "\n".join(atoms)
    )


def _run_codex(task: str, *, readonly: bool) -> str:
    task = str(task).strip()
    if not task:
        return "CODEX-CODE-ERROR empty task"

    status = _status_dict()
    if not status["codex_present"]:
        return "CODEX-CODE-ERROR codex CLI not found"
    if not status["openrouter_key_present"]:
        return "CODEX-CODE-ERROR OPENROUTER_API_KEY missing from this process environment"

    cwd = DEFAULT_CWD
    cwd.mkdir(parents=True, exist_ok=True)
    mode = "readonly" if readonly else "edit"
    try:
        sandbox, dangerous_bypass, sandbox_args = _codex_sandbox_args(readonly)
    except ValueError as exc:
        return f"CODEX-CODE-ERROR mode={mode} invalid sandbox config: {exc}"
    containment = _containment_mode(dangerous_bypass)

    prompt = (
        "You are a specialist coding organ called by OmegaClaw. "
        "Stay scoped to the requested task. Preserve the architecture. "
        + ("Read-only mode: inspect and report; do not edit files. " if readonly else "")
        + "Report what you changed, what you tested, and any residual risk.\n\n"
        + f"Task:\n{task}"
    )

    with tempfile.TemporaryDirectory(prefix="omegaclaw-codex-") as tmp:
        out_file = pathlib.Path(tmp) / "last_message.txt"
        command = [
            status["codex_bin"],
            "exec",
            "--profile",
            DEFAULT_PROFILE,
            "--skip-git-repo-check",
            "--ephemeral",
            "--json",
            "-C",
            str(cwd),
            *sandbox_args,
            "--output-last-message",
            str(out_file),
            prompt,
        ]
        start = time.time()
        try:
            result = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                timeout=DEFAULT_TIMEOUT,
            )
            elapsed = round(time.time() - start, 3)
        except subprocess.TimeoutExpired as exc:
            _trace(
                {
                    "mode": mode,
                    "sandbox": sandbox,
                    "dangerous_bypass": dangerous_bypass,
                    "containment": containment,
                    "task": task[:500],
                    "status": "timeout",
                    "timeout": DEFAULT_TIMEOUT,
                }
            )
            return (
                f"CODEX-CODE-TIMEOUT mode={mode} sandbox={sandbox} "
                f"timeout={DEFAULT_TIMEOUT}s output={_tail(exc.stdout or '')}"
            )

        final = out_file.read_text(encoding="utf-8", errors="replace") if out_file.exists() else ""
        stdout_tail = _tail(result.stdout or "", 2500)
        final_tail = _tail(final or stdout_tail)
        usage = _usage_from_jsonl(result.stdout.splitlines())
        if result.returncode != 0:
            _trace(
                {
                    "mode": mode,
                    "sandbox": sandbox,
                    "dangerous_bypass": dangerous_bypass,
                    "containment": containment,
                    "task": task[:1000],
                    "status": "error",
                    "returncode": result.returncode,
                    "elapsed_sec": elapsed,
                    "usage": usage,
                    "final": final_tail[:2000],
                }
            )
            return (
                f"CODEX-CODE-ERROR mode={mode} sandbox={sandbox} "
                f"exit={result.returncode} elapsed={elapsed}s output={stdout_tail}"
            )
        if not final_tail or ("turn.started" in final_tail and "item.completed" not in final_tail):
            _trace(
                {
                    "mode": mode,
                    "sandbox": sandbox,
                    "dangerous_bypass": dangerous_bypass,
                    "containment": containment,
                    "task": task[:1000],
                    "status": "incomplete",
                    "returncode": result.returncode,
                    "elapsed_sec": elapsed,
                    "usage": usage,
                    "final": final_tail[:2000],
                }
            )
            return (
                f"CODEX-CODE-INCOMPLETE mode={mode} sandbox={sandbox} "
                f"containment={containment} elapsed={elapsed}s output={stdout_tail}"
            )
        _trace(
            {
                "mode": mode,
                "sandbox": sandbox,
                "dangerous_bypass": dangerous_bypass,
                "containment": containment,
                "task": task[:1000],
                "status": "ok",
                "returncode": result.returncode,
                "elapsed_sec": elapsed,
                "usage": usage,
                "final": final_tail[:2000],
            }
        )
        usage_text = f" usage={usage}" if usage else ""
        return (
            f"CODEX-CODE-OK mode={mode} sandbox={sandbox} containment={containment} "
            f"elapsed={elapsed}s{usage_text}\n{final_tail}"
        )


def _usage_from_jsonl(lines: Iterable[str]) -> dict:
    usage = {}
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("type") == "turn.completed" and isinstance(item.get("usage"), dict):
            usage = item["usage"]
    return usage


def codex_code(task: str) -> str:
    return _run_codex(task, readonly=False)


def codex_code_readonly(task: str) -> str:
    return _run_codex(task, readonly=True)


def _new_job_id(task: str, *, readonly: bool) -> str:
    digest = hashlib.sha256(f"{time.time_ns()}:{readonly}:{task}".encode("utf-8")).hexdigest()[:12]
    return f"codex-{digest}"


def _start_codex_job(task: str, *, readonly: bool) -> str:
    task = str(task).strip()
    if not task:
        return "CODEX-CODE-JOB-ERROR empty task"
    active = _active_jobs()
    if len(active) >= MAX_ACTIVE_JOBS:
        active_id = active[0].get("id", "unknown")
        return f"CODEX-CODE-JOB-REJECTED active={active_id} reason=max-active-jobs"

    status = _status_dict()
    if not status["codex_present"]:
        return "CODEX-CODE-JOB-ERROR codex CLI not found"
    if not status["openrouter_key_present"]:
        return "CODEX-CODE-JOB-ERROR OPENROUTER_API_KEY missing from this process environment"

    mode = "readonly" if readonly else "edit"
    job_id = _new_job_id(task, readonly=readonly)
    result_path = str(_job_result_path(job_id))
    state = {
        "id": job_id,
        "mode": mode,
        "readonly": readonly,
        "status": "starting",
        "task": task,
        "task_sha256": hashlib.sha256(task.encode("utf-8")).hexdigest(),
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "timeout": DEFAULT_TIMEOUT,
        "result_path": result_path,
    }
    _write_job_state(state)

    worker = subprocess.Popen(
        [sys.executable, str(pathlib.Path(__file__).resolve()), "--worker", job_id],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    _start_worker_reaper(worker)
    state["status"] = "running"
    state["worker_pid"] = worker.pid
    state["updated_at"] = _now_iso()
    _write_job_state(state)
    _trace({"mode": mode, "status": "job-started", "job_id": job_id, "task": task[:1000]})
    _append_event_atom("CodexJobStarted", job_id, mode, task[:500], str(_job_state_path(job_id)))
    return (
        f"CODEX-CODE-JOB-STARTED id={job_id} mode={mode} "
        f"status=running state={_job_state_path(job_id)} result={result_path}"
    )


def codex_code_start(task: str) -> str:
    return _start_codex_job(task, readonly=False)


def codex_code_readonly_start(task: str) -> str:
    return _start_codex_job(task, readonly=True)


def codex_code_jobs() -> str:
    _refresh_stale_running_jobs()
    states = _list_job_states()[:12]
    if not states:
        return "CODEX-CODE-JOBS empty"
    lines = [
        (
            f"{state.get('id')} status={state.get('status')} mode={state.get('mode')} "
            f"pid={state.get('worker_pid', 'none')} created={state.get('created_at')} "
            f"result={state.get('result_path')}"
        )
        for state in states
    ]
    return "CODEX-CODE-JOBS\n" + "\n".join(lines)


def codex_code_job_status(job_id: str) -> str:
    _refresh_stale_running_jobs()
    state = _read_job_state(str(job_id))
    if not state:
        return f"CODEX-CODE-JOB-STATUS id={_job_symbol(job_id)} status=missing"
    return (
        f"CODEX-CODE-JOB-STATUS id={state.get('id')} status={state.get('status')} "
        f"mode={state.get('mode')} pid={state.get('worker_pid', 'none')} "
        f"created={state.get('created_at')} finished={state.get('finished_at', 'none')} "
        f"result={state.get('result_path')}"
    )


def codex_code_result(job_id: str) -> str:
    state = _read_job_state(str(job_id))
    if not state:
        return f"CODEX-CODE-RESULT id={_job_symbol(job_id)} status=missing"
    result_path = pathlib.Path(state.get("result_path", ""))
    if not result_path.exists():
        return f"CODEX-CODE-RESULT id={state.get('id')} status={state.get('status')} result=not-ready"
    return f"CODEX-CODE-RESULT id={state.get('id')} status={state.get('status')}\n{_tail(result_path.read_text(encoding='utf-8', errors='replace'))}"


def codex_code_cancel(job_id: str) -> str:
    state = _read_job_state(str(job_id))
    if not state:
        return f"CODEX-CODE-CANCEL id={_job_symbol(job_id)} status=missing"
    if state.get("status") != "running":
        return f"CODEX-CODE-CANCEL id={state.get('id')} status={state.get('status')} no-op"
    pid = state.get("worker_pid")
    try:
        os.killpg(int(pid), signal.SIGTERM)
        cancelled = True
    except Exception:
        cancelled = False
    state["status"] = "cancelled" if cancelled else "cancel-request-failed"
    state["finished_at"] = _now_iso()
    state["updated_at"] = _now_iso()
    state["summary"] = "cancelled by the agent" if cancelled else "cancel request failed"
    _write_job_state(state)
    _trace({"mode": state.get("mode"), "status": state["status"], "job_id": state.get("id")})
    _append_event_atom("CodexJobCancelled", state["id"], state.get("mode", "unknown"), state["summary"], state.get("result_path", ""))
    return f"CODEX-CODE-CANCEL id={state.get('id')} status={state['status']}"


def codex_code_events() -> str:
    if not EVENTS_FILE.exists():
        return "CODEX-CODE-EVENTS empty"
    lines = EVENTS_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
    return "CODEX-CODE-EVENTS\n" + "\n".join(lines)


def codex_code_last_trace() -> str:
    if not TRACE_FILE.exists():
        return "CODEX-CODE-TRACE empty"
    lines = TRACE_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-8:]
    return "CODEX-CODE-TRACE\n" + "\n".join(lines)


def _worker(job_id: str) -> int:
    state = _read_job_state(job_id)
    if not state:
        return 2
    state["status"] = "running"
    state["worker_pid"] = os.getpid()
    state["updated_at"] = _now_iso()
    _write_job_state(state)
    mode = state.get("mode", "readonly")
    try:
        result_text = _run_codex(state.get("task", ""), readonly=bool(state.get("readonly", True)))
        result_path = _job_result_path(job_id)
        result_path.write_text(result_text, encoding="utf-8")
        if result_text.startswith("CODEX-CODE-OK"):
            result_status = "complete"
            event_kind = "CodexJobComplete"
        elif result_text.startswith("CODEX-CODE-TIMEOUT"):
            result_status = "timeout"
            event_kind = "CodexJobTimeout"
        elif result_text.startswith("CODEX-CODE-INCOMPLETE"):
            result_status = "incomplete"
            event_kind = "CodexJobIncomplete"
        else:
            result_status = "error"
            event_kind = "CodexJobError"
        state["status"] = result_status
        state["finished_at"] = _now_iso()
        state["updated_at"] = _now_iso()
        state["result_path"] = str(result_path)
        state["summary"] = _tail(result_text, 500)
        _write_job_state(state)
        _trace({"mode": mode, "status": f"job-{result_status}", "job_id": job_id, "result_path": str(result_path)})
        _append_event_atom(event_kind, job_id, mode, state["summary"], str(result_path))
        return 0 if result_status == "complete" else 1
    except Exception as exc:  # pragma: no cover - defensive worker boundary
        result_path = _job_result_path(job_id)
        result_text = f"CODEX-CODE-JOB-EXCEPTION {type(exc).__name__}: {exc}"
        result_path.write_text(result_text, encoding="utf-8")
        state["status"] = "error"
        state["finished_at"] = _now_iso()
        state["updated_at"] = _now_iso()
        state["result_path"] = str(result_path)
        state["summary"] = result_text
        _write_job_state(state)
        _trace({"mode": mode, "status": "job-exception", "job_id": job_id, "error": result_text})
        _append_event_atom("CodexJobError", job_id, mode, result_text, str(result_path))
        return 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        raise SystemExit(_worker(sys.argv[2]))
    raise SystemExit("usage: codex_code.py --worker JOB_ID")
