/** P1 public data contract. Selectors below grant no authority; only the parent calls authenticated routes. */
export const APP_ASK_BYTES = 8192
export const APP_ASK_LEASE_MS = 15_000
export const APP_ASK_RENEW_MS = 5_000
export const APP_ASK_SUBSCRIPTIONS = 16
export const APP_ASK_EVENT_BYTES = 61_440
export const APP_ASK_PENDING_BYTES = 8_192
export const APP_ASK_ACK_MS = 2_000
export interface AppAskRelease { digest: string; version: string }
export interface AppAskCard {
  app_id: string; name: string; release_digest: string; version: string
  consent_id: string | null; consent_epoch: number; consented: boolean; card_id: string | null
  permission: 'may send to and show your Ask while open'
  related_apps?: string[]
}
export interface AppAskLease {
  generation_id: string; consent_id: string; consent_epoch: number; release_digest: string
  lease_ms: 15000; renew_after_ms: 5000; resumable_operations: string[]; initial_operation_id: string | null
}
export interface AppAskPresentation {
  operation_id: string; turn_id: string; owner: 'host' | 'frame'; host_active: boolean
  generation_id: string | null; epoch: number
}
export interface AppAskRecipient { kind: 'host' | 'frame'; generation_id: string | null; owner_epoch: number }
export interface AppAskCursor { after_seq: number; offset: number }
export interface AppAskSubscription { subscription_id: string; operation_id: string; cursor: AppAskCursor; presentation: AppAskPresentation }
export interface AppAskChunk {
  kind: 'chunk'; subscription_id: string; operation_id: string; seq: number; offset: number; total_bytes: number
  sha256: string; data_base64: string; next_cursor: AppAskCursor; complete: boolean; terminal: boolean
}
export interface AppAskIdle { kind: 'idle'; subscription_id: string; cursor: AppAskCursor; terminal: boolean }
export type AppAskOp =
  | { op: 'send'; text: string; context?: Record<string, unknown>; op_id: string }
  | { op: 'resume'; operation_id: string; expected_epoch: number }
  | { op: 'subscribe'; operation_id: string }
  | { op: 'unsubscribe'; subscription_id: string }
  | { op: 'poll'; subscription_id: string; cursor: AppAskCursor }
  | { op: 'act-claim'; operation_id: string; act_id: string; expected_epoch: number }
  | { op: 'act-result'; operation_id: string; act_id: string; result: Record<string, unknown> }
  | { op: 'yield'; operation_id: string }
  | { op: 'notices'; after?: number }
  | { op: 'spend'; days?: number }

