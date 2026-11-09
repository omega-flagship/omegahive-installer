import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ExploreGroupDef, ExploreResult, ExploreView } from '../../api/types'
import { DRAWN_BLOCKS, Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import exploreSource from './explore.metta?raw'
import { DEFAULT_SPEC, exploreScreen, grouped, groupedEarlier, ungrouped, withFilter, withKind, type ExploreInput } from './data'

vi.setConfig({ testTimeout: 20_000 })

/** The Explore page end to end: an invented hive → facts → MeTTa composes the page → drawn. INVENTED DATA only. */
const space = ScreensSpace.open()
const seen: Record<string, Set<number>> = { explore: new Set(), 'explore-group': new Set() }
const compose = (screen: string, facts: Parameters<typeof space.compose>[2]) => {
  const plan = space.compose(screen, 'classic', facts)
  for (const p of plan.parts) seen[screen]?.add(p.order)
  return plan
}

const RESULT: ExploreResult = {
  total: 3,
  facet_names: ['kind', 'state', 'swarm', 'tag'],
  facets: {
    kind: { mind: 2, swarm: 1 }, state: { working: 2, resting: 1 }, swarm: { Gardeners: 3 }, tag: { lamps: 1 },
    where: { '(none)': 3 }, purpose: {}, role: {}, owner: {}, visibility: {}, health: {}, spend: {}, active: {}, group: {},
  } as ExploreResult['facets'],
  groups: [{ facet: 'kind', value: 'mind', path: 'kind=mind', count: 2 }],
}
const GROUPS: ExploreGroupDef[] = [{ id: 'eg_1', name: 'Night shift', members: ['m_1', 'm_2'] }, { id: 'eg_2', name: 'Lamp crew', members: ['m_3'] }]
const VIEWS: ExploreView[] = [{ id: 'v_1', name: 'Busy minds', spec: {}, arrangement: {}, updated_at: '2026-02-01T09:00:00Z' }]
const BASE: ExploreInput = {
  supported: true, result: RESULT, error: null, spec: DEFAULT_SPEC, q: '', layout: 'list', viewId: null, views: VIEWS,
  groups: GROUPS, groupsOpen: false, can: { groups: true, rename: true, remove: true }, renaming: null, problem: null,
}

function page(over: Partial<ExploreInput> = {}, host: Partial<ScreenHost> = {}) {
  const s = exploreScreen({ ...BASE, ...over }, compose)
  const plan = compose('explore', s.facts)
  const islands = { 'explore-groups': createElement('p', null, 'GROUPS'), 'explore-items': createElement('p', null, 'ITEMS') }
  const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: s.data, framed: true, islands, onInput: () => {}, onOpen: () => {}, onAction: () => {}, ...host } }))
  return { ...s, plan, html, orders: plan.parts.map((p) => p.order), blocks: plan.parts.map((p) => p.block) }
}

