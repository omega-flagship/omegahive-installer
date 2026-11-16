# Purpose: tests that an unknown call settles at its worst case after an hour as a marked estimate, that each expiry pass
# publishes one event and each person reads one line a day, that a person corrects an estimate within 30 days, alone or
# all at once, by an adjusting usage row, and that OpenRouter's record still corrects one when it comes after the hour,
# through the real routes, the reconcile pass and the notices.
"""Unknown outcomes settle in an hour, marked estimated (the limits plan on omega-flagship/omegahive#107, PR D).

A call whose cost never came back is held at its worst case; an hour on, the books close on that worst case as an
estimate, which is an upper bound that's usually lower. One event goes out per expiry pass and one line a day per
person, where a night of expiries used to send a notice per call. A person corrects an estimate with the billed cost,
or with nothing billed, for 30 days; usage keeps the estimate and gains an adjusting row dated with it.

Synthetic minds, people and a scripted provider that times out: no network and no provider calls.
"""
import datetime
import random
import tempfile
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.budgets import period_start
# Only names the hive had before estimates are imported here; each test imports the new ones it uses, so on a hive
# without estimates every test fails on its own behaviour (the expiry's length, the event, the route) and not on import.
from hive.core.cost_reservations import UNKNOWN_EXPIRY_SECONDS, Reservations, expire_unknown
from hive.core.db import Database
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_held_call_provider_record import MODEL as OPENROUTER, _openrouter
from hive.tests.test_held_calls_settle_themselves import ROUTE, _held
from hive.tests.test_unbilled_refusal_release import MODEL

UTC = datetime.timezone.utc
ADMIN, MEMBER = "u_0a1b2c3d", "u_4e5f6a7b"


def _expire(client, age=UNKNOWN_EXPIRY_SECONDS + 1):
    """Age every held call's unknown outcome past the expiry and run one reconcile pass."""
    client.app.state.hive.db.execute("UPDATE cost_reservations SET unknown_at = ? WHERE state = 'unknown'",
                                     (time.time() - age,))
    client.portal.call(client.app.state.reconcile_once)


def _published(hive, monkeypatch):
    """Every live event the hive publishes from now on, as (kind, payload)."""
    seen, real = [], hive.events.publish

    def publish(kind, /, **payload):
        seen.append((kind, payload))
        return real(kind, **payload)
    monkeypatch.setattr(hive.events, "publish", publish)
    return seen


def _correct(client, rid, **body):
    return client.post(f"/api/budgets/reservations/{rid}/correct", json=body)


def _usage(hive, rid):
    return hive.db.all("SELECT cost_usd, estimated, created_at FROM usage WHERE reservation = ? ORDER BY id", (rid,))


def _people(hive):
    for pid, role in ((ADMIN, "admin"), (MEMBER, "member")):
        hive.db.execute("INSERT INTO people (id, email, role, created_at) VALUES (?, ?, ?, ?)",
                        (pid, f"{pid}@example.com", role, "2026-11-01T00:00:00.000Z"))


def _estimates(hive, agent, payers, held=0.05):
    """One estimate per payer, made as the expiry makes them: a sent call whose outcome went unknown, settled at its
    worst case an hour on. Returns the reservation ids, oldest first."""
    res = Reservations(hive.db)
    stamp = time.time_ns()
    for i, payer in enumerate(payers):
        key = f"chat:{agent['id']}:{stamp}-{i}"
        res.reserve(key, {"i": i}, held, lambda: [("hive", 100.0, 0.0)],
                    metadata={"agent": agent["id"], "model": MODEL, "payer": payer}, dispatched=True)
        res.unknown(key)

    def record(meta, usd, **fields):
        hive.record_usage(hive.agent(meta["agent"]), meta["model"],
                          {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd, **fields}, None, meta.get("payer"))
    return expire_unknown(res, record, now=time.time() + UNKNOWN_EXPIRY_SECONDS + 1)


def _notices(hive, pid):
    return hive.db.all("SELECT kind, text, state, held_reason, digest_id FROM notices WHERE principal = ? ORDER BY seq",
                       ("user:" + pid,))


# ---- the hour ---------------------------------------------------------------------------------------------------------

