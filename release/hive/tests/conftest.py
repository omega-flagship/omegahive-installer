"""Hive test isolation from this machine's live services."""
import pytest


@pytest.fixture(autouse=True)
def _code_release_guard_isolated(tmp_path_factory, monkeypatch):
    """The Code release guard reads the real Code service LaunchAgent. Tests must not depend on which release the live
    service happens to run, so by default it sees no agent; guard tests set their own agent, and
    test_the_code_service_on_this_machine_loads_the_intended_release reads the real file itself."""
    from hive.core.code import Code
    monkeypatch.setattr(Code, "CODE_AGENT_PLIST", str(tmp_path_factory.mktemp("no-agent") / "absent.plist"))
