import { shown, type Agent, type Approval, type Goal, type Swarm } from '../sdk'
import { beliefText, compareSureness, surenessOf, truthWords, type Truth } from '../../lib/beliefSentence'
import type { Seg } from './state'

/** Pure helpers over hive data: ordering, names, resolution and formatting for the construct. */

export const slug = (s: string) =>
  shown(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Minds in table order: by swarm name (unswarmed last), then name. Numbers in the table are 1-based indices here. */
export function orderedMinds(agents: Record<string, Agent>, swarms: Record<string, Swarm>): Agent[] {
  const sw = (a: Agent) => (a.swarm_id && swarms[a.swarm_id] ? shown(swarms[a.swarm_id].name).toLowerCase() : '￿')
  return Object.values(agents).sort((a, b) => sw(a).localeCompare(sw(b)) || shown(a.name).localeCompare(shown(b.name)))
}

export const orderedSwarms = (swarms: Record<string, Swarm>) => Object.values(swarms).sort((a, b) => shown(a.name).localeCompare(shown(b.name)))

export function pendingList(approvals: Record<string, Approval>): Approval[] {
  return Object.values(approvals)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function recentDecided(approvals: Record<string, Approval>, n = 6): Approval[] {
  return Object.values(approvals)
    .filter((a) => a.status !== 'pending')
    .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))
    .slice(0, n)
}

const GOAL_ORDER: Record<string, number> = { stalled: 0, waiting: 1, claimed: 2, open: 3, submitted: 4, done: 5, failed: 6, cancelled: 7 }
export const goalList = (goals: Record<string, Goal>) =>
  Object.values(goals).sort((a, b) => (GOAL_ORDER[a.status] ?? 9) - (GOAL_ORDER[b.status] ?? 9) || b.priority - a.priority || b.updated_at.localeCompare(a.updated_at))

export function lev(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const d = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[n]
}

export function closest(q: string, options: string[], max = 3): string[] {
  const s = q.toLowerCase()
  return options
    .map((o) => ({ o, d: o.startsWith(s) ? 0 : o.includes(s) ? 1 : lev(s, o) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(s.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.o)
}

type Resolved<T> = { ok: T } | { err: string; hint?: string[] }

export function resolveMind(q: string, list: Agent[]): Resolved<Agent> {
  const s = q.trim().replace(/^#/, '').toLowerCase()
  if (!s) return { err: 'which mind?' }
  if (/^\d+$/.test(s)) {
    const a = list[Number(s) - 1]
    return a ? { ok: a } : { err: `there is no mind #${s} (1–${list.length})` }
  }
  const exact = list.find((a) => a.id.toLowerCase() === s || slug(a.name) === s || a.name.toLowerCase() === s)
  if (exact) return { ok: exact }
  const pre = list.filter((a) => slug(a.name).startsWith(s))
  if (pre.length === 1) return { ok: pre[0] }
  if (pre.length > 1) return { err: `'${q}' could be ${pre.map((a) => slug(a.name)).join(', ')}` }
  const sub = list.filter((a) => slug(a.name).includes(s))
  if (sub.length === 1) return { ok: sub[0] }
  return { err: `no mind matches '${q}'`, hint: closest(s, list.map((a) => slug(a.name))) }
}

export function resolveSwarm(q: string, list: Swarm[]): Resolved<Swarm> {
  const s = q.trim().toLowerCase()
  if (!s) return { err: 'which swarm?' }
  const exact = list.find((w) => w.id.toLowerCase() === s || slug(w.name) === s)
  if (exact) return { ok: exact }
  const pre = list.filter((w) => slug(w.name).startsWith(s) || slug(w.name).split('-').some((p) => p.startsWith(s)))
  if (pre.length === 1) return { ok: pre[0] }
  if (pre.length > 1) return { err: `'${q}' could be ${pre.map((w) => slug(w.name)).join(', ')}` }
  return { err: `no swarm matches '${q}'`, hint: closest(s, list.map((w) => slug(w.name))) }
}

export const pad = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(1, w - 1)) + '…' : s.padEnd(w))

export const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8)
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '—'
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** ▕████▌   ▏ style budget bar. */
export function bar(frac: number, w = 8): string {
  const f = Math.max(0, Math.min(1, frac)) * w
  const full = Math.floor(f)
  const parts = ' ▏▎▍▌▋▊▉'
  const rem = f - full
  return '█'.repeat(full) + (full < w ? parts[Math.round(rem * 7)] + ' '.repeat(w - full - 1) : '')
}

export const SPARK = '▁▂▃▄▅▆▇█'

export const statusTone = (s: Agent['status']) =>
  s === 'awake' ? 'hi' : s === 'starting' ? 'amber' : s === 'error' ? 'red' : s === 'asleep' ? 'txt' : 'dim'

export const shortModel = (m: string) => m.split('/').pop() ?? m

/**
 * uifix-r3.2, r3.6 (stand-in P1 on r3.5): the `beliefs` table's tint is the one sureness decision's direction, like every
 * other certainty visual: amber for "doubts it", plain text (neutral) for "tentative", bright for a "yes" word. It used
 * to tint tentative amber too, so {f 1, c 0} looked like a doubt. The order is the one sureness order (bySureness).
 */
export const beliefTone = (tv: Truth): 'amber' | 'txt' | 'hi' => {
  const d = surenessOf(tv).direction
  return d === 'against' ? 'amber' : d === 'none' ? 'txt' : 'hi'
}
/** Most sure first, by the one sureness order (compareSureness): every "yes", then tentative, then doubts. */
export const bySureness = (a: { tv: Truth }, b: { tv: Truth }) => compareSureness(b.tv, a.tv)

/** One row of the terminal `beliefs` table: how sure (in the decision's tint), the two numbers labelled by column, the sentence. */
export const beliefRow = (b: { statement: string; tv: Truth }): Seg[] => [
  { t: truthWords(b.tv), c: beliefTone(b.tv), w: 14 },
  { t: `${bar(b.tv.f, 6)} ${b.tv.f.toFixed(2)}`, c: 'txt', w: 13 },
  { t: `${bar(b.tv.c, 6)} ${b.tv.c.toFixed(2)}`, c: 'txt', w: 13 },
  { t: beliefText(b.statement), c: 'txt' },
]
