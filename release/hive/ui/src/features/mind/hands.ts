/**
 * What the personal mind is doing with its hands, and what it handed on, read from the Ask thread the page already
 * holds (store/ask): no read of its own. A turn is the mind's when its `accepted` frame says `acting_as` this mind
 * (Platform P2; absent on hosts without it, so nothing shows as the mind's there).
 */
import { readActingAs } from '../../api/personalMind'
import { turnRows, type LogEntry, type RowState, type TurnMeta } from '../../store/ask'

export interface HandRow {
  id: string
  text: string
  state: 'done' | 'now' | 'refused' | 'waiting'
}
export interface Hands {
  op: string
  /** the turn is still open and the person has not taken over: it may act again */
  live: boolean
  rows: HandRow[]
}
export interface HandedOn {
  id: string
  text: string
  at: string
}

const HANDS = new Set(['act', 'proposal', 'presence', 'action-needs-confirm'])

/** The turn's mind, as `acting_as` on its accepted frame names it (null: not said). */
export function actingAs(t: TurnMeta): { mind_id: string; name: string } | null {
  const a = t.events.find((e) => e.phase === 'accepted')
  return a ? readActingAs((a as unknown as { acting_as?: unknown }).acting_as) : null
}

/** The mind the thread's latest turn spoke as (Platform P2 `acting_as`), or null. */
export function lastActingAs(log: readonly LogEntry[], turns: Record<string, TurnMeta>): string | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (e.kind === 'turn' && turns[e.op]) return actingAs(turns[e.op])?.mind_id ?? null
  }
  return null
}

const stateOf = (s: RowState | undefined, last: boolean, live: boolean): HandRow['state'] =>
  s === 'failed' || s === 'declined' ? 'refused' : s === 'waiting' ? 'waiting' : last && live ? 'now' : 'done'

/** The latest turn in the thread that this mind acted in, with what it did (null: none). */
export function handsOf(log: readonly LogEntry[], turns: Record<string, TurnMeta>, mindId: string): Hands | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (e.kind !== 'turn') continue
    const t = turns[e.op]
    if (!t || actingAs(t)?.mind_id !== mindId) continue
    const live = (t.state === 'open' || t.state === 'sending' || t.state === 'checking') && !t.tookOver
    const phase = new Map(t.events.map((x) => [x.seq, x.phase]))
    const rows = turnRows(t).filter((r) => r.seq !== undefined && HANDS.has(phase.get(r.seq) ?? '') && r.kind !== 'note')
    return { op: t.op, live, rows: rows.map((r, j) => ({ id: r.id, text: r.text, state: stateOf(r.state, j === rows.length - 1, live) })) }
  }
  return null
}

/** Everything handed on to a swarm, service or app in this thread (newest first). */
export function handedOn(log: readonly LogEntry[], turns: Record<string, TurnMeta>): HandedOn[] {
  const out: HandedOn[] = []
  for (const e of log) {
    if (e.kind !== 'turn') continue
    const t = turns[e.op]
    if (!t) continue
    for (const f of t.events) if (f.phase === 'dispatched') out.push({ id: `${t.op}#${f.seq}`, text: `${f.label ?? f.intent_kind} · ${f.to.name ?? f.to.ref}`, at: f.at })
  }
  return out.reverse()
}
