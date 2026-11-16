/**
 * J3 r4.3 O3: the current-piece uploads and their acknowledged custody (contract :43, :73–:77; envelope r1 §Capture 1–4).
 *
 * The frame captures its applied piece as Design's closed envelope (`omega-studio-current-piece-1`, an exact UTF-8 JSON
 * string we never parse or re-serialise) with its scene_ref and native edit_generation. This uploads it:
 *   - at most one write per second, COALESCED to the newest generation: an older capture is never sent over a newer one;
 *   - with the host's seq CAS (`seq` = previous + 1); a 409 `stale_piece` first reconciles, then retries on the host's seq;
 *   - a lost answer is reconciled by the exact seq + body sha256 the ledger shows before ANY other write;
 *   - an oversized or unsupported body holds with its reason (no truncation: the frame keeps the art).
 * Every acknowledged upload is kept as minimal metadata (seq, body sha256, scene_ref, edit_generation, mount) so a step
 * outcome can bind to the exact upload that contains the hand edit it observed (`custodyFor`). Nothing is uploaded once
 * closed (Stop, unmount, identity change): a closed mount cannot issue new current snapshots.
 *
 * Serialization (Design O3 finding P1, r1): ONE upload operation at a time, reserved SYNCHRONOUSLY (before its first
 * await, hashing included) and owned by identity. New captures only replace the single "latest pending". After hashing,
 * an operation that is no longer the owner, or whose capture a newer pending one supersedes, is dropped unsent; so an
 * older capture is never written after a newer one and no two puts share a seq. Cleanup and reconciling compare the
 * operation itself, never a seq. A hash failure releases the operation and holds with the capture kept.
 */
import { ApiError } from '../../api/client'
import type { SceneRef, UploadBinding } from './api'

const sameRef = (a: SceneRef, b: SceneRef) => a.scene_id === b.scene_id && a.revision === b.revision && a.digest === b.digest
import type { CurrentPiece, PieceAck } from './pieceAdapter'

/** A capture from the frame, in the current-piece lease's terms (pieceAdapter.ts owns the wire shape). */
export type Capture = Omit<CurrentPiece, 'scene_id'>
/** An acknowledged upload: the binding tuple, the mount it came from and when the host acknowledged it (local clock). */
export interface Ack extends UploadBinding { mount: number; at: number }
export type CustodyState = 'idle' | 'waiting' | 'uploading' | 'reconciling' | 'held' | 'closed'
export const MAX_PIECE_BYTES = 256 * 1024
export const PIECE_INTERVAL_MS = 1000
/** host plan r1.2 E7 (Design/Platform settled): refresh unchanged art about every 20 s; an unrefreshed piece is stale at 30 s */
export const REFRESH_MS = 20_000
export const STALE_MS = 30_000
const MAX_ACKS = 64

export interface CustodyDeps {
  /** one upload through the adapter; resolves to the host's acknowledgement in lease terms, or null if unreadable */
  put(seq: number, capture: Capture): Promise<PieceAck | null>
  /** the ledger's latest upload (seq + raw body sha256), for reconciling a lost or stale answer */
  ledgerPiece(): Promise<PieceAck | null>
  sha256(text: string): Promise<string>
  now(): number
  later(ms: number, fn: () => void): () => void
  /** the frame mount this custody belongs to (receiver generation); acks carry it */
  mount: number
  /** told whenever the acknowledged set or state changes */
  changed?(): void
  /** ask the frame for a new stable observation (E7 refresh, or custody missing) */
  requestCapture?(): void
}

interface UploadOp { readonly id: number; readonly seq: number; readonly capture: Capture; sha: string | null }
const SIZE_HOLD = 'The piece is larger than the hive takes for a live session (256 KB). Nothing was cut; the drawing waits until it is smaller.'
const SAME_GEN_HOLD = 'The canvas sent different art under the same edit number. Nothing was sent; the drawing waits for a new capture.'
const HASH_HOLD = 'The piece could not be prepared for the hive. Nothing was sent; the drawing waits for the next change.'

export class PieceCustody {
  state: CustodyState = 'idle'
  heldReason: string | null = null
  /** acknowledged uploads, oldest first (bounded) */
  readonly acks: Ack[] = []
  private pending: Capture | null = null
  /** the one upload operation in progress (preparing, putting or reconciling), owned by identity */
  private op: UploadOp | null = null
  private lastSentAt = -Infinity
  private cancelTimer: (() => void) | null = null
  private newestGeneration = -1
  private opSeq = 0
  private lastAckAt = -Infinity
  private lastAckBody: string | null = null
  private refreshWanted = false
  private refreshTimers: (() => void)[] = []
  /** the host's seq as last known (0: nothing uploaded yet) */
  hostSeq: number

  constructor(private deps: CustodyDeps, startSeq = 0) {
    this.hostSeq = startSeq
  }

  /** read through a method so a state changed across an await is re-read (not narrowed) */
  private closed(): boolean {
    return this.state === 'closed'
  }

