import { describe, expect, it } from 'vitest'
import {
  experienceNoticeTop, framedPadding, frameReserved, noticeLane, noticePillWidth, OMEGA_GLYPH, OMEGA_MARGIN, omegaHit, TOUCH_MIN, ZERO_INSETS,
  type Box, type Insets,
} from './frameFit'
import { appStageNow, setAppStage } from '../shell/appStage'

// Request Q: Ω's hit area on touch screens, and the host notice lane while a whole experience is in front.
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
  { width: 844, height: 390 },
]
/** Ω's hit box as OmegaMenu renders it (offset from the left and bottom edges, lifted by the bottom inset). */
const omegaBox = (vh: number, coarse: boolean, sab = 0, sal = 0): Box => {
  const h = omegaHit(coarse)
  return { left: sal + h.offset, top: vh - sab - h.offset - h.size, right: sal + h.offset + h.size, bottom: vh - sab - h.offset }
}
const whole = (v: { width: number; height: number }): Box => ({ left: 0, top: 0, right: v.width, bottom: v.height })
const hits = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

describe('Ω hit area', () => {
  it('fine pointer: the 36 px glyph itself, 12 px from the edges', () => {
    expect(omegaHit(false)).toEqual({ size: 36, offset: 12, glyph: 36 })
  })
  it('coarse pointer: a 44 px square, 8 px from the edges, the glyph centred where it always was', () => {
    const h = omegaHit(true)
    expect(h).toEqual({ size: TOUCH_MIN, offset: 8, glyph: OMEGA_GLYPH })
    expect(h.size).toBeGreaterThanOrEqual(44)
    // the glyph's own offset is unchanged (12 px), so the target grows only outwards, into the corner
    expect(h.offset + (h.size - h.glyph) / 2).toBe(OMEGA_MARGIN)
    expect(h.offset).toBeGreaterThanOrEqual(0)
  })
  it.each(VIEWPORTS)('at %o the hit area stays inside the screen and bottom-left, with and without safe areas', (v) => {
    for (const [sab, sal] of [[0, 0], [34, 0], [21, 47]]) {
      const o = omegaBox(v.height, true, sab, sal)
      expect(o.left).toBeGreaterThanOrEqual(sal)
      expect(o.bottom).toBeLessThanOrEqual(v.height - sab)
      expect(o.right - o.left).toBe(44)
      expect(o.bottom - o.top).toBe(44)
    }
  })
  it.each(VIEWPORTS)('at %o a full-bleed frame is told the larger corner: 64 x 64 on touch, 60 x 60 on a fine pointer', (v) => {
    expect(frameReserved(whole(v), omegaBox(v.height, true))).toEqual({ bottomLeft: { width: 64, height: 64 } })
    expect(frameReserved(whole(v), omegaBox(v.height, false))).toEqual({ bottomLeft: { width: 60, height: 60 } })
  })
  it('the experiences’ 60 px phone corner still clears the 44 px hit area (its right and top edges are 52 px in)', () => {
    const v = { width: 390, height: 844 }
    const o = omegaBox(v.height, true)
    expect(o.right).toBeLessThanOrEqual(60)
    expect(v.height - o.top).toBeLessThanOrEqual(60)
  })
  it('framed: the bottom lane grows to hold the 44 px target, and the notice lane starts right of it', () => {
    const v = { width: 390, height: 844 }
    const o = omegaBox(v.height, true)
    expect(framedPadding(v, ZERO_INSETS, o).bottom).toBe(64)
    expect(noticeLane(ZERO_INSETS, o)).toEqual({ left: 64, top: 844 - 64, right: 12, bottom: 0 })
    // a 44 px pill fits the lane (the lane is the hit area plus 12 px either side)
    expect(844 - noticeLane(ZERO_INSETS, o)!.top).toBeGreaterThanOrEqual(TOUCH_MIN)
  })
})