describe('the Explore page, composed by MeTTa', () => {
  it('draws the toolbar, kinds, groupings, the answer in groups, the note, and the filters beside them', () => {
    const p = page()
    expect(p.orders).toEqual([10, 11, 12, 13, 15, 20, 30, 31, 34, 61, 70, 80, 83, 85, 86, 82].sort((a, b) => a - b))
    expect(p.plan.missing).toEqual([])
    expect(p.html).toContain('<span class="sr-only">Search</span>')
    expect(p.html).toContain('placeholder="Search names, purposes, ids"')
    expect(p.html).toMatch(/aria-label="Layout"/)
    expect(p.html).toMatch(/<select aria-label="Saved views"[^>]*><option value="" selected="">Unsaved view<\/option><option value="v_1">Busy minds</)
    expect(p.html).toMatch(/>Save view</)
    expect(p.html).toMatch(/data-tour="my-groups"[^>]*>(<[^>]*>)*?<button[^>]*aria-expanded="false"[^>]*>(<[^>]*>)*My groups/)
    expect(p.html).toContain('role="group" aria-label="Kinds"')
    expect(p.html).toMatch(/<span class="truncate">Minds<\/span><span[^>]*>2<\/span>/)
    expect(p.html).toMatch(/<span class="truncate">Rooms<\/span><span[^>]*>0<\/span>/)
    expect(p.html).toContain('aria-label="Stop grouping by Kind"')
    expect(p.html).toMatch(/<select aria-label="Add a grouping"[^>]*><option value="" selected="">\+ add<\/option><option value="state">State<\/option>/)
    expect(p.html).toContain('GROUPS')
    expect(p.html).not.toContain('ITEMS')
    expect(p.html).toContain('Drag (or use ↑ ↓) to arrange')
    // the filters sit in the side column; a facet with only (none), or nothing, is left out
    expect(p.html).toMatch(/data-screen-region="aside"[^]*Filters[^]*State[^]*working 2/)
    expect(p.html).not.toMatch(/<legend[^>]*>Where</)
    expect(p.data['explore.eyebrow']).toBe('3 shown')
  })

  it('the kinds are chips, each pressed for a chosen kind; a press toggles that one kind through the page', () => {
    const pressed = (h: string) => Object.fromEntries([...h.matchAll(/aria-pressed="(true|false)"[^>]*><span class="truncate">(\w+)</g)].map((m) => [m[2], m[1] === 'true']))
    expect(pressed(page().html)).toEqual({ Minds: true, Swarms: true, Apps: true, Rooms: true })
    expect(pressed(page({ spec: { ...DEFAULT_SPEC, kinds: ['swarm', 'room'] } }).html)).toEqual({ Minds: false, Swarms: true, Apps: false, Rooms: true })
    // before the hive answers, the chips have no counts
    expect(page({ result: null }).data['explore.kinds']).toEqual([{ id: 'mind', label: 'Minds' }, { id: 'swarm', label: 'Swarms' }, { id: 'app', label: 'Apps' }, { id: 'room', label: 'Rooms' }])
    // several may be on, bound to the chosen kinds; a press sends the page's existing kind press (withKind) with the item
    const kinds = page().plan.parts.find((x) => x.order === 20)
    expect(kinds?.block).toBe('pills')
    expect(kinds?.props.multi).toBe('yes')
    expect(kinds?.props.action).toBe('kind')
    expect(kinds?.props.bind).toBe('explore.kinds.on')
    expect(page({ spec: { ...DEFAULT_SPEC, kinds: ['room', 'mind'] } }).data['explore.kinds.on']).toEqual(['mind', 'room'])
  })

  it('My groups is a button that says whether the panel is open', () => {
    expect(page().html).toMatch(/data-tour="my-groups"[^]*?<button[^>]*aria-expanded="false"/)
    expect(page({ groupsOpen: true }).html).toMatch(/data-tour="my-groups"[^]*?<button[^>]*aria-expanded="true"/)
  })

  it('the filters column is named Filters for screen readers', () => {
    expect(page().html).toContain('data-screen-region="aside" aria-label="Filters"')
    // nothing to filter by: no column at all
    expect(page({ result: null }).html).not.toContain('data-screen-region="aside"')
  })

  it('a flat answer is the other island; ticked filters show ticked, with a way to clear them', () => {
    const p = page({ result: { ...RESULT, groups: undefined, items: [] }, spec: { ...DEFAULT_SPEC, filters: { state: ['working'] } } })
    expect(p.html).toContain('ITEMS')
    expect(p.html).not.toContain('GROUPS')
    expect(p.orders).toContain(35)
    expect(p.html).toMatch(/<input type="checkbox" checked=""\/>working 2/)
  })

  it('a saved view: Save, Save as… and Delete view, and the menu shows it chosen', () => {
    const p = page({ viewId: 'v_1' })
    expect(p.orders).toEqual(expect.arrayContaining([14, 16]))
    expect(p.orders).not.toContain(13)
    expect(p.html).toMatch(/>Save<[^]*>Save as…<[^]*>Delete view</)
    expect(p.html).toMatch(/<option value="v_1" selected="">Busy minds/)
  })

  it('groupings: each later one moves earlier, three at most', () => {
    const p = page({ spec: { ...DEFAULT_SPEC, group_by: ['kind', 'state', 'swarm'] } })
    expect(p.orders).toEqual(expect.arrayContaining([31, 32, 33]))
    expect(p.orders).not.toContain(34)
    expect(p.html).toContain('aria-label="Group by State earlier"')
    expect(p.html).toContain('aria-label="Group by Swarm earlier"')
    expect(p.html).toContain('aria-label="Stop grouping by Swarm"')
    expect(p.html).not.toContain('Group by Kind earlier')
    const none = page({ spec: { ...DEFAULT_SPEC, group_by: [] } })
    expect(none.orders).not.toContain(31)
  })

  it('My groups: closed until asked for; each with Rename and Delete named for it; none yet says how to add one', () => {
    expect(page().orders).not.toContain(42)
    const p = page({ groupsOpen: true })
    expect(p.orders).toEqual(expect.arrayContaining([40, 42]))
    expect(p.html).toContain('My groups')
    expect(p.html).toContain('Only you see these.')
    expect(p.html).toContain('Night shift')
    expect(p.html).toContain('2 members')
    expect(p.html).toContain('1 member<')
    expect(p.html).toContain('aria-label="Rename Night shift"')
    expect(p.html).toContain('aria-label="Delete Lamp crew"')
    expect(page({ groupsOpen: true, groups: [] }).html).toContain('No groups yet. Add one from any row’s “Groups and tags”.')
    // a hive without groups offers no toggle and no panel
    const without = page({ groupsOpen: true, can: { groups: false, rename: false, remove: false } })
    expect(without.orders.filter((o) => o === 15 || (o >= 40 && o <= 42))).toEqual([])
    // a hive that cannot rename or delete them shows neither button
    const fixed = page({ groupsOpen: true, can: { groups: true, rename: false, remove: false } })
    expect(fixed.html).not.toContain('Rename Night shift')
    expect(fixed.html).not.toContain('Delete Night shift')
  })

  it('renaming one: a field named for it, starting from its name, and why the new name will not do', () => {
    const p = page({ groupsOpen: true, renaming: 'eg_1' })
    expect(p.html).toMatch(/<input autofocus="" aria-label="New name for Night shift" maxLength="60"[^>]*value="Night shift"/)
    expect(p.html).not.toContain('Rename Night shift')
    expect(p.html).toContain('Rename Lamp crew')
    const bad = page({ groupsOpen: true, renaming: 'eg_1', problem: 'You already have a group with that name.' })
    expect(bad.html).toMatch(/role="alert"[^>]*>You already have a group with that name\.</)
  })

  it('reading: loading, not offered, failed with Try again, a failed refresh over the last answer, and nothing matching', () => {
    const loading = page({ result: null })
    expect(loading.html).toContain('aria-label="Loading everything in this hive"')
    expect(loading.orders).not.toContain(80)
    expect(loading.data['explore.eyebrow']).toBe('Everything in this hive')
    const off = page({ supported: false, result: null })
    expect(off.html).toContain('Not available here')
    expect(off.html).toContain('This hive does not offer the explorer yet.')
    const failed = page({ result: null, error: 'the hive is asleep' })
    expect(failed.html).toContain('Could not load')
    expect(failed.html).toContain('the hive is asleep')
    expect(failed.html).toContain('Try again')
    const stale = page({ error: 'the hive is asleep' })
    expect(stale.html).toContain('Could not refresh: the hive is asleep Showing the last loaded data.')
    expect(stale.html).toContain('GROUPS')
    const nothing = page({ result: { ...RESULT, total: 0, groups: [] } })
    expect(nothing.html).toContain('Nothing matches')
    expect(nothing.html).toContain('Try fewer filters or another search.')
    expect(nothing.html).not.toContain('GROUPS')
  })

  it('every part of both screens can be reached, every block they name is drawn, and the guards are clean', () => {
    // a flat answer while stale, and a failed refresh with Retry, to reach the rest
    page({ supported: false, result: null })
    page({ result: null, error: 'x' })
    page({ error: 'x' })
    page({ result: { ...RESULT, total: 0 } })
    page({ result: { ...RESULT, groups: undefined, items: [] }, spec: { ...DEFAULT_SPEC, group_by: ['kind', 'state', 'swarm'], filters: { tag: ['lamps'] } }, viewId: 'v_1', groupsOpen: true, groups: [] })
    page({ groupsOpen: true, renaming: 'eg_1', problem: 'At most 60 characters.' })
    const all: ExploreResult['facets'] = Object.fromEntries(
      ['kind', 'where', 'state', 'swarm', 'purpose', 'role', 'owner', 'visibility', 'health', 'spend', 'active', 'tag', 'group'].map((f) => [f, { a: 1, b: 2 }]),
    ) as unknown as ExploreResult['facets']
    page({ result: { ...RESULT, facets: all } })
    const declared = [...exploreSource.matchAll(/^\(Part (explore(?:-group)?) (\d+) (\w+)/gm)].map((x) => [x[1], Number(x[2]), x[3]] as const)
    for (const [, , block] of declared) expect(DRAWN_BLOCKS).toContain(block)
    for (const screen of ['explore', 'explore-group']) {
      expect([...seen[screen]].sort((a, b) => a - b), screen).toEqual(space.orders(screen))
    }
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})

describe('the Explore presses (pure)', () => {
  it('kinds tick on and off, and the last one stays', () => {
    expect(withKind(DEFAULT_SPEC, 'room').kinds).toEqual(['mind', 'swarm', 'app'])
    expect(withKind({ kinds: ['mind'] }, 'mind').kinds).toEqual(['mind'])
    expect(withKind({ kinds: ['mind'] }, 'app').kinds).toEqual(['mind', 'app'])
    expect(withKind({ kinds: ['mind'] }, 'lamp')).toEqual({ kinds: ['mind'] })
  })
  it('a filter value ticks on and off, and an empty facet is dropped', () => {
    const on = withFilter({ filters: {} }, 'state', 'working')
    expect(on.filters).toEqual({ state: ['working'] })
    expect(withFilter(on, 'state', 'working').filters).toEqual({})
  })
  it('groupings: earlier, dropped, added (never twice, at most three)', () => {
    const s = { group_by: ['kind', 'state', 'swarm'] } as const
    expect(groupedEarlier({ group_by: [...s.group_by] }, 3).group_by).toEqual(['kind', 'swarm', 'state'])
    expect(groupedEarlier({ group_by: [...s.group_by] }, 1).group_by).toEqual(['kind', 'state', 'swarm'])
    expect(ungrouped({ group_by: [...s.group_by] }, 2).group_by).toEqual(['kind', 'swarm'])
    expect(grouped({ group_by: ['kind'] }, 'tag').group_by).toEqual(['kind', 'tag'])
    expect(grouped({ group_by: ['kind'] }, 'kind').group_by).toEqual(['kind'])
    expect(grouped({ group_by: [...s.group_by] }, 'tag').group_by).toEqual(['kind', 'state', 'swarm'])
    expect(grouped({ group_by: [] }, 'nonsense').group_by).toEqual([])
  })
})
