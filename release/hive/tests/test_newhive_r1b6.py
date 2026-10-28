"""Actual request encoding and host/helper functions, invented inputs; no live socket or provider."""
import ast
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest
from hive.core import newhive, newhive_helper as helper


def runtime_value(kind):
    if kind=='unsupported':return object()
    if kind=='nested':
        value='invented-runtime'
        for _ in range(12000):value=[value]
        return value
    if kind=='circular':
        value=[];value.append(value);return value
    return '['*12000+'invented-runtime'+']'*12000


@pytest.mark.parametrize('kind',['nested','circular','long_string'])
def test_request_encoder_failure_is_setup_stopped_before_socket(monkeypatch,kind):
    monkeypatch.setattr(helper.socket,'socket',lambda *a,**k:pytest.fail('invalid request must never open a socket'))
    outcome=None
    try:helper.control('/synthetic/no-socket',{'op':'bootstrap-complete','runtime':runtime_value(kind)})
    except Exception as exc:outcome=exc
    assert isinstance(outcome,helper.SetupStopped),type(outcome).__name__
    assert outcome.stage=='control'


@pytest.mark.parametrize('kind',['nested','circular','long_string','unsupported'])
def test_complete_request_failure_returns_control_result_and_retires_token(monkeypatch,kind):
    runtime=runtime_value(kind);monkeypatch.setattr(newhive,'runtime_identity',lambda:runtime)
    prepared=SimpleNamespace(map_digest='invented-map',receipt_sha256='receipt',envelope_sha256='envelope',
        receipt_bytes=b'invented-receipt',envelope_bytes=b'invented-envelope',repo='synthetic',sha='a'*40)
    begin={'ok':True,'runtime':runtime,'code':'invented-code','deadline':100,
           'map_digest':prepared.map_digest,'receipt_sha256':prepared.receipt_sha256,'envelope_sha256':prepared.envelope_sha256}
    original_control=helper.control;retired=[]
    def route(path,request,timeout=None):
        op=request['op']
        if op=='hello':return {'ok':True,'port':8700}
        if op=='bootstrap-begin':return begin
        if op=='bootstrap-complete':return original_control(path,request)
        if op=='bootstrap-retire':retired.append(request['token']);return {'ok':True}
        pytest.fail('unexpected control operation '+op)
    class Transport:
        def request(self,method,path,headers=None,body=None,timeout=None):
            if path==helper.EXCHANGE:return 200,b'{"token":"invented-bootstrap-token"}'
            if method=='GET' and path.endswith('/receipt'):return 200,prepared.receipt_bytes
            if method=='GET' and path.endswith('/envelope'):return 200,prepared.envelope_bytes
            if method=='GET':return 200,json.dumps({'digest':prepared.map_digest,'space':{'status':'mounted'}}).encode()
            return 200,b'{}'
    monkeypatch.setattr(helper,'control',route)
    monkeypatch.setattr(helper.socket,'socket',lambda *a,**k:pytest.fail('serialization must fail before connection'))
    try:
        out=helper.run_setup('/synthetic/no-socket',transport=Transport(),prepare=lambda:prepared,clock=lambda:1)
    except Exception as exc:out=exc
    assert retired==['invented-bootstrap-token']  # already true before patch, even on the escaping RecursionError
    assert isinstance(out,dict),type(out).__name__
    assert out['ok'] is False and out['stage']=='control'
    assert 'invented-bootstrap-token' not in repr(out)


@pytest.mark.parametrize('branch,code,stage',[('source','symlink','source'),('source_unknown','invented-private-code','source'),
    ('changed','extractor_changed','source'),('conflict','map_conflict','map'),('assets','retained_artifact_missing','install')])
def test_begin_last_error_has_only_known_stage_and_code(branch,code,stage):
    host=object.__new__(newhive.NewHive)
    host.hold=None;host._verifying=threading.Event();host.local=SimpleNamespace(principal='user:fixture')
    host.last_error=None
    prepared=SimpleNamespace(map_digest='map',receipt_sha256='receipt',envelope_sha256='envelope',repo='synthetic',sha='a'*40)
    comp={'map_digest':'other','receipt_sha256':'receipt','envelope_sha256':'envelope'} if branch=='changed' else None
    host.completion=lambda:comp;host.coding_ready=lambda *a:False
    def prepare():
        if branch.startswith('source'):raise newhive.SourceRefused(code,'invented-private-message','/invented/private/path')
        return prepared
    host.prepare=prepare
    row={'digest':'other' if branch=='conflict' else 'map'} if branch in ('conflict','assets') else None
    host.db=SimpleNamespace(one=lambda *a:row)
    host._assets_present=lambda *a:False
    out=host.begin()
    assert out['ok'] is False
    assert host.last_error=={'stage':stage,'code':'unexpected' if branch=='source_unknown' else code}


@pytest.mark.parametrize('payload',[{'error':'/invented/private/path'},{'error':{'path':'/invented/private/path'}},
    {'error':['invented-private-value']},{'error':'no_owner'},{'ok':True,'url':'https://outside.invalid/private'}])
def test_signin_category_is_already_bounded(monkeypatch,payload):
    monkeypatch.setattr(helper,'control',lambda *a,**k:payload)
    out=helper._handoff('/synthetic/no-socket','http://127.0.0.1:8700',{'synthetic':'receipt'})
    assert out['reason'] in {'signin_refused','no_usable_link','no_owner'}
    assert '/invented/private/path' not in repr(out)
    assert 'https://outside.invalid/private' not in repr(out)


def test_actual_source_guard_rejects_stale_extra_code(monkeypatch):
    test_file=Path(newhive.__file__).resolve().parents[1]/'tests/test_newhive_r1a.py'
    tree=ast.parse(test_file.read_text())
    guard=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='test_begin_reason_codes_cover_every_source_refusal_in_newhive')
    namespace={'newhive':newhive,'pathlib':__import__('pathlib')}
    exec(compile(ast.Module(body=[guard],type_ignores=[]),str(test_file),'exec'),namespace)
    monkeypatch.setattr(helper,'BEGIN_REASON_CODES',helper.BEGIN_REASON_CODES|{'stale_invented_code'})
    with pytest.raises(AssertionError):namespace[guard.name]()


def test_plain_object_request_typeerror_is_bounded_before_socket(monkeypatch):
    monkeypatch.setattr(helper.socket,'socket',lambda *a,**k:pytest.fail('unsupported request must not open a socket'))
    with pytest.raises(helper.SetupStopped) as failure:
        helper.control('/synthetic/no-socket',object())
    assert failure.value.stage=='control'
    assert failure.value.reason=='the control socket did not answer JSON'
