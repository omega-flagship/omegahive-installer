"""Offline CLI: seal, compare, normalize official reports and inspect metrics."""
import argparse
import json
from pathlib import Path
from .catalog import catalogue
from .protocol import seal, compare
from .demo import example
from .imports import import_trials
from .adapters import swe_summary_arm, arc_grid_arm
from .metrics import calibration, horizon_scores, causal_triplet, reliability


def read_json(path):
    source=Path(path)
    if source.stat().st_size>32*1024*1024:
        raise ValueError('input exceeds 32 MiB; use a preregistered smaller cohort')
    return json.loads(source.read_text())


def main():
    ap=argparse.ArgumentParser(description='OmegaBench offline evidence tools')
    sub=ap.add_subparsers(dest='cmd',required=True)
    sub.add_parser('catalog'); sub.add_parser('demo')
    s=sub.add_parser('seal');s.add_argument('registration')
    c=sub.add_parser('compare');c.add_argument('registration');c.add_argument('registration_pin');c.add_argument('export')
    imp=sub.add_parser('import-trials');imp.add_argument('registration');imp.add_argument('registration_pin');imp.add_argument('packet',help='baseline/candidate normalized rows and provenance')
    for name in ('swe-arm','arc-arm'):
        a=sub.add_parser(name);a.add_argument('registration');a.add_argument('arm',choices=['baseline','candidate']);a.add_argument('packet');a.add_argument('--seed',type=int,required=True)
        if name=='arc-arm':a.add_argument('--max-attempts',type=int,choices=[1,2],default=2)
    m=sub.add_parser('metrics');m.add_argument('measure',choices=['calibration','horizons','causal','reliability']);m.add_argument('packet')
    args=ap.parse_args()
    try:
        if args.cmd=='catalog':result=catalogue()
        elif args.cmd=='demo':
            r,e,a=example();result={'registration':r,'export':e,'assessment':a}
        elif args.cmd=='metrics':
            p=read_json(args.packet)
            if args.measure=='calibration':result=calibration(p['probabilities'],p['outcomes'],p.get('bins',10))
            elif args.measure=='horizons':result=horizon_scores(p['rows'])
            elif args.measure=='causal':result=causal_triplet(p['full'],p['sham'],p['severed'])
            else:result=reliability(p['successes'],p['k'])
        else:
            r=read_json(args.registration)
            if args.cmd=='seal':result={'registration_pin':seal(r)}
            elif args.cmd=='compare':result=compare(r,args.registration_pin,read_json(args.export))
            else:
                p=read_json(args.packet)
                if args.cmd=='import-trials':result=import_trials(r,args.registration_pin,p['baseline'],p['candidate'],p['provenance'])
                elif args.cmd=='swe-arm':result=swe_summary_arm(r,args.arm,p['report'],p['resources'],args.seed)
                else:result=arc_grid_arm(r,args.arm,p['solutions'],p['predictions'],p['resources'],args.seed,args.max_attempts)
        print(json.dumps(result,indent=2,allow_nan=False))
    except (ValueError,KeyError,TypeError,OSError) as exc:
        ap.exit(2,f'OmegaBench refused input: {exc}\n')

if __name__=='__main__':main()
