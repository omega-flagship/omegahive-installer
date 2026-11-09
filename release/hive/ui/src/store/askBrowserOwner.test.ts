import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AskAccepted, AskBody, AskContext, AskEvent } from '../api/ask'
import { AskRefusal } from '../api/ask'
import { ApiError, type HiveClient } from '../api/client'
import { createBrowserTurnLifecycle, type IterBroker } from '../features/browserIter/lifecycle'
import type { BrowserAskOwner } from '../features/browserIter/askOwner'

vi.stubGlobal('window', Object.assign(new EventTarget(), {
  location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }),
}))
const { useHive } = await import('./store')
const { askOrigin, useAskStore } = await import('./ask')
const context: AskContext = { route: 'hive', experience: 'still' }
const personal = { id: 'a_personal', name: 'Invented personal mind', status: 'awake' }
const thread = { id: 'thread-invented', mind: personal, budget_usd: 1, spent_usd: 0 }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve() }
const state = () => useAskStore.getState()
const view = (op: string, extra = {}) => ({ operation_id: op, turn_id: 'host-' + op, route: 'browser_mind', state: 'browser', thread, events: [], more: false, ...extra }) as AskAccepted & { events: AskEvent[]; more: boolean }
const frame = (op: string, seq: number, data: object) => ({ type: 'ask', operation_id: op, turn_id: 'host-' + op, principal: 'user:invented', seq, at: '2026-11-04T12:00:00Z', ...data }) as unknown as AskEvent
const emit = (op: string, seq: number, data: object) => state().onEvent(frame(op, seq, data))
let sequence = 0
function bind(client: HiveClient) {
  useHive.setState({ client, session: `browser-owner-${++sequence}`, inits: sequence, agents: {}, swarms: {} })
  state().bind(useHive.getState().session, 'user:invented')
  useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 1, eligible: [] }, personal,
    browserMind: { mindId: personal.id, gateway: true, available: true, preference: true } })
}
async function setup(options: { over?: Partial<HiveClient>; ready?: boolean; restored?: string; attach?: boolean } = {}) {
  const posts: string[] = []
  const client = {
    mode: 'sim',
    ask: vi.fn(async (body: AskBody) => { posts.push(JSON.stringify(body)); return view(body.operation_id, body.answer_in ? {} : { route: undefined, state: 'accepted' }) }),
    askTurn: vi.fn(async (op: string) => view(op)),
    askSteer: vi.fn(async (op: string, body: { steer_id: string }) => ({ operation_id: op, steer_id: body.steer_id })),
    askStop: vi.fn(async (op: string) => view(op, { state: 'done' })),
    agentAction: vi.fn(async () => ({})),
    ...options.over,
  } as unknown as HiveClient
  bind(client)
  let ready = options.ready ?? true, alive = true
  const origin = askOrigin()
  const broker: IterBroker = {
    turn: null,
    resume: vi.fn(async () => { if (options.restored) broker.startTurn(options.restored, 'iter', 'Earlier words'); return [] }),
    startTurn: vi.fn((id: string) => { (broker as { turn: unknown }).turn = { id, closed: false } }),
    endTurn: vi.fn(async (id: string) => { if (broker.turn?.id === id) broker.turn.closed = true; return true }),
    llm: vi.fn(async () => 'synthetic response'),
  }
  const lifecycle = createBrowserTurnLifecycle({ broker, gateway: { prepare: async () => true, refresh: async () => true, llm: async () => ({ status: 200 }) },
    current: () => alive && origin.ok(), workerReady: () => ready, admit: body => client.ask!(body), done: async op => ({ operation_id: op, state: 'done' }) })
  const owner: BrowserAskOwner = {
    lifecycle, workerReady: () => ready,
    entered: vi.fn(), fallbackStarted: vi.fn(), fallbackAnswer: vi.fn(),
    steer: vi.fn(async (_op, steerId) => ({ ok: true as const, steerId })),
    stopping: vi.fn(() => { ready = false }), closed: vi.fn(),
    dispose: vi.fn(() => { alive = false; ready = false }),
  }
  await lifecycle.restore()
  if (options.restored) await state().rejoin(options.restored)
  const detach = options.attach === false ? () => {} : state().attachBrowser(owner)
  return { owner, lifecycle, broker, client, posts, detach, worker: (value: boolean) => { ready = value } }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { state().reset(); vi.useRealTimers() })

