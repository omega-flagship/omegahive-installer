"""Synthetic namespace caching, credential and transaction regression checks. No provider/process/network."""
import contextlib
import json
import sqlite3
import statistics
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from hive.core.db import Database
from hive.core.flows import Flows
from hive.core.hive import HiveError
from hive.core.placement import Placement
from hive.core import studio_handoff as SH
from hive.tests.test_identity_namespace import CommitFailure, historical
from hive.tests.test_placement import client, mind_in_swarm  # noqa: F401


def row(identity):
    return dict(id=identity, name='Invented namespace mind', kind='omega', model='invented/model', hue=1,
                status='asleep', driver='local', token_hash='invented hash', created_at='2026-11-05T00:00:00Z')


@pytest.fixture
def ns(tmp_path):
    db = Database(tmp_path / 'synthetic.db')
    hive = SimpleNamespace(db=db, settings=SimpleNamespace(data_dir=tmp_path, agents_dir=tmp_path / 'agents'),
                           name='Synthetic', error=HiveError)
    hive.placement = Placement(hive)
    hive.supervisor = SimpleNamespace(workspace=SimpleNamespace(path=lambda identity: hive.settings.agents_dir / identity))
    db.insert('agents', row('a_aaaaaaaa'))
    yield hive
    db._conn.close()


def check(hive, identity='a_aaaaaaaa'):
    with hive.placement._workspace_guard(identity):
        pass


@pytest.mark.parametrize('write', ['insert', 'raw', 'executemany', 'rename'])
def test_warm_cache_cannot_hide_identity_writes(ns, write):
    check(ns)
    if write == 'insert': ns.db.insert('agents', row('a_AAAAAAAA'))
    else:
        ns.db.insert('agents', row('a_bbbbbbbb'))
        if write == 'raw': ns.db._conn.execute('UPDATE agents SET id=? WHERE id=?', ('a_AAAAAAAA', 'a_bbbbbbbb'))
        elif write == 'executemany': ns.db._conn.executemany('UPDATE agents SET id=? WHERE id=?', [('a_AAAAAAAA', 'a_bbbbbbbb')])
        else: ns.db.execute('UPDATE agents SET id=? WHERE id=?', ('a_AAAAAAAA', 'a_bbbbbbbb'))
    with pytest.raises(HiveError, match='workspace namespace'): check(ns)
    ns.db.execute('DELETE FROM agents WHERE id=?', ('a_AAAAAAAA',))
    check(ns)


@pytest.mark.parametrize('nested', [False, True])
def test_cache_discards_uncommitted_identity_views_after_rollback(ns, nested):
    check(ns)
    def fail():
        with ns.db.transaction():
            ns.db.insert('agents', row('a_AAAAAAAA'))
            with pytest.raises(HiveError): check(ns)
            raise RuntimeError('invented rollback')
    with ns.db.transaction() if nested else contextlib.nullcontext():
        with pytest.raises(RuntimeError, match='invented rollback'): fail()
        check(ns)
    check(ns)


def test_failed_commit_invalidates_a_cached_uncommitted_identity(ns):
    ns.db._conn = CommitFailure(ns.db._conn)
    with pytest.raises(sqlite3.OperationalError):
        with ns.db.transaction():
            ns.db.insert('agents', row('a_AAAAAAAA'))
            # Cache this uncommitted view without deliberately rolling a nested guard back.
            ns.placement._namespace_index(ns.settings.agents_dir)
    check(ns)


def test_other_connection_commit_invalidates_the_cache(ns):
    check(ns)
    path = ns.db.one('PRAGMA database_list')['file']
    with sqlite3.connect(path) as external:
        r = row('a_AAAAAAAA')
        external.execute('INSERT INTO agents (' + ','.join(r) + ') VALUES (' + ','.join('?' for _ in r) + ')', tuple(r.values()))
    with pytest.raises(HiveError, match='workspace namespace'): check(ns)


def test_parent_directory_change_invalidates_native_inode_aliases(ns):
    root = ns.settings.agents_dir; root.mkdir()
    (root / 'a_aaaaaaaa').mkdir()
    ns.db.insert('agents', row('a_unusual_legacy'))
    check(ns)
    (root / 'a_unusual_legacy').symlink_to(root / 'a_aaaaaaaa', target_is_directory=True)
    with pytest.raises(HiveError, match='workspace namespace'): check(ns)


