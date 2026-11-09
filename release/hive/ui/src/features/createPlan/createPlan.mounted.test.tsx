// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store, the client and the look */
/**
 * The Make bench mounted on the MiniDOM: the board draws any number of assignee lanes (one specialist, teams, five mixed,
 * a whole hive still being found that resolves to a mind), a question is answered inline and settles, the running page
 * re-renders at each checkpoint with its receipt, the deploy go (available, held with its reason, unreviewed), reduced
 * motion, and the whole page from one sentence through MeTTa's screens. Driven by the plan sim on a manual clock;
 * invented data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { SimPlans, SIM_PLAN_MINDS } from '../../api/sim/planSim'
import { currentFile, fileKey, fileWant, parsePlanView, parsePreviewFiles, type FileTexts } from './planModel'
import type { Assignee, PlanView } from './contract'

vi.setConfig({ testTimeout: 30_000 })

const T = vi.hoisted(() => ({ reduced: false, client: null as any, listeners: new Set<(e: unknown) => void>(), navigate: vi.fn() }))
vi.mock('../../store/store', () => {
  const state = () => ({ client: T.client, session: null, inits: 0, agents: {}, toast: () => undefined })
  const useHive = Object.assign((select: (s: any) => unknown) => select(state()), { getState: state, subscribe: () => () => undefined, setState: () => undefined })
  return { useHive, hiveBus: { on: (fn: (e: unknown) => void) => { T.listeners.add(fn); return () => { T.listeners.delete(fn) } } } }
})
vi.mock('../../lib/hooks', () => ({ useReducedMotion: () => T.reduced, useMediaQuery: () => false, useEscape: () => undefined, isTypingTarget: () => false }))
vi.mock('../../shell/uiVariant', () => ({ useLook: () => ({ current: null }) }))
vi.mock('../../lib/router', () => ({ navigate: T.navigate }))
vi.mock('../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../code/Editor', () => ({ Editor: (p: { path: string; content: string; layers?: { presence?: { caret?: unknown } } }) =>
  <pre data-editor={p.path} data-caret={p.layers?.presence?.caret ? 'yes' : undefined}>{p.content}</pre> }))
import { PlanBoard } from './PlanBoard'
import { QuestionCards } from './QuestionCards'
import { LivePair } from './LivePair'
import { DeployGo } from './ReadyToDeploy'
import PlanCanvas from './PlanCanvas'
import { forgetPlan } from './usePlan'

const SENTENCE = 'make me a small web page that shows the weather in London'
function sim(mode: 'normal' | 'hive' | 'unreviewed' = 'normal') {
  let t = 0
  const s = new SimPlans({ now: () => t, mode: () => mode })
  const id = (s.start(SENTENCE) as { plan_id: string }).plan_id
  const view = () => parsePlanView(s.get(id), (m) => SIM_PLAN_MINDS[m] ?? null)!
  const run = (to: number, until?: (v: PlanView) => boolean) => { let v = view(); while (t < to) { t += 250; v = view(); if (until?.(v)) break } return v }
  /** the code pane's file through the files route, as usePlan reads it */
  const code = (v: PlanView) => {
    const texts: Record<string, string | null> = {}
    for (let w = fileWant(v, texts); w; w = fileWant(v, texts as FileTexts)) {
      try { texts[fileKey(w.ckpt, w.path)] = (s.file(id, w.path, w.ckpt) as { content: string }).content } catch { texts[fileKey(w.ckpt, w.path)] = null }
    }
    return currentFile(v, texts)
  }
  /** the running page through the preview route */
  const frame = () => parsePreviewFiles(s.preview(id))!
  return { s, id, view, run, code, frame, now: () => t }
}
const who = (kind: string, ref: string | null, display: string, resolved = true): Assignee => ({ selector: null, kind, ref, resolved, display, detail: null, taken_by: null })

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const render = async (el: React.ReactElement) => { await act(async () => root.render(el)); await act(async () => { await Promise.resolve() }) }
const all = (pick: (n: MiniNode) => boolean) => host.findAll(pick)
const byClass = (c: string) => all((n) => (n.getAttribute('class') ?? '').split(' ').includes(c))
const button = (name: string) => all((n) => n.tagName === 'BUTTON' && n.textContent === name)[0]

