import { describe, expect, it, vi } from 'vitest'

/**
 * The apps this person can open (Ask-and-apps contract R1.1 §3, #2): ordered pinned first, at most 8 shown with the rest
 * as "more", and bound to the identity it was loaded for. A→B→A: a late list from A never lands for B or for A again, an
 * open() kept from A does nothing for B (or for A's next sign-in), and the list clears in the change itself.
 * INVENTED data, no network.
 */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { useHive } = await import('../../store/store')
const { awakeSlice, loadMyApps, orderApps, useMyApps } = await import('./myApps')
type Row = import('./myApps').MyAppRow

const row = (id: string, o: Partial<Row> = {}): Row => ({ id, name: id.toUpperCase(), placement: 'person', open: { kind: 'person' }, ...o })
const signInChange = () => useHive.setState({ inits: useHive.getState().inits + 1 })
const later = <T,>() => { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r }); return { p, resolve } }

describe('ordering and the awake slice', () => {
  it('pinned first, then the host order; 8 shown and the rest is "more", nothing hidden', () => {
    expect(orderApps([row('a', { order: 2 }), row('b', { pinned: true, order: 5 }), row('c', { order: 1 })]).map((r) => r.id)).toEqual(['b', 'c', 'a'])
    const ten = Array.from({ length: 10 }, (_, i) => i)
    expect(awakeSlice(ten)).toEqual({ shown: [0, 1, 2, 3, 4, 5, 6, 7], more: 2 })
    expect(awakeSlice([1, 2])).toEqual({ shown: [1, 2], more: 0 })
  })
})

describe('identity lifetimes (A→B→A)', () => {
  it('a list that answers after a sign-in change never lands, for B or for A again', async () => {
    const slow = later<{ apps: Row[] }>()
    // loaded for A
    const pending = loadMyApps(() => slow.p, () => undefined)
    // B
    signInChange()
    // A again (a new sign-in: a new epoch)
    signInChange()
    slow.resolve({ apps: [row('secret-of-first-a')] })
    expect(await pending).toBe('stale')
    expect(useMyApps.getState().apps).toEqual([])
    expect(useMyApps.getState().loaded).toBe(false)
  })

  it('the list clears in the change itself, and an open() kept from A does nothing afterwards', async () => {
    const opened: string[] = []
    expect(await loadMyApps(async () => ({ apps: [row('notes'), row('board', { placement: 'swarm', open: { kind: 'swarm', swarm_id: 's1', swarm_name: 'Studio' } })] }), (r) => opened.push(r.id))).toBe('loaded')
    const kept = useMyApps.getState().apps
    expect(kept.map((a) => `${a.id}@${a.where}`)).toEqual(['notes@mine', 'board@Studio'])
    expect(kept[0].open()).toBe(true)
    signInChange()
    // cleared synchronously, before anyone sees B
    expect(useMyApps.getState().apps).toEqual([])
    expect(kept[1].open()).toBe(false)
    // back to A: still a different sign-in
    signInChange()
    expect(kept[1].open()).toBe(false)
    expect(opened).toEqual(['notes'])
  })

  it('a newer load wins over an older one for the same person', async () => {
    const first = later<{ apps: Row[] }>()
    const a = loadMyApps(() => first.p, () => undefined)
    const b = loadMyApps(async () => ({ apps: [row('new')] }), () => undefined)
    expect(await b).toBe('loaded')
    first.resolve({ apps: [row('old')] })
    expect(await a).toBe('stale')
    expect(useMyApps.getState().apps.map((x) => x.id)).toEqual(['new'])
  })

  it('a failure after a change is stale; for the current person it is said', async () => {
    const slow = later<{ apps: Row[] }>()
    const p = loadMyApps(() => slow.p.then(() => { throw new Error('no') }), () => undefined)
    signInChange()
    slow.resolve({ apps: [] })
    expect(await p).toBe('stale')
    expect(useMyApps.getState().error).toBeNull()
    expect(await loadMyApps(async () => { throw new Error('host down') }, () => undefined)).toBe('loaded')
    expect(useMyApps.getState().error).toBe('host down')
  })
})
