import { describe, expect, it } from 'vitest'
import { appContext } from './appBridge'
import { cleanInsets, cleanReserved, frameInsets, framedNoticeFit, framedPadding, frameReserved, noticeLane, OMEGA_MARGIN, px, ZERO_INSETS, type Box } from './frameFit'
import { appStageNow, createAppStagePublisher, setAppStage } from '../shell/appStage'
import { askRoom } from '../features/ask/askRoom'

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

  it('keeps the incoming experience when an outgoing frame releases its measurement', () => {
    const frame = createAppStagePublisher()
    const experience = createAppStagePublisher()
    try {
      frame.set({ mode: 'full', top: 8 })
      experience.set({ mode: 'experience', top: 120 })
      frame.release()
      expect(appStageNow()).toEqual({ mode: 'experience', top: 120 })
    } finally {
      frame.release()
      experience.release()
    }
    expect(appStageNow()).toBeNull()
  })

  it('restores the background measurement without letting its updates cover the foreground stage', () => {
    const experience = createAppStagePublisher()
    const frame = createAppStagePublisher()
    try {
      experience.set({ mode: 'experience', top: 120 })
      frame.set({ mode: 'full', top: 8 })
      experience.set({ mode: 'experience', top: 136 })
      expect(appStageNow()).toEqual({ mode: 'full', top: 8 })
      frame.release()
      expect(appStageNow()).toEqual({ mode: 'experience', top: 136 })
    } finally {
      frame.release()
      experience.release()
    }
  })

  it('does not raise an older publisher whose first measurement arrives late', () => {
    const older = createAppStagePublisher()
    const newer = createAppStagePublisher()
    try {
      newer.set({ mode: 'full', top: 8 })
      older.set({ mode: 'experience', top: 120 })
      expect(appStageNow()).toEqual({ mode: 'full', top: 8 })
      newer.release()
      expect(appStageNow()).toEqual({ mode: 'experience', top: 120 })
    } finally {
      newer.release()
      older.release()
    }
  })

  it('retains independent ownership when two measurements have the same geometry', () => {
    const older = createAppStagePublisher()
    const newer = createAppStagePublisher()
    try {
      older.set({ mode: 'full', top: 8 })
      const original = appStageNow()
      newer.set({ mode: 'full', top: 8 })
      expect(appStageNow()).toBe(original)
      newer.release()
      expect(appStageNow()).toEqual({ mode: 'full', top: 8 })
    } finally {
      newer.release()
      older.release()
    }
    expect(appStageNow()).toBeNull()
  })

  it('cannot revive a released lifetime or clear a newer one through a stale callback', () => {
    const outgoing = createAppStagePublisher()
    const incoming = createAppStagePublisher()
    try {
      outgoing.set({ mode: 'full', top: 8 })
      outgoing.release()
      incoming.set({ mode: 'experience', top: 120 })
      outgoing.set({ mode: 'full', top: 99 })
      outgoing.release()
      expect(appStageNow()).toEqual({ mode: 'experience', top: 120 })
    } finally {
      outgoing.release()
      incoming.release()
    }
  })

  it('lets the compatibility writer update and release only its own slot', () => {
    setAppStage({ mode: 'experience', top: 80 })
    const foreground = createAppStagePublisher()
    try {
      foreground.set({ mode: 'full', top: 8 })
      setAppStage({ mode: 'experience', top: 120 })
      expect(appStageNow()).toEqual({ mode: 'full', top: 8 })
      setAppStage(null)
      expect(appStageNow()).toEqual({ mode: 'full', top: 8 })
    } finally {
      setAppStage(null)
      foreground.release()
    }
    expect(appStageNow()).toBeNull()
  })
})


