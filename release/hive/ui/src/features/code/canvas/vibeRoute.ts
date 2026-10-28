/**
 * The vibe request's route on a hive (linkage spec r3.6 §(a); host release main 39c0731), step by step. VibeSession runs
 * these and owns the fencing (request number + identity epoch); each step here is one exchange, read strictly.
 *
 *   1. capability: GET /api/ask/intents?limit=1 answers (the routes exist) and the client knows the Code team's offer
 *   2. record:     POST /api/ask/{turn op}/intents {kind: "code.request", request: <r2.13 body>}
 *   3. submit:     POST /api/ask/intents/{id}/submit  → the recorded r2.13 201 (request, lease, receiving goal)
 *   4. proposal:   GET  /v1/workspaces/{ws}/suggestions (Code relay) until a record on the person's issued scope appears;
 *                  the scope was minted for this request alone and is the request's origin.scope_id, and the delegated
 *                  child can propose only on exactly that scope (Code r2.13.1), so the scope id is the binding
 *   5. copy-apply: with the host's copy-apply switched on (HIVE_COPY_APPLY_CLAIMS; relay code.py:166-188), the team's
 *                  controller applies the proposal to the person's workspace copy itself (the person relay never can:
 *                  POST proposal-applications is purpose-only). The page reads the application from the workspace
 *                  journal (event proposal.copy_applied), reads it (GET …/proposal-applications/{id}) and offers Undo
 *                  (POST …/undo, person-only, on the person's own edit grant).
 *
 * Never POST /api/requests: the intent's submit is the only way a request is made from here.
 */
import { ApiError, type CodeContext, type HiveClient } from '../../../api/client'
import { IntentContractError, parseAdmission, parseIntentList, parseIntentView, type Admission, type CodeTeamOffer, type IntentRecordBody, type IntentView } from '../../../api/askIntents'
import { canonical, parseHistoryPage, sha256Text, type SuggestionRead, type WorkspaceHead } from '../suggestions/contract'

export type CopyApply = 'on' | 'off' | 'unknown'
export type Availability = { ok: true; offer: CodeTeamOffer; copyApply: CopyApply } | { ok: false; text: string }

/** The words for a hive without the route (kept in one place; the card shows them as "not available on this hive"). */
export const NO_INTENTS = 'Asking a mind to change code is not available on this hive: it has no route that hands your words to a Code swarm (the Ask’s linkage intents). You can change the code by hand, or ask the hive about it.'
export const NO_OFFER = 'This client cannot tell which Code swarm would take the change, so asking a mind to change code is not available here. You can change the code by hand, or ask the hive about it.'

/**
 * The words for a proposal on this request's lines whose retained request provenance is missing, null, foreign or
 * tampered (Code: a scope alone does not prove a request). It is never shown or offered; the person is told plainly.
 */
export const NOT_YOURS = 'A proposal turned up on the lines you marked, but it is not yours: it carries no proof that it answers this request, so it is not shown.'

/** The words for a re-read proposal whose content is no longer exactly what the person saw (r4 [P1] refresh). */
export const CHANGED_SINCE = 'It changed since you saw it — review again. Open it in the drawer’s Proposals, or ask again.'
/** The words when the hive refused to start a mind for the request (observed, never assumed). */
export const SPAWN_OFF = 'The hive isn’t allowed to start minds for requests right now, so nothing is being worked on. Only its operator can switch that on.'
/** The words when no mind started for the request in time, and the hive gave no reason (never "working on it"). */
export const NO_MIND_STARTED = 'No mind has started for this request, so nothing is being worked on. The hive may not be allowed to start minds for requests right now (only its operator can switch that on).'

/** Plain words for the Code team read (GET /api/teams/{swarm_id}/templates and the team choice). */
export function offerWords(e: unknown): string {
  const tail = ' You can change the code by hand, or ask the hive about it.'
  if (e instanceof IntentContractError) return `${e.message}.${tail}`
  if (!(e instanceof ApiError)) return `Couldn’t read which Code swarm would take the change: ${e instanceof Error ? e.message : String(e)}.${tail}`
  if (e.status === 401) return 'Sign in again to hand a change to a Code swarm.'
  if (e.code === 'person_required') return 'Only a named, signed-in person can hand a change to a Code swarm (not the hive’s password login).'
  if (e.code === 'teams_unchecked') return 'Couldn’t check which swarms offer Code. Try again.'
  if (e.code === 'no_code_team') return `No swarm on this hive takes code changes yet.${tail}`
  if (e.code === 'several_code_teams') return `${e.message} This page can’t choose between them yet.${tail}`
  if (e.status === 404) return `The Code swarm is not visible to you, or no longer exists.${tail}`
  return `Couldn’t read which Code swarm would take the change (${e.code}).${tail}`
}

