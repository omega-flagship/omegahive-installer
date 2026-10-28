import { ApiError } from '../api/client'
import type { ActionResult, ProgramAction, ProgramDescription } from '../api/types'
import { cancelledReply, MAX_BRIDGE_MESSAGE } from './appBridge'
import type { EpochBinding } from './identityEpoch'
import { jsonData, parseStudioMessage, rateLimitedReply, draftRefused, assetRefused } from './studioBridge'

/**
 * App frame bridge, candidate additions (frame ops, PROGRAMS.md §9c): the frame-host side of the Atlas survey gaps.
 *
 * - G1 `read`: a declared, non-WorkGraph read of the frame's own app, for THIS swarm, as the person (POST …/read).
 * - G2 `act` with a file: the person's own file bytes go to the frame's own app for one action, never stored.
 * - G3 `show-file`: the host shows a PDF or plain text in its own viewer; nothing goes back to the frame.
 * - G4 `open-url`: an https link, opened only by the person's own click in a host prompt that shows where it goes.
 * - G7 `back-request` / `escape`: the frame asks the host to go back, exactly as the host's own Back/Escape.
 * - G8 `layout`: the frame asks to fill the stage (full) or sit framed; the host decides.
 *   P8 alone also accepts light/dark as the host memory colour-mode signal; it does not theme the rest of the host.
 * - G9 goal notices: status of goals THIS frame's own act started, from events the page already receives.
 * - A per-frame token bucket over every message.
 *
 * Every wire name and shape is in `FRAME_WIRE` and the parse/reply functions below, so Platform's final shapes are a
 * one-file change. Pure apart from the client calls; tested without a browser (frameOps.test.ts).
 */

// ---- the wire, in one place ----------------------------------------------------------------------------------------

export { FRAME_WIRE } from './frameWire'
import { FRAME_WIRE } from './frameWire'

const ID = /^[\w.:-]{1,80}$/
/** A read query id (server: `[\w.-]{1,64}`, declared in describe().reads). */
export const READ_QUERY = /^[\w.-]{1,64}$/
/** Largest read `params` (serialised): Platform's server cap, checked on the host before sending. */
export const MAX_READ_PARAMS = 1024 * 1024
/** Largest read message from a frame, serialised: the params plus room for the envelope. */
export const MAX_READ_MESSAGE = MAX_READ_PARAMS + 4096
/** The server's cap on a read result (serialised JSON); the host re-checks before forwarding. */
export const MAX_READ_RESULT = 4 * 1024 * 1024
export const MAX_READ_INFLIGHT = 4
export const MAX_URL = 2048
export const MAX_SHOW_BYTES = 20 * 1024 * 1024
/** G2: the host's own ceiling for a file sent with an action (the action's `accepts_file.max_bytes` is at most this). */
export const MAX_ACT_FILE = 20 * 1024 * 1024
export const SHOW_MIMES = ['application/pdf', 'text/plain'] as const
export type ShowMime = (typeof SHOW_MIMES)[number]
/** Per frame, per 10 s, for the ops with their own limits (on top of the token bucket). */
export const FRAME_OP_LIMITS = { read: [30, 10_000], 'open-url': [5, 10_000], 'show-file': [10, 10_000], back: [4, 2_000], layout: [10, 10_000], goal: [30, 10_000] } as const

const serialised = (data: unknown) => {
  try {
    return JSON.stringify(data)?.length ?? Infinity
  } catch {
    return Infinity
  }
}
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k))
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === '[object ArrayBuffer]'
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

// ---- a per-frame token bucket over every message --------------------------------------------------------------------

