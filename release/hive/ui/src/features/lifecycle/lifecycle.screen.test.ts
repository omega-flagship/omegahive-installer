import { act, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Goal, Swarm } from '../../api/types'
import { DRAWN_BLOCKS, Screen, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { MiniDocument, reactProps } from '../../ui/miniDom.testkit'
import { COORDINATOR_SKILLS, lifecycleScreen, type Can, type Compose, type LifecycleInput, type StackItem } from './data'
import { LEASE_HINT } from './steps'

vi.setConfig({ testTimeout: 20_000 })

/** The Lifecycle page end to end: an invented swarm and minds → facts → MeTTa composes the page and each skill → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}

const SWARM: Swarm = { id: 's_orchard', name: 'Orchard Guild', description: '', hue: 120, member_ids: ['m_wren', 'm_moss', 'm_fern'], created_at: '2026-01-01T00:00:00Z' }
const mind = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({ id, name, swarm_id: 's_orchard', kind: 'llm', hue: 40, status: 'asleep', ...over }) as Agent
const AGENTS: Record<string, Agent> = {
  m_wren: mind('m_wren', 'Wren'),
  m_moss: mind('m_moss', 'Moss'),
  m_fern: mind('m_fern', 'Fern'),
  m_gate: mind('m_gate', 'Gatehouse', { kind: 'module' }),
  m_away: mind('m_away', 'Elsewhere', { swarm_id: 's_other' }),
}
const goal = (id: string, title: string, assignee: string, status = 'open'): Goal =>
  ({ id, swarm_id: 's_orchard', title, assignee, status, parent_id: null, detail: '', priority: 0.5, created_by: 'user:operator', claimed_by: null, result: null, created_at: '', updated_at: '' }) as Goal
const GOALS = [goal('g_prune', 'Prune the pear row', 'm_moss'), goal('g_done', 'Old harvest', 'm_moss', 'done'), goal('g_fern', 'Count the hives', 'm_fern')]
const CAN: Can = { delegate: true, lease: true, write: true }

const input = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  swarm: SWARM, agents: AGENTS, coordinator: '', chosen: [], current: [], goals: GOALS, member: '', task: '', seconds: 300, budget: 0.1,
  newTask: '', lease: null, allowed: () => false, ...over,
})
function page(i: LifecycleInput = input(), can: Can = CAN, host: Partial<ScreenHost> = {}) {
  const { data, facts } = lifecycleScreen(i, can, compose)
  const plan = compose('lifecycle', facts)
  return { plan, data, facts, orders: plan.parts.map((p) => p.order),
    html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onInput: () => {}, onAction: () => {}, ...host } })) }
}
const COORD = { coordinator: 'm_wren' }
const DELEGATED = { ...COORD, chosen: ['m_moss'], current: ['m_moss'] }

describe('the Lifecycle page, composed by MeTTa', () => {
  it('the fields block is known to MeTTa and drawn by the renderer; the guards stay clean, nothing falls back', () => {
    expect(space.blocks()).toContain('fields')
    expect(DRAWN_BLOCKS).toContain('fields')
    expect(space.screens()).toEqual(expect.arrayContaining(['lifecycle', 'lifecycle-skill']))
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(space.explain('lifecycle', 21)).toMatchObject({ declared: { kind: 'block', name: 'fields' }, role: 'form', words: 'fields to fill in' })
    const { plan, data } = page()
    expect(plan.missing).toEqual([])
    for (const item of data['skills.all'] as StackItem[]) expect(item.plan.missing).toEqual([])
  })
  it('an unknown swarm: only "No such swarm"', () => {
    const { orders, html } = page(input({ swarm: undefined }))
    expect(orders).toEqual([1])
    expect(html).toContain('No such swarm')
  })
  it('nothing chosen yet: what the page is, the coordinator picker, every skill without a status, and the lease step closed', () => {
    const { orders, html } = page(input())
    expect(orders).toEqual([10, 11, 12, 20, 21, 23, 30, 31, 32, 35, 40, 41])
    expect(html).toContain('This is a setup page, not a list of waiting approvals.')
    expect(html).toContain('Only an admin signed in as a person can apply anything here.')
    expect(html).toMatch(/<label[^>]*>Coordinator<select/)
    expect(html).toContain('<option value="" selected="">Choose a mind</option>')
    // native minds of this swarm only: no module, no mind of another swarm
    expect(html).toContain('>Wren</option>')
    expect(html).not.toContain('Gatehouse')
    expect(html).not.toContain('Elsewhere')
    expect(html).toContain('This swarm has no coordinator set. Choose the mind that should run the others.')
    expect(html).toContain('Needs step 1: choose a coordinator first.')
    for (const s of COORDINATOR_SKILLS) expect(html).toContain(`>${s}</span>`)
    expect(html).not.toContain('allowed')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Choose a coordinator first<\/button>/)
    expect(html).toContain(LEASE_HINT['needs-coordinator'])
    expect(html).toContain('Nothing starts until the coordinator uses the lease.')
    expect(html).not.toContain('Issue lease')
  })
  it('a swarm with fewer than two native minds says it needs two', () => {
    const { html, orders } = page(input({ agents: { m_wren: AGENTS.m_wren } }))
    expect(orders).toContain(22)
    expect(orders).not.toContain(23)
    expect(html).toContain('This swarm needs at least two native minds (a coordinator and a member) before anything can be delegated.')
  })
  it('a swarm with its coordinator set marks it in the picker', () => {
    const { html } = page(input({ swarm: { ...SWARM, coordinator_id: 'm_wren' }, ...COORD }))
    expect(html).toContain('>Wren (coordinator)</option>')
    expect(html).toMatch(/<option value="m_wren" selected="">/)
  })
  it('a coordinator chosen: its members to tick, Apply held until something changes, each skill allowed or not yet', () => {
    const { orders, html } = page(input({ ...COORD, allowed: (s) => s === 'hive-goals' }))
    expect(orders).toEqual([10, 11, 12, 20, 21, 24, 25, 26, 30, 32, 33, 40, 42])
    expect(html).toContain('<legend class="text-[12.5px] text-ink-3">Members it may run (native minds of this swarm)</legend>')
    expect(html).toMatch(/<input type="checkbox"\/>Moss<\/label>/)
    expect(html).not.toMatch(/checkbox[^>]*\/>Wren/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply delegation<\/button>/)
    expect(html).toContain('Now: nobody')
    expect(html).toMatch(/hive-goals<\/span><span class="[^"]*text-good[^"]*">allowed</)
    expect(html).toMatch(/hive-goal-get<\/span><span class="[^"]*text-warn[^"]*">not allowed yet</)
    expect(html).toMatch(/<button[^>]*>Allow 4 skills<\/button>/)
    expect(html).not.toMatch(/disabled=""[^>]*>Allow 4 skills/)
    expect(html).toContain(LEASE_HINT['needs-delegation'])
  })
  it('a ticked member that differs from now frees Apply; one skill missing reads in the singular; all allowed is held', () => {
    const changed = page(input({ ...COORD, chosen: ['m_moss'], allowed: (s) => s !== 'hive-goals' })).html
    expect(changed).toMatch(/<input type="checkbox" checked=""\/>Moss<\/label>/)
    expect(changed).not.toMatch(/disabled=""[^>]*>Apply delegation/)
    expect(changed).toMatch(/>Allow 1 skill<\/button>/)
    const all = page(input({ ...COORD, allowed: () => true }))
    expect(all.orders).toContain(34)
    expect(all.html).toMatch(/<button[^>]*disabled=""[^>]*>All allowed<\/button>/)
    // a hive that cannot delegate holds Apply
    expect(page(input({ ...COORD, chosen: ['m_moss'] }), { ...CAN, delegate: false }).html).toMatch(/disabled=""[^>]*>Apply delegation/)
  })
  it('delegated: the lease fields open, and the run asks for its member first', () => {
    const { orders, html } = page(input(DELEGATED))
    expect(orders).toEqual([10, 11, 12, 20, 21, 24, 25, 26, 30, 32, 33, 40, 43, 47, 49])
    expect(html).toContain('Now: Moss')
    expect(html).toContain('class="grid gap-3 sm:grid-cols-2"')
    expect(html).toMatch(/<label[^>]*>Member<select[^>]*><option value="" selected="">Choose<\/option><option value="m_moss">Moss<\/option><\/select>/)
    expect(html).toMatch(/<label[^>]*>Task assigned to it<select[^>]*disabled=""/)
    expect(html).toMatch(/Duration \(seconds, at most 900\)<input type="number" min="10" max="900"[^>]*value="300"/)
    expect(html).toMatch(/Budget for this run \(USD\)<input type="number" min="0.01" step="0.01"[^>]*value="0.1"/)
    expect(html).toContain(LEASE_HINT['needs-member'])
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Issue lease<\/button>/)
  })
  it('a member chosen: its open tasks only; choosing one leaves Issue lease free', () => {
    const picking = page(input({ ...DELEGATED, member: 'm_moss' }))
    expect(picking.orders).toContain(48)
    expect(picking.html).toContain('<option value="g_prune">Prune the pear row</option>')
    expect(picking.html).not.toContain('Old harvest')
    expect(picking.html).not.toContain('Count the hives')
    expect(picking.html).toContain(LEASE_HINT['needs-task'])
    const ready = page(input({ ...DELEGATED, member: 'm_moss', task: 'g_prune' }))
    expect(ready.orders).not.toContain(47)
    expect(ready.orders).not.toContain(48)
    expect(ready.html).toMatch(/<option value="g_prune" selected="">/)
    expect(ready.html).not.toMatch(/disabled=""[^>]*>Issue lease/)
    // no budget, no time, or a hive that cannot lease: held
    expect(page(input({ ...DELEGATED, member: 'm_moss', task: 'g_prune', budget: 0 })).html).toMatch(/disabled=""[^>]*>Issue lease/)
    expect(page(input({ ...DELEGATED, member: 'm_moss', task: 'g_prune' }), { ...CAN, lease: false }).html).toMatch(/disabled=""[^>]*>Issue lease/)
  })
  it('a member with no open task: the page offers to create one, in its name', () => {
    const none = page(input({ ...DELEGATED, member: 'm_moss', goals: [] }))
    expect(none.orders).toEqual(expect.arrayContaining([44, 45, 46]))
    expect(none.orders).not.toContain(48)
    expect(none.html).toContain('<option value="" selected="">No open task assigned to this member</option>')
    expect(none.html).toContain('Moss has no open task assigned to it. A lease always runs one assigned task. Create one here:')
    expect(none.html).toMatch(/<span class="sr-only">New task title<\/span><input type="text"[^>]*placeholder="What Moss should do"/)
    expect(none.html).toMatch(/<button[^>]*disabled=""[^>]*>Create task<\/button>/)
    expect(page(input({ ...DELEGATED, member: 'm_moss', goals: [], newTask: 'Mulch the beds' })).html).not.toMatch(/disabled=""[^>]*>Create task/)
  })
  it('a lease issued: who it was sent to, and that it is usable once', () => {
    const { html } = page(input({ ...DELEGATED, member: 'm_moss', task: 'g_prune', lease: 'lease_one' }))
    expect(html).toContain('Sent to Wren. It can be used once, and only by Wren.')
  })
  it('busy holds every button', () => {
    const { html } = page(input({ ...DELEGATED, member: 'm_moss', task: 'g_prune', chosen: [] }), CAN, { busy: true })
    for (const b of ['Apply delegation', 'Allow 5 skills', 'Issue lease']) expect(html).toMatch(new RegExp(`disabled=""[^>]*>${b}</button>`))
  })
  it('every part of both screens can be reached', () => {
    page(input({ swarm: undefined }))
    page(input({ agents: { m_wren: AGENTS.m_wren } }))
    page(input({ ...COORD, allowed: () => true }))
    page(input({ ...DELEGATED, member: 'm_moss', goals: [], lease: 'lease_one' }))
    page(input({ ...DELEGATED, member: 'm_moss', allowed: (s) => s === 'hive-goals' }))
    for (const screen of ['lifecycle', 'lifecycle-skill']) {
      const reached = seen.get(screen) ?? new Set<number>()
      expect(space.orders(screen).filter((o) => !reached.has(o)), screen).toEqual([])
    }
  })
})

describe('the fields, mounted: every change and tick goes back to the page', () => {
  it('a select, a number, the text field and a tick each send what was entered', async () => {
    const g = globalThis as unknown as Record<string, unknown>
    const saved: Record<string, unknown> = {}
    for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
    const doc = new MiniDocument()
    // react-dom drives a <select> through `options` (each with value/selected): give the mini document just that
    const make = doc.createElement.bind(doc)
    doc.createElement = (tag: string) => {
      const el = make(tag)
      const o = el as unknown as Record<string, unknown>
      if (tag === 'select') Object.defineProperty(o, 'options', { get: () => el.findAll((n) => n.tagName === 'OPTION') })
      if (tag === 'option') { o.selected = false; o.defaultSelected = false; Object.defineProperty(o, 'value', { get: () => el.getAttribute('value') ?? el.textContent, set: (v: string) => el.setAttribute('value', v) }) }
      return el
    }
    const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
    doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
    const container = doc.createElement('div'); doc.body.appendChild(container)
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(container as unknown as Element)
    try {
      const inputs: [string, string][] = []
      const acts: [string, ScreenItem, boolean | undefined][] = []
      const { plan, data } = page(input({ ...DELEGATED, chosen: [], member: 'm_moss', goals: [] }))
      await act(async () => root.render(createElement(Screen, { plan, host: { data, onInput: (b, v) => inputs.push([b, v]), onAction: (a, it, v) => acts.push([a, it, v]) } })))
      const change = (n: Parameters<typeof reactProps>[0], v: unknown) => (reactProps(n).onChange as (e: unknown) => void)({ target: { value: v, checked: v } })
      const selects = container.findAll((n) => n.tagName === 'SELECT')
      const fields = container.findAll((n) => n.tagName === 'INPUT')
      const typed = (t: string) => fields.find((n) => reactProps(n).type === t)!
      await act(async () => { change(selects[0], 'm_moss') })
      await act(async () => { change(typed('number'), '120') })
      await act(async () => { change(typed('text'), 'Mulch the beds') })
      await act(async () => { change(typed('checkbox'), true) })
      expect(inputs).toEqual([['deleg.coordinator', 'm_moss'], ['lease.seconds', '120'], ['task.new', 'Mulch the beds']])
      expect(acts.map(([a, it, v]) => [a, it.id, v])).toEqual([['pick-member', 'm_moss', true]])
    } finally {
      await act(async () => root.unmount())
      for (const [k, v] of Object.entries(saved)) g[k] = v
    }
  })
})