describe('experience notice lane', () => {
  const pill = (v: { width: number }, coarse = true) => ({ width: noticePillWidth(v as never), height: coarse ? 44 : 36 })
  const pillBox = (v: { width: number }, top: number, coarse = true): Box => {
    const p = pill(v, coarse)
    return { left: (v.width - p.width) / 2, top, right: (v.width + p.width) / 2, bottom: top + p.height }
  }

  it('no chrome to keep clear: top centre, below the top inset', () => {
    const v = { width: 390, height: 844 }
    expect(experienceNoticeTop(v, ZERO_INSETS, [], pill(v))).toBe(8)
    expect(experienceNoticeTop(v, { top: 47, right: 0, bottom: 34, left: 0 }, [], pill(v))).toBe(55)
  })
  it('the pill is never wider than 512 px, nor closer than 12 px to a side', () => {
    expect(noticePillWidth({ width: 1440, height: 900 })).toBe(512)
    expect(noticePillWidth({ width: 360, height: 780 })).toBe(336)
  })
  it('a phone with a status bar and a pager on top and chips plus a command line at the bottom (Construct): below the pager', () => {
    const v = { width: 390, height: 844 }
    const bars: Box[] = [
      { left: 7, top: 7, right: 383, bottom: 50 }, // status
      { left: 7, top: 57, right: 383, bottom: 101 }, // pager
      { left: 56, top: 729, right: 390, bottom: 773 }, // chips
      { left: 56, top: 779, right: 383, bottom: 837 }, // command line
      omegaBox(v.height, true),
    ]
    const t = experienceNoticeTop(v, ZERO_INSETS, bars, pill(v))
    expect(t).toBe(109)
    for (const b of bars) expect(hits(pillBox(v, t), b)).toBe(false)
  })
  it('a landscape phone: the pill fits between the top bars and the bottom band, touching neither', () => {
    const v = { width: 844, height: 390 }
    const bars: Box[] = [
      { left: 7, top: 7, right: 837, bottom: 50 },
      { left: 7, top: 57, right: 837, bottom: 101 },
      { left: 56, top: 270, right: 844, bottom: 315 },
      { left: 56, top: 322, right: 837, bottom: 383 },
      omegaBox(v.height, true),
    ]
    const t = experienceNoticeTop(v, ZERO_INSETS, bars, pill(v))
    const p = pillBox(v, t)
    for (const b of bars) expect(hits(p, b)).toBe(false)
    expect(p.bottom).toBeLessThanOrEqual(270)
  })
  it('chrome only at the sides of the top (Canvas’s two top pills): the pill takes the free middle when wide enough', () => {
    const v = { width: 1440, height: 900 }
    const bars: Box[] = [
      { left: 12, top: 12, right: 330, bottom: 56 },
      { left: 1100, top: 12, right: 1428, bottom: 56 },
      { left: 500, top: 840, right: 940, bottom: 888 },
    ]
    expect(experienceNoticeTop(v, ZERO_INSETS, bars, pill(v, false))).toBe(8)
  })
  it('never below the bottom band: a screen too short for its chrome overlaps the least chrome, the higher on a tie', () => {
    const v = { width: 844, height: 300 }
    const bars: Box[] = [
      { left: 0, top: 0, right: 844, bottom: 140 },
      { left: 0, top: 160, right: 844, bottom: 300 },
    ]
    const t = experienceNoticeTop(v, ZERO_INSETS, bars, pill(v))
    expect(t).toBeGreaterThanOrEqual(8)
    expect(t + 44).toBeLessThanOrEqual(300 - 8)
    // the result is the place with the least overlap among the tried places
    const cost = (top: number) => bars.reduce((s, b) => {
      const p = pillBox(v, top)
      const r = { left: p.left - 8, top: p.top - 8, right: p.right + 8, bottom: p.bottom + 8 }
      return s + Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)) * Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top))
    }, 0)
    for (const other of [8, 148]) expect(cost(t)).toBeLessThanOrEqual(cost(other))
  })
  it('zero-size and off-screen boxes are ignored; device insets move the floor and the ceiling', () => {
    const v = { width: 390, height: 844 }
    const d: Insets = { top: 47, right: 0, bottom: 34, left: 0 }
    expect(experienceNoticeTop(v, d, [{ left: 0, top: 0, right: 0, bottom: 900 }], pill(v))).toBe(55)
    const bottomOnly: Box[] = [{ left: 0, top: 700, right: 390, bottom: 810 }]
    expect(experienceNoticeTop(v, d, bottomOnly, pill(v))).toBe(55)
  })
  it('scene controls (Flux’s blobs) are avoided when there is a choice, but never at the cost of kept-clear chrome', () => {
    const v = { width: 390, height: 844 }
    const chrome: Box[] = [{ left: 20, top: 62, right: 200, bottom: 110 }, { left: 80, top: 770, right: 370, bottom: 830 }, omegaBox(v.height, true)]
    const blobs: Box[] = [{ left: 100, top: 120, right: 260, bottom: 280 }, { left: 40, top: 560, right: 360, bottom: 700 }]
    const t = experienceNoticeTop(v, ZERO_INSETS, chrome, pill(v), 8, blobs)
    for (const b of [...chrome, ...blobs]) expect(hits(pillBox(v, t), b)).toBe(false)
    // only blobs everywhere: the chrome still wins, the pill takes the least-covered place clear of the chrome
    const wall: Box[] = [{ left: 0, top: 0, right: 390, bottom: 844 }]
    const u = experienceNoticeTop(v, ZERO_INSETS, chrome, pill(v), 8, wall)
    for (const b of chrome) expect(hits(pillBox(v, u), b)).toBe(false)
  })
  it.each(VIEWPORTS)('at %o the pill always lands fully on screen', (v) => {
    for (const coarse of [true, false]) {
      const t = experienceNoticeTop(v, ZERO_INSETS, [{ left: 0, top: 0, right: v.width, bottom: v.height }], pill(v, coarse))
      expect(t).toBeGreaterThanOrEqual(8)
      expect(t + pill(v, coarse).height).toBeLessThanOrEqual(v.height)
    }
  })
  it('the experience stage is a third mode of the same notice stage, deduplicated like the others', () => {
    setAppStage({ mode: 'experience', top: 109 })
    const a = appStageNow()
    setAppStage({ mode: 'experience', top: 109 })
    expect(appStageNow()).toBe(a)
    expect(appStageNow()?.mode).toBe('experience')
    setAppStage(null)
    expect(appStageNow()).toBeNull()
  })
})