beforeEach(async () => {
  const g = globalThis as any
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout, innerWidth: 1400, innerHeight: 900, getComputedStyle: () => ({ getPropertyValue: () => '' }) }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0); g.cancelAnimationFrame = clearTimeout
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
  T.reduced = false; T.client = null; T.navigate.mockReset()
  forgetPlan()
})
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
/** a client over the sim, as SimClient and live.ts carry it */
function clientOf(s: SimPlans, calls: string[] = []) {
  return {
    createPlanStart: async (x: string) => { calls.push('start'); return s.start(x) },
    createPlans: async () => { calls.push('list'); return s.list() },
    createPlan: async (id: string) => s.get(id),
    createPlanPreview: async (id: string) => { calls.push('preview'); return s.preview(id) },
    createPlanFile: async (id: string, path: string, ckpt: string) => { calls.push(`file ${path}@${ckpt}`); return s.file(id, path, ckpt) },
    createPlanAnswer: async (id: string, q: string, text: string) => { calls.push(`answer ${q} ${text}`); return s.answer(id, q, text) },
    createPlanDeploy: async (id: string) => s.deploy(id),
    createPlanStop: async (id: string) => { calls.push('stop'); return s.stop(id) },
  }
}
afterEach(async () => {
  await act(async () => root.unmount())
  host.parentNode?.removeChild(host)
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v
  vi.useRealTimers()
})

const lanes = () => all((n) => n.tagName === 'SECTION' && (n.getAttribute('class') ?? '') === 'pb-lane').map((n) => n.findAll((x) => (x.getAttribute('class') ?? '') === 'pb-lane-name')[0].textContent)
const orbForms = () => byClass('pb-orb').map((n) => n.getAttribute('data-form'))
const withAssignees = (v: PlanView, as: Assignee[]): PlanView => ({ ...v, pieces: v.pieces.map((p, i) => ({ ...p, assignee: as[i % as.length] })) })

describe('the board: any number of assignees', () => {
  it('the sim plan: Studio, Code and a specialist mind, four cards, threads named on the cards', async () => {
    const v = sim().run(4000)
    await render(<PlanBoard view={v} reduced={false} />)
    expect(lanes()).toEqual(['Studio', 'Code', 'Iris (illustrator)'])
    expect(orbForms()).toEqual(['team', 'team', 'mind'])
    expect(all((n) => n.tagName === 'LI' && n.hasAttribute('data-piece'))).toHaveLength(4)
    expect(all((n) => n.getAttribute('data-piece') === 'look')[0].getAttribute('data-phase')).toBe('held')
    expect(byClass('pb-after').length).toBeGreaterThan(0)
    expect(host.textContent).not.toMatch(/a_sim_|plan_sim_/)
  })
  it('one lane (a single specialist), and five mixed lanes', async () => {
    const v = sim().run(4000)
    const iris = who('mind', 'a_iris', 'Iris (illustrator)')
    await render(<PlanBoard view={withAssignees(v, [iris])} reduced={false} />)
    expect(lanes()).toEqual(['Iris (illustrator)'])
    expect(all((n) => n.getAttribute('data-lanes') === '1')).toHaveLength(1)
    const five: Assignee[] = [
      who('team', 'studio', 'Studio'), who('team', 'code', 'Code'), iris,
      who('capability', 'cartography', 'Any mapmaker'), who('hive', 'h_driftwood', 'Driftwood hive'),
    ]
    const v5: PlanView = { ...v, pieces: [...v.pieces, { ...v.pieces[3], id: 'extra', title: 'Another piece', deps: [] }] }
    await render(<PlanBoard view={withAssignees(v5, five)} reduced={false} />)
    expect(lanes()).toEqual(['Studio', 'Code', 'Iris (illustrator)', 'Any mapmaker', 'Driftwood hive'])
    expect(orbForms()).toEqual(['team', 'team', 'mind', 'team', 'hive'])
    expect(host.textContent).toContain('any able mind')
  })
  it('the whole hive, still being found: a soft open orb that resolves to a mind’s orb', async () => {
    const m = sim('hive')
    const open = m.run(4000)
    await render(<PlanBoard view={open} reduced={false} />)
    const hiveLane = lanes().findIndex((n) => n === 'the whole hive')
    expect(hiveLane).toBeGreaterThanOrEqual(0)
    expect(orbForms()[hiveLane]).toBe('open')
    expect(host.textContent).toContain('finding who takes it…')
    const resolved = m.run(60000, (v) => v.pieces.some((p) => p.assignee.kind === 'mind' && p.assignee.display.startsWith('Quill')))
    await render(<PlanBoard view={resolved} reduced={false} />)
    expect(lanes()).toContain('Quill (from the hive)')
    expect(orbForms()).not.toContain('open')
  })
  it('reduced motion: an active lane’s orb is still; with motion it breathes', async () => {
    const v = sim().run(20000, (x) => x.pieces.some((p) => p.state === 'started' && p.builder))
    await render(<PlanBoard view={v} reduced={false} />)
    expect(byClass('pb-orb-live').length).toBeGreaterThan(0)
    await render(<PlanBoard view={v} reduced />)
    expect(byClass('pb-orb-live')).toHaveLength(0)
    expect(byClass('pb-dot-live')).toHaveLength(0)
    expect(all((n) => n.getAttribute('data-active') === 'true').length).toBeGreaterThan(0)
  })
})

