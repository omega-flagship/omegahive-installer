import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import type { HiveSettings } from '../../api/types'
import type { ResourceState } from '../../lib/useResource'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { LOW_DISK_BYTES, SETTINGS_LINKS, linkRoute, settingsScreen, type PasswordStep } from './data'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The Settings screen end to end: invented settings → facts → MeTTa composes → the renderer draws. */
const space = ScreensSpace.open()
const settings = (over: { hive?: Partial<HiveSettings['hive']>; signin?: Partial<HiveSettings['signin']>; disk?: Partial<HiveSettings['disk']>; apps?: Partial<HiveSettings['apps']> } = {}): HiveSettings => ({
  hive: { name: 'Meadow Hive', build: 'abcdef0123456789', started_at: '2026-01-02T03:04:05Z', supervised: true, base_paths: ['/meadow'], ...over.hive },
  signin: { password: true, password_from_env: false, family_google: true,
    hive_google: { configured: true, callback_path: '/auth/invented/callback', note: '' }, ...over.signin },
  disk: { free_bytes: 50e9, total_bytes: 200e9, hive_data_bytes: 2.5e9, ...over.disk },
  apps: { homes: { app_notes: ['s_one', 's_two'] }, sandbox_apps: ['app_notes'], sandbox_runtimes: ['wasm'], local_only_swarms: ['s_two'], ...over.apps },
})
const ready = (s: HiveSettings, error?: unknown): ResourceState<HiveSettings> => ({ status: 'ready', data: s, error, refreshing: false })
const names = { app: (id: string) => (id === 'app_notes' ? 'Notebook' : id), swarm: (id: string) => ({ s_one: 'Garden', s_two: 'Workshop' })[id] ?? id, when: () => 'the second of January' }
const idle: PasswordStep = { confirming: false, fresh: null }
const compose = (res: ResourceState<HiveSettings>, pw: PasswordStep = idle, look = 'classic') => {
  const { data, facts } = settingsScreen(res, names, pw)
  return { plan: space.compose('settings', look, facts), data }
}
const draw = (res: ResourceState<HiveSettings>, pw: PasswordStep = idle, host: Partial<ScreenHost> = {}) => {
  const { plan, data } = compose(res, pw)
  return renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, ...host } }))
}
const loading: ResourceState<HiveSettings> = { status: 'loading', data: undefined, error: undefined, refreshing: false }
const ISLAND_NAMES = ['hive-placement', 'google-connector', 'registered-services', 'ask-audit']
const islands = Object.fromEntries(ISLAND_NAMES.map((n) => [n, createElement('p', null, `Invented panel ${n}`)]))
const orders = (res: ResourceState<HiveSettings>, pw: PasswordStep = idle) => compose(res, pw).plan.parts.map((p) => p.order)