/** A token bucket: `take()` is true when a token was available (and spent). Refills continuously. */
export function tokenBucket(capacity: number, perSecond: number, now: () => number = () => performance.now()) {
  let tokens = capacity
  let at = now()
  return {
    take(): boolean {
      const t = now()
      tokens = Math.min(capacity, tokens + ((t - at) / 1000) * perSecond)
      at = t
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
    get level() {
      return tokens
    },
  }
}
/** Every message from a frame spends one token: a burst of 60, then 20 a second. */
export const FRAME_BUCKET: [number, number] = [60, 20]

// ---- frame → host messages -------------------------------------------------------------------------------------------

export type FrameOp =
  | { type: 'read'; id: string; query: string; params: Record<string, unknown> | null }
  | { type: 'open-url'; id: string; url: string }
  | { type: 'show-file'; id: string; name: string; mime: ShowMime; bytes: ArrayBuffer }
  | { type: 'back-request' }
  | { type: 'escape' }
  | { type: 'layout'; mode: 'full' | 'framed' | 'light' | 'dark' }
  | { type: 'subscribe' | 'unsubscribe'; goal_id: string }
export type FrameOpType = FrameOp['type']
export type ReadRefusal = 'not-declared' | 'refused' | 'too-large' | 'bad-request' | 'unavailable' | 'not-set-up' | 'not-opened' | 'rate-limited' | 'busy' | 'invalid'
export type UrlRefusal = 'not-https' | 'invalid' | 'busy' | 'rate-limited' | 'declined'
export type FileRefusal = 'unsupported-type' | 'too-large' | 'mismatch' | 'busy' | 'rate-limited' | 'invalid'
export type GoalRefusal = 'not-started-here' | 'invalid' | 'rate-limited'
export type FrameOpParse = { ok: true; msg: FrameOp } | { ok: false; type: FrameOpType; id: string | null; goal_id?: string; reason: string } | null

const OP_TYPES: FrameOpType[] = ['read', 'open-url', 'show-file', 'back-request', 'escape', 'layout', 'subscribe', 'unsubscribe']
const OP_KEYS: Record<FrameOpType, string[]> = {
  read: ['type', 'channel', 'id', 'query', 'params'],
  'open-url': ['type', 'channel', 'id', 'url'],
  'show-file': ['type', 'channel', 'id', 'name', 'mime', 'bytes'],
  'back-request': ['type', 'channel'],
  escape: ['type', 'channel'],
  layout: ['type', 'channel', 'mode'],
  subscribe: ['type', 'channel', 'goal_id'],
  unsubscribe: ['type', 'channel', 'goal_id'],
}

/** Validate a frame-op message (already checked to be the frame, on its channel). null: not one of these. */
export function parseFrameOp(data: unknown): FrameOpParse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  const type = m.type as FrameOpType
  if (!OP_TYPES.includes(type)) return null
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null
  const refuse = (reason: string) => ({ ok: false as const, type, id, reason })
  // the bytes of show-file are a transferred ArrayBuffer (serialised as {} here); everything else is small JSON
  if (serialised(data) > (type === 'read' ? MAX_READ_MESSAGE : MAX_BRIDGE_MESSAGE)) return refuse('too-large')
  // a frame never names a program, a swarm or a person: exact keys only
  if (!onlyKeys(m, OP_KEYS[type])) return refuse('invalid')
  if (type === 'back-request' || type === 'escape') return { ok: true, msg: { type } }
  if (type === 'layout') return m.mode === 'full' || m.mode === 'framed' || m.mode === 'light' || m.mode === 'dark' ? { ok: true, msg: { type, mode: m.mode } } : refuse('invalid')
  if (type === 'subscribe' || type === 'unsubscribe') {
    const g = typeof m.goal_id === 'string' && ID.test(m.goal_id) ? m.goal_id : null
    return g ? { ok: true, msg: { type, goal_id: g } } : refuse('invalid')
  }
  if (!id) return refuse('invalid')
  if (type === 'read') {
    if (typeof m.query !== 'string' || !READ_QUERY.test(m.query)) return refuse('invalid')
    if (m.params !== undefined && !(plainObject(m.params) && jsonData(m.params))) return refuse('bad-request')
    if (m.params !== undefined && serialised(m.params) > MAX_READ_PARAMS) return refuse('too-large')
    return { ok: true, msg: { type, id, query: m.query, params: (m.params as Record<string, unknown> | undefined) ?? null } }
  }
  if (type === 'open-url') return typeof m.url === 'string' ? { ok: true, msg: { type, id, url: m.url } } : refuse('invalid')
  // show-file
  if (typeof m.name !== 'string' || typeof m.mime !== 'string' || !isArrayBuffer(m.bytes)) return refuse('invalid')
  const mime = m.mime.toLowerCase() as ShowMime
  if (!SHOW_MIMES.includes(mime)) return refuse('unsupported-type')
  if (m.bytes.byteLength > MAX_SHOW_BYTES) return refuse('too-large')
  return { ok: true, msg: { type, id, name: cleanName(m.name) || 'file', mime, bytes: m.bytes } }
}

