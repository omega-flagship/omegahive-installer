import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Swarm } from '../api/types'
import { releasePersons, signInAs, switchPerson, testPerson } from '../lib/identityEpoch.testkit'
import { resolve } from '../lib/intent'
import { MAX_HIVES, PREFIX, readPositions, resetPositions, savePosition } from './galaxyPositions'
import { useViewer } from './viewer'
import { byHive, visibleSet, NO_VIEWER } from './visibleSet'

/**
 * Hive scaling r1, the UI-only parts: per-person galaxy positions (kept in this browser, gone from memory on an
 * identity change), the viewer cleared on an identity change (P7), the map's Ask words, and the lists' grouping.
 * Synthetic SimClients and INVENTED names only.
 */

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

let storage: ReturnType<typeof memoryStorage>
beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('window', { location: { search: '' } })
  vi.stubGlobal('localStorage', storage)
})
afterEach(() => {
  releasePersons()
  vi.unstubAllGlobals()
})

describe('galaxy positions, per person, in this browser', () => {
  it('kept under the person’s own key; another person reads none of them', () => {
    savePosition('user:p_ari', 'hive:user:p_ari', { x: 10.4, y: -20.6 })
    expect(readPositions('user:p_ari')).toEqual({ 'hive:user:p_ari': { x: 10, y: -21 } })
    expect(readPositions('user:p_bo')).toEqual({})
    expect([...storage.m.keys()]).toEqual([`${PREFIX}${encodeURIComponent('user:p_ari')}`])
  })
  it('nothing kept without a known person; only hive ids, finite numbers, bounded', () => {
    savePosition(null, 'hive:cloud', { x: 1, y: 1 })
    savePosition('user:p_ari', 'not a hive', { x: 1, y: 1 })
    savePosition('user:p_ari', 'hive:cloud', { x: Number.NaN, y: 1 })
    expect(storage.m.size).toBe(0)
    const big: Record<string, unknown> = {}
    for (let i = 0; i < MAX_HIVES + 50; i++) big[`hive:user:p_${i}`] = { x: i, y: i }
    big['hive:user:bad'] = { x: 'x', y: 1 }
    big['<script>'] = { x: 1, y: 1 }
    storage.setItem(`${PREFIX}${encodeURIComponent('user:p_cass')}`, JSON.stringify(big))
    const read = readPositions('user:p_cass')
    expect(Object.keys(read)).toHaveLength(MAX_HIVES)
    expect(read['<script>']).toBeUndefined()
  })
  it('reset forgets the arrangement', () => {
    savePosition('user:p_ari', 'hive:cloud', { x: 5, y: 5 })
    resetPositions('user:p_ari')
    expect(readPositions('user:p_ari')).toEqual({})
    expect(storage.m.size).toBe(0)
  })
  it('an identity change drops the in-memory copy and the viewer at once', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    savePosition('user:p_ari', 'hive:cloud', { x: 7, y: 7 })
    // the stored copy is replaced behind the cache; the cache still answers until the identity changes
    storage.setItem(`${PREFIX}${encodeURIComponent('user:p_ari')}`, JSON.stringify({ 'hive:cloud': { x: 99, y: 99 } }))
    expect(readPositions('user:p_ari')).toEqual({ 'hive:cloud': { x: 7, y: 7 } })
    useViewer.setState({ viewer: { ...NO_VIEWER, principal: 'user:p_ari', admin: true }, names: { 'user:p_ari': 'Ari Ashdown' } })
    const done = switchPerson(a, b)
    expect(useViewer.getState().viewer.principal).toBeNull()
    expect(useViewer.getState().names).toEqual({})
    expect(readPositions('user:p_ari')).toEqual({ 'hive:cloud': { x: 99, y: 99 } })
    await done
  })
})

