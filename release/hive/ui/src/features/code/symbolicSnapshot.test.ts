import { describe, expect, it } from 'vitest'
import { SnapshotAssembler } from './symbolicSnapshot'
import type { SymbolicRun } from './symbolicSession'
const run: SymbolicRun = { id:'run_one', workspace_id:'ws_one',generation:2,tree_digest:'a'.repeat(64),status:'running',argv:['/fixed/python'],timeout_seconds:60,symbolic_session:{runtime_id:'hyperon',identity_digest:'b'.repeat(64),helper_digest:'c'.repeat(64),protocol:'omegacode-symbolic-jsonl-v1'} }
const context={generation:2,run_id:'run_one',runtime:'hyperon',runtime_identity_digest:'b'.repeat(64),tree_digest:'a'.repeat(64)}
const atoms=['(fact Ω 😀)','(fact Ω 😀)']
const raw=JSON.stringify(atoms); const bytes=new TextEncoder().encode(raw)
// Independently generated Python canonical JSON SHA-256 fixtures.
const metadata={id:'atoms_c2e0cdd196890fc314db15a022d066312b4020ae4dcd65eb5a79df049be64ac1',rendered_atoms_digest:'e80609dd456637ec26a9dd6774aa7a5f6839b2f36810a9fa7f8915d4c8c7cf68',content_bytes:bytes.length,context,representation:'rendered-atom-multiset-v1'}
const page=(after:number,chunk:Uint8Array)=>({snapshot_id:metadata.id,rendered_atoms_digest:metadata.rendered_atoms_digest,encoding:'base64',content_type:'application/json; charset=utf-8',data:btoa(String.fromCharCode(...chunk)),after,next:after+chunk.length,eof:after+chunk.length===bytes.length,total_bytes:bytes.length})
describe('resident snapshot byte verification',()=>{
  it('verifies exact split UTF-8 bytes, duplicate atoms and source/runtime identity',async()=>{
    const reader=new SnapshotAssembler(metadata,run)
    for(let i=0;i<bytes.length;i++) reader.append(page(i,bytes.slice(i,i+1)))
    expect(await reader.finish()).toEqual(atoms)
    expect(reader.cursor).toBe(bytes.length)
  })
  it('refuses foreign context, incomplete sequences, gaps and changing custody without advancing',async()=>{
    expect(()=>new SnapshotAssembler(metadata,{...run,generation:3})).toThrow('metadata')
    const reader=new SnapshotAssembler(metadata,run)
    await expect(reader.finish()).rejects.toThrow('incomplete')
    for(const change of [{snapshot_id:'atoms_other'},{rendered_atoms_digest:'0'.repeat(64)},{after:1},{next:5},{total_bytes:999},{eof:true}]){
      expect(()=>reader.append({...page(0,bytes.slice(0,1)),...change})).toThrow()
      expect(reader.cursor).toBe(0)
    }
    reader.append(page(0,bytes.slice(0,1)))
    expect(()=>reader.append(page(0,bytes.slice(0,1)))).toThrow('cursor')
  })
  it('detects tampering even with valid framing and rejects a forged identity',async()=>{
    const reader=new SnapshotAssembler(metadata,run)
    const changed=bytes.slice(); changed[1]=32
    reader.append(page(0,changed)); await expect(reader.finish()).rejects.toThrow('content digest')
    const forged=new SnapshotAssembler({...metadata,id:'atoms_'+'0'.repeat(64)},run)
    forged.append({...page(0,bytes),snapshot_id:'atoms_'+'0'.repeat(64)})
    await expect(forged.finish()).rejects.toThrow('identity digest')
  })
})
