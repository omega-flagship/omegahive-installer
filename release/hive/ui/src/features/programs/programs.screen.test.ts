import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Program } from '../../api/types'
import { DRAWN_BLOCKS, Screen, scopedHost, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { pressed, programsResource, programsScreen, type Can, type Compose, type IdentityOf } from './data'

vi.setConfig({ testTimeout: 20_000 })

/** The Apps page end to end: invented apps → facts → MeTTa composes the page and each app's card → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}
const ALL: Can = { activity: true, access: true }
const own: IdentityOf = () => null

const app = (id: string, name: string, over: Partial<Program> = {}): Program => ({
  id, name, version: '1.0.0', description: `${name} keeps the garden notes.`, icon: 'spark', capabilities: [], source: 'built-in',
  enabled: true, error: null, ...over,
})
const APPS: Program[] = [
  app('ledger', 'Ledger', { capabilities: ['goals:read', 'goals:write', 'seeds:count'] }),
  app('garden', 'Garden', { enabled: false, source: 'plugin-dir', description: '' }),
  app('almanac', 'Almanac', { enabled: false, error: 'missing the page on frost dates' }),
]

function page(programs: Program[] | null, error: string | null = null, can: Can = ALL, host: Partial<ScreenHost> = {}, identityOf: IdentityOf = own) {
  const { data, facts } = programsScreen(programs, error, can, identityOf, compose)
  const plan = compose('programs', facts)
  return { plan, data, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onAction: () => {}, ...host } })) }
}
/** The markup of each row MeTTa put these parts in (`data-screen-row`), whole: every div it opens is closed. */
const rows = (html: string, name: string): string[] => {
  const out: string[] = []
  for (const m of html.matchAll(new RegExp(`<div data-screen-row="${name}"`, 'g'))) {
    let depth = 0
    for (const t of html.slice(m.index).matchAll(/<div\b|<\/div>/g)) {
      depth += t[0] === '</div>' ? -1 : 1
      if (depth === 0) { out.push(html.slice(m.index, m.index + t.index + 6)); break }
    }
  }
  return out
}
const labels = (html: string, attr: string) => [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => m[1])

describe('the Apps page, composed by MeTTa', () => {
  it('while loading: the words on what apps are, and a placeholder', () => {
    const { plan, html } = page(null)
    expect(plan.parts.map((p) => p.block)).toEqual(['header', 'waiting', 'island', 'island'])
    expect(html).toContain('A program supplies the meaning of a piece of work')
    expect(html).toContain('aria-label="Loading apps"')
    expect(html).not.toContain('<h2 class="text-xl')   // the page frame shows the title
  })
  it('could not read them, and has none: says so with the reason, and offers Try again', () => {
    const got: string[] = []
    const { html } = page(null, 'The hive did not answer', ALL, { onAction: (a) => got.push(a) })
    expect(html).toContain('Apps are not available')
    expect(html).toContain('The hive did not answer. This hive may be older than the programs API.')
    expect(html).toMatch(/>Try again<\/button>/)
    expect(html).not.toContain('No programs found')
  })
  it('none found: where apps come from', () => {
    const { html, plan } = page([])
    expect(html).toContain('No programs found')
    expect(html).toContain('then Reload.')
    expect(plan.parts.some((p) => p.block === 'stack')).toBe(false)
  })
  it('a refresh that failed keeps the apps on screen and says so, with Retry', () => {
    const { html } = page(APPS, 'The hive did not answer')
    expect(html).toContain('Could not refresh: The hive did not answer Showing the last loaded data.')
    expect(html).toMatch(/>Retry<\/button>/)
    expect(html).toContain('Ledger')
    expect(html).not.toContain('Apps are not available')
  })
  it('each app: its name, version, source, and how it stands', () => {
    const { html } = page(APPS)
    expect(html).toContain('data-tour="programs-list"')
    for (const id of ['ledger', 'garden', 'almanac']) expect(html).toContain(`data-tour="program-card-${id}"`)
    expect(html).toContain('v1.0.0 · Built-in · ledger')
    expect(html).toContain('v1.0.0 · Plugin dir · garden')
    expect(html).toMatch(/text-good[^>]*>Enabled</)
    expect(html).toMatch(/>Disabled by an operator</)
    expect(html).toMatch(/text-bad[^>]*>Failed to load</)
    expect(html).toContain('Ledger keeps the garden notes.')
    expect(html).toContain('No description.')
    expect(html).toContain('<pre aria-label="Why it failed to load"')
    expect(html).toContain('missing the page on frost dates')
  })
  it('what each app may do, in plain words where the hive has them', () => {
    const { html } = page(APPS)
    expect(html).toContain('What it may do')
    expect(html).toContain('>reads tasks<')
    expect(html).toContain('>posts tasks<')
    expect(html).toContain('>seeds:count<')
    expect(html).not.toContain('>goals:read<')
    expect(html.match(/No capabilities\./g)).toHaveLength(2)
  })
  it('the switch, where it runs and Open sit side by side; no switch for an app that failed to load, no Open for one turned off', () => {
    const { html } = page(APPS)
    const [ledger, garden, almanac] = rows(html, 'app-controls')
    expect(labels(ledger, 'aria-label')).toEqual(['Disable Ledger', 'Where Ledger runs', 'Open Ledger'])
    expect(labels(garden, 'aria-label')).toEqual(['Enable Garden', 'Where Garden runs'])
    expect(labels(almanac, 'aria-label')).toEqual(['Where Almanac runs'])
    expect(ledger).toContain('aria-checked="true"')
    expect(garden).toContain('aria-checked="false"')
    expect(ledger).toMatch(/style="background[^>]*>.*Open<\/button>/)   // the primary fill
  })
  it('without the record of app actions or app access: no activity, no Where it runs, no access dialog', () => {
    const islands = { 'app-activity': createElement('h2', { id: 'app-activity-h' }, 'What apps did lately'), 'app-access': createElement('div', { role: 'dialog' }, 'Where Ledger runs') }
    const full = page(APPS, null, ALL, { islands })
    expect(full.html).toContain('id="app-activity-h"')
    expect(full.html.indexOf('id="app-activity-h"')).toBeGreaterThan(full.html.indexOf('Almanac'))
    expect(full.html).toContain('role="dialog"')
    const bare = page(APPS, null, { activity: false, access: false }, { islands })
    expect(bare.html).not.toContain('app-activity-h')
    expect(bare.html).not.toContain('role="dialog"')
    expect(bare.html).not.toContain('runs')
    expect(labels(rows(bare.html, 'app-controls')[0], 'aria-label')).toEqual(['Disable Ledger', 'Open Ledger'])
    // access alone (an older hive with activations but no activity record)
    const access = page(APPS, null, { activity: false, access: true }, { islands })
    expect(access.html).not.toContain('app-activity-h')
    expect(access.html).toContain('aria-label="Where Ledger runs"')
  })
  it('the identity the person wears apps in shows under the name', () => {
    const { html } = page(APPS, null, ALL, {}, (p) => (p.id === 'ledger' ? 'The Ledger of Seasons' : null))
    expect(html).toContain('The Ledger of Seasons')
  })
  it('a press comes back with the app it came from', () => {
    const got: [string, ScreenItem, boolean | undefined][] = []
    const card = scopedHost({ data: {}, onAction: (a, it, v) => got.push([a, it, v]) }, { id: 'ledger' })
    card.onAction!('switch', { id: 'ledger', label: 'Use in this hive', on: true }, false)
    card.onAction!('open', {})
    card.onAction!('access', {})
    expect(got.map(([a, it, v]) => pressed(a, it, v))).toEqual([
      { kind: 'switch', id: 'ledger', on: false }, { kind: 'open', id: 'ledger' }, { kind: 'access', id: 'ledger' }])
    expect(pressed('retry', {})).toEqual({ kind: 'retry' })
    expect(pressed('open', {})).toBeNull()
    expect(pressed('sweep', { scope: ['ledger'] })).toBeNull()
  })
  it('the store’s apps as one resource state', () => {
    expect(programsResource(null, null)).toEqual({ status: 'loading', error: undefined })
    expect(programsResource(null, 'no')).toEqual({ status: 'error', error: 'no' })
    expect(programsResource([], null)).toEqual({ status: 'empty', error: undefined })
    expect(programsResource(APPS, 'no')).toEqual({ status: 'ready', error: 'no' })
  })
  it('the guards stay clean, nothing falls back, every block is drawn, and every part can be reached', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(page(APPS).plan.missing).toEqual([])
    expect(DRAWN_BLOCKS).toContain('paragraph')
    expect(space.explain('programs-app', 30)?.words).toBe('a paragraph of words')
    for (const screen of ['programs', 'programs-app']) {
      expect(space.orders(screen).length, screen).toBeGreaterThan(0)
      expect(space.orders(screen).filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
    }
  })
})

describe('each card wears its app (the per-item look)', () => {
  it('a card carries its app\'s colour variables, type and motif, and its icon tile is lit while the app is on', () => {
    const app = (over: Record<string, unknown>) => ({ id: 'ledger', name: 'Ledger', version: '1.0.0', source: 'built-in', description: 'Invented sums', enabled: true, error: null, capabilities: [], icon: 'coin', ...over }) as never
    const lookOf = () => ({ style: { '--app-accent': '#123456' } as never, type: 'serif', motif: 'grid' })
    const compose = (screen: string, facts: Parameters<ScreensSpace['compose']>[2]) => ScreensSpace.open().compose(screen, 'classic', facts)
    const { data, facts } = programsScreen([app({})], null, { activity: false, access: false }, () => null, compose, lookOf)
    const html = renderToStaticMarkup(createElement(Screen, { plan: compose('programs', facts), host: { data, framed: true } }))
    expect(html).toMatch(/<li[^>]*data-app-type="serif"[^>]*style="--app-accent:#123456"/)
    expect(html).toContain('class="app-motif" data-motif="grid"')
    expect(html).toMatch(/text-accent shadow-[^"]*"><svg/)          // the lit icon tile
    const off = programsScreen([app({ enabled: false })], null, { activity: false, access: false }, () => null, compose, () => null)
    const offHtml = renderToStaticMarkup(createElement(Screen, { plan: compose('programs', off.facts), host: { data: off.data, framed: true } }))
    expect(offHtml).not.toContain('data-app-type')
    expect(offHtml).toMatch(/text-ink-3"><svg/)                         // an app that is off: the tile is quiet
  })
})
