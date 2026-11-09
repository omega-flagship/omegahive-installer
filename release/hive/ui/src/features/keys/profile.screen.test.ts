import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Me } from '../../api/client'
import type { Agent, KeyInfo } from '../../api/types'
import type { ResourceState } from '../../lib/useResource'
import { DRAWN_BLOCKS, Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace, type Compose } from '../../screens/screenSpace'
import profileSource from './profile.metta?raw'
import { profileScreen, type KeyWork, type ProfileInput } from './data'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The You page end to end: an invented person, keys and minds → facts → MeTTa composes each screen → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}

const mind = (id: string, name: string, assigned: boolean) => ({ id, name, hue: 200, status: 'awake' as const, assigned })
const key = (id: string, provider: string, label: string, over: Partial<KeyInfo> = {}): KeyInfo => ({
  id, provider, provider_label: provider === 'openrouter' ? 'OpenRouter' : 'Anthropic', label, owner: 'user:operator', hint: `…${id.slice(-4)}`,
  default: false, created_at: null, spent_usd: 0, minds: [], ...over,
})
const KEYS: KeyInfo[] = [
  key('k_garden', 'openrouter', 'Garden', { default: true, spent_usd: 1.5, account: { usage: 2, limit: 10 } as KeyInfo['account'],
    minds: [mind('m1', 'Wren', true), mind('m2', 'Moss', false)] }),
  key('k_spare', 'openrouter', 'Spare', { account: { usage: 0.5, limit: null } as KeyInfo['account'] }),
  key('k_shed', 'anthropic', 'Shed', { env: true, default: true, account: { error: 'The provider did not answer' } as KeyInfo['account'] }),
  key('k_barn', 'anthropic', 'Barn', { minds: [mind('m3', 'Fern', true)] }),
]
const AGENTS = [{ model: 'openrouter/acme/swift-2' }, { model: 'mock/echo' }, { model: 'anthropic/quill-4' }] as Agent[]
const ME_PERSON: ResourceState<Me> = { status: 'ready', refreshing: false, error: undefined,
  data: { principal: 'p_1', kind: 'sso', role: 'member', expires_at: null, person: { id: 'p_1', email: 'wren@example.org', name: 'Wren Hollow' }, signin: 'google' } }
const ME_OPERATOR: ResourceState<Me> = { status: 'ready', refreshing: false, error: undefined,
  data: { principal: 'operator', kind: 'password', role: 'admin', expires_at: null, person: null, signin: 'password' } }
const none: KeyWork = { editing: new Set(), confirming: new Set() }
const input = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  me: ME_PERSON, keys: KEYS, keysError: undefined, agents: AGENTS, connected: true, signingOut: false, adding: false, work: none, ...over,
})
const ISLANDS = Object.fromEntries(['personal-mind', 'google-connector', 'person-notices', 'look', 'clock', 'demo-ask', 'ask-memory', 'own-limit', 'add-key']
  .map((n) => [n, createElement('p', null, `[${n}]`)]))

function page(over: Partial<ProfileInput> = {}, host: Partial<ScreenHost> = {}) {
  const { data, facts } = profileScreen(input(over), compose)
  const plan = compose('profile', facts)
  return { plan, data, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, islands: ISLANDS, onOpen: () => {}, onAction: () => {}, ...host } })) }
}
const islands = (p: { plan: { parts: { block: string | null; props: Record<string, unknown> }[] } }) => p.plan.parts.filter((x) => x.block === 'island').map((x) => x.props.name)
/** One key's card, from its label to the end of its card. */
const card = (html: string, label: string) => {
  const start = html.indexOf(`>${label}</`)
  const end = html.indexOf('data-screen="profile-key"', start)
  return html.slice(start, end === -1 ? undefined : end)
}

