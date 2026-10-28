import { describe, expect, it } from 'vitest'
import { contrast } from '../../experiences/canvas/contrast'
import { PALETTES, TEXT_PAIRS, UI_PAIRS, type PaletteId } from './palette'

/** WCAG 2.x contrast of every text pair (4.5:1) and control pair (3:1) in every rendering. Printed on every run. */
describe('commons contrast', () => {
  const rows: string[] = []
  for (const id of Object.keys(PALETTES) as PaletteId[]) {
    const p = PALETTES[id]
    for (const [name, fg, bg] of TEXT_PAIRS) {
      const r = contrast(p[fg], p[bg])
      rows.push(`${id.padEnd(13)} ${name.padEnd(26)} ${p[fg]} on ${p[bg]}  ${r.toFixed(2)}`)
      it(`${id}: ${name} ${r.toFixed(2)} >= 4.5`, () => expect(r).toBeGreaterThanOrEqual(4.5))
    }
    for (const [name, fg, bg] of UI_PAIRS) {
      const r = contrast(p[fg], p[bg])
      rows.push(`${id.padEnd(13)} ${name.padEnd(26)} ${p[fg]} on ${p[bg]}  ${r.toFixed(2)} (3:1)`)
      it(`${id}: ${name} ${r.toFixed(2)} >= 3`, () => expect(r).toBeGreaterThanOrEqual(3))
    }
  }
  it('prints the table', () => {
    console.log('\n' + rows.join('\n'))
    expect(rows.length).toBe((TEXT_PAIRS.length + UI_PAIRS.length) * 4)
  })
})
