"""Timed sharing between real Omega agents (offline mock model).

  - Vega shows Lyra a piece of work as an exhibit; Lyra reads it in one step;
  - Lyra asks to read one of Vega's spaces; Vega grants it; Lyra reads it;
  - the operator sees every share and every read.

Opt in with HIVE_E2E=1 (see test_acceptance.py).
"""

import pytest

from hive.tests.test_acceptance import Hive, free_port, wait_until

pytestmark = pytest.mark.skipif(__import__("os").environ.get("HIVE_E2E") != "1", reason="set HIVE_E2E=1")


def traced(c, agent_id, needle):
    return any(needle in str(t) for t in c.get(f"/api/agents/{agent_id}/traces", params={"limit": 200}).json())


def test_dots_show_work_and_spaces_to_each_other(tmp_path):
    hive = Hive(tmp_path, free_port())
    hive.start()
    c = hive.client
    try:
        swarm = c.post("/api/swarms", json={"name": "Study"}).json()
        vega, lyra = (c.post("/api/agents", json={"name": n, "swarm_id": swarm["id"]}).json() for n in ("Vega", "Lyra"))
        for a in (vega, lyra):
            c.post(f"/api/agents/{a['id']}/start")
        assert wait_until(lambda: all(x["connected"] and x["status"] == "awake" for x in c.get("/api/agents").json()))

        # 1. an exhibit: one read instead of a long thread
        c.post(f"/api/agents/{vega['id']}/messages",
               json={"text": "exhibit Lyra 10 Orbit notes | (Orbit lyra ellipse) (Period lyra 12)"})
        shown = wait_until(lambda: [s for s in c.get("/api/shares").json() if s["kind"] == "exhibit"], timeout=90)
        assert shown and shown[0]["grantee_id"] == lyra["id"] and shown[0]["exhibit"]["title"] == "Orbit notes"
        assert wait_until(lambda: c.get("/api/shares").json()[-1]["reads"] >= 1 or
                          any(s["reads"] for s in c.get("/api/shares").json()), timeout=90), "Lyra never read it"
        assert wait_until(lambda: traced(c, lyra["id"], "Orbit lyra ellipse"), timeout=60)

        # 2. a request for a space, granted by its owner, then read
        spaces = wait_until(lambda: [s["name"] for s in c.get(f"/api/agents/{vega['id']}/memory").json()], 60)
        space = "world" if "world" in spaces else spaces[0]
        c.post(f"/api/agents/{lyra['id']}/messages", json={"text": f"share-ask Vega {space} 10 to compare notes"})
        granted = wait_until(lambda: [s for s in c.get("/api/shares").json()
                                      if s["kind"] == "space" and s["status"] == "active"], timeout=120)
        assert granted and granted[0]["owner_id"] == vega["id"] and granted[0]["grantee_id"] == lyra["id"]
        read = wait_until(lambda: c.get(f"/api/shares/{granted[0]['id']}/reads").json(), timeout=90)
        assert read, "Lyra was granted access but never read the space"
        assert wait_until(lambda: traced(c, lyra["id"], "HIVE-SHARED"), timeout=60)
    finally:
        hive.stop()
