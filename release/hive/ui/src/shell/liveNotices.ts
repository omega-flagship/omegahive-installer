// Purpose: turn live hive events no screen reads (a mind paused for spending, overruns, estimates, connections,
// app access) into notices and the app-access record.
import { useEffect } from 'react'
import type { HiveEvent } from '../api/types'
import { shown } from '../lib/displayName'
import { money } from '../lib/format'
import { plural } from '../lib/plural'
import { navigate } from '../lib/router'
import { hiveBus, useHive, type Toast } from '../store/store'
import { refusedWords, UNSEEN_REFUSAL } from '../features/usage/settle'

/**
 * Live events the hive already sent that no screen read (Surface missing-UI batch 1; UI_BACKEND_PARITY_AUDIT_20261007):
 * `budget.overrun`, `budget.estimated`, `connection.updated` and the five `app.grants_*` kinds. The host decides who
 * receives each (visibility.py): `app.*` and `budget.estimated` reach admins only, `budget.overrun` in practice admins
 * only, `connection.updated` anyone who sees both swarms. Pages that show these things reload on them; this module
 * keeps the app-access record the App access dialog shows and raises one plain notice per event, the newest estimate
 * notice replacing the one on screen. `motivation.updated` belongs to the Motivations screens.
 */

export type AppGrantsKind = 'revoked' | 'restored' | 'restore_applied' | 'renewed' | 'refused'

/** What the hive last said about one app's host-managed access, while this page was open. */
export interface AppGrantsNote {
  program: string
  kind: AppGrantsKind
  by: string | null
  at: string
  reason?: string
  grants?: string[]
  /** the store session it arrived in: a later sign-in never shows an earlier one's record */
  session: string
}

const notes = new Map<string, AppGrantsNote>()
const listeners = new Set<() => void>()

