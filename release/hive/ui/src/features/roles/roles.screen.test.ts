import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import type { Agent, Role } from '../../api/types'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { Orb } from '../../ui/primitives'
import { ScreensSpace, type ScreenFacts } from '../../screens/screenSpace'
import { hueOf, renderRole, roleScreen, rolesScreen, rolesStatus, type RolesLoad } from './data'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The Roles screens end to end: invented roles → facts → MeTTa composes → the renderer draws. */
const space = ScreensSpace.open()
type Built = { data: Record<string, unknown>; facts: ScreenFacts }
const plan = (screen: 'roles' | 'role', look: string, d: Built) => space.compose(screen, look, d.facts)
const draw = (screen: 'roles' | 'role', look: string, d: Built, host: Partial<ScreenHost> = {}) =>
  renderToStaticMarkup(createElement(Screen, { plan: plan(screen, look, d), host: { data: d.data, framed: true, ...host } }))
const orders = (screen: 'roles' | 'role', d: Built) => plan(screen, 'classic', d).parts.map((p) => p.order)

const role = (id: string, name: string, extra: Partial<Role> = {}): Role => ({
  id, name, summary: '', prompt: 'You are {name}.', default_model: null, default_budget: null, rules: [], builtin: false,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', minds: [], ...extra,
})
const mind = (id: string, name: string, spent = 0, hue = 200, status = 'awake') => ({ id, name, spent_usd: spent, hue, status }) as unknown as Agent
const ready = (roles: Role[], error: unknown = undefined): RolesLoad => ({ state: 'ready', roles, error })
const library = [
  role('r1', 'Gardener', { summary: 'Tends the shared notes', builtin: true, minds: ['m1', 'm2'] }),
  role('r2', 'Cartographer', { minds: ['m3'] }),
]

