import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HiveEvent } from '../types'
import { SimClient } from './SimClient'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 2852 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 115000 }) // ~3x the worst case measured under load (followups-r5)

const make = (seed = 42) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })

afterEach(() => vi.useRealTimers())

describe('SimClient · Phase 2 seeding', () => {
  it('seeds policy, pending approvals and a history', async () => {
    const sim = make()
    const rules = await sim.listPolicy()
    expect(rules.some((r) => r.scope === 'hive')).toBe(true)
    expect(rules.some((r) => r.scope.startsWith('swarm:'))).toBe(true)
    expect(rules.some((r) => r.scope.startsWith('agent:'))).toBe(true)
    const all = await sim.listApprovals()
    expect(all.map((a) => a.created_at)).toEqual([...all.map((a) => a.created_at)].sort().reverse())
    const pending = await sim.listApprovals('pending')
    expect(pending.length).toBeGreaterThanOrEqual(3)
    expect(pending.every((a) => a.command.startsWith(`(${a.skill}`))).toBe(true)
    expect(all.some((a) => a.status === 'denied')).toBe(true)
    expect(all.some((a) => a.status === 'used')).toBe(true)
  })

  it('seeds goals with subgoals that point at real parents', async () => {
    const sim = make()
    for (const s of await sim.listSwarms()) {
      const goals = await sim.listGoals(s.id)
      expect(goals.length).toBeGreaterThan(3)
      const ids = new Set(goals.map((g) => g.id))
      const subs = goals.filter((g) => g.parent_id)
      expect(subs.length).toBeGreaterThan(0)
      for (const g of subs) expect(ids.has(g.parent_id!)).toBe(true)
      for (const g of goals.filter((x) => x.status === 'claimed')) expect(g.claimed_by).toBeTruthy()
    }
  })

  it('seeds per-iteration traces, newest first, linking asks to approvals', async () => {
    const sim = make()
    const traces = await sim.listTraces('a_anvl09', 50)
    expect(traces.length).toBeGreaterThan(8)
    expect(traces[0].id).toBeGreaterThan(traces[traces.length - 1].id)
    expect(traces[0].iteration).toBeGreaterThan(traces[1].iteration)
    const pending = (await sim.listApprovals('pending')).find((a) => a.agent_id === 'a_anvl09')!
    const ask = traces.flatMap((t) => t.commands).find((c) => c.gated === 'ask' && c.result.includes(pending.id))
    expect(ask?.command).toBe(pending.command)
    expect(traces.every((t) => t.tokens! > 0 && t.llm_ms! > 0)).toBe(true)
  })

  it('seeds wakeups with a future next run and memory spaces with atoms', async () => {
    const sim = make()
    const wakeups = await sim.listWakeups('a_anvl09')
    expect(wakeups.length).toBeGreaterThanOrEqual(2)
    for (const w of wakeups.filter((x) => x.enabled)) expect(Date.parse(w.next_run_at!)).toBeGreaterThan(Date.now())
    for (const w of wakeups.filter((x) => !x.enabled)) expect(w.next_run_at).toBeNull()
    const spaces = await sim.listMemory('a_vega01')
    expect(spaces.map((s) => s.name)).toContain('&self')
    expect(spaces.every((s) => s.atoms > 0 && s.bytes > s.atoms)).toBe(true)
    const hits = await sim.listAtoms('a_vega01', '&self', { q: 'vega' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.text.toLowerCase().includes('vega'))).toBe(true)
    expect((await sim.getAgent('a_vega01')).idle_sleep_minutes).toBe(30)
  })
})

