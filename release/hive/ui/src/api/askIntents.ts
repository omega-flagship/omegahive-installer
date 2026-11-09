/**
 * The Ask's linkage intents (PLATFORM_ASK_R2_13_LINKAGE_SPEC r3.6 §(a)), as the host serves them at release main 39c0731
 * (hive/core/app.py:1495-1532, hive/core/ask_intents.py). Platform owns these; Surface reads them.
 *
 *   POST /api/ask/{op}/intents {kind: "code.request", request: <r2.13 body without operation_id>}   201 new, 200 same
 *   POST /api/ask/intents/{id}/submit   (no body)   the recorded r2.13 201, byte for byte (S4)
 *   GET  /api/ask/intents?state=&limit≤50            the caller's own intents
 *   GET  /api/ask/intents/{id}                        one of the caller's own intents
 *
 * Record and submit are named-admin person routes under §G (exact Origin, a Bearer header, application/json). The
 * request inside an intent is exactly r2.13's (minds.py:336-382 `_instruction_body`): the host derives operation_id
 * ("ask." + intent id), so the page never sends one. Nothing here calls POST /api/requests (R1: the host refuses an
 * `ask.` key there).
 *
 * Every answer is checked strictly before the canvas uses it; an answer that does not fit is a ContractError-style
 * failure, never a guess.
 */

import { ApiError } from './client'

export const INTENT_KIND = 'code.request'
export type IntentState = 'pending' | 'dispatching' | 'linked' | 'refused' | 'abandoned'
const STATES: readonly IntentState[] = ['pending', 'dispatching', 'linked', 'refused', 'abandoned']

/** The r2.13 origin (minds.py ORIGIN_FIELDS): exactly these six. */
export interface CodeRequestOrigin {
  task_id: string
  repository_id: string
  workspace_id: string
  scope_id: string
  /** the issued scope's digest on the wire: "sha256:" + Code's bare 64-hex digest */
  scope_digest: string
  generation: number
}
/** The r2.13 body without operation_id (the host adds "ask." + intent id). */
export interface CodeRequest {
  to_swarm: string
  kind: 'code'
  title: string
  instruction: string
  origin: CodeRequestOrigin
  budget: { limit_usd: number }
  lifetime: { until: string }
  lease: { template_ids: string[]; max_children: number }
}
export interface IntentRecordBody {
  kind: typeof INTENT_KIND
  request: CodeRequest
}

/** The owner's intent view (ask_intents.py view). Only the fields the canvas relies on are required. */
export interface IntentView {
  intent_id: string
  turn_id: string
  kind: string
  state: IntentState
  request_operation_id: string
  request_id: string | null
  lease_id: string | null
  receiving_goal: string | null
  last_refusal: { code: string; status: number | null } | null
  last_dispatch: { outcome: string; code: string } | null
  until: string | null
  links_rev: number
}

/** The recorded r2.13 201 (minds.py instruct): what submit answers, byte for byte. */
export interface Admission {
  request_id: string
  receiving_goal: string
  lease_id: string
  state: 'accepted'
  budget: { root: string; limit_usd: number }
  until: string
}

/**
 * The Code team that would take a person's code request: its swarm and the mind templates registered for it, read with
 * the person read GET /api/teams/{swarm_id}/templates (release 37e606f; app.py team_templates, minds.py:498). Templates
 * have no display name (template_id is what is shown). How many minds, how much money and how long are NOT the
 * template's: they are set per request (VIBE_REQUEST_LIMITS).
 */
export interface CodeTeamOffer {
  to_swarm: string
  team_name: string
  template_ids: string[]
  /** The limits the host admits a request to this team within (the foundation Code team's are host-bound), when the
   * templates read states them. A request is composed inside them, never refused 403 foundation_limits. */
  limits?: TeamRequestLimits
}
export interface TeamRequestLimits { limit_usd: number; max_children: number; lifetime_seconds: number; template_ids: string[] }

