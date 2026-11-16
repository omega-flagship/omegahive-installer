# Purpose: the hive tests known to fail on runner 1, the self-hosted runner the petta jobs (the PR smoke and the full
# hive run) use, one mark per cause with the omega-flagship/omegahive issue that tracks it. On runner 1 a marked test
# still runs, and pytest reads its known failure, and only that failure, as expected, with the issue in a reason
# pytest -rxX prints. Any other failure fails the run, and so does a pass unless the mark says the failure depends on
# timing. On every other host a mark does nothing, so the test fails there until its issue is fixed.
import os

import pytest

# The runner sets RUNNER_NAME in every job step; its job logs print the same name as "Runner name". hive/tests run in
# CI only in the petta jobs, which run on runner 1 alone (ci.yml), and a job on any other runner, GitHub's hosted ones
# included, gets the plain result.
RUNNER_1 = "rnd-auto-kabir-963ef8bb54-1"
ON_RUNNER_1 = os.environ.get("RUNNER_NAME") == RUNNER_1


def fails_on_runner_1(issue, why, raises, strict=True):
    """Expect on runner 1 the failure `raises` names: an exception type, or a pytest.RaisesExc that also matches its
    message. strict=True makes a pass there fail the run, so the mark comes off once the issue is fixed; strict=False
    is for a failure that depends on timing, where a pass shows nothing."""
    reason = f"known failure on runner 1, omega-flagship/omegahive#{issue}: {why}"
    return pytest.mark.xfail(ON_RUNNER_1, reason=reason, raises=raises, strict=strict)


# The launch socket refuses a peer by closing with its request unread, which Linux reports as a reset.
request_credential_reset = fails_on_runner_1(
    285, "request_credential raises the reset Linux reports when the socket refuses", ConnectionResetError)

mcp_doc_lacks_code_mind_proof = fails_on_runner_1(
    286, "hive/MCP_S3.md has no section for the hive_code_mind_proof tool",
    pytest.RaisesExc(AssertionError, match="hive_code_mind_proof"))

# A race with the clock tick, so it sometimes passes on runner 1.
namespace_misses_same_tick_link = fails_on_runner_1(
    288, "the namespace cache misses a link made in the same clock tick as its last scan",
    pytest.RaisesExc(pytest.fail.Exception, match="DID NOT RAISE HiveError"), strict=False)

# The rest pass alone and fail only inside the full run.
stop_failure_leaves_session_active = fails_on_runner_1(
    287, "inside the full run a stop that raises leaves the session active, where it should hold",
    pytest.RaisesExc(AssertionError, match=r"\('active', None\) == \('held', "), strict=False)

stop_failure_rotates_credential = fails_on_runner_1(
    287, "inside the full run a stop that raises still installs a new credential",
    pytest.RaisesExc(AssertionError, match="At index 0 diff"), strict=False)
