import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Goal, Motivation, MotivationRef, Swarm } from '../../api/types'
import { PARTIAL_WORDS } from '../../lib/motivations'
import { DRAWN_BLOCKS, Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import tasksSource from './tasks.metta?raw'
import { routeAfter, taskFilter, tasksScreen, type TasksInput, type TasksRoute } from './data'
import { TASKS_SCREEN } from './layout'

vi.setConfig({ testTimeout: 20_000 })

/** The Tasks page end to end: an invented hive → facts → MeTTa composes the page → drawn. INVENTED DATA only. */
const space = ScreensSpace.open()
const seen = new Set<number>()
const at = '2026-02-01T09:00:00Z'

const swarm = (id: string, name: string, hue: number, created_at: string): Swarm => ({ id, name, description: '', hue, member_ids: [], created_at })
const goal = (id: string, swarm_id: string, over: Partial<Goal> = {}): Goal => ({
  id, swarm_id, parent_id: null, title: `Task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: at, updated_at: at, ...over,
})
const motive = (id: string, title: string, over: Partial<Motivation> = {}): Motivation => ({
  id, title, why: '', owner: 'user:p_one', swarm_id: null, status: 'active', visibility: 'public', rev: 1, parent_id: null, created_by: 'user:p_one', created_at: at, updated_at: at, status_changed_at: null, editable: false, ...over,
})
const ref = (m: Motivation): MotivationRef => ({ id: m.id, title: m.title, status: m.status })

const LAMPS = motive('mo_lamps', 'Light the lanes', { why: 'So walkers see the path at dusk.' })
const QUIET = motive('mo_quiet', 'Quiet mornings', { status: 'paused' })
const OLD = motive('mo_old', 'Old aim', { status: 'retired' })
const HIVE: Omit<TasksInput, 'route' | 'query'> = {
  swarms: { s_b: swarm('s_b', 'Builders', 200, '2026-01-02T00:00:00Z'), s_a: swarm('s_a', 'Gardeners', 120, '2026-01-01T00:00:00Z') },
  agents: { a_z: { id: 'a_z', name: 'Zeno' } as Agent, a_m: { id: 'a_m', name: 'Mira' } as Agent },
  goals: {
    g1: goal('g1', 's_a', { title: 'Fit the lamp posts', assignee: 'a_m' }),
    g2: goal('g2', 's_a', { title: 'Paint the gate', status: 'claimed', claimed_by: 'a_z' }),
    g3: goal('g3', 's_b', { title: 'Order bulbs', detail: 'warm white' }),
    g4: goal('g4', 's_b', { title: 'Sweep the lane', status: 'done' }),
  },
  links: { g1: [ref(LAMPS), ref(LAMPS)], g2: [], g3: [ref(LAMPS), ref(QUIET)], g4: [] },
  motivations: { [LAMPS.id]: LAMPS, [QUIET.id]: QUIET, [OLD.id]: OLD },
  supported: true,
  countsPartial: false,
  linksLoaded: true,
}

function page(route: TasksRoute = {}, over: Partial<TasksInput> = {}, host: Partial<ScreenHost> = {}) {
  const s = tasksScreen({ ...HIVE, route, query: '', ...over })
  const plan = space.compose('tasks', 'classic', s.facts)
  for (const p of plan.parts) seen.add(p.order)
  const html = renderToStaticMarkup(createElement(Screen, { plan, className: TASKS_SCREEN, host: { data: s.data, framed: true, onInput: () => {}, onOpen: () => {}, onAction: () => {}, ...host } }))
  return { ...s, plan, html, orders: plan.parts.map((p) => p.order), blocks: plan.parts.map((p) => p.block) }
}

describe('the Tasks page, composed by MeTTa', () => {
  it('with no swarm, says so and offers nothing else', () => {
    const p = page({}, { swarms: {}, goals: {} })
    expect(p.blocks).toEqual(['empty'])
    expect(p.html).toContain('No swarms yet')
    expect(p.html).toContain('Tasks belong to a swarm. Start one first.')
  })

  it('draws the filters in order, then the board in columns, then Find help', () => {
    const p = page()
    expect(p.blocks).toEqual(['tabs', 'pills', 'switcher', 'menus', 'search', 'notice', 'island', 'island'])
    expect(p.plan.parts.filter((x) => x.block === 'island').map((x) => x.props.name)).toEqual(['task-columns', 'find-help'])
    expect(p.plan.missing).toEqual([])
    // the task total is still a live region, as the old page's role="status" line was
    expect(p.html).toMatch(/data-screen-part="tasks\.33"[^>]*><p role="status"/)
  })

  it('the list view is the other island, chosen by the address', () => {
    const p = page({ view: 'list' })
    expect(p.plan.parts.filter((x) => x.block === 'island').map((x) => x.props.name)).toEqual(['task-list', 'find-help'])
    const offered = { 'task-columns': createElement('p', null, 'COLUMNS'), 'task-list': createElement('p', null, 'LIST'), 'find-help': createElement('p', null, 'HELP') }
    expect(page({ view: 'list' }, {}, { islands: offered }).html).toMatch(/LIST(?:(?!COLUMNS).)*HELP/s)
    expect(page({}, {}, { islands: offered }).html).not.toContain('LIST')
  })

  it('swarm tabs: every swarm first with all live tasks, then each swarm oldest first with its own count and colour', () => {
    const p = page({ swarm: 's_b' })
    expect(p.html).toContain('role="tablist" aria-label="Swarm"')
    const tabs = [...p.html.matchAll(/role="tab" aria-selected="(true|false)"(?:(?!<\/button>).)*?font-medium">([^<]+)<\/span><span[^>]*>(\d+)</gs)].map((x) => [x[2], x[3], x[1]])
    expect(tabs).toEqual([['All swarms', '3', 'false'], ['Gardeners', '2', 'false'], ['Builders', '1', 'true']])
    expect(p.html).toContain('box-shadow:0 0 10px hsl(')
    expect(p.team).toBe('s_b')
    expect(page({ swarm: 's_gone' }).team).toBeUndefined()
  })

  it('motivation filter: Any, the live motivations (each task once), the Unsorted with its nudge, and the way to Motivations', () => {
    const p = page()
    expect(p.html).toContain('role="group" aria-label="Filter by motivation"')
    expect(p.html).toMatch(/aria-pressed="true"[^>]*><span class="truncate">Any motivation</)
    // Light the lanes: g1 (linked twice, counted once) and g3; Quiet mornings is paused, so says so; Old aim is retired
    expect(p.html).toMatch(/title="So walkers see the path at dusk\."[^>]*><span class="truncate">Light the lanes<\/span><span[^>]*>2</)
    expect(p.html).toMatch(/Quiet mornings<\/span><span class="text-ink-4">· paused<\/span><span[^>]*>1</)
    expect(p.html).not.toContain('Old aim')
    expect(p.html).toMatch(/border-dashed[^>]*><span class="truncate">Unsorted<\/span><span[^>]*>1<\/span><span class="text-ink-3">· Sort these</)
    expect(p.html).toMatch(/>Motivations(?:<!-- -->)? <svg/)
    // a retired motivation still shows when it is the one chosen
    expect(page({ motivation: OLD.id }).html).toContain('Old aim')
  })

  it('a hive without Motivations shows no motivation filter', () => {
    expect(page({}, { supported: false }).blocks).not.toContain('pills')
  })

  it('a partial read marks each count by motivation as a floor and says why', () => {
    const p = page({ motivation: 'none' }, { countsPartial: true })
    expect(p.orders).toContain(25)
    expect(p.html).toContain(`Counts by motivation ${PARTIAL_WORDS}. Tasks it did not reach are not counted as under no motivation.`)
    expect(p.html).toMatch(/data-count-partial="true">2\+</)
    expect(p.html).toContain(`2+ tasks under no motivation you can see (${PARTIAL_WORDS})`)
    // without Motivations there is nothing to be partial about
    expect(page({}, { countsPartial: true, supported: false }).orders).not.toContain(25)
  })

  it('view, mind and words: a radio group that keeps one tab stop, the mind menu, the search, and the total', () => {
    const p = page({ view: 'list', mind: 'a_z' }, { query: 'GATE' })
    expect(p.html).toContain('role="radiogroup" aria-label="Show tasks as"')
    expect(p.html).toMatch(/role="radio" aria-checked="false" tabindex="-1" data-radio-value="board"[^>]*><svg[^]*?Columns</)
    expect(p.html).toMatch(/role="radio" aria-checked="true" tabindex="0" data-radio-value="list"[^>]*><svg[^]*?List</)
    expect(p.html).toMatch(/<select aria-label="Mind"[^>]*><option value="">Any mind<\/option><option value="a_m">Mira<\/option><option value="a_z" selected="">Zeno</)
    expect(p.html).toContain('placeholder="Find a task…"')
    expect(p.html).toContain('<span class="sr-only">Find a task</span>')
    expect(p.html).toMatch(/role="status"[^>]*>1 task</)
  })

  it('one motivation: its total, why it matters, and the way to it', () => {
    const p = page({ motivation: LAMPS.id })
    expect(p.chosen?.id).toBe(LAMPS.id)
    expect(p.html).toContain('2 tasks under “Light the lanes”')
    expect(p.html).toContain('So walkers see the path at dusk.')
    expect(p.html).toMatch(/<button[^>]*>About this motivation →<\/button>/)
    expect(p.html).toMatch(/border-accent\/50[^>]*><span class="truncate">Light the lanes/)
    // one without words of its own: the way to it, no empty line
    const q = page({ motivation: QUIET.id })
    expect(q.orders).toContain(43)
    expect(q.orders).not.toContain(42)
  })

  it('the Unsorted: a hint how to sort, only while there is something to sort', () => {
    expect(page({ motivation: 'none' }).orders).toContain(41)
    expect(page({ motivation: 'none' }).html).not.toContain('Sort these')
    expect(page({ motivation: 'none' }, { links: { g1: [ref(LAMPS)], g3: [ref(LAMPS)] } }).orders).not.toContain(41)
  })

  it('a motivation that is not there for you says so, once the links are read', () => {
    expect(page({ motivation: 'mo_private' }).html).toContain('That motivation is not there for you')
    expect(page({ motivation: 'mo_private' }, { linksLoaded: false }).orders).not.toContain(40)
    expect(page({ motivation: 'mo_private' }, { supported: false }).orders).not.toContain(40)
  })

  it('every part of the screen can be reached, and every block it names is drawn', () => {
    const declared = [...tasksSource.matchAll(/^\(Part tasks (\d+) (\w+)/gm)].map((x) => [Number(x[1]), x[2]] as const)
    for (const [, block] of declared) expect(DRAWN_BLOCKS).toContain(block)
    expect([...seen].sort((a, b) => a - b)).toEqual(declared.map(([o]) => o).sort((a, b) => a - b))
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})

describe('the Tasks filters (pure)', () => {
  const g = HIVE.goals
  it('mind is the assignee, the holder or the creator; motivation is one or the Unsorted; words search title and detail', () => {
    expect(Object.values(g).filter(taskFilter({ mind: 'a_m' }, '', HIVE.links)).map((x) => x.id)).toEqual(['g1'])
    expect(Object.values(g).filter(taskFilter({ mind: 'a_z' }, '', HIVE.links)).map((x) => x.id)).toEqual(['g2'])
    expect(taskFilter({ mind: 'a_q' }, '', HIVE.links)(goal('g9', 's_a', { created_by: 'agent:a_q' }))).toBe(true)
    expect(Object.values(g).filter(taskFilter({ motivation: 'none' }, '', HIVE.links)).map((x) => x.id)).toEqual(['g2', 'g4'])
    expect(Object.values(g).filter(taskFilter({ motivation: QUIET.id }, '', HIVE.links)).map((x) => x.id)).toEqual(['g3'])
    expect(Object.values(g).filter(taskFilter({}, '  WARM ', HIVE.links)).map((x) => x.id)).toEqual(['g3'])
  })
  it('a pick becomes the address: the chosen motivation again or Any clears it; the board is the view left out', () => {
    expect(routeAfter({}, 'swarm', 's_a')).toEqual({ swarm: 's_a' })
    expect(routeAfter({ swarm: 's_a' }, 'swarm', '')).toEqual({ swarm: undefined })
    expect(routeAfter({}, 'mind', '')).toEqual({ mind: undefined })
    expect(routeAfter({}, 'motivation', 'mo_lamps')).toEqual({ motivation: 'mo_lamps' })
    expect(routeAfter({ motivation: 'mo_lamps' }, 'motivation', 'mo_lamps')).toEqual({ motivation: undefined })
    expect(routeAfter({ motivation: 'none' }, 'motivation', '')).toEqual({ motivation: undefined })
    expect(routeAfter({}, 'view', 'list')).toEqual({ view: 'list' })
    expect(routeAfter({ view: 'list' }, 'view', 'board')).toEqual({ view: undefined })
    expect(routeAfter({}, 'view', 'grid')).toBeNull()
    expect(routeAfter({}, 'query', 'x')).toBeNull()
  })
})