/** Everything the intents route needs from a client, or null. */
export function intentsClient(c: HiveClient | null) {
  if (!c?.askRecordIntent || !c.askSubmitIntent || !c.askIntent || !c.askIntents) return null
  if (!c.codeSuggestionScope || !c.codeSuggestionHistory || !c.codeSuggestionRead || !c.codeSuggestionDecide || !c.codeProxy) return null
  return c as HiveClient & Required<Pick<HiveClient, 'askRecordIntent' | 'askSubmitIntent' | 'askIntent' | 'askIntents' | 'codeSuggestionScope' | 'codeSuggestionHistory' | 'codeSuggestionRead' | 'codeSuggestionDecide' | 'codeProxy'>>
}

/** Step 1: is the route on this hive, and who would take the change? Read from the hive's own answers. */
export async function vibeAvailability(client: HiveClient | null, ctx: CodeContext, wsId: string): Promise<Availability> {
  const c = intentsClient(client)
  if (!c) return { ok: false, text: NO_INTENTS }
  try {
    parseIntentList(await c.askIntents({ limit: 1 }))
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === 'http_404')) return { ok: false, text: NO_INTENTS }
    if (e instanceof ApiError && e.code === 'person_required') return { ok: false, text: 'Only a named, signed-in person can hand work to a Code swarm.' }
    return { ok: false, text: `Couldn’t check whether this hive can hand your words to a Code swarm: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!c.codeTeamOffer) return { ok: false, text: NO_OFFER }
  let offer: CodeTeamOffer
  try {
    offer = await c.codeTeamOffer(ctx)
  } catch (e) {
    return { ok: false, text: offerWords(e) }
  }
  return { ok: true, offer, copyApply: await copyApplyState(client, ctx, wsId) }
}

const ZERO_APPLICATION = `application_${'0'.repeat(32)}`

/**
 * Is the host's copy-apply switched on? Read from the relay's real answer for an application read (no write): held, the
 * hive itself answers 404 not_relayed (code.py:587-588); on, the read reaches OmegaCode, which answers for itself
 * (404 not_found for an id it never issued). Anything else is "unknown", which keeps the confirm.
 */
export async function copyApplyState(client: HiveClient | null, ctx: CodeContext, wsId: string): Promise<CopyApply> {
  if (!client?.codeProxy) return 'off'
  try {
    await client.codeProxy('GET', `/v1/workspaces/${wsId}/proposal-applications/${ZERO_APPLICATION}`, { task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id })
    return 'on'
  } catch (e) {
    if (!(e instanceof ApiError)) return 'unknown'
    if (e.source === 'omegacode') return 'on'
    if (e.code === 'not_relayed') return 'off'
    return 'unknown'
  }
}

/** Plain words for a refusal on record or submit (codes from ask_intents.py a.6 and r2.13.1 instruct). */
export function intentWords(e: unknown): string {
  if (e instanceof IntentContractError) return `${e.message}. Nothing is shown from it.`
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e)
  const w: Record<string, string> = {
    person_required: 'Only a named, signed-in admin can hand work to a Code swarm on this hive.',
    intent_pending: 'This Ask turn already has a different change waiting to be sent.',
    intent_in_flight: 'This change is still being handed over. Wait a moment.',
    intent_closed: 'That request was withdrawn before it was sent.',
    not_available: 'The Ask turn for this request is no longer there (or is more than a day old). Ask again.',
    origin_not_held: 'You did not open this coding work, so you cannot hand it to a swarm.',
    grant_inactive: 'Your edit grant on this work has ended. Open the code again.',
    not_offered: 'That swarm does not take code changes.',
    template_unknown: 'The swarm’s minds named for this request are not registered for it.',
    spend_limit: 'The request is over a spending limit (yours or the swarm’s), so nothing was sent.',
    spawn_disabled: 'This hive has not switched on starting minds for requests.',
    operation_conflict: 'This request’s record does not match; nothing was created.',
    origin_required: 'This page’s address is not one the hive accepts for this.',
    origin_refused: 'This page’s address is not one the hive accepts for this.',
  }
  return w[e.code] ?? `${e.message} (${e.code}).`
}

/**
 * Steps 2-3: record the intent on the person's Ask turn, then submit it. A dispatch already in flight (409
 * intent_in_flight) is waited for by reading the intent; an answer that is lost (no status) is settled by reading the
 * intent, never by sending again under a new key.
 */
export async function recordAndSubmit(
  client: HiveClient,
  turnOp: string,
  body: IntentRecordBody,
  wait: (ms: number) => Promise<void>,
  stillWanted: () => boolean,
): Promise<{ intent: IntentView; admission: Admission | null; request_id: string }> {
  const c = intentsClient(client)!
  const intent = parseIntentView(await c.askRecordIntent(turnOp, body))
  if (!stillWanted()) return { intent, admission: null, request_id: '' }
  try {
    const admission = parseAdmission(await c.askSubmitIntent(intent.intent_id))
    return { intent, admission, request_id: admission.request_id }
  } catch (e) {
    const settleByRow = e instanceof ApiError && (e.code === 'intent_in_flight' || e.status === 0 || e.status >= 500)
    if (!settleByRow) throw e
  }
  for (let i = 0; i < 30 && stillWanted(); i++) {
    const v = parseIntentView(await c.askIntent(intent.intent_id), { intent_id: intent.intent_id })
    if (v.state === 'linked' && v.request_id) return { intent: v, admission: null, request_id: v.request_id }
    if (v.state === 'refused') throw new ApiError(409, v.last_refusal?.code ?? 'refused', 'The swarm refused the request.')
    if (v.state === 'abandoned') throw new ApiError(409, 'intent_closed', 'The request was withdrawn.')
    if (v.state === 'pending') throw new Error('The request was not sent (its answer was lost and the hive did not create it). Ask again.')
    await wait(1000)
  }
  throw new Error('The hive has not said whether the request was created. It will appear in the drawer’s Proposals if it was.')
}

/**
 * Has the team started work on THIS request? (r4 [P2] spawn-off) Read from the hive's own answers, never assumed:
 *  - GET /api/teams/{to_swarm}/children (minds.py team_children; pages of children, each with its request_id and state):
 *    a child for this request means a mind was started for it;
 *  - GET /api/requests (collab.py request_view): the request's own state (failed or cancelled ends the wait) and its
 *    result; a result naming spawn_disabled is the hive refusing to start a mind.
 * The host admits a request (minds.instruct) before any mind is started and refuses a start (spawn_disabled) only to
 * the team's controller, so "admitted" alone never means "working".
 */
export type Progress = { started: boolean; refused: 'spawn_disabled' | null; closed: 'failed' | 'cancelled' | 'completed' | null }
export async function requestProgress(client: HiveClient, toSwarm: string, requestId: string): Promise<Progress | null> {
  if (!client.teamChildren) return null
  let started = false
  let cursor: string | undefined
  for (let i = 0; i < 5 && !started; i++) {
    const raw = await client.teamChildren(toSwarm, cursor)
    if (!obj(raw) || !Array.isArray(raw.children)) throw new Error('The swarm’s minds were not understood.')
    started = raw.children.some((c) => obj(c) && c.request_id === requestId && c.state !== 'failed')
    if (typeof raw.next_cursor !== 'string' || !raw.next_cursor) break
    cursor = raw.next_cursor
  }
  let refused: Progress['refused'] = null
  let closed: Progress['closed'] = null
  if (client.listRequests) {
    const row = (await client.listRequests()).find((r) => r.id === requestId)
    if (row) {
      if (row.state === 'failed' || row.state === 'cancelled' || row.state === 'completed') closed = row.state
      if (JSON.stringify(row.result ?? null).includes('spawn_disabled')) refused = 'spawn_disabled'
    }
  }
  return { started, refused, closed }
}

/** At most this many history pages (of 20) are walked in one look. */
export const HISTORY_PAGES = 10
/**
 * Step 4, one look: the CANDIDATES on exactly this scope (a discovery hint only; Code: a scope does not prove a request),
 * newest first, leaving out `skip`. The history is newest first in pages of 20; the walk follows next_cursor until a
 * candidate, the end, HISTORY_PAGES, or the request/identity is no longer live.
 */
export async function proposalsOnScope(client: HiveClient, ctx: CodeContext, wsId: string, scopeId: string, live: () => boolean = () => true, skip: ReadonlySet<string> = new Set()): Promise<string[]> {
  let cursor: string | undefined
  for (let i = 0; i < HISTORY_PAGES && live(); i++) {
    const page = parseHistoryPage(await client.codeSuggestionHistory!(ctx, wsId, { limit: 20, ...(cursor ? { cursor } : {}) }), wsId)
    const hits = page.items.filter((it) => it.scope_id === scopeId && !skip.has(it.id)).map((it) => it.id)
    if (hits.length) return hits
    if (!page.next_cursor) return []
    cursor = page.next_cursor
  }
  return []
}

/** What this page sent, for checking a proposal's retained request provenance against it. */
export interface SentRequest {
  request_id: string
  task_id: string
  repository_id: string
  workspace_id: string
  origin_scope: { scope_id: string; scope_digest: string; generation: number }
}
const SAFE_REF = (v: unknown) => typeof v === 'string' && v.length > 0 && !/[\s()"\\/]/.test(v)

/**
 * Read one candidate with its request provenance (GET …/suggestions/{id}?include_request_binding=true; Code bdfb0591
 * api.py:622-624, suggestions.py:286-299) and decide whether it is THIS request's proposal:
 *  - request_binding is {digest, content}; digest = sha256(canonical(content)) exactly (Code store.blob over common.canonical);
 *  - content: schema omegacode-request-proposal-v1, this workspace, this proposal (id, digest, author), this origin task and
 *    repository; content.delegated has exactly {request_id, controller_id, execution_goal, issuer, origin_scope} with
 *    request_id and origin_scope {scope_id, scope_digest, generation} equal to what was sent, and a person issuer.
 * Returns the read (without request_binding) when it is ours; null when it is not (missing, null, foreign or tampered).
 */
export async function readIfOurs(client: HiveClient, ctx: CodeContext, wsId: string, id: string, sent: SentRequest): Promise<unknown | null> {
  const raw = await client.codeProxy!<unknown>('GET', `/v1/workspaces/${wsId}/suggestions/${id}`, { task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id, include_request_binding: 'true' })
  if (!obj(raw) || !obj(raw.record)) return null
  const { request_binding: rb, ...read } = raw
  if (!obj(rb) || typeof rb.digest !== 'string' || !HEX64.test(rb.digest) || !obj(rb.content)) return null
  let digest: string
  try {
    digest = await sha256Text(canonical(rb.content))
  } catch {
    return null
  }
  if (digest !== rb.digest) return null
  const c = rb.content
  const rec = raw.record
  if (c.schema !== 'omegacode-request-proposal-v1' || c.workspace_id !== wsId || c.workspace_id !== sent.workspace_id) return null
  if (c.proposal_id !== rec.id || c.proposal_id !== id || c.proposal_digest !== rec.digest || c.author !== rec.author) return null
  if (c.origin_task_id !== sent.task_id || c.repository_id !== sent.repository_id) return null
  const d = c.delegated
  if (!obj(d) || Object.keys(d).sort().join() !== 'controller_id,execution_goal,issuer,origin_scope,request_id') return null
  if (d.request_id !== sent.request_id || !SAFE_REF(d.controller_id) || !SAFE_REF(d.execution_goal)) return null
  if (typeof d.issuer !== 'string' || !d.issuer.startsWith('user:') || d.issuer === 'user:operator') return null
  const s = d.origin_scope
  if (!obj(s) || Object.keys(s).sort().join() !== 'generation,scope_digest,scope_id') return null
  if (s.scope_id !== sent.origin_scope.scope_id || s.scope_digest !== sent.origin_scope.scope_digest || s.generation !== sent.origin_scope.generation) return null
  return read
}

export interface Application {
  id: string
  suggestion_id: string
  suggestion_digest: string
  change_id: string
  paths: string[]
  after_generation: number
  after_tree_digest: string
  currency: 'current' | 'stale' | 'undone'
  workspace: WorkspaceHead
  /**
   * The host's evidence of which consent this application was made under (r5; Platform is adding consent_id and
   * applied_at to the copy-apply application record). null: the record carries no such fields (today's host), so
   * whether the person's OK authorized it cannot be told from here.
   */
  evidence: { consent_id: string | null; applied_at: string | null } | null
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const HEX64 = /^[0-9a-f]{64}$/
const APP_ID = /^application_[0-9a-f]{32}$/

function head(v: unknown, wsId: string): WorkspaceHead | null {
  if (!obj(v) || v.id !== wsId || typeof v.generation !== 'number' || typeof v.tree_digest !== 'string' || !HEX64.test(v.tree_digest)) return null
  return v as unknown as WorkspaceHead
}

/**
 * Step 5, one look at the workspace journal (GET /v1/events?workspace_id&after): the controller's application of THIS
 * proposal (same id and digest), and the cursor to read on from.
 */
export async function applicationInJournal(client: HiveClient, ctx: CodeContext, wsId: string, read: SuggestionRead, after: number): Promise<{ id: string | null; after: number }> {
  const raw = await client.codeProxy!<unknown>('GET', '/v1/events', { task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id, workspace_id: wsId, after: String(after) })
  const events = obj(raw) && Array.isArray(raw.events) ? raw.events : null
  if (!events) throw new Error('The workspace journal answer was not understood.')
  let last = after
  let id: string | null = null
  for (const e of events) {
    if (!obj(e)) continue
    if (typeof e.seq === 'number' && e.seq > last) last = e.seq
    const b = e.body
    if (e.kind === 'proposal.copy_applied' && obj(b) && b.workspace_id === wsId && b.suggestion_id === read.record.id && b.suggestion_digest === read.record.digest && typeof b.id === 'string' && APP_ID.test(b.id)) id = b.id
  }
  return { id, after: last }
}

/** Read one application through the person relay (GET …/proposal-applications/{id}, read), strictly. */
export async function readApplication(client: HiveClient, ctx: CodeContext, wsId: string, id: string, read: SuggestionRead): Promise<Application> {
  const raw = await client.codeProxy!<unknown>('GET', `/v1/workspaces/${wsId}/proposal-applications/${id}`, { task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id })
  const bad = (why: string): never => {
    throw new Error(`The applied change was not understood (${why}).`)
  }
  if (!obj(raw) || !obj(raw.application)) return bad('no application')
  const a = raw.application
  if (a.id !== id || a.workspace_id !== wsId) bad('another application')
  if (a.suggestion_id !== read.record.id || a.suggestion_digest !== read.record.digest) bad('another proposal')
  if (typeof a.after_generation !== 'number' || typeof a.after_tree_digest !== 'string' || !HEX64.test(a.after_tree_digest)) bad('after')
  if (!Array.isArray(a.paths) || !a.paths.every((p) => typeof p === 'string')) bad('paths')
  if (typeof a.change_id !== 'string') bad('change')
  if (raw.currency !== 'current' && raw.currency !== 'stale' && raw.currency !== 'undone') bad('currency')
  const ws = head(raw.workspace, wsId) ?? bad('workspace')
  let evidence: Application['evidence'] = null
  if ('consent_id' in a || 'applied_at' in a) {
    if (a.consent_id !== null && (typeof a.consent_id !== 'string' || !/^cns_[0-9a-f]{32}$/.test(a.consent_id))) bad('consent_id')
    if (a.applied_at !== null && (typeof a.applied_at !== 'string' || Number.isNaN(Date.parse(a.applied_at)))) bad('applied_at')
    evidence = { consent_id: (a.consent_id as string | null) ?? null, applied_at: (a.applied_at as string | null) ?? null }
  }
  return { id, suggestion_id: read.record.id, suggestion_digest: read.record.digest, change_id: a.change_id as string, paths: a.paths as string[], after_generation: a.after_generation as number, after_tree_digest: a.after_tree_digest as string, currency: raw.currency as Application['currency'], workspace: ws, evidence }
}

/**
 * Undo one application (POST …/proposal-applications/{id}/undo; person-only, the person's own edit grant). The body is
 * Code's closed one, bound to the application's AFTER state; the same operation id on a retry returns the original.
 */
export async function undoApplication(client: HiveClient, ctx: CodeContext, wsId: string, app: Application, operationId: string): Promise<{ workspace: WorkspaceHead; change_id: string }> {
  const raw = await client.codeProxy!<unknown>('POST', `/v1/workspaces/${wsId}/proposal-applications/${app.id}/undo`, { task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id }, { operation_id: operationId, expected_generation: app.after_generation, expected_tree_digest: app.after_tree_digest })
  if (!obj(raw) || raw.undo_of !== app.id || raw.workspace_id !== wsId || typeof raw.change_id !== 'string') throw new Error('The Undo answer was not understood.')
  const ws = head(raw.workspace, wsId)
  if (!ws) throw new Error('The Undo answer did not say where your copy is now.')
  return { workspace: ws, change_id: raw.change_id }
}

/** Plain words for an Undo that did not happen. */
export function undoWords(e: unknown): { text: string; retry: boolean } {
  if (e instanceof ApiError) {
    if (e.code === 'already_undone') return { text: 'It was already undone.', retry: false }
    if (e.code === 'undo_stale' || e.code === 'stale_workspace') return { text: 'Your copy changed after this was put in, so Undo can’t put it back without losing the later work. Change it by hand, or ask again.', retry: false }
    if (e.code === 'edit_grant_required' || e.code === 'person_required') return { text: 'Undo needs your own edit grant on this work. Open the code again.', retry: false }
    if (e.code === 'not_relayed') return { text: 'This hive no longer relays Undo for applied changes.', retry: false }
    if (e.status === 0 || e.status >= 500) return { text: `No answer from the code service (${e.code}). Undo again sends the same request; it is never done twice.`, retry: true }
    return { text: `${e.message} (${e.code}).`, retry: false }
  }
  return { text: e instanceof Error ? e.message : String(e), retry: true }
}
