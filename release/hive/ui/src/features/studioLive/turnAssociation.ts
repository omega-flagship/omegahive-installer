/** Local retained host-frame join only: server turn IDs and operation IDs are different domains. */
import { readActingAs } from '../../api/ask'
import type { TurnMeta } from '../../store/ask'

export type DrawingTurnAssociation =
  | { state: 'known'; serverTurnId: string; operationId: string; omega: ReturnType<typeof readActingAs>; lastSeq: number }
  | { state: 'missing' | 'ambiguous' | 'foreign' | 'invalid' }

const selector = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/.test(v)

/** Caller separately proves this is the current bound person's retained state. Host _frame supplies principal and
 * both selectors; only placed frames count, never guessed aliases, current-thread names or unplaced effects. */
export function resolveDrawingTurn(serverTurnId: string, principal: string, turns: Readonly<Record<string, TurnMeta>>): DrawingTurnAssociation {
  if (!selector(serverTurnId) || !principal) return { state: 'invalid' }
  const matches: Extract<DrawingTurnAssociation, { state: 'known' }>[] = []
  for (const [operationId, turn] of Object.entries(turns)) {
    const frames = Array.isArray(turn.events) ? turn.events : []
    const links = frames.map((e) => e as unknown as Record<string, unknown>)
    if (!links.some((e) => e.turn_id === serverTurnId)) continue
    if (!selector(operationId) || operationId === serverTurnId || turn.op !== operationId || !Number.isSafeInteger(turn.lastSeq) || turn.lastSeq < 1) return { state: 'invalid' }
    if (links.some((e) => e.principal !== principal)) return { state: 'foreign' }
    if (links.some((e) => e.type !== 'ask' || e.operation_id !== operationId || e.turn_id !== serverTurnId || typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 1 || e.seq > turn.lastSeq)) return { state: 'ambiguous' }
    if (turn.appAskTurnId !== undefined && turn.appAskTurnId !== serverTurnId) return { state: 'ambiguous' }
    matches.push({ state: 'known', serverTurnId, operationId, omega: readActingAs(turn.actingAs), lastSeq: turn.lastSeq })
  }
  return matches.length === 1 ? matches[0] : { state: matches.length ? 'ambiguous' : 'missing' }
}
