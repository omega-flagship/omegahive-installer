import { conflictRevision, DRAFT_KEY, DRAFT_MAX_BYTES, draftBytes, type AppDraftPut, type AppDraftSaved } from '../api/appDrafts'
import { ApiError, type HiveClient } from '../api/client'
import { MAX_BRIDGE_MESSAGE, rateLimit, type AssetReference } from './appBridge'
import { creationReference, type CreationReference } from './router'

/**
 * App frame bridge, candidate additions (Studio slice 2; PROGRAMS.md §9b): private drafts and picked-asset bytes.
 *
 * - Drafts: the frame names a draft key and a body; the HOST supplies the program (the frame's own app) and the swarm
 *   (the frame's route), and the hive supplies the person from the session. Nothing in the message can widen that
 *   scope: messages have exactly the keys listed, so a `program_id`, `swarm_id` or principal in one is refused.
 * - Asset bytes: only for a file the person picked in THIS frame session (the host records each `picked` asset as it
 *   answers), fetched through the host's authenticated download route, raster images only, at most 8 MB, and checked
 *   against the file's signature before the bytes cross into the frame (transferred, not copied).
 *
 * Pure apart from the client calls, so every shape and refusal is tested without a browser.
 */

export const MAX_DRAFT_MESSAGE = DRAFT_MAX_BYTES + 4096
export const MAX_ASSET_BYTES = 8 * 1024 * 1024
/** Raster types a frame may receive as bytes. SVG is excluded (see PROGRAMS.md §9b): it is active content. */
export const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AssetMime = (typeof ASSET_MIMES)[number]
const ID = /^[\w.:-]{1,80}$/
const HANDLE = /^[a-f0-9]{64}$/

export type StudioRequest =
  | { type: 'draft-save'; id: string; draft_key: string; expected_revision: number | null; body: Record<string, unknown>; source_ref: CreationReference | null }
  | { type: 'draft-list'; id: string }
  | { type: 'draft-load'; id: string; draft_key: string }
  | { type: 'draft-delete'; id: string; draft_key: string }
  | { type: 'asset-bytes'; id: string; handle: string }
export type StudioType = StudioRequest['type']
export type DraftOp = 'save' | 'list' | 'load' | 'delete'
export type DraftRefusal = 'conflict' | 'too-large' | 'unavailable' | 'invalid' | 'rate-limited' | 'not-found' | 'not-set-up' | 'not-opened' | 'busy'
export type AssetRefusal = 'not-picked' | 'unsupported-type' | 'too-large' | 'mismatch' | 'busy' | 'unavailable' | 'invalid' | 'rate-limited'
export type StudioParse = { ok: true; msg: StudioRequest } | { ok: false; type: StudioType; id: string | null; reason: 'invalid' | 'too-large' } | null

const TYPES: StudioType[] = ['draft-save', 'draft-list', 'draft-load', 'draft-delete', 'asset-bytes']
const KEYS: Record<StudioType, string[]> = {
  'draft-save': ['type', 'channel', 'id', 'draft_key', 'expected_revision', 'body', 'source_ref'],
  'draft-list': ['type', 'channel', 'id'],
  'draft-load': ['type', 'channel', 'id', 'draft_key'],
  'draft-delete': ['type', 'channel', 'id', 'draft_key'],
  'asset-bytes': ['type', 'channel', 'id', 'handle'],
}
/** Per frame, per 10 s: autosave every ~2 s fits easily; a frame looping on any of these is cut off. */
export const STUDIO_LIMITS: Record<StudioType, [number, number]> = {
  'draft-save': [20, 10_000],
  'draft-list': [10, 10_000],
  'draft-load': [20, 10_000],
  'draft-delete': [10, 10_000],
  'asset-bytes': [30, 10_000],
}
export const MAX_ASSET_INFLIGHT = 3

const serialised = (data: unknown) => {
  try {
    return JSON.stringify(data)?.length ?? Infinity
  } catch {
    return Infinity
  }
}

/** JSON data only (what the hive will store): plain objects, arrays, strings, finite numbers, booleans, null. */
export function jsonData(v: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((x) => jsonData(x, depth + 1))
  if (typeof v === 'object') return Object.getPrototypeOf(v) === Object.prototype && Object.values(v as object).every((x) => jsonData(x, depth + 1))
  return false
}

