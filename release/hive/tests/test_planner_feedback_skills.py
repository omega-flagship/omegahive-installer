"""Native feedback skill bridge with disposable synthetic host and token scopes."""
import importlib.util
import json
from pathlib import Path
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_planning_review_context import setup, plan


def bridge(client, monkeypatch, active):
    path = Path(__file__).resolve().parents[2]/'modules/hive/src/hive_commons.py'
    spec = importlib.util.spec_from_file_location('planner_feedback_test', path)
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    def call(method, path, payload=None):
        response = client.request(method, path, headers=active[0]._headers, json=payload)
        if response.status_code >= 400:
            return None, 'HIVE-ERROR ' + str(response.status_code)
        return response.json(), None
    monkeypatch.setattr(module, '_call', call)
    return module


def test_native_feedback_preserves_dissent_and_authority(client, monkeypatch):
    mandate = {'id':'feasibility','version':'1'}
    swarms, (asker, planner, reviewer, foreign), root = setup(client, mandate)
    artifact = planner.create_plan('Invented feedback')
    revision = planner.publish(artifact['id'], plan())
    review = planner.request_review(root['receiving_goal'], swarms[2]['id'], revision, [mandate], [], .2)
    reviewer.claim(review['receiving_goal'])
    finding = reviewer.finding(review['id'], mandate, 'prepare', 'major', [], 'Room unknown; literal ⁏ retained')
    active = [planner];hc = bridge(client, monkeypatch, active)
    shown = hc.findings_read(artifact['id'])
    assert ';' not in shown
    rows = json.loads(hc.decode(shown).split(' ', 1)[1])
    assert rows[0]['recommendation'] == finding['recommendation']
    assert hc.finding_response(finding['id'], hc.encode(json.dumps({'revision':1,'stance':'addressed','note':'Claim; literal ⁏'}))).startswith('HIVE-FINDING-RESPONSE')
    rows = json.loads(hc.decode(hc.findings_read(artifact['id'])).split(' ', 1)[1])
    assert rows[0]['planner_response']['note'] == 'Claim; literal ⁏'
    assert rows[0]['disposition'] is None
    payload = json.dumps({'request_id':review['id'],'revision':1,'verdict':'still-open'})
    assert hc.finding_disposition(finding['id'], payload) == 'HIVE-ERROR 403'
    active[0] = reviewer
    assert hc.finding_response(finding['id'], json.dumps({'revision':1,'stance':'addressed'})) == 'HIVE-ERROR 403'
    assert hc.finding_disposition(finding['id'], payload).startswith('HIVE-FINDING-DISPOSITION')
    assert hc.plan_review_context(root['id'], artifact['id'], 1) == 'HIVE-ERROR 403'
    reviewer.complete_review(review['id'], 'hold', 'Still uncertain', [finding['id']], ['prepare'])
    active[0] = planner
    context = json.loads(hc.decode(hc.plan_review_context(root['id'], artifact['id'], 1)).split(' ', 1)[1])
    assert context['findings'][0]['disposition']['verdict'] == 'still-open'
    assert context['reviews'][0]['receipt']['recommendation'] == 'hold'
    assert context['authority'] == 'none'
    active[0] = foreign
    assert hc.findings_read(artifact['id']) == 'HIVE-ERROR 403'
    assert not any(call[0]=='start' for call in client.supervisor.calls)


def test_feedback_size_refuses_whole_output(monkeypatch):
    import hive.tests.test_hive_module_semicolons as membrane
    hc = membrane.hc
    monkeypatch.setattr(hc, '_call', lambda *_: ([{'recommendation':'x'*16001}], None))
    result = hc.findings_read('ar_synthetic')
    assert 'read_limit' in result and 'no partial' in result
    assert 'x'*100 not in result


def test_invalid_response_json_never_posts(monkeypatch):
    import hive.tests.test_hive_module_semicolons as membrane
    hc = membrane.hc
    def forbidden(*_):
        raise AssertionError('invalid input must not call the host')
    monkeypatch.setattr(hc, '_call', forbidden)
    for action in (hc.finding_response, hc.finding_disposition):
        assert 'bad_request' in action('fi_synthetic', '[]')
