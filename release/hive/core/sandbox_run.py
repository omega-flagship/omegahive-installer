"""Run a pinned tool bundle for an app inside the OS sandbox (capability ``sandbox:run``).

Jon (2026-10-04): Studio is "another app within the hive app". The hive gives apps one generic, isolated way to run
their own tools; apps keep their own operations. Design proved the boundary (studio_sandbox.py, studio_limits.sh);
this is the platform's version of it.

- Who: an app that declares ``sandbox:run`` AND is on the operator's allowlist (HIVE_SANDBOX_RUN_APPS). Both.
- What: a bundle inside the app's own reviewed folder, checked file by file against the app's lock file
  (``<bundle>/bundle.lock.json``: {"files": {"rel/path": "<sha256>"}}) before every run. No other files may exist.
- Which runtime: by name from the operator's map (HIVE_SANDBOX_RUNTIMES, e.g. {"node": "/opt/homebrew/bin/node"}).
- Boundary: sandbox-exec on macOS; existing namespace/Landlock wrapper with no relay ports on Linux. Deny by default; reads = the bundle, the runtime's install
  prefix and system roots; writes = a fresh job folder only. A fixed launcher sets CPU and file-size limits.
  Scrubbed environment; the process group is killed on timeout or cancel. No sandbox → refuse (fail closed).
- Network (r14.4): none. macOS: every network clause is removed from the profile. Linux: a fresh network namespace
  with only loopback and no relay ports; the launcher verifies the namespace and exits 78 if it cannot, and this
  runner refuses a written profile that lists any port.
- available() is the same predicate run() enforces (r14.4, Root): a known boundary, the launcher present, and the
  launcher really able to set its limits here (on Linux: Landlock + namespaces + a working prlimit).
- Returns bytes, never interprets them: exit code, bounded stdout/stderr, and the declared output files.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
import os
import pathlib
import re
import shutil
import signal
import stat
import tempfile
import time

from ..supervisor.sandbox import MAC_SYSTEM_READ, backend, profile, safe_roots, tools_refused, wrap

LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / "supervisor" / "limits.sh"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
RUN_PATH = "/usr/bin:/bin"   # the PATH every tool run (and the availability pre-check) gets: prlimit must be on it
MAX_INPUT, MAX_OUTPUT, MAX_STDOUT, MAX_STDERR = 20 * 1024 * 1024, 30 * 1024 * 1024, 256 * 1024, 16 * 1024
MAX_ARTIFACTS = 32
MAX_CLEANUP_ENTRIES, MAX_CLEANUP_DEPTH = 16384, 64


class SandboxOutputLimit(RuntimeError):
    """The actual stream exceeded its live retention bound; partial bytes remain in sandbox_result."""


class SandboxCleanupError(RuntimeError):
    """A completed test process is not evidence of completed cleanup."""


def _failure(phase, error):
    # Host/framework errors only: never include captured project output in error messages.
    return {"phase": phase, "type": type(error).__name__, "message": str(error)[:512]}


async def _drain(reader, state, cap, observed_errors=None):
    """Retain at most cap bytes, count actual reads, and stop a flooding job immediately."""
    try:
        while True:
            chunk = await reader.read(min(65536, cap + 1))
            if not chunk:
                state["eof"] = True
                return
            state["bytes"] += len(chunk)
            remaining = cap - len(state["data"])
            state["data"].extend(chunk[:remaining])
            if state["bytes"] > cap:
                state["truncated"] = True
                raise SandboxOutputLimit("sandbox output limit exceeded")
    except BaseException as error:
        if observed_errors is not None and not isinstance(error, asyncio.CancelledError):
            observed_errors.append(error)
        raise


def _group_exists(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False


async def _cleanup_process(proc, tasks, deadline, cleanup, observed_errors=None, *, stop_group=True):
    """Bounded cleanup of original handles; diagnostics cannot gate later tails."""
    loop = asyncio.get_running_loop()
    shared = isinstance(observed_errors, _PhaseObservations)
    custody = observed_errors.state if shared else _ProcessPhase()
    observations = observed_errors if shared else _PhaseObservations(custody, observed_errors)

    def record(phase, error):
        # The first actual error is retained before formatting or append can fail.
        if not isinstance(error, asyncio.CancelledError):
            observations.append(error)
        custody.error(phase, error, cleanup)

    try:
        if stop_group and _group_exists(proc.pid):
            if proc.returncode is not None:
                raise SandboxCleanupError("group exists after root reaping; numeric identity is no longer signal authority")
            os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except BaseException as error:
        record("group-stop", error)
    try:
        if proc.returncode is None:
            await asyncio.wait_for(proc.wait(), max(0, deadline - loop.time()))
        cleanup["original_process_reaped"] = proc.returncode is not None
    except BaseException as error:
        record("process-wait", error)
    try:
        if stop_group:
            # Original generic/Darwin behavior and callback order are unchanged.
            if _group_exists(proc.pid):
                raise SandboxCleanupError("group still exists after root wait; retain unknown ownership")
            cleanup["original_group_absent"] = True
        else:
            # The original owned-leaf stop has already been requested. A
            # successful signal0 probe saying present is not terminal absence,
            # and no numeric group signal is authorized after original reap.
            custody.group_observation_until = deadline
            custody.group_observation_started = True
            while True:
                custody.group_observation_clock = loop.time()
                if custody.group_observation_first_clock is None:
                    custody.group_observation_first_clock = custody.group_observation_clock
                if custody.group_observation_clock >= deadline:
                    raise SandboxCleanupError("original resource group absence deadline expired")
                custody.group_observation_attempted = True
                custody.group_observation_returned = False
                custody.group_observation_count += 1
                custody.group_observation_present = _group_exists(proc.pid)
                custody.group_observation_returned = True  # raw probe return before clocks/diagnostics
                custody.group_observation_clock = loop.time()
                if custody.group_observation_clock >= deadline:
                    raise SandboxCleanupError("resource group observation returned after original deadline")
                if type(custody.group_observation_present) is not bool:
                    raise SandboxCleanupError("original resource group observation outcome unknown")
                if custody.group_observation_present is False:
                    cleanup["original_group_absent"] = True
                    break
                left = deadline - loop.time()
                if left <= 0:
                    raise SandboxCleanupError("original resource group absence deadline expired")
                await asyncio.sleep(min(.01, left))  # passive cooperative observation, no fresh grace
    except BaseException as error:
        if not stop_group:
            custody.group_observation_error = error
        record("group-absence", error)
    try:
        custody.drain_join_attempted = custody.drain_join_unknown = True
        custody.drain_join = asyncio.gather(*(task for task in tasks if task is not None), return_exceptions=True)
        custody.drain_join_unknown = False
        await asyncio.wait_for(asyncio.shield(custody.drain_join), max(0, deadline - loop.time()))
    except BaseException as error:
        # Allocation may schedule a join without returning its handle. Do not
        # recreate it; known original tasks and pipe transports still have tails.
        if custody.drain_join_unknown:
            custody.observation_incomplete = True
        record("pipe-drain", error)
    if cleanup["original_process_reaped"]:
        for fd in (1, 2):
            try:
                pipe = proc._transport.get_pipe_transport(fd)
                if pipe is not None:
                    pipe.close()
            except BaseException as error:
                record("pipe-close", error)
    for task in tasks:
        try:
            if task is not None and not task.done():
                task.cancel()
        except BaseException as error:
            record("pipe-cancel", error)
    # Inspect only returned original tasks. Each wait shares the original cleanup
    # deadline, even if cancellation is ignored or gather allocation was unknown.
    for task in tasks:
        if task is None:
            continue
        try:
            if not task.done():
                await asyncio.wait_for(asyncio.shield(task), max(0, deadline - loop.time()))
            if task.done():
                task.result()
        except asyncio.CancelledError:
            pass
        except SandboxOutputLimit:
            pass
        except BaseException as error:
            record("pipe-tail", error)
    if custody.observation_incomplete:
        cleanup["observation_incomplete"] = True
        cleanup["complete"] = False
        if not shared and custody.primary is not None:
            raise custody.primary


class _PhaseObservations:
    """Record the raw first observation before fallible shared diagnostics."""
    __slots__ = ("state", "target")

    def __init__(self, state, target):
        self.state, self.target = state, target

    def append(self, error):
        self.state.retain(error)
        if self.target is not None:
            try:
                self.target.append(error)
            except BaseException as reporting:
                if self.state.recording_error is None:
                    self.state.recording_error = reporting
                self.state.observation_incomplete = True


class _ProcessPhase:
    """Private original-handle state retained by the one run owner before spawn.

    The same state will be used for fixed limit/runtime probes and the workload.
    No public dispatcher, PID adoption, authority or replacement executor.
    """
    __slots__ = ("proc", "tasks", "spawn_attempted", "primary", "secondary",
                 "cleanup_task", "cleanup_coro", "cleanup_task_unknown", "bridge", "workspace",
                 "recording_error", "observation_incomplete", "drain_coros",
                 "drain_attempted", "drain_unknown", "observations",
                 "drain_join", "drain_join_attempted", "drain_join_unknown",
                 "group_observation_until", "group_observation_started", "group_observation_attempted",
                 "group_observation_returned", "group_observation_count", "group_observation_present",
                 "group_observation_clock", "group_observation_first_clock", "group_observation_error")

    def __init__(self, bridge=None):
        self.proc = None
        self.tasks = [None, None]   # preallocated slots: no append can lose a returned task
        self.drain_coros = [None, None]
        self.drain_attempted = [False, False]
        self.drain_unknown = [False, False]
        self.spawn_attempted = False
        self.primary = None
        self.secondary = []
        self.cleanup_task = self.cleanup_coro = None
        self.cleanup_task_unknown = False
        self.bridge = bridge
        self.workspace = None
        self.recording_error = None
        self.observation_incomplete = False
        self.observations = None
        self.drain_join = None
        self.drain_join_attempted = self.drain_join_unknown = False
        self.group_observation_until = self.group_observation_clock = self.group_observation_first_clock = None
        self.group_observation_started = self.group_observation_attempted = False
        self.group_observation_returned = False
        self.group_observation_count = 0
        self.group_observation_present = self.group_observation_error = None

    def retain(self, error):
        # Slot assignment preserves the raw first outcome before diagnostics.
        if self.primary is None:
            self.primary = error
        elif error is not self.primary:
            try:
                self.secondary.append(error)
            except BaseException as reporting:
                if self.recording_error is None:
                    self.recording_error = reporting
                self.observation_incomplete = True

    def error(self, phase, error, cleanup):
        self.retain(error)
        try:
            cleanup["errors"].append(_failure(phase, error))
        except BaseException as reporting:
            if self.recording_error is None:
                self.recording_error = reporting
            self.observation_incomplete = True


def _sender_monotonic_until(loop, original_until):
    """Translate exact observed numeric values, rounding each result down.

    Sender samples monotonic before loop time. Integer deadlines must retain
    their exact value: implicit int-to-float subtraction can expand the budget.
    """
    before = time.monotonic()
    after = loop.time()

    def ratio(value):
        if type(value) is int:
            return value, 1
        if type(value) is float and math.isfinite(value):
            return value.as_integer_ratio()
        raise ValueError("finite original deadline and clock observations required")

    un, ud = ratio(original_until)
    an, ad = ratio(after)
    bn, bd = ratio(before)
    numerator, denominator = un * ad - an * ud, ud * ad
    if numerator <= 0:
        raise TimeoutError("original sandbox deadline expired before phase handoff")
    try:
        remaining = math.nextafter(numerator / denominator, -math.inf)
    except OverflowError as error:
        raise ValueError("finite original remaining interval required") from error
    if not math.isfinite(remaining):
        raise ValueError("finite original remaining interval required")
    if remaining <= 0:
        raise TimeoutError("no conservatively representable child interval remains")
    rn, rd = remaining.as_integer_ratio()
    try:
        translated = math.nextafter((bn * rd + rn * bd) / (bd * rd), -math.inf)
    except OverflowError as error:
        raise ValueError("finite translated deadline required") from error
    if not math.isfinite(translated):
        raise ValueError("finite translated deadline required")
    if translated <= before:
        raise TimeoutError("no conservatively representable child deadline remains")
    return translated


async def _execute_process_phase(state, argv, *, job, env, work_until, cleanup_until,
                                 streams, cleanup, observed_errors):
    """The original async spawn/drain/wait primitive, with an optional owned gate.

    Caller retains state before awaiting. Resource bridge owns only this exact
    phase's inherited descriptors and original live handle. It may never release
    project work from a status byte without actual placement readback.
    """
    loop = asyncio.get_running_loop()
    try:
        state.observations = _PhaseObservations(state, observed_errors)
        extra = {} if state.bridge is None else state.bridge.spawn_kwargs()
        if set(extra) - {"pass_fds"}:
            raise ValueError("resource bridge may supply only original inherited descriptors")
        if state.workspace is not None:
            if state.bridge is None or type(extra.get("pass_fds")) is not tuple or len(extra["pass_fds"]) != 3:
                raise ValueError("workspace requires original three placement descriptors")
            fourth = state.workspace.transport
            if fourth in extra["pass_fds"]:
                raise ValueError("workspace descriptor aliases placement control")
            extra["pass_fds"] = extra["pass_fds"] + (fourth,)
        if loop.time() >= work_until:
            raise TimeoutError("original sandbox deadline expired before phase spawn")
        state.spawn_attempted = True
        if state.workspace is not None:
            state.workspace.spawn_attempted = True
        if state.bridge is not None:
            state.bridge.note_spawn_attempt()
        state.proc = await asyncio.create_subprocess_exec(*argv, cwd=job, env=env,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, start_new_session=True, **extra)
        if state.workspace is not None:
            state.workspace.proc = state.proc
        for index, name in enumerate(("stdout", "stderr")):
            streams[name]["eof"] = False
            reader = getattr(state.proc, name)
            cap = MAX_STDOUT if name == "stdout" else MAX_STDERR
            state.drain_coros[index] = _drain(reader, streams[name], cap, state.observations)
            state.drain_attempted[index] = state.drain_unknown[index] = True
            state.tasks[index] = asyncio.create_task(state.drain_coros[index])
            state.drain_unknown[index] = False
        if state.bridge is not None:
            await state.bridge.confirm_and_release(state.proc, work_until)
        if state.workspace is not None:
            await state.workspace.handshake(state.proc, work_until)
        while state.proc.returncode is None:
            for task in state.tasks:
                if task is not None and task.done() and task.exception() is not None:
                    raise task.exception()
            if loop.time() >= work_until:
                raise TimeoutError("sandbox work deadline exceeded")
            await asyncio.sleep(min(.01, work_until - loop.time()))
    except BaseException as error:
        state.retain(error)
        if any(state.drain_unknown):
            state.observation_incomplete = True  # never adopt or retry an unreturned task
    finally:
        if state.bridge is not None:
            try:
                # Stop only the original owned leaf; never signal a reused PGID.
                state.bridge.stop_before_reap(state.proc, cleanup_until)
            except BaseException as error:
                state.error("resource-stop", error, cleanup)
        # One retained cleanup task covers both original-process and resource
        # terminal paths. A second caller cancellation cannot skip FD retirement.
        state.cleanup_task_unknown = True
        async def terminal():
            try:
                if state.proc is not None:
                    if state.bridge is None:
                        await _cleanup_process(state.proc, state.tasks, cleanup_until, cleanup, state.observations)
                    else:
                        await _cleanup_process(state.proc, state.tasks, cleanup_until,
                                               cleanup, state.observations, stop_group=False)
                elif state.spawn_attempted:
                    cleanup["errors"].append({"phase": "spawn", "type": "UNKNOWN",
                                              "message": "no original process handle returned"})
            except BaseException as error:
                state.error("cleanup-task", error, cleanup)
            finally:
                # Even unknown-spawn diagnostic failure cannot skip the owned
                # descriptor/leaf terminal path. It never heals spawn debt.
                if state.bridge is not None:
                    try:
                        await state.bridge.finish_phase(state.proc, cleanup, cleanup_until)
                    except BaseException as error:
                        state.error("resource-phase-terminal", error, cleanup)
        state.cleanup_coro = terminal()
        try:
            state.cleanup_task = asyncio.create_task(state.cleanup_coro)
            state.cleanup_task_unknown = False
        except BaseException as error:
            # Creation may be ambiguous. Keep the actual coroutine and debt;
            # never retry task creation or claim that terminal work ran.
            state.error("cleanup-task-create", error, cleanup)
        if state.cleanup_task is not None:
            while not state.cleanup_task.done():
                try:
                    await asyncio.shield(state.cleanup_task)
                except asyncio.CancelledError as error:
                    if state.primary is None:
                        state.primary = error
            try:
                state.cleanup_task.result()
            except BaseException as error:
                state.error("cleanup-task-tail", error, cleanup)


def _remove_job(original_path, deadline, *, entry_cap=MAX_CLEANUP_ENTRIES, clock=time.monotonic):
    """One cooperative bounded FD walk; no background deletion and no following links.

    Check the original owner clock before each scan/stat/open/unlink/rmdir step.
    Individual local filesystem syscalls are not a hard real-time guarantee. On
    exhaustion, close existing handles once and retain the remaining directory.
    """
    stats = {"entries_seen": 0, "entries_removed": 0, "entry_cap": entry_cap,
             "deadline_exceeded": False, "entry_limit_exceeded": False,
             "depth_limit_exceeded": False, "job_removed": False, "close_errors": [],
             "close_report_failed": False}
    primary, stack = None, []

    def guard():
        if clock() >= deadline:
            stats["deadline_exceeded"] = True
            raise TimeoutError("sandbox directory cleanup deadline exceeded")

    def close_frame(frame):
        first = None
        for key in ("iterator", "fd"):
            owned = frame[key]
            frame[key] = None  # The one attempt is retained even if close raises; no retry.
            if owned is None:
                continue
            try:
                owned.close() if key == "iterator" else os.close(owned)
            except BaseException as error:
                if first is None:
                    first = error
                try:
                    stats["close_errors"].append(_failure("directory-" + key + "-close", error))
                except BaseException:
                    # Metadata failure must not prevent the independent FD close.
                    stats["close_report_failed"] = True
        return first

    try:
        if type(entry_cap) is not int or not 1 <= entry_cap <= MAX_CLEANUP_ENTRIES:
            raise ValueError("invalid directory cleanup entry cap")
        root = {"fd": None, "iterator": None, "name": None, "parent": None}
        stack.append(root)
        guard()
        root["fd"] = os.open(original_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        guard()
        basis = os.fstat(root["fd"])
        if not stat.S_ISDIR(basis.st_mode) or basis.st_uid != os.getuid():
            raise SandboxCleanupError("original sandbox directory identity refused")
        guard()
        root["iterator"] = os.scandir(root["fd"])
        while stack:
            frame = stack[-1]
            guard()
            try:
                entry = next(frame["iterator"])
            except StopIteration:
                stack.pop()
                error = close_frame(frame)
                if error is not None:
                    raise error
                guard()
                if frame["parent"] is None:
                    current = os.lstat(original_path)
                    if (current.st_dev, current.st_ino) != (basis.st_dev, basis.st_ino):
                        raise SandboxCleanupError("sandbox directory changed before removal")
                    guard()
                    os.rmdir(original_path)
                    stats["job_removed"] = True
                else:
                    os.rmdir(frame["name"], dir_fd=frame["parent"])
                stats["entries_removed"] += 1
                continue
            stats["entries_seen"] += 1
            if stats["entries_seen"] > entry_cap:
                stats["entry_limit_exceeded"] = True
                raise SandboxCleanupError("sandbox directory cleanup entry cap exceeded")
            name = entry.name
            if type(name) is not str or name in ("", ".", "..") or "/" in name or "\x00" in name:
                raise SandboxCleanupError("invalid directory entry")
            guard()
            try:
                before = os.stat(name, dir_fd=frame["fd"], follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(before.st_mode):
                if len(stack) >= MAX_CLEANUP_DEPTH:
                    stats["depth_limit_exceeded"] = True
                    raise SandboxCleanupError("sandbox directory cleanup depth cap exceeded")
                child = {"fd": None, "iterator": None, "name": name, "parent": frame["fd"]}
                stack.append(child)  # Cover the original open return before fstat/scandir can fail.
                guard()
                child["fd"] = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                      dir_fd=frame["fd"])
                guard()
                after = os.fstat(child["fd"])
                if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
                    raise SandboxCleanupError("sandbox directory entry changed")
                guard()
                child["iterator"] = os.scandir(child["fd"])
            else:
                guard()
                try:
                    os.unlink(name, dir_fd=frame["fd"])
                    stats["entries_removed"] += 1
                except FileNotFoundError:
                    pass
    except BaseException as error:
        primary = error
    finally:
        for frame in reversed(stack):
            error = close_frame(frame)
            if primary is None and error is not None:
                primary = error
    if primary is not None:
        primary.sandbox_directory_cleanup = stats
        raise primary
    return stats


def _artifacts(job, names, total_cap, deadline=None):
    """Read untrusted flat outputs through no-follow FDs, with finite per-file and aggregate reads."""
    produced, digests, total = {}, {}, 0
    for name in names:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("sandbox artifact deadline exceeded")
        try:
            fd = os.open(job / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        primary = None
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > min(MAX_OUTPUT, total_cap - total):
                raise SandboxOutputLimit("sandbox artifact type or size refused")
            chunks, size = [], 0
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError("sandbox artifact deadline exceeded")
                chunk = os.read(fd, min(65536, total_cap - total - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_OUTPUT or total + size > total_cap:
                    raise SandboxOutputLimit("sandbox artifact total exceeded")
                chunks.append(chunk)
            after = os.fstat(fd)
            stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if stamp(before) != stamp(after) or size != before.st_size:
                raise RuntimeError("sandbox artifact changed during read")
            raw = b"".join(chunks)
        except BaseException as error:
            primary = error
        try:
            os.close(fd)
        except BaseException as error:
            if primary is None:
                primary = error
            primary.sandbox_artifact_close_error = _failure("artifact-close", error)
        if primary is not None:
            raise primary
        produced[name], digests[name] = raw, hashlib.sha256(raw).hexdigest()
        total += size
    return produced, digests, total


def _options(kind, cleanup_seconds, memory_bytes, processes, child_processes,
             require_complete_cleanup, artifact_bytes, aggregate_cpu_seconds,
             aggregate_memory_bytes, aggregate_processes, absolute_until=None):
    if type(cleanup_seconds) not in (int, float) or not 1 <= cleanup_seconds <= 10:
        raise ValueError("cleanup_seconds 1..10")
    if type(child_processes) is not bool or type(require_complete_cleanup) is not bool:
        raise ValueError("child_processes and require_complete_cleanup are booleans")
    if absolute_until is not None and (type(absolute_until) not in (int, float) or not math.isfinite(absolute_until)):
        raise ValueError("absolute_until is a finite deadline in the original owner loop clock")
    if type(artifact_bytes) is not int or not 1 <= artifact_bytes <= MAX_OUTPUT:
        raise ValueError("artifact_bytes 1..30 MiB")
    if memory_bytes is not None and (type(memory_bytes) is not int or not 16 * 1024 * 1024 <= memory_bytes <= 16 * 1024**3):
        raise ValueError("memory_bytes 16 MiB..16 GiB")
    if processes is not None and (type(processes) is not int or not 1 <= processes <= 1024):
        raise ValueError("processes 1..1024")
    if any(v is not None for v in (aggregate_cpu_seconds, aggregate_memory_bytes, aggregate_processes)):
        raise ValueError("aggregate descendant limits unavailable; no cgroup is provisioned by this runner")
    if kind == "sandbox-exec" and memory_bytes is not None:
        raise ValueError("a strict memory limit is unavailable on this macOS runner")
    if kind == "sandbox-exec" and child_processes and require_complete_cleanup:
        raise ValueError("macOS detached descendants are unproved; request the explicit forkless mode")
    if kind == "landlock" and not child_processes:
        raise ValueError("forkless mode is macOS-only; Linux supports contained namespace children")


def _allowed_apps():
    return {a.strip() for a in os.environ.get("HIVE_SANDBOX_RUN_APPS", "").split(",") if a.strip()}


def _runtimes():
    """Operator map: name -> path, or name -> {"exe": path, "reads": [extra read-only folders]} (e.g. a venv's
    interpreter plus PeTTa/SWI roots). The exe runs exactly as configured (a venv python keeps its packages)."""
    try:
        out = json.loads(os.environ.get("HIVE_SANDBOX_RUNTIMES", "") or "{}")
    except ValueError:
        return {}
    if not isinstance(out, dict):
        return {}
    runtimes = {}
    for k, v in out.items():
        if isinstance(v, str):
            runtimes[k] = {"exe": v, "reads": []}
        elif isinstance(v, dict) and isinstance(v.get("exe"), str):
            runtimes[k] = {"exe": v["exe"], "reads": [r for r in v.get("reads", []) if isinstance(r, str)]}
    return runtimes


def _launcher_works():
    """The fixed launcher, run exactly as a tool run runs it (same shell, same PATH), sets 1 s / 1 KiB limits and execs
    `/bin/sh -c :` (present on every host). On Linux that is the real prlimit path (absent or failing prlimit -> 78 -> False)."""
    import subprocess
    try:
        done = subprocess.run(["/bin/sh", str(LAUNCHER), "1", "1024", "/bin/sh", "-c", ":"], env={"PATH": RUN_PATH},
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def available():
    """True only when run() can really execute a tool on this host: sandbox-exec (macOS) or namespaces + Landlock
    (Linux; backend() already requires both), the fixed launcher present, and the launcher's limit pre-check passing.
    run() refuses on exactly this predicate, so a caller's preflight and the run path cannot disagree."""
    if tools_refused() is not None:   # the local-owner preflight could not verify this path (J1b r1.1)
        return False
    return backend() in {"sandbox-exec", "landlock"} and LAUNCHER.is_file() and _launcher_works()


