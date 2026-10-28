"""Read-guard failure/exception must leave no write or transaction behind."""
import pytest
from hive.core.db import Database


def test_guarded_save_commit_and_rollback(tmp_path):
    db=Database(tmp_path/'synthetic.db')
    db.insert('swarms',{'id':'s_guard','name':'before','hue':1,'created_at':'synthetic'})
    sql='UPDATE swarms SET name = ? WHERE id = ?'
    assert db.guarded_execute(sql,('refused','s_guard'),[lambda:False]) is None
    assert db.one('SELECT name FROM swarms WHERE id = ?',('s_guard',))['name']=='before'
    assert not db._conn.in_transaction
    def broken_read():raise RuntimeError('synthetic read failure')
    with pytest.raises(RuntimeError):db.guarded_execute(sql,('exception','s_guard'),[broken_read])
    assert not db._conn.in_transaction
    assert db.guarded_execute(sql,('committed','s_guard'),[lambda:True]).rowcount==1
    assert db.one('SELECT name FROM swarms WHERE id = ?',('s_guard',))['name']=='committed'
    db.execute('BEGIN IMMEDIATE')
    assert db.guarded_execute(sql,('nested','s_guard'),[lambda:True]).rowcount==1
    assert db._conn.in_transaction  # the caller still owns its outer transaction
    db._conn.rollback()
    assert db.one('SELECT name FROM swarms WHERE id = ?',('s_guard',))['name']=='committed'
    db._conn.close()