describe('SimClient · Phase 2 behaviour', () => {
  it('emits approvals, goals, traces and wakeups while running', () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 3, latency: false, historyDays: 1 })
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    sim.connect()
    vi.advanceTimersByTime(6 * 60_000)
    sim.disconnect()
    const types = new Set(seen.map((e) => e.type))
    for (const t of ['approval.created', 'goal.updated', 'agent.trace', 'wakeup.fired', 'wakeup.updated'] as const) expect(types.has(t)).toBe(true)
    const trace = seen.find((e) => e.type === 'agent.trace')
    expect(trace?.type === 'agent.trace' && trace.trace.response.length).toBeGreaterThan(0)
    // every ask raised during the run has a matching approval event
    const asks = seen.flatMap((e) => (e.type === 'agent.trace' ? e.trace.commands.filter((c) => c.gated === 'ask') : []))
    const created = new Set(seen.flatMap((e) => (e.type === 'approval.created' ? [e.approval.id] : [])))
    for (const c of asks) expect(created.has(/p_\w+/.exec(c.result)?.[0] ?? '')).toBe(true)
  })

  it('approve with remember adds an allow rule and the mind uses it once', async () => {
    vi.useFakeTimers()
    const sim = make(4)
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    const p = (await sim.listApprovals('pending')).find((a) => a.agent_id === 'a_anvl09')!
    const ap = await sim.approve(p.id, true)
    expect(ap.status).toBe('approved')
    expect(ap.decided_by).toBe('user:operator')
    const rules = await sim.listPolicy()
    expect(rules.some((r) => r.scope === 'agent:a_anvl09' && r.skill === p.skill && r.mode === 'allow')).toBe(true)
    expect(seen.some((e) => e.type === 'policy.updated')).toBe(true)
    await expect(sim.approve(p.id)).rejects.toThrow(/Already/)
    vi.advanceTimersByTime(12_000)
    expect((await sim.listApprovals()).find((a) => a.id === p.id)?.status).toBe('used')
    const tr = seen.find((e) => e.type === 'agent.trace' && e.trace.input?.startsWith(`[APPROVED ${p.id}]`))
    expect(tr?.type === 'agent.trace' && tr.trace.commands[0]).toMatchObject({ command: p.command, gated: 'allow' })
  })

  it('deny closes the approval', async () => {
    const sim = make()
    const p = (await sim.listApprovals('pending'))[0]
    expect((await sim.deny(p.id)).status).toBe('denied')
    expect((await sim.listApprovals('pending')).some((a) => a.id === p.id)).toBe(false)
  })

  it('creates a goal that a member claims, and work flows through splits to done', async () => {
    vi.useFakeTimers()
    const sim = make(8)
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    const g = await sim.createGoal('s_forge', { title: 'Rotate certificates', priority: 0.9 })
    expect(g).toMatchObject({ status: 'open', created_by: 'user:operator', parent_id: null })
    vi.advanceTimersByTime(6000)
    const claimed = (await sim.listGoals('s_forge')).find((x) => x.id === g.id)!
    expect(claimed.status).toBe('claimed')
    expect(sim.agents.get(claimed.claimed_by!)?.swarm_id).toBe('s_forge')
    await expect(sim.createGoal('s_forge', { title: ' ' })).rejects.toThrow(/Title/)
    for (let i = 0; i < 400; i++) {
      sim.goalStep()
      vi.advanceTimersByTime(1000)
    }
    const goals = seen.flatMap((e) => (e.type === 'goal.updated' ? [e.goal] : []))
    expect(goals.some((x) => x.parent_id && x.created_by.startsWith('agent:'))).toBe(true)
    expect(goals.some((x) => x.status === 'done')).toBe(true)
    const patched = await sim.patchGoal(g.id, { status: 'open' })
    expect(patched.claimed_by).toBeNull()
  })

  it('validates, fires and disables wakeups', async () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 2, latency: false, historyDays: 1 })
    await expect(sim.createWakeup('a_vega01', { cron: '0 9 * *', text: 'x' })).rejects.toThrow(/5 fields/)
    await expect(sim.createWakeup('a_vega01', { cron: '0 9 * * *', text: 'x', tz: 'Mars/Olympus' })).rejects.toThrow(/time zone/)
    const at = new Date(Date.now() + 90_000).toISOString()
    const w = await sim.createWakeup('a_altr03', { at, text: 'Look at the flare.' })
    expect(w.next_run_at).toBe(at)
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    sim.connect()
    vi.advanceTimersByTime(150_000)
    sim.disconnect()
    expect(seen.some((e) => e.type === 'wakeup.fired' && e.wakeup_id === w.id && e.agent_id === 'a_altr03')).toBe(true)
    const after = (await sim.listWakeups('a_altr03')).find((x) => x.id === w.id)!
    expect(after).toMatchObject({ enabled: false, next_run_at: null })
    expect(after.last_run_at).toBeTruthy()
    const cron = await sim.createWakeup('a_vega01', { cron: '*/5 * * * *', text: 'Ping' })
    expect((await sim.patchWakeup(cron.id, { enabled: false })).next_run_at).toBeNull()
    expect((await sim.patchWakeup(cron.id, { enabled: true })).next_run_at).toBeTruthy()
    await sim.deleteWakeup(cron.id)
    expect((await sim.listWakeups('a_vega01')).some((x) => x.id === cron.id)).toBe(false)
  })

  it('queues memory retirement and reset, applied on the next loop', async () => {
    vi.useFakeTimers()
    const sim = make()
    const [atom] = await sim.listAtoms('a_coral5', '&notes')
    expect(await sim.retireAtom('a_coral5', '&notes', atom.text)).toEqual({ queued: true })
    expect((await sim.listAtoms('a_coral5', '&notes')).some((a) => a.text === atom.text)).toBe(true)
    vi.advanceTimersByTime(8000)
    expect((await sim.listAtoms('a_coral5', '&notes')).some((a) => a.text === atom.text)).toBe(false)
    await expect(sim.retireAtom('a_coral5', '&notes', '(nope)')).rejects.toThrow(/No such atom/)
    await sim.resetMemory('a_coral5')
    vi.advanceTimersByTime(6000)
    expect((await sim.listMemory('a_coral5')).every((s) => s.atoms === 0)).toBe(true)
  })

  it('stop-all stops every mind and patches idle sleep', async () => {
    vi.useFakeTimers()
    const sim = make()
    const running = [...sim.agents.values()].filter((a) => a.status !== 'stopped').length
    expect(await sim.stopAll()).toEqual({ stopped: running })
    expect((await sim.listAgents()).every((a) => a.status === 'stopped')).toBe(true)
    expect((await sim.patchAgent('a_vega01', { idle_sleep_minutes: 45 })).idle_sleep_minutes).toBe(45)
    await expect(sim.patchAgent('a_vega01', { idle_sleep_minutes: -1 })).rejects.toThrow(/idle_sleep/)
  })
})

