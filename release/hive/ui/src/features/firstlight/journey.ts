/**
 * The journey's pure rules (tested): which steps apply now, where Next and Back go, and how each beat stands
 * (ready / skipped / blocked; "comes later" for the beats not in this round). The store (store.ts) drives these
 * against the host's real answers; nothing here reads the network or the screen.
 */
import type { MonthlyLimit } from './host'
import { BEATS, R2_BEATS, type Beat, type FlPath, type FlStep, type FlWhen } from './script'

export type BeatState = 'pending' | 'active' | 'ready' | 'skipped' | 'blocked' | 'later'

export interface BeatStatus {
  state: BeatState
  /** the plain line it ended with (ready: from the host's real answer) */
  line: string | null
}
export type Beats = Record<Beat, BeatStatus>

export function freshBeats(): Beats {
  const out = {} as Beats
  for (const b of BEATS) out[b.id] = { state: b.r2 ? 'pending' : 'later', line: b.r2 ? null : 'Comes in a later version of First Light.' }
  return out
}

/** What `when` is checked against: the host's answers and what happened so far. */
export interface Facts {
  path: FlPath
  /** the hive holds no mind but the person's own (null: not known, read as "not only") */
  onlyMind: boolean | null
  limit: MonthlyLimit | null
  lookKept: boolean
  greeted: boolean
  beats: Beats
  /** R3: how many apps are ready for this person (null: not read, or unreadable) */
  apps?: number | null
  /** R3: the person saved their Ask in beat 6 */
  askSaved?: boolean
}

/** Every beat of this round so far (before hello) is ready. */
export const allReadyBefore = (beats: Beats, beat: Beat): boolean => R2_BEATS.filter((b) => BEATS.findIndex((x) => x.id === b) < BEATS.findIndex((x) => x.id === beat)).every((b) => beats[b].state === 'ready')

export function holds(when: FlWhen | undefined, f: Facts): boolean {
  switch (when) {
    case undefined:
      return true
    case 'only-mind':
      return f.onlyMind === true
    case 'not-only-mind':
      return f.onlyMind !== true
    case 'limit-enforced':
      return !!f.limit?.enforced
    case 'limit-not-enforced':
      return !f.limit?.enforced
    case 'all-ready':
      return allReadyBefore(f.beats, 'hello')
    case 'not-all-ready':
      return !allReadyBefore(f.beats, 'hello')
    case 'look-kept':
      return f.lookKept
    case 'greeted':
      return f.greeted
    case 'apps-ready':
      return (f.apps ?? 0) > 0
    case 'no-apps':
      return !((f.apps ?? 0) > 0)
    case 'ask-saved':
      return !!f.askSaved
    case 'greeted-app':
      return f.greeted && (f.apps ?? 0) > 0
  }
}

/** The next step from `i` (exclusive) that applies now; -1 at the end. */
export function nextIndex(steps: readonly FlStep[], i: number, f: Facts): number {
  for (let j = i + 1; j < steps.length; j++) if (holds(steps[j].when, f)) return j
  return -1
}
/** The step before `i` that applies now (a step that waits for the person is a fine place to go back to). */
export function prevIndex(steps: readonly FlStep[], i: number, f: Facts): number {
  for (let j = i - 1; j >= 0; j--) if (holds(steps[j].when, f)) return j
  return i
}
/** The first step of `beat` that applies now (or the next beat's, when none of it does); -1 when none is left. */
export function startOf(steps: readonly FlStep[], beat: Beat, f: Facts): number {
  const at = steps.findIndex((s) => s.beat === beat)
  if (at < 0) return -1
  return holds(steps[at].when, f) ? at : nextIndex(steps, at, f)
}
/** The first step after the current beat (skipping the rest of it). */
export function afterBeat(steps: readonly FlStep[], i: number, f: Facts): number {
  const beat = steps[i]?.beat
  let j = i
  while (j + 1 < steps.length && steps[j + 1].beat === beat) j++
  return nextIndex(steps, j, f)
}

/** Whether a step waits for the person (never auto-advanced). */
export const waitsForPerson = (s: FlStep | undefined): boolean => !!s?.wait && s.wait.for !== 'time'

/** The marks, for the screen and for a screen reader: each beat's number, name and state in words. */
export function markWords(state: BeatState): string {
  switch (state) {
    case 'ready':
      return 'Done'
    case 'skipped':
      return 'Later'
    case 'blocked':
      return 'Needs you'
    case 'active':
      return 'Now'
    case 'later':
      return 'Comes later'
    default:
      return 'Not yet'
  }
}

/** The beats the host's record says are done or skipped, as states (a resumed journey shows them so). */
export function beatsFromRecord(done: readonly Beat[], skipped: readonly Beat[]): Beats {
  const b = freshBeats()
  for (const id of R2_BEATS) {
    if (done.includes(id)) b[id] = { state: 'ready', line: 'Done earlier.' }
    else if (skipped.includes(id)) b[id] = { state: 'skipped', line: 'Later' }
  }
  return b
}

/** Where a resumed journey starts: the record's current beat if it is in this round, else the first not yet done. */
export function resumeBeat(current: Beat | null, beats: Beats): Beat {
  if (current && R2_BEATS.includes(current) && beats[current].state !== 'ready') return current
  return R2_BEATS.find((b) => beats[b].state === 'pending' || beats[b].state === 'blocked') ?? 'arrive'
}

/** The journey is finished (for the host's record) when every beat of this round is ready or skipped. */
export const roundResolved = (beats: Beats): boolean => R2_BEATS.every((b) => beats[b].state === 'ready' || beats[b].state === 'skipped')
