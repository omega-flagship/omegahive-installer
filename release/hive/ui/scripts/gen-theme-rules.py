#!/usr/bin/env python3
"""Run src/theme/theme.metta in PeTTa and write src/theme/theme.rules.json: MeTTa decides, the browser measures and draws.
Usage: PETTA_PATH=… python3 scripts/gen-theme-rules.py   (re-run after editing theme.metta; the test checks they agree)."""
import json, os, re, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__)); src = open(os.path.join(here, '../src/theme/theme.metta')).read()
petta = os.environ.get('PETTA_PATH') or sys.exit('set PETTA_PATH to a PeTTa checkout (it has run.sh)')
tokens = re.findall(r'^\(role (\S+) \S+\)', src, re.M); derived = re.findall(r'^\(derive (\S+) \S+\)', src, re.M)
qs = [f'!(collapse (checks-for {t}))' for t in tokens] + [f'!(derived {d})' for d in derived]
with tempfile.NamedTemporaryFile('w', suffix='.metta', delete=False) as f: f.write(src + '\n' + '\n'.join(qs) + '\n'); prog = f.name
out = subprocess.run(['sh', 'run.sh', prog], cwd=petta, capture_output=True, text=True, timeout=300).stdout; os.unlink(prog)
tail = re.sub(r'\x1b\[[0-9;]*m', '', out.split('^^^^')[-1])
vals = [l.strip() for l in tail.splitlines() if l.strip() and not set(l.strip()) <= set('^')]
assert len(vals) == len(qs), (len(vals), len(qs), vals[:4])
checks = []
for t, v in zip(tokens, vals):
    for tok, against, floor, repair in re.findall(r'\(check ([^\s)]+) ([^\s)]+) ([\d.]+) ([^\s)]+)\)', v): checks.append({'token': tok, 'against': against, 'floor': float(floor), 'repair': repair})
rules = {'source': 'src/theme/theme.metta via PeTTa', 'checks': checks,
         'derive': {d: v for d, v in zip(derived, vals[len(tokens):])},
         'giveUpAfter': float(re.search(r'^\(give-up-after ([\d.]+)\)', src, re.M).group(1)),
         'roles': dict(re.findall(r'^\(role (\S+) (\S+)\)', src, re.M)),
         'translucent': re.findall(r'^\(translucent (\S+)\)', src, re.M)}
json.dump(rules, open(os.path.join(here, '../src/theme/theme.rules.json'), 'w'), indent=1); print(len(checks), 'checks for', len(tokens), 'tokens')
