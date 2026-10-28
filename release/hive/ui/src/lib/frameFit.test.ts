import { describe, expect, it } from 'vitest'
import { appContext } from './appBridge'
import { cleanInsets, cleanReserved, frameInsets, framedPadding, frameReserved, noticeLane, OMEGA_MARGIN, px, ZERO_INSETS, type Box } from './frameFit'
import { appStageNow, setAppStage } from '../shell/appStage'

// Ω as OmegaMenu renders it: 36 px, 12 px from the left and bottom edges (plus the bottom safe area)
const omegaAt = (vh: number, sab = 0): Box => ({ left: 12, top: vh - 12 - sab - 36, right: 48, bottom: vh - 12 - sab })
const VIEWPORTS = [
  { width: 844, height: 390 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
  { width: 1440, height: 900 },
]
const whole = (v: { width: number; height: number }): Box => ({ left: 0, top: 0, right: v.width, bottom: v.height })

describe('frame fit: lengths are clean data', () => {
  it('px: whole CSS px, never negative, NaN or huge; a fraction still covers', () => {
    expect([px(0), px(-3), px(NaN), px(Infinity), px('12'), px(null), px(12), px(12.2), px(1e9)]).toEqual([0, 0, 0, 0, 0, 0, 12, 13, 4096])
  })
  it('insets and reserved have exactly their keys, whatever comes in', () => {
    expect(cleanInsets({ top: 47, right: -1, bottom: 34.4, left: 'x' as never, extra: 9 } as never)).toEqual({ top: 47, right: 0, bottom: 35, left: 0 })
    expect(cleanInsets(null)).toEqual(ZERO_INSETS)
    expect(cleanReserved({ bottomLeft: { width: 60, height: 60, x: 1 } as never })).toEqual({ bottomLeft: { width: 60, height: 60 } })
    expect(cleanReserved({ bottomLeft: { width: 60, height: 0 } })).toEqual({ bottomLeft: { width: 0, height: 0 } })
    expect(cleanReserved(undefined)).toEqual({ bottomLeft: { width: 0, height: 0 } })
  })
})

describe('frame fit: full-bleed (the frame fills the stage and must honour both)', () => {
  it.each(VIEWPORTS)('at %o the frame gets the Ω corner as 60 x 60 and the device insets as they are', (v) => {
    const frame = whole(v)
    expect(frameReserved(frame, omegaAt(v.height))).toEqual({ bottomLeft: { width: 48 + OMEGA_MARGIN, height: 36 + 12 + OMEGA_MARGIN } })
    expect(frameInsets(frame, v, ZERO_INSETS)).toEqual(ZERO_INSETS)
  })
  it('a phone in landscape: notch left and right, home indicator below; Ω lifted by it', () => {
    const v = { width: 844, height: 390 }
    const device = { top: 0, right: 47, bottom: 21, left: 47 }
    expect(frameInsets(whole(v), v, device)).toEqual(device)
    expect(frameReserved(whole(v), omegaAt(390, 21))).toEqual({ bottomLeft: { width: 60, height: 81 } })
  })
})

describe('frame fit: framed (the host pads the frame clear of both)', () => {
  it.each(VIEWPORTS)('at %o the padded frame meets neither Ω nor a safe area, and never needs more than the screen', (v) => {
    for (const device of [ZERO_INSETS, { top: 47, right: 0, bottom: 34, left: 0 }, { top: 0, right: 47, bottom: 21, left: 47 }]) {
      const sab = device.bottom
      const omega = omegaAt(v.height, sab)
      const pad = framedPadding(v, device, omega)
      const frame = { left: pad.left, top: pad.top, right: v.width - pad.right, bottom: v.height - pad.bottom }
      expect(frame.bottom - frame.top).toBeGreaterThan(v.height / 2)   // no fixed minimum pushes anything off-screen
      expect(frame.bottom).toBeLessThanOrEqual(omega.top - OMEGA_MARGIN)
      expect(frameReserved(frame, omega)).toEqual({ bottomLeft: { width: 0, height: 0 } })
      expect(frameInsets(frame, v, device)).toEqual(ZERO_INSETS)
      // the notice lane is the band right of Ω, as tall as Ω's area, above the bottom inset: outside the frame
      const lane = noticeLane(device, omega)!
      expect(lane.top).toBeGreaterThanOrEqual(frame.bottom)
      expect(lane.left).toBe(48 + OMEGA_MARGIN)
      expect(lane.bottom).toBe(sab)
    }
  })
  it('without Ω the host keeps only the safe areas, and there is no lane', () => {
    expect(framedPadding({ width: 390, height: 844 }, { top: 47, right: 0, bottom: 34, left: 0 }, null)).toEqual({ top: 47, right: 0, bottom: 34, left: 0 })
    expect(noticeLane(ZERO_INSETS, null)).toBeNull()
  })
})

describe('frame fit: partial overlaps', () => {
  it('a frame beside Ω (not over it) reserves nothing; one partly over it reserves only the overlap', () => {
    const omega = omegaAt(900)
    expect(frameReserved({ left: 100, top: 0, right: 1440, bottom: 900 }, omega)).toEqual({ bottomLeft: { width: 0, height: 0 } })
    expect(frameReserved({ left: 30, top: 0, right: 1440, bottom: 880 }, omega)).toEqual({ bottomLeft: { width: 30, height: 40 } })
  })
  it('a frame that only partly reaches into a safe area gets only that part', () => {
    expect(frameInsets({ left: 0, top: 20, right: 390, bottom: 844 }, { width: 390, height: 844 }, { top: 47, right: 0, bottom: 34, left: 0 })).toEqual({ top: 27, right: 0, bottom: 34, left: 0 })
  })
  it('an empty frame gets zeros', () => {
    expect(frameInsets({ left: 0, top: 0, right: 0, bottom: 0 }, { width: 390, height: 844 }, { top: 47, right: 0, bottom: 34, left: 0 })).toEqual(ZERO_INSETS)
    expect(frameReserved({ left: 0, top: 0, right: 0, bottom: 0 }, omegaAt(844))).toEqual({ bottomLeft: { width: 0, height: 0 } })
  })
})

describe('frame fit in context', () => {
  const base = { experience: 'classic', chrome: null, identity: null, reducedMotion: false, picker: false }
  it('context carries insets and reserved, cleaned; zero when the host has not measured', () => {
    expect(appContext(base)).toMatchObject({ insets: ZERO_INSETS, reserved: { bottomLeft: { width: 0, height: 0 } } })
    const c = appContext({ ...base, insets: { top: 47.2, right: -5, bottom: 34, left: 0 }, reserved: { bottomLeft: { width: 60, height: 94 } } })
    expect(c.insets).toEqual({ top: 48, right: 0, bottom: 34, left: 0 })
    expect(c.reserved).toEqual({ bottomLeft: { width: 60, height: 94 } })
    expect(Object.keys(c.insets).sort()).toEqual(['bottom', 'left', 'right', 'top'])
    expect(JSON.stringify(c).length).toBeLessThan(2048)
  })
})

describe('app stage (where host notices go while a frame is mounted)', () => {
  it('is set and cleared, and an equal value is not a change', () => {
    setAppStage({ mode: 'full', top: 8 })
    const a = appStageNow()
    setAppStage({ mode: 'full', top: 8 })
    expect(appStageNow()).toBe(a)
    setAppStage({ mode: 'framed', lane: { left: 60, top: 784, right: 12, bottom: 0 } })
    expect(appStageNow()?.mode).toBe('framed')
    setAppStage(null)
    expect(appStageNow()).toBeNull()
  })
})
