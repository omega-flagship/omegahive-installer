import { describe, expect, it } from 'vitest'
import { experienceNoticeTop, noticeLane, noticeOverlap, noticePillWidth, OMEGA_GLYPH, OMEGA_MARGIN, ZERO_INSETS, type Box } from '../lib/frameFit'
import {
  CLOCK_HEIGHT, CLOCK_LIFT, CLOCK_MARGIN, cleanCycle, cornerTop, FEEDBACK_BESIDE_MIN, FEEDBACK_SLOT, feedbackRoom, laneClockRoom, clockRoom, clockShown, clockSlot, clockText, minuteTicker, msToNextMinute, TICK_SLACK, type TickerEnv,
} from './clockModel'

import appSrc from '../App.tsx?raw'
import clockSrc from './OsClock.tsx?raw'
import stepAsideSrc from './stepAside.ts?raw'
import ambientSrc from './Ambient.tsx?raw'
import navSrc from './Nav.tsx?raw'
import canvasSrc from '../experiences/canvas/overlays.tsx?raw'
import cosmosSrc from '../experiences/cosmos/index.tsx?raw'
import fluxSrc from '../experiences/flux/index.tsx?raw'
import constructSrc from '../experiences/construct/index.tsx?raw'
// CSS is read from disk (a ?raw CSS import is emptied by the test transform), as shell/longPress.test.ts does
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const clockCss = fs.readFileSync(new URL('./osClock.css', import.meta.url), 'utf8')
const constructCss = fs.readFileSync(new URL('../experiences/construct/construct.css', import.meta.url), 'utf8')
const feedbackCss = fs.readFileSync(new URL('../features/feedback/feedback.css', import.meta.url), 'utf8')

const SOURCES: Record<string, string> = {
  'App.tsx': appSrc,
  'shell/OsClock.tsx': clockSrc,
  'shell/osClock.css': clockCss,
  'shell/Ambient.tsx': ambientSrc,
  'shell/Nav.tsx': navSrc,
  'experiences/canvas/overlays.tsx': canvasSrc,
  'experiences/cosmos/index.tsx': cosmosSrc,
  'experiences/flux/index.tsx': fluxSrc,
  'experiences/construct/construct.css': constructCss,
  'features/feedback/feedback.css': feedbackCss,
}
const read = (p: string) => SOURCES[p]

/** A fake clock and timer queue: time moves only when `advance` is called. */
function fakeEnv(start: number) {
  let t = start
  let hidden = false
  let seq = 0
  const timers = new Map<number, { at: number; f: () => void }>()
  const vis = new Set<() => void>()
  const env: TickerEnv = {
    now: () => t,
    setTimeout: (f, ms) => (timers.set(++seq, { at: t + ms, f }), seq),
    clearTimeout: (id) => void timers.delete(id),
    hidden: () => hidden,
    onVisibility: (f) => (vis.add(f), () => vis.delete(f)),
  }
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      timers.delete(next[0])
      t = next[1].at
      next[1].f()
    }
    t = end
  }
  const setHidden = (h: boolean) => {
    hidden = h
    vis.forEach((f) => f())
  }
  return { env, advance, setHidden, pending: () => timers.size, now: () => t }
}

