import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('window', Object.assign(new EventTarget(), {
  location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }),
}))
const { useHive } = await import('./store')
const { useAskStore } = await import('./ask')
const { askAutoWake } = await import('./askAutoWake')
const { ApiError } = await import('../api/client')
type HiveClient = import('../api/client').HiveClient
const thread = { id: 'ses_wake', mind: { id: 'a_ada', name: 'Ada' }, budget_usd: .25, spent_usd: 0 }
function fixture(initial = 'asleep') {
  let status = initial
  let wakeRelease!: () => void
  const wake = new Promise<void>((resolve) => { wakeRelease = () => { status = 'awake'; resolve() } })
  const client = {
    mode: 'sim',
    me: vi.fn(async () => ({ principal: 'user:invented', role: 'member' })),
    askSettings: vi.fn(async () => ({ swarm_id: null })),
    myMind: vi.fn(async () => ({ mind: { id: 'a_ada', name: 'Ada', swarm_id: 's_home' } })),
    getSwarm: vi.fn(async () => ({ id: 's_home', coordinator_id: 'a_ada', owner: 'user:invented' })),
    getAgent: vi.fn(async () => ({ id: 'a_ada', name: 'Ada', status, kind: 'omega', swarm_id: 's_home', may_sleep: true, is_mine: true })),
    agentAction: vi.fn(async () => { await wake; return {} }),
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't_wake', state: 'accepted', thread })),
    askSteer: vi.fn(async (op: string, b: { steer_id: string }) => ({ operation_id: op, steer_id: b.steer_id })),
    askStop: vi.fn(async () => ({})),
  }
  useHive.setState({ client: client as unknown as HiveClient, session: 'wake-session', inits: 1 })
  useAskStore.getState().bind('wake-session', 'user:invented')
  return { client, wakeRelease }
}
beforeEach(() => { useAskStore.getState().reset() })
afterEach(() => { useAskStore.getState().reset(); vi.useRealTimers() })
describe('Ask store wake-before-send integration', () => {
  it('holds both the request and its steers until waking; then delivers each once', async () => {
    const f = fixture()
    const sent = useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
    const op = useAskStore.getState().open!
    await vi.waitFor(() => expect(f.client.agentAction).toHaveBeenCalledTimes(1))
    expect(f.client.ask).not.toHaveBeenCalled()
    await useAskStore.getState().steer('Use a short answer', { route: 'hive', experience: 'classic' })
    expect(f.client.askSteer).not.toHaveBeenCalled()
    expect(useAskStore.getState().turns[op].held?.[0].text).toBe('Use a short answer')
    f.wakeRelease(); await sent
    await vi.waitFor(() => expect(f.client.askSteer).toHaveBeenCalledTimes(1))
    expect(f.client.ask).toHaveBeenCalledTimes(1)
    expect(f.client.ask.mock.calls[0][0].operation_id).toBe(op)
    expect(f.client.askSteer.mock.calls[0][0]).toBe(op)
    expect(askAutoWake.view(op)).toBeNull()
  })
  it('a stopped mind is woken and the request delivered once, like an asleep one (Jon 11-04)', async () => {
    const f = fixture('stopped')
    const sent = useAskStore.getState().send('make me a nice poster about cats', { route: 'hive', experience: 'classic' })
    const op = useAskStore.getState().open!
    await vi.waitFor(() => expect(f.client.agentAction).toHaveBeenCalledExactlyOnceWith('a_ada', 'wake'))
    expect(f.client.ask).not.toHaveBeenCalled()
    f.wakeRelease(); await sent
    expect(f.client.ask).toHaveBeenCalledTimes(1)
    expect(f.client.ask.mock.calls[0][0].operation_id).toBe(op)
    expect(askAutoWake.view(op)).toBeNull()
  })
  it('an unknown status still never wakes or sends', async () => {
    const f = fixture('error')
    await useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
    expect(f.client.agentAction).not.toHaveBeenCalled()
    expect(f.client.ask).not.toHaveBeenCalled()
  })
  it('retries only a known not-sent request with the same operation and no second admission callback', async () => {
    const f = fixture()
    f.client.agentAction.mockRejectedValueOnce(new Error('invented wake refusal'))
    const admission = vi.fn()
    await useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' }, { admission })
    const op = Object.keys(useAskStore.getState().turns)[0]
    expect(useAskStore.getState().open).toBeNull()
    expect(askAutoWake.view(op)?.phase).toBe('failed')
    expect(f.client.ask).not.toHaveBeenCalled()
    expect(admission).toHaveBeenCalledExactlyOnceWith({ admitted: false, reason: 'failed' })
    const clearRestoration = vi.fn()
    askAutoWake.restoreDraft(op, () => clearRestoration)
    f.wakeRelease()
    await askAutoWake.retry(op)
    expect(clearRestoration).toHaveBeenCalledTimes(1)
    expect(f.client.ask).toHaveBeenCalledTimes(1)
    expect(f.client.ask.mock.calls[0][0].operation_id).toBe(op)
    expect(admission).toHaveBeenCalledTimes(1)
  })
  it('Stop during waking never sends Ask or a stop for an operation the host has not received', async () => {
    const f = fixture()
    const sent = useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
    await vi.waitFor(() => expect(f.client.agentAction).toHaveBeenCalledTimes(1))
    await useAskStore.getState().stop()
    f.wakeRelease(); await sent
    expect(f.client.ask).not.toHaveBeenCalled()
    expect(f.client.askStop).not.toHaveBeenCalled()
    expect(useAskStore.getState().open).toBeNull()
  })
  it('a session reset during wake prevents late delivery and removes private wake UI state', async () => {
    const f = fixture()
    const sent = useAskStore.getState().send('Read my private note', { private: true })
    const op = useAskStore.getState().open!
    await vi.waitFor(() => expect(f.client.agentAction).toHaveBeenCalledTimes(1))
    useAskStore.getState().reset()
    f.wakeRelease(); await sent
    expect(f.client.ask).not.toHaveBeenCalled()
    expect(askAutoWake.view(op)).toBeNull()
    expect(useAskStore.getState().log).toEqual([])
  })
  it('after dispatch Stop uses the existing host route rather than claiming the request was not sent', async () => {
    const f = fixture(); f.wakeRelease()
    let finish!: (r: never) => void
    f.client.ask.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const sent = useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
    await vi.waitFor(() => expect(f.client.ask).toHaveBeenCalledTimes(1))
    expect(askAutoWake.pending(useAskStore.getState().open!)).toBe(false)
    await useAskStore.getState().stop()
    expect(f.client.askStop).toHaveBeenCalledTimes(1)
    finish({ operation_id: useAskStore.getState().open, turn_id: 't_wake', state: 'accepted', thread } as never)
    await sent
  })
  it('a lost Ask reply stays in the existing checking protocol with no wake retry control', async () => {
    const f = fixture(); f.wakeRelease()
    f.client.ask.mockRejectedValueOnce(new ApiError(0, 'network', 'invented lost reply'))
    let release!: (r: unknown) => void
    const read = vi.fn(() => new Promise((resolve) => { release = resolve }))
    Object.assign(f.client, { askTurn: read })
    const sent = useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
    const op = useAskStore.getState().open!
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].state).toBe('checking'))
    expect(askAutoWake.view(op)).toBeNull()
    expect(f.client.ask).toHaveBeenCalledTimes(1)
    expect(askAutoWake.canRetry(op)).toBe(false)
    release({ operation_id: op, turn_id: 't_wake', thread, state: 'accepted', events: [], more: false })
    await sent
    expect(f.client.ask).toHaveBeenCalledTimes(1)
  })
})

