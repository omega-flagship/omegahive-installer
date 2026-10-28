import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GitExportPanel } from '../../src/features/code/GitExportPanel'
import { DebuggerPanel } from '../../src/features/code/DebuggerPanel'
import { SymbolicPanel } from '../../src/features/code/SymbolicPanel'
import { ConfirmHost } from '../../src/ui/confirm'
import '../../src/index.css'

// Synthetic callbacks only: importing this harness never creates a Hive client or service grant.
const qa = { requests: [] as { method: string; path: string; body: unknown }[], loseNextReply: true, loseDebuggerReply: true }
Object.assign(window, { omegaCodeQA: qa })
let debugRun: Record<string,unknown> | null = null
let debugOutput = ''
const controls = new Map<string,unknown>()
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string,string>): Promise<T> {
  qa.requests.push({ method, path, body: structuredClone(body) })
  if (path.endsWith('/toolchains')) return { toolchains:[{ id:'debug',kind:'debugpy',available:true,capabilities:['python-dap-session'],session_argv:['/fixed/python'] }] } as T
  if (method==='POST' && path==='/v1/runs') {
    const request=body as {workspace_id:string;expected_generation:number;expected_tree_digest:string}
    debugRun={id:'run_debug',workspace_id:request.workspace_id,generation:request.expected_generation,tree_digest:request.expected_tree_digest,status:'running',debugger_session:{runtime_id:'debug',identity_digest:'a'.repeat(64),helper_digest:'b'.repeat(64),protocol:'omegacode-debugger-jsonl-v1',all_inputs_require_run_authority:true}}
    debugOutput=JSON.stringify({event:'ready',protocol:'omegacode-debugger-jsonl-v1',context:{run_id:'run_debug',generation:request.expected_generation,tree_digest:request.expected_tree_digest,runtime_identity_digest:'a'.repeat(64),runtime:'debugpy'}})+'\n'
    return debugRun as T
  }
  if (path==='/v1/runs/run_debug') return debugRun as T
  if (path.endsWith('/output')) {
    const all=new TextEncoder().encode(debugOutput);const after=Number(query?.after??0);const bytes=all.slice(after,after+16384)
    return {run_id:'run_debug',workspace_id:'ws_synthetic',after,cursor:after+bytes.length,size_bytes:all.length,readable_bytes:all.length,data:btoa(String.fromCharCode(...bytes)),source:'live-run-log',output_digest:null,status:'running',eof:true,complete:false,truncated:false} as T
  }
  if (path.endsWith('/terminal')) {
    const request=body as {operation_id:string;data_base64:string}
    if(!controls.has(request.operation_id)) controls.set(request.operation_id,{id:'ctl_synthetic',status:'queued'})
    if(qa.loseDebuggerReply){qa.loseDebuggerReply=false;throw new Error('Synthetic lost debugger response')}
    return controls.get(request.operation_id) as T
  }
  if (method !== 'POST' || !path.endsWith('/git/exports')) throw new Error('Unexpected synthetic route')
  if (qa.loseNextReply) { qa.loseNextReply = false; throw new Error('Synthetic lost response') }
  const request = body as { expected_generation: number; expected_tree_digest: string; history_mode?: string; branch: string }
  const original = request.history_mode === 'original'
  return { id: 'gx_synthetic', workspace_id: 'ws_synthetic', generation: request.expected_generation,
    tree_digest: request.expected_tree_digest, source_base_commit: 'a'.repeat(40),
    baseline_commit: original ? 'a'.repeat(40) : 'b'.repeat(40), commit: 'c'.repeat(40),
    branch_ref: `refs/heads/${request.branch}`, patch_digest: 'd'.repeat(64), patch_bytes: 0,
    bundle_digest: 'e'.repeat(64), bundle_bytes: 0, published: false,
    history_kind: original ? 'original-parent-ancestry' : 'reconstructed-manifest-snapshots',
    original_history_included: original } as T
}
function Harness() {
  const [dirty, setDirty] = useState(false)
  const [generation, setGeneration] = useState(1)
  const [pane, setPane] = useState('git')
  const ws = { id: 'ws_synthetic', generation, tree_digest: String(generation).repeat(64) }
  return <main className="h-screen bg-abyss text-ink"><h1>Isolated OmegaCode interaction check</h1>
    <p>Synthetic fixtures; no deployed parity or provider qualification.</p>
    <button onClick={() => setDirty(!dirty)}>Toggle dirty draft</button>
    <button onClick={() => setGeneration(generation + 1)}>Advance source</button>
    <button onClick={() => setPane('debugger')}>Open debugger pane</button>
    <button onClick={() => setPane(pane === 'git' ? 'symbolic' : 'git')}>Switch pane</button>
    <output aria-label="Source generation">{generation}</output>
    <div hidden={pane !== 'git'}><GitExportPanel call={call} ws={ws} dirty={dirty} /></div>
    <ConfirmHost />
    {/* Mount after the main host to catch the hidden-host regression. */}
    <div hidden={pane !== 'symbolic'}><SymbolicPanel call={call} ws={ws} dirty={dirty} active={pane === 'symbolic'} /></div>
    <div hidden={pane !== 'debugger'}><DebuggerPanel call={call} ws={ws} dirty={dirty} active={pane === 'debugger'} /></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Harness />)