describe('minute-boundary scheduling', () => {
  it('waits exactly until the next minute', () => {
    expect(msToNextMinute(Date.UTC(2026, 9, 6, 21, 43, 0, 0))).toBe(60_000)
    expect(msToNextMinute(Date.UTC(2026, 9, 6, 21, 43, 59, 990))).toBe(10)
    expect(msToNextMinute(Date.UTC(2026, 9, 6, 21, 43, 12, 500))).toBe(47_500)
  })
  it('ticks once per minute, just after each boundary, with one timer and no per-second loop', () => {
    const start = Date.UTC(2026, 9, 6, 21, 43, 20)
    const f = fakeEnv(start)
    const ticks: number[] = []
    const stop = minuteTicker(() => ticks.push(f.now()), f.env)
    expect(f.pending()).toBe(1)
    f.advance(39_000)
    expect(ticks).toEqual([])
    f.advance(1_000 + TICK_SLACK)
    expect(ticks).toEqual([Date.UTC(2026, 9, 6, 21, 44, 0) + TICK_SLACK])
    f.advance(3 * 60_000)
    expect(ticks.length).toBe(4)
    ticks.forEach((t) => expect(t % 60_000).toBe(TICK_SLACK))
    expect(f.pending()).toBe(1)
    stop()
    expect(f.pending()).toBe(0)
  })
  it('a hidden tab holds no timer and ticks nothing; showing again ticks at once and re-arms', () => {
    const f = fakeEnv(Date.UTC(2026, 9, 6, 21, 43, 20))
    let n = 0
    minuteTicker(() => n++, f.env)
    f.setHidden(true)
    expect(f.pending()).toBe(0)
    f.advance(10 * 60_000)
    expect(n).toBe(0)
    f.setHidden(false)
    expect(n).toBe(1)
    expect(f.pending()).toBe(1)
  })
  it('a ticker started while hidden arms only when the tab shows', () => {
    const f = fakeEnv(0)
    f.setHidden(true)
    let n = 0
    minuteTicker(() => n++, f.env)
    expect(f.pending()).toBe(0)
    f.setHidden(false)
    expect([n, f.pending()]).toEqual([1, 1])
  })
})

describe('locale and 12/24-hour time', () => {
  const at = new Date(2026, 9, 6, 21, 43, 30)
  it('24-hour locale: "21:43", the long date, and the accessible name', () => {
    const t = clockText(at, 'en-GB')
    expect(t.time).toBe('21:43')
    expect(t.meridiem).toBe('')
    expect(t.date).toBe('Tuesday 6 October')
    expect(t.label).toBe('Time: 21:43, Tuesday 6 October')
    expect(t.iso).toBe('2026-10-06T21:43')
  })
  it('12-hour locale: "9:43" with its day period beside it, in the name too', () => {
    const t = clockText(at, 'en-US')
    expect(t.time).toBe('9:43')
    expect(t.meridiem).toBe('PM')
    expect(t.label).toBe('Time: 9:43 PM, Tuesday, October 6')
  })
  it('the person can force either cycle over the locale', () => {
    expect(clockText(at, 'en-US', '24').time).toBe('21:43')
    expect(clockText(at, 'en-US', '24').meridiem).toBe('')
    expect(clockText(at, 'en-GB', '12').time).toBe('9:43')
    expect(clockText(at, 'en-GB', '12').meridiem.toLowerCase()).toBe('pm')
    expect(clockText(new Date(2026, 0, 1, 7, 5), 'en-GB', '24').time).toBe('07:05')
  })
  it('other locales keep their own words', () => {
    expect(clockText(at, 'de-DE').time).toBe('21:43')
    expect(clockText(at, 'de-DE').date).toBe('Dienstag, 6. Oktober')
    expect(clockText(at, 'fr-FR').label).toBe('Time: 21:43, mardi 6 octobre')
  })
  it('the stored preference is cleaned to auto, 12 or 24', () => {
    expect(['12', '24', 'auto', 'x', null, 24].map(cleanCycle)).toEqual(['12', '24', 'auto', 'auto', 'auto', 'auto'])
  })
})

describe('when the clock shows', () => {
  it('always, except over the rest, a modal, or a full-bleed app', () => {
    expect(clockShown({ resting: false, modal: false, stage: null })).toBe(true)
    expect(clockShown({ resting: false, modal: false, stage: 'experience' })).toBe(true)
    expect(clockShown({ resting: false, modal: false, stage: 'framed' })).toBe(true)
    expect(clockShown({ resting: true, modal: false, stage: 'experience' })).toBe(false)
    expect(clockShown({ resting: false, modal: true, stage: null })).toBe(false)
    expect(clockShown({ resting: false, modal: false, stage: 'full' })).toBe(false)
  })
})

