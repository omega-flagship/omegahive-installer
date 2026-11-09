"""Real Database/Reservations/Budgets accounting component; all inputs are owned synthetic rows.

No Hive/create_app/PeTTa/provider/native mind or real person authority is constructed.
Two original mind-table DDL strings are schema data, not copied financial logic.
All production pending/reserve/snapshot/period logic comes from whole Source modules.
"""
import datetime as real_datetime
import importlib.util
import pathlib
from types import SimpleNamespace

import pytest
from hive.core.db import Database
from hive.core.budgets import Budgets
from hive.core import budgets as budget_source

SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'hive/core/cost_reservations.py'
_spec = importlib.util.spec_from_file_location('hive.core._controller_budget_accounting_candidate', SOURCE)
cost = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cost)

CONTROLLER = 'a_' + '1' * 32
CHILD = 'a_' + '2' * 32
SECOND = 'a_' + '3' * 32
FOREIGN = 'a_' + '4' * 32
TEAM = 's_' + '5' * 32
NOW = real_datetime.datetime(2026, 11, 6, 12, tzinfo=real_datetime.timezone.utc)
STAMP = '2026-11-06T12:00:00.000Z'
MIND_TABLES = ('CREATE TABLE IF NOT EXISTS mind_children (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, controller_id TEXT NOT NULL,\n  team_id TEXT NOT NULL, request_id TEXT NOT NULL, lease_id TEXT NOT NULL, template_id TEXT NOT NULL, model_id TEXT NOT NULL,\n  lifecycle_mode TEXT NOT NULL, lifecycle_limits TEXT, state TEXT NOT NULL, paused_reason TEXT,\n  recovery_needed INTEGER NOT NULL DEFAULT 0, prompt_rev INTEGER NOT NULL, stop_requested_at REAL, stopped_at TEXT,\n  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)', 'CREATE TABLE IF NOT EXISTS mind_reservations (id TEXT PRIMARY KEY, child_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL,\n  budget_root TEXT NOT NULL, allocated_usd REAL NOT NULL, released_usd REAL, released_at TEXT, created_at TEXT NOT NULL)')


class NoKeys:
    """No key/payer input exists in this component; this supplies no authority."""
    def rules(self, key, payer):
        assert key is None and payer is None
        return []

    def subjects(self, key, payer):
        assert key is None and payer is None
        return []


def _agent(db, aid, budget=1, spent=0):
    db.insert('agents', {'id': aid, 'name': 'synthetic', 'kind': 'omega', 'swarm_id': TEAM,
        'model': 'synthetic/no-provider', 'hue': 0, 'status': 'stopped', 'driver': 'synthetic',
        'budget_usd': budget, 'spent_usd': spent, 'token_hash': 'not-a-bearer', 'created_at': STAMP})


@pytest.fixture
def books(tmp_path):
    db = Database(tmp_path / 'accounting.sqlite3')
    try:
        # Original Budgets.derive queries these empty lifecycle schema seams.
        db.execute('ALTER TABLE swarms ADD COLUMN archived_at TEXT')
        db.execute('CREATE TABLE IF NOT EXISTS session_caps (agent_id TEXT PRIMARY KEY, base_limit REAL, installed REAL, updated_at TEXT NOT NULL)')
        for ddl in MIND_TABLES:
            db.execute(ddl)
        db.insert('swarms', {'id': TEAM, 'name': 'synthetic', 'hue': 0, 'created_at': STAMP})
        _agent(db, CONTROLLER)
        _agent(db, FOREIGN)
        hive = SimpleNamespace(db=db, ownhive=NoKeys(),
            settings=SimpleNamespace(hive_budget_usd=0, swarm_monthly_usd=0))
        def row(aid):
            found = db.one('SELECT * FROM agents WHERE id=?', (aid,))
            assert found is not None
            return found
        hive._agent_row = row
        hive.budgets = Budgets(hive)
        yield SimpleNamespace(db=db, hive=hive, reservations=cost.Reservations(db))
    finally:
        with db._lock:
            db._conn.close()


@pytest.fixture
def period_clock(monkeypatch):
    class Clock:
        @staticmethod
        def now(tz=None):
            return NOW if tz is not None else NOW.replace(tzinfo=None)
    # Only this original module's clock binding changes; period_start itself is real.
    monkeypatch.setattr(budget_source, 'datetime', SimpleNamespace(
        datetime=Clock, timezone=real_datetime.timezone))
    assert budget_source.period_start('day') == '2026-11-06T00:00:00.000Z'
    assert budget_source.period_start('month') == '2026-11-01T00:00:00.000Z'


