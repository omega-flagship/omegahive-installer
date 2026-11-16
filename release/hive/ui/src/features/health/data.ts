import type { HealthIssue, HealthOverview, MindHealth } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import type { ResourceState } from '../../lib/useResource'
import type { Compose, ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { withResource } from '../../screens/resourceFacts'

/**
 * What the Health screens are told (health.metta): the values they draw (bound by path) and this moment's facts
 * (counts, flags and known values) from which MeTTa composes them. Each mind and each of its problems is composed as
 * its own small screen, and the health screen stacks them. Pure: composing is handed in.
 */
export type Show = 'problems' | 'all'
export type { Compose }
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

const HEALTH = new Set(['high', 'medium', 'low', 'ok'])

/** A mind with a problem: not healthy, or with a problem in the last hour. */
export const troubled = (m: MindHealth): boolean => m.health !== 'ok' || m.issues.some((i) => i.recent)
export const issueKey = (issue: HealthIssue, i: number): string => `${issue.kind}-${issue.skill}-${i}`
/** Which problems are open: one key per mind and problem. */
export const openKey = (mindId: string, key: string): string => `${mindId}\n${key}`

export function issueItem(issue: HealthIssue, i: number, mindId: string, open: ReadonlySet<string>, now: number, compose: Compose): StackItem {
  const id = issueKey(issue, i)
  const isOpen = open.has(openKey(mindId, id))
  return {
    id,
    plan: compose('health-issue', { flags: { 'issue.recent': issue.recent, 'issue.waiting': issue.kind === 'waiting', 'issue.open': isOpen } }),
    data: {
      'issue.kind': issue.kind,
      'issue.tone': issue.severity,
      'issue.meaning': issue.meaning,
      'issue.meta': [issue.skill, `${issue.count}×`, ...(issue.last_at ? [ago(issue.last_at, now)] : [])].join(' · '),
      'issue.hint': issue.hint,
      'issue.example': `${issue.example.command}\n→ ${issue.example.result}`,
      'issue.open': isOpen,
    },
  }
}

export function mindItem(mind: MindHealth, open: ReadonlySet<string>, now: number, compose: Compose): StackItem {
  const issues = mind.issues.map((issue, i) => issueItem(issue, i, mind.id, open, now, compose))
  return {
    id: mind.id,
    plan: compose('health-mind', { counts: { 'mind.issues': issues.length }, values: { 'mind.health': HEALTH.has(mind.health) ? mind.health : 'other' } }),
    data: { 'mind.name': shown(mind.name), 'mind.status': mind.status, 'mind.issues': issues },
  }
}

/** The health screen: how the checks stand, the totals, and every mind (and those with problems) as stacked screens. */
export function healthScreen(res: ResourceState<HealthOverview>, show: Show, open: ReadonlySet<string>, now: number, compose: Compose): Composed {
  const overview = (res.status === 'ready' || res.status === 'empty') && res.data ? res.data : null
  const all = overview ? overview.minds.map((m) => mindItem(m, open, now, compose)) : []
  const bad = overview ? overview.minds.flatMap((m, i) => (troubled(m) ? [all[i]] : [])) : []
  const totals = overview?.totals ?? { high: 0, medium: 0, low: 0, ok: 0 }
  // an answer with no overview in it has nothing to show yet: it reads as still loading
  const state = (res.status === 'ready' || res.status === 'empty') && !overview ? { status: 'loading' as const, error: undefined } : res
  return withResource(state, {
    data: {
      show,
      'minds.all': all,
      'minds.troubled': bad,
      'totals.high': totals.high,
      'totals.medium': totals.medium,
      'totals.low': totals.low,
      'totals.ok': totals.ok,
      // Check again waits on this alone, so a refresh never greys out the rest of the page
      'checks.refreshing': res.refreshing === true,
    },
    facts: {
      counts: { 'minds.all': all.length, 'minds.troubled': bad.length },
      values: { show },
    },
  })
}
