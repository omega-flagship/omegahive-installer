import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HiveEvent } from '../types'
import { CommonsEngineError, SimCommons } from './commons'
import { SimClient, seedKey, simSeedCache } from './SimClient'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 2029 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 80000 }) // ~3x the worst case measured under load (followups-r5)

const make = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 3 })

afterEach(() => vi.useRealTimers())

describe('the sim commons runs on the real engine (lib_nal / lib_hive on MeTTaScript)', () => {
  it('revision is lib_nal Truth_Revision: evidence pools, frequency is weighted, confidence is capped at 0.99', () => {
    const e = SimCommons.start()
    expect(e.revise({ f: 1, c: 0.5 }, { f: 0, c: 0.5 })).toEqual({ f: 0.5, c: 0.6666666666666666 })
    // the cap: w = 99 + 99 gives c = 0.99497…; lib_nal says (min 0.99 …). The old TypeScript gave 0.995 here.
    expect(e.revise({ f: 1, c: 0.99 }, { f: 0, c: 0.99 })).toEqual({ f: 0.5, c: 0.99 })
    expect(e.revise({ f: 0.8, c: 0.9 }, { f: 0.6, c: 0.5 })).toEqual({ f: 0.78, c: 0.9090909090909091 })
  })

  it('a revised belief can never pass the cap, however much disjoint evidence arrives', async () => {
    const sim = make()
    await sim.addVocab('s_lyra', ['capped', 'glow'])
    const at = new Date().toISOString()
    for (let i = 1; i <= 6; i++) sim.applyAssertion('s_lyra', 'a_vega01', '(--> capped glow)', { f: 1, c: 0.98 }, [`ev:cap:${i}`], at)
    const d = sim.beliefs.get('s_lyra')!.get('(--> capped glow)')!
    expect(d.tv).toEqual({ f: 1, c: 0.99 })
    expect(d.stamp).toEqual(['ev:cap:1', 'ev:cap:2', 'ev:cap:3', 'ev:cap:4', 'ev:cap:5', 'ev:cap:6'])
    expect(d.assertions.map((x) => x.outcome)).toEqual(['adopted', 'revised', 'revised', 'revised', 'revised', 'revised'])
  })

  it('overlapping evidence is never revised: choice keeps the more confident one, whatever the agent', async () => {
    const sim = make()
    await sim.addVocab('s_lyra', ['murmur', 'glow'])
    const at = new Date().toISOString()
    sim.applyAssertion('s_lyra', 'a_vega01', '(--> murmur glow)', { f: 0.9, c: 0.6 }, ['ev:e:1'], at)
    // a second mind echoing the same evidence id: no revision, no confidence gained
    const echo = sim.applyAssertion('s_lyra', 'a_deneb2', '(--> murmur glow)', { f: 0.9, c: 0.6 }, ['ev:e:1', 'ev:e:2'], at)
    expect(echo.assertion.outcome).toBe('kept')
    expect(echo.belief).toBeNull()
    const d = sim.beliefs.get('s_lyra')!.get('(--> murmur glow)')!
    expect(d.tv).toEqual({ f: 0.9, c: 0.6 })
    expect(d.choices).toEqual([{ kept: ['ev:e:1'], rejected: ['ev:e:1', 'ev:e:2'] }])
  })

  it('vocabulary: a known term is adopted; a term outside the swarm’s vocabulary is quarantined by hive-publish! itself', async () => {
    const sim = make()
    const at = new Date().toISOString()
    expect(await sim.getVocab('s_lyra')).toEqual(expect.arrayContaining(['vega', 'star']))
    expect(await sim.getVocab('s_lyra')).not.toContain('invented-unmapped')
    const known = sim.applyAssertion('s_lyra', 'a_vega01', '(--> vega pulsar)', { f: 0.6, c: 0.4 }, ['ev:v:1'], at)
    expect(known.assertion.outcome).toBe('adopted')
    const q = sim.applyAssertion('s_lyra', 'a_vega01', '(--> invented-unmapped star)', { f: 1, c: 0.5 }, ['ev:v:2'], at)
    expect(q.assertion.outcome).toBe('quarantined')
    expect(q.belief).toBeNull()
    expect(sim.published.at(-1)?.unmapped).toEqual(['invented-unmapped'])
    expect(sim.beliefs.get('s_lyra')!.has('(--> invented-unmapped star)')).toBe(false)
    // once the term is in the vocabulary (hive-vocab-add!), the same claim is adopted
    expect(await sim.addVocab('s_lyra', ['invented-unmapped'])).toContain('invented-unmapped')
    expect(sim.applyAssertion('s_lyra', 'a_vega01', '(--> invented-unmapped star)', { f: 1, c: 0.5 }, ['ev:v:3'], at).assertion.outcome).toBe('adopted')
    // statements follow the host grammar (hive/spaces/sexpr.py): no variables, no characters outside it
    expect(() => sim.applyAssertion('s_lyra', 'a_vega01', '(==> (--> $x vega) (--> $x star))', { f: 1, c: 0.5 }, ['ev:v:4'], at)).toThrow(/variables are not allowed/)
    expect(() => sim.applyAssertion('s_lyra', 'a_vega01', '(--> (× vega star) has)', { f: 1, c: 0.5 }, ['ev:v:5'], at)).toThrow(/symbol not allowed/)
  })

  it('membership: an outsider is denied by the engine’s access list; joining grants, leaving revokes', async () => {
    const sim = make()
    const at = new Date().toISOString()
    // the seeded demo shows one outsider per swarm, denied by the same check
    for (const s of ['s_lyra', 's_kelp', 's_forge']) expect(sim.published.filter((p) => p.swarm_id === s && p.assertion.outcome === 'denied').length).toBe(1)
    const kelp = sim.swarms.get('s_kelp')!.member_ids[0]
    expect(sim.swarms.get('s_lyra')!.member_ids).not.toContain(kelp)
    const d = sim.applyAssertion('s_lyra', kelp, '(--> vega star)', { f: 0, c: 0.9 }, [`ev:${kelp}:900`], at)
    expect(d.assertion.outcome).toBe('denied')
    expect(d.belief).toBeNull()
    // a member who leaves the list is no longer granted
    const lyra = sim.swarms.get('s_lyra')!
    const vega = 'a_vega01'
    lyra.member_ids = lyra.member_ids.filter((m) => m !== vega)
    expect(sim.applyAssertion('s_lyra', vega, '(--> vega star)', { f: 1, c: 0.5 }, ['ev:a_vega01:900'], at).assertion.outcome).toBe('denied')
    lyra.member_ids.push(vega)
    expect(sim.applyAssertion('s_lyra', vega, '(--> vega star)', { f: 1, c: 0.5 }, ['ev:a_vega01:901'], at).assertion.outcome).toBe('revised')
  })

  it('the live stream’s refusals are the engine’s: every quarantine names the unmapped terms hive-publish! returned', () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 11, latency: false, historyDays: 1 })
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    sim.connect()
    vi.advanceTimersByTime(240_000)
    sim.disconnect()
    const refused = seen.flatMap((e) => (e.type === 'belief.published' && (e.assertion.outcome === 'quarantined' || e.assertion.outcome === 'denied') ? [e.assertion] : []))
    expect(refused.length).toBeGreaterThan(0)
    for (const a of refused) {
      const logged = sim.published.find((p) => p.assertion === a)
      expect(logged, a.statement).toBeDefined()
      if (a.outcome === 'quarantined') expect(logged!.unmapped!.length).toBeGreaterThan(0)
    }
  })

  it('seed cache: a hit is exactly the engine’s fresh seed (beliefs, stamps, outcomes, vocabulary, members, behaviour)', async () => {
    // one clock for every sim here, so the times (display only, re-timed on a hit) compare exactly too
    vi.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    simSeedCache.clear()
    const fresh = make()
    const cached = make()
    expect(simSeedCache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 })
    expect(cached.beliefs).toEqual(fresh.beliefs)
    expect(cached.published).toEqual(fresh.published)
    // a hit at another moment is re-timed to its own construction: every time shifts by exactly the clock's step
    vi.setSystemTime(new Date('2026-10-09T12:01:00Z'))
    const later = make()
    const times = (sim: SimClient) => sim.published.map((p) => Date.parse(p.assertion.created_at))
    expect(times(later)).toEqual(times(fresh).map((t) => t + 60_000))
    expect([...later.beliefs.get('s_lyra')!.values()].map((d) => Date.parse(d.updated_at))).toEqual([...fresh.beliefs.get('s_lyra')!.values()].map((d) => Date.parse(d.updated_at) + 60_000))
    for (const s of ['s_lyra', 's_kelp', 's_forge']) {
      expect(await cached.getVocab(s)).toEqual(await fresh.getVocab(s))
      expect(await cached.listBeliefs(s)).toEqual(await fresh.listBeliefs(s))
    }
    // the same assertions afterwards get the same answers from both engines: revision, choice, duplicate, quarantine,
    // denial (so Current, Asserted, Chosen, Term and the grants all came across)
    const at = new Date().toISOString()
    const kelp = fresh.swarms.get('s_kelp')!.member_ids[0]
    const lyra = [...fresh.beliefs.get('s_lyra')!.values()]
    const steps: [string, string, { f: number; c: number }, string[]][] = [
      ['a_vega01', lyra[0].statement, { f: 0.2, c: 0.6 }, ['ev:a_vega01:500']],
      ['a_deneb2', lyra[1].statement, { f: 0.9, c: 0.95 }, [lyra[1].stamp[0], 'ev:a_deneb2:500']],
      ...fresh.published.filter((p) => p.swarm_id === 's_lyra' && p.assertion.outcome === 'adopted').slice(0, 1).map((p) => [p.assertion.agent_id, p.assertion.statement, p.assertion.tv, p.assertion.stamp] as [string, string, { f: number; c: number }, string[]]),
      ['a_vega01', '(--> invented-unmapped star)', { f: 1, c: 0.5 }, ['ev:a_vega01:501']],
      [kelp, lyra[2].statement, { f: 0.5, c: 0.5 }, [`ev:${kelp}:500`]],
    ]
    const answers = (sim: SimClient) => steps.map(([a, st, tv, stamp]) => sim.applyAssertion('s_lyra', a, st, tv, stamp, at))
    const [fa, ca] = [answers(fresh), answers(cached)]
    expect(fa.map((x) => x.assertion.outcome)).toEqual(['revised', 'chosen', 'duplicate', 'quarantined', 'denied'])
    expect(ca).toEqual(fa)
    expect(cached.beliefs).toEqual(fresh.beliefs)
  })

  it('seed cache: one sim’s changes never reach another (every hit is its own deep copy)', async () => {
    // one clock for every sim here, so the times (display only, re-timed on a hit) compare exactly too
    vi.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z'), toFake: ['Date'] })
    simSeedCache.clear()
    const a = make()
    const before = structuredClone([...a.beliefs.entries()].map(([k, m]) => [k, [...m.entries()]]))
    // change everything a later sim could see: a belief, its read-model objects, the vocabulary, the access list
    const at = new Date().toISOString()
    a.applyAssertion('s_lyra', 'a_vega01', [...a.beliefs.get('s_lyra')!.keys()][0], { f: 0, c: 0.9 }, ['ev:a_vega01:700'], at)
    const d = [...a.beliefs.get('s_lyra')!.values()][1]
    d.tv.f = 0.123
    d.assertions.push({ ...d.assertions[0], agent_id: 'leak' })
    await a.addVocab('s_lyra', ['leaked-term'])
    a.swarms.get('s_lyra')!.member_ids.push('a_x9999')
    a.applyAssertion('s_lyra', 'a_x9999', '(--> vega star)', { f: 1, c: 0.5 }, ['ev:a_x9999:1'], at)
    const b = make()
    expect(simSeedCache.stats().hits).toBe(1)
    expect([...b.beliefs.entries()].map(([k, m]) => [k, [...m.entries()]])).toEqual(before)
    expect(await b.getVocab('s_lyra')).not.toContain('leaked-term')
    expect(b.applyAssertion('s_lyra', 'a_x9999', '(--> vega star)', { f: 1, c: 0.5 }, ['ev:a_x9999:1'], at).assertion.outcome).toBe('denied')
    expect([...b.beliefs.get('s_lyra')!.values()][1]).not.toBe(d)
    // and a third sim, from the same cache, is still the pristine seed
    const c = make()
    expect([...c.beliefs.entries()].map(([k, m]) => [k, [...m.entries()]])).toEqual(before)
    expect(c.applyAssertion('s_lyra', 'a_x9999', '(--> vega star)', { f: 1, c: 0.5 }, ['ev:a_x9999:1'], at).assertion.outcome).toBe('denied')
    expect(await c.getVocab('s_lyra')).not.toContain('leaked-term')
  })

  it('seed cache key: the program, and the sha256 of lib_nal, lib_pln, lib_hive and the adapter', () => {
    const libs = [['lib_nal', 'a'], ['lib_pln', 'b'], ['lib_hive', 'c'], ['lib_mind', 'm']] as const
    const k = seedKey([1], { libs, adapter: 'x' })
    expect(seedKey([1], { libs, adapter: 'x' })).toBe(k)
    expect(seedKey([2], { libs, adapter: 'x' })).not.toBe(k)
    expect(seedKey([1], { libs, adapter: 'y' })).not.toBe(k)
    for (const i of [0, 1, 2]) expect(seedKey([1], { libs: libs.map((l, j) => (j === i ? [l[0], l[1] + '!'] : l)) as never, adapter: 'x' })).not.toBe(k)
  })

  it('when the engine cannot start, the commons says so plainly and nothing else computes it', async () => {
    const spy = vi.spyOn(SimCommons, 'start').mockImplementation(() => {
      throw new CommonsEngineError('the MeTTa engine did not start: test')
    })
    try {
      const sim = make()
      expect(sim.commonsError).toMatch(/did not start/)
      // the boot read fails with it, so the boot screen says it (the hive never looks merely empty)
      await expect(sim.getHive()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/did not start: test$/) })
      await expect(sim.listBeliefs('s_lyra')).rejects.toMatchObject({ status: 503, code: 'engine_unavailable', message: expect.stringMatching(/reasoning engine \(MeTTa\) is not running/) })
      await expect(sim.getBeliefDetail('s_lyra', '(--> a b)')).rejects.toMatchObject({ status: 503 })
      expect(() => sim.applyAssertion('s_lyra', 'a_vega01', '(--> a b)', { f: 1, c: 0.5 }, ['ev:a:1'], new Date().toISOString())).toThrow(/not running/)
      expect([...sim.beliefs.values()].every((m) => m.size === 0)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('SimClient', () => {
  it('seeds a believable hive', async () => {
    const sim = make()
    const swarms = await sim.listSwarms()
    const agents = await sim.listAgents()
    expect(swarms.length).toBeGreaterThanOrEqual(2)
    expect(swarms.length).toBeLessThanOrEqual(3)
    expect(agents.length).toBeGreaterThanOrEqual(8)
    // twelve seeded minds, plus the Code team's seven invented request helpers (SimClient seedHelpers)
    expect(agents.length).toBeLessThanOrEqual(21)
    for (const s of swarms) {
      for (const id of s.member_ids) expect(agents.find((a) => a.id === id)?.swarm_id).toBe(s.id)
      expect((await sim.listBeliefs(s.id)).length).toBeGreaterThan(5)
    }
    const hive = await sim.getHive()
    expect(hive.agents).toBe(agents.length)
    expect(hive.spent_usd).toBeGreaterThan(0)
    expect((await sim.getModels()).some((m) => m.local)).toBe(true)
  })

  it('records provenance including a choice', async () => {
    const sim = make()
    const [swarm] = await sim.listSwarms()
    const beliefs = await sim.listBeliefs(swarm.id)
    const details = await Promise.all(beliefs.map((b) => sim.getBeliefDetail(swarm.id, b.statement)))
    expect(details.every((d) => d.assertions.length >= 1 && d.assertions[0].outcome === 'adopted')).toBe(true)
    expect(details.some((d) => d.choices.length > 0)).toBe(true)
  })

  it('applies revision, choice and duplicate outcomes', async () => {
    const sim = make()
    await sim.addVocab('s_lyra', ['lumen', 'glow'])
    const at = new Date().toISOString()
    const a = sim.applyAssertion('s_lyra', 'a_vega01', '(--> lumen glow)', { f: 1, c: 0.5 }, ['ev:x:1'], at)
    expect(a.assertion.outcome).toBe('adopted')
    const b = sim.applyAssertion('s_lyra', 'a_deneb2', '(--> lumen glow)', { f: 0, c: 0.5 }, ['ev:y:1'], at)
    expect(b.assertion.outcome).toBe('revised')
    expect(b.belief?.tv.f).toBeCloseTo(0.5, 2)
    expect(b.belief?.sources).toEqual(['a_vega01', 'a_deneb2'])
    expect(b.belief?.tv).toEqual({ f: 0.5, c: 0.666667 }) // the engine's 0.6666…, read back to 6 places as service.py does
    const c = sim.applyAssertion('s_lyra', 'a_altr03', '(--> lumen glow)', { f: 0.2, c: 0.95 }, ['ev:x:1', 'ev:z:9'], at)
    expect(c.assertion.outcome).toBe('chosen')
    // overlapping and less confident: the engine keeps the current belief
    const d = sim.applyAssertion('s_lyra', 'a_altr03', '(--> lumen glow)', { f: 0.9, c: 0.1 }, ['ev:z:9'], at)
    expect(d.assertion.outcome).toBe('kept')
    expect(d.belief).toBeNull()
    // the same assertion sent again (lib_hive's duplicate: the same agent, statement, truth value and stamp)
    const e = sim.applyAssertion('s_lyra', 'a_altr03', '(--> lumen glow)', { f: 0.2, c: 0.95 }, ['ev:z:9', 'ev:x:1'], at)
    expect(e.assertion.outcome).toBe('duplicate')
    expect(e.belief).toBeNull()
    expect(() => sim.applyAssertion('s_lyra', 'a_altr03', '(--> lumen glow)', { f: 0.2, c: 1 }, ['ev:z:10'], at)).toThrow(/0 < c < 1/)
  })

  it('emits a believable stream of events while running', () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 3, latency: false, historyDays: 1 })
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    sim.connect()
    vi.advanceTimersByTime(120_000)
    sim.disconnect()
    const types = new Set(seen.map((e) => e.type))
    expect(seen[0].type).toBe('hello')
    for (const t of ['belief.published', 'belief.updated', 'agent.thinking', 'usage', 'log', 'agent.updated'])
      expect(types.has(t as HiveEvent['type'])).toBe(true)
  })

  it('replies to chat and bills usage', async () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 5, latency: false, autoStart: false, historyDays: 1 })
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    const before = (await sim.getAgent('a_vega01')).spent_usd
    const sent = await sim.sendMessage('a_vega01', { text: 'What do you believe most?' })
    expect(sent.direction).toBe('in')
    vi.advanceTimersByTime(10_000)
    const reply = seen.find((e) => e.type === 'message' && e.message.direction === 'out')
    expect(reply).toBeDefined()
    expect(seen.some((e) => e.type === 'agent.thinking' && e.phase === 'llm')).toBe(true)
    expect((await sim.getAgent('a_vega01')).spent_usd).toBeGreaterThan(before)
  })

  it('creates a mind that boots to awake and returns a one-time token', async () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 9, latency: false, autoStart: false, historyDays: 1 })
    const created = await sim.createAgent({ name: 'Lumen', kind: 'omega', swarm_id: 's_kelp', model: 'mock/echo', hue: 200 })
    expect(created.token).toMatch(/^hvt_/)
    expect(created.status).toBe('created')
    expect((await sim.getSwarm('s_kelp')).member_ids).toContain(created.id)
    vi.advanceTimersByTime(5000)
    const a = await sim.getAgent(created.id)
    expect(a.status).toBe('awake')
    expect('token' in a).toBe(false)
    await expect(sim.createAgent({ name: 'lumen', kind: 'omega', model: 'mock/echo' })).rejects.toThrow(/exists/)
  })

  it('handles sleep / wake / stop actions', async () => {
    vi.useFakeTimers()
    const sim = new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1 })
    expect((await sim.agentAction('a_vega01', 'sleep')).status).toBe('asleep')
    expect((await sim.agentAction('a_vega01', 'wake')).status).toBe('starting')
    vi.advanceTimersByTime(3000)
    expect((await sim.getAgent('a_vega01')).status).toBe('awake')
    expect((await sim.agentAction('a_vega01', 'stop')).status).toBe('stopped')
  })
})
