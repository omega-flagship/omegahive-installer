export const debuggerOps = ['launch', 'threads', 'stack', 'scopes', 'variables', 'next', 'step-in', 'step-out', 'continue', 'pause', 'wait', 'close'] as const
export type DebuggerOp = typeof debuggerOps[number]
export interface DebuggerRun {
  id: string; workspace_id: string; generation: number; tree_digest: string; status: string
  debugger_session?: { runtime_id: string; identity_digest: string; helper_digest: string; protocol: string; all_inputs_require_run_authority: boolean }
  descendants_terminated?: boolean
}
export interface DebuggerEvent { event: 'ready' | 'result' | 'error'; protocol?: string; context?: Record<string, unknown>; id?: string; op?: string; input_sequence?: number; reason?: string; result?: unknown }
const hash = /^[a-f0-9]{64}$/
export const activeDebuggerRun = (run: DebuggerRun) => ['starting', 'running'].includes(run.status)
export function verifyDebuggerRun(run: DebuggerRun, workspace: string) {
  const session = run.debugger_session
  if (run.workspace_id !== workspace || !/^run_[A-Za-z0-9_-]+$/.test(run.id) || !Number.isSafeInteger(run.generation) || run.generation < 1 || !hash.test(run.tree_digest) ||
      session?.protocol !== 'omegacode-debugger-jsonl-v1' || !session.all_inputs_require_run_authority || !hash.test(session.identity_digest) || !hash.test(session.helper_digest)) throw new Error('Run is not an authorized debugger session in this workspace')
}
export interface DebuggerFields { path: string; breakpoints: string; thread: number; frame: number; reference: number; after: number; limit: number; event: string; timeout: number }
function integer(value: number, min: number, max: number) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid debugger integer'); return value }
export function debuggerFrame(op: DebuggerOp, id: string, fields: DebuggerFields) {
  if (!debuggerOps.includes(op) || !id || id.length > 160) throw new Error('Invalid debugger input')
  const request: Record<string, unknown> = { id, op }
  if (op === 'launch') {
    if (!fields.path || fields.path.startsWith('/') || fields.path.includes('\\') || fields.path.split('/').some(x => !x || x === '.' || x === '..') || fields.path.includes('\0')) throw new Error('Target must be a saved relative file')
    const lines = fields.breakpoints.trim() ? fields.breakpoints.split(',').map(x => { if (!/^\s*\d+\s*$/.test(x)) throw new Error('Use comma-separated breakpoint lines'); return integer(Number(x), 1, 100000) }) : []
    if (lines.length > 100 || new Set(lines).size !== lines.length) throw new Error('Use at most 100 unique breakpoint lines')
    Object.assign(request, { path: fields.path, breakpoints: lines })
  }
  if (['stack','next','step-in','step-out','continue','pause'].includes(op)) request.thread_id = integer(fields.thread, 1, 2147483647)
  if (op === 'scopes') request.frame_id = integer(fields.frame, 1, 2147483647)
  if (op === 'variables') request.reference = integer(fields.reference, 1, 2147483647)
  if (op === 'stack' || op === 'variables') Object.assign(request, { after: integer(fields.after, 0, 100000), limit: integer(fields.limit, 1, 100) })
  if (op === 'wait') {
    if (!['stopped','continued','output','exited','terminated','process','thread','breakpoint'].includes(fields.event)) throw new Error('Unsupported debugger event')
    Object.assign(request, { event: fields.event, timeout_ms: integer(fields.timeout, 1, 5000) })
  }
  const bytes = new TextEncoder().encode(JSON.stringify(request)+'\n')
  if (bytes.length > 8192) throw new Error('Debugger input exceeds 8192 bytes')
  return { request, bytes: bytes.length, data_base64: btoa(String.fromCharCode(...bytes)) }
}
/** Complete, source-bound worker frames; terminal input consumption alone is never a debugger result. */
export class DebuggerTranscript {
  ready = false
  events: DebuggerEvent[] = []
  diagnostics: string[] = []
  private previous = ''
  private after = 0
  private sequence = 0
  constructor(readonly run: DebuggerRun) {}
  append(text: string) {
    if (!text.startsWith(this.previous)) throw new Error('Debugger transcript changed; explicitly replay output')
    this.previous = text
    for (;;) {
      const next = text.indexOf('\n', this.after)
      if (next < 0) break
      const line = text.slice(this.after, next); this.after = next+1
      try {
        if (new TextEncoder().encode(line).length > 65536) throw new Error('Oversized debugger frame')
        const event = JSON.parse(line) as DebuggerEvent
        if (!event || !['ready','result','error'].includes(event.event)) throw new Error('Unsupported debugger response')
        if (event.event === 'ready') {
          this.ready = false
          const c = event.context
          if (event.protocol !== 'omegacode-debugger-jsonl-v1' || c?.run_id !== this.run.id || c?.generation !== this.run.generation || c?.tree_digest !== this.run.tree_digest || c?.runtime_identity_digest !== this.run.debugger_session?.identity_digest || c?.runtime !== 'debugpy') throw new Error('Debugger ready source/runtime does not match')
          this.ready = true
        } else {
          if (!this.ready) throw new Error('No matching debugger ready receipt')
          if (!Number.isSafeInteger(event.input_sequence) || event.input_sequence! <= this.sequence || typeof event.id !== 'string' || !event.id || event.id.length > 160) throw new Error('Invalid debugger response sequence or input ID')
          if (event.event === 'result' && !debuggerOps.includes(event.op as DebuggerOp)) throw new Error('Unsupported debugger result operation')
          this.sequence = event.input_sequence!
        }
        this.events.push(event); if (this.events.length > 200) this.events.shift()
      } catch (error) {
        this.ready = false
        this.diagnostics.push(error instanceof Error ? error.message : 'Invalid worker response')
        if (this.diagnostics.length > 10) this.diagnostics.shift()
      }
    }
  }
}
