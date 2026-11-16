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
const ALL: Can = { hold: true, release: true, apply: true, request: true, check: true }

const app = (id: string, name: string, over: Partial<AppUpdate> = {}): AppUpdate => ({
  target: `program:${id}`, id, name, loaded_version: '1.0.0', disk_version: '1.0.0', loaded_digest: 'a', disk_digest: 'a', load_error: null,
  update_available: false, removed_on_disk: false, request: null, ...over,
})
const hold = (id: string, scope: string, over: Partial<UpdateHold> = {}): UpdateHold => ({
  id, scope, reason: 'The spring planting plan is being drawn', held_by: 'Ada', created_at: '2026-03-01T10:00:00Z', until: null, ...over,
})
const OVERVIEW: UpdatesOverview = {
  platform: {
    target: 'platform', running_build: 'b0a7c1e55aa', running_release: null, source_build: 'c9d1', started_at: '2026-03-01T09:00:00Z', update_available: true,
    commits_waiting: [{ commit: 'c9d1f00', subject: 'Water the beds at dusk' }, { commit: 'aa12bb3', subject: 'Count the seedlings' }],
    supervised: true, request: { requested_by: 'Wren', note: 'The seedling counter is fixed' } as AppUpdate['request'], installer: null,
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

function page(res: ResourceState<UpdatesOverview>, can: Can = ALL, host: Partial<ScreenHost> = {}, checking = false) {
  const { data, facts } = updatesScreen(res, can, compose, NOW, when, checking)
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
    const { html } = page(ready(withData({ holds: [hold('k1', 'all')] })), { hold: false, release: false, apply: true, request: false, check: true })
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
    expect(platform.match(/data-screen-part="updates\.\d+"/g)).toEqual(['data-screen-part="updates.32"', 'data-screen-part="updates.37"'])
    expect(html).not.toContain('Up to date.')
  })
  it('the platform up to date: says so, and only Hold restarts', () => {
    const { html } = page(ready(withData({}, { update_available: false, commits_waiting: [], request: null })))
    expect(html).toContain('Up to date.')
    expect(html).not.toContain('waiting for a restart')
    expect(buttons(html).filter((b) => /Restart/.test(b))).toEqual([])
    expect(buttons(html)).toContain('Hold restarts…')
  })
  it('an installed release: named by its number and build, never called up to date by a check it cannot make', () => {
    const release = { version: '0.21', commit: 'c09333acbaf84622124dcb103fd54943fa7f59d8' }
    const installed = { running_build: null, running_release: release, source_build: null, update_available: false, commits_waiting: [], request: null }
    const { html } = page(ready(withData({}, installed)))
    expect(html).toContain('Running Omega Hive v0.21 (build c09333a), started 3h ago.')
    expect(html).not.toContain('Up to date.')
    expect(html).not.toContain('Running build unknown')
    const unnumbered = page(ready(withData({}, { ...installed, running_release: { ...release, version: null } }))).html
    expect(unnumbered).toContain('Running build c09333a, started 3h ago.')
  })
  describe('an installed Mac hive: what its updater has on offer, and Update now', () => {
    const release = { version: '0.22', commit: '300234fe5ab2899bf2ef2c03d8e380b9341529d2' }
    const base = { running_build: null, running_release: release, source_build: null, update_available: false, commits_waiting: [], request: null }
    const inst = (over: Partial<NonNullable<UpdatesOverview['platform']['installer']>> = {}) => ({
      newest: '0.23', offer: { version: '0.23', label: 'v0.23', notes: 'A shorter install.' }, checked_at: '2026-03-01T11:00:00Z',
      check_failed: null, checking: false, deferred_until: null, failed: null, updating: false, ...over,
    })
    it('a newer release: says so with its notes and how it goes, and Update now beside Hold restarts', () => {
      const { html } = page(ready(withData({}, { ...base, installer: inst() })))
      expect(html).toContain('Omega Hive v0.23 is ready to install. A shorter install.')
      expect(html).toContain('Update now downloads it, then a Terminal window installs it and your hive opens again on the new version.')
      const [row, ...more] = rows(html, 'platform-actions')
      expect(more).toEqual([])
      expect(buttons(row)).toEqual(['Update now', 'Check now', 'Hold restarts…'])
      expect(row.match(/data-screen-part="updates\.\d+"/g)).toEqual(['data-screen-part="updates.34"', 'data-screen-part="updates.36"',
        'data-screen-part="updates.37"'])
      expect(html).not.toContain('Up to date')
    })
    it('the newest release running: says so with when the updater checked, and offers nothing', () => {
      const { html } = page(ready(withData({}, { ...base, installer: inst({ newest: '0.22', offer: null }) })))
      expect(html).toContain('Up to date: v0.22 is the newest release (checked 1h ago).')
      expect(buttons(html).filter((b) => /^Update now|^Restart/.test(b))).toEqual([])
    })
    it('an update under way: says what happens next, and no second Update now', () => {
      const { html } = page(ready(withData({}, { ...base, installer: inst({ updating: true }) })))
      expect(html).toContain('Updating to v0.23: once the download finishes, a Terminal window installs it and the hive opens again.')
      expect(html).not.toContain('Update now downloads it')
      expect(rows(html, 'platform-actions').map(buttons)).toEqual([['Hold restarts…']])
    })
    it('a Not now still waiting and a try that did not finish: both said, and Update now still there', () => {
      const failed = { version: '0.23', error: 'the download is not the release the statement names', at: '2026-03-01T11:30:00Z' }
      const { html } = page(ready(withData({}, { ...base, installer: inst({ deferred_until: '2026-03-02T11:00:00Z', failed }) })))
      expect(html).toContain('You chose Not now in the update dialog, which asks again at 11:00.')
      expect(html).toMatch(/role="alert"[^>]*>The last try to install v0.23 did not finish: the download is not the release the statement names</)
      expect(buttons(html)).toContain('Update now')
    })
    it('a held platform updates only as an override, and a hive that cannot apply updates offers no Update now', () => {
      const held = page(ready(withData({ holds: [hold('k1', 'restart')] }, { ...base, installer: inst() }))).html
      expect(rows(held, 'platform-actions').map(buttons)).toEqual([['Update now (on hold)', 'Check now', 'Hold restarts…']])
      const noApply = page(ready(withData({}, { ...base, installer: inst() })), { hold: true, release: true, apply: false, request: true, check: true }).html
      expect(buttons(noApply).filter((b) => /^Update now/.test(b))).toEqual([])
      expect(noApply).toContain('Omega Hive v0.23 is ready to install.')
    })
    it('Check now: the updater checks at once, the page says it is checking and offers no second press meanwhile', () => {
      // a tester in Lisbon (16 November), back on wifi, had only the hourly check to wait for
      const current = inst({ newest: '0.22', offer: null })
      const idle = page(ready(withData({}, { ...base, installer: current }))).html
      expect(rows(idle, 'platform-actions').map(buttons)).toEqual([['Check now', 'Hold restarts…']])
      expect(idle).toContain('Up to date: v0.22 is the newest release (checked 1h ago).')
      expect(idle).not.toContain('Checking for a newer release…')
      // pressed here, or running for another page: said, and no Check now until it answers
      for (const html of [page(ready(withData({}, { ...base, installer: current })), ALL, {}, true).html,
        page(ready(withData({}, { ...base, installer: inst({ newest: '0.22', offer: null, checking: true }) }))).html]) {
        expect(html).toContain('Checking for a newer release…')
        expect(rows(html, 'platform-actions').map(buttons)).toEqual([['Hold restarts…']])
      }
      // the updater busy on its own (its hourly run, an install): no Check now either
      const busy = page(ready(withData({}, { ...base, installer: inst({ newest: '0.22', offer: null, updating: true }) }))).html
      expect(buttons(busy)).not.toContain('Check now')
    })
    it('a check that failed is said, and the last good answer is never shown as current', () => {
      // a tester's page said "Up to date" from a check 23 hours old while two newer releases were out (16 November)
      const unreachable = { reason: "the release feed couldn't be reached", detail: 'could not check https://example.test/feed.json: <urlopen error>', at: '2026-03-01T11:58:00Z' }
      const stale = page(ready(withData({}, { ...base, installer: inst({ newest: '0.22', offer: null, check_failed: unreachable }) }))).html
      expect(stale).toContain('Last checked 1h ago, when v0.22 was the newest release.')
      expect(stale).not.toContain('Up to date')
      expect(stale).toContain('Later checks failed: the release feed couldn&#x27;t be reached (last tried 2m ago).')
      expect(stale).not.toContain('urlopen')                                // the log's detail stays in the log
      // with an offer from the earlier check: still offered, and the failure said beside it
      const offered = page(ready(withData({}, { ...base, installer: inst({ check_failed: unreachable }) }))).html
      expect(offered).toContain('Omega Hive v0.23 is ready to install.')
      expect(buttons(offered)).toEqual(expect.arrayContaining(['Update now', 'Check now']))
      // never a good check at all
      const never = page(ready(withData({}, { ...base, installer: inst({ newest: null, offer: null, checked_at: null, check_failed: unreachable }) }))).html
      expect(never).toContain('This hive could not check for a newer release: the release feed couldn&#x27;t be reached (tried 2m ago).')
      // while a check runs, the failure gives way to it
      const again = page(ready(withData({}, { ...base, installer: inst({ check_failed: unreachable }) })), ALL, {}, true).html
      expect(again).not.toContain('Later checks failed')
      expect(again).toContain('Checking for a newer release…')
    })
    it('no Check now without the right to it, nor where no updater checks (a git checkout)', () => {
      const noCheck = page(ready(withData({}, { ...base, installer: inst() })), { ...ALL, check: false }).html
      expect(buttons(noCheck)).not.toContain('Check now')
      expect(buttons(page(ready(OVERVIEW)).html)).not.toContain('Check now')
    })
    it('an update started from here reads as such in Recent', () => {
      const history = [{ id: 'h9', target: 'platform', by: 'Ada', at: '2026-03-01T11:00:00Z', before: { release: '0.22' },
        after: { release: '0.23', installer: true }, ok: true, error: null, overrode: [] }]
      expect(page(ready(withData({ history }, { ...base, installer: inst() }))).html).toContain('1h ago · Update to v0.23 started by Ada')
    })
  })
  it('a held platform restarts only as an override; one change reads as one', () => {
    const one = withData({ holds: [hold('k1', 'all')] }, { commits_waiting: [{ commit: 'c9d1f00', subject: 'Water the beds at dusk' }], request: null })
    const held = page(ready(one)).html
    expect(held).toContain('1 change waiting for a restart.')
    expect(buttons(held)).toContain('Restart (on hold)')
    expect(buttons(held)).not.toContain('Restart to update')
    expect(rows(held, 'platform-actions').map(buttons)).toEqual([['Restart (on hold)', 'Hold restarts…']])
    expect(held).not.toContain('From Wren')
    const heldNoHold = page(ready(one), { hold: false, release: true, apply: true, request: true, check: true }).html
    expect(buttons(heldNoHold)).toContain('Restart (on hold)')
    expect(buttons(heldNoHold)).not.toContain('Hold restarts…')
    expect(buttons(page(ready(OVERVIEW), { hold: false, release: true, apply: true, request: true, check: true }).html)).toContain('Restart to update')
  })
  it("a hive that can't restart itself says so and offers no Restart; nor does one that can't apply updates", () => {
    const unsupervised = page(ready(withData({}, { supervised: false }))).html
    expect(unsupervised).toContain('This hive can&#x27;t restart itself; restart it on its host.')
    expect(buttons(unsupervised).filter((b) => /^Restart/.test(b))).toEqual([])
    expect(buttons(unsupervised)).toContain('Hold restarts…')
    expect(rows(unsupervised, 'platform-actions').map(buttons)).toEqual([['Hold restarts…']])
    const noApply = page(ready(OVERVIEW), { hold: true, release: true, apply: false, request: true, check: true }).html
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
    const { html } = page(ready(withData({ apps, holds })), { hold: false, release: true, apply: true, request: true, check: true })
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
