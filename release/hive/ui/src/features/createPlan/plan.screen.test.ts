import { describe, expect, it, vi } from 'vitest'
import { ScreensSpace, type ScreenFacts } from '../../screens/screenSpace'
import { SimPlans } from '../../api/sim/planSim'
import { parsePlanView } from './planModel'
import { planFacts, planScreen, type PlanUi } from './planFacts'
import type { PlanView } from './contract'

vi.setConfig({ testTimeout: 30_000 })

/** The Make bench's screens (plan.metta), composed by MeTTa for the facts that matter. Invented data only. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose = (screen: string, facts: ScreenFacts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}
const shown = (screen: string, facts: ScreenFacts) => compose(screen, facts).parts.map((p) => (p.block === 'island' ? String(p.props.name) : `${p.block}:${p.order}`))
const UI: PlanUi = { can: true, starting: false, startError: null, stopAsking: false }
const SENTENCE = 'make me a small web page that shows the weather in London'
function simAt(ms: number, until?: (v: PlanView) => boolean, mode: 'normal' | 'hive' | 'unreviewed' = 'normal') {
  let t = 0
  const s = new SimPlans({ now: () => t, mode: () => mode })
  const id = (s.start(SENTENCE) as { plan_id: string }).plan_id
  let v = parsePlanView(s.get(id))!
  while (t < ms) { t += 250; v = parsePlanView(s.get(id))!; if (until?.(v)) break }
  return { s, id, v, step: (to: number, u?: (x: PlanView) => boolean) => { while (t < to) { t += 250; v = parsePlanView(s.get(id))!; if (u?.(v)) break } return v } }
}

describe('the empty canvas: one sentence', () => {
  it('the field and its line when the hive plans; a plain absence when it does not; a failed start says why', () => {
    expect(planScreen(null)).toBe('plan-start')
    expect(shown('plan-start', planFacts(null, UI).facts)).toEqual(['plan-say', 'note:30'])
    expect(shown('plan-start', planFacts(null, { ...UI, can: false }).facts)).toEqual(['empty:40'])
    expect(shown('plan-start', planFacts(null, { ...UI, startError: 'No answer.' }).facts)).toEqual(['plan-say', 'notice:20', 'note:30'])
  })
})

describe('the plan at work', () => {
  it('while planning: the head with its Stop, the forming plan, the stream, and the place the running page will be', () => {
    const { v } = simAt(0)
    const page = planFacts(v, UI)
    expect(page.screen).toBe('plan')
    expect(shown('plan', page.facts)).toEqual(['plan-head', 'buttons:11', 'plan-forming', 'plan-stream', 'empty:61'])
  })
  it('planned: the question above the board; once the code streams in, the live pair takes the side column', () => {
    const { v, step } = simAt(4000)
    // planned, the tests still being written: nothing built yet, so the place the running page will be
    expect(shown('plan', planFacts(v, UI).facts)).toEqual(['plan-head', 'buttons:11', 'plan-questions', 'plan-board', 'plan-stream', 'empty:61'])
    // the page already holding a file or a verified preview shows the pair whatever the view says
    expect(shown('plan', planFacts(v, { ...UI, showing: true }).facts)).toContain('live-pair')
    const authored = step(10000, (x) => !!x.checkpoint)
    expect(shown('plan', planFacts(authored, UI).facts)).toEqual(['plan-head', 'buttons:11', 'plan-questions', 'plan-board', 'plan-stream', 'live-pair'])
    const plan = compose('plan', planFacts(authored, UI).facts)
    expect(plan.parts.find((p) => p.props.name === 'live-pair')?.place.region).toBe('aside')
    const writing = step(20000, (x) => x.pieces.some((p) => !!p.candidate))
    expect(shown('plan', planFacts(writing, UI).facts)).toContain('live-pair')
  })
  it('the one Stop asks first, inside the page; stopped, it says so and offers a fresh start', () => {
    const { v, s, id } = simAt(4000)
    expect(shown('plan', planFacts(v, { ...UI, stopAsking: true }).facts).slice(0, 2)).toEqual(['plan-head', 'confirm:12'])
    const stopped = parsePlanView(s.stop(id))!
    const facts = planFacts(stopped, UI).facts
    expect(facts.flags!['can.stop']).toBe(false)
    expect(shown('plan', facts)).toEqual(expect.arrayContaining(['notice:20', 'buttons:22']))
    expect(shown('plan', facts)).not.toContain('buttons:11')
  })
  it('blocked: it says what it waits on', () => {
    const { v } = simAt(4000)
    for (const status of ['needs_you', 'engine_error', 'assignee_unavailable']) {
      const page = planFacts({ ...v, status, status_line: 'your answer' }, UI)
      expect(shown('plan', page.facts), status).toContain('notice:21')
      expect(page.data['plan.status']).toBe('your answer')
    }
    expect(shown('plan', planFacts({ ...v, pieces: [], phase: 'stopped', status: 'stopped' }, UI).facts)).not.toContain('plan-forming')
  })
  it('a plan this browser follows, while its view is on its way: the plan, not the empty canvas', () => {
    expect(planFacts(null, { ...UI, opening: true }).screen).toBe('plan')
  })
})

describe('ready to deploy', () => {
  it('the page large, the go, and how it was made beside it; installed: its name, Open, and a fresh start', () => {
    const { v } = simAt(4000)
    const ready: PlanView = { ...v, phase: 'ready-to-deploy', status: 'ready_to_deploy', questions: [] }
    const page = planFacts(ready, UI)
    expect(page.screen).toBe('plan-ready')
    expect(shown('plan-ready', page.facts)).toEqual(['plan-head', 'ready-preview', 'deploy-go', 'plan-stream'])
    expect(shown('plan-ready', planFacts({ ...ready, questions: v.questions }, UI).facts)).toContain('plan-questions')
    const done: PlanView = { ...ready, phase: 'deployed', status: 'deployed', installed: { app_id: 'app_sim_weather', name: 'London weather' } }
    const after = planFacts(done, UI)
    expect(shown('plan-ready', after.facts)).toEqual(['plan-head', 'ready-preview', 'notice:40', 'buttons:41', 'buttons:42', 'plan-stream'])
    expect(after.data['installed.name']).toBe('London weather')
  })
})

describe('the plan screens', () => {
  it('every part of each can be reached', () => {
    for (const screen of ['plan-start', 'plan', 'plan-ready']) {
      const missing = space.orders(screen).filter((o) => !seen.get(screen)?.has(o))
      expect(missing, screen).toEqual([])
    }
  })
  it('the guards stay clean, and every island is one the page offers', () => {
    for (const [name, list] of Object.entries(space.guards())) expect(list, name).toEqual([])
    const placed = new Set(space.islands().filter((x) => x.screen.startsWith('plan')).map((x) => x.name))
    expect([...placed].sort()).toEqual(['deploy-go', 'live-pair', 'plan-board', 'plan-forming', 'plan-head', 'plan-questions', 'plan-say', 'plan-stream', 'ready-preview'])
  })
  it('facts never carry the person’s words', () => {
    const { v } = simAt(4000)
    const { facts } = planFacts(v, { ...UI, startError: 'a person’s words' })
    expect(JSON.stringify(facts)).not.toContain(SENTENCE)
    expect(JSON.stringify(facts)).not.toContain('person’s')
  })
})
