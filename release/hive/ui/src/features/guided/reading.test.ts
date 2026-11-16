import { describe, expect, it, vi } from 'vitest'
import { placeHint } from '../../tour/place'
import { overlaps, placeReading, wholeShift } from './reading'

/**
 * A reading step's caption (stand-in r5 P2; Root r6 acceptance): beside the target only on a real fit; never on the
 * target through placeHint's fallback (covers -1) or a big target; docked with the target scrolled clear otherwise.
 * Every case checks the same invariant: after the shift, the caption and the target do not overlap.
 */
const CAP = { width: 380, height: 150 }
type Box = { left: number; top: number; width: number; height: number }
/** the target where it lands once scrolled by the placement's shift */
const after = (t: Box, shift: number): Box => ({ ...t, top: t.top - shift })
const clearOf = (t: Box, r: ReturnType<typeof placeReading>) => !overlaps({ left: r.left, top: r.top, width: r.width, height: CAP.height }, after(t, r.shift))

describe('reading-step caption placement', () => {
  it('desktop 1440×900 (Ask band 92px): beside, outside the viewers’ region, nothing to scroll', () => {
    const vp = { width: 1440, height: 900 - 92 }
    const target = { left: 1005, top: 535, width: 200, height: 128 }
    const region = { left: 1005, top: 415, width: 406, height: 400 }
    const r = placeReading(target, CAP, vp, [], region)
    expect([r.mode, r.shift]).toEqual(['beside', 0])
    expect(r.left + r.width).toBeLessThanOrEqual(region.left)
    expect(clearOf(target, r)).toBe(true)
  })

  it('placeHint’s fallback (covers -1, no candidate fits) is never taken: docked, the target scrolled clear', () => {
    // constrained: a short, narrow screen where no hint candidate fits beside a mid-screen target
    const vp = { width: 400, height: 330 }
    const target = { left: 8, top: 120, width: 384, height: 120 }
    expect(placeHint(target, CAP, vp, [], null).covers).toBe(-1)
    const r = placeReading(target, CAP, vp, [], null)
    expect(r.mode).not.toBe('beside')
    expect(r.shift).not.toBe(0)
    expect(clearOf(target, r)).toBe(true)
  })

  it('a placement that would sit on the target is not clearance, even with covers 0', () => {
    // the region is not passed and nothing else is kept clear: placeHint can only offer below/above, both off-screen
    const vp = { width: 390, height: 300 }
    const target = { left: 0, top: 60, width: 390, height: 140 }
    const r = placeReading(target, CAP, vp, [], null)
    expect(clearOf(target, r)).toBe(true)
  })

  it('a target taller than the room left: docked at the top, the target starts just under it, read by scrolling', () => {
    const vp = { width: 1440, height: 808 }
    const target = { left: 8, top: 300, width: 1424, height: 1200 }
    const r = placeReading(target, CAP, vp, [], null)
    expect([r.mode, r.scrolls, r.top]).toEqual(['docked-top', true, 8])
    expect(after(target, r.shift).top).toBe(8 + CAP.height + 8)
    expect(clearOf(target, r)).toBe(true)
  })

  it('mobile 390×844 (Ask band 110px), the viewer low in a half sheet: clear above it, or docked with it scrolled clear', () => {
    const vp = { width: 390, height: 844 - 110 }
    const region = { left: 8, top: 450, width: 374, height: 284 }
    for (const top of [470, 600, 700]) {
      const target = { left: 9, top, width: 372, height: 100 }
      const r = placeReading(target, { width: 366, height: 160 }, vp, [], region)
      expect([top, !overlaps({ left: r.left, top: r.top, width: r.width, height: 160 }, after(target, r.shift))]).toEqual([top, true])
      // and the target, once scrolled, is whole above the Ask's band
      expect(after(target, r.shift).top + target.height).toBeLessThanOrEqual(vp.height)
    }
  })

  it('Root’s reproduction (170349Z): a beside fit is not taken while the target is not whole on screen; it is scrolled into view', () => {
    // placeReading owns the target's visibility (option a): beside only when the target is already whole above the
    // Ask's band; otherwise the shift it returns brings it whole into the band the caption leaves
    const vp = { width: 390, height: 734 }
    const target = { left: 9, top: 700, width: 372, height: 100 }
    const r = placeReading(target, { width: 366, height: 160 }, vp, [], { left: 8, top: 450, width: 374, height: 284 })
    // not the unshifted beside fit Root found (left 15, top 532, shift 0): the target is scrolled whole into view first
    expect([r.mode, r.shift]).not.toEqual(['beside', 0])
    const t = after(target, r.shift)
    expect(t.top).toBeGreaterThanOrEqual(0)
    expect(t.top + t.height).toBeLessThanOrEqual(734)
    expect(overlaps({ left: r.left, top: r.top, width: r.width, height: 160 }, t)).toBe(false)
  })

  it('every placement leaves the target whole on screen (or, too tall, starting under the caption) and off the caption', () => {
    const cap = { width: 366, height: 160 }
    for (const vp of [{ width: 390, height: 734 }, { width: 390, height: 450 }, { width: 1440, height: 808 }, { width: 1440, height: 428 }])
      for (let top = -300; top <= vp.height + 200; top += 37)
        for (const height of [60, 100, 220]) {
          const target = { left: 9, top, width: Math.min(372, vp.width - 18), height }
          const r = placeReading(target, cap, vp, [], { left: 8, top: Math.max(0, top - 120), width: 374, height: 600 })
          const t = after(target, r.shift)
          const ok = !overlaps({ left: r.left, top: r.top, width: r.width, height: cap.height }, t) && (r.scrolls ? t.top === 8 + cap.height + 8 : t.top >= 0 && t.top + t.height <= vp.height)
          expect([vp.width, vp.height, top, height, ok]).toEqual([vp.width, vp.height, top, height, true])
        }
  })

  it('the reveal stage: wholeShift brings a target whole into its scroller’s visible box short of the Ask’s band', () => {
    // a desktop mind panel: scroll area 280..800 (a live log band below it), Ask band from 816
    const bounds = { top: 280, bottom: Math.min(800, 900 - 84) }
    expect(wholeShift({ top: 400, bottom: 520 }, bounds)).toBe(0)
    const s = wholeShift({ top: 760, bottom: 880 }, bounds)! // clipped at the bottom, as Temporal/Assume were
    expect([760 - s >= bounds.top, 880 - s <= bounds.bottom]).toEqual([true, true])
    expect(wholeShift({ top: 100, bottom: 1500 }, bounds)).toBe(100 - 280) // taller than the box: from its top
  })

  it('the view is the target’s scrollport, not the window: a half sheet under a fixed header (rerun1 Self-knowledge, 390×844)', () => {
    // measured: the sheet's scroll area is 573..724 (its header above, the live log below); the target was drawn at
    // 380..466, inside the window but under the fixed header, so not visible
    const vp = { width: 390, height: 844 - 110 }
    const view = { top: 573, bottom: 724 }
    const target = { left: 17, top: 380, width: 356, height: 86 }
    const r = placeReading(target, { width: 366, height: 160 }, vp, [], { left: 16, top: 300, width: 358, height: 700 }, view)
    const t = after(target, r.shift)
    expect([t.top >= view.top, t.top + t.height <= view.bottom]).toEqual([true, true])
    expect(overlaps({ left: r.left, top: r.top, width: r.width, height: 160 }, t)).toBe(false)
    // and the caption is whole on the screen above the Ask's band
    expect([r.top >= 0, r.top + 160 <= vp.height]).toEqual([true, true])
  })

  it('ReadingRoom: once per step; a new step, run or person starts afresh; release forgets', async () => {
    const { ReadingRoom } = await import('./reading')
    const room = new ReadingRoom()
    expect(room.observe('r1:1:1', true)).toBe(false)
    expect(room.observe('r1:1:1', false)).toBe(true)
    expect(room.observe('r1:1:1', false)).toBe(false)
    expect(room.observe('r1:2:1', false)).toBe(true) // another step
    expect(room.observe('r1:2:2', false)).toBe(true) // another person
    room.release()
    expect(room.observe('r1:2:2', false)).toBe(true)
  })

  it('docked, the caption keeps off a kept-clear box (a toast at the top right) along its edge', () => {
    const toast = { left: 1060, top: 64, width: 360, height: 80 }
    const r = placeReading({ left: 1005, top: 273, width: 197, height: 130 }, { width: 380, height: 147 }, { width: 1440, height: 438 }, [toast], null, { top: 273, bottom: 392 })
    expect(r.mode).toBe('docked-top')
    expect(overlaps({ left: r.left, top: r.top, width: r.width, height: 147 }, toast)).toBe(false)
  })

  it('sameMeasure (Root 191824Z): a target growing inside an unchanged band is a NEW measurement, though its clipped box is the same', async () => {
    const { sameMeasure } = await import('./reading')
    const el = {} as Element
    const band = { top: 273, bottom: 392 }
    const before = { el, band, box: { left: 1005, top: 273, right: 1202, bottom: 392 }, full: { left: 1005, top: 273, right: 1202, bottom: 392 } }
    const grown = { el, band, box: { left: 1005, top: 273, right: 1202, bottom: 392 }, full: { left: 1005, top: 273, right: 1202, bottom: 403 } }
    expect(sameMeasure(before, { ...before })).toBe(true)
    expect(sameMeasure(before, grown)).toBe(false)
    // and then the reading layout no longer fits its view: the room is made for that step
    const fitsBefore = before.full.bottom - before.full.top <= band.bottom - band.top
    const fitsAfter = grown.full.bottom - grown.full.top <= band.bottom - band.top
    expect([fitsBefore, fitsAfter]).toEqual([true, false])
    // a band change alone is new too
    expect(sameMeasure(before, { ...before, band: { top: 273, bottom: 380 } })).toBe(false)
  })

  it('visibleBand clips at the Ask as it actually stands under the target (r63 Energy 1440×520: capsule over the card bottom)', async () => {
    const { visibleBand } = await import('./reading')
    const capsule = { getBoundingClientRect: () => ({ left: 518, right: 1158, top: 432, bottom: 502, width: 640, height: 70 }) }
    vi.stubGlobal('window', { innerHeight: 520 })
    vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'auto' }))
    vi.stubGlobal('document', { body: null, documentElement: {}, querySelectorAll: () => [capsule] })
    const el = { parentElement: { getBoundingClientRect: () => ({ top: 273, bottom: 437 }), parentElement: null }, getBoundingClientRect: () => ({ left: 1005, right: 1202, top: 307, bottom: 437 }) } as unknown as Element
    expect(visibleBand(el)).toEqual({ top: 273, bottom: 432 })
    // a target beside the Ask (not over it) is not clipped by it
    const side = { ...el, getBoundingClientRect: () => ({ left: 1214, right: 1411, top: 307, bottom: 437 }) } as unknown as Element
    expect(visibleBand(side)).toEqual({ top: 273, bottom: 437 })
    vi.unstubAllGlobals()
  })

  it('wholeShift moves whole pixels, away from zero: a card 0.4px past its band is moved fully inside', () => {
    expect(wholeShift({ top: 638.2, bottom: 724.4 }, { top: 573, bottom: 724 })).toBe(1)
    expect(wholeShift({ top: 572.6, bottom: 650 }, { top: 573, bottom: 724 })).toBe(-1)
    const s = wholeShift({ top: 638.2, bottom: 724.4 }, { top: 573, bottom: 724 })!
    expect(724.4 - s).toBeLessThanOrEqual(724)
  })

  it('Design 220243Z: no step-aligned shift fits both edges, so none is claimed; a finer (device-pixel) step that fits is used', () => {
    const t = { top: 100.6, bottom: 200.4 }, band = { top: 100, bottom: 200 }
    expect(wholeShift(t, band, 1)).toBeNull() // ceil(0.4) = 1 would clip the top by 0.4
    const s = wholeShift(t, band, 0.5)! // a 2x screen: half-pixel steps, 0.5 fits [0.4, 0.6]
    expect([s, t.top - s >= band.top, t.bottom - s <= band.bottom]).toEqual([0.5, true, true])
    // ample room: unchanged behaviour
    expect(wholeShift({ top: 120.6, bottom: 210.4 }, band, 1)).toBe(11)
    // oversized: start alignment keeps its own rule (floor keeps the top visible)
    expect(wholeShift({ top: 90.6, bottom: 400 }, band, 1)).toBe(-10)
  })

  it('Design 220243Z, beside and docks: with no aligned fit, placeReading never claims whole; it reads by scrolling (labelled)', () => {
    // the view is the band [100, 200]; the target 99.8 tall at a fractional offset; no candidate may claim it whole
    const r = placeReading({ left: 9, top: 100.6, width: 372, height: 99.8 }, { width: 366, height: 60 }, { width: 390, height: 734 }, [], null, { top: 100, bottom: 200 }, 1)
    expect([r.mode === 'beside', r.scrolls]).toEqual([false, true])
    // dock-candidate equivalent: the docked band leaves exactly the target's height at fractional offsets
    const d = placeReading({ left: 9, top: 176.6, width: 372, height: 99.8 }, { width: 366, height: 160 }, { width: 390, height: 300 }, [], null, { top: 150, bottom: 276 }, 1)
    expect(d.scrolls).toBe(true)
    // with half-pixel steps the same docked case fits whole
    const d2 = placeReading({ left: 9, top: 176.6, width: 372, height: 99.8 }, { width: 366, height: 160 }, { width: 390, height: 300 }, [], null, { top: 150, bottom: 276 }, 0.5)
    expect([d2.scrolls, d2.shift]).toEqual([false, 0.5])
  })

  it('stand-in r6 P3: sameMeasure compares in device pixels; at DPR 2 a 0.5px growth across the band edge is a new measurement', async () => {
    const { sameMeasure } = await import('./reading')
    const el = {} as Element
    const band = { top: 573, bottom: 724 }
    const fit = { el, band, box: { left: 17, top: 638, right: 373, bottom: 724 }, full: { left: 17, top: 638, right: 373, bottom: 724 } }
    const grown = { ...fit, full: { ...fit.full, bottom: 724.5 } }
    expect(sameMeasure(fit, grown, 2)).toBe(false) // a whole device pixel at 2x: re-layout
    // Root 231754Z: a change of fit class is never noise, however small, at any DPR
    expect(sameMeasure(fit, { ...fit, full: { ...fit.full, bottom: 724.4 } }, 1)).toBe(false) // whole → clipped at 1x
    expect(sameMeasure(fit, { ...fit, full: { ...fit.full, bottom: 724.1 } }, 2)).toBe(false) // whole → clipped at 2x
    expect(sameMeasure(fit, { ...fit, band: { top: 573, bottom: 723.9 } }, 2)).toBe(false) // the band shrinks under it
    // noise inside the same class is still filtered (a whole target moving 0.1px well inside its band)
    const inside = { ...fit, full: { ...fit.full, top: 600, bottom: 700 }, box: { ...fit.box, top: 600, bottom: 700 } }
    expect(sameMeasure(inside, { ...inside, full: { ...inside.full, bottom: 700.1 }, box: { ...inside.box, bottom: 700.1 } }, 2)).toBe(true)
    expect(sameMeasure(fit, { ...fit, band: { top: 573, bottom: 723.5 } }, 2)).toBe(false) // a band shrinking 0.5px
    // and that growth turns the whole fit into clipping: the layout must run (wholeShift then asks for half a pixel)
    expect(wholeShift({ top: 638, bottom: 724.5 }, band, 0.5)).toBe(0.5)
  })
})
