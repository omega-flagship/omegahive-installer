import { useEffect, useRef, useState } from 'react'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Button } from '../../ui/primitives'
import { useUnsaved } from '../ask/dirty'
import { RunSourceReader, type SourcePage } from './runSource'
import { OutputReader, type OutputPage } from './runOutput'
import { activeDebuggerRun, debuggerFrame, debuggerOps, DebuggerTranscript, verifyDebuggerRun, type DebuggerEvent, type DebuggerFields, type DebuggerOp, type DebuggerRun } from './debuggerSession'
type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string,string>) => Promise<T>
interface Workspace { id: string; generation: number; tree_digest: string }
interface Runtime { id: string; kind: string; available: boolean; capabilities: string[]; session_argv?: string[] }
interface Pending { kind: 'start' | 'input' | 'cancel'; path: string; body: Record<string,unknown> }
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e)
const sameRun = (a: DebuggerRun, b: DebuggerRun) => a.id === b.id && a.workspace_id === b.workspace_id && a.generation === b.generation && a.tree_digest === b.tree_digest && a.debugger_session?.identity_digest === b.debugger_session?.identity_digest && a.debugger_session?.helper_digest === b.debugger_session?.helper_digest && a.debugger_session?.runtime_id === b.debugger_session?.runtime_id