describe('explicit own-mind alternate for a non-private known-unsent request', () => {
  it('holds the denied target, then wakes and sends to the fresh own mind only after the alternate is chosen', async () => {
    const f = fixture()
    const ownAgent = f.client.getAgent.getMockImplementation()!
    f.client.getAgent.mockImplementation(async (id?: string) => id === 'a_deneb'
      ? { id, name: 'Deneb', status: 'asleep', kind: 'omega', swarm_id: 's_other', may_sleep: true, is_mine: false }
      : ownAgent())
    f.client.getSwarm.mockImplementation(async (id?: string) => id === 's_other'
      ? { id, coordinator_id: 'a_deneb', owner: 'user:someone-else' }
      : { id: 's_home', coordinator_id: 'a_ada', owner: 'user:invented' })
    await useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic', swarm_id: 's_other' })
    const op = Object.keys(useAskStore.getState().turns)[0]
    expect(askAutoWake.view(op)).toMatchObject({ phase: 'gated', gate: 'authority', own: { id: 'a_ada' } })
    expect(f.client.agentAction).not.toHaveBeenCalled()
    expect(f.client.ask).not.toHaveBeenCalled()
    const retry = askAutoWake.useOwn(op)
    await vi.waitFor(() => expect(f.client.agentAction).toHaveBeenCalledTimes(1))
    f.wakeRelease(); await retry
    expect(f.client.agentAction).toHaveBeenCalledExactlyOnceWith('a_ada', 'wake')
    expect(f.client.ask).toHaveBeenCalledTimes(1)
    expect(f.client.ask.mock.calls[0][0]).toMatchObject({ operation_id: op, context: { mind: 'a_ada', swarm_id: 's_home' } })
  })
  it('does not offer a hidden recipient override on a private request', async () => {
    const f = fixture()
    f.client.askSettings.mockResolvedValue({ swarm_id: 's_home' } as never)
    f.client.getAgent.mockResolvedValue({ id: 'a_ada', name: 'Ada', status: 'asleep', kind: 'omega', swarm_id: 's_home', may_sleep: true, is_mine: false })
    f.client.getSwarm.mockResolvedValue({ id: 's_home', coordinator_id: 'a_ada', owner: 'user:someone-else' })
    await useAskStore.getState().send('Read my private note', { private: true })
    const op = Object.keys(useAskStore.getState().turns)[0]
    expect(askAutoWake.view(op)?.own).toBeUndefined()
    await askAutoWake.useOwn(op)
    expect(f.client.agentAction).not.toHaveBeenCalled()
    expect(f.client.ask).not.toHaveBeenCalled()
  })
})