/** Validate a slice-2 message from a frame (already checked to be the frame, on its channel). null: not one of ours. */
export function parseStudioMessage(data: unknown): StudioParse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  const type = m.type as StudioType
  if (!TYPES.includes(type)) return null
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null
  const refuse = (reason: 'invalid' | 'too-large') => ({ ok: false as const, type, id, reason })
  if (serialised(data) > (type === 'draft-save' ? MAX_DRAFT_MESSAGE : MAX_BRIDGE_MESSAGE)) return refuse('too-large')
  if (!id || !Object.keys(m).every((k) => KEYS[type].includes(k))) return refuse('invalid')
  if (type === 'draft-list') return { ok: true, msg: { type, id } }
  if (type === 'asset-bytes') return typeof m.handle === 'string' && HANDLE.test(m.handle) ? { ok: true, msg: { type, id, handle: m.handle } } : refuse('invalid')
  if (typeof m.draft_key !== 'string' || !DRAFT_KEY.test(m.draft_key)) return refuse('invalid')
  const draft_key = m.draft_key
  if (type === 'draft-load' || type === 'draft-delete') return { ok: true, msg: { type, id, draft_key } }
  // draft-save
  const exp = m.expected_revision
  if (!('expected_revision' in m) || (exp !== null && !(typeof exp === 'number' && Number.isSafeInteger(exp) && exp >= 1))) return refuse('invalid')
  const body = m.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || !jsonData(body)) return refuse('invalid')
  if (draftBytes(body) > DRAFT_MAX_BYTES) return refuse('too-large')
  let source_ref: CreationReference | null = null
  if (m.source_ref !== undefined) {
    source_ref = creationReference(m.source_ref) ?? null
    if (!source_ref) return refuse('invalid')
  }
  return { ok: true, msg: { type, id, draft_key, expected_revision: exp as number | null, body: body as Record<string, unknown>, source_ref } }
}

// ---- per-frame picked assets ------------------------------------------------------------------------------------

/** The files the person picked in one frame session. A new frame (or a reload of this one) starts empty. */
export class FrameAssetGrants {
  private picked = new Map<string, { mime: string; size: number }>()
  inflight = 0
  /** Draft keys with a save or delete still unresolved in THIS frame: a second write to the same key is refused
   *  `busy` (never queued, never re-based onto a newer revision); other keys stay usable (Review F1). */
  readonly writing = new Set<string>()
  constructor(private max = 256) {}
  /** Record a file the host just handed this frame in a `picked` reply. */
  grant(ref: AssetReference) {
    if (!HANDLE.test(ref.handle)) return
    this.picked.delete(ref.handle)
    this.picked.set(ref.handle, { mime: String(ref.mime).toLowerCase(), size: ref.size })
    if (this.picked.size > this.max) this.picked.delete(this.picked.keys().next().value as string)
  }
  get(handle: string) {
    return this.picked.get(handle) ?? null
  }
  clear() {
    this.picked.clear()
  }
}

/** The image type the bytes actually are, from their signature, or null. */
export function sniffImage(b: Uint8Array): AssetMime | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

// ---- replies ----------------------------------------------------------------------------------------------------

export type StudioReply =
  | ({ type: 'draft-saved'; id: string } & AppDraftSaved)
  | { type: 'drafts'; id: string; drafts: AppDraftSaved[] }
  | ({ type: 'draft'; id: string } & AppDraftSaved & { body: Record<string, unknown>; source_ref: CreationReference | null })
  | { type: 'draft-deleted'; id: string; draft_key: string }
  | { type: 'draft-refused'; id: string; op: DraftOp; reason: DraftRefusal; current_revision?: number | null }
  | { type: 'asset'; id: string; handle: string; mime: AssetMime; size: number; bytes: ArrayBuffer }
  | { type: 'asset-refused'; id: string; handle?: string; reason: AssetRefusal }

const OP: Record<Exclude<StudioType, 'asset-bytes'>, DraftOp> = { 'draft-save': 'save', 'draft-list': 'list', 'draft-load': 'load', 'draft-delete': 'delete' }
export const draftRefused = (id: string, op: DraftOp, reason: DraftRefusal, current?: number | null): StudioReply =>
  current === undefined ? { type: 'draft-refused', id, op, reason } : { type: 'draft-refused', id, op, reason, current_revision: current }
