import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent, Message } from '../../api/types'
import { chatPerson } from '../../lib/personNames'

/**
 * followups r4: a mind chat's person messages, rendered (FIXTURE messages, invented people). "You" is the viewer's own
 * principal only; an admin's audit (or the loopback operator's whole stream) shows others by name, the hive-password
 * operator as "the operator".
 */
const { Bubble, MeNotice } = await import('./Chat')
const agent = { id: 'a_vega01', name: 'Vega', hue: 200 } as unknown as Agent
const msg = (sender: string, text: string): Message => ({ id: `m_${text}`, agent_id: 'a_vega01', conversation_id: 'c_main', direction: 'in', sender, text, created_at: '2026-10-01T10:00:00Z' })
const people = [{ id: 'p_ada', name: 'Ada Brightwater' }, { id: 'p_rowan', name: 'Rowan Vale' }]
const render = (m: Message, me: { principal: string; person: null } | null | undefined) =>
  renderToStaticMarkup(createElement(Bubble, { m, agent, grouped: false, fresh: false, peerName: () => '', peerHue: () => 0, person: chatPerson(m.sender, { me, people }) }))

describe('a mind chat names whose words they are', () => {
  it('an admin auditing: their own is "You", on their side; another person by name, on the other side', () => {
    const ada = { principal: 'user:p_ada', person: null }
    const own = render(msg('user:p_ada', 'mine'), ada)
    expect(own).toContain('data-chat-sender="You"')
    expect(own).toContain('items-end')
    const rowan = render(msg('user:p_rowan', 'rowan'), ada)
    expect(rowan).toContain('Rowan Vale')
    expect(rowan).not.toContain('You')
    expect(rowan).toContain('items-start')
    const op = render(msg('user:operator', 'pw'), ada)
    expect(op).toContain('the operator')
    expect(op).not.toContain('You')
  })
  it('the hive-password operator: their own is "You"; a named person never is', () => {
    const operator = { principal: 'user:operator', person: null }
    expect(render(msg('user:operator', 'pw'), operator)).toContain('data-chat-sender="You"')
    const ada = render(msg('user:p_ada', 'ada'), operator)
    expect(ada).toContain('Ada Brightwater')
    expect(ada).not.toContain('You')
  })
})

describe('no /me: while it loads, and after it failed (followups-r5, Kimi r4)', () => {
  // useMe() gives me === undefined in both states; Chat passes `me ?? null`. Both forms are covered.
  for (const me of [undefined, null]) {
    it(`me ${String(me)}: nobody is "You"; people by name, else by principal without "user:"; nothing drawn as the viewer's`, () => {
      expect(chatPerson('user:p_ada', { me })).toEqual({ label: 'p_ada', mine: false })
      expect(chatPerson('user:p_ada', { me, people })).toEqual({ label: 'Ada Brightwater', mine: false })
      expect(chatPerson('user:operator', { me })).toEqual({ label: 'the operator', mine: false })
      expect(chatPerson('user:p_rowan', { me, people: null })).toEqual({ label: 'p_rowan', mine: false })
      const own = render(msg('user:p_ada', 'mine'), me)
      expect(own).not.toContain('data-chat-sender="You"')
      expect(own).toContain('items-start')
    })
  }
  it('after a failed /me the chat says its labels are degraded; while loading (or once read) it says nothing', () => {
    expect(renderToStaticMarkup(createElement(MeNotice, { show: true }))).toContain('Couldn’t load who you are')
    expect(renderToStaticMarkup(createElement(MeNotice, { show: false }))).toBe('')
  })
  it('the notice is shown only for a failed read (useMe().failed), and only where person messages are labelled', async () => {
    const fsName = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
    const chat = readFileSync(new URL('./Chat.tsx', import.meta.url).pathname, 'utf8')
    expect(chat).toContain('const { me, admin, failed: meFailed } = useMe()')
    expect(chat).toMatch(/<MeNotice show=\{meFailed && messages\.some\(/)
    const admin = readFileSync(new URL('../../lib/useAdmin.ts', import.meta.url).pathname, 'utf8')
    expect(admin).toContain("failed: res.status === 'error'")
  })
})
