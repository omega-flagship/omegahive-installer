import { describe, expect, it } from 'vitest'
import { decodeRecovery, recoveryKey, type SymbolicRecovery } from './symbolicRecovery'
const record: SymbolicRecovery = { version:1,workspace:'ws_one',run:'run_one',runtime:'hyperon',pending:{kind:'input',path:'/v1/runs/run_one/terminal',body:{operation_id:'exact-original',kind:'input',data_base64:btoa('{"id":"one","op":"close"}\n')}},draft:{op:'eval',source:'!(+ 2 3)',label:'',snapshot:'',base:'',incoming:'',after:0,limit:50} }
describe('symbolic recovery data, never effect replay',()=>{
  it('preserves the exact input operation and isolates workspace keys',()=>{
    const saved=decodeRecovery(JSON.stringify(record),'ws_one')
    expect(saved.pending).toEqual(record.pending)
    expect(recoveryKey('ws_one')).not.toBe(recoveryKey('ws_other'))
    saved.draft.source='changed'; expect(record.draft.source).toBe('!(+ 2 3)')
  })
  it('refuses foreign scope, arbitrary routes, oversized bodies and mutated operation schemas',()=>{
    expect(()=>decodeRecovery(JSON.stringify(record),'ws_other')).toThrow('workspace')
    for(const pending of [{...record.pending,path:'/v1/operator/grants'},{...record.pending,body:{...record.pending!.body,approval_id:'injected'}},{...record.pending,body:{...record.pending!.body,data_base64:btoa('x'.repeat(8193))}}]) {
      expect(()=>decodeRecovery(JSON.stringify({...record,pending}),'ws_one')).toThrow()
    }
    expect(()=>decodeRecovery(' '.repeat(32769),'ws_one')).toThrow('exceeds')
  })
})