/** A file name as untrusted display text: no control characters, at most 255 characters. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 255)
}

// ---- G1 read ---------------------------------------------------------------------------------------------------------

export type ReadReply =
  | { type: 'read-result'; id: string; query: string; result: unknown }
  | { type: 'read-refused'; id: string; query?: string; reason: ReadRefusal }
export const readRefused = (id: string, reason: ReadRefusal, query?: string): ReadReply =>
  query ? { type: 'read-refused', id, query, reason } : { type: 'read-refused', id, reason }

/** The reads an app declares (describe().reads), or null when the host's describe does not carry them. */
export function declaredReads(d: ProgramDescription | null | undefined): Set<string> | null {
  const reads = (d as { reads?: unknown } | null | undefined)?.reads
  if (!Array.isArray(reads)) return null
  return new Set(reads.map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : null)).filter((x): x is string => typeof x === 'string' && READ_QUERY.test(x)))
}

/** How a hive refusal of a read reads to the frame (Platform's mapping). Hive error text is never forwarded. */
export function readError(e: unknown): ReadRefusal {
  if (!(e instanceof ApiError)) return 'unavailable'
  if (e.code === 'unknown_read') return 'not-declared'
  if (e.code === 'read_too_large' || e.status === 413) return 'too-large'
  if (e.code === 'app_not_here') return 'not-set-up'
  if (e.code === 'app_not_opened') return 'not-opened'
  if (e.code === 'program_refused') return 'refused'
  if (e.code === 'bad_request' || e.status === 400 || e.status === 422) return 'bad-request'
  if (e.status === 429) return 'rate-limited'
  // bad_result (500: read() did not return a JSON object), app_integrity (403), program_disabled (409), no route, network, anything else
  return 'unavailable'
}

export interface ReadEnv {
  read?: (programId: string, swarmId: string, query: string, params: Record<string, unknown> | null) => Promise<{ result?: unknown } & Record<string, unknown>>
  programId: string
  swarmId: string
  /** describe().reads as the host sees it; null when unknown (then the hive alone decides). */
  declared: Set<string> | null
  inflight: { n: number }
}

/** Answer one validated read. The host supplies the app and swarm; only `result` crosses into the frame. */
export async function readReply(msg: Extract<FrameOp, { type: 'read' }>, env: ReadEnv): Promise<ReadReply> {
  const { id, query } = msg
  if (!env.read) return readRefused(id, 'unavailable', query)
  if (env.declared && !env.declared.has(query)) return readRefused(id, 'not-declared', query)
  if (env.inflight.n >= MAX_READ_INFLIGHT) return readRefused(id, 'busy', query)
  env.inflight.n++
  try {
    const r = await env.read(env.programId, env.swarmId, query, msg.params)
    const result = r && typeof r === 'object' ? r.result : undefined
    // next9: read() returns a JSON object; the host forwards nothing else
    if (!plainObject(result) || !jsonData(result)) return readRefused(id, 'unavailable', query)
    if (serialised(result) > MAX_READ_RESULT) return readRefused(id, 'too-large', query)
    return { type: 'read-result', id, query, result }
  } catch (e) {
    return readRefused(id, readError(e), query)
  } finally {
    env.inflight.n--
  }
}

// ---- G4 open-url -----------------------------------------------------------------------------------------------------

export type UrlReply = { type: 'url-opened'; id: string } | { type: 'url-refused'; id: string; reason: UrlRefusal }
export const urlRefused = (id: string, reason: UrlRefusal): UrlReply => ({ type: 'url-refused', id, reason })

