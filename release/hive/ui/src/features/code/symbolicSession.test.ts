import { describe, expect, it } from 'vitest'
import { symbolicFrame, SymbolicTranscript, verifySymbolicRun, type SymbolicRun } from './symbolicSession'
const digest = 'a'.repeat(64)
const run: SymbolicRun = { id: 'run_one', workspace_id: 'ws_one', generation: 2, tree_digest: digest, status: 'running', argv: ['/fixed/python'], timeout_seconds: 60, symbolic_session: { runtime_id: 'hyperon', identity_digest: digest, helper_digest: digest, protocol: 'omegacode-symbolic-jsonl-v1' } }
const fields = { source: '(fact Ω 😀)', label: '', snapshot: 'atoms_'+digest, base: 'atoms_'+digest, incoming: 'atoms_'+digest, after: 0, limit: 50 }
describe('symbolic session protocol', () => {
  it('preserves exact Unicode framed bytes and emits only operation fields', () => {
    const frame = symbolicFrame('add', 'input-one', fields)
    expect(new TextDecoder().decode(Uint8Array.from(atob(frame.data_base64), c => c.charCodeAt(0)))).toBe('{"id":"input-one","op":"add","source":"(fact Ω 😀)"}\n')
    expect(symbolicFrame('close', 'close', fields).request).toEqual({id:'close',op:'close'})
    expect(symbolicFrame('snapshot-bytes', 'bytes', {...fields,limit:8192}).request).toEqual({id:'bytes',op:'snapshot-bytes',after:0,limit:8192,snapshot_id:'atoms_'+digest})
  })
  it('refuses oversized encoded inputs and unsafe cursors/snapshot selection', () => {
    expect(() => symbolicFrame('eval','one',{...fields,source:'Ω'.repeat(3501)})).toThrow('UTF-8')
    expect(() => symbolicFrame('eval','one',{...fields,source:'\\'.repeat(5000)})).toThrow('frame')
    for (const after of [-1,NaN,1.5]) expect(() => symbolicFrame('atoms','one',{...fields,after})).toThrow('offset')
    expect(() => symbolicFrame('diff','one',{...fields,base:'foreign'})).toThrow('two snapshot')
    expect(() => symbolicFrame('snapshot-atoms','one',{...fields,snapshot:'foreign'})).toThrow('snapshot ID')
  })
  it('binds run and ready receipt to source/runtime and waits for complete lines', () => {
    verifySymbolicRun(run,'ws_one')
    expect(() => verifySymbolicRun(run,'ws_other')).toThrow()
    const transcript = new SymbolicTranscript(run)
    const ready = JSON.stringify({event:'ready',protocol:'omegacode-symbolic-jsonl-v1',context:{run_id:run.id,generation:2,tree_digest:digest,runtime_identity_digest:digest,runtime:'hyperon'}})
    transcript.append(ready); expect(transcript.ready).toBe(false)
    transcript.append(ready+'\n'); expect(transcript.ready).toBe(true)
    transcript.append(ready+'\n'+JSON.stringify({event:'result',id:'one',op:'eval',result:[['5']]})+'\n')
    expect(transcript.events).toHaveLength(2)
    transcript.append(ready+'\n'+JSON.stringify({event:'result',id:'one',op:'eval',result:[['5']]})+'\n')
    expect(transcript.events).toHaveLength(2)
    const foreign = new SymbolicTranscript({...run,generation:3}); foreign.append(ready+'\n')
    expect(foreign.ready).toBe(false); expect(foreign.diagnostics[0]).toContain('does not match')
  })
  it('refuses unready responses and bounds retained diagnostics/events', () => {
    const transcript = new SymbolicTranscript(run)
    transcript.append(Array(15).fill('{"event":"result"}\n').join(''))
    expect(transcript.events).toHaveLength(0); expect(transcript.diagnostics).toHaveLength(10)
  })
})
