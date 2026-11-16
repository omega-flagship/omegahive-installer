"""hive.programs_check resolves async view() and act() as the host does (no PeTTa needed)."""
import json
import pathlib
import subprocess
import sys

from hive.programs_check import check

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "hive" / "plugins" / "contract_fixture"

# An app whose view() and act() are coroutines, over the public fixture. It also refuses to run on a different event
# loop from its first call, as a program holding loop-bound state (a lock, a client) would fail.
ASYNC_PROGRAM = '''
import asyncio
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("fixture_inner", {fixture!r})
_inner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_inner)
_LOOP = None


def _same_loop():
    global _LOOP
    loop = asyncio.get_running_loop()
    if _LOOP is None:
        _LOOP = loop
    if loop is not _LOOP:
        raise RuntimeError("called on a different event loop from the first call")


def describe():
    return _inner.describe()


async def view(ctx, focus, stage):
    _same_loop()
    await asyncio.sleep(0)
    return _inner.view(ctx, focus, stage)


async def act(ctx, action, items, params):
    _same_loop()
    return await _inner.act(ctx, action, items, params)
'''


def _async_app(tmp_path):
    folder = tmp_path / "async_app"
    folder.mkdir()
    manifest = json.loads((FIXTURE / "plugin.json").read_text())
    manifest["id"] = "async-fixture"
    (folder / "plugin.json").write_text(json.dumps(manifest))
    (folder / "program.py").write_text(ASYNC_PROGRAM.format(fixture=str(FIXTURE / "program.py")))
    return folder


def test_async_view_and_act_are_awaited(tmp_path):
    folder = _async_app(tmp_path)
    lines = []
    assert check(folder, log=lines.append, scenario=True, allow_mutation=True)
    assert any(line.startswith("views valid in every stage") for line in lines)
    assert any(line.startswith("inspect-source returns") for line in lines)
    assert any(line.startswith("correct keeps every id") for line in lines)


def test_the_cli_reports_an_async_app_compatible_without_unawaited_coroutines(tmp_path):
    folder = _async_app(tmp_path)
    out = subprocess.run([sys.executable, "-W", "error::RuntimeWarning", "-m", "hive.programs_check", str(folder)],
                         cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "COMPATIBLE with program contract" in out.stdout
    assert "never awaited" not in out.stderr


def test_sync_programs_still_pass():
    assert check(FIXTURE, log=lambda *_: None, scenario=True, allow_mutation=True)
