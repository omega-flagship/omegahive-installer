#!/usr/bin/env python3
"""Light-token round R1 codemod (Surface). Rewrites dark-only colour literals in the UI to theme tokens, so any look (light,
dark, or one a person makes) dresses every surface. Mechanical and idempotent; prints a per-file report.

Never touched: experiences/ (each world keeps its own chrome and art), brand/, scene/ (the WebGL hive), canvas/three/GL
code (var() can't reach a canvas), token sources (@theme / :root definitions, uiVariant.ts, appLook.ts, seeds), data and
palette modules (api/, *palette*.ts, model.ts), and tests. Solid white/black stay: they are deliberate fixed elements."""
import os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'src'
SKIP_DIRS = ('experiences/', 'brand/', 'scene/', 'api/')
SKIP_FILES = ('shell/uiVariant.ts', 'shell/appLook.ts', 'shell/osClock.css')  # osClock: each world's own clock skin
ART = re.compile(r"getContext\(|from 'three'|from \"three\"|THREE\.|fillStyle|strokeStyle|new Path2D|gl_FragColor|WebGL")
TOK = {'#eceaff': 'ink', '#b9b8dc': 'ink-2', '#8a89b3': 'ink-3', '#7e7da9': 'ink-4', '#5d5c86': 'ink-5', '#04040f': 'void', '#080822': 'abyss',
       '#6868a0': 'control', '#a493ff': 'accent', '#b9aeff': 'primary-top', '#0b0820': 'primary-ink', '#6ee7ff': 'accent-2',
       '#4ade80': 'good', '#fbbf24': 'warn', '#fb7185': 'bad'}
UTIL = r'(?:bg|text|border|border-[trblxy]|ring|ring-offset|divide|outline|from|via|to|fill|stroke|placeholder|caret|decoration|shadow|accent)'

def pct(a):
    v = float(a) * 100
    return (f'{v:.1f}'.rstrip('0').rstrip('.')) + '%'

def css_tint(m):   # rgb(255 255 255 / .08) | rgba(255,255,255,.08) -> color-mix with the look's ink
    return f'color-mix(in oklab, var(--color-ink) {pct(m.group(1))}, transparent)'

def tw_arbitrary_tint(m):   # inside Tailwind [ ... ] values spaces are underscores
    return f'color-mix(in_oklab,var(--color-ink)_{pct(m.group(1))},transparent)'

# 4 · near-token colours (OKLab distance): a literal that is a token in all but name follows the look
NEAR = {'ink': (236, 234, 255), 'ink-2': (185, 184, 220), 'ink-3': (138, 137, 179), 'void': (4, 4, 15), 'abyss': (8, 8, 34), 'glass': (16, 16, 44),
        'glass-2': (24, 24, 62), 'accent': (164, 147, 255), 'primary-top': (185, 174, 255), 'accent-2': (110, 231, 255), 'line': (170, 170, 255),
        'good': (74, 222, 128), 'warn': (251, 191, 36), 'bad': (251, 113, 133)}
VAR = {'glass': 'abyss', 'glass-2': 'abyss', 'line': 'ink'}     # glass and line are themselves alpha colours: mix from their solid base
def oklab(c):
    r, g, b = [((x / 255) / 12.92 if x / 255 <= .04045 else (((x / 255) + .055) / 1.055) ** 2.4) for x in c]
    l = (.4122214708 * r + .5363325363 * g + .0514459929 * b) ** (1 / 3); m = (.2119034982 * r + .6806995451 * g + .1073969566 * b) ** (1 / 3); s_ = (.0883024619 * r + .2817188376 * g + .6299787005 * b) ** (1 / 3)
    return (.2104542553 * l + .793617785 * m - .0040720468 * s_, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s_, .0259040371 * l + .7827717662 * m - .808675766 * s_)
NEARLAB = {k: oklab(v) for k, v in NEAR.items()}
def nearest(c, limit=.055):
    L = oklab(c); best = min(NEARLAB, key=lambda k: sum((a - b) ** 2 for a, b in zip(L, NEARLAB[k])))
    return best if sum((a - b) ** 2 for a, b in zip(L, NEARLAB[best])) ** .5 < limit else None
def near_rgb(m, sep=' '):
    c = tuple(int(x) for x in m.group(1, 2, 3)); a = m.group(4); k = nearest(c)
    if not k or c == (255, 255, 255) or c == (0, 0, 0): return m.group(0)
    v = VAR.get(k, k)
    return f'color-mix(in{sep}oklab,{sep}var(--color-{v}){sep}{pct(a)},{sep}transparent)' if a is not None else f'var(--color-{v})'

