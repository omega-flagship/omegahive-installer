"""bench-ops: what a live swarm costs to run and how well it holds up.

Boots a real hive with three real Omegas on the offline mock model and
measures, on the same run:
- resources: memory, CPU, threads, file descriptors and disk, per mind and for
  the server, idle and under load;
- power: energy per reply. Without a power meter this is estimated from CPU
  time (``HIVE_BENCH_WATTS_PER_CORE``, default 12 W per busy core); with
  Intel RAPL it is measured;
- cost: what the measured token use would cost on each priced model
  (projected: the mock model is free);
- efficiency: tokens, model calls and CPU time per reply, and how fast the
  prompt grows from cycle to cycle;
- accuracy: tasks with mechanically checked answers (beliefs land exactly,
  questions answered from the commons);
- reliability: a killed mind is restarted and gets its missed message, a
  failing model upstream is survived, the hive restarts with every belief
  intact, and a burst of messages is fully answered.
"""

from __future__ import annotations

import concurrent.futures
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

import httpx

from ..core.config import DEFAULT_PROVIDERS
from .harness import ProcSampler, dir_size_mb, latency_metrics, metric, pct, proc_group, descendants, series
from .protocol import emit
from .swarm import available

ROOT = pathlib.Path(__file__).resolve().parents[2]
WATTS_PER_CORE = float(os.environ.get("HIVE_BENCH_WATTS_PER_CORE", "12"))
RAPL = pathlib.Path("/sys/class/powercap/intel-rapl:0/energy_uj")


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait(predicate, timeout=120, step=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            value = predicate()
        except (httpx.HTTPError, ValueError, KeyError):
            value = None
        if value:
            return value
        time.sleep(step)
    return None


class LiveHive:
    def __init__(self):
        self.data = pathlib.Path(tempfile.mkdtemp(prefix="hive-ops-bench-"))
        self.port = _free_port()
        self.proc = None
        self.c = httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=60)

    def start(self):
        env = dict(os.environ, HIVE_DATA_DIR=str(self.data), HIVE_ADMIN_PASSWORD="bench", HIVE_PORT=str(self.port),
                   HIVE_PUBLIC_URL=f"http://127.0.0.1:{self.port}", HIVE_LOG_LEVEL="warning")
        self.log = open(self.data / "server.log", "a")
        self.proc = subprocess.Popen([sys.executable, "-m", "hive"], cwd=ROOT, env=env, stdout=self.log,
                                     stderr=subprocess.STDOUT)
        token = _wait(lambda: self.c.post("/api/auth/login", json={"password": "bench"}).json()["token"], 60)
        if not token:
            raise RuntimeError("hive did not start")
        self.c.headers["Authorization"] = f"Bearer {token}"

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()

    def cleanup(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def out(self, agent_id):
        return [m for m in self.c.get(f"/api/agents/{agent_id}/messages").json() if m["direction"] == "out"]

    def say(self, agent_id, text, timeout=90):
        """Send a message; returns (reply text, latency ms) or (None, None)."""
        before = len(self.out(agent_id))
        sent = time.perf_counter()
        self.c.post(f"/api/agents/{agent_id}/messages", json={"text": text})
        got = _wait(lambda: (lambda o: o[before:] if len(o) > before else None)(self.out(agent_id)), timeout)
        if not got:
            return None, None
        return got[0]["text"], (time.perf_counter() - sent) * 1000

    def usage(self):
        return self.c.get("/api/usage").json()


def _case(cid, name, group, dimension, start, metrics, series_=(), notes="", message=None, status=None):
    failing = [m["name"] for m in metrics if m.get("ok") is False]
    status = status or ("failed" if failing or message else "passed")
    emit("case", id=f"bench-ops::{cid}", name=name, group=group, dimension=dimension, status=status,
         duration_ms=round((time.perf_counter() - start) * 1000, 1),
         message=message or (f"missed target: {', '.join(failing)}" if failing else None),
         metrics=metrics, series=list(series_), notes=notes)
    return status


def _totals(snapshot):
    cpu = sum(v[0] for v in snapshot.values())
    rss = sum(v[1] for v in snapshot.values())
    return cpu, rss


def _rapl():
    try:
        return int(RAPL.read_text()) / 1e6
    except (OSError, ValueError):
        return None


def run():
    if not available():
        emit("case", id="bench-ops::boot", name="Live swarm operations", group="operations", dimension="resources",
             status="skipped", duration_ms=0, message="set PETTA_PATH and HIVE_CHROMADB_LIB to run real Omegas")
        return "skipped"
    hive = LiveHive()
    worst = "passed"

    def note(status):
        nonlocal worst
        order = ["passed", "skipped", "failed", "error"]
        worst = max(worst, status, key=order.index)

    try:
        hive.start()
        c = hive.c
        sampler = ProcSampler(hive.proc.pid, hive.data / "agents").start()
        swarm = c.post("/api/swarms", json={"name": "Ops"}).json()
        agents = {}
        for name in ("Vega", "Lyra", "Orion"):
            agents[name] = c.post("/api/agents", json={"name": name, "swarm_id": swarm["id"]}).json()
            c.post(f"/api/agents/{agents[name]['id']}/start")
        if not _wait(lambda: all(a["connected"] for a in c.get("/api/agents").json()), 180):
            raise RuntimeError("minds did not connect")
        ids = {a["id"]: n for n, a in agents.items()}

        # ---- resources while idle --------------------------------------------------------------
        start = time.perf_counter()
        idle_from = sampler.mark()
        usage_before_idle = len(hive.usage())
        time.sleep(15)
        idle = sampler.window(idle_from)
        idle_calls = len(hive.usage()) - usage_before_idle
        idle_cpu = _totals(idle[-1][1])[0] - _totals(idle[0][1])[0]
        idle_span = idle[-1][0] - idle[0][0]
        per_dot_rss = {ids.get(g, g): v[1] for g, v in idle[-1][1].items()}
        dot_rss = [v for g, v in per_dot_rss.items() if g != "server"]
        threads = sum(v[2] for v in idle[-1][1].values())
        fds = sum(v[3] for v in idle[-1][1].values())
        note(_case("idle", "Resources at idle", "resources", "resources", start,
                   [metric("memory per mind", max(dot_rss) if dot_rss else 0, "MB", "lower", 600),
                    metric("server memory", per_dot_rss.get("server", 0), "MB", "lower", 400),
                    metric("total memory", sum(per_dot_rss.values()), "MB", "lower", 2000),
                    metric("idle CPU", 100 * idle_cpu / max(idle_span, 1e-6), "% of a core", "lower", 50),
                    metric("threads", threads, "", "lower"),
                    metric("open files", fds, "", "lower", 2000),
                    metric("model calls while idle", idle_calls, "per 15 s", "lower", 3)],
                   [series("memory by process", [(i, v) for i, v in enumerate(per_dot_rss.values())], "MB", "bar",
                           " / ".join(per_dot_rss)),
                    series("total memory", [(t, _totals(s)[1]) for t, s in idle], "MB", "line", "s")],
                   notes="Three minds connected and waiting. Memory is resident set size summed over each mind's "
                         "processes (PeTTa plus its channel daemon)."))

        # ---- load: replies, efficiency, power --------------------------------------------------
        start = time.perf_counter()
        load_from = sampler.mark()
        rapl_start = _rapl()
        usage_start = len(hive.usage())
        jobs = [(a["id"], f"hello {n} {i}") for i in range(5) for n, a in agents.items()]
        latencies, answered = [], 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            for reply, ms in pool.map(lambda job: hive.say(*job), jobs):
                if reply is not None:
                    answered += 1
                    latencies.append(ms)
        load = sampler.window(load_from)
        rapl_end = _rapl()
        calls = hive.usage()[usage_start:]
        load_cpu = _totals(load[-1][1])[0] - _totals(load[0][1])[0]
        span = load[-1][0] - load[0][0]
        peak_rss = max(_totals(s)[1] for _, s in load)
        prompt_tokens = sum(u["prompt_tokens"] for u in calls)
        completion_tokens = sum(u["completion_tokens"] for u in calls)
        replies = max(1, answered)
        measured = rapl_start is not None and rapl_end is not None
        joules = (rapl_end - rapl_start) if measured else load_cpu * WATTS_PER_CORE
        note(_case("load", "Resources under load", "resources", "resources", start,
                   [metric("peak memory", peak_rss, "MB", "lower", 2500),
                    metric("CPU used", load_cpu, "core·s", "lower"),
                    metric("average CPU", 100 * load_cpu / max(span, 1e-6), "% of a core", "lower")],
                   [series("CPU", _rate(load), "% of a core", "line", "s"),
                    series("memory", [(t, _totals(s)[1]) for t, s in load], "MB", "line", "s")],
                   notes=f"{len(jobs)} messages, three at a time, across three minds."))
        note(_case("latency", "Reply latency under load", "latency", "latency", start,
                   latency_metrics("reply", latencies, 15000) + [metric("max", max(latencies or [0]), "ms", "lower")],
                   [series("reply latency", list(enumerate(latencies)), "ms", "bar", "message")],
                   notes="Includes the Omega loop's sleep between cycles (3 s), which dominates."))
        note(_case("power", "Energy per reply", "power", "power", start,
                   [metric("energy per reply", joules / replies, "J", "lower", 60),
                    metric("energy per 1000 replies", joules / replies * 1000 / 3600, "Wh", "lower"),
                    metric("idle power", idle_cpu / max(idle_span, 1e-6) * WATTS_PER_CORE, "W", "lower")],
                   notes=("Measured with Intel RAPL." if measured else
                          f"Estimated: no power meter is readable here, so energy is CPU time × "
                          f"{WATTS_PER_CORE:g} W per busy core (HIVE_BENCH_WATTS_PER_CORE). Excludes the model: "
                          "the mock model costs nothing to run.")))
        projections = []
        for provider in DEFAULT_PROVIDERS:
            for model, price in provider.prices.items():
                if model == "*":
                    continue
                usd = (prompt_tokens * price["in"] + completion_tokens * price["out"]) / 1e6 / replies
                projections.append((f"{provider.name}/{model}", usd))
        idle_per_day = idle_calls * (86400 / 15) * 3
        note(_case("cost", "Cost per reply (projected)", "cost", "cost", start,
                   [metric(f"per reply on {name}", usd, "$", "lower") for name, usd in projections]
                   + [metric("per 1000 replies on " + projections[-1][0], projections[-1][1] * 1000, "$", "lower")
                      if projections else metric("projections", 0, "", "lower"),
                      metric("idle model calls per mind-day", idle_per_day / 3, "", "lower", 1000)],
                   [series("cost per reply", [(i, usd * 1000) for i, (_, usd) in enumerate(projections)], "m$", "bar",
                           " / ".join(n.split("/")[-1] for n, _ in projections))],
                   notes="The run used the free mock model; these apply its measured tokens to each priced model. "
                         "A real model writes longer replies, so treat these as a floor."))
        note(_case("efficiency", "Efficiency", "efficiency", "efficiency", start,
                   [metric("model calls per reply", len(calls) / replies, "", "lower", 3),
                    metric("prompt tokens per reply", prompt_tokens / replies, "tokens", "lower", 12000),
                    metric("completion tokens per reply", completion_tokens / replies, "tokens", "lower"),
                    metric("CPU per reply", load_cpu * 1000 / replies, "ms", "lower", 4000),
                    metric("answered", 100 * answered / len(jobs), "%", "higher", 100)],
                   [series("prompt tokens per call", [(i, u["prompt_tokens"]) for i, u in enumerate(calls)], "tokens",
                           "line", "call")],
                   notes="Prompt size per call shows context growth: a steady climb means the context keeps "
                         "accumulating and will rot."))

        # ---- accuracy: tasks with checked answers ----------------------------------------------
        start = time.perf_counter()
        tasks = [("Vega", "(--> comet-a icy)", 0.9, 0.8), ("Lyra", "(--> comet-b rocky)", 0.7, 0.6),
                 ("Orion", "(--> comet-c bright)", 0.6, 0.9), ("Vega", "(--> comet-d fast)", 0.8, 0.5),
                 ("Lyra", "(--> comet-e old)", 0.95, 0.7)]
        correct, checks = 0, []
        for name, statement, f, conf in tasks:
            hive.say(agents[name]["id"], f"believe {statement} {f} {conf}")
            got = _wait(lambda: c.get(f"/api/swarms/{swarm['id']}/beliefs/detail",
                                      params={"statement": statement}).json().get("tv"), 30)
            ok = bool(got) and abs(got["f"] - f) < 1e-6 and abs(got["c"] - conf) < 1e-6
            correct += ok
            checks.append((len(checks), 1 if ok else 0))
        orion = agents["Orion"]["id"]
        seen = len(hive.out(orion))
        c.post(f"/api/agents/{orion}/messages", json={"text": "ask (Current (--> comet-a $x) $tv $st)"})
        # The mock model acknowledges and runs the query but never relays its result, so check what the
        # query returned in the mind's own trace.
        _ = seen
        recalled = bool(_wait(lambda: any("HIVE-QUERY" in str(t) and "icy" in str(t)
                                          for t in c.get(f"/api/agents/{orion}/traces", params={"limit": 50}).json()),
                              90))
        note(_case("accuracy", "Task accuracy", "accuracy", "accuracy", start,
                   [metric("beliefs stored exactly", 100 * correct / len(tasks), "%", "higher", 100),
                    metric("query returned the belief", recalled, "", "equal", 1)],
                   [series("task correct", checks, "", "bar", "task")],
                   notes="Mock model: this checks that instructions reach the commons exactly and come back on "
                         "request. Reasoning accuracy needs a real model (set HIVE_BENCH_MODEL)."))

        # ---- reliability ------------------------------------------------------------------------
        start = time.perf_counter()
        victim = agents["Lyra"]["id"]
        pids = [p for p in descendants(hive.proc.pid) if proc_group(p, hive.data / "agents") == victim]
        killed = time.perf_counter()
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        _wait(lambda: not c.get(f"/api/agents/{victim}").json()["connected"], 30)
        c.post(f"/api/agents/{victim}/messages", json={"text": "are you back?"})
        back = _wait(lambda: c.get(f"/api/agents/{victim}").json()["connected"], 120)
        recovery_s = time.perf_counter() - killed
        missed = _wait(lambda: any("are you back" in m["text"] for m in hive.out(victim)), 90)
        note(_case("crash", "Mind crash recovery", "reliability", "reliability", start,
                   [metric("restarted", bool(back), "", "equal", 1),
                    metric("recovery time", recovery_s, "s", "lower", 60),
                    metric("missed message answered", bool(missed), "", "equal", 1)],
                   notes=f"Killed all {len(pids)} processes of one mind with SIGKILL, then sent it a message "
                         "while it was down."))

        start = time.perf_counter()
        orion = agents["Orion"]["id"]
        c.patch(f"/api/agents/{orion}", json={"model": "local/unreachable"})
        c.post(f"/api/agents/{orion}/messages", json={"text": "hello while broken"})
        time.sleep(12)
        alive = c.get(f"/api/agents/{orion}").json()
        c.patch(f"/api/agents/{orion}", json={"model": "mock/echo"})
        healed, _ = hive.say(orion, "hello after the fix", timeout=120)
        note(_case("upstream", "Model outage survival", "reliability", "reliability", start,
                   [metric("mind stayed up", alive["status"] != "error", "", "equal", 1),
                    metric("answered after recovery", healed is not None, "", "equal", 1)],
                   notes="Pointed one mind at a model server that is not there for 12 s, then back."))

        start = time.perf_counter()
        before = {b["statement"]: b["tv"] for b in c.get(f"/api/swarms/{swarm['id']}/beliefs").json()}
        sampler.stop()
        hive.stop()
        restarted = time.perf_counter()
        hive.start()
        restored = _wait(lambda: all(a["connected"] for a in hive.c.get("/api/agents").json()), 180)
        restore_s = time.perf_counter() - restarted
        after = {b["statement"]: b["tv"] for b in hive.c.get(f"/api/swarms/{swarm['id']}/beliefs").json()}
        note(_case("restart", "Hive restart", "reliability", "reliability", start,
                   [metric("minds restored", bool(restored), "", "equal", 1),
                    metric("restore time", restore_s, "s", "lower", 90),
                    metric("beliefs intact", 100 * sum(after.get(k) == v for k, v in before.items())
                           / max(1, len(before)), "%", "equal", 100),
                    metric("disk used", dir_size_mb(hive.data), "MB", "lower", 500)],
                   notes=f"Stopped and restarted the hive server with {len(before)} beliefs in the commons."))

        start = time.perf_counter()
        burst = [(a["id"], f"burst {i}") for i in range(4) for a in agents.values()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda job: hive.say(*job, timeout=120), burst))
        ok = [ms for reply, ms in results if reply is not None]
        errors = [a["name"] for a in hive.c.get("/api/agents").json() if a["status"] == "error"]
        note(_case("burst", "Message burst after restart", "reliability", "reliability", start,
                   [metric("answered", 100 * len(ok) / len(burst), "%", "higher", 100),
                    metric("reply p95", pct(ok, 95), "ms", "lower", 20000),
                    metric("minds in error", len(errors), "", "equal", 0)],
                   notes="Twelve messages right after the restart."))
    except Exception as exc:
        import traceback
        emit("case", id="bench-ops::error", name="Live swarm operations", group="operations", dimension="reliability",
             status="error", duration_ms=0, message=traceback.format_exc()[-4000:])
        _ = exc
        worst = "error"
    finally:
        hive.stop()
        hive.cleanup()
    return worst


def _rate(samples):
    out = []
    for (t0, s0), (t1, s1) in zip(samples, samples[1:]):
        if t1 > t0:
            out.append((t1, 100 * (_totals(s1)[0] - _totals(s0)[0]) / (t1 - t0)))
    return out
