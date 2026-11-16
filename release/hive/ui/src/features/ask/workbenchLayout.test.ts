// Purpose: check that the workbench and conversation share the available viewport without covering decisions.
import { describe, expect, it } from 'vitest'
import { workbenchLayout } from './workbenchLayout'
import type { Placement } from './placement'

describe('Classic beside an open workbench drawer', () => {
  it.each([900, 1800])('leaves the desktop drawer clear at 1440 × %i', height => {
    const drawer = { left: 698, top: 68 }
    const { place, stacked } = workbenchLayout({ mode: 'desktop', left: 472, width: 640, bottom: 12 }, drawer, { height, contentLeft: 260, room: 140 })
    expect(stacked).toBe(false)
    expect(place.width).toBeGreaterThanOrEqual(300)
    expect(place.left).toBeGreaterThan(260)
    expect(place.left + place.width).toBeLessThan(drawer.left)
  })

  it.each([
    { mode: 'phone', width: 390, height: 844 },
    { mode: 'phone', width: 360, height: 740 },
    { mode: 'landscape', width: 844, height: 390 },
    { mode: 'desktop', width: 1024, height: 900 },
  ] as const)('shares the height when columns do not fit: $width × $height', ({ mode, width, height }) => {
    const place: Placement = { mode, left: 12, width: width - 24, bottom: 12 }
    const drawer = { left: mode === 'desktop' ? 300 : 0, top: height * .18 }
    const room = 140
    const layout = workbenchLayout(place, drawer, { height, contentLeft: 0, room })
    expect(layout.stacked).toBe(true)
    expect(layout.place).toBe(place)
    const threadTop = height - room - layout.maxThreadHeight!
    const drawerBottom = threadTop - 8
    expect(drawerBottom).toBeGreaterThan(drawer.top)
    expect(threadTop).toBeGreaterThan(drawerBottom)
    expect(layout.maxThreadHeight).toBeGreaterThan(0)
  })

  it('reserves no negative conversation height when a keyboard fills the viewport', () => {
    expect(workbenchLayout({ mode: 'phone', left: 12, width: 336, bottom: 12 }, { left: 0, top: 150 }, { height: 300, contentLeft: 0, room: 200 }).maxThreadHeight).toBe(0)
  })
})