@pytest.mark.parametrize('invalid', [None, b'invented-binary-id'])
def test_warm_cache_still_fails_closed_for_non_string_recorded_ids(ns, invalid):
    check(ns); ns.db.insert('agents', row(invalid))
    with pytest.raises(HiveError) as exc: check(ns)
    assert exc.value.code == 'workspace_identity_invalid'


def test_nested_guarded_writes_reuse_the_scan_but_body_write_keeps_the_transaction(ns, monkeypatch):
    root = ns.settings.agents_dir / 'a_aaaaaaaa'; root.mkdir(parents=True)
    calls = []; real = ns.db.all
    def all_(sql, *args):
        if sql == 'SELECT id FROM agents': calls.append(sql)
        return real(sql, *args)
    monkeypatch.setattr(ns.db, 'all', all_)
    original = Path.write_text
    def write(path, *args, **kwargs):
        assert ns.db._conn.in_transaction
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'write_text', write)
    with ns.placement._workspace_guard('a_aaaaaaaa'):
        for _ in range(8): ns.placement.write_body('a_aaaaaaaa')
    assert len(calls) == 1


def test_body_write_refuses_a_warmed_alias_before_creating_files(ns):
    check(ns); ns.db.insert('agents', row('a_AAAAAAAA'))
    with pytest.raises(HiveError): ns.placement.write_body('a_aaaaaaaa')
    assert not ns.settings.agents_dir.exists()


def studio(hive):
    st = SH.StudioHandoffs(); st.hive = hive
    st._epoch = lambda _: 2
    return st


@pytest.mark.parametrize('operation', ['root', 'repair', 'prepare', 'reuse', 'install', 'cleanup', 'match', 'sync'])
def test_studio_files_refuse_a_late_alias_even_after_path_acquisition(ns, operation):
    st = studio(ns); aid = 'a_aaaaaaaa'; root = st._root(aid)
    (root / 'token-e1').write_text('invented credential sentinel')
    before = {p.name: p.read_bytes() for p in root.iterdir()}
    ns.db.insert('agents', row('a_AAAAAAAA')); recorded = []
    with pytest.raises(HiveError, match='workspace namespace'):
        if operation == 'root': st._root(aid)
        elif operation == 'repair': st._repair(aid)
        elif operation == 'prepare': st._prepare_files(aid, 2, None, recorded.append)
        elif operation == 'reuse': st._prepare_files(aid, 2, 'invented digest', recorded.append)
        elif operation == 'install': st._install_files(aid, root, 2, 'invented digest')
        elif operation == 'cleanup': st._cleanup_files(aid, root, 2)
        elif operation == 'match': st._files_match(aid, root, 2)
        else: st._sync_files(aid, root)
    assert not recorded
    assert {p.name: p.read_bytes() for p in root.iterdir()} == before


def test_studio_keeps_namespace_transaction_through_real_file_operations_and_records_hash_first(ns, monkeypatch):
    st = studio(ns); aid = 'a_aaaaaaaa'; operations = []
    # Test the actual path and content syscalls, not an outer orchestration helper. fd sync is deliberately outside.
    for obj, name in [(Path, 'read_text'), (Path, 'unlink'), (SH.os, 'open'), (SH.os, 'write'), (SH.os, 'replace')]:
        original = getattr(obj, name)
        def guarded(*args, _name=name, _original=original, **kwargs):
            assert ns.db._conn.in_transaction, _name
            operations.append(_name)
            return _original(*args, **kwargs)
        monkeypatch.setattr(obj, name, guarded)
    original_sync = SH.os.fsync
    def sync(fd):
        assert not ns.db._conn.in_transaction
        operations.append('fsync')
        return original_sync(fd)
    monkeypatch.setattr(SH.os, 'fsync', sync)
    original_write = SH.write_fsync
    def written(path, text, **kwargs):
        if Path(path).name.startswith('pending-token-e'):
            with sqlite3.connect(ns.db.one('PRAGMA database_list')['file']) as external:
                assert external.execute('SELECT token_hash FROM agents WHERE id=?', (aid,)).fetchone()[0] == digest[0]
        return original_write(path, text, **kwargs)
    monkeypatch.setattr(SH, 'write_fsync', written)
    digest = []
    def record(value):
        digest.append(value); ns.db.execute('UPDATE agents SET token_hash=? WHERE id=?', (value, aid))
    value = st._prepare_files(aid, 2, None, record)
    assert st._prepare_files(aid, 2, value, record) == value and len(digest) == 1
    root = st._root(aid); st._install_files(aid, root, 2, value)
    assert st._files_match(aid, root, 2)
    st._repair(aid); st._cleanup_files(aid, root, 2); st._sync_files(aid, root)
    assert {'read_text', 'open', 'write', 'replace', 'fsync'} <= set(operations)


