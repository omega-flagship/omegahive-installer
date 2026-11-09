import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactList } from '../../api/moneyWork'
import type { CollabRequest } from '../../api/types'
import { DRAWN_BLOCKS, Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { composeArtifacts, filterArtifacts, NO_FILTER, type ArtifactFilter } from './artifacts'
import { artifactsScreen, withInput, type Loaded, type Names } from './data'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const digest = `sha256:${'a'.repeat(64)}`

describe('the hive-level artifact list', () => {
  const request = { id: 'rq1', kind: 'review', title: 'Review the patch', from_swarm: 's1', from_principal: 'agent:a_v', to_swarm: 's2', state: 'working', created_at: '2026-10-05T10:00:00Z', subject: { artifact_id: 'ar1', revision: 3, digest } } as unknown as CollabRequest
  const items = composeArtifacts({
    requests: [request, { ...request, id: 'rq2', subject: { bad: true } } as unknown as CollabRequest],
    flows: { s2: [{ artifact_id: 'ar9', title: 'Nightly', revision: 2 }] },
    shares: [
      { id: 'sh1', owner_id: 'a_d', grantee_id: 'a_v', status: 'active', created_at: '2026-10-05T11:00:00Z', exhibit_id: 'ex1', exhibit: { title: 'Spectra', bytes: 10, atoms: 2 } },
      { id: 'sh2', owner_id: 'a_d', grantee_id: 'a_x', status: 'active', created_at: '2026-10-05T11:00:00Z', exhibit_id: 'ex1', exhibit: { title: 'Spectra', bytes: 10, atoms: 2 } },
    ],
    activity: [
      { id: 'pa1', program: 'explorer', swarm_id: 's1', principal: 'agent:a_v', action: 'annotate', items: ['b1'], status: 'done', approval_id: null, created_at: '2026-10-05T12:00:00Z', finished_at: '2026-10-05T12:00:01Z' },
      { id: 'pa2', program: 'explorer', swarm_id: 's1', principal: 'agent:a_v', action: 'annotate', items: [], status: 'failed', approval_id: null, created_at: '2026-10-05T12:00:00Z', finished_at: null },
    ],
  })

  it('composes one row per thing, newest first, skipping malformed references and unfinished actions', () => {
    expect(items.map((a) => a.key)).toEqual(['app:pa1', 'exhibit:ex1', 'review:rq1', 'flow:ar9'])
    expect(items.find((a) => a.kind === 'review')).toMatchObject({ mind_id: 'a_v', revision: 3, ref: { artifact_id: 'ar1', revision: 3, digest } })
  })

  it('filters by kind, swarm (through a mind), mind, app and text', () => {
    expect(filterArtifacts(items, { ...NO_FILTER, kind: 'flow' }).map((a) => a.key)).toEqual(['flow:ar9'])
    expect(filterArtifacts(items, { ...NO_FILTER, swarm: 's9' }, (id) => (id === 'a_d' ? 's9' : null)).map((a) => a.key)).toEqual(['exhibit:ex1'])
    expect(filterArtifacts(items, { ...NO_FILTER, app: 'explorer' }).map((a) => a.key)).toEqual(['app:pa1'])
    expect(filterArtifacts(items, { ...NO_FILTER, q: 'PATCH' }).map((a) => a.key)).toEqual(['review:rq1'])
  })
})

/** The Artifacts and findings screen end to end: an invented list → facts → MeTTa composes → the renderer draws. */
describe('the Artifacts and findings page, composed by MeTTa', () => {
  const space = ScreensSpace.open()
  const now = Date.parse('2026-10-05T12:10:00Z')
  const list: ArtifactList = {
    missing: [],
    items: composeArtifacts({
      requests: [{ id: 'rq1', kind: 'review', title: 'Review the lantern sketch', from_swarm: 's1', from_principal: 'agent:m1', to_swarm: 's2', state: 'working', created_at: '2026-10-05T10:00:00Z', subject: { artifact_id: 'ar1', revision: 3, digest } } as unknown as CollabRequest],
      flows: { s2: [{ artifact_id: 'ar9', title: 'Morning tidy', revision: 2 }] },
      shares: [{ id: 'sh1', owner_id: 'm2', grantee_id: 'm1', status: 'active', created_at: '2026-10-05T11:00:00Z', exhibit_id: 'ex1', exhibit: { title: 'Tide tables', bytes: 10, atoms: 2 } }],
      activity: [{ id: 'pa1', program: 'garden', swarm_id: 's1', principal: 'agent:m1', action: 'water the beds', items: ['b1'], status: 'done', approval_id: null, created_at: '2026-10-05T12:00:00Z', finished_at: '2026-10-05T12:00:01Z' }],
    }),
  }
  const names: Names = {
    minds: { m1: { name: 'Wren', swarm_id: 's1' }, m2: { name: 'Ada', swarm_id: 's2' } },
    swarms: { s1: { name: 'Orchard' }, s2: { name: 'Harbour' } },
    apps: { garden: 'Garden Planner' },
  }
  const ready: Loaded = { status: 'ready', list }
  const compose = (loaded: Loaded, f: ArtifactFilter = NO_FILTER, look = 'classic') => {
    const d = artifactsScreen(loaded, f, names, now)
    return { d, plan: space.compose('artifacts', look, d.facts) }
  }
  const draw = (loaded: Loaded, f: ArtifactFilter = NO_FILTER, look = 'classic') => {
    const { d, plan } = compose(loaded, f, look)
    return renderToStaticMarkup(createElement(Screen, { plan, host: { data: d.data, framed: true, onOpen: () => undefined, onInput: () => undefined } }))
  }
  const orders = (loaded: Loaded, f: ArtifactFilter = NO_FILTER) => compose(loaded, f).plan.parts.map((p) => p.order)

  it('lists every row newest first, each with its kind, who made it, where, and its own open button', () => {
    const html = draw(ready)
    expect(html.indexOf('water the beds')).toBeLessThan(html.indexOf('Tide tables'))
    expect(html.indexOf('Tide tables')).toBeLessThan(html.indexOf('Review the lantern sketch'))
    expect(html).toContain('aria-label="Artifacts"')
    expect(html).toContain('by Wren · via Garden Planner · in Orchard · 10m ago')
    expect(html).toContain('Sent to Harbour · For review')
    expect(html).toContain('ar1 r3')
    for (const label of ['Open in Design', 'Open flows', 'Who sees it', 'Open Garden Planner']) expect(html).toContain(`>${label}</button>`)
    expect(html).toContain('Composed from what you can already see')
  })

  it('the kind filter is a radio group with counts; search, swarm and mind menus keep their names', () => {
    const html = draw(ready, { ...NO_FILTER, kind: 'flow' })
    expect(html).toContain('role="radiogroup" aria-label="Kind"')
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Flow <span[^>]*>1<\/span>/)
    expect(html).toMatch(/aria-checked="false"[^>]*>Everything <span[^>]*>4<\/span>/)
    expect(html).toContain('Search artifacts')
    expect(html).toContain('placeholder="Search titles"')
    expect(html).toContain('aria-label="Swarm"')
    expect(html).toContain('<option value="s2">Harbour</option>')
    expect(html).toContain('aria-label="Mind"')
    expect(html).not.toContain('Review the lantern sketch')
  })

  it('the app menu shows only when an app produced something', () => {
    expect(draw(ready)).toContain('aria-label="App"')
    const noApps: Loaded = { status: 'ready', list: { missing: [], items: list.items.filter((a) => !a.app) } }
    expect(draw(noApps)).not.toContain('aria-label="App"')
    expect(orders(ready)).toContain(32)
    expect(orders(noApps)).toContain(31)
  })

  it('nothing matching says so and offers to clear the filters', () => {
    const html = draw(ready, { ...NO_FILTER, q: 'zzz' })
    expect(html).toContain('Nothing matches')
    expect(html).toContain('>Clear filters</button>')
    expect(html).not.toContain('aria-label="Artifacts"')
  })

  it('sources that could not be read are named, with a retry, and the rest still shows', () => {
    const html = draw({ status: 'ready', list: { ...list, missing: ['flows'] } })
    expect(html).toContain('Could not read flows this time, so those are missing from the list.')
    expect(html).toContain('>Retry</button>')
    expect(html).toContain('Tide tables')
  })

  it('each state of the list: loading, not offered here, failed, empty, and a failed refresh', () => {
    expect(orders({ status: 'loading' })).toEqual([4])
    expect(draw({ status: 'loading' })).toContain('aria-label="Loading artifacts"')
    const unsupported = draw({ status: 'unsupported' })
    expect(unsupported).toContain('Not available here')
    expect(unsupported).toContain('does not list artifacts yet')
    const failed = draw({ status: 'error', error: new Error('The hive is asleep.') })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Could not list artifacts: The hive is asleep.')
    expect(failed).toContain('>Try again</button>')
    const empty = draw({ status: 'empty', list: { items: [], missing: [] } })
    expect(empty).toContain('Nothing produced yet')
    expect(empty).not.toContain('radiogroup')
    const stale = draw({ ...ready, error: new Error('No answer.') })
    expect(stale).toContain('Could not refresh: No answer. Showing the last loaded data.')
    expect(stale).toContain('Tide tables')
  })

  it('every part can be reached', () => {
    const seen = new Set<number>()
    const cases: [Loaded, ArtifactFilter?][] = [
      [{ status: 'loading' }], [{ status: 'unsupported' }], [{ status: 'error', error: new Error('x') }],
      [{ status: 'empty', list: { items: [], missing: [] }, error: new Error('x') }], [{ ...ready, error: new Error('x') }],
      [{ status: 'ready', list: { ...list, missing: ['flows'] } }, { ...NO_FILTER, q: 'zzz' }],
      [{ status: 'ready', list: { missing: [], items: list.items.filter((a) => !a.app) } }],
    ]
    for (const [l, f] of cases) for (const o of orders(l, f)) seen.add(o)
    expect([...seen].sort((a, b) => a - b)).toEqual([4, 5, 7, 8, 9, 11, 12, 14, 15, 20, 30, 31, 32, 40, 41, 42, 90])
    expect(space.orders('artifacts')).toEqual([...seen].sort((a, b) => a - b))
  })

  it('Cosmos draws the same atoms in its 3D space, keeping the rows and their buttons', () => {
    const html = draw(ready, NO_FILTER, 'cosmos')
    expect(html).toContain('data-space="3d"')
    expect(html).toContain('data-block="entries"')
    expect(html).toContain('>Who sees it</button>')
  })

  it('a pick or a typed word changes only its own filter', () => {
    expect(withInput(NO_FILTER, 'kind', 'exhibit').kind).toBe('exhibit')
    expect(withInput(NO_FILTER, 'kind', 'nonsense')).toEqual(NO_FILTER)
    expect(withInput({ ...NO_FILTER, mind: 'm1' }, 'query', 'tide')).toEqual({ ...NO_FILTER, mind: 'm1', q: 'tide' })
    expect(withInput(NO_FILTER, 'swarm', 's2').swarm).toBe('s2')
    expect(withInput(NO_FILTER, 'app', 'garden').app).toBe('garden')
  })

  it('the new blocks are in the vocabulary and the renderer draws them', () => {
    for (const b of ['segments', 'menus', 'entries', 'note', 'waiting']) expect(DRAWN_BLOCKS).toContain(b)
  })
})