/** An https URL with no credentials, at most 2048 characters, as the parsed href; or why not. */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: 'not-https' | 'invalid' } {
  if (raw.length > MAX_URL) return { ok: false, reason: 'invalid' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not-https' }
  if (u.username || u.password || !u.hostname) return { ok: false, reason: 'invalid' }
  return { ok: true, url: u }
}

/** What the prompt shows: the full origin (punycode as the URL parser gives it) and the rest, ellipsized in the middle. */
export function urlParts(u: URL, max = 64): { origin: string; rest: string } {
  const rest = `${u.pathname}${u.search}${u.hash}`
  return { origin: u.origin, rest: rest.length <= max ? rest : `${rest.slice(0, Math.ceil(max / 2) - 1)}…${rest.slice(rest.length - Math.floor(max / 2))}` }
}

// ---- G3 show-file ----------------------------------------------------------------------------------------------------

export type FileReply = { type: 'file-shown'; id: string } | { type: 'file-closed'; id: string } | { type: 'file-refused'; id: string; reason: FileRefusal }
export const fileRefused = (id: string, reason: FileRefusal): FileReply => ({ type: 'file-refused', id, reason })
/** Longest text the viewer renders (characters); the rest is noted, not shown. */
export const MAX_TEXT_SHOWN = 1_000_000

/** What the viewer shows, from the bytes: a PDF (signature checked) or decoded text; or why not. */
export function viewable(mime: ShowMime, bytes: ArrayBuffer): { ok: true; kind: 'pdf' } | { ok: true; kind: 'text'; text: string; cut: boolean } | { ok: false; reason: FileRefusal } {
  if (bytes.byteLength > MAX_SHOW_BYTES) return { ok: false, reason: 'too-large' }
  if (mime === 'application/pdf') {
    const head = new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength))
    return String.fromCharCode(...head) === '%PDF-' ? { ok: true, kind: 'pdf' } : { ok: false, reason: 'mismatch' }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return { ok: true, kind: 'text', text: text.length > MAX_TEXT_SHOWN ? text.slice(0, MAX_TEXT_SHOWN) : text, cut: text.length > MAX_TEXT_SHOWN }
}

/**
 * How the host viewer presents a file (Review I1, 2026-10-05). Text is shown escaped in the host's own viewer. A PDF is
 * DOWNLOAD-ONLY: Chromium renders PDFs only in an unsandboxed iframe, and a link inside one navigated the whole host
 * tab in real Brave, so no show-file path creates an iframe. A contained viewer (e.g. pdf.js to canvas in a sandboxed
 * frame) is a later request with its own real-browser link/top-navigation test.
 */
export function viewerPlan(kind: 'pdf' | 'text'): { show: 'text' | 'download-only'; iframe: false } {
  return kind === 'text' ? { show: 'text', iframe: false } : { show: 'download-only', iframe: false }
}

/** The type every viewer download blob carries: opaque bytes, so even opened directly it is saved, never rendered. */
export const DOWNLOAD_BLOB_TYPE = 'application/octet-stream'

/** The viewer's download blob URL, revoked exactly once on close. No URL ever goes back to the frame. The `mime` the app
 *  declared is not used as the blob type (see DOWNLOAD_BLOB_TYPE). */
export function viewerBlob(bytes: ArrayBuffer, mime: ShowMime): { url: string; close: () => void } {
  void mime
  const url = URL.createObjectURL(new Blob([bytes], { type: DOWNLOAD_BLOB_TYPE }))
  let open = true
  return { url, close: () => { if (open) { open = false; URL.revokeObjectURL(url) } } }
}

// ---- G7 back / escape ------------------------------------------------------------------------------------------------

/** A frame's `back-request` or forwarded `escape`: the host's own Back, unless a host dialog is open (it owns Escape). */
export function frameBack(hostModalOpen: boolean, onBack: (() => void) | undefined): boolean {
  if (hostModalOpen || !onBack) return false
  onBack()
  return true
}

// ---- G2 act with a file ----------------------------------------------------------------------------------------------

export type ActFileRefusal = 'file-not-accepted' | 'file-type-refused' | 'too-large' | 'bad-file' | 'not-opened' | 'person-required' | 'declined' | 'busy' | 'unavailable' | 'rate-limited' | 'invalid' | 'confirm-required'
export interface ActFile {
  name: string
  mime: string
  size: number
  bytes: ArrayBuffer
}
/** What the hive receives (POST …/act `file`): the bytes as base64, the size from the bytes. */
export interface ActFileWire {
  name: string
  mime: string
  size: number
  content_base64: string
}
export interface AcceptsFile {
  mimes: string[]
  max_bytes: number
}
const MIME = /^[a-z0-9][\w.+-]{0,63}\/[\w.+-]{1,63}$/i

