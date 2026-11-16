import { afterEach, describe, expect, it, vi } from 'vitest'
import { askAutoWake, nativeWakePorts, type NativeWakeClient, WakeBeforeSend, type WakeAttemptPorts, type WakeInspection } from '../../store/askAutoWake'
const awake: WakeInspection = { state: 'awake', canWake: true }
const asleep: WakeInspection = { state: 'asleep', canWake: true }
function fixture(views: WakeInspection[]) {
  let index = 0
  const ports: WakeAttemptPorts<string> = { current: () => true,
    inspect: vi.fn(async () => views[Math.min(index++, views.length - 1)]),
    wake: vi.fn(async () => undefined), send: vi.fn(async () => 'reply'), phase: vi.fn() }
  return ports
}
afterEach(() => vi.useRealTimers())
describe('wake before Ask delivery', () => {
  it('wakes a resting target once and delivers once even when run is called twice', async () => {
    const ports = fixture([asleep, awake]); const attempt = new WakeBeforeSend(ports)
    const first = attempt.run(), second = attempt.run()
    expect(first).toBe(second)
    expect(await first).toEqual({ kind: 'sent', value: 'reply' })
    expect(ports.wake).toHaveBeenCalledTimes(1)
    expect(ports.send).toHaveBeenCalledTimes(1)
  })
  it('does not wake an already awake target', async () => {
    const ports = fixture([awake]); expect((await new WakeBeforeSend(ports).run()).kind).toBe('sent')
    expect(ports.wake).not.toHaveBeenCalled()
    expect(ports.send).toHaveBeenCalledTimes(1)
  })
  it('does not wake or deliver when current native authority says no', async () => {
    const ports = fixture([{ ...asleep, canWake: false }])
    expect(await new WakeBeforeSend(ports).run()).toEqual({ kind: 'gated', gate: 'authority' })
    expect(ports.wake).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled()
  })
  it('keeps each real gate distinct without executing it', async () => {
    for (const gate of ['spending', 'approval', 'quiet-hours'] as const) {
      const ports = fixture([{ ...asleep, gate }])
      expect(await new WakeBeforeSend(ports).run()).toEqual({ kind: 'gated', gate })
      expect(ports.wake).not.toHaveBeenCalled(); expect(ports.send).not.toHaveBeenCalled()
    }
  })
  it('does not deliver after the identity changes during a wake', async () => {
    let current = true; const ports = fixture([asleep, awake]); ports.current = () => current
    ports.wake = vi.fn(async () => { current = false })
    expect(await new WakeBeforeSend(ports).run()).toEqual({ kind: 'stale' })
    expect(ports.send).not.toHaveBeenCalled()
  })
  it('an unconfirmed wake times out without sending or automatically retrying', async () => {
    vi.useFakeTimers()
    const ports = fixture([asleep]); ports.wake = vi.fn(() => new Promise(() => {}))
    const result = new WakeBeforeSend(ports, 1000).run()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual({ kind: 'wake-failed', reason: 'unconfirmed', requestSent: false })
    expect(ports.wake).toHaveBeenCalledTimes(1); expect(ports.send).not.toHaveBeenCalled()
  })
  it('waits for an existing start without a second wake effect', async () => {
    vi.useFakeTimers()
    const ports = fixture([{ state: 'starting', canWake: false }, awake])
    const result = new WakeBeforeSend(ports).run()
    await vi.advanceTimersByTimeAsync(250)
    expect((await result).kind).toBe('sent')
    expect(ports.wake).not.toHaveBeenCalled(); expect(ports.send).toHaveBeenCalledTimes(1)
  })
  it('cancels before delivery and never retries a send error', async () => {
    const ports = fixture([asleep]); ports.wake = vi.fn(() => new Promise(() => {}))
    const attempt = new WakeBeforeSend(ports); const pending = attempt.run()
    await Promise.resolve(); await Promise.resolve(); attempt.cancel()
    expect(await pending).toEqual({ kind: 'stale' }); expect(ports.send).not.toHaveBeenCalled()
    const sending = fixture([awake]); const lost = new Error('synthetic lost reply')
    sending.send = vi.fn(async () => { throw lost })
    const once = new WakeBeforeSend(sending)
    expect(await once.run()).toEqual({ kind: 'send-error', error: lost })
    await once.run(); expect(sending.send).toHaveBeenCalledTimes(1)
  })
})