describe('the role library, composed by MeTTa', () => {
  it('lists every role with its summary, whether it is built in, and how many minds have it', () => {
    const html = draw('roles', 'classic', rolesScreen(ready(library), true))
    expect(html).toContain('data-block="list"')
    expect(html).toContain('aria-label="Roles"')
    expect(html).toContain('Tends the shared notes')
    expect(html).toContain('built in · 2 minds')
    expect(html).toContain('No summary')
    expect(html).toContain('1 mind<')
  })
  it('stays a list in a look that draws collections as cards (it sits in a narrow column)', () => {
    expect(draw('roles', 'cosmos', rolesScreen(ready(library), true))).toContain('data-block="list"')
  })
  it('pressing a role opens it', () => {
    const p = plan('roles', 'classic', rolesScreen(ready(library), true))
    expect(p.parts.find((x) => x.block === 'list')?.props.open).toBe('role')
  })
  it('an empty library says how to start only when this hive can create roles', () => {
    const can = draw('roles', 'classic', rolesScreen(ready([]), true))
    expect(can).toContain('No roles yet')
    expect(can).toContain('Create one with New role.')
    const cannot = draw('roles', 'classic', rolesScreen(ready([]), false))
    expect(cannot).toContain('No roles yet')
    expect(cannot).not.toContain('New role')
  })
  it('New role is a part MeTTa shows only when this hive can create roles, and its press asks to create one', () => {
    const can = plan('roles', 'classic', rolesScreen(ready(library), true))
    expect(can.parts[0]).toMatchObject({ order: 5, block: 'actions', props: { tone: 'primary', items: [['action', 'New role', 'create-role', '-', 'plus']] } })
    const html = draw('roles', 'classic', rolesScreen(ready(library), true))
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*<svg(?:(?!<\/button>).)*New role<\/button>/)   // the look's primary button, with its plus
    expect(plan('roles', 'classic', rolesScreen(ready(library), false)).parts.map((p) => p.order)).not.toContain(5)
    expect(draw('roles', 'classic', rolesScreen(ready(library), false))).not.toContain('New role')
  })
  it('while the library loads MeTTa shows the waiting part, and only that (New role aside)', () => {
    for (const state of ['idle', 'loading'] as const) {
      const d = rolesScreen({ state, roles: null, error: undefined }, true)
      expect(plan('roles', 'classic', d).parts.map((p) => [p.order, p.block])).toEqual([[5, 'actions'], [10, 'waiting']])
      expect(draw('roles', 'classic', d)).toContain('aria-label="Loading roles"')
      expect(orders('roles', rolesScreen({ state, roles: null, error: undefined }, false))).toEqual([10])
    }
    expect(orders('roles', rolesScreen(ready(library), true))).not.toContain(10)
  })
  it('the open role is highlighted and marked current, and no other role is', () => {
    const html = draw('roles', 'classic', rolesScreen(ready(library), true, 'r2'), { onOpen: () => undefined })
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    const rows = html.split('<li>').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Cartographer')
    expect(rows[1]).toMatch(/<button[^>]*bg-tint\/\[0\.07\][^>]*aria-current="true"/)
    expect(rows[0]).toContain('Gardener')
    expect(rows[0]).not.toContain('aria-current')
    expect(rows[0]).not.toContain('bg-tint/[0.07]')
    expect(draw('roles', 'classic', rolesScreen(ready(library), true))).not.toContain('aria-current')
  })
  it('each role keeps its own colour dot', () => {
    const d = rolesScreen(ready(library), true)
    expect((d.data['roles.all'] as { hue: number }[]).map((r) => r.hue)).toEqual([hueOf('Gardener'), hueOf('Cartographer')])
    expect(hueOf('Gardener')).not.toBe(hueOf('Cartographer'))
    const html = draw('roles', 'classic', d)
    expect(html.match(/rounded-full" style="background:hsl/g)).toHaveLength(2)
  })
  it('a hive without a role library, an admin-only library, and a failed load each say so', () => {
    expect(draw('roles', 'classic', rolesScreen({ state: 'unsupported', roles: null, error: undefined }, true))).toContain('does not have a role library')
    const forbidden = draw('roles', 'classic', rolesScreen({ state: 'error', roles: null, error: new ApiError(403, 'forbidden', 'Not allowed') }, true))
    expect(forbidden).toContain('Admins only')
    expect(forbidden).not.toContain('Try again')
    const failed = draw('roles', 'classic', rolesScreen({ state: 'error', roles: null, error: new Error('The hive is busy') }, true))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Could not load roles: The hive is busy')
    expect(failed).toContain('>Try again<')
  })
  it('a failed refresh keeps the roles on screen with a notice and Retry', () => {
    const html = draw('roles', 'classic', rolesScreen(ready(library, new Error('Timed out')), true))
    expect(html).toContain('Could not refresh: Timed out Showing the last loaded data.')
    expect(html).toContain('>Retry<')
    expect(html).toContain('Gardener')
  })
  it('every condition on the library can be reached', () => {
    expect(orders('roles', rolesScreen({ state: 'unsupported', roles: null, error: undefined }, false))).toEqual([11])
    expect(orders('roles', rolesScreen({ state: 'error', roles: null, error: new ApiError(403, 'forbidden', 'Not allowed') }, false))).toEqual([12])
    expect(orders('roles', rolesScreen({ state: 'error', roles: null, error: new Error('x') }, true))).toEqual([5, 13, 14])
    expect(orders('roles', rolesScreen(ready(library, new Error('x')), true))).toEqual([5, 15, 17, 20])
    expect(orders('roles', rolesScreen({ state: 'loading', roles: null, error: undefined }, false))).toEqual([10])
    expect(orders('roles', rolesScreen(ready([]), true))).toEqual([5, 21])
    expect(orders('roles', rolesScreen(ready([]), false))).toEqual([22])
    expect(space.orders('roles')).toEqual([5, 10, 11, 12, 13, 14, 15, 17, 20, 21, 22])
  })
  it('loading is told apart from an empty library', () => {
    expect(rolesStatus({ state: 'idle', roles: null, error: undefined })).toBe('loading')
    expect(rolesStatus({ state: 'loading', roles: null, error: undefined })).toBe('loading')
    expect(rolesStatus(ready([]))).toBe('empty')
    expect(rolesStatus(ready(library))).toBe('ready')
  })
})

