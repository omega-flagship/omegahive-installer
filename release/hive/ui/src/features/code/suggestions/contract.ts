/**
 * The retained scoped-suggestion contract, exactly as implemented by the OmegaCode service candidate
 * (SCOPED_SUGGESTIONS_IMPLEMENTATION.md + SUGGESTION_HISTORY_IMPLEMENTATION.md; field shapes read
 * from omegacode/src/omegacode/suggestions.py and suggestion_validation.py, read-only). The illustrative v1 object in
 * OMEGACODE_REPLY_TO_SURFACE.md §1 is NOT this contract: no rationale, request/model attribution or aggregate status.
 *
 * Parsing is strict: a response that does not match is refused, never guessed at. Integrity (record digest, normalized
 * digest, hunk IDs) is re-derived in the browser with the service's own canonical JSON, so a decision can only bind
 * what was actually retained.
 */

export const SUGGESTION_SCHEMA = 'omegacode-scoped-suggestion-v1'

/**
 * The one field the panel reads that the service contract does NOT have (proposed to Code, see the report):
 * hunk IDs that must be decided together. Absent in every real service response today; when absent every hunk is
 * its own group. The sim carries it on one invented proposal, inside the digest-covered content.
 */
export const PROPOSED_EXTENSION_GROUPS = 'hunk_groups'

export interface SuggestionBinding {
  workspace_id: string
  task_id: string
  generation: number
  tree_digest: string
}
export interface SuggestionHunk {
  id: string
  path: string
  start_byte: number
  end_byte: number
  replacement: string
  before_digest: string
  expected_file_digest: string
}
/** `content`: the retained blob. `digest` is the inner normalized digest (NOT what a decision binds). */
export interface SuggestionContent {
  schema: typeof SUGGESTION_SCHEMA
  binding: SuggestionBinding
  scope: Record<string, [number, number][]>
  hunks: SuggestionHunk[]
  digest: string
  scope_id: string
  author: string
  /** Dependent groups (frozen584e source; used only when the loaded service declares dependent-suggestion-groups). */
  hunk_groups?: string[][]
  /**
   * The author's plain explanation (Codex owner ruling §1, in qualification): retained in the content the record
   * digest covers; not a verified quality claim. Shown only when the loaded service declares proposal-plain-summary.
   */
  plain_summary?: { what: string; why: string }
}
/** `record`: server-issued identity; `record.digest` is the exact custodied artifact digest a decision binds. */
export interface SuggestionRecord {
  id: string
  workspace_id: string
  scope_id: string
  digest: string
  author: string
  created_at: number
}
export interface SuggestionDecisionRecord {
  id: string
  suggestion_id: string
  suggestion_digest: string
  workspace_id: string
  actor: string
  accepted_hunk_ids: string[]
  rejected_hunk_ids: string[]
  change_id: string | null
  created_at: number
}
export type Currency = 'current' | 'stale'
export interface SuggestionRead {
  record: SuggestionRecord
  content: SuggestionContent
  decisions: SuggestionDecisionRecord[]
  currency: Currency
}
export interface SuggestionScopeRecord {
  id: string
  workspace_id: string
  digest: string
  author: string
  created_at: number
}
export interface SuggestionHistoryItem extends SuggestionRecord {
  generation: number
  tree_digest: string
  currency: Currency
  hunk_count: number
  accepted_count: number
  rejected_count: number
}
export interface SuggestionHistoryPage {
  workspace_id: string
  generation: number
  tree_digest: string
  items: SuggestionHistoryItem[]
  next_cursor: string | null
}
export interface ChangeSet {
  id: string
  workspace_id: string
  task_id: string
  author: string
  base_commit: string
  before_digest: string
  tree_digest: string
  generation: number
  paths: string[]
  created_at: number
  diff_digest: string
}
export interface WorkspaceHead {
  id: string
  generation: number
  tree_digest: string
  base_commit: string
}
/** Acceptance returns the edit result plus the decision; rejection returns workspace + decision only. */
export interface SuggestionDecisionResult {
  workspace: WorkspaceHead
  change?: ChangeSet
  decision: SuggestionDecisionRecord
}

