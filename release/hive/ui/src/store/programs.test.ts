import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HiveEvent, Program, WorkGraph } from '../api/types'
import { SimClient } from '../api/sim/SimClient'
import {
  actionsFor,
  applyResult,
  backStep,
  currentStep,
  jumpTo,
  newSession,
  pushStep,
  receiveView,
  reconcile,
  sessionKey,
  type TrailStep,
} from './programSession'
import { emptyData, reduce } from './reducer'
import { useHive } from './store'

const graph = (p: Partial<WorkGraph> = {}): WorkGraph => ({
  revision: 'r1',
  focus: 'q1',
  title: 't',
  suggested_stage: 'unfold',
  items: ['q1', 'c1', 'e1', 'e2'].map((id) => ({ id, kind: id === 'q1' ? 'question' : id === 'c1' ? 'claim' : 'evidence', label: id })),
  links: [],
  groups: [],
  notes: [],
  ...p,
})

describe('program trail and back', () => {
  const a: TrailStep = { stage: 'unfold', focus: 'q1' }
  const b: TrailStep = { stage: 'map', focus: 'c1' }
  const c: TrailStep = { stage: 'detail', focus: 'e1' }

  it('pushes new steps and ignores a repeat of where you are', () => {
    let t = pushStep([a], b)
    t = pushStep(t, b)
    expect(t).toEqual([a, b])
    expect(pushStep(t, { stage: 'compare', focus: 'c1', compare: ['c1', 'h1'] })).toHaveLength(3)
  })

  it('goes back one step and never past the first', () => {
    const t = [a, b, c]
    expect(backStep(t)).toEqual([a, b])
    expect(backStep(backStep(t))).toEqual([a])
    expect(backStep([a])).toEqual([a])
  })

  it('jumps to a breadcrumb and drops what came after', () => {
    expect(jumpTo([a, b, c], 0)).toEqual([a])
    expect(jumpTo([a, b, c], 5)).toEqual([a, b, c])
  })

  it('caps the trail', () => {
    let t: TrailStep[] = [a]
    for (let i = 0; i < 100; i++) t = pushStep(t, { stage: 'map', focus: `x${i}` })
    expect(t.length).toBe(40)
    expect(currentStep({ trail: t }).focus).toBe('x99')
  })
})

describe('program reconciliation', () => {
  it('keeps the focus by id across revisions, and the selection that still exists', () => {
    const s = { ...newSession('p', 's', [{ stage: 'unfold', focus: 'q1' }, { stage: 'detail', focus: 'e1' }]), graph: graph(), selection: ['e1', 'e2'] }
    const next = reconcile(s, graph({ revision: 'r2', items: graph().items.filter((i) => i.id !== 'e2') }))
    expect(currentStep(next).focus).toBe('e1')
    expect(next.trail).toHaveLength(2)
    expect(next.selection).toEqual(['e1'])
  })

  it('settles on the graph focus when the focused id is gone', () => {
    const s = { ...newSession('p', 's', [{ stage: 'detail', focus: 'zz' }]), graph: graph() }
    expect(currentStep(reconcile(s, graph({ revision: 'r2' }))).focus).toBe('q1')
  })

  it('announces a changed revision calmly and turns suggested_stage into a hint, not a jump', () => {
    const s = { ...newSession('p', 's'), graph: graph() }
    const next = receiveView(s, graph({ revision: 'r2', suggested_stage: 'compare' }))
    expect(next.notice?.kind).toBe('revision')
    expect(next.suggestion).toBe('compare')
    expect(currentStep(next).stage).toBe('unfold')
  })

  it('ignores a view that drops the requested focus when nothing changed', () => {
    const s = { ...newSession('p', 's', [{ stage: 'detail', focus: 'e1' }]), graph: graph() }
    const overview = graph({ items: graph().items.filter((i) => i.id !== 'e1') })
    const next = receiveView(s, overview)
    expect(next.graph).toBe(s.graph)
    expect(currentStep(next).focus).toBe('e1')
  })
})

