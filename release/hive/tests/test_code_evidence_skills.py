"""Native skill membrane tests; transport fixtures, no model or live Hive claims."""
import base64
import importlib.util
import json
import pathlib
import tomllib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = ROOT / 'modules/code'
spec = importlib.util.spec_from_file_location('code_evidence_under_test', MODULE / 'src/omega_code.py')
oc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oc)


@pytest.fixture
def membrane(tmp_path, monkeypatch):
    monkeypatch.setenv('OMEGACLAW_MEMORY_DIR', str(tmp_path))
    oc._save({'goal': 'g_one', 'repo': 'synthetic', 'ws': 'ws_one', 'generation': 7,
              'tree_digest': 'tree7', 'run': 'run_latest',
              'files': {'x.metta': {'generation': 6, 'digest': 'file6', 'content': '(x)'}}, 'pending': {}})
    calls = []
    class Client:
        result = {}
        def call(self, action, task, repo, payload):
            calls.append((action, task, repo, payload))
            return self.result
        def close(self):
            pass
    client = Client()
    monkeypatch.setattr(oc, '_client', lambda: (client, None))
    return client, calls


def test_history_retains_exact_cursor_currency_and_observation_without_changing_edit_state(membrane):
    client, calls = membrane
    before = oc._state_path().read_bytes()
    cursor = 'eyJpZCI6InJ1bl9hIn0'
    client.result = {'ok': True, 'result': {'workspace_id': 'ws_one', 'generation': 8, 'tree_digest': 'tree8',
        'next_cursor': cursor, 'items': [{'id': 'run_old', 'generation': 6, 'tree_digest': 'tree6',
                                        'status': 'completed', 'currency': 'stale', 'argv': ['very long command']}]}}
    page = json.loads(oc.runs('-').removeprefix('CODE-HISTORY '))
    assert page['next_cursor'] == cursor and page['generation'] == 8
    assert page['items'][0]['id'] == 'run_old' and page['items'][0]['currency'] == 'stale'
    assert 'argv' not in page['items'][0]
    assert calls[-1] == ('run-history', 'g_one', 'synthetic', {'workspace_id': 'ws_one', 'limit': 5})
    oc.verifications(cursor)
    assert calls[-1][0] == 'verification-history' and calls[-1][3]['cursor'] == cursor
    assert oc._state_path().read_bytes() == before


def test_output_keeps_binary_byte_cursor_and_live_eof_without_selecting_historical_run(membrane):
    client, calls = membrane
    before = oc._state_path().read_bytes()
    raw = b'\xff\x00;\xf0\x9f'
    client.result = {'ok': True, 'result': {'run_id': 'run_old', 'after': 2, 'cursor': 7,
        'data': base64.b64encode(raw).decode(), 'encoding': 'base64', 'content_text': None,
        'eof': True, 'complete': False, 'source': 'live-run-log', 'truncated': False}}
    page = json.loads(oc.output('run_old', '2').removeprefix('CODE-OUTPUT '))
    assert base64.b64decode(page['data']) == raw
    assert page['cursor'] == 7 and page['eof'] and not page['complete']
    assert calls[-1][3] == {'run_id': 'run_old', 'after': 2, 'limit': 1024}
    assert oc._state_path().read_bytes() == before and oc._load()['run'] == 'run_latest'


@pytest.mark.parametrize('offset', ['-1', '1.0', '4194305', '١', '99999999999999999'])
def test_invalid_output_offsets_do_not_request_a_capability(membrane, offset):
    _, calls = membrane
    assert 'bad_output_cursor' in oc.output('run_old', offset)
    assert calls == []


def test_diagnostics_are_bound_to_last_read_and_explicitly_bounded(membrane):
    client, calls = membrane
    before = oc._state_path().read_bytes()
    client.result = {'ok': True, 'result': {'workspace_id': 'ws_one', 'generation': 6, 'source_digest': 'file6',
        'evaluated': False, 'semantic_validation': False,
        'diagnostics': [{'line': i+1, 'column': 1, 'offset_utf16': i, 'code': 'unclosed-open', 'severity': 'warning',
                         'message': 'message'} for i in range(25)]}}
    reply = oc.diagnostics('x.metta')
    assert 'structural only, no evaluation or semantic validation' in reply
    result = json.loads(reply.split('validation ', 1)[1])
    assert result['shown'] == 20 and result['total_returned'] == 25 and result['display_truncated']
    assert result['source_digest'] == 'file6' and not result['evaluated']
    assert calls[-1][3] == {'workspace_id': 'ws_one', 'path': 'x.metta', 'generation': 6}
    assert oc._state_path().read_bytes() == before
    oc.diagnostics('unread.metta')
    assert 'generation' not in calls[-1][3]


def test_refusal_and_stale_diagnostics_propagate_without_approval_or_edits(membrane):
    client, calls = membrane
    before = oc._state_path().read_bytes()
    client.result = {'ok': False, 'phase': 'capability', 'result': {'error': {'code': 'goal_not_held', 'message': 'not yours'}}}
    assert oc.runs('-').startswith('CODE-REFUSED goal_not_held')
    client.result = {'ok': False, 'phase': 'operation', 'http_status': 409,
                     'result': {'error': 'stale_generation', 'message': 'changed'}}
    assert oc.diagnostics('x.metta').startswith('CODE-STALE')
    assert oc._state_path().read_bytes() == before
    assert all(a not in ('edit', 'run', 'verify', 'artifact') for a, *_ in calls)


def test_status_uses_bounded_output_followup_instead_of_full_artifact_download(membrane):
    client, calls = membrane
    client.result = {'ok': True, 'result': {'status': 'completed', 'exit_code': 1, 'output_digest': 'digest'}}
    reply = oc.status()
    assert 'FAILED' in reply and 'code-output run_latest 0' in reply
    assert [a for a, *_ in calls] == ['run-status']


def test_registry_signatures_and_wrappers_are_complete():
    skills = {'code-runs': 'runs', 'code-verifications': 'verifications', 'code-output': 'output', 'code-diagnostics': 'diagnostics'}
    manifest = tomllib.loads((MODULE / 'module.toml').read_text())
    for skill, fn in skills.items():
        assert 'skill:'+skill in manifest['provides']
        for filename in ('entry.metta', 'signatures.metta', 'skills.metta', 'catalog.metta', 'affordance.metta'):
            assert skill in (MODULE / filename).read_text()
        assert callable(getattr(oc, fn))


def test_corrupt_output_artifact_is_not_misreported_as_a_stale_workspace(membrane):
    client, calls = membrane
    client.result = {"ok": False, "phase": "operation", "http_status": 409,
                     "result": {"error": "artifact_corrupt", "message": "artifact digest does not match"}}
    assert oc.output("run_old", "0").startswith("CODE-ERROR artifact_corrupt")
    assert calls[-1][0] == "run-output"
