import { describe, expect, it } from 'vitest'
import source from './LookConflictNotice.tsx?raw'
import app from '../App.tsx?raw'
import { over, parse, ratio, type RGBA } from '../experiences/canvas/contrast'
import type { ExperienceChrome } from '../experiences/chrome'
import { chromeVarNames } from '../experiences/chrome'
import { chromeForMode } from '../experiences/canvas/chrome'
import { chrome as construct } from '../experiences/construct/chrome'
import { chrome as cosmos } from '../experiences/cosmos/chrome'
import { chrome as flux } from '../experiences/flux/chrome'
import { chrome as still } from '../experiences/still/chrome'
import { blockedReason, DEFAULT_VARIANT, lookVars, SEED_VARIANTS, type UiVariant } from './uiVariant'

/**
 * r1o (stand-in r1n P2): the conflict notice's contrast, from the CASCADE that actually applies to it. index.css is
 * parsed; every rule is matched against the notice's real element chain (html with the experience's attributes, the
 * App's `.xc-dress contents` wrapper, the notice with its exact class list, and its buttons); the winning background
 * declaration is chosen by importance, cascade layer, specificity and order; every var() is resolved per element as the
 * browser would (chrome variables and look variables on <html> inline, custom properties inherited and re-pointed by the
 * rules that match); the background's layers are composited at EVERY gradient stop over the page behind (the extremes,
 * since the page behind can be anything). Text >= 4.5:1; the button edge and the focus ring >= 3:1.
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string; writeFileSync: (p: URL, d: string) => void }
const CSS = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')

// ---------------------------------------------------------------- a small CSS cascade (only what index.css uses)

interface Decl {
  prop: string
  value: string
  important: boolean
}
interface Rule {
  selectors: string[]
  decls: Decl[]
  layered: boolean
  order: number
}
function splitTop(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  let quote = ''
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === sep && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}
function parseRules(text: string): Rule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  let order = 0
  const walk = (src: string, layered: boolean) => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open < 0) break
      const head = src.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < src.length && depth) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        j++
      }
      const body = src.slice(open + 1, j - 1)
      const at = head.split(/;\s*/).pop()!.trim()
      if (at.startsWith('@layer')) walk(body, true)
      else if (at.startsWith('@theme')) rules.push({ selectors: [':root'], decls: decls(body), layered: true, order: order++ })
      else if (!at.startsWith('@')) rules.push({ selectors: splitTop(at, ','), decls: decls(body), layered, order: order++ })
      // @media, @keyframes, @supports: state- or device-dependent; not part of the notice's resting paint
      i = j
    }
  }
  const decls = (body: string): Decl[] =>
    splitTop(body.replace(/\{[^}]*\}/g, ''), ';').flatMap((d) => {
      const k = d.indexOf(':')
      if (k < 0) return []
      const value = d.slice(k + 1).trim()
      return [{ prop: d.slice(0, k).trim(), value: value.replace(/\s*!important$/, ''), important: /!important$/.test(value) }]
    })
  walk(css, false)
  return rules
}
const RULES = parseRules(CSS)

