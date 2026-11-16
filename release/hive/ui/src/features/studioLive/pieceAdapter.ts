/**
 * J3 r4.3 O3: the ONE place the current-piece wire shape lives (Kimi FIX-FIRST on the host plan, item 4: Platform will
 * revise the frame-pushed opaque `PUT …/piece` toward contract r4.1 §7's person-scoped `studio.session.current_piece`
 * lease). Everything else (custody, outcomes, UI, tests) speaks the lease's fields below; only this adapter knows the
 * plan's present body `{seq, body, scene_ref}` and its answer `{seq, body_sha256, at}`. When Platform pins the revised
 * shape, this file changes and nothing else does.
 *
 * Hash representations are kept apart and typed (Design native r2): `body_sha256` is the raw 64-hex SHA-256 of the
 * exact UTF-8 body bytes (host custody), while `scene_ref.digest` is the app-reported native scene digest, `sha256:`
 * prefixed. They are different claims; neither is derived from the other here. Platform pins the outer representation.
 */
import type { MountWire, PieceBody, PieceUploadView, SceneRef } from './api'

/** The lease's fields as the contract names them (draft identity, revision/digest, mount/person/goal binding, freshness). */
export interface CurrentPiece {
  /** draft identity: the piece's scene id (and, when known, its saved source reference) */
  scene_id: string
  /** the app-reported local revision and native digest (`sha256:` + 64 hex) */
  scene_ref: SceneRef
  /** the app's native edit generation captured with this piece (detects edit/Undo/Redo/ABA) */
  edit_generation: number
  /** unapplied field input exists (never applied or sent as source). Boolean only: a field VALUE change that leaves it
   *  true is still caught because the receiver compares the full canonical snapshot (Kimi r2.1 note on the coupling) */
  pending_fields: boolean
  /** Design's closed envelope, the exact UTF-8 JSON string (never parsed or re-serialised by the host page) */
  body: string
}
/** The host's acknowledgement of one upload, in the lease's terms. */
/** The host's acknowledgement in lease terms. `raw` is the 64-hex digest (compared with the local hash); `body_sha256`
 *  is kept EXACTLY as the host wrote it (host R3: `sha256:`-prefixed), because the outcome's `piece_upload` must equal the
 *  host's acknowledged tuple byte for byte. */
export interface PieceAck { seq: number; body_sha256: string; raw: string }

/** The plan r1.2 shape (E3/E7): the piece and its generation, plus the current mount's fields (from mount.ts only). The
 *  session and person come from the route and the bearer, never from the body. A refresh is the SAME bytes and the SAME
 *  generation under a new seq; nothing here raises a generation. */
export function toHostPiece(seq: number, piece: CurrentPiece, mount: MountWire): PieceBody {
  return { seq, body: piece.body, scene_ref: piece.scene_ref, edit_generation: piece.edit_generation, ...mount }
}
/** The host's answer, if it names a seq and a raw 64-hex body sha256; otherwise null (reconciled, never assumed). */
export function readPieceAck(v: unknown): PieceAck | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  if (!o || typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || typeof o.body_sha256 !== 'string') return null
  const sha = o.body_sha256.startsWith('sha256:') ? o.body_sha256.slice(7) : o.body_sha256
  return /^[a-f0-9]{64}$/.test(sha) ? { seq: o.seq, body_sha256: o.body_sha256, raw: sha } : null
}
/** The ledger's view of the latest upload, in the same terms (for reconciling a lost answer). */
export function ledgerPieceAck(v: PieceUploadView | null): PieceAck | null {
  return v ? readPieceAck(v) : null
}
