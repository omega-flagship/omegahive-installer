/**
 * J3 r4.3 O3: the frame messages between the host page and Studio's own receiver (Design's live-edits, artifact-live,
 * proposal-subscription and live-controls, inside the app frame). PROPOSED by Surface; Design names the in-app side.
 * They ride the existing app-frame bridge (lib/appFrame.ts isFrameSender + the document's channel): no network, no token.
 *
 * Host → frame
 *   studio-live-open    {session}            receiving may run for THIS admitted session and mount (receiver_generation)
 *   studio-live-close   {session_id, reason} close/pause local receiving NOW (stop | identity | unmount | pause); the
 *                                            frame keeps the piece, history, Undo and receipt cursor
 *   studio-live-capture {session_id}         please capture the applied piece again (custody is missing or stale)
 *   studio.recover      {session_id, receiver_generation, startRevision, upload}   (frozen with Design, 0355Z) ONCE, only to
 *                                            a NEW mount reopening a progressed session in HELD recovery, after its first
 *                                            acknowledged capture: start a fresh receiver at proposal revision k (the last
 *                                            the ledger had admitted), from that acknowledged upload; k and the upload come
 *                                            from ONE ledger read. Never to a receiver that applied anything, after Stop or
 *                                            a host pause, or for a superseded mount. Fresh ownership is not restoration of
 *                                            earlier element ownership or reservations.
 *   studio-live-step    {session_id, n, proposal, piece_read}   the host's record of step n: its exact proposal ref and the
 *                                            acknowledged piece tuple the maker read (observedBase for receive); a step
 *                                            with no piece_read is never sent, so the receiver holds
 * Frame → host
 *   studio-live-piece   {session_id, receiver_generation, body, scene_ref, edit_generation, pending_fields}
 *                       body: Design's current-piece envelope as the exact UTF-8 JSON string (never parsed here)
 *   studio-live-outcome {session_id, receiver_generation, proposal, outcome, reason?, piece_before, piece_after,
 *                        receipt_digest, observed_generation, op_ids?}   sent only after the canvas CAS and readback;
 *                       op_ids (r1.5, host R4 L6): the op ids the receiver validated in that exact proposal, from its own
 *                       receipt: Design's `op_ids: clone(receipt.operation_ids)` (Design 112400Z). Forwarded unchanged and
 *                       never normalised; a list the host's L6 shape would refuse is HELD by the reporter (not confirmed).
 *
 * Messages have exactly these keys; anything else is not ours (null) or refused (invalid). The host decides the session,
 * person and mount: a message naming another session or receiver generation is dropped.
 */
import { readProposalRef, readSceneRef, type FrameOutcomeKind, type SceneRef } from './api'
import { MAX_PIECE_BYTES, type Capture } from './custody'
import type { FrameReport } from './outcomes'

export const WIRE = {
  open: 'studio-live-open',
  close: 'studio-live-close',
  capture: 'studio-live-capture',
  step: 'studio-live-step',
  recover: 'studio.recover',
  piece: 'studio-live-piece',
  outcome: 'studio-live-outcome',
} as const
export type CloseReason = 'stop' | 'identity' | 'unmount' | 'pause' | 'replaced'

export interface OpenSession {
  session_id: string
  /** the host-admitted P2a stream identity, exactly as the host returned it (never derived or chosen here) */
  stream_id: string
  proposal_artifact_id: string
  goal_id: string
  /** the admitted scene; a session without one is held before opening (never whatever canvas is open) */
  scene_id: string
  /** the host page's mount generation for this frame document; the frame echoes it on everything it sends */
  receiver_generation: number
}
export const openMessage = (session: OpenSession) => ({ type: WIRE.open, session })
export const closeMessage = (session_id: string, reason: CloseReason) => ({ type: WIRE.close, session_id, reason })
export const captureMessage = (session_id: string) => ({ type: WIRE.capture, session_id })
/**
 * r1.14d (walk 2, Design 202940Z): the host records an upload's body hash as `sha256:<hex>` (studio_steps upload); the
 * Studio frame (0.4.20/0.4.21 native-frame `upload()`) takes ONLY the bare 64-hex it computes for its own captures, and
 * silently drops a step or recover whose tuple has the prefix. At this one UI→frame boundary the body hash is sent bare;
 * the host's own form stays unchanged everywhere the client keeps or compares host tuples (ledger, custody, outcomes).
 * Only body_sha256 changes: seq, scene_ref (and its digest) and edit_generation pass exactly; anything not a sha256
 * hex is passed as it is, so the frame's own check still refuses it.
 */