// ------------------------------------------------------------------------------------------ requests (closed shapes)

export interface SuggestionScopeRequest {
  operation_id: string
  approval_id?: string
  expected_generation: number
  expected_tree_digest: string
  ranges: Record<string, [number, number][]>
}
export interface SuggestionCreateRequest {
  operation_id: string
  approval_id?: string
  scope_id: string
  hunks: { path: string; start_byte: number; end_byte: number; replacement: string; before_digest: string }[]
}
export interface SuggestionDecisionRequest {
  operation_id: string
  approval_id?: string
  suggestion_id: string
  suggestion_digest: string
  expected_generation: number
  expected_tree_digest: string
  accepted_hunk_ids: string[]
  rejected_hunk_ids: string[]
}

// ------------------------------------------------------------------------------------------ parsing

export class ContractError extends Error {
  readonly problems: string[]
  constructor(what: string, problems: string[]) {
    super(`${what} does not match the retained suggestion contract: ${problems.slice(0, 4).join('; ')}${problems.length > 4 ? ` (+${problems.length - 4} more)` : ''}`)
    this.problems = problems
  }
}

const HEX64 = /^[a-f0-9]{64}$/
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

class Check {
  problems: string[] = []
  need(ok: boolean, what: string) {
    if (!ok) this.problems.push(what)
    return ok
  }
  keys(v: Record<string, unknown>, where: string, required: string[], optional: string[] = []) {
    for (const k of required) this.need(k in v, `${where}.${k} missing`)
    for (const k of Object.keys(v)) this.need(required.includes(k) || optional.includes(k), `${where}.${k} is not a contract field`)
  }
}

function checkRecord(c: Check, r: unknown, where: string): r is SuggestionRecord {
  if (!c.need(obj(r), `${where} is not an object`)) return false
  const v = r as Record<string, unknown>
  c.keys(v, where, ['id', 'workspace_id', 'scope_id', 'digest', 'author', 'created_at'])
  c.need(str(v.id, 160), `${where}.id`)
  c.need(str(v.workspace_id, 160), `${where}.workspace_id`)
  c.need(str(v.scope_id, 160), `${where}.scope_id`)
  c.need(typeof v.digest === 'string' && HEX64.test(v.digest), `${where}.digest is not a sha256`)
  c.need(str(v.author), `${where}.author`)
  c.need(num(v.created_at), `${where}.created_at`)
  return true
}

function checkDecision(c: Check, d: unknown, i: number): d is SuggestionDecisionRecord {
  const where = `decisions[${i}]`
  if (!c.need(obj(d), `${where} is not an object`)) return false
  const v = d as Record<string, unknown>
  c.keys(v, where, ['id', 'suggestion_id', 'suggestion_digest', 'workspace_id', 'actor', 'accepted_hunk_ids', 'rejected_hunk_ids', 'change_id', 'created_at'])
  c.need(str(v.id, 160), `${where}.id`)
  c.need(typeof v.suggestion_digest === 'string' && HEX64.test(v.suggestion_digest), `${where}.suggestion_digest`)
  c.need(Array.isArray(v.accepted_hunk_ids) && v.accepted_hunk_ids.every((x) => typeof x === 'string'), `${where}.accepted_hunk_ids`)
  c.need(Array.isArray(v.rejected_hunk_ids) && v.rejected_hunk_ids.every((x) => typeof x === 'string'), `${where}.rejected_hunk_ids`)
  c.need(v.change_id === null || str(v.change_id, 160), `${where}.change_id`)
  c.need(num(v.created_at), `${where}.created_at`)
  c.need(str(v.actor), `${where}.actor`)
  return true
}

