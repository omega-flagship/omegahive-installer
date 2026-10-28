import { describe, expect, it, vi } from 'vitest'
import { DESKTOP, installSceneGlobals, makeEngine, PHONE, pointer, settle, SPRITES_MOCK } from './engineHarness.testkit'

/**
 * followups-r6, the hive map's fit, driven headless (engineHarness.testkit). INVENTED data only.
 * - item 2 (Kimi r5 #3): the old 72 px "dock" guess in fitZoom is gone; the docked Ask reports its own room.
 * - item 3 (stand-in r5 #2): a camera the person moved (zoom buttons, wheel, pinch, drag) or flew to a dot is never
 *   refitted when the Ask's room arrives; a right-only inset (a desktop sheet) never refits at all.
 * - item 4 (Kimi r5 #7, #8): a resize refits a fit nobody has moved (and never a moved camera); a dot flight's zoom is
 *   clamped again to the free region when the insets (or the size) change, until the person zooms themselves.
 */

vi.mock('./sprites', () => SPRITES_MOCK)
installSceneGlobals()

/** The universe as drawn: the top of its highest name or outline, the bottom of its lowest outline, and the zoom. */
async function overviewWith(askRoom: number) {
  const { e, inner } = await makeEngine(1440, 900)
  e.setInsets({ ...DESKTOP.hud, bottom: Math.max(DESKTOP.hud.bottom, askRoom) })
  e.overview(true)
  settle(inner)
  const shown = e.galaxyScreens().filter((g) => g.visible)
  const labels = e.galaxyLabelBoxes()
  const top = Math.min(...shown.map((g) => g.sy - g.sr), ...labels.map((b) => b.top))
  const bottom = Math.max(...shown.map((g) => g.sy + g.sr), ...labels.map((b) => b.bottom))
  return { z: inner.camT.z, top, bottom, mid: (top + bottom) / 2, labels }
}

describe('item 2: no extra "dock" room under the universe (the Ask reports its own)', () => {
  it('a short Ask (48 px room, under the old 60 px threshold): everything is between the HUD and the Ask', async () => {
    const f = await overviewWith(48)
    expect(f.labels.length).toBeGreaterThanOrEqual(2)
    expect(f.top).toBeGreaterThanOrEqual(DESKTOP.hud.top)
    expect(f.bottom).toBeLessThanOrEqual(900 - 48)
  })
  it('a 48 px room fits the universe as a 61 px room does, give or take those 13 px: no 72 px jump at 60', async () => {
    const short = await overviewWith(48)
    const over = await overviewWith(61)
    // less room taken never makes the universe smaller
    expect(short.z).toBeGreaterThanOrEqual(over.z)
    // and never lifts it: 13 px less below moves the middle of the free region down by 6.5 px, nothing more
    // (the dock term lifted it by 36 px and shrank it)
    expect(Math.abs(short.mid - over.mid)).toBeLessThanOrEqual(8)
  })
  it('the universe sits in the middle of the free region (the label room above it aside), whatever the Ask’s room', async () => {
    for (const room of [48, 82, 150]) {
      const f = await overviewWith(room)
      const free = { top: DESKTOP.hud.top, bottom: 900 - Math.max(DESKTOP.hud.bottom, room) }
      const above = f.top - free.top
      const below = free.bottom - f.bottom
      // equal slack above and below, within a few px (names are measured text, the room above is a fixed 30 px)
      expect(Math.abs(above - below), `room ${room}: above ${above.toFixed(1)}, below ${below.toFixed(1)}`).toBeLessThanOrEqual(12)
    }
  })
})

/** The Ask arrives (or grows): what AskHost's room does to the insets. */
const ASK_ARRIVES = { ...DESKTOP.hud, bottom: DESKTOP.askRoom }

/** Landed in the universe overview, settled, with the HUD's insets only: a fit nobody has moved. */
async function fitted() {
  const t = await makeEngine(1440, 900)
  t.e.setInsets(DESKTOP.hud)
  t.e.overview(true)
  settle(t.inner)
  return t
}

