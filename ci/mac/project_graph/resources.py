"""Small, host-wide resource probes and conservative task admission advice.

RAM estimates are peak *additional task* RAM in GiB; CPU estimates are maximum
simultaneous core equivalents (100% in ``ps`` is one core). Existing processes
are already in host usage, so only the unobserved portion of each registered
task's declared peak is reserved. This is an estimate, not a quota or a promise
that an admitted process cannot later exhaust the machine. No command arguments
or environment variables are collected or exposed.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import threading
import time

HERE = Path(__file__).resolve().parent
POLICY_PATH = HERE / "resource-policy.json"
GIB = 1024 ** 3
ACTIVE_STATES = {"running", "starting", "started", "launching", "in_testing", "reserved"}
_cache = None
_cache_at = 0.0
_lock = threading.Lock()


def _utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _number(value, *, minimum=0, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        value = float(value)
    except OverflowError:
        return None
    if not math.isfinite(value) or value < minimum or (positive and value <= 0):
        return None
    return value


def load_policy(path=None):
    """Read tunable, versioned limits; malformed policies fail closed."""
    path = Path(path or POLICY_PATH)
    raw = path.read_bytes()
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("schema") != 1:
        raise ValueError("Resource policy schema must be 1")
    positive = ("sample_cache_seconds", "max_metric_age_seconds", "memory_reserve_gb",
                "cpu_busy_limit_percent", "disk_reserve_gb", "heavy_ram_gb", "heavy_cpu_cores")
    for name in positive:
        if _number(data.get(name), positive=True) is None:
            raise ValueError(f"Resource policy {name} must be positive and finite")
    for name in ("memory_reserve_fraction", "memory_warning_fraction", "memory_critical_fraction",
                 "disk_reserve_fraction"):
        value = _number(data.get(name))
        if value is None or value >= 1:
            raise ValueError(f"Resource policy {name} must be between 0 and 1")
    if data["cpu_busy_limit_percent"] > 100:
        raise ValueError("Resource policy CPU limit cannot exceed 100%")
    if data["memory_critical_fraction"] >= data["memory_warning_fraction"]:
        raise ValueError("Resource policy critical memory fraction must be below warning fraction")
    if not isinstance(data.get("benchmark_isolation"), bool):
        raise ValueError("Resource policy benchmark_isolation must be boolean")
    data.update({"sha256": hashlib.sha256(raw).hexdigest(), "source": "project_graph/resource-policy.json"})
    return data


def normalize_estimate(estimate):
    """Validate peak resource declarations. disk_gb may be zero."""
    if not isinstance(estimate, dict):
        raise ValueError("Resource estimate must be an object")
    normalized = {}
    for key in ("ram_gb", "cpu_cores", "disk_gb"):
        value = _number(estimate.get(key), positive=key != "disk_gb")
        if value is None:
            comparison = "positive" if key != "disk_gb" else "nonnegative"
            raise ValueError(f"{key} must be {comparison} and finite")
        if key in {"ram_gb", "disk_gb"} and not math.isfinite(value * GIB):
            raise ValueError(f"{key} is too large to represent as bytes")
        normalized[key] = value
    kind = estimate.get("kind", "task")
    if not isinstance(kind, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", kind):
        raise ValueError("Task kind must be a short lower-case identifier")
    normalized["kind"] = kind
    return normalized


def _run(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=4, check=False)
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return None, f"{Path(command[0]).name} probe unavailable"
    if result.returncode:
        return None, f"{Path(command[0]).name} probe failed (exit {result.returncode})"
    return result.stdout, None


def parse_vm_stat(text):
    """Return macOS vm_stat page counts in bytes using the reported page size."""
    match = re.search(r"page size of\s+(\d+)\s+bytes", text or "")
    if not match:
        raise ValueError("vm_stat page size is unavailable")
    page_size = int(match.group(1))
    if page_size <= 0:
        raise ValueError("vm_stat page size is invalid")
    values = {}
    for line in text.splitlines():
        match = re.match(r"([^:]+):\s*(\d+)\.?\s*$", line)
        if match:
            values[match.group(1).strip()] = int(match.group(2)) * page_size
    required = ("Pages free", "Pages inactive", "Pages speculative")
    if any(key not in values for key in required):
        raise ValueError("vm_stat available-memory counters are unavailable")
    return values


def _size_bytes(number, unit):
    return int(float(number) * (1024 ** {"B": 0, "K": 1, "M": 2, "G": 3, "T": 4}[unit.upper()]))


def parse_mac_memory(vm_text, total_bytes, pressure_value=None, top_text=None):
    values = parse_vm_stat(vm_text)
    total = int(total_bytes)
    if total <= 0:
        raise ValueError("Physical memory size is invalid")
    available = min(total, sum(values[key] for key in ("Pages free", "Pages inactive", "Pages speculative")))
    # Occupied memory includes reclaimable cache and must not by itself gate RAM.
    used = max(0, total - values["Pages free"] - values["Pages speculative"])
    match = re.search(r"PhysMem:\s*([\d.]+)([BKMGTP])(?:B)?\s+used", top_text or "", re.I)
    if match and match.group(2).upper() != "P":
        used = min(total, _size_bytes(match.group(1), match.group(2)))
    try:
        pressure = {1: "normal", 2: "warning", 4: "critical"}.get(int(str(pressure_value).strip()), "unknown")
    except (ValueError, TypeError):
        pressure = "unknown"
    return {"total_bytes": total, "used_bytes": used, "used_percent": round(used / total * 100, 2),
            "available_estimate_bytes": available, "available_basis": "free + inactive + speculative pages; reclaimable estimate",
            "pressure": pressure, "source": "sysctl + vm_stat" + (" + top" if match else "")}


def parse_mac_cpu(text):
    match = re.search(r"CPU usage:.*?([\d.]+)%\s+idle", text or "", re.I)
    if not match:
        raise ValueError("macOS CPU usage is unavailable")
    idle = float(match.group(1))
    if not 0 <= idle <= 100:
        raise ValueError("macOS CPU idle percentage is invalid")
    return round(100 - idle, 2)


def parse_linux_memory(text, policy=None):
    policy = policy or load_policy()
    values = {}
    for line in (text or "").splitlines():
        match = re.match(r"(\w+):\s+(\d+)(?:\s+(kB))?", line)
        if match:
            values[match.group(1)] = int(match.group(2)) * (1024 if match.group(3) else 1)
    total = values.get("MemTotal", 0)
    if total <= 0 or "MemAvailable" not in values or "MemFree" not in values:
        raise ValueError("Linux MemAvailable or physical-memory counters are unavailable")
    available = min(total, values["MemAvailable"])
    used = max(0, total - values["MemFree"])
    ratio = available / total
    pressure = ("critical" if ratio < policy["memory_critical_fraction"] else
                "warning" if ratio < policy["memory_warning_fraction"] else "normal")
    return {"total_bytes": total, "used_bytes": used, "used_percent": round(used / total * 100, 2),
            "available_estimate_bytes": available, "available_basis": "Linux MemAvailable; includes reclaimable cache",
            "pressure": pressure, "source": "/proc/meminfo"}


def parse_linux_cpu(text):
    """Aggregate CPU counters, excluding guest counters already included in user."""
    match = re.search(r"^cpu\s+(.*)$", text or "", re.M)
    if not match:
        raise ValueError("Aggregate Linux CPU counters are unavailable")
    try:
        values = [int(value) for value in match.group(1).split()]
    except ValueError as exc:
        raise ValueError("Invalid Linux CPU counters") from exc
    if len(values) < 4 or any(value < 0 for value in values):
        raise ValueError("Incomplete Linux CPU counters")
    total = sum(values[:8])
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return total, idle


def linux_cpu_busy(before, after):
    total = after[0] - before[0]
    idle = after[1] - before[1]
    if total <= 0 or idle < 0 or idle > total:
        raise ValueError("Linux CPU differential sample is unavailable")
    return round((total - idle) / total * 100, 2)


def parse_processes(text):
    rows = []
    for line in (text or "").splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) != 5:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
            cpu, rss = float(parts[2]), int(parts[3]) * 1024
        except ValueError:
            continue
        if pid <= 0 or ppid < 0 or not math.isfinite(cpu) or cpu < 0 or rss < 0:
            continue
        # comm contains executable names, not argv. Discard paths and controls.
        name = parts[4].replace("\\", "/").rsplit("/", 1)[-1]
        name = "".join(char for char in name if char.isprintable())[:120] or "unknown"
        rows.append({"pid": pid, "ppid": ppid, "name": name, "cpu_percent": cpu, "rss_bytes": rss})
    return rows


def _empty_sample(system):
    return {"checked_at": _utcnow(), "platform": system,
            "memory": {"total_bytes": None, "used_bytes": None, "used_percent": None,
                       "available_estimate_bytes": None, "available_basis": "unavailable", "pressure": "unknown", "source": "unavailable"},
            "cpu": {"busy_percent": None, "logical_cores": os.cpu_count(), "load_1m": None, "load_5m": None, "source": "unavailable"},
            "processes": {"count": None, "top": [], "rows": []}, "warnings": []}


def _collect(policy):
    system = platform.system()
    result = _empty_sample(system)
    warnings = result["warnings"]
    try:
        load = os.getloadavg()
        result["cpu"].update({"load_1m": round(load[0], 2), "load_5m": round(load[1], 2)})
    except (OSError, AttributeError):
        warnings.append("Host load average is unavailable")
    if system == "Darwin":
        commands = (["sysctl", "-n", "hw.memsize"], ["sysctl", "-n", "hw.logicalcpu"],
                    ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], ["vm_stat"], ["top", "-l", "1", "-n", "0"])
        outputs = []
        for command in commands:
            output, error = _run(command)
            outputs.append(output)
            if error:
                warnings.append(error)
        total, cores, pressure, vm, top = outputs
        try:
            result["memory"] = parse_mac_memory(vm, total, pressure, top)
        except (ValueError, TypeError):
            warnings.append("Host RAM probe unavailable; run monitoring outside the execution sandbox")
        try:
            result["cpu"]["logical_cores"] = int(cores.strip())
        except (ValueError, AttributeError):
            warnings.append("Native logical CPU count unavailable; using Python host count")
        try:
            result["cpu"].update({"busy_percent": parse_mac_cpu(top), "source": "top host CPU usage"})
        except ValueError:
            warnings.append("Host CPU usage unavailable; run monitoring outside the execution sandbox")
        if result["memory"]["pressure"] == "unknown":
            warnings.append("Host RAM pressure level unavailable")
    elif system == "Linux":
        try:
            result["memory"] = parse_linux_memory(Path("/proc/meminfo").read_text(), policy)
        except (OSError, ValueError):
            warnings.append("Host RAM probe unavailable")
        try:
            before = parse_linux_cpu(Path("/proc/stat").read_text())
            time.sleep(0.12)
            after = parse_linux_cpu(Path("/proc/stat").read_text())
            result["cpu"].update({"busy_percent": linux_cpu_busy(before, after), "source": "/proc/stat 120 ms differential"})
        except (OSError, ValueError):
            warnings.append("Host CPU usage unavailable")
    else:
        warnings.append(f"Host resource probes are unsupported on {system}")
    output, error = _run(["ps", "-axo", "pid=,ppid=,%cpu=,rss=,comm="])
    if error:
        warnings.append(error)
    else:
        rows = parse_processes(output)
        if rows:
            result["processes"] = {"count": len(rows), "top": sorted(rows, key=lambda row: (row["cpu_percent"], row["rss_bytes"]), reverse=True)[:12], "rows": rows}
        else:
            warnings.append("Process inventory unavailable")
    result["checked_at"] = _utcnow()
    return result


def sample(force=False):
    """Read host state, cached for five seconds by the default local policy."""
    global _cache, _cache_at
    policy = load_policy()
    with _lock:
        now = time.monotonic()
        if not force and _cache is not None and now - _cache_at < policy["sample_cache_seconds"]:
            return copy.deepcopy(_cache)
        _cache = _collect(policy)
        _cache_at = time.monotonic()
        return copy.deepcopy(_cache)


def _observed_subtree(pid, rows):
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return 0, 0
    descendants = {pid}
    children = {}
    by_pid = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("pid"), int):
            continue
        by_pid[row["pid"]] = row
        children.setdefault(row.get("ppid"), []).append(row["pid"])
    pending = [pid]
    while pending:
        current = pending.pop()
        for child in children.get(current, []):
            if child not in descendants:
                descendants.add(child)
                pending.append(child)
    rss = cpu = 0
    for descendant in descendants:
        row = by_pid.get(descendant, {})
        rss += _number(row.get("rss_bytes")) or 0
        cpu += (_number(row.get("cpu_percent")) or 0) / 100
    return rss, cpu


def advise(snapshot, estimate, running_tasks=None):
    """Advise run/wait/unknown; unknown is a closed gate, never permission to run."""
    estimate = normalize_estimate(estimate)
    policy = load_policy()
    if not isinstance(snapshot, dict):
        raise ValueError("Resource snapshot must be an object")
    memory, cpu, disk = (snapshot.get(key) if isinstance(snapshot.get(key), dict) else {}
                         for key in ("memory", "cpu", "disk"))
    total = _number(memory.get("total_bytes"), positive=True)
    available = _number(memory.get("available_estimate_bytes"))
    busy = _number(cpu.get("busy_percent"))
    cores = _number(cpu.get("logical_cores"), positive=True)
    disk_total = _number(disk.get("total_bytes"), positive=True)
    disk_free = _number(disk.get("free_bytes"))
    reasons, unknown = [], []
    if total is None or available is None or available > total:
        unknown.append("Host available RAM is unavailable or invalid; wait for a valid host sample")
    if memory.get("pressure") not in {"normal", "warning", "critical"}:
        unknown.append("Host RAM pressure is unknown; wait for a valid host sample")
    if busy is None or busy > 100 or cores is None:
        unknown.append("Host CPU usage is unavailable or invalid; wait for a valid host sample")
    if disk_total is None or disk_free is None or disk_free > disk_total:
        unknown.append("Workspace disk space is unavailable or invalid; wait for a valid host sample")
    try:
        checked = datetime.fromisoformat(snapshot["checked_at"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - checked).total_seconds()
        if age < -5 or age > policy["max_metric_age_seconds"]:
            unknown.append("Host resource sample is stale; refresh before admission")
    except (KeyError, TypeError, ValueError, AttributeError):
        unknown.append("Host resource sample time is unavailable")
    ram_reservations = cpu_reservations = disk_reservations = 0
    active = []
    processes = snapshot.get("processes") if isinstance(snapshot.get("processes"), dict) else {}
    rows = processes.get("rows") if isinstance(processes.get("rows"), list) else []
    for task in running_tasks or []:
        if not isinstance(task, dict) or task.get("state") not in ACTIVE_STATES:
            continue
        active.append(task)
        try:
            declaration = normalize_estimate(task.get("estimate") or task)
        except ValueError:
            unknown.append("A running task has an invalid resource declaration; reconcile task inventory")
            continue
        observed_ram, observed_cpu = _observed_subtree(task.get("pid"), rows)
        ram_reservations += max(0, declaration["ram_gb"] * GIB - observed_ram)
        cpu_reservations += max(0, declaration["cpu_cores"] - observed_cpu)
        # Disk growth is not process-attributable; reserve declared remaining growth conservatively.
        disk_reservations += declaration["disk_gb"] * GIB
    headroom = {"ram_bytes": None, "cpu_cores": None, "disk_bytes": None}
    if total is not None and available is not None:
        reserve = max(policy["memory_reserve_gb"] * GIB, total * policy["memory_reserve_fraction"])
        headroom["ram_bytes"] = int(available - reserve - ram_reservations)
        if estimate["ram_gb"] * GIB > headroom["ram_bytes"]:
            reasons.append("Task RAM peak plus outstanding reservations would consume the host memory reserve")
    if busy is not None and cores is not None:
        headroom["cpu_cores"] = round(cores * (policy["cpu_busy_limit_percent"] - busy) / 100 - cpu_reservations, 3)
        if estimate["cpu_cores"] > headroom["cpu_cores"]:
            reasons.append(f"Predicted CPU peak exceeds the {policy['cpu_busy_limit_percent']:g}% host limit")
    if disk_total is not None and disk_free is not None:
        reserve = max(policy["disk_reserve_gb"] * GIB, disk_total * policy["disk_reserve_fraction"])
        headroom["disk_bytes"] = int(disk_free - reserve - disk_reservations)
        if estimate["disk_gb"] * GIB > headroom["disk_bytes"]:
            reasons.append("Task disk growth plus outstanding reservations would consume the disk reserve")
    heavy = estimate["ram_gb"] >= policy["heavy_ram_gb"] or estimate["cpu_cores"] >= policy["heavy_cpu_cores"]
    pressure = memory.get("pressure")
    if pressure == "critical" or (pressure == "warning" and heavy):
        reasons.append(f"Host RAM pressure is {pressure}; defer {'the task' if pressure == 'critical' else 'heavy tasks'}")
    if policy["benchmark_isolation"] and active:
        active_benchmark = any((task["estimate"] if isinstance(task.get("estimate"), dict) else task).get("kind") == "benchmark"
                               for task in active)
        if estimate["kind"] == "benchmark" or active_benchmark:
            reasons.append("Benchmarks require isolation from other registered running tasks")
    decision = "unknown" if unknown else "wait" if reasons else "run"
    if decision == "run":
        reasons.append("Declared task peaks fit current headroom and host pressure limits")
    return {"decision": decision, "reasons": unknown + reasons, "headroom": headroom,
            "estimate": estimate, "policy": policy}