@pytest.mark.parametrize('ending', ['commit', 'rollback', 'nested-rollback', 'commit-failure'])
def test_flow_transactions_share_database_callback_and_rollback_authority(ns, ending):
    flows = Flows(ns); fired = []
    if ending == 'commit-failure': ns.db._conn = CommitFailure(ns.db._conn)
    def work():
        with flows.transaction():
            ns.db.after_commit(lambda: fired.append('outer'))
            if ending == 'nested-rollback':
                with pytest.raises(RuntimeError):
                    with flows.transaction():
                        ns.db.after_commit(lambda: fired.append('rolled-back nested'))
                        raise RuntimeError('invented nested rollback')
            else:
                with flows.transaction(): ns.db.after_commit(lambda: fired.append('nested'))
            assert not fired
            if ending == 'rollback': raise RuntimeError('invented outer rollback')
    if ending in ('rollback', 'commit-failure'):
        with pytest.raises((RuntimeError, sqlite3.OperationalError)): work()
        assert not fired
    else:
        with ns.db.transaction():
            work(); assert not fired
        assert fired == (['outer'] if ending == 'nested-rollback' else ['outer', 'nested'])
    with flows.transaction(): ns.db.after_commit(lambda: fired.append('later'))
    assert fired[-1] == 'later' and 'rolled-back nested' not in fired


def test_finish_only_refuses_before_prepare_even_when_new_row_and_insert_are_bypassed(client):
    _, mind = mind_in_swarm(client); hive = client.app.state.hive
    historical(hive, mind['id'], 'a_AAAAAAAA')
    target = historical(hive, mind['id'], 'a_aaaaaaaa')
    root = hive.settings.agents_dir / 'a_AAAAAAAA'; root.mkdir(parents=True, exist_ok=True)
    (root / 'token').write_text('invented old credential')
    before = list(hive.supervisor.calls)
    with pytest.raises(HiveError, match='workspace namespace'): hive.finish_agent(target, 'must never be written', None)
    assert hive.supervisor.calls == before
    assert (root / 'token').read_text() == 'invented old credential'


def test_10k_namespace_latency_is_measured_without_warm_full_scans(ns, monkeypatch, capsys):
    template = row('unused'); columns = list(template)
    values = [tuple({**template, 'id': f'a_{i:032x}'}[key] for key in columns) for i in range(9999)]
    ns.db._conn.executemany('INSERT INTO agents (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', values)
    scans = []; real = ns.db.all
    def all_(sql, *args):
        if sql == 'SELECT id FROM agents': scans.append(sql)
        return real(sql, *args)
    monkeypatch.setattr(ns.db, 'all', all_)
    start = time.perf_counter(); check(ns); cold = time.perf_counter() - start
    samples = []
    for _ in range(200):
        start = time.perf_counter(); check(ns); samples.append(time.perf_counter() - start)
    assert len(scans) == 1
    report = {'synthetic_agents': 10000, 'cold_ms': cold * 1000, 'warm_median_ms': statistics.median(samples) * 1000, 'warm_max_ms': max(samples) * 1000, 'warm_runs': len(samples), 'full_scans': len(scans)}
    with capsys.disabled(): print('NAMESPACE_LATENCY ' + json.dumps(report, sort_keys=True))


@pytest.mark.parametrize('boundary', ['record', 'fsync'])
def test_studio_rechecks_between_durable_authorization_and_each_path_write(ns, monkeypatch, boundary):
    st = studio(ns); aid = 'a_aaaaaaaa'; root = st._root(aid)
    (root / 'token').write_text('invented credential sentinel')
    def alias(): ns.db.insert('agents', row('a_AAAAAAAA'))
    def record(value):
        ns.db.execute('UPDATE agents SET token_hash=? WHERE id=?', (value, aid))
        if boundary == 'record': alias()
    def hook(kind, path):
        if boundary == 'fsync' and kind == 'fsync' and Path(path).name.startswith('pending-token-e'):
            assert not ns.db._conn.in_transaction
            alias()
    monkeypatch.setattr(SH, 'HOOK', hook)
    with pytest.raises(HiveError, match='workspace namespace'): st._prepare_files(aid, 2, None, record)
    assert (root / 'token').read_text() == 'invented credential sentinel'
    assert not (root / 'current.tmp').exists()
    assert (root / 'pending-token-e2').exists() == (boundary == 'fsync')