  get latest(): Ack | null {
    return this.acks.at(-1) ?? null
  }

  /** for tests and display: whether an upload operation holds the line right now */
  get busy(): boolean {
    return this.op !== null
  }

  /** A capture from the frame. Older than one already offered or acknowledged: dropped (never uploaded over newer). */
  offer(c: Capture): void {
    if (this.closed()) return
    if (c.edit_generation < this.newestGeneration) return
    if (new TextEncoder().encode(c.body).length > MAX_PIECE_BYTES) {
      this.hold('The piece is larger than the hive takes for a live session (256 KB). Nothing was cut; the drawing waits until it is smaller.')
      return
    }
    // E7: a capture with the latest ACKNOWLEDGED generation is either the one wanted refresh (same bytes, after the timer
    // asked for a new stable observation: let through once, never with a raised generation) or nothing to send
    const last = this.latest
    if (last && c.edit_generation === last.edit_generation && !(this.pending && this.pending.edit_generation > c.edit_generation)) {
      if (this.lastAckBody !== null && c.body !== this.lastAckBody) { this.hold(SAME_GEN_HOLD); return }   // the host would 409 it: a bug guard
      if (!this.refreshWanted || this.op) return
      this.refreshWanted = false
      this.pending = c
      this.pump()
      return
    }
    if (c.edit_generation === this.newestGeneration && (this.pending?.body === c.body || this.op?.capture.body === c.body)) return
    this.newestGeneration = c.edit_generation
    this.pending = c
    if (this.state === 'held' && this.heldReason !== null && ([SIZE_HOLD, HASH_HOLD, SAME_GEN_HOLD].includes(this.heldReason) || this.heldReason.startsWith('The hive refused that piece upload'))) { this.state = 'idle'; this.heldReason = null }
    this.pump()
  }

  /**
   * r1.1 (stand-in P1-2, Design custody clarification): the FRESH acknowledged upload of THIS mount whose snapshot is
   * EXACTLY the observed one (same scene_ref: id, revision and native digest; same edit generation); else null. No
   * "generation ≥" path: a later generation can undo or replace what was observed, and the receiver exports no lineage.
   * Fresh = acknowledged within the 30 s window (an E7 refresh of unchanged art renews it with a new seq).
   */
  custodyFor(observed: SceneRef, generation: number): Ack | null {
    const now = this.deps.now()
    const exact = this.acks.filter((a) => a.mount === this.deps.mount && a.edit_generation === generation && sameRef(a.scene_ref, observed))
    const fresh = exact.filter((a) => now - a.at < STALE_MS)
    return fresh.at(-1) ?? null
  }

  /** An outcome is held for custody: the next stable observation is uploaded even if it repeats the acknowledged art
   *  (a refresh with the same bytes and generation, E7), so a fresh exact acknowledgement can exist. */
  wantRefresh(): void {
    if (!this.closed()) this.refreshWanted = true
  }

  /** Stop uploading for good (Stop, unmount, identity change). Acks stay readable for outstanding reports. */
  close(): void {
    this.state = 'closed'
    this.pending = null
    this.op = null
    for (const t of this.refreshTimers) t()
    this.refreshTimers = []
    this.cancelTimer?.()
    this.cancelTimer = null
    this.deps.changed?.()
  }

  private hold(reason: string) {
    if (this.closed()) return
    this.state = 'held'
    this.heldReason = reason
    this.deps.changed?.()
  }

  private pump(): void {
    if (this.closed() || this.op || !this.pending) return
    if (this.state === 'held') return
    const wait = this.lastSentAt + PIECE_INTERVAL_MS - this.deps.now()
    if (wait > 0) {
      if (!this.cancelTimer) {
        this.state = 'waiting'
        this.cancelTimer = this.deps.later(wait, () => { this.cancelTimer = null; this.pump() })
        this.deps.changed?.()
      }
      return
    }
    // reserve the operation NOW, before any await: nothing else can start until this one is released
    const op: UploadOp = { id: ++this.opSeq, seq: this.hostSeq + 1, capture: this.pending, sha: null }
    this.pending = null
    this.op = op
    this.lastSentAt = this.deps.now()
    this.state = 'uploading'
    this.deps.changed?.()
    void this.run(op)
  }

  private owns(op: UploadOp): boolean {
    return this.op === op && !this.closed()
  }
  private release(op: UploadOp) {
    if (this.op !== op) return
    this.op = null
    if (this.state === 'uploading' || this.state === 'reconciling') this.state = 'idle'
    this.deps.changed?.()
    this.pump()
  }

