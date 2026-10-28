import { describe, expect, it } from 'vitest'
import { chrome } from './chrome'

/** WCAG 2.x relative luminance and contrast for #rrggbb. */
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('window chrome contrast (WCAG 2.x)', () => {
  const text: [string, string, string, number][] = [
    ['ink', chrome.ink, 'surface', 4.5],
    ['ink2', chrome.ink2, 'surface', 4.5],
    ['ink3', chrome.ink3, 'surface', 4.5],
    ['accent', chrome.accent, 'surface', 4.5],
    ['danger', chrome.danger, 'surface', 4.5],
    ['ink', chrome.ink, 'raised', 4.5],
    ['ink2', chrome.ink2, 'raised', 4.5],
    ['ink3', chrome.ink3, 'raised', 4.5],
    ['accent', chrome.accent, 'raised', 4.5],
    ['danger', chrome.danger, 'raised', 4.5],
    ['onAccent', chrome.onAccent, 'accent', 4.5],
    ['onDanger', chrome.onDanger, 'danger', 4.5],
    ['edge', chrome.edge, 'surface', 3],
  ]
  const bg = (k: string) => (k === 'surface' ? chrome.surface : k === 'raised' ? chrome.raised : k === 'accent' ? chrome.accent : chrome.danger)
  it.each(text)('%s (%s) on %s ≥ %s:1', (_name, fg, on, min) => {
    const r = ratio(fg, bg(on))
    if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CHROME_TABLE) console.log(`| ${_name} | ${fg} | ${on} ${bg(on)} | ${r.toFixed(2)}:1 |`)
    expect(r).toBeGreaterThanOrEqual(min)
  })
})
