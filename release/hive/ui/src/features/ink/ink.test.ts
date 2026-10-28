import { describe, expect, it } from 'vitest'
import { markElement } from './ink'

// Guided-play r1.2b: a mark bound to the element the player chose draws on that element only. When it disconnects
// there is no mark; the mark's targets are never matched again (that could be a different element).
describe('markElement', () => {
  const node = (connected: boolean) => ({ isConnected: connected }) as unknown as Element
  it('a bound mark draws on its own element while it is on the page', () => {
    const own = node(true)
    let asked = 0
    expect(markElement({ el: own }, () => (asked++, node(true)))).toBe(own)
    expect(asked).toBe(0)
  })
  it('a bound element that disconnects gives no mark, and the targets are not matched again', () => {
    let asked = 0
    const other = node(true)
    expect(markElement({ el: node(false) }, () => (asked++, other))).toBeNull()
    expect(asked).toBe(0)
  })
  it('an unbound mark (the showreel) is found from its targets', () => {
    const found = node(true)
    expect(markElement({}, () => found)).toBe(found)
    expect(markElement({}, () => null)).toBeNull()
  })
})
