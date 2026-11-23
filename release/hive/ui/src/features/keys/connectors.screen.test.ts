// Purpose: test the You page's connector screens end to end (connectors.metta through connectors.ts): invented
// connectors → facts → MeTTa composes the panel and each card → drawn; every part can be reached, no secret is drawn,
// and a card's presses and typing come back scoped to it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorRow, ConnectorsStatus } from '../../api/connectors'
import { Screen, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace, type Compose } from '../../screens/screenSpace'
import connectorsSource from './connectors.metta?raw'
import { connectorsPanel, type ConnectorsInput, type ConnectorWork } from './connectors'

vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}

const row = (id: ConnectorRow['id'], over: Partial<ConnectorRow> = {}): ConnectorRow => ({
  id, kind: id === 'whatsapp' || id === 'agentverse' ? 'served' : 'calls', exclusive: id === 'whatsapp', set: false, fields: [],
  minds: [], ...over,
})
const STATUS: ConnectorsStatus = {
  store: { open: true, home: 'keychain', made: true, warning: null, reason: null },
  connectors: [row('home_assistant', { set: true, fields: ['token', 'url'], minds: ['a_wren'] }), row('librelinkup'),
    row('whatsapp', { set: true, minds: ['a_moss'] }), row('agentverse')],
  minds: [{ id: 'a_wren', name: 'Wren', running: true }, { id: 'a_moss', name: 'Moss', running: false }],
}
const idle: ConnectorWork = { forms: {}, confirming: new Set(), busy: new Set(), restart: {}, errors: {} }
const input = (over: Partial<ConnectorsInput> = {}): ConnectorsInput => ({ status: STATUS, error: undefined, unsupported: false,
  work: idle, ...over })

function draw(over: Partial<ConnectorsInput> = {}, host: Partial<ScreenHost> = {}) {
  const panel = connectorsPanel(input(over), compose)
  const plan = compose('profile', { counts: {}, flags: {}, values: {} })
  const data = { 'connectors.panel': [panel] }
  const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, islands: {}, onOpen: () => {}, onAction: () => {}, ...host } }))
  return { panel, html }
}
const card = (html: string, title: string) => {
  const start = html.indexOf(`>${title}</`)
  const end = html.indexOf('data-screen="profile-connector"', start)
  return html.slice(start, end === -1 ? undefined : end)
}

describe('the You page connectors', () => {
  it('shows each connector, where its key lives, and which of your minds have it', () => {
    const { html } = draw()
    expect(html).toContain('Your connectors')
    expect(html).toContain('login Keychain')
    const ha = card(html, 'Home Assistant')
    expect(ha).toContain('Connected')
    expect(ha).toContain('On Wren')
    expect(ha).toContain('Long-lived access token')
    expect(ha).toContain('Disconnect')
    expect(card(html, 'LibreLinkUp')).toContain('LibreLinkUp password')
    expect(card(html, 'WhatsApp')).toContain('On one of your minds at a time')
    expect(card(html, 'Agentverse')).not.toContain('password')
  })

  it('draws no secret: a token or password field is always empty and type password', () => {
    const { html } = draw({ work: { ...idle, forms: { home_assistant: { url: 'http://ha.local:8123' } } } })
    expect(html).toContain('value="http://ha.local:8123"')
    expect(html.match(/type="password"[^>]*value="([^"]*)"/g)?.every((m) => m.endsWith('value=""'))).toBe(true)
  })

  it('says when the key protects less, when the store is shut, and when a change waits for a restart or failed', () => {
    const warn = draw({ status: { ...STATUS, store: { ...STATUS.store, home: 'fallback-file', warning: 'systemd 255 here, so …' } } }).html
    expect(warn).toContain('systemd 255 here')
    const shut = draw({ status: { ...STATUS, store: { open: false, home: null, made: true, warning: null, reason: 'the login Keychain did not answer' } } }).html
    expect(shut).toContain('can&#x27;t open connector logins right now: the login Keychain did not answer')
    const waiting = draw({ work: { ...idle, restart: { whatsapp: ['a_wren'] }, errors: { librelinkup: 'LibreLinkUp login failed' },
      confirming: new Set(['home_assistant']) } }).html
    expect(card(waiting, 'WhatsApp')).toContain('Takes effect when Wren next starts')
    expect(card(waiting, 'LibreLinkUp')).toContain('LibreLinkUp login failed')
    expect(card(waiting, 'Home Assistant')).toContain('take it off your minds?')
    expect(draw({ status: { ...STATUS, minds: [] } }).html).toContain('You have no Omega minds yet')
  })

  it('loads, fails and stays on screen when a refresh fails', () => {
    expect(draw({ status: null }).html).toContain('Loading your connectors')
    expect(draw({ status: null, error: new Error('down') }).html).toContain('Could not load your connectors')
    expect(draw({ error: new Error('down') }).html).toContain('Could not refresh your connectors')
    expect(draw({ status: null, unsupported: true }).html).toContain('doesn&#x27;t keep connectors yet')
  })

  it('hands back a press and a typed field scoped to the card', () => {
    const { panel } = draw()
    const items = panel.data['connectors.items'] as ScreenItem[]
    expect(items.map((i) => i.id)).toEqual(['home_assistant', 'librelinkup', 'whatsapp', 'agentverse'])
    const ha = items[0]
    expect(ha.data).toMatchObject({ 'connector.minds': [{ id: 'a_wren', name: 'Wren', on: true }, { id: 'a_moss', name: 'Moss', on: false }] })
  })

  it('every part of every connector screen can be reached', () => {
    draw({ status: { ...STATUS, store: { ...STATUS.store, warning: 'w' } }, work: { ...idle, restart: { whatsapp: ['a_wren'] },
      errors: { librelinkup: 'x' }, confirming: new Set(['home_assistant']) } })
    draw({ status: { ...STATUS, minds: [] } })
    draw({ status: { ...STATUS, store: { open: false, home: null, made: true, warning: null, reason: 'r' } } })
    draw({ status: null })
    draw({ status: null, error: new Error('down') })
    draw({ error: new Error('down') })
    draw({ status: null, unsupported: true })
    const declared = new Map<string, Set<number>>()
    for (const [, screen] of connectorsSource.matchAll(/^\(Screen (\S+) /gm)) declared.set(screen, new Set(space.orders(screen)))
    expect([...declared.keys()]).toEqual(['profile-connectors', 'profile-connector'])
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})