def test_an_unknown_call_settles_at_its_worst_case_after_an_hour_marked_estimated(client):
    assert UNKNOWN_EXPIRY_SECONDS == 3600
    from hive.core.cost_reservations import CORRECTION_SECONDS
    a, (h,) = _held(client, 1)
    hive = client.app.state.hive
    _expire(client, age=59 * 60)
    (row,) = client.get("/api/budgets/reservations").json()
    assert row["state"] == "unknown"                                    # 59 minutes: still held for a person
    assert row["auto_settles_at"] - time.time() == pytest.approx(60, abs=10)
    _expire(client)
    assert client.get("/api/budgets/reservations").json() == []
    r = hive.db.one("SELECT state, maximum, actual FROM cost_reservations WHERE id = ?", (h["id"],))
    assert r["state"] == "settled" and r["actual"] == r["maximum"] == round(h["held_usd"] * 1_000_000)
    v = hive.db.one("SELECT action, decided_by FROM cost_reservation_resolutions WHERE reservation = ?", (h["id"],))
    assert (v["action"], v["decided_by"]) == ("settle", "hive:expiry")
    (u,) = hive.db.all("SELECT cost_usd, estimated, reservation FROM usage WHERE agent_id = ?", (a["id"],))
    assert (u["cost_usd"], u["estimated"], u["reservation"]) == (pytest.approx(h["held_usd"]), 1, h["id"])
    assert [x["estimated"] for x in client.get("/api/usage", params={"agent_id": a["id"]}).json()] == [1]
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(h["held_usd"])
    (e,) = client.get("/api/budgets/reservations/estimated").json()
    assert e["id"] == h["id"] and e["estimate_usd"] == pytest.approx(h["held_usd"])
    assert e["correctable_until"] - e["settled_at"] == CORRECTION_SECONDS and e["metadata"]["agent"] == a["id"]


def test_one_event_per_expiry_pass(client, monkeypatch):
    a, held = _held(client, 3)
    seen = _published(client.app.state.hive, monkeypatch)
    _expire(client)
    estimated_events = [p for kind, p in seen if kind == "budget.estimated"]
    assert [kind for kind, _ in seen if kind == "budget.overrun"] == []     # no notice per call any more
    assert len(estimated_events) == 1
    (event,) = estimated_events
    assert event["count"] == 3 and event["total_usd"] == pytest.approx(sum(h["held_usd"] for h in held))
    assert sorted(event["reservations"]) == sorted(h["id"] for h in held)
    assert sum(p["count"] for p in event["payers"]) == 3
    assert sum(p["total_usd"] for p in event["payers"]) == pytest.approx(event["total_usd"])
    client.portal.call(client.app.state.reconcile_once)                   # a pass that settles nothing says nothing
    assert len([kind for kind, _ in seen if kind == "budget.estimated"]) == 1


def test_the_events_summary_says_who_paid_largest_total_first():
    from hive.core.cost_reservations import estimated_summary
    free = "openrouter/meta-llama/llama-4-scout:free"
    out = estimated_summary([("k1", 40_000, "user:u_4e5f6a7b", MODEL), ("k2", 50_000, None, MODEL),
                             ("k3", 30_000, "user:u_4e5f6a7b", MODEL), ("k4", 0, "user:u_4e5f6a7b", free)])
    assert out == {"count": 4, "total_usd": 0.12, "reservations": ["k1", "k2", "k3", "k4"],
                   "payers": [{"payer": "user:u_4e5f6a7b", "count": 3, "total_usd": 0.07},
                              {"payer": "hive", "count": 1, "total_usd": 0.05}],
                   "free": [{"model": free, "count": 1}]}   # a free model's call, settled at $0, named for the admins


