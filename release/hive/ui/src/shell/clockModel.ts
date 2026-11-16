import { useSyncExternalStore } from 'react'

/**
 * The OS clock (shell/OsClock.tsx): one host clock, in the same place in every experience, page and app form.
 *
 * Where it sits (the clock slot): the bottom-right corner, on Ω's row. Ω is the host's bottom-left corner, the Ask is
 * the host's bottom centre, the clock is the host's bottom-right corner: the three are the host's own bottom row, and
 * the clock's glyph box is Ω's mirror image (36 px tall, 12 px in from the right and bottom edges plus the safe areas),
 * so the two corners line up on every screen. Experiences keep their own chrome clear of it, as they do of Ω:
 * bottom-row chrome ends `--os-clock-room` from the right edge; right-column chrome sits `--os-clock-lift` above the
 * bottom. The clock is also a `data-xc-keep-clear` box, so host notices and the Ask never cover it.
 *
 * The feedback entry (features/feedback/FeedbackHost.tsx) shares the corner, so a person sees on every page where to
 * send feedback or report a bug. From `FEEDBACK_BESIDE_MIN` (1024 px) it stands just left of the clock's slot, and
 * `--os-clock-room` and `clockSlotLeft` keep bottom-row chrome clear of both; narrower, where bottom rows are full (a
 * phone's tab bar, Canvas's tools beside a tablet's clock), it stands on the clock, so the corner is a column
 * `cornerTop` tall and `--os-clock-lift` rises with it.
 *
 * Everything here is pure (or a tiny local store), so it is tested without a browser.
 */

/** The clock's box: as tall as Ω's glyph, as far in from the edges as Ω (lib/frameFit OMEGA_GLYPH, OMEGA_MARGIN). */
export const CLOCK_HEIGHT = 36
export const CLOCK_MARGIN = 12
/** Space kept between the clock and the chrome beside or above it. */
export const CLOCK_GAP = 8

/** The bottom-right slot, in viewport px, for a clock `width` wide (safe areas included). Pure: one geometry for every experience. */
export function clockSlot(viewport: { width: number; height: number }, safe: { right: number; bottom: number }, width: number) {
  const right = viewport.width - safe.right - CLOCK_MARGIN
  const bottom = viewport.height - safe.bottom - CLOCK_MARGIN
  return { left: right - width, top: bottom - CLOCK_HEIGHT, right, bottom }
}

/**
 * The clock's reserved width (osClock.css `--os-clock-slot`): its box is never wider, whatever the locale, hour cycle or
 * minute (a long day period is clipped; the accessible name has it in full). Desktop fits "12:59 PM" in every skin;
 * a phone shows hours and minutes only. Fixed, so nothing around the clock ever has to follow it.
 */
export const CLOCK_SLOT = { desktop: 96, phone: 60 } as const
/** The slot for a viewport width (phones are under 768 px, as in osClock.css). */
export const clockSlotWidth = (viewportWidth: number) => (viewportWidth >= 768 ? CLOCK_SLOT.desktop : CLOCK_SLOT.phone)
/**
 * The feedback entry's reserved width (osClock.css `--feedback-slot`): beside the clock, a pill with its icon and the
 * word "Feedback" in every skin; standing on it, its icon alone. Fixed, as the clock's slot is.
 */
export const FEEDBACK_SLOT = { beside: 112, stacked: 36 } as const
/**
 * The narrowest window whose bottom row holds the entry beside the clock in every experience (osClock.css and
 * feedback.css use the same width). Canvas's full tools bar, the widest bottom-row chrome that does not shrink, is
 * 553 px wide and centred, so it clears a corner widened by the entry (12 + 96 + 8 + 112 + 8 = 236 px) from 1024 px,
 * where it spans 236 to 788 px and the room starts at 788 px. Narrower windows (a tablet held upright, a phone on its
 * side) stack the entry on the clock, as a phone does.
 */
export const FEEDBACK_BESIDE_MIN = 1024
const beside = (viewportWidth: number) => viewportWidth >= FEEDBACK_BESIDE_MIN
export const feedbackSlotWidth = (viewportWidth: number) => (beside(viewportWidth) ? FEEDBACK_SLOT.beside : FEEDBACK_SLOT.stacked)
/** How much wider the corner is for the entry beside the clock; narrower windows stack it on the clock instead. */
export const feedbackRoom = (viewportWidth: number) => (beside(viewportWidth) ? FEEDBACK_SLOT.beside + CLOCK_GAP : 0)
/**
 * The corner's left edge (the feedback entry's slot left of the clock's where it stands beside it, else the clock's
 * slot, which is wider than the entry standing on it): where chrome beside the corner (the Ask) must stop, before
 * `CLOCK_GAP`.
 */
export const clockSlotLeft = (viewportWidth: number, safeRight = 0) =>
  viewportWidth - safeRight - CLOCK_MARGIN - clockSlotWidth(viewportWidth) - feedbackRoom(viewportWidth)
/** How high the corner reaches above the bottom safe area: the clock's row, and the entry where it stands on the clock. */
export const cornerTop = (viewportWidth: number) =>
  CLOCK_MARGIN + CLOCK_HEIGHT + CLOCK_GAP + (beside(viewportWidth) ? 0 : FEEDBACK_SLOT.stacked + CLOCK_GAP)

/**
 * How far from the right edge bottom-row chrome must end to keep clear of the corner, a clock slot `width` wide and
 * `entryRoom` more for the feedback entry beside it (`feedbackRoom`: none where it stands on the clock) (the
 * `--os-clock-room` value).
 */