export const askSelector = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,160}$/.test(v)
export const askInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export const askObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
export const askKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k))
export function askBytes(v: unknown): number {
  try { const text = JSON.stringify(v); return typeof text === 'string' ? new TextEncoder().encode(text).byteLength : Infinity } catch { return Infinity }
}
export function readAppAskRelease(v: unknown): AppAskRelease | null {
  return askObject(v) && askKeys(v, ['digest', 'version']) && typeof v.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(v.digest) && typeof v.version === 'string' && v.version.length <= 160 ? v as unknown as AppAskRelease : null
}
export function readAppAskCard(v: unknown, app: string, digest: string): AppAskCard | null {
  if (!askObject(v) || !askKeys(v, ['app_id', 'name', 'release_digest', 'version', 'consent_id', 'consent_epoch', 'consented', 'card_id', 'permission', 'related_apps'])) return null
  if (v.related_apps !== undefined && (!Array.isArray(v.related_apps) || v.related_apps.length > 8 || !v.related_apps.every(x => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(x)))) return null
  return v.app_id === app && v.release_digest === digest && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 200 && typeof v.version === 'string' && v.version.length <= 160 && askInteger(v.consent_epoch) && typeof v.consented === 'boolean' && (v.consented ? askSelector(v.consent_id) : v.consent_id === null || askSelector(v.consent_id)) && (v.card_id === null || askSelector(v.card_id)) && v.permission === 'may send to and show your Ask while open' ? v as unknown as AppAskCard : null
}
export function readAppAskLease(v: unknown, digest: string): AppAskLease | null {
  if (!askObject(v) || !askKeys(v, ['generation_id', 'consent_id', 'consent_epoch', 'release_digest', 'lease_ms', 'renew_after_ms', 'resumable_operations', 'initial_operation_id'])) return null
  return askSelector(v.generation_id) && askSelector(v.consent_id) && askInteger(v.consent_epoch) && v.release_digest === digest && v.lease_ms === APP_ASK_LEASE_MS && v.renew_after_ms === APP_ASK_RENEW_MS && Array.isArray(v.resumable_operations) && v.resumable_operations.length <= APP_ASK_SUBSCRIPTIONS && v.resumable_operations.every(askSelector) && new Set(v.resumable_operations).size === v.resumable_operations.length && (v.initial_operation_id === null || askSelector(v.initial_operation_id)) ? v as unknown as AppAskLease : null
}
export function readAppAskPresentation(v: unknown, operation?: string): AppAskPresentation | null {
  if (!askObject(v) || !askKeys(v, ['operation_id', 'turn_id', 'owner', 'host_active', 'generation_id', 'epoch'])) return null
  return askSelector(v.operation_id) && (!operation || v.operation_id === operation) && askSelector(v.turn_id) && (v.owner === 'host' || v.owner === 'frame') && typeof v.host_active === 'boolean' && askInteger(v.epoch) && ((v.owner === 'host' && v.generation_id === null) || (v.owner === 'frame' && askSelector(v.generation_id) && v.host_active === false)) ? v as unknown as AppAskPresentation : null
}
export function readAppAskRecipient(v: unknown): AppAskRecipient | null {
  if (!askObject(v) || !askKeys(v, ['kind', 'generation_id', 'owner_epoch']) || !askInteger(v.owner_epoch)) return null
  return (v.kind === 'host' && v.generation_id === null) || (v.kind === 'frame' && askSelector(v.generation_id)) ? v as unknown as AppAskRecipient : null
}
/** Missing is a legacy host act only. A tracked P1 turn must always carry an explicit recipient. */
export function hostAskRecipient(v: unknown, tracked = false): boolean {
  return v === undefined ? !tracked : readAppAskRecipient(v)?.kind === 'host'
}
/** A host claim is useful only for the exact turn and presentation epoch that issued this act. */
export function hostAskPresentationMatches(value: AppAskPresentation | null, operation: string, turn: string, recipient: AppAskRecipient | undefined): boolean {
  const r = readAppAskRecipient(recipient)
  return !!value && r?.kind === 'host' && value.operation_id === operation && value.turn_id === turn && value.owner === 'host' && value.generation_id === null && value.epoch === r.owner_epoch
}
export function readAppAskClaim(v: unknown, act: string): boolean {
  return askObject(v) && askKeys(v, ['act_id', 'claimed']) && v.act_id === act && v.claimed === true
}
/** Shared pre-effect guard, with no retry of an unknown claim. No DOM or credential state is accepted here. */
export async function admitHostAskAct(input: {
  recipient: AppAskRecipient | undefined; tracked: boolean; operation: string; act: string; current(): boolean
  claim?: (operation: string, act: string, body: { owner_epoch: number }) => Promise<unknown>
}): Promise<boolean> {
  if (!input.current() || !hostAskRecipient(input.recipient, input.tracked)) return false
  if (!input.recipient) return input.current()
  if (!input.claim) return false
  try {
    const receipt = await input.claim(input.operation, input.act, { owner_epoch: input.recipient.owner_epoch })
    return readAppAskClaim(receipt, input.act) && input.current()
  } catch { return false }
}
export function readAppAskCursor(v: unknown): AppAskCursor | null {
  return askObject(v) && askKeys(v, ['after_seq', 'offset']) && askInteger(v.after_seq) && askInteger(v.offset) && v.offset <= APP_ASK_EVENT_BYTES ? v as unknown as AppAskCursor : null
}
export const sameAskCursor = (a: AppAskCursor, b: AppAskCursor) => a.after_seq === b.after_seq && a.offset === b.offset
export function readAppAskSubscription(v: unknown, operation: string, generation: string): AppAskSubscription | null {
  if (!askObject(v) || !askKeys(v, ['subscription_id', 'operation_id', 'cursor', 'presentation'])) return null
  const p = readAppAskPresentation(v.presentation, operation)
  return askSelector(v.subscription_id) && v.operation_id === operation && readAppAskCursor(v.cursor) && p?.owner === 'frame' && p.generation_id === generation ? v as unknown as AppAskSubscription : null
}
export function readAppAskPoll(v: unknown, subscription: AppAskSubscription): AppAskChunk | AppAskIdle | null {
  if (!askObject(v) || askBytes(v) > APP_ASK_BYTES || v.subscription_id !== subscription.subscription_id || typeof v.terminal !== 'boolean') return null
  if (v.kind === 'idle') return askKeys(v, ['kind', 'subscription_id', 'cursor', 'terminal']) && readAppAskCursor(v.cursor) && sameAskCursor(v.cursor as AppAskCursor, subscription.cursor) ? v as unknown as AppAskIdle : null
  if (v.kind !== 'chunk' || !askKeys(v, ['kind', 'subscription_id', 'operation_id', 'seq', 'offset', 'total_bytes', 'sha256', 'data_base64', 'next_cursor', 'complete', 'terminal'])) return null
  if (v.operation_id !== subscription.operation_id || !askInteger(v.seq) || v.seq <= subscription.cursor.after_seq || !askInteger(v.offset) || v.offset !== subscription.cursor.offset || !askInteger(v.total_bytes) || v.total_bytes < 1 || v.total_bytes > APP_ASK_EVENT_BYTES || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256) || typeof v.data_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data_base64) || v.data_base64.length < 4 || v.data_base64.length > 4096 || typeof v.complete !== 'boolean' || !readAppAskCursor(v.next_cursor)) return null
  const length = v.data_base64.length / 4 * 3 - (v.data_base64.endsWith('==') ? 2 : v.data_base64.endsWith('=') ? 1 : 0)
  const end = v.offset + length, next = v.next_cursor as AppAskCursor
  if (length < 1 || length > 3072 || end > v.total_bytes || v.complete !== (end === v.total_bytes)) return null
  return v.complete ? (next.after_seq === v.seq && next.offset === 0 ? v as unknown as AppAskChunk : null) : (next.after_seq === subscription.cursor.after_seq && next.offset === end ? v as unknown as AppAskChunk : null)
}
