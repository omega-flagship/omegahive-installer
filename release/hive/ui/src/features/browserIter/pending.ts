/** Surface owns sealing, key custody and the AAD encoding. This adapter only supplies the broker's record contract. */
export interface PendingStep {
  v?: 1 | 2
  kind?: undefined
  key: string
  turnId: string
  owner: 'iter'
  step: number
  body: object
  history?: unknown[]
  calls?: unknown[]
  inputs?: { clock?: string[]; steers?: { steerId: string; words: string }[]; steerAt?: string | null }
}
export interface PendingTurn { v: 2; kind: 'turn'; key: string; turnId: string; owner: 'iter'; at: number }
export interface PendingCall { v: 2; kind: 'call'; key: string; turnId: string; callId: string }
export interface PendingSteer { v: 2; kind: 'steer'; key: string; turnId: string; steerId: string; words: string; seq: number; accepted?: true; refused?: true }
export type PendingRecord = PendingStep | PendingTurn | PendingCall | PendingSteer
export interface SealedRecords {
  put(key: string, value: unknown): Promise<void>
  get(key: string): Promise<unknown>
  delete(key: string): Promise<void>
  list(): Promise<unknown[]>
}
export interface PendingScope { readonly spaceId: string; readonly deviceId: string }
export type OpenSealed = (recordKind: 'iter-pending', aad: PendingScope) => Promise<SealedRecords>

const steerWords = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.steerId === 'string' && s.steerId.length > 0 && s.steerId.length <= 128 && typeof s.words === 'string' && s.words.trim().length > 0 && s.words.length <= 4000
}
const inputs = (v: unknown) => {
  if (v === undefined) return true
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const i = v as Record<string, unknown>
  return (i.clock === undefined || Array.isArray(i.clock) && i.clock.every(t => typeof t === 'string'))
    && (i.steers === undefined || Array.isArray(i.steers) && i.steers.every(steerWords))
    && (i.steerAt === undefined || i.steerAt === null || typeof i.steerAt === 'string')
}

const valid = (v: unknown): v is PendingRecord => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (typeof r.turnId !== 'string' || !r.turnId) return false
  if (r.kind === 'turn') return r.v === 2 && r.owner === 'iter' && r.key === `turn:${r.turnId}` && typeof r.at === 'number' && Number.isSafeInteger(r.at) && r.at >= 0
  if (r.kind === 'call') return r.v === 2 && typeof r.callId === 'string' && r.callId.length > 0 && r.key === `call:${r.turnId}:${r.callId}`
  if (r.kind === 'steer') return r.v === 2 && steerWords(r) && r.key === `steer:${r.turnId}:${r.steerId}` && Number.isSafeInteger(r.seq) && (r.seq as number) >= 0
    && (r.accepted === undefined || r.accepted === true) && (r.refused === undefined || r.refused === true) && !(r.accepted && r.refused)
  if (r.kind !== undefined || (r.v !== undefined && r.v !== 1 && r.v !== 2)) return false
  return r.owner === 'iter'
    && typeof r.step === 'number' && Number.isSafeInteger(r.step) && r.step >= 0 && r.key === `${r.turnId}:${r.step}`
    && !!r.body && typeof r.body === 'object' && !Array.isArray(r.body)
    && (r.v !== 2 || (Array.isArray(r.history) && Array.isArray(r.calls)))
    && inputs(r.inputs)
}

/** No memory/plaintext fallback here: locked or unavailable sealed storage prevents starting a browser-owned turn. */
export async function openIterPending(openSealed: OpenSealed, aad: PendingScope, current: () => boolean) {
  const assertCurrent = () => { if (!current()) throw new Error('browser mind identity changed') }
  assertCurrent()
  if (typeof aad.spaceId !== 'string' || !aad.spaceId.trim() || typeof aad.deviceId !== 'string' || !aad.deviceId.trim()) throw new Error('missing mind space or device')
  const records = await openSealed('iter-pending', Object.freeze({ spaceId: aad.spaceId, deviceId: aad.deviceId }))
  assertCurrent()
  return {
    async put(key: string, value: unknown) {
      assertCurrent()
      if (!valid(value) || value.key !== key) throw new Error('invalid pending Iter record')
      // The record must retain the first body independently of a caller mutating its object after the write.
      await records.put(key, structuredClone(value))
      assertCurrent()
    },
    async delete(key: string) {
      assertCurrent()
      await records.delete(key)
      assertCurrent()
    },
    async list(): Promise<PendingRecord[]> {
      assertCurrent()
      const values = await records.list()
      assertCurrent()
      if (!values.every(valid)) throw new Error('unreadable pending Iter records')
      return structuredClone(values)
    },
  }
}
