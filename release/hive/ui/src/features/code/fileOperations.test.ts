import { expect, it } from 'vitest'
import { filePatch } from './fileOperations'
const ws = { id: 'ws_a', generation: 7, tree_digest: 'tree7' }
const file = { path: 'old.metta', digest: 'digest', content: '(x "Ω;😀")\n' }
it('creates an absent empty path and freezes the observed version', () => {
  const patch = filePatch(ws, { kind: 'create', path: 'src/new.metta' }, 'op')
  ws.generation = 8
  expect(patch.expected_generation).toBe(7)
  expect(patch.edits).toEqual([{ path: 'src/new.metta', expected_digest: null, content: '' }])
})
it('moves in one atomic edit without overwriting the destination or altering content', () => {
  const patch = filePatch(ws, { kind: 'move', file, target: 'new.metta' }, 'op')
  expect(patch.edits).toEqual([{ path: file.path, expected_digest: file.digest, content: null },
    { path: 'new.metta', expected_digest: null, content: file.content }])
})
it('removes only the exact file digest and refuses duplicate or escaping paths', () => {
  expect(filePatch(ws, { kind: 'remove', file }, 'op').edits).toEqual([{ path: file.path, expected_digest: file.digest, content: null }])
  expect(() => filePatch(ws, { kind: 'move', file, target: file.path }, 'op')).toThrow('different destination')
  for (const path of ['/outside', '../outside', 'x/../y', 'x//y', './x', 'x\\y', 'x\0y']) {
    expect(() => filePatch(ws, { kind: 'create', path }, 'op')).toThrow('relative file path')
  }
})
