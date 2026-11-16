/** j0-fixes r1 item 4: which open sessions the Ask's "Earlier" lists, and what ending says (pure; OpenThreads.tsx). */
import type { WorkSession } from '../../api/types'
import { isAskSession } from '../messages/sessionTitle'

export { isAskSession }

export const END_SAYS = 'Ends the thread; its words stay.'


/** The person's own open sessions, on `mind` when given, newest first; never the thread on the page (New thread ends it). */
export function openThreadsOf(sessions: readonly WorkSession[], me: string | null | undefined, o: { mind?: string | null; current?: string | null } = {}): WorkSession[] {
  if (!me) return []
  return sessions
    .filter((s) => s.status === 'active' && s.owner === me && isAskSession(s) && (!o.mind || s.mind?.id === o.mind) && s.id !== o.current)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}

/** One Ask thread's own cap and spend, as the Limits read model reports it (ask-limits r1 minds[].ask_threads). */
export interface AskThreadFigures {
  id: string
  owner: string
  mind: string
  budget_usd: number
  spent_usd: number
}

const money = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
const ident = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(x)

/**
 * The Ask threads' own figures from GET /api/budgets/limits, by session id; null when the payload carries no
 * `ask_threads` at all (a host before ask-limits r1, or a person who may not read it), so the sessions list stands.
 * Read as untrusted: a row with an unreadable id, owner or figure is left out.
 */
export function askThreadFigures(payload: unknown): Map<string, AskThreadFigures> | null {
  const minds = payload && typeof payload === 'object' ? (payload as { minds?: unknown }).minds : undefined
  if (!Array.isArray(minds)) return null
  let seen = false
  const out = new Map<string, AskThreadFigures>()
  for (const m of minds) {
    if (!m || typeof m !== 'object') continue
    const { agent_id, ask_threads } = m as { agent_id?: unknown; ask_threads?: unknown }
    if (!Array.isArray(ask_threads)) continue
    seen = true
    if (!ident(agent_id)) continue
    for (const t of ask_threads) {
      if (!t || typeof t !== 'object') continue
      const r = t as Record<string, unknown>
      const budget = money(r.budget_usd)
      const spent = money(r.spent_usd)
      if (!ident(r.id) || !ident(r.owner) || budget === null || spent === null) continue
      out.set(r.id, { id: r.id, owner: r.owner, mind: agent_id, budget_usd: budget, spent_usd: spent })
    }
  }
  return seen ? out : null
}

/**
 * The rows shown: the person's own open sessions (names, times, status from GET /api/sessions), with each Ask thread's
 * figures taken from the limits payload's `ask_threads` where present (its own cap and its own spend, which the session
 * view does not have on a host before ask-limits r1). Without that payload, the session's own figures stand.
 */
export function withThreadFigures(rows: readonly WorkSession[], figures: Map<string, AskThreadFigures> | null): WorkSession[] {
  if (!figures) return [...rows]
  return rows.map((s) => {
    const f = figures.get(s.id)
    return f && f.owner === s.owner ? { ...s, budget_usd: f.budget_usd, spent_usd: f.spent_usd } : s
  })
}
