"""Warm namespace decisions must never be weaker than a fresh authoritative scan."""
import pytest

from hive.core.hive import HiveError
from hive.tests.test_identity_namespace_r2 import ns, check, row  # noqa: F401


def decision(hive):
    try:
        check(hive)
    except HiveError as exc:
        return exc.code
    return 'allowed'


def test_external_intermediary_symlink_retarget_cannot_hide_behind_a_warm_snapshot(ns):
    root = ns.settings.agents_dir; root.mkdir()
    target = root / 'a_aaaaaaaa'; target.mkdir()
    other = root / 'a_bbbbbbbb'
    ns.db.insert('agents', row(other.name))
    links = root.parent / 'links'; links.mkdir()
    unrelated = root.parent / 'unrelated'; unrelated.mkdir()
    current = links / 'current'; current.symlink_to(unrelated, target_is_directory=True)
    other.symlink_to('../links/current', target_is_directory=True)
    assert decision(ns) == 'allowed'  # build the resolved native namespace snapshot
    parent_before, requested_before = root.stat(), target.stat()
    current.unlink(); current.symlink_to(target, target_is_directory=True)
    assert (root.stat().st_mtime_ns, root.stat().st_ctime_ns) == (parent_before.st_mtime_ns, parent_before.st_ctime_ns)
    assert target.stat().st_ino == requested_before.st_ino
    warm = decision(ns)
    ns.placement._namespace_cache = None
    cold = decision(ns)
    assert warm == cold == 'workspace_identity_conflict'


@pytest.mark.parametrize('rollback', ['ROLLBACK', '-- synthetic leading comment\nROLLBACK'])
def test_raw_rollback_cannot_restore_an_alias_behind_a_warm_snapshot(ns, rollback):
    ns.db.insert('agents', row('a_AAAAAAAA'))
    ns.db.execute('BEGIN IMMEDIATE')
    ns.db.execute('DELETE FROM agents WHERE id=?', ('a_AAAAAAAA',))
    assert decision(ns) == 'allowed'
    ns.db.execute(rollback)
    warm = decision(ns)
    ns.placement._namespace_cache = None
    cold = decision(ns)
    assert warm == cold == 'workspace_identity_conflict'


@pytest.mark.parametrize('level', ['parent', 'ancestor'])
def test_workspace_ancestor_links_never_reuse_a_resolved_inode_snapshot(ns, tmp_path, monkeypatch, caplog, level):
    actual = tmp_path / 'actual'; actual.mkdir()
    link = tmp_path / 'linked'; link.symlink_to(actual, target_is_directory=True)
    ns.settings.agents_dir = link if level == 'parent' else link / 'nested' / 'agents'
    ns.settings.agents_dir.mkdir(parents=True, exist_ok=True)
    (ns.settings.agents_dir / 'a_aaaaaaaa').mkdir()
    scans = []; original = ns.db.all
    def observed(sql, *args):
        if sql == 'SELECT id FROM agents': scans.append(sql)
        return original(sql, *args)
    monkeypatch.setattr(ns.db, 'all', observed)
    assert decision(ns) == 'allowed'
    assert decision(ns) == 'allowed'
    assert len(scans) == 2  # existing ordinary-path test retains one scan for 200 warm checks
    assert ns.placement._namespace_cache is None
    assert sum('linked workspace ancestor' in r.message for r in caplog.records) == 1
    ns.db.insert('agents', row('a_AAAAAAAA'))
    assert decision(ns) == 'workspace_identity_conflict'


@pytest.mark.parametrize('raw', [False, True])
@pytest.mark.parametrize('rollback', ['ROLLBACK', '-- synthetic leading comment\nROLLBACK'])
def test_linked_ancestor_rollback_still_observes_restored_identity_even_through_raw_connection(ns, tmp_path, raw, rollback):
    actual = tmp_path / 'physical'; actual.mkdir()
    link = tmp_path / 'linked'; link.symlink_to(actual, target_is_directory=True)
    ns.settings.agents_dir = link / 'agents'; ns.settings.agents_dir.mkdir()
    ns.db.insert('agents', row('a_AAAAAAAA'))
    ns.db.execute('BEGIN IMMEDIATE')
    ns.db.execute('DELETE FROM agents WHERE id=?', ('a_AAAAAAAA',))
    assert decision(ns) == 'allowed'
    (ns.db._conn.execute if raw else ns.db.execute)(rollback)
    assert decision(ns) == 'workspace_identity_conflict'
