import { describe, it, expect } from 'vitest'
import { codeTestBody, requestCodeTest, resumeCodeTest, parseCodeTestQueueReceipt, type CodeTestIntentClient, type CodeTestRequest } from './testIntent'

const request: CodeTestRequest = { request_id: 'rq_original', proposal_id: `suggestion_${'a'.repeat(32)}` }
const intent = `ai_${'b'.repeat(24)}`
const operation = 'op-original-ask'
const receipt = () => ({ schema: 'hive.code-test-intent-receipt/1', kind: 'code.test', ...request,
  lease_id: 'lease_original', receiving_goal: 'g_original', controller_id: 'controller_original',
  message_id: 'message_original', state: 'queued', tested: false, accepted_source: false })
function fixture() {
  const calls: unknown[][] = []
  const client: CodeTestIntentClient = {
    askRecordCodeTestIntent: async (op, body) => { calls.push(['record', op, body]); return { kind: 'code.test', intent_id: intent, request_operation_id: `ask.${intent}`, state: 'pending', request: body.request } },
    askSubmitIntent: async (id) => { calls.push(['submit', id]); return receipt() },
  }
  return { calls, client }
}
describe('person Test through the original Ask intent', () => {
  it('records under exactly the admitted Ask operation and reports only queued', async () => {
    const f = fixture(); const said: string[] = []
    const answer = await requestCodeTest(f.client, request, async (text) => { said.push(text); return operation }, () => true)
    expect(answer.kind).toBe('queued')
    expect(said).toHaveLength(1)
    expect(f.calls).toEqual([['record', operation, { kind: 'code.test', request }], ['submit', intent]])
    if (answer.kind === 'queued') expect(answer.receipt).toEqual(receipt())
  })
  it('does not record if the draft or person changes during Ask admission', async () => {
    const f = fixture(); let current = true
    const result = await requestCodeTest(f.client, request, async () => { current = false; return operation }, () => current)
    expect(result).toEqual({ kind: 'left', attempted: false }); expect(f.calls).toEqual([])
  })
  it('keeps an unknown record tied to the same operation and never retries itself', async () => {
    const f = fixture(); let n = 0; const record = f.client.askRecordCodeTestIntent!
    f.client.askRecordCodeTestIntent = async (...args) => { if (++n === 1) { f.calls.push(['lost record', ...args]); throw new Error('PRIVATE_HTTP_BODY') }; return record(...args) }
    const first = await requestCodeTest(f.client, request, async () => operation, () => true)
    expect(first.kind).toBe('unknown'); expect(f.calls).toHaveLength(1)
    if (first.kind !== 'unknown') throw new Error('missing original attempt')
    const recovered = await resumeCodeTest(f.client, first.attempt, () => true)
    expect(recovered.kind).toBe('queued')
    expect(f.calls[0].slice(1)).toEqual(f.calls[1].slice(1))
    expect(JSON.stringify(first)).not.toContain('PRIVATE_HTTP_BODY')
  })
  it('recovers unknown submit using only the same intent, without another Ask or record', async () => {
    const f = fixture(); let n = 0
    f.client.askSubmitIntent = async (id) => { f.calls.push(['submit', id]); if (++n === 1) throw new Error('lost'); return receipt() }
    const first = await requestCodeTest(f.client, request, async () => operation, () => true)
    expect(first.kind).toBe('unknown'); expect(f.calls).toHaveLength(2)
    if (first.kind !== 'unknown') throw new Error('missing original intent')
    expect((await resumeCodeTest(f.client, first.attempt, () => true)).kind).toBe('queued')
    expect(f.calls).toEqual([['record', operation, { kind: 'code.test', request }], ['submit', intent], ['submit', intent]])
  })
  it('refuses another proposal, kind, grant or invented success in queue receipts', () => {
    for (const bad of [{ ...receipt(), proposal_id: `suggestion_${'f'.repeat(32)}` }, { ...receipt(), kind: 'code.request' }, { ...receipt(), token: 'PRIVATE' }, { ...receipt(), tested: true }, { ...receipt(), state: 'running' }]) expect(() => parseCodeTestQueueReceipt(bad, request)).toThrow()
  })
  it('does not submit another intent body or publish a late result to another person', async () => {
    const f = fixture()
    f.client.askRecordCodeTestIntent = async () => ({ kind: 'code.test', intent_id: intent, request_operation_id: `ask.${intent}`, state: 'pending', request: { ...request, request_id: 'rq_foreign' } })
    expect((await requestCodeTest(f.client, request, async () => operation, () => true)).kind).toBe('unknown')
    expect(f.calls).toEqual([])
    let current = true
    f.client.askRecordCodeTestIntent = async (_op, body) => ({ kind: 'code.test', intent_id: intent, request_operation_id: `ask.${intent}`, state: 'pending', request: body.request })
    f.client.askSubmitIntent = async () => { current = false; return receipt() }
    expect((await requestCodeTest(f.client, request, async () => operation, () => current)).kind).toBe('left')
  })
  it('rejects caller authority/command fields and unsafe selector ranges before Ask', () => {
    for (const bad of [{ ...request, argv: ['python'] }, { ...request, selection: { path: '../other', start_byte: 0, end_byte: 2 } }, { ...request, selection: { path: 'a.py', start_byte: 2, end_byte: 1 } }, { ...request, test_filter: 'a'.repeat(513) }]) expect(() => codeTestBody(bad as CodeTestRequest)).toThrow()
  })
  it('does not ask or fall back to a native run when the host method is unavailable', async () => {
    let said = false
    expect(await requestCodeTest({}, request, async () => { said = true; return operation }, () => true)).toEqual({ kind: 'unavailable' })
    expect(said).toBe(false)
  })
})

// A newly recorded test intent must not make the person's existing Code request path look unavailable.
import { parseIntentList, parseIntentView } from '../../api/askIntents'
const view = (kind: string) => ({ intent_id: intent, turn_id: 'turn_original', kind,
  request_operation_id: `ask.${intent}`, state: 'pending', request_id: null, lease_id: null,
  receiving_goal: null, links_rev: 0, last_refusal: null, last_dispatch: null })
it('accepts the known test kind in a mixed personal list without weakening default request parsing', () => {
  expect(parseIntentList({ intents: [view('code.request'), view('code.test')] }).map((v) => v.kind)).toEqual(['code.request', 'code.test'])
  expect(() => parseIntentView(view('code.test'))).toThrow()
  expect(parseIntentView(view('code.test'), { kind: 'code.test' }).kind).toBe('code.test')
})
it('still refuses an unknown intent kind instead of treating it as a code test', () => {
  expect(() => parseIntentList({ intents: [view('unknown.execute')] })).toThrow()
})

it('matches the Host reference-list and Unicode/total context limits without executable commands', () => {
  expect(codeTestBody({ ...request, selection: ['hunk_one', 'hunk_two'], test_filter: '😀'.repeat(512) }).request.selection).toEqual(['hunk_one', 'hunk_two'])
  for (const bad of [{ ...request, request_id: 'not-a-request' }, { ...request, selection: ['same', 'same'] }, { ...request, selection: ['control\n'] }, { ...request, test_filter: '\ud800' }, { ...request, selection: Array.from({ length: 32 }, (_, n) => String(n) + '😀'.repeat(198)) }]) expect(() => codeTestBody(bad)).toThrow()
})
