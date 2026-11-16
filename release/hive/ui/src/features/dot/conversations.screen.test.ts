import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../../api/types'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { conversationsScreen } from './conversations'
import type { RecentChat } from './recent'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** Recent conversations end to end: invented chats → facts → MeTTa composes → the renderer draws. */
const space = ScreensSpace.open()
const mind = (id: string, name: string, over: Partial<Agent> = {}): Agent =>
  ({ id, name, hue: 140, status: 'awake', swarm_id: null, kind: 'omega', ...over }) as Agent
const AGENTS: Record<string, Agent> = {
  m_1: mind('m_1', 'Wren', { swarm_id: 's_1' }),
  m_2: mind('m_2', 'Ada', { status: 'asleep', hue: 30 }),
}
const SWARMS: Record<string, Swarm> = { s_1: { id: 's_1', name: 'Orchard Guild', description: '', hue: 200, member_ids: ['m_1'], created_at: '2026-01-01T00:00:00Z' } }
const ROWS: RecentChat[] = [{ id: 'm_2', at: new Date(Date.now() - 120_000).toISOString() }, { id: 'm_1', at: new Date(Date.now() - 7_200_000).toISOString() }]

const draw = (rows: RecentChat[], look = 'classic', onOpen?: (t: string, item: Record<string, unknown>) => void) => {
  const { data, facts } = conversationsScreen(rows, AGENTS, SWARMS)
  const plan = space.compose('conversations', look, facts)
  return { plan, orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onOpen: onOpen ?? (() => {}), onAction: () => {} } })) }
}

describe('Recent conversations, composed by MeTTa', () => {
  it('one row per mind, newest first, each naming its swarm, how it is and when this person wrote', () => {
    const { html } = draw(ROWS)
    expect(html).toContain('aria-label="Recent conversations"')
    expect(html.indexOf('Ada')).toBeLessThan(html.indexOf('Wren'))
    expect(html).toContain('No swarm · asleep · you wrote')
    expect(html).toContain('Orchard Guild · awake · you wrote')
    expect(html.match(/Open chat ›/g)).toHaveLength(2)
    expect(html).not.toContain('No conversations yet')
  })
  it('each row opens its chat with the mind', () => {
    const { data } = conversationsScreen(ROWS, AGENTS, SWARMS)
    const rows = data['conversations.rows'] as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual(['m_2', 'm_1'])
    expect(space.compose('conversations', 'classic', { counts: { conversations: 2 } }).parts[0].props.open).toBe('chat')
  })
  it('a chat with a mind no longer here is left out', () => {
    expect(conversationsScreen([{ id: 'gone', at: '2026-01-01T00:00:00Z' }], AGENTS, SWARMS).facts.counts).toEqual({ conversations: 0 })
  })
  it('none yet: the empty state and a way to find a mind', () => {
    const { html } = draw([])
    expect(html).toContain('No conversations yet')
    expect(html).toContain('so you can go straight back to its chat')
    expect(html).toContain('Find a mind')
  })
  it('Cosmos draws the same atoms as cards', () => {
    expect(draw(ROWS, 'cosmos').html).toContain('data-block="cards"')
  })
  it('the guards stay clean and nothing falls back', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(draw(ROWS).plan.missing).toEqual([])
  })
})

describe('every part of Recent conversations can be reached', () => {
  it('the rows, or the empty state and its button', () => {
    const seen = new Set<number>()
    const see = (o: number[]) => { o.forEach((x) => seen.add(x)); return o }
    expect(see(draw(ROWS).orders)).toEqual([10])
    expect(see(draw([]).orders)).toEqual([20, 21])
    expect([...seen].sort((a, b) => a - b)).toEqual(space.orders('conversations'))
  })
})
