export const symbolicOps = ['eval', 'add', 'remove', 'query', 'atoms', 'snapshot', 'snapshots', 'snapshot-atoms', 'snapshot-bytes', 'diff', 'close'] as const
export type SymbolicOp = typeof symbolicOps[number]
export interface SymbolicRun {
  id: string; workspace_id: string; generation: number; tree_digest: string; status: string
  argv: string[]; timeout_seconds: number
  symbolic_session?: { runtime_id: string; identity_digest: string; helper_digest: string; protocol: string }
}
export interface SymbolicEvent { event: 'ready' | 'result' | 'error'; protocol?: string; id?: string; op?: string; result?: unknown; reason?: string; atom_count?: number; context?: Record<string, unknown> }
export const activeSymbolicRun = (run: SymbolicRun) => ['starting', 'running'].includes(run.status)
export function verifySymbolicRun(run: SymbolicRun, workspace: string) {
  if (run.workspace_id !== workspace || !/^run_[A-Za-z0-9_-]+$/.test(run.id) ||
      run.symbolic_session?.protocol !== 'omegacode-symbolic-jsonl-v1' || !run.argv.length ||
      !Number.isSafeInteger(run.generation) || run.generation < 1 || !/^[a-f0-9]{64}$/.test(run.tree_digest) ||
      !/^[a-f0-9]{64}$/.test(run.symbolic_session.identity_digest)) throw new Error('Run is not a symbolic session in this workspace')
}
export function symbolicFrame(op: SymbolicOp, id: string, fields: { source: string; label: string; snapshot: string; base: string; incoming: string; after: number; limit: number }) {
  if (!symbolicOps.includes(op) || !id || id.length > 160) throw new Error('Invalid symbolic operation or input ID')
  let request: Record<string, unknown> = { id, op }
  if (['eval', 'add', 'remove', 'query'].includes(op)) {
    if (!fields.source || new TextEncoder().encode(fields.source).length > 7000) throw new Error('Source needs 1 to 7000 UTF-8 bytes')
    request = { ...request, source: fields.source }
  } else if (op === 'snapshot') {
    if (fields.label.length > 160) throw new Error('Snapshot label exceeds 160 characters')
    request = { ...request, label: fields.label }
  } else if (op !== 'close') {
    if (!Number.isSafeInteger(fields.after) || fields.after < 0 || !Number.isSafeInteger(fields.limit) || fields.limit < 1 || fields.limit > (op === 'snapshot-bytes' ? 8192 : 100)) throw new Error('Invalid page offset or limit')
    request = { ...request, after: fields.after, limit: fields.limit }
    if (op === 'snapshot-atoms' || op === 'snapshot-bytes') {
      if (!/^atoms_[a-f0-9]{64}$/.test(fields.snapshot)) throw new Error('Select a snapshot ID from this session')
      request.snapshot_id = fields.snapshot
    }
    if (op === 'diff') {
      if (![fields.base, fields.incoming].every(id => /^atoms_[a-f0-9]{64}$/.test(id))) throw new Error('Diff needs two snapshot IDs')
      request = { ...request, base: fields.base, incoming: fields.incoming }
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(request) + '\n')
  if (bytes.length > 8192) throw new Error('Encoded input frame exceeds 8192 bytes')
  return { id, request, data_base64: btoa(String.fromCharCode(...bytes)), bytes: bytes.length }
}

/** Output is evidence of worker responses, never authority to issue another input. */
export class SymbolicTranscript {
  events: SymbolicEvent[] = []
  ready = false
  diagnostics: string[] = []
  private after = 0
  constructor(readonly run: SymbolicRun) {}
  append(text: string) {
    const fresh: SymbolicEvent[] = []
    if (text.length < this.after) throw new Error('Transcript changed; explicitly replay the output reader')
    for (;;) {
      const next = text.indexOf('\n', this.after)
      if (next < 0) break
      const line = text.slice(this.after, next).trim(); this.after = next + 1
      if (!line) continue
      try {
        const event = JSON.parse(line) as SymbolicEvent
        if (!event || !['ready', 'result', 'error'].includes(event.event)) throw new Error('Unsupported event')
        if (event.event === 'ready') {
          this.ready = false
          const c = event.context
          if (event.protocol !== 'omegacode-symbolic-jsonl-v1' || c?.run_id !== this.run.id || c?.generation !== this.run.generation || c?.tree_digest !== this.run.tree_digest ||
              c?.runtime_identity_digest !== this.run.symbolic_session?.identity_digest || c?.runtime !== 'hyperon') throw new Error('Ready context does not match selected run/source/runtime')
          this.ready = true
        } else if (!this.ready) throw new Error('No matching ready receipt before event')
        this.events.push(event)
        fresh.push(event)
        if (this.events.length > 200) this.events.shift()
      } catch (error) {
        this.diagnostics.push(error instanceof Error ? error.message : 'Non-JSON worker output')
        if (this.diagnostics.length > 10) this.diagnostics.shift()
      }
    }
    return fresh
  }
}
