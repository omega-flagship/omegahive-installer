# Purpose: an acceptance check a test author wrote in one of our Make runs of a v0.39.1 test build (19 Nov), its own
# bug kept and its catch-all removed, as the contract now asks: its notes' bare '%,' raises ValueError on every
# tree, so it gives no verdict instead of failing app files.
import os
import sys
import json

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errors = []
failing = []
notes = []


def read(name):
    try:
        p = os.path.join(root, name)
        if not os.path.isfile(p):
            return ''
        with open(p, encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception as e:
        notes.append('could not read ' + name + ': ' + str(e))
        return ''


def need(cond, msg, owner):
    if not cond:
        errors.append(msg)
        if owner not in failing:
            failing.append(owner)


def calc(bill, pct, n):
    tip = round(bill * pct / 100.0, 2)
    total = round(bill + tip, 2)
    return ('%.2f' % tip, '%.2f' % total, '%.2f' % round(total / n, 2))


def run():
    html = read('index.html')
    js = read('app.js')
    css = read('style.css')
    hl = html.lower()
    jl = js.lower()
    cl = css.lower()
    need(html.strip() != '', 'index.html is missing or empty', 'index.html')
    need(js.strip() != '', 'app.js is missing or empty', 'app.js')
    need(css.strip() != '', 'style.css is missing or empty', 'style.css')
    dq = chr(34)
    sq = chr(39)
    for i in ['bill', 'tip-buttons', 'custom-tip', 'people', 'tip-amount', 'total-amount', 'per-person']:
        need(('id=' + dq + i + dq) in html or ('id=' + sq + i + sq) in html, 'index.html lacks element id ' + i, 'index.html')
        need(i in js, 'app.js does not reference ' + i, 'app.js')
    for pct in ['10', '15', '18', '20']:
        need(pct in html, 'index.html lacks quick tip button for ' + pct + '%', 'index.html')
    need('<button' in hl, 'tip options should be buttons', 'index.html')
    need('custom' in hl, 'index.html lacks a Custom tip option', 'index.html')
    need('%' in html, 'index.html tip buttons should show a percent sign', 'index.html')
    need('style.css' in html, 'index.html does not link style.css', 'index.html')
    need('app.js' in html, 'index.html does not load app.js', 'index.html')
    need('viewport' in hl, 'index.html lacks a viewport meta tag for phones', 'index.html')
    compact = hl.replace(' ', '')
    need(('type=' + dq + 'submit' + dq) not in compact and ('type=' + sq + 'submit' + sq) not in compact, 'no submit button should be needed', 'index.html')
    need('tofixed(2)' in jl, 'app.js must show amounts with toFixed(2)', 'app.js')
    need('addeventlistener' in jl or 'oninput' in jl, 'app.js must listen for events', 'app.js')
    need('input' in jl, 'app.js must update live on input events', 'app.js')
    need('click' in jl or 'onclick' in jl, 'app.js must react to tip button clicks', 'app.js')
    need('isnan' in jl or 'isfinite' in jl, 'app.js must guard against NaN', 'app.js')
    need('math.max' in jl or '< 1' in jl or '<1' in jl or '<= 0' in jl, 'app.js must keep people at 1 or more', 'app.js')
    need('active' in jl, 'app.js must mark the active tip button', 'app.js')
    need('classlist' in jl or 'classname' in jl, 'app.js must toggle a class for the active button', 'app.js')
    need('0.00' in js or 'tofixed(2)' in jl, 'app.js must fall back to 0.00 amounts', 'app.js')
    need('.active' in cl, 'style.css needs an .active state for tip buttons', 'style.css')
    need('@media' in cl or 'max-width' in cl or 'flex-wrap' in cl or 'minmax' in cl, 'style.css must be responsive for narrow screens', 'style.css')
    need('{' in css and '}' in css, 'style.css has no rules', 'style.css')
    ex1 = calc(100.0, 18, 4)
    ex2 = calc(86.4, 15, 3)
    notes.append('expected bill 100.00, 18%, 4 people: tip %s, total %s, per person %s' % ex1)
    notes.append('expected bill 86.40, 15%, 3 people: tip %s, total %s, per person %s' % ex2)


def main():
    run()
    if errors and not failing:
        failing.append('app.js')
    passed = not errors
    for e in errors:
        print('FINDING: ' + e)
    verdict = {'passed': passed, 'failing': failing, 'notes': notes + errors[:20]}
    print('CREATE-CHECK ' + json.dumps(verdict))
    sys.stdout.flush()
    sys.exit(0 if passed else 1)


main()
