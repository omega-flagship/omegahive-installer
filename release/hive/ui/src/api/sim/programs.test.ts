import { describe, expect, it, vi } from 'vitest'
import type { HiveEvent, WorkItem } from '../types'
import { terms } from './programs'
import { SimClient } from './SimClient'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 1844 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 55000 }) // ~3x the worst case measured under load (followups-r5)

const make = () => new SimClient({ seed: 5, latency: false, autoStart: false, historyDays: 1 })
const byId = (items: WorkItem[]) => Object.fromEntries(items.map((i) => [i.id, i]))

describe('sim programs · contract fixture (port of test_programs_api.py)', () => {
  it('lists both built-in programs with describe()', async () => {
    const sim = make()
    const list = await sim.programs()
    expect(list.map((p) => p.id).sort()).toEqual(['commons-explorer', 'contract-fixture', 'omega-tools', 'omegadesign'])
    expect(list.every((p) => p.enabled && p.source === 'built-in' && !p.error)).toBe(true)
    const d = await sim.program('contract-fixture')
    expect(d.describe?.contract).toBe('0.1')
    expect(d.describe?.actions.map((a) => a.id)).toEqual(['inspect-source', 'compare', 'challenge', 'investigate-gap', 'correct'])
  })

  it('question, support, counterevidence, source and correction', async () => {
    const sim = make()
    const swarm = [...sim.swarms.keys()][0]
    const view = await sim.programView('contract-fixture', { swarm_id: swarm })
    expect(view.contract).toBe('0.1')
    expect(view.revision).toBe('r1')
    expect(view.focus).toBe('q1')
    expect(view.stage).toBe('unfold')
    const items = byId(view.items)
    expect(items.c1.uncertainty).toEqual({ method: 'nal', f: 0.8, c: 0.55 })
    expect(items.e3.uncertainty?.method).toBe('qualitative')
    expect(items.q1.status).toBe('current')
    expect(items.e1.sources![0].origin).toBe(items.e2.sources![0].origin)
    expect(new Set(view.links.map((l) => l.rel))).toEqual(new Set(['answers', 'supports', 'contradicts', 'qualifies', 'depends_on']))
    const opened = await sim.programAct('contract-fixture', { swarm_id: swarm, action: 'inspect-source', items: ['e1'], base_revision: 'r1' })
    expect(opened.status).toBe('done')
    expect(opened.detail?.sources?.[0].locator).toBe('p. 4, table 2')
    const asked = await sim.programAct('contract-fixture', { swarm_id: swarm, action: 'correct', items: ['e1'], base_revision: 'r1' })
    expect(asked.status).toBe('needs_input')
    expect(Object.keys(asked.needs!)).toEqual(['text', 'note'])
    const fixed = await sim.programAct('contract-fixture', {
      swarm_id: swarm, action: 'correct', items: ['e1'], base_revision: 'r1',
      params: { text: 'Inspection report lists a 5 t rating, valid until 2025', note: 'expiry date missed' },
    })
    const after = byId(fixed.graph!.items)
    expect(Object.keys(after).sort()).toEqual(Object.keys(items).sort())
    expect(fixed.graph!.revision).toBe('r2')
    expect(fixed.graph!.stage).toBe('detail')
    expect(after.e1.status).toBe('corrected')
    expect(after.e1.revisions![0].revision).toBe('r1')
    expect(after.c1.flags).toContain('affected-by-correction')
    const stale = await sim.programAct('contract-fixture', { swarm_id: swarm, action: 'correct', items: ['e2'], base_revision: 'r1', params: { text: 'x' } })
    expect(stale.status).toBe('stale')
    expect(stale.graph!.revision).toBe('r2')
  })

  it('long actions become swarm goals that can be cancelled', async () => {
    const sim = make()
    const swarm = [...sim.swarms.keys()][0]
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    const out = await sim.programAct('contract-fixture', { swarm_id: swarm, action: 'investigate-gap', items: ['g1'] })
    expect(out.status).toBe('started')
    expect(out.task?.kind).toBe('goal')
    const goal = sim.goals.get(out.task!.id)!
    expect(goal.created_by).toBe('program:contract-fixture')
    expect(seen.some((e) => e.type === 'goal.updated' && e.goal.id === goal.id)).toBe(true)
    expect((await sim.patchGoal(goal.id, { status: 'cancelled' })).status).toBe('cancelled')
  })

  it('disable gives 409, unknown actions 400, and program.updated is emitted', async () => {
    const sim = make()
    const swarm = [...sim.swarms.keys()][0]
    const seen: HiveEvent[] = []
    sim.subscribe((e) => seen.push(e))
    await sim.programDisable('contract-fixture')
    expect(seen.some((e) => e.type === 'program.updated' && !e.program.enabled)).toBe(true)
    await expect(sim.programView('contract-fixture', { swarm_id: swarm })).rejects.toMatchObject({ status: 409, code: 'program_disabled' })
    await sim.programEnable('contract-fixture')
    await expect(sim.programAct('contract-fixture', { swarm_id: swarm, action: 'explode', items: [] })).rejects.toMatchObject({ status: 400 })
  })
})

