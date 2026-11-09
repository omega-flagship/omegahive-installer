"""Screen blocks a screen asked for that nothing draws yet: reported best-effort by browsers, kept ONCE per
(screen, wanted) whatever release reports them, and filed as one task in Create's Code swarm through the goals API,
only from an admin's report and within a hive-wide allowance. Synthetic only."""
import asyncio

import pytest

from hive.core.db import now
from hive.core.screens_missing import CREATED_BY, ScreensMissing
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

ITEM = {"ui_release": "r4-test", "screen": "tools", "wanted": "timeline", "drawn_as": "list"}


def code_swarm(client):
    """The Code swarm this synthetic hive provisions, or one bound here when it has none."""
    hive = client.supervisor.hive
    row = hive.db.one("SELECT swarm_id FROM person_minds WHERE purpose = 'foundation_create_code'")
    if row and row["swarm_id"]:
        return row["swarm_id"]
    sw = client.post("/api/swarms", json={"name": "Code"}).json()
    stamp = now()
    hive.db.execute("INSERT INTO person_minds (principal, purpose, agent_id, swarm_id, created_at, updated_at) "
                    "VALUES (?, 'foundation_create_code', NULL, ?, ?, ?)", ("user:operator", sw["id"], stamp, stamp))
    return sw["id"]


def filed(client, swarm):
    return client.supervisor.hive.db.all("SELECT * FROM goals WHERE swarm_id = ? AND created_by = ?", (swarm, CREATED_BY))


def run(client, coro):
    return asyncio.run_coroutine_threadsafe(coro, client.supervisor.hive.events._loop).result(10)


def post(client, *items):
    return client.post("/api/screens/missing", json={"items": list(items)})


def test_no_code_swarm_stores_nothing_and_files_nothing(client):
    hive = client.supervisor.hive
    hive.db.execute("DELETE FROM person_minds WHERE purpose = 'foundation_create_code'")   # this synthetic hive has none
    r = post(client, ITEM)
    assert r.status_code == 409 and r.json()["error"]["code"] == "code_swarm_missing"
    assert hive.db.all("SELECT * FROM screens_missing") == []
    assert hive.db.all("SELECT * FROM goals WHERE created_by = ?", (CREATED_BY,)) == []


def test_an_admins_first_report_files_one_task_and_later_ones_count(client):
    swarm = code_swarm(client)
    first = post(client, ITEM).json()["items"][0]
    assert first["filed"] is True and first["task_id"]
    again = post(client, ITEM, ITEM).json()["items"]
    assert [x["filed"] for x in again] == [False, False] and {x["task_id"] for x in again} == {first["task_id"]}
    goals = filed(client, swarm)
    assert len(goals) == 1 and goals[0]["id"] == first["task_id"]
    assert "timeline" in goals[0]["title"] and "tools" in goals[0]["detail"]
    row = client.supervisor.hive.db.one("SELECT * FROM screens_missing")
    assert row["reports"] == 3 and row["task_id"] == first["task_id"]


def test_a_release_name_never_makes_a_new_task_but_another_screen_does(client):
    swarm = code_swarm(client)
    post(client, ITEM)
    other = post(client, dict(ITEM, ui_release="r5-test"), dict(ITEM, ui_release="anything-else"), dict(ITEM, screen="roles")).json()["items"]
    assert [x["filed"] for x in other] == [False, False, True]
    assert len(filed(client, swarm)) == 2
    assert client.supervisor.hive.db.one("SELECT last_release FROM screens_missing WHERE screen = 'tools'")["last_release"] == "anything-else"


def test_a_members_report_counts_and_never_files_or_shows_a_task(client):
    swarm = code_swarm(client)
    m = ScreensMissing(client.supervisor.hive)
    out = run(client, m.report("user:member-invented", [ITEM], admin=False))["items"]
    assert out == [{"screen": "tools", "wanted": "timeline", "filed": False}]
    assert filed(client, swarm) == []
    first = post(client, ITEM).json()["items"][0]           # then an admin's report files it
    assert first["filed"] is True and len(filed(client, swarm)) == 1


def test_the_hive_files_at_most_its_allowance(client):
    swarm = code_swarm(client)
    m = ScreensMissing(client.supervisor.hive, file_limit=2)
    items = [dict(ITEM, wanted=w) for w in ("alpha", "beta", "gamma")]
    out = run(client, m.report("user:operator", items, admin=True))["items"]
    assert [x["filed"] for x in out] == [True, True, False]
    assert len(filed(client, swarm)) == 2
    row = client.supervisor.hive.db.one("SELECT task_id, claimed_at FROM screens_missing WHERE wanted = 'gamma'")
    assert row["task_id"] is None and row["claimed_at"] is None    # the claim went back: a later report files it


