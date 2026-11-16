// Purpose: what the signed-in person's monthly allowance has left, and for an admin the hive cap, the hook that reads both and keeps them current, and what the battery's screen (allowance.metta) is told: each battery's parts and words as data, and whether each shows as a fact.
import { useEffect, useState } from 'react'
import type { MySpendSummary } from '../../api/types'
import { hsl } from '../../lib/color'
import { useAdminView } from '../../lib/useAdmin'
import { need, useResource } from '../../lib/useResource'
import type { ScreenFacts } from '../../screens/screenSpace'
import { hiveBus, useHive } from '../../store/store'
import { readLimitsView, type LimitRowView } from './limitsView'

/** One battery: what a limit's spend and held calls have used of it, and what is left. `level` is the share left, 0 to 1. */
export interface Battery {
  kind: 'allowance' | 'hive'
  used_usd: number
  held_usd: number
  max_usd: number
  left_usd: number
  level: number
  tone: 'ok' | 'low' | 'out'
  /** the limit's period: an allowance is monthly, the hive cap a month rule or else a day rule */
  period: 'month' | 'day'
}

/** Below this share left the battery reads low, the share at which Your spend says the allowance is running low. */
export const LOW_SHARE = 0.2

/** Read again on this cadence while the page is visible, besides after each recorded call. */
export const ALLOWANCE_POLL_MS = 60_000

/** A burst of recorded calls (a thread's turns, a swarm's steps) is read once, this long after the first. */
export const USAGE_SETTLE_MS = 1_500

const round2 = (n: number) => Math.round(n * 100) / 100

function battery(kind: Battery['kind'], spent: number, held: number, max: number, period: Battery['period']): Battery {
  const used = Math.max(0, spent) + Math.max(0, held)
  const left = Math.max(0, max - used)
  const level = max > 0 ? left / max : 0
  return { kind, used_usd: round2(used), held_usd: round2(Math.max(0, held)), max_usd: max, left_usd: round2(left), level, period, tone: left < 0.005 ? 'out' : level < LOW_SHARE ? 'low' : 'ok' }
}

/** The person's own battery from GET /api/usage/me: their spend against their allowance plus what calls not yet settled
 *  hold against it, the figure admission counts. None without an allowance (an admin with no rule of their own). */
export function allowanceBattery(me: MySpendSummary | null | undefined): Battery | null {
  if (!me || me.allowance_usd == null || me.allowance_usd <= 0) return null
  return battery('allowance', me.hive_paid_usd, me.held_usd ?? 0, me.allowance_usd, 'month')
}

/** The hive cap's battery from the Limits view's hive part; none on a hive without a cap. */
export function hiveBattery(cap: LimitRowView | null | undefined): Battery | null {
  if (!cap || cap.limit_usd <= 0) return null
  return battery('hive', cap.spent_usd, cap.held_usd, cap.limit_usd, cap.period === 'day' ? 'day' : 'month')
}

/** What is left at a glance: "$19 left", "$4.60 left", or "used up". */
export function batteryLeft(b: Battery): string {
  return b.tone === 'out' ? 'used up' : `$${b.left_usd >= 10 ? Math.floor(b.left_usd) : b.left_usd.toFixed(2)} left`
}

/** The tone's hue, as the usage Meter colours a limit: its accent, amber once low, red once used up. */
const HUE: Record<Battery['tone'], number> = { ok: 252, low: 38, out: 356 }

/** A battery as the progress block draws it: what is left in its tone, what calls still hold in a paler one, then what
 *  is spent on the bare track, each as wide as its dollars and named by them for assistive technology. */
export function batteryParts(b: Battery): { label: string; n: number; color?: string }[] {
  const hue = HUE[b.tone]
  return [
    { label: 'dollars left', n: b.left_usd, color: hsl(hue, 90, 62) },
    { label: 'dollars held', n: b.held_usd, color: hsl(hue, 90, 62, 0.4) },
    { label: 'dollars spent', n: round2(b.used_usd - b.held_usd) },
  ]
}

/** What the battery's screen (allowance.metta) is told: each battery's parts and words, bound by path, and whether the
 *  person's own allowance and the hive cap show, as flags MeTTa composes it from. */
export function allowanceScreen(batteries: Battery[]): { data: Record<string, unknown>; facts: ScreenFacts } {
  const mine = batteries.find((b) => b.kind === 'allowance')
  const hive = batteries.find((b) => b.kind === 'hive')
  const data: Record<string, unknown> = {}
  for (const [key, b] of [['allowance.mine', mine], ['allowance.hive', hive]] as const) {
    if (!b) continue
    data[`${key}.parts`] = batteryParts(b)
    data[`${key}.left`] = batteryLeft(b)
  }
  return { data, facts: { flags: { 'allowance.mine': mine !== undefined, 'allowance.hive': hive !== undefined } } }
}

/** A counter that moves shortly after the hive records a call or changes a limit, so a read keyed on it follows spend. */
function useUsageBump(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = hiveBus.on((e) => {
      if ((e.type === 'usage' || e.type === 'budgets.updated') && !timer) timer = setTimeout(() => { timer = null; setN((x) => x + 1) }, USAGE_SETTLE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])
  return n
}

/** The batteries to show the signed-in person: their allowance's, and for an admin the hive cap's. Empty while unread,
 *  or on a hive that answers neither read. */
export function useBatteries(): Battery[] {
  const client = useHive((s) => s.client)
  const { adminView } = useAdminView()
  const bump = useUsageBump()
  const mine = useResource(() => need(client, 'usageMe', 'Your allowance')(), { poll: ALLOWANCE_POLL_MS, key: bump })
  const hive = useResource(
    () => (adminView ? need(client, 'budgetLimitsView', 'The hive cap')().then(readLimitsView) : Promise.resolve(null)),
    { poll: ALLOWANCE_POLL_MS, key: bump, context: adminView },
  )
  const out: Battery[] = []
  const own = allowanceBattery(mine.data)
  if (own) out.push(own)
  const cap = adminView ? hiveBattery(hive.data?.hive.cap) : null
  if (cap) out.push(cap)
  return out
}
