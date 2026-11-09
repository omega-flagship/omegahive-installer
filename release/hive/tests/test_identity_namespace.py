"""Prospective namespace and commit-failure regressions on synthetic hives; no process/provider call."""
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from hive.core.db import Database
from hive.core.hive import HiveError
from hive.supervisor.workspace import Workspace
from hive.tests.test_placement import client, home, mind_in_swarm, _rebundle  # noqa: F401
from hive.tests.test_mind_control import w, person, enabled, accepted, spawn  # noqa: F401


def historical(hive, original, target):
    row = dict(hive.db.one("SELECT * FROM agents WHERE id = ?", (original,)))
    row.update(id=target, personal_of=None)
    hive.db.insert("agents", row)
    return row


def force_candidates(monkeypatch, values):
    import hive.core.hive as source
    original = source.new_id
    iterator = iter(values)
    monkeypatch.setattr(source, "new_id", lambda prefix: next(iterator) if prefix == "a" else original(prefix))


@pytest.mark.parametrize("width", [8, 32])
@pytest.mark.parametrize("placed", [False, True])
def test_generated_collision_retries_without_touching_the_historical_workspace(client, monkeypatch, width, placed):
    swarm, mind = mind_in_swarm(client)
    hive = client.app.state.hive
    alias, target, free = 'a_' + 'A' * width, 'a_' + 'a' * width, 'a_' + 'b' * width
    historical(hive, mind['id'], alias)
    root = hive.settings.agents_dir / alias; root.mkdir(parents=True)
    (root / 'token').write_text('invented historical token')
    force_candidates(monkeypatch, [target, free])
    response = client.post('/api/agents', json={'name': 'Invented new mind', **({'swarm_id': swarm['id']} if placed else {})})
    assert response.status_code == 200, response.text
    assert response.json()['id'] == free
    assert hive.db.one('SELECT id FROM agents WHERE id=?', (target,)) is None
    assert (root / 'token').read_text() == 'invented historical token'


def test_generated_id_never_claims_an_unrecorded_existing_workspace(client, monkeypatch):
    hive = client.app.state.hive
    root = hive.settings.agents_dir / 'a_aaaaaaaa'; root.mkdir(parents=True)
    (root / 'token').write_text('invented orphan token')
    force_candidates(monkeypatch, ['a_aaaaaaaa', 'a_bbbbbbbb'])
    response = client.post('/api/agents', json={'name': 'Invented new mind'})
    assert response.status_code == 200 and response.json()['id'] == 'a_bbbbbbbb'
    assert (root / 'token').read_text() == 'invented orphan token'


def test_generated_collision_refuses_after_a_bounded_number_of_attempts(client, monkeypatch):
    _, mind = mind_in_swarm(client); hive = client.app.state.hive
    historical(hive, mind['id'], 'a_AAAAAAAA')
    before = hive.db.one('SELECT COUNT(*) AS n FROM agents')['n']
    force_candidates(monkeypatch, ['a_aaaaaaaa'] * 16)
    response = client.post('/api/agents', json={'name': 'Invented new mind'})
    assert response.status_code == 409 and response.json()['error']['code'] == 'workspace_identity_conflict'
    assert hive.db.one('SELECT COUNT(*) AS n FROM agents')['n'] == before


def late_alias(hive, monkeypatch):
    original = hive.new_agent_row
    captured = {}
    def row_then_alias(*args, **kwargs):
        row, token, role = original(*args, **kwargs)
        alias = {**row, 'id': 'a_' + row['id'][2:].upper(), 'personal_of': None}
        hive.db.insert('agents', alias)  # invented historical row appearing after allocation, before the insert guard
        captured.update(row)
        return row, token, role
    force_candidates(monkeypatch, ['a_deadbeef'])
    monkeypatch.setattr(hive, 'new_agent_row', row_then_alias)
    return captured


def test_ordinary_insertion_rechecks_an_alias_that_appears_after_allocation(client, monkeypatch):
    hive = client.app.state.hive
    captured = late_alias(hive, monkeypatch)
    response = client.post('/api/agents', json={'name': 'Invented new mind'})
    assert response.status_code == 409 and response.json()['error']['code'] == 'workspace_identity_conflict'
    assert hive.db.one('SELECT id FROM agents WHERE id=?', (captured['id'],)) is None


def test_personal_creation_rechecks_an_alias_after_allocation(w, monkeypatch):
    hive = w.hive
    person(hive, 'u_namespace_member', role='member')
    captured = late_alias(hive, monkeypatch)
    with pytest.raises(HiveError, match='workspace namespace'):
        hive.personal.ensure('user:u_namespace_member')
    assert hive.db.one('SELECT id FROM agents WHERE id=?', (captured['id'],)) is None


