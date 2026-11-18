import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactList } from '../../api/moneyWork'
import type { CollabRequest } from '../../api/types'
import { DRAWN_BLOCKS, Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { composeArtifacts, filterArtifacts, NO_FILTER, type ArtifactFilter, type CreationRow } from './artifacts'
import { artifactsScreen, withInput, type ArtifactRow, type Loaded, type Names } from './data'

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
    apps: { garden: 'Garden Planner', omegadesign: 'Design' },
  }
  const ready: Loaded = { status: 'ready', list }
  // the page adds artifacts.link-missing when it was opened at #/artifacts/<id> for one this person can't open
  const compose = (loaded: Loaded, f: ArtifactFilter = NO_FILTER, look = 'classic', linkMissing = false) => {
    const d = artifactsScreen(loaded, f, names, now)
    return { d, plan: space.compose('artifacts', look, { ...d.facts, flags: { ...d.facts.flags, 'artifacts.link-missing': linkMissing } }) }
  }
  const draw = (loaded: Loaded, f: ArtifactFilter = NO_FILTER, look = 'classic', linkMissing = false) => {
    const { d, plan } = compose(loaded, f, look, linkMissing)
    return renderToStaticMarkup(createElement(Screen, { plan, host: { data: d.data, framed: true, onOpen: () => undefined, onInput: () => undefined } }))
  }
  const orders = (loaded: Loaded, f: ArtifactFilter = NO_FILTER, linkMissing = false) => compose(loaded, f, 'classic', linkMissing).plan.parts.map((p) => p.order)

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

  it('a link naming an artifact this person cannot open says so, above the list it opened on', () => {
    const html = draw(ready, NO_FILTER, 'classic', true)
    expect(html).toContain('<p role="status"')
    expect(html).toContain('That artifact is no longer here, or not shown to you.')
    expect(html.indexOf('no longer here')).toBeLessThan(html.indexOf('water the beds'))
    expect(draw(ready)).not.toContain('no longer here')
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
    for (const o of orders(ready, NO_FILTER, true)) seen.add(o)
    expect([...seen].sort((a, b) => a - b)).toEqual([2, 4, 5, 7, 8, 9, 11, 12, 14, 15, 20, 30, 31, 32, 40, 41, 42, 90])
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

/** What the swarms a person sees keep (GET /api/artifacts): a plan a mind started is listed even before anything is
 *  saved in it, so a person told "I made you a plan" finds it here. */
describe('creations: what the swarms a person sees keep', () => {
  const creations: CreationRow[] = [
    { artifact_id: 'ar5', kind: 'plan', title: 'Walk by the river', swarm_id: 's1', mind_id: 'm1', revision: null, digest: null, created_at: '2026-10-05T12:05:00Z', revised_at: null },
    { artifact_id: 'ar6', kind: 'studio-source', title: 'Lantern sketch', swarm_id: 's1', mind_id: null, revision: 2, digest, created_at: '2026-10-05T09:00:00Z', revised_at: '2026-10-05T11:30:00Z' },
    { artifact_id: 'ar9', kind: 'flow', title: 'Morning tidy', swarm_id: 's2', mind_id: null, revision: 2, digest, created_at: '2026-10-05T08:00:00Z', revised_at: '2026-10-05T08:00:00Z' },
  ]
  const items = composeArtifacts({ creations, flows: { s2: [{ artifact_id: 'ar9', title: 'Morning tidy', revision: 2 }] } })
  const now = Date.parse('2026-10-05T12:10:00Z')
  const names: Names = { minds: { m1: { name: 'Juniper', swarm_id: 's1' } }, swarms: { s1: { name: 'Trips' }, s2: { name: 'Harbour' } }, apps: {} }

  it('lists each once, newest first, a flow only as a flow, and one with nothing saved without a reference', () => {
    expect(items.map((a) => a.key)).toEqual(['creation:ar5', 'creation:ar6', 'flow:ar9'])
    expect(items[0]).toMatchObject({ kind: 'creation', title: 'Walk by the river', swarm_id: 's1', mind_id: 'm1', state: 'Empty', detail: 'Plan' })
    expect(items[0].ref).toBeUndefined()
    expect(items[1]).toMatchObject({ revision: 2, detail: 'Studio source', ref: { artifact_id: 'ar6', revision: 2, digest } })
    expect(items[1].state).toBeUndefined()
  })

  it('an empty creation says who started it and that there is nothing to open, and opens that mind\'s chat', () => {
    const d = artifactsScreen({ status: 'ready', list: { items, missing: [] } }, NO_FILTER, names, now)
    const rows = d.data['artifacts.shown'] as ArtifactRow[]
    expect(rows[0]).toMatchObject({
      title: 'Walk by the river', kind: 'Creation', state: 'Empty', byline: 'by Juniper · in Trips · 5m ago',
      detail: 'Juniper started this plan but saved nothing in it, so there is nothing to open.', code: 'ar5',
      action: 'Ask Juniper', route: { name: 'dot', id: 'm1', tab: 'chat' },
    })
    const html = renderToStaticMarkup(createElement(Screen, { plan: ScreensSpace.open().compose('artifacts', 'classic', d.facts), host: { data: d.data, framed: true, onOpen: () => undefined, onInput: () => undefined } }))
    expect(html).toContain('>Empty</span>')
    expect(html).toContain('>Ask Juniper</button>')
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Creation <span[^>]*>2<\/span>/)
    // a mind this person does not see is never named or offered
    const unseen = artifactsScreen({ status: 'ready', list: { items, missing: [] } }, NO_FILTER, { ...names, minds: {} }, now)
    expect((unseen.data['artifacts.shown'] as ArtifactRow[])[0]).toMatchObject({ detail: 'Nothing was saved in this plan, so there is nothing to open.', action: '', route: null })
  })

  it('a saved creation opens in Design where this hive offers Design, and is read in place where it does not', () => {
    const rowsWith = (apps: Names['apps']) => artifactsScreen({ status: 'ready', list: { items, missing: [] } }, NO_FILTER, { ...names, apps }, now).data['artifacts.shown'] as ArtifactRow[]
    expect(rowsWith({ omegadesign: 'Design' })[1]).toMatchObject({ kind: 'Creation', state: '', detail: 'Studio source', action: 'Open in Design', code: 'ar6 r2', read: null })
    // a fresh install offers no Design: Open in Design would lead to "This app isn't available to you here"
    expect(rowsWith({})[1]).toMatchObject({ detail: 'Studio source', action: 'Read it', route: null, read: { artifact_id: 'ar6', revision: 2 } })
    // an empty one has nothing to read, so it still asks its mind
    expect(rowsWith({})[0]).toMatchObject({ action: 'Ask Juniper', read: null })
  })

  it("Ask <mind> takes the artifact to that mind's chat box, and a row opening anywhere else takes nothing", () => {
    const rows = artifactsScreen({ status: 'ready', list: { items, missing: [] } }, NO_FILTER, names, now).data['artifacts.shown'] as ArtifactRow[]
    expect(rows[0]).toMatchObject({ action: 'Ask Juniper', about: { id: 'ar5', title: 'Walk by the river' } })
    const designed = artifactsScreen({ status: 'ready', list: { items, missing: [] } }, NO_FILTER, { ...names, apps: { omegadesign: 'Design' } }, now)
    expect((designed.data['artifacts.shown'] as ArtifactRow[])[1]).toMatchObject({ action: 'Open in Design', about: null })
    expect(rows[2]).toMatchObject({ action: 'Open flows', about: null })
  })

  it('a saved plan never opens in Design, which opens only Studio sources', () => {
    // Design showed "This design could not be opened" for a plan a mind saved, on a hive offering Design
    const saved = composeArtifacts({ creations: [{ ...creations[0], revision: 1, digest }] })
    const rows = artifactsScreen({ status: 'ready', list: { items: saved, missing: [] } }, NO_FILTER, { ...names, apps: { omegadesign: 'Design' } }, now).data['artifacts.shown'] as ArtifactRow[]
    expect(saved[0]).toMatchObject({ creation_kind: 'plan', ref: { artifact_id: 'ar5', revision: 1, digest } })
    // the row's next place answers instead: its mind's chat here, Read it where a hive reads a plan in place
    expect(rows[0].detail).toBe('Plan')
    expect(rows[0].action).not.toBe('Open in Design')
    expect(rows[0].action).not.toBe('')
    expect(rows[0].route?.name).not.toBe('program')
  })

  it('the Creation kind keeps only them', () => {
    expect(filterArtifacts(items, { ...NO_FILTER, kind: 'creation' }).map((a) => a.key)).toEqual(['creation:ar5', 'creation:ar6'])
    expect(withInput(NO_FILTER, 'kind', 'creation').kind).toBe('creation')
  })
})
