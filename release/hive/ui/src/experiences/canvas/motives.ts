import type { Goal } from '../sdk'
import type { Motivation, MotivationRef } from '../../api/types'
import { progressOf, sortMotivations, STATUS_WORDS, tasksOf, type Progress } from '../../lib/motivations'

/**
 * Motivations above Tasks, in Canvas's grammar (shared words and counting live in lib/motivations). A task's stickies
 * name the motivations it serves; the Hive panel's Motivations card lists every motivation this person can read, with
 * its progress counted once per task. Read-only here: linking and editing happen on the classic pages, and a link tells
 * no mind anything.
 */

/** One stable empty list, so a task with no readable links never re-renders for a fresh []. */
export const NO_MOTIVES: readonly MotivationRef[] = Object.freeze([])

/** Short words for a sticky: the first motivation it serves, and how many more. Null when it serves none. */
export function stickyLine(refs: readonly Pick<MotivationRef, 'title'>[], max = 26): string | null {
  if (!refs.length) return null
  const first = refs[0].title.length > max ? `${refs[0].title.slice(0, max - 1).trimEnd()}…` : refs[0].title
  return refs.length > 1 ? `${first} +${refs.length - 1}` : first
}

/** The same, said in full for a screen reader (part of the sticky's label). */
export function servesWords(refs: readonly Pick<MotivationRef, 'title'>[]): string {
  if (!refs.length) return ''
  return ` Serves ${refs.length === 1 ? 'the motivation' : `${refs.length} motivations`}: ${refs.map((r) => r.title).join(', ')}.`
}

/** "3 of 5 tasks done", plus failures (they count against progress, so they are said). */
export function progressWords(p: Progress): string {
  if (p.total === 0) return 'No tasks yet'
  const base = p.total - p.cancelled
  const parts = [`${p.done} of ${base} task${base === 1 ? '' : 's'} done`]
  if (p.failed) parts.push(`${p.failed} failed`)
  if (p.cancelled) parts.push(`${p.cancelled} cancelled`)
  return parts.join(' · ')
}

export interface MotivationRow {
  m: Motivation
  status: string
  progress: Progress
}

/** Every readable motivation, active first, each with its tasks counted once by their live status. */
export function motivationRows(motivations: Record<string, Motivation>, taskLinks: Record<string, { id: string }[]>, goals: Record<string, Pick<Goal, 'status'>>): MotivationRow[] {
  return sortMotivations(Object.values(motivations)).map((m) => ({ m, status: STATUS_WORDS[m.status] ?? m.status, progress: progressOf(tasksOf(m.id, taskLinks), goals) }))
}