describe('item 3: a camera the person moved is never refitted', () => {
  it('control: a fit nobody moved IS refitted when the Ask’s room arrives (so the cases below are not vacuous)', async () => {
    const { e, inner } = await fitted()
    const before = { ...inner.camT }
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT).not.toEqual(before)
  })
  it('flying to a dot directly (flyToDot): the inset change leaves the flight where it is going', async () => {
    const { e, inner, agents } = await fitted()
    e.flyToDot(agents[0].id)
    const before = { ...inner.camT }
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT).toEqual(before)
  })
  it('selecting a dot (setSelected, which flies to it): the same', async () => {
    const { e, inner, agents } = await fitted()
    e.setSelected(agents[3].id)
    const before = { ...inner.camT }
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT).toEqual(before)
  })
  it('the zoom buttons (zoomBy)', async () => {
    const { e, inner, moved } = await fitted()
    e.zoomBy(1.4)
    expect(moved.length).toBeGreaterThan(0)
    const before = { ...inner.camT }
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT).toEqual(before)
  })
  it('the wheel (or a trackpad pinch, which arrives as a ctrl-wheel)', async () => {
    for (const ctrlKey of [false, true]) {
      const { e, inner, moved } = await fitted()
      inner.onWheel({ ...pointer(1, 700, 400, 'mouse'), deltaY: -120, ctrlKey })
      expect(moved.length).toBeGreaterThan(0)
      const before = { ...inner.camT }
      e.setInsets(ASK_ARRIVES)
      expect(inner.camT, `ctrlKey ${ctrlKey}`).toEqual(before)
    }
  })
  it('a two-finger pinch on a touch screen', async () => {
    const { e, inner, moved } = await fitted()
    inner.onDown(pointer(1, 600, 450))
    inner.onDown(pointer(2, 800, 450))
    inner.onMove(pointer(2, 900, 470))   // the fingers spread: zoom in
    inner.onUp(pointer(2, 900, 470))
    inner.onUp(pointer(1, 600, 450))
    expect(moved.length).toBeGreaterThan(0)
    const before = { ...inner.camT }
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT).toEqual(before)
  })
  it('a one-finger drag', async () => {
    const { e, inner, moved } = await fitted()
    inner.onDown(pointer(1, 700, 450))
    inner.onMove(pointer(1, 760, 480))
    inner.onUp(pointer(1, 760, 480))
    expect(moved.length).toBeGreaterThan(0)
    const before = { ...inner.camT }
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT).toEqual(before)
  })
  it('a right-only inset (a desktop sheet opens on the right) never refits: not a fit nobody moved, not a moved camera', async () => {
    const untouched = await fitted()
    const before = { ...untouched.inner.camT }
    untouched.e.setInsets({ ...DESKTOP.hud, right: 472 })
    expect(untouched.inner.camT).toEqual(before)
    untouched.e.setInsets(DESKTOP.hud)
    expect(untouched.inner.camT).toEqual(before)

    // on a phone the overview's zoom is set by the width, so a refit WOULD move it: it must not
    const phone = await makeEngine(390, 844)
    phone.e.setInsets(PHONE.hud)
    phone.e.overview(true)
    settle(phone.inner)
    const phoneFit = { ...phone.inner.camT }
    phone.e.setInsets({ ...PHONE.hud, right: 120 })
    expect(phone.inner.camT).toEqual(phoneFit)

    const moved = await fitted()
    moved.e.panBy(-90, 30)
    const after = { ...moved.inner.camT }
    moved.e.setInsets({ ...DESKTOP.hud, right: 472 })
    expect(moved.inner.camT).toEqual(after)
  })
})

