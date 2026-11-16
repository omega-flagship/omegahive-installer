// Purpose: the words and checks for held calls, estimates and spending limits: how and when each held call settles
// itself, amounts, reasons, timing, limit names, what a correction still needs, and the totals and binding Correct all
// decides on.
import type { CostOverrun, CostReservation, EstimatedCall } from '../../api/moneyWork'
import type { RefusedLimit } from '../../api/types'
import type { Bound } from '../../lib/decisionGate'
import { money } from '../../lib/format'
import type { Blocked } from '../../ui/DecisionDialog'

/** Dollars a person typed ("0.31", "$0.31", "1,204.50"), or null when it is not a finite amount of zero or more. */
export function parseUsd(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d+(\.\d{1,6})?$|^\.\d{1,6}$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Why a correction that needs only its reason ("Nothing was billed", Correct all) can't be sent yet, with the field
 *  that gives it (DecisionDialog's Blocked), or null when it can. */
export const reasonBlocked = (reason: string): Blocked | null => (reason.trim() ? null : { why: 'Give a reason, recorded with the correction.', field: 'reason' })

/** Why a correction to the billed cost can't be sent yet, with the field that gives it, or null when it can: the hive
 *  needs the cost the provider billed and a reason. */
export function correctBlocked(amount: string, reason: string): Blocked | null {
  if (!amount.trim()) return { why: 'Enter the billed cost from the provider’s billing.', field: 'amount' }
  if (parseUsd(amount) === null) return { why: 'The billed cost must be an amount in dollars, zero or more (up to 6 decimals).', field: 'amount' }
  return reasonBlocked(reason)
}

/** The held calls whose outcome is unknown, and those still in flight (outstanding's state). Both settle by themselves;
 *  nobody settles a held call by hand. */
export function splitHeld(rows: CostReservation[]): { unknown: CostReservation[]; inFlight: CostReservation[] } {
  return { unknown: rows.filter((r) => r.state === 'unknown'), inFlight: rows.filter((r) => r.state !== 'unknown') }
}

/** A free model's call: held at the hive's one-micro-dollar floor (cost_reservations.FREE_FLOOR_MICROS), which is no
 *  worst case, so it settles at $0, the model's price. */
export const isFreeFloor = (usd: number): boolean => Math.round(usd * 1e6) <= 1

/** Why a held call's cost is unknown, as the hive recorded it (gateway.held_cause); a call held before the hive
 *  recorded causes says what its usage record says, or that the provider never reported usage. */
export const heldReason = (r: Pick<CostReservation, 'observation'>): string => r.observation?.cause ?? r.observation?.usage_origin ?? 'the provider never reported usage'

/** The estimates of one mind on one model, as Correct all lists them. */
export interface HeldGroup {
  agent?: string
  model?: string
  count: number
  usd: number
}

/**
 * Correct all's numbers: how many calls, their total, and the same by mind and model, the largest total first, equal
 * totals in the order the hive listed them; and why they were held (heldReason), the most common first. Summed in
 * micro-dollars, as the hive holds them, so 52 amounts of $0.05 add to exactly $2.60.
 * Time: n map updates + g log g to sort, n = calls, g = mind and model pairs.
 */
export function estimateSummary(rows: EstimatedCall[]): { count: number; usd: number; groups: HeldGroup[]; reasons: { reason: string; count: number }[] } {
  const groups = new Map<string, { agent?: string; model?: string; count: number; micros: number }>()
  const reasons = new Map<string, number>()
  let micros = 0
  for (const r of rows) {
    reasons.set(heldReason(r), (reasons.get(heldReason(r)) ?? 0) + 1)
    const m = Math.round(r.estimate_usd * 1e6)
    const key = JSON.stringify([r.metadata.agent ?? null, r.metadata.model ?? null])
    const g = groups.get(key) ?? { agent: r.metadata.agent, model: r.metadata.model, count: 0, micros: 0 }
    g.count += 1
    g.micros += m
    groups.set(key, g)
    micros += m
  }
  const sorted = [...groups.values()].sort((a, b) => b.micros - a.micros || b.count - a.count)
  return {
    count: rows.length,
    usd: micros / 1e6,
    groups: sorted.map(({ micros: m, ...g }) => ({ ...g, usd: m / 1e6 })),
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  }
}

/**
 * Correct all's binding (Review R2/R3): ready while every estimate the person saw may still be corrected and is
 * unchanged in what they read; closed once any of them is not. An estimate listed after the dialog opened is not part
 * of the decision and changes nothing here.
 */
export function bindEstimates(seen: EstimatedCall[], live: EstimatedCall[] | undefined, now = Date.now()): Bound {
  if (!live) return { kind: 'gone' }
  const byId = new Map(live.map((e) => [e.id, e]))
  const left = seen.filter((e) => !byId.has(e.id) || !canCorrect(byId.get(e.id)!, now)).length
  if (left) return { kind: 'closed', why: `${left === 1 ? 'One of these calls was' : `${left} of these calls were`} corrected since this opened, or is past its 30 days.` }
  const changed = seen.filter((e) => ESTIMATE_FIELDS.some((f) => JSON.stringify(e[f]) !== JSON.stringify(byId.get(e.id)![f]))).length
  return changed ? { kind: 'changed', fields: [`${changed} call${changed === 1 ? '' : 's'}`] } : { kind: 'ready' }
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

/** "58 minutes", "1 minute", "under a minute", and span's "3h 12m" from two hours: a wait in words a person reads aloud. */
export function inWords(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60)
  if (m < 1) return 'under a minute'
  if (m < 120) return `${m} ${m === 1 ? 'minute' : 'minutes'}`
  return span(seconds)
}

/**
 * How long a call has been held, from the hive's timing fields (`dispatched_at`, `unknown_at`, epoch seconds), or null
 * when it sent none: nothing is guessed. `now` is epoch milliseconds.
 */
export function heldFor(r: CostReservation, now = Date.now()): string | null {
  const t = now / 1000
  return r.state === 'unknown' && typeof r.unknown_at === 'number'
    ? `outcome unknown for ${span(t - r.unknown_at)}${typeof r.dispatched_at === 'number' ? ` (sent ${span(t - r.dispatched_at)} ago)` : ''}`
    : typeof r.dispatched_at === 'number'
      ? `in flight for ${span(t - r.dispatched_at)}`
      : r.dispatched_at === null && r.state === 'reserved'
        ? 'reserved, not sent yet'
        : null
}

/**
 * How and when the hive settles a held call by itself, from its own fields (cost_reservations.outstanding: `settles`,
 * `auto_settles_at`); nobody settles one by hand. An unknown OpenRouter call settles from OpenRouter's record of it,
 * any other unknown call at its worst case an hour after its outcome went unknown (the plan's review asked that a worst
 * case say it is an upper bound that's usually lower), a free model's at $0, and a call in flight when it answers:
 * "settles from OpenRouter’s record of it, or at its worst case in 42 minutes if no record comes". Without the clock
 * time the hive sends, it names the rule instead. `now` is epoch milliseconds.
 */
export function settlesWords(r: CostReservation, now = Date.now()): string {
  if (r.settles === 'answer') return 'settles when the call answers'
  const t = now / 1000
  const at = r.auto_settles_at
  const when = typeof at === 'number' ? (at > t ? `in ${inWords(at - t)}` : 'on the hive’s next pass') : 'an hour after its outcome went unknown'
  const free = isFreeFloor(r.held_usd)
  const estimate = free ? `at $0, the free model’s price, ${when}` : `at its worst case ${when}`
  if (r.settles === 'record') return `settles from OpenRouter’s record of it, or ${estimate} if no record comes`
  return free ? `settles ${estimate}` : `settles ${estimate}: an upper bound that’s usually lower, which you can correct afterwards`
}

/** What an estimate is, wherever spend that holds estimates is marked (the plan's review asked that it say it is an
 *  upper bound that's usually lower). */
export const ESTIMATE_WORDS = 'Settled at its worst case because its cost never came back: an upper bound that’s usually lower. You can correct it from the provider’s billing within 30 days.'

/** What one estimate is: a worst case (ESTIMATE_WORDS), or a free model's call settled at its price, $0, which says no
 *  more than its price did (estimate_usd 0: a worst case is never $0). */
export const estimateWords = (e: EstimatedCall): string =>
  e.estimate_usd === 0 ? 'Settled at $0, the free model’s price, because its outcome never came back. If the provider’s billing shows a charge, you can correct it within 30 days.' : ESTIMATE_WORDS

/** Whether a person may still correct this estimate: the hive's own window, correctable_until (epoch seconds). */
export const canCorrect = (e: EstimatedCall, now = Date.now()): boolean => e.correctable_until > now / 1000

/** When an estimate was made and how long it may still be corrected: "settled at its worst case 3h ago · correct
 *  within 29 days", a free model's "settled at $0 3h ago". `now` is epoch milliseconds. */
export function estimateTiming(e: EstimatedCall, now = Date.now()): string {
  const t = now / 1000
  const left = e.correctable_until - t
  const days = Math.floor(left / 86_400)
  const until = left <= 0 ? 'too late to correct' : days >= 2 ? `correct within ${days} days` : `correct within ${inWords(left)}`
  return `settled at ${e.estimate_usd === 0 ? '$0' : 'its worst case'} ${span(t - e.settled_at)} ago · ${until}`
}

/** The fields a person reads before correcting an estimate; any change means they have not seen the call. */
export const ESTIMATE_FIELDS = ['id', 'estimate_usd', 'scopes', 'metadata', 'observation'] as const

const PER: Record<string, string> = { month: 'this month', day: 'today', total: 'in total' }
/** The kinds of limit that are about one thing (kind:id[:period]); the hive's are about the whole hive (hive[:period]). */
const ABOUT_ONE = new Set(['agent', 'swarm', 'key', 'person', 'keyuse'])

/**
 * A limit's label ("agent:a_x:total", "hive:month", "keyuse:4f…:month") in words: what it limits and when. One rule for
 * every place a limit is named (a held call's budgets, the limit that paused a mind). A kind without its id (a scope
 * this viewer may not see) is named by its kind alone.
 */
export function scopeWords(scope: string, name: (kind: 'agent' | 'swarm' | 'key', id: string) => string = (_k, id) => id): string {
  const parts = scope.split(':')
  const kind = parts[0]
  const one = ABOUT_ONE.has(kind)
  const period = parts.length > (one ? 2 : 1) ? parts[parts.length - 1] : ''
  const per = PER[period] ?? ''
  if (kind === 'hive') return per ? `the whole hive ${per}` : 'the whole hive’s hard cap'
  if (!one) return scope
  const id = parts.slice(1, parts.length > 2 ? -1 : undefined).join(':')
  const named = kind === 'agent' || kind === 'swarm' || kind === 'key' ? kind : null
  const what = named ? `${named === 'agent' ? 'mind' : named} ${id ? name(named, id) : ''}`.trim() : kind === 'person' ? 'a person’s allowance' : 'the own-key limit'
  return `${what}${per ? ` ${per}` : ''}`
}

/** The limit that refused a mind's call (budget.refused) as one sentence: which limit and when, what is spent and held
 *  against it, the limit, and what the refused call could cost, e.g. "No room under swarm Create · Code today: $1.98
 *  spent and $0.04 held for calls not yet settled, of $2.00, and its next call could cost up to $0.05." The call's worst
 *  case is what makes a limit with room left refuse it ($0 spent of $0.01 refuses a call that could cost $0.05). */
export function refusedWords(l: RefusedLimit, name?: (kind: 'agent' | 'swarm' | 'key', id: string) => string): string {
  const held = l.held_usd ? ` and ${money(l.held_usd)} held for calls not yet settled` : ''
  const call = l.call_usd ? `, and its next call could cost up to ${money(l.call_usd)}` : ''
  return `No room under ${scopeWords(`${l.scope}:${l.period}`, name)}: ${money(l.spent_usd)} spent${held}, of ${money(l.limit_usd)}${call}.`
}

/** A limit this viewer may not see (another person's allowance or key spending, which the hive sends only to that person
 *  and the admins), in words; and its refusal as one sentence, beside refusedWords. */
export const UNSEEN_LIMIT = 'a spending limit it can’t change'
export const UNSEEN_REFUSAL = `No room under ${UNSEEN_LIMIT}.`

/** An overrun in dollars (the hive stores micro-dollars). */
export function overrunUsd(o: CostOverrun): { held: number; actual: number; over: number } {
  return { held: o.maximum / 1e6, actual: o.actual / 1e6, over: (o.actual - o.maximum) / 1e6 }
}

/** An exact dollar amount for a money decision: never rounded to cents (2 to 6 decimals). */
export const exactUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
