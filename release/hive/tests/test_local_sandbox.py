"""J1b sandbox items: HIVE_SANDBOX_PYTHON on both wrap paths (r4 ST1, r4.1 K-1) and the first-boot preflight
(r4 ST3, r4.1 K-2, Kimi r4.1 P3: a write to <data>/hive.db from inside a mind-profile sandbox gets EPERM)."""

import asyncio
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys

import pytest

from hive.core import sandbox_run
from hive.supervisor import preflight, sandbox

MAC = sys.platform == "darwin" and shutil.which("sandbox-exec") is not None
NODE = shutil.which("node")
CHOSEN = "/opt/omegahive/sandbox-python/0123abcd/bin/python3.12"


@pytest.fixture(autouse=True)
def _clear_refusal():
    yield
    sandbox._REFUSED = None
    sandbox._TOOLS_REFUSED = None


# ---- K-1: the chosen interpreter starts on BOTH paths ----------------------------------------------------------------

class _Stop(Exception):
    pass


def test_the_mind_path_starts_the_chosen_interpreter(tmp_path, monkeypatch):
    """drivers.LocalDriver.start (the mind wrap, drivers.py) runs argv[0] == HIVE_SANDBOX_PYTHON, then -I -S landlock.py."""
    from hive.supervisor import drivers
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", CHOSEN)
    monkeypatch.setenv("HIVE_MIND_SANDBOX", "1")
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    monkeypatch.setattr(drivers, "sandbox_available", lambda: True)
    seen = {}

    def popen(argv, **kwargs):
        seen["argv"] = argv
        raise _Stop()

    monkeypatch.setattr(drivers.subprocess, "Popen", popen)
    from hive.core.config import load_settings
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw")
    from hive.supervisor.workspace import Workspace
    driver = drivers.LocalDriver(Workspace(settings), settings.petta_path)
    monkeypatch.setattr(driver.workspace, "command", lambda agent, petta: ["/bin/echo", "mind"])
    driver.workspace.path("a_test").mkdir(parents=True, exist_ok=True)
    with pytest.raises(_Stop):
        driver.start({"id": "a_test", "kind": "omegaclaw"}, {})
    argv = seen["argv"]
    assert argv[0] == CHOSEN and argv[1:3] == ["-I", "-S"] and argv[3].endswith("landlock.py")
    assert argv[-2:] == ["/bin/echo", "mind"]


def test_the_tool_path_starts_the_chosen_interpreter(tmp_path, monkeypatch):
    """sandbox_run (tools.py run -> _run_admitted -> wrap) runs argv[0] == HIVE_SANDBOX_PYTHON, then -I -S landlock.py,
    even though the tool's own environment is scrubbed (the interpreter is argv[0], not an inherited variable)."""
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", CHOSEN)
    monkeypatch.setenv("HIVE_SANDBOX_RUN_APPS", "demo")
    exe = tmp_path / "rt" / "bin" / "node"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"node": str(exe)}))
    app = tmp_path / "app"
    (app / "tools").mkdir(parents=True)
    (app / "tools" / "t.js").write_text("1")
    (app / "tools" / "bundle.lock.json").write_text(json.dumps(
        {"files": {"t.js": hashlib.sha256(b"1").hexdigest()}}))
    import hive.supervisor.sandbox as sb
    monkeypatch.setattr(sb, "backend", lambda: "landlock")
    monkeypatch.setattr(sandbox_run, "backend", lambda: "landlock")
    monkeypatch.setattr(sandbox_run, "available", lambda: True)
    monkeypatch.setattr(sandbox_run, "_runtime_reachable", lambda *a: True)
    monkeypatch.setattr(sandbox_run, "_granted", lambda kind, reads: tuple(sorted({str(exe.resolve().parent.parent), str(app)})))
    seen = {}

    async def spawn(*argv, **kwargs):
        seen["argv"], seen["env"] = list(argv), kwargs.get("env")
        raise _Stop()

    monkeypatch.setattr(sandbox_run.asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(_Stop):
        asyncio.run(sandbox_run.run({"id": "demo", "path": str(app)}, "t.js"))
    argv = seen["argv"]
    assert argv[0] == CHOSEN and argv[1:3] == ["-I", "-S"] and argv[3].endswith("landlock.py")
    assert "HIVE_SANDBOX_PYTHON" not in seen["env"]   # scrubbed child env, yet the chosen interpreter runs


def test_unset_keeps_the_hives_own_interpreter_exactly(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_SANDBOX_PYTHON", raising=False)
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    argv, _ = sandbox.wrap(["/bin/echo"], tmp_path / "m", [], tmp_path / "p", "a_x", ports=[8700])
    assert argv[0] == sys.executable and argv[1].endswith("landlock.py")


def test_a_relative_sandbox_python_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("HIVE_SANDBOX_PYTHON", "python3")
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    with pytest.raises(RuntimeError):
        sandbox.wrap(["/bin/echo"], tmp_path / "m", [], tmp_path / "p", "a_x", ports=[8700])


# ---- ST3: the preflight table ----------------------------------------------------------------------------------------

def _data(tmp_path):
    data = tmp_path / "data"
    data.mkdir(mode=0o700, parents=True)
    db = sqlite3.connect(data / "hive.db")
    db.execute("CREATE TABLE t (x)")
    db.commit()
    db.close()
    return data


@pytest.mark.skipif(not MAC, reason="the macOS rows run under sandbox-exec")
def test_mac_preflight_passes_through_the_real_mind_and_tool_paths(tmp_path, monkeypatch):
    if NODE:
        monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"node": NODE}))
    else:
        monkeypatch.delenv("HIVE_SANDBOX_RUNTIMES", raising=False)
    data = _data(tmp_path)
    before = (data / "hive.db").read_bytes()
    receipt = preflight.run(data)
    rows = {r["id"]: r for r in receipt["rows"]}
    if NODE:
        assert receipt["pass"] and receipt["status"] == "pass", json.dumps(receipt, indent=1)
    else:   # r1.1: the tool rows were skipped, so this is incomplete, never a pass
        assert receipt["status"] == "incomplete" and receipt["minds"], json.dumps(receipt, indent=1)
    assert rows["mind.write_hive_db"]["got"] == "EPERM"        # Kimi r4.1 P3, the exact hive-owned target
    assert rows["mind.read_canary"]["got"] == "EPERM"
    assert rows["mind.write_outside"]["got"] == "EPERM"
    assert rows["mind.connect_ungranted"]["got"] == "EPERM"
    assert rows["mind.connect_hive"]["got"] == "allowed"
    assert rows["mind.write_own_folder"]["got"] == "allowed"
    assert rows["mind.namespaces"]["applies"] is False and rows["mind.etc_unlisted"]["applies"] is False
    if NODE:
        assert rows["tool.write_hive_db"]["got"] == "EPERM" and rows["tool.read_canary"]["got"] == "EPERM"
        assert rows["tool.connect_loopback"]["pass"]
    assert (data / "hive.db").read_bytes() == before            # the probe never wrote a byte
    assert not (data / "preflight" / "outside-mind").exists()


