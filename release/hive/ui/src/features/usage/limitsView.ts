// Purpose: the spending limits' read models: a stored rule as GET /api/budgets lists it, and the limits view (GET /api/budgets/limits) read from the hive's untrusted answer: the hive cap, one row per person with their monthly allowance, the caps someone set, and the old form defaults that can be removed.

/** A stored rule as GET /api/budgets lists it (Budgets.overview): only what someone stored, nothing derived. */
export interface BudgetRow {
  id: string
  scope: string
  period: 'day' | 'month' | 'total'
  limit_usd: number
  spent_usd: number
  /** what calls not yet settled hold against this limit (cost_reservations.held_usd); admission counts it with the spend */
  held_usd?: number
  note: string
  origin: 'rule'
}

/** One limit as the hive reports it (limits_view._row): its key is the label a paid call's reservation is checked
 *  under; room is what admission still lets through (limit less spend less what calls not yet settled hold). */
export interface LimitRowView {
  key: string
  scope: string
  period: string
  limit_usd: number
  spent_usd: number
  held_usd: number
  room_usd: number
  /** set: someone stored it; session: a work session's machinery; member-default / visitor: the hive's default allowance;
   *  every-mind: the every-mind rule as a mind's month cap; server-settings / default: HIVE_BUDGET_USD */
  source: string
  rule_id?: string
  note?: string
}

export interface PersonLimits {
  person_id: string
  name: string
  role: string
  /** their monthly allowance on the hive's money; null for an admin with no rule of their own */
  allowance: LimitRowView | null
  source: 'set' | 'member-default' | 'visitor' | 'none'
  spent_usd: number
  pace_usd_per_day: number
  /** key owners' grants to them: each holds their calls on that owner's key instead of the allowance */
  grants: number
}

export interface OldDefault {
  kind: 'mind' | 'swarm'
  id: string
  name: string
  change: string
  reasons: string[]
  /** the one change that removes it: a mind's cap set to $0, or the swarm rule removed */
  reset: { kind: 'mind'; agent_id: string } | { kind: 'rule'; rule_id: string }
}

export interface LimitsView {
  hive: { cap: LimitRowView | null; all_time: LimitRowView | null; month_spent_usd: number; pace_usd_per_day: number }
  people: PersonLimits[]
  caps: LimitRowView[]
  old_defaults: OldDefault[]
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const usd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length <= max ? v : null)

function row(v: unknown): LimitRowView | null {
  const r = rec(v)
  if (!r) return null
  const [key, scope, period, source] = [text(r.key), text(r.scope), text(r.period, 20), text(r.source, 40)]
  const [limit, spent, held, room] = [usd(r.limit_usd), usd(r.spent_usd), usd(r.held_usd), usd(r.room_usd)]
  if (key === null || scope === null || period === null || source === null || limit === null || spent === null || held === null || room === null) return null
  return { key, scope, period, limit_usd: limit, spent_usd: spent, held_usd: held, room_usd: room, source, ...(text(r.rule_id, 80) ? { rule_id: r.rule_id as string } : {}), ...(text(r.note) ? { note: r.note as string } : {}) }
}

function person(v: unknown): PersonLimits | null {
  const r = rec(v)
  const source = r && text(r.source, 20)
  if (!r || !text(r.person_id, 80) || !text(r.name) || !text(r.role, 20) || !source || !['set', 'member-default', 'visitor', 'none'].includes(source)) return null
  const allowance = r.allowance === null ? null : row(r.allowance)
  if (r.allowance !== null && allowance === null) return null
  return { person_id: r.person_id as string, name: r.name as string, role: r.role as string, allowance, source: source as PersonLimits['source'], spent_usd: usd(r.spent_usd) ?? 0, pace_usd_per_day: usd(r.pace_usd_per_day) ?? 0, grants: Array.isArray(r.grants) ? r.grants.length : 0 }
}

function oldDefault(v: unknown): OldDefault | null {
  const r = rec(v)
  const reset = rec(r?.reset)
  if (!r || !reset || !text(r.name) || !text(r.change, 400)) return null
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string') : []
  if (r.kind === 'mind' && text(r.agent_id, 80) && reset.method === 'PATCH') return { kind: 'mind', id: r.agent_id as string, name: r.name as string, change: r.change as string, reasons, reset: { kind: 'mind', agent_id: r.agent_id as string } }
  if (r.kind === 'swarm' && text(r.swarm_id, 80) && text(r.rule_id, 80) && reset.method === 'DELETE') return { kind: 'swarm', id: r.swarm_id as string, name: r.name as string, change: r.change as string, reasons, reset: { kind: 'rule', rule_id: r.rule_id as string } }
  return null
}

const every = <T,>(v: unknown, read: (x: unknown) => T | null): T[] | null => {
  if (!Array.isArray(v)) return null
  const out = v.map(read)
  return out.every((x): x is T => x !== null) ? out : null
}

/** The hive's answer as the page draws it, or null when it isn't that shape (the page then says it could not read it,
 *  never an empty set of limits). */
export function readLimitsView(v: unknown): LimitsView | null {
  const r = rec(v)
  const hive = rec(r?.hive)
  if (!r || !hive) return null
  const cap = hive.cap === null ? null : row(hive.cap)
  const allTime = hive.all_time === null ? null : row(hive.all_time)
  if ((hive.cap !== null && !cap) || (hive.all_time !== null && !allTime)) return null
  const people = every(r.people, person)
  const caps = every(r.caps, row)
  const olds = every(r.old_defaults, oldDefault)
  if (!people || !caps || !olds) return null
  return { hive: { cap, all_time: allTime, month_spent_usd: usd(hive.month_spent_usd) ?? 0, pace_usd_per_day: usd(hive.pace_usd_per_day) ?? 0 }, people, caps, old_defaults: olds }
}
