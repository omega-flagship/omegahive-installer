import { expect, it } from 'vitest'
import { debuggerFrame, DebuggerTranscript, verifyDebuggerRun, type DebuggerRun } from './debuggerSession'
const h = 'a'.repeat(64)
const run: DebuggerRun = { id:'run_one',workspace_id:'ws_one',generation:1,tree_digest:h,status:'running',debugger_session:{runtime_id:'debug',identity_digest:h,helper_digest:h,protocol:'omegacode-debugger-jsonl-v1',all_inputs_require_run_authority:true} }
const fields = { path:'src/Ω.py',breakpoints:'1, 4',thread:2,frame:3,reference:4,after:0,limit:20,event:'stopped',timeout:1000 }
const ready = JSON.stringify({event:'ready',protocol:'omegacode-debugger-jsonl-v1',context:{run_id:run.id,generation:1,tree_digest:h,runtime_identity_digest:h,runtime:'debugpy'}})+'\n'
it('uses exact UTF-8 and closed operation fields without expressions or arbitrary commands', () => {
  const f = debuggerFrame('launch','launch-one',fields)
  expect(new TextDecoder().decode(Uint8Array.from(atob(f.data_base64),c=>c.charCodeAt(0)))).toBe('{"id":"launch-one","op":"launch","path":"src/Ω.py","breakpoints":[1,4]}\n')
  expect(debuggerFrame('stack','s',fields).request).toEqual({id:'s',op:'stack',thread_id:2,after:0,limit:20})
  expect(debuggerFrame('close','c',fields).request).toEqual({id:'c',op:'close'})
})
it('refuses escape paths, duplicate breakpoints, invalid IDs, bounds and unsupported events',()=> {
  for(const path of ['/etc/passwd','../x','a/../x','a\\x','a//x']) expect(()=>debuggerFrame('launch','l',{...fields,path})).toThrow()
  for(const breakpoints of ['1,1','0','1.5','1e3']) expect(()=>debuggerFrame('launch','l',{...fields,breakpoints})).toThrow()
  for(const thread of [0,-1,NaN,1.2]) expect(()=>debuggerFrame('next','n',{...fields,thread})).toThrow()
  expect(()=>debuggerFrame('variables','v',{...fields,limit:101})).toThrow()
  expect(()=>debuggerFrame('wait','w',{...fields,event:'evaluate'})).toThrow()
  expect(()=>debuggerFrame('launch','l',{...fields,path:'Ω'.repeat(5000)})).toThrow('8192')
})
it('waits for complete ready frames and validates source/runtime before results',()=> {
  verifyDebuggerRun(run,'ws_one'); expect(()=>verifyDebuggerRun(run,'ws_other')).toThrow()
  expect(()=>verifyDebuggerRun({...run,debugger_session:{...run.debugger_session!,helper_digest:'bad'}},'ws_one')).toThrow()
  const t = new DebuggerTranscript(run);t.append(ready.slice(0,-1));expect(t.ready).toBe(false);t.append(ready);expect(t.ready).toBe(true)
  const result=JSON.stringify({event:'result',id:'s',op:'stack',input_sequence:1,result:{stackFrames:[]}})+'\n'
  t.append(ready+result.slice(0,-1));expect(t.events).toHaveLength(1);t.append(ready+result);expect(t.events).toHaveLength(2)
  t.append(ready+result);expect(t.events).toHaveLength(2)
  const foreign=new DebuggerTranscript({...run,generation:2});foreign.append(ready);expect(foreign.ready).toBe(false)
})
it('refuses replaced output, malformed or reordered replies and bounds retained evidence',()=> {
  const t=new DebuggerTranscript(run);t.append(ready);expect(()=>t.append('x'+ready.slice(1))).toThrow('changed')
  t.append(ready+'{"event":"result","id":"x","op":"stack","input_sequence":0}\n');expect(t.ready).toBe(false)
  const bounded=new DebuggerTranscript(run);bounded.append(ready+Array.from({length:205},(_,i)=>JSON.stringify({event:'result',op:'threads',id:String(i),input_sequence:i+1})+'\n').join(''));expect(bounded.events).toHaveLength(200)
  const malformed=new DebuggerTranscript(run);malformed.append('bad\n'.repeat(15));expect(malformed.diagnostics).toHaveLength(10)
})
