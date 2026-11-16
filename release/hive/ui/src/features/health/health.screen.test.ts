import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HealthIssue, HealthOverview, MindHealth } from '../../api/types'
import type { ResourceState } from '../../lib/useResource'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import healthSource from './health.metta?raw'
import { healthScreen, openKey, troubled, type Compose, type Show } from './data'
import { rememberedCompose } from '../../screens/screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The Health page end to end: invented checks → facts → MeTTa composes the page, each mind and each problem → drawn. */
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

const issue = (over: Partial<HealthIssue> = {}): HealthIssue => ({
  kind: 'error', severity: 'medium', meaning: 'A command failed to parse', hint: 'Check the brackets.', count: 3, skill: 'reply',
  example: { command: '(say "hi"', result: 'unbalanced' }, last_at: '2026-03-01T10:00:00Z', iteration: null, recent: true, ...over,
})
const mind = (id: string, name: string, health: MindHealth['health'], issues: HealthIssue[] = []): MindHealth =>
  ({ id, name, swarm_id: null, status: 'awake', health, issues, checked_commands: 10 })
const OVERVIEW: HealthOverview = {
  minds: [
    mind('m1', 'Wren', 'high', [issue({ kind: 'crashed', severity: 'high', meaning: 'The mind stopped' })]),
    mind('m2', 'Ada', 'medium', [issue(), issue({ kind: 'waiting', severity: 'low', meaning: 'Waiting for a yes', recent: false, last_at: null })]),
    mind('m3', 'Juniper', 'ok'),
  ],
  totals: { high: 1, medium: 1, low: 0, ok: 1 },
}
const ready = (data: HealthOverview, error?: unknown): ResourceState<HealthOverview> => ({ status: 'ready', data, error, refreshing: false })
const state = (status: 'loading' | 'unsupported' | 'error', error?: unknown): ResourceState<HealthOverview> => ({ status, data: undefined, error, refreshing: false })

function page(res: ResourceState<HealthOverview>, show: Show = 'problems', open: ReadonlySet<string> = new Set(), host: Partial<ScreenHost> = {}) {
  const { data, facts } = healthScreen(res, show, open, NOW, compose)
  const plan = compose('health', facts)
  return { plan, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onOpen: () => {}, onAction: () => {}, ...host } })) }
}
const blocks = (res: ResourceState<HealthOverview>, show: Show = 'problems') => page(res, show).plan.parts.map((p) => p.block)