describe('sim programs · commons explorer (over the sim commons)', () => {
  it('parses terms like hive.spaces.sexpr', () => {
    expect(terms('(--> rr-lyrae variable)')).toEqual(['rr-lyrae', 'variable'])
    expect(terms('(--> (× vega dust) has)')).toEqual(['vega', 'dust', 'has'])
    expect(terms('(((')).toEqual([])
  })

  it('overview, a belief with reports and rivals, source, compare, map and stale', async () => {
    const sim = make()
    const swarm = 's_lyra'
    const overview = await sim.programView('commons-explorer', { swarm_id: swarm })
    expect(overview.focus).toBe('overview')
    const beliefs = overview.items.filter((i) => i.kind === 'belief')
    expect(beliefs.length).toBeGreaterThan(5)
    expect(beliefs.every((b) => b.uncertainty?.method === 'nal')).toBe(true)
    // pick a belief with a rival (same subject) and at least one report
    let picked: string | null = null
    for (const b of beliefs) {
      const v = await sim.programView('commons-explorer', { swarm_id: swarm, focus: b.id, stage: 'unfold' })
      if (v.items.some((i) => i.kind === 'rival') && v.items.some((i) => i.kind === 'report')) {
        picked = b.id
        break
      }
    }
    expect(picked).not.toBeNull()
    const one = await sim.programView('commons-explorer', { swarm_id: swarm, focus: picked, stage: 'unfold' })
    expect(one.links.some((l) => l.rel === 'rivals')).toBe(true)
    const report = one.items.find((i) => i.kind === 'report')!
    const opened = await sim.programAct('commons-explorer', { swarm_id: swarm, action: 'inspect-source', items: [report.id], base_revision: one.revision })
    expect(opened.status).toBe('done')
    expect(opened.detail?.sources?.[0].kind).toBe('dot')
    const rival = one.items.find((i) => i.kind === 'rival')!
    const few = await sim.programAct('commons-explorer', { swarm_id: swarm, action: 'compare', items: [picked!], base_revision: one.revision })
    expect(few.status).toBe('needs_input')
    const compared = await sim.programAct('commons-explorer', { swarm_id: swarm, action: 'compare', items: [picked!, rival.id], base_revision: one.revision })
    expect(compared.status).toBe('done')
    expect(compared.graph!.stage).toBe('compare')
    const mapped = await sim.programView('commons-explorer', { swarm_id: swarm, focus: picked, stage: 'map' })
    expect(mapped.items.length).toBeGreaterThan(1)
    expect(mapped.links.every((l) => l.rel === 'shares-term')).toBe(true)
    // a new publish changes the commons hash, so the old base is stale
    const agent = [...sim.agents.values()].find((a) => a.swarm_id === swarm)!
    expect(sim.applyAssertion(swarm, agent.id, '(--> vega pulsar)', { f: 0.9, c: 0.5 }, ['ev:test:1'], new Date().toISOString()).assertion.outcome).toBe('adopted')
    const stale = await sim.programAct('commons-explorer', { swarm_id: swarm, action: 'challenge', items: [picked!], base_revision: one.revision })
    expect(stale.status).toBe('stale')
    expect(stale.graph!.focus).toBe('overview')
  })
})

describe('sim programs · omega-tools stand-in (guided demos)', () => {
  it('a demo focus reads that demo card alone, a valid graph the guided demos can read', async () => {
    const { readBankedDemo } = await import('../../features/guided/banked')
    const sim = make()
    const swarm = [...sim.swarms.keys()][0]
    const view = await sim.programView('omega-tools', { swarm_id: swarm, focus: 'demo:attention-demo-focus', stage: 'detail' })
    expect(view.items.map((i) => i.id)).toEqual(['demo:attention-demo-focus'])
    expect(view.links).toEqual([])
    expect(readBankedDemo(view.items[0].meta, 'attention-demo-focus')).toMatchObject({ id: 'attention-demo-focus', steps: [{}, {}, {}] })
    const none = await sim.programView('omega-tools', { swarm_id: swarm, focus: 'demo:nope', stage: 'detail' })
    expect([none.items, none.focus]).toEqual([[], null])
    const whole = await sim.programView('omega-tools', { swarm_id: swarm })
    expect(whole.links.length).toBeGreaterThan(0)
  })
})