/** The frame's optional `file: {name, mime, bytes}` on an act, checked; the host computes size. */
export function parseActFile(f: unknown): { ok: true; file: ActFile } | { ok: false; reason: ActFileRefusal } {
  if (!plainObject(f) || !onlyKeys(f, ['name', 'mime', 'bytes'])) return { ok: false, reason: 'bad-file' }
  if (!isArrayBuffer(f.bytes) || typeof f.name !== 'string' || typeof f.mime !== 'string') return { ok: false, reason: 'bad-file' }
  if (f.bytes.byteLength > MAX_ACT_FILE) return { ok: false, reason: 'too-large' }
  const name = cleanName(f.name)
  if (!name || !MIME.test(f.mime)) return { ok: false, reason: 'bad-file' }
  return { ok: true, file: { name, mime: f.mime.toLowerCase(), size: f.bytes.byteLength, bytes: f.bytes } }
}

/** The action's declared `accepts_file`, as the host's describe shows it; null when the action takes no file. */
export function acceptsFile(a: ProgramAction | undefined): AcceptsFile | null {
  const x = (a as { accepts_file?: unknown } | undefined)?.accepts_file
  if (!plainObject(x) || !Array.isArray(x.mimes) || typeof x.max_bytes !== 'number') return null
  return { mimes: x.mimes.filter((m): m is string => typeof m === 'string').map((m) => m.toLowerCase()), max_bytes: Math.min(x.max_bytes, MAX_ACT_FILE) }
}

/** Params the host itself passes with every action (PROGRAMS.md "Stale"): never undeclared. */
const HOST_STEP_PARAMS = new Set(['focus', 'stage'])

/**
 * The host's describe checks for a frame act on a confirm action, before any dialog or mint (Kimi next22b/23b r2 #1):
 * the action must be one describe declares, and every param must be one it declares for that action (or the host's
 * own `focus`/`stage`). Refused `invalid`, so the person is never asked to confirm an act the hive cannot take.
 * `actions` null: describe is not known here, and the hive stays the authority.
 */
export function precheckAct(action: string, params: unknown, actions: ProgramAction[] | null): ActFileRefusal | null {
  if (!actions) return null
  const a = actions.find((x) => x.id === action)
  if (!a) return 'invalid'
  if (params === undefined || params === null) return null
  if (!plainObject(params)) return 'invalid'
  const declared = plainObject(a.params) ? a.params : {}
  return Object.keys(params).every((k) => Object.hasOwn(declared, k) || HOST_STEP_PARAMS.has(k)) ? null : 'invalid'
}

/**
 * The local pre-check against describe (the hive stays the authority), before any dialog or mint: the size ceiling,
 * then the action and its params (precheckAct), then the action's declared file types and size. `actions` null:
 * describe not known here.
 */
export function precheckActFile(file: ActFile, action: string, actions: ProgramAction[] | null, params?: unknown): ActFileRefusal | null {
  if (file.size > MAX_ACT_FILE) return 'too-large'
  if (!actions) return null
  const known = precheckAct(action, params, actions)
  if (known) return known
  const a = actions.find((x) => x.id === action)
  const acc = acceptsFile(a)
  if (!acc) return 'file-not-accepted'
  if (!acc.mimes.some((m) => m === file.mime || (m.endsWith('/*') && file.mime.startsWith(m.slice(0, -1))))) return 'file-type-refused'
  if (file.size > acc.max_bytes) return 'too-large'
  return null
}

/** Base64 in chunks (a multiple of 3 bytes each, so the pieces concatenate), never one huge spread. */
export function base64Chunked(bytes: ArrayBuffer, chunk = 3 * 0x4000): string {
  const u = new Uint8Array(bytes)
  const parts: string[] = []
  for (let i = 0; i < u.length; i += chunk) {
    const piece = u.subarray(i, i + chunk)
    let s = ''
    for (let j = 0; j < piece.length; j += 0x1000) s += String.fromCharCode.apply(null, piece.subarray(j, j + 0x1000) as unknown as number[])
    parts.push(btoa(s))
  }
  return parts.join('')
}

/** Detach the frame's buffer once the call is made: the host keeps no bytes (ES2024 transfer; else drop the reference). */
export function releaseBytes(bytes: ArrayBuffer): void {
  const t = (bytes as ArrayBuffer & { transfer?: (n?: number) => ArrayBuffer }).transfer
  if (typeof t === 'function') {
    try {
      t.call(bytes, 0)
    } catch {
      /* already detached */
    }
  }
}