@pytest.mark.skipif(not MAC, reason="the macOS rows run under sandbox-exec")
def test_a_too_open_sandbox_fails_the_preflight_and_refuses_every_mind(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_SANDBOX_RUNTIMES", raising=False)
    monkeypatch.setattr(sandbox, "profile", lambda mind_dir, reads, ports=None: "(version 1)\n(allow default)\n")
    data = _data(tmp_path)
    receipt = preflight.run_and_record(data)
    rows = {r["id"]: r for r in receipt["rows"]}
    assert receipt["pass"] is False and rows["mind.write_hive_db"]["pass"] is False
    assert sandbox.refused() and sandbox.backend() is None and not sandbox.available()
    with pytest.raises(RuntimeError):
        sandbox.wrap(["/bin/echo"], tmp_path / "m", [], tmp_path / "p", "a_x")
    assert sandbox_run.backend() is None   # the tool path is refused by the same switch
    stored = data / "preflight" / "receipt.json"
    assert json.loads(stored.read_text())["pass"] is False and oct(stored.stat().st_mode & 0o777) == "0o600"
    assert (data / "preflight" / "first-boot.json").exists()


def test_no_backend_is_a_failed_preflight(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox, "backend", lambda: None)
    receipt = preflight.run_and_record(_data(tmp_path))
    assert receipt["pass"] is False and sandbox.refused()


def test_a_crashing_preflight_is_a_failure_never_a_pass(tmp_path, monkeypatch):
    def boom(data_dir):
        raise OSError("disk")
    monkeypatch.setattr(preflight, "run", boom)
    assert preflight.run_and_record(_data(tmp_path))["pass"] is False and sandbox.refused()


LINUX_GOOD = {"read_canary": "ENOENT", "write_outside": "EACCES", "write_hive_db": "ENOENT", "write_own_folder": "allowed",
              "read_granted": "allowed", "write_granted": "EACCES", "connect_granted": "allowed",
              "connect_ungranted": "ECONNREFUSED", "connect_outside": "ENETUNREACH",
              "new_namespaces": {"pid": True, "net": True, "user": True}, "interfaces": ["lo"],
              "read_etc_unlisted": "ENOENT", "read_etc_listed": "allowed"}


def test_linux_rows_pass_on_a_good_sandbox():
    rows = preflight.evaluate("linux", "mind", LINUX_GOOD, mind=True)
    assert all(r["pass"] for r in rows), rows
    assert {r["id"] for r in rows} >= {"mind.namespaces", "mind.loopback_only", "mind.etc_unlisted", "mind.write_granted"}


@pytest.mark.parametrize("key,bad", [("new_namespaces", {"pid": True, "net": False, "user": True}),
                                     ("interfaces", ["eth0", "lo"]), ("read_etc_unlisted", "allowed"),
                                     ("write_granted", "allowed"), ("write_hive_db", "allowed"),
                                     ("connect_outside", "allowed"), ("connect_granted", "ECONNREFUSED")])
def test_each_linux_row_catches_its_failure(key, bad):
    rows = preflight.evaluate("linux", "mind", dict(LINUX_GOOD, **{key: bad}), mind=True)
    assert not all(r["pass"] for r in rows if r["applies"])


def test_mac_rows_require_eperm_exactly():
    result = dict(LINUX_GOOD, read_canary="EPERM", write_outside="EPERM", write_hive_db="ENOENT",
                  write_granted="EPERM", connect_ungranted="EPERM")
    rows = {r["id"]: r for r in preflight.evaluate("mac", "mind", result, mind=True)}
    assert rows["mind.write_hive_db"]["pass"] is False   # on the Mac a missing file is not the sandbox denying it
    assert rows["mind.namespaces"]["applies"] is False


def test_the_landlock_abi_row_is_recorded_on_linux(tmp_path, monkeypatch):
    from hive.supervisor import landlock
    monkeypatch.setattr(preflight, "_platform", lambda: "linux")
    monkeypatch.setattr(sandbox, "backend", lambda: "landlock")
    monkeypatch.setattr(landlock, "abi_version", lambda: 0)
    monkeypatch.setattr(preflight, "_mind_probe", lambda *a: (LINUX_GOOD, {"argv0": "x"}))
    monkeypatch.delenv("HIVE_SANDBOX_RUNTIMES", raising=False)
    receipt = preflight.run(_data(tmp_path))
    assert receipt["landlock_abi"] == 0 and receipt["pass"] is False and receipt["status"] == "fail"
    monkeypatch.setattr(landlock, "abi_version", lambda: 4)
    receipt = preflight.run(_data(tmp_path / "again"))
    # r1.1 (stand-in r1.0 P2-2): every row that ran passed, but with no node runtime the tool rows were skipped, so
    # this is "incomplete" (minds verified, tools unverified), no longer a pass
    assert receipt["landlock_abi"] == 4 and receipt["status"] == "incomplete" and receipt["pass"] is False
    assert receipt["minds"] is True and receipt["tools"] is False


# ---- r1.1, stand-in r1.0 P2-2: skipped tool rows are an incomplete preflight, never a pass ------------------------

@pytest.mark.skipif(not MAC, reason="the macOS rows run under sandbox-exec")
def test_r11_no_node_is_incomplete_and_keeps_tools_refused(tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_SANDBOX_RUNTIMES", raising=False)
    receipt = preflight.run_and_record(_data(tmp_path))
    assert receipt["status"] == "incomplete" and receipt["pass"] is False, json.dumps(receipt, indent=1)
    assert receipt["minds"] is True and receipt["tools"] is False and "tools" in receipt["reason"]
    assert not [r for r in receipt["rows"] if r["id"].startswith("tool.")]
    assert sandbox.refused() is None and sandbox.available()          # minds were verified: they may run
    assert sandbox.tools_refused() and not sandbox_run.available()   # tools were not: they stay refused
    with pytest.raises(RuntimeError, match="sandbox unavailable"):
        asyncio.run(sandbox_run._run_admitted({"id": "x", "path": str(tmp_path)}, "e.js"))


@pytest.mark.skipif(not MAC or not NODE, reason="the macOS rows run under sandbox-exec, with Node")
def test_r11_with_node_the_preflight_is_a_complete_pass(tmp_path, monkeypatch):
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"node": NODE}))
    receipt = preflight.run_and_record(_data(tmp_path))
    assert receipt["status"] == "pass" and receipt["pass"] is True and receipt["minds"] and receipt["tools"]
    assert sandbox.refused() is None and sandbox.tools_refused() is None


def test_r11_incomplete_keeps_tools_refused_whatever_the_cause(tmp_path, monkeypatch):
    monkeypatch.setattr(preflight, "run", lambda d: {"version": 1, "platform": "test", "rows": [], "pass": False,
                                                     "status": "incomplete", "minds": True, "tools": False,
                                                     "reason": "tools unverified"})
    receipt = preflight.run_and_record(_data(tmp_path))
    assert receipt["status"] == "incomplete"
    assert sandbox.refused() is None and sandbox.tools_refused() == "tools unverified"


def test_r11_a_failure_still_refuses_minds_and_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox, "backend", lambda: None)
    receipt = preflight.run_and_record(_data(tmp_path))
    assert receipt["status"] == "fail" and receipt["pass"] is False and sandbox.refused()