interface El {
  tag: string
  classes: string[]
  attrs: Record<string, string>
  states?: string[]
}
/** Does one compound selector (no combinators) match the element? Unknown pseudo-classes do not match (resting state). */
function compound(sel: string, el: El): boolean {
  let s = sel
  const tag = s.match(/^([a-z*]+)/)
  if (tag) {
    if (tag[1] !== '*' && tag[1] !== el.tag) return false
    s = s.slice(tag[1].length)
  }
  while (s) {
    let m
    if ((m = s.match(/^\.([\w-]+)/))) {
      if (!el.classes.includes(m[1])) return false
    } else if ((m = s.match(/^\[([\w-]+)(?:([*^$]?=)'([^']*)')?\]/))) {
      const v = m[1] === 'class' ? el.classes.join(' ') : el.attrs[m[1]]
      if (v === undefined) return false
      if (m[2] === '=' && v !== m[3]) return false
      if (m[2] === '*=' && !v.includes(m[3])) return false
      if (m[2] === '^=' && !v.startsWith(m[3])) return false
    } else if ((m = s.match(/^:root/))) {
      if (el.tag !== 'html') return false
    } else if ((m = s.match(/^:not\(([^)]*)\)/))) {
      if (splitTop(m[1], ',').some((x) => compound(x.trim(), el))) return false
    } else if ((m = s.match(/^::?([\w-]+)(\([^)]*\))?/))) {
      if (!(el.states ?? []).includes(m[1])) return false
    } else return false // anything this small matcher does not know: not matched
    s = s.slice(m[0].length)
  }
  return true
}
/** A selector with descendant combinators only, against the element and its ancestors (nearest first). */
function matches(selector: string, el: El, ancestors: El[]): boolean {
  if (/[>+~]/.test(selector.replace(/\[[^\]]*\]|\([^)]*\)/g, ''))) return false
  const parts = selector.trim().split(/\s+/)
  if (!compound(parts[parts.length - 1], el)) return false
  let k = 0
  for (let p = parts.length - 2; p >= 0; p--) {
    while (k < ancestors.length && !compound(parts[p], ancestors[k])) k++
    if (k >= ancestors.length) return false
    k++
  }
  return true
}
const specificity = (sel: string): [number, number, number] => {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)(?!not\()[\w-]+/g) ?? []).length
  const tags = (sel.match(/(^|\s)[a-z]+/g) ?? []).length
  return [ids, cls, tags]
}
/** The winning declarations of `props` on the element, in cascade order (later wins), each with its matched selector. */
function cascade(el: El, ancestors: El[], props: (p: string) => boolean): { decl: Decl; selector: string; rank: number[] }[] {
  const found: { decl: Decl; selector: string; rank: number[] }[] = []
  for (const r of RULES)
    for (const sel of r.selectors)
      if (matches(sel, el, ancestors))
        for (const d of r.decls)
          if (props(d.prop)) {
            // normal: unlayered > layered; !important: layered > unlayered (CSS cascade layers)
            const layer = d.important ? (r.layered ? 1 : 0) : r.layered ? 0 : 1
            found.push({ decl: d, selector: sel, rank: [d.important ? 1 : 0, layer, ...specificity(sel), r.order] })
          }
  return found.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i]
    return 0
  })
}
/** Custom properties at the element: inherited, then the matching rules', then inline (html only), resolved here. */
function customProps(el: El, ancestors: El[], inherited: Record<string, string>, inline: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...inherited }
  const own: Record<string, string> = {}
  for (const f of cascade(el, ancestors, (p) => p.startsWith('--'))) own[f.decl.prop] = f.decl.value
  Object.assign(own, inline)
  // var() in a custom property resolves against this element's own values first, then what it inherits
  for (let pass = 0; pass < 4; pass++) for (const [k, v] of Object.entries(own)) env[k] = resolve(v, { ...env, ...own })
  return env
}
function resolve(value: string, env: Record<string, string>): string {
  let v = value
  for (let i = 0; i < 8 && v.includes('var('); i++)
    v = v.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))*[^()]*))?\)/g, (_m, name: string, fb?: string) => env[name] ?? fb ?? 'transparent')
  return v
}
/** A CSS colour, color-mix(in srgb, X N%, transparent) included, as RGBA. */
function colour(c: string): RGBA {
  const s = c.trim()
  if (s === 'transparent') return [0, 0, 0, 0]
  const mix = s.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/)
  if (mix) {
    const x = colour(mix[1])
    return [x[0], x[1], x[2], x[3] * (Number(mix[2]) / 100)]
  }
  return parse(s)
}
const COLOUR = /color-mix\([^()]*(?:\([^()]*\))?[^()]*\)|rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8}\b|transparent/g
/** Every ground the background can paint at any of its gradient stops, over each page behind. */
function grounds(background: string, behind: RGBA[]): RGBA[] {
  const layers = splitTop(background, ',')
  const base = layers[layers.length - 1]
  const options: RGBA[][] = layers.slice(0, -1).map((l) => (/gradient\(/.test(l) ? (l.match(COLOUR) ?? ['transparent']).map(colour) : [colour(l)]))
  const out: RGBA[] = []
  for (const page of behind) {
    const b = over(colour(base.match(COLOUR)?.[0] ?? 'transparent'), page)
    let stack: RGBA[] = [b]
    for (let i = options.length - 1; i >= 0; i--) stack = stack.flatMap((g) => options[i].map((c) => over(c, g)))
    out.push(...stack)
  }
  return out
}

// ---------------------------------------------------------------- the notice's real element chain

const cls = (re: RegExp) => (source.match(re)?.[1] ?? '').split(/\s+/).filter(Boolean)
const NOTICE = cls(/role="status"\s+className="([^"]+)"/)
const USE_MINE = cls(/className="([^"]+)"\s+data-tour="look-conflict-use-mine"/)
const DISMISS = cls(/className="([^"]+)" aria-label="Dismiss"/)
const SENTENCE = cls(/<span className="([^"]+)">\s*Your look was changed/)