describe('questions: answered inline, never blocking', () => {
  it('a suggested answer or the person’s own words; answered, it settles into “You said”', async () => {
    const m = sim()
    const v = m.run(4000)
    const onAnswer = vi.fn()
    await render(<QuestionCards view={v} answering={null} onAnswer={onAnswer} />)
    expect(host.textContent).toContain('Should it look calm and minimal, or bright and playful?')
    expect(host.textContent).toContain('Only that waits; the rest goes on.')
    await act(async () => press(button('Calm and minimal')))
    expect(onAnswer).toHaveBeenCalledWith('q_look', 'Calm and minimal')
    // own words: typed, then Enter (the composing guard lets a plain Enter through)
    const input = all((n) => n.tagName === 'INPUT')[0]
    await act(async () => (reactProps(input).onChange as (e: unknown) => void)({ target: { value: 'Soft blues, please' } }))
    await act(async () => (reactProps(input).onKeyDown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined, nativeEvent: {}, target: input }))
    expect(onAnswer).toHaveBeenLastCalledWith('q_look', 'Soft blues, please')
    // while it is on its way the card holds
    await render(<QuestionCards view={v} answering="q_look" onAnswer={onAnswer} />)
    expect(button('Calm and minimal').getAttribute('disabled')).not.toBeNull()
    const answered = parsePlanView(m.s.answer(m.id, 'q_look', 'Calm and minimal'))!
    await render(<QuestionCards view={answered} answering={null} onAnswer={onAnswer} />)
    expect(host.textContent).toContain('You said: Calm and minimal')
    expect(all((n) => n.tagName === 'INPUT')).toHaveLength(0)
  })
})

describe('the live pair: the code beside the running page', () => {
  const frames = () => all((n) => n.tagName === 'IFRAME')
  const srcDoc = (f: MiniNode) => String(reactProps(f).srcDoc ?? '')
  it('the file being written (read through the files route) streams in with its writer’s caret', async () => {
    T.reduced = true
    const m = sim()
    const v = m.run(20000, (x) => !!x.pieces.find((p) => p.id === 'logic')?.candidate && x.pieces.find((p) => p.id === 'logic')!.state === 'started')
    const file = m.code(v)!
    expect(file.writing).toBe(true)
    await render(<LivePair view={v} file={file} frame={null} reduced />)
    expect(all((n) => n.getAttribute('data-editor') === file.path)).toHaveLength(1)
    expect(all((n) => n.getAttribute('data-caret') === 'yes')).toHaveLength(1)
    expect(host.textContent).toContain(`${SIM_PLAN_MINDS[v.pieces.find((p) => p.id === file.piece)!.builder!.id].name} is writing`)
    expect(frames()).toHaveLength(0)
    expect(host.textContent).toContain('It runs here once the checks pass and its preview is ready.')
  })
  it('the running page is the preview route’s verified files, in a sandboxed frame', async () => {
    T.reduced = true
    const m = sim()
    m.run(5000); m.s.answer(m.id, 'q_look', 'Calm and minimal')
    const ready = m.run(90000, (x) => x.status === 'ready_to_deploy')
    const frame = m.frame()
    await render(<LivePair view={ready} file={m.code(ready)} frame={frame} reduced />)
    expect(frames().map((f) => f.getAttribute('data-ckpt'))).toEqual([ready.preview!.ckpt])
    expect(frames()[0].getAttribute('sandbox')).toBe('allow-scripts')
    const doc = srcDoc(frames()[0])
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain('°C')
    expect(doc).toContain('data:image/svg+xml')
    expect(byClass('pl-who').map((n) => n.textContent)).toContain('preview')
  })
  it('a remounted pair shows the current page at once (no hidden-until-load fade); only a NEW preview cross-fades', async () => {
    vi.useFakeTimers()
    const m = sim()
    m.run(5000); m.s.answer(m.id, 'q_look', 'Calm and minimal')
    const ready = m.run(90000, (x) => x.status === 'ready_to_deploy')
    const frame = m.frame()
    const shown = () => frames().map((f) => [f.getAttribute('data-ckpt'), f.getAttribute('data-shown'), f.getAttribute('data-instant')])
    await render(<LivePair view={ready} file={null} frame={frame} reduced={false} />)
    expect(shown()).toEqual([[frame.ckpt, 'true', 'true']])
    // the pair goes (another screen) and comes back: the same page is there at once, no timer needed
    await render(<p>elsewhere</p>)
    expect(frames()).toHaveLength(0)
    await render(<LivePair view={ready} file={null} frame={frame} reduced={false} />)
    expect(shown()).toEqual([[frame.ckpt, 'true', 'true']])
    // a newer preview fades in over it, then the older frame is let go
    const next = { ckpt: 'ckpt_9', files: { ...frame.files, 'app.js': frame.files['app.js'] + '\n// newer' } }
    await render(<LivePair view={ready} file={null} frame={next} reduced={false} />)
    expect(shown()).toEqual([[frame.ckpt, 'true', 'true'], ['ckpt_9', null, null]])
    expect(byClass('pl-receipt')[0].textContent).toMatch(/^\+ app\.js · /)
    await act(async () => { vi.advanceTimersByTime(800) })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(shown()).toEqual([['ckpt_9', 'true', null]])
  })
  it('reduced motion: a new preview replaces the last at once, still', async () => {
    const m = sim()
    m.run(5000); m.s.answer(m.id, 'q_look', 'Calm and minimal')
    const ready = m.run(90000, (x) => x.status === 'ready_to_deploy')
    const frame = m.frame()
    await render(<LivePair view={ready} file={null} frame={frame} reduced />)
    await render(<LivePair view={ready} file={null} frame={{ ckpt: 'ckpt_9', files: frame.files }} reduced />)
    expect(frames().map((f) => [f.getAttribute('data-ckpt'), f.getAttribute('data-shown')])).toEqual([['ckpt_9', 'true']])
  })
})

