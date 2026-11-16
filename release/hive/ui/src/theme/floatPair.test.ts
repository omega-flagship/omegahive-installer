import { describe, expect, it } from 'vitest'
import type { ExperienceChrome } from '../experiences/chrome'
import { chromeForMode } from '../experiences/canvas/chrome'
import { chrome as construct } from '../experiences/construct/chrome'
import { chrome as cosmos } from '../experiences/cosmos/chrome'
import { chrome as flux } from '../experiences/flux/chrome'
import { chrome as professional } from '../experiences/professional/chrome'
import { chrome as still } from '../experiences/still/chrome'
import seeds from '../shell/uiVariants.seed.json'
import { DEFAULT_VARIANT, lookVars } from '../shell/uiVariant'

/**
 * A surface and the ink on it must flip together in every look (tester report, 9 Nov: in a light look the Ask's
 * "New messages ↓" pill was a black oval with dark text, because its background, --color-abyss, stayed dark inside the
 * skins that re-point --color-ink, and Chat's copy of the pill had a literal navy). The floating surfaces now sit on one
 * pair, --color-float / --color-float-ink, and these checks keep any background paired with ink from going stale:
 *  - every CSS scope that re-points --color-ink re-points the pair, and a worn look sets the pair;
 *  - a rule or class that draws ink text on a background token uses a token every ink scope re-points (a per-look token),
 *    never one only some scopes change, and never a literal colour;
 *  - the pair reads at 4.5:1 in every built-in look, every experience chrome, and the Still letter.
 */

// CSS read from disk: under vitest a `?raw` import of a .css file comes back empty
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as {
  readdirSync: (p: string) => string[]
  readFileSync: (p: string, e: 'utf8') => string
  statSync: (p: string) => { isDirectory: () => boolean }
}
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const walk = (d: string): string[] => fs.readdirSync(d).flatMap((n) => (fs.statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : n.endsWith('.css') ? [`${d}/${n}`] : []))
const css = Object.fromEntries(walk(SRC).map((p) => [`..${p.slice(SRC.length)}`, fs.readFileSync(p, 'utf8')])) as Record<string, string>
const tsx = import.meta.glob(['../**/*.tsx', '!../**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const rel = (k: string) => k.replace(/^\.\.\//, '')

type Rule = { at: string; body: string }
/** every innermost `selector { declarations }` block, comments removed (at-rule wrappers such as @media are skipped over) */
const rules: Rule[] = Object.entries(css).flatMap(([k, src]) =>
  [...src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ at: `${rel(k)}:${m[1].trim().replace(/\s+/g, ' ')}`, body: m[2] })))
const defines = (body: string) => new Set([...body.matchAll(/--color-([\w-]+)\s*:/g)].map((m) => m[1]))

const inkScopes = rules.filter((r) => defines(r.body).has('ink'))
/** the tokens every ink scope re-points: only these may sit behind ink text */
const perLook = [...defines(inkScopes[0]?.body ?? '')].filter((t) => inkScopes.every((r) => defines(r.body).has(t)))

/**
 * Page grounds: the full-screen backdrop gradient of a page, not a surface floating over content. They are drawn only in
 * the classic hive or the Code canvas, where the look (lookVars) and the experience dress (.xc-dress) re-point void and
 * abyss together with the ink; no skin scope that changes only the ink ever wraps them.
 */
const GROUNDS: { at: string; why: string }[] = [
  { at: 'experiences/classic/phases.css:.classic-home', why: 'the classic home page ground; classic only, the look sets void, abyss and ink together' },
  { at: 'features/power/power.css:.pw-rest-classic', why: 'the classic rest screen ground; classic only, the look sets void, abyss and ink together' },
  { at: 'features/code/canvas/codeCanvas.css:.cc', why: "the Code canvas page ground (--look-page-a/b first); the look or the dress sets it with the ink" },
]

/**
 * Class lists drawn only where the look (lookVars) or the experience dress (.xc-dress) sets the background with the ink,
 * never inside a skin scope that re-points only the ink.
 */
const TSX_ALLOWED: { file: string; bg: string; why: string }[] = [
  { file: 'features/requestExperience/RequestPanel.tsx', bg: 'bg-glass', why: 'the Change UI window (shell/ChangeUi.tsx): the look or the dress sets glass with the ink' },
  { file: 'features/requestExperience/RequestPanel.tsx', bg: 'bg-glass-2', why: 'its text field, in the same Change UI window' },
]

