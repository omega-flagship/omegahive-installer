import { describe, expect, it } from 'vitest'
import { contrast, mix } from '../../shell/appLook'
import { chrome as still } from '../../experiences/still/chrome'
import { ROLE, SOURCE_STATUS, toneInk } from './style'

/**
 * Demo audit P1 #7: in Still (a light chrome) the Omega Tools graph cards and Design's suggestion chips were dark
 * surfaces under Still's dark ink. Inside an experience the app surfaces now take the chrome's own (index.css .xc-dress),
 * and role/status pastels are drawn mostly in the ink there, so every pair passes WCAG AA (4.5:1).
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const SRC = new URL('../..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')
const block = (css: string, selector: string) => {
  const i = css.indexOf(`${selector} {`)
  expect(i, selector).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf('}', i))
}
const STATUS_COLOURS = ['#fbbf24', '#a1a1c2', '#fb7185']   // features/programs/parts.tsx STATUS_STYLE

describe('Still: app surfaces under the chrome ink', () => {
  const css = read('index.css')
  it('the dress re-points the app card and panel surfaces at the chrome', () => {
    const dress = block(css, 'html[data-xc-active] .xc-dress')
    expect(dress).toMatch(/--look-card: var\(--xc-raised\);/)
    expect(dress).toMatch(/--look-panel: color-mix\(in srgb, var\(--xc-surface\) 72%, transparent\);/)
  })
  it('the ink on a card (raised) passes AA, and so do the role and status labels at the light tint', () => {
    const light = block(css, "html[data-xc-active][data-xc-scheme='light'] .xc-dress")
    const tint = Number(light.match(/--tone-tint: (\d+)%;/)?.[1])
    expect(tint).toBeGreaterThan(0)
    for (const ink of [still.ink, still.ink2, still.ink3]) expect(contrast(ink, still.raised)).toBeGreaterThanOrEqual(4.5)
    const tones = [...Object.values(ROLE).map((r) => r.color), ...Object.values(SOURCE_STATUS).map((s) => s.color), ...STATUS_COLOURS]
    for (const c of tones) {
      const drawn = mix(c, still.ink, tint / 100)
      expect(contrast(drawn, still.raised), c).toBeGreaterThanOrEqual(4.5)
      expect(contrast(drawn, still.surface), c).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('the tone is the colour itself outside a light chrome (classic unchanged)', () => {
    expect(toneInk('#b4a6ff')).toBe('color-mix(in srgb, #b4a6ff var(--tone-tint, 100%), var(--color-ink))')
    expect(block(css, ':root')).not.toMatch(/--tone-tint/)
  })
  it("Design's glass is the chrome's raised surface inside an experience; the ink on it passes AA", () => {
    const dc = block(read('forms/designCanvas/designCanvas.css'), 'html[data-xc-active] .xc-dress .dc')
    expect(dc).toMatch(/--dc-glass: color-mix\(in srgb, var\(--xc-raised\) (\d+)%, transparent\);/)
    const pct = Number(dc.match(/var\(--xc-raised\) (\d+)%/)![1]) / 100
    const chip = mix(still.raised, still.surface, pct)   // the glass over Still's page
    expect(contrast(still.ink, chip)).toBeGreaterThanOrEqual(4.5)
  })
})
