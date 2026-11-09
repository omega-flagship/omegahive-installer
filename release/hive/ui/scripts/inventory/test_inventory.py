"""R3.1 conservation and binding (fixtures only; run: python3 -I scripts/inventory/test_inventory.py from hive/ui).
A literal label turning into say('…'), and a registry name turning into say('…'), keep every count and bind by intent;
a dynamic label with no intent is kept, unbound (so unbound-entry sees it); a deleted control fails the counts check."""
import json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, 'extract_ui_inventory.py')
INTENTS = '''(intent chrome.change-experience menu)
(says default chrome.change-experience "Change experience")
(intent chrome.inbox menu)
(says default chrome.inbox "Inbox")
(intent experience.classic experience)
(says default experience.classic "Classic")
(intent experience.cosmos experience)
(says default experience.cosmos "Cosmos")
(entry-component "shell/Hud.tsx")
'''
FEATURES = "export const FEATURES = [{ id: 'hive.help', label: 'Help', group: 'hive', classic: null }]\n"
REG_LIT = "export const E = [{ id: 'classic', name: 'Classic', tagline: 't' }, { id: 'cosmos', name: 'Cosmos', tagline: 't' }]\n"
REG_SAY = "export const E = [{ id: 'classic', name: say('experience.classic'), tagline: 't' }, { id: 'cosmos', name: words.say('experience.cosmos'), intent: 'experience.cosmos', tagline: 't' }]\n"
HUD_LIT = '''export function Hud() { return (<nav>
  <button onClick={go}>Change experience</button>
  <button aria-label="Inbox" onClick={inbox} />
  <div role="menuitem" onClick={x}>Hive menu</div>
</nav>) }
'''
HUD_SAY = '''export function Hud() { return (<nav>
  <button onClick={go}>{say('chrome.change-experience')}</button>
  <button aria-label={label} data-intent="chrome.inbox" onClick={inbox} />
  <div role="menuitem" onClick={x}>{menuTitle}</div>
</nav>) }
'''
HUD_LOST = '''export function Hud() { return (<nav>
  <button onClick={go}>{say('chrome.change-experience')}</button>
  <div role="menuitem" onClick={x}>{menuTitle}</div>
</nav>) }
'''
def tree(reg, hud):
    d = tempfile.mkdtemp(prefix='inv-')
    for p, t in {'src/experiences/registry.ts': reg, 'src/shell/Hud.tsx': hud, 'src/features/registry.ts': FEATURES}.items():
        os.makedirs(os.path.join(d, os.path.dirname(p)), exist_ok=True); open(os.path.join(d, p), 'w').write(t)
    open(os.path.join(d, 'intents.metta'), 'w').write(INTENTS)
    return d
def run(d, *extra):
    r = subprocess.run([sys.executable, '-I', GEN, os.path.join(d, 'src'), os.path.join(d, 'intents.metta'), os.path.join(d, 'out.metta'), os.path.join(d, 'out.md'), 'fixture', *extra], capture_output=True, text=True)
    atoms = open(os.path.join(d, 'out.metta')).read() if os.path.exists(os.path.join(d, 'out.metta')) else ''
    return r, atoms
fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
a = tree(REG_LIT, HUD_LIT); counts = os.path.join(a, 'counts.json')
r, atoms_a = run(a, '--counts', counts, '--write-counts')
check(r.returncode == 0, 'literal tree generates and writes counts')
check(json.load(open(counts)) == {'experiences': 2, 'shell/Hud.tsx': 3}, 'counts: 2 experiences, 3 Hud controls')
check('(bound shell.change-experience chrome.change-experience)' in atoms_a, 'a literal label binds by its phrase')
b = tree(REG_SAY, HUD_SAY); shutil.copy(counts, os.path.join(b, 'counts.json'))
r, atoms_b = run(b, '--counts', os.path.join(b, 'counts.json'))
check(r.returncode == 0, 'say() labels conserve every count (no failure against the literal counts)')
check('(bound shell.chrome-change-experience chrome.change-experience)' in atoms_b, "say('…') binds to its intent")
check('(bound shell.chrome-inbox chrome.inbox)' in atoms_b, 'data-intent binds a dynamic label')
check('(control shell.dyn-hud shell "shell/Hud.tsx" menuitem "<dynamic>")' in atoms_b and '(bound shell.dyn-hud' not in atoms_b, 'a dynamic label with no intent is kept, unbound')
check('(bound experiences.offers.classic experience.classic)' in atoms_b and '(control experiences.offers.cosmos experiences "experiences/registry.ts" experience "Cosmos")' in atoms_b, 'registry names as say() keep both experiences, shown by their default phrase')
c = tree(REG_SAY, HUD_LOST); shutil.copy(counts, os.path.join(c, 'counts.json'))
r, _ = run(c, '--counts', os.path.join(c, 'counts.json'))
check(r.returncode == 2 and 'shell/Hud.tsx had 3 controls, now 2' in r.stderr, 'a lost control fails conservation')
for d in (a, b, c): shutil.rmtree(d)
sys.exit(1 if fails else 0)
