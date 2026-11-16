/**
 * J3 r4.3 O3: the frame mount's host authority (host plan r1.2 E3; Design 213121Z pins). This adapter alone owns:
 *   POST   /api/studio-sessions/{sid}/mount {expected_epoch, receiver_generation, stream_id, mount_id}   compare-and-swap
 *   POST   /api/studio-sessions/{sid}/mount/heartbeat {mount_token, mount_epoch, receiver_generation} renews the LEASE only
 *   DELETE /api/studio-sessions/{sid}/mount {mount_token}                                          revokes on unmount
 * The mount_token is bearer-like: it lives only in this object (never in the frame, never logged, never in React state or
 * storage). Every upload, refresh, heartbeat and outcome carries {mount_token, mount_epoch, receiver_generation} from
 * `fields()`. A lost CAS, a replacement, a revocation or lease expiry makes `current()` false SYNCHRONOUSLY and calls
 * `lost` (the store closes local receiving and says so). No retry, re-acquire or auto-resume from a local counter; an
 * unknown CAS answer is not a win.
 */
import { ApiError } from '../../api/client'

export const MOUNT_LEASE_MS = 60_000
export const HEARTBEAT_MS = 25_000
export type MountState = 'none' | 'mounting' | 'current' | 'lost' | 'released'
export type LostReason = 'replaced' | 'revoked' | 'expired' | 'unknown'
export interface MountFields { mount_token: string; mount_epoch: number; receiver_generation: number }

export interface MountDeps {
  receiver_generation: number
  stream_id: string
  mount_id: string
  /** host R3: the body is exactly {expected_epoch, receiver_generation, stream_id, mount_id, attempt_id} */
  mount(body: { expected_epoch: number | null; receiver_generation: number; stream_id: string; mount_id: string; attempt_id: string }): Promise<unknown>
  /** host R3 GET …/mount?attempt_id=: a lost mount answer is read back by its attempt id (never inferred from a timeout) */
  readback?(attempt_id: string): Promise<unknown>
  heartbeat(body: MountFields): Promise<unknown>
  unmount(body: { mount_token: string }): Promise<unknown>
  /** a monotonic clock for durations (performance.now) */
  now(): number
  /** the wall clock, only to turn the host's absolute expiry into a remaining duration once (default Date.now) */
  wall?(): number
  later(ms: number, fn: () => void): () => void
  lost(reason: LostReason): void
  changed?(): void
}

