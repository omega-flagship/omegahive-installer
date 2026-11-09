/**
 * INVENTED DATA. A small in-browser stand-in for the OmegaCode service, for ONE invented repository
 * (`repo:sim-suggestions`), so the Code workbench and WorkbenchSuggestionPanel can be exercised in the simulator.
 *
 * It follows the implemented retained-suggestion contract (omegacode/src/omegacode/suggestions.py and
 * suggestion_validation.py, read-only reference): human-only scope minting, exact UTF-8 boundaries, before digests,
 * hunk IDs = sha256(canonical({binding, hunk})), record.digest = sha256(canonical(content)), decisions bound to the
 * proposal's own retained generation/tree, one atomic CAS edit per acceptance, same-operation retries returning the
 * original result, changed-payload refusal, stale remainder refusal and issuer liveness at decision time.
 *
 * Two things here are NOT the service contract and are labelled as such: `ask` (an invented mind turning a person's
 * instruction into hunks; no hive/service route carries an instruction today) and the proposed `hunk_groups`
 * extension (dependency groups, retained inside the digest-covered content). Nothing here is live evidence.
 *
 * Person-authored explicit hunks go through POST /suggestions exactly as the real route takes them (closed five-field
 * hunks, before_digest of the replaced saved bytes, inside the person's scope, author derived from the caller).
 *
 * `relay: false` plays a hive whose relay list lacks the Workbench routes: every one of the nine answers 404
 * not_relayed, exactly as hive/core/code.py does for an unlisted route.
 */
import { ApiError, type SimCodeFixture } from '../client'
import { canonical, isWorkbenchRoute, sha256Text, type SuggestionBinding } from '../../features/code/suggestions/contract'
import { SimProjectTests, type SimTestStart, type SimTestSource } from './projectTests'

/**
 * SIM ONLY (smoke and qualification): `?simbinding=none` retains no request provenance for the invented team's proposals
 * (an unbound or legacy proposal); `?simbinding=foreign` retains another request's. Either is "not yours" on the canvas.
 * `?simbinding=foreign-later`: the first provenance read of a proposal is its own; every later one names another request
 * (a re-read, after the proposal was shown, must say "not yours" and never swap anything in).
 */
const SIM_BINDING = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('simbinding') : null

const enc = new TextEncoder()
const bytesOf = (s: string) => enc.encode(s)
const HUMAN = 'user:you'
const MIND = 'agent:a_anvl09'
export const SIM_CODE_REPOSITORY = 'sim-suggestions'
export const SIM_CODE_TARGET = `repo:${SIM_CODE_REPOSITORY}`

/**
 * Surface request L (INVENTED): a repository the hive lists but the Code service has no editable copy of. With next10's
 * closed_reason (51a7ccc) it is closed and code/open is refused 409 not_editable before any task or grant; in the live
 * 0aa6330 shape (no closed_reason) it looks openable, code/open makes a task and grant, and the service then refuses
 * every relayed call with 403 repository_unregistered.
 */
export const SIM_UNREGISTERED_REPOSITORY = 'old-notebooks'
export const SIM_UNREGISTERED_TARGET = `repo:${SIM_UNREGISTERED_REPOSITORY}`

/** As hive/core/code.py:193-201 at 51a7ccc: why a sim target cannot be opened for editing, or null. */
export function simClosedReason(t: { id: string; commit?: string; private?: boolean; owner: string }): string | null {
  if (!t.commit) return 'it has no git source'
  if (t.private) return `it is private; its owner (${t.owner}) has to agree first`
  if (t.id !== SIM_CODE_TARGET) return 'the Code service has no editable copy of it registered'
  return null
}

/** The service's refusal of a repository it has no copy of, as relayed by the hive (code.py relayed_error). */
export const simRepositoryUnregistered = () => new ApiError(403, 'repository_unregistered', 'this repository is not registered for coding', { source: 'omegacode', upstreamStatus: 403 })

/** SIM ONLY (request L): the earlier edit sessions a browser may still hold. */
export type SimStaleSession = 'other-principal' | 'expired' | 'revoked' | 'own'

const FILES: Record<string, string> = {
  'README.md': '# Invented fixture repository\n\nSimulator data for the suggestion panel. Not a real project.\n',
  'src/greeting.py':
    '"""Invented fixture for the OmegaDots simulator. Not real data."""\n\n\ndef greet(name):\n    message = "Hello, " + name + "!"\n    print(message)\n    return message\n\n\ndef farewell(name):\n    return "Goodbye, " + name + " 👋"\n',
  // Invented: a longer file, so the canvas's minimap and scrolling have something to show.
  'src/inventory.py':
    '"""Invented fixture for the OmegaDots simulator: a small shelf inventory. Not real data."""\n\nfrom dataclasses import dataclass, field\n\n\n@dataclass\nclass Item:\n    name: str\n    count: int = 0\n    tags: list = field(default_factory=list)\n\n\nclass Shelf:\n    """A shelf of invented items, counted by name."""\n\n    def __init__(self, label):\n        self.label = label\n        self.items = {}\n\n    def add(self, name, count=1):\n        item = self.items.get(name)\n        if item is None:\n            item = Item(name)\n            self.items[name] = item\n        item.count += count\n        return item\n\n    def take(self, name, count=1):\n        item = self.items.get(name)\n        if item is None:\n            return 0\n        taken = min(count, item.count)\n        item.count -= taken\n        if item.count == 0:\n            del self.items[name]\n        return taken\n\n    def tag(self, name, label):\n        item = self.items.get(name)\n        if item is not None and label not in item.tags:\n            item.tags.append(label)\n\n    def total(self):\n        total = 0\n        for item in self.items.values():\n            total += item.count\n        return total\n\n    def tagged(self, label):\n        return [i.name for i in self.items.values() if label in i.tags]\n\n    def report(self):\n        lines = ["Shelf " + self.label]\n        for name in sorted(self.items):\n            item = self.items[name]\n            lines.append("  " + name + ": " + str(item.count))\n        lines.append("Total: " + str(self.total()))\n        return "\\n".join(lines)\n\n\ndef merge(a, b):\n    """A new shelf holding everything on both."""\n    out = Shelf(a.label + "+" + b.label)\n    for shelf in (a, b):\n        for item in shelf.items.values():\n            out.add(item.name, item.count)\n            for t in item.tags:\n                out.tag(item.name, t)\n    return out\n\n\ndef busiest(shelves):\n    best = None\n    for shelf in shelves:\n        if best is None or shelf.total() > best.total():\n            best = shelf\n    return best\n\n\ndef restock(shelf, wanted):\n    """Bring every wanted item up to its count; return what was added."""\n    added = {}\n    for name, count in wanted.items():\n        have = shelf.items[name].count if name in shelf.items else 0\n        if have < count:\n            shelf.add(name, count - have)\n            added[name] = count - have\n    return added\n\n\ndef empty_names(shelves):\n    names = set()\n    for shelf in shelves:\n        for item in shelf.items.values():\n            if item.count == 0:\n                names.add(item.name)\n    return sorted(names)\n',
  'src/units.py': '# Invented fixture: Ω units with non-ASCII text 😀\nOHM = "Ω"\n\n\ndef describe(value):\n    return str(value) + " " + OHM\n',
  'tests/test_greeting.py': 'from src.greeting import greet\n\n\ndef test_greet():\n    assert greet("Ada") == "Hello, Ada!"\n',
  // Same bytes as calculator.py in the live disposable repo:synthetic (sha256 e1a89402…7edc8), so the person-authored
  // rehearsal uses exactly the ranges of Jon's live step script (bytes 4–7 `add`, 28–29 `-`). Invented here, not read live.
  'calculator.py': 'def add(a, b):\n    return a - b\n',
}