def test_a_call_that_cannot_be_settled_stays_held_and_the_rest_still_settle(tmp_path):
    res = Reservations(Database(tmp_path / "r.db"))
    for key in ("bad", "good"):
        res.reserve(key, {"k": key}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": key}, dispatched=True)
        res.unknown(key)
    told = []

    def record(meta, usd, **fields):
        if meta["agent"] == "bad":
            raise RuntimeError("no such mind")
    assert expire_unknown(res, record, told.append, now=time.time() + UNKNOWN_EXPIRY_SECONDS + 1) == ["good"]
    assert res.get("bad")["state"] == "unknown" and res.get("good")["state"] == "settled"
    assert [t["reservations"] for t in told] == [["good"]]


# ---- the day's line ---------------------------------------------------------------------------------------------------

def test_a_person_gets_one_line_a_day_about_estimates(client):
    hive = client.app.state.hive
    _people(hive)
    for pid in (ADMIN, MEMBER):   # quiet hours off, so the line is delivered as soon as it goes
        hive.notices.set_prefs("user:" + pid, {"quiet_start": None, "quiet_end": None})
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL)
    ids = _estimates(hive, a, ["user:" + MEMBER, "user:" + MEMBER, None])
    client.portal.call(client.app.state.reconcile_once)
    assert _notices(hive, ADMIN) == [] and _notices(hive, MEMBER) == []   # estimates made today wait for tomorrow's line
    yesterday = (datetime.datetime.now(UTC) - datetime.timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)
    hive.db.execute("UPDATE usage SET created_at = ? WHERE estimated = 1",
                    (yesterday.isoformat(timespec="milliseconds").replace("+00:00", "Z"),))
    client.portal.call(client.app.state.reconcile_once)
    (admin_line,) = _notices(hive, ADMIN)
    (member_line,) = _notices(hive, MEMBER)
    assert admin_line["kind"] == member_line["kind"] == "hive" and admin_line["state"] == "delivered"
    assert admin_line["text"] == ("Yesterday, 3 calls were estimated at $0.15. That's their worst case, an upper bound "
                                  "that's usually lower; you can correct them in Usage from the provider's billing within "
                                  "30 days.")
    assert member_line["text"] == ("Yesterday, 2 of your calls were estimated at $0.10. That's their worst case, an upper "
                                   "bound that's usually lower; an admin can correct them from the provider's billing "
                                   "within 30 days.")
    client.portal.call(client.app.state.reconcile_once)
    assert len(_notices(hive, ADMIN)) == len(_notices(hive, MEMBER)) == 1   # one a day, whatever the passes
    assert len(ids) == 3


def test_quiet_hours_hold_the_line_for_the_morning_digest(client):
    from hive.core.cost_reservations import estimated_lines
    hive = client.app.state.hive
    _people(hive)
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL)
    _estimates(hive, a, [None])
    tomorrow = datetime.datetime.now(UTC).date() + datetime.timedelta(days=1)
    night = datetime.datetime.combine(tomorrow, datetime.time(3, 0), UTC)
    hive.notices.clock = lambda: night                                     # default quiet hours: 21:00 to 07:00, UTC
    assert estimated_lines(hive.db, [("user:" + ADMIN, True, "UTC")], hive.notices.from_hive, night.timestamp()) == ["user:" + ADMIN]
    (line,) = _notices(hive, ADMIN)
    assert (line["kind"], line["state"], line["held_reason"]) == ("hive", "held", "quiet")
    assert line["text"].startswith("Yesterday, 1 call was estimated at $0.05. That's its worst case")
    hive.notices.clock = lambda: night.replace(hour=7, minute=30)
    hive.notices.sweep()
    rows = _notices(hive, ADMIN)
    assert [(r["kind"], r["state"]) for r in rows] == [("hive", "digested"), ("digest", "delivered")]
    out = hive.notices.list("user:" + ADMIN)
    assert [i["text"] for i in out["notices"][0]["items"]] == [line["text"]]


def test_the_line_leaves_out_corrected_estimates_and_a_restart_never_repeats_it(tmp_path):
    from hive.core.cost_reservations import correct, estimated_lines
    db = Database(tmp_path / "h.db")
    res = Reservations(db)
    for i in range(3):
        res.reserve(f"k{i}", {"i": i}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": "a", "payer": "user:" + MEMBER},
                    dispatched=True)
        res.unknown(f"k{i}")
    night = datetime.datetime(2026, 11, 12, 1, 0, tzinfo=UTC)

    def record(meta, usd, **fields):
        db.insert("usage", {"agent_id": "a", "model": MODEL, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd,
                            "created_at": fields.pop("created_at", "2026-11-12T01:00:00.000Z"), "payer": meta["payer"], **fields})
    db.execute("UPDATE cost_reservations SET unknown_at = ?", (night.timestamp() - UNKNOWN_EXPIRY_SECONDS - 1,))   # held since before the night's expiry, whatever today's date
    expire_unknown(res, record, now=night.timestamp())
    correct(res, "k1", "release", "billing shows nothing", "user:" + ADMIN, record_usage_for=record, now=night.timestamp())
    sent = []
    morning = datetime.datetime(2026, 11, 13, 8, 0, tzinfo=UTC)
    people = [("user:" + ADMIN, True, "UTC"), ("user:" + MEMBER, False, "Europe/Lisbon")]
    assert estimated_lines(db, people, lambda p, text: sent.append((p, text)), morning.timestamp()) == [p for p, _, _ in people]
    assert [text.split(".")[0] for _, text in sent] == ["Yesterday, 2 calls were estimated at $0", "Yesterday, 2 of your calls were estimated at $0"]
    assert estimated_lines(db, people, lambda p, text: sent.append((p, text)), morning.timestamp() + 3600) == []
    assert len(sent) == 2                                                  # the same day again, as after a restart
    later = datetime.datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
    assert estimated_lines(db, people, lambda p, text: sent.append((p, text)), later.timestamp()) == []   # nothing new