  private async run(op: UploadOp): Promise<void> {
    try {
      op.sha = await this.deps.sha256(op.capture.body)
    } catch {
      if (!this.owns(op)) return
      // keep the capture (unless a newer one already waits) and hold; the next capture or a retry tries again
      if (!this.pending) this.pending = op.capture
      this.op = null
      this.hold(HASH_HOLD)
      return
    }
    if (!this.owns(op)) return
    // superseded while hashing: a newer capture waits, so this older one is dropped unsent
    if (this.pending && this.pending.edit_generation > op.capture.edit_generation) { this.release(op); return }
    let ack: PieceAck | null
    try {
      ack = await this.deps.put(op.seq, op.capture)
    } catch (e) {
      if (!this.owns(op)) return
      if (e instanceof ApiError && (e.code === 'session_closed' || e.code === 'mount_not_current' || e.code === 'stale_mount' || e.code === 'mount_revoked')) { this.close(); return }
      // host R3: an older capture, the same generation with other bytes, a higher generation with the same bytes, or another
      // piece: a client bug or a stale frame; held, never retried as-is
      if (e instanceof ApiError && ['stale_generation', 'generation_reused', 'generation_without_change', 'scene_mismatch'].includes(e.code)) { this.op = null; this.hold(`The hive refused that piece upload (${e.code}). Nothing was cut; the drawing waits for a new capture.`); return }
      if (e instanceof ApiError && (e.status === 413 || e.code === 'too_large' || e.code === 'piece_too_large')) { this.op = null; this.hold('The hive refused the piece as too large. Nothing was cut; the drawing waits.'); return }
      // 409 stale_piece, a lost answer (network/5xx) or anything unknown: reconcile by exact seq + sha first
      await this.reconcile(op, e)
      return
    }
    if (!this.owns(op)) return
    // the host's answer must name exactly what we sent; anything else is reconciled, never assumed
    if (!ack || ack.seq !== op.seq || ack.raw !== op.sha) { await this.reconcile(op); return }
    this.acknowledge(op, ack.body_sha256)
    this.release(op)
  }

  /** E7: whether the acknowledged piece is still fresh (≤30 s since its last acknowledged upload or refresh). */
  freshness(): 'none' | 'fresh' | 'stale' {
    if (!this.latest) return 'none'
    return this.deps.now() - this.lastAckAt < STALE_MS ? 'fresh' : 'stale'
  }

  /** `hostSha`: the digest exactly as the host recorded it (the outcome binds the host's tuple byte for byte) */
  private acknowledge(op: UploadOp, hostSha: string) {
    this.lastAckAt = this.deps.now()
    this.lastAckBody = op.capture.body
    this.refreshWanted = false
    for (const t of this.refreshTimers) t()
    this.refreshTimers = [
      this.deps.later(REFRESH_MS, () => { if (this.closed()) return; this.refreshWanted = true; this.deps.requestCapture?.() }),
      this.deps.later(STALE_MS, () => this.deps.changed?.()),   // the display turns stale; nothing is extended
    ]
    this.hostSeq = op.seq
    this.acks.push({ seq: op.seq, body_sha256: hostSha, scene_ref: op.capture.scene_ref, edit_generation: op.capture.edit_generation, mount: this.deps.mount, at: this.lastAckAt })
    if (this.acks.length > MAX_ACKS) this.acks.shift()
  }

  /** Read the ledger: this operation's exact seq + sha there is its upload (acknowledged); otherwise retry later. */
  private async reconcile(op: UploadOp, e?: unknown): Promise<void> {
    this.state = 'reconciling'
    this.deps.changed?.()
    let view: PieceAck | null = null
    let read = true
    try {
      view = await this.deps.ledgerPiece()
    } catch {
      read = false
    }
    if (!this.owns(op)) return
    if (read && view && view.seq === op.seq && view.raw === op.sha) {
      this.acknowledge(op, view.body_sha256)
      this.release(op)
      return
    }
    if (read && view) this.hostSeq = Math.max(this.hostSeq, view.seq)
    else if (e instanceof ApiError && e.code === 'stale_piece') {
      const cur = (e.body as { error?: { seq?: unknown }; seq?: unknown } | undefined)?.error?.seq ?? (e.body as { seq?: unknown } | undefined)?.seq ?? e.envelope?.seq
      if (typeof cur === 'number' && Number.isSafeInteger(cur)) this.hostSeq = Math.max(this.hostSeq, cur)
    }
    // not known to have landed: the same capture goes again (unless a newer one already waits), on the host's seq
    if (!this.pending || this.pending.edit_generation < op.capture.edit_generation) this.pending = op.capture
    if (!read || (!view && !(e instanceof ApiError && e.code === 'stale_piece'))) {
      // the ledger could not be read: hold this operation until it can (never write blind over a possibly landed upload)
      this.hold('The hive did not confirm the last piece upload. The drawing waits until it does.')
      this.cancelTimer?.()
      this.cancelTimer = this.deps.later(PIECE_INTERVAL_MS * 2, () => {
        this.cancelTimer = null
        if (!this.owns(op)) return
        this.state = 'reconciling'
        this.heldReason = null
        void this.reconcile(op)
      })
      return
    }
    this.release(op)
  }
}
