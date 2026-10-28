import { describe, expect, it } from 'vitest'
import { canApplyMerge, resolutionPayload, type MergeDraft, type MergeFile } from './mergeResolution'

const entry = { digest: 'source', size: 3, executable: false }
const conflict: MergeFile = { path: 'code.py', base: entry, ours: entry, incoming: entry, merged: entry, conflict: true, reason: 'text-overlap' }
const source = { generation: 7, tree_digest: 'tree7' }
const preview = { ...source, file_count: 1, conflict_count: 1 }
const manual = (content: string, format: 'text' | 'base64' = 'text'): MergeDraft => ({ choice: 'manual', content, format, executable: true })

describe('saved-source conflict resolution', () => {
  it('preserves Unicode, CRLF, missing final newline and executable mode', () => {
    const raw = 'é😀\r\nlast'
    const [result] = resolutionPayload([conflict], { 'code.py': manual(raw) })
    expect(new TextDecoder().decode(Uint8Array.from(atob(result.content_base64!), c => c.charCodeAt(0)))).toBe(raw)
    expect(result.executable).toBe(true)
  })
  it('preserves arbitrary binary and empty manual files', () => {
    expect(resolutionPayload([conflict], { 'code.py': manual('/4AA', 'base64') })[0].content_base64).toBe('/4AA')
    expect(resolutionPayload([conflict], { 'code.py': manual('') })[0].content_base64).toBe('')
  })
  it('requires every conflict and sends no implicit source or executable changes for a selected side', () => {
    expect(() => resolutionPayload([conflict], {})).toThrow('Choose a resolution')
    expect(resolutionPayload([conflict], { 'code.py': { ...manual('ignored'), choice: 'delete' } })).toEqual([{ path: 'code.py', choice: 'delete' }])
    expect(resolutionPayload([{ ...conflict, conflict: false }], {})).toEqual([])
  })
  it('refuses malformed binary and oversized manual content', () => {
    expect(() => resolutionPayload([conflict], { 'code.py': manual('?', 'base64') })).toThrow('Invalid base64')
    expect(() => resolutionPayload([conflict], { 'code.py': manual('é'.repeat(1048577)) })).toThrow('2 MiB')
  })
  it('requires a complete matching clean-source review before applying', () => {
    const drafts = { 'code.py': manual('resolved') }
    expect(canApplyMerge(source, preview, [conflict], true, false, drafts)).toBe(true)
    expect(canApplyMerge(source, preview, [conflict], true, true, drafts)).toBe(false)
    expect(canApplyMerge({ ...source, generation: 8 }, preview, [conflict], true, false, drafts)).toBe(false)
    expect(canApplyMerge({ ...source, tree_digest: 'new' }, preview, [conflict], true, false, drafts)).toBe(false)
    expect(canApplyMerge(source, preview, [], false, false, drafts)).toBe(false)
    expect(canApplyMerge(source, { ...preview, conflict_count: 2 }, [conflict], true, false, drafts)).toBe(false)
  })
})