interface Ws {
  id: string
  repository_id: string
  task_id: string
  swarm_id: string
  base_commit: string
  base_ref: string
  generation: number
  tree_digest: string
  base_tree_digest: string
  created_by: string
  created_at: number
  profile: string
  history: { generation: number; tree_digest: string; author: string; change_id?: string }[]
}
interface Scope {
  record: { id: string; workspace_id: string; digest: string; author: string; created_at: number }
  body: { workspace_id: string; task_id: string; generation: number; tree_digest: string; ranges: Record<string, [number, number][]>; file_digests: Record<string, string>; author: string }
  files: Record<string, string>
  epoch: number
}
interface Suggestion {
  record: { id: string; workspace_id: string; scope_id: string; digest: string; author: string; created_at: number }
  content: Record<string, unknown> & { binding: SuggestionBinding; hunks: Hunk[]; digest: string; scope_id: string; author: string; hunk_groups?: string[][] }
}
interface Hunk {
  id: string
  path: string
  start_byte: number
  end_byte: number
  replacement: string
  before_digest: string
  expected_file_digest: string
}
interface Decision {
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

const err = (status: number, code: string, message: string) => new ApiError(status, code, message)
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'])
const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
const now = () => Date.now() / 1000
const boundary = (data: Uint8Array, o: unknown): o is number => typeof o === 'number' && Number.isInteger(o) && o >= 0 && o <= data.length && (o === data.length || (data[o] & 0xc0) !== 0x80)

async function sha(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SimCodeOptions {
  /** false: the hive does not relay the nine Workbench routes (404 not_relayed). Default true (as live next7). */
  relay?: boolean
  /** The task this service's one workspace belongs to (each sim code/open is a fresh task with its own workspace). */
  task_id?: string
  workspace_id?: string
  swarm_id?: string
  /**
   * The host's copy-apply switch (HIVE_COPY_APPLY_CLAIMS; linkage slice 3). Off (the default, as on a hive that has not
   * switched it on): the application routes answer 404 not_relayed, as hive/core/code.py:587-588 does for held routes.
   * On: the person may read an application and Undo it; applying stays the team controller's (`applyAsController`).
   */
  copyApply?: boolean
}

const MAX_BYTES = 2 * 1024 * 1024
const pathOk = (p: unknown): p is string => typeof p === 'string' && !!p && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every((x) => x !== '' && x !== '.' && x !== '..')

export class SimCodeService {
  constructor(private readonly options: SimCodeOptions = {}) {}
  private ws: Ws | null = null
  private files = new Map<string, string>()
  private changes: Record<string, unknown>[] = []
  private scopes = new Map<string, Scope>()
  private suggestions = new Map<string, Suggestion>()
  private decisions: Decision[] = []
  private operations = new Map<string, { fingerprint: string; result: unknown }>()
  private epoch = 1
  private revokedEpochs = new Set<number>()
  private loseNext = false
  private baseFiles = new Map(Object.entries(FILES))
  private seeded = false

  // --------------------------------------------------------------------------------------------- fixtures

  async fixture(action: Exclude<SimCodeFixture, 'revoke-grant'>): Promise<string> {
    const ws = await this.workspaceOrCreate()
    if (action === 'external-edit') {
      const path = 'README.md'
      const before = this.files.get(path) ?? ''
      await this.commit(ws, MIND, { [path]: before + `\nEdited by another actor at generation ${ws.generation + 1} (invented).\n` })
      return `Another actor (${MIND}) saved README.md: the workspace is now generation ${ws.generation}. Proposals bound to earlier generations are stale.`
    }
    if (action === 'revoke-issuer') {
      this.revokedEpochs.add(this.epoch)
      this.epoch += 1
      return 'The grant that issued the existing scopes was revoked; you reopened under a renewed grant. Old scopes and their proposals can no longer be decided; a fresh scope is needed.'
    }
    this.loseNext = true
    return 'The next decision will be recorded by the service but its answer is lost in transit (outcome unknown).'
  }

  // --------------------------------------------------------------------------------------------- relay

  /** SIM smoke hook (?simhooks=1): hold the workspace journal's answers, as a slow relay would */
  journalHeld = false
  async proxy(method: 'GET' | 'POST', path: string, query: Record<string, string>, body: unknown): Promise<unknown> {
    while (this.journalHeld && path === '/v1/events') await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 90))
    const ws = await this.workspaceOrCreate()
    const p = path.split('?')[0]
    if (this.options.relay === false && isWorkbenchRoute(method, p)) throw err(404, 'not_relayed', `${method} ${p} is not available through the hive`)
    if (method === 'POST' && p === '/v1/workspaces') return this.view(ws)
    // SIM ONLY: the invented service's features (the real list is OmegaCode's GET /v1/capabilities)
    if (method === 'GET' && p === '/v1/capabilities') return { service: 'omegacode-simulator', features: ['source-tree', 'cas-edits', 'changes', 'frozen-runs', 'run-output-pages', 'dependent-suggestion-groups', 'proposal-plain-summary', 'language-server-queries', 'rename-preview', 'saved-completion-preview'] }
    const m = /^\/v1\/workspaces\/(ws_[A-Za-z0-9_-]+)(\/.*)?$/.exec(p)
    // /v1/runs… is not under /v1/workspaces: each run route is bound to its own workspace inside runRoute, exactly as
    // OmegaCode's service authorises a run against the run's workspace (service.run / run_output / cancel)
    if (!m && method === 'GET' && p === '/v1/events') {
      if (query.workspace_id !== ws.id) throw err(404, 'not_found', 'workspace not found')
      const after = Number(query.after ?? 0)
      return { events: this.events.filter((e) => e.seq > after).slice(0, 200) }
    }
    if (!m && /^\/v1\/runs(\/|$)/.test(p)) {
      const run = this.runRoute(ws, method, p, query, body)
      if (run) return run
    }
    if (!m) throw err(404, 'not_relayed', `${method} ${p} is not part of the simulator's invented code service`)
    if (m[1] !== ws.id) throw err(404, 'not_found', 'workspace not found')
    const rest = m[2] ?? ''
    const b = (body ?? {}) as Record<string, unknown>
    if (method === 'GET' && rest === '') return this.view(ws)
    if (method === 'GET' && rest === '/tree') {
      this.fresh(ws, query.expected_generation ? Number(query.expected_generation) : undefined)
      return { generation: ws.generation, tree_digest: ws.tree_digest, files: await Promise.all([...this.files.keys()].sort().map(async (f) => ({ path: f, digest: await sha(bytesOf(this.files.get(f) ?? '')), size: bytesOf(this.files.get(f) ?? '').length }))) }
    }
    if (method === 'GET' && rest === '/files') {
      this.fresh(ws, query.expected_generation ? Number(query.expected_generation) : undefined)
      const content = this.files.get(query.path ?? '')
      if (content === undefined) throw err(404, 'file_missing', 'no such file in this generation')
      return { path: query.path, content, digest: await sha(bytesOf(content)), generation: ws.generation, tree_digest: ws.tree_digest }
    }
    if (method === 'POST' && rest === '/patches') return this.patch(ws, b)
    if (method === 'GET' && rest === '/changes') return { workspace: this.view(ws), changes: this.changes, diff: this.diff() }
    if (method === 'GET' && rest === '/checkpoints') return { checkpoints: [] }
    if (method === 'POST' && rest === '/suggestion-scopes') return this.scope(ws, b)
    if (method === 'POST' && rest === '/function-scope-preview') return this.functionPreview(ws, b)
    if (method === 'POST' && rest === '/iterations') return this.retainIteration(ws, b)
    const iter = /^\/iterations\/([A-Za-z0-9_-]+)$/.exec(rest)
    if (method === 'GET' && iter) {
      const it = this.iterations.get(iter[1])
      if (!it || it.record.workspace_id !== ws.id) throw err(404, 'not_found', 'iteration not found')
      return structuredClone({ ...it, currency: it.content.generation === ws.generation && it.content.tree_digest === ws.tree_digest ? 'current' : 'historical' })
    }
    if (method === 'POST' && rest === '/function-scopes') {
      const allowed = ['operation_id', 'approval_id', 'expected_generation', 'expected_tree_digest', 'path', 'source_digest', 'caret_byte', 'selection_digest']
      if (Object.keys(b).some((k) => !allowed.includes(k))) throw err(422, 'validation_error', 'unknown function scope field')
      const pv = await this.functionPreview(ws, b)
      if (pv.selection_digest !== b.selection_digest) throw err(409, 'function_scope_stale', 'function preview identity changed')
      return this.scope(ws, { operation_id: b.operation_id, expected_generation: b.expected_generation, expected_tree_digest: b.expected_tree_digest, ranges: { [b.path as string]: [[pv.selection.start_byte, pv.selection.end_byte]] } })
    }
    if (method === 'POST' && rest === '/suggestions') return this.create(ws, b, HUMAN)
    if (method === 'GET' && rest === '/suggestions') return this.history(ws, query)
    const read = /^\/suggestions\/([A-Za-z0-9_-]+)$/.exec(rest)
    if (method === 'GET' && read) {
      const r: Record<string, unknown> = this.read(ws, read[1])
      // include_request_binding=true (Code api.py:622-624): the retained request provenance, or null (unbound/legacy)
      if (query.include_request_binding === 'true') {
        r.request_binding = structuredClone(this.provenance.get(read[1]) ?? null)
        const n = (this.bindingReads.get(read[1]) ?? 0) + 1
        this.bindingReads.set(read[1], n)
        const rb = r.request_binding as { content: { delegated: Record<string, unknown> } } | null
        if (SIM_BINDING === 'foreign-later' && n > 1 && rb) rb.content.delegated.request_id = 'rq_someone_else'
      }
      return r
    }
    const tests = /^\/suggestions\/(suggestion_[a-f0-9]{32})\/project-tests$/.exec(rest)
    if (method === 'GET' && tests) {
      if (!this.suggestions.has(tests[1])) throw err(404, 'not_found', 'proposal not found')
      return this.projectTests.page(tests[1], ws, query)
    }
    if (method === 'POST' && rest === '/suggestion-decisions') return this.decide(ws, b)
    if (rest.startsWith('/language')) return this.language(ws, method, rest, b)
    if (rest.startsWith('/proposal-applications')) return this.applicationRoute(ws, method, rest, b)
    throw err(404, 'not_relayed', `${method} ${p} is not part of the simulator's invented code service`)
  }

