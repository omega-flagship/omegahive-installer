# Run omega-mark.metta in PeTTa and write rules.json for renderers: MeTTa decides, renderers draw.
#   PETTA_PATH=/path/to/PeTTa python3 gen_rules.py [out.json]   (default: rules.json beside this file)
import json, os, re, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
petta = os.environ.get('PETTA_PATH') or sys.exit('set PETTA_PATH to a PeTTa checkout (it has run.sh)')
out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'rules.json')
src = open(os.path.join(here, 'omega-mark.metta')).read()
envs = re.findall(r'^\(environment (\S+)', src, re.M); acts = re.findall(r'^\(action (\S+)', src, re.M)
body = src.split('; ── checks')[0]
qs = []
for e in envs: qs += [f'!(material {e})', f'!(edge {e})', f'!(morph-style {e} none full)', f'!(alive {e} full)']
for a in acts: qs += [f'!(in-place {a} full)']
pres = re.findall(r'^\(presence (\S+)', src, re.M)
for st in pres: qs += [f'!(shows {st} full)']
jumps = re.findall(r'^\(time-jump ([^\s)]+)', src, re.M)
for d in jumps: qs += [f'!(jump-reading {d})']
acts_ask = re.findall(r'^\(ask-activity (\S+)', src, re.M)
for e in envs:
    for a in acts_ask: qs += [f'!(ask-shows {e} {a})']
askacts = re.findall(r'\(ask-act ([^\s)]+) ([^\s)]+)\)', src)
for e in envs:
    for a in acts_ask: qs += [f'!(collapse (ask-behaves {e} {a}))']   # always one line: () when the material has no special behaviour
with tempfile.TemporaryDirectory() as tmp:
    gen = os.path.join(tmp, 'omega-mark-gen.metta')
    open(gen, 'w').write(body + '\n' + '\n'.join(qs) + '\n')
    out = subprocess.run(['sh', 'run.sh', gen], cwd=petta, capture_output=True, text=True, timeout=300).stdout
tail = out.split('^^^^')[-1]; tail = re.sub(r'\x1b\[[0-9;]*m', '', tail)
vals = [l.strip() for l in tail.splitlines() if l.strip() and not set(l.strip()) <= set('^')]
assert len(vals) == len(qs), (len(vals), len(qs), vals[:5])
it = iter(vals); rules = {'environments': {}, 'actions': {}, 'reduced_motion': {'morph': 'crossfade', 'living': 'still'}, 'source': 'omega-mark.metta via PeTTa'}
for e in envs: rules['environments'][e] = {'material': next(it), 'edge': next(it).strip('"'), 'style': next(it), 'living': next(it)}
for a in acts: rules['actions'][a] = next(it)
rules['presence'] = {st: next(it) for st in pres}
rules['time_jump'] = {d: next(it).strip('"') for d in jumps}
rules['ask'] = {'shows': {e: {a: next(it) for a in acts_ask} for e in envs}, 'acts': {k: v for k, v in askacts if not k.startswith('$')}}
# behaviours are read straight from the facts (plain data); which behaviour a material uses is MeTTa's ask-behaves (queried below)
beh = {}
for name, body in re.findall(r'^\(behaviour (\S+)\s+(.*?)\)\s*(?:;.*)?$', src, re.M):
    kv = dict(re.findall(r'\((\w+) ([^)]+)\)', body + ')'))
    beh[name] = {k: (float(v) if re.match(r'^-?[\d.]+$', v) else v) for k, v in kv.items()}
rules['ask']['behaviours'] = beh
rules['ask']['behaves'] = {}
for e in envs:
    rules['ask']['behaves'][e] = {}
    for a in acts_ask:
        v = next(it).strip('()').strip()
        if v: rules['ask']['behaves'][e][a] = v
json.dump(rules, open(out_path, 'w'), indent=1); print(len(envs), 'environments', len(acts), 'actions')
