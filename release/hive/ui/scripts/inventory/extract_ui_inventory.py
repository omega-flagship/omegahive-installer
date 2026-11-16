"""Extract a control-level UI inventory as MeTTa atoms from the hive UI source (read-only).
R2: stable control ids and intent binding. R3.1 (Surface, for Codex's intent round): the experience registry and every
entry component are read from the TypeScript AST (entries.mjs), so a label that becomes say('…') or is computed is still
counted, and binds by data-intent / an `intent:` field / say(); a dynamic label with no intent stays, unbound, for
unbound-entry. A counts manifest makes conservation a check: a drop in any entry component or in the registry fails.
Usage: python3 extract_ui_inventory.py <hive/ui/src> <intents.metta> <out.metta> <out-summary.md> [source-sha]
                                       [--counts counts.json] [--write-counts]
Elsewhere (non-entry files) the mechanical first pass stays: Buttons, role=button, aria-labels, nav items, labelled
inputs; nesting = feature dir > component file."""
import re, sys, os, json, collections, subprocess
args = [a for a in sys.argv[1:]]
counts_path = args[args.index('--counts') + 1] if '--counts' in args else None
write_counts = '--write-counts' in args
pos = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] != '--counts')]
src, intents, out, summ = pos[0], pos[1], pos[2], pos[3]
sha = pos[4] if len(pos) > 4 else 'unknown'
# every phrase an intent is known by (its default and each look's words), so a literal label can be bound to its intent
phrase_of = collections.defaultdict(set)
intents_src = open(intents).read()
default_of = {}
for look, i, p in re.findall(r'^\(says ([\w.-]+) ([\w.-]+) "([^"]*)"\)', intents_src, re.M):
    phrase_of[p].add(i)
    if look == 'default': default_of[i] = p
entry_files = re.findall(r'^\(entry-component "([^"]+)"\)', intents_src, re.M)
here = os.path.dirname(os.path.abspath(__file__))
ast = json.loads(subprocess.run(['node', os.path.join(here, 'entries.mjs'), src] + entry_files, capture_output=True, text=True, check=True).stdout)
reg = open(os.path.join(src, 'features/registry.ts')).read()
feats = re.findall(r"\{ id: '([a-z.]+)', label: (?:'((?:[^'\\]|\\.)*)'|\"([^\"]*)\").*?group: '(\w+)'.*?classic: (null|\{[^}]*\})", reg, re.S)
feats = [(a, b or c, d, e) for a, b, c, d, e in feats]
def q(s): return '"' + s.replace('\\', '').replace('"', "'").strip() + '"'
atoms = [f';; UI inventory R2: generated from hive/ui/src at {sha} by extract_ui_inventory.py. Do not hand-edit; the authored half is intents.metta.',
         ';; Schema: (feature $id $label $group) (classic-route $id $route) (surface $sid $label)',
         ';;         (control $cid $surface $component $kind $label) (nests $child $parent) (control-state $cid $state)',
         ';;         (bound $cid $intent): the control says that intent (a say() call, or its literal label is one of the intent\'s phrases)',
         ';;         (renders $ui $cid tuned|auto|classic)  -- filled per experience by the coverage step']
for fid, label, grp, classic in feats:
    atoms.append(f'(feature {fid} {q(label)} {grp})')
    phrase_of[label].add(fid)
    if classic != 'null':
        m = re.search(r"name: '([\w-]+)'", classic); atoms.append(f'(classic-route {fid} {m.group(1) if m else "unknown"})')
SURF = {'code':'Code','create':'Create','firstlight':'First Light','ask':'Ask','studioLive':'Directing Studio','approvals':'Approvals',
        'goals':'Tasks','tasks':'Tasks','minds':'Minds','mind':'Mind','dot':'Mind panel','swarm':'Swarm','keys':'Keys','setup':'Setup',
        'launch':'Launch','programs':'Apps','artifacts':'Artifacts','health':'Health','usage':'Usage','people':'People','settings':'Settings',
        'messages':'Messages','models':'Models','roles':'Roles','explore':'Explore','flow':'Flow','lab':'Lab','lifecycle':'Lifecycle',
        'palette':'Command palette','guided':'Guided tour','power':'Power','updates':'Updates','assets':'Assets','hive':'Hive home',
        'boards':'(retired) Boards','requestExperience':'Request an experience','showreel':'Showreel','harness':'Harness','ink':'Ink','swarm':'Swarm'}
