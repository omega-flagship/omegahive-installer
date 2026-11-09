import type { ActionResult, WorkGraph } from '../../api/types'

/**
 * Scientist requests the person has sent from this form: sealed, revocable envelopes. Atlas's view does not list
 * them, so the form keeps what act() returned (the request digest) and nothing private: no question text, no
 * values. Pure; the hook persists it.
 */
export type RequestState = 'pending' | 'revoked' | 'cancelled' | 'expired' | 'refused'

export interface ScientistRequest {
  digest: string
  items: string[]
  worker: string
  sentAt: number
  /** Unix ms. */
  expiresAt: number
  budgetSeconds: number
  state: RequestState
  goalId?: string
  /** Sample mode: nothing left the page. */
  simulated?: boolean
}

export function recordSent(list: ScientistRequest[], r: { items: string[]; worker: string; expiresAt: number; budgetSeconds: number; simulated?: boolean }, result: ActionResult, now: number): ScientistRequest[] {
  const digest = typeof result.detail?.request_digest === 'string' ? result.detail.request_digest : null
  if (!digest || (result.status !== 'started' && result.status !== 'done')) return list
  const next: ScientistRequest = { digest, items: [...r.items], worker: r.worker, sentAt: now, expiresAt: r.expiresAt, budgetSeconds: r.budgetSeconds, state: 'pending', goalId: result.task?.id, simulated: r.simulated }
  return [next, ...list.filter((x) => x.digest !== digest)]
}

/** A revoke or cancel only changes the state when Atlas said it was done. */
export function recordClosed(list: ScientistRequest[], digest: string, how: 'revoke-request' | 'cancel-request', result: ActionResult): ScientistRequest[] {
  if (result.status !== 'done') return list
  return list.map((x) => (x.digest === digest ? { ...x, state: how === 'revoke-request' ? 'revoked' : 'cancelled' } : x))
}

/** Requests past their expiry are expired, whatever else is known. */
export const withExpiry = (list: ScientistRequest[], now: number): ScientistRequest[] => list.map((x) => (x.state === 'pending' && now >= x.expiresAt ? { ...x, state: 'expired' } : x))

export const pendingFor = (list: ScientistRequest[], itemId: string) => list.filter((x) => x.state === 'pending' && x.items.includes(itemId))

/** "in 3 h", "in 6 d", "in 12 min". */
export function untilText(ms: number): string {
  if (ms <= 0) return 'expired'
  const min = Math.round(ms / 60000)
  if (min < 90) return `in ${Math.max(1, min)} min`
  const h = Math.round(min / 60)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(h / 24)} d`
}

export const BUDGETS = [
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
]
/** Atlas's exchange refuses an expiry more than 24 hours ahead (exchange.prepare). */
export const EXPIRIES = [
  { ms: 3600_000, label: '1 hour' },
  { ms: 6 * 3600_000, label: '6 hours' },
  { ms: 23 * 3600_000, label: '23 hours' },
]

/**
 * Exactly what the sealed snapshot would hold, mirroring Atlas's exchange.scoped_snapshot: the targets, everything
 * that links into anything included (transitively: their premises), and the events those records cite.
 * Nothing else is added.
 */
export function snapshotScope(graph: WorkGraph, targets: string[]): { ids: Set<string>; byKind: Record<string, number> } {
  const byId = new Map(graph.items.map((i) => [i.id, i]))
  const included = new Set(targets.filter((t) => byId.has(t)))
  for (;;) {
    const before = included.size
    for (const l of graph.links) if (included.has(l.to)) included.add(l.from)
    for (const id of [...included]) for (const s of byId.get(id)?.sources ?? []) if (byId.has(s.id)) included.add(s.id)
    if (included.size === before) break
  }
  const byKind: Record<string, number> = {}
  for (const id of included) {
    const k = byId.get(id)!.kind
    byKind[k] = (byKind[k] ?? 0) + 1
  }
  return { ids: included, byKind }
}

/** Only these keys are ever kept (localStorage), so nothing private can leak into storage. */
export function serialise(list: ScientistRequest[]): string {
  return JSON.stringify(list.slice(0, 40).map(({ digest, items, worker, sentAt, expiresAt, budgetSeconds, state, goalId, simulated }) => ({ digest, items, worker, sentAt, expiresAt, budgetSeconds, state, goalId, simulated })))
}

export function parse(raw: string | null): ScientistRequest[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((x) => x && typeof x.digest === 'string' && Array.isArray(x.items) && typeof x.expiresAt === 'number')
  } catch {
    return []
  }
}

/**
 * Review C2: the source a consent is bound to. Investigate binds the revision and the snapshot closure the dialog
 * shows; revoke/cancel bind the revision and their own items (they send no snapshot).
 */
export function inspectedSource(graph: WorkGraph, action: string, items: string[]): { revision: string; scope: string[] } {
  const scope = action === 'investigate' ? [...snapshotScope(graph, items).ids] : [...items]
  return { revision: graph.revision, scope: scope.sort() }
}
