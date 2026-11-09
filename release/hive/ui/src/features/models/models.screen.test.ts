import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, ProviderStatus } from '../../api/types'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace, type Compose } from '../../screens/screenSpace'
import modelsSource from './models.metta?raw'
import { modelsScreen, type KeyWork, type ModelsInput } from './data'
import type { PickRow } from './modelUtil'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The Models page end to end: invented providers, minds and a default → facts → MeTTa composes each screen → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}
const NOW = Date.parse('2026-03-01T12:00:00Z')

const provider = (name: string, label: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  name, label, local: false, needs_key: true, connected: false, source: null, key_hint: '', key_env: '', base_url: '', models: [], ...over,
})
const PROVIDERS: ProviderStatus[] = [
  provider('openrouter', 'OpenRouter', { connected: true, source: 'stored', key_hint: '…wxyz', account: { label: 'Garden team', usage: 2, limit: 10 } as ProviderStatus['account'],
    catalog: { count: 312, fetched_at: NOW / 1000 - 7200, error: null } }),
  provider('anthropic', 'Anthropic', { connected: true, source: 'env', key_hint: '…abcd', key_env: 'GARDEN_KEY' }),
  provider('openai', 'OpenAI'),
  provider('local', 'Local', { local: true, needs_key: false, connected: true }),
]
const row = (id: string, name: string, provider: string): PickRow => ({
  id, provider, name, short: id.split('/').slice(1).join('/'), local: false, featured: true, inPerM: null, outPerM: null, context: 0, inputs: ['text'], tools: true, reasoning: false, description: '',
})
const ROWS = [row('openrouter/acme/swift-2', 'Swift 2', 'openrouter'), row('anthropic/quill-4', 'Quill 4', 'anthropic')]
const mind = (id: string, name: string, model: string) => ({ id, name, model, hue: 120, status: 'awake' }) as unknown as Agent
const MINDS = [
  mind('m1', 'Wren', 'anthropic/quill-4'),
  ...Array.from({ length: 7 }, (_, i) => mind(`s${i}`, `Sparrow ${i + 1}`, 'openrouter/acme/swift-2')),
]
const none: KeyWork = { replacing: new Set(), confirming: new Set(), checking: new Set() }
const input = (over: Partial<ModelsInput> = {}): ModelsInput => ({ providers: PROVIDERS, rows: ROWS, agents: MINDS, def: null, work: none, now: NOW, ...over })

function page(over: Partial<ModelsInput> = {}, host: Partial<ScreenHost> = {}) {
  const { data, facts } = modelsScreen(input(over), compose)
  const plan = compose('models', facts)
  return { plan, data, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onOpen: () => {}, onAction: () => {}, ...host } })) }
}
const providerHtml = (html: string, label: string) => {
  const start = html.indexOf(`>${label}</span>`)
  return html.slice(start, html.indexOf('</li>', start))
}