export const clockRoom = (width: number, safeRight = 0, entryRoom: number = feedbackRoom(FEEDBACK_BESIDE_MIN)) =>
  Math.ceil(safeRight + CLOCK_MARGIN + width + CLOCK_GAP + entryRoom)
/**
 * The framed notice lane's right clearance for the clock's measured box (lib/frameFit noticeLane `clockRoom`): from the
 * right edge to the clock's left side plus `gap`; 0 while the clock is hidden (an empty box).
 */
export const laneClockRoom = (viewportWidth: number, clock: { left: number; width: number } | null | undefined, gap = CLOCK_GAP): number =>
  clock && clock.width > 0 ? Math.ceil(viewportWidth - clock.left + gap) : 0

/** How far above the bottom edge (before the safe area) right-column chrome must start (the `--os-clock-lift` value). */
export const CLOCK_LIFT = CLOCK_MARGIN + CLOCK_HEIGHT + CLOCK_GAP

/** Milliseconds until the next minute boundary (local time keeps whole-minute offsets, so UTC minutes are local minutes). */
export function msToNextMinute(now: number): number {
  const into = ((now % 60_000) + 60_000) % 60_000
  return 60_000 - into
}

export type HourCycle = 'auto' | '12' | '24'

export interface ClockText {
  /** what the clock shows: "21:43", or "9:43" with `meridiem` "PM" */
  time: string
  /** "AM" / "PM" (or the locale's day period) in 12-hour time, shown small beside the time; empty in 24-hour time */
  meridiem: string
  /** the long date, shown on hover and focus: "Tuesday 6 October" */
  date: string
  /** the accessible name: "Time: 21:43, Tuesday 6 October" */
  label: string
  /** machine-readable local time for <time dateTime>: "2026-10-06T21:43" */
  iso: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The clock's words for `at` in the person's locale (undefined: the browser's own) and hour cycle ('auto' follows the
 * locale). Hours and minutes only; the date is the locale's long weekday, day and month.
 */
export function clockText(at: Date, locale?: string | string[], cycle: HourCycle = 'auto'): ClockText {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  if (cycle === '12') opts.hourCycle = 'h12'
  if (cycle === '24') {
    opts.hourCycle = 'h23'
    opts.hour = '2-digit'
  }
  const fmt = new Intl.DateTimeFormat(locale, opts)
  const parts = fmt.formatToParts(at)
  const meridiem = parts.find((p) => p.type === 'dayPeriod')?.value ?? ''
  // the time without its day period: "9:43" (the period is drawn small beside it)
  const time = parts
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim()
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(at)
  const spoken = meridiem ? `${time} ${meridiem}` : time
  const iso = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
  return { time, meridiem, date, label: `Time: ${spoken}, ${date}`, iso }
}

/** Whether the clock shows: never over the rest (it has its own big clock), a modal, or a full-bleed app (which owns the whole stage). */
export function clockShown(s: { resting: boolean; modal: boolean; stage: 'framed' | 'full' | 'experience' | null }): boolean {
  return !s.resting && !s.modal && s.stage !== 'full'
}

// ---------------------------------------------------------------- the person's hour cycle (this device)

const KEY = 'omegahive.ui.clock'
const subs = new Set<() => void>()

export const cleanCycle = (v: unknown): HourCycle => (v === '12' || v === '24' ? v : 'auto')

function read(): HourCycle {
  try {
    return typeof window === 'undefined' ? 'auto' : cleanCycle(window.localStorage.getItem(KEY))
  } catch {
    return 'auto'
  }
}
let cycle: HourCycle = read()

/** 12- or 24-hour time, or 'auto' (the locale's own). Remembered in this browser, like the rail and the frame-rate meter. */
export function setHourCycle(next: HourCycle): void {
  cycle = cleanCycle(next)
  try {
    if (cycle === 'auto') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, cycle)
  } catch {
    /* storage unavailable: remembered for this page only */
  }
  subs.forEach((f) => f())
}

export function useHourCycle(): HourCycle {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    () => cycle,
    () => 'auto' as HourCycle,
  )
}

// ---------------------------------------------------------------- the minute ticker

export interface TickerEnv {
  now: () => number
  setTimeout: (f: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  hidden: () => boolean
  /** subscribe to visibility changes; returns the unsubscribe */
  onVisibility: (f: () => void) => () => void
}

/** A little after the boundary, so a timer that fires a hair early still lands in the new minute. */
export const TICK_SLACK = 25

/**
 * Calls `tick` at each minute boundary (one timer per minute, never a per-second loop). While the page is hidden no
 * timer runs at all; when it shows again `tick` runs at once (the minute may have changed) and the next boundary is
 * armed. Returns the stop function.
 */
export function minuteTicker(tick: () => void, env: TickerEnv): () => void {
  let id: number | null = null
  const disarm = () => {
    if (id !== null) env.clearTimeout(id)
    id = null
  }
  const arm = () => {
    disarm()
    id = env.setTimeout(() => {
      id = null
      tick()
      arm()
    }, msToNextMinute(env.now()) + TICK_SLACK)
  }
  const unsub = env.onVisibility(() => {
    if (env.hidden()) disarm()
    else {
      tick()
      arm()
    }
  })
  if (!env.hidden()) arm()
  return () => {
    disarm()
    unsub()
  }
}

/** The browser's ticker environment. */
export const browserTicker = (): TickerEnv => ({
  now: () => Date.now(),
  setTimeout: (f, ms) => window.setTimeout(f, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  hidden: () => document.hidden,
  onVisibility: (f) => {
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  },
})
