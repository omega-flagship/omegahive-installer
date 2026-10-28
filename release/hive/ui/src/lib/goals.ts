import type { Goal, GoalStatus } from '../api/types'

/** Statuses where a mind still holds the goal (task glyphs keep orbiting it). */
export const HELD: GoalStatus[] = ['claimed', 'waiting']
/** Statuses that count as "in flight" for headers and badges. */
export const ACTIVE: GoalStatus[] = ['open', 'claimed', 'waiting', 'stalled']

export const isHeld = (g: Goal) => HELD.includes(g.status)
export const isActive = (g: Goal) => ACTIVE.includes(g.status)
export const LEASE_LAPSES = 3

export type Lease = { kind: 'running'; ms: number; total: number } | { kind: 'lapsed' } | { kind: 'paused' } | null

/** Where a goal's lease stands at `now`. */
export function leaseOf(g: Goal, now: number, leaseMinutes = 60): Lease {
  if (g.status === 'waiting') return { kind: 'paused' }
  if (g.status !== 'claimed' || !g.lease_until) return null
  const ms = Date.parse(g.lease_until) - now
  return ms <= 0 ? { kind: 'lapsed' } : { kind: 'running', ms, total: leaseMinutes * 60_000 }
}

export function leaseText(ms: number): string {
  const m = Math.ceil(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`
}