describe('the Models page, composed by MeTTa', () => {
  it('while the providers load: the heading, a placeholder, and no provider cards', () => {
    const { plan, html } = page({ providers: null })
    expect(plan.parts.map((p) => p.order).slice(0, 3)).toEqual([11, 12, 14])
    expect(html).toContain('>Providers</h3>')
    expect(html).toContain('aria-label="Loading providers"')
    expect(html).not.toContain('ready</p>')
  })
  it('the providers: how many are ready, one card each, and where keys live', () => {
    const { html } = page()
    expect(html).toContain('3 of 4 ready')
    expect(html).toContain('aria-label="Providers"')
    expect(html.match(/data-screen="models-provider"/g)).toHaveLength(4)
    expect(html).toContain('Nothing a mind says can reveal a key.')
  })
  it('each provider says whether it is ready, connected or not, and what it pays with', () => {
    const { html } = page()
    const or = providerHtml(html, 'OpenRouter')
    expect(or).toContain('>Connected<')
    expect(or).toContain('Key …wxyz stored in the hive · Garden team · $2.00 of $10 used')
    expect(or).toContain('312 models in the catalogue · 2h ago')
    expect(providerHtml(html, 'Anthropic')).toContain("Key …abcd from GARDEN_KEY in the hive&#x27;s environment")
    const local = providerHtml(html, 'Local')
    expect(local).toContain('>Ready<')
    expect(local).not.toContain('Replace key')
    const openai = providerHtml(html, 'OpenAI')
    expect(openai).toContain('>Not connected<')
    expect(openai).toContain('Paste a key to use OpenAI models.')
  })
  it('a provider without a key offers a hidden field to paste one, with where to find it', () => {
    const openai = providerHtml(page().html, 'OpenAI')
    expect(openai).toContain('type="password"')
    expect(openai).toContain('aria-label="OpenAI API key"')
    expect(openai).toContain('placeholder="sk-…"')
    expect(openai).toMatch(/type="submit" disabled=""><svg[^>]*>.*?<\/svg>Connect<\/button>/)
    expect(openai).toContain('Find it at platform.openai.com → API keys.')
    expect(openai).toContain('href="https://platform.openai.com/api-keys"')
    expect(openai).toContain('Open')
    expect(openai).not.toContain('Cancel')
  })
  it('a provider that needs no key says so and has no field', () => {
    const offline = page({ providers: [provider('mock', 'Offline', { needs_key: false })] }).html
    expect(offline).toContain('Needs no key.')
    expect(offline).not.toContain('type="password"')
  })
  it('#/models/<provider> puts the focus in that provider\'s key field, and checking a key waits', () => {
    const html = page({ work: { ...none, focus: 'openai', checking: new Set(['openai']) } }).html
    expect(providerHtml(html, 'OpenAI')).toContain('data-autofocus=""')
    expect(providerHtml(html, 'OpenAI')).toContain('Checking…')
    expect(html.match(/data-autofocus/g)).toHaveLength(1)
    // and that provider's card carries the focus ring, marked current; no other card does
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    expect(html).toMatch(/<li aria-current="true" class="[^"]*ring-2 ring-accent\/60/)
  })
  it('a stored key can be replaced or removed, with a second press to remove; a key from the host only replaced', () => {
    const html = page().html
    expect(providerHtml(html, 'OpenRouter')).toContain('>Replace key</button>')
    expect(providerHtml(html, 'OpenRouter')).toContain('>Remove</button>')
    expect(providerHtml(html, 'Anthropic')).toContain('>Replace key</button>')
    expect(providerHtml(html, 'Anthropic')).not.toContain('>Remove</button>')
    const asking = providerHtml(page({ work: { ...none, confirming: new Set(['openrouter']) } }).html, 'OpenRouter')
    expect(asking).toContain('Remove this key from the hive?')
    expect(asking).toContain('Remove key</button>')
    expect(asking).toContain('Keep</button>')
    expect(asking).toContain('>Replace key</button>')
  })
  it('replacing a key shows the field with Replace and Cancel, and hides the other key buttons', () => {
    const or = providerHtml(page({ work: { ...none, replacing: new Set(['openrouter']) } }).html, 'OpenRouter')
    expect(or).toContain('aria-label="OpenRouter API key"')
    expect(or).toMatch(/Replace<\/button>/)
    expect(or).toContain('Cancel</button>')
    expect(or).not.toContain('>Replace key</button>')
    expect(or).not.toContain('>Remove</button>')
  })
  it('presses on a provider come back with its name; the key comes back only with Connect', () => {
    const { data } = page()
    const items = data['providers.all'] as { id: string }[]
    expect(items.map((i) => i.id)).toEqual(['openrouter', 'anthropic', 'openai', 'local'])
    expect(JSON.stringify(data)).not.toContain('sk-or-1')
  })
  it('the default for new minds: what it is and how it routes, or how to pick one; Clear when one is saved', () => {
    const unset = page().html
    expect(unset).toContain('Pick what the create flow should suggest first. Saved in this browser.')
    expect(unset).not.toContain('>Clear</button>')
    const routed = page({ def: { model: 'openrouter/acme/swift-2', options: { route: { sort: 'price' } } as never } }).html
    expect(routed).toContain('New minds start on Swift 2 · cheapest first. You can still change it for each mind.')
    expect(routed).toContain('>Clear</button>')
    expect(page({ def: { model: 'anthropic/quill-4' } }).html).toContain('New minds start on Quill 4. You can still')
    // a saved default the hive no longer offers: how to pick one, and Clear
    const gone = page({ def: { model: 'acme/retired' } }).html
    expect(gone).toContain('Pick what the create flow should suggest first.')
    expect(gone).toContain('>Clear</button>')
  })
  it('places the model picker where the page offers it', () => {
    const { plan, html } = page({}, { islands: { 'model-picker': createElement('p', null, 'Every model') } })
    expect(plan.parts.find((p) => p.block === 'island')?.props.name).toBe('model-picker')
    expect(html).toContain('Every model')
    expect(html.indexOf('Default for new minds')).toBeLessThan(html.indexOf('Every model'))
  })
  it('the models in use, the most used first, each with its minds as orbs that open their model settings', () => {
    const { html } = page()
    expect(html).toContain('>In use</h3>')
    expect(html.indexOf('Swift 2')).toBeLessThan(html.indexOf('Quill 4'))
    expect(html).toContain('openrouter/acme/swift-2')
    expect(html).toContain('aria-label="Wren, open model settings"')
    expect(html.match(/open model settings/g)).toHaveLength(7)
    expect(html).toContain('+1')
    expect(page({ agents: [] }).html).not.toContain('In use')
  })
  it('Create a mind and where costs show', () => {
    const { html } = page()
    expect(html).toContain('>Create a mind</button>')
    expect(html).toContain('Costs show on the Usage view as minds talk.')
  })
  it('Cosmos draws the same atoms on a 3D stage', () => {
    const { data, facts } = modelsScreen(input(), compose)
    const plan = space.compose('models', 'cosmos', facts)
    expect(plan.space).toBe('3d')
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data } }))).toContain('OpenRouter')
  })
  it('every part of every Models screen can be reached', () => {
    // each screen's own parts and the orders its resource declaration takes
    const declared = new Map<string, Set<number>>()
    for (const [, screen] of modelsSource.matchAll(/^\(Screen (\S+) /gm)) declared.set(screen, new Set(space.orders(screen)))
    expect(declared.get('models')?.has(12)).toBe(true)
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})