describe('the Settings page, composed by MeTTa', () => {
  it('draws the hive, sign-in, disk and apps from the settings, with no secrets', () => {
    const html = draw(ready(settings()))
    for (const words of ['Meadow Hive', 'abcdef0123', 'the second of January', 'Yes (supervised)', '/meadow/', 'On: the everyday way in',
      'Google client set', '/auth/invented/callback', '50.0 GB of 200.0 GB', '2.5 GB', 'Notebook: Garden, Workshop', 'wasm', 'Workshop'])
      expect(html).toContain(words)
    expect(html).not.toContain('abcdef01234')
    expect(html).toContain('Rotate password…')
    expect(html).not.toContain('Free space on this Mac is low')
    expect(html).not.toContain('Each app opens where it was last used')
  })
  it('every other answer to a yes-or-no setting has its own words', () => {
    const html = draw(ready(settings({ hive: { supervised: false, build: null, base_paths: [] }, signin: { family_google: false, hive_google: { configured: false, callback_path: '/cb', note: '' } },
      disk: { free_bytes: LOW_DISK_BYTES - 1 }, apps: { homes: {}, sandbox_apps: [], sandbox_runtimes: [], local_only_swarms: [] } })))
    for (const words of ['No: restart it from its host', 'unknown', 'Off', 'Not configured', 'Free space on this Mac is low', 'Each app opens where it was last used'])
      expect(html).toContain(words)
    expect(html).not.toContain('Public paths')
    expect(html.match(/>None</g)).toHaveLength(3)
  })
  it('the operator password: set on the host, or asked, confirmed, and shown once', () => {
    const env = draw(ready(settings({ signin: { password_from_env: true } })), { confirming: true, fresh: 'invented-secret' })
    expect(env).toContain('HIVE_ADMIN_PASSWORD')
    expect(env).not.toContain('Rotate')
    expect(env).not.toContain('invented-secret')
    const confirming = draw(ready(settings()), { confirming: true, fresh: null })
    expect(confirming).toContain('sign out every password session?')
    expect(confirming).toContain('>Rotate now<')
    expect(confirming).toContain('>Cancel<')
    expect(confirming).not.toContain('Rotate password…')
    const fresh = draw(ready(settings()), { confirming: false, fresh: 'invented-secret' })
    expect(fresh).toContain('Shown once: copy it now.')
    expect(fresh).toContain('invented-secret')
    expect(fresh).toContain('>Copy<')
    expect(fresh).toContain('>Hide<')
    expect(fresh).not.toContain('Rotate')
  })
  it('loading, unsupported, admins only and a failed read each say so, and show no settings', () => {
    const at = (res: ResourceState<HiveSettings>) => draw(res)
    expect(at(loading)).toContain('Reading this hive')
    expect(at({ status: 'unsupported', data: undefined, error: undefined, refreshing: false })).toContain('does not report its settings yet')
    const forbidden = at({ status: 'error', data: undefined, error: new ApiError(403, 'forbidden', 'no'), refreshing: false })
    expect(forbidden).toContain('Admins only')
    expect(forbidden).not.toContain('Try again')
    const failed = at({ status: 'error', data: undefined, error: new Error('The invented hive is asleep'), refreshing: false })
    expect(failed).toContain('Could not load settings')
    expect(failed).toContain('The invented hive is asleep')
    expect(failed).toContain('>Try again<')
    for (const html of [forbidden, failed]) expect(html).not.toContain('Operator password')
  })
  it('a failed refresh keeps the settings on screen, says why, and offers Retry', () => {
    const html = draw(ready(settings(), new Error('Invented timeout')))
    expect(html).toContain('Could not refresh the settings')
    expect(html).toContain('Invented timeout')
    expect(html).toContain('>Retry<')
    expect(html).toContain('Meadow Hive')
  })
  it('every condition can be reached', () => {
    const reached = new Set<number>()
    const states: [ResourceState<HiveSettings>, PasswordStep][] = [
      [{ status: 'loading', data: undefined, error: undefined, refreshing: false }, idle],
      [{ status: 'unsupported', data: undefined, error: undefined, refreshing: false }, idle],
      [{ status: 'error', data: undefined, error: new ApiError(403, 'forbidden', 'no'), refreshing: false }, idle],
      [{ status: 'error', data: undefined, error: new Error('x'), refreshing: false }, idle],
      [ready(settings(), new Error('x')), idle],
      [ready(settings({ signin: { password_from_env: true } })), idle],
      [ready(settings({ hive: { supervised: false, base_paths: [] }, signin: { family_google: false, hive_google: { configured: false, callback_path: '/cb', note: '' } },
        disk: { free_bytes: 1 }, apps: { homes: {}, sandbox_apps: [], sandbox_runtimes: [], local_only_swarms: [] } })), { confirming: true, fresh: null }],
      [ready(settings()), { confirming: false, fresh: 'invented' }],
    ]
    for (const [res, pw] of states) for (const o of orders(res, pw)) reached.add(o)
    const declared = [1, 5, 6, 7, 8, 9, 10, 11, 12, 20, 21, 22, 23, 24, 30, 31, 32, 33, 34, 35, 40, 41, 42, 43, 44, 50, 51, 52, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
      70, 71, 72, 73, 80]
    expect([...reached].sort((a, b) => a - b)).toEqual(declared)
    expect(space.orders('settings')).toEqual(declared)
  })
  it('the new blocks hand their presses back to the page', () => {
    const { plan } = compose(ready(settings()), { confirming: true, fresh: null })
    expect(plan.parts.find((p) => p.order === 43)).toMatchObject({ block: 'confirm', how: { kind: 'direct' }, depth: { layer: 'raised' } })
    const fresh = compose(ready(settings()), { confirming: false, fresh: 'x' }).plan.parts.find((p) => p.order === 44)
    expect(fresh).toMatchObject({ block: 'reveal', how: { kind: 'direct' }, depth: { layer: 'raised' }, props: { copy: 'copy-password', hide: 'hide-password' } })
    expect(plan.missing).toEqual([])
  })
  it('the links to the pages that own the rest: a list in a desk look, cards in Cosmos, each with its icon', () => {
    const html = draw(ready(settings()), idle, { onOpen: () => undefined })
    const links = html.slice(html.indexOf('aria-label="More settings"'))
    expect(html).toContain('data-block="list"')
    for (const l of SETTINGS_LINKS) expect(links).toContain(l.label)
    expect(links.match(/<button/g)).toHaveLength(SETTINGS_LINKS.length)
    expect(links.match(/<svg/g)).toHaveLength(SETTINGS_LINKS.length)
    const { plan } = compose(ready(settings()))
    expect(plan.parts.at(-1)).toMatchObject({ order: 80, block: 'list', props: { icon: 'icon', source: 'settings.links' } })
    expect(compose(ready(settings()), idle, 'cosmos').plan.parts.at(-1)?.block).toBe('cards')
    expect(SETTINGS_LINKS.map((l) => l.icon)).toEqual(['cpu', 'chart', 'people', 'replay', 'roles', 'rules', 'database', 'layers'])
    expect(linkRoute('approvals')).toEqual({ name: 'approvals', tab: 'rules' })
  })
  it('each link draws its own icon, not the fallback', () => {
    const one = { ...SETTINGS_LINKS[0], icon: 'database' as const }
    const { plan, data } = compose(ready(settings()))
    const iconOf = (links: unknown[]) => {
      const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: { ...data, 'settings.links': links }, framed: true } }))
      return html.slice(html.indexOf('aria-label="More settings"')).match(/<svg[\s\S]*?<\/svg>/)?.[0]
    }
    expect(iconOf([one])).toBeDefined()
    expect(iconOf([one])).not.toEqual(iconOf([SETTINGS_LINKS[0]]))
  })
  it('places the four panels as islands, in order, after the settings and before the links, whatever the settings say', () => {
    for (const res of [loading, ready(settings())]) {
      const parts = compose(res).plan.parts
      const placed = parts.filter((p) => p.block === 'island')
      expect(placed.map((p) => [p.order, p.props.name])).toEqual(ISLAND_NAMES.map((n, i) => [70 + i, n]))
      expect(parts.slice(-5).map((p) => p.block)).toEqual(['island', 'island', 'island', 'island', 'list'])
    }
    const html = draw(ready(settings()), idle, { islands })
    const at = (words: string) => html.indexOf(words)
    const seen = ['Local-only swarms: their minds', ...ISLAND_NAMES.map((n) => `Invented panel ${n}`), 'aria-label="More settings"'].map(at)
    expect(seen.every((i) => i >= 0)).toBe(true)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    // a panel the page does not offer draws nothing
    expect(draw(ready(settings()))).not.toContain('Invented panel')
  })
  it('loading draws the waiting placeholder, not a notice, and no settings', () => {
    const { plan } = compose(loading)
    expect(plan.parts.find((p) => p.order === 5)).toMatchObject({ block: 'waiting', props: { label: "Reading this hive's settings…" } })
    const html = draw(loading)
    expect(html).toContain('data-block="waiting"')
    expect(html).toContain('aria-label="Reading this hive&#x27;s settings…"')
    expect(html).not.toContain('data-block="notice"')
    expect(html).not.toContain('Operator password')
  })
})
