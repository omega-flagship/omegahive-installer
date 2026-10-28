"""A throwaway in-process hive for benchmarks, and small measuring helpers."""

from __future__ import annotations

import contextlib
import pathlib
import shutil
import statistics
import tempfile
import time

from fastapi.testclient import TestClient

from ..core.app import create_app
from ..core.config import load_settings
from .names import legacy_metric_names


class NullSupervisor:
    """Agents are never started: benchmarks drive the agent API directly."""

    def attach(self, hive):
        self.hive = hive

    def prepare(self, agent, token):
        pass

    def reconfigure(self, agent):
        pass

    def start(self, agent_id):
        pass

    def stop(self, agent_id):
        pass

    def logs(self, agent_id, tail=200):
        return []

    def check(self):
        pass


class Bench:
    def __init__(self, client):
        self.client = client
        self.hive = client.app.state.hive

    def swarm(self, name="Bench"):
        return self.client.post("/api/swarms", json={"name": name}).json()

    def agents(self, swarm, n, **fields):
        return [self.client.post("/api/agents", json=dict({"name": f"B{i}", "swarm_id": swarm["id"]}, **fields)).json()
                for i in range(n)]

    def as_agent(self, agent):
        return {"Authorization": f"Bearer {agent['token']}"}

    def post(self, agent, path, body=None):
        return self.client.post(path, headers=self.as_agent(agent), json=body or {})

    def get(self, agent, path, **params):
        return self.client.get(path, headers=self.as_agent(agent), params=params)

    def publish(self, agent, statement, f=0.9, c=0.8, **extra):
        return self.post(agent, "/api/agent/publish", dict({"statement": statement, "f": f, "c": c}, **extra)).json()

    def belief(self, swarm, statement):
        detail = self.client.get(f"/api/swarms/{swarm['id']}/beliefs/detail", params={"statement": statement})
        return detail.json() if detail.status_code == 200 else None


@contextlib.contextmanager
def scratch_hive(**settings):
    data = pathlib.Path(tempfile.mkdtemp(prefix="hive-bench-"))
    config = load_settings(data_dir=data, admin_password="bench", **settings)
    app = create_app(config, supervisor=NullSupervisor(), reconcile_seconds=0)
    try:
        with TestClient(app) as client:
            token = client.post("/api/auth/login", json={"password": "bench"}).json()["token"]
            client.headers["Authorization"] = f"Bearer {token}"
            yield Bench(client)
    finally:
        shutil.rmtree(data, ignore_errors=True)


def timed(fn):
    start = time.perf_counter()
    value = fn()
    return value, (time.perf_counter() - start) * 1000


def pct(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(q / 100 * (len(ordered) - 1))))
    return ordered[index]


def latency_metrics(prefix, samples_ms, p95_target=None):
    p50, p95 = pct(samples_ms, 50), pct(samples_ms, 95)
    metrics = [metric(f"{prefix} p50", p50, "ms", "lower"),
               metric(f"{prefix} p95", p95, "ms", "lower", p95_target)]
    if samples_ms:
        metrics.append(metric(f"{prefix} mean", statistics.fmean(samples_ms), "ms", "lower"))
    return metrics


def metric(name, value, unit="", better="lower", target=None):
    """A measured value; ``target`` is the pass line (lower: <=, higher: >=, equal: ==)."""
    value = round(float(value), 6)
    ok = None
    if target is not None:
        ok = {"lower": value <= target, "higher": value >= target,
              "equal": abs(value - target) < 1e-9}[better]
    out = {"name": name, "value": value, "unit": unit, "better": better, "target": target, "ok": ok}
    legacy = legacy_metric_names(name)
    if legacy:  # a renamed metric: History and Compare pair it with runs stored under its old name
        out["legacy_names"] = legacy
    return out


def series(name, points, unit="", kind="line", x="step"):
    return {"name": name, "unit": unit, "kind": kind, "x": x,
            "points": [[round(float(a), 6), round(float(b), 6)] for a, b in points]}


def histogram(name, samples_ms, buckets=12, unit="ms"):
    if not samples_ms:
        return series(name, [], unit, "bar", "ms")
    low, high = min(samples_ms), max(samples_ms)
    width = (high - low) / buckets or 1.0
    counts = [0] * buckets
    for value in samples_ms:
        counts[min(buckets - 1, int((value - low) / width))] += 1
    return series(name, [(low + (i + 0.5) * width, n) for i, n in enumerate(counts)], "count", "bar", unit)


# ---- process sampling from /proc (no psutil needed) ---------------------------------------------

import os as _os
import threading as _threading

CLOCK_TICKS = _os.sysconf("SC_CLK_TCK")
PAGE_KB = _os.sysconf("SC_PAGE_SIZE") // 1024


def _children_map():
    kids = {}
    for name in _os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as handle:
                fields = handle.read().rsplit(")", 1)[1].split()
            kids.setdefault(int(fields[1]), []).append(int(name))
        except (OSError, IndexError):
            continue
    return kids


def descendants(root):
    kids, out, todo = _children_map(), [], [root]
    while todo:
        pid = todo.pop()
        out.append(pid)
        todo.extend(kids.get(pid, []))
    return out


def proc_stats(pid):
    """(cpu_seconds, rss_mb, threads, fds) for one process, or None if it is gone."""
    try:
        with open(f"/proc/{pid}/stat") as handle:
            fields = handle.read().rsplit(")", 1)[1].split()
        cpu = (int(fields[11]) + int(fields[12])) / CLOCK_TICKS
        threads = int(fields[17])
        rss = int(fields[21]) * PAGE_KB / 1024
        fds = len(_os.listdir(f"/proc/{pid}/fd"))
        return cpu, rss, threads, fds
    except (OSError, IndexError, ValueError):
        return None


def proc_group(pid, agents_dir):
    """Which agent a process belongs to (by its working directory), else 'server'."""
    try:
        cwd = _os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return "server"
    prefix = str(agents_dir) + "/"
    if cwd.startswith(prefix):
        return cwd[len(prefix):].split("/", 1)[0]
    return "server"


class ProcSampler:
    """Samples CPU, memory, threads and file descriptors of a process tree, grouped by agent."""

    def __init__(self, root_pid, agents_dir, interval=0.5):
        self.root, self.agents_dir, self.interval = root_pid, agents_dir, interval
        self.samples = []  # (t, {group: (cpu_s, rss_mb, threads, fds)})
        self._stop = _threading.Event()
        self._thread = None
        self._t0 = time.perf_counter()

    def snapshot(self):
        groups = {}
        for pid in descendants(self.root):
            stats = proc_stats(pid)
            if stats is None:
                continue
            group = proc_group(pid, self.agents_dir)
            cpu, rss, threads, fds = groups.get(group, (0.0, 0.0, 0, 0))
            groups[group] = (cpu + stats[0], rss + stats[1], threads + stats[2], fds + stats[3])
        return groups

    def _loop(self):
        while not self._stop.is_set():
            self.samples.append((time.perf_counter() - self._t0, self.snapshot()))
            self._stop.wait(self.interval)

    def start(self):
        self._thread = _threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join()

    def mark(self):
        return len(self.samples)

    def window(self, start, end=None):
        return self.samples[start:end]


def dir_size_mb(path):
    total = 0
    for base, _dirs, files in _os.walk(path):
        for name in files:
            try:
                total += _os.path.getsize(_os.path.join(base, name))
            except OSError:
                pass
    return total / (1024 * 1024)
