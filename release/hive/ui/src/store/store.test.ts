import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { SimClient } from '../api/sim/SimClient'
import { hiveBus, useHive } from './store'

const fresh = () => new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })

beforeEach(() => {
  vi.useFakeTimers()
  // a minimal window for wantsSim-free code paths that touch it
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  useHive.getState().client?.disconnect()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('store', () => {
  it('hydrates agents, swarms, models and every commons', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const s = useHive.getState()
    expect(s.ready).toBe(true)
    expect(Object.keys(s.agents).length).toBe(sim.agents.size)
    // archived swarms are left out of the hive's list (GET /api/swarms), as on live
    expect(Object.keys(s.swarms).length).toBe([...sim.swarms.values()].filter((w) => !w.archived_at).length)
    expect(s.swarms.s_tide).toBeUndefined()
    expect(s.models.length).toBeGreaterThan(0)
    for (const id of Object.keys(s.swarms)) expect(s.beliefsLoaded[id]).toBe(true)
  })

  it('applies live events from the client and fans them out to the scene bus', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const seen: string[] = []
    const off = hiveBus.on((e) => seen.push(e.type))
    await sim.agentAction('a_vega01', 'sleep')
    off()
    expect(useHive.getState().agents.a_vega01.status).toBe('asleep')
    expect(seen).toContain('agent.updated')
  })

  it('sends optimistically, then reconciles with the server message', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const p = useHive.getState().sendMessage('a_coral5', 'hello coral')
    expect(useHive.getState().pending.a_coral5).toHaveLength(1)
    expect(useHive.getState().pending.a_coral5[0].status).toBe('sending')
    await p
    const s = useHive.getState()
    expect(s.pending.a_coral5).toHaveLength(0)
    expect(s.messages.a_coral5.filter((m) => m.text === 'hello coral')).toHaveLength(1)
    vi.advanceTimersByTime(10_000)
    expect(useHive.getState().messages.a_coral5.some((m) => m.direction === 'out')).toBe(true)
  })

  it('keeps failed sends with an error and can retry them', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const spy = vi.spyOn(sim, 'sendMessage').mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Hub offline'))
    await useHive.getState().sendMessage('a_anvl09', 'deploy?')
    const failed = useHive.getState().pending.a_anvl09[0]
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Hub offline')
    await useHive.getState().retryMessage('a_anvl09', failed.tempId)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(useHive.getState().pending.a_anvl09).toHaveLength(0)
  })

  it('creates a dot, keeps the token out of the store and marks it for birth', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const created = await useHive.getState().createAgent({ name: 'Quill', kind: 'iter', swarm_id: 's_forge', model: 'mock/echo' })
    const s = useHive.getState()
    expect(created.token).toMatch(/^hvt_/)
    expect(s.agents[created.id]).toBeDefined()
    expect('token' in s.agents[created.id]).toBe(false)
    expect(s.focusBirth).toBe(created.id)
  })
})

