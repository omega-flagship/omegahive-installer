"""Sparse schedules must survive calendar gaps longer than a year."""
import datetime

import pytest

from hive.core.schedule import CronError, next_run


UTC = datetime.timezone.utc


@pytest.mark.parametrize("after,expected", [
    (datetime.datetime(2026, 11, 5, tzinfo=UTC), datetime.datetime(2028, 2, 29, tzinfo=UTC)),
    (datetime.datetime(2096, 2, 29, tzinfo=UTC), datetime.datetime(2104, 2, 29, tzinfo=UTC)),
])
def test_leap_day_after_a_long_gap(after, expected):
    assert next_run("0 0 29 2 *", after) == expected


def test_impossible_calendar_date_still_refuses():
    with pytest.raises(CronError, match="cron never fires"):
        next_run("0 0 31 2 *", datetime.datetime(2026, 11, 5, tzinfo=UTC))


def test_sparse_search_preserves_day_of_week_or_and_local_timezone():
    after = datetime.datetime(2026, 11, 5, tzinfo=UTC)
    assert next_run("0 0 31 2 mon", after) == datetime.datetime(2027, 2, 1, tzinfo=UTC)
    assert next_run("0 0 29 2 *", after, "Pacific/Kiritimati") == datetime.datetime(2028, 2, 28, 10, tzinfo=UTC)


@pytest.mark.parametrize("after,expected", [
    ("2027-03-28T01:00:00+00:00", "2027-03-29T00:30:00+00:00"),  # nonexistent01:30 is skipped
    ("2027-10-31T00:00:00+00:00", "2027-10-31T00:30:00+00:00"),  # first occurrence
    ("2027-10-31T00:45:00+00:00", "2027-10-31T01:30:00+00:00"),  # second occurrence
    ("2027-10-31T01:45:00+00:00", "2027-11-01T01:30:00+00:00"),  # both passed
])
def test_london_gaps_and_both_fold_occurrences(after, expected):
    assert next_run("30 1 * * *", datetime.datetime.fromisoformat(after), "Europe/London") == datetime.datetime.fromisoformat(expected)


def test_fold_candidates_are_chosen_in_utc_order_instead_of_local_minute_order():
    after = datetime.datetime(2027, 10, 31, 0, 10, 30, tzinfo=UTC)
    assert next_run("* 1 * * *", after, "Europe/London") == datetime.datetime(2027, 10, 31, 0, 11, tzinfo=UTC)
