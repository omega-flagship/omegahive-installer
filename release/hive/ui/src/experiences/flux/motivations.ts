import type { MotivationRef } from '../../api/types'

/**
 * Flux's Tasks filter by motivation: '' = any task, 'none' = Unsorted (under no motivation this person can read),
 * otherwise one motivation's id. Only readable links ever reach the store, so a hidden link and no link look the same.
 */
export type MotivationFilter = string

type Links = Record<string, Pick<MotivationRef, 'id'>[] | undefined>

/** Does this task pass the motivation filter? */
export function serves(links: Links, taskId: string, filter: MotivationFilter): boolean {
  if (!filter) return true
  const refs = links[taskId]
  // a task whose links were never read is not Unsorted (stand-in P2-3 on 61936cb)
  return filter === 'none' ? refs !== undefined && refs.length === 0 : (refs ?? []).some((r) => r.id === filter)
}

/** How many of these tasks each filter shows. Every task counts once in `any`, and once per motivation it serves. */
export function countByMotivation(taskIds: Iterable<string>, links: Links): { any: number; none: number; per: Record<string, number> } {
  const per: Record<string, number> = {}
  let any = 0
  let none = 0
  for (const id of new Set(taskIds)) {
    any++
    const mine = new Set((links[id] ?? []).map((r) => r.id))
    if (links[id] !== undefined && mine.size === 0) none++
    for (const m of mine) per[m] = (per[m] ?? 0) + 1
  }
  return { any, none, per }
}

/** A long title, clipped to fit a pill on a 390px phone (the full title stays in the pill's accessible name). */
export const clip = (s: string, n = 26) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
