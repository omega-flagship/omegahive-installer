"""Surface audit 8 (2026-10-05): goal list rows and goal.updated events say who must review the result."""
import asyncio

from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def test_list_rows_and_events_carry_review_by(client):
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "Reviewed"}).json()["id"]
    seen = []
    original = hive.events.publish
    hive.events.publish = lambda kind, **kw: (seen.append((kind, kw)), original(kind, **kw))[1]
    try:
        g1 = asyncio.run(hive.goals.create(sw, "needs a person", binding={"review": "person"}))
        g2 = asyncio.run(hive.goals.create(sw, "plain"))
        hive.goals._emit(g1["id"])
    finally:
        hive.events.publish = original
    rows = {g["id"]: g for g in client.get(f"/api/swarms/{sw}/goals").json()}
    assert rows[g1["id"]]["review_by"] == "person" and rows[g2["id"]]["review_by"] == "none"
    updated = [kw["goal"] for kind, kw in seen if kind == "goal.updated" and kw["goal"]["id"] == g1["id"]]
    assert updated and updated[-1]["review_by"] == "person"