/** Mounted per workspace. No automatic input, target replay or debugger-state restoration. */
export function DebuggerPanel({ call, ws, dirty, active = true }: { call: Call; ws: Workspace; dirty: boolean; active?: boolean }) {
  const [runtimes,setRuntimes]=useState<Runtime[]>([])
  const [runtime,setRuntime]=useState('')
  const [run,setRun]=useState<DebuggerRun|null>(null)
  const [savedSource,setSavedSource]=useState<{path:string;digest:string;content:string;line:number;run:DebuggerRun}|null>(null)
  const [attach,setAttach]=useState('')
  const [op,setOp]=useState<DebuggerOp>('launch')
  const [fields,setFields]=useState<DebuggerFields>({path:'',breakpoints:'',thread:1,frame:1,reference:1,after:0,limit:20,event:'stopped',timeout:1000})
  const [busy,setBusy]=useState(false)
  const [pending,setPending]=useState<Pending|null>(null)
  // a request retained for an exact retry: a reload must not drop it
  useUnsaved(!!pending)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [view,setView]=useState<{ready:boolean;events:DebuggerEvent[];diagnostics:string[]}>({ready:false,events:[],diagnostics:[]})
  const alive=useRef(true)
  const current=useRef({ws,dirty,active})
  const reader=useRef<OutputReader|null>(null)
  const transcript=useRef<DebuggerTranscript|null>(null)
  useEffect(()=>{current.current={ws,dirty,active}},[ws,dirty,active])
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  const job=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work()}catch(e){if(alive.current)setError(errorMessage(e))}finally{if(alive.current)setBusy(false)}}
  const select=(selected:DebuggerRun)=>{
    verifyDebuggerRun(selected,current.current.ws.id)
    if(!alive.current)return
    reader.current=new OutputReader(selected.id,selected.workspace_id);transcript.current=new DebuggerTranscript(selected)
    setSavedSource(null);setRun(selected);setAttach(selected.id);setView({ready:false,events:[],diagnostics:[]})
  }
  const confirm=async(text:string,label:string)=>{
    const ok=await askConfirm(text,label)
    if(ok&&(!alive.current||!current.current.active))throw new Error('Debugger pane changed during confirmation; review again')
    return ok
  }
  const perform=async(request:Pending)=>{
    if(request.kind!=='start'){
      if(!run||request.path!==`/v1/runs/${run.id}/${request.kind==='input'?'terminal':'cancel'}`)throw new Error('Reconnect the original run before retrying')
      if(request.kind==='input'&&!view.ready)throw new Error('Read the matching debugger ready receipt before input retry')
    }
    setPending(request)
    const response=await call<DebuggerRun&{id:string;status:string}>('POST',request.path,request.body)
    if(!alive.current)return
    if(request.kind==='start')select(response)
    setPending(null)
    setNotice(request.kind==='input'?`Input ${response.id}: ${response.status}. Read the matching worker response; byte consumption is not completion.`:`Run ${response.id}: ${response.status}. Read status and stop evidence.`)
  }
  const start=()=>job(async()=>{
    const selected=runtimes.find(r=>r.id===runtime)
    if(!selected?.available||!selected.capabilities.includes('python-dap-session')||selected.session_argv?.length!==1)throw new Error('Select an enabled Python debugger runtime')
    const source={...current.current.ws}
    if(current.current.dirty)throw new Error('Save or discard editor changes first')
    const body={operation_id:crypto.randomUUID(),workspace_id:source.id,expected_generation:source.generation,expected_tree_digest:source.tree_digest,argv:selected.session_argv,debugger_runtime_id:selected.id,terminal:true,timeout_seconds:120}
    if(!await confirm(`Start trusted native debugger on this exact source for up to 120 seconds?\n${JSON.stringify(body)}`,'Start debugger'))return
    if(current.current.dirty||current.current.ws.id!==source.id||current.current.ws.generation!==source.generation||current.current.ws.tree_digest!==source.tree_digest)throw new Error('Source changed during confirmation')
    await perform({kind:'start',path:'/v1/runs',body})
  })
  const send=()=>job(async()=>{
    if(!run||!activeDebuggerRun(run)||!view.ready)throw new Error('Read the active debugger ready receipt first')
    const original=run
    const frame=debuggerFrame(op,crypto.randomUUID(),fields)
    if(!await confirm(`Authorize exact ${frame.bytes}-byte ${op} input on ${run.id}, source generation ${run.generation}? Inspection may execute target code.\n${JSON.stringify(frame.request)}`,'Send debugger input'))return
    if(!sameRun(original,run))throw new Error('Selected debugger changed')
    await perform({kind:'input',path:`/v1/runs/${run.id}/terminal`,body:{operation_id:crypto.randomUUID(),kind:'input',data_base64:frame.data_base64}})
  })
  const refresh=()=>job(async()=>{
    if(!run||!reader.current||!transcript.current)return
    const status=await call<DebuggerRun>('GET',`/v1/runs/${run.id}`)
    verifyDebuggerRun(status,ws.id);if(!sameRun(status,run))throw new Error('Debugger source/runtime identity changed')
    if(!alive.current)return
    setRun(status)
    for(let i=0;i<4;i++){
      const page=await call<OutputPage>('GET',`/v1/runs/${run.id}/output`,undefined,{after:String(reader.current.cursor),limit:'16384'})
      if(!alive.current)return
      const outcome=reader.current.append(page)
      if(outcome==='replay'){reader.current=new OutputReader(run.id,ws.id);transcript.current=new DebuggerTranscript(run);continue}
      transcript.current.append(reader.current.text)
      if(outcome!=='continue')break
    }
    setView({ready:transcript.current.ready,events:[...transcript.current.events],diagnostics:[...transcript.current.diagnostics]})
  })
  const readSource=(path:string,line:number)=>job(async()=>{
    if(!run||!Number.isSafeInteger(line)||line<1||line>1000000)throw new Error('Select a saved source frame with a valid line')
    setSavedSource(null)
    const selected=run;const assembly=new RunSourceReader(selected)
    let done=false
    for(let i=0;i<129;i++){
      const page=await call<SourcePage>('GET',`/v1/runs/${selected.id}/source`,undefined,{source_path:path,after:String(assembly.cursor),limit:'16384'})
      if(!alive.current)return
      done=assembly.append(page);if(done)break
    }
    if(!done)throw new Error('Saved source exceeds the bounded read budget')
    const verified=await assembly.finish()
    if(alive.current)setSavedSource({...verified,line,run:selected})
  })
  const cancel=()=>job(async()=>{if(run&&await confirm(`Cancel debugger ${run.id}? Target stop requires observed cleanup evidence.`,'Cancel debugger'))await perform({kind:'cancel',path:`/v1/runs/${run.id}/cancel`,body:{operation_id:crypto.randomUUID()}})})
  const frozen=busy||pending!==null
  const numberField=(key:'thread'|'frame'|'reference'|'after'|'limit'|'timeout',label:string)=> <label>{label} <input aria-label={label} type="number" value={fields[key]} onChange={e=>setFields({...fields,[key]:Number(e.target.value)})} /></label>
  return <section aria-label="Python debugger" className="h-full overflow-auto space-y-4 p-4">
    {active&&<ConfirmHost/>}
    <p>Python debugger · one saved target per frozen session. All inputs require run authority. No automatic launch, replay or expression evaluation.</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={frozen} onClick={()=>job(async()=>{const result=await call<{toolchains:Runtime[]}>('GET',`/v1/workspaces/${ws.id}/toolchains`);if(alive.current)setRuntimes(result.toolchains.filter(r=>r.kind==='debugpy'))})}>Discover debugger runtimes</Button>
      <select aria-label="Debugger runtime" disabled={frozen} value={runtime} onChange={e=>setRuntime(e.target.value)}><option value="">Select runtime</option>{runtimes.map(r=><option key={r.id} value={r.id} disabled={!r.available||!r.session_argv}>{r.id}</option>)}</select>
      <Button disabled={frozen||dirty||!runtime||!!run&&activeDebuggerRun(run)} onClick={start}>Start debugger</Button>
      <input aria-label="Existing debugger run ID" disabled={frozen} value={attach} onChange={e=>setAttach(e.target.value)} placeholder="run_…"/>
      <Button disabled={busy||pending?.kind==='start'||!attach} onClick={()=>job(async()=>{if(!/^run_[A-Za-z0-9_-]+$/.test(attach))throw new Error('Enter a run ID');if(pending&&pending.path!==`/v1/runs/${attach}/${pending.kind==='input'?'terminal':'cancel'}`)throw new Error('Reconnect the pending original run');select(await call<DebuggerRun>('GET',`/v1/runs/${attach}`))})}>Reconnect debugger</Button>
    </div>
    {run&&<div className="space-y-2"><p>{run.id} · {run.status} · generation {run.generation}{run.generation!==ws.generation||run.tree_digest!==ws.tree_digest?' · historical frozen source':''}{dirty?' · unsaved editor changes excluded':''}</p><p className="break-all font-mono text-xs">source {run.tree_digest}<br/>runtime {run.debugger_session?.runtime_id} / {run.debugger_session?.identity_digest}<br/>helpers {run.debugger_session?.helper_digest}</p><p>Target cleanup: {run.descendants_terminated===true?'observed stopped':run.descendants_terminated===false?'not proven stopped':'not yet observed'}.</p><Button disabled={busy} onClick={refresh}>Read debugger output / status</Button> <Button disabled={frozen||!activeDebuggerRun(run)} onClick={cancel}>Cancel debugger</Button></div>}
    {pending&&<div role="alert"><p>Uncertain {pending.kind} response. Other effects are frozen; retry retains the exact operation ID and body.</p><Button disabled={busy} onClick={()=>job(async()=>{if(await confirm(`Retry exact request?\n${JSON.stringify(pending.body)}`,'Retry exact debugger request'))await perform(pending)})}>Retry exact debugger request</Button></div>}
    <fieldset disabled={frozen||!run||!activeDebuggerRun(run)||!view.ready} className="space-y-2">
      <label>Debugger operation <select value={op} onChange={e=>setOp(e.target.value as DebuggerOp)}>{debuggerOps.map(x=><option key={x}>{x}</option>)}</select></label>
      {op==='launch'&&<><label>Saved target <input aria-label="Saved debugger target" value={fields.path} onChange={e=>setFields({...fields,path:e.target.value})}/></label><label>Breakpoint lines <input aria-label="Breakpoint lines" value={fields.breakpoints} placeholder="1, 12" onChange={e=>setFields({...fields,breakpoints:e.target.value})}/></label></>}
      {['stack','next','step-in','step-out','continue','pause'].includes(op)&&numberField('thread','Thread ID')}
      {op==='scopes'&&numberField('frame','Frame ID')}{op==='variables'&&numberField('reference','Variables reference')}
      {['stack','variables'].includes(op)&&<>{numberField('after','Page offset')}{numberField('limit','Page limit')}</>}
      {op==='wait'&&<><label>Event <select value={fields.event} onChange={e=>setFields({...fields,event:e.target.value})}>{['stopped','continued','output','exited','terminated','process','thread','breakpoint'].map(x=><option key={x}>{x}</option>)}</select></label>{numberField('timeout','Wait milliseconds')}</>}
      <Button onClick={send}>Review and send debugger input</Button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <p>{view.ready?'Matching debugger ready receipt observed.':'Read a matching debugger ready receipt before sending inputs.'}</p>
    {view.diagnostics.length>0&&<p role="alert">{view.diagnostics.join('; ')}</p>}
    {savedSource&&<section aria-label="Saved debugger source" className="space-y-2"><p>{savedSource.path} · saved run input generation {savedSource.run.generation} · {savedSource.run.generation!==ws.generation||savedSource.run.tree_digest!==ws.tree_digest?'historical':'current'} · line {savedSource.line}</p><p className="break-all text-xs">Verified file {savedSource.digest}. This is the saved input; target file mutations are not verified.</p><pre className="whitespace-pre-wrap break-all font-mono text-xs">{savedSource.content.split('\n').slice(Math.max(0,savedSource.line-13),savedSource.line+12).map((line,i)=>`${i+Math.max(0,savedSource.line-13)+1===savedSource.line?'→':' '} ${i+Math.max(0,savedSource.line-13)+1}: ${line}`).join('\n')}</pre></section>}
    <ol aria-label="Debugger responses" className="space-y-3">{view.events.map((event,i)=><li key={i} className="rounded border border-line p-2"><p>{event.op??event.event} · {event.id??'session'} · {event.input_sequence??'ready'}</p>{event.reason&&<p role="alert">{event.reason}</p>}<DebuggerResult result={event.result} disabled={frozen} open={readSource} select={(key,id)=>{setFields({...fields,[key]:id,after:0});setOp(key==='thread'?'stack':key==='frame'?'scopes':'variables')}}/><details><summary>Exact response</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(event,null,2)}</pre></details></li>)}</ol>
  </section>
}
function DebuggerResult({result,disabled,select,open}:{result:unknown;disabled:boolean;open:(path:string,line:number)=>void;select:(key:'thread'|'frame'|'reference',id:number)=>void}) {
  if(!result||typeof result!=='object'||Array.isArray(result))return null
  const value=result as Record<string,unknown>
  const rows = ['threads','stackFrames','scopes','variables'].flatMap(kind=>Array.isArray(value[kind])?(value[kind] as unknown[]).map(row=>({kind,row})):[])
  return <div className="space-y-2">{rows.map(({kind,row},i)=>{
    if(!row||typeof row!=='object')return null
    const item=row as Record<string,unknown>;const key=kind==='threads'?'thread':kind==='stackFrames'?'frame':'reference';const id=key==='reference'?item.variablesReference:item.id
    const source=item.source&&typeof item.source==='object'?item.source as Record<string,unknown>:null
    return <div key={i} className="break-all">{typeof source?.path==='string'&&typeof item.line==='number'&&Number.isSafeInteger(item.line)&&item.line>0&&<Button disabled={disabled} onClick={()=>open(source.path as string,item.line as number)}>Read saved source</Button>}<span>{String(item.name??'')} {item.value!==undefined?String(item.value):''} {source?`${String(source.path??source.name??'')} : ${String(item.line??'')}`:''}</span> {typeof id==='number'&&Number.isSafeInteger(id)&&id>0&&<Button disabled={disabled} onClick={()=>select(key,id)}>Select {key} {id}</Button>}</div>
  })}</div>
}