pat = [
 ('button', re.compile(r'<Button\b[^>]*>\s*([^<{][^<]{1,60}?)\s*</Button>')),
 ('button', re.compile(r'<button\b[^>]*>\s*([^<{][^<]{1,60}?)\s*</button>')),
 ('aria', re.compile(r'aria-label=["\']([^"\'{}]{2,70})["\']')),
 ('aria', re.compile(r'aria-label=\{`([^`$]{2,70})`\}')),
 ('label', re.compile(r'<label\b[^>]*>\s*([A-Z][^<{]{1,50}?)\s*<')),
 ('placeholder', re.compile(r'placeholder=["\']([^"\'{}]{2,60})["\']')),
 ('menuitem', re.compile(r"\{ label: '([^']{2,50})', icon:")),
 ('say', re.compile(r"\bsay\('([\w.-]+)'\)")),
]
rows=[]; seen=set(); surf_atoms=set()
roots=[('features',d) for d in sorted(os.listdir(os.path.join(src,'features'))) if os.path.isdir(os.path.join(src,'features',d))]+[('shell',None),('experiences',None)]
for base,d in roots:
    root=os.path.join(src,base,d) if d else os.path.join(src,base)
    sid=(d or base).replace('-','_'); slabel=SURF.get(d, d or base.title())
    for dp,_,fs in os.walk(root):
        for f in sorted(fs):
            if not f.endswith('.tsx') or '.test.' in f: continue
            p=os.path.join(dp,f); comp=os.path.relpath(p,src)
            if comp in entry_files: surf_atoms.add((sid,slabel)); continue   # read from the AST below
            txt=open(p,errors='ignore').read()
            for kind,rx in pat:
                for m in rx.finditer(txt):
                    lab=re.sub(r'\s+',' ',m.group(1)).strip()
                    if '}>' in lab: lab=lab.split('}>')[-1].strip()
                    if '=>' in lab or lab.startswith(('void ','navigate(','set')): continue
                    if not lab or lab.startswith('//'): continue
                    key=(sid,comp,kind,lab)
                    if key in seen: continue
                    seen.add(key); rows.append(key); surf_atoms.add((sid,slabel))
# stable ids: surface.slug-of-label, then the component, then a counter, so an id survives unrelated edits
slug=lambda t: re.sub(r'-+','-',re.sub(r'[^a-z0-9]+','-',t.lower())).strip('-')[:40] or 'dyn'
used=set(); nbound=0
for sid,comp,kind,lab in rows:
    base=f"{sid}.{slug(lab) if '{' not in lab else 'dyn-' + slug(os.path.basename(comp)[:-4])}"
    cid=base if base not in used else f"{base}.{slug(os.path.basename(comp)[:-4])}"
    n=2
    while cid in used: cid=f'{base}.{n}'; n+=1
    used.add(cid)
    atoms.append(f'(control {cid} {sid} {q(comp)} {kind} {q(lab)})')
    atoms.append(f'(nests {cid} {q(comp)})')
    for intent in sorted({lab} if kind=='say' else phrase_of.get(lab, ())):
        atoms.append(f'(bound {cid} {intent})'); nbound+=1
# entry components, from the AST: every interactive element counted; bound by data-intent / intent: / say(), else by its literal label
def shown_label(l):
    if l['kind'] == 'literal': return l['text']
    if l['kind'] == 'say': return default_of.get(l['intent'], l['intent'])
    return '<dynamic>'