/** The optional `request_limits` of GET /api/teams/{swarm}/templates, strictly; anything malformed is treated as absent. */
export function parseRequestLimits(raw: unknown): TeamRequestLimits | undefined {
  if (!obj(raw) || !obj(raw.request_limits)) return undefined
  const l = raw.request_limits
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  if (!pos(l.limit_usd) || !pos(l.max_children) || !pos(l.lifetime_seconds) || !Array.isArray(l.template_ids)) return undefined
  const ids = l.template_ids.filter((t): t is string => ref(t, 120))
  if (!ids.length) return undefined
  return { limit_usd: l.limit_usd as number, max_children: Math.floor(l.max_children as number), lifetime_seconds: Math.floor(l.lifetime_seconds as number), template_ids: ids }
}

/** A clock margin under a host-bound lifetime, so a request never asks for a moment longer than the host admits. */
export const LIFETIME_MARGIN_MS = 30_000
/**
 * Which team takes a person's code request (r4 [P2]): the visible, in-use swarms with a coordinator whose services
 * offer `code`; exactly one, or the page says so rather than choose. Every read must answer: one that fails means
 * eligibility is unknown, so it fails closed (503 teams_unchecked) and never picks from partial reads. A 401 still
 * says "sign in again".
 */
export async function chooseCodeTeam<S extends { id: string; name: string; archived_at?: string | null; coordinator_id?: string | null }>(
  listSwarms: () => Promise<S[]>,
  servicesOf: (id: string) => Promise<{ kinds?: string[] } | null | undefined>,
): Promise<S> {
  const unchecked = (e: unknown): never => {
    if (e instanceof ApiError && e.status === 401) throw e
    throw new ApiError(503, 'teams_unchecked', 'Couldn’t check which swarms offer Code. Try again.')
  }
  const swarms = (await listSwarms().catch(unchecked)).filter((s) => !s.archived_at && s.coordinator_id)
  const offering: S[] = []
  for (const s of swarms) {
    const svc = await servicesOf(s.id).catch(unchecked)
    if (svc?.kinds?.includes('code')) offering.push(s)
  }
  if (!offering.length) throw new ApiError(404, 'no_code_team', 'No swarm here takes code changes.')
  if (offering.length > 1) throw new ApiError(409, 'several_code_teams', `More than one swarm takes code changes here (${offering.map((s) => s.name).join(', ')}).`)
  return offering[0]
}

/** Per REQUEST, never read from a template: one mind, at most $0.50, for an hour (the host caps both further). */
export const VIBE_REQUEST_LIMITS = { max_children: 1, limit_usd: 0.5, lifetime_minutes: 60 } as const
export type RequestLimits = { max_children: number; limit_usd: number; lifetime_minutes: number }

/**
 * Strictly read GET /api/teams/{swarm_id}/templates: `{to_swarm, templates: [{template_id, harness, model_id, role_id,
 * max_allocation_usd, overridable, controls, lifecycle_modes}]}` for exactly the team asked about. Returns its template
 * ids (at most 8: the lease's limit), in the host's order.
 */
export function parseTeamTemplates(raw: unknown, swarmId: string): string[] {
  const p: string[] = []
  if (!obj(raw)) throw new IntentContractError('The swarm’s minds', ['not an object'])
  if (raw.to_swarm !== swarmId) p.push('another swarm')
  if (!Array.isArray(raw.templates)) p.push('templates')
  const ids: string[] = []
  for (const [i, t] of (Array.isArray(raw.templates) ? raw.templates : []).entries()) {
    if (!obj(t) || !ref(t.template_id, 120)) p.push(`templates[${i}].template_id`)
    else if (typeof t.harness !== 'string' || !Array.isArray(t.controls) || !Array.isArray(t.lifecycle_modes) || typeof t.max_allocation_usd !== 'number') p.push(`templates[${i}] shape`)
    else if (!ids.includes(t.template_id)) ids.push(t.template_id)
  }
  if (p.length) throw new IntentContractError('The swarm’s minds', p)
  return ids.slice(0, 8)
}