/** How a hive refusal of an act with a file reads to the frame (Platform's mapping). */
export function actFileError(e: unknown): ActFileRefusal {
  if (!(e instanceof ApiError)) return 'unavailable'
  const map: Record<string, ActFileRefusal> = {
    file_not_accepted: 'file-not-accepted',
    file_type_refused: 'file-type-refused',
    file_too_large: 'too-large',
    request_too_large: 'too-large',   // next9: the request body is stream-capped at 28 MB
    bad_file: 'bad-file',
    app_not_opened: 'not-opened',
    person_required: 'person-required',
  }
  if (map[e.code]) return map[e.code]
  if (e.status === 413) return 'too-large'
  if (e.status === 415) return 'file-type-refused'
  return 'unavailable'
}

/**
 * Send one confirmed act with a file. The host makes ONE idempotency key per confirmed intent (the frame cannot choose
 * it); a retry after a lost answer (network) reuses the same key and the same encoded bytes. The server never
 * re-delivers the bytes to the program on a retry. `content_base64` is dropped when this returns.
 * Superseded on the host path by §9d (a confirm token is never silently re-sent): AppFrame uses fileActBody and
 * lib/hostConfirm.runConfirmed. Kept for callers outside a confirm action.
 */
export async function sendActFile(
  act: (body: import('../api/types').ProgramActBody) => Promise<ActionResult>,
  body: Omit<import('../api/types').ProgramActBody, 'file' | 'idempotency_key' | 'swarm_id'> & Record<string, unknown>,
  swarmId: string,
  file: { name: string; mime: string; size: number; content_base64: string },
  key: string = crypto.randomUUID(),
  tries = 2,
): Promise<ActionResult> {
  const wire = fileActBody(body, swarmId, file, key)
  for (let i = 1; ; i++) {
    try {
      return await act(wire)
    } catch (e) {
      const lost = e instanceof ApiError && (e.status === 0 || e.code === 'network')
      if (!lost || i >= tries) throw e
    }
  }
}

/**
 * The act body for one confirmed file act: the frame's own key, swarm and file are dropped; the host's swarm, its key
 * for this intent and the encoded file are set. With §9d the host sends it once per confirm (AppFrame → lib/hostConfirm):
 * a lost answer asks the person again and sends this same body (same key) with a new token, never a silent resend.
 */
export function fileActBody(
  body: Record<string, unknown>,
  swarmId: string,
  file: { name: string; mime: string; size: number; content_base64: string },
  key: string,
): import('../api/types').ProgramActBody {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { idempotency_key: _frameKey, swarm_id: _frameSwarm, file: _frameFile, confirm_token: _frameToken, ...rest } = body
  return { ...(rest as object), swarm_id: swarmId, idempotency_key: key, file } as import('../api/types').ProgramActBody
}

/** Only the host's already-bound confirm outcome may certify that /act was never sent.
 * Missing delivery evidence stays unknown. This changes no grants, confirms or dispatch. */
export const actFileRefused = (id: string, reason: ActFileRefusal, actNotSent?: boolean, refusalCode?: 'app_inactive') => ({
  type: 'app-reply' as const, id, ok: false as const, error: reason, reason,
  ...(actNotSent === true ? { act_not_sent: true as const, ...(refusalCode === 'app_inactive' ? { refusal_code: refusalCode } : {}) } : {}),
})

// ---- G9 goal notices -------------------------------------------------------------------------------------------------

/** The goal an act result started (its `task`), if any. */
export function startedGoal(r: ActionResult | null | undefined): string | null {
  const t = r?.task
  return t && t.kind === 'goal' && typeof t.id === 'string' && ID.test(t.id) ? t.id : null
}

/** Goal ids THIS frame's own acts started, and which of them it subscribed to. A new frame starts with none. */
export class FrameGoals {
  private started = new Set<string>()
  readonly subscribed = new Set<string>()
  constructor(private max = 256) {}
  record(goalId: string | null) {
    if (!goalId) return
    this.started.add(goalId)
    if (this.started.size > this.max) this.started.delete(this.started.values().next().value as string)
  }
  subscribe(goalId: string): boolean {
    if (!this.started.has(goalId)) return false
    this.subscribed.add(goalId)
    return true
  }
  unsubscribe(goalId: string) {
    this.subscribed.delete(goalId)
  }
  clear() {
    this.started.clear()
    this.subscribed.clear()
  }
}

