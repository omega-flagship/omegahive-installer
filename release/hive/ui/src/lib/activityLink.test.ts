import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, Message } from '../api/types'
import { emptyData, reduce, type Activity } from '../store/reducer'
import { linkTarget } from '../features/messages/coffee'
import { activityRoute } from './activityLink'
import { href, parse } from './router'

/**
 * An activity line that says a mind said something, or received or sent a message, opens that message in its
 * conversation: the line keeps the conversation and the message, the route names both, and the Messages page finds
 * the message itself or the room copy made from it. The store is replaced at its module for the ticker; INVENTED names.
 */

// hoisted with the module mocks below, which read them when the ticker's store loads
const { at, vega } = vi.hoisted(() => {
  const at = '2026-11-10T08:00:00.000Z'
  const vega: Agent = {
    id: 'a_vega', name: 'Vega', kind: 'omega', swarm_id: 's_lyra', model: 'mock/echo', persona: '', hue: 248,
    status: 'awake', driver: 'local', budget_usd: 0, spent_usd: 0, connected: true, last_active_at: null, created_at: at,
  }
  return { at, vega }
})
const msg = (p: Partial<Message>): Message => ({
  id: 'm_1', agent_id: 'a_vega', conversation_id: 'c_a_vega', direction: 'out', sender: 'agent:a_vega', text: 'hi', created_at: at, ...p,
})
const line = (m: Message): Activity => {
  const s = reduce({ ...emptyData(), agents: { a_vega: vega } }, { type: 'message', at, message: m })
  return s.activity[0]
}

describe('an activity line about a message', () => {
  it('keeps its conversation and the message a link opens: its own, or the room message a delivery copies', () => {
    expect(line(msg({}))).toMatchObject({ kind: 'message', text: 'said something', conversation_id: 'c_a_vega', message_id: 'm_1' })
    const delivered = line(msg({ id: 'm_2', direction: 'in', sender: 'user:p_ada', conversation_id: 'r_plan', source_message_id: 'rm_7' }))
    expect(delivered).toMatchObject({ text: 'received a message', conversation_id: 'r_plan', message_id: 'rm_7' })
  })

  it('opens that message where its conversation lives: a person’s chat in the mind’s chat, a room or an Ask in Messages', () => {
    const chat = activityRoute(line(msg({})))
    expect(chat).toEqual({ name: 'dot', id: 'a_vega', tab: 'chat', message: 'm_1' })
    expect(href(chat!)).toBe('#/dot/a_vega?m=m_1')
    expect(parse(href(chat!))).toEqual({ name: 'dot', id: 'a_vega', message: 'm_1' }) // the chat is the mind's first tab
    expect(activityRoute(line(msg({ conversation_id: 'c_a_vega~user:p_ada' })))).toMatchObject({ name: 'dot', id: 'a_vega', message: 'm_1' })
    const room = activityRoute(line(msg({ conversation_id: 'team_s_lyra' })))
    expect(room).toEqual({ name: 'messages', room: 'team_s_lyra', message: 'm_1' })
    expect(href(room!)).toBe('#/messages/team_s_lyra?m=m_1')
    expect(parse(href(room!))).toEqual(room)
    expect(activityRoute(line(msg({ conversation_id: 'r_plan' })))).toEqual({ name: 'messages', room: 'r_plan', message: 'm_1' })
    expect(activityRoute(line(msg({ conversation_id: 'coffee' })))).toEqual({ name: 'messages', room: 'coffee', message: 'm_1' })
    expect(activityRoute(line(msg({ conversation_id: 'ask:t_1' })))).toEqual({ name: 'messages', room: 'ask:t_1', message: 'm_1' })
    // any other conversation (two minds talking, a note from the hive) opens in the chat of the mind holding it
    expect(activityRoute(line(msg({ conversation_id: 'peer:a_orion:a_vega' })))).toEqual({ name: 'dot', id: 'a_vega', tab: 'chat', message: 'm_1' })
    expect(activityRoute({ kind: 'belief' })).toBeNull()
    expect(activityRoute({ kind: 'message', conversation_id: 'c_a_vega' })).toBeNull()
  })

  it('finds the message in its room, itself or the room copy made from it, and leaves a missing one as named', () => {
    const room = [{ id: 'rm_1', source_message_id: null }, { id: 'rm_2', source_message_id: 'm_1' }, { id: 'm_9', source_message_id: 'm_5' }]
    expect(linkTarget(room, 'rm_1')).toBe('rm_1')
    expect(linkTarget(room, 'm_1')).toBe('rm_2')
    expect(linkTarget(room, 'm_9')).toBe('m_9')                 // its own id first, though another copy names it too
    expect(linkTarget(room, 'm_404')).toBe('m_404')
    expect(linkTarget(room, undefined)).toBeUndefined()
  })
})

vi.mock('../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../store/store')>()
  const hive = {
    ...real.useHive.getState(),
    agents: { a_vega: vega },
    activity: [
      { id: 2, at, kind: 'message', agent_id: 'a_vega', swarm_id: 's_lyra', text: 'said something', conversation_id: 'c_a_vega', message_id: 'm_1' },
      { id: 1, at, kind: 'status', agent_id: 'a_vega', swarm_id: 's_lyra', text: 'woke up' },
    ],
  }
  return { ...real, useHive: Object.assign((select: (s: unknown) => unknown) => select(hive), real.useHive) }
})
vi.mock('./router', async (importOriginal) => ({ ...(await importOriginal<typeof import('./router')>()), useRoute: () => ({ name: 'hive' }) }))
vi.mock('./hooks', async (importOriginal) => ({ ...(await importOriginal<typeof import('./hooks')>()), useIsDesktop: () => true }))

describe('the classic hive page’s activity ticker', () => {
  it('makes a line about a message a button that opens it, and leaves other lines as words', async () => {
    const { ActivityTicker } = await import('../shell/Ambient')
    const page = renderToStaticMarkup(createElement(ActivityTicker))
    expect(page).toMatch(/<button[^>]*data-activity-link="#\/dot\/a_vega\?m=m_1"[^>]*>.*Vega.*said something.*<\/button>/)
    expect(page).toContain('woke up')
    expect(page.match(/data-activity-link/g)).toHaveLength(1)
  })
})
