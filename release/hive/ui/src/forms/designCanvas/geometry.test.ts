import { describe, expect, it } from 'vitest'
import { fit, handlePoint, keepVisible, MAX_SCALE, MIN_SCALE, overlapArea, pinch, placeRing, resizeBox, snap, toArt, toScreen, wheel, zoomAt } from './geometry'

const RESERVE = { top: 64, right: 0, bottom: 84, left: 0 }

describe('the artboard fits clear of the reserved bands', () => {
  it('fits inside the stage minus the top line and the Ask band, centred, never above 100 %', () => {
    const v = fit({ width: 1280, height: 720 }, { width: 1440, height: 900 }, RESERVE)
    const tl = toScreen(v, { x: 0, y: 0 })
    const br = toScreen(v, { x: 1280, y: 720 })
    expect(tl.y).toBeGreaterThanOrEqual(64 + 24 - 1)
    expect(br.y).toBeLessThanOrEqual(900 - 84 - 24 + 1)
    expect(Math.abs(tl.x - (1440 - br.x))).toBeLessThanOrEqual(1)   // centred
    expect(fit({ width: 200, height: 100 }, { width: 1440, height: 900 }, RESERVE).scale).toBe(1)
  })
  it('a portrait design on a phone, and a landscape one on a short landscape screen, stay inside', () => {
    for (const [art, stage, reserve] of [
      [{ width: 900, height: 1200 }, { width: 390, height: 844 }, { top: 104, right: 0, bottom: 136, left: 0 }],
      [{ width: 1280, height: 720 }, { width: 844, height: 390 }, RESERVE],
    ] as const) {
      const v = fit(art, stage, reserve)
      const br = toScreen(v, { x: art.width, y: art.height })
      const tl = toScreen(v, { x: 0, y: 0 })
      expect(tl.x).toBeGreaterThanOrEqual(0)
      expect(br.x).toBeLessThanOrEqual(stage.width)
      expect(tl.y).toBeGreaterThanOrEqual(reserve.top)
      expect(br.y).toBeLessThanOrEqual(stage.height - reserve.bottom + 1)
    }
  })
})

describe('pan and zoom', () => {
  const v0 = { scale: 0.5, tx: 100, ty: 50 }
  it('zooms about a point that stays put, within bounds', () => {
    const at = { x: 400, y: 300 }
    const before = toArt(v0, at)
    const v = zoomAt(v0, 2, at)
    expect(toArt(v, at).x).toBeCloseTo(before.x)
    expect(toArt(v, at).y).toBeCloseTo(before.y)
    expect(zoomAt(v0, 1e6, at).scale).toBe(MAX_SCALE)
    expect(zoomAt(v0, 1e-6, at).scale).toBe(MIN_SCALE)
  })
  it('the wheel pans; with ⌘/Ctrl (and a trackpad pinch) it zooms', () => {
    expect(wheel(v0, { deltaX: 10, deltaY: 20, ctrlKey: false, metaKey: false }, { x: 0, y: 0 })).toEqual({ scale: 0.5, tx: 90, ty: 30 })
    expect(wheel(v0, { deltaX: 0, deltaY: -100, ctrlKey: true, metaKey: false }, { x: 0, y: 0 }).scale).toBeGreaterThan(0.5)
    expect(wheel(v0, { deltaX: 0, deltaY: 3, ctrlKey: false, metaKey: false, deltaMode: 1 }, { x: 0, y: 0 }).ty).toBe(50 - 48)
  })
  it('two fingers: spread zooms in about their centre, moving together pans', () => {
    const z = pinch(v0, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 50, y: 100 }, { x: 250, y: 100 }])
    expect(z.scale).toBeCloseTo(1)
    expect(toArt(z, { x: 150, y: 100 }).x).toBeCloseTo(toArt(v0, { x: 150, y: 100 }).x)
    const p = pinch(v0, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 130, y: 120 }, { x: 230, y: 120 }])
    expect(p).toMatchObject({ scale: 0.5, tx: 130, ty: 70 })
  })
  it('never loses the artboard off screen', () => {
    const v = keepVisible({ scale: 1, tx: -5000, ty: 9000 }, { width: 1000, height: 500 }, { width: 800, height: 600 })
    expect(v.tx + 1000).toBeGreaterThanOrEqual(80)
    expect(v.ty).toBeLessThanOrEqual(600 - 80)
  })
})

