import { expect, it } from 'vitest'
import { decodePages, selectionPayload, type Review } from './reviewSelection'
const ws = { id: 'ws_a', generation: 7, tree_digest: 'tree7' }
const review: Review = { id: 'review_a', workspace_id: 'ws_a', generation: 7, tree_digest: 'tree7', currency: 'current', cursor: 2, eof: true, hunks: [{ id: 'h_a', path: 'a', kind: 'text', before: null, after: null }, { id: 'h_b', path: 'b', kind: 'file', before: null, after: null }] }
it('refuses stale and foreign versions and only sends the explicit frozen selection', () => {
  expect(selectionPayload(ws, review, ['h_b'], 'op')).toEqual({ review_id: 'review_a', operation_id: 'op', hunk_ids: ['h_b'], expected_generation: 7, expected_tree_digest: 'tree7' })
  for (const changed of [{ ...ws, id: 'ws_b' }, { ...ws, generation: 8 }, { ...ws, tree_digest: 'other' }]) expect(() => selectionPayload(changed, review, ['h_a'], 'op')).toThrow('changed')
  expect(() => selectionPayload(ws, { ...review, currency: 'stale' }, ['h_a'], 'op')).toThrow('changed')
  for (const ids of [[], ['foreign'], ['h_a', 'h_a']]) expect(() => selectionPayload(ws, review, ids, 'op')).toThrow('unique')
})
it('preserves UTF8 across byte pages and displays binary explicitly', () => {
  expect(decodePages(['w6k=', '8J8=', 'mIA='])).toBe('é😀')
  expect(decodePages(['AP8='])).toBe('Binary bytes (hex):\n00 ff')
})