it.each(['typed', 'voice'] as const)('admits a personal %s turn once in the browser without waking the sleeping hive mind', async via => {
  const s = await setup()
  useAskStore.setState({ personal: { ...personal, status: 'asleep' } })
  await state().send('A synthetic question', context, { via })
  const op = state().open!
  expect(JSON.parse(s.posts[0])).toMatchObject({ operation_id: op, answer_in: 'browser', via })
  expect(s.client.ask).toHaveBeenCalledTimes(1)
  expect(s.client.agentAction).not.toHaveBeenCalled()
  expect(s.owner.entered).toHaveBeenCalledExactlyOnceWith(op)
  expect(s.broker.startTurn).toHaveBeenCalledExactlyOnceWith(op, 'iter', 'A synthetic question')
  expect(s.lifecycle.phase).toBe('running')
})

it.each(['gateway', 'available', 'preference', 'worker', 'missing', 'wrong-person'])('keeps %s in labelled hive fallback for the whole turn', async flag => {
  const s = await setup({ ready: flag !== 'worker' })
  if (flag === 'missing') useAskStore.setState({ browserMind: null })
  else if (flag === 'wrong-person') useAskStore.setState({ browserMind: { ...state().browserMind!, mindId: 'a_other' } })
  else if (flag !== 'worker') useAskStore.setState({ browserMind: { ...state().browserMind!, [flag]: false } })
  await state().send('Fallback question', context)
  const op = state().open!
  expect(JSON.parse(s.posts[0])).not.toHaveProperty('answer_in')
  expect(state().turns[op].notes.some(n => n.text.includes('hive mind is answering'))).toBe(true)
  expect(s.owner.fallbackStarted).toHaveBeenCalledExactlyOnceWith(op, 'Fallback question')
  s.worker(true); useAskStore.setState({ browserMind: { mindId: personal.id, gateway: true, available: true, preference: true } })
  state().browserReady()
  emit(op, 1, { phase: 'accepted', thread }); emit(op, 2, { phase: 'answer', text: 'Hive answer' })
  emit(op, 2, { phase: 'answer', text: 'Hive answer' }); emit(op, 3, { phase: 'done', outcome: 'answered' })
  expect(s.owner.entered).not.toHaveBeenCalled()
  expect(s.owner.fallbackAnswer).toHaveBeenCalledExactlyOnceWith(op, 'Hive answer')
  expect(s.owner.closed).toHaveBeenCalledExactlyOnceWith(op)
  await state().send('Next explicit question', context)
  expect(JSON.parse(s.posts[1]).answer_in).toBe('browser')
})

it.each([{ ...context, swarm_id: 's_other' }, { private: true, route: 'private' }] as AskContext[])('preserves the existing recipient without browser history: %j', async ctx => {
  const s = await setup()
  useHive.setState({ swarms: { s_other: { id: 's_other', name: 'Other', coordinator_id: 'a_other' } } } as never)
  useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 1, eligible: [{ id: 's_other', name: 'Other', orchestrator: { id: 'a_other', name: 'Other coordinator' } }] } })
  await state().send('Host request', ctx)
  expect(JSON.parse(s.posts[0])).not.toHaveProperty('answer_in')
  expect(s.owner.entered).not.toHaveBeenCalled()
  expect(s.owner.fallbackStarted).not.toHaveBeenCalled()
})

it('recovers a lost admission by the same operation without starting or posting twice', async () => {
  const s = await setup()
  s.client.ask = vi.fn(async body => { s.posts.push(JSON.stringify(body)); throw new ApiError(0, 'network', 'lost answer') })
  await state().send('Lost after commit', context)
  const op = state().open!
  expect(s.posts).toHaveLength(1)
  expect(s.client.askTurn).toHaveBeenCalledWith(op, 0)
  expect(s.owner.entered).toHaveBeenCalledExactlyOnceWith(op)
  expect(s.broker.startTurn).toHaveBeenCalledTimes(1)
  expect(s.lifecycle.phase).toBe('running')
})