describe('the You page, composed by MeTTa', () => {
  it('the new rename block is known to MeTTa and drawn by the renderer; the guards stay clean', () => {
    expect(space.blocks()).toContain('rename')
    expect(DRAWN_BLOCKS).toContain('rename')
    expect(space.screens()).toEqual(expect.arrayContaining(['profile', 'profile-provider', 'profile-key']))
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(page().plan.missing).toEqual([])
    expect(space.explain('profile-key', 14)?.words).toBe('a field for changing a name')
  })
  it('who you are: your name and orb, how you signed in, and Sign out', () => {
    const { html } = page()
    expect(html).toContain('>Wren Hollow</span>')
    expect(html).toContain('wren@example.org · Signed in with Google · Member')
    expect(html).toContain('>Sign out</button>')
    expect(html.indexOf('Wren Hollow')).toBeLessThan(html.indexOf('Sign out'))
    expect(html).toContain('data-screen-row="who"')
    expect(html).toContain('style="width:52px;height:52px"')   // your orb at its full size again
    const operator = page({ me: ME_OPERATOR }).html
    expect(operator).toContain('>Operator</span>')
    expect(operator).toContain('Operator (admin)')
    const checking = page({ me: { status: 'loading', data: undefined, error: undefined, refreshing: false } }).html
    expect(checking).toContain('>You</span>')
    expect(checking).toContain('Checking who you are…')
  })
  it('places the panels the page draws itself, in order, and the monthly total only for a person', () => {
    expect(islands(page())).toEqual(['personal-mind', 'google-connector', 'person-notices', 'look', 'clock', 'demo-ask', 'ask-memory', 'own-limit'])
    expect(islands(page({ me: ME_OPERATOR }))).not.toContain('own-limit')
    const { html } = page()
    expect(html.indexOf('[ask-memory]')).toBeLessThan(html.indexOf('Your keys'))
    expect(html.indexOf('A key stays inside the hive')).toBeLessThan(html.indexOf('[own-limit]'))
  })
  it('while your keys load: the heading, Add a key, a placeholder, and no cards', () => {
    const { plan, html } = page({ keys: null })
    expect(plan.parts.map((p) => p.order)).toEqual(expect.arrayContaining([31, 32, 40, 60]))
    expect(html).toContain('>Your keys</h3>')
    expect(html).toContain('aria-label="Loading your keys"')
    expect(html).toContain('Add a key</button>')
    expect(html).not.toContain('spent through this hive')
    expect(html).toContain('data-tour="your-keys"')
  })
  it('when they could not be read: says why, with Try again', () => {
    const { plan, html } = page({ keys: null, keysError: new Error('The hive is restarting') })
    expect(plan.parts.map((p) => p.order)).toEqual(expect.arrayContaining([43, 44]))
    expect(html).toContain('Could not load your keys')
    expect(html).toContain('The hive is restarting')
    expect(html).toContain('>Try again</button>')
    expect(html).not.toContain('Loading your keys')
  })
  it('with no keys yet: how to add one', () => {
    const { html } = page({ keys: [] })
    expect(html).toContain('No keys yet')
    expect(html).toContain('Add an OpenRouter key to give minds every major model')
    expect(html).not.toContain('spent through this hive')
  })
  it('your keys: what they spent, the minds on paid models, and one group per provider in the hive\'s order', () => {
    const { html, data } = page()
    expect(html).toContain('$1.50 spent through this hive · 2 minds on paid models')
    expect(html).toContain('aria-label="Your keys by provider"')
    expect(html).toContain('aria-label="OpenRouter keys"')
    expect(html).toContain('aria-label="Anthropic keys"')
    expect(html.indexOf('OpenRouter')).toBeLessThan(html.indexOf('Anthropic'))
    expect(html.match(/data-screen="profile-key"/g)).toHaveLength(4)
    const groups = data['keys.groups'] as { id: string; data: Record<string, unknown> }[]
    expect(groups.map((g) => g.id)).toEqual(['openrouter', 'anthropic'])
    expect((groups[0].data['group.keys'] as { id: string }[]).map((k) => k.id)).toEqual(['k_garden', 'k_spare'])
    expect(page({ agents: [AGENTS[0]] }).html).toContain('· 1 mind on paid models')
  })
  it('each key: its name to rename it, its last characters, the default badge, and what its account has used', () => {
    const { html } = page()
    const garden = card(html, 'Garden')
    expect(html).toMatch(/<button type="button"[^>]*>Garden<\/button>/)
    expect(garden).toContain('…rden')
    expect(garden).toContain('Hive default')
    expect(garden).toContain('$1.50 through this hive')
    expect(garden).toContain('$2.00 used on the account of $10')
    expect(garden).toContain('aria-label="Check the key and its credits"')
    const spare = card(html, 'Spare')
    expect(spare).not.toContain('Hive default')
    expect(spare).toContain('$0.50 used on the account, no limit')
    // a key from the hive's environment: not renamed, made default or removed here
    expect(html).toMatch(/<span class="[^"]*">Shed<\/span>/)
    const shed = card(html, 'Shed')
    expect(shed).toContain('…shed · environment')
    expect(shed).toContain('Hive default')
    expect(shed).toContain('role="status"')
    expect(shed).toContain('The provider did not answer')
    expect(shed).not.toContain('>Remove</button>')
    expect(shed).not.toContain('Make default')
  })
  it('which minds a key pays for, each opening its model settings; or that it pays for none yet', () => {
    const { html } = page()
    const garden = card(html, 'Garden')
    expect(garden).toContain('Pays for')
    expect(garden).toContain('aria-label="Wren, open model settings"')
    expect(garden).toContain('aria-label="Moss (as the default), open model settings"')
    expect(card(html, 'Spare')).toContain('Pays for no minds yet')
  })
  it('Make default for a key that is not; Remove asks again, naming the minds it moves', () => {
    const { html } = page()
    expect(card(html, 'Garden')).not.toContain('Make default')
    expect(card(html, 'Spare')).toContain('>Make default</button>')
    expect(card(html, 'Barn')).toContain('>Remove</button>')
    const asking = page({ work: { ...none, confirming: new Set(['k_barn', 'k_spare']) } }).html
    const barn = card(asking, 'Barn')
    expect(barn).toContain('Remove this key?')
    expect(barn).toContain('>Remove, move 1 to default</button>')
    expect(barn).toContain('>Keep</button>')
    expect(barn).not.toContain('>Remove</button>')
    expect(barn).toContain('>Make default</button>')
    expect(card(asking, 'Spare')).toContain('>Remove</button>')
    expect(card(asking, 'Spare')).toContain('Remove this key?')
  })
  it('renaming a key: a field holding its name in place of the name, capped at 60 characters', () => {
    const { html } = page({ work: { ...none, editing: new Set(['k_spare']) } })
    expect(html).toContain('aria-label="Key name"')
    expect(html).toContain('value="Spare"')
    expect(html).toContain('maxLength="60"')
    expect(html).not.toMatch(/>Spare<\/button>/)
    expect(html.match(/aria-label="Key name"/g)).toHaveLength(1)
  })
  it('adding a key: the page\'s own form in place of Add a key', () => {
    const p = page({ adding: true })
    expect(islands(p)).toContain('add-key')
    expect(p.html).not.toContain('Add a key</button>')
    expect(islands(page())).not.toContain('add-key')
  })
  it('no key\'s secret is ever in the page data', () => {
    const { data } = page()
    const text = JSON.stringify(data)
    expect(text).not.toMatch(/\bsk-/)
    expect(text).toContain('…rden')
  })
  it('Cosmos draws the same atoms on a 3D stage', () => {
    const { data, facts } = profileScreen(input(), compose)
    const plan = space.compose('profile', 'cosmos', facts)
    expect(plan.space).toBe('3d')
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data } }))).toContain('Garden')
  })
  it('every part of every You screen can be reached', () => {
    // the cases the other tests did not draw
    page({ signingOut: true })
    page({ connected: false })
    page({ keys: [key('k_hay', 'anthropic', 'Hay', { env: true })] })
    const declared = new Map<string, Set<number>>()
    for (const [, screen] of profileSource.matchAll(/^\(Screen (\S+) /gm)) declared.set(screen, new Set(space.orders(screen)))
    expect(declared.get('profile')?.has(40)).toBe(true)
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})
