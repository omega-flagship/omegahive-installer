import { describe, expect, it } from 'vitest'
import { anchoredBox } from './anchoredBox'

/** A box opening from a button: under it, right edges together, inside the window; above it when there is no room. */
const view = { width: 1440, height: 900 }
const box = { width: 320, height: 240 }

describe('a box opening from a button', () => {
  it('opens under the button with their right edges together', () => {
    expect(anchoredBox({ top: 90, right: 1200, bottom: 126 }, box, view)).toEqual({ top: 134, left: 880 })
  })
  it('moves right to stay inside the window when the button is near its left edge', () => {
    // a mind panel's Public or Private button sits at the panel's left, near the middle of the window or its left side
    expect(anchoredBox({ top: 90, right: 100, bottom: 126 }, box, view).left).toBe(8)
  })
  it('moves left to stay inside a narrow window', () => {
    expect(anchoredBox({ top: 90, right: 400, bottom: 126 }, box, { width: 390, height: 844 }).left).toBe(390 - 8 - 320)
  })
  it('opens above the button when there is no room below, and below when there is room nowhere else', () => {
    expect(anchoredBox({ top: 800, right: 1200, bottom: 836 }, box, view).top).toBe(800 - 8 - 240)
    expect(anchoredBox({ top: 100, right: 1200, bottom: 136 }, { width: 320, height: 880 }, view).top).toBe(144)
  })
})
