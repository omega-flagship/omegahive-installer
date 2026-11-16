import json
import subprocess
import sys
from pathlib import Path
from omegabench.demo import example
from omegabench.protocol import seal

ROOT=Path(__file__).resolve().parents[2]


def run(*args):
    return subprocess.run([sys.executable,'-m','omegabench',*map(str,args)],cwd=ROOT,capture_output=True,text=True,timeout=10)


def test_cli_seal_and_compare_round_trip(tmp_path):
    r,e,_=example();rp=tmp_path/'r.json';ep=tmp_path/'e.json'
    rp.write_text(json.dumps(r));ep.write_text(json.dumps(e))
    sealed=run('seal',rp);assert sealed.returncode==0
    p=json.loads(sealed.stdout)['registration_pin'];assert p==seal(r)
    assessed=run('compare',rp,p,ep);assert assessed.returncode==0
    assert json.loads(assessed.stdout)['independent_units']==3


def test_cli_refuses_changed_export_without_partial_output(tmp_path):
    r,e,_=example();e['candidate'].pop()
    rp=tmp_path/'r.json';ep=tmp_path/'e.json';rp.write_text(json.dumps(r));ep.write_text(json.dumps(e))
    result=run('compare',rp,seal(r),ep)
    assert result.returncode==2 and not result.stdout
    assert 'complete paired denominator' in result.stderr


def test_cli_semantic_calibration(tmp_path):
    p=tmp_path/'forecasts.json';p.write_text(json.dumps({'probabilities':[0.,1.],'outcomes':[0,1]}))
    result=run('metrics','calibration',p)
    assert result.returncode==0 and json.loads(result.stdout)['brier']==0
