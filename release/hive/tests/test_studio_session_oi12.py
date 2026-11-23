# Purpose: retain the adopted host restart pin and verify the standalone installer's exact restart artifact.
"""OI12: pin the adopted host override and the candidate standalone installer entry point.

The pin check reads the packaged entry point; the boundary cases use synthetic
files and hashes. No Hive/session constructor, database, provider, restart or
external host script is used. Native installation is checked separately.
"""
from types import SimpleNamespace
import hashlib
from pathlib import Path


REVIEWED_OVERRIDE_SHA256 = "de8c80c4cb7240a6b83f9657145c059461c0bcf95c387f4de7724c44eee24429"


class SyntheticFile:
    def __init__(self, trace, body=b"synthetic safe-restart input\n", error=None):
        self.trace, self.body, self.error = trace, body, error

    def read_bytes(self):
        self.trace.append("read_bytes")
        if self.error is not None:
            raise self.error
        return self.body


def mac_file(monkeypatch, sessions, file):
    monkeypatch.setattr(sessions, "host_platform", lambda: "darwin")
    monkeypatch.setattr(sessions, "safe_restart_path", lambda: file)


def test_OI12_keeps_the_host_override_and_pins_the_delivered_installer_entrypoint():
    from hive.core import studio_sessions as sessions

    assert type(sessions.MAC_SAFE_RESTART_OVERRIDE_HASHES) is tuple
    entry = Path(__file__).resolve().parents[2] / "install/macos/safe-restart.py"
    assert sessions.MAC_SAFE_RESTART_OVERRIDE_HASHES == (
        REVIEWED_OVERRIDE_SHA256, hashlib.sha256(entry.read_bytes()).hexdigest())


def test_OI12_mac_accepts_the_reviewed_digest_at_the_existing_reader_hash_seam(monkeypatch):
    from hive.core import studio_sessions as sessions

    trace = []
    file = SyntheticFile(trace)
    mac_file(monkeypatch, sessions, file)

    def sha256(body):
        trace.append(("sha256", body))

        def hexdigest():
            trace.append("hexdigest")
            return REVIEWED_OVERRIDE_SHA256

        return SimpleNamespace(hexdigest=hexdigest)

    # Replace only this SUT module's dependency, not the shared hashlib module.
    monkeypatch.setattr(sessions, "hashlib", SimpleNamespace(sha256=sha256))
    assert sessions.mac_restart_override_adopted() is True
    assert trace == ["read_bytes", ("sha256", file.body), "hexdigest"]


def test_OI12_mac_rejects_the_real_hash_of_unreviewed_synthetic_bytes(monkeypatch):
    from hive.core import studio_sessions as sessions

    trace = []
    file = SyntheticFile(trace, body=b"OI12 unreviewed restart fixture\n")
    mac_file(monkeypatch, sessions, file)
    # Use the real hash implementation for this refusal, never change the pin.
    assert sessions.hashlib.sha256(file.body).hexdigest() != REVIEWED_OVERRIDE_SHA256
    assert sessions.mac_restart_override_adopted() is False
    assert trace == ["read_bytes"]


def test_OI12_mac_missing_override_file_still_refuses(monkeypatch):
    from hive.core import studio_sessions as sessions

    trace = []
    mac_file(monkeypatch, sessions, SyntheticFile(trace, error=FileNotFoundError("synthetic missing override")))
    assert sessions.mac_restart_override_adopted() is False
    assert trace == ["read_bytes"]


def test_OI12_non_mac_still_passes_without_reading_a_host_path(monkeypatch):
    from hive.core import studio_sessions as sessions

    def forbidden_path():
        raise AssertionError("non-Mac guard must not request a host path")

    monkeypatch.setattr(sessions, "host_platform", lambda: "linux")
    monkeypatch.setattr(sessions, "safe_restart_path", forbidden_path)
    assert sessions.mac_restart_override_adopted() is True