/**
 * ONE limit for a vibe request's words, end to end (r3 [P2]): the Ask carries at most 4000 UTF-16 units of a turn or a
 * steer (store/ask send/steerTo) and r2.13 at most 8192 UTF-8 bytes of an instruction (minds.py _instruction_body).
 * Both are checked before anything is issued or sent, and over-long words are refused, never cut: the Ask and the
 * Code team receive exactly the same words.
 */
export const VIBE_WORDS_MAX = 4000
export function vibeWordsProblem(words: string): string | null {
  if (words.length > VIBE_WORDS_MAX || new TextEncoder().encode(words).length > 8192) return `That is too long to hand to a mind in one go (${words.length} characters; at most ${VIBE_WORDS_MAX}). Say it in fewer words, or split it into steps. Nothing was sent.`
  return null
}

export class IntentContractError extends Error {
  constructor(what: string, problems: string[]) {
    super(`${what} was not understood (${problems.slice(0, 3).join('; ')})`)
  }
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const ref = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const objectKind = (v: unknown) => obj(v) ? v.kind : undefined
const refOrNull = (v: unknown) => v === null || v === undefined || ref(v)

/** Strictly read an intent view (record's 201/200, get, and each item of a list). */
export function parseIntentView(raw: unknown, expect?: { intent_id?: string; kind?: typeof INTENT_KIND | 'code.test' }): IntentView {
  const p: string[] = []
  if (!obj(raw)) throw new IntentContractError('The intent', ['not an object'])
  if (!ref(raw.intent_id) || !/^ai_[0-9a-f]{24}$/.test(raw.intent_id)) p.push('intent_id')
  if (expect?.intent_id && raw.intent_id !== expect.intent_id) p.push('another intent')
  if (!ref(raw.turn_id)) p.push('turn_id')
  if (raw.kind !== (expect?.kind ?? INTENT_KIND)) p.push('kind')
  if (!STATES.includes(raw.state as IntentState)) p.push('state')
  if (!ref(raw.request_operation_id) || raw.request_operation_id !== `ask.${String(raw.intent_id)}`) p.push('request_operation_id')
  for (const k of ['request_id', 'lease_id', 'receiving_goal'] as const) if (!refOrNull(raw[k])) p.push(k)
  if (raw.state === 'linked' && !ref(raw.request_id)) p.push('a linked intent without its request')
  if (typeof raw.links_rev !== 'number' || !Number.isInteger(raw.links_rev) || raw.links_rev < 0) p.push('links_rev')
  const refusal = raw.last_refusal
  if (refusal !== null && refusal !== undefined && (!obj(refusal) || !ref(refusal.code, 120))) p.push('last_refusal')
  const dispatch = raw.last_dispatch
  if (dispatch !== null && dispatch !== undefined && (!obj(dispatch) || !ref(dispatch.outcome, 40))) p.push('last_dispatch')
  if (p.length) throw new IntentContractError('The intent', p)
  return {
    intent_id: raw.intent_id as string,
    turn_id: raw.turn_id as string,
    kind: expect?.kind ?? INTENT_KIND,
    state: raw.state as IntentState,
    request_operation_id: raw.request_operation_id as string,
    request_id: (raw.request_id as string | null) ?? null,
    lease_id: (raw.lease_id as string | null) ?? null,
    receiving_goal: (raw.receiving_goal as string | null) ?? null,
    last_refusal: obj(refusal) ? { code: String(refusal.code), status: typeof refusal.status === 'number' ? refusal.status : null } : null,
    last_dispatch: obj(dispatch) ? { outcome: String(dispatch.outcome), code: String(dispatch.code ?? '') } : null,
    until: typeof raw.until === 'string' ? raw.until : null,
    links_rev: raw.links_rev as number,
  }
}

/** Strictly read the list answer (GET /api/ask/intents): `{intents: [...]}`. */
export function parseIntentList(raw: unknown): IntentView[] {
  if (!obj(raw) || !Array.isArray(raw.intents)) throw new IntentContractError('The intent list', ['no intents array'])
  return raw.intents.map((v) => parseIntentView(v, objectKind(v) === 'code.test' ? { kind: 'code.test' } : undefined))
}

/** Strictly read the recorded r2.13 admission submit answers (closed shape; state "accepted"). */
export function parseAdmission(raw: unknown): Admission {
  const p: string[] = []
  if (!obj(raw)) throw new IntentContractError('The admission', ['not an object'])
  const allowed = ['request_id', 'receiving_goal', 'lease_id', 'state', 'budget', 'until']
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) p.push(`unexpected ${k}`)
  if (!ref(raw.request_id)) p.push('request_id')
  if (!ref(raw.receiving_goal)) p.push('receiving_goal')
  if (!ref(raw.lease_id)) p.push('lease_id')
  if (raw.state !== 'accepted') p.push('state')
  const b = raw.budget
  if (!obj(b) || b.root !== raw.request_id || typeof b.limit_usd !== 'number' || !(b.limit_usd > 0)) p.push('budget')
  if (typeof raw.until !== 'string' || Number.isNaN(Date.parse(raw.until))) p.push('until')
  if (p.length) throw new IntentContractError('The admission', p)
  return raw as unknown as Admission
}

