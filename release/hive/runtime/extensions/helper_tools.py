"""Declared advisory Tools wrappers; authenticated host action, no local evaluator."""
import json
import os
import uuid
import urllib.request
import urllib.error

SKILLS=frozenset({'tools-provenance-revise', 'tools-intent-return', 'tools-value-transition', 'tools-attention-select', 'tools-energy-reserve', 'tools-prediction-score', 'tools-belief-appraise', 'tools-attention-event', 'tools-novelty-inspect', 'tools-energy-close', 'tools-goal-step', 'tools-novelty-genesis', 'tools-skill-nominate', 'tools-retention-check', 'tools-habitat-stage', 'tools-atom-recall', 'tools-ethical-compare', 'tools-scratch-promote', 'tools-self-readback', 'tools-substrate-check', 'tools-consolidation-propose', 'tools-intent-bind', 'tools-habitat-room', 'tools-ensemble-compare', 'tools-rest-appraise', 'tools-home-propose'})

def result_atom(skill,result):
    name=json.dumps(str(skill)[:128]); kind=result.get('kind')
    if kind=='ToolLimitExceeded':
        return '(ToolLimitExceeded '+name+' '+json.dumps(str(result.get('limit'))) +' authority-none)'
    if kind!='ToolResult':
        return '(ToolAdmissionRefused '+name+' '+json.dumps(str(result.get('reason','host-action-refused'))[:256])+' authority-none)'
    results=result.get('results',[])
    if result.get('authority')!='none' or not isinstance(results,list) or not all(type(x) is str for x in results):
        return '(ToolAdmissionRefused '+name+' "invalid-host-result" authority-none)'
    return '(ToolResult '+name+' (NativeOutputStrings '+' '.join(json.dumps(x) for x in results)+') authority-none)'

def call(skill,text):
    try:
        if skill not in SKILLS or type(text) is not str or len(text.encode())>8192: raise ValueError('input-envelope')
        args=json.loads(text)
        if not isinstance(args,list): raise ValueError('expected-array')
        base=os.environ.get('HIVE_API_URL','').rstrip('/');token=os.environ.get('HIVE_WS_TOKEN','')
        pin=os.environ.get('OMEGACLAW_TOOLS_RECEIPT','')
        if not base or not token or not pin: raise ValueError('host-action-not-configured')
        # A fresh read-only calculation is a new request; no automatic retry on
        # timeout. App policy/action idempotency remains owned by ProgramActions.
        body={'action':'run-native','items':[],'params':{'skill':skill,'arguments':args,'review_receipt':pin},
              'idempotency_key':'tools-'+uuid.uuid4().hex}
        req=urllib.request.Request(base+'/api/agent/programs/omega-tools/act',data=json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(req,timeout=10) as response:
            wire=response.read(32769)
            if len(wire)>32768: raise ValueError('output-envelope')
            out=json.loads(wire)
        if out.get('status')!='done': return result_atom(skill,{'reason':out.get('message',out.get('status','refused'))})
        return result_atom(skill,out['detail'])
    except (ValueError,TypeError,KeyError,OSError,RecursionError):
        return result_atom(skill,{'reason':'invalid-input-or-host-action-unavailable'})