def test_a_failed_announce_keeps_the_task_so_nothing_is_filed_twice(client, monkeypatch):
    swarm = code_swarm(client)
    hive = client.supervisor.hive

    async def deaf(goal):
        raise RuntimeError("invented announce failure")
    monkeypatch.setattr(hive.goals, "announce", deaf)
    assert post(client, ITEM).json()["items"][0]["filed"] is True
    monkeypatch.undo()
    assert post(client, ITEM).json()["items"][0]["filed"] is False
    assert len(filed(client, swarm)) == 1


def test_a_failed_filing_gives_the_claim_back(client, monkeypatch):
    swarm = code_swarm(client)
    hive = client.supervisor.hive

    def refuse(*a, **k):
        raise hive.error(409, "swarm_archived", "invented refusal")
    monkeypatch.setattr(hive.goals, "_create_record", refuse)
    assert post(client, ITEM).status_code == 409
    row = hive.db.one("SELECT task_id, claimed_at FROM screens_missing")
    assert row["task_id"] is None and row["claimed_at"] is None
    monkeypatch.undo()
    assert post(client, ITEM).json()["items"][0]["filed"] is True and len(filed(client, swarm)) == 1


def test_a_claim_cut_off_mid_filing_is_claimed_again_once_stale(client):
    swarm = code_swarm(client)
    hive = client.supervisor.hive
    stamp = now()
    hive.db.execute("INSERT INTO screens_missing (screen, wanted, drawn_as, last_release, claimed_at, first_seen, last_seen) "
                    "VALUES ('tools', 'timeline', 'list', 'r4-test', ?, ?, ?)", (stamp, stamp, stamp))
    assert post(client, ITEM).json()["items"][0]["filed"] is False     # a live claim: someone is filing it now
    hive.db.execute("UPDATE screens_missing SET claimed_at = '2020-01-01T00:00:00.000Z'")
    assert post(client, ITEM).json()["items"][0]["filed"] is True      # a stale one: claimed again
    assert len(filed(client, swarm)) == 1


def test_rows_hold_no_person_data(client):
    code_swarm(client)
    post(client, ITEM)
    row = dict(client.supervisor.hive.db.one("SELECT * FROM screens_missing"))
    assert set(row) == {"screen", "wanted", "drawn_as", "last_release", "task_id", "claimed_at", "reports", "first_seen", "last_seen"}
    assert "operator" not in " ".join(str(v) for v in row.values())


@pytest.mark.parametrize("bad", [
    {"items": []},
    {"items": "timeline"},
    {"items": [dict(ITEM, screen="Tools Page")]},
    {"items": [dict(ITEM, wanted="(not x)")]},
    {"items": [dict(ITEM, ui_release="")]},
    {"items": [dict(ITEM, drawn_as="a b")]},
    {"items": [ITEM] * 21},
])
def test_bad_reports_are_refused_and_store_nothing(client, bad):
    code_swarm(client)
    r = client.post("/api/screens/missing", json=bad)
    assert r.status_code == 400
    assert client.supervisor.hive.db.all("SELECT * FROM screens_missing") == []


def test_reports_are_paced_per_principal_and_quiet_histories_go():
    class Hive:
        class Err(Exception):
            def __init__(self, status, code, msg):
                super().__init__(msg); self.status, self.code = status, code
        error = Err

        class DB:
            def execute(self, *a): return None
        db = DB()
    t = [0.0]
    m = ScreensMissing(Hive(), limit=3, window=10, clock=lambda: t[0])
    m._paced("user:a", 3)
    with pytest.raises(Hive.Err) as exc:
        m._paced("user:a", 1)
    assert exc.value.status == 429
    m._paced("user:b", 3)          # another person has their own allowance
    t[0] = 11.0
    m._paced("user:a", 3)          # the window passed
    assert set(m._seen) == {"user:a"}   # user:b's quiet history was dropped


def test_a_refused_report_is_paced_too(client):
    hive = client.supervisor.hive
    hive.db.execute("DELETE FROM person_minds WHERE purpose = 'foundation_create_code'")
    m = ScreensMissing(hive, limit=1)
    with pytest.raises(Exception) as first:
        run(client, m.report("user:operator", [ITEM], admin=True))
    assert getattr(first.value, "status", None) == 409
    with pytest.raises(Exception) as second:
        run(client, m.report("user:operator", [ITEM], admin=True))
    assert getattr(second.value, "status", None) == 429


def test_the_list_is_for_admins(client):
    code_swarm(client)
    post(client, ITEM)
    items = client.get("/api/screens/missing").json()["items"]
    assert [(x["screen"], x["wanted"]) for x in items] == [("tools", "timeline")]