it('a stale failure view cannot restore earlier words after the request is cleared', async () => {
  const f = fixture()
  f.client.agentAction.mockRejectedValueOnce(new Error('invented refusal'))
  await useAskStore.getState().send('Earlier private words', { private: true })
  const op = Object.keys(useAskStore.getState().turns)[0]
  useAskStore.getState().reset()
  const restore = vi.fn(() => vi.fn())
  askAutoWake.restoreDraft(op, restore)
  expect(restore).not.toHaveBeenCalled()
})

it('a private authority gate saves a default only through an explicit existing-picker choice, then retries the same private operation', async () => {
  const f = fixture()
  let selected = 's_denied'
  const ownAgent = f.client.getAgent.getMockImplementation()!
  f.client.askSettings.mockImplementation(async () => ({ swarm_id: selected } as never))
  f.client.getSwarm.mockImplementation(async (id?: string) => id === 's_denied'
    ? { id, coordinator_id: 'a_deneb', owner: 'user:someone-else' }
    : { id: 's_home', coordinator_id: 'a_ada', owner: 'user:invented' })
  f.client.getAgent.mockImplementation(async (id?: string) => id === 'a_deneb'
    ? { id, name: 'Deneb', status: 'asleep', kind: 'omega', swarm_id: 's_denied', may_sleep: true, is_mine: false }
    : ownAgent())
  const save = vi.fn(async (body: { swarm_id: string }) => { selected = body.swarm_id; return { swarm_id: selected } })
  Object.assign(f.client, { setAskSettings: save })
  await useAskStore.getState().send('Read my private note', { private: true })
  const op = Object.keys(useAskStore.getState().turns)[0]
  expect(askAutoWake.view(op)).toMatchObject({ phase: 'gated', gate: 'authority', privateRequest: true })
  expect(save).not.toHaveBeenCalled()
  expect(f.client.agentAction).not.toHaveBeenCalled()
  expect(f.client.ask).not.toHaveBeenCalled()
  // AnswererPicker without an op saves the explicit default; its onDone invokes the known-unsent retry.
  expect(await useAskStore.getState().chooseAnswerer('s_home')).toBe('saved')
  const retry = askAutoWake.retry(op)
  await vi.waitFor(() => expect(f.client.agentAction).toHaveBeenCalledTimes(1))
  f.wakeRelease(); await retry
  expect(save).toHaveBeenCalledExactlyOnceWith({ swarm_id: 's_home' })
  expect(f.client.ask).toHaveBeenCalledTimes(1)
  expect(f.client.ask.mock.calls[0][0]).toMatchObject({ operation_id: op, context: { private: true } })
  expect(Object.keys((f.client.ask.mock.calls[0][0] as unknown as { context: object }).context)).toEqual(['private'])
})