describe('the map’s Ask words (layout only)', () => {
  const hives = [
    { id: 'hive:cloud', name: 'Cloud hive', cloud: true },
    { id: 'hive:user:p_me', name: 'Your hive', mine: true, aliases: ['my'] },
    { id: 'hive:user:p_ari', name: 'Ashdown hive', aliases: ['Ari Ashdown', 'Ari', 'Ashdown'] },
    { id: 'hive:user:p_bo', name: 'A hive', aliases: [] },
    { id: 'hive:user:p_bo2', name: 'A hive', aliases: [] },
  ]
  const world = { minds: [], swarms: [], pending: 0, hives }
  const top = (t: string) => resolve(t, { experience: 'classic' }, world)[0]
  it('"show me Ari’s hive", "the Ashdown hive", "my hive", "the cloud hive"', () => {
    expect(top('show me Ari’s hive')?.act).toEqual({ do: 'map', op: 'galaxy', label: 'Ashdown hive', hive: 'hive:user:p_ari' })
    expect(top('go to the Ashdown hive')?.act).toMatchObject({ op: 'galaxy', hive: 'hive:user:p_ari' })
    expect(top('show me Ari Ashdown’s hive.')?.act).toMatchObject({ op: 'galaxy', hive: 'hive:user:p_ari' })
    expect(top('my hive')?.act).toMatchObject({ op: 'galaxy', hive: 'hive:user:p_me' })
    expect(top('take me to the cloud hive')?.act).toMatchObject({ op: 'galaxy', hive: 'hive:cloud' })
  })
  it('zoom and the whole universe', () => {
    expect(top('zoom out')?.act).toMatchObject({ do: 'map', op: 'zoomOut' })
    expect(top('zoom in')?.act).toMatchObject({ do: 'map', op: 'zoomIn' })
    expect(top('show me every hive')?.act).toMatchObject({ do: 'map', op: 'overview' })
    expect(top('show all the hives')?.act).toMatchObject({ do: 'map', op: 'overview' })
    expect(top('show the whole universe')?.act).toMatchObject({ do: 'map', op: 'overview' })
  })
  it('"rearrange the hives", "tidy up the galaxies", "put my hives back": the person’s own arrangement only', () => {
    for (const t of ['rearrange the hives', 'tidy up the galaxies', 'reset the layout', 'put my hives back']) expect(top(t)?.act, t).toMatchObject({ do: 'map', op: 'resetLayout' })
  })
  it('a hive this viewer may not name cannot be named; an unknown name is not a map act', () => {
    for (const t of ['show me a hive', 'show me Bo’s hive', 'show me Zed’s hive']) expect(resolve(t, { experience: 'classic' }, world).some((c) => c.act?.do === 'map' || c.key.startsWith('map-')), t).toBe(false)
  })
  it('no client offers split, merge or move today (the capability seam is empty for the live and sim clients)', async () => {
    const { hiveActionsOffered } = await import('./hiveActions')
    const { SimClient } = await import('../api/sim/SimClient')
    expect(hiveActionsOffered(new SimClient({ latency: false, autoStart: false, historyDays: 1 })).size).toBe(0)
    // the live client's methods are instance fields: none of the routes' methods is defined on it
    const live = (await import('../api/live.ts?raw')).default
    for (const m of ['listHives', 'planHiveChange', 'splitHive', 'mergeHives', 'moveSwarmToHive']) expect(live).not.toMatch(new RegExp(`\\b${m}\\s*[=(]`))
    const all = { listHives() {}, planHiveChange() {}, splitHive() {}, mergeHives() {} }
    expect([...hiveActionsOffered(all)].sort()).toEqual(['merge', 'split'])
  })
  it('split, merge and move offer nothing: no hive advertises those routes yet', () => {
    for (const t of ['split my hive', 'merge my two hives', 'move Vega to the Ashdown hive']) expect(resolve(t, { experience: 'classic' }, world).some((c) => c.act?.do === 'map'), t).toBe(false)
  })
  it('no map words where the map shows no hives (another experience)', () => {
    expect(resolve('zoom out', { experience: 'still' }, { minds: [], swarms: [], pending: 0 }).some((c) => c.act?.do === 'map')).toBe(false)
  })
})

describe('lists take the shown set, grouped by hive', () => {
  const sw = (id: string, name: string, owner: string | null, extra: Partial<Swarm> = {}): Swarm => ({ id, name, description: '', hue: 0, member_ids: [], created_at: '', ...(owner ? { owner } : {}), ...extra })
  it('your hive, the cloud hive, then other people’s; another person’s personal swarm never; archived kept for lists', () => {
    const viewer = { ...NO_VIEWER, principal: 'user:p_me', homesState: 'resolved' as const }
    const swarms = [sw('s_z', 'Zinc', 'user:p_other'), sw('s_c', 'Cobalt', null), sw('s_m', 'Moss', 'user:p_me'), sw('s_p', 'Ari', 'user:p_other', { personal_of: 'user:p_other' }), sw('s_old', 'Amber', 'user:p_me', { archived_at: '2026-01-01' })]
    const v = visibleSet(swarms, [], viewer, { map: false, keepArchived: true })
    expect([...v.swarms].sort(byHive(v, (s) => s.name)).map((s) => s.id)).toEqual(['s_old', 's_m', 's_c', 's_z'])
  })
})
