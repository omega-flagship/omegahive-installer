"""File skill membrane fixtures: exact approvals, version binding and encoded content."""
import hashlib
import importlib.util
import json
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('code_file_under_test', ROOT/'modules/code/src/omega_code.py')
oc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oc)

@pytest.fixture
def organ(tmp_path, monkeypatch):
    monkeypatch.setenv('OMEGACLAW_MEMORY_DIR', str(tmp_path))
    class Client:
        files = {'old.metta': '(x "a;b")\n'}
        generation = 1
        calls = []
        approved = set()
        def digest(self, path):
            return hashlib.sha256(self.files[path].encode()).hexdigest() if path in self.files else None
        def call(self, action, task, repo, payload):
            self.calls.append((action, json.loads(json.dumps(payload))))
            if action == 'read':
                path = payload['path']
                return {'ok': True, 'result': {'path': path, 'digest': self.digest(path), 'content': self.files[path], 'generation': self.generation, 'tree_digest': f't{self.generation}'}}
            assert action == 'edit'
            if payload.get('approval_id') not in self.approved:
                return {'ok': False, 'result': {'error': 'approval_required', 'details': {'approval_id': 'p_exact', 'skill': 'code-edit'}}}
            if payload['expected_generation'] != self.generation or payload['expected_tree_digest'] != f't{self.generation}':
                return {'ok': False, 'http_status': 409, 'result': {'error': 'stale_workspace'}}
            candidate = dict(self.files)
            for edit in payload['edits']:
                if self.digest(edit['path']) != edit['expected_digest']:
                    return {'ok': False, 'http_status': 409, 'result': {'error': 'stale_file'}}
                if edit['content'] is None:
                    del candidate[edit['path']]
                else:
                    candidate[edit['path']] = edit['content']
            self.files = candidate
            self.generation += 1
            return {'ok': True, 'result': {'workspace': {'id': 'ws_one', 'generation': self.generation, 'tree_digest': f't{self.generation}'}}}
        def close(self): pass
    client = Client()
    monkeypatch.setattr(oc, '_client', lambda: (client, None))
    oc._save({'ws': 'ws_one', 'goal': 'g_one', 'repo': 'synthetic', 'generation': 1, 'tree_digest': 't1', 'files': {}, 'pending': {}})
    return client


def test_create_retries_exact_approved_content_and_does_not_reuse_a_file_read(organ):
    content = '(x "a;b")\n' + oc.SEMI
    command = oc.encode(content).replace('\n', '_newline_')
    assert oc.create('new.metta', command).startswith('CODE-APPROVAL-NEEDED')
    first = organ.calls[-1][1]
    organ.approved.add('p_exact')
    assert oc.create('new.metta', command).startswith('CODE-CREATED')
    last = organ.calls[-1][1]
    assert {k: v for k, v in last.items() if k != 'approval_id'} == first
    assert organ.files['new.metta'] == content
    assert 'new.metta' not in oc._load()['files']
    assert oc._load()['generation'] == 2


def test_move_is_one_bound_two_path_edit_and_preserves_raw_content(organ):
    assert oc.move('old.metta', 'new.metta').startswith('CODE-READ-FIRST')
    oc.read('old.metta')
    assert oc.move('old.metta', 'new.metta').startswith('CODE-APPROVAL-NEEDED')
    original = organ.files['old.metta']; first = organ.calls[-1][1]
    assert len(first['edits']) == 2 and first['edits'][0]['content'] is None and first['edits'][1]['expected_digest'] is None
    organ.approved.add('p_exact')
    assert oc.move('old.metta', 'new.metta').startswith('CODE-MOVED')
    assert organ.files == {'new.metta': original}
    assert oc._load()['files'] == {}
    assert {k: v for k, v in organ.calls[-1][1].items() if k != 'approval_id'} == first


def test_existing_move_destination_and_create_target_are_never_overwritten(organ):
    organ.files['taken.metta'] = '(reserved)'
    original = dict(organ.files)
    oc.read('old.metta')
    assert oc.move('old.metta', 'taken.metta').startswith('CODE-APPROVAL-NEEDED')
    organ.approved.add('p_exact')
    assert oc.move('old.metta', 'taken.metta').startswith('CODE-STALE')
    assert oc.create('taken.metta', '(replace)').startswith('CODE-APPROVAL-NEEDED')
    assert oc.create('taken.metta', '(replace)').startswith('CODE-STALE')
    assert organ.files == original


def test_changed_source_after_approval_refuses_move_and_remove(organ):
    oc.read('old.metta')
    assert oc.move('old.metta', 'new.metta').startswith('CODE-APPROVAL-NEEDED')
    organ.files['old.metta'] += '(human edit)'; organ.generation += 1
    organ.approved.add('p_exact')
    assert oc.move('old.metta', 'new.metta').startswith('CODE-STALE')
    assert 'new.metta' not in organ.files and '(human edit)' in organ.files['old.metta']
    assert oc.remove('old.metta').startswith('CODE-APPROVAL-NEEDED')
    assert oc.remove('old.metta').startswith('CODE-STALE')
    assert 'old.metta' in organ.files


def test_remove_requires_read_and_approval_and_invalid_move_stays_local(organ):
    assert oc.remove('old.metta').startswith('CODE-READ-FIRST')
    assert 'same_path' in oc.move('old.metta', 'old.metta')
    assert organ.calls == []
    oc.read('old.metta')
    assert oc.remove('old.metta').startswith('CODE-APPROVAL-NEEDED')
    organ.approved.add('p_exact')
    assert oc.remove('old.metta').startswith('CODE-REMOVED')
    assert organ.files == {} and oc._load()['files'] == {}