export const assetRefused = (id: string, reason: AssetRefusal, handle?: string): StudioReply =>
  handle ? { type: 'asset-refused', id, handle, reason } : { type: 'asset-refused', id, reason }

/** The refusal for a message that failed validation (an id is needed to answer at all). */
export function invalidReply(p: { type: StudioType; id: string | null; reason: 'invalid' | 'too-large' }): StudioReply | null {
  if (!p.id) return null
  return p.type === 'asset-bytes' ? assetRefused(p.id, p.reason) : draftRefused(p.id, OP[p.type], p.reason)
}
export function rateLimitedReply(msg: StudioRequest): StudioReply {
  return msg.type === 'asset-bytes' ? assetRefused(msg.id, 'rate-limited', msg.handle) : draftRefused(msg.id, OP[msg.type], 'rate-limited')
}

const savedAt = (v: unknown) => (typeof v === 'string' && v.length <= 64 ? v : null)
const revisionOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null)
function summary(r: unknown): AppDraftSaved | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const draft_key = typeof o.draft_key === 'string' && DRAFT_KEY.test(o.draft_key) ? o.draft_key : null
  const revision = revisionOf(o.revision)
  const saved_at = savedAt(o.saved_at)
  return draft_key && revision && saved_at ? { draft_key, revision, saved_at } : null
}

/** How a hive refusal reads to the frame. The frame never sees hive error text. */
export function draftError(e: unknown, op: DraftOp): { reason: DraftRefusal; current?: number | null } {
  const current = conflictRevision(e)
  if (current !== undefined) return { reason: 'conflict', current }
  if (e instanceof ApiError) {
    if (e.status === 413 || e.code === 'draft_too_large') return { reason: 'too-large' }
    if (e.status === 400 || e.status === 422) return { reason: 'invalid' }
    // the app is not set up in this swarm (it is not one of the app's homes): drafts live only where the app works
    if (e.code === 'app_not_here') return { reason: 'not-set-up' }
    // the person has not opened this app here in the last day, or the app's view refused them: open the app here first
    if (e.code === 'app_not_opened') return { reason: 'not-opened' }
    if (e.status === 404 && (op === 'load' || op === 'delete')) return { reason: 'not-found' }
  }
  return { reason: 'unavailable' }
}

export type StudioClient = Pick<HiveClient, 'putAppDraft' | 'listAppDrafts' | 'getAppDraft' | 'deleteAppDraft' | 'assetBlob'>
export interface StudioEnv {
  client: StudioClient
  /** The frame's own app and swarm, fixed by the host (never read from the message). */
  programId: string
  swarmId: string
  /** False unless this person may save drafts here (the context's `capabilities.draftSave`). */
  draftSave: boolean
  grants: FrameAssetGrants
}

