import { describe, expect, it } from 'vitest'
import { gitExportBody, verifyGitHistory } from './gitHistory'
describe('Git export history identity', () => {
  const original={workspace_id:'ws_one',history_kind:'original-parent-ancestry',original_history_included:true,baseline_commit:'parent',source_base_commit:'parent',published:false}
  it('requires exact original parent and refuses mode/authority mismatches',()=>{
    verifyGitHistory(original,'ws_one','original')
    for(const change of [{baseline_commit:'reconstructed'},{original_history_included:false},{published:true},{workspace_id:'foreign'}]) expect(()=>verifyGitHistory({...original,...change},'ws_one','original')).toThrow()
    expect(()=>verifyGitHistory(original,'ws_one','snapshot')).toThrow()
  })
  it('preserves legacy snapshot payload and puts original mode in the approved body',()=>{
    const ws={id:'ws_one',generation:3,tree_digest:'tree'}
    const snapshot=gitExportBody(ws,'review/one','Message','snapshot','same-id')
    expect(snapshot).toEqual({operation_id:'same-id',expected_generation:3,expected_tree_digest:'tree',branch:'review/one',message:'Message'})
    expect(gitExportBody(ws,'review/one','Message','original','same-id')).toEqual({...snapshot,history_mode:'original'})
    verifyGitHistory({...original,history_kind:'reconstructed-manifest-snapshots',original_history_included:false,baseline_commit:'other'},'ws_one','snapshot')
  })
})
