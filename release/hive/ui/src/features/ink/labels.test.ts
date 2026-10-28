import { describe, expect, it } from 'vitest'
import { dialogTitle, labelTop } from './labels'

// Where a showreel mark's label sits: above the mark, below it when there is no room above or when above would cover
// the title of the dialog the mark is in (a D4 follow-up: labels sat over dialog titles).

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

describe('a mark label keeps off its dialog’s title', () => {
  it('above the mark when there is room and nothing to keep off', () => {
    expect(labelTop(box(100, 300, 200, 330), 100, 900)).toBe(266)
    expect(labelTop(box(100, 300, 200, 330), 100, 900, null)).toBe(266)
  })
  it('below the mark when there is no room above', () => {
    expect(labelTop(box(100, 20, 200, 50), 100, 900)).toBe(64)
    expect(labelTop(box(100, 880, 200, 899), 100, 900, null)).toBe(846)
  })
  it('below the mark when above would cover the dialog’s title', () => {
    const title = box(80, 250, 400, 280)
    expect(labelTop(box(100, 300, 200, 330), 100, 900, title)).toBe(344)
  })
  it('above when the title is elsewhere (beside or well above the label)', () => {
    expect(labelTop(box(100, 300, 200, 330), 100, 900, box(400, 260, 600, 290))).toBe(266)
    expect(labelTop(box(100, 300, 200, 330), 100, 900, box(80, 100, 400, 130))).toBe(266)
  })
  it('finds the title by the dialog’s aria-labelledby, else its first heading; none outside a dialog', () => {
    const h = { id: 'h' }
    const byId = { getAttribute: () => 'h other', ownerDocument: { getElementById: (id: string) => (id === 'h' ? h : null) }, querySelector: () => null }
    const el = (d: unknown) => ({ closest: () => d }) as unknown as Element
    expect(dialogTitle(el(byId))).toBe(h)
    const h2 = { tag: 'h2' }
    const byHeading = { getAttribute: () => null, ownerDocument: { getElementById: () => null }, querySelector: () => h2 }
    expect(dialogTitle(el(byHeading))).toBe(h2)
    expect(dialogTitle(el(null))).toBeNull()
    expect(dialogTitle(null)).toBeNull()
  })
})
