import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prerender } from 'react-dom/static'
import { SimClient } from '../api/sim/SimClient'
import type { ExperienceChrome } from '../experiences/chrome'
import { chromeForMode } from '../experiences/canvas/chrome'
import { chrome as construct } from '../experiences/construct/chrome'
import { chrome as cosmos } from '../experiences/cosmos/chrome'
import { chrome as flux } from '../experiences/flux/chrome'
import { chrome as still } from '../experiences/still/chrome'
import LabView from '../features/lab/LabView'
import { ProgramForm } from '../features/programs/ProgramForm'
import SwarmView from '../features/swarm/SwarmView'
import { useHive } from '../store/store'
import { MeTTa } from '../ui/MeTTa'
import { dressedIn } from './chromeDress'
import { formFor, GRAMMARS, type FormId, type Grammar } from './contract'
import { backgroundLayers, Cascade, classes, find, measure, page, parseColor, parseCss, sameColour, textElements, type El, type Measured } from './readabilityKit'

/**
 * Stand-in READABILITY_R1 (FIX-FIRST) finding 1 and 2: the rendering itself, not the helpers. Each test renders the
 * real component (Lab, the swarm's commons table, MeTTa, and ProgramForm hosting each fallback form), reads the real
 * stylesheets, and resolves what the browser would paint inside each experience: the dressed variables, the
 * backgrounds beneath every text node (opacity included) and the contrast of every text node (4.5:1, 3:1 for large
 * text). Reverting any of the rendering changes fails here (receipts/readability/r2-fail-before.txt). INVENTED sim
 * data only; nothing leaves the page.
 */

// A server render reads a zustand store through its server snapshot (the initial state); read the live one instead.
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    ;(api as { getInitialState: unknown }).getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})
// The page's info button portals into document.body, which a server render has none of.
vi.mock('../tour/ViewInfo', () => ({ ViewInfo: () => null }))
// The scheme the chrome writes on <html> (a server render has no <html>): set per chrome below.
const scheme = vi.hoisted(() => ({ current: 'light' as 'light' | 'dark' }))
vi.mock('./chromeDress', async (orig) => ({ ...(await orig<typeof import('./chromeDress')>()), useXcScheme: () => scheme.current }))

// vitest hands CSS imports back empty (even ?raw): read the stylesheets themselves, as ui/overlays.test.ts does
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const css = (rel: string) => {
  const text = fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
  if (text.length < 1000) throw new Error(`${rel} read empty`)
  return text
}
const indexCss = css('../index.css')

const CHROMES: Record<string, ExperienceChrome[]> = {
  still: [still],
  cosmos: [cosmos],
  construct: [construct],
  flux: [flux],
  canvas: [chromeForMode('light'), chromeForMode('dark')],
}
const ALL = Object.entries(CHROMES).flatMap(([g, cs]) => cs.map((c) => [`${g}/${c.scheme}`, g as Grammar, c] as const))
const INDEX = parseCss(indexCss)
const FORM_CSS: Partial<Record<FormId, string>> = { commons: './commons/commons.css', 'case-file': './caseFile/caseFile.css' }

