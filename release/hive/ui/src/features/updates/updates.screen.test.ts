import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppUpdate, UpdateHold, UpdatesOverview } from '../../api/types'
import type { ResourceState } from '../../lib/useResource'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import updatesSource from './updates.metta?raw'
import { updatesScreen, type Can, type Compose } from './data'

vi.setConfig({ testTimeout: 20_000 })

/** The Updates page end to end: invented updates → facts → MeTTa composes the page, each hold and each app → drawn. */
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
const when = (iso: string) => `at ${iso.slice(11, 16)}`
const ALL: Can = { hold: true, release: true, apply: true, request: true }

const app = (id: string, name: string, over: Partial<AppUpdate> = {}): AppUpdate => ({
  target: `program:${id}`, id, name, loaded_version: '1.0.0', disk_version: '1.0.0', loaded_digest: 'a', disk_digest: 'a', load_error: null,
  update_available: false, removed_on_disk: false, request: null, ...over,
})
const hold = (id: string, scope: string, over: Partial<UpdateHold> = {}): UpdateHold => ({
  id, scope, reason: 'The spring planting plan is being drawn', held_by: 'Ada', created_at: '2026-03-01T10:00:00Z', until: null, ...over,
})
const OVERVIEW: UpdatesOverview = {
  platform: {
    target: 'platform', running_build: 'b0a7c1e55aa', source_build: 'c9d1', started_at: '2026-03-01T09:00:00Z', update_available: true,
    commits_waiting: [{ commit: 'c9d1f00', subject: 'Water the beds at dusk' }, { commit: 'aa12bb3', subject: 'Count the seedlings' }],
    supervised: true, request: { requested_by: 'Wren', note: 'The seedling counter is fixed' } as AppUpdate['request'],
  },
  apps: [
    app('ledger', 'Ledger', { update_available: true, disk_version: '1.1.0' }),
    app('garden', 'Garden'),
    app('almanac', 'Almanac', { load_error: 'missing a page' }),
  ],
  holds: [],
  history: [
    { id: 'h1', target: 'platform', by: 'Ada', at: '2026-03-01T11:00:00Z', before: {}, after: {}, ok: true, error: null, overrode: [] },
    { id: 'h2', target: 'program:garden', by: 'Wren', at: '2026-03-01T11:30:00Z', before: {}, after: {}, ok: false, error: 'no soil', overrode: ['x'] },
  ],
}
const ready = (data: UpdatesOverview, error?: unknown): ResourceState<UpdatesOverview> => ({ status: 'ready', data, error, refreshing: false })
const state = (status: 'loading' | 'unsupported' | 'error', error?: unknown): ResourceState<UpdatesOverview> => ({ status, data: undefined, error, refreshing: false })
const withData = (over: Partial<UpdatesOverview>, platform: Partial<UpdatesOverview['platform']> = {}): UpdatesOverview =>
  ({ ...OVERVIEW, ...over, platform: { ...OVERVIEW.platform, ...platform } })

function page(res: ResourceState<UpdatesOverview>, can: Can = ALL, host: Partial<ScreenHost> = {}) {
  const { data, facts } = updatesScreen(res, can, compose, NOW, when)
  const plan = compose('updates', facts)
  return { plan, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onAction: () => {}, ...host } })) }
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
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)].map((m) => m[1])