def verify_bundle(app_dir, bundle):
    """The bundle folder inside the app, exactly matching its lock file. Returns the resolved folder."""
    app_dir = pathlib.Path(app_dir).resolve()
    if not isinstance(bundle, str) or not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", bundle) or ".." in bundle.split("/"):
        raise ValueError("bundle is a plain relative folder inside the app")
    root = (app_dir / bundle).resolve()
    if app_dir not in root.parents or not root.is_dir():
        raise ValueError("bundle must be a folder inside the app")
    lock = json.loads((root / "bundle.lock.json").read_text())
    files = lock.get("files") if isinstance(lock, dict) else None
    if not isinstance(files, dict) or not files:
        raise ValueError("bundle.lock.json lists the bundle's files and their sha256")
    present = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() or p.is_symlink()} - {"bundle.lock.json"}
    if present != set(files):
        raise ValueError("bundle files differ from its lock (extra or missing files)")
    for rel, digest in files.items():
        p = root / rel
        if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            raise ValueError(f"bundle file changed: {rel}")
    return root


_REACHABLE = {}   # probe key -> monotonic time of the last successful probe (bounded, oldest evicted)
REACHABLE_TTL, REACHABLE_MAX = 300, 64


def _granted(kind, reads):
    """The read roots the sandbox will actually grant for `reads`, as resolved real paths: what sandbox.wrap and
    sandbox_policy pass on (safe_roots), then, on Linux, the launcher profile's own already-resolved filter."""
    roots = safe_roots(reads)
    if kind == "landlock":
        from ..supervisor import landlock
        roots = [r for r in roots if os.path.realpath(r) == os.path.normpath(os.path.abspath(r))]
        roots += [r for r in landlock.SYSTEM_READ if r != "/proc"]
    else:
        roots += list(MAC_SYSTEM_READ)
    return tuple(sorted(set(roots)))