let a: SimClient
beforeAll(async () => {
  vi.stubGlobal('window', { location: { search: '', hash: '#/lab', pathname: '/' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
  a = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  a.simSession = 'person'
  await useHive.getState().init(a)
  await Promise.all([useHive.getState().loadLab(), useHive.getState().loadBeliefs('s_lyra'), useHive.getState().loadPrograms()])
  await useHive.getState().loadLabScorecard()
})
afterAll(() => {
  a.disconnect()
  vi.unstubAllGlobals()
})

const bottomColour = (bg: string) => {
  const layers = backgroundLayers(bg)
  expect(layers.length, `background "${bg}"`).toBeGreaterThan(0)
  expect(layers[0].length, `background "${bg}" bottom layer`).toBe(1)
  return layers[0][0]
}
/** The worst text of each rendered case, printed at the end (the receipt's table). */
const SUMMARY: string[] = []
const worstOf = (label: string, rows: Measured[]) => {
  const w = rows.reduce((a, b) => (b.ratio / b.min < a.ratio / a.min ? b : a))
  SUMMARY.push(`${label.padEnd(44)} ${String(rows.length).padStart(4)} texts, worst ${w.ratio.toFixed(2)} (${w.min}:1) "${w.text.slice(0, 24)}" ${w.fg} on ${w.bg}`)
}
afterAll(() => console.log(`\n${SUMMARY.join('\n')}`))
const fails = (rows: Measured[]) => rows.filter((r) => r.ratio < r.min).map((r) => `"${r.text}" <${r.el.tag} class="${r.el.attrs.class ?? ''}"> ${r.ratio} < ${r.min} (fg ${r.fg} on ${r.bg})`)
const rendered = (el: ReactElement) => renderToStaticMarkup(el)

describe('Lab tiles, rendered (LabView overview)', () => {
  let markup = ''
  beforeAll(() => {
    markup = rendered(createElement(LabView))
  })
  const parts = (root: El) => ({
    card: find(root, (e) => e.attrs['data-tour'] === 'lab-scorecard')[0],
    tiles: find(root, (e) => e.tag === 'article'),
    dims: find(root, (e) => e.tag === 'button' && !!e.parent?.attrs['data-tour']?.startsWith('lab-dim-')),
  })
  it('renders the scorecard, the suite tiles and the dimension tiles inside the dressed page', () => {
    const p = parts(page(markup, cosmos))
    expect(p.card).toBeDefined()
    expect(p.tiles.length).toBeGreaterThan(3)
    expect(p.dims.length).toBeGreaterThan(3)
    const inDress = (e: El) => {
      for (let x: El | null = e; x; x = x.parent) if (classes(x).includes('xc-dress')) return true
      return false
    }
    for (const t of [p.card, ...p.tiles, ...p.dims]) expect(inDress(t)).toBe(true)
  })
  it('classic is unchanged: the navy tile and white ink', () => {
    const cx = new Cascade(INDEX)
    const p = parts(page(markup, null))
    for (const t of p.tiles) expect(sameColour(cx.styled(t).props.background, '#0d0d26')).toBe(true)
    expect(sameColour(cx.styled(p.card).props.background, '#0d0d26')).toBe(true)
  })
  for (const [name, , c] of ALL) {
    it(`${name}: every tile is the chrome's raised surface (empty: its surface), and every text in them reads`, () => {
      const cx = new Cascade(INDEX)
      const root = page(markup, c)
      const p = parts(root)
      for (const t of [p.card, ...p.tiles]) expect(bottomColour(cx.styled(t).props.background), `${t.tag}`).toEqual(parseColor(c.raised))
      for (const d of p.dims) {
        const empty = classes(d).includes('opacity-80')
        expect(bottomColour(cx.styled(d).props.background)).toEqual(parseColor(empty ? c.surface : c.raised))
      }
      const rows = [p.card, ...p.tiles, ...p.dims].flatMap((t) => textElements(t).map((e) => measure(cx, e)))
      expect(rows.length).toBeGreaterThan(20)
      worstOf(`lab ${name}`, rows)
      expect(fails(rows)).toEqual([])
    })
  }
})

describe('the swarm commons table, rendered (SwarmView)', () => {
  let markup = ''
  beforeAll(() => {
    markup = rendered(createElement(SwarmView, { id: 's_lyra' }))
  })
  const sky = (root: El) => find(root, (e) => e.attrs['data-tour'] === 'swarm-sky')[0]
  // uifix-r3 (S3): the table reads beliefs as sentences with sureness in words; the notation is closed behind "Show as written"
  it('renders the sky with the table of beliefs as sentences and how sure, no notation open', () => {
    const s = sky(page(markup, still))
    expect(s).toBeDefined()
    const body = find(s, (e) => e.tag === 'tbody')
    expect(body.length).toBe(1)
    expect(find(body[0], (x) => x.attrs['data-belief'] !== undefined).length).toBeGreaterThan(3)
    // "Show as written" is closed: its written form is in the DOM (aria-controls resolves) but hidden (uifix-r3.1)
    expect(find(body[0], (x) => x.tag === 'code' && x.attrs.hidden === undefined).length).toBe(0)
    expect(find(body[0], (x) => x.tag === 'code' && x.attrs.hidden !== undefined).length).toBeGreaterThan(3)
  })
  it('classic is unchanged: the hue glow at 22% and the night at 60% at the edge', () => {
    const cx = new Cascade(INDEX)
    const stops = backgroundLayers(cx.styled(sky(page(markup, null))).props.background)[0]
    expect(stops[0]).toEqual(parseColor(`hsl(${useHive.getState().swarms.s_lyra.hue} 80% 30% / 0.22)`).map((v, i) => (i < 3 ? v : 0.22)))
    expect(stops[stops.length - 1]).toEqual(parseColor('rgb(4 4 16 / 0.6)'))
  })
  for (const [name, , c] of ALL) {
    it(`${name}: the sky edge is the chrome's surface, and every belief sentence, sureness word and value reads on it`, () => {
      const cx = new Cascade(INDEX)
      const s = sky(page(markup, c))
      const stops = backgroundLayers(cx.styled(s).props.background)[0]
      const surface = parseColor(c.surface)
      expect(stops[stops.length - 1]).toEqual(parseColor(`color-mix(in srgb, rgb(${surface.slice(0, 3).join(' ')} / ${surface[3]}) 60%, transparent)`))
      const rows = textElements(find(s, (e) => e.tag === 'table')[0]).map((e) => measure(cx, e))
      expect(rows.filter((r) => r.el.tag === 'span' && r.el.parent?.attrs['data-belief'] !== undefined).length).toBeGreaterThan(3)
      worstOf(`swarm ${name}`, rows)
      expect(fails(rows)).toEqual([])
    })
  }
})

describe('MeTTa syntax, rendered, at the opacity it is drawn with (finding 2)', () => {
  const SRC = '(==> (--> $x (× "said" 0.9)) (head (inner (deeper (deepest y)))))'
  const on = (where: 'surface' | 'raised') =>
    `<section class="xc-dress"><div style="background:var(--xc-${where})">${renderToStaticMarkup(createElement(MeTTa, { src: SRC }))}</div></section>`
  it('renders every token kind, parentheses at four depths', () => {
    const code = find(page(on('surface'), still), (e) => e.tag === 'code')[0]
    const spans = find(code, (e) => e.tag === 'span' && !!e.attrs.style)
    for (const v of ['p0', 'p1', 'p2', 'p3', 'copula', 'var', 'num', 'str', 'head', 'sym']) expect(spans.some((e) => e.attrs.style.includes(`var(--metta-${v})`)), v).toBe(true)
  })
  for (const [name, , c] of ALL)
    for (const where of ['surface', 'raised'] as const)
      it(`${name} on the ${where}: every token reads, parentheses composited at their opacity`, () => {
        const cx = new Cascade(INDEX)
        const root = page(on(where), c)
        const rows = textElements(find(root, (e) => e.tag === 'code')[0]).map((e) => measure(cx, e))
        const parens = rows.filter((r) => r.el.attrs['aria-hidden'] === 'true')
        expect(parens.length).toBe(14)
        for (const p of parens) expect(cx.styled(p.el).props.opacity).toBe('0.85')
        // the measurement takes the opacity: the same glyph at full opacity reads higher
        const full = measure(cx, { ...parens[0].el, attrs: { ...parens[0].el.attrs, style: parens[0].el.attrs.style.replace(/;?opacity:[\d.]+/, '') } })
        expect(full.ratio).toBeGreaterThan(parens[0].ratio)
        worstOf(`metta ${name} ${where}`, rows)
        worstOf(`metta ${name} ${where}, parentheses`, parens)
        expect(fails(rows)).toEqual([])
      })
})

/**
 * ProgramForm hosting each fallback form (this release ships Commons and the case file). The forms are lazy; a first prerender loads them, after which a plain server
 * render returns the whole form inside the host's [data-app-form].
 */
type FormCase = { form: FormId; program: string; root: string; required: string[] }
const FORM_CASES: FormCase[] = [
  { form: 'commons', program: 'commons-explorer', root: 'cm', required: ['cm-title', 'cm-eyebrow', 'cm-lede'] },
  { form: 'case-file', program: 'contract-fixture', root: 'cf', required: ['cfc-eyebrow'] },
]
describe('ProgramForm hosting each fallback form in an experience it has no rendering for', () => {
  const html = async (el: ReactElement) => {
    const { prelude } = await prerender(el)
    for (const r = prelude.getReader(); !(await r.read()).done; );
    return renderToStaticMarkup(el)
  }
  for (const f of FORM_CASES) {
    const worn = (GRAMMARS as Grammar[]).filter((g) => dressedIn(f.form, g))
    const element = (grammar: Grammar) => {
      const program = useHive.getState().programs!.find((p) => p.id === f.program)!
      return createElement(ProgramForm, { form: f.form, program, swarmId: 's_lyra', grammar })
    }
    beforeAll(async () => {
      await useHive.getState().loadProgram(f.program)
      expect(formFor(f.program, useHive.getState().programDetails[f.program]?.describe ?? null)).toBe(f.form)
      await useHive.getState().openProgram(f.program, 's_lyra')
    })
    it(`${f.form}: classic and its own renderings are not dressed`, async () => {
      for (const g of ['classic', ...(GRAMMARS as Grammar[]).filter((x) => !worn.includes(x))] as Grammar[]) {
        const root = find(page(await html(element(g)), null), (e) => classes(e).includes(f.root))[0]
        expect(root, g).toBeDefined()
        expect('data-chrome' in root.attrs, g).toBe(false)
      }
    })
    for (const g of worn)
      for (const c of CHROMES[g]) {
        it(`${f.form} in ${g}/${c.scheme}: ProgramForm passes the experience, the form wears its tokens, and every text reads`, async () => {
          scheme.current = c.scheme
          vi.stubGlobal('document', { documentElement: { dataset: { xcScheme: c.scheme } } })
          let markup: string
          try {
            markup = await html(element(g))
          } finally {
            vi.stubGlobal('document', undefined)
          }
          const tree = page(markup, c)
          const host = find(tree, (e) => e.attrs['data-app-form'] === f.form)[0]
          expect(host).toBeDefined()
          const root = find(host, (e) => classes(e).includes(f.root))[0]
          expect(root).toBeDefined()
          expect(root.attrs['data-chrome']).toBe('')
          expect(root.attrs['data-host-grammar']).toBe(g)
          expect(root.attrs['data-scheme']).toBe(c.scheme)
          for (const r of f.required) expect(find(root, (e) => classes(e).includes(r)).length, r).toBeGreaterThan(0)
          const cx = new Cascade(INDEX, parseCss(css(FORM_CSS[f.form]!)))
          const st = cx.styled(root)
          expect(bottomColour(st.props.background)).toEqual(parseColor(c.surface))
          expect(parseColor(st.props.color)).toEqual(parseColor(c.ink))
          expect(st.props['font-family']).toBe(c.font)
          const rows = textElements(root).map((e) => measure(cx, e))
          expect(rows.length).toBeGreaterThan(10)
          worstOf(`${f.form} ${g}/${c.scheme}`, rows)
          expect(fails(rows)).toEqual([])
        })
      }
  }
})
