/** Read-only projection of the actual normal read-scoped project-tests route.
 * Receipt identity is a retained locator, not a browser reserialization claim.
 * Capture SHA256 is checked over original bytes before rendering a UTF8 preview.
 */
export interface EvidenceSubject {
  workspace_id: string
  generation: number
  tree_digest: string
  proposal_id: string
  proposal_digest: string
  normalized_hunks_digest: string
}
export type EvidenceCall = (method: 'GET', path: string, body: undefined, query: Record<string, string>) => Promise<unknown>
export type EvidenceCurrency = 'current' | 'stale' | 'unknown'
export interface EvidenceLog {
  name: 'stdout' | 'stderr'
  bytes: number
  digest: string
  text: string
  preview_truncated: boolean
  complete: boolean
}
export interface ProjectTestEvidence {
  test_id: string
  launch_key: string
  source_currency: EvidenceCurrency
  execution_currency: EvidenceCurrency
  currency: EvidenceCurrency
  tested: boolean
  outcome: 'succeeded' | 'not_succeeded' | 'unknown'
  receipt_digest: string | null
  logs: EvidenceLog[]
}
export interface EvidencePage { results: ProjectTestEvidence[]; next_cursor: string | null }
export interface EvidenceState { pending: boolean; page: EvidencePage | null; error: string | null }
type ObjectValue = Record<string, unknown>
const HEX = /^[a-f0-9]{64}$/
const SHA = /^sha256:[a-f0-9]{64}$/
const REF = /^[A-Za-z0-9_-]{1,160}$/
const CURSOR = /^(0|[1-9][0-9]{0,18})$/
const obj = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v)
function need(ok: unknown): asserts ok { if (!ok) throw new Error('Project-test evidence does not match the retained contract') }
function object(v: unknown): ObjectValue { need(obj(v)); return v }
function keys(v: ObjectValue, required: string[], optional: string[] = []) {
  need(required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)))
}
function ref(v: unknown): string { need(typeof v === 'string' && REF.test(v)); return v }
function currency(v: unknown): EvidenceCurrency { need(v === 'current' || v === 'stale' || v === 'unknown'); return v }
function nat(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 }
export function evidenceSubjectKey(s: EvidenceSubject): string {
  ref(s.workspace_id); ref(s.proposal_id)
  need(nat(s.generation) && s.generation > 0)
  need([s.tree_digest, s.proposal_digest, s.normalized_hunks_digest].every(x => typeof x === 'string' && HEX.test(x)))
  return JSON.stringify([s.workspace_id, s.generation, s.tree_digest, s.proposal_id, s.proposal_digest, s.normalized_hunks_digest])
}
export function exactEvidenceCursor(value: unknown): string {
  need(typeof value === 'string' && CURSOR.test(value) && BigInt(value) <= 9223372036854775807n)
  return value
}
export function projectTestEvidenceRequest(s: EvidenceSubject, cursor = '0') {
  evidenceSubjectKey(s)
  return { path: `/v1/workspaces/${s.workspace_id}/suggestions/${s.proposal_id}/project-tests`, query: { limit: '4', cursor: exactEvidenceCursor(cursor) } }
}
export async function captureDigest(bytes: Uint8Array): Promise<string> {
  return 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), b => b.toString(16).padStart(2, '0')).join('')
}
function originalBinding(value: unknown, s: EvidenceSubject, tid: string): boolean {
  const b = object(value)
  need(b.schema === 'omegacode-project-test-binding/1' && b.test_id === tid)
  const parent = object(b.parent), proposal = object(b.proposal)
  need(parent.workspace_id === s.workspace_id && nat(parent.generation) && parent.generation > 0 && typeof parent.tree_digest === 'string' && SHA.test(parent.tree_digest))
  need(proposal.proposal_id === s.proposal_id && proposal.proposal_digest === 'sha256:' + s.proposal_digest && proposal.normalized_hunks_digest === 'sha256:' + s.normalized_hunks_digest)
  return parent.generation === s.generation && parent.tree_digest === 'sha256:' + s.tree_digest
}
function preview(bytes: Uint8Array): string {
  // Inert text only. Escape terminal/bidi controls; hash verification used all bytes.
  return new TextDecoder().decode(bytes.slice(0, 32768)).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
async function capture(name: 'stdout' | 'stderr', encoded: unknown, streamValue: unknown): Promise<EvidenceLog> {
  const limit = name === 'stdout' ? 256 * 1024 : 16 * 1024
  need(typeof encoded === 'string' && encoded.length <= 4 * Math.ceil(limit / 3) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
  const binary = atob(encoded), bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  need(bytes.length <= limit && btoa(binary) === encoded)
  const stream = object(streamValue)
  need(stream.retained_bytes === bytes.length && typeof stream.digest === 'string' && SHA.test(stream.digest))
  need(stream.digest === await captureDigest(bytes))
  need(typeof stream.complete === 'boolean' && typeof stream.eof === 'boolean' && typeof stream.truncated === 'boolean')
  need(stream.observed_bytes === null || (nat(stream.observed_bytes) && stream.observed_bytes >= bytes.length))
  if (stream.complete) need(stream.eof && !stream.truncated && stream.observed_bytes === bytes.length)
  return { name, bytes: bytes.length, digest: stream.digest, text: preview(bytes), preview_truncated: bytes.length > 32768, complete: stream.complete }
}
/** Optional original _finish settlement metadata. Validate its fixed projection,
 * then discard it: it cannot establish tested/current/close/work authority. */
function holdMetadata(value: unknown, holdId: string, tid: string, launch: string, receipt: ObjectValue) {
  const meta = object(value); keys(meta, ['hold', 'observation'])
  const hold = object(meta.hold), obs = object(meta.observation)
  keys(hold, ['hold_id', 'test_id', 'request_id', 'launch_key', 'argv_digest', 'runtime_seconds_max', 'state', 'run_id', 'cleanup', 'accounting', 'charged_seconds', 'overrun_seconds', 'observation_count', 'created_at', 'settled_at'])
  const binding = object(receipt.binding)
  need(hold.hold_id === holdId && hold.test_id === tid && hold.launch_key === launch && hold.request_id === binding.request_id && hold.run_id === receipt.run_id)
  need(typeof hold.argv_digest === 'string' && SHA.test(hold.argv_digest))
  need(['dispatched', 'unknown', 'settled', 'released'].includes(hold.state as string) && ['unobserved', 'observed'].includes(hold.cleanup as string) && ['reserved_max', 'executor_measured', 'wall_clock_bound', 'none'].includes(hold.accounting as string))
  for (const field of ['runtime_seconds_max', 'charged_seconds', 'overrun_seconds', 'observation_count']) need(nat(hold[field]))
  const stamp = (v: unknown) => typeof v === 'string' && v.length <= 64 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)
  need(stamp(hold.created_at) && (hold.settled_at === null || stamp(hold.settled_at)))
  keys(obs, ['seq', 'body_digest', 'body', 'state_before', 'state_after', 'received_at'])
  need(nat(obs.seq) && obs.seq === hold.observation_count && typeof obs.body_digest === 'string' && HEX.test(obs.body_digest) && stamp(obs.received_at))
  need(['dispatched', 'unknown', 'settled', 'released'].includes(obs.state_before as string) && obs.state_after === hold.state)
  const body = object(obs.body); keys(body, ['outcome', 'run_id', 'runtime', 'cleanup', 'evidence', 'receipt_digest'])
  const runtime = object(body.runtime), cleanup = object(body.cleanup), evidence = object(body.evidence)
  keys(runtime, ['seconds', 'provenance']); keys(cleanup, ['descendants_stopped', 'observed_at']); keys(evidence, ['launch_record_state', 'launch_record_rev'])
  need(['completed', 'failed', 'cancelled', 'withdrawn', 'not_started', 'unknown'].includes(body.outcome as string) && body.run_id === receipt.run_id && body.receipt_digest === receipt.digest)
  need((runtime.seconds === null || nat(runtime.seconds)) && ['executor_measured', 'wall_clock_bound', 'unknown'].includes(runtime.provenance as string))
  need(typeof cleanup.descendants_stopped === 'boolean' && (cleanup.observed_at === null || stamp(cleanup.observed_at)))
  need(['never_spawning', 'spawning', 'running', 'ended'].includes(evidence.launch_record_state as string) && nat(evidence.launch_record_rev))
}
async function parseRow(value: unknown, s: EvidenceSubject): Promise<ProjectTestEvidence> {
  const v = object(value)
  keys(v, ['test_id', 'launch_key', 'result', 'source_currency', 'execution_currency', 'currency', 'tested', 'accepted_source'])
  const tid = ref(v.test_id)
  need(typeof v.launch_key === 'string' && /^[A-Za-z0-9_.:-]{8,120}$/.test(v.launch_key))
  const launch = v.launch_key
  const source = currency(v.source_currency), execution = currency(v.execution_currency), combined = currency(v.currency)
  need(typeof v.tested === 'boolean' && v.accepted_source === false)
  const expected = source === 'stale' || execution === 'stale' ? 'stale' : source === 'current' && execution === 'current' ? 'current' : 'unknown'
  need(combined === expected && (!v.tested || combined === 'current'))
  const base: ProjectTestEvidence = { test_id: tid, launch_key: launch, source_currency: source, execution_currency: execution, currency: combined, tested: false, outcome: 'unknown', receipt_digest: null, logs: [] }
  if (v.result === null) { need(!v.tested); return base }
  const r = object(v.result)
  need(r.test_id === tid && r.launch_key === launch && typeof r.hold_id === 'string' && /^ph_[a-f0-9]{24}$/.test(r.hold_id))
  if (r.schema === 'omegacode-sandbox-dispatch/1') {
    keys(r, ['schema', 'state', 'test_id', 'launch_key', 'hold_id', 'run_id', 'binding', 'revision'])
    need(r.state === 'dispatch_unresolved' && typeof r.run_id === 'string' && /^run_sbx_[a-f0-9]{32}$/.test(r.run_id) && r.revision === 1 && !v.tested)
    originalBinding(r.binding, s, tid)
    return base
  }
  keys(r, ['schema', 'test_id', 'launch_key', 'hold_id', 'receipt', 'observation', 'captures', 'revision'], ['hold'])
  need(r.schema === 'omegacode-sandbox-dispatch-result/1' && r.revision === 2)
  const receipt = object(r.receipt), observation = object(r.observation), captures = object(r.captures)
  need(receipt.schema === 'omegacode-sandbox-test-result/1' && typeof receipt.digest === 'string' && SHA.test(receipt.digest) && observation.receipt_digest === receipt.digest)
  need(receipt.accepted_source === false && receipt.independent_evaluation === false)
  const sameHead = originalBinding(receipt.binding, s, tid)
  if (Object.hasOwn(r, 'hold')) holdMetadata(r.hold, r.hold_id, tid, launch, receipt)
  need(receipt.command_outcome === 'succeeded' || receipt.command_outcome === 'not_succeeded' || receipt.command_outcome === 'unknown')
  const streams = object(receipt.streams)
  keys(captures, [], ['stdout', 'stderr'])
  for (const name of ['stdout', 'stderr'] as const) if (Object.hasOwn(captures, name)) base.logs.push(await capture(name, captures[name], streams[name]))
  const cleanup = object(receipt.cleanup)
  if (v.tested) need(receipt.command_outcome === 'succeeded' && receipt.output_complete === true && receipt.exit_code === 0 && receipt.primary_error === null && receipt.authorization_error === null && base.logs.length === 2 && base.logs.every(x => x.complete) && cleanup.complete === true && cleanup.original_process_reaped === true && cleanup.original_group_absent === true && cleanup.job_removed === true && Array.isArray(cleanup.errors) && cleanup.errors.length === 0 && ['PID_NAMESPACE_TERMINATED', 'FORK_DENIED'].includes(cleanup.descendants as string))
  return { ...base, currency: sameHead ? combined : 'stale', tested: v.tested && sameHead, outcome: receipt.command_outcome, receipt_digest: receipt.digest }
}
export async function parseProjectTestEvidence(value: unknown, subject: EvidenceSubject, requestedCursor = '0'): Promise<EvidencePage> {
  evidenceSubjectKey(subject); exactEvidenceCursor(requestedCursor)
  need(new TextEncoder().encode(JSON.stringify(value)).length <= 2560 * 1024)
  const page = object(value)
  keys(page, ['results', 'next_cursor', 'accepted_source'])
  need(page.accepted_source === false && Array.isArray(page.results) && page.results.length <= 4)
  const next = page.next_cursor === null ? null : exactEvidenceCursor(page.next_cursor)
  need(next === null || BigInt(next) > BigInt(requestedCursor))
  const results: ProjectTestEvidence[] = []
  for (const raw of page.results) {
    const result = await parseRow(raw, subject)
    need(!results.some(x => x.test_id === result.test_id && x.launch_key === result.launch_key))
    results.push(result)
  }
  return { results, next_cursor: next }
}

/** Actual display request owner; responses are revoked on supersession/unmount.
 * It neither cancels a server operation nor recovers/creates any run authority.
 */
export class ProjectTestEvidenceReader {
  private sequence = 0
  private alive = true
  private readonly subject: EvidenceSubject
  constructor(private readonly call: EvidenceCall, subject: EvidenceSubject, private readonly update: (state: EvidenceState) => void) {
    evidenceSubjectKey(subject); this.subject = { ...subject }
  }
  async load(cursor = '0'): Promise<void> {
    if (!this.alive) return
    const request = projectTestEvidenceRequest(this.subject, cursor), mine = ++this.sequence
    this.update({ pending: true, page: null, error: null })
    try {
      const raw = await this.call('GET', request.path, undefined, request.query)
      if (!this.alive || mine !== this.sequence) return
      const page = await parseProjectTestEvidence(raw, this.subject, cursor)
      if (this.alive && mine === this.sequence) this.update({ pending: false, page, error: null })
    } catch {
      if (this.alive && mine === this.sequence) this.update({ pending: false, page: null, error: 'Test evidence is unavailable or its retained binding could not be verified.' })
    }
  }
  dispose(): void { this.alive = false; ++this.sequence }
}
