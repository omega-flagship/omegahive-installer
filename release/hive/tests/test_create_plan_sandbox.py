"""Create plans: the authored acceptance check under production's runner, SandboxChecks (the hive's OS sandbox).

Moved out of test_create_plan_engine.py so it can run in the full run's switch shard (scripts/ci/hive-switch-files.txt):
the sandbox cannot start at the machine's restriction 1, where the plain shards run. The scaffold, the check and the
built page are test_create_plan_engine.py's."""
import asyncio
import json
import pathlib
import sys

import pytest

from hive.core import create_plan_engine as cpe
from hive.tests.test_create_plan_engine import APP_FIXED, CHECK, PAGE, ROOT, SCAFFOLD, STYLE


def test_the_authored_check_runs_in_the_hive_sandbox(monkeypatch):
    """Production's runner: the pinned create-acceptance-check bundle under sandbox_run (no network, fresh job folder).
    Red on the scaffold, green on the built page; a check that reaches for the network gets no network."""
    from hive.core import sandbox_run
    from hive.core.create_plan_ports import SandboxChecks
    monkeypatch.setenv("HIVE_SANDBOX_RUN_APPS", "create-acceptance-check")
    monkeypatch.setenv("HIVE_SANDBOX_RUNTIMES", json.dumps({"python": {"exe": str(pathlib.Path(sys.executable).absolute()),
                                                                         "reads": sorted({sys.prefix, sys.base_prefix})}}))
    if not sandbox_run.available():
        pytest.skip("no OS sandbox on this host")
    sandbox_run.verify_bundle(str(ROOT / "hive/plugins/create_acceptance_check"), "tools")
    checks = SandboxChecks()
    red = asyncio.run(checks.run({**SCAFFOLD, cpe.CHECK_PATH: CHECK}, cpe.CHECK_PATH))
    assert red["outcome"] == "fail" and set(red["failing"]) == {"index.html", "style.css", "app.js"}, red
    green = asyncio.run(checks.run({**SCAFFOLD, "index.html": PAGE, "style.css": STYLE, "app.js": APP_FIXED,
                                    cpe.CHECK_PATH: CHECK}, cpe.CHECK_PATH))
    assert green["outcome"] == "pass", green
    net = ("import socket, json\ntry:\n    socket.create_connection(('1.1.1.1', 80), 2); ok = True\nexcept OSError:\n    ok = False\n"
           "print('CREATE-CHECK ' + json.dumps({'passed': False, 'failing': ['net' if ok else 'nonet']}))\n")
    out = asyncio.run(checks.run({cpe.CHECK_PATH: net}, cpe.CHECK_PATH))
    assert out["failing"] == ["nonet"], out
    # a build file named like a module the check imports is never imported (review F2): the check still judges
    shadow = 'print("CREATE-CHECK " + %r)\nraise SystemExit(0)\n' % json.dumps({"passed": True, "failing": []})
    out = asyncio.run(checks.run({**SCAFFOLD, "json.py": shadow, "html/__init__.py": shadow, "re.py": shadow,
                                  cpe.CHECK_PATH: CHECK}, cpe.CHECK_PATH))
    assert out["outcome"] == "fail", out