/** Strictly parse GET /v1/workspaces/{id}/suggestions/{suggestion_id}. Throws ContractError listing every mismatch. */
export function parseSuggestionRead(raw: unknown, expect?: { workspace_id?: string; suggestion_id?: string }): SuggestionRead {
  const c = new Check()
  if (!obj(raw)) throw new ContractError('The proposal', ['response is not an object'])
  c.keys(raw, 'response', ['record', 'content', 'decisions', 'currency'])
  const { record, content, decisions, currency } = raw
  checkRecord(c, record, 'record')
  c.need(currency === 'current' || currency === 'stale', 'currency is neither current nor stale')
  c.need(Array.isArray(decisions), 'decisions is not a list')
  if (obj(content)) {
    c.keys(content, 'content', ['schema', 'binding', 'scope', 'hunks', 'digest', 'scope_id', 'author'], [PROPOSED_EXTENSION_GROUPS, 'plain_summary'])
    if (content.plain_summary !== undefined) {
      const ps = content.plain_summary
      if (c.need(obj(ps), 'content.plain_summary is not an object')) {
        c.keys(ps as Record<string, unknown>, 'content.plain_summary', ['what', 'why'])
        const v = ps as Record<string, unknown>
        const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && Array.from(x).length <= 2000 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(x.replace(/[\n\t]/g, ''))
        c.need(text(v.what) && text(v.why), 'content.plain_summary what/why must be nonblank text of at most 2000 Unicode code points, without forbidden controls')
        if (text(v.what) && text(v.why)) c.need(new TextEncoder().encode(canonical(ps)).length <= 8192, 'content.plain_summary exceeds8192 UTF-8 bytes')
      }
    }
    c.need(content.schema === SUGGESTION_SCHEMA, `content.schema is not ${SUGGESTION_SCHEMA}`)
    c.need(typeof content.digest === 'string' && HEX64.test(content.digest), 'content.digest is not a sha256')
    const b = content.binding
    if (c.need(obj(b), 'content.binding missing')) {
      const bv = b as Record<string, unknown>
      c.keys(bv, 'content.binding', ['workspace_id', 'task_id', 'generation', 'tree_digest'])
      c.need(nat(bv.generation) && (bv.generation as number) >= 1, 'content.binding.generation is not a positive integer')
      c.need(typeof bv.tree_digest === 'string' && HEX64.test(bv.tree_digest), 'content.binding.tree_digest is not a sha256')
      c.need(str(bv.workspace_id, 160) && str(bv.task_id, 160), 'content.binding workspace/task')
    }
    const scope = content.scope
    const scopeOk = c.need(obj(scope) && Object.keys(scope).length >= 1 && Object.keys(scope).length <= 100, 'content.scope needs 1–100 paths')
    if (scopeOk) {
      for (const [p, ranges] of Object.entries(scope as Record<string, unknown>)) {
        c.need(Array.isArray(ranges) && ranges.length >= 1 && ranges.length <= 100 && ranges.every((r) => Array.isArray(r) && r.length === 2 && nat(r[0]) && nat(r[1]) && r[0] <= r[1]), `content.scope[${p}] ranges`)
      }
    }
    const hunks = content.hunks
    if (c.need(Array.isArray(hunks) && hunks.length >= 1 && hunks.length <= 1000, 'content.hunks needs 1–1000 hunks')) {
      const ids = new Set<string>()
      ;(hunks as unknown[]).forEach((h, i) => {
        const where = `content.hunks[${i}]`
        if (!obj(h)) return void c.need(false, `${where} is not an object`)
        c.keys(h, where, ['id', 'path', 'start_byte', 'end_byte', 'replacement', 'before_digest', 'expected_file_digest'])
        c.need(typeof h.id === 'string' && HEX64.test(h.id) && !ids.has(h.id), `${where}.id is not a unique sha256`)
        if (typeof h.id === 'string') ids.add(h.id)
        c.need(nat(h.start_byte) && nat(h.end_byte) && (h.start_byte as number) <= (h.end_byte as number), `${where} byte range`)
        c.need(typeof h.replacement === 'string', `${where}.replacement`)
        c.need(typeof h.before_digest === 'string' && HEX64.test(h.before_digest), `${where}.before_digest`)
        c.need(typeof h.expected_file_digest === 'string' && HEX64.test(h.expected_file_digest), `${where}.expected_file_digest`)
        const ranges = scopeOk && typeof h.path === 'string' ? (scope as Record<string, [number, number][]>)[h.path] : undefined
        c.need(!!ranges && ranges.some(([a, z]) => a <= (h.start_byte as number) && (h.end_byte as number) <= z), `${where} lies outside the retained scope`)
      })
      const groups = content[PROPOSED_EXTENSION_GROUPS]
      if (groups !== undefined) {
        const seen = new Set<string>()
        c.need(
          Array.isArray(groups) && groups.every((g) => Array.isArray(g) && g.length >= 2 && g.every((id) => typeof id === 'string' && ids.has(id) && !seen.has(id) && !!seen.add(id))),
          `content.${PROPOSED_EXTENSION_GROUPS} must list disjoint groups of 2+ known hunk IDs`,
        )
      }
    }
    c.need(str(content.scope_id, 160), 'content.scope_id')
    c.need(str(content.author), 'content.author')
  } else c.need(false, 'content is not an object')
  if (Array.isArray(decisions)) decisions.forEach((d, i) => checkDecision(c, d, i))
  if (!c.problems.length) {
    const r = record as SuggestionRecord
    const ct = content as unknown as SuggestionContent
    c.need(r.workspace_id === ct.binding.workspace_id, 'record.workspace_id differs from content.binding.workspace_id')
    c.need(r.scope_id === ct.scope_id, 'record.scope_id differs from content.scope_id')
    c.need(r.author === ct.author, 'record.author differs from content.author')
    if (expect?.workspace_id) c.need(r.workspace_id === expect.workspace_id, 'proposal belongs to another workspace')
    if (expect?.suggestion_id) c.need(r.id === expect.suggestion_id, 'a different proposal answered')
    const known = new Set(ct.hunks.map((h) => h.id))
    const decided = new Set<string>()
    for (const d of decisions as SuggestionDecisionRecord[]) {
      c.need(d.suggestion_id === r.id && d.suggestion_digest === r.digest, `decision ${d.id} binds another proposal or digest`)
      for (const id of [...d.accepted_hunk_ids, ...d.rejected_hunk_ids]) {
        c.need(known.has(id), `decision ${d.id} names an unknown hunk`)
        c.need(!decided.has(id), `hunk ${id.slice(0, 12)} is decided twice`)
        decided.add(id)
      }
      c.need(d.accepted_hunk_ids.length === 0 || !!d.change_id, `decision ${d.id} accepted hunks without a ChangeSet`)
    }
  }
  if (c.problems.length) throw new ContractError('The proposal', c.problems)
  return raw as unknown as SuggestionRead
}