it('reposts exactly the original browser-marked body and id after a 404, without beginning another lifecycle', async () => {
  const s = await setup()
  const ask = s.client.ask!
  s.client.ask = vi.fn().mockImplementationOnce(async (body: AskBody) => { s.posts.push(JSON.stringify(body)); throw new ApiError(0, 'network', 'lost before commit') }).mockImplementation(ask)
  s.client.askTurn = vi.fn().mockRejectedValueOnce(new AskRefusal(404, 'not_available', 'not found')).mockImplementation(async op => view(op))
  await state().send('Retry same body', context)
  expect(s.posts).toHaveLength(2)
  expect(s.posts[1]).toBe(s.posts[0])
  expect(JSON.parse(s.posts[1]).answer_in).toBe('browser')
  expect(s.broker.startTurn).toHaveBeenCalledTimes(1)
  expect(s.owner.entered).toHaveBeenCalledTimes(1)
})

it.each([{ operation_id: 'wrong-operation' }, { route: undefined }, { state: 'accepted' }, { turn_id: '' }])('holds unknown admission when host browser readback is malformed: %j', async bad => {
  const s = await setup()
  s.client.ask = vi.fn(async () => { throw new ApiError(0, 'network', 'unknown admission') })
  s.client.askTurn = vi.fn(async op => view(op, bad))
  await state().send('Uncertain admission', context)
  const op = state().open!
  expect(state().turns[op].unsure?.state).toBe('unresolved')
  expect(s.lifecycle.phase).toBe('admitting')
  expect(s.lifecycle.operation).toBe(op)
  expect(s.owner.entered).not.toHaveBeenCalled()
  await state().send('No replacement request', context)
  expect(s.client.ask).toHaveBeenCalledTimes(1)
})

it('releases a definitive browser refusal without automatic fallback', async () => {
  const s = await setup({ over: { ask: vi.fn(async () => { throw new AskRefusal(403, 'not_available', 'browser refused') }) } })
  await state().send('Refused question', context)
  expect(s.client.ask).toHaveBeenCalledTimes(1)
  expect(s.owner.fallbackStarted).not.toHaveBeenCalled()
  expect(s.lifecycle.phase).toBe('ready')
  expect(s.lifecycle.operation).toBeNull()
  expect(state().open).toBeNull()
})

it('sends nothing if worker readiness is lost between selection and lifecycle begin', async () => {
  const s = await setup()
  let checks = 0
  s.owner.workerReady = () => { if (++checks === 1) { s.worker(false); return true } return false }
  await state().send('Readiness race', context)
  expect(s.client.ask).not.toHaveBeenCalled()
  expect(s.client.askTurn).not.toHaveBeenCalled()
  expect(state().open).toBeNull()
  expect(s.lifecycle.phase).toBe('ready')
})

it('disposes on identity change before a late admission can start the worker; old detach cannot kill a new owner', async () => {
  const admission = deferred<AskAccepted>()
  const s = await setup({ over: { ask: vi.fn(() => admission.promise) } })
  const sending = state().send('Old person', context)
  const op = state().open!
  const next = await setup()
  expect(s.owner.dispose).toHaveBeenCalledTimes(1)
  admission.resolve(view(op)); await sending
  expect(s.owner.entered).not.toHaveBeenCalled()
  expect(state().turns[op]).toBeUndefined()
  s.detach()
  expect(next.owner.dispose).not.toHaveBeenCalled()
  await state().send('New person', context)
  expect(next.owner.entered).toHaveBeenCalledTimes(1)
})

it('reads and attaches the restored operation without another admission', async () => {
  const s = await setup({ restored: 'ask:restored' })
  expect(s.client.ask).not.toHaveBeenCalled()
  expect(s.owner.entered).toHaveBeenCalledExactlyOnceWith('ask:restored')
  expect(s.lifecycle.operation).toBe('ask:restored')
})