def test_child_creation_rechecks_an_alias_before_its_atomic_reservation(w, monkeypatch):
    enabled(w); request = accepted(w)
    before = w.hive.db.one('SELECT COUNT(*) AS n FROM mind_children')['n']
    captured = late_alias(w.hive, monkeypatch)
    response = spawn(w, request['request_id'])
    assert response.status_code == 409 and response.json()['error']['code'] == 'workspace_identity_conflict'
    assert w.hive.db.one('SELECT id FROM agents WHERE id=?', (captured['id'],)) is None
    assert w.hive.db.one('SELECT COUNT(*) AS n FROM mind_children')['n'] == before
    assert w.hive.collab.get_request(request['request_id'])['allocated_usd'] == 0


@pytest.mark.parametrize('method', ['omega', 'module', 'iter', 'direct-iter', 'skills', 'prompt', 'note', 'tools'])
def test_workspace_writer_refuses_the_shared_namespace_before_any_write(client, method):
    _, mind = mind_in_swarm(client); hive = client.app.state.hive
    historical(hive, mind['id'], 'a_AAAAAAAA')
    root = hive.settings.agents_dir / 'a_AAAAAAAA'; root.mkdir(parents=True)
    (root / 'token').write_text('invented historical token')
    (root / 'run.metta').write_text('!(omegaclaw)\n')
    ws = Workspace(hive.settings, hive.programs)
    agent = {**hive.agent(mind['id']), 'id': 'a_aaaaaaaa', 'kind': method if method in ('omega', 'module', 'iter') else 'omega'}
    before = {p.name: p.read_bytes() for p in root.iterdir()}
    with pytest.raises(HiveError, match='workspace namespace'):
        if method in ('omega', 'module', 'iter'): ws.create(agent, 'must never replace the old token')
        elif method == 'direct-iter': ws.create_iter(agent, 'must never replace the old token')
        elif method == 'skills': ws.write_studio_skills(agent, True)
        elif method == 'prompt': ws.write_prompt(agent)
        elif method == 'note': ws.write_iter_note(agent)
        else: ws.write_tools(agent)
    assert {p.name: p.read_bytes() for p in root.iterdir()} == before


def test_conversion_refuses_an_alias_before_changing_kind_or_token(client):
    _, mind = mind_in_swarm(client); hive = client.app.state.hive
    target = historical(hive, mind['id'], 'a_aaaaaaaa')
    hive.db.execute("UPDATE agents SET kind='module' WHERE id=?", (target['id'],))
    historical(hive, mind['id'], 'a_AAAAAAAA')
    before = hive.db.one('SELECT * FROM agents WHERE id=?', (target['id'],))
    with pytest.raises(HiveError, match='workspace namespace'):
        hive.convert_to_native(target['id'])
    assert hive.db.one('SELECT * FROM agents WHERE id=?', (target['id'],)) == before


@pytest.mark.parametrize('invalid', [None, b'invented-binary-id'])
def test_non_string_recorded_ids_fail_closed_instead_of_disappearing_from_the_scan(client, invalid):
    _, mind = mind_in_swarm(client); hive = client.app.state.hive
    historical(hive, mind['id'], invalid)
    with pytest.raises(HiveError) as error:
        hive.placement._check_workspace_namespace(mind['id'], hive.settings.agents_dir / mind['id'])
    assert error.value.code == 'workspace_identity_invalid'


class CommitFailure:
    def __init__(self, connection): self.inner, self.fail = connection, True
    def __getattr__(self, key): return getattr(self.inner, key)
    def commit(self):
        if self.fail:
            self.fail = False
            raise sqlite3.OperationalError('invented commit failure')
        return self.inner.commit()


def test_commit_failure_rolls_back_and_drops_outer_and_nested_callbacks(tmp_path):
    db = Database(tmp_path / 'invented.db'); db._conn = CommitFailure(db._conn)
    db.execute('CREATE TABLE invented (id INTEGER)'); fired = []
    with pytest.raises(sqlite3.OperationalError, match='invented commit failure'):
        with db.transaction():
            db.execute('INSERT INTO invented VALUES (1)')
            db.after_commit(lambda: fired.append('must not escape'))
            with db.transaction(): db.after_commit(lambda: fired.append('nested must not escape'))
    assert db._conn.in_transaction is False
    assert db.one('SELECT COUNT(*) AS n FROM invented')['n'] == 0
    assert db._after_commit == [] and fired == []
    with db.transaction():
        db.execute('INSERT INTO invented VALUES (2)')
        db.after_commit(lambda: fired.append('later committed callback'))
    assert fired == ['later committed callback']