/** Strictly parse a history page (GET /v1/workspaces/{id}/suggestions). */
export function parseHistoryPage(raw: unknown, workspaceId: string): SuggestionHistoryPage {
  const c = new Check()
  if (!obj(raw)) throw new ContractError('The proposal list', ['response is not an object'])
  c.keys(raw, 'page', ['workspace_id', 'generation', 'tree_digest', 'items', 'next_cursor'])
  c.need(raw.workspace_id === workspaceId, 'page belongs to another workspace')
  c.need(nat(raw.generation), 'page.generation')
  c.need(typeof raw.tree_digest === 'string' && HEX64.test(raw.tree_digest), 'page.tree_digest')
  c.need(raw.next_cursor === null || (typeof raw.next_cursor === 'string' && raw.next_cursor.length <= 512), 'page.next_cursor')
  if (c.need(Array.isArray(raw.items) && raw.items.length <= 20, 'page.items needs at most 20 items')) {
    ;(raw.items as unknown[]).forEach((it, i) => {
      const where = `items[${i}]`
      if (!obj(it)) return void c.need(false, `${where} is not an object`)
      c.keys(it, where, ['id', 'workspace_id', 'scope_id', 'digest', 'author', 'created_at', 'generation', 'tree_digest', 'currency', 'hunk_count', 'accepted_count', 'rejected_count'])
      c.need(it.workspace_id === workspaceId, `${where} belongs to another workspace`)
      c.need(typeof it.digest === 'string' && HEX64.test(it.digest), `${where}.digest`)
      c.need(it.currency === 'current' || it.currency === 'stale', `${where}.currency`)
      c.need(nat(it.hunk_count) && nat(it.accepted_count) && nat(it.rejected_count), `${where} counts`)
      c.need(str(it.id, 160) && num(it.created_at), `${where} identity`)
    })
  }
  if (c.problems.length) throw new ContractError('The proposal list', c.problems)
  return raw as unknown as SuggestionHistoryPage
}

