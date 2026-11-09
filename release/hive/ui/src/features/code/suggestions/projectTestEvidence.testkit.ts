/** Invented transport DATA only; never a live runner/authority receipt. */
import { captureDigest, type EvidenceSubject } from './projectTestEvidence'
export const evidenceSubject: EvidenceSubject = {
  workspace_id: 'ws_a', generation: 2, tree_digest: '1'.repeat(64),
  proposal_id: 'suggestion_a', proposal_digest: '2'.repeat(64), normalized_hunks_digest: '3'.repeat(64),
}
export const emptyEvidencePage = () => ({ results: [], next_cursor: null, accepted_source: false })
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
export async function evidencePage() {
  const bytes = new TextEncoder().encode('original assertion output\n')
  const stdout = { digest: await captureDigest(bytes), retained_bytes: bytes.length, observed_bytes: bytes.length, complete: true, eof: true, truncated: false }
  const stderr = { digest: await captureDigest(new Uint8Array()), retained_bytes: 0, observed_bytes: 0, complete: true, eof: true, truncated: false }
  const tid = 'pt_original', key = 'launch.original:0001'
  const receipt = {
    schema: 'omegacode-sandbox-test-result/1', digest: 'sha256:' + 'a'.repeat(64),
    binding: { schema: 'omegacode-project-test-binding/1', test_id: tid,
      service_id: 'svc_original', capability_id: 'cap_original', request_id: 'rq_original', lease_id: 'lease_original', controller_id: 'controller_original', issuer: 'user:original', repository_id: 'repo_original',
      fork: { workspace_id: 'ws_fork', preparation_digest: 'sha256:' + '4'.repeat(64) }, test_tree_digest: 'sha256:' + '5'.repeat(64), runtime: 'python', argv: ['/selected/python', '-m', 'unittest'], runtime_seconds: 10,
      parent: { workspace_id: evidenceSubject.workspace_id, generation: 2, tree_digest: 'sha256:' + evidenceSubject.tree_digest },
      proposal: { proposal_id: evidenceSubject.proposal_id, proposal_digest: 'sha256:' + evidenceSubject.proposal_digest, normalized_hunks_digest: 'sha256:' + evidenceSubject.normalized_hunks_digest } },
    binding_digest: 'sha256:' + '6'.repeat(64), run_id: 'run_sbx_' + '7'.repeat(32), snapshot_digest: 'sha256:' + '8'.repeat(64), program_identity: { id: 'code-project-test', release_digest: '9'.repeat(64), version: 'fixture', files: 2 }, execution_backend: 'sandbox-exec', elapsed_seconds: 1, configured_limits: {}, limit_availability: {}, never_started_proven: false, observed_at: '2026-11-04T13:00:00Z',
    streams: { stdout, stderr }, command_outcome: 'succeeded', output_complete: true, exit_code: 0,
    primary_error: null, authorization_error: null, accepted_source: false, independent_evaluation: false,
    cleanup: { complete: true, original_process_reaped: true, original_group_absent: true, job_removed: true, errors: [], descendants: 'FORK_DENIED' },
  }
  const result = { schema: 'omegacode-sandbox-dispatch-result/1', test_id: tid, launch_key: key, hold_id: 'ph_' + 'b'.repeat(24), revision: 2,
    receipt, observation: { outcome: 'completed', run_id: receipt.run_id, runtime: { seconds: 1, provenance: 'wall_clock_bound' }, cleanup: { descendants_stopped: true, observed_at: '2026-11-04T13:00:00Z' }, evidence: { launch_record_state: 'ended', launch_record_rev: 2 }, receipt_digest: receipt.digest }, captures: { stdout: btoa(new TextDecoder().decode(bytes)), stderr: '' } }
  return { results: [{ test_id: tid, launch_key: key, result, source_currency: 'current', execution_currency: 'current', currency: 'current', tested: true, accepted_source: false }], next_cursor: null, accepted_source: false }
}

/** Actual _finish shape: {hold:{hold:<hold_view>,observation:<observation_view>}}.
 * Pure invented prior-owner DATA, not a real hold or accounting receipt. */
export async function evidencePageWithRetainedHold() {
  const page = await evidencePage(), row = page.results[0], result = row.result
  const settlement = {
    hold: { hold_id: result.hold_id, test_id: result.test_id, request_id: result.receipt.binding.request_id, launch_key: result.launch_key,
      argv_digest: 'sha256:' + 'c'.repeat(64), runtime_seconds_max: 10, state: 'settled', run_id: result.receipt.run_id,
      cleanup: 'observed', accounting: 'wall_clock_bound', charged_seconds: 1, overrun_seconds: 0, observation_count: 1,
      created_at: '2026-11-04T13:00:00Z', settled_at: '2026-11-04T13:00:01Z' },
    observation: { seq: 1, body_digest: 'd'.repeat(64), body: result.observation, state_before: 'dispatched', state_after: 'settled', received_at: '2026-11-04T13:00:01Z' },
  }
  return { ...page, results: [{ ...row, execution_currency: 'unknown', currency: 'unknown', tested: false, result: { ...result, hold: settlement } }] }
}
