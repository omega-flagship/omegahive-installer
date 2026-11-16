import { expect, it } from 'vitest'
import { openIterPending, type OpenSealed } from './pending'

it('opens only the iter-pending sealed namespace and retains an independent body across broker reload', async () => {
  const values = new Map<string, unknown>() // injected contract fake; not a durable or sealed store
  const calls: unknown[] = []
  const open: OpenSealed = async (...args) => {
    calls.push(args)
    return { put: async (k, v) => { values.set(k, v) }, get: async k => values.get(k), delete: async k => { values.delete(k) }, list: async () => [...values.values()] }
  }
  const aad = { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }
  const store = await openIterPending(open, aad, () => true)
  const step = { key: 'operation:2', turnId: 'operation', owner: 'iter', step: 2, body: { messages: [{ content: 'First body' }] } }
  await store.put(step.key, step)
  step.body.messages[0].content = 'Changed later'
  const reloaded = await openIterPending(open, aad, () => true)
  expect(calls[0]).toEqual(['iter-pending', aad])
  expect((await reloaded.list())[0]).toMatchObject({ body: { messages: [{ content: 'First body' }] } })
  await reloaded.delete(step.key)
  expect(await store.list()).toEqual([])
})

it('preserves v2 history, tool authority, turn markers and consumed calls together across reload', async () => {
  const records = new Map<string, unknown>()
  const open: OpenSealed = async () => ({ put: async (k, v) => { records.set(k, v) }, get: async k => records.get(k), delete: async k => { records.delete(k) }, list: async () => [...records.values()] })
  const store = await openIterPending(open, { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => true)
  const step = { v: 2, key: 'operation:2', turnId: 'operation', owner: 'iter', step: 2, body: { messages: [] }, history: [{ role: 'user', content: 'First words' }], calls: [['tool-1', { state: 'pending' }]] }
  const marker = { v: 2, kind: 'turn', key: 'turn:operation', turnId: 'operation', owner: 'iter', at: 1 }
  const consumed = { v: 2, kind: 'call', key: 'call:operation:tool-1', turnId: 'operation', callId: 'tool-1' }
  for (const rec of [marker, step, consumed]) await store.put(rec.key, rec)
  step.history[0].content = 'Changed later'
  const reloaded = await openIterPending(open, { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => true)
  expect(await reloaded.list()).toEqual([marker, { ...step, history: [{ role: 'user', content: 'First words' }] }, consumed])
  const copy = await reloaded.list()
  ;(copy[0] as typeof marker).at = 99
  expect((await reloaded.list())[0]).toEqual(marker)
  for (const key of [...records.keys()]) await reloaded.delete(key)
  expect(await reloaded.list()).toEqual([])
})

it.each([
  { v: 2, kind: 'turn', key: 'turn:wrong', turnId: 'operation', owner: 'iter', at: 0 },
  { v: 2, kind: 'call', key: 'call:operation:wrong', turnId: 'operation', callId: 'tool-1' },
  { v: 2, key: 'operation:0', turnId: 'operation', owner: 'iter', step: 0, body: {} },
  { v: 3, kind: 'turn', key: 'turn:operation', turnId: 'operation', owner: 'iter', at: 0 },
])('refuses malformed recovery records before persistence: %j', async rec => {
  let puts = 0
  const pending = await openIterPending(async () => ({ put: async () => { puts++ }, get: async () => null, delete: async () => {}, list: async () => [rec] }), { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => true)
  await expect(pending.put(rec.key, rec)).rejects.toThrow('invalid pending')
  await expect(pending.list()).rejects.toThrow('unreadable pending')
  expect(puts).toBe(0)
})

it('rejects corrupt or mismatched steps instead of inventing a new idempotency key', async () => {
  const records = { put: async () => {}, get: async () => null, delete: async () => {}, list: async () => [{ key: 'other:0', turnId: 'operation', owner: 'iter', step: 0, body: {} }] }
  const pending = await openIterPending(async () => records, { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => true)
  await expect(pending.list()).rejects.toThrow('unreadable pending')
  await expect(pending.put('other:0', { key: 'operation:0', turnId: 'operation', owner: 'iter', step: 0, body: {} })).rejects.toThrow('invalid pending')
})

it('never opens a plaintext fallback and withdraws authority after identity changes', async () => {
  await expect(openIterPending(async () => { throw new Error('key locked') }, { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => true)).rejects.toThrow('key locked')
  let current = true, reads = 0
  const pending = await openIterPending(async () => ({ put: async () => {}, get: async () => null, delete: async () => {}, list: async () => { reads++; current = false; return [] } }), { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => current)
  await expect(pending.list()).rejects.toThrow('identity changed')
  await expect(pending.list()).rejects.toThrow('identity changed')
  expect(reads).toBe(1)
})


it('retains accepted, refused and unacknowledged steering records and cloned step inputs across reload', async () => {
  const values = new Map<string, unknown>() // contract storage only; encryption is qualified separately
  const open: OpenSealed = async () => ({ put: async (k, v) => { values.set(k, v) }, get: async k => values.get(k), delete: async k => { values.delete(k) }, list: async () => [...values.values()] })
  const scope = { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }
  const store = await openIterPending(open, scope, () => true)
  const steers = [
    { v: 2, kind: 'steer', key: 'steer:operation:yes', turnId: 'operation', steerId: 'yes', words: 'Keep the original blue.', seq: 0, accepted: true },
    { v: 2, kind: 'steer', key: 'steer:operation:no', turnId: 'operation', steerId: 'no', words: 'Refused invented words', seq: 1, refused: true },
    { v: 2, kind: 'steer', key: 'steer:operation:unknown', turnId: 'operation', steerId: 'unknown', words: 'Unacknowledged invented words', seq: 2 },
  ]
  const step = { v: 2, key: 'operation:1', turnId: 'operation', owner: 'iter', step: 1, body: { messages: [] }, history: [], calls: [], inputs: { clock: ['2026-11-04 13:00:00'], steers: [{ steerId: 'yes', words: 'Keep the original blue.' }], steerAt: '2026-11-04 13:00:01' } }
  for (const rec of [...steers, step]) await store.put(rec.key, rec)
  step.inputs.steers[0].words = 'Mutated later'
  const reload = await openIterPending(open, scope, () => true)
  expect((await reload.list()).slice(0, 3)).toEqual(steers)
  expect((await reload.list())[3]).toMatchObject({ inputs: { clock: ['2026-11-04 13:00:00'], steers: [{ steerId: 'yes', words: 'Keep the original blue.' }], steerAt: '2026-11-04 13:00:01' } })
})

it.each([
  { v: 2, kind: 'steer', key: 'steer:operation:s', turnId: 'operation', steerId: 's', words: 'words', seq: -1 },
  { v: 2, kind: 'steer', key: 'steer:operation:s', turnId: 'operation', steerId: 's', words: 'words', seq: 0.5 },
  { v: 2, kind: 'steer', key: 'steer:operation:s', turnId: 'operation', steerId: 's', words: 'words', seq: 0, accepted: true, refused: true },
  { v: 2, kind: 'steer', key: 'steer:operation:foreign', turnId: 'operation', steerId: 's', words: 'words', seq: 0 },
  { v: 2, kind: 'steer', key: 'steer:operation:s', turnId: 'operation', steerId: 's', words: ' ', seq: 0 },
  { v: 2, kind: 'steer', key: 'steer:operation:s', turnId: 'operation', steerId: 's', words: 'words', seq: 0, accepted: 'yes' },
  { v: 2, key: 'operation:1', turnId: 'operation', owner: 'iter', step: 1, body: {}, history: [], calls: [], inputs: { clock: [4] } },
  { v: 2, key: 'operation:1', turnId: 'operation', owner: 'iter', step: 1, body: {}, history: [], calls: [], inputs: { steers: [{ steerId: 's', words: '' }] } },
  { v: 2, key: 'operation:1', turnId: 'operation', owner: 'iter', step: 1, body: {}, history: [], calls: [], inputs: { steerAt: 4 } },
])('refuses corrupted steer or step inputs without persisting them: %j', async rec => {
  let writes = 0
  const store = await openIterPending(async () => ({ put: async () => { writes++ }, get: async () => null, delete: async () => {}, list: async () => [rec] }), { spaceId: 'synthetic-space', deviceId: 'synthetic-device' }, () => true)
  await expect(store.put(rec.key, rec)).rejects.toThrow('invalid pending')
  await expect(store.list()).rejects.toThrow('unreadable pending')
  expect(writes).toBe(0)
})

it('requires both space and device before opening and snapshots their original values', async () => {
  let opens = 0
  const seen: unknown[] = []
  const open: OpenSealed = async (_kind, scope) => {
    opens++; seen.push(scope)
    return { put: async () => {}, get: async () => null, delete: async () => {}, list: async () => [] }
  }
  for (const scope of [{ spaceId: 's', deviceId: '' }, { spaceId: '', deviceId: 'd' }, { spaceId: 's', deviceId: ' ' }]) {
    await expect(openIterPending(open, scope, () => true)).rejects.toThrow('missing mind space or device')
  }
  expect(opens).toBe(0)
  const scope = { spaceId: 's', deviceId: 'original-device' }
  await openIterPending(open, scope, () => true)
  scope.deviceId = 'later-device'
  expect(seen).toEqual([{ spaceId: 's', deviceId: 'original-device' }])
  expect(Object.isFrozen(seen[0])).toBe(true)
})