it('only a typed native budget_exhausted wake response becomes a spending gate', async () => {
  const f = fixture()
  f.client.agentAction.mockRejectedValueOnce(new ApiError(402, 'budget_exhausted', 'native code, not parsed copy'))
  await useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
  const op = Object.keys(useAskStore.getState().turns)[0]
  expect(askAutoWake.view(op)).toMatchObject({ phase: 'gated', gate: 'spending', mindId: 'a_ada' })
  expect(f.client.ask).not.toHaveBeenCalled()
})

it('an error message mentioning a budget is not native spending authority', async () => {
  const f = fixture()
  f.client.agentAction.mockRejectedValueOnce(new Error('budget_exhausted appears only in untyped text'))
  await useAskStore.getState().send('Read my note', { route: 'hive', experience: 'classic' })
  const op = Object.keys(useAskStore.getState().turns)[0]
  expect(askAutoWake.view(op)).toMatchObject({ phase: 'failed' })
  expect(askAutoWake.view(op)?.gate).toBeUndefined()
  expect(f.client.ask).not.toHaveBeenCalled()
})

describe('streamed completion precedes a delayed HTTP reply', () => {
  for (const outcome of ['success', 'error'] as const) it(`keeps completed A and current B intact after A delayed ${outcome}`, async () => {
    const f = fixture(); f.wakeRelease()
    let finish!: (value: never) => void, fail!: (error: Error) => void
    const delayed = new Promise<never>((resolve, reject) => { finish = resolve; fail = reject })
    const nextThread = { ...thread, id: 'ses_next', mind: { id: 'a_next', name: 'Next' } }
    f.client.ask.mockImplementationOnce(() => delayed).mockImplementationOnce(async (b) => ({ operation_id: b.operation_id, turn_id: 't_next', state: 'accepted', thread: nextThread }))
    const admissionA = vi.fn(), admissionB = vi.fn()
    const sentA = useAskStore.getState().send('First request', { route: 'hive', experience: 'classic' }, { admission: admissionA })
    const opA = useAskStore.getState().open!
    await vi.waitFor(() => expect(f.client.ask).toHaveBeenCalledTimes(1))
    const base = { type: 'ask', operation_id: opA, turn_id: 't_wake', principal: 'user:invented', at: '2026-11-02T13:00:00Z' }
    useAskStore.getState().onEvent({ ...base, seq: 1, phase: 'accepted', thread })
    useAskStore.getState().onEvent({ ...base, seq: 2, phase: 'done', outcome: 'answered', spent_usd: 0.01 })
    await vi.waitFor(() => expect(useAskStore.getState().turns[opA].state).toBe('done'))
    await useAskStore.getState().send('Second request', { route: 'hive', experience: 'classic' }, { admission: admissionB })
    const opB = useAskStore.getState().open!
    expect(opB).not.toBe(opA)
    expect(useAskStore.getState().thread?.id).toBe('ses_next')
    if (outcome === 'success') finish({ operation_id: opA, turn_id: 't_wake', state: 'accepted', thread } as never)
    else fail(new ApiError(409, 'not_available', 'delayed error after proven streamed completion'))
    await sentA
    const state = useAskStore.getState()
    expect(state.turns[opA].state).toBe('done')
    expect(state.turns[opA].refusedEarly).toBeUndefined()
    expect(state.open).toBe(opB)
    expect(state.thread?.id).toBe('ses_next')
    expect(state.turns[opB].state).toBe('open')
    expect(admissionA).toHaveBeenCalledExactlyOnceWith({ admitted: true, op: opA, principal: 'user:invented' })
    expect(admissionB).toHaveBeenCalledExactlyOnceWith({ admitted: true, op: opB, principal: 'user:invented' })
    expect(f.client.ask).toHaveBeenCalledTimes(2)
  })
})

