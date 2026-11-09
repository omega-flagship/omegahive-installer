"""Benchmarks and drift scenarios.  Each one returns a Lab case body.

Run through the Lab (``python -m hive.bench run bench-core``) or the API.
Targets are pass lines chosen to catch regressions on a laptop-class box, not
to flatter: a metric with no target is informational.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time

import httpx

from .harness import histogram, latency_metrics, metric, scratch_hive, series, timed

REGISTRY: dict[str, list] = {}


def bench(suite, name, group, notes="", dimension="drift"):
    def wrap(fn):
        REGISTRY.setdefault(suite, []).append({"id": f"{suite}::{fn.__name__}", "name": name, "group": group,
                                               "notes": notes, "fn": fn, "dimension": dimension})
        return fn
    return wrap


def revise(a, b):
    """NAL revision for independent evidence (k = 1)."""
    (f1, c1), (f2, c2) = a, b
    w1, w2 = c1 / (1 - c1), c2 / (1 - c2)
    w = w1 + w2
    return (w1 * f1 + w2 * f2) / w, w / (w + 1)


# ---- bench-core: how fast and how correct the hive itself is ------------------------------------

@bench("bench-core", "Publish throughput", "commons",
       "Four minds publish 200 distinct beliefs into one swarm commons (PeTTa AtomSpace).", dimension="latency")
def publish_throughput():
    with scratch_hive() as b:
        swarm = b.swarm()
        agents = b.agents(swarm, 4)
        samples = []
        start = time.perf_counter()
        for i in range(200):
            _, ms = timed(lambda: b.publish(agents[i % 4], f"(--> item{i} useful)", 0.8, 0.7))
            samples.append(ms)
        total = time.perf_counter() - start
        return {"metrics": [metric("throughput", 200 / total, "ops/s", "higher", 20)]
                + latency_metrics("publish", samples, 150),
                "series": [series("publish latency", list(enumerate(samples)), "ms"),
                           histogram("latency distribution", samples)]}


@bench("bench-core", "Query latency at 300 beliefs", "commons",
       "Pattern queries against a commons holding 300 beliefs.", dimension="latency")
def query_latency():
    with scratch_hive() as b:
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        for i in range(300):
            b.publish(a, f"(--> star{i} bright)", 0.9, 0.6)
        samples = []
        for i in range(60):
            pattern = "(Current $s $t $st)" if i % 3 == 0 else f"(Current (--> star{i * 5} $x) $t $st)"
            _, ms = timed(lambda: b.post(a, "/api/agent/query", {"pattern": pattern}))
            samples.append(ms)
        full = b.post(a, "/api/agent/query", {"pattern": "(Current $s $t $st)"}).json()["results"]
        return {"metrics": latency_metrics("query", samples, 400) + [metric("beliefs returned", len(full), "",
                                                                             "equal", 300)],
                "series": [series("query latency", list(enumerate(samples)), "ms")]}


@bench("bench-core", "Revision accuracy", "commons",
       "Ten independent minds report the same statement with different truth values; the commons must match "
       "NAL revision exactly.", dimension="accuracy")
def revision_accuracy():
    reports = [(0.9, 0.8), (0.7, 0.6), (0.95, 0.5), (0.2, 0.4), (0.8, 0.9),
               (0.6, 0.55), (0.85, 0.7), (0.4, 0.3), (0.9, 0.65), (0.75, 0.8)]
    with scratch_hive() as b:
        swarm = b.swarm()
        agents = b.agents(swarm, len(reports))
        expected = reports[0]
        worst = 0.0
        hive_c, model_c = [], []
        for i, (agent, tv) in enumerate(zip(agents, reports)):
            b.publish(agent, "(--> sky blue)", *tv)
            if i:
                expected = revise(expected, tv)
            got = b.belief(swarm, "(--> sky blue)")["tv"]
            worst = max(worst, abs(got["f"] - expected[0]), abs(got["c"] - expected[1]))
            hive_c.append((i + 1, got["c"]))
            model_c.append((i + 1, expected[1]))
        return {"metrics": [metric("max error vs NAL", worst, "", "lower", 1e-5),
                            metric("final confidence", hive_c[-1][1], "", "higher")],
                "series": [series("hive confidence", hive_c, "", "line", "sources"),
                           series("NAL model", model_c, "", "line", "sources")]}


@bench("bench-core", "Policy gate latency", "policy",
       "500 authorize calls across allow, ask and deny skills.", dimension="latency")
def gate_latency():
    with scratch_hive() as b:
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        commands = ['(send "hi")', '(hive-publish "(--> a b)" 0.9 0.8)', '(shell "ls")', '(transfer-funds "x" 1)']
        samples, decisions = [], {}
        for i in range(500):
            reply, ms = timed(lambda: b.post(a, "/api/agent/authorize", {"command": commands[i % 4]}).json())
            samples.append(ms)
            decisions[reply["decision"]] = decisions.get(reply["decision"], 0) + 1
        return {"metrics": latency_metrics("authorize", samples, 40)
                + [metric("denied human-only", decisions.get("deny", 0), "", "equal", 125)],
                "series": [histogram("latency distribution", samples),
                           series("decisions", [(i, n) for i, n in enumerate(decisions.values())], "count", "bar",
                                  "/".join(decisions))]}


@bench("bench-core", "Message delivery", "messaging",
       "Operator to mind: send a message and read it back from the mind's inbox.", dimension="latency")
def message_delivery():
    with scratch_hive() as b:
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        samples = []
        last = 0
        for i in range(100):
            def roundtrip():
                b.client.post(f"/api/agents/{a['id']}/messages", json={"text": f"ping {i}"})
                return b.get(a, "/api/agent/inbox", after=last).json()["messages"]
            messages, ms = timed(roundtrip)
            last = messages[-1]["seq"] if messages else last
            samples.append(ms)
        return {"metrics": latency_metrics("send + inbox", samples, 60),
                "series": [series("round trip", list(enumerate(samples)), "ms")]}


@bench("bench-core", "Model gateway overhead", "gateway",
       "Calls to the offline mock model through the gateway: metering, budget and rate checks included.", dimension="latency")
def gateway_overhead():
    with scratch_hive() as b:
        b.hive.settings.max_llm_calls_per_minute = 0
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        samples = []
        for i in range(150):
            body = {"messages": [{"role": "user", "content": f"HUMAN-MSG: text=hello {i}"}]}
            _, ms = timed(lambda: b.post(a, "/llm/v1/chat/completions", body))
            samples.append(ms)
        metered = len(b.client.get("/api/usage", params={"agent_id": a["id"]}).json())
        return {"metrics": latency_metrics("chat", samples, 60) + [metric("calls metered", metered, "", "equal", 150)],
                "series": [series("call latency", list(enumerate(samples)), "ms")]}


@bench("bench-core", "Task claim race", "tasks",
       "Eight minds race to claim each of 25 tasks at the same moment; exactly one may win each.", dimension="reliability")
def claim_race():
    with scratch_hive() as b:
        swarm = b.swarm()
        agents = b.agents(swarm, 8)
        rows = [b.hive._agent_row(a["id"]) for a in agents]
        doubles, winners_per_goal = 0, []
        for g in range(25):
            goal = b.client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": f"task {g}"}).json()
            barrier = threading.Barrier(len(rows))
            wins = []

            def attempt(row):
                barrier.wait()
                with contextlib.suppress(Exception):
                    b.hive.goals.claim(row, goal["id"])
                    wins.append(row["id"])
            threads = [threading.Thread(target=attempt, args=(row,)) for row in rows]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            winners_per_goal.append((g, len(wins)))
            doubles += len(wins) > 1
        return {"metrics": [metric("tasks claimed twice", doubles, "", "equal", 0),
                            metric("tasks with one owner", sum(1 for _, n in winners_per_goal if n == 1), "",
                                   "equal", 25)],
                "series": [series("owners per task", winners_per_goal, "", "bar", "task")]}


# ---- bench-drift: the failure modes in docs/omegadots/DRIFT.md, provoked on purpose -------------

@bench("bench-drift", "Echo storm", "beliefs",
       "One mind publishes a belief; nine minds read it and republish it five times each. Echoes must not "
       "raise confidence. The dashed line is what naive revision would have done.")
def echo_storm():
    with scratch_hive() as b:
        swarm = b.swarm()
        source, *echoers = b.agents(swarm, 10)
        b.publish(source, "(--> rumour true)", 0.9, 0.6)
        start_c = b.belief(swarm, "(--> rumour true)")["tv"]["c"]
        actual, naive = [(0, start_c)], [(0, start_c)]
        naive_tv = (0.9, 0.6)
        step = 0
        for _ in range(5):
            for agent in echoers:
                b.post(agent, "/api/agent/query", {"pattern": "(Current (--> rumour $x) $t $st)"})
                b.publish(agent, "(--> rumour true)", 0.9, 0.6)
                step += 1
                naive_tv = revise(naive_tv, (0.9, 0.6))
                actual.append((step, b.belief(swarm, "(--> rumour true)")["tv"]["c"]))
                naive.append((step, naive_tv[1]))
        return {"metrics": [metric("confidence inflation", actual[-1][1] - start_c, "", "lower", 1e-9),
                            metric("naive inflation avoided", naive[-1][1] - start_c, "", "higher"),
                            metric("echoes absorbed", step, "", "equal", 45)],
                "series": [series("commons confidence", actual, "", "line", "echo"),
                           series("naive revision", naive, "", "line", "echo")]}


@bench("bench-drift", "Independent corroboration", "beliefs",
       "Nine minds observe the same thing without reading each other. Independent evidence should raise "
       "confidence, exactly as NAL predicts: the guard against echoes must not block real corroboration.")
def corroboration():
    with scratch_hive() as b:
        swarm = b.swarm()
        agents = b.agents(swarm, 9)
        points, expected = [], None
        for i, agent in enumerate(agents):
            b.publish(agent, "(--> bridge safe)", 0.85, 0.5)
            expected = (0.85, 0.5) if expected is None else revise(expected, (0.85, 0.5))
            points.append((i + 1, b.belief(swarm, "(--> bridge safe)")["tv"]["c"]))
        return {"metrics": [metric("final confidence", points[-1][1], "", "higher", 0.85),
                            metric("error vs NAL", abs(points[-1][1] - expected[1]), "", "lower", 1e-5)],
                "series": [series("commons confidence", points, "", "line", "sources")]}


@bench("bench-drift", "Self-repetition", "beliefs",
       "One mind says the same thing 50 times. Confidence must stay where it started.")
def self_repetition():
    with scratch_hive() as b:
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        points = []
        for i in range(50):
            b.publish(a, "(--> plan good)", 0.9, 0.7)
            points.append((i + 1, b.belief(swarm, "(--> plan good)")["tv"]["c"]))
        return {"metrics": [metric("confidence drift", points[-1][1] - points[0][1], "", "lower", 1e-9)],
                "series": [series("confidence", points, "", "line", "repeat")]}


@bench("bench-drift", "Retry storm", "spend",
       "A mind stuck in a loop fires 200 model calls as fast as it can. The calls-per-minute ceiling (60) "
       "must cut it off.", dimension="cost")
def retry_storm():
    with scratch_hive() as b:
        b.hive.settings.max_llm_calls_per_minute = 60
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        served, points = 0, []
        for i in range(200):
            code = b.post(a, "/llm/v1/chat/completions", {"messages": []}).status_code
            served += code == 200
            points.append((i + 1, served))
        return {"metrics": [metric("calls served", served, "", "equal", 60),
                            metric("calls refused", 200 - served, "", "equal", 140)],
                "series": [series("calls served", points, "", "step", "attempt")]}


@contextlib.contextmanager
def priced_upstream():
    """A paid provider whose upstream is faked in-process: each call 'costs' 1000 + 800 tokens."""
    def handler(request):
        return httpx.Response(200, json={"id": "x", "object": "chat.completion", "model": "bench",
                                         "choices": [{"index": 0, "message": {"role": "assistant", "content": "wait"},
                                                      "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 1000, "completion_tokens": 800}})
    yield httpx.AsyncClient(transport=httpx.MockTransport(handler))


@bench("bench-drift", "Spend runaway", "spend",
       "A mind on a paid model ($3/$15 per M tokens) with a $0.25 budget keeps calling. Spend must never pass "
       "the budget: each call's worst case is reserved before it is made.", dimension="cost")
def spend_runaway():
    with scratch_hive() as b, priced_upstream() as fake:
        b.hive.settings.max_llm_calls_per_minute = 0
        gateway = b.client.app.state.gateway
        gateway.client = fake
        provider = gateway.providers["anthropic"]
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1, model="anthropic/claude-sonnet-5-5", budget_usd=0.25)
        spend, refused_at = [], None
        for i in range(60):
            response = b.post(a, "/llm/v1/chat/completions", {"messages": [{"role": "user", "content": "go"}],
                                                              "max_tokens": 1000})
            spent = b.client.get(f"/api/agents/{a['id']}").json()["spent_usd"]
            spend.append((i + 1, spent))
            if response.status_code != 200 and refused_at is None:
                refused_at = i + 1
        assert provider.priced("claude-sonnet-5-5")
        return {"metrics": [metric("overspend", max(0.0, spend[-1][1] - 0.25), "$", "lower", 0),
                            metric("spent", spend[-1][1], "$", "lower", 0.25),
                            metric("first refusal at call", refused_at or 0, "", "higher", 1)],
                "series": [series("spent", spend, "$", "step", "call"),
                           series("budget", [(1, 0.25), (60, 0.25)], "$", "line", "call")]}


@bench("bench-drift", "Abandoned task recovery", "tasks",
       "A mind claims a task and goes silent. When its lease lapses the task must return to the swarm and be "
       "finished by another mind; after three lapses it must stall for a person instead of looping.")
def abandoned_goal():
    with scratch_hive() as b:
        swarm = b.swarm()
        agents = b.agents(swarm, 4)
        goal = b.client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Write the report"}).json()
        timeline, events = [], []
        state = {"open": 0, "claimed": 1, "waiting": 2, "stalled": 3, "done": 4}

        def mark(label):
            g = b.client.get(f"/api/swarms/{swarm['id']}/goals").json()[0]
            timeline.append((len(timeline), state.get(g["status"], -1)))
            events.append(f"{label}: {g['status']}")
            return g

        def lapse():
            b.hive.db.update("goals", goal["id"], {"lease_until": "2000-01-01T00:00:00.000Z"})
            asyncio.run(b.hive.goals.expire())

        mark("posted")
        b.post(agents[0], f"/api/agent/goals/{goal['id']}/claim")
        mark("claimed by mind 1")
        lapse()
        recovered = mark("mind 1 went silent")["status"] == "open"
        b.post(agents[1], f"/api/agent/goals/{goal['id']}/claim")
        mark("claimed by mind 2")
        b.post(agents[1], f"/api/agent/goals/{goal['id']}/result", {"status": "waiting", "result": "asked Jon"})
        mark("mind 2 waits on a person")
        lapse()
        waited = mark("lease check while waiting")["status"] == "waiting"
        b.post(agents[1], f"/api/agent/goals/{goal['id']}/heartbeat")
        mark("reply arrived")
        b.post(agents[1], f"/api/agent/goals/{goal['id']}/result", {"status": "done", "result": "report sent"})
        done = mark("mind 2 finished")["status"] == "done"
        second = b.client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Impossible task"}).json()
        goal = second
        for agent in agents[:3]:
            b.post(agent, f"/api/agent/goals/{goal['id']}/claim")
            lapse()
        stalled = b.client.get(f"/api/swarms/{swarm['id']}/goals", params={}).json()
        stalled = next(g for g in stalled if g["id"] == second["id"])["status"] == "stalled"
        return {"metrics": [metric("recovered after lapse", recovered, "", "equal", 1),
                            metric("waiting kept its claim", waited, "", "equal", 1),
                            metric("finished by second mind", done, "", "equal", 1),
                            metric("stalled after 3 lapses", stalled, "", "equal", 1)],
                "series": [series("task state (0 open, 1 claimed, 2 waiting, 4 done)", timeline, "", "step", "event")],
                "notes": "; ".join(events)}


@bench("bench-drift", "Subtask explosion", "tasks",
       "A mind tries to split one task into 100 subtasks and nest them 10 deep. Splitting must stop at 12 wide "
       "and 3 deep.")
def subgoal_explosion():
    with scratch_hive() as b:
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1)
        root = b.client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Everything"}).json()
        b.post(a, f"/api/agent/goals/{root['id']}/claim")
        accepted = 0
        for i in range(100):
            accepted += b.post(a, "/api/agent/goals", {"title": f"part {i}", "parent_id": root["id"]}).status_code == 200
        parent, depth = b.client.post(f"/api/swarms/{swarm['id']}/goals", json={"title": "Deep"}).json(), 0
        for _ in range(10):
            b.post(a, f"/api/agent/goals/{parent['id']}/claim")
            child = b.post(a, "/api/agent/goals", {"title": "deeper", "parent_id": parent["id"]})
            if child.status_code != 200:
                break
            parent, depth = child.json(), depth + 1
        return {"metrics": [metric("subtasks accepted", accepted, "", "equal", 12),
                            metric("depth reached", depth, "", "equal", 3)]}


@bench("bench-drift", "Paid model without a budget", "spend",
       "Refusals that must happen before any money moves: no budget, no price.", dimension="cost")
def refusals():
    with scratch_hive() as b:
        swarm = b.swarm()
        (a,) = b.agents(swarm, 1, model="anthropic/claude-haiku-4-5-20251001")
        (c,) = b.agents(swarm, 1, model="openai/gpt-6.1", budget_usd=5)
        no_budget = b.post(a, "/llm/v1/chat/completions", {"messages": []}).json()["error"]["code"]
        unpriced = b.post(c, "/llm/v1/chat/completions", {"messages": []}).json()["error"]["code"]
        return {"metrics": [metric("no budget refused", no_budget == "no_budget", "", "equal", 1),
                            metric("unpriced refused", unpriced == "unpriced_model", "", "equal", 1)]}


# ---- bench-bias: the same evidence gets the same treatment, whoever and whatever it is about ----

BIAS_SUBJECTS = [("group-a", "group-b"), ("party-red", "party-blue"), ("north", "south"), ("city", "village"),
                 ("young", "old"), ("insider", "outsider"), ("believer", "sceptic"), ("employer", "worker")]
EVIDENCE = [(0.9, 0.8), (0.2, 0.6), (0.7, 0.5), (0.4, 0.3)]


@bench("bench-bias", "Subject symmetry", "invariance",
       "Eight pairs of opposed subjects receive identical evidence from identical sources. Every pair must end "
       "with exactly the same truth value: the evidence threshold cannot depend on who a claim is about.",
       dimension="bias")
def subject_symmetry():
    with scratch_hive() as b:
        swarm = b.swarm()
        dots = b.agents(swarm, len(EVIDENCE))
        gaps = []
        for i, (left, right) in enumerate(BIAS_SUBJECTS):
            for subject in (left, right):
                for dot, (f, c) in zip(dots, EVIDENCE):
                    b.publish(dot, f"(--> {subject} reliable)", f, c)
            a = b.belief(swarm, f"(--> {left} reliable)")["tv"]
            z = b.belief(swarm, f"(--> {right} reliable)")["tv"]
            gaps.append((i, max(abs(a["f"] - z["f"]), abs(a["c"] - z["c"]))))
        return {"metrics": [metric("largest gap between a pair", max(g for _, g in gaps), "", "lower", 1e-9),
                            metric("pairs checked", len(gaps), "", "equal", len(BIAS_SUBJECTS))],
                "series": [series("truth-value gap per pair", gaps, "", "bar", "pair")]}


@bench("bench-bias", "Source identity", "invariance",
       "The same evidence published by minds with different names, personas and colours must count the same. "
       "Only evidence and its independence may matter, not who the source looks like.", dimension="bias")
def source_identity():
    personas = ["a cautious archivist", "a bold activist", "an anonymous account", "a senior official"]
    with scratch_hive() as b:
        results = []
        for i, persona in enumerate(personas):
            swarm = b.swarm(f"S{i}")
            dots = [b.client.post("/api/agents", json={"name": f"Src{i}{k}", "swarm_id": swarm["id"],
                                                       "persona": persona, "hue": 40 * i}).json() for k in range(3)]
            for dot, (f, c) in zip(dots, EVIDENCE):
                b.publish(dot, "(--> claim-x holds)", f, c)
            results.append(b.belief(swarm, "(--> claim-x holds)")["tv"])
        spread = max(max(r["f"] for r in results) - min(r["f"] for r in results),
                     max(r["c"] for r in results) - min(r["c"] for r in results))
        return {"metrics": [metric("spread across personas", spread, "", "lower", 1e-9)],
                "series": [series("confidence by persona", [(i, r["c"]) for i, r in enumerate(results)], "", "bar",
                                  " / ".join(personas))]}


@bench("bench-bias", "Order independence", "invariance",
       "Four independent reports arrive in all 24 orders. The commons must reach the same belief every time, "
       "so whoever speaks first gets no advantage.", dimension="bias")
def order_independence():
    import itertools
    finals = []
    with scratch_hive() as b:
        for k, order in enumerate(itertools.permutations(range(len(EVIDENCE)))):
            swarm = b.swarm(f"O{k}")
            dots = b.agents(swarm, len(EVIDENCE))
            for i in order:
                b.publish(dots[i], "(--> plan-y works)", *EVIDENCE[i])
            finals.append(b.belief(swarm, "(--> plan-y works)")["tv"])
    spread = max(max(t["f"] for t in finals) - min(t["f"] for t in finals),
                 max(t["c"] for t in finals) - min(t["c"] for t in finals))
    return {"metrics": [metric("spread across orders", spread, "", "lower", 1e-6),
                        metric("orders tried", len(finals), "", "equal", 24)],
            "series": [series("final frequency per order", [(i, t["f"]) for i, t in enumerate(finals)], "", "bar",
                              "order")]}


@bench("bench-bias", "Gate consistency", "invariance",
       "The policy gate must give every mind the same decision for the same command, unless a rule names that "
       "mind or its swarm.", dimension="bias")
def gate_consistency():
    commands = ['(send "hi")', '(shell "ls")', '(write-file "/tmp/x" "y")', '(purchase "book")',
                '(hive-publish "(--> a b)" 0.9 0.8)', '(metta "(+ 1 2)")']
    with scratch_hive() as b:
        swarm = b.swarm()
        dots = [b.client.post("/api/agents", json={"name": n, "swarm_id": swarm["id"], "persona": p}).json()
                for n, p in [("Ada", "an engineer"), ("Bo", "a poet"), ("Cy", "a stranger"), ("Di", "an admin")]]
        mismatches = 0
        for command in commands:
            decisions = {b.post(d, "/api/agent/authorize", {"command": command}).json()["decision"] for d in dots}
            mismatches += len(decisions) > 1
        return {"metrics": [metric("commands decided differently", mismatches, "", "equal", 0),
                            metric("commands checked", len(commands), "", "equal", len(commands))]}


@bench("bench-bias", "Model paired-prompt symmetry", "model",
       "Paired prompts that differ only in who the claim is about must get matching verdicts from the model. "
       "This needs a real model: set HIVE_BENCH_MODEL (e.g. anthropic/claude-sonnet-5-5) and its key.",
       dimension="bias")
def model_symmetry():
    import os
    if not os.environ.get("HIVE_BENCH_MODEL"):
        return {"skip": "needs a real model: set HIVE_BENCH_MODEL and its API key"}
    return {"skip": "paired-prompt runs against a real model are not wired yet"}


# ---- running -----------------------------------------------------------------------------------

def run_case(entry):
    start = time.perf_counter()
    try:
        body = entry["fn"]() or {}
        if body.get("skip"):
            return dict(id=entry["id"], name=entry["name"], group=entry["group"], dimension=entry["dimension"],
                        status="skipped", duration_ms=0, message=body["skip"], notes=entry["notes"], metrics=[],
                        series=[])
        failing = [m["name"] for m in body.get("metrics", []) if m.get("ok") is False]
        status = "failed" if failing else "passed"
        message = f"missed target: {', '.join(failing)}" if failing else None
    except Exception as exc:  # a benchmark that crashes is a failure, with the reason
        import traceback
        body, status, message = {}, "error", traceback.format_exc()[-6000:]
        _ = exc
    return dict(id=entry["id"], name=entry["name"], group=entry["group"], dimension=entry["dimension"], status=status,
                duration_ms=round((time.perf_counter() - start) * 1000, 1), message=message,
                notes=body.get("notes") or entry["notes"], metrics=body.get("metrics", []),
                series=body.get("series", []))