export const frameBodySha = (sha: string): string => (/^sha256:[a-f0-9]{64}$/.test(sha) ? sha.slice('sha256:'.length) : sha)
export const frameUpload = (u: import('./api').UploadBinding): import('./api').UploadBinding => ({ ...u, body_sha256: frameBodySha(u.body_sha256) })
export const recoverMessage = (session_id: string, receiver_generation: number, startRevision: number, upload: import('./api').UploadBinding) => ({ type: WIRE.recover, session_id, receiver_generation, startRevision, upload: frameUpload(upload) })
export const stepMessage = (session_id: string, n: number, proposal: { artifact_id: string; revision: number; digest: string }, piece_read: import('./api').UploadBinding) => ({ type: WIRE.step, session_id, n, proposal, piece_read: frameUpload(piece_read) })

const FRAME_OUTCOMES: readonly FrameOutcomeKind[] = ['applied', 'refused', 'accepted-no-source-change', 'invalid']
const PIECE_KEYS = ['type', 'channel', 'session_id', 'receiver_generation', 'body', 'scene_ref', 'edit_generation', 'pending_fields']
const OUTCOME_KEYS = ['type', 'channel', 'session_id', 'receiver_generation', 'proposal', 'outcome', 'reason', 'piece_before', 'piece_after', 'receipt_digest', 'observed_generation', 'op_ids']
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export type FrameLive =
  | { kind: 'piece'; session_id: string; receiver_generation: number; capture: Capture }
  | { kind: 'outcome'; session_id: string; receiver_generation: number; report: FrameReport }
  | { kind: 'invalid'; type: string }

/** A studio-live message from the frame, checked; null when it is not one of these types. */
export function parseFrameLive(data: unknown): FrameLive | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  if (m.type !== WIRE.piece && m.type !== WIRE.outcome) return null
  const bad = { kind: 'invalid' as const, type: m.type }
  const keys = m.type === WIRE.piece ? PIECE_KEYS : OUTCOME_KEYS
  if (!Object.keys(m).every((k) => keys.includes(k))) return bad
  if (typeof m.session_id !== 'string' || !/^[\w.:-]{1,80}$/.test(m.session_id) || !nat(m.receiver_generation)) return bad
  if (m.type === WIRE.piece) {
    const scene_ref = readSceneRef(m.scene_ref)
    if (typeof m.body !== 'string' || m.body.length > MAX_PIECE_BYTES || !scene_ref || !nat(m.edit_generation) || typeof m.pending_fields !== 'boolean') return bad
    return { kind: 'piece', session_id: m.session_id, receiver_generation: m.receiver_generation, capture: { body: m.body, scene_ref, edit_generation: m.edit_generation, pending_fields: m.pending_fields } }
  }
  const proposal = readProposalRef(m.proposal)
  const before = readSceneRef(m.piece_before)
  const after = readSceneRef(m.piece_after)
  const outcome = typeof m.outcome === 'string' && (FRAME_OUTCOMES as readonly string[]).includes(m.outcome) ? (m.outcome as FrameOutcomeKind) : null
  if (!proposal || !before || !after || !outcome || typeof m.receipt_digest !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/.test(m.receipt_digest) || !nat(m.observed_generation)) return bad
  if (m.reason !== undefined && (typeof m.reason !== 'string' || m.reason.length > 200)) return bad
  if (before.scene_id !== after.scene_id) return bad
  // op_ids: carried exactly as the receiver gave them (a bounded list of strings). Whether the host's L6 shape accepts
  // them is the reporter's check, so a bad list HOLDS that step as not confirmed instead of vanishing as noise.
  if (m.op_ids !== undefined && !(Array.isArray(m.op_ids) && m.op_ids.length <= 64 && m.op_ids.every((x) => typeof x === 'string' && x.length <= 200))) return bad
  const op_ids = m.op_ids as string[] | undefined
  const report: FrameReport = {
    proposal, outcome, piece_before: before as SceneRef, piece_after: after as SceneRef,
    receiver_generation: m.receiver_generation, receipt_digest: m.receipt_digest, observed_generation: m.observed_generation,
    ...(typeof m.reason === 'string' ? { reason: m.reason } : {}),
    ...(op_ids ? { op_ids: [...op_ids] } : {}),
  }
  return { kind: 'outcome', session_id: m.session_id, receiver_generation: m.receiver_generation, report }
}
