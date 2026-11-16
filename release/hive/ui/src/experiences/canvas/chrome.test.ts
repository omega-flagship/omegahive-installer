import { describe, expect, it } from 'vitest'
import { chromeForMode } from './chrome'
import { contrast } from './contrast'

/** Canvas's window chrome, both board modes: text >= 4.5:1, control edges >= 3:1 (WCAG 2.x), on surface and raised. */
describe.each(['light', 'dark'] as const)('Canvas window chrome (%s)', (mode) => {
  const c = chromeForMode(mode)
  const cases: [string, string, string, number][] = [
    ['ink', c.ink, c.surface, 4.5],
    ['ink2', c.ink2, c.surface, 4.5],
    ['ink3', c.ink3, c.surface, 4.5],
    ['accent', c.accent, c.surface, 4.5],
    ['danger', c.danger, c.surface, 4.5],
    ['ink on raised', c.ink, c.raised, 4.5],
    ['ink2 on raised', c.ink2, c.raised, 4.5],
    ['ink3 on raised', c.ink3, c.raised, 4.5],
    ['accent on raised', c.accent, c.raised, 4.5],
    ['onAccent', c.onAccent, c.accent, 4.5],
    ['onDanger', c.onDanger, c.danger, 4.5],
    ['edge', c.edge, c.surface, 3],
  ]
  it.each(cases)('%s', (_n, fg, bg, min) => expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min))
  it('is flat and product-grade: no blur, 12px windows', () => {
    expect(c.material).toBe('none')
    expect(c.radius).toBe('12px')
    expect(c.scheme).toBe(mode)
  })
})