interface Setting {
  name: string
  html: El
  inline: Record<string, string>
  behind: RGBA[]
}
function experience(name: string, c: ExperienceChrome): Setting {
  // applyChrome: the chrome as --xc-* on <html> inline, and data-xc-active / -scheme / -material
  const inline: Record<string, string> = {}
  for (const k of Object.keys(c) as (keyof ExperienceChrome)[]) {
    if (k === 'material' || k === 'scheme') continue
    const name = `--xc-${k.replace(/([A-Z])/g, '-$1').replace(/(\d)/g, '-$1').toLowerCase()}`
    expect(chromeVarNames, `${k} -> ${name}`).toContain(name)
    inline[name] = String(c[k])
  }
  return { name, html: { tag: 'html', classes: [], attrs: { 'data-xc-active': '', 'data-xc-scheme': c.scheme, 'data-xc-material': c.material } }, inline, behind: [parse('#000000'), parse('#ffffff')] }
}
function classic(v: UiVariant | null): Setting {
  // applyLook: the look's variables on <html> inline (none for the standard look); the classic page behind is the void
  const inline = v ? lookVars(v) : {}
  return { name: `classic · ${v?.name ?? 'standard'}`, html: { tag: 'html', classes: [], attrs: {} }, inline, behind: [parse((v ?? DEFAULT_VARIANT).colors.void), parse('#000000')] }
}
const SETTINGS: Setting[] = [
  classic(null),
  ...SEED_VARIANTS.filter((v) => !blockedReason(v)).map(classic),
  experience('still', still),
  experience('cosmos', cosmos),
  experience('construct', construct),
  experience('flux', flux),
  experience('canvas · light', chromeForMode('light')),
  experience('canvas · dark', chromeForMode('dark')),
]

function paint(s: Setting) {
  const html = s.html
  const body: El = { tag: 'body', classes: [], attrs: {} }
  const wrapper: El = { tag: 'div', classes: ['xc-dress', 'contents'], attrs: {} } // App: classic pages, sheets and dialogs
  const notice: El = { tag: 'div', classes: NOTICE, attrs: { role: 'status' } }
  const envHtml = customProps(html, [], {}, s.inline)
  const envBody = customProps(body, [html], envHtml)
  const envWrap = customProps(wrapper, [body, html], envBody)
  const chain = [wrapper, body, html]
  const envNotice = customProps(notice, chain, envWrap)
  const bg = cascade(notice, chain, (p) => p === 'background' || p === 'background-color').pop()
  const background = bg ? resolve(bg.decl.value, envNotice) : 'transparent'
  const ground = grounds(background, s.behind)
  const tok = (classes: string[], prefix: string) => {
    const c = classes.find((x) => x.startsWith(prefix) && /^(text|border)-(ink|control|line|accent)/.test(x))
    return c ? resolve(`var(--color-${c.slice(prefix.length)})`, envNotice) : null
  }
  const button: El = { tag: 'button', classes: USE_MINE, attrs: { type: 'button' }, states: ['focus-visible'] }
  const envButton = customProps(button, [notice, ...chain], envNotice)
  const outline = cascade(button, [notice, ...chain], (p) => p === 'outline' || p === 'outline-color').pop()
  const focus = outline ? resolve(outline.decl.value, envButton).match(COLOUR)?.slice(-1)[0] ?? null : null
  return { selector: bg?.selector, background, ground, sentence: tok(SENTENCE, 'text-'), name: resolve('var(--color-ink)', envNotice), useMine: tok(USE_MINE, 'text-'), dismiss: tok(DISMISS, 'text-'), edge: tok(USE_MINE, 'border-'), focus }
}
const worst = (fg: string | null, ground: RGBA[]) => (fg ? Math.min(...ground.map((g) => ratio(over(colour(fg), g), g))) : 0)