export class MountLease {
  state: MountState = 'none'
  epoch: number | null = null
  leaseUntil = 0
  lostReason: LostReason | null = null
  #token: string | null = null
  /** this mount's one attempt id (host R3 replay key; 8–80 of A-Z a-z 0-9 . _ : -) */
  readonly attemptId = `att_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  #timers: (() => void)[] = []
  constructor(private deps: MountDeps) {}

  current(): boolean {
    if (this.state !== 'current') return false
    if (this.deps.now() >= this.leaseUntil) { this.lose('expired'); return false }
    return true
  }
  /** The three fields every write carries, or null when this mount is not the current one. */
  fields(): MountFields | null {
    return this.current() && this.#token && this.epoch !== null ? { mount_token: this.#token, mount_epoch: this.epoch, receiver_generation: this.deps.receiver_generation } : null
  }

  /** Compare-and-swap against the epoch last seen (null: the first mount). Resolves true only on a recorded win. */
  async acquire(expectedEpoch: number | null): Promise<boolean> {
    if (this.state !== 'none') return false
    this.state = 'mounting'
    this.deps.changed?.()
    let v: unknown
    try {
      v = await this.deps.mount({ expected_epoch: expectedEpoch, receiver_generation: this.deps.receiver_generation, stream_id: this.deps.stream_id, mount_id: this.deps.mount_id, attempt_id: this.attemptId })
    } catch (e) {
      if ((this.state as MountState) !== 'mounting') return false
      if (e instanceof ApiError && e.code === 'mount_conflict') { this.lose('replaced'); return false }
      // a lost answer: read the attempt back (host R3); only a recorded win that is still current is a win
      const won = e instanceof ApiError && (e.status === 0 || e.status >= 500) && this.deps.readback ? await this.readBack() : null
      if ((this.state as MountState) !== 'mounting') return false
      if (!won) { this.lose('unknown'); return false }
      v = won
    }
    if ((this.state as MountState) !== 'mounting') return false
    const o = (v ?? {}) as Record<string, unknown>
    const lease = typeof o.lease_expires_at === 'string' ? Date.parse(o.lease_expires_at) : NaN
    if (typeof o.mount_token !== 'string' || !/^mt_[a-f0-9]{24}$/.test(o.mount_token) || typeof o.mount_epoch !== 'number' || !Number.isSafeInteger(o.mount_epoch)) {
      this.lose('unknown')   // an answer that does not name the win is not a win
      return false
    }
    this.#token = o.mount_token
    this.epoch = o.mount_epoch
    this.leaseUntil = this.untilFrom(lease)
    this.state = 'current'
    this.schedule()
    this.deps.changed?.()
    return true
  }

  private async readBack(): Promise<Record<string, unknown> | null> {
    try {
      const r = (await this.deps.readback!(this.attemptId)) as { lease_expires_at?: unknown; attempt?: { outcome?: unknown; mount_epoch?: unknown; mount_token?: unknown } | null } | null
      const a = r?.attempt
      if (a && a.outcome === 'mounted' && typeof a.mount_token === 'string') return { mount_token: a.mount_token, mount_epoch: a.mount_epoch, lease_expires_at: r?.lease_expires_at }
    } catch { /* unread: not a win */ }
    return null
  }

  /** A host refusal on any write that names this mount as old, revoked or gone: lose it now. */
  noteRefusal(e: unknown): void {
    if (!(e instanceof ApiError)) return
    if (e.code === 'stale_mount' || e.code === 'mount_conflict') this.lose('replaced')
    else if (e.code === 'mount_revoked' || (e.status === 404 && this.state === 'current')) this.lose('revoked')
  }

  /** Unmount: synchronously not current, then (when `send`) revoke on the host with the token. Never re-acquired. */
  async release(send: (fn: () => Promise<unknown>) => Promise<unknown>): Promise<void> {
    const token = this.#token
    const was = this.state
    this.clear()
    this.state = 'released'
    this.deps.changed?.()
    if (was === 'current' && token) {
      try { await send(() => this.deps.unmount({ mount_token: token })) } catch { /* the lease expires on its own */ }
    }
  }
  /** Drop authority with no host call (an identity change: the new person's bearer is never used for this mount). */
  forget(): void {
    this.clear()
    this.state = 'released'
  }

  /** the host's absolute expiry as a monotonic deadline: remaining = expiry − wall now, at most the 60 s lease */
  private untilFrom(expiry: number): number {
    const remaining = Number.isFinite(expiry) ? expiry - (this.deps.wall?.() ?? Date.now()) : Infinity
    return this.deps.now() + Math.max(0, Math.min(remaining, MOUNT_LEASE_MS))
  }

  private lose(reason: LostReason) {
    if (this.state === 'lost' || this.state === 'released') return
    this.clear()
    this.state = 'lost'
    this.lostReason = reason
    this.deps.lost(reason)
    this.deps.changed?.()
  }
  private clear() {
    this.#token = null
    for (const t of this.#timers) t()
    this.#timers = []
  }
  private schedule() {
    for (const t of this.#timers) t()
    this.#timers = [
      this.deps.later(Math.max(0, this.leaseUntil - this.deps.now()), () => { if (this.state === 'current' && this.deps.now() >= this.leaseUntil) this.lose('expired') }),
      this.deps.later(HEARTBEAT_MS, () => void this.beat()),
    ]
  }
  private async beat() {
    const f = this.fields()
    if (!f) return
    try {
      const v = (await this.deps.heartbeat(f)) as { lease_expires_at?: unknown } | null
      if (this.state !== 'current' || this.#token !== f.mount_token) return
      const lease = typeof v?.lease_expires_at === 'string' ? Date.parse(v.lease_expires_at) : NaN
      this.leaseUntil = this.untilFrom(lease)
      this.schedule()
    } catch (e) {
      this.noteRefusal(e)
      if (this.state === 'current') this.#timers.push(this.deps.later(5_000, () => void this.beat()))   // the lease timer still decides
    }
  }
}