@pytest.mark.parametrize('proof', ['none', 'wrong-hash', 'wrong-id', 'matching'])
def test_legacy_return_needs_outbound_proof_for_this_exact_incoming_manifest(client, home, proof):
    _, mind = mind_in_swarm(client); source = client.app.state.hive
    bundle = client.post(f"/api/agents/{mind['id']}/export").content
    swarm = home.post('/api/swarms', json={'name': 'Invented destination'}).json()
    hive = home.app.state.hive; target = 'a_legacyproof'
    row = dict(source.db.one('SELECT * FROM agents WHERE id=?', (mind['id'],)))
    row.update(id=target, swarm_id=swarm['id'], moved_to='historical-other-hive', deleted=1)
    hive.db.insert('agents', row)
    changed = _rebundle(bundle, lambda manifest: manifest['mind'].update(id=target))
    manifest, _ = hive.placement.read_bundle(changed)
    digest = hashlib.sha256(json.dumps(manifest, indent=1).encode()).hexdigest()
    if proof != 'none':
        out = dict(source.db.one("SELECT * FROM mind_moves WHERE agent_id=? AND direction='out'", (mind['id'],)))
        out.update(id='mv_inventedproof', agent_id=target if proof != 'wrong-id' else 'a_otherlegacy',
                   manifest_sha256=digest if proof != 'wrong-hash' else 'f' * 64)
        hive.db.insert('mind_moves', out)
    before = hive.db.one('SELECT * FROM agents WHERE id=?', (target,))
    response = home.post(f"/api/agents/import?swarm_id={swarm['id']}", content=changed)
    assert response.status_code == (200 if proof == 'matching' else 400), response.text
    if proof != 'matching':
        assert hive.db.one('SELECT * FROM agents WHERE id=?', (target,)) == before
        assert not (hive.settings.agents_dir / target).exists()


def test_placement_commit_failure_restores_database_workspace_and_cancels_notices(client, home, monkeypatch):
    _, mind = mind_in_swarm(client)
    bundle = client.post(f"/api/agents/{mind['id']}/export").content
    swarm = home.post('/api/swarms', json={'name': 'Invented return home'}).json()
    hive = home.app.state.hive
    assert home.post(f"/api/agents/import?swarm_id={swarm['id']}", content=bundle).status_code == 200
    hive.db.execute("UPDATE agents SET deleted=1, status='deleted' WHERE id=?", (mind['id'],))
    root = hive.settings.agents_dir / mind['id']
    (root / 'invented-owner-sentinel').write_text('preserve this original workspace')
    before_row = hive.db.one('SELECT * FROM agents WHERE id=?', (mind['id'],))
    before_files = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    notices = []
    prepare = hive.supervisor.prepare
    def prepare_then_queue(agent, token):
        prepare(agent, token)
        hive.db.after_commit(lambda: notices.append('must not escape failed import'))
    monkeypatch.setattr(hive.supervisor, 'prepare', prepare_then_queue)
    hive.db._conn = CommitFailure(hive.db._conn)
    with pytest.raises(sqlite3.OperationalError, match='invented commit failure'):
        hive.placement.import_(bundle, swarm_id=swarm['id'])
    assert hive.db._conn.in_transaction is False and hive.db._after_commit == []
    assert hive.db.one('SELECT * FROM agents WHERE id=?', (mind['id'],)) == before_row
    assert {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()} == before_files
    assert not list(root.parent.glob('.' + mind['id'] + '.before-*'))
    assert not list(root.parent.glob('.' + mind['id'] + '.staged-*'))
    with hive.db.transaction(): hive.db.after_commit(lambda: notices.append('later durable callback'))
    assert notices == ['later durable callback']


def test_exact_collision_at_insert_refuses_without_exposing_a_sqlite_error(client, monkeypatch):
    hive = client.app.state.hive; original = hive.new_agent_row; captured = {}
    def row_then_collision(*args, **kwargs):
        row, token, role = original(*args, **kwargs)
        hive.db.insert('agents', row)
        captured.update(hive.db.one('SELECT * FROM agents WHERE id=?', (row['id'],)))
        return row, token, role
    force_candidates(monkeypatch, ['a_deadbeef'])
    monkeypatch.setattr(hive, 'new_agent_row', row_then_collision)
    response = client.post('/api/agents', json={'name': 'Invented collision'})
    assert response.status_code == 409 and response.json()['error']['code'] == 'workspace_identity_conflict'
    assert hive.db.one('SELECT * FROM agents WHERE id=?', (captured['id'],)) == captured


@pytest.mark.parametrize('kind', ['omega', 'iter', 'module'])
def test_actual_supervisor_wake_refuses_namespace_before_reading_any_token(client, monkeypatch, kind):
    import types
    import hive.supervisor.workspace as source
    from hive.supervisor.drivers import Supervisor
    _, mind = mind_in_swarm(client); hive = client.app.state.hive
    historical(hive, mind['id'], 'a_aaaaaaaa')
    historical(hive, mind['id'], 'a_AAAAAAAA')
    hive.db.execute('UPDATE agents SET kind=? WHERE id=?', (kind, 'a_aaaaaaaa'))
    root = hive.settings.agents_dir / 'a_aaaaaaaa'; root.mkdir(parents=True, exist_ok=True)
    (root / 'token').write_text('invented ambiguous workspace token')
    reads, starts = [], []
    original = source.current_token
    def read(path):
        reads.append(path)
        return original(path)
    monkeypatch.setattr(source, 'current_token', read)
    driver = types.SimpleNamespace(execution=lambda _: None, start=lambda *args: starts.append(args))
    supervisor = Supervisor(hive.settings, drivers={'local': driver}); supervisor.attach(hive)
    with pytest.raises(HiveError, match='workspace namespace'):
        supervisor.start('a_aaaaaaaa')
    assert reads == [] and starts == []