describe('the conflict notice, measured from the cascade that applies to it', () => {
  it('reads the notice’s real markup: its class list, its buttons, and that it sits inside the App’s .xc-dress wrapper', () => {
    expect(NOTICE).toEqual(expect.arrayContaining(['xc-dress', 'xc-frame', 'glass-strong']))
    expect(NOTICE.some((c) => c.startsWith('bg-'))).toBe(false) // no utility background: the ground is the CSS rules'
    expect(USE_MINE).toEqual(expect.arrayContaining(['border-control', 'text-ink']))
    expect(DISMISS).toContain('text-ink-3')
    expect(SENTENCE).toContain('text-ink-2')
    // App: the notice is rendered inside <div className="xc-dress contents"> … </div>
    const open = app.indexOf('<div className="xc-dress contents">')
    const at = app.indexOf('<LookConflictNotice />')
    const close = app.indexOf('</div>', at)
    expect(open).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(open)
    expect(app.slice(open, at).match(/<div\b/g)?.length).toBe((app.slice(open, at).match(/<\/div>/g)?.length ?? 0) + 1)
    expect(close).toBeGreaterThan(at)
  })

  it('the ground comes from the rules that really win: glass-strong in classic, the dressed frame (!important) in an experience', () => {
    expect(paint(SETTINGS[0]).selector).toBe('.glass-strong')
    for (const s of SETTINGS.filter((x) => 'data-xc-active' in x.html.attrs)) expect(paint(s).selector).toMatch(/^html\[data-xc-active\] \.xc-dress(\.| \.)xc-frame$/)
  })

  it.each(SETTINGS.map((s) => [s.name, s] as const))('%s: text >= 4.5:1; the Use mine edge and the focus ring >= 3:1, at every gradient stop over any page', (_n, s) => {
    const p = paint(s)
    expect(p.ground.length).toBeGreaterThan(0)
    expect(worst(p.sentence, p.ground), `sentence ${p.sentence} on ${p.background}`).toBeGreaterThanOrEqual(4.5)
    expect(worst(p.name, p.ground), 'the look’s name (ink)').toBeGreaterThanOrEqual(4.5)
    expect(worst(p.useMine, p.ground), 'Use mine (ink)').toBeGreaterThanOrEqual(4.5)
    expect(worst(p.dismiss, p.ground), 'Dismiss (ink-3)').toBeGreaterThanOrEqual(4.5)
    expect(worst(p.edge, p.ground), `Use mine edge ${p.edge}`).toBeGreaterThanOrEqual(3)
    expect(worst(p.focus, p.ground), `focus ring ${p.focus}`).toBeGreaterThanOrEqual(3)
  })

  it('(receipt) what was measured, per setting', () => {
    const lines = SETTINGS.map((s) => {
      const p = paint(s)
      const f = (fg: string | null) => worst(fg, p.ground).toFixed(2)
      return `${s.name} | ${p.selector} | ${p.background.replace(/\s+/g, ' ').slice(0, 90)} | sentence ${f(p.sentence)} | name ${f(p.name)} | dismiss ${f(p.dismiss)} | edge ${f(p.edge)} | focus ${f(p.focus)}`
    })
    // @ts-expect-error -- process exists in vitest (node)
    const out = process.env.CONTRAST_RECEIPT
    if (out) fs.writeFileSync(new URL(`file://${out}`), lines.join('\n') + '\n')
    expect(lines).toHaveLength(SETTINGS.length)
  })
})