describe('the ring sits beside the selection, inside the free area', () => {
  const stage = { width: 1440, height: 900 }
  const ring = { width: 300, height: 44 }
  it('above when there is room, else below, else beside, else inside', () => {
    expect(placeRing({ x: 500, y: 300, width: 200, height: 100 }, ring, stage, RESERVE)).toEqual({ x: 450, y: 246, side: 'above' })
    expect(placeRing({ x: 500, y: 80, width: 200, height: 100 }, ring, stage, RESERVE).side).toBe('below')
    expect(placeRing({ x: 100, y: 70, width: 300, height: 700 }, ring, stage, RESERVE).side).toBe('right')
    expect(placeRing({ x: 1100, y: 70, width: 330, height: 700 }, ring, stage, RESERVE).side).toBe('left')
    expect(placeRing({ x: 0, y: 0, width: 1440, height: 900 }, ring, stage, RESERVE).side).toBe('inside')
  })
  it('never under the top line, the Ask band or off the sides', () => {
    for (const box of [{ x: -200, y: 500, width: 100, height: 50 }, { x: 1400, y: 500, width: 100, height: 50 }, { x: 600, y: 760, width: 100, height: 40 }]) {
      const r = placeRing(box, ring, stage, RESERVE)
      expect(r.x).toBeGreaterThanOrEqual(8)
      expect(r.x + ring.width).toBeLessThanOrEqual(stage.width - 8)
      expect(r.y).toBeGreaterThanOrEqual(64 + 8)
      expect(r.y + ring.height).toBeLessThanOrEqual(900 - 84 - 8)
    }
  })
})

describe('guides and resizing', () => {
  it('snaps edges and centres to the artboard and the other elements, within the threshold', () => {
    const s = snap({ x: 497, y: 10, width: 6, height: 20 }, [], { width: 1000, height: 600 }, 5)
    expect(s.x).toBe(497)   // its centre (500) already sits on the artboard centre
    expect(s.guides).toContainEqual({ axis: 'x', at: 500 })
    const t = snap({ x: 103, y: 203, width: 50, height: 50 }, [{ x: 100, y: 400, width: 200, height: 10 }], { width: 1000, height: 1000 }, 5)
    expect(t.x).toBe(100)
    expect(t.guides).toContainEqual({ axis: 'x', at: 100 })
    expect(snap({ x: 300, y: 300, width: 50, height: 50 }, [], { width: 1000, height: 1000 }, 5).guides).toEqual([])
  })
  it('drags an edge or a corner, never below the minimum, keeping the opposite side', () => {
    const r = { x: 100, y: 100, width: 200, height: 100 }
    expect(resizeBox(r, 'se', 50, 20)).toEqual({ x: 100, y: 100, width: 250, height: 120 })
    expect(resizeBox(r, 'nw', 50, 20)).toEqual({ x: 150, y: 120, width: 150, height: 80 })
    expect(resizeBox(r, 'w', 500, 0)).toEqual({ x: 292, y: 100, width: 8, height: 100 })
    expect(resizeBox(r, 'n', 0, -30)).toEqual({ x: 100, y: 70, width: 200, height: 130 })
    expect(handlePoint(r, 'e')).toEqual({ x: 300, y: 150 })
  })
})

