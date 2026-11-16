import { ApiError } from '../client'
import type { ActionResult, ProgramAction, ProgramActBody, ConfirmToken } from '../types'
import { base64Bytes, canonicalJson, ConfirmTooLargeError, ConfirmValueError, confirmPayload, payloadDigest, sha256Hex, wireOf, type ConfirmFile } from '../../lib/confirmDigest'

/**
 * The sim host's confirm tokens (PROGRAMS.md §9d), with the hive's rules (hive/core/program_actions.py mint_confirm,
 * _take_confirm, as amended by Platform B1): INVENTED sessions only, nothing leaves the page.
 *
 * - mint: exactly {swarm_id, action, payload, payload_digest}; digest `sha256:` + 64 lowercase hex; payload
 *   {items?, params?, base_revision?, file?}, normalized as the act normalizes (ced0564), in the number domain (else
 *   400 confirm_unsupported_value), at most 2 MiB as canonical JSON (else 413 confirm_payload_too_large, also at act),
 *   whose digest is payload_digest (else 400 confirm_digest_mismatch); a declared action that
 *   needs a confirm (else 400 confirm_not_needed); `person_activity` or `approver: "person"` → a named person (403
 *   person_required); a mind or no session → 401. Token `hct_` + 43 url-safe characters, 120 s, bound to principal,
 *   session, program, swarm, action and digest.
 * - act: a confirm action without a token → 403 confirm_required; a token that does not match all of that, or is
 *   expired, or spent → 403 confirm_invalid. A spent token is accepted again ONLY to recover the already-completed
 *   result of the intent (same idempotency key) it was spent on. Decimals, −0 and numbers past 2^53−1 → 400
 *   confirm_unsupported_value. Tokens are spent only on a full match.
 */

export const CONFIRM_TTL_S = 120
const DIGEST = /^sha256:[0-9a-f]{64}$/

export const confirms = (a: ProgramAction | undefined) => !!a && (a.confirm === true || a.person_activity === true)

interface Row {
  principal: string
  session: string
  program: string
  swarm: string
  action: string
  digest: string
  expires: number
  used: number | null
  intent: string | null
}

export interface SimSession {
  /** null: no person session (a mind's token, or signed out) */
  principal: string | null
  /** a named person (not the local operator password) */
  person: boolean
  /** the session's identity: a token from another session of the same person is refused */
  session: string
}

const named = (p: string) => p.startsWith('user:') && p !== 'user:operator'