def test_a_line_covering_more_than_a_day_says_since_when():
    from hive.core.cost_reservations import estimated_words
    assert estimated_words(4, 0.2, True, "Since 9 Nov").startswith("Since 9 Nov, 4 calls were estimated at $0.20. ")
    assert estimated_words(1, 0.0034, False, "Yesterday") == ("Yesterday, 1 of your calls was estimated at $0.0034. That's "
                                                              "its worst case, an upper bound that's usually lower; an admin "
                                                              "can correct it from the provider's billing within 30 days.")
    # an admin reads that the estimates can be corrected, never an instruction to go and check, and of free models by name
    admin = estimated_words(2, 0.1, True, "Yesterday", [("openrouter/x:free", 1)])
    assert admin == ("Yesterday, 2 calls were estimated at $0.10. That's their worst case, an upper bound that's usually "
                     "lower; you can correct them in Usage from the provider's billing within 30 days. 1 call to a free "
                     "model (openrouter/x:free) had an unknown outcome and was settled at $0, its price.")
    assert estimated_words(0, 0, True, "Yesterday", [("openrouter/x:free", 2)]) == (
        "Yesterday, 2 calls to a free model (openrouter/x:free) had an unknown outcome and were settled at $0, their "
        "price; if the provider's billing shows a charge, you can correct them in Usage within 30 days.")
    assert "free model" not in estimated_words(1, 0.05, False, "Yesterday", [("openrouter/x:free", 1)])


def test_free_models_estimates_reach_only_admins_lines_named_by_model(tmp_path):
    from hive.core.cost_reservations import FREE_FLOOR_MICROS, estimated_lines
    db = Database(tmp_path / "h.db")
    res = Reservations(db)
    for key, usd, model in (("paid", 0.05, MODEL), ("free", FREE_FLOOR_MICROS / 1_000_000, "openrouter/x:free")):
        res.reserve(key, {"k": key}, usd, lambda: [("hive", 10.0, 0.0)],
                    metadata={"agent": "a", "payer": "user:" + MEMBER, "model": model}, dispatched=True)
        res.unknown(key)
    night = datetime.datetime(2026, 11, 12, 1, 0, tzinfo=UTC)
    db.execute("UPDATE cost_reservations SET unknown_at = ?", (night.timestamp() - UNKNOWN_EXPIRY_SECONDS - 1,))

    def record(meta, usd, **fields):
        db.insert("usage", {"agent_id": "a", "model": meta["model"], "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd,
                            "created_at": fields.pop("created_at", "2026-11-12T01:00:00.000Z"), "payer": meta["payer"], **fields})
    assert sorted(expire_unknown(res, record, now=night.timestamp())) == ["free", "paid"]
    sent = []
    morning = datetime.datetime(2026, 11, 13, 8, 0, tzinfo=UTC)
    people = [("user:" + ADMIN, True, "UTC"), ("user:" + MEMBER, False, "UTC")]
    assert estimated_lines(db, people, lambda p, text: sent.append((p, text)), morning.timestamp()) == [p for p, _, _ in people]
    lines = dict(sent)
    assert lines["user:" + MEMBER].startswith("Yesterday, 1 of your calls was estimated at $0.05.")
    assert "free model" not in lines["user:" + MEMBER]                  # it moved none of their spend
    assert lines["user:" + ADMIN].startswith("Yesterday, 1 call was estimated at $0.05.")
    assert lines["user:" + ADMIN].endswith("1 call to a free model (openrouter/x:free) had an unknown outcome and was "
                                           "settled at $0, its price.")


# ---- correcting -------------------------------------------------------------------------------------------------------