describe('store · Phase 2', () => {
  it('hydrates approvals and goals, and decides an approval', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    let s = useHive.getState()
    expect(s.approvalsLoaded).toBe(true)
    const pending = Object.values(s.approvals).filter((a) => a.status === 'pending')
    expect(pending.length).toBeGreaterThanOrEqual(3)
    for (const id of Object.keys(s.swarms)) expect(s.goalsLoaded[id]).toBe(true)
    const p = useHive.getState().decide(pending[0].id, 'deny')
    expect(useHive.getState().deciding[pending[0].id]).toBe('deny')
    await p
    s = useHive.getState()
    expect(s.approvals[pending[0].id].status).toBe('denied')
    expect(s.deciding[pending[0].id]).toBeUndefined()
  })

  it('answers Never and For a time with a standing rule', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const pending = Object.values(useHive.getState().approvals).filter((a) => a.status === 'pending')
    await useHive.getState().decide(pending[0].id, 'never')
    expect(useHive.getState().approvals[pending[0].id].status).toBe('denied')
    await useHive.getState().decide(pending[1].id, 'for', 60)
    expect(useHive.getState().approvals[pending[1].id].status).toBe('approved')
    const rules = await sim.listPolicy()
    expect(rules.some((r) => r.skill === pending[0].skill && r.mode === 'deny')).toBe(true)
    expect(rules.some((r) => r.skill === pending[1].skill && r.mode === 'allow')).toBe(true)
  })

  it('patches goals optimistically and rolls back on failure', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const g = Object.values(useHive.getState().goals).find((x) => x.status === 'open')!
    // a definite refusal (4xx) rolls back; a 5xx is an unknown outcome and is re-read instead (Review ed50158)
    vi.spyOn(sim, 'patchGoal').mockRejectedValueOnce(new ApiError(409, 'boom', 'Nope'))
    const p = useHive.getState().patchGoal(g.id, { status: 'cancelled' })
    expect(useHive.getState().goals[g.id].status).toBe('cancelled')
    await p
    expect(useHive.getState().goals[g.id].status).toBe('open')
    expect(useHive.getState().toasts.at(-1)?.title).toMatch(/task/)
  })

  it('loads wakeups, toggles them and deletes with rollback', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    await useHive.getState().loadWakeups('a_anvl09')
    const ws = Object.values(useHive.getState().wakeups).filter((w) => w.agent_id === 'a_anvl09')
    expect(ws.length).toBeGreaterThan(1)
    const on = ws.find((w) => w.enabled)!
    await useHive.getState().patchWakeup(on.id, { enabled: false })
    expect(useHive.getState().wakeups[on.id]).toMatchObject({ enabled: false, next_run_at: null })
    vi.spyOn(sim, 'deleteWakeup').mockRejectedValueOnce(new ApiError(500, 'boom', 'Nope'))
    await useHive.getState().deleteWakeup(on.id)
    expect(useHive.getState().wakeups[on.id]).toBeDefined()
  })

  it('stops the whole hive', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    const n = await useHive.getState().stopAll()
    expect(n).toBeGreaterThan(0)
    vi.advanceTimersByTime(3000)
    expect(Object.values(useHive.getState().agents).every((a) => a.status === 'stopped')).toBe(true)
  })

  it('counts health alerts for the nav badge, keeps the toast, and resolves them; refusals can be dismissed', async () => {
    const client = fresh()
    await useHive.getState().init(client)
    const st = () => useHive.getState()
    const toasts = st().toasts.length
    const alert = { agent_id: 'a_x', name: 'X', kind: 'bad_skill', severity: 'high' as const, count: 2, skill: 'shell', result: 'err', hint: 'h' }
    ;(client as unknown as { emit(e: unknown): void }).emit({ type: 'health.alert', at: new Date().toISOString(), alert })
    expect(Object.keys(st().healthAlerts)).toHaveLength(1)
    expect(st().toasts.length).toBe(toasts + 1)
    st().resolveHealthAlerts()
    expect(st().healthAlerts).toEqual({})
    st().apply({ type: 'budget.refused', at: new Date().toISOString(), agent_id: 'a_x', code: 'spend_limit', count: 1 })
    expect(st().refusals.a_x?.code).toBe('spend_limit')
    st().dismissRefusal('a_x')
    expect(st().refusals.a_x).toBeUndefined()
  })
})

describe('store fixes (request K)', () => {
  it('agentAction and patchGoal say whether the hive took it', async () => {
    const sim = fresh()
    await useHive.getState().init(sim)
    expect(await useHive.getState().agentAction('a_vega01', 'sleep')).toBe(true)
    vi.spyOn(sim, 'agentAction').mockRejectedValueOnce(new ApiError(409, 'busy', 'No'))
    expect(await useHive.getState().agentAction('a_vega01', 'wake')).toBe(false)
    await useHive.getState().loadGoals('s_lyra')
    const g = Object.values(useHive.getState().goals).find((x) => x.swarm_id === 's_lyra' && x.status === 'open')!
    expect(await useHive.getState().patchGoal(g.id, { priority: 0.9 })).toBe(true)
    vi.spyOn(sim, 'patchGoal').mockRejectedValueOnce(new ApiError(500, 'boom', 'Nope'))
    expect(await useHive.getState().patchGoal(g.id, { priority: 0.2 })).toBe(false)
    expect(await useHive.getState().patchGoal('g_nope', { priority: 0.2 })).toBe(false)
  })
  it('a message never stays on Sending… without a hive', async () => {
    useHive.setState({ client: null, pending: {} })
    await useHive.getState().sendMessage('a_x', 'hello')
    const p = useHive.getState().pending.a_x
    expect(p).toHaveLength(1)
    expect(p[0].status).toBe('failed')
    expect(p[0].error).toMatch(/Not connected/)
  })
  it('openPalette(query) opens with the words typed; closing clears them', () => {
    useHive.getState().openPalette('settle')
    expect(useHive.getState()).toMatchObject({ paletteOpen: true, paletteQuery: 'settle' })
    useHive.getState().setPalette(false)
    expect(useHive.getState()).toMatchObject({ paletteOpen: false, paletteQuery: '' })
  })
})
