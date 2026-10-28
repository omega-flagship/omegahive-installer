"""Nothing a mind did is deleted: old traces move to a compressed per-day archive, big logs roll over whole."""
import gzip

from hive.core import archive as archive_mod
from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)


def test_old_traces_are_archived_not_deleted_and_stay_readable(client):
    _, (a, _b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    for i in range(30):
        r = client.post("/api/agent/trace", headers=agent_headers(a),
                        json={"iteration": i, "response": f"step {i}", "commands": [{"command": f"(send \"{i}\")", "result": "ok"}]})
        assert r.status_code == 200, r.text
    moved = hive.archive.archive_traces(a["id"], keep=10)
    assert moved == 20
    live = client.get(f"/api/agents/{a['id']}/traces?limit=500").json()
    assert len(live) == 10 and {t["iteration"] for t in live} == set(range(20, 30))
    index = client.get(f"/api/agents/{a['id']}/traces/archive").json()
    assert sum(d["entries"] for d in index["days"]) == 20
    day = index["days"][0]["day"]
    old = client.get(f"/api/agents/{a['id']}/traces/archive/{day}?limit=100").json()
    assert [t["iteration"] for t in old] == list(range(20))
    assert old[0]["response"] == "step 0" and old[0]["commands"][0]["command"] == '(send "0")'
    # a second batch appends to the same day file; nothing earlier is lost
    hive.archive.archive_traces(a["id"], keep=5)
    old = client.get(f"/api/agents/{a['id']}/traces/archive/{day}?limit=100").json()
    assert [t["iteration"] for t in old] == list(range(25))
    assert client.get(f"/api/agents/{a['id']}/traces/archive/2026-13").status_code == 400
    assert client.get(f"/api/agents/{a['id']}/traces/archive/1999-01-01").status_code == 404


def test_batching_slack_waits_before_archiving(client):
    _, (a, _b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    for i in range(12):
        client.post("/api/agent/trace", headers=agent_headers(a), json={"iteration": i, "response": "", "commands": []})
    assert hive.archive.archive_traces(a["id"], keep=10, slack=5) == 0
    assert hive.archive.archive_traces(a["id"], keep=10) == 2


def test_big_logs_roll_over_whole_into_the_archive(client):
    _, (a, _b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    log = hive.settings.agents_dir / a["id"] / "agent.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    body = b"".join(b"line %d\n" % i for i in range(5000))
    log.write_bytes(body)
    assert hive.archive.rotate_logs(limit=10**9) == []
    rolled = hive.archive.rotate_logs(limit=1000)
    assert rolled == [{"agent_id": a["id"], "file": rolled[0]["file"], "bytes": len(body)}]
    assert log.read_bytes() == b""
    saved = hive.archive.root / "logs" / a["id"] / rolled[0]["file"]
    assert gzip.decompress(saved.read_bytes()) == body
    logs = client.get(f"/api/agents/{a['id']}/traces/archive").json()["logs"]
    assert logs[0]["bytes"] == len(body) and logs[0]["sha256"].startswith("sha256:")
    assert archive_mod.LOG_LIMIT == 10 * 1024 * 1024
