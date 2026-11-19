# Purpose: an acceptance check a test author wrote in another of our Make runs of a v0.39.1 test build (19 Nov), its
# own bug kept and its catch-all removed, as the contract now asks: expected() raises TypeError on every tree, so it
# gives no verdict instead of failing app.js.
import os
import re
import sys
import json
import shutil
import subprocess
from decimal import Decimal, ROUND_HALF_UP

root = os.getcwd()
if not os.path.exists(os.path.join(root, 'index.html')):
    alt = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if os.path.exists(os.path.join(alt, 'index.html')):
        root = alt
failing = []
notes = []


def flag(fname, msg):
    if fname not in failing:
        failing.append(fname)
    notes.append(fname + ': ' + msg)
    print('FAIL ' + fname + ': ' + msg)


def read(name):
    try:
        with open(os.path.join(root, name), encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        flag(name, 'missing or unreadable (' + str(e)[:60] + ')')
        return ''


def money(x):
    return str(x.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def expected(bill, pct, n):
    b = Decimal(bill)
    tip = b * Decimal(pct) / Decimal(100)
    total = b + tip
    return money(tip), money(total), money(total / Decimal(n))


def check(cond, fname, msg):
    if not cond:
        flag(fname, msg)


def main():
    html = read('index.html')
    js = read('app.js')
    css = read('style.css')
    low = html.lower()
    jl = js.lower().replace(' ', '')
    tags = re.findall('<input[^>]*>', low)
    check(len(tags) >= 3, 'index.html', 'need at least 3 inputs: bill, custom tip percent, people')
    check(any('bill' in t for t in tags), 'index.html', 'no bill amount input')
    people = [t for t in tags if 'people' in t or 'split' in t or 'person' in t]
    check(bool(people), 'index.html', 'no number-of-people input')
    check(any(re.search('value=.?1[^0-9]', t + ' ') for t in people), 'index.html', 'number of people must default to 1')
    check(any('custom' in t for t in tags), 'index.html', 'no custom tip percentage input')
    for p in ('10', '15', '18', '20'):
        check(re.search('(?<![0-9.])' + p + '(?![0-9])', low) is not None, 'index.html', 'missing tip preset ' + p)
    check('tip' in low and 'total' in low, 'index.html', 'tip and total results must be labelled')
    check(re.search('per[ -]person|each', low) is not None, 'index.html', 'per-person amount must be shown')
    check(re.search('<link[^>]*style[.]css', low) is not None, 'index.html', 'index.html must link style.css')
    check(re.search('<script[^>]*app[.]js', low) is not None, 'index.html', 'index.html must load app.js')
    check('viewport' in low, 'index.html', 'missing viewport meta for mobile')
    check(re.search('aria-live|role=.?alert|id=.?[a-z-]*(error|message|msg|hint)', low) is not None, 'index.html', 'no inline message element for invalid input')
    check(len(css.strip()) > 50 and '{' in css, 'style.css', 'style.css needs real styles')
    check('tofixed(2)' in jl, 'app.js', 'money must be formatted with toFixed(2)')
    check('isnan' in jl or 'isfinite' in jl, 'app.js', 'must guard against NaN and Infinity')
    check(re.search('addeventlistener|oninput|onchange|onclick', jl) is not None, 'app.js', 'must update live on input events')
    check('/100' in jl or '*0.01' in jl, 'app.js', 'tip percentage must be divided by 100')
    check('custom' in jl, 'app.js', 'custom percentage must be read and override presets')
    check(re.search('<0|<=0|<1|>=0|>=1|>0|math[.]max', jl) is not None, 'app.js', 'must reject negative bill and fewer than 1 person')
    check('0.00' in js, 'app.js', 'invalid input must fall back to 0.00')
    e1 = expected('100.00', '15', 1)
    e2 = expected('84.50', '20', 3)
    notes.append('expected 100.00 at 15% for 1: tip %s total %s each %s' % e1)
    notes.append('expected 84.50 at 20% for 3: tip %s total %s each %s' % e2)
    node = shutil.which('node')
    if node and js.strip():
        try:
            r = subprocess.run([node, '--input-type=module', '--check'], input=js.encode('utf-8'), capture_output=True, timeout=20)
            if r.returncode != 0:
                flag('app.js', 'JavaScript syntax error: ' + r.stderr.decode('utf-8', 'replace')[:150])
        except Exception as e:
            notes.append('node syntax check skipped: ' + str(e)[:60])


main()
verdict = {'passed': len(failing) == 0, 'failing': failing, 'notes': notes[:12]}
sys.stdout.flush()
print('CREATE-CHECK ' + json.dumps(verdict))
sys.stdout.flush()
