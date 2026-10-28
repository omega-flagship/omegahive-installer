import { ApiError } from '../../api/client'
import { stopped, type BoundOperation } from '../../lib/boundOperation'
/** r1.14b: reading and parsing the own-key monthly total (see OwnMonthlyLimit.tsx). */
export interface OwnLimitView { month_usd: number; spent_usd: number | null }
export type OwnLimitState = { state: 'set'; limit: OwnLimitView; ownKeys: number } | { state: 'unset'; ownKeys: number } | { state: 'unreadable' }
export function readOwnLimit(v: unknown): OwnLimitState {
  if (!v || typeof v !== 'object' || !Array.isArray((v as { own?: unknown }).own) || !Array.isArray((v as { keys?: unknown }).keys)) return { state: 'unreadable' }
  const ownKeys = (v as { keys: unknown[] }).keys.length
  const row = ((v as { own: unknown[] }).own).find((r) => !!r && typeof r === 'object' && (r as { key_id?: unknown }).key_id === '*' && (r as { active?: unknown }).active !== false) as Record<string, unknown> | undefined
  if (!row) return { state: 'unset', ownKeys }
  if (typeof row.month_usd !== 'number' || !Number.isFinite(row.month_usd)) return { state: 'unreadable' }
  return { state: 'set', limit: { month_usd: row.month_usd, spent_usd: typeof row.spent_usd === 'number' ? row.spent_usd : null }, ownKeys }
}
/** what the person typed, as a limit the host accepts (0 stops everything; at most $1,000,000), or null */
export function parseLimit(text: string): number | null {
  const t = text.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t)
  return n >= 0 && n <= 1_000_000 ? n : null
}


/** what one save came to: only a refusal the hive answered is "nothing changed"; a lost answer or a failed readback is unknown */
export type SaveOutcome = { kind: 'saved'; view: OwnLimitState } | { kind: 'unconfirmed'; view: OwnLimitState | null } | { kind: 'refused' } | { kind: 'stopped' }
export async function saveOwnLimit(op: BoundOperation, io: { write(body: { key_id: '*'; month_usd: number }): Promise<unknown>; read(): Promise<unknown> }, month: number): Promise<SaveOutcome> {
  let sent = false
  try {
    await op.write(() => io.write({ key_id: '*', month_usd: month }))
    sent = true
    const view = readOwnLimit(await op.write(() => io.read()))
    return view.state === 'set' && view.limit.month_usd === month ? { kind: 'saved', view } : { kind: 'unconfirmed', view }
  } catch (e) {
    if (stopped(e)) return { kind: 'stopped' }
    // a client error the host answered before acting (4xx, not a 408 timeout) is a refusal; a 5xx, a 408 or a lost
    // answer may come after the row was written, so it stays unconfirmed (Design 145800Z #1)
    return !sent && e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 ? { kind: 'refused' } : { kind: 'unconfirmed', view: null }
  }
}

/** r1.14b (Dot, the owner's three 409 duplicate_key): the hive's refusal of a new key, in plain words that stay on screen */
export function addKeyRefusalWords(err: unknown, provider: string): string {
  const code = err instanceof ApiError ? err.code : null
  if (code === 'duplicate_key') return `That key is already saved in this hive, perhaps as the hive's own key or one added before. Make a new key at ${provider} for your own use, then add that one.`
  if (code === 'bad_key' || (err instanceof ApiError && err.status === 401)) return `${provider} did not accept that key. Check it was copied whole, or make a new one.`
  const msg = err instanceof Error && err.message ? err.message : null
  return msg ? `The key was not added: ${msg}` : 'The key was not added. Nothing was saved.'
}
