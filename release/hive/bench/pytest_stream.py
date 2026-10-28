"""pytest plugin: report each test as a Lab case on stdout (``-p hive.bench.pytest_stream``)."""

from __future__ import annotations

import os

from .protocol import emit

_seen = set()


def _group(nodeid):
    path = nodeid.split("::", 1)[0]
    return os.path.splitext(os.path.basename(path))[0].removeprefix("test_")


def _name(nodeid):
    parts = nodeid.split("::")
    return " / ".join(p.removeprefix("test_").replace("_", " ") for p in parts[1:]) or parts[0]


def pytest_runtest_logreport(report):
    if report.nodeid in _seen:
        return
    final = (report.when == "call") or (report.when == "setup" and (report.failed or report.skipped)) \
        or (report.when == "teardown" and report.failed)
    if not final:
        return
    _seen.add(report.nodeid)
    if report.skipped:
        status = "skipped"
    elif report.failed:
        status = "failed" if report.when == "call" else "error"
    else:
        status = "passed"
    message = None
    if report.skipped and isinstance(report.longrepr, tuple):
        message = str(report.longrepr[2])
    elif report.failed:
        message = str(report.longreprtext)[-6000:]
    emit("case", id=report.nodeid, name=_name(report.nodeid), group=_group(report.nodeid), dimension="correctness",
         status=status,
         duration_ms=round(report.duration * 1000, 1), message=message)