/** The last app-access event for an app in this session, or null (the hive has no read for it: events only). */
export function appGrantsNote(program: string, session: string): AppGrantsNote | null {
  const n = notes.get(program)
  return n && n.session === session ? n : null
}
export function onAppGrantsNote(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
/** Record an outcome the person's own action produced (the event may not reach them: app.* go to admins only). */
export function noteAppGrants(n: AppGrantsNote): void {
  notes.set(n.program, n)
  listeners.forEach((l) => l())
}

/** The note an app.grants_* event makes, or null for any other event. Pure. */
export function appGrantsFrom(e: HiveEvent, session: string): AppGrantsNote | null {
  switch (e.type) {
    case 'app.grants_revoked':
      return { program: e.program, kind: 'revoked', by: e.by, at: e.at, session }
    case 'app.grants_restored':
      return { program: e.program, kind: 'restored', by: e.by, at: e.at, session }
    case 'app.grants_restore_applied':
      return { program: e.program, kind: 'restore_applied', by: e.restored_by, at: e.at, session }
    case 'app.grants_renewed':
      return { program: e.program, kind: 'renewed', by: e.by, at: e.at, grants: e.grants, session }
    case 'app.grants_refused':
      return { program: e.program, kind: 'refused', by: e.by, at: e.at, reason: e.reason, session }
    default:
      return null
  }
}

/** Plain words for an app-access note. */
export function appGrantsWords(n: Pick<AppGrantsNote, 'kind' | 'by' | 'reason'>, app: string): string {
  const by = n.by ? ` by ${n.by.replace(/^user:/, '')}` : ''
  switch (n.kind) {
    case 'revoked':
      return `${app}'s access was paused${by}. Its grants are dropped now and at every start until its owner restores them.`
    case 'restored':
      return `${app}'s access was restored${by}. It takes effect at the next restart.`
    case 'restore_applied':
      return `${app}'s restored access took effect at this start.`
    case 'renewed':
      return `${app}'s read access was renewed${by}.`
    case 'refused':
      return `${app}'s access was refused${n.reason ? `: ${n.reason}` : ''}.`
  }
}

/** The notice a budget.overrun makes: a call cost more than the hive held for it. */
export function overrunWords(e: Extract<HiveEvent, { type: 'budget.overrun' }>, mind: (id: string) => string): { title: string; body: string } {
  const who = e.agent ? mind(e.agent) : 'A call'
  const held = `$${e.held_usd.toFixed(4)}`
  const actual = `$${e.actual_usd.toFixed(4)}`
  return { title: `${who} spent more than was held`, body: `Held ${held}, cost ${actual}. Spending limits count the actual cost.` }
}

/** The notice a budget.estimated makes: one expiry pass settled calls whose cost never came back at their worst case,
 *  an upper bound that's usually lower, which can be corrected for 30 days, and a free model's at $0, its price, named
 *  by model, since once its block lifts nothing else says that model's calls end unknown. It informs; nobody is asked
 *  to correct anything. Cents, as the day's line says them. */
export function estimatedWords(e: Extract<HiveEvent, { type: 'budget.estimated' }>): { title: string; body: string } {
  const freed = (e.free ?? []).reduce((n, f) => n + f.count, 0)
  const worst = e.count - freed
  const one = worst === 1
  const worstWords = worst ? `${one ? 'Its' : 'Their'} cost never came back, so the hive settled ${one ? 'it' : 'them'} at the worst case: an upper bound that’s usually lower, which you can correct in Usage within 30 days.` : ''
  const freeWords = freed ? `${plural(freed, 'call')} to a free model (${(e.free ?? []).map((f) => f.model).join(', ')}) had an unknown outcome and ${freed === 1 ? 'was' : 'were'} settled at $0, ${freed === 1 ? 'its' : 'their'} price.` : ''
  return {
    title: `${plural(e.count, 'call')} ${e.count === 1 ? 'was' : 'were'} estimated at ${money(e.total_usd)}`,
    body: [worstWords, freeWords].filter(Boolean).join(' '),
  }
}

/**
 * The notice the first refusal of a stretch makes (budget.refused, count 1): which mind is paused for spending and, when
 * the hive names it, the limit that has no room; null for the later refusals of the same stretch, which the mind's page
 * counts instead.
 */
export function refusalNotice(e: Extract<HiveEvent, { type: 'budget.refused' }>, s: Pick<ReturnType<typeof useHive.getState>, 'agents' | 'swarms' | 'keys' | 'refusals'>): Omit<Toast, 'id'> | null {
  if (e.count !== 1) return null
  const name = shown(s.agents[e.agent_id]?.name ?? 'A mind')
  const refusal = s.refusals[e.agent_id]
  const limit = refusal?.limit
  const named = (kind: 'agent' | 'swarm' | 'key', id: string) => shown((kind === 'agent' ? s.agents[id]?.name : kind === 'swarm' ? s.swarms[id]?.name : s.keys?.find((k) => k.id === id)?.label) ?? id)
  const body = limit ? refusedWords(limit, named) : refusal?.hidden ? UNSEEN_REFUSAL : 'A spending limit has no room for its next call.'
  return { tone: 'error', icon: 'pause', title: `${name} is paused for spending`, body, action: { label: 'Open', run: () => navigate({ name: 'dot', id: e.agent_id }) }, ttl: 10000 }
}

/** Mounted once (App): turn these events into notices and the app-access record. */
export function useLiveNotices(): void {
  useEffect(
    () =>
      hiveBus.on((e) => {
        const s = useHive.getState()
        const app = appGrantsFrom(e, s.session)
        if (app) {
          noteAppGrants(app)
          const name = shown(s.programs?.find((p) => p.id === app.program)?.name ?? app.program)
          s.toast({ tone: app.kind === 'refused' ? 'error' : 'info', icon: 'plug', title: `App access: ${name}`, body: appGrantsWords(app, name), action: { label: 'Open', run: () => navigate({ name: 'program', id: app.program }) }, ttl: 8000 })
          return
        }
        if (e.type === 'budget.refused') {
          const notice = refusalNotice(e, s)
          if (notice) s.toast(notice)
          return
        }
        if (e.type === 'budget.overrun') {
          const w = overrunWords(e, (id) => shown(s.agents[id]?.name ?? id))
          s.toast({ tone: 'info', icon: 'chart', title: w.title, body: w.body, action: { label: 'Held calls', run: () => navigate({ name: 'usage' }) }, ttl: 8000 })
          return
        }
        if (e.type === 'budget.estimated') {
          const w = estimatedWords(e)
          s.toast({ tone: 'info', icon: 'coin', title: w.title, body: w.body, action: { label: 'Review', run: () => navigate({ name: 'usage' }) }, ttl: 10000, group: 'budget.estimated' })
        }
      }),
    [],
  )
}