describe('the deploy go', () => {
  const ready = (over: Partial<PlanView> = {}): PlanView => ({ ...sim().run(4000), phase: 'ready-to-deploy', status: 'ready_to_deploy', ...over })
  it('available: one Deploy, the person’s go', async () => {
    const onDeploy = vi.fn()
    await render(<DeployGo view={ready({ actions: [{ name: 'deploy', available: true, why_not: null }] })} busy={false} alert={null} onDeploy={onDeploy} />)
    expect(host.textContent).toContain('Checked and reviewed.')
    await act(async () => press(button('Deploy')))
    expect(onDeploy).toHaveBeenCalledTimes(1)
  })
  it('not available: held, with the reason in plain words', async () => {
    await render(<DeployGo view={ready({ actions: [{ name: 'deploy', available: false, why_not: 'A check is still failing.' }] })} busy={false} alert={null} onDeploy={vi.fn()} />)
    expect(button('Deploy').getAttribute('disabled')).not.toBeNull()
    expect(host.textContent).toContain('A check is still failing.')
  })
  it('unreviewed: it says so plainly before the go', async () => {
    await render(<DeployGo view={ready({ unreviewed: true, actions: [{ name: 'deploy', available: true, why_not: null }] })} busy={false} alert={null} onDeploy={vi.fn()} />)
    expect(host.textContent).toContain('Not reviewed: your setting allowed it to skip review.')
  })
})