/**
 * The exact r2.13 body for one vibe request (no operation_id). `scopeDigest` is Code's bare 64-hex scope digest; the
 * wire carries it as "sha256:<hex>" (Code's copy-apply check compares exactly that). Title: 1-200 code points;
 * instruction: 1-8192 UTF-8 bytes (refused here rather than truncated).
 */
export function codeRequest(o: {
  offer: CodeTeamOffer
  /** set per request (default VIBE_REQUEST_LIMITS), never taken from a template */
  limits?: RequestLimits
  instruction: string
  title: string
  origin: Omit<CodeRequestOrigin, 'scope_digest'> & { scope_digest_hex: string }
  now: number
}): CodeRequest {
  const words = o.instruction.trim()
  const bytes = new TextEncoder().encode(words).length
  if (bytes < 1 || bytes > 8192) throw new Error('Say it in fewer words: a request to a mind is at most 8 KB of text.')
  if (!/^[0-9a-f]{64}$/.test(o.origin.scope_digest_hex)) throw new Error('The lines you marked have no digest the hive can bind to.')
  const title = [...o.title.trim()].slice(0, 200).join('') || 'A change to the code'
  const asked = o.limits ?? VIBE_REQUEST_LIMITS
  const bound = o.offer.limits
  // inside the team's host-bound limits when it states them (never more money, minds, time or templates than admitted)
  const limits = bound ? { limit_usd: Math.min(asked.limit_usd, bound.limit_usd), max_children: Math.min(asked.max_children, bound.max_children) } : asked
  const templates = bound ? o.offer.template_ids.filter((t) => bound.template_ids.includes(t)) : o.offer.template_ids
  if (!templates.length) throw new Error(`${o.offer.team_name} has no minds registered to take a change.`)
  const minutes = Math.min(Math.max(1, Math.floor(asked.lifetime_minutes)), 24 * 60)
  const lifeMs = bound ? Math.min(minutes * 60_000, Math.max(60_000, bound.lifetime_seconds * 1000 - LIFETIME_MARGIN_MS)) : minutes * 60_000
  const { scope_digest_hex, ...origin } = o.origin
  return {
    to_swarm: o.offer.to_swarm,
    kind: 'code',
    title,
    instruction: words,
    origin: { task_id: origin.task_id, repository_id: origin.repository_id, workspace_id: origin.workspace_id, scope_id: origin.scope_id, scope_digest: `sha256:${scope_digest_hex}`, generation: origin.generation },
    budget: { limit_usd: limits.limit_usd },
    lifetime: { until: new Date(o.now + lifeMs).toISOString() },
    lease: { template_ids: [...templates].slice(0, 8), max_children: limits.max_children },
  }
}
