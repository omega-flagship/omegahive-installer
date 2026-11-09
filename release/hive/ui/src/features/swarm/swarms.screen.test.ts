import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../../api/types'
import { DRAWN_BLOCKS, Screen, scopedHost, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { swarmsScreen, type Compose, type SwarmItem, type SwarmsContext, type SwarmsInput } from './data'

vi.setConfig({ testTimeout: 20_000 })

/** The Swarms page end to end: invented swarms and minds → facts → MeTTa composes the page and each card → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const composeFor = (look: string): Compose => (screen, facts) => {
  const plan = space.compose(screen, look, facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}
const compose = composeFor('classic')

const mind = (id: string, name: string, over: Partial<Agent> = {}): Agent =>
  ({ id, name, hue: 40, status: 'asleep', spent_usd: 0.25, swarm_id: null, kind: 'llm', ...over }) as Agent
const swarm = (id: string, name: string, over: Partial<Swarm> = {}): Swarm =>
  ({ id, name, description: '', hue: 200, member_ids: [], created_at: '2026-01-01T00:00:00Z', ...over })

const AGENTS: Record<string, Agent> = {
  m_1: mind('m_1', 'Quill', { swarm_id: 's_1', status: 'awake', hue: 120 }),
  m_2: mind('m_2', 'Bramble', { swarm_id: 's_1' }),
  m_3: mind('m_3', 'Tansy'),
  m_4: mind('m_4', 'Corvid', { swarm_id: 's_gone' }),
}
const SWARMS: Record<string, Swarm> = {
  s_2: swarm('s_2', 'Lantern Circle', { created_at: '2026-02-01T00:00:00Z' }),
  s_1: swarm('s_1', 'Orchard Guild', { description: 'Keeps the invented orchard', member_ids: ['m_1', 'm_2'], services: ['pruning', 'grafting'] }),
  s_3: swarm('s_3', 'Old Mill', { archived_at: '2026-03-01T00:00:00Z' }),
}
const INPUT: SwarmsInput = { swarms: SWARMS, agents: AGENTS, beliefs: { s_1: { b_1: {}, b_2: {}, b_3: {} } } }
const ADMIN: SwarmsContext = { admin: true, canRestore: true, sim: false }
const ISLANDS = { 'archived-swarms': createElement('section', { 'aria-label': 'Archived list' }) }

function page(input = INPUT, ctx = ADMIN, host: Partial<ScreenHost> = {}, c = compose) {
  const { data, facts } = swarmsScreen(input, ctx, c)
  const plan = c('swarms', facts)
  return { plan, data, facts, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, islands: ISLANDS, onOpen: () => {}, onAction: () => {}, ...host } })) }
}
const cards = (data: Record<string, unknown>) => data['swarms.rows'] as SwarmItem[]
const card = (item: SwarmItem, host: Partial<ScreenHost> = {}) =>
  renderToStaticMarkup(createElement(Screen, { plan: item.plan, host: { data: item.data, onOpen: () => {}, onAction: () => {}, ...host } }))

describe('the Swarms page, composed by MeTTa', () => {
  it('the new orrery block is known to MeTTa and drawn by the renderer; the guards stay clean', () => {
    expect(space.blocks()).toContain('orrery')
    expect(DRAWN_BLOCKS).toContain('orrery')
    expect(space.screens()).toEqual(expect.arrayContaining(['swarms', 'swarms-swarm']))
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(space.explain('swarms-swarm', 10)).toMatchObject({ declared: { kind: 'block', name: 'orrery' }, role: 'circle', words: 'the minds of a group, circling it' })
    const { plan } = page()
    expect(plan.missing).toEqual([])
    for (const item of cards(page().data)) expect(item.plan.missing).toEqual([])
  })
  it('the page offers its two ways in, then the live swarms oldest first, the archived list and the wanderers', () => {
    const { plan, html } = page()
    expect(plan.parts.map((p) => [p.order, p.block])).toEqual([[5, 'buttons'], [10, 'stack'], [20, 'island'], [30, 'section'], [31, 'list']])
    expect(html).toContain('>Add an outside agent</button>')
    expect(html).toContain('>Start a swarm</button>')
    expect(html.indexOf('Orchard Guild')).toBeLessThan(html.indexOf('Lantern Circle'))
    // the cards share a responsive grid again, as before (one column on a phone, more as it widens)
    expect(html).toMatch(/<ul aria-label="Swarms" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">/)
    expect(html).not.toContain('Old Mill')
    expect(html).toContain('aria-label="Archived list"')
    expect(html).toContain('Wanderers · no swarm')
    expect(html).toContain('aria-label="Wanderers · no swarm"')
    expect(html).toContain('Tansy')
    expect(html).toContain('Corvid')
    expect(html).not.toMatch(/Wanderers[^]*Quill/)
  })
  it('each card: its orrery opens the swarm by name, then its words, counts, services and two ways to add to it', () => {
    const [orchard] = cards(page().data)
    const html = card(orchard)
    expect(orchard.plan.parts.map((p) => p.order)).toEqual([10, 20, 21, 30, 40, 50])
    expect(html).toContain('aria-label="Open Orchard Guild"')
    expect((html.match(/animation:orbit-x/g) ?? []).length).toBe(2)
    expect(html).toContain('Keeps the invented orchard')
    expect(html).toContain('aria-label="About Orchard Guild"')
    expect(html).toContain('>2 minds</li>')
    expect(html).toContain('>1 awake</li>')
    expect(html).toContain('>3 beliefs</li>')
    expect(html).toMatch(/>\$0\.50 spent<\/li>/)
    expect(html).toContain('aria-label="Offered services"')
    expect(html).toMatch(/Services for other swarms<\/dt><dd[^>]*>pruning, grafting</)
    expect(html).toContain('>New mind here</button>')
    expect(html).toContain('>Add an outside agent</button>')
  })
  it('a swarm with no description, no services, or none known says so; one mind and one belief read in the singular', () => {
    const one: SwarmsInput = { ...INPUT, swarms: { s_1: swarm('s_1', 'Solo', { member_ids: ['m_1'], services: [] }) }, beliefs: { s_1: { b_1: {} } } }
    const html = card(cards(page(one).data)[0])
    expect(html).toContain('No description.')
    expect(html).toContain('>1 mind</li>')
    expect(html).toContain('>1 belief</li>')
    expect(html).toContain('No public services offered.')
    const lantern = card(cards(page().data)[1])
    expect(lantern).toContain('Service information unavailable.')
    expect(lantern).toContain('>0 minds</li>')
  })
  it('simulated costs are marked as simulated', () => {
    const html = card(cards(page(INPUT, { ...ADMIN, sim: true }).data)[0])
    expect(html).toMatch(/text-warn[^>]*>\$0\.50 spent \(simulated\)</)
  })
  it('no swarms yet: says what a swarm is and offers to start one; no wanderers, no wanderer section', () => {
    const { plan, html } = page({ swarms: {}, agents: {}, beliefs: {} })
    expect(plan.parts.map((p) => p.order)).toEqual([5, 11, 12, 20])
    expect(html).toContain('No swarms yet')
    expect(html).toContain('A swarm is a group of minds with a shared purpose and a commons of beliefs.')
    expect((html.match(/>Start a swarm</g) ?? []).length).toBe(2)
    expect(html).not.toContain('Wanderers')
  })
  it('the archived list is placed only for an admin on a hive that can restore', () => {
    const islands = (ctx: SwarmsContext) => page(INPUT, ctx).plan.parts.filter((p) => p.block === 'island').length
    expect(islands(ADMIN)).toBe(1)
    expect(islands({ ...ADMIN, admin: false })).toBe(0)
    expect(islands({ ...ADMIN, canRestore: false })).toBe(0)
  })
  it('presses come back with the swarm they belong to', () => {
    const opened: [string, ScreenItem][] = []
    const acted: [string, ScreenItem][] = []
    const host: ScreenHost = { data: {}, onOpen: (t, it) => opened.push([t, it]), onAction: (a, it) => acted.push([a, it]) }
    const [orchard] = cards(page().data)
    const scoped = scopedHost(host, orchard as unknown as ScreenItem)
    scoped.onOpen!('swarm', {})
    scoped.onAction!('new-mind', {})
    scoped.onAction!('connect-here', {})
    expect(opened).toEqual([['swarm', { scope: ['s_1'] }]])
    expect(acted.map(([a, it]) => [a, it.scope])).toEqual([['new-mind', ['s_1']], ['connect-here', ['s_1']]])
  })
  it('Cosmos draws the wanderers as cards, in its 3D space', () => {
    const { plan } = page(INPUT, ADMIN, {}, composeFor('cosmos'))
    expect(plan.space).toBe('3d')
    expect(plan.parts.find((p) => p.order === 31)).toMatchObject({ block: 'cards', how: { kind: 'look' } })
  })
  it('without a press handler the orrery is a plain picture, not a button', () => {
    const [orchard] = cards(page().data)
    const html = renderToStaticMarkup(createElement(Screen, { plan: orchard.plan, host: { data: orchard.data } }))
    expect(html).not.toContain('aria-label="Open Orchard Guild"')
    expect(html).toContain('aria-hidden="true"')
  })
  it('every part of both screens can be reached', () => {
    for (const screen of ['swarms', 'swarms-swarm']) {
      const reached = [...(seen.get(screen) ?? [])].sort((a, b) => a - b)
      expect(reached, screen).toEqual(space.orders(screen))
    }
  })
})
