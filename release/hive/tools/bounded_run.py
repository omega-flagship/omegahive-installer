"""Bounded run: start named minds for named goals, watch, and stop them all on the first end condition.

    python -m hive.tools.bounded_run \
        --minds a_00000001,a_00000002 --goals g_…,g_… --ceiling-usd 1.0 --timeout-min 20 \
        --out receipts/<name>.json [--restart-after g_…:a_…]

Refuses to start unless every mind is stopped, every goal is open (or already claimed by one of the minds),
and every mind carries its own hard 'total' spending rule with the rules summing to at most the ceiling
(the hive refuses any paid call that would cross a rule, before it is made). Stops every mind on: all goals
finished (done/failed/cancelled), any mind hitting a spending refusal, a mind error, or the timeout.
The receipt is metadata only: ids, states, times, spend, digests of results, never their text.
"""

import argparse
import hashlib
import json
import pathlib
import sys
import time

import httpx

FINISHED = {"done", "failed", "cancelled"}


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest() if value else None


class Runner:
    def __init__(self, client, minds, goals, ceiling_usd, timeout_s, poll_s=5.0, restart_after=None, sleep=time.sleep, clock=time.time):
        self.c, self.minds, self.goals = client, list(minds), list(goals)
        self.ceiling, self.timeout, self.poll = float(ceiling_usd), float(timeout_s), float(poll_s)
        self.restart_after = dict(restart_after or {})  # goal id -> mind id to stop and start once that goal finishes
        self.sleep, self.clock = sleep, clock
        self.events = []

    def _get(self, path):
        r = self.c.get(path)
        r.raise_for_status()
        return r.json()

    def _goal(self, goal_id):
        return self._get(f"/api/goals/{goal_id}")

    def note(self, what, **detail):
        self.events.append({"at": _now(), "event": what, **detail})

    def preflight(self):
        problems = []
        agents = {a["id"]: a for a in self._get("/api/agents")}
        rules = self._get("/api/budgets")
        caps = {}
        for m in self.minds:
            a = agents.get(m)
            if not a:
                problems.append(f"{m}: no such mind")
                continue
            if a["status"] not in ("created", "stopped"):
                problems.append(f"{m}: is {a['status']}, must be stopped before a bounded run")
            mine = [r for r in rules if r.get("scope") == f"agent:{m}" and r.get("period") == "total" and r.get("origin", "rule") == "rule"]
            if not mine:
                problems.append(f"{m}: has no hard total spending rule")
            else:
                caps[m] = min(float(r["limit_usd"]) for r in mine)
        if caps and sum(caps.values()) > self.ceiling + 1e-9:
            problems.append(f"the minds' total caps sum to ${sum(caps.values()):.2f}, above the ${self.ceiling:.2f} ceiling")
        for g in self.goals:
            try:
                goal = self._goal(g)
            except httpx.HTTPStatusError:
                problems.append(f"{g}: no such goal")
                continue
            if goal["status"] in FINISHED:
                problems.append(f"{g}: already {goal['status']}")
            elif goal.get("assignee") and goal["assignee"] not in self.minds:
                problems.append(f"{g}: assigned to {goal['assignee']}, not to a mind in this run")
        return problems, caps, agents

    def stop_all(self):
        """Stop every mind and record what was observed, not what was asked: a stop counts only when the
        mind's status reads stopped afterwards."""
        for m in self.minds:
            try:
                r = self.c.post(f"/api/agents/{m}/stop")
                status = None
                for _ in range(10):
                    status = self._get(f"/api/agents/{m}")["status"]
                    if status in ("stopped", "created"):
                        break
                    self.sleep(1)
                if r.status_code < 300 and status in ("stopped", "created"):
                    self.note("stopped", mind=m, observed_status=status)
                else:
                    self.note("stop-unconfirmed", mind=m, http_status=r.status_code, observed_status=status)
            except Exception as exc:  # keep stopping the others
                self.note("stop-failed", mind=m, error=type(exc).__name__)

    def run(self):
        started_at = _now()
        problems, caps, agents = self.preflight()
        spent0 = {m: float(agents[m].get("spent_usd") or 0) for m in self.minds if m in agents}
        if problems:
            return {"started": False, "refused": problems, "at": started_at}
        deadline, reason, restarted = self.clock() + self.timeout, None, set()
        refusals0 = {e["id"]: next((i["count"] for i in e["issues"] if i["kind"] == "budget" and i.get("recent")), 0)
                     for e in self._get("/api/health").get("minds", []) if e["id"] in self.minds}
        # never run past a goal's own deadline (a bound request's snapshot is revoked then)
        import datetime
        for g in self.goals:
            at = self._goal(g).get("deadline_at")
            if at:
                left = (datetime.datetime.fromisoformat(at.replace("Z", "+00:00")) - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
                if self.clock() + max(0.0, left) < deadline:
                    deadline = self.clock() + max(0.0, left)
                    self.note("deadline-bound", goal=g, seconds=round(left))
        try:
            for m in self.minds:
                self.c.post(f"/api/agents/{m}/start").raise_for_status()
                self.note("started", mind=m)
            while reason is None:
                states = {g: self._goal(g) for g in self.goals}
                for g, goal in states.items():
                    who = self.restart_after.get(g)
                    if who and goal["status"] in FINISHED and g not in restarted:
                        restarted.add(g)
                        self.c.post(f"/api/agents/{who}/stop").raise_for_status()
                        self.note("restart-stop", mind=who, after_goal=g)
                        self.sleep(self.poll)
                        self.c.post(f"/api/agents/{who}/start").raise_for_status()
                        self.note("restart-start", mind=who, after_goal=g)
                if all(goal["status"] in FINISHED for goal in states.values()):
                    reason = "all goals finished"
                    break
                for m in self.minds:
                    a = self._get(f"/api/agents/{m}")
                    if a["status"] == "error":
                        reason = f"{m} errored"
                    spent = float(a.get("spent_usd") or 0) - spent0.get(m, 0)
                    if m in caps and spent >= caps[m] - 1e-9:
                        reason = f"{m} reached its ${caps[m]:.2f} cap"
                if reason is None:
                    for e in self._get("/api/health").get("minds", []):
                        hits = [i for i in e["issues"] if i["kind"] == "budget" and i.get("recent")] if e["id"] in self.minds else []
                        if hits and hits[0]["count"] > refusals0.get(e["id"], 0):
                            reason = f"{e['id']} was refused a model call for spending ({hits[0]['example']['result'][:120]})"
                            self.note("budget-refused", mind=e["id"], count=hits[0]["count"])
                if reason is None and self.clock() >= deadline:
                    reason = "timeout"
                if reason is None:
                    self.sleep(self.poll)
        except Exception as exc:  # the runner itself failed: still stop everyone, and say why
            reason = f"runner error: {type(exc).__name__}"
            raise
        finally:
            self.stop_all()
        final = {m: self._get(f"/api/agents/{m}") for m in self.minds}
        goals = {}
        for g in self.goals:
            goal = self._goal(g)
            goals[g] = {"status": goal["status"], "claimed_by": goal.get("claimed_by"), "assignee": goal.get("assignee"),
                        "binding_digest": goal.get("binding_digest"), "result_digest": _digest(goal.get("result")),
                        "result_data_digest": _digest(goal.get("result_data")), "updated_at": goal.get("updated_at")}
        unconfirmed = [e["mind"] for e in self.events if e["event"] in ("stop-unconfirmed", "stop-failed")]
        return {"started": True, "started_at": started_at, "ended_at": _now(), "stop_reason": reason,
                "all_stopped_confirmed": not unconfirmed, "stop_unconfirmed": unconfirmed,
                "ceiling_usd": self.ceiling, "caps_usd": caps,
                "minds": {m: {"name": final[m]["name"], "model": final[m].get("model"), "status_after": final[m]["status"],
                              "spent_usd_this_run": round(float(final[m].get("spent_usd") or 0) - spent0.get(m, 0), 6)} for m in self.minds},
                "goals": goals, "events": self.events,
                "metering": "hard: the hive refuses a paid call when spent + that call's worst-case estimate would cross any applicable rule"}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--hive", default="http://127.0.0.1:8700")
    p.add_argument("--password-file", default=str(pathlib.Path(__file__).resolve().parents[3] / ".runtime" / "hive-8700" / "admin-password"))
    p.add_argument("--minds", required=True)
    p.add_argument("--goals", required=True)
    p.add_argument("--ceiling-usd", type=float, required=True)
    p.add_argument("--timeout-min", type=float, default=20)
    p.add_argument("--restart-after", default="", help="goal:mind pairs, comma separated: restart that mind once that goal finishes")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    c = httpx.Client(base_url=a.hive, timeout=60, trust_env=False)
    token = c.post("/api/auth/login", json={"password": pathlib.Path(a.password_file).read_text().strip()}).json()["token"]
    c.headers["Authorization"] = f"Bearer {token}"
    restart = dict(pair.split(":", 1) for pair in a.restart_after.split(",") if pair)
    receipt = Runner(c, a.minds.split(","), a.goals.split(","), a.ceiling_usd, a.timeout_min * 60, restart_after=restart).run()
    pathlib.Path(a.out).write_text(json.dumps(receipt, indent=1))
    print(json.dumps({k: receipt.get(k) for k in ("started", "refused", "stop_reason")}))
    return 0 if receipt.get("started") else 2


if __name__ == "__main__":
    sys.exit(main())