describe('one role, composed by MeTTa', () => {
  const agents = { m1: mind('m1', 'Ada', 0.42, 120), m2: mind('m2', 'Wren', 3, 300, 'asleep') }
  const islands = { 'role-form': createElement('form', { 'aria-label': 'Invented editor' }), 'role-commands': createElement('button', null, 'Invented save') }

  it('nothing open: asks to pick a role, with no editor', () => {
    const d = roleScreen(null, agents)
    expect(orders('role', d)).toEqual([40])
    const html = draw('role', 'classic', d, { islands })
    expect(html).toContain('Pick a role')
    expect(html).not.toContain('Invented editor')
  })
  it('a role open: the editor island, its minds, then save and remove, in that order', () => {
    const d = roleScreen(library[0], agents)
    expect(plan('role', 'classic', d).parts.map((p) => [p.order, p.block])).toEqual([[10, 'island'], [20, 'section'], [21, 'list'], [30, 'island']])
    const html = draw('role', 'classic', d, { islands })
    expect(html.indexOf('Invented editor')).toBeLessThan(html.indexOf('Minds with this role'))
    expect(html.indexOf('Wren')).toBeLessThan(html.indexOf('Invented save'))
    expect(html).toContain('$0.42')
  })
  it('a mind that is gone is left out; no minds says how to give the role to one', () => {
    const d = roleScreen(library[1], agents)
    expect(d.facts.counts?.['role.minds']).toBe(0)
    expect(orders('role', d)).toEqual([10, 20, 22, 30])
    expect(draw('role', 'classic', d)).toContain('None yet. Pick it when you create a mind or start a swarm.')
  })
  it('pressing a mind opens it', () => {
    const d = roleScreen(library[0], agents)
    expect(plan('role', 'classic', d).parts.find((p) => p.order === 21)?.props.open).toBe('mind')
  })
  it('each mind shows its orb, in its own hue and state', () => {
    const d = roleScreen(library[0], agents)
    expect(d.data['role.minds']).toEqual([
      { id: 'm1', name: 'Ada', spent: '$0.42', hue: 120, status: 'awake' },
      { id: 'm2', name: 'Wren', spent: '$3.00', hue: 300, status: 'asleep' },
    ])
    expect(plan('role', 'classic', d).parts.find((p) => p.order === 21)?.props).toMatchObject({ orb: 'hue', status: 'status' })
    for (const look of ['classic', 'cosmos']) {
      const html = draw('role', look, d)
      // the same orb the mind wears elsewhere: its hue, and dimmed while it sleeps
      expect(html).toContain(renderToStaticMarkup(createElement(Orb, { hue: 120, size: 22, status: 'awake' })))
      expect(html).toContain(renderToStaticMarkup(createElement(Orb, { hue: 300, size: 22, status: 'asleep' })))
    }
  })
  it('the minds are cards in Cosmos', () => {
    expect(draw('role', 'cosmos', roleScreen(library[0], agents))).toContain('data-block="cards"')
  })
  it('the prompt preview fills in the name, the swarm and its purpose', () => {
    expect(renderRole('I am {name} of {swarm}: {purpose}', 'Ada', '', 'mapping')).toBe('I am Ada of this hive: mapping')
  })
})

describe('the island block', () => {
  it('draws the element the page placed, and nothing when there is none', () => {
    const d = roleScreen(library[0], {})
    const withIsland = draw('role', 'classic', d, { islands: { 'role-form': createElement('em', null, 'drawn by the page') } })
    expect(withIsland).toContain('data-block="island"')
    expect(withIsland).toContain('<em>drawn by the page</em>')
    const without = draw('role', 'classic', d, { islands: { 'something-else': createElement('em', null, 'not this one') } })
    expect(without).not.toContain('not this one')
  })
  it('is drawable, has a default, and sits on the surface', () => {
    const p = plan('role', 'still', roleScreen(library[0], {}))
    expect(p.parts[0]).toMatchObject({ block: 'island', how: { kind: 'direct' }, depth: { layer: 'surface', z: 1 } })
    expect(space.guards().rolesWithoutDefault).toEqual([])
  })
})
