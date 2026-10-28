"""Docker driver against a real daemon, with a stand-in agent command."""

import json
import pathlib
import shutil
import subprocess
import tempfile
import time

import pytest

from hive.core.config import load_settings
from hive.supervisor.drivers import DockerDriver
from hive.supervisor.workspace import Workspace

IMAGE = "mirror.gcr.io/library/python:3.11-slim"


def docker_ready():
    """A daemon that does not answer within seconds (e.g. Docker Desktop hung) counts as absent, never a hang."""
    if not shutil.which("docker"):
        return False
    try:
        if subprocess.run(["docker", "info"], capture_output=True, timeout=8).returncode != 0:
            return False
        return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, timeout=8).returncode == 0
    except subprocess.TimeoutExpired:
        return False


pytestmark = pytest.mark.skipif(not docker_ready(), reason=f"needs a docker daemon and {IMAGE}")


def test_container_lifecycle_mounts_and_env(tmp_path):
    settings = load_settings(data_dir=tmp_path / "hive", admin_password="pw")
    chroma = tmp_path / "chromadb"
    chroma.mkdir()
    (chroma / "lib_chromadb.metta").write_text("")
    import os
    os.environ["HIVE_CHROMADB_LIB"] = str(chroma)
    workspace = Workspace(settings)
    agent = {"id": "a_dockertest", "name": "Dock", "persona": "", "model": "mock/echo"}
    workspace.create(agent, "secret-token")
    command = ["sh", "-c", "echo agent-up $HIVE_AGENT_ID; ls /agent/repos/OmegaClaw-Core/hive >/dev/null && "
                           "echo core-mounted; touch /agent/memory/written; sleep 300"]
    driver = DockerDriver(workspace, image=IMAGE, network="none", command=command)
    try:
        driver.start(agent, {"HIVE_AGENT_ID": agent["id"], "HIVE_WS_TOKEN": "secret-token"})
        assert driver.status(agent["id"]) == "running"
        deadline = time.time() + 20
        while time.time() < deadline and "core-mounted" not in "\n".join(driver.logs(agent["id"])):
            time.sleep(0.5)
        logs = "\n".join(driver.logs(agent["id"]))
        assert "agent-up a_dockertest" in logs and "core-mounted" in logs
        assert (workspace.path(agent["id"]) / "memory" / "written").exists()
        info = json.loads(subprocess.run(["docker", "inspect", DockerDriver.container(agent["id"])],
                                         capture_output=True, text=True).stdout)[0]
        mounts = {m["Destination"]: m["RW"] for m in info["Mounts"]}
        assert mounts["/agent/memory"] is True
        assert mounts["/agent/repos/OmegaClaw-Core"] is False
        assert "OMEGACLAW_MEMORY_DIR=/agent/memory" in info["Config"]["Env"]
    finally:
        driver.stop(agent["id"])
    assert driver.status(agent["id"]) == "absent"
