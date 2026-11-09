/**
 * Hive power (Jon, 2026-10-05 ~23:40: Off, Quiet and Wake all): the host's shapes and nothing else. This file is the
 * ONE place that knows the wire. Pinned to the live host cf8bd9c (power 7973ca4; shape-equivalent to 293fe18):
 *
 *   GET  /api/hive/power -> {state: 'on'|'off', since, by} (anyone signed in); an admin also gets minds_in_snapshot
 *        (0 when none). While on, since/by are the latest restore's (who turned it back on); while off, who turned it off.
 *   POST /api/hive/power {state, operation_id <= 128 chars} (admin; a replay of a FINISHED run returns its result, but
 *        a run cut short by a failure or restart is REDONE by a replay, so a retry after a lost answer may come back
 *        with different counts: that answer is authoritative, and the page re-reads GET afterwards; the same id with
 *        the other state is 409 operation_conflict). Each mind is recorded in the snapshot before its stop (no UI effect).
 *        off -> {state: 'off', since, stopped: n, failed: [{id, error}]}          a failed mind is STILL RUNNING
 *        on  -> {state: 'on', since, woken: [id], skipped: [{id, reason}], failed: [{id, error}]}   (also Wake all)
 *   event hive.power {state, since} to everyone, after each off or on (also an on that woke nothing)
 *   Plain Stop all is separate: 500 stop_incomplete with details {stopped, failed}; it records the snapshot too.
 *
 * Results normalise to Tallies (a count, or a list), so a change in the pin stays in this file.
 */

import { plural } from '../../lib/plural'

export type PowerState = 'on' | 'off'

export interface PowerStatus {
  state: PowerState
  since: string | null
  by: string | null
  /** Admins only: how many minds the pending snapshot would wake (0 when none). Never used as a role check. */
  minds_in_snapshot?: number
}

export interface PowerBody {
  state: PowerState
  operation_id: string
}

/** A mind named in a result. `why` is the host's own reason (a failure's error, a skip's reason), shown verbatim. */
export interface PowerMind {
  id: string
  name?: string
  why?: string
}
/** How many, and which when the host says. `count` is authoritative; `minds` may be empty when only a count came. */
export interface Tally {
  count: number
  minds: PowerMind[]
}
export interface OffResult {
  kind: 'off'
  stopped: Tally
  failed: Tally
}
export interface OnResult {
  kind: 'on'
  woken: Tally
  skipped: Tally
  failed: Tally
}
export type PowerResult = OffResult | OnResult

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined)

function mind(v: unknown): PowerMind | null {
  if (typeof v === 'string') return v ? { id: v } : null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = str(o.id) ?? str(o.agent_id)
  if (!id) return null
  return { id, name: str(o.name), why: str(o.error) ?? str(o.reason) ?? str(o.why) }
}

/** A count, a list of ids, or a list of records; anything else is an empty tally (never a guess). */
export function tally(v: unknown): Tally {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return { count: Math.floor(v), minds: [] }
  if (Array.isArray(v)) {
    const minds = v.map(mind).filter((m): m is PowerMind => !!m)
    return { count: minds.length, minds }
  }
  return { count: 0, minds: [] }
}

export function readStatus(v: unknown): PowerStatus | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.state !== 'on' && o.state !== 'off') return null
  const out: PowerStatus = { state: o.state, since: str(o.since) ?? null, by: str(o.by) ?? null }
  if (typeof o.minds_in_snapshot === 'number' && Number.isFinite(o.minds_in_snapshot)) out.minds_in_snapshot = Math.max(0, Math.floor(o.minds_in_snapshot))
  return out
}

export function readResult(state: PowerState, v: unknown): PowerResult {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return state === 'off'
    ? { kind: 'off', stopped: tally(o.stopped), failed: tally(o.failed) }
    : { kind: 'on', woken: tally(o.woken), skipped: tally(o.skipped), failed: tally(o.failed) }
}

