import { describe, expect, it } from 'vitest'
import { inkWidth } from './layers'

// r2, Kimi FIX-FIRST 5: ink stays inside the layer
describe('ink is clamped inside the layer', () => {
  it('clamps a mark, and the arrow or tick drawn to its right, inside the layer', () => {
    expect(inkWidth('underline', 100, 400, 1000)).toBe(300)
    expect(inkWidth('arrow', 100, 980, 1000) + 100 + 50).toBeLessThanOrEqual(1000)
    expect(inkWidth('tick', 100, 990, 1000) + 100 + 30).toBeLessThanOrEqual(1000)
    expect(inkWidth('underline', 100, 2000, 1000)).toBeLessThanOrEqual(900)
    expect(inkWidth('arrow', 990, 995, 1000)).toBeGreaterThanOrEqual(8)
  })
})
