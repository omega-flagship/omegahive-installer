/** P8 host-only protocol. No memory data, storage access, network, or reasoning lives on the wire. */
export const MEMORY_WIRE = { open: 'memory-open', opened: 'memory-opened', closed: 'memory-closed', refused: 'memory-refused' } as const
/** Private host mount identity. A caller's request ID never keys retained memory UI state. */
export const nextMemoryOpeningKey = (): string => crypto.randomUUID()
const ID = /^[A-Za-z0-9_-]{1,96}$/
const THEME = /^[a-z0-9-]{1,24}$/
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
export interface MemoryOpen { id: string; topic: string; theme?: string; token?: string }
export type MemoryRequest = { ok: true; request: MemoryOpen } | { ok: false; id: string | null; reason: 'invalid' | 'unsupported' }

/** Read once with the frame document, never obtained by a memory operation. Explicit null means no expiry. */
export interface MemorySession { principal: string; expiresAt: number | null }
export function readMemorySession(value: unknown): MemorySession | null {
  if (!plain(value) || typeof value.principal !== 'string' || !/^user:[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/.test(value.principal)) return null
  const expires = value.expires_at
  if (expires === null) return { principal: value.principal, expiresAt: null }
  return typeof expires === 'number' && Number.isFinite(expires) && expires > 0 && expires <= Number.MAX_SAFE_INTEGER / 1000
    ? { principal: value.principal, expiresAt: expires * 1000 } : null
}

/** Host bookkeeping fence: missing program, digest, owner, session or document authority always closes access. */
export function memoryHostCurrent(input: {
  session: MemorySession | null; owner: { principal: string; hive: string } | null
  hive: string; program: { enabled: boolean; digest?: string | null } | null | undefined
  releaseDigest: string | null | undefined; identityCurrent: boolean; documentCurrent: boolean; ready: boolean; now?: number
}): boolean {
  return input.ready && input.identityCurrent && input.documentCurrent && !!input.session
    && (input.session.expiresAt === null || (input.now ?? Date.now()) < input.session.expiresAt)
    && input.owner?.principal === input.session.principal && input.owner?.hive === input.hive
    && input.program?.enabled === true && typeof input.releaseDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(input.releaseDigest)
    && input.program.digest === input.releaseDigest
}

export function parseMemoryRequest(value: unknown): MemoryRequest | null {
  if (!plain(value) || typeof value.type !== 'string' || !value.type.startsWith('memory-')) return null
  const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : null
  if (value.type !== MEMORY_WIRE.open) return { ok: false, id, reason: 'unsupported' }
  if (!id || Object.keys(value).some((key) => !['type', 'channel', 'id', 'topic', 'theme', 'token'].includes(key))) return { ok: false, id, reason: 'invalid' }
  if (value.topic !== undefined && (typeof value.topic !== 'string' || value.topic.length > 160 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.topic))) return { ok: false, id, reason: 'invalid' }
  if (value.theme !== undefined && (typeof value.theme !== 'string' || !THEME.test(value.theme))) return { ok: false, id, reason: 'invalid' }
  if (value.token !== undefined && (typeof value.token !== 'string' || !ID.test(value.token) || value.topic !== undefined)) return { ok: false, id, reason: 'invalid' }
  return { ok: true, request: { id, topic: typeof value.topic === 'string' && value.topic.trim() ? value.topic.trim() : 'your memory',
    ...(typeof value.theme === 'string' ? { theme: value.theme } : {}), ...(typeof value.token === 'string' ? { token: value.token } : {}) } }
}

/** Construct lifecycle replies from an allowlist, never by spreading an overlay/store/action result. */
export function memoryNotice(type: 'opened' | 'closed', id: string): { type: 'memory-opened' | 'memory-closed'; id: string } {
  return { type: type === 'opened' ? MEMORY_WIRE.opened : MEMORY_WIRE.closed, id }
}
export const memoryRefused = (id: string, reason: 'invalid' | 'unsupported' | 'busy' | 'unavailable' | 'rate-limited') => ({ type: MEMORY_WIRE.refused, id, reason })

/** Shared across mounts of the same app/person. The host alone supplies active user interaction. */
export class MemoryOpenBudget {
  private entries = new Map<string, number[]>()
  constructor(private readonly now: () => number = () => performance.now()) {}
  admit(appPerson: string, activelyUsed: boolean): boolean {
    const at = this.now()
    for (const [key, times] of this.entries) if (times.every((t) => at - t >= 600_000)) this.entries.delete(key)
    const times = (this.entries.get(appPerson) ?? []).filter((t) => at - t < 600_000)
    if (times.length >= 3 && !activelyUsed || !this.entries.has(appPerson) && this.entries.size >= 128) return false
    this.entries.set(appPerson, [...times, at].slice(-3))
    return true
  }
  clear(): void { this.entries.clear() }
}

/** R4.2 opaque reason seam for host cards. App-provided tokens cannot manufacture a topic or identity. */
export class MemoryReasonTokens {
  private reasons = new Map<string, { app: string; swarm: string; digest: string; topic: string; current: () => boolean }>()
  issue(app: string, swarm: string, digest: string, topic: string, current: () => boolean): string {
    for (const [key, reason] of this.reasons) if (!reason.current()) this.reasons.delete(key)
    if (this.reasons.size >= 128) throw new Error('Too many memory review reasons')
    const token = crypto.randomUUID()
    this.reasons.set(token, { app, swarm, digest, topic: topic.slice(0, 160), current })
    return token
  }
  resolve(token: string, app: string, swarm: string, digest: string): string | null {
    const reason = this.reasons.get(token)
    if (!reason || !reason.current() || reason.app !== app || reason.swarm !== swarm || reason.digest !== digest) return null
    return reason.topic
  }
  clear(): void { this.reasons.clear() }
}

export const memoryOpenBudget = new MemoryOpenBudget()
export const memoryReasonTokens = new MemoryReasonTokens()
