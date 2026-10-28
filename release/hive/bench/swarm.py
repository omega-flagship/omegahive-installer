"""bench-swarm: a real hive with three real Omega agents on the offline mock model.

Needs PeTTa (PETTA_PATH) and the chromadb MeTTa library (HIVE_CHROMADB_LIB).
Measures what a person waiting on a mind feels: boot time, reply latency,
how fast a belief reaches the commons, loop rate, model calls per reply.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import httpx

from .harness import latency_metrics, metric, series
from .protocol import emit

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait(predicate, timeout=120, step=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


def _case(cid, name, group, start, metrics, series_=(), notes="", message=None):
    failing = [m["name"] for m in metrics if m.get("ok") is False]
    status = "failed" if failing or message else "passed"
    dimension = {"boot": "latency", "reply": "latency", "belief": "latency", "loop": "efficiency"}.get(cid, "reliability")
    emit("case", id=f"bench-swarm::{cid}", name=name, group=group, dimension=dimension, status=status,
         duration_ms=round((time.perf_counter() - start) * 1000, 1),
         message=message or (f"missed target: {', '.join(failing)}" if failing else None),
         metrics=metrics, series=list(series_), notes=notes)
    return status


def available():
    petta = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
    lib = os.environ.get("HIVE_CHROMADB_LIB", "")
    return (pathlib.Path(petta) / "run.sh").exists() and lib and pathlib.Path(lib).exists()


def run():
    if not available():
        emit("case", id="bench-swarm::boot", name="Swarm boot", group="swarm", status="skipped", duration_ms=0,
             message="set PETTA_PATH and HIVE_CHROMADB_LIB to run real Omegas")
        return "skipped"
    data = pathlib.Path(tempfile.mkdtemp(prefix="hive-swarm-bench-"))
    port = _free_port()
    env = dict(os.environ, HIVE_DATA_DIR=str(data), HIVE_ADMIN_PASSWORD="bench", HIVE_PORT=str(port),
               HIVE_PUBLIC_URL=f"http://127.0.0.1:{port}", HIVE_LOG_LEVEL="warning")
    log = open(data / "server.log", "a")
    proc = subprocess.Popen([sys.executable, "-m", "hive"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    c = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60)
    overall = "passed"
    try:
        token = _wait(lambda: _login(c), timeout=60)
        if not token:
            raise RuntimeError("hive did not start")
        c.headers["Authorization"] = f"Bearer {token}"

        # 1. boot
        start = time.perf_counter()
        swarm = c.post("/api/swarms", json={"name": "Bench swarm"}).json()
        agents = {}
        for name in ("Vega", "Lyra", "Orion"):
            agents[name] = c.post("/api/agents", json={"name": name, "swarm_id": swarm["id"]}).json()
            c.post(f"/api/agents/{agents[name]['id']}/start")
        boot = {}
        for name, agent in agents.items():
            ok = _wait(lambda: c.get(f"/api/agents/{agent['id']}").json()["connected"], timeout=180)
            boot[name] = (time.perf_counter() - start) * 1000 if ok else None
        times = [v for v in boot.values() if v is not None]
        overall = _worst(overall, _case("boot", "Swarm boot", "swarm", start,
                         [metric("minds connected", len(times), "", "equal", 3),
                          metric("slowest boot", max(times) if times else 0, "ms", "lower", 120000)],
                         [series("boot time", [(i, v) for i, v in enumerate(times)], "ms", "bar", "mind")],
                         notes="Process start to hub connection, including PeTTa compile."))
        if len(times) < 3:
            return "failed"

        # 2. reply latency
        start = time.perf_counter()
        samples, vega = [], agents["Vega"]["id"]
        for i in range(6):
            sent = time.perf_counter()
            count = len(_out(c, vega))
            c.post(f"/api/agents/{vega}/messages", json={"text": f"hello Vega {i}"})
            if _wait(lambda: len(_out(c, vega)) > count, timeout=90):
                samples.append((time.perf_counter() - sent) * 1000)
        overall = _worst(overall, _case("reply", "Reply latency", "swarm", start,
                         latency_metrics("reply", samples, 30000) + [metric("replies", len(samples), "", "equal", 6)],
                         [series("reply latency", list(enumerate(samples)), "ms")],
                         notes="Operator message to the mind's reply, through a full Omega loop cycle."))

        # 3. belief propagation
        start = time.perf_counter()
        prop = []
        reports = {"Vega": (0.9, 0.8), "Lyra": (0.95, 0.7), "Orion": (0.1, 0.6)}
        for i, (name, (f, conf)) in enumerate(reports.items()):
            sent = time.perf_counter()
            c.post(f"/api/agents/{agents[name]['id']}/messages", json={"text": f"believe (--> sky blue) {f} {conf}"})
            got = _wait(lambda: len(_detail(c, swarm).get("assertions", [])) > i, timeout=90)
            if got:
                prop.append((time.perf_counter() - sent) * 1000)
        detail = _detail(c, swarm)
        tv = detail.get("tv", {})
        overall = _worst(overall, _case("belief", "Belief propagation", "commons", start,
                         latency_metrics("to commons", prop, 30000)
                         + [metric("final f", tv.get("f", 0), "", "equal", 0.761702),
                            metric("final c", tv.get("c", 0), "", "equal", 0.886792)],
                         [series("propagation", list(enumerate(prop)), "ms", "bar", "mind")],
                         notes="Tell three minds a belief; time until it is revised into the shared commons."))

        # 4. loop health
        start = time.perf_counter()
        usage = c.get("/api/usage").json()
        traces = sum(len(c.get(f"/api/agents/{a['id']}/traces", params={"limit": 500}).json()) for a in agents.values())
        errors = [a["name"] for a in c.get("/api/agents").json() if a.get("last_error")]
        replies = len(samples) + len(prop)
        overall = _worst(overall, _case("loop", "Loop health", "swarm", start,
                         [metric("model calls", len(usage), "", "lower", 120),
                          metric("calls per reply", len(usage) / max(1, replies), "", "lower", 12),
                          metric("traced cycles", traces, "", "higher", 1),
                          metric("minds with errors", len(errors), "", "equal", 0)],
                         notes=f"Over the whole run. Errors: {', '.join(errors) or 'none'}."))
        return overall
    except Exception as exc:
        emit("case", id="bench-swarm::error", name="Swarm run", group="swarm", status="error", duration_ms=0,
             message=repr(exc))
        return "error"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        shutil.rmtree(data, ignore_errors=True)


def _login(c):
    try:
        return c.post("/api/auth/login", json={"password": "bench"}).json()["token"]
    except (httpx.HTTPError, KeyError, ValueError):
        return None


def _out(c, agent_id):
    return [m for m in c.get(f"/api/agents/{agent_id}/messages").json() if m["direction"] == "out"]


def _detail(c, swarm):
    response = c.get(f"/api/swarms/{swarm['id']}/beliefs/detail", params={"statement": "(--> sky blue)"})
    return response.json() if response.status_code == 200 else {}


def _worst(a, b):
    order = ["passed", "skipped", "failed", "error"]
    return max(a, b, key=order.index)
