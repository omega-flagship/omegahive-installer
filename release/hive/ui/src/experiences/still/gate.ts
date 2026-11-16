/**
 * The decision gate: when may a Yes, No or Later reach a request? Pure, so it can be proved without a browser.
 *
 * One intended decision must never authorise two different requests. So an activation only counts when:
 *  - it is not keyboard auto-repeat (a held Y, N, L or Enter);
 *  - it was aimed at the request on screen when it began (not one that arrived, moved up or replaced it since);
 *  - no decision is in flight, for this request or any other (busy spans consecutive cards);
 *  - the request has been on screen for at least ARM_MS (time to see that it changed);
 *  - for keys: the key used for the previous decision has been released since (keyup), so a key held down
 *    through a card change cannot carry over.
 */

export const ARM_MS = 700

export interface GateState {
  /** The request on screen now. */
  currentId: string | null
  /** When it became the one on screen. */
  shownAt: number
  /** A decision in flight (any request). */
  inFlight: string | null
  /** A key has been released since the last keyboard decision. */
  released: boolean
}

export type Activation =
  | { kind: 'key'; key: string; repeat: boolean; at: number; boundId: string }
  /** Mouse, touch, or an assistive technology's click: no key to release. */
  | { kind: 'pointer'; at: number; boundId: string }

export type Refusal = 'repeat' | 'stale' | 'busy' | 'arming' | 'held'
export type Verdict = { ok: true } | { ok: false; why: Refusal }

export const initialGate: GateState = { currentId: null, shownAt: 0, inFlight: null, released: true }

/** The request on screen changed (decision, new arrival, reorder, "later"). Arms the interval again. */
export function shown(s: GateState, id: string | null, at: number): GateState {
  return id === s.currentId ? s : { ...s, currentId: id, shownAt: at }
}

export function canActivate(s: GateState, e: Activation): Verdict {
  if (e.kind === 'key' && e.repeat) return { ok: false, why: 'repeat' }
  if (e.boundId !== s.currentId) return { ok: false, why: 'stale' }
  if (s.inFlight) return { ok: false, why: 'busy' }
  if (e.at - s.shownAt < ARM_MS) return { ok: false, why: 'arming' }
  if (e.kind === 'key' && !s.released) return { ok: false, why: 'held' }
  return { ok: true }
}

/** A decision began (Yes or No, sent to the hive). `later` only reorders, so nothing stays in flight. */
export function began(s: GateState, e: Activation, inFlight: boolean): GateState {
  return { ...s, inFlight: inFlight ? e.boundId : s.inFlight, released: e.kind === 'key' ? false : s.released }
}

/** The hive answered, or failed to (always called, in a finally). */
export function settled(s: GateState, id: string): GateState {
  return s.inFlight === id ? { ...s, inFlight: null } : s
}

/** Any key went up (or the window lost focus, which can swallow the keyup). */
export function keyUp(s: GateState): GateState {
  return s.released ? s : { ...s, released: true }
}

/** Plain words for a refused activation, for the live region. Silent for repeats and in-flight presses. */
export function refusalWords(why: Refusal): string | null {
  if (why === 'arming') return 'This request just appeared. Take a moment to read it, then answer.'
  if (why === 'held') return 'Let go of the key, read this request, then answer.'
  if (why === 'stale') return 'The request on screen changed. Read it, then answer.'
  return null
}