it('reconciles terminal admission readback without starting a worker, then allows an explicit new turn', async () => {
  const s = await setup()
  const ask = s.client.ask!
  s.client.ask = vi.fn().mockRejectedValueOnce(new ApiError(0, 'network', 'lost answer')).mockImplementation(ask)
  s.client.askTurn = vi.fn(async op => view(op, { state: 'done' }))
  await state().send('Already completed', context)
  expect(s.owner.entered).not.toHaveBeenCalled()
  expect(s.owner.closed).toHaveBeenCalledTimes(1)
  expect(s.lifecycle.phase).toBe('ready')
  expect(state().open).toBeNull()
  await state().send('Next explicit turn', context)
  expect(s.owner.entered).toHaveBeenCalledTimes(1)
})

it('never starts a worker from a late admission after route-checked streamed terminal proof and a new request', async () => {
  const admission = deferred<AskAccepted>()
  const s = await setup()
  const ask = s.client.ask!
  s.client.ask = vi.fn().mockImplementationOnce(() => admission.promise).mockImplementation(ask)
  const oldSend = state().send('Earlier words', context), old = state().open!
  emit(old, 1, { phase: 'accepted', thread }); emit(old, 2, { phase: 'done', outcome: 'cancelled' })
  expect(state().open).toBe(old)
  expect(state().turns[old].browserTurnId).toBeUndefined()
  await state().recover(old)
  expect(s.broker.startTurn).not.toHaveBeenCalled()
  await state().send('New words', context)
  const next = state().open!
  admission.resolve(view(old)); await oldSend
  expect(next).not.toBe(old)
  expect(s.owner.entered).toHaveBeenCalledExactlyOnceWith(next)
  expect(s.lifecycle.operation).toBe(next)
})

it('delivers only checked, ordered host steers, once the broker has acknowledged them', async () => {
  const s = await setup(), save = deferred<{ ok: true; steerId: string }>()
  s.owner.steer = vi.fn(() => save.promise)
  await state().send('Original words', context)
  const op = state().open!, original = s.posts[0]
  emit(op, 1, { phase: 'accepted', thread })
  await state().steer('More words', context)
  const id = state().turns[op].steers[0].steer_id
  expect(s.owner.steer).not.toHaveBeenCalled()
  emit(op, 3, { phase: 'steer', steer_id: id, text: 'More words', at_seq: 1 })
  expect(s.owner.steer).not.toHaveBeenCalled()
  emit(op, 2, { phase: 'thinking', step: 'Working' })
  expect(s.owner.steer).toHaveBeenCalledExactlyOnceWith(op, id, 'More words')
  emit(op, 3, { phase: 'steer', steer_id: id, text: 'More words', at_seq: 1 }); state().browserReady()
  expect(state().turns[op].browserSteers).toBeUndefined()
  save.resolve({ ok: true, steerId: id }); await flush()
  expect(state().turns[op].browserSteers).toEqual([id])
  expect(s.owner.steer).toHaveBeenCalledTimes(1)
  expect(s.posts).toEqual([original])
})