/** Strictly parse a scope answer (POST suggestion-scopes): `{id, workspace_id, digest, author, created_at}`, nothing more. */
export function parseScopeRecord(raw: unknown, workspaceId: string): SuggestionScopeRecord {
  const c = new Check()
  if (!obj(raw)) throw new ContractError('The scope answer', ['response is not an object'])
  c.keys(raw, 'scope', ['id', 'workspace_id', 'digest', 'author', 'created_at'])
  c.need(str(raw.id, 160), 'scope.id')
  c.need(raw.workspace_id === workspaceId, 'scope belongs to another workspace')
  c.need(typeof raw.digest === 'string' && HEX64.test(raw.digest), 'scope.digest is not a sha256')
  c.need(str(raw.author), 'scope.author')
  c.need(num(raw.created_at), 'scope.created_at')
  if (c.problems.length) throw new ContractError('The scope answer', c.problems)
  return raw as unknown as SuggestionScopeRecord
}

/** Strictly parse a create answer (POST suggestions): the retained record, bound to the workspace and scope that were sent. */
export function parseCreateRecord(raw: unknown, sent: { workspace_id: string; scope_id: string }): SuggestionRecord {
  const c = new Check()
  checkRecord(c, raw, 'record')
  if (!c.problems.length) {
    const r = raw as SuggestionRecord
    c.need(r.workspace_id === sent.workspace_id, 'record belongs to another workspace')
    c.need(r.scope_id === sent.scope_id, 'record binds another scope')
  }
  if (c.problems.length) throw new ContractError('The suggestion answer', c.problems)
  return raw as SuggestionRecord
}