describe('one slot in every experience', () => {
  const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]
  it.each(VIEWPORTS)('at %o the slot is Ω mirrored: bottom-right, 36 px tall, 12 px in from the edges and safe areas', (v) => {
    for (const safe of [{ right: 0, bottom: 0 }, { right: 47, bottom: 21 }]) {
      const s = clockSlot(v, safe, 64)
      expect(s.right).toBe(v.width - safe.right - CLOCK_MARGIN)
      expect(s.bottom).toBe(v.height - safe.bottom - CLOCK_MARGIN)
      expect(s.bottom - s.top).toBe(CLOCK_HEIGHT)
      // the same row as Ω's glyph (36 px, 12 px from the left and bottom edges)
      expect(CLOCK_HEIGHT).toBe(OMEGA_GLYPH)
      expect(CLOCK_MARGIN).toBe(OMEGA_MARGIN)
    }
  })
  it('the slot does not depend on the experience: one mount, one style rule for place and size', () => {
    const app = read('App.tsx')
    expect(app.match(/<OsClock /g)?.length).toBe(1)
    // mounted outside the experience switch, beside the universal Ask
    expect(app.indexOf('<OsClock ')).toBeGreaterThan(app.indexOf('<AskHost '))
    const css = read('shell/osClock.css')
    const skins = ['classic', 'still', 'canvas', 'cosmos', 'flux', 'construct']
    for (const s of skins) {
      // one rule dresses the clock and the feedback entry beside it
      const block = css.split(`.os-clock[data-skin='${s}'],\n.feedback-entry[data-skin='${s}'] {`)[1]?.split('}')[0]
      expect(block, s).toBeTruthy()
      // a skin dresses the clock; it never moves or resizes it
      expect(block).not.toMatch(/\b(position|right|bottom|left|top|height|width|margin|transform|z-index)\s*:/)
    }
    // the feedback entry shares the corner: one mount beside the clock, placed by its own rule against the clock's slot
    expect(app.match(/<FeedbackHost /g)?.length).toBe(1)
    expect(app.indexOf('<FeedbackHost ')).toBeGreaterThan(app.indexOf('<OsClock '))
    expect(read('features/feedback/feedback.css')).toMatch(/right: calc\(12px \+ env\(safe-area-inset-right, 0px\) \+ var\(--os-clock-slot, 96px\) \+ 8px\)/)
  })
  it('it is registered as kept-clear chrome and steps aside for the rest and modals', () => {
    // what it steps aside for is read from the page in one place, which the feedback entry beside it reads too
    const c = read('shell/OsClock.tsx') + stepAsideSrc
    expect(c).toMatch(/\[KEEP_CLEAR\]: ''/)
    expect(c).toMatch(/aria-live="off"/)
    expect(c).toMatch(/role="timer"/)
    expect(c).toMatch(/\[data-rest\]/)
    expect(c).toMatch(/aria-modal/)
  })
  it('a host notice never covers it (experienceNoticeTop with the clock as a kept-clear box)', () => {
    for (const v of VIEWPORTS) {
      const s = clockSlot(v, { right: 0, bottom: 0 }, 64)
      const clock: Box = s
      const pill = { width: noticePillWidth(v), height: 36 }
      // a full-height side bar forces the pill to search: it must still miss the clock
      const top = experienceNoticeTop(v, ZERO_INSETS, [clock], pill)
      expect(noticeOverlap(v, top, pill, [clock])).toBe(0)
    }
  })
  it('the framed app lane ends before the clock', () => {
    const omega: Box = { left: 12, top: 852, right: 48, bottom: 888 }
    expect(noticeLane(ZERO_INSETS, omega)!.right).toBe(12)
    expect(noticeLane(ZERO_INSETS, omega, undefined, 92)!.right).toBe(92)
  })
  it('room and lift: what the experiences keep clear of it', () => {
    // the clock's slot, then from FEEDBACK_BESIDE_MIN the feedback entry's beside it; narrower, it stands on the clock
    expect(clockRoom(64)).toBe(12 + 64 + 8 + FEEDBACK_SLOT.beside + 8)
    for (const w of [360, 390, 768, 844, FEEDBACK_BESIDE_MIN - 1]) {
      expect(clockRoom(64, 47, feedbackRoom(w)), `${w}`).toBe(47 + 12 + 64 + 8)
      expect(cornerTop(w), `${w}`).toBe(CLOCK_LIFT + FEEDBACK_SLOT.stacked + 8)
    }
    expect(cornerTop(FEEDBACK_BESIDE_MIN)).toBe(CLOCK_LIFT)
    expect(cornerTop(1440)).toBe(CLOCK_LIFT)
    expect(CLOCK_LIFT).toBe(56)
    // every experience's bottom-right chrome reads the room the clock keeps (shell/osClock.css)
    const keepers: [string, RegExp][] = [
      ['shell/Ambient.tsx', /--os-clock-lift/],
      ['shell/Nav.tsx', /--os-clock-room/],
      ['experiences/canvas/overlays.tsx', /--os-clock-room[\s\S]*--os-clock-lift|--os-clock-lift[\s\S]*--os-clock-room/],
      // Cosmos's key hints sit under its top-right controls (Ask phase 2), so nothing of Cosmos stands in the clock's column
      ['experiences/cosmos/index.tsx', /--os-clock-room/],
      ['experiences/cosmos/index.tsx', /data-cx-hint=""[^>]*style=\{\{ top: 72,/],
      ['experiences/flux/index.tsx', /--os-clock-room/],
      ['experiences/construct/construct.css', /--os-clock-room/],
    ]
    for (const [f, re] of keepers) expect(read(f), f).toMatch(re)
    expect(read('shell/osClock.css')).toMatch(/html\[data-os-clock\] \.toast-stack/)
  })
})

describe('the framed lane follows the clock (r2)', () => {
  const omega: Box = { left: 12, top: 852, right: 48, bottom: 888 }
  it('hidden clock: no clearance; shown: the lane ends 8 px before it; a wider clock widens the clearance', () => {
    expect(laneClockRoom(1440, null)).toBe(0)
    expect(laneClockRoom(1440, { left: 0, width: 0 })).toBe(0)
    const narrow = laneClockRoom(1440, { left: 1440 - 12 - 64, width: 64 })
    const wide = laneClockRoom(1440, { left: 1440 - 12 - 80, width: 80 })
    expect(narrow).toBe(12 + 64 + 8)
    expect(wide).toBe(12 + 80 + 8)
    expect(noticeLane(ZERO_INSETS, omega, undefined, narrow)!.right).toBe(84)
    expect(noticeLane(ZERO_INSETS, omega, undefined, wide)!.right).toBe(100)
  })
})

describe('one clock (r2)', () => {
  it("Construct's status bar keeps no clock of its own and no per-second render", () => {
    const bar = constructSrc.slice(constructSrc.indexOf('function StatusBar'), constructSrc.indexOf('function', constructSrc.indexOf('function StatusBar') + 10))
    expect(bar).not.toMatch(/useNow\(/)
    expect(bar).not.toMatch(/toTimeString|toLocaleTimeString/)
  })
  it('the clock stays mounted when it steps aside (hidden), so its box and inert state stay observable', () => {
    expect(read('shell/OsClock.tsx')).toMatch(/hidden=\{!shown\}/)
    expect(read('shell/osClock.css')).toMatch(/\.os-clock\[hidden\] \{ display: none; \}/)
  })
})

describe('the Ask ends before the clock on its row (r2)', () => {
  it('phone and narrow desktop: the capsule stops 12 px before the clock; above the tab bar it keeps its width', async () => {
    const { placeAsk } = await import('../features/ask/placement')
    const base = { layout: 'rail' as const, page: false, tabBar: false, omegaRight: 48 }
    // a phone: too tight between Ω and the clock (audit P1 #1), so it rises above their row instead, at full width
    const { CLOCK_ROW } = await import('../features/ask/placement')
    const phone = placeAsk({ ...base, width: 390, height: 844, clockLeft: 326 })
    expect(phone.bottom).toBeGreaterThanOrEqual(CLOCK_ROW)
    expect(phone.width).toBe(370)
    const narrow = placeAsk({ ...base, width: 800, height: 900, clockLeft: 724 })
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(724 - 12)
    // above the classic tab bar (bottom 74) the Ask is beside the feedback entry standing on the clock: it ends before
    // the corner where that leaves it room enough, and rises above the corner where it does not
    // (classic: no Ω on screen)
    const above = placeAsk({ ...base, omegaRight: null, width: 390, height: 844, tabBar: true, clockLeft: 326 })
    expect(above.bottom).toBe(74)
    expect(above.left + above.width).toBeLessThanOrEqual(326 - 12)
    const tighter = placeAsk({ ...base, omegaRight: null, width: 360, height: 780, tabBar: true, clockLeft: 360 - 12 - 60 })
    expect(tighter.bottom).toBe(cornerTop(360))
    expect(tighter.width).toBe(360 - 20)
  })
})

describe('a fixed slot (r3): nothing around the clock ever has to follow it', () => {
  it('the slot is fixed per viewport class and matches osClock.css', async () => {
    const { CLOCK_SLOT, clockSlotWidth, clockSlotLeft } = await import('./clockModel')
    expect(clockSlotWidth(1440)).toBe(CLOCK_SLOT.desktop)
    expect(clockSlotWidth(768)).toBe(CLOCK_SLOT.desktop)
    expect(clockSlotWidth(767)).toBe(CLOCK_SLOT.phone)
    // the corner's left edge: the feedback entry's slot left of the clock's where it stands beside it, else the clock's
    expect(clockSlotLeft(390)).toBe(390 - 12 - CLOCK_SLOT.phone)
    expect(clockSlotLeft(844, 47)).toBe(844 - 47 - 12 - CLOCK_SLOT.desktop)
    expect(clockSlotLeft(1024, 47)).toBe(1024 - 47 - 12 - CLOCK_SLOT.desktop - FEEDBACK_SLOT.beside - 8)
    const css = read('shell/osClock.css')
    expect(css).toContain(`--os-clock-slot: ${CLOCK_SLOT.desktop}px;`)
    expect(css).toContain(`--feedback-slot: ${FEEDBACK_SLOT.beside}px;`)
    expect(css).toContain(`html[data-os-clock] { --os-clock-slot: ${CLOCK_SLOT.phone}px; }`)
    // the entry stands on the clock below FEEDBACK_BESIDE_MIN, at the same width in the corner's CSS and the entry's own
    expect(css).toContain(`@media (max-width: ${FEEDBACK_BESIDE_MIN - 1}px) {\n  html[data-os-clock] { --feedback-slot: ${FEEDBACK_SLOT.stacked}px; --feedback-room: 0px; --feedback-lift: ${FEEDBACK_SLOT.stacked + 8}px; }`)
    expect(read('features/feedback/feedback.css')).toContain(`@media (max-width: ${FEEDBACK_BESIDE_MIN - 1}px) {\n  .feedback-entry { right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(56px + var(--sab, 0px)); width: ${FEEDBACK_SLOT.stacked}px;`)
    expect(css).toContain('--os-clock-room: calc(env(safe-area-inset-right, 0px) + 12px + var(--os-clock-slot) + 8px + var(--feedback-room));')
    expect(css).toContain('--os-clock-lift: calc(var(--sab, 0px) + 56px + var(--feedback-lift));')
    // the box never grows past the slot; a long day period is clipped, not allowed to widen it
    expect(css).toMatch(/max-width: var\(--os-clock-slot/)
    expect(read('shell/OsClock.tsx')).not.toMatch(/--os-clock-w/)
  })
  it('the Ask, placed against the slot, clears the widest clock the slot allows', async () => {
    const { placeAsk } = await import('../features/ask/placement')
    const { clockSlotLeft } = await import('./clockModel')
    for (const [w, h] of [[390, 844], [360, 780], [800, 900], [844, 390]]) {
      const p = placeAsk({ layout: 'rail', page: false, tabBar: false, omegaRight: 48, width: w, height: h, clockLeft: clockSlotLeft(w) })
      // on the clock's row it ends before the clock; a phone too tight for that is above the row (audit P1 #1)
      if (p.bottom < 12 + 36 + 8) expect(p.left + p.width, `${w}x${h}`).toBeLessThanOrEqual(clockSlotLeft(w) - 12)
      else expect(p.mode, `${w}x${h}`).toBe('phone')
    }
  })
})