/** The notice for a goal event the page received, if this frame subscribed to that goal in its swarm. Status only. */
export function goalNotice(event: { type: string } & Record<string, unknown>, swarmId: string, goals: FrameGoals) {
  if (event.type !== 'goal.updated') return null
  const g = event.goal as { id?: unknown; swarm_id?: unknown; status?: unknown } | undefined
  if (!g || typeof g.id !== 'string' || g.swarm_id !== swarmId || !goals.subscribed.has(g.id) || typeof g.status !== 'string') return null
  return { type: FRAME_WIRE.goal.status, goal_id: g.id, status: g.status }
}

// ---- identity epoch for the host bridge (Surface P2, studio-host-seam r1) ------------------------------------------

/**
 * A message's refusal in its own reply type, or null when it has none (the message is then dropped):
 * - `rate-limited`: the frame's token bucket (PROGRAMS.md §9c).
 * - `unavailable`: the identity the request or its document belongs to is no longer the current one. This is the
 *   bridge's UNKNOWN outcome: never `act_not_sent`, never a whitelisted definite refusal, so an app keeps its own
 *   custody (it never hears that a write succeeded, nor that it certainly did not happen). Types without an
 *   `unavailable` reason (open-url, show-file, goal subscribe) are dropped: they never reach the hive as the person,
 *   and their document is being replaced for the new person (AppFrame remounts on the identity epoch).
 */
export function frameRefusal(data: unknown, reason: 'rate-limited' | 'unavailable'): object | null {
  const m = (data && typeof data === 'object' ? data : {}) as { type?: unknown; id?: unknown; goal_id?: unknown }
  if ((m.type === 'app-setup' || m.type === 'app-open') && typeof m.id === 'string' && ID.test(m.id)) return { type: `${m.type}-result`, id: m.id, state: 'refused', reason: reason === 'rate-limited' ? 'rate_limited' : 'not_available' }
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null
  if (m.type === 'subscribe' || m.type === 'unsubscribe')
    return reason === 'rate-limited' && typeof m.goal_id === 'string' ? { type: FRAME_WIRE.goal.refused, goal_id: m.goal_id.slice(0, 80), reason } : null
  if (!id) return null
  switch (m.type) {
    case 'read': return readRefused(id, reason)
    case 'open-url': return reason === 'rate-limited' ? urlRefused(id, reason) : null
    case 'show-file': return reason === 'rate-limited' ? fileRefused(id, reason) : null
    case 'pick': return cancelledReply(id, reason)
    case 'app-request': return { type: 'app-reply', id, ok: false, error: reason, reason }
    case 'draft-save': case 'draft-list': case 'draft-load': case 'draft-delete': case 'asset-bytes': {
      const p = parseStudioMessage(data)
      if (reason === 'rate-limited') return p?.ok ? rateLimitedReply(p.msg) : null
      const [type, sid] = p?.ok ? [p.msg.type, p.msg.id] : p ? [p.type, p.id] : [null, null]
      if (!type || !sid) return null
      if (type === 'asset-bytes') return assetRefused(sid, 'unavailable', p?.ok && p.msg.type === 'asset-bytes' ? p.msg.handle : undefined)
      return draftRefused(sid, ({ 'draft-save': 'save', 'draft-list': 'list', 'draft-load': 'load', 'draft-delete': 'delete' } as const)[type], 'unavailable')
    }
    default: return null
  }
}

/** One frame request, bound to the identity it arrived under (lib/identityEpoch; no primitive of its own). */
export interface FrameRequest {
  /** The request may reach the hive: its identity is the one the frame's document was loaded for, and still current. */
  readonly admitted: boolean
  /**
   * What the frame may be told now (call it in the same synchronous tick as the post): the host's own reply while
   * the request's identity is still current; otherwise the unknown refusal (frameRefusal 'unavailable'), or null
   * (nothing posted). A completion that lands after a change of person is never posted as a success.
   */
  settle(value: object): object | null
}

/**
 * Bind one bridge message. `doc` is the binding the frame's document was loaded under; `at` is bound now, as the
 * message is received (pass `bindEpoch()`). A message from a document loaded for an earlier person is not admitted,
 * so nothing it asks for is sent as the new person; every answer is checked again when it is posted.
 */
export function bindFrameRequest(doc: EpochBinding, at: EpochBinding, data: unknown): FrameRequest {
  const admitted = at.epoch === doc.epoch && at.current()
  return {
    admitted,
    settle: (value) => (admitted && at.current() ? value : frameRefusal(data, 'unavailable')),
  }
}
