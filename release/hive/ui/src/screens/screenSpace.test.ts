import { describe, expect, it, vi } from 'vitest'
import { ScreensSpace, SCREEN_SOURCES } from './screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const FIXTURE = `
(Screen demo "Demo")
(Part demo 10 header ((title "Hello") (body (bind who))))
(RolePart demo 20 collection ((source items)))
(When demo 20 (has items))
(Part demo 21 empty ((title "Nothing yet")))
(When demo 21 (none items))
(Part demo 30 timeline ((source events)))
(Part demo 40 notice ((text "Offline")))
(When demo 40 (on offline))
`
const open = () => ScreensSpace.open([...SCREEN_SOURCES, ['demo', FIXTURE]])

describe('MeTTa composes a screen (real MeTTa)', () => {
  it('shows the parts whose conditions hold for this moment, in order', () => {
    const s = open()
    const empty = s.compose('demo', 'classic', { counts: { items: 0 } })
    expect(empty.parts.map((p) => p.block)).toEqual(['header', 'empty', 'list'])
    const full = s.compose('demo', 'classic', { counts: { items: 3 }, flags: { offline: true } })
    expect(full.parts.map((p) => p.block)).toEqual(['header', 'list', 'list', 'notice'])
    expect(full.parts[0].props).toEqual({ title: 'Hello', body: { bind: 'who' } })
  })
  it('the look decides how a role is drawn', () => {
    const s = open()
    expect(s.compose('demo', 'cosmos', { counts: { items: 1 } }).parts[1]).toMatchObject({ block: 'cards', how: { kind: 'look' } })
    expect(s.compose('demo', 'still', { counts: { items: 1 } }).parts[1]).toMatchObject({ block: 'list', how: { kind: 'role' } })
  })
  it('a block nothing draws falls back to its role and becomes a build task', () => {
    const p = open().compose('demo', 'cosmos', { counts: { items: 1 } })
    expect(p.parts.find((x) => x.order === 30)).toMatchObject({ block: 'cards', how: { kind: 'fallback', wanted: 'timeline' } })
    expect(p.missing).toEqual([{ screen: 'demo', order: 30, wanted: 'timeline', drawnAs: 'cards' }])
  })
  it('depth: each part sits at its layer, and a 3D look says so', () => {
    const s = ScreensSpace.open([...SCREEN_SOURCES, ['demo', FIXTURE + '(Depth demo 40 float)']])
    const flat = s.compose('demo', 'still', { counts: { items: 1 }, flags: { offline: true } })
    expect(flat.space).toBe('flat')
    expect(flat.parts.map((p) => [p.order, p.depth.layer, p.depth.z])).toEqual([[10, 'float', 3], [20, 'surface', 1], [30, 'surface', 1], [40, 'float', 3]])
    expect(s.compose('demo', 'cosmos').space).toBe('3d')
  })
  it('facts last for one composition only', () => {
    const s = open()
    s.compose('demo', 'classic', { counts: { items: 5 }, flags: { offline: true } })
    expect(s.compose('demo', 'classic').parts.map((p) => p.block)).toEqual(['header', 'empty', 'list'])
  })
  it('the guards are clean for every screen the page loads', () => {
    const g = ScreensSpace.open().guards()
    expect(g).toEqual({ unknownBlocks: [], rolesWithoutDefault: [], badLookPrefs: [], orphanConditions: [], undeclaredScreens: [], badDepths: [], badRegions: [], badConditions: [], rolesWithoutWords: [], badResources: [] })
    expect(ScreensSpace.open().screens()).toEqual(expect.arrayContaining(['tool', 'tools']))
  })
})