it('retries an unkept steer with the same host id at the next readiness notification, never marks it kept optimistically', async () => {
  const s = await setup()
  s.owner.steer = vi.fn().mockResolvedValueOnce({ ok: false, error: 'not kept' }).mockImplementation(async (_op, steerId) => ({ ok: true, steerId }))
  await state().send('Question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread }); emit(op, 2, { phase: 'steer', steer_id: 'steer:one', text: 'More words', at_seq: 1 })
  await flush()
  expect(state().turns[op].browserSteers).toBeUndefined()
  expect(state().turns[op].notes.at(-1)?.text).toContain('still waiting')
  state().browserReady(); await flush()
  expect(s.owner.steer).toHaveBeenCalledTimes(2)
  expect(state().turns[op].browserSteers).toEqual(['steer:one'])
  expect(state().turns[op].notes.some(note => note.text.includes('still waiting'))).toBe(false)
  expect(state().turns[op].notes.filter(note => note.text === 'Your words have reached your browser mind.')).toHaveLength(1)
  state().browserReady(); await flush()
  expect(state().turns[op].notes.filter(note => note.text === 'Your words have reached your browser mind.')).toHaveLength(1)
})

it('keeps the waiting notice until all host-acknowledged words have reached the browser', async () => {
  const s = await setup(), second = deferred<{ ok: true; steerId: string }>()
  s.owner.steer = vi.fn().mockResolvedValueOnce({ ok: false, error: 'not kept' })
    .mockResolvedValueOnce({ ok: true, steerId: 'first' }).mockImplementation(() => second.promise)
  await state().send('Question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread })
  emit(op, 2, { phase: 'steer', steer_id: 'first', text: 'First words', at_seq: 1 })
  await flush()
  emit(op, 3, { phase: 'steer', steer_id: 'second', text: 'Second words', at_seq: 2 })
  await flush()
  expect(state().turns[op].browserSteers).toEqual(['first'])
  expect(state().turns[op].notes.at(-1)?.text).toContain('still waiting')
  second.resolve({ ok: true, steerId: 'second' }); await flush()
  expect(state().turns[op].browserSteers).toEqual(['first', 'second'])
  expect(state().turns[op].notes.at(-1)?.text).toBe('Your words have reached your browser mind.')
})

it('pins the browser turn only from the route-checked view and releases only its buffered frames', async () => {
  const s = await setup(), initial = deferred<AskAccepted>()
  s.client.ask = vi.fn(() => initial.promise)
  const sending = state().send('Question', context), op = state().open!
  emit(op, 1, { phase: 'done', outcome: 'cancelled', turn_id: 'another-host-turn' })
  emit(op, 1, { phase: 'accepted', thread })
  emit(op, 2, { phase: 'steer', steer_id: 'right-words', text: 'Right words', at_seq: 1 })
  expect(state().turns[op].browserTurnId).toBeUndefined()
  expect(state().turns[op].lastSeq).toBe(0)
  expect(s.owner.closed).not.toHaveBeenCalled()
  expect(s.owner.steer).not.toHaveBeenCalled()
  initial.resolve(view(op)); await sending; await flush()
  expect(state().turns[op].browserTurnId).toBe('host-' + op)
  expect(state().turns[op].browserPendingFrames).toBeUndefined()
  expect(state().turns[op].events.map(e => e.turn_id)).toEqual(['host-' + op, 'host-' + op])
  expect(s.owner.closed).not.toHaveBeenCalled()
  expect(s.owner.steer).toHaveBeenCalledExactlyOnceWith(op, 'right-words', 'Right words')
})

it.each(['reconcileClosed', 'closed'] as const)('retains exact terminal state and reports cleanup when %s throws', async method => {
  const s = await setup(), initial = deferred<AskAccepted>()
  s.client.ask = vi.fn(() => initial.promise)
  const sending = state().send('Pending admission', context), op = state().open!
  if (method === 'reconcileClosed') vi.spyOn(s.lifecycle, method).mockImplementation(() => { throw Error('synthetic cleanup failure') })
  else s.owner.closed = vi.fn(() => { throw Error('synthetic cleanup failure') })
  s.client.askStop = vi.fn(async id => view(id, { state: 'done' }))
  await expect(state().stop()).resolves.toBeUndefined()
  expect(state().turns[op].state).toBe('done')
  expect(state().turns[op].browserClosed).toBe(true)
  expect(state().open).toBeNull()
  expect(state().turns[op].notes.at(-1)?.text).toContain('could not finish its cleanup')
  initial.reject(new ApiError(0, 'network', 'lost answer')); await sending
})

it('applies terminal route-checked state before buffered history so an old proposal cannot move the page', async () => {
  const s = await setup(), initial = deferred<AskAccepted>()
  s.client.ask = vi.fn(() => initial.promise)
  const sending = state().send('Pending question', context), op = state().open!
  emit(op, 1, { phase: 'accepted', thread })
  emit(op, 2, { phase: 'proposal', proposal: { id: 'proposal-one', kind: 'navigate', route: '#/goals', digest: 'digest-one' } })
  s.client.askTurn = vi.fn(async id => view(id, { state: 'done' }))
  await state().recover(op)
  expect(state().turns[op].state).toBe('done')
  expect(state().turns[op].outcomes[2]).toMatchObject({ kind: 'go', why: 'closed' })
  expect(s.owner.entered).not.toHaveBeenCalled()
  expect(s.broker.startTurn).not.toHaveBeenCalled()
  initial.reject(new ApiError(0, 'network', 'lost answer')); await sending
})

it.each(['lost', 'malformed'] as const)('recovers one exact terminal view after an unconfirmed %s Stop without another write', async result => {
  const s = await setup()
  await state().send('Question', context)
  const op = state().open!
  s.client.askStop = vi.fn(async () => { if (result === 'lost') throw new ApiError(0, 'network', 'lost Stop'); return {} }) as HiveClient['askStop']
  s.client.askTurn = vi.fn(async id => view(id, { state: 'done' }))
  await state().stop()
  expect(s.client.askStop).toHaveBeenCalledExactlyOnceWith(op)
  expect(s.client.askTurn).toHaveBeenCalledExactlyOnceWith(op, 0)
  expect(s.client.ask).toHaveBeenCalledTimes(1)
  expect(s.owner.closed).toHaveBeenCalledExactlyOnceWith(op)
  expect(state().open).toBeNull()
})

it('ends the unconfirmed Stop recovery after one failed read and ignores a later identity-crossing answer', async () => {
  const s = await setup()
  await state().send('Question', context)
  const op = state().open!
  s.client.askStop = vi.fn(async () => { throw new ApiError(0, 'network', 'lost Stop') })
  s.client.askTurn = vi.fn(async () => { throw new ApiError(0, 'network', 'lost read') })
  await state().stop()
  expect(s.client.askTurn).toHaveBeenCalledTimes(1)
  expect(state().open).toBe(op)
  const read = deferred<ReturnType<typeof view>>()
  s.client.askTurn = vi.fn(() => read.promise)
  const stopping = state().stop()
  await flush()
  bind(s.client)
  read.resolve(view(op, { state: 'done' })); await stopping
  expect(s.owner.closed).not.toHaveBeenCalled()
  expect(state().turns[op]).toBeUndefined()
})

it.each(['lost', 'malformed'])('disarms synchronously before Stop; a %s result retains the reserved operation until exact terminal proof', async result => {
  const s = await setup(), stopping = deferred<unknown>()
  s.client.askStop = vi.fn(() => stopping.promise) as HiveClient['askStop']
  await state().send('Question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread })
  const stop = state().stop()
  expect(s.owner.stopping).toHaveBeenCalledExactlyOnceWith(op)
  if (result === 'lost') stopping.reject(new ApiError(0, 'network', 'lost Stop'))
  else stopping.resolve({})
  await stop
  expect(state().open).toBe(op)
  expect(s.lifecycle.operation).toBe(op)
  expect(s.owner.closed).not.toHaveBeenCalled()
  await state().send('No new admission', context)
  expect(s.client.ask).toHaveBeenCalledTimes(1)
  expect(s.client.askSteer).not.toHaveBeenCalled()
  emit(op, 2, { phase: 'done', outcome: 'cancelled' }); emit(op, 2, { phase: 'done', outcome: 'cancelled' })
  expect(s.owner.closed).toHaveBeenCalledExactlyOnceWith(op)
  expect(state().open).toBeNull()
})

it('requires durable restoration and an exact adopted open operation before attachment', async () => {
  const s = await setup({ attach: false })
  await s.lifecycle.begin({ operation_id: 'ask:not-read', text: 'Earlier', context, via: 'typed' })
  expect(() => state().attachBrowser(s.owner)).toThrow('Read the existing Ask operation')
})

it('ignores another host turn reusing the operation id for steers, terminal frames, recovery, and Stop', async () => {
  const s = await setup()
  await state().send('Exact turn only', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread })
  emit(op, 2, { phase: 'steer', steer_id: 'wrong-steer', text: 'Wrong host turn', at_seq: 1, turn_id: 'wrong-turn' })
  emit(op, 2, { phase: 'done', outcome: 'cancelled', turn_id: 'wrong-turn' })
  s.client.askTurn = vi.fn(async id => view(id, { turn_id: 'wrong-turn', state: 'done', events: [frame(op, 2, { phase: 'done', outcome: 'cancelled', turn_id: 'wrong-turn' })] }))
  await state().recover(op)
  expect(s.owner.steer).not.toHaveBeenCalled()
  expect(s.owner.closed).not.toHaveBeenCalled()
  expect(state().turns[op].lastSeq).toBe(1)
  s.client.askStop = vi.fn(async id => view(id, { turn_id: 'wrong-turn', state: 'done' }))
  await state().stop()
  expect(state().open).toBe(op)
  expect(s.owner.closed).not.toHaveBeenCalled()
  s.client.askStop = vi.fn(async id => view(id, { state: 'refused' }))
  await state().stop()
  emit(op, 2, { phase: 'refused', reason: 'stopped' })
  expect(s.owner.closed).toHaveBeenCalledExactlyOnceWith(op)
  expect(state().open).toBeNull()
})

it('accepts exact terminal recovery readback for a running browser operation even without new frames', async () => {
  const s = await setup()
  await state().send('Running question', context)
  const op = state().open!
  s.client.askTurn = vi.fn(async id => view(id, { state: 'done' }))
  await state().recover(op); await state().recover(op)
  expect(s.owner.closed).toHaveBeenCalledExactlyOnceWith(op)
  expect(state().turns[op].state).toBe('done')
  expect(state().open).toBeNull()
})

it('discards a pending steer acknowledgment after an identity change', async () => {
  const s = await setup(), kept = deferred<{ ok: true; steerId: string }>()
  s.owner.steer = vi.fn(() => kept.promise)
  await state().send('Old question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread }); emit(op, 2, { phase: 'steer', steer_id: 'old-steer', text: 'Old input', at_seq: 1 })
  await setup()
  kept.resolve({ ok: true, steerId: 'old-steer' }); await flush()
  expect(state().turns[op]).toBeUndefined()
  expect(state().open).toBeNull()
})

it('refuses to attach an owner restored under another identity before any fallback callback can see words', async () => {
  const s = await setup({ attach: false })
  bind({ mode: 'sim', ask: vi.fn(async b => view(b.operation_id)) } as unknown as HiveClient)
  expect(() => state().attachBrowser(s.owner)).toThrow('different identity')
  useAskStore.setState({ browserMind: null })
  await state().send('New identity words', context)
  expect(s.owner.fallbackStarted).not.toHaveBeenCalled()
  expect(s.owner.entered).not.toHaveBeenCalled()
})

it('retains per-turn entry and kept steer markers across detach, restoration and re-attachment to the same broker', async () => {
  const s = await setup()
  await state().send('Original question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread }); emit(op, 2, { phase: 'steer', steer_id: 'kept-once', text: 'Kept once', at_seq: 1 })
  await flush()
  expect(s.owner.steer).toHaveBeenCalledTimes(1)
  const origin = askOrigin()
  s.detach()
  const lifecycle = createBrowserTurnLifecycle({ broker: s.broker, gateway: { prepare: async () => true, refresh: async () => true, llm: async () => ({ status: 200 }) },
    current: () => origin.ok(), workerReady: () => true, admit: b => s.client.ask!(b), done: async id => ({ operation_id: id, state: 'done' }) })
  await lifecycle.restore()
  const next = { ...s.owner, lifecycle, workerReady: () => true, entered: vi.fn(), steer: vi.fn(async (_op: string, steerId: string) => ({ ok: true as const, steerId })), dispose: vi.fn() }
  state().attachBrowser(next)
  await state().rejoin(op); state().browserReady(); await flush()
  expect(next.entered).not.toHaveBeenCalled()
  expect(next.steer).not.toHaveBeenCalled()
  expect(s.broker.startTurn).toHaveBeenCalledTimes(1)
  expect(state().turns[op].browserSteers).toEqual(['kept-once'])
})

it('never transcribes fallback answers after host terminal proof', async () => {
  const s = await setup({ ready: false })
  await state().send('Host question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread }); emit(op, 2, { phase: 'done', outcome: 'answered' })
  emit(op, 3, { phase: 'answer', text: 'Late answer' })
  expect(s.owner.fallbackAnswer).not.toHaveBeenCalled()
  expect(s.owner.fallbackStarted).toHaveBeenCalledTimes(1)
})

it('records a fallback terminal close while detached so reattachment cannot transcribe a late answer', async () => {
  const s = await setup({ ready: false })
  await state().send('Fallback question', context)
  const op = state().open!
  emit(op, 1, { phase: 'accepted', thread })
  s.detach()
  emit(op, 2, { phase: 'done', outcome: 'answered' })
  expect(state().turns[op].browserClosed).toBe(true)
  const origin = askOrigin()
  const lifecycle = createBrowserTurnLifecycle({ broker: s.broker, gateway: { prepare: async () => true, refresh: async () => true, llm: async () => ({ status: 200 }) },
    current: () => origin.ok(), workerReady: () => false, admit: b => s.client.ask!(b), done: async id => ({ operation_id: id, state: 'done' }) })
  await lifecycle.restore()
  const next = { ...s.owner, lifecycle, workerReady: () => false, fallbackAnswer: vi.fn(), fallbackStarted: vi.fn(), dispose: vi.fn() }
  state().attachBrowser(next)
  emit(op, 3, { phase: 'answer', text: 'Late fallback answer' })
  expect(next.fallbackAnswer).not.toHaveBeenCalled()
  expect(next.fallbackStarted).not.toHaveBeenCalled()
  expect(s.owner.closed).not.toHaveBeenCalled()
})

it.each(['refused', 'terminal'] as const)('releases words held during browser admission after %s proof instead of dropping them', async proof => {
  const s = await setup(), initial = deferred<AskAccepted>()
  const originalAsk = s.client.ask!
  s.client.ask = vi.fn().mockImplementationOnce(() => initial.promise).mockImplementation(originalAsk)
  const sending = state().send('Initial question', context), op = state().open!
  await state().send('Held follow-up words', context)
  expect(state().turns[op].held?.map(h => h.text)).toEqual(['Held follow-up words'])
  if (proof === 'refused') initial.reject(new AskRefusal(403, 'not_available', 'not admitted'))
  else {
    s.client.askTurn = vi.fn(async id => view(id, { state: 'done' }))
    initial.reject(new ApiError(0, 'network', 'lost admission'))
  }
  await sending; await flush()
  expect(s.client.ask).toHaveBeenCalledTimes(2)
  expect(JSON.parse(s.posts[0]).text).toBe('Held follow-up words')
  expect(state().turns[op].held).toBeUndefined()
  expect(state().open).not.toBe(op)
})

it('bounds a stuck browser admission with a readback and visible report while retaining held words', async () => {
  const s = await setup(), pending = deferred<AskAccepted>()
  s.client.ask = vi.fn(() => pending.promise)
  s.client.askTurn = vi.fn(async id => view(id, { route: undefined }))
  const sending = state().send('Pending admission', context), op = state().open!
  emit(op, 1, { phase: 'accepted', thread })
  await state().send('Words while confirming', context)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(s.client.askTurn).toHaveBeenCalledTimes(1)
  expect(s.client.ask).toHaveBeenCalledTimes(1)
  expect(state().turns[op].notes.at(-1)?.text).toContain('has not been confirmed')
  expect(state().turns[op].held?.[0].text).toBe('Words while confirming')
  s.client.askTurn = vi.fn(async id => view(id))
  await state().recover(op)
  pending.resolve(view(op)); await sending; await flush()
  expect(s.owner.entered).toHaveBeenCalledExactlyOnceWith(op)
  expect(s.broker.startTurn).toHaveBeenCalledTimes(1)
  expect(s.client.askSteer).toHaveBeenCalledTimes(1)
})

it('rejects rejoin metadata for the wrong operation even when it is not browser-marked', async () => {
  const s = await setup()
  s.client.askTurn = vi.fn(async id => view('wrong-' + id, { route: undefined }))
  await state().rejoin('ask:unrelated')
  expect(state().turns['ask:unrelated']).toBeUndefined()
})
