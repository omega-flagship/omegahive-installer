/**
 * INVENTED DATA. The simulator's sandbox project test of a retained proposal on a fork, and its read-only evidence
 * route (GET /v1/workspaces/{ws}/suggestions/{id}/project-tests?limit=&cursor=, relayed read-scoped as hive/core/code.py
 * does), in the exact shapes features/code/suggestions/projectTestEvidence.ts reads strictly (the host's
 * code_project_results.py build_result projection: binding, receipt, observation, base64 captures).
 *
 * A test starts when the person's code.test intent is submitted (api/sim/intents.ts). For `runMs` it reads as a
 * dispatched, unresolved run (not tested); then as a settled result: passed (`1 passed in 0.02s`), or, with
 * `?simtest=fail`, failed (`assert add(2, 3) == 5` / AssertionError). Nothing here is a live runner or authority receipt.
 */
import { ApiError } from '../client'
import { canonical, sha256Text } from '../../features/code/suggestions/contract'

export type SimTestOutcome = 'pass' | 'fail'

/** The proposal and its parent, as the host binds them (sha256:-prefixed digests). */
export interface SimTestSource {
  request_id: string
  repository_id: string
  proposal: { proposal_id: string; proposal_digest: string; normalized_hunks_digest: string }
  parent: { workspace_id: string; generation: number; tree_digest: string }
}
export interface SimTestStart {
  lease_id: string
  controller_id: string
  issuer: string
  outcome: SimTestOutcome
  runMs: number
}
interface SimTest {
  test_id: string
  launch_key: string
  hold_id: string
  run_id: string
  started: number
  runMs: number
  outcome: SimTestOutcome
  binding: Record<string, unknown> & { parent: SimTestSource['parent'] }
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('')
const enc = new TextEncoder()
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const digestOf = async (bytes: Uint8Array) => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('')
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

const RULE = (title: string, fill = '=') => {
  const side = Math.max(1, Math.floor((78 - title.length - 2) / 2))
  const line = `${fill.repeat(side)} ${title} ${fill.repeat(side)}`
  return line.length < 80 ? line + fill.repeat(80 - line.length) : line
}
/** INVENTED pytest-like output of the fork's tests, with the proposal applied (or, failing, as if it were not). */
export function simTestStdout(outcome: SimTestOutcome): string {
  const head = [RULE('test session starts'), 'platform sim -- Python 3.12 (invented simulator run)', 'collected 1 item', '']
  if (outcome === 'pass') return [...head, 'tests/test_calculator.py .                                               [100%]', '', RULE('1 passed in 0.02s'), ''].join('\n')
  return [
    ...head,
    'tests/test_calculator.py F                                               [100%]',
    '',
    RULE('FAILURES'),
    RULE('test_add', '_'),
    '',
    '    def test_add():',
    '>       assert add(2, 3) == 5',
    'E       assert -1 == 5',
    'E        +  where -1 = add(2, 3)',
    '',
    'tests/test_calculator.py:5: AssertionError',
    RULE('short test summary info'),
    'FAILED tests/test_calculator.py::test_add - AssertionError: assert -1 == 5',
    RULE('1 failed in 0.02s'),
    '',
  ].join('\n')
}

const CURSOR = /^(0|[1-9][0-9]{0,18})$/

export class SimProjectTests {
  /** by proposal id, newest first */
  private tests = new Map<string, SimTest[]>()

  /** The controller's sandbox run of exactly this proposal on a fork (invented): dispatched now, settled after runMs. */
  start(source: SimTestSource, s: SimTestStart): void {
    const test_id = `pt_sim${hex(8)}`
    const binding = {
      schema: 'omegacode-project-test-binding/1', test_id, service_id: 'svc_simcode', capability_id: `cap_sim${hex(6)}`,
      request_id: source.request_id, lease_id: s.lease_id, controller_id: s.controller_id, issuer: s.issuer, repository_id: source.repository_id,
      proposal: { ...source.proposal }, parent: { ...source.parent },
      fork: { workspace_id: `ws_simfork${hex(6)}`, preparation_digest: `sha256:${hex(32)}` },
      test_tree_digest: `sha256:${hex(32)}`, runtime: 'python', argv: ['python', '-m', 'pytest', '-q'], runtime_seconds: 60,
    }
    const t: SimTest = { test_id, launch_key: `launch.sim:${hex(6)}`, hold_id: `ph_${hex(12)}`, run_id: `run_sbx_${hex(16)}`, started: Date.now(), runMs: s.runMs, outcome: s.outcome, binding }
    this.tests.set(source.proposal.proposal_id, [t, ...(this.tests.get(source.proposal.proposal_id) ?? [])])
  }