def test_a_correction_within_30_days_adjusts_the_spend(client):
    a, held = _held(client, 3)
    hive = client.app.state.hive
    _expire(client)
    estimate = {h["id"]: h["held_usd"] for h in held}
    lower, freed, higher = (h["id"] for h in held)
    hive.db.execute("UPDATE cost_reservation_resolutions SET decided_at = ?", (time.time() - 29 * 86400,))   # day 29
    r = _correct(client, lower, action="settle", actual_usd=0.0123, reason="billing shows $0.0123")
    assert r.status_code == 200, r.text
    assert r.json() == {"id": lower, "state": "settled", "maximum": round(estimate[lower] * 1e6), "actual": 12_300,
                        "estimate": round(estimate[lower] * 1e6), "action": "settle"}
    assert _correct(client, freed, action="release", reason="billing shows nothing").json()["actual"] == 0
    assert _correct(client, higher, action="settle", actual_usd=0.06, reason="billing shows $0.06").status_code == 200
    for rid, billed in ((lower, 0.0123), (freed, 0.0), (higher, 0.06)):
        kept, adjusting = _usage(hive, rid)                               # the estimate stays; one row adjusts it
        assert (kept["estimated"], kept["cost_usd"]) == (1, pytest.approx(estimate[rid]))
        assert adjusting["estimated"] == 0 and adjusting["created_at"] == kept["created_at"]
        assert kept["cost_usd"] + adjusting["cost_usd"] == pytest.approx(billed)
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(0.0723)
    month = hive.db.one("SELECT SUM(cost_usd) AS s FROM usage WHERE agent_id = ? AND created_at >= ?",
                        (a["id"], period_start("month")))["s"]
    assert month == pytest.approx(0.0723)
    assert [(o["reservation"], o["source"]) for o in client.get("/api/budgets/overruns").json()] == [(higher, "correct")]
    assert client.get("/api/budgets/reservations/estimated").json() == []
    again = _correct(client, lower, action="release", reason="second thoughts")
    assert again.status_code == 409 and again.json()["error"]["code"] == "not_correctable"
    assert "corrected already" in again.json()["error"]["message"]
    rows = {r["reservation"]: r for r in hive.db.all("SELECT * FROM cost_reservation_corrections")}
    assert {k: (v["action"], v["actual"]) for k, v in rows.items()} == {lower: ("settle", 12_300), freed: ("release", 0),
                                                                        higher: ("settle", 60_000)}


