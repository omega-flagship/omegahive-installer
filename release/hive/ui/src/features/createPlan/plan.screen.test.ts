// Purpose: test that MeTTa composes the Make bench's screens (plan.metta) right for the facts that matter, from the
// empty canvas through the plan at work, its deploy, and every later change, version and undo; invented data only.
import { describe, expect, it, vi } from 'vitest'
import { ScreensSpace, type ScreenFacts, type ScreenPlan } from '../../screens/screenSpace'
import { SimPlans } from '../../api/sim/planSim'
import { isHeld, madeApps, openQuestions, parsePlanList, parsePlanView } from './planModel'
import { planFacts as factsFor, planScreen, type PlanUi } from './planFacts'
import type { PlanView } from './contract'

vi.setConfig({ testTimeout: 20_000 })

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
const planFacts = (view: PlanView | null, ui: PlanUi) => factsFor(view, ui, compose)
const names = (plan: ScreenPlan) => plan.parts.map((p) => (p.block === 'island' ? String(p.props.name) : `${p.block}:${p.order}`))
const shown = (screen: string, facts: ScreenFacts) => names(compose(screen, facts))
const openQuestionsOf = (v: PlanView) => openQuestions(v).length
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
/** a sim plan deployed once (its look question answered), with a clock to drive its later rounds to a status */
function deployedSim() {
  let t = 0
  const s = new SimPlans({ now: () => t })
  const id = (s.start(SENTENCE) as { plan_id: string }).plan_id
  const view = () => parsePlanView(s.get(id))!
  const until = (ok: (v: PlanView) => boolean) => { let v = view(); while (!ok(v)) { if (t > 600_000) throw new Error(`never reached: ${v.status}`); t += 250; v = view() } return v }
  until((v) => v.questions.length > 0)
  s.answer(id, 'q_look', 'Calm and minimal')
  until((v) => v.status === 'ready_to_deploy')
  s.deploy(id)
  const deployed = until((v) => v.status === 'deployed')
  /** a change asked, built to its go, and deployed */
  const change = (words: string) => {
    s.revise(id, words)
    until((v) => v.status === 'ready_to_deploy')
    s.deploy(id)
    return until((v) => v.status === 'deployed')
  }
  return { s, id, view, until, deployed, change }
}
/** each version row as MeTTa composed it: its parts, and the data it draws */
const rowsOf = (page: ReturnType<typeof planFacts>) =>
  (page.data['revisions.rows'] as { id: string; plan: ScreenPlan; data: Record<string, unknown> }[]).map((r) => ({ id: r.id, parts: names(r.plan), data: r.data }))