describe('program action results', () => {
  const base = () => ({ ...newSession('p', 's', [{ stage: 'unfold', focus: 'q1' }]), graph: graph() })

  it('stale: replaces the graph, keeps the focus, says the action was not applied, and refreshes', () => {
    const s = { ...base(), trail: [{ stage: 'detail' as const, focus: 'e1' }] }
    const { session, refresh } = applyResult(s, { status: 'stale', message: 'the view changed', graph: graph({ revision: 'r2', focus: 'q1' }) }, { action: 'correct', items: ['e1'], params: {} })
    expect(refresh).toBe(true)
    expect(session.graph?.revision).toBe('r2')
    expect(currentStep(session).focus).toBe('e1')
    expect(session.notice?.kind).toBe('stale')
    expect(session.notice?.title).toMatch(/not applied/)
    expect(session.notice?.body).toMatch(/r1 to r2/)
  })

  it('done with a graph from the person’s own action moves to its stage; the trail survives', () => {
    const { session } = applyResult(base(), { status: 'done', graph: graph({ revision: 'r2', focus: 'e1', suggested_stage: 'detail' }), message: 'corrected e1' }, { action: 'correct', items: ['e1'], params: { text: 'x' } })
    expect(session.trail.map((t) => `${t.stage}:${t.focus}`)).toEqual(['unfold:q1', 'detail:e1'])
    expect(session.notice?.body).toBe('corrected e1')
  })

  it('compare from a selection keeps the chosen items in the step', () => {
    const { session } = applyResult(base(), { status: 'done', graph: graph({ focus: 'c1', suggested_stage: 'compare' }) }, { action: 'compare', items: ['c1', 'e1'], params: {} })
    expect(currentStep(session)).toEqual({ stage: 'compare', focus: 'c1', compare: ['c1', 'e1'] })
  })

  it('needs_input opens a form from the result’s needs, described by the action params', () => {
    const def = { id: 'correct', label: 'Correct', params: { text: 'the corrected wording', note: 'why it changed' } }
    const { session } = applyResult(base(), { status: 'needs_input', needs: { text: '' }, message: 'say what' }, { action: 'correct', items: ['e1'], params: {}, def })
    expect(session.input?.needs).toEqual({ text: 'the corrected wording' })
    expect(session.input?.items).toEqual(['e1'])
  })

  it('started records a task; refused and error show the message', () => {
    const started = applyResult(base(), { status: 'started', task: { id: 'g_1', kind: 'goal', status: 'open' }, message: 'posted' }, { action: 'challenge', items: ['c1'], params: {} })
    expect(started.session.tasks[0]).toMatchObject({ id: 'g_1', status: 'open', action: 'challenge' })
    expect(applyResult(base(), { status: 'refused', message: 'no' }, { action: 'x', items: [], params: {} }).session.notice?.body).toBe('no')
    expect(applyResult(base(), { status: 'error', message: 'boom' }, { action: 'x', items: [], params: {} }).session.notice?.tone).toBe('bad')
  })

  it('filters actions by every selected kind', () => {
    const acts = [{ id: 'a', applies_to: ['evidence'] }, { id: 'b', applies_to: ['claim', 'evidence'] }, { id: 'c' }]
    expect(actionsFor(acts, ['evidence']).map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(actionsFor(acts, ['evidence', 'claim']).map((a) => a.id)).toEqual(['b', 'c'])
    expect(actionsFor(acts, [])).toEqual([])
  })
})

describe('reduce · program.updated', () => {
  it('replaces the program by id and stays pure', () => {
    const p: Program = { id: 'x', name: 'X', version: '1', description: '', icon: 'spark', capabilities: [], source: 'built-in', enabled: true, error: null }
    const s0 = { ...emptyData(), programs: [p] }
    const e: HiveEvent = { type: 'program.updated', at: '', program: { ...p, enabled: false } }
    const s1 = reduce(s0, e)
    expect(s1.programs![0].enabled).toBe(false)
    expect(s0.programs![0].enabled).toBe(true)
    expect(reduce(emptyData(), e).programs).toHaveLength(1)
  })
})

describe('store · program session against the sim', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { location: { search: '' } })
  })
  afterEach(() => {
    useHive.getState().client?.disconnect()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens, navigates, corrects, reconciles a stale action and keeps the trail across visits', async () => {
    const sim = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 1 })
    await useHive.getState().init(sim)
    const swarm = Object.keys(useHive.getState().swarms)[0]
    const key = sessionKey('contract-fixture', swarm)
    expect(useHive.getState().programs?.length).toBe(4)   // contract fixture, commons explorer, Design (invented designs), Omega Tools stand-in (invented)
    await useHive.getState().openProgram('contract-fixture', swarm)
    await vi.runAllTimersAsync()
    let s = useHive.getState().programSessions[key]
    expect(s.graph?.revision).toBe('r1')
    expect(currentStep(s).focus).toBe('q1')
    useHive.getState().programGo(key, { stage: 'detail', focus: 'e1' })
    await vi.runAllTimersAsync()
    // needs_input, then the retry with params
    await useHive.getState().programAct(key, 'correct', ['e1'])
    expect(useHive.getState().programSessions[key].input?.needs.text).toBe('the corrected wording')
    await useHive.getState().programAct(key, 'correct', ['e1'], { text: 'Valid until 2025', note: 'expiry missed' })
    s = useHive.getState().programSessions[key]
    expect(s.graph?.revision).toBe('r2')
    expect(s.input).toBeNull()
    expect(s.trail.map((t) => t.focus)).toEqual(['q1', 'e1'])
    // another client corrects behind our back: our next action is stale and reconciles
    await sim.programAct('contract-fixture', { swarm_id: swarm, action: 'correct', items: ['e2'], base_revision: 'r2', params: { text: 'elsewhere' } })
    await useHive.getState().programAct(key, 'correct', ['e1'], { text: 'again' })
    await vi.runAllTimersAsync()
    s = useHive.getState().programSessions[key]
    expect(s.notice?.kind).toBe('stale')
    expect(s.graph?.revision).toBe('r3')
    expect(currentStep(s).focus).toBe('e1')
    expect(s.graph?.items.find((i) => i.id === 'e1')?.label).toBe('Valid until 2025')
    // back, then return: the session (and its trail) is restored
    expect(useHive.getState().programBack(key)).toBe(true)
    expect(useHive.getState().programBack(key)).toBe(false)
    useHive.getState().programGo(key, { stage: 'map', focus: 'c1' })
    await useHive.getState().openProgram('contract-fixture', swarm)
    expect(useHive.getState().programSessions[key].trail.map((t) => t.stage)).toEqual(['unfold', 'map'])
  })

  it('started actions follow the goal and can cancel it', async () => {
    const sim = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 1 })
    await useHive.getState().init(sim)
    const swarm = Object.keys(useHive.getState().swarms)[0]
    const key = sessionKey('contract-fixture', swarm)
    await useHive.getState().openProgram('contract-fixture', swarm)
    await useHive.getState().programAct(key, 'investigate-gap', ['g1'])
    const task = useHive.getState().programSessions[key].tasks[0]
    expect(task.status).toBe('open')
    expect(useHive.getState().goals[task.id]?.created_by).toBe('program:contract-fixture')
    await useHive.getState().programCancelTask(key, task.id)
    expect(useHive.getState().goals[task.id].status).toBe('cancelled')
  })
})

describe('program routes', async () => {
  const { parse, href } = await import('../lib/router')
  it('round-trips the index, a program, a program in a swarm, and a mind hosting one', () => {
    for (const r of [{ name: 'programs' }, { name: 'program', id: 'contract-fixture' }, { name: 'program', id: 'commons-explorer', swarm: 's_lyra' }, { name: 'dot', id: 'a_vega01', program: 'commons-explorer' }] as const) {
      expect(parse(href(r))).toEqual({ swarm: undefined, ...r })
    }
    expect(parse('#/program')).toEqual({ name: 'programs' })
  })
})