describe('item 4: a resize refits a fit nobody moved', () => {
  /** The camera a fit computes at this size from scratch: what a resized fit must equal. */
  async function freshFit(w: number, h: number, galaxy: string | null) {
    const { e, inner } = await makeEngine(w, h)
    e.setInsets(ASK_ARRIVES)
    if (galaxy) e.flyToGalaxy(galaxy)
    else e.overview(true)
    return { ...inner.camT }
  }
  for (const galaxy of [null, 'hive:user:p_ada']) {
    it(`${galaxy ? 'landed in a galaxy' : 'the universe overview'}: 1440x900 resized to 1024x640 is the fit for 1024x640`, async () => {
      const { e, inner, canvas } = await makeEngine(1440, 900)
      e.setInsets(ASK_ARRIVES)
      if (galaxy) e.flyToGalaxy(galaxy)
      else e.overview(true)
      settle(inner)
      const big = { ...inner.camT }
      canvas.size.w = 1024
      canvas.size.h = 640
      e.resize()
      expect(inner.camT).not.toEqual(big)
      const want = await freshFit(1024, 640, galaxy)
      expect(inner.camT.x).toBeCloseTo(want.x, 6)
      expect(inner.camT.y).toBeCloseTo(want.y, 6)
      expect(inner.camT.z).toBeCloseTo(want.z, 6)
    })
  }
  it('a camera the person moved is not refitted by a resize', async () => {
    const { e, inner, canvas } = await fitted()
    e.zoomBy(1.3)
    e.panBy(40, -20)
    const before = { ...inner.camT }
    canvas.size.w = 1024
    canvas.size.h = 640
    e.resize()
    expect(inner.camT).toEqual(before)
  })
  it('a new pixel ratio alone (same size) refits nothing', async () => {
    const { e, inner } = await fitted()
    e.zoomBy(1)   // the person's camera now, at the fit's own place
    const before = { ...inner.camT }
    e.resize()
    expect(inner.camT).toEqual(before)
  })
})

describe('item 4: a dot flight clamps its zoom again when the insets change', () => {
  /** 2.1 at most, else what the free region allows (its shorter side / 300), never below 0.6. */
  const expected = (free: number) => Math.max(0.6, Math.min(2.1, free / 300))
  it('a tall Ask (500 px room) arrives while following a dot: the zoom drops to what the free region allows; it goes back when the Ask shrinks', async () => {
    const { e, inner, agents } = await fitted()
    e.flyToDot(agents[0].id)
    expect(inner.camT.z).toBeCloseTo(2.1, 6)
    e.setInsets({ ...DESKTOP.hud, bottom: 500 })
    expect(inner.camT.z).toBeCloseTo(expected(900 - 76 - 500), 6)
    e.setInsets(ASK_ARRIVES)
    expect(inner.camT.z).toBeCloseTo(2.1, 6)
  })
  it('a wide sheet on the right narrows the free region: the zoom follows it', async () => {
    const { e, inner, agents } = await fitted()
    e.flyToDot(agents[1].id)
    e.setInsets({ ...DESKTOP.hud, right: 1000 })
    expect(inner.camT.z).toBeCloseTo(expected(1440 - 60 - 1000), 6)
  })
  it('a resize while following clamps it too', async () => {
    const { e, inner, canvas, agents } = await fitted()
    e.flyToDot(agents[2].id)
    canvas.size.w = 390
    canvas.size.h = 844
    e.resize()
    expect(inner.camT.z).toBeCloseTo(expected(390 - 60), 6)
  })
  it('once the person zooms, the zoom is theirs: an inset change leaves it', async () => {
    const { e, inner, agents } = await fitted()
    e.flyToDot(agents[0].id)
    e.zoomBy(0.8)
    const z = inner.camT.z
    e.setInsets({ ...DESKTOP.hud, bottom: 500 })
    expect(inner.camT.z).toBe(z)
  })
  it('after the dot is let go (flown elsewhere), an inset change does not touch the zoom as a dot flight', async () => {
    const { e, inner, agents } = await fitted()
    e.flyToDot(agents[0].id)
    e.flyToSwarm('s_1_0')
    const before = { ...inner.camT }
    e.setInsets({ ...DESKTOP.hud, bottom: 500 })
    expect(inner.camT).toEqual(before)
  })
})