describe('the Health page, composed by MeTTa', () => {
  it('places its three islands first, whatever the checks say, and draws what the page offers', () => {
    for (const res of [state('loading'), state('unsupported'), state('error', new Error('x')), ready(OVERVIEW)]) {
      expect(page(res).plan.parts.slice(0, 3).map((p) => [p.block, p.props.name])).toEqual([['island', 'health-mind'], ['island', 'idle-minds'], ['island', 'sleep-and-spend']])
    }
    const islands = { 'health-mind': createElement('p', null, 'Told of alerts'), 'idle-minds': createElement('section', { id: 'idle-minds' }, 'Idle'), 'sleep-and-spend': createElement('p', null, 'Spend') }
    const { html } = page(ready(OVERVIEW), 'problems', new Set(), { islands })
    expect(html).toContain('Told of alerts')
    expect(html).toContain('id="idle-minds"')   // the #/health/idle scroll target
    expect(html.indexOf('Told of alerts')).toBeLessThan(html.indexOf('Spend'))
  })
  it('while loading, unsupported or failed: says so plainly, with no totals and no empty state', () => {
    expect(blocks(state('loading')).slice(3)).toEqual(['notice'])
    expect(page(state('loading')).html).toContain('Checking every mind')
    const unsupported = page(state('unsupported')).html
    expect(unsupported).toContain('does not report mind health yet')
    expect(unsupported).not.toContain('Nothing is failing')
    const failed = page(state('error', new Error('The hive said no')))
    expect(failed.html).toContain('Could not check health')
    expect(failed.html).toContain('The hive said no')
    expect(failed.html).toContain('>Try again</button>')
    expect(failed.html).not.toContain('Minds by health')
  })
  it('a failed refresh keeps the last checks on screen, says so, and offers Retry', () => {
    const { html } = page(ready(OVERVIEW, new Error('Timed out')))
    expect(html).toContain('Could not refresh: Timed out Showing the last loaded data.')
    expect(html).toContain('>Retry</button>')
    expect(html).toContain('Wren')
  })
  it('the totals, the choice of which minds to show, and Check again', () => {
    const { html } = page(ready(OVERVIEW))
    expect(html).toContain('aria-label="Minds by health"')
    for (const words of ['1 needs attention', '1 errors', '0 minor', '1 healthy']) expect(html).toContain(words)
    expect(html).toContain('aria-label="Which minds to show"')
    expect(html).toMatch(/aria-checked="true"(?:(?!<\/button>).)*>Problems</)
    expect(html).toContain('>Check again</button>')
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>Check again/)
  })
  it('while a refresh runs, Check again waits and nothing else on the page does', () => {
    const { html } = page({ ...ready(OVERVIEW), refreshing: true }, 'all')
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Check again/)
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>(?:Problems|All minds)</)
  })
  it('Problems shows minds with a problem; All minds shows every mind', () => {
    expect(troubled(OVERVIEW.minds[2])).toBe(false)
    const problems = page(ready(OVERVIEW)).html
    expect(problems).toContain('aria-label="Minds with problems"')
    expect(problems).toContain('Wren')
    expect(problems).not.toContain('Juniper')
    const all = page(ready(OVERVIEW), 'all').html
    expect(all).toContain('aria-label="All minds"')
    expect(all).toContain('Juniper')
    expect(all.indexOf('Wren')).toBeLessThan(all.indexOf('Juniper'))
  })
  it('nothing failing: the empty state, in either choice', () => {
    const calm: HealthOverview = { minds: [mind('m3', 'Juniper', 'ok')], totals: { high: 0, medium: 0, low: 0, ok: 1 } }
    expect(page(ready(calm)).html).toContain('Nothing is failing')
    const none: HealthOverview = { minds: [], totals: { high: 0, medium: 0, low: 0, ok: 0 } }
    expect(page(ready(none), 'all').html).toContain('Nothing is failing')
    expect(page(ready(calm), 'all').html).not.toContain('Nothing is failing')
  })
  it("each mind: its name opens it, its status, its health in words, and its problems", () => {
    const { html } = page(ready(OVERVIEW), 'all')
    expect(html).toMatch(/<button[^>]*>Wren<\/button>/)
    expect(html).toContain('Needs attention')
    expect(html).toContain('>Errors<')
    expect(html).toContain('>Healthy<')
    expect(html).toContain('aria-label="Problems"')
    expect(html).toContain('A command failed to parse')
    expect(html).toContain('reply · 3× · 2h ago')
    // a mind with no problems has no problems list
    expect(html.match(/aria-label="Problems"/g)).toHaveLength(2)
  })
  it('an older problem is listed as earlier, not counted', () => {
    const { html } = page(ready(OVERVIEW))
    expect(html).toContain('Waiting for a yes')
    expect(html).toContain('reply · 3× · earlier, not counted')
  })
  it('a problem opens to what to do, what it ran, and where to go next', () => {
    const closed = page(ready(OVERVIEW)).html
    expect(closed).not.toContain('Check the brackets.')
    const open = new Set([openKey('m2', 'error-reply-0'), openKey('m2', 'waiting-reply-1')])
    const html = page(ready(OVERVIEW), 'problems', open).html
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Check the brackets.')
    expect(html).toContain('(say &quot;hi&quot;\n→ unbalanced')
    expect(html).toContain('>Open the mind&#x27;s trace</button>')
    expect(html).toContain('>Open approvals</button>')
  })
  it('a press on a problem comes back with its mind and its key', () => {
    const { data, facts } = healthScreen(ready(OVERVIEW), 'problems', new Set(), NOW, compose)
    const minds = data['minds.troubled'] as { id: string; data: Record<string, unknown> }[]
    expect(compose('health', facts).parts.find((p) => p.block === 'stack')?.props.source).toBe('minds.troubled')
    expect(minds.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect((minds[1].data['mind.issues'] as { id: string }[]).map((i) => i.id)).toEqual(['error-reply-0', 'waiting-reply-1'])
  })
  it('the same facts are composed once', () => {
    let calls = 0
    const counting = { compose: (s: string, l: string, f: Parameters<ScreensSpace['compose']>[2]) => { calls++; return space.compose(s, l, f) } } as unknown as ScreensSpace
    const once = rememberedCompose('classic', () => counting)
    healthScreen(ready(OVERVIEW), 'all', new Set(), NOW, once)
    healthScreen(ready(OVERVIEW), 'all', new Set(), NOW, once)
    expect(calls).toBe(5)   // three mind shapes and two problem shapes, each asked once
  })
  it('Cosmos draws the same atoms on a 3D stage', () => {
    const { data, facts } = healthScreen(ready(OVERVIEW), 'all', new Set(), NOW, compose)
    const plan = space.compose('health', 'cosmos', facts)
    expect(plan.space).toBe('3d')
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data } }))).toContain('Juniper')
  })
  it('every part of every Health screen can be reached', () => {
    // each screen's own parts and the orders its resource declaration takes
    const declared = new Map<string, Set<number>>()
    for (const [, screen] of healthSource.matchAll(/^\(Screen (\S+) /gm)) declared.set(screen, new Set(space.orders(screen)))
    expect(declared.get('health')).toEqual(new Set([10, 20, 30, 40, 41, 43, 44, 45, 47, 50, 51, 52, 60, 61, 62, 63]))
    // the cases above, plus a mind whose health the page does not know
    healthScreen(ready({ minds: [mind('m9', 'Moss', 'low'), { ...mind('m8', 'Fern', 'ok'), health: 'unknown' as MindHealth['health'] }], totals: { high: 0, medium: 0, low: 1, ok: 0 } }), 'all', new Set(), NOW, compose)
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})
