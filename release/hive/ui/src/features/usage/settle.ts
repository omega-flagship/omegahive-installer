import type { CostOverrun, CostReservation } from '../../api/moneyWork'

/** Dollars a person typed ("0.31", "$0.31", "1,204.50"), or null when it is not a finite amount of zero or more. */
export function parseUsd(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,6})?$|^\.\d{1,6}$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Why a settle cannot be sent yet (null when it can). The hive needs the provider's real cost and a reason. */
export function settleBlocked(amount: string, reason: string): string | null {
  if (!amount.trim()) return 'Enter the real cost from the provider’s billing to settle.'
  if (parseUsd(amount) === null) return 'The real cost must be an amount in dollars, zero or more (up to 6 decimals).'
  if (!reason.trim()) return 'Give a reason: it is recorded with the decision.'
  return null
}

export function releaseBlocked(reason: string): string | null {
  return reason.trim() ? null : 'Give a reason to release: it is recorded with the decision.'
}

/**
 * Whether a person may settle this call now. The hive's own answer (`resolvable`, coming from Platform) wins; without
 * it, today's rule: only an unknown-outcome call. Never guessed from timing the hive did not send.
 */
export const canSettle = (r: CostReservation): boolean => (typeof r.resolvable === 'boolean' ? r.resolvable : r.state === 'unknown')

/** Calls a person may settle now, and the rest (still in flight). */
export function splitReservations(rows: CostReservation[]): { toSettle: CostReservation[]; inFlight: CostReservation[] } {
  return { toSettle: rows.filter(canSettle), inFlight: rows.filter((r) => !canSettle(r)) }
}

/** "3h 12m", "45m", "under a minute": a span in plain words. */
export function span(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60)
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`
}

/**
 * How long a call has been held and when the hive settles it by itself, from the timing fields when the hive sends them
 * (`dispatched_at`, `unknown_at`, `auto_settles_at`, epoch seconds). Each line is null when its field is absent:
 * nothing is estimated. `now` is epoch milliseconds.
 */
export function heldTiming(r: CostReservation, now = Date.now()): { held: string | null; autoSettle: string | null; stuck: boolean } {
  const t = now / 1000
  const held =
    r.state === 'unknown' && typeof r.unknown_at === 'number'
      ? `outcome unknown for ${span(t - r.unknown_at)}${typeof r.dispatched_at === 'number' ? ` (sent ${span(t - r.dispatched_at)} ago)` : ''}`
      : typeof r.dispatched_at === 'number'
        ? `in flight for ${span(t - r.dispatched_at)}`
        : r.dispatched_at === null && r.state === 'reserved'
          ? 'reserved, not sent yet'
          : null
  const autoSettle =
    typeof r.auto_settles_at === 'number'
      ? r.auto_settles_at > t
        ? `if nobody settles it, the hive settles it at the held amount in ${span(r.auto_settles_at - t)}`
        : 'past its auto-settle time: the hive settles it at the held amount on its next pass'
      : null
  return { held, autoSettle, stuck: r.state !== 'unknown' && canSettle(r) }
}

/** "agent:a_x:total" → what it counts against, in words. */
export function scopeWords(scope: string, name: (kind: 'agent' | 'swarm' | 'key', id: string) => string = (_k, id) => id): string {
  const parts = scope.split(':')
  const period = parts.length > 2 ? parts[parts.length - 1] : ''
  const per = period === 'month' ? 'this month' : period === 'day' ? 'today' : period === 'total' ? 'in total' : period
  if (parts[0] === 'hive') return 'the whole hive’s hard cap'
  if (parts[0] === 'agent' || parts[0] === 'swarm' || parts[0] === 'key') {
    const id = parts.slice(1, parts.length > 2 ? -1 : undefined).join(':')
    const what = parts[0] === 'agent' ? 'mind' : parts[0]
    return `${what} ${name(parts[0], id)}${per ? ` ${per}` : ''}`
  }
  return scope
}

/** An overrun in dollars (the hive stores micro-dollars). */
export function overrunUsd(o: CostOverrun): { held: number; actual: number; over: number } {
  return { held: o.maximum / 1e6, actual: o.actual / 1e6, over: (o.actual - o.maximum) / 1e6 }
}

/** The fields a person reads before settling; any change means they have not seen the call. */
export const SEEN_FIELDS = ['id', 'state', 'held_usd', 'scopes', 'metadata', 'observation'] as const

/** An exact dollar amount for a money decision: never rounded to cents (2 to 6 decimals). */
export const exactUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
