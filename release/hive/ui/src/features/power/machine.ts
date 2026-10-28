import type { PowerResult, PowerState, PowerStatus } from './api'
import type { GateState } from './gate'

/**
 * The one power state machine every experience shares (each only draws it: features/power/OffScreen.tsx).
 *
 *   gate     what the page knows: unknown until GET /api/hive/power (or hive.power) answers
 *   wake     the off screen's own sequence: idle -> lighting (the light-up plays) -> report (the honest result) -> idle
 *   pending  our own POST on is still in flight; the report waits for it (and for the light-up), never for an event
 *
 * Pure: the store (store.ts) feeds it reads, events and answers; tests drive it directly.
 */
export interface PowerView {
  gate: GateState
  since: string | null
  by: string | null
  snapshot: number | null
  /** null until the signed-in person's role is known (me() is an auth route: it stays open while off). */
  admin: boolean | null
  wake: 'idle' | 'lighting' | 'report'
  pending: boolean
  animDone: boolean
  /** The last result to report: Off's on the off screen, the power button's in the report. */
  result: PowerResult | null
  /** A calm line when there is no result to give (refused, or the answer was lost). */
  note: string | null
}

export const INITIAL: PowerView = { gate: 'unknown', since: null, by: null, snapshot: null, admin: null, wake: 'idle', pending: false, animDone: false, result: null, note: null }

export type PowerAction =
  | { type: 'status'; status: PowerStatus }
  | { type: 'event'; state: PowerState; since: string | null }
  | { type: 'unreadable' }
  | { type: 'admin'; admin: boolean }
  | { type: 'press' }
  /**
   * Our POST on's answer. `current`: no newer hive.power was seen while it was in flight, so its state (applied by the
   * store as an observation before this) is the hive's; otherwise it is only the report of what that request did.
   */
  | { type: 'answered'; result: PowerResult; current: boolean }
  | { type: 'failed'; note: string; on: boolean }
  | { type: 'lit' }
  | { type: 'offAnswered'; result: PowerResult }
  | { type: 'dismiss' }
  | { type: 'signedOut' }

/** off -> on seen while the off screen is up and idle: everyone watches the light-up (someone else pressed it). */
function toState(v: PowerView, state: PowerState, since: string | null, extra: Partial<PowerView> = {}): PowerView {
  const next: PowerView = { ...v, ...extra, gate: state, since: since ?? v.since }
  if (state === 'on' && v.gate === 'off' && v.wake === 'idle') return { ...next, wake: 'lighting', pending: false, animDone: false, result: null, note: null }
  if (state === 'off') {
    // a hive turned off again mid-report goes back to dark; an off result stays for the admin to read
    if (v.wake !== 'idle') return { ...next, wake: 'idle', pending: false, animDone: false, result: v.result?.kind === 'off' ? v.result : null }
    if (v.gate !== 'off' && v.result?.kind === 'on') return { ...next, result: null, note: null }
  }
  return next
}

/** lighting ends once the light-up has played AND our own answer (if we asked) is in. */
function settle(v: PowerView): PowerView {
  if (v.wake !== 'lighting' || !v.animDone || v.pending) return v
  return v.result || v.note ? { ...v, wake: 'report' } : { ...v, wake: 'idle' }
}

export function powerReducer(v: PowerView, a: PowerAction): PowerView {
  switch (a.type) {
    case 'status': {
      const snap = a.status.minds_in_snapshot ?? null
      return toState(v, a.status.state, a.status.since, { by: a.status.by, snapshot: snap })
    }
    case 'event':
      return toState(v, a.state, a.since)
    case 'unreadable':
      // no power route (an older host) or no answer: the page never strands anyone behind a screen it cannot justify
      return v.gate === 'unknown' ? { ...v, gate: 'on' } : v
    case 'admin':
      return { ...v, admin: a.admin }
    case 'press':
      if (v.admin !== true || v.gate !== 'off' || v.wake !== 'idle') return v
      return { ...v, wake: 'lighting', pending: true, animDone: false, result: null, note: null }
    case 'answered': {
      // f0b412fc B2: an answer never sets the gate; the hive's state comes from events and valid reads (the store
      // applies a current answer as an observation first). A superseded answer is still reported, honestly, as is.
      if (a.result.kind !== 'on') return v
      if (a.current) return settle({ ...v, pending: false, result: a.result, note: null })
      const note = v.gate === 'off' ? 'The hive has been turned off again since.' : 'The hive’s power has changed again since; what you see now is read afresh.'
      const next: PowerView = { ...v, pending: false, result: a.result, note }
      // the light already went back out (a newer off): the report is still shown, over the dark
      return v.wake === 'lighting' ? settle(next) : { ...next, wake: 'report', animDone: true }
    }
    case 'failed':
      // refused or unconfirmed: if the hive is (still) off the light goes back out and the button returns
      if (!a.on) return { ...v, wake: 'idle', pending: false, animDone: false, result: null, note: a.note, gate: v.gate === 'unknown' ? 'off' : v.gate }
      // the hive's state itself came from the read the store applied first
      return settle({ ...v, pending: false, note: a.note })
    case 'lit':
      return settle({ ...v, animDone: true })
    case 'offAnswered':
      return a.result.kind === 'off' ? { ...v, result: a.result, note: null } : v
    case 'dismiss':
      return { ...v, wake: v.wake === 'report' ? 'idle' : v.wake, result: null, note: null }
    case 'signedOut':
      return { ...INITIAL }
  }
}

export type Screen = 'none' | 'off' | 'lighting' | 'report'

/** What every experience draws. */
export function screenOf(v: PowerView): Screen {
  if (v.wake === 'lighting') return 'lighting'
  if (v.wake === 'report') return 'report'
  return v.gate === 'off' ? 'off' : 'none'
}

/** The power button is offered only to a known admin, on a dark, idle off screen. */
export const canPress = (v: PowerView): boolean => v.admin === true && v.gate === 'off' && v.wake === 'idle'