def _probe_key(kind, exe, granted):
    """Everything the probe's answer depends on: backend, the exe as configured and as resolved (with its identity),
    and the exact granted roots. A config, backend, symlink, interpreter content or permission change (mode, owner,
    ctime: Root r3) is a new key, never a stale hit."""
    try:
        st = os.stat(exe)
        ident = (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid, st.st_mtime_ns, st.st_ctime_ns, st.st_size)
    except OSError:
        ident = None
    return (kind, exe, os.path.realpath(exe), ident, granted)


def _runtime_reachable(kind, exe, reads):
    """Probe, through the same boundary a job gets (Linux: launcher, profile shape and programs mirror; macOS: the same
    sandbox-exec policy), that `exe` is executable inside it (test -x; nothing of the runtime itself runs). Successes
    are cached briefly under a key that covers everything the answer depends on; failures are never cached, so a
    fixed host recovers on the next job. Each miss costs one sandboxed /bin/sh spawn: an intended admission cost."""
    import subprocess, time
    key = _probe_key(kind, exe, _granted(kind, reads))
    if time.monotonic() - _REACHABLE.get(key, -1e9) < REACHABLE_TTL:
        return True
    with tempfile.TemporaryDirectory(prefix="sbx-probe-") as folder:
        job = pathlib.Path(folder).resolve()
        probe = ["/bin/sh", "-c", 'test -x "$0"', exe]
        if kind == "landlock":
            argv, _ = wrap(probe, job, list(reads) + [str(LAUNCHER)], job / ".sandbox-profile",
                           "runtime-probe", ports=(), programs=(exe,))
        else:
            argv = ["/usr/bin/sandbox-exec", "-p", sandbox_policy(job, reads)] + probe
        try:
            ok = subprocess.run(argv, cwd=job, env={"PATH": RUN_PATH, "HOME": str(job), "TMPDIR": str(job)},
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
    if ok:
        _REACHABLE.pop(key, None)
        _REACHABLE[key] = time.monotonic()
        while len(_REACHABLE) > REACHABLE_MAX:
            _REACHABLE.pop(next(iter(_REACHABLE)))
    return ok


def sandbox_policy(job, reads, child_processes=True):
    """The hive's deny-by-default profile with every network clause removed.

    Directory-service account lookups such as getpwuid are unavailable. Tools can
    use the job's HOME for paths or accept an explicit application identity.
    """
    reads = [r for r in safe_roots(reads)]
    lines = profile(job, reads).splitlines()
    policy = "\n".join(line for line in lines if not line.startswith("(allow network-")
                       and (child_processes or line != "(allow process-fork)")) + "\n"
    return policy + "(allow file-read* (literal " + json.dumps(str(LAUNCHER)) + "))\n"


def _aggregate_dependencies():
    # Lazy private dependency: generic/Darwin imports and dispatch stay legacy.
    from .code_aggregate import _CodeAggregate
    from . import sandbox_resources
    return _CodeAggregate, sandbox_resources


def _aggregate_limits(owner, kind, aggregate_cpu_seconds, aggregate_memory_bytes, aggregate_processes):
    owner_type, resources = _aggregate_dependencies()
    if type(owner) is not owner_type or type(owner.limits) is not tuple or not owner._valid_limits():
        raise TypeError("original Code aggregate owner required")
    if type(owner._runner_contexts) is not list:
        raise TypeError("original private resource custody required")
    resources._other_contexts_healthy(owner, owner)
    limits = owner.limits
    boot = owner.attempt
    if (kind != "landlock" or owner.start_attempted is not True or owner.retirement_attempted
            or owner.primary_error is not None or owner.observation_incomplete
            or type(boot) is not resources.C.BootstrapAttempt or not boot.ready or boot.retired
            or type(boot.service_unit) is not str or boot.service_unit != limits[0]
            or boot.primary_error is not None or boot.observation_incomplete):
        raise RuntimeError("original Code aggregate bootstrap unavailable")
    if (owner.capacity_policy is not boot.capacity_policy
            or owner.workspace_policy is not boot.workspace_policy
            or resources.C.capacity_usable(boot, limits[1], limits[2]) is not True):
        raise RuntimeError("original aggregate capacity policy unavailable")
    # Operator immutable limits apply to the leaf. No public per-run override or
    # claimed narrowing is accepted by the current actual helper interface.
    if aggregate_cpu_seconds is not None:
        raise ValueError("aggregate CPU limit unavailable")
    for requested, expected in ((aggregate_memory_bytes, limits[1]), (aggregate_processes, limits[2])):
        if requested is not None and (type(requested) is not int or requested != expected):
            raise ValueError("aggregate request must equal the original operator limit")
    return limits, resources


def _aggregate_continuation_limits(owner, kind, original_limits, original_bootstrap, *,
                                   original_capacity_policy, original_workspace_policy):
    """Original-owner cleanup/currentness, never fresh-room admission or a work grant."""
    owner_type, resources = _aggregate_dependencies()
    if (type(owner) is not owner_type or kind != "landlock" or not owner._valid_limits()
            or owner.limits is not original_limits or owner.attempt is not original_bootstrap
            or owner.capacity_policy is not original_capacity_policy
            or owner.workspace_policy is not original_workspace_policy):
        raise RuntimeError("original aggregate continuation identity changed")
    resources.require_owner_continuation(owner, original_limits, original_bootstrap,
                                        original_capacity_policy, original_workspace_policy)
    return original_limits, resources


def _aggregate_deadline(started, *durations):
    """Original numeric sum rounded down only when binary64 rounded it up."""
    numerator, denominator = 0, 1
    for value in (started, *durations):
        if type(value) is int:
            n, d = value, 1
        elif type(value) is float and math.isfinite(value):
            n, d = value.as_integer_ratio()
        else:
            raise ValueError("finite original clock and durations required")
        numerator, denominator = numerator * d + n * denominator, denominator * d
    result = numerator / denominator
    if not math.isfinite(result):
        raise ValueError("finite original total required")
    n, d = result.as_integer_ratio()
    return math.nextafter(result, -math.inf) if n * denominator > numerator * d else result


async def _run_aggregate_admitted(program, entry, args, inputs, outputs, runtime, bundle,
        cpu_seconds, file_bytes, timeout, *, cleanup_seconds, memory_bytes, processes,
        child_processes, require_complete_cleanup, artifact_bytes, aggregate_cpu_seconds,
        aggregate_memory_bytes, aggregate_processes, absolute_until, owner, invocation_started):
    """One original runner, three sequential common phases in one owned leaf.

    This private call does not admit an app or enable Linux. The caller retains
    its existing grant/Program/runtime checks; the published Code gate stays off.
    """
    loop = asyncio.get_running_loop()
    started = loop.time() if invocation_started is None else invocation_started
    if type(started) not in (int, float) or not math.isfinite(started) or started > loop.time():
        raise ValueError("original invocation loop observation required")
    kind = backend()
    limits, resources = _aggregate_limits(owner, kind, aggregate_cpu_seconds,
                                           aggregate_memory_bytes, aggregate_processes)
    bootstrap = owner.attempt
    capacity_policy, workspace_policy = owner.capacity_policy, owner.workspace_policy
    from . import sandbox_workspace as workspace_api
    _options(kind, cleanup_seconds, memory_bytes, processes, child_processes,
             require_complete_cleanup, artifact_bytes, None, None, None, absolute_until)
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 1 <= timeout <= 120:
        raise ValueError("timeout 1..120 seconds")
    total_until = min(_aggregate_deadline(started, timeout, cleanup_seconds),
                      _aggregate_deadline(started, limits[3]))
    if absolute_until is not None:
        total_until = min(total_until, absolute_until)
    work_until = _aggregate_deadline(total_until, -cleanup_seconds)
    if loop.time() >= work_until:
        raise TimeoutError("original aggregate envelope has no work reserve")
    # Pure validation only. Neither legacy availability function may dispatch an
    # uncontained fixed child in this branch.
    if tools_refused() is not None or not LAUNCHER.is_file():
        raise RuntimeError("sandbox unavailable: original launcher/preflight unavailable")
    runtimes = _runtimes()
    if runtime not in runtimes or not pathlib.Path(runtimes[runtime]["exe"]).is_file():
        raise ValueError("configured runtime unavailable")
    if type(cpu_seconds) is not int or not 1 <= cpu_seconds <= 60 or type(file_bytes) is not int or not 1024 <= file_bytes <= MAX_OUTPUT:
        raise ValueError("cpu_seconds 1..60, file_bytes 1 KiB..30 MiB")
    root = verify_bundle(program["path"], bundle)
    entry_path = (root / str(entry)).resolve()
    if root not in entry_path.parents or not entry_path.is_file():
        raise ValueError("entry is a file in the bundle")
    args = [str(a) for a in (args or ())]
    if len(args) > 32 or any(len(a) > 4096 for a in args):
        raise ValueError("at most 32 arguments of 4096 characters")
    original_inputs = dict(inputs or {})
    if len(original_inputs) > workspace_api.MAX_INPUT_FILES:
        raise ValueError("at most2000 input names")
    inputs = {name: data if isinstance(data, bytes) else str(data).encode()
              for name, data in original_inputs.items()}
    outputs = list(outputs or ())
    if any(not isinstance(name, str) or not NAME.fullmatch(name) for name in list(inputs) + outputs):
        raise ValueError("input/output names are plain file names")
    if len(outputs) > MAX_ARTIFACTS or len(set(outputs)) != len(outputs):
        raise ValueError("at most 32 distinct output names")
    if sum(len(v) for v in inputs.values()) > MAX_INPUT:
        raise ValueError("inputs exceed 20 MiB")
    exe = pathlib.Path(runtimes[runtime]["exe"]).absolute()
    real = pathlib.Path(os.path.realpath(exe))
    reads = [str(root)] + list(runtimes[runtime]["reads"])
    for e in {exe, real}:
        reads.append(str(e.parent.parent if e.parent.name == "bin" else e.parent))
        for prefix in ("/opt/homebrew", "/usr/local"):
            if str(e).startswith(prefix + "/"):
                reads += [f"{prefix}/opt", f"{prefix}/lib", f"{prefix}/Cellar"]
    granted = [pathlib.Path(r) for r in _granted(kind, reads)]
    if not any(real == r or r in real.parents for r in granted):
        raise RuntimeError("sandbox unavailable: runtime resolves outside its read roots")
    if loop.time() >= work_until:
        raise TimeoutError("original aggregate deadline expired during validation")

    evidence = _ProcessPhase()  # raw first outcome before job/context effects
    states = [None, None, None]
    phases = [None, None, None]
    facts = [None, None, None]
    streams = {name: {"data": bytearray(), "bytes": 0, "eof": False, "truncated": False}
               for name in ("stdout", "stderr")}
    observed = []
    context = original_job = job = None
    workspace_job = None
    quiesced = False
    context_attempted = context_returned = context_original = resource_closed = False
    any_spawn = False
    final_proc = None
    cleanup = {"original_process_reaped": False, "original_group_absent": False,
               "descendants": "UNRESOLVED", "job_removed": False, "errors": [],
               "complete": False, "prelaunch_complete": False}
    result = {"backend": kind, "spawn_attempted": False, "elapsed_seconds": None,
              "primary_error": None, "exit": None, "outputs": {}, "output_digests": {},
              "artifacts_total_bytes": 0, "missing_outputs": outputs, "cleanup": cleanup,
              "configured_limits": {"cpu_seconds_per_process": cpu_seconds,
                  "file_bytes_per_file": file_bytes, "memory_bytes": memory_bytes,
                  "processes": processes, "timeout_seconds": timeout,
                  "cleanup_seconds": cleanup_seconds, "artifact_bytes": artifact_bytes,
                  "child_processes": child_processes, "absolute_until": total_until,
                  "aggregate_memory_bytes": limits[1], "aggregate_processes": limits[2],
                  "aggregate_swap_bytes": 0, "operator_total_seconds": limits[3]},
              "limit_availability": {"memory": "per_process_virtual_address_space",
                  "processes": "real_uid_not_job", "aggregate_cpu": False,
                  "aggregate_memory": False, "aggregate_processes": False}}

    def retain_resource():
        if context_original and context.primary is not None:
            evidence.retain(context.primary)

    async def phase(index, name, command, programs, bound):
        nonlocal any_spawn, final_proc
        state = _ProcessPhase()
        states[index] = state  # retain before placement/pipe/wrap/spawn
        local = {"errors": [], "original_process_reaped": False,
                 "original_group_absent": False, "complete": False}
        facts[index] = {"name": name, "cleanup": local, "spawn_attempted": False,
                        "exit": None, "work_until": bound, "phase_complete": False,
                        "stdout_bytes_before": streams["stdout"]["bytes"],
                        "stderr_bytes_before": streams["stderr"]["bytes"]}
        try:
            if loop.time() >= bound:
                raise TimeoutError("original aggregate phase deadline expired")
            phases[index] = context.new_phase(work_loop_until=bound)
            if type(phases[index]) is not resources.ResourcePhase or phases[index].context is not context:
                evidence.observation_incomplete = True
                raise TypeError("original resource phase return required")
            state.bridge = phases[index]
            if not state.bridge.ready:
                retain_resource()
                if state.bridge.primary is not None:
                    evidence.retain(state.bridge.primary)
                raise SandboxCleanupError("aggregate phase preparation failed")
            state.workspace = workspace_api.prepare_phase(context, state.bridge, index,
                inputs if index == 2 else {}, work_loop_until=bound)
            state.workspace.raise_first()
            if not state.workspace.ready:
                raise SandboxCleanupError("original workspace preparation unavailable")
            argv, written = wrap(command, job, reads + [str(LAUNCHER)],
                job / (".sandbox-profile-" + name), "app-bundle" if index == 2 else name, ports=(),
                programs=programs, _runner_placement=state.bridge.transport,
                _runner_workspace=state.workspace.transport)
            if json.loads(pathlib.Path(written).read_text()).get("connect_ports") != []:
                raise RuntimeError("sandbox profile would allow network access")
            await _execute_process_phase(state, argv, job=job, env=env,
                work_until=bound, cleanup_until=total_until, streams=streams,
                cleanup=local, observed_errors=observed)
        except BaseException as error:
            state.retain(error)
        finally:
            # Wrapping/preparation may fail before common phase enters. The
            # context outer terminal path still owns any returned partial phase.
            any_spawn = any_spawn or state.spawn_attempted
            if index == 2:
                final_proc = state.proc
            if state.primary is not None:
                evidence.retain(state.primary)
            retain_resource()
            # Physical terminal custody and capture/work success are distinct.
            # A bounded overflow may stop before EOF while every owned handle
            # and worker is known closed. Such capture failure still forbids
            # another phase and remains the raw first work error below.
            try:
                drains_known = True
                for slot in (0, 1):
                    task = state.tasks[slot]
                    if task is None or not task.done():
                        drains_known = False
                local["complete"] = (state.bridge is not None and state.bridge.controls_closed
                    and not state.bridge.observation_incomplete and local["original_process_reaped"]
                    and local["original_group_absent"] and not local["errors"]
                    and not state.observation_incomplete and not state.cleanup_task_unknown
                    and state.cleanup_task is not None and state.cleanup_task.done()
                    and not state.cleanup_task.cancelled() and state.drain_join_attempted
                    and not state.drain_join_unknown and state.drain_join is not None
                    and state.drain_join.done() and not state.drain_join.cancelled()
                    and drains_known and not any(state.drain_unknown))
            except BaseException as error:
                local["complete"] = False
                state.retain(error)
                evidence.retain(error)
                state.observation_incomplete = evidence.observation_incomplete = True
            if state.spawn_attempted and not local["complete"] and context_original:
                # Same original owner retains common Process/task/pipe custody
                # on physical UNKNOWN. No new registry or status permission.
                context.observation_incomplete = True
            facts[index].update(spawn_attempted=state.spawn_attempted,
                exit=state.proc.returncode if state.proc is not None else None,
                phase_complete=bool(state.bridge is not None and state.bridge.complete),
                stdout_bytes_after=streams["stdout"]["bytes"], stderr_bytes_after=streams["stderr"]["bytes"],
                stdout_eof=streams["stdout"]["eof"], stderr_eof=streams["stderr"]["eof"],
                stdout_truncated=streams["stdout"]["truncated"], stderr_truncated=streams["stderr"]["truncated"])
            if state.observation_incomplete or state.cleanup_task_unknown:
                evidence.observation_incomplete = True
            for item in local["errors"]:
                try:
                    cleanup["errors"].append(item)
                except BaseException as recording:
                    if evidence.recording_error is None:
                        evidence.recording_error = recording
                    evidence.observation_incomplete = True
            if index < 2 and state.workspace is not None:
                # No second root/lease while a preceding workspace remains held.
                disposed = state.workspace.dispose(total_until)
                if state.workspace.primary is not None:
                    evidence.retain(state.workspace.primary)
                if not disposed:
                    context.observation_incomplete = True
                    evidence.observation_incomplete = True
                    evidence.retain(SandboxCleanupError("original probe workspace retirement unknown"))
        if evidence.primary is not None:
            raise evidence.primary
        if not local["complete"] or not state.bridge.complete:
            raise SandboxCleanupError("aggregate phase original terminal facts incomplete")
        if not all(stream["eof"] and not stream["truncated"] for stream in streams.values()):
            raise RuntimeError("aggregate phase capture incomplete; continuation refused")
        return state.proc.returncode

    env = {"PATH": RUN_PATH, "LANG": "en_US.UTF-8", "OPENSSL_CONF": "/dev/null"}
    try:
        if loop.time() >= work_until:
            raise TimeoutError("original aggregate deadline expired before context")
        if (owner.limits is not limits or owner.attempt is not bootstrap or owner.retirement_attempted
                or owner.capacity_policy is not capacity_policy or owner.workspace_policy is not workspace_policy
                or bootstrap.capacity_policy is not capacity_policy or bootstrap.workspace_policy is not workspace_policy):
            raise RuntimeError("original aggregate owner changed during validation")
        # Reserve a real leaf before any host metadata/job creation, atomically
        # refusing the sixth job before job/leaf/spawn when the pool is full.
        import secrets
        run_name = "run-" + secrets.token_hex(16)
        original_mono_until = _sender_monotonic_until(loop, total_until)
        prepare_context = resources.prepare_context
        context_attempted = True
        context = prepare_context(owner, run_name, monotonic_until=original_mono_until,
            loop_until=total_until, sender_monotonic_until=_sender_monotonic_until)
        context_returned = True
        context_original = (type(context) is resources.ResourceContext and context.owner is owner
            and context.limits is limits and context.bootstrap is bootstrap
            and context.capacity_policy is capacity_policy and context.workspace_policy is workspace_policy)
        if not context_original:
            evidence.observation_incomplete = True
            raise TypeError("original resource context return required")
        retain_resource()
        if not context.ready:
            raise SandboxCleanupError("aggregate original context unavailable")
        workspace_job = workspace_api.prepare_job(context, work_loop_until=work_until)
        workspace_job.raise_first()
        if not workspace_job.ready:
            raise SandboxCleanupError("original workspace job unavailable")
        original_job = workspace_job.path
        job = pathlib.Path(original_job)
        env.update(TMPDIR=str(job), HOME=str(job))
        # Preallocated original common-state slots stay with this same physical
        # context if any Task/pipe/spawn observation is UNKNOWN.
        context._runner_states = states
        result["limit_availability"].update(aggregate_memory=True, aggregate_processes=True)
        # Same fixed commands and mirrors; no legacy synchronous subprocess can
        # escape this context. Each actual P gets a new placement and confirmation.
        code = await phase(0, "launcher-probe",
            ["/bin/sh", str(LAUNCHER), "1", "1024", "/bin/sh", "-c", ":"],
            ("/bin/sh",), min(work_until, _aggregate_deadline(loop.time(), 10)))
        if code != 0:
            raise RuntimeError("sandbox launcher limit probe failed")
        key = _probe_key(kind, str(exe), _granted(kind, reads))
        if time.monotonic() - _REACHABLE.get(key, -1e9) >= REACHABLE_TTL:
            code = await phase(1, "runtime-probe",
                ["/bin/sh", "-c", 'test -x "$0"', str(exe)], (str(exe),),
                min(work_until, _aggregate_deadline(loop.time(), 10)))
            if code != 0:
                raise RuntimeError("runtime is not executable inside the sandbox view")
            _REACHABLE.pop(key, None)
            _REACHABLE[key] = time.monotonic()
            while len(_REACHABLE) > REACHABLE_MAX:
                _REACHABLE.pop(next(iter(_REACHABLE)))
        command = ["/bin/sh", str(LAUNCHER), str(cpu_seconds), str(file_bytes),
                   "--hive-resource-limits", "Linux", str(memory_bytes or 0), str(processes or 0),
                   "--", str(exe), str(entry_path), *args]
        await phase(2, "workload", command, (str(exe),), work_until)
    except BaseException as error:
        evidence.retain(error)
    finally:
        # Critical native/owned tails precede all optional list/result projection.
        if context_original:
            try:
                raw_quiescence = await context.quiesce(total_until)
                quiesced = raw_quiescence is True and context.quiesced is True
            except BaseException as error:
                retain_resource()
                evidence.retain(error)
            retain_resource()
            if context.observation_incomplete:
                evidence.observation_incomplete = True
        elif context_attempted:
            evidence.observation_incomplete = True  # no context adoption by name/list
        # These are original raw terminal facts, not a newly allocated summary.
        reaped, groups_absent, controls_closed, known_phases = True, True, True, True
        try:
            for index in (0, 1, 2):
                state = states[index]
                if state is not None and state.spawn_attempted:
                    local = facts[index]["cleanup"]
                    if (state.proc is None or state.proc.returncode is None
                            or not local["original_process_reaped"]):
                        reaped = False
                    if not local["original_group_absent"]:
                        groups_absent = False
                    if phases[index] is None or not phases[index].controls_closed:
                        controls_closed = False
                    if not local["complete"]:
                        known_phases = False
        except BaseException as error:
            reaped = groups_absent = controls_closed = known_phases = False
            evidence.retain(error)
            evidence.observation_incomplete = True
        physical_terminal = reaped and groups_absent and controls_closed
        artifact_error = directory_error = directory_raw = None
        job_removed_raw = False
        if evidence.primary is None and final_proc is not None and quiesced:
            try:
                produced, digests, total = await workspace_api.read_outputs(context.workspaces[2], outputs,
                    artifact_bytes, cleanup_loop_until=total_until)
                result.update(outputs=produced, output_digests=digests, artifacts_total_bytes=total,
                              missing_outputs=[name for name in outputs if name not in produced])
            except BaseException as error:
                artifact_error = error
                evidence.retain(error)
        if workspace_job is not None:
            try:
                workspace_job.dispose(total_until)
                job_removed_raw = workspace_job.removed is True
                directory_raw = {"job_removed": job_removed_raw, "quota_bytes": workspace_api.BYTES,
                                 "quota_inodes": workspace_api.INODES}
                if workspace_job.primary is not None:
                    evidence.retain(workspace_job.primary)
            except BaseException as error:
                directory_error = error
                evidence.retain(error)  # raw first before any optional directory diagnostic
        if context_original:
            try:
                # Exact workspace validation happens inside final finish too.
                # No leaf/context/capacity release while filesystem references remain.
                raw_terminal = await context.finish(total_until)
                resource_closed = raw_terminal is True and context.released is True
            except BaseException as error:
                retain_resource()
                evidence.retain(error)
            retain_resource()
        # All eligible critical tails have run. Projection failure can now only
        # mark evidence incomplete; it cannot skip removal or replace raw first.
        try:
            # Existing job_removed means no outstanding ORIGINAL job: a removed
            # retained job above, or this strict never-created original-context
            # case. Local None/lost returns and posted refusal labels prove nothing.
            # No directory/rmdir diagnostic or synthetic reap/EOF is emitted here.
            if (context_original and context_returned and resource_closed and quiesced
                    and context.released is True and context.quiesced is True
                    and context.observation_incomplete is False
                    and not evidence.observation_incomplete
                    and type(context) is resources.ResourceContext and context.owner is owner
                    and context.limits is limits and context.bootstrap is bootstrap
                    and context.capacity_policy is capacity_policy and context.workspace_policy is workspace_policy
                    and owner.limits is limits and owner.attempt is bootstrap
                    and owner.capacity_policy is capacity_policy and owner.workspace_policy is workspace_policy
                    and bootstrap.capacity_policy is capacity_policy and bootstrap.workspace_policy is workspace_policy
                    and workspace_job is None and original_job is None and job is None
                    and context.workspace_job is None and type(context.workspaces) is list
                    and len(context.workspaces) == 3 and all(x is None for x in context.workspaces)
                    and type(context.phases) is list and not context.phases
                    and all(x is None for x in states) and all(x is None for x in phases)
                    and not any_spawn and final_proc is None):
                job_removed_raw = True
            if final_proc is not None:
                result["exit"] = final_proc.returncode
            cleanup["original_process_reaped"] = any_spawn and reaped
            cleanup["original_group_absent"] = any_spawn and groups_absent
            cleanup["resource_cleanup_complete"] = resource_closed
            cleanup["job_removed"] = job_removed_raw
            if directory_raw is not None:
                cleanup["directory"] = directory_raw
            if directory_error is not None:
                cleanup["directory"] = getattr(directory_error, "sandbox_directory_cleanup", None)
                evidence.error("job-remove", directory_error, cleanup)
            if artifact_error is not None:
                close_error = getattr(artifact_error, "sandbox_artifact_close_error", None)
                if close_error is not None:
                    cleanup["errors"].append(close_error)
            if original_job is not None and not job_removed_raw:
                result["retained_job"] = original_job
            cleanup["descendants"] = ("PID_NAMESPACE_TERMINATED"
                if resource_closed and physical_terminal and any_spawn else "UNRESOLVED")
            if not resource_closed and context_attempted:
                evidence.error("resource-terminal", SandboxCleanupError("aggregate resource custody unresolved"), cleanup)
            cleanup["complete"] = (any_spawn and physical_terminal and known_phases and resource_closed
                and job_removed_raw and not cleanup["errors"] and not evidence.observation_incomplete)
            cleanup["prelaunch_complete"] = (not any_spawn and job_removed_raw
                and (not context_attempted or resource_closed) and not cleanup["errors"]
                and not evidence.observation_incomplete)
            for name, stream in streams.items():
                result[name], result[name + "_bytes"] = bytes(stream["data"]), stream["bytes"]
                result[name + "_eof"], result[name + "_truncated"] = stream["eof"], stream["truncated"]
            result["spawn_attempted"] = any_spawn
            result["invocation_elapsed_seconds"] = loop.time() - started
            result["elapsed_seconds"] = result["invocation_elapsed_seconds"] if any_spawn else None
            result["aggregate_phases"] = [item for item in facts if item is not None]
            if loop.time() > total_until:
                evidence.error("total-deadline", TimeoutError("aggregate total deadline exceeded"), cleanup)
                cleanup["complete"] = cleanup["prelaunch_complete"] = False
            if evidence.primary is None and (final_proc is None or not cleanup["complete"]):
                evidence.retain(SandboxCleanupError("aggregate workload or cleanup incomplete"))
        except BaseException as recording:
            evidence.retain(recording)
            evidence.observation_incomplete = True
            cleanup["complete"] = cleanup["prelaunch_complete"] = False
        if evidence.primary is not None:
            try:
                result["primary_error"] = _failure("run", evidence.primary)
            except BaseException as recording:
                if evidence.recording_error is None:
                    evidence.recording_error = recording
                evidence.observation_incomplete = True
            if evidence.observation_incomplete:
                cleanup["observation_incomplete"] = True
                cleanup["complete"] = cleanup["prelaunch_complete"] = False
            try:
                evidence.primary.sandbox_result = result
            except BaseException as recording:
                if evidence.recording_error is None:
                    evidence.recording_error = recording
                evidence.observation_incomplete = True
                cleanup["observation_incomplete"] = True
                cleanup["complete"] = cleanup["prelaunch_complete"] = False
    if evidence.primary is not None:
        raise evidence.primary
    return result


async def run(program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools",
              cpu_seconds=10, file_bytes=30 * 1024 * 1024, timeout=30, *, cleanup_seconds=5,
              memory_bytes=None, processes=None, child_processes=True, require_complete_cleanup=False,
              artifact_bytes=MAX_OUTPUT, aggregate_cpu_seconds=None, aggregate_memory_bytes=None,
              aggregate_processes=None, absolute_until=None, _resource_owner=None):
    """Run ``runtime <bundle>/<entry> args...`` in a fresh job folder.

    Output counters count bytes actually read, not discarded/unobserved bytes after
    an aborted job. EOF and truncation are separate. Strict macOS cleanup requires
    the explicit forkless mode; generic fork-enabled calls retain that limitation.
    Generic Linux calls use the existing PID namespace. The private actual-owner
    branch adds an original aggregate leaf; it does not enable the Code gate.
    """
    _invocation_started = asyncio.get_running_loop().time() if _resource_owner is not None else None
    if program["id"] not in _allowed_apps():
        raise PermissionError(f"{program['id']} is not allowed to run sandboxed tools on this hive (HIVE_SANDBOX_RUN_APPS)")
    if _resource_owner is not None:
        return await _run_admitted(program, entry, args, inputs, outputs, runtime, bundle, cpu_seconds, file_bytes, timeout,
                                   cleanup_seconds=cleanup_seconds, memory_bytes=memory_bytes, processes=processes,
                                   child_processes=child_processes, require_complete_cleanup=require_complete_cleanup,
                                   artifact_bytes=artifact_bytes, aggregate_cpu_seconds=aggregate_cpu_seconds,
                                   aggregate_memory_bytes=aggregate_memory_bytes, aggregate_processes=aggregate_processes,
                                   absolute_until=absolute_until, _resource_owner=_resource_owner,
                                   _invocation_started=_invocation_started)
    return await _run_admitted(program, entry, args, inputs, outputs, runtime, bundle, cpu_seconds, file_bytes, timeout,
                               cleanup_seconds=cleanup_seconds, memory_bytes=memory_bytes, processes=processes,
                               child_processes=child_processes, require_complete_cleanup=require_complete_cleanup,
                               artifact_bytes=artifact_bytes, aggregate_cpu_seconds=aggregate_cpu_seconds,
                               aggregate_memory_bytes=aggregate_memory_bytes, aggregate_processes=aggregate_processes,
                               absolute_until=absolute_until)


async def _run_admitted(program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools",
                        cpu_seconds=10, file_bytes=30 * 1024 * 1024, timeout=30, *, cleanup_seconds=5,
                        memory_bytes=None, processes=None, child_processes=True, require_complete_cleanup=False,
                        artifact_bytes=MAX_OUTPUT, aggregate_cpu_seconds=None, aggregate_memory_bytes=None,
                        aggregate_processes=None, absolute_until=None,
                        _resource_owner=None, _invocation_started=None):
    """Everything run() does after the app allowlist: the one execution path, also driven by the local-owner hive's
    sandbox preflight (hive/supervisor/preflight.py) with its own fixed bundle, so the preflight proves this path."""
    if _resource_owner is not None:
        return await _run_aggregate_admitted(program, entry, args, inputs, outputs, runtime, bundle,
            cpu_seconds, file_bytes, timeout, cleanup_seconds=cleanup_seconds,
            memory_bytes=memory_bytes, processes=processes, child_processes=child_processes,
            require_complete_cleanup=require_complete_cleanup, artifact_bytes=artifact_bytes,
            aggregate_cpu_seconds=aggregate_cpu_seconds, aggregate_memory_bytes=aggregate_memory_bytes,
            aggregate_processes=aggregate_processes, absolute_until=absolute_until,
            owner=_resource_owner, invocation_started=_invocation_started)
    kind = backend()
    _options(kind, cleanup_seconds, memory_bytes, processes, child_processes,
             require_complete_cleanup, artifact_bytes, aggregate_cpu_seconds,
             aggregate_memory_bytes, aggregate_processes, absolute_until)
    loop = asyncio.get_running_loop()
    if absolute_until is not None and loop.time() + cleanup_seconds >= absolute_until:
        raise TimeoutError("sandbox original deadline has no work reserve")
    if kind not in {"sandbox-exec", "landlock"} or not await asyncio.to_thread(available):   # off the event loop
        raise RuntimeError("sandbox unavailable: refusing to run tools unsandboxed")
    if absolute_until is not None and loop.time() + cleanup_seconds >= absolute_until:
        raise TimeoutError("sandbox original deadline expired during availability")
    runtimes = _runtimes()
    if runtime not in runtimes or not pathlib.Path(runtimes[runtime]["exe"]).is_file():
        raise ValueError(f"runtime is one of: {', '.join(sorted(runtimes)) or 'none configured'}")
    if type(cpu_seconds) is not int or not 1 <= cpu_seconds <= 60 or type(file_bytes) is not int or not 1024 <= file_bytes <= MAX_OUTPUT:
        raise ValueError("cpu_seconds 1..60, file_bytes 1 KiB..30 MiB")
    if not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
        raise ValueError("timeout 1..120 seconds")
    root = verify_bundle(program["path"], bundle)
    entry_path = (root / str(entry)).resolve()
    if root not in entry_path.parents or not entry_path.is_file():
        raise ValueError("entry is a file in the bundle")
    args = [str(a) for a in (args or ())]
    if len(args) > 32 or any(len(a) > 4096 for a in args):
        raise ValueError("at most 32 arguments of 4096 characters")
    inputs = {name: data if isinstance(data, bytes) else str(data).encode()
              for name, data in dict(inputs or {}).items()}
    outputs = list(outputs or ())
    for name in list(inputs) + outputs:
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError("input/output names are plain file names")
    if len(outputs) > MAX_ARTIFACTS or len(set(outputs)) != len(outputs):
        raise ValueError("at most 32 distinct output names")
    if sum(len(v) for v in inputs.values()) > MAX_INPUT:
        raise ValueError("inputs exceed 20 MiB")
    exe = pathlib.Path(runtimes[runtime]["exe"]).absolute()     # run as configured: a venv interpreter keeps its venv
    real = pathlib.Path(os.path.realpath(exe))
    reads = [str(root)] + list(runtimes[runtime]["reads"])
    for e in {exe, real}:   # the runtime's own install prefix, both as configured and as resolved
        reads.append(str(e.parent.parent if e.parent.name == "bin" else e.parent))
        for prefix in ("/opt/homebrew", "/usr/local"):   # its shared libraries (read only), as minds already have
            if str(e).startswith(prefix + "/"):
                reads += [f"{prefix}/opt", f"{prefix}/lib", f"{prefix}/Cellar"]
    # Admission must observe what execution needs, on both backends (Kimi runtime-mirror r1, r2): the runtime's real
    # path lies under the roots the sandbox will actually grant (not the raw list), and the exact exe is executable
    # inside the same boundary the job will get.
    granted = [pathlib.Path(r) for r in _granted(kind, reads)]
    if not any(real == r or r in real.parents for r in granted):
        raise RuntimeError(f"sandbox unavailable: runtime {runtime!r} resolves outside its read roots")
    if not await asyncio.to_thread(_runtime_reachable, kind, str(exe), tuple(reads)):
        raise RuntimeError(f"sandbox unavailable: runtime {runtime!r} is not executable inside the sandbox view")
    if absolute_until is not None and loop.time() + cleanup_seconds >= absolute_until:
        raise TimeoutError("sandbox original deadline expired during runtime admission")
    proc, tasks, primary, spawn_attempted = None, [], None, False
    phase_state = _ProcessPhase()  # retain raw errors before job setup or diagnostic effects
    observed_errors = []
    streams = {name: {"data": bytearray(), "bytes": 0, "eof": False, "truncated": False}
               for name in ("stdout", "stderr")}
    cleanup = {"original_process_reaped": False, "original_group_absent": False,
               "descendants": "UNRESOLVED",
               "job_removed": False, "errors": [], "complete": False, "prelaunch_complete": False}
    result = {"backend": kind, "spawn_attempted": False, "elapsed_seconds": None,
              "primary_error": None, "exit": None, "outputs": {}, "output_digests": {}, "artifacts_total_bytes": 0,
              "missing_outputs": outputs, "cleanup": cleanup,
              "configured_limits": {"cpu_seconds_per_process": cpu_seconds, "file_bytes_per_file": file_bytes,
                                    "memory_bytes": memory_bytes, "processes": processes,
                                    "timeout_seconds": timeout, "cleanup_seconds": cleanup_seconds,
                                    "artifact_bytes": artifact_bytes, "child_processes": child_processes,
                                    "absolute_until": absolute_until},
              "limit_availability": {"memory": "per_process_virtual_address_space" if kind == "landlock" else "unavailable",
                                     "processes": "real_uid_not_job", "aggregate_cpu": False,
                                     "aggregate_memory": False, "aggregate_processes": False}}
    cleanup_until = loop.time() + cleanup_seconds
    if absolute_until is not None:
        cleanup_until = min(cleanup_until, absolute_until)
    original_job = tempfile.mkdtemp(prefix="sbx-")
    try:
        # Retain the actual original return and cover resolve/initialization before
        # any further fallible operation. Cleanup never needs resolve to succeed.
        job = pathlib.Path(original_job).resolve()
        for name, data in inputs.items():
            (job / name).write_bytes(data if isinstance(data, bytes) else str(data).encode())
        if kind == "landlock":
            command = ["/bin/sh", str(LAUNCHER), str(cpu_seconds), str(file_bytes),
                       "--hive-resource-limits", "Linux", str(memory_bytes or 0), str(processes or 0), "--",
                       str(exe), str(entry_path), *args]
            # Inputs/outputs are flat NAMEs, so this job-owned metadata folder cannot collide with them.
            # The wrapper reads this profile before executing the tool; no token or authority is stored here.
            # The runtime is exec'd by limits.sh, not as argv[0]: name it so the launcher mirrors its symlink chain
            # (a venv python -> uv's version alias -> the real interpreter; without it: "exec: ...: not found").
            argv, written = wrap(command, job, reads + [str(LAUNCHER)], job / ".sandbox-profile",
                                 "app-bundle", ports=(), programs=(str(exe),))
            # No network: the profile the launcher will read must list no relay port (the namespace itself is
            # verified fresh and loopback-only by the launcher, which exits 78 otherwise).
            try:
                ports = json.loads(pathlib.Path(written).read_text()).get("connect_ports")
            except (OSError, ValueError, AttributeError):
                ports = None
            if ports != []:
                raise RuntimeError("sandbox unavailable: the tool profile would allow network access; refusing")
        else:
            argv = ["/usr/bin/sandbox-exec", "-p", sandbox_policy(job, reads, child_processes),
                    "/bin/sh", str(LAUNCHER), str(cpu_seconds), str(file_bytes),
                    "--hive-resource-limits", "Darwin", "0", str(processes or 0), "--",
                    str(exe), str(entry_path), *args]
        env = {"PATH": RUN_PATH, "TMPDIR": str(job), "HOME": str(job), "LANG": "en_US.UTF-8", "OPENSSL_CONF": "/dev/null"}
        started = loop.time()
        work_until, cleanup_until = started + timeout, started + timeout + cleanup_seconds
        if absolute_until is not None:
            work_until = min(work_until, absolute_until - cleanup_seconds)
            cleanup_until = min(cleanup_until, absolute_until)
        if work_until <= started:
            raise TimeoutError("sandbox original deadline expired before spawn")
        await _execute_process_phase(phase_state, argv, job=job, env=env,
            work_until=work_until, cleanup_until=cleanup_until, streams=streams,
            cleanup=cleanup, observed_errors=observed_errors)
        primary = phase_state.primary
    except BaseException as error:
        if phase_state is not None and phase_state.primary is not None:
            primary = phase_state.primary
            phase_state.retain(error)
        else:
            primary = error
            phase_state.retain(error)
    finally:
        if phase_state is not None:
            # The caller owns this state even when awaiting the phase is
            # interrupted. Cleanup already belongs to that same original phase.
            proc, spawn_attempted = phase_state.proc, phase_state.spawn_attempted
            if primary is None:
                primary = phase_state.primary
            result["exit"] = proc.returncode if proc is not None else None
        if primary is None and observed_errors:
            primary = observed_errors[0]
        if primary is None and not cleanup["errors"]:
            try:
                produced, digests, total = _artifacts(job, outputs, artifact_bytes, cleanup_until)
                result.update(outputs=produced, output_digests=digests, artifacts_total_bytes=total,
                              missing_outputs=[n for n in outputs if n not in produced])
            except BaseException as error:
                primary = error
                phase_state.retain(error)
                try:
                    close_error = getattr(error, "sandbox_artifact_close_error", None)
                    if close_error is not None:
                        cleanup["errors"].append(close_error)
                except BaseException as reporting:
                    if phase_state.recording_error is None:
                        phase_state.recording_error = reporting
                    phase_state.observation_incomplete = True
        if not spawn_attempted or (cleanup["original_process_reaped"] and cleanup["original_group_absent"]):
            try:
                cleanup["directory"] = _remove_job(original_job, cleanup_until, clock=loop.time)
                cleanup["job_removed"] = cleanup["directory"]["job_removed"]
            except BaseException as error:
                if primary is None:
                    primary = error
                phase_state.retain(error)
                try:
                    cleanup["directory"] = getattr(error, "sandbox_directory_cleanup", None)
                except BaseException as reporting:
                    if phase_state.recording_error is None:
                        phase_state.recording_error = reporting
                    phase_state.observation_incomplete = True
                phase_state.error("job-remove", error, cleanup)
        if not cleanup["job_removed"]:
            result["retained_job"] = original_job
        if cleanup["original_process_reaped"] and cleanup["original_group_absent"]:
            cleanup["descendants"] = ("PID_NAMESPACE_TERMINATED" if kind == "landlock" else
                                      "UNPROVEN_DETACHED_MAC" if child_processes else "FORK_DENIED")
        cleanup["complete"] = (cleanup["original_process_reaped"] and cleanup["original_group_absent"]
                               and cleanup["job_removed"] and not cleanup["errors"]
                               and cleanup["descendants"] in ("PID_NAMESPACE_TERMINATED", "FORK_DENIED"))
        for name, state in streams.items():
            result[name] = bytes(state["data"])
            result[name + "_bytes"] = state["bytes"]
            result[name + "_truncated"] = state["truncated"]
            result[name + "_eof"] = state["eof"]
        if primary is None and any(state["truncated"] for state in streams.values()):
            primary = SandboxOutputLimit("sandbox output limit exceeded")
        if phase_state is not None and (phase_state.observation_incomplete or phase_state.cleanup_task_unknown):
            cleanup["complete"] = False
            cleanup["observation_incomplete"] = True
        if primary is None and (cleanup["errors"] or cleanup.get("observation_incomplete")
                                or (require_complete_cleanup and not cleanup["complete"])):
            primary = SandboxCleanupError("sandbox cleanup incomplete")
        if spawn_attempted and loop.time() > cleanup_until:
            error = TimeoutError("sandbox total work and cleanup deadline exceeded")
            if primary is None:
                primary = error
            else:
                phase_state.error("total-deadline", error, cleanup)
            cleanup["complete"] = False
        result["spawn_attempted"] = spawn_attempted
        result["elapsed_seconds"] = loop.time() - started if spawn_attempted else None
        cleanup["prelaunch_complete"] = (not spawn_attempted and proc is None and cleanup["job_removed"]
                                         and not cleanup["errors"] and not cleanup.get("observation_incomplete"))
        if primary is not None:
            phase_state.retain(primary)
            try:
                result["primary_error"] = _failure("run", primary)
            except BaseException as reporting:
                if phase_state.recording_error is None:
                    phase_state.recording_error = reporting
                phase_state.observation_incomplete = True
            if phase_state.observation_incomplete:
                cleanup["observation_incomplete"] = True
                cleanup["complete"] = cleanup["prelaunch_complete"] = False
            try:
                primary.sandbox_result = result
            except BaseException as reporting:
                if phase_state.recording_error is None:
                    phase_state.recording_error = reporting
                phase_state.observation_incomplete = True
                cleanup["observation_incomplete"] = True
                cleanup["complete"] = cleanup["prelaunch_complete"] = False
    if primary is not None:
        raise primary
    return result
