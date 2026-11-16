import { ARM_MS, began, canActivate, initialGate, keyUp, refusalWords, settled, shown, type Activation, type GateState, type Refusal } from '../../experiences/still/gate'

/**
 * The full-context confirm for actions that spend money, dispatch an agent, reach outside the hive or make a
 * permanent change. It reuses the decision gate proved for Still's approvals (Review R2/R3), so one rule holds:
 *
 *  - fresh activation: the confirm is armed only ARM_MS after it appears, so the click or key that opened it
 *    can never also confirm it;
 *  - no carried focus: focus lands on the dialog's heading, never on the confirm button;
 *  - key auto-repeat is refused, and a key held through the opening must be released first;
 *  - a confirm is bound to the request on screen (action + items + revision); a different one is stale;
 *  - one confirm in flight at a time.
 */

export { ARM_MS }
export type { Refusal }

export interface ConfirmRequest {
  action: string
  items: string[]
  revision: string
}

export const requestKey = (r: ConfirmRequest) => `${r.action}\u0000${r.items.join(',')}\u0000${r.revision}`

/** The confirm appeared at `at`. Opened from the keyboard: that key must go up before a key can confirm. */
export function opened(req: ConfirmRequest, at: number, viaKey: boolean): GateState {
  const s = shown(initialGate, requestKey(req), at)
  return viaKey ? { ...s, released: false } : s
}

export type Press = { kind: 'key'; key: string; repeat: boolean; at: number } | { kind: 'pointer'; at: number }

export function tryConfirm(s: GateState, req: ConfirmRequest, p: Press): { ok: true; next: GateState } | { ok: false; why: Refusal; words: string | null } {
  const e: Activation = p.kind === 'key' ? { ...p, boundId: requestKey(req) } : { ...p, boundId: requestKey(req) }
  const v = canActivate(s, e)
  if (!v.ok) return { ok: false, why: v.why, words: refusalWords(v.why) }
  return { ok: true, next: began(s, e, true) }
}

export const released = keyUp
export const finished = (s: GateState, req: ConfirmRequest) => settled(s, requestKey(req))
export type { GateState }
