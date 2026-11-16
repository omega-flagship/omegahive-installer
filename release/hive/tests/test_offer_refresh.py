# Purpose: tests of OfferRefresh, which re-derives the Create · Code offer when its inputs change: the catalogue, then the
# foundation's ensure, one run at a time, exactly one more run for any number of changes during a run, at start an
# ensure only when the catalogue brought prices, and at shutdown nothing left running.
import asyncio
import logging

import pytest

from hive.core.offer_refresh import OfferRefresh


def recorder(priced=False):
    calls, gate = [], asyncio.Event()

    async def prices():
        calls.append("prices")
        await gate.wait()           # the run stays open until the test lets it go
        return priced

    async def ensure():
        calls.append("ensure")
    return calls, gate, prices, ensure


def test_steps_run_in_order_and_changes_during_a_run_cause_one_more_run():
    async def scenario():
        calls, gate, prices, ensure = recorder()
        refresh = OfferRefresh(prices, ensure)
        first = refresh.schedule()
        await asyncio.sleep(0)                     # the run has started and waits in prices
        assert refresh.schedule() is first         # a key added during the run joins it...
        assert refresh.schedule() is first         # ...and so does a service change
        gate.set()
        await first
        assert calls == ["prices", "ensure", "prices", "ensure"]   # two changes, one extra run
        second = refresh.schedule()                # after the run ended, a change starts a new one
        assert second is not first
        await second
        assert calls[-2:] == ["prices", "ensure"] and len(calls) == 6
    asyncio.run(scenario())


def test_a_lone_change_runs_once():
    async def scenario():
        calls, gate, prices, ensure = recorder()
        gate.set()
        refresh = OfferRefresh(prices, ensure)
        await refresh.schedule()
        assert calls == ["prices", "ensure"]
    asyncio.run(scenario())


@pytest.mark.parametrize("priced, expected", [(False, ["prices"]), (True, ["prices", "ensure"])])
def test_the_start_up_run_ensures_again_only_when_the_catalogue_brought_prices(priced, expected):
    """create_app has just run the foundation's ensure: with no key, offline or a failed fetch, the start-up run must not
    run that setup a second time; a catalogue that brought prices is a change the offer has not seen."""
    async def scenario():
        calls, gate, prices, ensure = recorder(priced)
        gate.set()
        await OfferRefresh(prices, ensure).schedule(changed=False)
        assert calls == expected
    asyncio.run(scenario())


def test_a_change_during_the_start_up_run_still_ensures():
    async def scenario():
        calls, gate, prices, ensure = recorder()
        refresh = OfferRefresh(prices, ensure)
        start = refresh.schedule(changed=False)
        await asyncio.sleep(0)
        assert refresh.schedule() is start         # a key added while the boot catalogue is fetched
        gate.set()
        await start
        assert calls == ["prices", "prices", "ensure"]
    asyncio.run(scenario())


def test_the_shutdown_cancels_a_catalogue_fetch_and_starts_nothing_after_it():
    async def scenario():
        calls, gate, prices, ensure = recorder()
        refresh = OfferRefresh(prices, ensure)
        run = refresh.schedule()
        await asyncio.sleep(0)                     # the run waits in the catalogue fetch
        await refresh.aclose()
        assert run.cancelled() and calls == ["prices"]   # no ensure follows the cancelled fetch
        assert refresh.schedule() is None          # a key change after the shutdown began starts nothing
        await asyncio.sleep(0)
        assert calls == ["prices"]
    asyncio.run(scenario())


def ensure_held_open(fail=False):
    """A refresh whose ensure stands for one still running on a worker thread until the test releases it."""
    calls, entered, release = [], asyncio.Event(), asyncio.Event()

    async def prices():
        calls.append("prices")
        return False

    async def ensure():
        calls.append("ensure")
        entered.set()
        await release.wait()
        if fail:
            raise RuntimeError("the foundation's ensure broke")
        calls.append("ensured")
    return calls, entered, release, OfferRefresh(prices, ensure)


def test_the_shutdown_waits_for_an_ensure_in_progress_and_runs_no_more():
    """Cancelling the task would not stop the worker thread, so the shutdown waits for that ensure; a change it did not
    see starts no run after it."""
    async def scenario():
        calls, entered, release, refresh = ensure_held_open()
        run = refresh.schedule()
        await entered.wait()
        assert refresh.schedule() is run           # a key added during the ensure would make the run go again...
        closing = asyncio.create_task(refresh.aclose())
        await asyncio.sleep(0)
        assert not closing.done() and not run.done()   # ...but the shutdown waits for this ensure to finish
        release.set()
        await closing
        assert run.done() and not run.cancelled()
        assert calls == ["prices", "ensure", "ensured"]   # and no second run follows it
    asyncio.run(scenario())


def test_the_shutdown_stops_waiting_for_an_ensure_after_its_grace_and_says_so(caplog):
    async def scenario():
        calls, entered, release, refresh = ensure_held_open()
        run = refresh.schedule()
        await entered.wait()
        refresh.schedule()                         # a change the ensure did not see
        await refresh.aclose(grace=0.01)           # returns although the ensure is still running
        assert not run.done()
        release.set()
        await run
        assert calls == ["prices", "ensure", "ensured"]   # still no second run after the shutdown began
    with caplog.at_level(logging.WARNING, logger="hive"):
        asyncio.run(scenario())
    assert "offer refresh: its ensure was still running 0.01 s into the shutdown, which goes on without it" in caplog.text


def test_a_run_that_fails_at_shutdown_is_logged_and_the_shutdown_goes_on(caplog):
    async def scenario():
        calls, entered, release, refresh = ensure_held_open(fail=True)
        refresh.schedule()
        await entered.wait()
        closing = asyncio.create_task(refresh.aclose())
        await asyncio.sleep(0)
        release.set()
        await closing                              # returns: the rest of the shutdown still runs
    with caplog.at_level(logging.WARNING, logger="hive"):
        asyncio.run(scenario())
    assert "offer refresh: the run in progress at shutdown failed (RuntimeError)" in caplog.text