/** Answer one validated slice-2 request. The reply (and any ArrayBuffer to transfer) goes back to the asking frame. */
export async function studioReply(msg: StudioRequest, env: StudioEnv): Promise<{ reply: StudioReply; transfer?: Transferable[] }> {
  if (msg.type === 'asset-bytes') return assetBytes(msg, env)
  const op = OP[msg.type]
  const c = env.client
  const { programId, swarmId } = env
  if (!env.draftSave || !c.putAppDraft || !c.listAppDrafts || !c.getAppDraft || !c.deleteAppDraft) return { reply: draftRefused(msg.id, op, 'unavailable') }
  const writes = msg.type === 'draft-save' || msg.type === 'draft-delete'
  if (writes && env.grants.writing.has(msg.draft_key)) return { reply: draftRefused(msg.id, op, 'busy') }
  if (writes) env.grants.writing.add(msg.draft_key)
  try {
    if (msg.type === 'draft-save') {
      const body: AppDraftPut = { swarm_id: swarmId, expected_revision: msg.expected_revision, body: msg.body, ...(msg.source_ref ? { source_ref: msg.source_ref } : {}) }
      const r = summary(await c.putAppDraft(programId, msg.draft_key, body))
      if (!r || r.draft_key !== msg.draft_key) return { reply: draftRefused(msg.id, op, 'unavailable') }
      return { reply: { type: 'draft-saved', id: msg.id, ...r } }
    }
    if (msg.type === 'draft-list') {
      const r = await c.listAppDrafts(programId, swarmId)
      const rows = Array.isArray(r?.drafts) ? r.drafts.map(summary).filter((x): x is AppDraftSaved => !!x).slice(0, 500) : []
      return { reply: { type: 'drafts', id: msg.id, drafts: rows } }
    }
    if (msg.type === 'draft-load') {
      const r = await c.getAppDraft(programId, msg.draft_key, swarmId)
      const s = summary(r)
      const body = r?.body
      if (!s || s.draft_key !== msg.draft_key || !body || typeof body !== 'object' || Array.isArray(body) || !jsonData(body)) return { reply: draftRefused(msg.id, op, 'unavailable') }
      const source_ref = r.source_ref == null ? null : (creationReference(r.source_ref) ?? null)
      return { reply: { type: 'draft', id: msg.id, ...s, body, source_ref } }
    }
    await c.deleteAppDraft(programId, msg.draft_key, swarmId)
    return { reply: { type: 'draft-deleted', id: msg.id, draft_key: msg.draft_key } }
  } catch (e) {
    const { reason, current } = draftError(e, op)
    return { reply: draftRefused(msg.id, op, reason, current) }
  } finally {
    if (writes) env.grants.writing.delete(msg.draft_key)
  }
}

async function assetBytes(msg: Extract<StudioRequest, { type: 'asset-bytes' }>, env: StudioEnv): Promise<{ reply: StudioReply; transfer?: Transferable[] }> {
  const { id, handle } = msg
  const picked = env.grants.get(handle)
  if (!picked) return { reply: assetRefused(id, 'not-picked', handle) }
  const mime = picked.mime as AssetMime
  if (!ASSET_MIMES.includes(mime)) return { reply: assetRefused(id, 'unsupported-type', handle) }
  if (!(picked.size <= MAX_ASSET_BYTES)) return { reply: assetRefused(id, 'too-large', handle) }
  if (!env.client.assetBlob) return { reply: assetRefused(id, 'unavailable', handle) }
  if (env.grants.inflight >= MAX_ASSET_INFLIGHT) return { reply: assetRefused(id, 'busy', handle) }
  env.grants.inflight++
  try {
    const blob = await env.client.assetBlob(handle)
    if (blob.size > MAX_ASSET_BYTES) return { reply: assetRefused(id, 'too-large', handle) }
    const bytes = await blob.arrayBuffer()
    if (bytes.byteLength > MAX_ASSET_BYTES) return { reply: assetRefused(id, 'too-large', handle) }
    if (sniffImage(new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength))) !== mime) return { reply: assetRefused(id, 'mismatch', handle) }
    return { reply: { type: 'asset', id, handle, mime, size: bytes.byteLength, bytes }, transfer: [bytes] }
  } catch {
    return { reply: assetRefused(id, 'unavailable', handle) }
  } finally {
    env.grants.inflight--
  }
}

/** The host's slice-2 dispatcher for ONE frame document: parse, rate-limit, answer. AppFrame calls it for every
 *  message event, so the per-key write guard holds across separate events, not only within one call. Returns the reply
 *  to post (and any buffers to transfer), or null when the message is not a slice-2 request. */
export function studioDispatcher(env: Omit<StudioEnv, 'draftSave'> & { draftSave: () => boolean }) {
  const limits = Object.fromEntries(Object.entries(STUDIO_LIMITS).map(([k, [n, ms]]) => [k, rateLimit(n, ms)])) as Record<StudioType, (key: string) => boolean>
  return async (data: unknown): Promise<{ reply: StudioReply | object; transfer?: Transferable[] } | null | undefined> => {
    const studio = parseStudioMessage(data)
    if (!studio) return null
    if (!studio.ok) {
      const refused = invalidReply(studio)
      return refused ? { reply: refused } : undefined
    }
    const msg = studio.msg
    if (!limits[msg.type](msg.type)) return { reply: rateLimitedReply(msg) }
    return studioReply(msg, { ...env, draftSave: env.draftSave() })
  }
}