// A real geometry reproducer for the reported desktop text obstruction: independent painted-box intersection,
// not a CSS-string check. Heights include the dock's answerer row/autosize, not a capsule-height assumption.
describe('framed and fallback notices clear the measured host composer', () => {
  const area = (a: Box, b: Box) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  const pill = (v: { width: number; height: number }, lane: NonNullable<ReturnType<typeof noticeLane>>, height = 36): Box => {
    const right = v.width - lane.right
    const width = Math.min(512, right - lane.left)
    const top = lane.top + (v.height - lane.bottom - lane.top - height) / 2
    return { left: right - width, right, top, bottom: top + height }
  }
  // Hud uses p-3/centred cards below md and p-4/right alignment above it. The unlayered index.css may reserve
  // more bottom padding for classic phones, or top-anchor an active experience. These are distinct layout cases.
  const fallbackCard = (v: { width: number; height: number; safe: number }, room: number, padding = v.width < 768 ? 12 : 16, safeBottom = v.safe): Box => {
    const width = Math.max(0, Math.min(384, v.width - 2 * padding))
    const left = v.width < 768 ? (v.width - width) / 2 : v.width - padding - width
    const bottom = v.height - safeBottom - room - padding
    return { left, right: left + width, top: bottom - 112, bottom }
  }
  const fixtures = [
    { width: 1440, height: 900, bottom: 18, safe: 0 },
    { width: 390, height: 844, bottom: 56, safe: 34 },
    { width: 382, height: 580, bottom: 56, safe: 0 },
    { width: 669, height: 825, bottom: 56, safe: 21 },
    { width: 951, height: 543, bottom: 18, safe: 0 },
  ]

  it('first reproduces positive desktop overlap, then separates the notice and the frame from the whole dock', () => {
    const v = fixtures[0]
    const device = ZERO_INSETS
    const dock: Box = { left: 400, right: 1040, top: 788, bottom: 882 } // 56 px field + 32 px answerer + 6 px gap
    const original = pill(v, noticeLane(device, omegaAt(v.height), undefined, 112)!)
    expect(area(original, dock)).toBeGreaterThan(0)
    const fit = framedNoticeFit(v, device, omegaAt(v.height), 112, askRoom({ bottom: v.bottom }, false, 94))
    const placed = pill(v, fit.lane!)
    expect(area(placed, dock)).toBe(0)
    expect(placed.bottom).toBeLessThanOrEqual(dock.top - 8)
    expect(v.height - fit.padding.bottom).toBeLessThanOrEqual(fit.lane!.top)
    expect(v.height - fit.padding.bottom - fit.padding.top).toBeGreaterThan(0)
  })

  it.each(fixtures)('at %o both notice forms remain above actual dock growth and inside a nonempty viewport', (v) => {
    const device = { top: 8, right: 0, bottom: v.safe, left: 0 }
    const omega = omegaAt(v.height, v.safe)
    for (const height of [56, 94, 146]) {
      const room = askRoom({ bottom: v.bottom }, false, height)
      const width = Math.min(640, v.width - 20)
      const dock: Box = { left: (v.width - width) / 2, right: (v.width + width) / 2, top: v.height - v.safe - v.bottom - height, bottom: v.height - v.safe - v.bottom }
      const fit = framedNoticeFit(v, device, omega, 12, room)
      const placed = pill(v, fit.lane!, 44)
      expect(area(placed, dock)).toBe(0)
      expect(placed.bottom).toBeLessThanOrEqual(dock.top - 8)
      expect(placed.left).toBeGreaterThanOrEqual(device.left)
      expect(placed.right).toBeLessThanOrEqual(v.width - device.right)
      expect(placed.top).toBeGreaterThanOrEqual(device.top)
      expect(v.height - fit.padding.bottom).toBeLessThanOrEqual(fit.lane!.top)
      expect(v.height - fit.padding.bottom - fit.padding.top).toBeGreaterThan(0)
      // Visible card bounds include the stack's responsive padding and phone centring, not just its bottom anchor.
      const fallback = fallbackCard(v, room)
      expect(area(fallback, dock)).toBe(0)
      expect(fallback.bottom).toBeLessThanOrEqual(dock.top - 8)
      expect(fallback.top).toBeGreaterThanOrEqual(device.top)
      expect(fallback.left).toBeGreaterThanOrEqual(0)
      expect(fallback.right).toBeLessThanOrEqual(v.width)
      if (v.width < 768) {
        // Classic index.css may add safe+84 padding; padding0 is the conservative bottom-anchored lower bound.
        for (const padding of [0, v.safe + 84]) {
          const card = fallbackCard(v, room, padding)
          expect(area(card, dock)).toBe(0)
          expect(card.bottom).toBeLessThanOrEqual(dock.top - 8)
          expect(card.top).toBeGreaterThanOrEqual(device.top)
        }
        // Active-experience fallback has a separate top anchor (safe top+64), not this bottom-card formula.
        const topCard: Box = { left: (v.width - Math.min(384, v.width - 24)) / 2, right: (v.width + Math.min(384, v.width - 24)) / 2, top: device.top + 64, bottom: device.top + 64 + 112 }
        expect(area(topCard, dock)).toBe(0)
        expect(topCard.bottom).toBeLessThanOrEqual(dock.top)
      }
    }
  })

  it('reproduces the missing phone safe-area overlap with a visible p-3 card before the correction', () => {
    const v = fixtures[1] // 390x844, safe bottom34
    const room = askRoom({ bottom: v.bottom }, false, 94)
    const dock: Box = { left: 10, right: 380, top: 660, bottom: 754 }
    // R1 bottom=room (safe omitted), while Hud p-3 still leaves12px under the visible card.
    const original = fallbackCard(v, room, 12, 0)
    expect(original.bottom).toBe(674)
    expect(original.bottom - dock.top).toBe(14)
    expect(area(original, dock)).toBeGreaterThan(0)
    const corrected = fallbackCard(v, room)
    expect(corrected.bottom).toBe(640)
    expect(area(corrected, dock)).toBe(0)
    expect(corrected.bottom).toBeLessThanOrEqual(dock.top - 8)
    expect(corrected.left).toBe((v.width - (corrected.right - corrected.left)) / 2)
  })

  it('keeps the old frame and lane exactly when no Ask reservation exists', () => {
    const v = fixtures[0]
    const omega = omegaAt(v.height)
    expect(framedNoticeFit(v, ZERO_INSETS, omega, 112, 0)).toEqual({
      padding: framedPadding(v, ZERO_INSETS, omega), lane: noticeLane(ZERO_INSETS, omega, undefined, 112),
    })
  })

  it('measured growth increases both frame and notice reserve together, including the answerer row', () => {
    const v = fixtures[0]
    const small = framedNoticeFit(v, ZERO_INSETS, omegaAt(v.height), 12, askRoom({ bottom: 18 }, false, 56))
    const tall = framedNoticeFit(v, ZERO_INSETS, omegaAt(v.height), 12, askRoom({ bottom: 18 }, false, 94))
    expect(tall.padding.bottom - small.padding.bottom).toBe(38)
    expect(small.lane!.top - tall.lane!.top).toBe(38)
    expect(tall.lane!.bottom - small.lane!.bottom).toBe(38)
  })

  it('retains Professional gap behavior and ignores invalid measured heights instead of publishing NaN', () => {
    expect(askRoom({ bottom: 18 }, true, 100)).toBe(130)
    expect([NaN, Infinity, -1].map((height) => askRoom({ bottom: 18 }, false, height))).toEqual([82, 82, 82])
  })

  it('never turns an impossible overlay reservation into an empty or negative frame', () => {
    const v = { width: 390, height: 240 }
    const fit = framedNoticeFit(v, ZERO_INSETS, omegaAt(v.height), 12, 4096)
    expect(v.height - fit.padding.bottom - fit.padding.top).toBe(1)
    expect(fit.lane!.top).toBeGreaterThanOrEqual(0)
    // No assertion of successful full-overlay fit: that cannot be guaranteed when the overlay exceeds the viewport.
  })
})