/** the colour tokens a background draws at 50% or more (a surface, not a light wash of the parent) */
function surfaceTokens(value: string): string[] {
  const out: string[] = []
  for (const m of value.matchAll(/color-mix\(in \w+, var\(--color-([\w-]+)\) (\d+)%/g)) if (Number(m[2]) >= 50) out.push(m[1])
  const bare = value.replace(/color-mix\([^()]*(\([^()]*\)[^()]*)*\)/g, '')
  for (const m of bare.matchAll(/var\(--color-([\w-]+)\)/g)) out.push(m[1])
  return out
}

describe('a surface and its ink flip together in every look', () => {
  it('there are scopes that re-point the ink (the guard is reading the CSS)', () => {
    expect(inkScopes.length).toBeGreaterThan(5)
    expect(perLook).toEqual(expect.arrayContaining(['ink', 'float', 'float-ink']))
  })
  it('every scope that re-points --color-ink re-points --color-float and --color-float-ink', () => {
    const missing = inkScopes.filter((r) => !defines(r.body).has('float') || !defines(r.body).has('float-ink')).map((r) => r.at)
    expect(missing).toEqual([])
  })
  it('a worn look sets the pair from its own ground and ink', () => {
    for (const v of [DEFAULT_VARIANT, ...(seeds as (typeof DEFAULT_VARIANT)[])]) {
      const vars = lookVars(v)
      expect({ id: v.id, float: vars['--color-float'], ink: vars['--color-float-ink'] }).toEqual({ id: v.id, float: vars['--color-abyss'], ink: vars['--color-ink'] })
    }
  })
  it('CSS: ink text sits only on a per-look background token (page grounds listed with a reason)', () => {
    const grounds = new Set(GROUNDS.map((g) => g.at))
    const bad = rules.flatMap((r) => {
      const ink = r.body.match(/(?<![\w-])color:\s*var\(--color-(ink|float-ink)\)/)?.[1]
      if (!ink || grounds.has(r.at)) return []
      const bgs = [...r.body.matchAll(/(?<![\w-])background(?:-color)?\s*:([^;]*)/g)].flatMap((m) => surfaceTokens(m[1]))
      const wrong = bgs.filter((t) => (ink === 'float-ink' ? t !== 'float' : !perLook.includes(t)))
      return wrong.map((t) => `${r.at}: ${ink} on ${t}`)
    })
    expect(bad).toEqual([])
    for (const g of GROUNDS) expect(rules.some((r) => r.at === g.at), `${g.at} still exists`).toBe(true)
  })
  it('no plain @theme colour holds a var(): it would resolve once on the root and keep the root ink inside a skin (tint is inline)', () => {
    const src = (css['../index.css'] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
    const plain = [...src.matchAll(/@theme\s*\{([^}]*)\}/g)].flatMap((m) => [...m[1].matchAll(/(--color-[\w-]+)\s*:\s*([^;]*var\([^;]*);/g)].map((d) => `${d[1]}: ${d[2]}`))
    expect(plain).toEqual([])
    const inline = [...src.matchAll(/@theme\s+inline\s*\{([^}]*)\}/g)].map((m) => m[1]).join('')
    expect(inline).toMatch(/--color-tint:\s*var\(--color-ink\);/)
  })
  it('TSX: a class list with ink text uses no literal background and no background token only some looks re-point', () => {
    const bad = Object.entries(tsx).flatMap(([k, src]) =>
      [...src.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((m) => m[2]).filter((cls) => /(?<![\w:-])text-(ink|float-ink)(?![\w-])/.test(cls)).flatMap((cls) =>
        [...cls.matchAll(/(?<![\w:-])bg-(\[[^\]]+\]|[a-z][\w-]*)(?:\/(\d+))?(?![\w-])/g)]
          .filter((b) => !b[2] || Number(b[2]) >= 50)
          .filter((b) => !TSX_ALLOWED.some((a) => a.file === rel(k) && a.bg === `bg-${b[1]}`))
          .filter((b) => b[1].startsWith('[#') || b[1].startsWith('[rgb') || ['void', 'abyss', 'glass', 'glass-2', 'shade'].includes(b[1]) && !perLook.includes(b[1]))
          .map((b) => `${rel(k)}: ${b[0]} with ink text`)))
    expect(bad).toEqual([])
  })
})

type RGBA = [number, number, number, number]
const parse = (c: string): RGBA => {
  const short = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (short) c = `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA
  const rgb = c.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[/,]\s*([\d.]+))?\)$/)
  if (!rgb) throw new Error(`unparsed colour ${c}`)
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1]
}
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA
const lum = (x: RGBA) => {
  const [r, g, b] = x.slice(0, 3).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/** the pill draws the surface at 95% over whatever is behind it: measured over black and over white, the worse one counts */
const pill = (surface: string, ink: string) => {
  const s = parse(surface)
  const at95: RGBA = [s[0], s[1], s[2], s[3] * 0.95]
  return Math.min(...[parse('#000000'), parse('#ffffff')].map((d) => ratio(parse(ink), over(at95, d))))
}

describe('the pill reads in every look, light and dark', () => {
  it('every built-in look: float-ink on float at 4.5:1 or more', () => {
    for (const v of [DEFAULT_VARIANT, ...(seeds as (typeof DEFAULT_VARIANT)[])]) {
      const vars = lookVars(v)
      expect({ id: v.id, ok: pill(vars['--color-float'], vars['--color-float-ink']) >= 4.5 }).toEqual({ id: v.id, ok: true })
    }
  })
  it('every experience chrome (where the skins and the dress set the pair to the chrome surface and ink): 4.5:1 or more', () => {
    const chromes: Record<string, ExperienceChrome> = {
      cosmos, flux, construct, still, professional, 'canvas light': chromeForMode('light'), 'canvas dark': chromeForMode('dark'),
    }
    expect(Object.values(chromes).some((c) => c.scheme === 'light')).toBe(true)
    for (const [id, c] of Object.entries(chromes)) expect({ id, ok: pill(c.surface, c.ink) >= 4.5 }).toEqual({ id, ok: true })
  })
  it('the Still letter (paper): 4.5:1 or more', () => {
    const letter = rules.find((r) => r.at === 'features/ask/ask.css:.ask-letter, .st-letter' && defines(r.body).has('float'))!
    // a value is a colour, or var(--color-x) naming another colour the same block declares
    const val = (t: string): string => {
      const v = letter.body.match(new RegExp(`--color-${t}:\\s*([^;]+);`))![1].trim()
      const ref = v.match(/^var\(--color-([\w-]+)\)/)
      return ref ? val(ref[1]) : v
    }
    expect(pill(val('float'), val('float-ink'))).toBeGreaterThanOrEqual(4.5)
  })
})