function token(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return 'hct_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The hive's digest with its refusals: 400 confirm_unsupported_value, 413 confirm_payload_too_large. */
async function hiveDigest(payload: Parameters<typeof payloadDigest>[0]): Promise<string> {
  try {
    canonicalJson(payload)
    return await payloadDigest(payload)
  } catch (e) {
    if (e instanceof ConfirmValueError) throw new ApiError(400, 'confirm_unsupported_value', 'confirmable payloads hold integers up to 2^53-1 only')
    if (e instanceof ConfirmTooLargeError) throw new ApiError(413, 'confirm_payload_too_large', 'a confirmed act is limited to 2 MB as canonical JSON')
    throw e
  }
}

export class SimConfirmTokens {
  private rows = new Map<string, Row>()   // keyed by sha256 of the token: the raw token is never kept
  /** completed person_activity intents: principal|program|key → the recorded result (sim's program_actions) */
  private done = new Map<string, ActionResult>()
  constructor(private now: () => number = () => Date.now()) {}

  async mint(program: string, actions: ProgramAction[], s: SimSession, body: unknown): Promise<ConfirmToken> {
    if (!s.principal) throw new ApiError(401, 'unauthorized', 'sign in')
    const b = body as Record<string, unknown>
    if (!b || typeof b !== 'object' || Object.keys(b).sort().join(',') !== 'action,payload,payload_digest,swarm_id')
      throw new ApiError(400, 'bad_request', 'confirm takes exactly swarm_id, action, payload and payload_digest')
    if (typeof b.payload_digest !== 'string' || !DIGEST.test(b.payload_digest)) throw new ApiError(400, 'bad_request', 'payload_digest is sha256:<64 lowercase hex>')
    const p = b.payload as Record<string, unknown> | null
    const keys = p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p) : null
    if (!keys || keys.some((k) => !['items', 'params', 'base_revision', 'file'].includes(k)))
      throw new ApiError(400, 'bad_request', 'payload is {items?, params?, base_revision?, file?} exactly as the act will send them')
    let w: Record<string, unknown>
    try {
      w = wireOf(p) as Record<string, unknown>
    } catch (e) {
      if (e instanceof ConfirmValueError) throw new ApiError(400, 'confirm_unsupported_value', 'confirmable payloads hold integers up to 2^53-1 only')
      throw e
    }
    const normal = confirmPayload(w, (w.file as ConfirmFile | undefined) ?? null)   // normalized exactly as the act does
    if ((await hiveDigest(normal)) !== b.payload_digest) throw new ApiError(400, 'confirm_digest_mismatch', 'payload_digest is not the hive digest of payload')
    const declared = actions.find((a) => a.id === b.action)
    if (!declared) throw new ApiError(400, 'bad_request', `${program} has no action ${String(b.action)}`)
    if (!confirms(declared)) throw new ApiError(400, 'confirm_not_needed', `${declared.id} does not take a host confirm`)
    const approver = (declared as { approver?: unknown }).approver
    if ((approver === 'person' || declared.person_activity === true) && !(s.person && named(s.principal))) throw new ApiError(403, 'person_required', 'named person required')
    const t = token()
    const at = this.now() + CONFIRM_TTL_S * 1000
    this.rows.set(await sha256Hex(t), { principal: s.principal, session: s.session, program, swarm: String(b.swarm_id), action: declared.id, digest: b.payload_digest, expires: at, used: null, intent: null })
    return { confirm_token: t, expires_at: new Date(at).toISOString(), expires_in: CONFIRM_TTL_S }
  }

  /**
   * The act route's check, before delivery. Returns a recorded result when this is the recovery of an intent that
   * already completed (the program is not called again); null when the act may run.
   */
  async take(program: string, declared: ProgramAction | undefined, s: SimSession, body: ProgramActBody): Promise<ActionResult | null> {
    if (!confirms(declared)) return null   // back-compat: actions without a confirm ignore the field
    let wire: ProgramActBody
    try {
      wire = wireOf(body)   // the text the hive parses: 1.0 or 1e3 there is a float (400)
    } catch (e) {
      if (e instanceof ConfirmValueError) throw new ApiError(400, 'confirm_unsupported_value', 'confirmable payloads hold integers up to 2^53-1 only')
      throw e
    }
    const f = wire.file
    let bytes: Uint8Array | null
    try {
      bytes = f ? base64Bytes(f.content_base64) : null
    } catch {
      throw new ApiError(400, 'bad_file', 'content_base64 is not base64')   // the hive checks the file before the confirm
    }
    const file = f && bytes ? { name: f.name, mime: f.mime, size: f.size, sha256: `sha256:${await sha256Hex(bytes)}` } : null
    const digest = await hiveDigest(confirmPayload(wire, file))
    const pa = declared!.person_activity === true
    if (pa && (!s.principal || !s.person || !named(s.principal) || !body.idempotency_key)) throw new ApiError(403, 'person_required', 'named person and stable intent key required')
    if (!body.confirm_token) throw new ApiError(403, 'confirm_required', `${declared!.id} needs the person's confirm in the host first`)
    const intent = pa ? `${s.principal}|${program}|${body.idempotency_key}` : null
    const row = this.rows.get(await sha256Hex(String(body.confirm_token)))
    const t = this.now()
    const match = !!row && row.principal === s.principal && row.session === s.session && row.program === program && row.swarm === body.swarm_id && row.action === declared!.id && row.digest === digest
    const fresh = !!row && row.used === null && row.expires > t
    const recovery = !!row && row.used !== null && intent !== null && row.intent === intent && this.done.has(intent)
    if (!match || !(fresh || recovery)) throw new ApiError(403, 'confirm_invalid', 'that confirm is used, expired or for a different act')
    if (fresh) {
      row!.used = t
      row!.intent = intent
    }
    // a completed intent (a new confirm or its own spent token) returns what it returned: never a second effect
    return intent && this.done.has(intent) ? structuredClone(this.done.get(intent)!) : null
  }

  /** The act ran: a person_activity intent's result is recorded for its recovery. */
  record(program: string, declared: ProgramAction | undefined, s: SimSession, body: ProgramActBody, result: ActionResult) {
    if (!confirms(declared) || declared!.person_activity !== true || !body.idempotency_key || !s.principal) return
    if (result.status === 'error') return
    this.done.set(`${s.principal}|${program}|${body.idempotency_key}`, structuredClone(result))
  }
}

/** The describe as the hive sends it (§9d): every action carries its effective `confirm`. */
export function withEffectiveConfirm<T extends { describe: { actions: ProgramAction[] } | null }>(detail: T): T {
  if (!detail.describe) return detail
  return { ...detail, describe: { ...detail.describe, actions: detail.describe.actions.map((a) => ({ ...a, confirm: confirms(a) })) } }
}