it('an immediate wake refusal retains its failed delivery and retry after the turn closes', async () => {
  const f = fixture(); f.client.agentAction.mockRejectedValueOnce(new Error('immediate refusal'))
  await useAskStore.getState().send('Keep this request', { route: 'hive', experience: 'classic' })
  const op = Object.keys(useAskStore.getState().turns)[0]
  await Promise.resolve(); await Promise.resolve()
  expect(useAskStore.getState().open).toBeNull()
  expect(askAutoWake.view(op)).toMatchObject({ phase: 'failed' })
  expect(askAutoWake.canRetry(op)).toBe(true)
  expect(f.client.ask).not.toHaveBeenCalled()
})

describe('fresh principal mismatches remain fail-closed at store boundaries', () => {
  it('delivery never wakes, sends, or adopts an answerer from another principal', async () => {
    const f = fixture()
    f.client.me.mockResolvedValue({ principal: 'user:other', role: 'admin' })
    await useAskStore.getState().send('Keep these invented words with their person', { route: 'hive', experience: 'classic' })
    const op = Object.keys(useAskStore.getState().turns)[0]
    expect(f.client.agentAction).not.toHaveBeenCalled()
    expect(f.client.ask).not.toHaveBeenCalled()
    expect(f.client.getAgent).not.toHaveBeenCalled()
    expect(useAskStore.getState().thread).toBeNull()
    expect(useAskStore.getState().turns[op].answerer).toBeUndefined()
    expect(askAutoWake.view(op)).toMatchObject({ phase: 'failed', changed: true })
    expect(askAutoWake.view(op)?.mindId).toBeUndefined()
  })
  it('chooser save never writes or clears the local choice for a mismatched principal', async () => {
    const f = fixture()
    const { answererChoice } = await import('../features/ask/answererChoice')
    const saved = { swarm_id: 's_before', thread_budget_usd: .25 }
    useAskStore.setState({ settings: saved })
    answererChoice.select({ kind: 'swarm', swarm: 's_local', name: 'Invented local choice' }, () => true)
    const save = vi.fn(async () => ({ swarm_id: 's_other', thread_budget_usd: .25 }))
    Object.assign(f.client, { setAskSettings: save })
    f.client.me.mockResolvedValue({ principal: 'user:other', role: 'admin' })
    expect(await useAskStore.getState().chooseAnswerer('s_other')).toBe('failed')
    expect(save).not.toHaveBeenCalled()
    expect(f.client.agentAction).not.toHaveBeenCalled()
    expect(f.client.ask).not.toHaveBeenCalled()
    expect(useAskStore.getState().settings).toEqual(saved)
    expect(useAskStore.getState().thread).toBeNull()
    expect(answererChoice.apply({ route: 'hive', experience: 'classic' })).toMatchObject({ swarm_id: 's_local' })
  })
})