def _child(books, aid=CHILD, allocation=.5, released=False, controller=CONTROLLER, request='rq_one'):
    _agent(books.db, aid, allocation)
    seq = books.db.one('SELECT COALESCE(MAX(seq),0)+1 AS n FROM mind_children')['n']
    books.db.insert('mind_children', {'id': aid, 'seq': seq, 'controller_id': controller,
        'team_id': TEAM, 'request_id': request, 'lease_id': 'lease_' + str(seq),
        'template_id': 'synthetic', 'model_id': 'synthetic/no-provider', 'lifecycle_mode': 'deliver',
        'state': 'retired' if released else 'stopped', 'prompt_rev': 1,
        'created_at': STAMP, 'updated_at': STAMP})
    books.db.insert('mind_reservations', {'id': 'res_' + str(seq), 'child_id': aid,
        'request_id': request, 'budget_root': request, 'allocated_usd': allocation,
        'released_usd': 0 if released else None, 'released_at': STAMP if released else None,
        'created_at': STAMP})
    return aid


def _usage(books, aid, usd, at=STAMP):
    # Synthetic recorded facts, using the original usage + stored-spend books.
    books.db.insert('usage', {'agent_id': aid, 'model': 'synthetic/no-provider',
        'prompt_tokens': 0, 'completion_tokens': 0, 'cost_usd': usd, 'created_at': at})
    books.db.execute('UPDATE agents SET spent_usd=spent_usd+? WHERE id=?', (usd, aid))


def _hold(books, aid, usd=.2, state='unknown', metadata=None, key='child_call'):
    result = books.reservations.reserve(key, {'fixture': key}, usd,
        lambda: cost.host_budget_snapshot(books.hive, aid),
        metadata={'agent': aid} if metadata is None else metadata,
        subjects=cost.host_subjects(books.hive, aid))
    if state in ('dispatched', 'unknown'):
        books.reservations.dispatch(key)
    if state == 'unknown':
        books.reservations.unknown(key)
    return result


def _pending(books, period='total'):
    with books.db.transaction():
        return cost.pending_micros(books.db, 'agent:' + CONTROLLER + ':' + period)


@pytest.mark.parametrize('state', ['reserved', 'dispatched', 'unknown'])
@pytest.mark.parametrize('released,expected', [(False, 500000), (True, 300000)])
@pytest.mark.parametrize('overlap', ['child_only', 'controller_scope', 'wildcard', 'no_subjects'])
def test_child_hold_is_counted_once_with_all_original_overlap_forms(books,state,released,expected,overlap):
    _child(books, released=released)
    _hold(books, CHILD, state=state)
    _usage(books, CHILD, .1)
    if overlap == 'controller_scope':
        books.db.insert('cost_reservation_scopes', {'reservation': 'child_call', 'scope': 'agent:' + CONTROLLER + ':total'})
    elif overlap == 'wildcard':
        books.db.insert('cost_reservation_subjects', {'reservation': 'child_call', 'subject': '*'})
    elif overlap == 'no_subjects':
        books.db.execute('DELETE FROM cost_reservation_subjects WHERE reservation=?', ('child_call',))
    assert _pending(books) == expected
    assert books.reservations.pending('agent:' + CONTROLLER + ':total') == expected
    # Shared rows retain the original one call, rather than counting allocation or spend again.
    assert books.reservations.pending('hive:month') == 200000
    assert books.reservations.pending('swarm:' + TEAM + ':month') == 200000


@pytest.mark.parametrize('released,expected', [(False, 500000), (True, 300000)])
@pytest.mark.parametrize('attribution', ['child_subject', 'child_scope_only'])
@pytest.mark.parametrize('controller_overlap', [False, True])
def test_missing_agent_metadata_does_not_lose_recorded_child_liability(books,released,expected,attribution,controller_overlap):
    _child(books, released=released)
    # This is an allowed original Reservations API shape, not a fabricated pending result.
    _hold(books, CHILD, metadata={})
    _usage(books, CHILD, .1)
    if attribution == 'child_scope_only':
        books.db.execute('DELETE FROM cost_reservation_subjects WHERE reservation=? AND subject<>?', ('child_call', 'hive'))
    if controller_overlap:
        books.db.insert('cost_reservation_scopes', {'reservation': 'child_call', 'scope': 'agent:' + CONTROLLER + ':total'})
    assert _pending(books) == expected


