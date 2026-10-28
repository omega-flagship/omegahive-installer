"""Test-session hygiene: every tempfile.mkdtemp() made during a test session lands in one session folder, which is
removed when the session ends. Fixtures across the suites call mkdtemp without cleanup; each hive fixture leaves a
data directory (~20 MB), and repeated runs by the platform and owners filled the Mac's disk (2026-10-04: ~10 GB)."""

import shutil
import tempfile

import pytest


@pytest.fixture(scope="session", autouse=True)
def _session_temp_root():
    previous = tempfile.tempdir
    root = tempfile.mkdtemp(prefix="hive-tests-session-")
    tempfile.tempdir = root
    try:
        yield root
    finally:
        tempfile.tempdir = previous
        shutil.rmtree(root, ignore_errors=True)