/** The hive.power event, if well formed. */
export function readPowerEvent(e: unknown): { state: PowerState; since: string | null } | null {
  if (!e || typeof e !== 'object') return null
  const o = e as Record<string, unknown>
  if (o.type !== 'hive.power' || (o.state !== 'on' && o.state !== 'off')) return null
  return { state: o.state, since: str(o.since) ?? null }
}

/**
 * What stays usable while the hive is off (Platform, 2026-10-05): the events socket, GET/POST power, and sign-in.
 * Every other client method is refused by the page without a request (features/power/gate.ts). `me` is the auth
 * route /api/auth/me. The synchronous members are here too: they make no request.
 */
export const OPEN_WHILE_OFF: ReadonlySet<string> = new Set([
  'mode',
  'needsAuth',
  'login',
  'logout',
  'authMethods',
  'trySso',
  'me',
  'connect',
  'disconnect',
  'subscribe',
  'onConnection',
  'getPower',
  'setPower',
  'flowStudioUrl',
  // the person-session observer (Platform 439efb9): synchronous, no request; a gated one would answer a Promise
  'authContext',
  'onAuthChange',
])

export const HIVE_OFF_CODE = 'hive_off'


/** A skip reason in plain words: the host's 'deleted', 'swarm archived', 'moved', or the mind's current status. */
export function reasonWords(reason: string | undefined): string {
  switch (reason) {
    case undefined:
      return 'skipped'
    case 'deleted':
      return 'deleted'
    case 'swarm archived':
      return 'its swarm is archived'
    case 'moved':
      return 'moved'
    case 'asleep':
      return 'asleep'
    case 'awake':
    case 'starting':
      return `not stopped (${reason === 'awake' ? 'already awake' : 'already starting'})`
    default:
      return `not stopped (${reason})`
  }
}

/** Mind ids to names where the page knows them (the host's results carry ids only). */
export type NameOf = (id: string) => string | undefined

function names(t: Tally, nameOf: NameOf, words: (why: string | undefined) => string | undefined, max = 6): string {
  const shown = t.minds.slice(0, max).map((m) => {
    const who = nameOf(m.id) ?? m.name ?? m.id
    const why = words(m.why)
    return why ? `${who} (${why})` : who
  })
  const more = t.count - shown.length
  if (more <= 0) return shown.join(', ')
  return shown.length ? `${shown.join(', ')} and ${more} more` : ''
}

/** The honest result, in plain words: every count the host gave, every skip and failure by name. */
export function resultWords(r: PowerResult, nameOf: NameOf = () => undefined): { headline: string; detail: string[]; ok: boolean; nothing: boolean } {
  const err = (why: string | undefined) => why
  if (r.kind === 'off') {
    const detail: string[] = []
    if (r.failed.count) {
      const who = names(r.failed, nameOf, err)
      detail.push(`${plural(r.failed.count, 'mind')} could not be stopped and ${r.failed.count === 1 ? 'is' : 'are'} still running${who ? `: ${who}` : ''}.`)
    }
    return { headline: r.stopped.count ? `Stopped ${plural(r.stopped.count, 'mind')}.` : 'No mind was running.', detail, ok: r.failed.count === 0, nothing: false }
  }
  if (!r.woken.count && !r.skipped.count && !r.failed.count) return { headline: 'Nothing to wake.', detail: [], ok: true, nothing: true }
  const detail: string[] = []
  if (r.skipped.count) {
    const who = names(r.skipped, nameOf, reasonWords)
    detail.push(`Skipped ${plural(r.skipped.count, 'mind')}${who ? `: ${who}` : ''}.`)
  }
  if (r.failed.count) {
    const who = names(r.failed, nameOf, err)
    detail.push(`${plural(r.failed.count, 'mind')} did not wake${who ? `: ${who}` : ''}.`)
  }
  return { headline: r.woken.count ? `Woke ${plural(r.woken.count, 'mind')}.` : 'No mind woke.', detail, ok: r.failed.count === 0, nothing: false }
}

/** Who a `by` principal is, in plain words ("user:operator" is the hive's operator; "user:p_x" a person's id). */
export function whoWords(by: string | null | undefined): string | null {
  if (!by) return null
  const id = by.replace(/^user:/, '')
  return id === 'operator' ? 'the operator' : id
}