entry_count = collections.Counter()
for c in ast['controls']:
    comp = c['file']; entry_count[comp] += 1
    parts = comp.split('/'); sid = (parts[1] if parts[0] == 'features' and len(parts) > 2 else parts[0]).replace('-', '_')
    surf_atoms.add((sid, SURF.get(sid, sid.title())))
    lab = shown_label(c['label'])
    base = f"{sid}.{slug(c['intent'])}" if c['intent'] else f"{sid}.{slug(lab)}" if c['label']['kind'] == 'literal' else f"{sid}.dyn-{slug(os.path.basename(comp).split('.')[0])}"
    cid = base; n = 2
    while cid in used: cid = f'{base}.{n}'; n += 1
    used.add(cid)
    atoms.append(f'(control {cid} {sid} {q(comp)} {c["kind"]} {q(lab)})')
    atoms.append(f'(nests {cid} {q(comp)})')
    for intent in sorted({c['intent']} if c['intent'] else phrase_of.get(lab, ()) if c['label']['kind'] == 'literal' else ()):
        atoms.append(f'(bound {cid} {intent})'); nbound += 1
    rows.append((sid, comp, c['kind'], lab))
for sid,sl in sorted(surf_atoms):
    if f'(surface {sid} ' not in '\n'.join(atoms): atoms.append(f'(surface {sid} {q(sl)})')
# the experiences the registry offers are choosable entries too (from the AST: every object with an id and a name, whatever
# the name's value): each is bound to its intent field, else experience.<id>, so a retired one is caught
for e in ast['experiences']:
    cid=f"experiences.offers.{e['id']}"
    atoms.append(f'(control {cid} experiences "experiences/registry.ts" experience {q(shown_label(e["label"]))})')
    atoms.append(f"(bound {cid} {e['intent']})"); nbound+=1
# conservation: no entry component and no registry may lose a control without the manifest saying so
counts = {'experiences': len(ast['experiences']), **{f: entry_count.get(f, 0) for f in entry_files}}
if counts_path and write_counts:
    json.dump(counts, open(counts_path, 'w'), indent=1, sort_keys=True); print('counts written', counts_path)
elif counts_path:
    want = json.load(open(counts_path)); drops = {k: (v, counts.get(k, 0)) for k, v in want.items() if counts.get(k, 0) < v}
    if drops:
        for k, (was, now) in sorted(drops.items()): print(f'FAIL conservation: {k} had {was} controls, now {now}', file=sys.stderr)
        sys.exit(2)
# Known control states from the designs (work cards, review, lifecycle): attached by name
STATES={'WorkCard':['starting','working','needs-you','changes-needed','ready','done','blocked','stopped','paused','unknown'],
        'Review':['needs-review','reviewing','looks-right','with-notes','changes-needed','could-not-review'],
        'Ribbon':['observed','agent-note','hypothesis','needs-approval','unknown']}
for c,sts in STATES.items():
    atoms.append(f'(surface design_{c.lower()} "{c} (designed, not yet in source)")')
    for s in sts: atoms.append(f'(control-state design_{c.lower()} {s})')
# coverage query (MeTTa) for the test
atoms += [';; Coverage: a control is missing in $ui when no (renders $ui $c $how) exists.',
 '(= (missing $ui) (match &self (control $c $s $comp $k $l) (unless-renders $ui $c $l)))',
 '(= (unless-renders $ui $c $l) (if (== (collapse (match &self (renders $ui $c $h) $h)) ()) ($c $l) (empty)))']
open(out,'w').write('\n'.join(atoms)+'\n')
by=collections.Counter(r[0] for r in rows); kinds=collections.Counter(r[2] for r in rows)
with open(summ,'w') as s:
    s.write(f'# UI inventory R2: summary (generated)\n\n- Features: **{len(feats)}** (registry.ts)\n- Controls: **{len(rows)}** across **{len(by)}** surfaces; **{nbound}** bound to an intent\n- By kind: '+', '.join(f'{k} {v}' for k,v in kinds.most_common())+'\n\n| Surface | Controls |\n|---|---|\n')
    for k,v in by.most_common(): s.write(f'| {SURF.get(k,k)} (`{k}`) | {v} |\n')
print(len(feats),'features',len(rows),'controls',len(by),'surfaces')
