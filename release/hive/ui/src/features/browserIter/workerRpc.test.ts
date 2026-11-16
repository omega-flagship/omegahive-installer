import { expect, it } from 'vitest'
import { createIterWorkerRpc } from './workerRpc'

function fixture(withClock = true, withReceive = true) {
  let operation: string | null = 'operation'
  const replies: unknown[] = [], tools: unknown[] = [], requests: object[] = []
  let request = async (_body: object): Promise<unknown> => ({ message: { role: 'assistant', content: 'Synthetic' } })
  const clocks: string[] = []
  let clock = async () => '2026-11-04 02:08:01'
  const receives: string[] = []
  let receive = async () => 'Host-acknowledged words'
  const rpc = createIterWorkerRpc({ operation: 'operation', operationNow: () => operation, current: () => true,
    experience: () => '[{"role":"user","content":"Synthetic"}]', memory: async () => [],
    clock: withClock ? op => { clocks.push(op); return clock() } : undefined,
    receive: withReceive ? op => { receives.push(op); return receive() } : undefined,
    request: b => { requests.push(b); return request(b) }, workerReply: b => ({ wrapped: b }),
    tool: async (...args) => { tools.push(args); return { ok: true } }, reply: r => replies.push(r) })
  return { rpc, replies, tools, requests, clocks, receives, replace: () => { operation = 'other' }, request: (fn: typeof request) => { request = fn }, clock: (fn: typeof clock) => { clock = fn }, receive: (fn: typeof receive) => { receive = fn } }
}
const model = { rpc: 1, type: 'llm', payload: { messages: '[{"role":"user","content":"Synthetic"}]', tools: '[]', maxTokens: 512 } }

it('passes model requests and exact model tool identity to their trusted owners', async () => {
  const f = fixture(); await f.rpc.handle(model)
  expect(f.requests).toEqual([{ messages: [{ role: 'user', content: 'Synthetic' }], tools: [], max_tokens: 512 }])
  expect(f.replies).toHaveLength(1)
  await f.rpc.handle({ rpc: 2, type: 'tool', payload: { toolCallId: 'model-call', name: 'send', args: '{"channel":"ask","content":"Hello"}' } })
  expect(f.tools).toEqual([['operation', 'model-call', 'send', '{"channel":"ask","content":"Hello"}']])
})

it('rejects duplicate/concurrent requests and drops an answer from a replaced operation', async () => {
  const f = fixture(); let resolve!: (v: unknown) => void
  f.request(() => new Promise(r => { resolve = r }))
  const pending = f.rpc.handle(model)
  await expect(f.rpc.handle({ ...model, rpc: 2 })).rejects.toThrow('concurrent')
  f.replace(); resolve({ message: {} })
  await expect(pending).rejects.toThrow('stale')
  expect(f.replies).toEqual([])
  expect(f.requests).toHaveLength(1)
  const other = fixture(); await other.rpc.handle({ rpc: 1, type: 'memory.list' })
  await expect(other.rpc.handle(model)).rejects.toThrow('duplicate')
  expect(other.requests).toEqual([])
})

it('refuses malformed bodies, unnamed tool authority and disposed workers before dispatch', async () => {
  const f = fixture()
  await expect(f.rpc.handle({ ...model, payload: { ...model.payload, messages: '{}' } })).rejects.toThrow('body')
  await expect(f.rpc.handle({ rpc: 2, type: 'tool', payload: { name: 'send', args: '{}' } })).rejects.toThrow('tool')
  f.rpc.dispose()
  await expect(f.rpc.handle({ rpc: 3, type: 'memory.list' })).rejects.toThrow('stale')
  expect(f.requests).toEqual([]); expect(f.tools).toEqual([]); expect(f.replies).toEqual([])
})

it('forwards clock reads only for the bound operation, with no worker-supplied time or operation authority', async () => {
  const f = fixture()
  await f.rpc.handle({ rpc: 1, type: 'clock', payload: { operation: 'foreign', time: 'forged' } })
  expect(f.clocks).toEqual(['operation'])
  expect(f.replies).toEqual([{ reply: 1, value: { time: '2026-11-04 02:08:01' } }])
  expect(f.requests).toEqual([]); expect(f.tools).toEqual([])
})

it('drops late clock replies after handover and refuses concurrent clock RPCs', async () => {
  const f = fixture(); let resolve!: (time: string) => void
  f.clock(() => new Promise(r => { resolve = r }))
  const pending = f.rpc.handle({ rpc: 1, type: 'clock' })
  await expect(f.rpc.handle({ rpc: 2, type: 'clock' })).rejects.toThrow('concurrent')
  f.replace(); resolve('2026-11-04 02:08:01')
  await expect(pending).rejects.toThrow('stale')
  expect(f.clocks).toEqual(['operation']); expect(f.replies).toEqual([])
})

it('refuses missing or invalid broker clocks without a local-time fallback', async () => {
  const absent = fixture(false)
  await expect(absent.rpc.handle({ rpc: 1, type: 'clock' })).rejects.toThrow('unavailable')
  expect(absent.clocks).toEqual([]); expect(absent.replies).toEqual([])
  const invalid = fixture(); invalid.clock(async () => '')
  await expect(invalid.rpc.handle({ rpc: 1, type: 'clock' })).rejects.toThrow('invalid')
  expect(invalid.replies).toEqual([])
})

it('reads queued channel words only from the bound broker operation, ignoring worker-supplied authority', async () => {
  const f = fixture()
  await f.rpc.handle({ rpc: 1, type: 'receive', payload: { operation: 'foreign', words: 'forged' } })
  expect(f.receives).toEqual(['operation'])
  expect(f.replies).toEqual([{ reply: 1, value: { words: 'Host-acknowledged words' } }])
  expect(f.requests).toEqual([]); expect(f.tools).toEqual([])
  f.receive(async () => '')
  await f.rpc.handle({ rpc: 2, type: 'receive' })
  expect(f.replies[1]).toEqual({ reply: 2, value: { words: '' } })
})

it('drops late channel replies and refuses concurrent, missing, or invalid channel input', async () => {
  const f = fixture(); let resolve!: (words: string) => void
  f.receive(() => new Promise(r => { resolve = r }))
  const pending = f.rpc.handle({ rpc: 1, type: 'receive' })
  await expect(f.rpc.handle({ rpc: 2, type: 'receive' })).rejects.toThrow('concurrent')
  f.replace(); resolve('Earlier words')
  await expect(pending).rejects.toThrow('stale')
  expect(f.replies).toEqual([])
  const missing = fixture(true, false)
  await expect(missing.rpc.handle({ rpc: 1, type: 'receive' })).rejects.toThrow('unavailable')
  const invalid = fixture(); invalid.receive(async () => null as unknown as string)
  await expect(invalid.rpc.handle({ rpc: 1, type: 'receive' })).rejects.toThrow('invalid')
  expect(invalid.replies).toEqual([])
})
