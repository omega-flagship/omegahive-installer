import { describe, expect, it } from 'vitest'
import { contrast } from '../../experiences/canvas/contrast'
import { PALETTES, TEXT_PAIRS, type CaseGrammar } from './palette'

/** WCAG 2.x contrast of every text pair in every grammar. The table is printed on every run. */
describe('case file contrast (WCAG AA text, 4.5:1)', () => {
  const rows: string[] = []
  for (const g of Object.keys(PALETTES) as CaseGrammar[]) {
    for (const [name, fg, bg] of TEXT_PAIRS) {
      const p = PALETTES[g]
      const r = contrast(p[fg], p[bg])
      rows.push(`${g.padEnd(9)} ${name.padEnd(26)} ${p[fg]} on ${p[bg]}  ${r.toFixed(2)}`)
      it(`${g}: ${name} ${r.toFixed(2)}`, () => expect(r).toBeGreaterThanOrEqual(4.5))
    }
  }
  it('prints the table', () => {
    console.log('\n' + rows.join('\n'))
    expect(rows.length).toBe(TEXT_PAIRS.length * 3)
  })
})
