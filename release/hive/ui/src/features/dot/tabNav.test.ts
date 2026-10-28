import { describe, expect, it } from 'vitest'
import { chatRoute, escapeFrom, tabStep } from './tabNav'
import { href, isPageRoute, parse } from '../../lib/router'
import dotSource from './DotPanel.tsx?raw'
import confirmSource from '../../ui/confirm.tsx?raw'

// mind-chat r1 item 3: a person opened Budget and could not find the conversation again.
describe('a mind panel never loses its chat', () => {
  it('leaving the chat is one Back away; coming back steps back to it; the other tabs replace each other', () => {
    expect(tabStep('chat', 'model', false)).toBe('push')
    expect(tabStep('model', 'chat', true)).toBe('back')
    expect(tabStep('model', 'memory', true)).toBe('replace')
    // a deep link straight to a tab has no chat entry behind it: the chat replaces it
    expect(tabStep('model', 'chat', false)).toBe('replace')
    expect(tabStep('chat', 'chat', false)).toBe('none')
  })
  it('Esc on Budget (Model) or any other tab returns to the chat; Esc on the chat closes the panel', () => {
    for (const t of ['mind', 'memory', 'schedule', 'model', 'tools'] as const) expect(escapeFrom(t)).toBe('chat')
    expect(escapeFrom('chat')).toBe('close')
  })
  it('a mind conversation has a stable, linkable address, and Recent conversations has its own', () => {
    expect(href(chatRoute('m_lyra'))).toBe('#/dot/m_lyra')
    expect(parse('#/dot/m_lyra')).toEqual({ name: 'dot', id: 'm_lyra', tab: undefined })
    expect(parse('#/dot/m_lyra/chat')).toEqual({ name: 'dot', id: 'm_lyra', tab: 'chat' })
    expect(href({ name: 'conversations' })).toBe('#/conversations')
    expect(parse('#/conversations')).toEqual({ name: 'conversations' })
    expect(isPageRoute('conversations')).toBe(true)
  })
  it('is wired: the panel uses the step rule, Esc goes back to the chat, the Budget meter opens the cap, "Back to chat" shows', () => {
    expect(dotSource).toContain('tabStep(tab, t, leftChat.current)')
    expect(dotSource).toContain("onEscape={escapeFrom(tab) === 'chat' ? () => setTab('chat') : undefined}")
    expect(dotSource).toContain('<Budget agent={agent} onOpen={onBudget} />')
    expect(dotSource).toContain('data-back-to-chat=""')
    expect(dotSource).not.toContain("navigate({ name: 'dot', id, tab: t }, { replace: true })")
  })
  it('an idle confirm host (the Model tab carries one) never takes Esc: it listens only while a question is open', () => {
    expect(confirmSource).toContain('useEscape(() => settle(false), !!pending && active)')
    expect(confirmSource).not.toContain('useEscape(() => active && pending && settle(false))')
  })
})