describe('the ring covers the least of the design (follow-up: ring placement polish)', () => {
  const stage = { width: 1440, height: 900 }
  const ring = { width: 360, height: 44 }
  // the desktop lantern poster as the canvas shows it at 98 %: the board, the kicker above the selected headline, the date below
  const board = { x: 94, y: 88, width: 1252, height: 704 }
  const kicker = { x: 188, y: 166, width: 1096, height: 43 }
  const headline = { x: 188, y: 235, width: 959, height: 196 }
  const date = { x: 188, y: 499, width: 743, height: 108 }
  it('content right above the selection: it goes below, into free space, covering nothing', () => {
    const r = placeRing(headline, ring, stage, RESERVE, { others: [kicker, date], board })
    expect(r.side).toBe('below')
    const box = { x: r.x, y: r.y, width: ring.width, height: ring.height }
    expect(overlapArea(box, kicker) + overlapArea(box, date) + overlapArea(box, headline)).toBe(0)
  })
  it('with the colour row open (taller), it still takes the place that covers least', () => {
    const tall = { width: 360, height: 100 }
    const r = placeRing(headline, tall, stage, RESERVE, { others: [kicker, date], board })
    const box = { x: r.x, y: r.y, width: tall.width, height: tall.height }
    const covered = overlapArea(box, kicker) + overlapArea(box, date) + overlapArea(box, headline)
    // no candidate covers less: try every above/below/beside alignment by brute force over the free area
    let least = Infinity
    for (let y = 72; y <= 900 - 84 - 8 - 100; y += 4)
      for (let x = 8; x <= 1440 - 8 - 360; x += 8) {
        const b = { x, y, width: 360, height: 100 }
        if (overlapArea(b, headline) > 0) continue
        least = Math.min(least, overlapArea(b, kicker) + overlapArea(b, date))
      }
    expect(covered).toBeLessThanOrEqual(least + 0.25 * 360 * 100)   // within a quarter-ring of the true least (the ring stays beside its selection)
    expect(overlapArea(box, headline)).toBe(0)
  })
  it('on a phone, a selection at the top of the poster: the ring goes outside the board, clear of the kicker and the edge', () => {
    const phone = { width: 390, height: 844 }
    const res = { top: 104, right: 0, bottom: 136, left: 0 }
    const b = { x: 24, y: 310, width: 342, height: 192 }
    const k = { x: 49, y: 333, width: 300, height: 12 }
    const h = { x: 49, y: 348, width: 262, height: 53 }
    const r = placeRing(h, { width: 240, height: 52 }, phone, res, { others: [k], board: b })
    const box = { x: r.x, y: r.y, width: 240, height: 52 }
    expect(overlapArea(box, k)).toBe(0)
    expect(overlapArea(box, b)).toBe(0)
    expect(r.y + 52).toBeLessThanOrEqual(b.y)
  })
  it('no room above or below: beside', () => {
    const tallSel = { x: 300, y: 80, width: 400, height: 720 }
    expect(placeRing(tallSel, ring, stage, RESERVE, { board }).side).toBe('right')
    expect(placeRing({ ...tallSel, x: 760 }, ring, stage, RESERVE, { board }).side).toBe('left')
  })
  it('crowded on every side: the least-overlap place, never over Ω or the drawer pill', () => {
    const sel = { x: 500, y: 300, width: 300, height: 100 }
    const above = { x: 0, y: 200, width: 1440, height: 98 }
    const below = { x: 0, y: 402, width: 1440, height: 30 }   // a thin line below: covering it costs less
    const sides = [{ x: 0, y: 296, width: 498, height: 108 }, { x: 802, y: 296, width: 638, height: 108 }]
    const r = placeRing(sel, ring, stage, RESERVE, { others: [above, below, ...sides] })
    expect(r.side).toBe('below')
    const omega = { x: 0, y: 780, width: 70, height: 120 }
    const pill = { x: 1200, y: 820, width: 230, height: 50 }
    const low = { x: 40, y: 700, width: 200, height: 60 }
    const p = placeRing(low, ring, stage, RESERVE, { avoid: [omega, pill] })
    const box = { x: p.x, y: p.y, width: ring.width, height: ring.height }
    expect(overlapArea(box, omega) + overlapArea(box, pill)).toBe(0)
    expect(box.y + box.height).toBeLessThanOrEqual(900 - RESERVE.bottom - 8)
  })
  it('follows the selection: a moved box moves the ring with it', () => {
    const a = placeRing({ x: 500, y: 400, width: 200, height: 80 }, ring, stage, RESERVE)
    const b = placeRing({ x: 560, y: 420, width: 200, height: 80 }, ring, stage, RESERVE)
    expect([b.x - a.x, b.y - a.y]).toEqual([60, 20])
  })
})
