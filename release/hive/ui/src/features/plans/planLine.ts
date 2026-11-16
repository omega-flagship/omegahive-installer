import { compact, localWhen } from '../../lib/format'

/**
 * What is left of each plan attached to the hive (GET /api/subscriptions/status, owner only): the provider's own
 * reading from its local bridge, beside the hive's own day guard. Every number shown here is one the provider reported
 * or the hive counted; nothing is estimated. A reading the hive could not get is "usage not reported yet".
 */
export interface PlanWindow { name: string; used_fraction: number; resets_at: number | null }
export interface PlanRow {
  provider: string
  vendor: string | null
  plan_type: string | null
  status: string
  reported: boolean
  windows: PlanWindow[]
  overage: { status: string | null; in_use: boolean | null; disabled_reason: string | null } | null
  credits: { has_credits: boolean | null; unlimited: boolean | null; balance: number | null } | null
  observed_at: number | null
  hive_calls_today: number
  hive_daily_cap: number
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The answer, read strictly: anything malformed is dropped (a row) or emptied (a field), never shown as a number. */
export function readPlanStatus(value: unknown): PlanRow[] {
  const rows = obj(value)?.subscriptions
  if (!Array.isArray(rows)) return []
  const out: PlanRow[] = []
  for (const raw of rows) {
    const r = obj(raw)
    if (!r || !str(r.provider) || !num(r.hive_calls_today) || !num(r.hive_daily_cap)) continue
    const windows = (Array.isArray(r.windows) ? r.windows : []).flatMap((w): PlanWindow[] => {
      const x = obj(w)
      return x && str(x.name) && num(x.used_fraction) && x.used_fraction >= 0
        ? [{ name: x.name as string, used_fraction: x.used_fraction, resets_at: num(x.resets_at) ? x.resets_at : null }]
        : []
    })
    const ov = obj(r.overage)
    const cr = obj(r.credits)
    const reported = r.reported === true && num(r.observed_at)
    out.push({
      provider: r.provider as string,
      vendor: str(r.vendor),
      plan_type: str(r.plan_type),
      status: str(r.status) ?? 'unknown',
      reported,
      windows: reported ? windows : [],
      overage: reported && ov ? { status: str(ov.status), in_use: flag(ov.in_use), disabled_reason: str(ov.disabled_reason) } : null,
      credits: reported && cr ? { has_credits: flag(cr.has_credits), unlimited: flag(cr.unlimited), balance: num(cr.balance) ? cr.balance : null } : null,
      observed_at: reported ? (r.observed_at as number) : null,
      hive_calls_today: r.hive_calls_today,
      hive_daily_cap: r.hive_daily_cap,
    })
  }
  return out
}

const NAMES: Record<string, string> = { claude: 'Claude plan', codex: 'Codex' }
const PERIODS: Record<string, { span: string; limit: string }> = {
  five_hour: { span: 'this 5-hour window', limit: '5-hour limit' },
  one_day: { span: 'today', limit: 'daily limit' },
  seven_day: { span: 'this week', limit: 'weekly limit' },
  thirty_day: { span: 'this month', limit: 'monthly limit' },
}
const period = (name: string) => PERIODS[name] ?? { span: `the ${name.replace(/_/g, ' ')} window`, limit: `${name.replace(/_/g, ' ')} limit` }

export function planName(row: Pick<PlanRow, 'vendor' | 'provider'>): string {
  return (row.vendor && NAMES[row.vendor]) || row.provider
}

/** When a window resets, in local time ("Fri 13 Nov, 17:00"), from the provider's epoch seconds. */
export const resetsWhen = (epochSeconds: number): string => localWhen(new Date(epochSeconds * 1000).toISOString())

/**
 * One plain line: "Claude plan: 53% of this week used · resets Fri 13 Nov, 17:00 · 37 of 500 hive calls today", or
 * "Codex: weekly limit used, on credits (4,873 left) · resets …". The window shown is the one nearest its limit.
 */
export function planLine(row: PlanRow): string {
  const parts: string[] = []
  const hive = `${row.hive_calls_today.toLocaleString('en-US')} of ${row.hive_daily_cap.toLocaleString('en-US')} hive calls today`
  const tightest = [...row.windows].sort((a, b) => b.used_fraction - a.used_fraction)[0]
  if (!row.reported || !tightest) {
    parts.push('usage not reported yet')
  } else {
    const p = period(tightest.name)
    let used = tightest.used_fraction >= 1 ? `${p.limit} used` : `${Math.round(tightest.used_fraction * 100)}% of ${p.span} used`
    const c = row.credits
    if (tightest.used_fraction >= 1 && c?.unlimited) used += ', on unlimited credits'
    else if (tightest.used_fraction >= 1 && c?.has_credits && c.balance !== null) used += `, on credits (${compact(Math.floor(c.balance))} left)`
    else if (tightest.used_fraction >= 1 && c?.has_credits === false) used += ', no credits left'
    if (row.overage?.in_use) used += ', on extra usage'
    parts.push(used)
    if (tightest.resets_at !== null) parts.push(`resets ${resetsWhen(tightest.resets_at)}`)
  }
  parts.push(hive)
  return `${planName(row)}: ${parts.join(' · ')}`
}