describe('the empty canvas: one sentence', () => {
  it('the field and its line when the hive plans; a plain absence when it does not; a failed start says why', () => {
    expect(planScreen(null)).toBe('plan-start')
    expect(shown('plan-start', planFacts(null, UI).facts)).toEqual(['plan-say', 'note:30'])
    expect(shown('plan-start', planFacts(null, { ...UI, can: false }).facts)).toEqual(['empty:40'])
    expect(shown('plan-start', planFacts(null, { ...UI, startError: 'No answer.' }).facts)).toEqual(['plan-say', 'notice:20', 'note:30'])
  })
  it('a build left held (Make something else): one line names the most recent and opens it; its words only in data', () => {
    const page = planFacts(null, { ...UI, held: { sentence: 'a tip calculator' } })
    expect(shown('plan-start', page.facts)).toEqual(['plan-say', 'note:15', 'buttons:16', 'note:30'])
    expect(page.data['held.sentence']).toBe('a tip calculator')
    expect(JSON.stringify(page.facts)).not.toContain('tip calculator')
    const open = JSON.stringify(compose('plan-start', page.facts).parts.find((x) => x.order === 16)?.props)
    expect(open).toContain('Open it')
    expect(open).toContain('open-held')
    expect(shown('plan-start', planFacts(null, { ...UI, held: null }).facts)).toEqual(['plan-say', 'note:30'])
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
  it('held (waiting on the person or the hive, as the empty canvas names it): make something else meanwhile; not while it works, never once stopped', () => {
    const { v } = simAt(4000)
    const leave = ['note:25', 'buttons:26']
    for (const status of ['needs_you', 'asking_you', 'engine_error', 'assignee_unavailable']) {
      const held: PlanView = { ...v, status }
      expect(isHeld(held), status).toBe(true)
      expect(shown('plan', planFacts(held, UI).facts), status).toEqual(expect.arrayContaining(leave))
    }
    // the look question open while the engine still plans: answered here, not left (the canvas would not name it)
    expect(openQuestionsOf(v)).toBeGreaterThan(0)
    expect(isHeld(v)).toBe(false)
    expect(shown('plan', planFacts(v, UI).facts)).not.toContain('buttons:26')
    const asking: PlanView = { ...v, status: 'asking_you' }
    const press = JSON.stringify(compose('plan', planFacts(asking, UI).facts).parts.find((x) => x.order === 26)?.props)
    expect(press).toContain('Make something else')
    expect(press).toContain('fresh')
    const moving: PlanView = { ...v, status: 'building', questions: [] }
    expect(shown('plan', planFacts(moving, UI).facts)).not.toContain('buttons:26')
    const stopped: PlanView = { ...v, phase: 'stopped', status: 'stopped' }
    expect(shown('plan', planFacts(stopped, UI).facts)).not.toContain('buttons:26')
    expect(shown('plan', planFacts(stopped, UI).facts)).toContain('buttons:22')
  })
  it('a mind it waits on is refused for spending: it says which, in the hive\'s words, and offers the limits', () => {
    // a test hive with a 1 USD month limit held the planner 30 minutes with nothing said
    const { v } = simAt(4000)
    const waiting = { name: 'Planner', message: 'A spending limit has no room for this call.' }
    const page = planFacts({ ...v, waiting }, UI)
    expect(shown('plan', page.facts)).toEqual(expect.arrayContaining(['notice:23', 'buttons:24']))
    expect(page.data['waiting.name']).toBe('Planner')
    expect(page.data['waiting.message']).toBe('A spending limit has no room for this call.')
    const press = JSON.stringify(compose('plan', page.facts).parts.find((x) => x.order === 24)?.props)
    expect(press).toContain('See limits')
    expect(press).toContain('open-limits')
    expect(shown('plan', planFacts({ ...v, waiting: null }, UI).facts)).not.toContain('notice:23')
    expect(shown('plan', planFacts({ ...v, waiting, phase: 'stopped', status: 'stopped' }, UI).facts)).not.toContain('notice:23')
  })
  it('a plan this browser follows, while its view is on its way: the plan, not the empty canvas', () => {
    expect(planFacts(null, { ...UI, opening: true }).screen).toBe('plan')
  })
})

describe('ready to deploy', () => {
  it('the page large, the go with where a change goes after it, and how it was made beside it; installed: its name, Open, and a fresh start', () => {
    const { v } = simAt(4000)
    const ready: PlanView = { ...v, phase: 'ready-to-deploy', status: 'ready_to_deploy', questions: [] }
    const page = planFacts(ready, UI)
    expect(page.screen).toBe('plan-ready')
    expect(shown('plan-ready', page.facts)).toEqual(['plan-head', 'ready-preview', 'deploy-go', 'note:31', 'plan-stream'])
    expect(shown('plan-ready', planFacts({ ...ready, questions: v.questions }, UI).facts)).toContain('plan-questions')
    // a hive from before rounds says nothing of changes beside its go
    const noRounds: PlanView = { ...ready, actions: ready.actions.filter((a) => !['revise', 'undo', 'revert'].includes(a.name)) }
    expect(shown('plan-ready', planFacts(noRounds, UI).facts)).toEqual(['plan-head', 'ready-preview', 'deploy-go', 'plan-stream'])
    // a hive from before rounds (no revise, undo or revert action): the installed row alone, no change box
    const done: PlanView = {
      ...ready, phase: 'deployed', status: 'deployed', installed: { app_id: 'app_sim_weather', name: 'London weather' },
      actions: ready.actions.filter((a) => !['revise', 'undo', 'revert'].includes(a.name)),
    }
    const after = planFacts(done, UI)
    expect(shown('plan-ready', after.facts)).toEqual(['plan-head', 'ready-preview', 'notice:40', 'buttons:41', 'buttons:42', 'plan-stream'])
    expect(after.data['installed.name']).toBe('London weather')
  })
})

describe('changing it in place: a later round on the same plan', () => {
  it('deployed once: the change box under the installed app, its button held until there are words; no versions yet', () => {
    const { deployed } = deployedSim()
    const page = planFacts(deployed, UI)
    expect(page.screen).toBe('plan-ready')
    expect(shown('plan-ready', page.facts)).toEqual(['plan-head', 'ready-preview', 'notice:40', 'buttons:41', 'buttons:42', 'plan-stream', 'section:60', 'fields:61', 'actions:62'])
    expect(page.data['revise.held']).toBe(true)
    const typed = planFacts(deployed, { ...UI, words: 'make it blue' })
    expect(typed.data['revise.words']).toBe('make it blue')
    expect(typed.data['revise.held']).toBe(false)
    // on its way: the button and the field wait
    const sent = planFacts(deployed, { ...UI, words: 'make it blue', revising: true })
    expect(sent.data['revise.held']).toBe(true)
    expect(sent.data['revise.busy']).toBe(true)
    expect(rowsOf(page)).toHaveLength(1)
  })
  it('a change at work: the plan screen with its Stop, saying which change, while the app stays as it was', () => {
    const { s, id } = deployedSim()
    const v = parsePlanView(s.revise(id, 'make it blue'))!
    expect(v).toMatchObject({ round: 2, round_words: 'make it blue', status: 'planning' })
    expect(v.installed).not.toBeNull()
    const page = planFacts(v, UI)
    expect(page.screen).toBe('plan')
    expect(page.facts.flags!['plan.changing']).toBe(true)
    expect(page.facts.flags!['can.stop']).toBe(true)
    // nothing of this round built yet and no page in hand: the place its running page will be
    expect(shown('plan', page.facts)).toEqual(['plan-head', 'buttons:11', 'notice:13', 'note:14', 'plan-forming', 'plan-stream', 'empty:61'])
    // the bench still holding the app's page from before: it runs beside the work
    expect(shown('plan', planFacts(v, { ...UI, showing: true }).facts)).toContain('live-pair')
    expect(page.data['round.words']).toBe('“make it blue”')
  })
  it('a change ready for its go: the go and what it changes, not the installed row or the change box', () => {
    const { s, id, until } = deployedSim()
    s.revise(id, 'make it blue')
    const ready = until((v) => v.status === 'ready_to_deploy')
    const page = planFacts(ready, UI)
    expect(page.screen).toBe('plan-ready')
    expect(shown('plan-ready', page.facts)).toEqual(['plan-head', 'ready-preview', 'notice:25', 'deploy-go', 'plan-stream'])
  })
  it('two versions: the list with the one in the person’s Apps marked, Undo to the one it was made from, Put back on the other', () => {
    const { change } = deployedSim()
    const v = change('make it blue')
    expect(v.revisions.map((r) => [r.round, r.words, r.current, r.from])).toEqual([[1, SENTENCE, false, null], [2, 'make it blue', true, 1]])
    const page = planFacts(v, UI)
    expect(shown('plan-ready', page.facts)).toEqual(['plan-head', 'ready-preview', 'notice:40', 'buttons:41', 'buttons:42', 'plan-stream', 'section:60', 'fields:61', 'actions:62', 'section:70', 'buttons:71', 'stack:72'])
    expect(page.data['revisions.current']).toBe('r2')
    expect(page.data['undo.round']).toBe(1)
    const rows = rowsOf(page)
    expect(rows.map((r) => [r.id, r.parts])).toEqual([['r1', ['line:11', 'buttons:20']], ['r2', ['line:10']]])
    expect(rows[1].data['rev.title']).toBe('“make it blue”')
    expect(String(rows[1].data['rev.meta'])).toMatch(/^Version 2 · deployed (\d{1,2} \w+|\w+ \d{1,2}), \S/)
    const undo = JSON.stringify(compose('plan-ready', page.facts).parts.find((p) => p.order === 71)?.props)
    expect(undo).toContain('Undo the last change')
  })
  it('undone: the first version is the app again, nothing earlier to undo to, and the change can be put back', () => {
    const { s, id, change } = deployedSim()
    change('make it blue')
    const v = parsePlanView(s.revert(id, 1))!
    const page = planFacts(v, UI)
    expect(page.data['revisions.current']).toBe('r1')
    expect(page.facts.flags!['can.undo']).toBe(false)
    expect(shown('plan-ready', page.facts)).toEqual(expect.arrayContaining(['section:70', 'stack:72']))
    expect(shown('plan-ready', page.facts)).not.toContain('buttons:71')
    expect(rowsOf(page).map((r) => [r.id, r.parts])).toEqual([['r1', ['line:10']], ['r2', ['line:11', 'buttons:20']]])
  })
  it('a change made after an undo: Undo goes back to what it was made from, not to the change undone before', () => {
    const { s, id, change } = deployedSim()
    change('make it blue')
    s.revert(id, 1)
    const v = change('make the cells bigger')
    expect(v.revisions.map((r) => [r.round, r.current, r.from])).toEqual([[1, false, null], [2, false, 1], [3, true, 1]])
    const page = planFacts(v, UI)
    expect(page.data['undo.round']).toBe(1)
    expect(rowsOf(page)[2].data['rev.meta']).toMatch(/· made from version 1$/)
  })
  it('a change stopped: the installed app at its version, saying the change stopped, ready for another', () => {
    const { s, id } = deployedSim()
    s.revise(id, 'make it blue')
    const v = parsePlanView(s.stop(id))!
    const page = planFacts(v, UI)
    expect(page.screen).toBe('plan-ready')
    expect(page.facts.flags!['plan.changing']).toBe(false)
    expect(shown('plan-ready', page.facts)).toEqual(['plan-head', 'ready-preview', 'notice:26', 'notice:40', 'buttons:41', 'buttons:42', 'plan-stream', 'section:60', 'fields:61', 'actions:62'])
  })
  it('a change the hive can’t take now: the box stays, its button held, with the hive’s reason', () => {
    const { deployed } = deployedSim()
    const held: PlanView = { ...deployed, actions: deployed.actions.map((a) => (a.name === 'revise' ? { ...a, available: false, why_not: 'Changing apps is off on this hive.' } : a)) }
    const page = planFacts(held, { ...UI, words: 'make it blue' })
    expect(shown('plan-ready', page.facts)).toEqual(expect.arrayContaining(['actions:62', 'note:63']))
    expect(page.data['revise.held']).toBe(true)
    expect(page.data['revise.why_not']).toBe('Changing apps is off on this hive.')
    // a hive from before rounds: no revise action, no change box
    const older = planFacts({ ...deployed, actions: deployed.actions.filter((a) => !['revise', 'undo', 'revert'].includes(a.name)) }, UI)
    expect(shown('plan-ready', older.facts)).not.toContain('section:60')
  })
  it('back on the empty canvas: the apps the person made, newest first, each one opened to change it', () => {
    const { s, id } = deployedSim()
    s.start('a second thing')
    const made = madeApps(parsePlanList(s.list()))
    expect(made.map((p) => p.plan_id)).toEqual([id])
    const page = planFacts(null, { ...UI, made })
    expect(shown('plan-start', page.facts)).toEqual(['plan-say', 'note:30', 'section:50', 'stack:51'])
    const rows = (page.data['made.rows'] as { id: string; plan: ScreenPlan; data: Record<string, unknown> }[])
    expect(rows.map((r) => [r.id, names(r.plan)])).toEqual([[id, ['line:10', 'buttons:20']]])
    expect(rows[0].data['made.title']).toBe('London weather')                 // the app's name, as its view gives it
    expect(String(rows[0].data['made.meta'])).toMatch(/^Last changed (\d{1,2} \w+|\w+ \d{1,2}), \S/)
    // a hive that sends no name: the sentence the app began from, quoted
    const unnamed = planFacts(null, { ...UI, made: [{ ...made[0], title: null }] }).data['made.rows'] as { data: Record<string, unknown> }[]
    expect(unnamed[0].data['made.title']).toBe(`“${SENTENCE}”`)
    // none made, or a hive that doesn't plan: no list
    expect(shown('plan-start', planFacts(null, UI).facts)).toEqual(['plan-say', 'note:30'])
    expect(shown('plan-start', planFacts(null, { ...UI, can: false, made }).facts)).toEqual(['empty:40'])
    // a plan on the bench: the list is the empty canvas's alone
    expect(planFacts(parsePlanView(s.get(id))!, { ...UI, made }).data['made.rows']).toEqual([])
  })
})

describe('the plan screens', () => {
  it('every part of each can be reached', () => {
    for (const screen of ['plan-start', 'plan', 'plan-ready', 'plan-revision', 'plan-made']) {
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
    const { s, id } = deployedSim()
    const changing = planFacts(parsePlanView(s.revise(id, 'make it blue'))!, { ...UI, words: 'and bigger' })
    expect(JSON.stringify(changing.facts)).not.toMatch(/make it blue|and bigger/)
  })
})
