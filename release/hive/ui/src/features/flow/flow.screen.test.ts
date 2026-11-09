import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { flowScreen, studioResource, type StudioState } from './data'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The Flow studio end to end: its load → facts → MeTTa composes → the renderer draws, with both islands offered. */
const space = ScreensSpace.open()
const ISLANDS = {
  'flow-adoptions': createElement('section', { 'aria-label': 'Adopted list fixture' }),
  'flow-studio': createElement('div', { 'data-studio-fixture': '' }),
}
const at = (s: StudioState, canAdopt = true, look = 'classic') => {
  const { data, facts } = flowScreen(s, canAdopt)
  const plan = space.compose('flow', look, facts)
  return { plan, orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, islands: ISLANDS } })) }
}
const LIVE = { enabled: true, ready: false, error: null }

describe('the Flow studio, composed by MeTTa', () => {
  it('its load reads as the standard resource status', () => {
    expect(studioResource({ enabled: false, ready: true, error: 'x' })).toEqual({ status: 'unsupported' })
    expect(studioResource({ ...LIVE, error: 'invented outage' })).toEqual({ status: 'error', error: 'invented outage' })
    expect(studioResource({ ...LIVE, ready: true })).toEqual({ status: 'ready' })
    expect(studioResource(LIVE)).toEqual({ status: 'loading' })
  })
  it('loading says so, as a status', () => {
    const { html } = at(LIVE)
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading Flow studio…')
    expect(html).not.toContain('data-studio-fixture')
  })
  it('a failed load shows its reason as an alert, and no studio', () => {
    const { html } = at({ ...LIVE, error: 'Flow studio assets are unavailable' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Flow studio assets are unavailable')
    expect(html).not.toContain('data-studio-fixture')
  })
  it('without a live connection it says the studio needs one', () => {
    const { html } = at({ enabled: false, ready: false, error: null })
    expect(html).toContain('Flow studio requires a live Hive connection. The local authoring preview remains available separately.')
    expect(html).not.toContain('Not available here')
  })
  it('once ready the studio is drawn, after the adopted revisions', () => {
    const { html } = at({ ...LIVE, ready: true })
    expect(html.indexOf('Adopted list fixture')).toBeLessThan(html.indexOf('data-studio-fixture'))
    expect(html).not.toContain('Loading Flow studio')
  })
  it('a hive that cannot list adoptions shows none', () => {
    expect(at({ ...LIVE, ready: true }, false).html).not.toContain('Adopted list fixture')
  })
  it('the guards stay clean and nothing falls back', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(at(LIVE).plan.missing).toEqual([])
    expect(at(LIVE, true, 'cosmos').plan.missing).toEqual([])
  })
})

describe('every part of the Flow studio can be reached', () => {
  it('adoptions, loading, no connection, failed, and the studio', () => {
    const seen = new Set<number>()
    const see = (o: number[]) => { o.forEach((x) => seen.add(x)); return o }
    expect(see(at(LIVE).orders)).toEqual([10, 20])
    expect(see(at({ enabled: false, ready: false, error: null }, false).orders)).toEqual([21])
    expect(see(at({ ...LIVE, error: 'invented outage' }).orders)).toEqual([10, 23])
    expect(see(at({ ...LIVE, ready: true }).orders)).toEqual([10, 30])
    expect([...seen].sort((a, b) => a - b)).toEqual(space.orders('flow'))
    expect(space.orders('flow')).toEqual([10, 20, 21, 23, 30])
  })
})
