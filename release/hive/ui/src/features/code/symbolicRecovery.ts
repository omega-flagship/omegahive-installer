import { symbolicOps, type SymbolicOp } from './symbolicSession'
export interface PendingSymbolic { path: string; body: Record<string, unknown>; kind: 'start' | 'input' | 'cancel' }
export interface SymbolicRecovery { version: 1; workspace: string; run: string; runtime: string; pending: PendingSymbolic | null; draft: { op: SymbolicOp; source: string; label: string; snapshot: string; base: string; incoming: string; after: number; limit: number } }
export const recoveryKey = (workspace: string) => 'omegacode:symbolic-recovery:v1:' + workspace
export function decodeRecovery(raw: string, workspace: string): SymbolicRecovery {
  if (new TextEncoder().encode(raw).length > 32768) throw new Error('Recovery record exceeds 32768 bytes')
  const value = JSON.parse(raw) as SymbolicRecovery
  if (!value || value.version !== 1 || value.workspace !== workspace || !value.draft ||
      typeof value.run !== 'string' || value.run && !/^run_[A-Za-z0-9_-]+$/.test(value.run) ||
      typeof value.runtime !== 'string' || value.runtime.length > 160) throw new Error('Recovery record belongs to another workspace or version')
  const draft = value.draft
  if (!symbolicOps.includes(draft.op) || !['source','label','snapshot','base','incoming'].every(k => typeof draft[k as keyof typeof draft] === 'string') ||
      new TextEncoder().encode(draft.source).length > 7000 || draft.label.length > 160 ||
      [draft.snapshot,draft.base,draft.incoming].some(id => id.length > 160) ||
      !Number.isSafeInteger(draft.after) || draft.after < 0 || !Number.isSafeInteger(draft.limit) || draft.limit < 1 || draft.limit > 8192) throw new Error('Recovery draft is malformed')
  if (value.pending) {
    const { path, body, kind } = value.pending
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.operation_id !== 'string' || !body.operation_id || body.operation_id.length > 160) throw new Error('Recovery operation is malformed')
    const keys = Object.keys(body).sort().join(',')
    if (kind === 'start') {
      if (path !== '/v1/runs' || body.workspace_id !== workspace || body.terminal !== true ||
          !Array.isArray(body.argv) || body.argv.length !== 1 || typeof body.argv[0] !== 'string' ||
          typeof body.symbolic_runtime_id !== 'string' || !Number.isSafeInteger(body.expected_generation) || Number(body.expected_generation) < 1 ||
          !/^[a-f0-9]{64}$/.test(String(body.expected_tree_digest)) || body.timeout_seconds !== 60 ||
          keys !== 'argv,expected_generation,expected_tree_digest,operation_id,symbolic_runtime_id,terminal,timeout_seconds,workspace_id') throw new Error('Recovery start does not match this workspace')
    } else if (kind === 'input') {
      if (!value.run || path !== `/v1/runs/${value.run}/terminal` || body.kind !== 'input' || keys !== 'data_base64,kind,operation_id' ||
          typeof body.data_base64 !== 'string' || atob(body.data_base64).length < 1 || atob(body.data_base64).length > 8192) throw new Error('Recovery input does not match the selected run')
    } else if (kind !== 'cancel' || !value.run || path !== `/v1/runs/${value.run}/cancel` || keys !== 'operation_id') throw new Error('Recovery cancellation does not match selected run')
  }
  return structuredClone(value)
}