/** Parse a decision answer and check it is the answer to exactly the decision that was sent. */
export function parseDecisionResult(raw: unknown, sent: SuggestionDecisionRequest): SuggestionDecisionResult {
  const c = new Check()
  if (!obj(raw)) throw new ContractError('The decision answer', ['response is not an object'])
  const d = raw.decision
  if (c.need(obj(d), 'decision missing') && checkDecision(c, d, 0) && !c.problems.length) {
    const dv = d as SuggestionDecisionRecord
    c.need(dv.suggestion_id === sent.suggestion_id && dv.suggestion_digest === sent.suggestion_digest, 'decision answers another proposal')
    c.need(same(dv.accepted_hunk_ids, sent.accepted_hunk_ids) && same(dv.rejected_hunk_ids, sent.rejected_hunk_ids), 'decision records other hunks than were sent')
  }
  const w = raw.workspace
  c.need(obj(w) && nat(w.generation) && typeof w.tree_digest === 'string' && HEX64.test(w.tree_digest), 'workspace head missing')
  if (sent.accepted_hunk_ids.length) {
    const ch = raw.change
    c.need(obj(ch) && str(ch.id, 160) && nat(ch.generation) && Array.isArray(ch.paths), 'accepted hunks returned no ChangeSet')
    if (obj(ch) && obj(d)) c.need(ch.id === d.change_id, 'ChangeSet differs from the decision receipt')
    if (obj(ch)) c.need(ch.before_digest === sent.expected_tree_digest && ch.generation === sent.expected_generation + 1, 'ChangeSet does not start from the bound generation/tree')
  }
  if (c.problems.length) throw new ContractError('The decision answer', c.problems)
  return raw as unknown as SuggestionDecisionResult
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// ------------------------------------------------------------------------------------------ integrity (canonical JSON)

/** Python `json.dumps(v, sort_keys=True, separators=(',',':'), ensure_ascii=False)`, keys sorted by code point. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON here carries integers only')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (obj(value)) {
    const keys = Object.keys(value).sort(byCodePoint)
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  throw new Error('value is not JSON')
}
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number)
    if (d) return d
  }
  return x.length - y.length
}

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The service's hunk identity: sha256(canonical({binding, hunk-without-id})). */
export function hunkIdentityBody(binding: SuggestionBinding, h: Omit<SuggestionHunk, 'id'>) {
  const { path, start_byte, end_byte, replacement, before_digest, expected_file_digest } = h
  return { binding, hunk: { path, start_byte, end_byte, replacement, before_digest, expected_file_digest } }
}

/** The normalized (inner) digest covers schema, binding, scope, hunks and optional groups/plain_summary when present. */
export function normalizedBody(content: SuggestionContent): Record<string, unknown> {
  const body: Record<string, unknown> = { schema: content.schema, binding: content.binding, scope: content.scope, hunks: content.hunks }
  if (content.hunk_groups) body[PROPOSED_EXTENSION_GROUPS] = content.hunk_groups
  if (content.plain_summary !== undefined) body.plain_summary = content.plain_summary
  return body
}

export interface Integrity {
  ok: boolean
  problems: string[]
}
/**
 * Re-derive every identity a decision binds: each hunk ID, the inner normalized digest and record.digest (the custodied
 * artifact digest = sha256 of the canonical retained content). Any mismatch refuses decisions on this proposal.
 */
export async function verifyIntegrity(read: SuggestionRead): Promise<Integrity> {
  const problems: string[] = []
  for (const h of read.content.hunks) {
    if ((await sha256Text(canonical(hunkIdentityBody(read.content.binding, h)))) !== h.id) problems.push(`hunk ${h.id.slice(0, 12)} identity does not match its content`)
  }
  if ((await sha256Text(canonical(normalizedBody(read.content)))) !== read.content.digest) problems.push('normalized proposal digest does not match the hunks')
  if ((await sha256Text(canonical(read.content))) !== read.record.digest) problems.push('record digest does not match the retained content')
  return { ok: !problems.length, problems }
}

// ------------------------------------------------------------------------------------------ relayed routes

/**
 * The nine Workbench routes the live hive relays (platform hive/core/code.py PROXY_ROUTES at 60fa650, "OmegaReview next7",
 * read-only reference), each as (method, path pattern). The four run-result routes (POST /v1/runs/{id}/results, GET
 * run-results/{rr}, …/source, POST …/import) are HELD and not listed. The panel never decides availability from this
 * list: it decides from the hive's real answer (404 not_relayed). The list exists so tests can prove every call the
 * panel makes is one the host relays, and so the simulator can play a hive that does not relay them.
 */
export const WORKBENCH_RELAYED_ROUTES: readonly (readonly ['GET' | 'POST', RegExp])[] = [
  ['POST', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/suggestion-scopes$/],
  ['POST', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/function-scopes$/],
  ['POST', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/function-scope-preview$/],
  ['POST', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/suggestions$/],
  ['GET', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/suggestions$/],
  ['GET', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/suggestions\/[A-Za-z0-9_-]+$/],
  ['POST', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/suggestion-decisions$/],
  ['POST', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/iterations$/],
  ['GET', /^\/v1\/workspaces\/ws_[A-Za-z0-9_-]+\/iterations\/[A-Za-z0-9_-]+$/],
]
export const isWorkbenchRoute = (method: string, path: string) => WORKBENCH_RELAYED_ROUTES.some(([m, re]) => m === method && re.test(path))
