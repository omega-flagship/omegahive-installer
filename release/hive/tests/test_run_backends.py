"""Tool runs go through one run interface (hive/core/run_backends.py; flagship omegahive#85, step 1).

The hive's callers ask the run backend to run a pinned bundle; only the backend starts, signals and cleans up the run's
processes and folders. Today's in-OS sandbox is the only backend and behaves as before. A second backend can replace it
without any caller changing: a fake backend installed here is the one every caller reaches.
"""
import asyncio
import pathlib
import re

import pytest

from hive.core import run_backends
from hive.core.run_backends import LocalSandboxBackend, RunBackend

CORE = pathlib.Path(__file__).resolve().parents[1] / "core"


@pytest.fixture(autouse=True)
def _reset_backend():
    previous = run_backends.use(None)
    yield
    run_backends.use(previous)


def test_the_default_backend_is_todays_sandbox(monkeypatch):
    monkeypatch.delenv("HIVE_RUN_BACKEND", raising=False)
    backend = run_backends.get()
    assert isinstance(backend, LocalSandboxBackend) and backend.name == "local-sandbox"
    from hive.core import sandbox_run
    assert backend.MAX_STDERR == sandbox_run.MAX_STDERR and backend.OutputLimit is sandbox_run.SandboxOutputLimit


def test_an_unknown_backend_name_fails_closed(monkeypatch):
    monkeypatch.setenv("HIVE_RUN_BACKEND", "nowhere")
    with pytest.raises(RuntimeError, match="unknown HIVE_RUN_BACKEND"):
        run_backends.get()


def test_the_local_backend_delegates_to_the_sandbox_unchanged(monkeypatch):
    from hive.core import sandbox_run
    seen = {}

    async def fake_run(program, entry, args, inputs, outputs, runtime, bundle, **limits):
        seen.update(program=program, entry=entry, args=args, runtime=runtime, bundle=bundle, limits=limits)
        return {"exit": 0}

    monkeypatch.setattr(sandbox_run, "run", fake_run)
    monkeypatch.setattr(sandbox_run, "_allowed_apps", lambda: {"demo"})
    monkeypatch.setattr(sandbox_run, "_runtimes", lambda: {"python": {"exe": "/x/python"}})
    monkeypatch.setattr(sandbox_run, "available", lambda: True)
    backend = LocalSandboxBackend()
    out = asyncio.run(backend.run({"id": "demo"}, "run.py", ["a"], None, (), "python", "tools", cpu_seconds=3, timeout=4))
    assert out == {"exit": 0}
    assert seen == {"program": {"id": "demo"}, "entry": "run.py", "args": ["a"], "runtime": "python", "bundle": "tools",
                    "limits": {"cpu_seconds": 3, "timeout": 4}}
    assert backend.allowed_apps() == {"demo"} and backend.runtimes() == {"python": {"exe": "/x/python"}}
    assert backend.available() is True


def test_the_local_backend_runs_the_hives_own_tools_through_the_sandbox_runner(monkeypatch):
    from hive.core import sandbox_run
    seen = {}

    async def fake_hive_tool(name, files, entry, args, inputs, outputs, **limits):
        seen.update(name=name, files=files, entry=entry, args=args, inputs=inputs, outputs=outputs, limits=limits)
        return {"exit": 0}

    monkeypatch.setattr(sandbox_run, "run_hive_tool", fake_hive_tool)
    out = asyncio.run(LocalSandboxBackend().run_hive_tool("pdf-reader", {"pdf_text.py": "pass"}, "pdf_text.py", ["9"],
                                                          {"in.pdf": b"%PDF-1.4"}, ["text.txt"], cpu_seconds=8))
    assert out == {"exit": 0}
    assert seen == {"name": "pdf-reader", "files": {"pdf_text.py": "pass"}, "entry": "pdf_text.py", "args": ["9"],
                    "inputs": {"in.pdf": b"%PDF-1.4"}, "outputs": ["text.txt"], "limits": {"cpu_seconds": 8}}


class FakeBackend(RunBackend):
    name = "fake"
    MAX_STDERR = 10

    def __init__(self):
        self.calls = []

    def available(self):
        return True

    def allowed_apps(self):
        return {"demo"}

    def runtimes(self):
        return {}

    async def run(self, program, entry, args=(), inputs=None, outputs=(), runtime="node", bundle="tools", **limits):
        self.calls.append((program["id"], entry, runtime, bundle, limits))
        return {"exit": 0, "stdout": b"", "stderr": b"", "stdout_truncated": False, "missing_outputs": [], "outputs": {}}


def test_a_second_backend_is_reached_by_an_apps_sandbox_run_without_changing_the_caller(tmp_path):
    from hive.core.programs import ProgramContext

    class Hive:
        def error(self, status, code, message):
            return RuntimeError(f"{status} {code}: {message}")

    fake = FakeBackend()
    run_backends.use(fake)
    ctx = ProgramContext.__new__(ProgramContext)      # only the parts sandbox_run uses
    ctx._hive = Hive()
    ctx._program = {"id": "demo", "capabilities": ["sandbox:run"]}
    ctx._need = lambda capability: None
    out = asyncio.run(ctx.sandbox_run("run.py", runtime="python", cpu_seconds=2))
    assert out["exit"] == 0
    assert fake.calls == [("demo", "run.py", "python", "tools", {"cpu_seconds": 2})]


def test_no_hive_module_but_the_backend_reaches_into_the_sandbox_runner():
    """Done-when for step 1: callers use run_backends; only bundle verification (hive policy, no processes) and the
    output-limit type stay importable from sandbox_run directly."""
    allowed_direct = {"verify_bundle", "verify_tool_bundle"}
    offenders = []
    for path in sorted(CORE.glob("*.py")):
        if path.name in {"sandbox_run.py", "run_backends.py"}:
            continue
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"sandbox_run\.([A-Za-z_]+)", text):
            name = match.group(1)
            if name not in allowed_direct and name != "py":
                offenders.append(f"{path.name}: sandbox_run.{name}")
        for match in re.finditer(r"from \.sandbox_run import ([A-Za-z_, ]+)", text):
            names = {n.strip() for n in match.group(1).split(",")}
            if names - allowed_direct:
                offenders.append(f"{path.name}: from .sandbox_run import {sorted(names - allowed_direct)}")
        if re.search(r"^\s*from \. import sandbox_run\b", text, flags=re.M):
            offenders.append(f"{path.name}: from . import sandbox_run")
    assert offenders == []
