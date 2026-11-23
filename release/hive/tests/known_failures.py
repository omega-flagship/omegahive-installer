# Purpose: the hive tests known to fail on the full run's runners (FULL_RUN_RUNNERS below), one mark per cause with the
# omega-flagship/omegahive issue that tracks it. On those runners a marked test still runs, and pytest reads its known
# failure, and only that failure, as expected, with the issue in a reason pytest -rxX prints. Any other failure fails
# the run, and so does a pass unless the mark says the failure depends on timing. On every other host a mark does
# nothing, so the test fails there until its issue is fixed.
import os

import pytest

# The runner sets RUNNER_NAME in every job step; its job logs print the same name as "Runner name". The full run's
# shards and hive-runtime run on our machines only (ci.yml): runner 1 on the CI machine, and the PeTTa runners on
# kabir-flagship-2 (omega-flagship/.github-private ci-runners/ci-runner-add-host, `16 --docker 1 --petta`: runners 1 to
# 15 carry omegahive-petta-full, runner 16 is the Docker lane and runs no hive tests). A runner added there, or a new
# machine, goes into this one set, and test_known_failures.py checks it. A job on any other runner, GitHub's hosted
# ones included, gets the plain result.
RUNNER_1 = "rnd-auto-kabir-963ef8bb54-1"
FLAGSHIP_2_PETTA = frozenset(f"kabir-flagship-2-{n}" for n in range(1, 16))
FULL_RUN_RUNNERS = frozenset({RUNNER_1}) | FLAGSHIP_2_PETTA


def on_full_run_runner(runner_name):
    """True only for the exact name of a runner the full run uses."""
    return runner_name in FULL_RUN_RUNNERS


ON_FULL_RUN_RUNNER = on_full_run_runner(os.environ.get("RUNNER_NAME"))


def fails_on_full_run_runners(issue, why, raises, strict=True):
    """Expect on the full run's runners the failure `raises` names: an exception type, or a pytest.RaisesExc that also
    matches its message. strict=True makes a pass there fail the run, so the mark comes off once the issue is fixed;
    strict=False is for a failure that depends on timing, where a pass shows nothing."""
    reason = f"known failure on the full run's runners, omega-flagship/omegahive#{issue}: {why}"
    return pytest.mark.xfail(ON_FULL_RUN_RUNNER, reason=reason, raises=raises, strict=strict)


# A race with the clock tick, so it sometimes passes on the full run's runners.
namespace_misses_same_tick_link = fails_on_full_run_runners(
    288, "the namespace cache misses a link made in the same clock tick as its last scan",
    pytest.RaisesExc(pytest.fail.Exception, match="DID NOT RAISE HiveError"), strict=False)
