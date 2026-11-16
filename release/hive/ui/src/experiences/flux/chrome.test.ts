import { describe, expect, it } from 'vitest'
import { chrome } from './chrome'

/** WCAG 2 contrast of the Flux chrome, with the glass composited over the worst backdrop (black and white). */
type RGBA = [number, number, number, number]
const parse = (c: string): RGBA => {
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA
  const m = c.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/)
  if (!m) throw new Error(`unparsed colour ${c}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 1]
}
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA
const lum = (c: RGBA) => {
  const [r, g, b] = c.slice(0, 3).map((v) => {
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
const worst = (fg: string, bg: string) => Math.min(...BACKDROPS.map((d) => ratio(over(parse(fg), over(parse(bg), d)), over(parse(bg), d))))

export const CHROME_PAIRS: [string, string, string, number][] = [
  ['ink', chrome.ink, chrome.surface, 4.5],
  ['ink2', chrome.ink2, chrome.surface, 4.5],
  ['ink3', chrome.ink3, chrome.surface, 4.5],
  ['accent (as text)', chrome.accent, chrome.surface, 4.5],
  ['danger (as text)', chrome.danger, chrome.surface, 4.5],
  ['ink on raised', chrome.ink, chrome.raised, 4.5],
  ['ink2 on raised', chrome.ink2, chrome.raised, 4.5],
  ['ink3 on raised', chrome.ink3, chrome.raised, 4.5],
  ['onAccent on accent', chrome.onAccent, chrome.accent, 4.5],
  ['onDanger on danger', chrome.onDanger, chrome.danger, 4.5],
  ['edge on surface', chrome.edge, chrome.surface, 3],
]

describe('Flux chrome contrast', () => {
  it.each(CHROME_PAIRS)('%s', (_name, fg, bg, min) => {
    const r = worst(fg, bg)
    if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CHROME_TABLE) console.log(`| ${_name} | ${fg} | ${bg} | ${r.toFixed(2)}:1 | ${min}:1 |`)
    expect(r).toBeGreaterThanOrEqual(min)
  })
})