// Invented native responses: exercise routing/authority together with effect counts.
function nativeFixture() {
  const mind = { id: 'a_ada', name: 'Ada', swarm_id: 's_home', kind: 'omega', status: 'asleep', may_sleep: true, is_mine: true }
  const swarm = { id: 's_home', coordinator_id: 'a_ada', owner: 'user:owner' }
  const client = {
    me: vi.fn(async () => ({ principal: 'user:owner', role: 'member' })),
    askSettings: vi.fn(async () => ({ swarm_id: null })),
    myMind: vi.fn(async () => ({ mind: { id: 'a_ada', name: 'Ada', swarm_id: 's_home' } })),
    getAgent: vi.fn(async (id: string) => ({ ...mind, id })),
    getSwarm: vi.fn(async () => ({ ...swarm })),
    agentAction: vi.fn(async () => { mind.status = 'awake'; return { ...mind } }),
  }
  const send = vi.fn(async () => 'admitted')
  const run = (context: Parameters<typeof nativeWakePorts>[0]['context'] = { route: 'hive', experience: 'classic' }) => new WakeBeforeSend(nativeWakePorts({
    client: client as unknown as NativeWakeClient, principal: 'user:owner', context, current: () => true, send, phase: () => {},
  })).run()
  return { client, mind, swarm, send, run }
}
describe('native Ask wake routing and custody', () => {
  it('uses fresh own-mind fallback, preserves the exact private context and wakes once', async () => {
    const f = nativeFixture(); const context = Object.freeze({ private: true as const })
    expect(await f.run(context)).toEqual({ kind: 'sent', value: 'admitted' })
    expect(f.client.agentAction).toHaveBeenCalledExactlyOnceWith('a_ada', 'wake')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(context).toEqual({ private: true })
  })
  it('wakes the addressed member’s coordinator, not the member', async () => {
    const f = nativeFixture()
    expect((await f.run({ route: 'hive', experience: 'classic', mind: 'a_member' })).kind).toBe('sent')
    expect(f.client.agentAction).toHaveBeenCalledExactlyOnceWith('a_ada', 'wake')
  })
  it('uses the current saved swarm before personal fallback', async () => {
    const f = nativeFixture()
    f.client.askSettings.mockResolvedValue({ swarm_id: 's_saved' } as never)
    f.client.getSwarm.mockImplementation(async () => ({ ...f.swarm, id: 's_saved' }))
    f.mind.swarm_id = 's_saved'
    expect((await f.run()).kind).toBe('sent')
    expect(f.client.myMind).not.toHaveBeenCalled()
    expect(f.client.getSwarm).toHaveBeenCalledWith('s_saved')
  })
  it('does not treat a visible, sleepable mind as owned', async () => {
    const f = nativeFixture(); f.mind.is_mine = false; f.swarm.owner = 'user:someone-else'
    expect(await f.run({ route: 'hive', experience: 'classic', swarm_id: 's_home' })).toEqual({ kind: 'gated', gate: 'authority' })
    expect(f.client.agentAction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('rechecks authority before wake rather than using the first read', async () => {
    const f = nativeFixture(); let reads = 0
    f.client.getAgent.mockImplementation(async (id) => ({ ...f.mind, id, may_sleep: ++reads === 1 }))
    expect(await f.run({ route: 'hive', experience: 'classic', swarm_id: 's_home' })).toEqual({ kind: 'gated', gate: 'authority' })
    expect(f.client.agentAction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('does not wake or deliver when the coordinator changes during inspection', async () => {
    const f = nativeFixture(); let reads = 0
    f.client.getSwarm.mockImplementation(async () => ({ ...f.swarm, coordinator_id: ++reads === 1 ? 'a_ada' : 'a_new' }))
    expect(await f.run({ route: 'hive', experience: 'classic', swarm_id: 's_home' })).toEqual({ kind: 'stale' })
    expect(f.client.agentAction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('does not wake or deliver for a changed principal', async () => {
    const f = nativeFixture()
    f.client.me.mockResolvedValue({ principal: 'user:other', role: 'admin' })
    expect(await f.run()).toEqual({ kind: 'stale' })
    expect(f.client.agentAction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('leaves a missing coordinator to the host refusal without waking a different mind', async () => {
    const f = nativeFixture(); f.swarm.coordinator_id = ''
    expect((await f.run({ route: 'hive', experience: 'classic', swarm_id: 's_home' })).kind).toBe('sent')
    expect(f.client.agentAction).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1)
  })
})

describe('native wake deadline during authority recheck', () => {
  it('never issues a late wake after a timed-out pre-effect read resolves', async () => {
    vi.useFakeTimers()
    const f = nativeFixture()
    let finish!: (v: { principal: string; role: string }) => void
    f.client.me.mockImplementationOnce(async () => ({ principal: 'user:owner', role: 'member' }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.run({ route: 'hive', experience: 'classic', swarm_id: 's_home' })
    await vi.advanceTimersByTimeAsync(30000)
    expect(await pending).toEqual({ kind: 'wake-failed', reason: 'unconfirmed', requestSent: false })
    finish({ principal: 'user:owner', role: 'member' })
    await vi.advanceTimersByTimeAsync(1)
    expect(f.client.agentAction).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
})

it('an own-mind alternate is invalidated if the host remaps that person’s own mind before waking', async () => {
  const f = nativeFixture()
  const ports = nativeWakePorts({ client: f.client as unknown as NativeWakeClient, principal: 'user:owner',
    context: { route: 'hive', experience: 'classic', mind: 'a_previous' }, expectedOwn: 'a_previous',
    current: () => true, send: f.send, phase: () => {},
  })
  expect(await new WakeBeforeSend(ports).run()).toEqual({ kind: 'stale' })
  expect(f.client.agentAction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

describe('dispatch is not reversible by later route/identity staleness', () => {
  for (const outcome of ['success', 'error'] as const) it(`preserves a delayed dispatched ${outcome} after current becomes false`, async () => {
    const ports = fixture([awake]); let current = true
    ports.current = () => current
    let finish!: (value: string) => void, fail!: (error: Error) => void
    ports.send = vi.fn(() => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject }))
    const attempt = new WakeBeforeSend(ports), pending = attempt.run()
    await vi.waitFor(() => expect(ports.send).toHaveBeenCalledTimes(1))
    current = false; attempt.cancel()
    const error = new Error('delayed transport error')
    if (outcome === 'success') finish('admitted'); else fail(error)
    expect(await pending).toEqual(outcome === 'success' ? { kind: 'sent', value: 'admitted' } : { kind: 'send-error', error })
    expect(ports.send).toHaveBeenCalledTimes(1)
  })
})

it('swarm ownership alone cannot wake an addressed member when there is no coordinator', async () => {
  const f = nativeFixture(); f.mind.is_mine = false
  f.client.getSwarm.mockResolvedValue({ ...f.swarm, coordinator_id: null } as never)
  expect(await f.run({ route: 'hive', experience: 'classic', mind: 'a_member' })).toEqual({ kind: 'gated', gate: 'authority' })
  expect(f.client.agentAction).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
})
for (const outcome of ['success', 'error'] as const) it(`clearing a dispatched registry entry preserves its delayed ${outcome}`, async () => {
  const f = nativeFixture(); f.mind.status = 'awake'
  let finish!: (value: string) => void, fail!: (error: Error) => void
  const send = vi.fn(() => new Promise<string>((resolve, reject) => { finish = resolve; fail = reject }))
  const pending = askAutoWake.deliver(`registry-${outcome}`, { client: f.client as unknown as NativeWakeClient, principal: 'user:owner', context: { route: 'hive', experience: 'classic' }, current: () => true, send, phase: () => {}, retry: async () => {}, reopen: () => {}, routeOwn: () => {} })
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  askAutoWake.clear()
  const error = new Error('delayed dispatched error')
  if (outcome === 'success') { finish('admitted'); expect(await pending).toBe('admitted') }
  else { const rejection = expect(pending).rejects.toBe(error); fail(error); await rejection }
})

it('a fresh mismatched principal cannot wake, send, or project a target', async () => {
  const f = nativeFixture()
  f.client.me.mockResolvedValue({ principal: 'user:other', role: 'admin' })
  const target = vi.fn(), fallback = vi.fn()
  const ports = nativeWakePorts({ client: f.client as unknown as NativeWakeClient, principal: 'user:owner',
    context: { route: 'hive', experience: 'classic' }, current: () => true, send: f.send, phase: () => {}, target, fallback })
  expect(await new WakeBeforeSend(ports).run()).toEqual({ kind: 'stale' })
  expect(f.client.agentAction).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
  expect(f.client.getAgent).not.toHaveBeenCalled()
  expect(target).not.toHaveBeenCalled()
  expect(fallback).not.toHaveBeenCalled()
})


it('an invalid private own-choice hint fails before native reads or effects', async () => {
  const f = nativeFixture()
  const target = vi.fn()
  const ports = nativeWakePorts({ client: f.client as unknown as NativeWakeClient, principal: 'user:owner',
    context: { private: true }, expectedOwn: 'a_ada', current: () => true, send: f.send, phase: () => {}, target })
  await expect(ports.inspect()).rejects.toThrow('expectedOwn never applies to a private Ask')
  expect(await new WakeBeforeSend(ports).run()).toEqual({ kind: 'wake-failed', reason: 'refused', requestSent: false })
  expect(f.client.me).not.toHaveBeenCalled()
  expect(f.client.getAgent).not.toHaveBeenCalled()
  expect(f.client.agentAction).not.toHaveBeenCalled()
  expect(target).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
})
