"""Purpose: the known-failure marks apply on exactly the full run's runners, runner 1 and the flagship-2 PeTTa runners,
and on no other host (omega-flagship/omegahive#619)."""
import os

import pytest

from hive.tests import known_failures as KF

FULL_RUN = ["rnd-auto-kabir-963ef8bb54-1"] + [f"kabir-flagship-2-{n}" for n in range(1, 16)]


@pytest.mark.parametrize("name", FULL_RUN)
def test_a_full_run_runner_gets_the_marks(name):
    assert KF.on_full_run_runner(name)


@pytest.mark.parametrize("name", [
    None, "",
    "kabir-flagship-2-16",              # the Docker lane on kabir-flagship-2: no hive tests
    "kabir-flagship-2-0", "kabir-flagship-2-150", "kabir-flagship-2", "kabir-flagship-2-1 ",
    "rnd-auto-kabir-963ef8bb54-2",      # runner 2 on the CI machine, the Docker lane
    "rnd-auto-kabir-963ef8bb54-6",      # an ordinary CI runner
    "rnd-auto-kabir-963ef8bb54-10",
    "omega-hive-1-1",
    "GitHub Actions 1000002517",        # a GitHub-hosted machine
])
def test_any_other_host_gets_the_plain_result(name):
    assert not KF.on_full_run_runner(name)


def test_the_set_is_runner_1_and_fifteen_flagship_2_runners():
    assert KF.FULL_RUN_RUNNERS == frozenset(FULL_RUN)


def test_this_job_reads_its_own_runner_name():
    assert KF.ON_FULL_RUN_RUNNER is KF.on_full_run_runner(os.environ.get("RUNNER_NAME"))


def test_the_288_mark_keeps_its_condition_failure_and_timing():
    mark = KF.namespace_misses_same_tick_link.mark
    assert mark.name == "xfail"
    assert mark.args == (KF.ON_FULL_RUN_RUNNER,)
    assert mark.kwargs["strict"] is False
    assert "omega-flagship/omegahive#288" in mark.kwargs["reason"]
    raises = mark.kwargs["raises"]
    assert isinstance(raises, pytest.RaisesExc)
    assert raises.matches(pytest.fail.Exception("DID NOT RAISE HiveError"))
    assert not raises.matches(pytest.fail.Exception("some other failure"))


def test_a_new_mark_is_strict_by_default():
    mark = KF.fails_on_full_run_runners(1, "why", ValueError).mark
    assert mark.args == (KF.ON_FULL_RUN_RUNNER,) and mark.kwargs["strict"] is True
    assert mark.kwargs["raises"] is ValueError