describe('the whole bench, composed by MeTTa', () => {
  it('one sentence → the plan; an answer goes to the hive; the Stop asks inside the page', async () => {
    T.reduced = true
    let t = 0
    const s = new SimPlans({ now: () => t, mode: () => 'normal' })
    const calls: string[] = []
    T.client = clientOf(s, calls)
    await render(<PlanCanvas />)
    await flush()
    expect(calls).toEqual(['list'])
    calls.length = 0
    expect(all((n) => n.getAttribute('data-plan-screen') === 'plan-start')).toHaveLength(1)
    expect(host.textContent).toContain('What would you like to make?')
    const field = all((n) => n.tagName === 'INPUT')[0]
    await act(async () => (reactProps(field).onChange as (e: unknown) => void)({ target: { value: SENTENCE } }))
    await act(async () => press(button('Make it')))
    await act(async () => { await Promise.resolve() })
    expect(calls).toEqual(['start'])
    expect(all((n) => n.getAttribute('data-plan-screen') === 'plan')).toHaveLength(1)
    expect(host.textContent).toContain(`“${SENTENCE}”`)
    expect(host.textContent).toContain('Planning the pieces, and who takes each…')
    // the plan forms: an event about it reads it again at once
    t = 4000
    await act(async () => { for (const fn of [...T.listeners]) fn({ type: 'create.plan.status', plan_id: 'plan_sim_1' }); await Promise.resolve(); await Promise.resolve() })
    expect(lanes()).toEqual(['Studio', 'Code', 'Iris (illustrator)'])
    await act(async () => press(button('Bright and playful')))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(calls).toContain('answer q_look Bright and playful')
    expect(host.textContent).toContain('You said: Bright and playful')
    // Stop asks first (MeTTa's confirm part), then goes to the hive
    await act(async () => press(button('Stop')))
    expect(host.textContent).toContain('Stop making this?')
    await act(async () => press(button('Keep going')))
    expect(host.textContent).not.toContain('Stop making this?')
    await act(async () => press(button('Stop')))
    const stops = all((n) => n.tagName === 'BUTTON' && n.textContent === 'Stop')
    await act(async () => press(stops[stops.length - 1]))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(calls).toContain('stop')
    expect(host.textContent).toContain('Stopped.')
    expect(button('Make something else')).toBeTruthy()
  })
  it('the person’s running plan is picked up again instead of the empty sentence; a finished one is not', async () => {
    T.reduced = true
    let t = 0
    const s = new SimPlans({ now: () => t, mode: () => 'normal' })
    s.start('an old thing'); t = 12000
    s.stop('plan_sim_1')
    s.start(SENTENCE)
    t = 30000
    const calls: string[] = []
    T.client = clientOf(s, calls)
    await render(<PlanCanvas />)
    await flush()
    expect(calls[0]).toBe('list')
    expect(all((n) => n.getAttribute('data-plan-screen') === 'plan')).toHaveLength(1)
    expect(host.textContent).toContain(`“${SENTENCE}”`)
    expect(lanes()).toEqual(['Studio', 'Code', 'Iris (illustrator)'])
    // the code pane reads its file through the files route
    expect(calls.some((c) => c.startsWith('file '))).toBe(true)
    await act(async () => root.unmount())
    root = (await import('react-dom/client')).createRoot(host as unknown as Element)
    forgetPlan()
    const done = new SimPlans({ now: () => 99000 })
    done.start('finished'); done.stop('plan_sim_1')
    T.client = clientOf(done)
    await render(<PlanCanvas />)
    await flush()
    expect(all((n) => n.getAttribute('data-plan-screen') === 'plan-start')).toHaveLength(1)
  })
  it('create.plan.preview: the page fetches the verified preview and the running page shows it', async () => {
    T.reduced = true
    let t = 0
    const s = new SimPlans({ now: () => t, mode: () => 'normal' })
    const calls: string[] = []
    T.client = clientOf(s, calls)
    await render(<PlanCanvas />)
    await flush()
    const field = all((n) => n.tagName === 'INPUT')[0]
    await act(async () => (reactProps(field).onChange as (e: unknown) => void)({ target: { value: SENTENCE } }))
    await act(async () => press(button('Make it')))
    await flush()
    t = 5000
    s.answer('plan_sim_1', 'q_look', 'Calm and minimal')
    for (t = 5000; t < 90000; t += 500) s.get('plan_sim_1')
    expect(calls).not.toContain('preview')
    expect(all((n) => n.tagName === 'IFRAME')).toHaveLength(0)
    const pv = s.get('plan_sim_1').preview as { ckpt: string; ref: string }
    await act(async () => { for (const fn of [...T.listeners]) fn({ type: 'create.plan.preview', plan_id: 'plan_sim_1', ckpt: pv.ckpt, preview: pv.ref }) })
    await flush()
    expect(calls.filter((c) => c === 'preview')).toHaveLength(1)
    const frames = all((n) => n.tagName === 'IFRAME')
    expect(frames.map((f) => f.getAttribute('data-ckpt'))).toEqual([pv.ckpt])
    expect(frames[0].getAttribute('data-shown')).toBe('true')
    // a status event reads the view again: ready to deploy, the finished page from the same verified files, no refetch
    await act(async () => { for (const fn of [...T.listeners]) fn({ type: 'create.plan.status', plan_id: 'plan_sim_1', phase: 'ready-to-deploy', status: 'ready_to_deploy', next_action: null }) })
    await flush()
    expect(all((n) => n.getAttribute('data-plan-screen') === 'plan-ready')).toHaveLength(1)
    expect(all((n) => n.tagName === 'IFRAME').map((f) => f.getAttribute('data-ckpt'))).toEqual([pv.ckpt])
    expect(calls.filter((c) => c === 'preview')).toHaveLength(1)
  })
  it('a hive without the plan routes: a plain absence, no field', async () => {
    T.client = {}
    await render(<PlanCanvas />)
    expect(host.textContent).toContain("Making from one sentence isn't on this hive yet")
    expect(all((n) => n.tagName === 'INPUT')).toHaveLength(0)
  })
})
