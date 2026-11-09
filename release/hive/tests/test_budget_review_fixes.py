"""Fixes from the independent review of S5 (Kimi, 2026-10-04) and hardening of the live security batch 4aad53d.
One regression test per item; all L0/L1-disposable (synthetic data, in-process hive)."""
import json
import pathlib
import sqlite3
import tempfile
import threading
import time

import pytest

from hive.core.cost_reservations import Reservations, overruns, outstanding, resolve
from hive.core.db import Database
from hive.core.policy import restrictiveness
from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers  # noqa: F401  (fixture)
from hive.tests.test_cost_reservations import MODEL, _fake_chat, _gateway, _mind
from hive.tests.test_five_way_decisions import decide
from hive.tests.test_phase2_api import authorize
from hive.tests.test_services_api import c, register, mind_with_goal, verify  # noqa: F401  (fixture)

CHAT = {"messages": [{"role": "user", "content": "SECRET-PROMPT-TEXT"}], "max_tokens": 100}
BUDGETS = lambda: [("agent:a:total", 10.0, 0.0)]


def _db():
    return Database(pathlib.Path(tempfile.mkdtemp(prefix="res-")) / "hive.db")   # a data directory recovery can lock


# 1 ---- reserve + dispatch is one transaction; orphans are swept to unknown and can be resolved
def test_reserve_and_dispatch_in_one_transaction_and_orphans_are_resolvable():
    db = _db()
    r = Reservations(db)
    assert r.reserve("k1", {"x": 1}, 1.0, BUDGETS, dispatched=True)["state"] == "dispatched"
    r.reserve("k2", {"x": 2}, 1.0, BUDGETS)                       # the old two-step shape, left in 'reserved'
    assert r.get("k2")["state"] == "reserved"
    restarted = Reservations(db)                                  # construction alone never sweeps (linkage §L, OPEN-17)
    assert (restarted.get("k1")["state"], restarted.get("k2")["state"]) == ("dispatched", "reserved")
    from hive.tests.test_startup_exclusive import recover
    assert recover(db) == {"reservations": 2, "ask_intents": 0, "studio": 0}                     # process restart: the one startup recovery, under the lock
    assert {restarted.get("k1")["state"], restarted.get("k2")["state"]} == {"unknown"}
    assert {o["id"] for o in outstanding(restarted)} == {"k1", "k2"}
    resolve(restarted, "k2", "release", "process died before dispatch", "user:operator")
    assert restarted.get("k2")["state"] == "released"
    # a hung (not restarted) dispatch becomes resolvable after the stale window, never before
    r3 = Reservations(db)
    r3.reserve("k3", {"x": 3}, 1.0, BUDGETS, dispatched=True)
    with pytest.raises(ValueError):
        resolve(r3, "k3", "release", "too early", "user:operator")
    db.execute("UPDATE cost_reservations SET dispatched_at = ? WHERE id = 'k3'", (time.time() - 3600,))
    assert resolve(r3, "k3", "release", "hung for an hour", "user:operator")["state"] == "released"


# 2 ---- the prompt is never stored or returned
def test_prompt_is_neither_stored_nor_returned(client):
    a = _mind(client, 1.0)
    _fake_chat(_gateway(client), usage=False)                     # no usage -> an unknown liability stays listed
    assert client.post("/llm/v1/chat/completions", json=CHAT, headers=agent_headers(a)).status_code == 200
    listed = client.get("/api/budgets/reservations")
    assert listed.json() and "SECRET-PROMPT-TEXT" not in listed.text
    assert "payload_hash" in listed.json()[0]["metadata"]
    db = client.app.state.hive.db
    for table in ("cost_reservations", "cost_reservation_details", "cost_reservation_scopes"):
        assert "SECRET-PROMPT-TEXT" not in json.dumps([dict(r) for r in db.all(f"SELECT * FROM {table}")])


# 3 ---- nothing after a successful provider call may raise
def test_observe_failure_after_delivery_does_not_error_and_holds_the_liability(client, monkeypatch):
    a = _mind(client, 1.0)
    _fake_chat(_gateway(client))

    def boom(self, key, observation):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(Reservations, "observe", boom)
    r = client.post("/llm/v1/chat/completions", json=CHAT, headers=agent_headers(a))
    assert r.status_code == 200
    held = client.get("/api/budgets/reservations").json()
    assert [h["state"] for h in held] == ["unknown"]