def test_a_correction_lands_in_the_month_its_estimate_was_charged(client):
    a, (h,) = _held(client, 1)
    hive = client.app.state.hive
    _expire(client)
    last_month = (datetime.datetime.fromisoformat(period_start("month").replace("Z", "+00:00"))
                  - datetime.timedelta(days=2)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    hive.db.execute("UPDATE usage SET created_at = ? WHERE reservation = ?", (last_month, h["id"]))
    assert _correct(client, h["id"], action="release", reason="billing shows nothing").status_code == 200
    rows = _usage(hive, h["id"])
    assert [r["created_at"] for r in rows] == [last_month, last_month]
    this_month = hive.db.one("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE agent_id = ? AND created_at >= ?",
                             (a["id"], period_start("month")))["s"]
    assert this_month == 0                                                 # no room this month that its allowance never had


def test_a_correction_after_30_days_is_refused(client):
    from hive.core.cost_reservations import CORRECTION_SECONDS
    from hive.tests.test_unbilled_refusal_release import _ok_chat, _post
    a, (h,) = _held(client, 1)
    hive = client.app.state.hive
    _ok_chat(client.app.state.gateway)
    assert _post(client, a) == 200                                         # this call answers and settles at its cost
    answered = hive.db.one("SELECT id, actual FROM cost_reservations WHERE state = 'settled'")
    _expire(client)
    hive.db.execute("UPDATE cost_reservation_resolutions SET decided_at = ? WHERE decided_by = 'hive:expiry'",
                    (time.time() - CORRECTION_SECONDS - 60,))
    before = _usage(hive, h["id"])
    r = _correct(client, h["id"], action="release", reason="billing shows nothing")
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_correctable"
    assert "more than 30 days ago" in r.json()["error"]["message"]
    assert _usage(hive, h["id"]) == before
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(h["held_usd"] + answered["actual"] / 1_000_000)
    assert client.get("/api/budgets/reservations/estimated").json() == []
    r = _correct(client, answered["id"], action="release", reason="x")          # it answered: no estimate
    assert r.status_code == 409 and "not settled at an estimate" in r.json()["error"]["message"]
    assert _correct(client, "no-such-call", action="release", reason="x").status_code == 409


def test_correcting_all_is_all_or_none(client):
    a, held = _held(client, 3)
    hive = client.app.state.hive
    _expire(client)
    ids = [h["id"] for h in held]
    assert _correct(client, ids[1], action="settle", actual_usd=0.02, reason="billing shows $0.02").status_code == 200
    before = {rid: _usage(hive, rid) for rid in ids}
    r = client.post(ROUTE, json={"action": "release", "ids": ids, "reason": "billing shows no charge"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_correctable"
    assert ids[1] in r.json()["error"]["message"] and "corrected already" in r.json()["error"]["message"]
    assert {rid: _usage(hive, rid) for rid in ids} == before               # nothing changed
    assert sorted(e["id"] for e in client.get("/api/budgets/reservations/estimated").json()) == sorted([ids[0], ids[2]])
    r = client.post(ROUTE, json={"action": "release", "ids": [ids[0], ids[2]], "reason": "billing shows no charge"})
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 2 and [x["actual"] for x in r.json()["corrected"]] == [0, 0]
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(0.02)
    assert [x["cost_usd"] for x in _usage(hive, ids[0])] == [pytest.approx(held[0]["held_usd"]), pytest.approx(-held[0]["held_usd"])]
    assert client.get("/api/budgets/reservations/estimated").json() == []


def test_settling_all_estimates_keeps_each_estimate_as_billed(client):
    a, held = _held(client, 2)
    hive = client.app.state.hive
    _expire(client)
    r = client.post(ROUTE, json={"action": "settle", "ids": [h["id"] for h in held], "reason": "billing matches"})
    assert r.status_code == 200 and [x["action"] for x in r.json()["corrected"]] == ["settle", "settle"]
    assert all(len(_usage(hive, h["id"])) == 1 for h in held)              # no adjusting row: the estimate was billed
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(sum(h["held_usd"] for h in held))
    assert client.get("/api/budgets/reservations/estimated").json() == []


@pytest.mark.parametrize("body", [
    {"action": "refund", "reason": "x"},
    {"action": "settle", "reason": "x"},
    {"action": "settle", "actual_usd": -1, "reason": "x"},
    {"action": "settle", "actual_usd": "lots", "reason": "x"},
    {"action": "release", "reason": "  "},
])
def test_a_correction_it_cannot_take_is_a_bad_request(client, body):
    _, (h,) = _held(client, 1)
    _expire(client)
    r = _correct(client, h["id"], **body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"
    assert len(client.get("/api/budgets/reservations/estimated").json()) == 1


def test_only_an_admin_reads_or_corrects_estimates(client):
    _, (h,) = _held(client, 1)
    _expire(client)
    anonymous = TestClient(client.app)
    assert anonymous.get("/api/budgets/reservations/estimated").status_code == 401
    r = anonymous.post(f"/api/budgets/reservations/{h['id']}/correct", json={"action": "release", "reason": "x"})
    assert r.status_code == 401 and len(client.get("/api/budgets/reservations/estimated").json()) == 1


# ---- OpenRouter's record after the hour -------------------------------------------------------------------------------

def _openrouter_calls(client, n):
    """n sent OpenRouter calls held unknown at $0.05 whose answers named a generation id (gen-0, gen-1, ...) but no cost
    the hive could price, so each waits for OpenRouter's record. Returns the mind and the reservation ids, oldest first."""
    _, (a,) = make_swarm_and_agents(client, n=1, model=OPENROUTER, budget_usd=5.0)
    res = Reservations(client.app.state.hive.db)
    keys = []
    for i in range(n):
        key = f"chat:{a['id']}:record-{i}"
        res.reserve(key, {"i": i}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"agent": a["id"], "model": OPENROUTER},
                    dispatched=True)
        res.observe(key, {"response_id": f"gen-{i}", "usage_origin": "usage-unverified"})
        res.unknown(key)
        keys.append(key)
    return a, keys


@pytest.mark.parametrize("billed, adjusted, overrun", [(0.0123, True, False), (0.05, False, False), (0.07, True, True)])
def test_a_record_that_comes_after_the_hour_corrects_the_estimate(client, monkeypatch, billed, adjusted, overrun):
    hive = client.app.state.hive
    a, (key,) = _openrouter_calls(client, 1)
    ready = []
    _openrouter(client, monkeypatch, lambda r: httpx.Response(200, json={"data": {"id": "gen-0", "total_cost": billed}})
                if ready else httpx.Response(404, json={"error": {"code": 404, "message": "Generation not found"}}))
    _expire(client)                                                     # no record within the hour: the worst case
    assert hive.db.one("SELECT actual FROM cost_reservations WHERE id = ?", (key,))["actual"] == 50_000
    ready.append(True)
    client.portal.call(client.app.state.reconcile_once)                 # the record comes and sets the call's cost
    assert hive.db.one("SELECT actual FROM cost_reservations WHERE id = ?", (key,))["actual"] == round(billed * 1_000_000)
    c = hive.db.one("SELECT action, estimate, decided_by, reason FROM cost_reservation_corrections WHERE reservation = ?",
                    (key,))
    assert (c["action"], c["estimate"], c["decided_by"]) == ("settle", 50_000, "hive:provider-record") and "gen-0" in c["reason"]
    rows = _usage(hive, key)
    assert [r["estimated"] for r in rows] == ([1, 0] if adjusted else [1])    # none when the record is the estimate
    assert {r["created_at"] for r in rows} == {rows[0]["created_at"]}         # dated with the estimate
    assert sum(r["cost_usd"] for r in rows) == pytest.approx(billed)
    assert hive.agent(a["id"])["spent_usd"] == pytest.approx(billed)
    assert client.get("/api/budgets/reservations/estimated").json() == []
    assert [(o["reservation"], o["source"]) for o in client.get("/api/budgets/overruns").json()] == \
        ([(key, "provider-record")] if overrun else [])


def test_after_a_sleep_past_the_hour_every_call_ends_at_its_records_cost(client, monkeypatch):
    """A hive that slept past the hour holding more OpenRouter calls than a pass reads records for: the pass reads ten
    and the expiry estimates the other two before their turn, and the next pass reads theirs, so all twelve end at what
    their records report."""
    hive = client.app.state.hive
    _, keys = _openrouter_calls(client, 12)
    _openrouter(client, monkeypatch, lambda r: httpx.Response(200, json={"data": {
        "id": r.url.params["id"], "total_cost": (int(r.url.params["id"][4:]) + 1) / 1000}}))
    _expire(client)
    assert len(hive.db.all("SELECT reservation FROM cost_reservation_resolutions WHERE decided_by = 'hive:expiry'")) == 2
    client.portal.call(client.app.state.reconcile_once)
    assert [hive.db.one("SELECT actual FROM cost_reservations WHERE id = ?", (k,))["actual"] for k in keys] == \
        [1000 * (i + 1) for i in range(12)]
    assert client.get("/api/budgets/reservations/estimated").json() == []


def test_an_estimate_whose_record_is_missing_is_asked_again_once_its_age_has_doubled(tmp_path):
    from hive.core.cost_reservations import CORRECTION_SECONDS, correct, estimates_with_records, record_asked
    res = Reservations(Database(tmp_path / "h.db"))
    for key, model, generation in (("a", OPENROUTER, "gen-a"), ("b", OPENROUTER, "gen-b"), ("plain", "anthropic/x", "msg_1"),
                                   ("no-id", OPENROUTER, None)):
        res.reserve(key, {"k": key}, 0.05, lambda: [("hive", 10.0, 0.0)], metadata={"model": model, "key": "k_1"},
                    dispatched=True)
        if generation:
            res.observe(key, {"response_id": generation})
        res.unknown(key)
    made = time.time() + UNKNOWN_EXPIRY_SECONDS + 1
    assert len(expire_unknown(res, lambda meta, usd, **marks: None, now=made)) == 4

    def due(age, limit=None):
        return [e[0] for e in estimates_with_records(res, made + age, 5, limit)]
    assert [(rid, key, generation, meta["model"]) for rid, key, generation, meta in estimates_with_records(res, made, 5)] \
        == [("a", "k_1", "gen-a", OPENROUTER), ("b", "k_1", "gen-b", OPENROUTER)]   # only calls with a record to read
    record_asked(res, "a", made + 10)                                   # asked when 10 s old: no record yet
    assert due(19) == ["b"] and due(20) == ["b", "a"]                   # again once 20 s old; the longest due first
    assert due(20, limit=1) == ["b"]
    record_asked(res, "a", made + 20)
    assert "a" not in due(39) and "a" in due(40)
    record_asked(res, "b", made + 1)                                    # one pass (least, 5 s) is the shortest wait
    assert "b" not in due(5.9) and "b" in due(6)
    assert due(CORRECTION_SECONDS + 1) == []                            # past its 30 days the estimate stands
    correct(res, "a", "release", "billing shows nothing", "user:" + ADMIN, now=made + 50)
    assert due(100) == ["b"]                                            # corrected: nothing left to ask about


def test_the_reconcile_asks_for_a_missing_record_again_only_once_it_is_due(client, monkeypatch):
    hive = client.app.state.hive
    _, (key,) = _openrouter_calls(client, 1)
    asked = _openrouter(client, monkeypatch, lambda r: httpx.Response(404, json={"error": {"code": 404, "message": "x"}}))
    _expire(client)                                                     # asked while unknown, then estimated
    hive.db.execute("UPDATE cost_reservation_resolutions SET decided_at = decided_at - 100 WHERE reservation = ?", (key,))
    before = len(asked)
    client.portal.call(client.app.state.reconcile_once)                 # the estimate's first ask finds no record
    client.portal.call(client.app.state.reconcile_once)                 # not again until it is twice as old
    assert len(asked) - before == 1
    assert hive.db.one("SELECT actual FROM cost_reservations WHERE id = ?", (key,))["actual"] == 50_000


# ---- the ledger stays append-only, whatever the corrections ---------------------------------------------------------------

def _calls(rnd):
    """One case's estimates in micro-dollars, each left alone (None), released, or settled at a billed cost; a fifth of
    the draws take an edge value: a $0 model's floor (1, which the expiry settles at $0, its price), the smallest worst
    case above it (2) or the largest drawn, and a billed cost of nothing, exactly the estimate (no adjusting row), one
    micro-dollar over the hold (an overrun) or the largest drawn."""
    def draw(edges, low, high):
        return rnd.choice(edges) if rnd.random() < 0.2 else rnd.randint(low, high)
    out = []
    for _ in range(rnd.randint(1, 6)):
        held = draw([1, 2, 900_000], 1, 900_000)
        kind = rnd.choice(["keep", "release", "settle"])
        change = None if kind == "keep" else ("release", 0) if kind == "release" else \
            ("settle", draw([0, held, held + 1, 2_000_000], 0, 2_000_000))
        out.append((held, change))
    return out


def test_corrections_keep_each_calls_usage_summing_to_its_billed_cost():
    """60 seeded cases, the repo's property style (random.Random, as test_auto_budgets does): whatever is corrected,
    each call's usage rows sum to its final cost, no earlier usage row is rewritten, an adjusting row is dated with its
    estimate, a call is corrected once, and the estimates still listed are exactly the ones nobody corrected."""
    from hive.core.cost_reservations import NotCorrectable, correct, estimated
    rnd = random.Random(107)
    for case in range(60):
        calls = _calls(rnd)
        with tempfile.TemporaryDirectory() as folder:
            db = Database(Path(folder) / "p.db")
            res = Reservations(db)
            for i, (held, _) in enumerate(calls):
                res.reserve(f"k{i}", {"i": i}, held / 1_000_000, lambda: [("hive", 100.0, 0.0)], metadata={"agent": "a"},
                            dispatched=True)
                res.unknown(f"k{i}")

            def record(meta, usd, **fields):
                db.insert("usage", {"agent_id": "a", "model": MODEL, "prompt_tokens": 0, "completion_tokens": 0,
                                    "cost_usd": usd, "created_at": fields.pop("created_at", "2026-11-12T01:00:00.000Z"),
                                    **fields})
            moment = time.time() + UNKNOWN_EXPIRY_SECONDS + 1
            assert len(expire_unknown(res, record, now=moment)) == len(calls), f"case {case}: {calls}"
            kept = db.all("SELECT id, cost_usd, created_at FROM usage ORDER BY id")
            for i, (_, change) in enumerate(calls):
                if change:
                    action, billed = change
                    correct(res, f"k{i}", action, "billing", "user:" + ADMIN, billed / 1_000_000, record, now=moment)
            assert db.all("SELECT id, cost_usd, created_at FROM usage WHERE id <= ? ORDER BY id", (kept[-1]["id"],)) == kept, \
                f"case {case}: an earlier usage row changed"
            for i, (held, change) in enumerate(calls):
                estimate = 0 if held <= 1 else held   # a free model's floor is estimated at its price
                final = change[1] if change else estimate
                rows = db.all("SELECT cost_usd, estimated, created_at FROM usage WHERE reservation = ? ORDER BY id", (f"k{i}",))
                assert sum(r["cost_usd"] for r in rows) == pytest.approx(final / 1_000_000, abs=1e-9), \
                    f"case {case}, call k{i} {(held, change)}: usage sums to {sum(r['cost_usd'] for r in rows)}"
                assert rows[0]["estimated"] == 1 and all(r["estimated"] == 0 and r["created_at"] == rows[0]["created_at"]
                                                         for r in rows[1:]), f"case {case}, call k{i}: {rows}"
                assert len(rows) == (2 if change and change[1] != estimate else 1), f"case {case}, call k{i}: {rows}"
                assert res.get(f"k{i}")["actual"] == final, f"case {case}, call k{i}: actual {res.get(f'k{i}')['actual']}"
                if change:
                    try:
                        correct(res, f"k{i}", "release", "again", "user:" + ADMIN, None, record, now=moment)
                    except NotCorrectable:
                        pass
                    else:
                        pytest.fail(f"case {case}, call k{i}: corrected a second time")
            assert sorted(e["id"] for e in estimated(res, moment)) == sorted(f"k{i}" for i, (_, c) in enumerate(calls) if not c), \
                f"case {case}: {calls}"