@pytest.mark.parametrize('released', [False, True])
@pytest.mark.parametrize('held', [0, .125, .25])
@pytest.mark.parametrize('period', ['day', 'month', 'total'])
def test_actual_utc_period_spend_and_unresolved_holds_are_preserved(books,period_clock,released,held,period):
    _child(books, released=released)
    if held:
        _hold(books, CHILD, held)
    # A late charge may leave commitments beyond allocation; no liability is forgiven.
    _usage(books, CHILD, .125, '2026-10-31T23:59:59.000Z')
    _usage(books, CHILD, .0625, '2026-11-05T23:59:59.000Z')
    _usage(books, CHILD, .125, '2026-11-06T00:00:01.000Z')
    # Binary-exact fixture amounts isolate window semantics from SQL float-sum rounding.
    expected = {
        (False, 0, 'day'):312500, (False, 0, 'month'):375000, (False, 0, 'total'):500000,
        (False, .125, 'day'):312500, (False, .125, 'month'):375000, (False, .125, 'total'):500000,
        (False, .25, 'day'):375000, (False, .25, 'month'):437500, (False, .25, 'total'):562500,
        (True, 0, 'day'):125000, (True, 0, 'month'):187500, (True, 0, 'total'):312500,
        (True, .125, 'day'):250000, (True, .125, 'month'):312500, (True, .125, 'total'):437500,
        (True, .25, 'day'):375000, (True, .25, 'month'):437500, (True, .25, 'total'):562500,
    }[released, held, period]
    assert _pending(books, period) == expected


@pytest.mark.parametrize('released,expected', [(False,400000),(True,150000)])
def test_stored_spend_without_a_usage_window_is_conservative(books,period_clock,released,expected):
    _child(books, released=released)
    _usage(books, CHILD, .10, '2026-10-31T23:59:59.000Z')
    _usage(books, CHILD, .10, '2026-11-06T00:00:01.000Z')
    books.db.execute('UPDATE agents SET spent_usd=? WHERE id=?', (.25, CHILD))
    assert _pending(books, 'day') == expected


def test_controller_reserve_after_two_request_allocations_uses_actual_budget_snapshot(books):
    _child(books, allocation=.25, request='rq_first')
    _child(books, SECOND, allocation=.25, request='rq_second')
    # Own cap is read from the actual stored row by original host_budget_snapshot.
    books.db.execute('UPDATE agents SET budget_usd=? WHERE id=?', (.5, CONTROLLER))
    with pytest.raises(cost.BudgetExhausted):
        _hold(books, CONTROLLER, .000001, state='reserved', key='controller_call')
    assert books.reservations.get('controller_call') is None
    assert _pending(books) == 500000


def test_controller_own_hold_and_foreign_controller_are_not_merged_or_double_counted(books):
    _child(books, allocation=.4)
    _child(books, SECOND, allocation=.3, controller=FOREIGN)
    _hold(books, CONTROLLER, .1, key='own_call')
    assert _pending(books) == 500000
    assert books.reservations.pending('agent:' + FOREIGN + ':total') == 300000
    assert books.reservations.pending('hive:total') == 100000


@pytest.mark.parametrize('action,expected', [('release',100000),('settle',250000)])
def test_retired_child_resolution_keeps_actual_charge_and_releases_only_known_free_hold(books,action,expected):
    _child(books, released=True)
    _hold(books, CHILD)
    _usage(books, CHILD, .1)
    assert _pending(books) == 300000
    cost.resolve(books.reservations, 'child_call', action, 'synthetic observed resolution', 'fixture',
        actual=.15 if action=='settle' else None,
        record_usage=(lambda usd:_usage(books, CHILD, usd)) if action=='settle' else None)
    assert _pending(books) == expected
    assert books.reservations.pending('hive:total') == 0


def test_partial_delegation_books_fail_closed_instead_of_ignoring_child(books):
    _child(books)
    books.db.execute('DELETE FROM mind_reservations WHERE child_id=?', (CHILD,))
    with pytest.raises(ValueError, match='Incomplete delegated'):
        _pending(books)
