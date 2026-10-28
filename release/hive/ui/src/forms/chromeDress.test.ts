import { describe, expect, it } from 'vitest'
import type { ExperienceChrome } from '../experiences/chrome'
import { chromeForMode } from '../experiences/canvas/chrome'
import { chrome as construct } from '../experiences/construct/chrome'
import { chrome as cosmos } from '../experiences/cosmos/chrome'
import { chrome as flux } from '../experiences/flux/chrome'
import { chrome as still } from '../experiences/still/chrome'
import { dressedIn } from './chromeDress'
import * as commons from './commons/palette'
import { GRAMMARS, type FormId, type Grammar } from './contract'

/**
 * A form in an experience it has no rendering for wears that experience's chrome (chromeDress.ts). Every text pair
 * (4.5:1) and control pair (3:1) of its chrome palette is measured here on each chrome it is actually worn in, with
 * translucent surfaces composited over the worst backdrop (black and white), as the experiences' own chrome tests do.
 */

type RGBA = [number, number, number, number]
const parse = (c: string): RGBA => {
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA
  const rgb = c.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[/,]\s*([\d.]+))?\)$/)
  if (!rgb) throw new Error(`unparsed colour ${c}`)
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1]
}
const VAR: Record<string, keyof ExperienceChrome> = {
  '--xc-surface': 'surface',
  '--xc-raised': 'raised',
  '--xc-ink': 'ink',
  '--xc-ink-2': 'ink2',
  '--xc-ink-3': 'ink3',
  '--xc-line': 'line',
  '--xc-edge': 'edge',
  '--xc-accent': 'accent',
  '--xc-on-accent': 'onAccent',
  '--xc-danger': 'danger',
}
/** A palette value as the browser resolves it on this chrome: a colour, var(--xc-*), or color-mix(in srgb, A p%, B). */
function resolve(v: string, c: ExperienceChrome): RGBA {
  const ref = v.match(/^var\((--xc-[\w-]+)\)$/)
  if (ref) return parse(c[VAR[ref[1]]] as string)
  const mix = v.match(/^color-mix\(in srgb, (var\([\w-]+\)|#[0-9a-f]{6}) ([\d.]+)%, (var\([\w-]+\)|#[0-9a-f]{6})\)$/i)
  if (mix) {
    const [a, b, p] = [resolve(mix[1], c), resolve(mix[3], c), Number(mix[2]) / 100]
    const alpha = a[3] * p + b[3] * (1 - p)
    return [0, 1, 2].map((i) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha).concat(alpha) as RGBA
  }
  return parse(v)
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
const BACKDROPS: RGBA[] = [parse('#000000'), parse('#ffffff')]
const worst = (fg: RGBA, bg: RGBA) =>
  Math.min(...BACKDROPS.map((d) => ratio(over(fg, over(bg, d)), over(bg, d))))

const CHROMES: Record<string, ExperienceChrome[]> = {
  still: [still],
  cosmos: [cosmos],
  construct: [construct],
  flux: [flux],
  canvas: [chromeForMode('light'), chromeForMode('dark')],
}

type Pairs = [string, string, string][]
const FORMS: { id: FormId; palette: (s: 'light' | 'dark') => Record<string, string>; text: Pairs; ui: Pairs }[] = [
  { id: 'commons', palette: commons.chromePalette as never, text: commons.TEXT_PAIRS, ui: commons.UI_PAIRS },
]

describe('forms dressed in an experience chrome', () => {
  const rows: string[] = []
  for (const f of FORMS) {
    const worn = (GRAMMARS as Grammar[]).filter((g) => dressedIn(f.id, g))
    it(`${f.id} is dressed exactly where it has no rendering of its own`, () => {
      expect(worn.length).toBeGreaterThan(0)
      expect(dressedIn(f.id, 'classic')).toBe(false)
    })
    for (const g of worn) {
      for (const c of CHROMES[g]) {
        const p = f.palette(c.scheme)
        for (const [pairs, min] of [[f.text, 4.5], [f.ui, 3]] as [Pairs, number][]) {
          for (const [name, fg, bg] of pairs) {
            const r = worst(resolve(p[fg], c), resolve(p[bg], c))
            rows.push(`${f.id.padEnd(10)} ${`${g}/${c.scheme}`.padEnd(16)} ${name.padEnd(28)} ${r.toFixed(2)} (${min}:1)`)
            it(`${f.id} in ${g} (${c.scheme}): ${name} ${r.toFixed(2)} >= ${min}`, () => expect(r).toBeGreaterThanOrEqual(min))
          }
        }
      }
    }
  }
  it('Commons is dressed in the experiences the audit found them undressed in', () => {
    expect(['cosmos', 'construct', 'flux'].every((g) => dressedIn('commons', g as Grammar))).toBe(true)
    expect(['still', 'canvas'].some((g) => dressedIn('commons', g as Grammar))).toBe(false)
  })
  it('prints the table', () => {
    console.log('\n' + rows.join('\n'))
    expect(rows.length).toBeGreaterThan(0)
  })
})

// The Lab tiles, the swarm sky and MeTTa are measured as rendered, with the real stylesheets, in readability.test.ts.