def test_settle_failure_after_delivery_does_not_error(client, monkeypatch):
    a = _mind(client, 1.0)
    _fake_chat(_gateway(client))

    def boom(self, *args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(Reservations, "settle", boom)
    assert client.post("/llm/v1/chat/completions", json=CHAT, headers=agent_headers(a)).status_code == 200
    assert [h["state"] for h in client.get("/api/budgets/reservations").json()] == ["unknown"]


# 4 ---- embeddings estimate has a per-item floor and a cap on inputs
def _priced_embeddings(client):
    hive = client.app.state.hive
    gw = _gateway(client)
    gw.providers["openai"].prices["text-embedding-3-small"] = {"in": 20, "out": 0}
    object.__setattr__(hive.settings, "embedding_model", "openai/text-embedding-3-small")

    async def embeddings(model, body, agent=None):
        return {"object": "list", "data": [], "usage": {"prompt_tokens": 1}}
    gw.embeddings = embeddings


def test_embeddings_input_count_is_capped_and_tiny_inputs_are_floored(client):
    _priced_embeddings(client)
    a = _mind(client, 1.0)
    big = client.post("/llm/v1/embeddings", json={"input": ["a"] * 257}, headers=agent_headers(a))
    assert big.status_code == 400 and big.json()["error"]["code"] == "too_many_inputs"
    rich = _mind(client, 1.0)
    assert client.post("/llm/v1/embeddings", json={"input": ["a"] * 256}, headers=agent_headers(rich)).status_code == 200
    # 100 tiny inputs: floor of 8 tokens each = 800 tokens = $0.016; a $0.01 budget must refuse (1 token each = $0.002 would pass)
    mid = _mind(client, 0.01)
    assert client.post("/llm/v1/embeddings", json={"input": ["a"] * 100}, headers=agent_headers(mid)).status_code == 402


# 5 ---- settling above the hold records, emits budget.overrun and flags the mind
def test_resolve_settle_above_the_hold_flags_an_overrun(client):
    a = _mind(client, 1.0)
    _fake_chat(_gateway(client), usage=False)
    assert client.post("/llm/v1/chat/completions", json=CHAT, headers=agent_headers(a)).status_code == 200
    held = client.get("/api/budgets/reservations").json()[0]
    assert held["held_usd"] < 0.5
    r = client.post(f"/api/budgets/reservations/{held['id']}/resolve",
                    json={"action": "settle", "actual_usd": 0.9, "reason": "provider dashboard shows a larger charge"})
    assert r.status_code == 200 and r.json()["state"] == "settled"
    over = client.get("/api/budgets/overruns").json()
    assert len(over) == 1 and over[0]["agent"] == a["id"] and over[0]["actual"] > over[0]["maximum"]
    mind = client.app.state.hive.agent(a["id"])
    assert "budget overrun" in (mind["last_error"] or "")
    assert abs(mind["spent_usd"] - 0.9) < 1e-9                    # recorded, never hidden


def test_settle_within_the_hold_is_not_an_overrun():
    db = _db()
    r = Reservations(db)
    r.reserve("k", {}, 1.0, BUDGETS, dispatched=True)
    r.unknown("k")
    resolve(r, "k", "settle", "ok", "user:operator", actual=0.5, record_usage=lambda usd: None)
    assert overruns(r) == []


# 6 ---- double-record race: hot-path settle() vs admin resolve(settle) on the same liability
@pytest.mark.parametrize("round_", range(10))
def test_settle_and_admin_resolve_cannot_both_record(round_):
    db = _db()
    r = Reservations(db)
    r.reserve("k", {}, 1.0, BUDGETS, dispatched=True)
    r.unknown("k")                                               # the only state both writers accept
    records, errors, barrier = [], [], threading.Barrier(2)

    def record(usd):
        time.sleep(0.01)                                         # widen the window inside the transaction
        records.append(usd)

    def hot():
        barrier.wait()
        try:
            r.settle("k", 0.4, lambda: record(0.4))
        except ValueError as exc:
            errors.append(exc)

    def admin():
        barrier.wait()
        try:
            resolve(r, "k", "settle", "race", "user:operator", actual=0.4, record_usage=record)
        except ValueError as exc:
            errors.append(exc)
    threads = [threading.Thread(target=hot), threading.Thread(target=admin)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    # Both take the connection lock + BEGIN IMMEDIATE and re-read the state inside it, so exactly one records.
    # (Hot settle with the same actual after an admin settle is the documented idempotent no-op.)
    assert len(records) == 1, records
    assert r.get("k")["state"] == "settled"


# 7 ---- an unknown mode raises, it never ranks as most restrictive
def test_unknown_mode_raises_instead_of_ranking():
    assert [restrictiveness(m) for m in ("deny", "ask", "allow")] == [0, 1, 2]
    with pytest.raises(ValueError):
        restrictiveness("audit")


def test_decide_raises_on_a_rule_with_an_unknown_mode(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.db.insert("policy_rules", {"id": "r_bad00001", "scope": f"agent:{a['id']}", "skill": "write-file", "mode": "audit",
                                    "note": "", "created_at": "2026-10-04T00:00:00Z", "origin": ""})
    with pytest.raises(ValueError):
        hive.policy.decide(hive.agent(a["id"]), "write-file")


# 8 ---- supersede by origin, not by note text; migration marks existing answer rules
def test_supersede_uses_origin_not_note_prefix(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    # an admin rule whose note merely imitates an answer note is not an answer, so it is never superseded
    hive.policy.add_rule(f"agent:{a['id']}", "write-file", "ask", "always allowed when approving p_fake")
    p = authorize(client, a, '(write-file "x.txt" "y")')
    decide(client, p["approval_id"], "always")
    hive.db.insert("approvals", {"id": "p_later001", "agent_id": a["id"], "skill": "write-file", "command": '(write-file "x.txt" "y")',
                                 "reason": "test", "risk": "medium", "status": "pending", "created_at": "2026-10-04T00:00:00Z"})
    assert decide(client, "p_later001", "never").json()["status"] == "denied"
    assert any(r["origin"] == "answer" and r["mode"] == "deny" for r in hive.policy.rules())
    assert not any(r["origin"] == "answer" and r["mode"] == "allow" for r in hive.policy.rules())   # the Always was superseded
    assert any(r["origin"] == "" and r["note"] == "always allowed when approving p_fake" for r in hive.policy.rules())


def test_migration_marks_existing_answer_rules():
    path = pathlib.Path(tempfile.mkdtemp(prefix="mig-")) / "old.db"
    old = sqlite3.connect(path)
    old.execute("CREATE TABLE policy_rules (id TEXT PRIMARY KEY, scope TEXT NOT NULL, skill TEXT NOT NULL, mode TEXT NOT NULL, "
                "note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at REAL)")
    for i, note in enumerate(("always allowed when approving p_1", "never, when refusing p_2", "allowed for 5 min when approving p_3", "role:dev", "")):
        old.execute("INSERT INTO policy_rules VALUES (?,?,?,?,?,?,NULL)", (f"r{i}", "agent:a_1", "s", "allow", note, "2026-10-04T00:00:00Z"))
    old.commit()
    old.close()
    db = Database(path)
    origins = {r["id"]: r["origin"] for r in db.all("SELECT id, origin FROM policy_rules")}
    assert origins == {"r0": "answer", "r1": "answer", "r2": "answer", "r3": "", "r4": ""}


# 9 ---- an explicit empty paths list is refused, never "the whole repository"
def test_explicit_empty_paths_is_refused(c):
    _, _, r = register(c)
    reg = r.json()
    swarm, mind, goal, agent = mind_with_goal(c)
    base = {"task_id": goal["id"], "repository_id": "synthetic", "actions": ["read"]}
    refused = c.post("/api/agent/code/capability", json=base | {"paths": []}, headers=agent)
    assert refused.status_code == 400
    absent = c.post("/api/agent/code/capability", json=base, headers=agent)
    assert absent.status_code == 200 and verify(absent.json()["token"], reg["capability_secret"])["paths"] == []   # legacy
    none = c.post("/api/agent/code/capability", json=base | {"paths": None}, headers=agent)
    assert none.status_code == 200
    human = c.post("/api/code/capability", json={"service": "omegacode", "repository_id": "synthetic", "paths": []}, headers=c.admin)
    assert human.status_code in (400, 404, 422)          # the person-facing route shares the same guard


# ---- Kimi round 2 (N1, N2), platform 2026-10-04 ----

def test_a_late_answer_after_release_is_recorded_not_lost(tmp_path):
    from hive.core.cost_reservations import Reservations, resolve, STALE_SECONDS
    from hive.core.db import Database
    db = Database(tmp_path / "r.db")
    r = Reservations(db)
    r.reserve("k1", {"p": 1}, 0.05, lambda: [("agent:a:total", 1.0, 0.0)], metadata={"agent": "a"}, dispatched=True)
    db.execute("UPDATE cost_reservations SET dispatched_at = dispatched_at - ? WHERE id='k1'", (STALE_SECONDS + 5,))
    resolve(r, "k1", "release", "provider looked dead", "user:jon")
    recorded = []
    assert r.settle("k1", 0.03, lambda: recorded.append(0.03)) is True
    assert recorded == [0.03] and r.get("k1")["state"] == "settled"
    assert db.one("SELECT COUNT(*) n FROM cost_overruns")["n"] == 1


def test_unknown_holds_expire_after_a_day_at_the_held_worst_case(tmp_path):
    import time
    from hive.core.cost_reservations import Reservations, expire_unknown
    from hive.core.db import Database
    db = Database(tmp_path / "r.db")
    r = Reservations(db)
    r.reserve("k2", {"p": 2}, 0.05, lambda: [("agent:a:total", 1.0, 0.0)], metadata={"agent": "a"}, dispatched=True)
    r.unknown("k2")
    seen = []
    assert expire_unknown(r, lambda meta, usd: seen.append(usd)) == []                 # fresh: still held
    done = expire_unknown(r, lambda meta, usd: seen.append(usd), now=time.time() + 25 * 3600)
    assert done == ["k2"] and seen == [0.05] and r.get("k2")["state"] == "settled"
    assert db.one("SELECT decided_by FROM cost_reservation_resolutions WHERE reservation='k2'")["decided_by"] == "hive:expiry"