describe('the Updates page, composed by MeTTa', () => {
  it('while checking, unsupported or failed: says so plainly, and nothing else', () => {
    expect(page(state('loading')).plan.parts.map((p) => p.block)).toEqual(['waiting'])
    expect(page(state('loading')).html).toContain('aria-label="Checking for updates"')
    const unsupported = page(state('unsupported'))
    expect(unsupported.html).toContain('This hive does not report updates yet.')
    expect(unsupported.plan.parts.map((p) => p.block)).toEqual(['empty'])
    const failed = page(state('error', new Error('The hive did not answer')))
    expect(failed.html).toContain('Could not check for updates')
    expect(failed.html).toContain('The hive did not answer')
    expect(buttons(failed.html)).toEqual(['Try again'])
    expect(failed.html).not.toContain('Platform')
  })
  it('a failed refresh keeps the last updates on screen, says so, and offers Retry', () => {
    const { html } = page(ready(OVERVIEW, new Error('Timed out')))
    expect(html).toContain('Could not refresh: Timed out Showing the last loaded data.')
    expect(buttons(html)[0]).toBe('Retry')
    expect(html).toContain('Ledger')
  })
  it('Ask for an update sits first once the updates are loaded, for a hive that takes requests', () => {
    const { html } = page(ready(OVERVIEW))
    expect(buttons(html)[0]).toBe('Ask for an update…')
    expect(buttons(page(ready(OVERVIEW), { ...ALL, request: false }).html)).not.toContain('Ask for an update…')
    expect(page(state('loading')).html).not.toContain('Ask for an update')
  })
  it('nothing held: says so, and offers to hold everything', () => {
    const { html } = page(ready(OVERVIEW))
    expect(html).toContain('>Holds</h3>')
    expect(html).toContain('Nothing is held. Hold the platform or an app below when work must not be interrupted.')
    expect(buttons(html)).toContain('Hold everything…')
  })
  it('each hold: what it stops, why, who and since when, until when, and Lift', () => {
    const holds = [hold('k1', 'restart'), hold('k2', 'program:ledger', { held_by: 'Wren', reason: 'Closing the month', until: '2026-03-02T18:00:00Z' })]
    const { html } = page(ready(withData({ holds })))
    expect(html).toContain("On hold: don&#x27;t interrupt (2)")
    expect(html).toContain('aria-label="Holds"')
    expect(html).toContain('No platform restart')
    expect(html).toContain('The spring planting plan is being drawn · Ada, 2h ago · until released')
    expect(html).toContain('No reload of Ledger')
    expect(html).toContain('Closing the month · Wren, 2h ago · until at 18:00')
    expect(html.match(/>On hold</g)).toHaveLength(2)
    expect(buttons(html).filter((b) => b === 'Lift…')).toHaveLength(2)
    expect(html).not.toContain('Nothing is held')
  })
  it('without the right to hold or lift: no Hold, no Lift, still every hold listed', () => {
    const { html } = page(ready(withData({ holds: [hold('k1', 'all')] })), { hold: false, release: false, apply: true, request: false })
    expect(html).toContain('No updates at all (no restart, no app reload)')
    for (const b of buttons(html)) expect(b).not.toMatch(/Hold|Lift/)
    expect(html).not.toContain('aria-label="Hold reloads of')
  })
  it('the platform: its build and start, what waits for a restart, who asked, and Restart beside Hold restarts', () => {
    const { html } = page(ready(OVERVIEW))
    expect(html).toContain('>Platform</h3>')
    expect(html).toContain('Running build b0a7c1e, started 3h ago.')
    expect(html).toContain('2 changes waiting for a restart.')
    expect(html).toContain('aria-label="Changes waiting for a restart"')
    expect(html).toContain('c9d1f00 Water the beds at dusk\naa12bb3 Count the seedlings')
    expect(html).toContain('From Wren: The seedling counter is fixed')
    // Restart beside Hold restarts: two parts in one row, Restart first
    const [platform, ...more] = rows(html, 'platform-actions')
    expect(more).toEqual([])
    expect(buttons(platform)).toEqual(['Restart to update', 'Hold restarts…'])
    expect(platform).toMatch(/style="background[^>]*>Restart to update<\/button>/)
    expect(platform.match(/data-screen-part="updates\.\d+"/g)).toEqual(['data-screen-part="updates.26"', 'data-screen-part="updates.28"'])
    expect(html).not.toContain('Up to date.')
  })
  it('the platform up to date: says so, and only Hold restarts', () => {
    const { html } = page(ready(withData({}, { update_available: false, commits_waiting: [], request: null })))
    expect(html).toContain('Up to date.')
    expect(html).not.toContain('waiting for a restart')
    expect(buttons(html).filter((b) => /Restart/.test(b))).toEqual([])
    expect(buttons(html)).toContain('Hold restarts…')
  })
  it('a held platform restarts only as an override; one change reads as one', () => {
    const one = withData({ holds: [hold('k1', 'all')] }, { commits_waiting: [{ commit: 'c9d1f00', subject: 'Water the beds at dusk' }], request: null })
    const held = page(ready(one)).html
    expect(held).toContain('1 change waiting for a restart.')
    expect(buttons(held)).toContain('Restart (on hold)')
    expect(buttons(held)).not.toContain('Restart to update')
    expect(rows(held, 'platform-actions').map(buttons)).toEqual([['Restart (on hold)', 'Hold restarts…']])
    expect(held).not.toContain('From Wren')
    const heldNoHold = page(ready(one), { hold: false, release: true, apply: true, request: true }).html
    expect(buttons(heldNoHold)).toContain('Restart (on hold)')
    expect(buttons(heldNoHold)).not.toContain('Hold restarts…')
    expect(buttons(page(ready(OVERVIEW), { hold: false, release: true, apply: true, request: true }).html)).toContain('Restart to update')
  })
  it("a hive that can't restart itself says so and offers no Restart; nor does one that can't apply updates", () => {
    const unsupervised = page(ready(withData({}, { supervised: false }))).html
    expect(unsupervised).toContain('This hive can&#x27;t restart itself; restart it on its host.')
    expect(buttons(unsupervised).filter((b) => /^Restart/.test(b))).toEqual([])
    expect(buttons(unsupervised)).toContain('Hold restarts…')
    expect(rows(unsupervised, 'platform-actions').map(buttons)).toEqual([['Hold restarts…']])
    const noApply = page(ready(OVERVIEW), { hold: true, release: true, apply: false, request: true }).html
    expect(buttons(noApply).filter((b) => /^Restart|^Reload/.test(b))).toEqual([])
    expect(buttons(noApply)).toContain('Hold restarts…')
    expect(noApply.match(/aria-label="Hold reloads of /g)).toHaveLength(3)
  })
  it('the apps: how many need attention, and each with its version, its trouble, and Hold beside Reload', () => {
    const { html } = page(ready(OVERVIEW))
    expect(html).toContain('>Apps</h3>')
    expect(html).toContain('2 of 3 need attention.')
    expect(html).toContain('Ledger')
    expect(html).toContain('1.0.0 → 1.1.0')
    expect(html).toContain('Load error: missing a page')
    // Hold beside Reload, one row per app
    const appRows = rows(html, 'app-actions')
    expect(appRows.map(buttons)).toEqual([['Hold…', 'Reload'], ['Hold…'], ['Hold…', 'Reload']])
    expect(appRows[0]).toMatch(/<button[^>]*aria-label="Hold reloads of Ledger"[^>]*>.*Hold…<\/button>/)
    expect(appRows[0]).toMatch(/style="background[^>]*>Reload<\/button>/)
    expect(html).toContain('aria-label="Hold reloads of Garden"')
    // Garden needs nothing: Hold only
    expect(buttons(html).filter((b) => b === 'Reload')).toHaveLength(2)
  })
  it('an app: same version with changed code, a folder gone, a request, a hold; and Reload without the right to hold', () => {
    const apps = [
      app('ledger', 'Ledger', { update_available: true, request: { requested_by: 'Ada', note: 'Signed off' } as AppUpdate['request'] }),
      app('garden', 'Garden', { removed_on_disk: true, update_available: true, disk_version: '2.0.0' }),
    ]
    const holds = [hold('k1', 'program:ledger')]
    const { html } = page(ready(withData({ apps, holds })), { hold: false, release: true, apply: true, request: true })
    expect(html).toContain('Same version number, changed code.')
    expect(html).toContain('Its folder is gone; it keeps running until the next restart.')
    expect(html).toContain('From Ada: Signed off')
    expect(buttons(html)).toEqual(expect.arrayContaining(['Reload (on hold)', 'Reload']))
    expect(html).not.toContain('aria-label="Hold reloads of')
    const allowed = page(ready(withData({ apps, holds }))).html
    const [ledger] = rows(allowed, 'app-actions')
    expect(ledger).toMatch(/aria-label="Hold reloads of Ledger"/)
    expect(buttons(ledger)).toEqual(['Hold…', 'Reload (on hold)'])
  })
  it('apps all running what is on disk: one, or several', () => {
    expect(page(ready(withData({ apps: [app('garden', 'Garden')] }))).html).toContain('The one app is running what is on disk.')
    const two = page(ready(withData({ apps: [app('garden', 'Garden'), app('ledger', 'Ledger')] }))).html
    expect(two).toContain('All 2 apps are running what is on disk.')
    const none = page(ready(withData({ apps: [] })))
    expect(none.html).toContain('All 0 apps are running what is on disk.')
    expect(none.plan.parts.some((p) => p.block === 'stack' && p.props.label === 'Apps')).toBe(false)
  })
  it('what was applied lately, and nothing when nothing was', () => {
    const { html } = page(ready(OVERVIEW))
    expect(html).toContain('>Recent</h3>')
    expect(html).toContain('1h ago · Platform restart by Ada')
    expect(html).toContain('30m ago · garden reloaded by Wren')
    expect(html).toContain('error: no soil · overrode a hold')
    expect(page(ready(withData({ history: [] }))).html).not.toContain('Recent')
  })
  it('the dialogs island sits once the updates are loaded, then the note on minds', () => {
    const dialogs = { 'update-dialogs': createElement('div', { role: 'dialog' }, 'Place a hold') }
    const { html } = page(ready(OVERVIEW), ALL, { islands: dialogs })
    expect(html).toContain('Place a hold')
    expect(html.indexOf('Place a hold')).toBeLessThan(html.indexOf('hive-update-apply'))
    expect(html).toContain('minds can never override a hold.')
    expect(page(state('loading'), ALL, { islands: dialogs }).html).not.toContain('Place a hold')
  })
  it('busy: every button on the screen waits', () => {
    const { html } = page(ready(withData({ holds: [hold('k1', 'restart')] })), ALL, { busy: true })
    const all = html.match(/<button/g)?.length ?? 0
    expect(all).toBeGreaterThan(5)
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(all)
  })
  it('the guards stay clean, nothing falls back, and every part can be reached', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(page(ready(OVERVIEW)).plan.missing).toEqual([])
    const declared = new Map<string, Set<number>>()
    for (const m of updatesSource.matchAll(/^\(Part (\S+) (\d+) /gm)) {
      const s = declared.get(m[1]) ?? new Set<number>()
      s.add(Number(m[2]))
      declared.set(m[1], s)
    }
    expect([...declared.keys()].sort()).toEqual(['updates', 'updates-app', 'updates-hold'])
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})