  /** GET …/suggestions/{id}/project-tests?limit=&cursor= : one page, `current` against the workspace head given. */
  async page(proposalId: string, head: { generation: number; tree_digest: string }, query: Record<string, string>): Promise<unknown> {
    const limit = Number(query.limit ?? '4')
    const cursor = query.cursor ?? '0'
    if (!Number.isInteger(limit) || limit < 1 || limit > 4 || !CURSOR.test(cursor)) throw new ApiError(400, 'bad_request', 'limit is 1 to 4 and cursor a decimal offset')
    const all = this.tests.get(proposalId) ?? []
    const from = Number(cursor)
    const slice = all.slice(from, from + limit)
    const results = await Promise.all(slice.map((t) => this.row(t, head)))
    return { results, next_cursor: from + limit < all.length ? String(from + limit) : null, accepted_source: false }
  }

  private async row(t: SimTest, head: { generation: number; tree_digest: string }) {
    const sourceCurrent = t.binding.parent.generation === head.generation && t.binding.parent.tree_digest === `sha256:${head.tree_digest}`
    const source = sourceCurrent ? 'current' : 'stale'
    const base = { test_id: t.test_id, launch_key: t.launch_key, source_currency: source, accepted_source: false }
    const at = Date.now()
    if (at - t.started < t.runMs) {
      // dispatched, not yet settled: the runner's outcome is not known, so the execution (and the whole) is unknown
      const result = { schema: 'omegacode-sandbox-dispatch/1', state: 'dispatch_unresolved', test_id: t.test_id, launch_key: t.launch_key, hold_id: t.hold_id, run_id: t.run_id, binding: structuredClone(t.binding), revision: 1 }
      return { ...base, result, execution_currency: 'unknown', currency: sourceCurrent ? 'unknown' : 'stale', tested: false }
    }
    const pass = t.outcome === 'pass'
    const out = enc.encode(simTestStdout(t.outcome))
    const err = new Uint8Array()
    const stream = async (bytes: Uint8Array) => ({ digest: await digestOf(bytes), retained_bytes: bytes.length, observed_bytes: bytes.length, eof: true, truncated: false, complete: true })
    const observedAt = iso(t.started + t.runMs)
    const body = {
      schema: 'omegacode-sandbox-test-result/1', binding: structuredClone(t.binding), binding_digest: `sha256:${await sha256Text(canonical(t.binding))}`,
      run_id: t.run_id, snapshot_digest: `sha256:${'5e'.repeat(32)}`, program_identity: { id: 'code-project-test', version: 'simulator', files: 2 },
      execution_backend: 'sandbox-exec', streams: { stdout: await stream(out), stderr: await stream(err) }, exit_code: pass ? 0 : 1, elapsed_seconds: 1,
      cleanup: { complete: true, original_process_reaped: true, original_group_absent: true, job_removed: true, errors: [], descendants: 'FORK_DENIED' },
      configured_limits: {}, limit_availability: {}, primary_error: null, output_complete: true, authorization_error: null, never_started_proven: false,
      command_outcome: pass ? 'succeeded' : 'not_succeeded', observed_at: observedAt, accepted_source: false, independent_evaluation: false,
    }
    const receipt = { ...body, digest: `sha256:${await sha256Text(canonical(body))}` }
    const observation = { outcome: pass ? 'completed' : 'failed', run_id: t.run_id, runtime: { seconds: 1, provenance: 'wall_clock_bound' }, cleanup: { descendants_stopped: true, observed_at: observedAt }, evidence: { launch_record_state: 'ended', launch_record_rev: 2 }, receipt_digest: receipt.digest }
    const result = { schema: 'omegacode-sandbox-dispatch-result/1', test_id: t.test_id, launch_key: t.launch_key, hold_id: t.hold_id, receipt, observation, captures: { stdout: b64(out), stderr: b64(err) }, revision: 2 }
    return { ...base, result, execution_currency: 'current', currency: source, tested: pass && sourceCurrent }
  }
}