def rewrite(p, s):
    n0 = s
    is_css = p.endswith('.css')
    # 1 · Tailwind alpha utilities: white/N is "a little of the foreground" (tint); black/N is a shade (unchanged value)
    s = re.sub(rf'(?<![\w-]){UTIL}-white/(\d+|\[[^\]]+\])', lambda m: m.group(0).replace('-white/', '-tint/'), s)
    s = re.sub(rf'(?<![\w-]){UTIL}-black/(\d+|\[[^\]]+\])', lambda m: m.group(0).replace('-black/', '-shade/'), s)
    # 2 · white rgb literals
    if is_css:
        out, depth_tok = [], False
        for line in s.split('\n'):
            if re.match(r'\s*(@theme|:root)\b', line): depth_tok = True
            if not depth_tok:
                line = re.sub(r'rgba?\(\s*255[\s,]+255[\s,]+255\s*[/,]\s*([0-9.]+)\s*\)', css_tint, line)
            if depth_tok and line.strip().startswith('}'): depth_tok = False
            out.append(line)
        s = '\n'.join(out)
    else:
        s = re.sub(r'rgb\(255_255_255/([0-9.]+)\)', tw_arbitrary_tint, s)                      # Tailwind arbitrary values
        s = re.sub(r'rgba?\(\s*255[\s,]+255[\s,]+255\s*[/,]\s*([0-9.]+)\s*\)', css_tint, s)    # inline style strings
    # 3 · hex that is exactly a default token
    if is_css:
        out, depth_tok = [], False
        for line in s.split('\n'):
            if re.match(r'\s*(@theme|:root)\b', line): depth_tok = True
            if not depth_tok:
                line = re.sub(r'#[0-9a-fA-F]{6}\b', lambda m: f'var(--color-{TOK[m.group(0).lower()]})' if m.group(0).lower() in TOK else m.group(0), line)
            if depth_tok and line.strip().startswith('}'): depth_tok = False
            out.append(line)
        s = '\n'.join(out)
    else:
        s = re.sub(r'(?<![\w-])(' + UTIL + r')-\[(#[0-9a-fA-F]{6})\]', lambda m: f'{m.group(1)}-{TOK[m.group(2).lower()]}' if m.group(2).lower() in TOK else m.group(0), s)
        s = re.sub(r"((?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke|caretColor|textDecorationColor)\s*:\s*)(['\"])(#[0-9a-fA-F]{6})\2",
                   lambda m: f"{m.group(1)}{m.group(2)}var(--color-{TOK[m.group(3).lower()]}){m.group(2)}" if m.group(3).lower() in TOK else m.group(0), s)
    # 4 · near-token rgb() literals (CSS outside token blocks, and inline style strings), and collapse self-referencing fallbacks
    RGB = r'rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[/,]\s*([0-9.]+)\s*)?\)'
    if is_css:
        out, depth_tok = [], False
        for line in s.split('\n'):
            if re.match(r'\s*(@theme|:root)\b', line): depth_tok = True
            if not depth_tok: line = re.sub(RGB, near_rgb, line)
            if depth_tok and line.strip().startswith('}'): depth_tok = False
            out.append(line)
        s = '\n'.join(out)
    else:
        MOTION = re.compile(r'(initial|animate|exit|whileHover|whileTap|whileInView)=\{\{')   # framer can't interpolate color-mix(): leave motion colours as literals
        STR = re.compile(r"(['\"`])((?:\\.|(?!\1)[^\\\n])*)\1")                                 # a string literal on one line; replace only inside it
        def in_strings(line): return STR.sub(lambda m: m.group(1) + re.sub(RGB, near_rgb, m.group(2)) + m.group(1), line)
        s = '\n'.join(line if MOTION.search(line) else in_strings(line) for line in s.split('\n'))
    s = re.sub(r'var\((--color-[\w-]+),\s*var\(\1\)\)', r'var(\1)', s)
    return s, s != n0

changed = 0
for root, _, fs in os.walk(ROOT):
    for f in fs:
        if not f.endswith(('.ts', '.tsx', '.css')) or '.test.' in f: continue
        full = os.path.join(root, f); p = os.path.relpath(full, ROOT)
        if p.startswith(SKIP_DIRS) or p in SKIP_FILES or 'palette' in f or f == 'model.ts': continue
        s = open(full).read()
        if ART.search(s): continue
        new, did = rewrite(p, s)
        if did:
            open(full, 'w').write(new); changed += 1
            print('rewrote', p)
print(changed, 'files rewritten')