  /** SIM ONLY: an invented mind turns the instruction into hunks inside the scope and files them as an agent. */
  /** SIM ONLY: the retained request provenance of a delegated child's proposal (Code suggestions.py:261-268). */
  private bindingReads = new Map<string, number>()
  private provenance = new Map<string, { digest: string; content: Record<string, unknown> }>()

  async ask(wsId: string, scopeId: string, instruction: string, delegated?: Record<string, unknown>): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 450))
    const ws = await this.workspaceOrCreate()
    if (wsId !== ws.id) throw err(404, 'not_found', 'workspace not found')
    if (!instruction.trim()) throw err(400, 'instruction_required', 'say what the mind should change')
    const scope = this.scopes.get(scopeId)
    if (!scope) throw err(404, 'not_found', 'scope not found')
    const { hunks, groups } = await inventHunks(scope.files, scope.body.ranges, instruction)
    // the invented mind's own plain what/why (Codex ruling §1: plain_summary, retained under the record digest)
    const plain = { what: `Changes ${hunks.length} line${hunks.length === 1 ? '' : 's'} as you asked (invented simulator mind).`, why: `You asked: ${instruction.trim().slice(0, 200)}` }
    const record = (await this.create(ws, { operation_id: `ask-${hex()}`, scope_id: scopeId, hunks }, MIND, groups, plain)) as { id: string; digest: string; author: string }
    if (delegated && SIM_BINDING !== 'none') {
      if (SIM_BINDING === 'foreign') delegated = { ...structuredClone(delegated), request_id: 'rq_someone_else' }
      const content = { schema: 'omegacode-request-proposal-v1', workspace_id: ws.id, proposal_id: record.id, proposal_digest: record.digest, author: record.author, origin_task_id: ws.task_id, origin_swarm_id: ws.swarm_id, repository_id: ws.repository_id, delegated: structuredClone(delegated) }
      this.provenance.set(record.id, { digest: await sha256Text(canonical(content)), content })
    }
    return record
  }

  // --------------------------------------------------------------------------------------------- project tests (invented)
  // INVENTED, after hive/core/code_test_intents.py _source_refs: a test is only of a retained proposal of THIS request,
  // current on the person's copy and with no decision yet; the evidence route is api/sim/projectTests.ts.

  private projectTests = new SimProjectTests()

  /** The host's code_test_source check, in miniature: the proposal's sha256:-prefixed binding, or 409 code_test_source. */
  projectTestSource(proposalId: string, requestId: string): SimTestSource {
    const ws = this.ws
    const s = this.suggestions.get(proposalId)
    const prov = this.provenance.get(proposalId)?.content as { delegated?: { request_id?: unknown } } | undefined
    const b = s?.content.binding
    if (!ws || !s || !b || prov?.delegated?.request_id !== requestId || this.decisions.some((d) => d.suggestion_id === proposalId) || b.generation !== ws.generation || b.tree_digest !== ws.tree_digest)
      throw err(409, 'code_test_source', 'the retained proposal is not current for this original request')
    return {
      request_id: requestId, repository_id: ws.repository_id,
      proposal: { proposal_id: s.record.id, proposal_digest: `sha256:${s.record.digest}`, normalized_hunks_digest: `sha256:${s.content.digest}` },
      parent: { workspace_id: ws.id, generation: b.generation, tree_digest: `sha256:${b.tree_digest}` },
    }
  }
  /** SIM ONLY: the controller runs the proposal's tests on a fork (after the person's code.test intent is queued). */
  startProjectTest(source: SimTestSource, start: SimTestStart): void {
    this.projectTests.start(source, start)
  }

  // --------------------------------------------------------------------------------------------- copy-apply (invented)
  // INVENTED, after Code's copy_application.py (workspace_copy_service r9, read-only reference) and the host relay table
  // (code.py:166-188 at 39c0731): the team controller applies a retained proposal to the person's workspace copy with its
  // purpose capability (never through the person relay); the person reads the application and may Undo it.

  private applications = new Map<string, { id: string; workspace_id: string; actor: string; suggestion_id: string; suggestion_digest: string; change_id: string; paths: string[]; before_tree_digest: string; after_generation: number; after_tree_digest: string; before_files: Record<string, string | null>; created_at: number; consent_id?: string | null; applied_at?: string }>()
  private undos: { id: string; application_id: string; change_id: string }[] = []

  /** SIM ONLY: the copy-apply switch as the hive has it. */
  get copyApplyOn() {
    return !!this.options.copyApply
  }

  /**
   * SIM ONLY: the team's controller applies one retained proposal to the copy (POST proposal-applications with its
   * copy_apply capability). Refused like Code's r9 auto path: a change that shortens or removes text is never applied
   * here (it keeps its own gate), nor is a proposal already decided or applied, nor a stale one.
   */
  async applyAsController(suggestionId: string, actor = MIND, evidence?: { consent_id: string | null }): Promise<string> {
    if (!this.options.copyApply) throw err(503, 'copy_apply_off', 'copy_apply capabilities are off on this hive (HIVE_COPY_APPLY_CLAIMS)')
    const ws = await this.workspaceOrCreate()
    const s = this.suggestions.get(suggestionId)
    if (!s || s.record.workspace_id !== ws.id) throw err(404, 'not_found', 'suggestion record not found')
    const scope = this.bound(ws, s.record.scope_id, true)
    if (s.content.hunks.some((h) => bytesOf(h.replacement).length < h.end_byte - h.start_byte)) throw err(403, 'application_effect_refused', 'shortening requires separate owner policy handling')
    if ([...this.applications.values()].some((a) => a.suggestion_id === s.record.id)) throw err(409, 'suggestion_applied', 'proposal already applied')
    if (this.decisions.some((d) => d.suggestion_id === s.record.id)) throw err(409, 'suggestion_decided', 'proposal already has a decision')
    const edits: Record<string, string> = {}
    for (const path of [...new Set(s.content.hunks.map((h) => h.path))].sort()) {
      const data = bytesOf(scope.files[path])
      const parts: Uint8Array[] = []
      let at = 0
      for (const h of s.content.hunks.filter((x) => x.path === path).sort((x, y) => x.start_byte - y.start_byte)) {
        parts.push(data.slice(at, h.start_byte), bytesOf(h.replacement))
        at = h.end_byte
      }
      parts.push(data.slice(at))
      edits[path] = new TextDecoder().decode(concat(parts))
    }
    const before_files = Object.fromEntries(Object.keys(edits).map((p) => [p, this.files.has(p) ? this.files.get(p)! : null]))
    const before = ws.tree_digest
    const change = await this.commit(ws, actor, edits)
    // the consent evidence Platform is adding to the application record (consent_id, applied_at); absent: today's host
    const app = { id: `application_${hex()}`, workspace_id: ws.id, actor, suggestion_id: s.record.id, suggestion_digest: s.record.digest, change_id: change.id, paths: change.paths, before_tree_digest: before, after_generation: change.generation, after_tree_digest: change.tree_digest, before_files, created_at: now(), ...(evidence ? { consent_id: evidence.consent_id, applied_at: new Date().toISOString() } : {}) }
    this.applications.set(app.id, app)
    const { before_files: _b, ...body } = app
    void _b
    this.events.push({ seq: this.events.length + 1, workspace: ws.id, task: ws.task_id, kind: 'proposal.copy_applied', at: new Date().toISOString(), body })
    return app.id
  }

  private applicationRoute(ws: Ws, method: 'GET' | 'POST', rest: string, b: Record<string, unknown>) {
    // the host's relay table: applying is purpose-only (403 for a person); read and Undo are held while the switch is off
    if (method === 'POST' && rest === '/proposal-applications') throw err(403, 'purpose_only', 'applying a proposal needs the controller’s copy_apply capability; the person relay never applies one')
    const m = /^\/proposal-applications\/(application_[a-f0-9]{32})(\/undo)?$/.exec(rest)
    if (!m) throw err(404, 'not_relayed', `${method} ${rest} is not part of the simulator's invented code service`)
    if (!this.options.copyApply) throw err(404, 'not_relayed', `${method} ${rest} is held until copy-apply is switched on`)
    const relayed = (status: number, code: string, message: string) => new ApiError(status, code, message, { source: 'omegacode', upstreamStatus: status })
    const app = this.applications.get(m[1])
    if (!app) throw relayed(404, 'not_found', 'copy_application record not found')
    if (app.workspace_id !== ws.id) throw relayed(403, 'application_scope', 'application belongs to another workspace')
    if (method === 'GET' && !m[2]) {
      const undo = this.undos.find((u) => u.application_id === app.id) ?? null
      const currency = undo ? 'undone' : ws.generation === app.after_generation && ws.tree_digest === app.after_tree_digest ? 'current' : 'stale'
      const { before_files: _b, ...application } = app
      void _b
      return structuredClone({ application, currency, workspace: this.view(ws), undo })
    }
    if (method !== 'POST' || !m[2]) throw err(404, 'not_relayed', `${method} ${rest} is not relayed`)
    if (Object.keys(b).sort().join(',') !== 'expected_generation,expected_tree_digest,operation_id') throw relayed(400, 'application_fields', 'Undo requires the exact closed body')
    if (b.expected_generation !== app.after_generation || b.expected_tree_digest !== app.after_tree_digest) throw relayed(409, 'undo_stale', 'Undo must bind the exact application result')
    return this.operation(HUMAN, { ...b, application_id: app.id, mutation: 'proposal-copy-undo-r1' }, async () => {
      if (this.undos.some((u) => u.application_id === app.id)) throw relayed(409, 'already_undone', 'application already undone')
      if (ws.generation !== app.after_generation || ws.tree_digest !== app.after_tree_digest) throw relayed(409, 'stale_workspace', 'workspace changed; read current generation before editing or running')
      const edits: Record<string, string> = {}
      for (const [p, text] of Object.entries(app.before_files)) if (text !== null) edits[p] = text
      const before = { generation: ws.generation, tree_digest: ws.tree_digest }
      const change = await this.commit(ws, HUMAN, edits)
      const undo = { id: `undo_${hex()}`, application_id: app.id, change_id: change.id }
      this.undos.push(undo)
      this.events.push({ seq: this.events.length + 1, workspace: ws.id, task: ws.task_id, kind: 'proposal.copy_undone', at: new Date().toISOString(), body: { ...undo, workspace_id: ws.id, actor: HUMAN } })
      return { undo_id: undo.id, undo_of: app.id, workspace_id: ws.id, change_id: change.id, before, after: { generation: change.generation, tree_digest: change.tree_digest }, workspace: this.view(ws), effect: 'workspace-copy-write' }
    })
  }

  // --------------------------------------------------------------------------------------------- runs (invented)

  private runs = new Map<string, { id: string; workspace_id: string; status: string; argv: string[]; exit_code: number; generation: number; tree_digest: string; output: string }>()

  /**
   * SIM ONLY: an invented test run (no process runs). Two invented checks: greet still says hello, and add(2, 3) is 5.
   * The output has the pytest shape, so the canvas shows results beside the lines they name. Bound to the generation
   * and tree it was asked for (stale refused), finished at once.
   */
  private runRoute(ws: Ws, method: 'GET' | 'POST', p: string, query: Record<string, string>, body: unknown): Promise<unknown> | null {
    if (method === 'POST' && p === '/v1/runs') {
      const b = (body ?? {}) as Record<string, unknown>
      if (b.workspace_id !== ws.id) return Promise.reject(err(404, 'not_found', 'workspace not found'))
      this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
      const argv = Array.isArray(b.argv) ? b.argv.map(String) : []
      if (!argv.length) return Promise.reject(err(400, 'argv_required', 'say what to run'))
      const greeting = this.files.get('src/greeting.py') ?? ''
      const calc = this.files.get('calculator.py') ?? ''
      const greetOk = /Hello, /.test(greeting) && /return/.test(greeting)
      const addOk = /return a \+ b/.test(calc)
      const calcLine = calc.split('\n').findIndex((l) => /return /.test(l)) + 1
      const failed = [addOk ? 0 : 1, greetOk ? 0 : 1].reduce((a, z) => a + z, 0)
      const out = [
        `${addOk ? '.' : 'F'}${greetOk ? '.' : 'F'}                                                       [100%]`,
        ...(addOk ? [] : ['=================================== FAILURES ===================================', '___________________________________ test_add ___________________________________', `calculator.py:${calcLine || 2}: in add`, `    ${calc.split('\n')[calcLine - 1]?.trim() ?? ''}`, 'E   AssertionError: add(2, 3) gave -1; the check expects 5']),
        ...(greetOk ? [] : ['___________________________________ test_greet _________________________________', 'tests/test_greeting.py:5: in test_greet', 'E   AssertionError: greet("Ada") no longer says "Hello, Ada!"']),
        `${failed ? `${failed} failed, ` : ''}${2 - failed} passed in 0.03s (invented simulator run)`,
        '',
      ].join('\n')
      const id = `run_sim${hex().slice(0, 10)}`
      const r = { id, workspace_id: ws.id, status: failed ? 'failed' : 'succeeded', argv, exit_code: failed ? 1 : 0, generation: ws.generation, tree_digest: ws.tree_digest, output: out }
      this.runs.set(id, r)
      const { output: _o, ...view } = r
      void _o
      return Promise.resolve(view)
    }
    const m = /^\/v1\/runs\/(run_[A-Za-z0-9_-]+)(\/output|\/cancel)?$/.exec(p)
    if (!m) return null
    const r = this.runs.get(m[1])
    // a run of another workspace is not found from this one (the service authorises against the run's workspace)
    if (!r || r.workspace_id !== ws.id) return Promise.reject(err(404, 'not_found', 'run not found'))
    const { output, ...view } = r
    if (!m[2] && method === 'GET') return Promise.resolve(view)
    if (m[2] === '/cancel' && method === 'POST') return Promise.resolve(view)
    if (m[2] === '/output' && method === 'GET') {
      // the service's bounds: a byte offset 0..4 MiB and a limit 1..65536, else 400 invalid_output_cursor
      const after = Number(query.after ?? 0)
      const limit = Number(query.limit ?? 16384)
      if (!Number.isInteger(after) || after < 0 || after > 4194304 || !Number.isInteger(limit) || limit < 1 || limit > 65536) return Promise.reject(err(400, 'invalid_output_cursor', 'output needs a byte offset from 0 to 4 MiB and a limit from 1 to 65536'))
      const bytes = bytesOf(output)
      const page = bytes.slice(after, after + Math.min(limit, 16384))
      const done = after + page.length >= bytes.length
      return Promise.resolve({ run_id: r.id, workspace_id: r.workspace_id, after, cursor: after + page.length, size_bytes: bytes.length, readable_bytes: bytes.length, data: btoa(String.fromCharCode(...page)), source: 'live-run-log', output_digest: null, status: r.status, eof: done, complete: done, truncated: false })
    }
    return null
  }

  // --------------------------------------------------------------------------------------------- iterations (invented)

  private events: { seq: number; workspace: string; task: string; kind: string; at: string; body: Record<string, unknown> }[] = []
  private iterations = new Map<string, { record: { id: string; workspace_id: string; task_id: string; digest: string; created_at: number; author: string }; content: Record<string, unknown> & { generation: number; tree_digest: string } }>()

  /**
   * SIM ONLY: iterations.py retain, in miniature: closed fields, finite limits, the source anchor, the same early
   * outcomes (cancelled / not admitted / attempt limit / usage unknown / time or cost); evidence is not evaluated here.
   */
  private retainIteration(ws: Ws, b: Record<string, unknown>) {
    const required = ['operation_id', 'verification_ids', 'commands', 'limits', 'observations', 'expected_generation', 'expected_tree_digest']
    if (!required.every((k) => k in b) || Object.keys(b).some((k) => !required.includes(k) && k !== 'approval_id')) throw err(400, 'iteration_fields', 'closed iteration observation fields required')
    return this.operation(HUMAN, { ...b, mutation: 'iteration' }, async () => {
      this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
      if (this.iterations.size >= 128) throw err(429, 'iteration_budget', 'workspace observation budget exhausted')
      const lim = b.limits as { max_attempts: number; max_seconds: number; max_cost: number }
      const o = b.observations as { attempts: number; elapsed_seconds: number | null; observed_cost: number | null; host_admitted: boolean; cancelled: boolean }
      if (!lim || ![lim.max_attempts, lim.max_seconds, lim.max_cost].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) throw err(400, 'iteration_limits', 'invalid finite iteration limits')
      if (!o || typeof o.host_admitted !== 'boolean' || typeof o.cancelled !== 'boolean') throw err(400, 'iteration_observation', 'invalid iteration observation')
      const result = (state: string, reason: string) => ({ state, reason, effect_authority: false, independent_review: false })
      const outcome = o.cancelled ? result('stopped', 'cancelled') : !o.host_admitted ? result('paused', 'host_admission_unavailable') : o.attempts > lim.max_attempts ? result('stopped', 'attempt_limit') : o.elapsed_seconds == null || o.observed_cost == null ? result('paused', 'usage_unknown') : o.elapsed_seconds >= lim.max_seconds || o.observed_cost >= lim.max_cost ? result('stopped', 'time_or_cost_limit') : result('paused', 'evidence_not_evaluated_in_simulator')
      const content = { schema: 'omegacode-iteration-observation-v1', workspace_id: ws.id, task_id: ws.task_id, generation: ws.generation, tree_digest: ws.tree_digest, commands: b.commands, verification_ids: b.verification_ids, limits: b.limits, reported_observations: b.observations, host_usage_qualified: false, outcome, actor: HUMAN }
      const record = { id: `iteration_${hex().slice(0, 16)}`, workspace_id: ws.id, task_id: ws.task_id, digest: await sha256Text(canonical(content)), created_at: now(), author: HUMAN }
      this.iterations.set(record.id, { record, content })
      this.events.push({ seq: this.events.length + 1, workspace: ws.id, task: ws.task_id, kind: 'iteration.observation', at: new Date().toISOString(), body: record })
      return { record, content }
    })
  }

  // --------------------------------------------------------------------------------------------- function pick (invented)

  /**
   * SIM ONLY: the function around a byte caret, found by indentation (OmegaCode uses a bounded Python parser). Same
   * request fields, freshness, digest and refusal codes as service function_scope_preview; nothing is issued.
   */
  private async functionPreview(ws: Ws, b: Record<string, unknown>) {
    this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
    const path = String(b.path ?? '')
    if (!/\.pyi?$/.test(path)) throw err(415, 'function_language', 'exact function selection currently supports saved Python')
    const text = this.files.get(path)
    if (text === undefined) throw err(404, 'file_missing', 'no such file in this generation')
    const data = bytesOf(text)
    if ((await sha(data)) !== b.source_digest) throw err(409, 'function_scope_stale', 'saved file digest changed')
    const caret = b.caret_byte
    if (typeof caret !== 'number' || !Number.isInteger(caret) || caret < 0 || caret >= data.length) throw err(422, 'function_scope_refused', 'bounded saved function selection refused')
    const rows = text.split('\n')
    const starts: number[] = []
    let at = 0
    for (const r of rows) {
      starts.push(at)
      at += bytesOf(r).length + 1
    }
    let line = starts.findIndex((st, i) => caret >= st && (i === rows.length - 1 || caret < starts[i + 1]))
    const indent = (r: string) => /^\s*/.exec(r)![0].length
    for (; line >= 0; line--) {
      const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(rows[line])
      if (!m) continue
      let end = line
      for (let j = line + 1; j < rows.length; j++) {
        if (!rows[j].trim()) continue
        if (indent(rows[j]) <= m[1].length) break
        end = j
      }
      const start_byte = starts[line] + bytesOf(m[1]).length
      const end_byte = starts[end] + bytesOf(rows[end]).length
      if (caret < starts[line] || caret >= end_byte) continue
      const selection = { start_byte, end_byte, name: m[2], kind: 'function', source_digest: b.source_digest, range_digest: await sha(data.slice(start_byte, end_byte)), workspace_id: ws.id, task_id: ws.task_id, generation: ws.generation, tree_digest: ws.tree_digest, path, caret_byte: caret }
      return { selection, selection_digest: await sha256Text(canonical(selection)), scope_issued: false }
    }
    throw err(422, 'function_scope_refused', 'bounded saved function selection refused')
  }

  // --------------------------------------------------------------------------------------------- language (invented)

  private renamePreviews = new Map<string, { generation: number; tree_digest: string; edits: { path: string; expected_digest: string; content: string }[] }>()
  private completionQueries = new Map<string, { generation: number; tree_digest: string; path: string; line: number; character: number; prefix: string; items: string[] }>()
  private completionPreviews = new Map<string, { generation: number; tree_digest: string; edits: { path: string; expected_digest: string; content: string }[] }>()

  /**
   * SIM ONLY: an invented Python "language server" over the invented files: names are found by regular expressions
   * (def/class/assignment), not by a real analyser. Same routes, request fields, freshness and preview-id rules as
   * OmegaCode's service (service.py 300–556); positions are UTF-16 line/character.
   */
  private async language(ws: Ws, method: 'GET' | 'POST', rest: string, b: Record<string, unknown>): Promise<unknown> {
    const py = [...this.files.keys()].filter((f) => f.endsWith('.py')).sort()
    if (method === 'GET' && rest === '/language/servers')
      return { servers: [{ id: 'python-sim', language_id: 'python', extensions: ['.py'], configured: true, executable_present: true, qualified: false, position_profile: 'utf-16' }], workspace_id: ws.id, generation: ws.generation, selection_policy: 'operator configuration only', request_features: ['definition', 'references', 'completion', 'rename'] }
    if (method !== 'POST') throw err(404, 'not_relayed', `${method} ${rest} is not part of the simulator's invented code service`)
    if (rest === '/language') {
      this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
      if (b.server_id !== 'python-sim') throw err(415, 'language_unsupported', 'language server is not configured by the operator')
      const path = String(b.path ?? '')
      const text = this.files.get(path)
      if (text === undefined) throw err(404, 'file_missing', 'language target is not in this snapshot')
      if (!path.endsWith('.py')) throw err(415, 'language_unsupported', 'configured server does not support this file extension')
      const lines = text.split('\n')
      const line = Number(b.line ?? 0)
      const character = Number(b.character ?? 0)
      if (!Number.isInteger(line) || line < 0 || line >= lines.length || !Number.isInteger(character) || character < 0 || character > lines[line].length) throw err(422, 'language_range', 'position is outside source')
      const row = lines[line]
      let a = character
      while (a > 0 && /\w/.test(row[a - 1])) a--
      let z = character
      while (z < row.length && /\w/.test(row[z])) z++
      const word = row.slice(a, z)
      const wrap = (result: unknown, extra: Record<string, unknown> = {}) => ({ result, workspace_id: ws.id, generation: ws.generation, tree_digest: ws.tree_digest, path, server_id: 'python-sim', feature: b.feature, profile: 'trusted-native-analysis', applied: false, unsaved_buffers: false, ...extra })
      const at = (f: string, re: RegExp) => this.files.get(f)!.split('\n').flatMap((l, i) => [...l.matchAll(re)].map((m) => ({ path: f, range: { start: { line: i, character: m.index! + m[0].indexOf(word) }, end: { line: i, character: m.index! + m[0].indexOf(word) + word.length } } })))
      if (b.feature === 'definition') {
        if (!word) return wrap({ locations: [], truncated: false, omitted_external: 0 })
        const def = new RegExp(`^\\s*(?:def|class)\\s+${word}\\b|^${word}\\s*=`, 'g')
        return wrap({ locations: py.flatMap((f) => at(f, def)).slice(0, 50), truncated: false, omitted_external: 0 })
      }
      if (b.feature === 'references') return wrap({ locations: word ? py.flatMap((f) => at(f, new RegExp(`\\b${word}\\b`, 'g'))).slice(0, 50) : [], truncated: false, omitted_external: 0 })
      if (b.feature === 'rename') {
        const name = b.new_name
        if (typeof name !== 'string' || !/^[A-Za-z_]\w{0,159}$/.test(name) || PY_KEYWORDS.has(name)) throw err(400, 'rename_name', 'rename needs a valid identifier')
        if (!word) throw err(422, 'rename_unavailable', 'rename returned no source changes')
        const re = new RegExp(`\\b${word}\\b`, 'g')
        const edits = (await Promise.all(py.map(async (f) => {
          const before = this.files.get(f)!
          const after = before.replace(re, name)
          return after === before ? null : { path: f, expected_digest: await sha(bytesOf(before)), content: after }
        }))).filter((e): e is { path: string; expected_digest: string; content: string } => !!e)
        if (!edits.length) throw err(422, 'rename_unavailable', 'rename returned no source changes')
        const id = `rp_${hex().slice(0, 16)}`
        this.renamePreviews.set(id, { generation: ws.generation, tree_digest: ws.tree_digest, edits })
        return wrap({ edits, applied: false, preview_id: id, edit_digest: await sha256Text(canonical(edits)), paths: edits.map((e) => e.path) })
      }
      if (b.feature === 'completion') {
        const prefix = row.slice(a, character)
        const names = new Set<string>()
        for (const f of py) for (const m of this.files.get(f)!.matchAll(/^\s*(?:def|class)\s+(\w+)|^(\w+)\s*=/gm)) names.add(m[1] ?? m[2])
        const items = [...names].filter((n) => n.startsWith(prefix) && n !== prefix).sort().slice(0, 50)
        const id = `cq_${hex().slice(0, 16)}`
        this.completionQueries.set(id, { generation: ws.generation, tree_digest: ws.tree_digest, path, line, character, prefix, items })
        return wrap({ items: items.map((label) => ({ label, kind: 3, detail: 'defined in this repository (invented)', textEdit: { newText: label, range: { start: { line, character: a }, end: { line, character } } }, additionalTextEdits: [], omitted_additional_edits: false })), truncated: false, incomplete: false }, { completion_query_id: id })
      }
      throw err(400, 'language_feature', 'language feature or limit is unsupported')
    }
    if (rest === '/language/completion-previews') {
      const q = this.completionQueries.get(String(b.query_id))
      if (!q) throw err(404, 'not_found', 'completion query not found')
      this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
      this.fresh(ws, q.generation, q.tree_digest)
      const i = b.item_index
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= q.items.length) throw err(422, 'completion_selection', 'select an exact retained completion item index')
      const before = this.files.get(q.path)!
      const lines = before.split('\n')
      const row = lines[q.line]
      lines[q.line] = row.slice(0, q.character - q.prefix.length) + q.items[i] + row.slice(q.character)
      const content = lines.join('\n')
      const id = `cp_${hex().slice(0, 16)}`
      const edits = [{ path: q.path, expected_digest: await sha(bytesOf(before)), content }]
      this.completionPreviews.set(id, { generation: q.generation, tree_digest: q.tree_digest, edits })
      return { id, workspace_id: ws.id, generation: q.generation, tree_digest: q.tree_digest, path: q.path, query_id: b.query_id, item_index: i, edits, label: q.items[i], replacement: q.items[i], replaced_text: q.prefix, applied: false, unsaved_buffers: false, profile: 'saved-source-completion-preview', provider_generated_next_edit: false }
    }
    if (rest === '/language/completion-applies' || rest === '/language/renames') {
      const store = rest === '/language/renames' ? this.renamePreviews : this.completionPreviews
      const pv = store.get(String(b.preview_id))
      if (!pv) throw err(404, 'not_found', 'preview not found')
      return this.operation(HUMAN, { ...b, mutation: rest }, async () => {
        if (pv.generation !== b.expected_generation || pv.tree_digest !== b.expected_tree_digest) throw err(409, 'stale_workspace', 'preview does not match the expected workspace')
        this.fresh(ws, pv.generation, pv.tree_digest)
        for (const e of pv.edits) if ((await sha(bytesOf(this.files.get(e.path) ?? ''))) !== e.expected_digest) throw err(409, 'stale_file', 'file changed since the preview')
        const change = await this.commit(ws, HUMAN, Object.fromEntries(pv.edits.map((e) => [e.path, e.content])))
        return { workspace: this.view(ws), change }
      })
    }
    throw err(404, 'not_relayed', `${method} ${rest} is not part of the simulator's invented code service`)
  }

  // --------------------------------------------------------------------------------------------- workspace + CAS

  private async workspaceOrCreate(): Promise<Ws> {
    if (this.ws) return this.ws
    if (!this.seeded) {
      this.seeded = true
      for (const [k, v] of this.baseFiles) this.files.set(k, v)
    }
    const tree = await this.tree()
    this.ws = {
      id: this.options.workspace_id ?? 'ws_simsuggest01',
      repository_id: SIM_CODE_REPOSITORY,
      task_id: this.options.task_id ?? 'g_simcode01',
      swarm_id: this.options.swarm_id ?? 's_forge',
      base_commit: '5ce7a1d09b3e44f1a2c0de55aa01b2c3d4e5f607',
      base_ref: 'main',
      generation: 1,
      tree_digest: tree,
      base_tree_digest: tree,
      created_by: HUMAN,
      created_at: now(),
      profile: 'trusted-native',
      history: [{ generation: 1, tree_digest: tree, author: HUMAN }],
    }
    return this.ws
  }
  private view(ws: Ws) {
    return { ...ws, history: ws.history.map((h) => ({ ...h })) }
  }
  private async tree(): Promise<string> {
    const manifest: Record<string, unknown> = {}
    for (const [k, v] of this.files) manifest[k] = { digest: await sha(bytesOf(v)), size: bytesOf(v).length, executable: false }
    return sha256Text(canonical(manifest))
  }
  private fresh(ws: Ws, generation?: number, tree?: string) {
    if ((generation !== undefined && generation !== ws.generation) || (tree !== undefined && tree !== ws.tree_digest)) throw err(409, 'stale_workspace', 'workspace changed; read current generation before editing or running')
  }
  private async commit(ws: Ws, actor: string, edits: Record<string, string>) {
    const before = ws.tree_digest
    for (const [k, v] of Object.entries(edits)) this.files.set(k, v)
    const tree = await this.tree()
    const change = { id: `cs_${hex()}`, workspace_id: ws.id, task_id: ws.task_id, author: actor, base_commit: ws.base_commit, before_digest: before, tree_digest: tree, generation: ws.generation + 1, paths: Object.keys(edits).sort(), created_at: now(), diff_digest: await sha256Text(this.diff()) }
    ws.generation = change.generation
    ws.tree_digest = tree
    ws.history.push({ generation: ws.generation, tree_digest: tree, author: actor, change_id: change.id })
    this.changes.push(change)
    return change
  }
  /** Same-operation retry returns the original result; a different payload under the same ID refuses. */
  private async operation<T>(actor: string, b: Record<string, unknown>, apply: () => Promise<T>): Promise<T> {
    const opId = b.operation_id
    if (typeof opId !== 'string' || !opId || opId.length > 160) throw err(400, 'operation_id_required', 'write operations need a bounded operation_id')
    const fingerprint = canonical(Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'approval_id')))
    const key = `${actor}\u0000${opId}`
    const cached = this.operations.get(key)
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw err(409, 'operation_conflict', 'operation_id was already used with another payload')
      return structuredClone(cached.result) as T
    }
    const result = await apply()
    this.operations.set(key, { fingerprint, result: structuredClone(result) })
    return result
  }
  private async patch(ws: Ws, b: Record<string, unknown>) {
    return this.operation(HUMAN, b, async () => {
      this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
      const edits = b.edits as { path: string; expected_digest: string | null; content: string }[]
      for (const e of edits) {
        const old = this.files.get(e.path)
        if ((old === undefined ? null : await sha(bytesOf(old))) !== e.expected_digest) throw err(409, 'stale_file', 'file content digest differs from expected_digest')
      }
      const change = await this.commit(ws, HUMAN, Object.fromEntries(edits.map((e) => [e.path, e.content])))
      return { workspace: this.view(ws), change }
    })
  }
  private diff(): string {
    const out: string[] = []
    for (const path of [...new Set([...this.baseFiles.keys(), ...this.files.keys()])].sort()) {
      const a = this.baseFiles.get(path) ?? ''
      const z = this.files.get(path) ?? ''
      if (a === z) continue
      out.push(`--- a/${path}`, `+++ b/${path}`, ...lineDiff(a, z))
    }
    return out.join('\n')
  }

  // --------------------------------------------------------------------------------------------- retained suggestions

  private async scope(ws: Ws, b: Record<string, unknown>) {
    // Only an authenticated person may mint a scope; the sim's caller is always the person.
    const allowed = ['operation_id', 'approval_id', 'expected_generation', 'expected_tree_digest', 'ranges']
    if (Object.keys(b).some((k) => !allowed.includes(k))) throw err(422, 'validation_error', 'unknown scope field')
    return this.operation(HUMAN, { ...b, mutation: 'suggestion-scope' }, async () => {
      if ([...this.scopes.values()].length >= 128) throw err(429, 'suggestion_budget', 'workspace scope budget exhausted')
      this.fresh(ws, b.expected_generation as number, b.expected_tree_digest as string)
      const ranges = b.ranges as Record<string, [number, number][]>
      const paths = Object.keys(ranges ?? {}).sort()
      if (!paths.length || paths.length > 100) throw err(400, 'suggestion_scope', 'scope needs1–100 paths')
      const files: Record<string, string> = {}
      const normalized: Record<string, [number, number][]> = {}
      const digests: Record<string, string> = {}
      for (const path of paths) {
        const text = this.files.get(path)
        if (text === undefined) throw err(403, 'suggestion_path', 'path is absent or context-excluded')
        const data = bytesOf(text)
        if (!ranges[path]?.length || ranges[path].length > 100) throw err(400, 'suggestion_scope', 'bounded ranges required')
        normalized[path] = ranges[path].map(([s, e]) => {
          if (!boundary(data, s) || !boundary(data, e) || s > e) throw err(400, 'suggestion_scope', 'invalid UTF-8 range')
          return [s, e]
        })
        files[path] = text
        digests[path] = await sha(data)
      }
      const body = { workspace_id: ws.id, task_id: ws.task_id, generation: ws.generation, tree_digest: ws.tree_digest, ranges: normalized, file_digests: digests, author: HUMAN }
      const record = { id: `scope_${hex()}`, workspace_id: ws.id, digest: await sha256Text(canonical(body)), author: HUMAN, created_at: now() }
      this.scopes.set(record.id, { record, body, files, epoch: this.epoch })
      return record
    })
  }

  private bound(ws: Ws, scopeId: string, fresh: boolean): Scope {
    const scope = this.scopes.get(scopeId)
    if (!scope) throw err(404, 'not_found', 'scope not found')
    if (scope.record.workspace_id !== ws.id) throw err(403, 'suggestion_scope', 'scope belongs to another workspace')
    if (this.revokedEpochs.has(scope.epoch)) throw err(401, 'invalid_capability', 'capability is expired or revoked')
    if (fresh) this.fresh(ws, scope.body.generation, scope.body.tree_digest)
    return scope
  }

  private async create(ws: Ws, b: Record<string, unknown>, actor: string, groups?: number[][], plain?: { what: string; why: string }) {
    if (Object.keys(b).some((k) => !['operation_id', 'approval_id', 'scope_id', 'hunks'].includes(k))) throw err(422, 'validation_error', 'unknown proposal field (author/model/harness are derived, never supplied)')
    this.bound(ws, b.scope_id as string, true)
    return this.operation(actor, { ...b, mutation: 'suggestion-preview' }, async () => {
      if (this.suggestions.size >= 128) throw err(429, 'suggestion_budget', 'workspace proposal budget exhausted')
      if (bytesOf(canonical(b.hunks ?? null)).length > 4 * 1024 * 1024) throw err(413, 'suggestion_size', 'proposal exceeds4MiB')
      const scope = this.bound(ws, b.scope_id as string, true)
      const binding: SuggestionBinding = { workspace_id: ws.id, task_id: ws.task_id, generation: scope.body.generation, tree_digest: scope.body.tree_digest }
      let normalized: { schema: string; binding: SuggestionBinding; scope: Record<string, [number, number][]>; hunks: Hunk[]; digest: string; hunk_groups?: string[][] }
      try {
        normalized = await prepare(binding, scope.files, scope.body.ranges, b.hunks as Record<string, unknown>[], groups)
      } catch (e) {
        throw err(400, 'suggestion_refused', e instanceof Error ? e.message : String(e))
      }
      // The real service covers the optional explanation in the inner digest too.
      if (plain) {
        const inner = { ...normalized } as Record<string, unknown>
        delete inner.digest
        inner.plain_summary = plain
        normalized = { ...normalized, digest: await sha256Text(canonical(inner)) }
      }
      const content = { ...normalized, scope_id: scope.record.id, author: actor, ...(plain ? { plain_summary: plain } : {}) }
      const record = { id: `suggestion_${hex()}`, workspace_id: ws.id, scope_id: scope.record.id, digest: await sha256Text(canonical(content)), author: actor, created_at: now() }
      this.suggestions.set(record.id, { record, content: structuredClone(content) })
      return record
    })
  }

  private read(ws: Ws, id: string) {
    const s = this.suggestions.get(id)
    if (!s) throw err(404, 'not_found', 'proposal not found')
    if (s.record.workspace_id !== ws.id) throw err(403, 'suggestion_scope', 'proposal belongs to another workspace')
    const b = s.content.binding
    return structuredClone({ record: s.record, content: s.content, decisions: this.decisions.filter((d) => d.suggestion_id === id), currency: b.generation === ws.generation && b.tree_digest === ws.tree_digest ? 'current' : 'stale' })
  }

  private history(ws: Ws, query: Record<string, string>) {
    const limit = Number(query.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw err(400, 'suggestion_history', 'limit must be from1 to20')
    let after: { at: number; id: string } | null = null
    if (query.cursor) {
      try {
        const c = JSON.parse(atob(query.cursor.replace(/-/g, '+').replace(/_/g, '/')))
        if (c.workspace_id !== ws.id || c.kind !== 'suggestion') throw new Error()
        after = { at: c.at, id: c.id }
      } catch {
        throw err(400, 'invalid_cursor', 'proposal cursor is invalid for this workspace and kind')
      }
    }
    const all = [...this.suggestions.values()].map((s) => s.record).sort((a, z) => z.created_at - a.created_at || (a.id < z.id ? 1 : -1))
    const rows = after ? all.filter((r) => r.created_at < after.at || (r.created_at === after.at && r.id < after.id)) : all
    const page = rows.slice(0, limit)
    const items = page.map((r) => {
      const read = this.read(ws, r.id)
      const acc = new Set(read.decisions.flatMap((d) => d.accepted_hunk_ids))
      const rej = new Set(read.decisions.flatMap((d) => d.rejected_hunk_ids))
      return { ...r, generation: read.content.binding.generation, tree_digest: read.content.binding.tree_digest, currency: read.currency, hunk_count: read.content.hunks.length, accepted_count: acc.size, rejected_count: rej.size }
    })
    const last = page[page.length - 1]
    const next_cursor = rows.length > limit && last ? btoa(JSON.stringify({ at: last.created_at, id: last.id, kind: 'suggestion', workspace_id: ws.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null
    return { workspace_id: ws.id, generation: ws.generation, tree_digest: ws.tree_digest, items, next_cursor }
  }

  private async decide(ws: Ws, b: Record<string, unknown>) {
    const allowed = ['operation_id', 'approval_id', 'suggestion_id', 'suggestion_digest', 'expected_generation', 'expected_tree_digest', 'accepted_hunk_ids', 'rejected_hunk_ids']
    if (Object.keys(b).some((k) => !allowed.includes(k))) throw err(422, 'validation_error', 'unknown decision field')
    const s = this.suggestions.get(b.suggestion_id as string)
    if (!s || s.record.workspace_id !== ws.id || s.record.digest !== b.suggestion_digest) throw err(403, 'suggestion_scope', 'proposal identity mismatch')
    const binding = s.content.binding
    if (b.expected_generation !== binding.generation || b.expected_tree_digest !== binding.tree_digest) throw err(409, 'suggestion_stale', 'decision must bind the retained proposal source')
    const scope = this.bound(ws, s.record.scope_id, false)
    const accepted = (b.accepted_hunk_ids ?? []) as string[]
    const rejected = (b.rejected_hunk_ids ?? []) as string[]
    const ids = [...accepted, ...rejected]
    const known = new Set(s.content.hunks.map((h) => h.id))
    if (!ids.length || new Set(ids).size !== ids.length || !ids.every((i) => known.has(i))) throw err(400, 'suggestion_decision', 'unknown/duplicate/empty hunk decisions')
    // PROPOSED extension (sim only): a dependent group is never split across a decision.
    for (const g of s.content.hunk_groups ?? []) {
      const choices = new Set(g.map((id) => (accepted.includes(id) ? 'a' : rejected.includes(id) ? 'r' : '-')))
      if (choices.size > 1) throw err(400, 'suggestion_group_split', 'dependent hunks must be decided together (proposed extension)')
    }
    const result = await this.operation(HUMAN, { ...b, accepted_hunk_ids: accepted, rejected_hunk_ids: rejected, mutation: 'suggestion-decision' }, async () => {
      this.fresh(ws, binding.generation, binding.tree_digest)
      for (const prior of this.decisions) if (prior.suggestion_id === s.record.id && ids.some((i) => prior.accepted_hunk_ids.includes(i) || prior.rejected_hunk_ids.includes(i))) throw err(409, 'suggestion_decided', 'hunk already decided')
      let change: Record<string, unknown> | undefined
      if (accepted.length) {
        const edits: Record<string, string> = {}
        const selected = s.content.hunks.filter((h) => accepted.includes(h.id))
        for (const path of [...new Set(selected.map((h) => h.path))].sort()) {
          const data = bytesOf(scope.files[path])
          const parts: Uint8Array[] = []
          let at = 0
          for (const h of selected.filter((x) => x.path === path).sort((x, y) => x.start_byte - y.start_byte)) {
            if ((await sha(data)) !== h.expected_file_digest) throw err(409, 'suggestion_stale', 'stale file')
            parts.push(data.slice(at, h.start_byte), bytesOf(h.replacement))
            at = h.end_byte
          }
          parts.push(data.slice(at))
          edits[path] = new TextDecoder().decode(concat(parts))
        }
        change = await this.commit(ws, HUMAN, edits)
      }
      const decision: Decision = { id: `decision_${hex()}`, suggestion_id: s.record.id, suggestion_digest: s.record.digest, workspace_id: ws.id, actor: HUMAN, accepted_hunk_ids: accepted, rejected_hunk_ids: rejected, change_id: (change?.id as string) ?? null, created_at: now() }
      this.decisions.push(decision)
      return { workspace: this.view(ws), ...(change ? { change } : {}), decision }
    })
    if (this.loseNext) {
      this.loseNext = false
      throw err(502, 'service_unreachable', 'OmegaCode did not answer (simulated lost answer; the decision was recorded)')
    }
    return result
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Port of suggestion_validation.prepare (plus the proposed groups extension, given as hunk indexes). */
async function prepare(binding: SuggestionBinding, files: Record<string, string>, trusted: Record<string, [number, number][]>, proposals: Record<string, unknown>[], groups?: number[][]) {
  if (!Array.isArray(proposals) || !proposals.length || proposals.length > 1000) throw new Error('hunk count')
  const hunks: Hunk[] = []
  const byIndex: string[] = []
  for (const item of proposals) {
    const keys = Object.keys(item).sort().join(',')
    if (keys !== 'before_digest,end_byte,path,replacement,start_byte') throw new Error('hunk fields')
    const path = item.path as string
    if (!pathOk(path) || !(path in files) || !(path in trusted)) throw new Error('path scope')
    const data = bytesOf(files[path])
    if (data.length > MAX_BYTES) throw new Error('saved source')
    const start = item.start_byte
    const end = item.end_byte
    if (!boundary(data, start) || !boundary(data, end) || start > end) throw new Error('UTF-8 range')
    if (!trusted[path].some(([a, z]) => a <= start && start <= end && end <= z)) throw new Error('range scope')
    if (item.before_digest !== (await sha(data.slice(start, end)))) throw new Error('before digest')
    if (typeof item.replacement !== 'string' || bytesOf(item.replacement).length > MAX_BYTES) throw new Error('replacement size')
    const hunk = { path, start_byte: start, end_byte: end, replacement: item.replacement, before_digest: item.before_digest as string, expected_file_digest: await sha(data) }
    const id = await sha256Text(canonical({ binding, hunk }))
    hunks.push({ ...hunk, id })
    byIndex.push(id)
  }
  hunks.sort((a, z) => (a.path < z.path ? -1 : a.path > z.path ? 1 : a.start_byte - z.start_byte || a.end_byte - z.end_byte))
  for (let i = 1; i < hunks.length; i++) {
    const l = hunks[i - 1]
    const r = hunks[i]
    if (l.path === r.path && (r.start_byte < l.end_byte || r.start_byte === l.start_byte || (r.start_byte === l.end_byte && (l.start_byte === l.end_byte || r.start_byte === r.end_byte)))) throw new Error('overlapping or ambiguous hunks')
  }
  const scope = Object.fromEntries(Object.keys(trusted).sort().map((p) => [p, trusted[p].map((r) => [r[0], r[1]] as [number, number])]))
  const result: Record<string, unknown> = { schema: 'omegacode-scoped-suggestion-v1', binding: { ...binding }, scope, hunks }
  if (groups?.length) result.hunk_groups = groups.map((g) => g.map((i) => byIndex[i]))
  const digest = await sha256Text(canonical(result))
  return JSON.parse(canonical({ ...result, digest })) as { schema: string; binding: SuggestionBinding; scope: Record<string, [number, number][]>; hunks: Hunk[]; digest: string; hunk_groups?: string[][] }
}

/**
 * INVENTED MIND. Deterministic edits inside the scope: type hints on a Python def, string concatenation -> f-string,
 * and a rename of an assigned local (`message` -> `text`) on every line that uses it (a dependent group).
 */
async function inventHunks(files: Record<string, string>, ranges: Record<string, [number, number][]>, instruction: string) {
  const hunks: { path: string; start_byte: number; end_byte: number; replacement: string; before_digest: string }[] = []
  const groups: number[][] = []
  for (const path of Object.keys(ranges).sort()) {
    const data = bytesOf(files[path])
    const text = files[path]
    // whole lines (without their newline) fully inside a range, in byte offsets
    const lines: { start: number; end: number; text: string }[] = []
    let byte = 0
    for (const raw of text.split('\n')) {
      const len = bytesOf(raw).length
      if (ranges[path].some(([a, z]) => a <= byte && byte + len <= z) && raw.trim()) lines.push({ start: byte, end: byte + len, text: raw })
      byte += len + 1
    }
    const assigned = lines.map((l) => /^\s*(message|msg|result)\s*=/.exec(l.text)?.[1]).find(Boolean)
    const renamed: number[] = []
    for (const l of lines) {
      let next = l.text
      if (/\b(type|types|hint|hints|label|annotat\w*)\b/i.test(instruction)) next = next.replace(/^(\s*)def (\w+)\(([^)]*)\):/, (_m, ind: string, name: string, params: string) => `${ind}def ${name}(${params.split(',').map((p) => p.trim()).filter(Boolean).map((p) => (p.includes(':') ? p : `${p}: str`)).join(', ')}) -> str:`)
      if (/\b(add|sum|plus|fix|correct)\b/i.test(instruction)) next = next.replace(/\breturn (\w+) - (\w+)\b/, 'return $1 + $2')
      next = next.replace(/"([^"]*)" \+ (\w+) \+ "([^"]*)"/, (_m, a: string, v: string, z: string) => `f"${a}{${v}}${z}"`)
      let uses = false
      if (assigned && new RegExp(`\\b${assigned}\\b`).test(next)) {
        next = next.replace(new RegExp(`\\b${assigned}\\b`, 'g'), 'text')
        uses = true
      }
      if (next === l.text) continue
      if (uses) renamed.push(hunks.length)
      hunks.push({ path, start_byte: l.start, end_byte: l.end, replacement: next, before_digest: await sha(data.slice(l.start, l.end)) })
    }
    if (renamed.length > 1) groups.push(renamed)
  }
  if (!hunks.length) {
    // nothing recognisable: one insertion at the end of the first range, as a reviewable note
    const path = Object.keys(ranges).sort()[0]
    const at = ranges[path][0][1]
    const mark = /\.py$|\.sh$|\.md$/.test(path) ? '#' : /\.metta$/.test(path) ? ';' : '//'
    hunks.push({ path, start_byte: at, end_byte: at, replacement: ` ${mark} ${instruction.trim().slice(0, 60)} (invented suggestion)`, before_digest: await sha(new Uint8Array()) })
  }
  return { hunks, groups }
}

/** Minimal LCS line diff for the Changes view (sim only). */
function lineDiff(a: string, z: string): string[] {
  const x = a.split('\n')
  const y = z.split('\n')
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: string[] = [`@@ -1,${x.length} +1,${y.length} @@`]
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(` ${x[i]}`)
      i++
      j++
    } else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+${y[j++]}`)
    else out.push(`-${x[i++]}`)
  }
  return out
}
