"""Phase 1 acceptance: a real hive with three real Omega agents in one swarm.

Boots the server as a subprocess with the local driver and the offline
``mock/echo`` model, so it needs PeTTa and the agent runtime's Python
packages, but no API keys.  Slow (about a minute); opt in with HIVE_E2E=1:

    HIVE_E2E=1 PETTA_PATH=~/PeTTa HIVE_CHROMADB_LIB=/path/to/petta_lib_chromadb \
        python3 -m pytest hive/tests/test_acceptance.py
"""

import os
import pathlib
import socket
import subprocess
import sys
import time

import httpx
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.environ.get("HIVE_E2E") != "1", reason="set HIVE_E2E=1")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Hive:
    def __init__(self, data_dir, port):
        self.data_dir, self.port = data_dir, port
        self.proc = None

    def start(self):
        env = dict(os.environ, HIVE_DATA_DIR=str(self.data_dir), HIVE_ADMIN_PASSWORD="pw",
                   HIVE_PORT=str(self.port), HIVE_PUBLIC_URL=f"http://127.0.0.1:{self.port}", HIVE_LOG_LEVEL="warning")
        self.log = open(self.data_dir / "server.log", "a")
        self.proc = subprocess.Popen([sys.executable, "-m", "hive"], cwd=ROOT, env=env, stdout=self.log,
                                     stderr=subprocess.STDOUT)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=60)
        for _ in range(100):
            try:
                token = self.client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
                self.client.headers["Authorization"] = f"Bearer {token}"
                return
            except httpx.HTTPError:
                time.sleep(0.2)
        raise RuntimeError("hive did not start")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=60)
        self.log.close()


def wait_until(predicate, timeout=120, step=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


def test_three_omegas_share_revise_and_survive_restart(tmp_path):
    hive = Hive(tmp_path, free_port())
    hive.start()
    c = hive.client
    try:
        swarm = c.post("/api/swarms", json={"name": "Aurora"}).json()
        agents = {}
        for name in ("Vega", "Lyra", "Orion"):
            agents[name] = c.post("/api/agents", json={"name": name, "swarm_id": swarm["id"]}).json()
            c.post(f"/api/agents/{agents[name]['id']}/start")
        assert wait_until(lambda: all(a["connected"] for a in c.get("/api/agents").json())), "agents did not connect"

        def reply(name, text, count):
            agent_id = agents[name]["id"]
            c.post(f"/api/agents/{agent_id}/messages", json={"text": text})
            return wait_until(lambda: (lambda out: out[count - 1]["text"] if len(out) >= count else None)(
                [m for m in c.get(f"/api/agents/{agent_id}/messages").json() if m["direction"] == "out"]), timeout=90)

        assert "I hear you" in reply("Vega", "hello Vega", 1)
        assert "I now believe" in reply("Vega", "believe (--> sky blue) 0.9 0.8", 2)
        assert "I now believe" in reply("Lyra", "believe (--> sky blue) 0.95 0.7", 1)
        assert "I now believe" in reply("Orion", "believe (--> sky blue) 0.1 0.6", 1)

        detail = wait_until(lambda: (lambda d: d if len(d.get("assertions", [])) >= 3 else None)(
            c.get(f"/api/swarms/{swarm['id']}/beliefs/detail", params={"statement": "(--> sky blue)"}).json()))
        assert [a["outcome"] for a in detail["assertions"]] == ["adopted", "revised", "revised"]
        assert detail["tv"] == {"f": 0.761702, "c": 0.886792}
        assert sorted(detail["sources"]) == sorted(a["id"] for a in agents.values())
        assert len(c.get("/api/usage").json()) < 60, "an LLM call storm is back"
    finally:
        hive.stop()

    hive.start()
    c = hive.client
    try:
        assert wait_until(lambda: all(a["connected"] for a in c.get("/api/agents").json())), "agents not restored"
        beliefs = c.get(f"/api/swarms/{swarm['id']}/beliefs").json()
        assert beliefs[0]["tv"] == {"f": 0.761702, "c": 0.886792}
        assert "commons" in reply("Orion", "ask (Current (--> sky $x) $tv $st)", 2)
    finally:
        hive.stop()
