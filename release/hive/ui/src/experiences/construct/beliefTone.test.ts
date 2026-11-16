import { describe, expect, it } from 'vitest'
import { beliefTone, bySureness } from './model'

/**
 * uifix-r3.2, r3.6 (stand-in P1 on r3.5): the terminal `beliefs` table tints by the one sureness decision and orders by
 * NAL expectation. r3.2 tinted "tentative" amber like "doubts it", so {f 1, c 0} looked like a doubt; it is neutral now.
 */
describe('construct beliefs: tint from the sureness decision, order from the NAL scale', () => {
  it.each([
    [{ f: 0.5, c: 0.9 }, 'txt'], // tentative (e 0.5): neutral
    [{ f: 0.39, c: 0.5 }, 'amber'], // doubts it
    [{ f: 0.1, c: 0.1 }, 'txt'], // tentative: no evidence
    [{ f: 0.3, c: 0.1 }, 'txt'], // tentative, f under 0.4
    [{ f: 1, c: 0 }, 'txt'], // the stand-in's case: tentative, never amber
    [{ f: 0, c: 0.29 }, 'txt'], // below the floor
    [{ f: 0, c: 0.3 }, 'amber'], // at the floor: doubts it
    [{ f: 0.7, c: 0.5 }, 'hi'], // fairly sure
    [{ f: 0.95, c: 0.9 }, 'hi'], // near certain
  ] as const)('%o → %s', (tv, tone) => {
    expect(beliefTone(tv)).toBe(tone)
  })
  it('strongest NAL expectation first: a confident "no" sorts below a weak "yes"', () => {
    const rows = [
      { id: 'no', tv: { f: 0.1, c: 0.9 } }, // e 0.14 (c·f 0.09)
      { id: 'weak', tv: { f: 0.6, c: 0.1 } }, // e 0.51 (c·f 0.06)
      { id: 'yes', tv: { f: 0.95, c: 0.9 } }, // e 0.905
    ]
    expect([...rows].sort(bySureness).map((r) => r.id)).toEqual(['yes', 'weak', 'no'])
  })
})