describe('SimClient · goal leases and gateway errors', () => {
  it('seeds waiting and stalled goals and leases on claimed ones', async () => {
    const sim = make()
    const all = (await Promise.all(['s_lyra', 's_kelp', 's_forge'].map((id) => sim.listGoals(id)))).flat()
    expect(all.some((g) => g.status === 'waiting' && g.claimed_by && g.result)).toBe(true)
    expect(all.some((g) => g.status === 'stalled' && g.attempts === 3 && !g.claimed_by)).toBe(true)
    for (const g of all.filter((x) => x.status === 'claimed')) expect(Date.parse(g.lease_until!)).toBeGreaterThan(Date.now())
  })

  it('reopens a lapsed lease, stalls on the third lapse, and a person can re-open it', async () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 6, latency: false, historyDays: 1 })
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    const g = (await sim.listGoals('s_kelp')).find((x) => x.title === 'Transect B')!
    expect(g.attempts).toBe(1)
    const live0 = sim.goals.get(g.id)!
    Object.assign(live0, { status: 'claimed', lease_until: new Date(Date.now() - 1000).toISOString() })
    sim.connect()
    vi.advanceTimersByTime(3000)
    sim.disconnect()
    const lapsed = seen.find((e) => e.type === 'goal.updated' && e.goal.id === g.id && e.goal.attempts === 2)
    expect(lapsed?.type === 'goal.updated' && lapsed.goal).toMatchObject({ status: 'open', claimed_by: null, lease_until: null })
    // force the third lapse
    const live = sim.goals.get(g.id)!
    Object.assign(live, { status: 'claimed', claimed_by: 'a_coral5', attempts: 2, lease_until: new Date(Date.now() - 1000).toISOString() })
    sim.connect()
    vi.advanceTimersByTime(3000)
    sim.disconnect()
    expect(sim.goals.get(g.id)).toMatchObject({ status: 'stalled', claimed_by: null, attempts: 3 })
    const reopened = await sim.patchGoal(g.id, { status: 'open' })
    expect(reopened).toMatchObject({ status: 'open', attempts: 0, lease_until: null })
  })

  it('refuses paid models with no budget and records gateway errors', async () => {
    vi.useFakeTimers()
    const sim = make()
    await sim.patchAgent('a_vega01', { budget_usd: 0 })
    await sim.agentAction('a_vega01', 'sleep')
    await expect(sim.agentAction('a_vega01', 'wake')).rejects.toMatchObject({ status: 402, code: 'no_budget' })
    expect((await sim.getAgent('a_qnch11')).last_error).toMatch(/rate_limited/)
    // local models are fine at $0
    await sim.agentAction('a_mira04', 'sleep')
    expect((await sim.agentAction('a_mira04', 'wake')).status).toBe('starting')
  })
})
