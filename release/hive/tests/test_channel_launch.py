"""The hub channel never adopts or signals a daemon recorded by another launch: in a mind's own pid namespace the same
pids come back at every launch, a stale daemon.pid named a live (unrelated) pid, the channel answered ALREADY-RUNNING
and no cloud mind rejoined after a restart (2026-10-08). Within one launch the old pid-based behaviour is unchanged."""

import importlib.util
import json
import os
import pathlib
import subprocess

import pytest

SOURCE = pathlib.Path(__file__).resolve().parents[2] / "modules" / "channel_hive" / "src" / "hive_channel.py"


@pytest.fixture
def channel(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("hive_channel_launch_test", SOURCE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setenv("HIVE_LAUNCH_ID", "launch-2")
    spawned, signalled = [], []

    class FakePopen:
        def __init__(self, argv, env=None, **kw):
            spawned.append(env)
            self.pid = 4242

    shim = type("subprocess", (), {"Popen": FakePopen, "DEVNULL": subprocess.DEVNULL, "STDOUT": subprocess.STDOUT})
    monkeypatch.setattr(mod, "subprocess", shim)
    monkeypatch.setattr(mod, "_terminate", lambda pid, timeout=5.0: signalled.append(pid))
    real_kill = os.kill
    monkeypatch.setattr(mod.os, "kill", lambda pid, sig: real_kill(pid, 0) if sig == 0 else signalled.append(pid))
    mod.spawned, mod.signalled = spawned, signalled
    return mod


def record(folder, **fields):
    (folder / "daemon.pid").write_text(json.dumps(fields))


@pytest.mark.parametrize("fields", [{"launch": "launch-1"}, {}])   # another launch, or an old record with none
def test_a_record_from_another_launch_naming_a_live_pid_is_neither_adopted_nor_signalled(channel, fields):
    folder = channel.channel_dir()
    record(folder, pid=os.getpid(), owner=os.getpid(), **fields)   # alive in this namespace, as pid 19 was
    assert channel.start_hive("ws://127.0.0.1:9/agent-hub", "t").startswith("HIVE-CHANNEL-STARTED")
    assert channel.signalled == []
    assert json.loads((folder / "daemon.pid").read_text()) == {"pid": 4242, "owner": os.getpid(), "launch": "launch-2"}
    assert channel.spawned[0]["HIVE_WS_URL"] == "ws://127.0.0.1:9/agent-hub"
    assert "daemon=down" in channel.status()                        # another launch's pid is not this launch's daemon


def test_this_launchs_live_daemon_is_kept(channel):
    folder = channel.channel_dir()
    record(folder, pid=os.getpid(), owner=os.getpid(), launch="launch-2")
    assert channel.start_hive("ws://x/agent-hub", "t") == f"HIVE-CHANNEL-ALREADY-RUNNING pid={os.getpid()}"
    assert channel.spawned == [] and channel.signalled == []


def test_stop_signals_only_this_launchs_daemon(channel):
    folder = channel.channel_dir()
    record(folder, pid=os.getpid(), owner=1, launch="launch-1")
    channel.stop_hive()
    assert channel.signalled == []
    record(folder, pid=os.getpid(), owner=1, launch="launch-2")
    channel.stop_hive()
    assert channel.signalled == [os.getpid()]


def test_every_launch_gets_a_new_launch_id(tmp_path, monkeypatch):
    from hive.core.config import load_settings
    from hive.supervisor.drivers import Supervisor
    monkeypatch.setenv("HIVE_DATA_DIR", str(tmp_path))
    sup = Supervisor(load_settings(), drivers={"local": object(), "docker": object()})
    sup.workspace.env = lambda agent, hub_url, api_url, memory_dir=None: {}
    ids = {sup.env({"id": "a_1", "driver": d})["HIVE_LAUNCH_ID"] for d in ("local", "local", "docker")}
    assert len(ids) == 3
