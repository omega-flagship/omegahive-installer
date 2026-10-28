import { describe, expect, it } from 'vitest'
import type { Motivation, MotivationRef, TaskItem } from '../api/types'
import { useHive } from '../store/store'
import * as lib from './motivations'

/**
 * Stand-in FIX-FIRST on b26a46a (STANDIN_SURFACE_MOTIVATIONS_r3_VERDICT_20261007, P1-1): a late task answer may carry only
 * motivations the newest complete visibility snapshot lists (an allow-list, so ids the store never saw are dropped too),
 * and a motivation's title is shown only as a motivations read delivered it. Re-sharing still brings it back.
 * INVENTED DATA, fake hive only.
 */
const L = lib as unknown as Record<string, unknown>
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const at = '2026-10-07T00:00:00Z'
const mo = (id: string, extra: Partial<Motivation> = {}): Motivation => ({ id, title: `Secret aim ${id}`, why: `words only the named people may read ${id}`, owner: 'user:p_one', swarm_id: null, status: 'active', visibility: 'shared', rev: 1, parent_id: null, created_by: 'user:p_one', created_at: at, updated_at: at, status_changed_at: null, editable: false, ...extra })
const task = (id: string, refs: MotivationRef[]): TaskItem => ({ id, swarm_id: 's_a', parent_id: null, title: `task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: at, updated_at: at, motivations: refs, requests: [] })
const refOf = (m: Pick<Motivation, 'id' | 'title' | 'status'>): MotivationRef => ({ id: m.id, title: m.title, status: m.status })
type Page = { items: TaskItem[]; counts: object; cursor: null }
const page = (items: TaskItem[]): Page => ({ items, counts: { total: items.length, by_status: {} }, cursor: null })
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
function fakeHive(client: Record<string, unknown>) {
  useHive.setState({ client: client as never, session: `test-${Math.random()}`, motivations: {}, motivationsLoaded: false, motivationsPartial: false, taskLinks: {}, taskLinksLoaded: false, taskLinksPartial: false, goals: {}, swarms: {}, agents: {}, linksSeq: 0 } as never)
}
/** A hive whose task answers can be held back one at a time. */
function hive(listed: () => Motivation[], tasks: () => TaskItem[]) {
  const held: ReturnType<typeof deferred<Page>>[] = []
  const ctl = { hold: false }
  fakeHive({
    listMotivations: async () => ({ items: listed(), cursor: null }),
    listTasks: async () => {
      if (!ctl.hold) return page(tasks())
      const d = deferred<Page>()
      held.push(d)
      return d.promise
    },
  })
  return { held, ctl }
}
const shown = () => JSON.stringify(useHive.getState().taskLinks)


describe('P1-1 on b26a46a: a late task answer carries only what the newest visibility snapshot lists', () => {
  it('(a) a revoked id the store once held: re-shared, read by a task read, revoked again, the snapshot no longer lists it — the late answer drops it', async () => {
    const x = mo('mo_known')
    const world = { x: true }
    const h = hive(() => (world.x ? [x] : []), () => [task('g_1', world.x ? [refOf(x)] : [])])
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    // revoked, and a full re-read purges it (the store held it, so this is recorded)
    world.x = false
    await lib.revalidateMotivations()
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    // shared again on the hive; a task read starts and is answered with it, but its answer is held back
    world.x = true
    h.ctl.hold = true
    const older = lib.loadTaskLinks(true)
    await flush()
    // revoked again; a full motivations read lands without it (the store no longer held it, so nothing is recorded by id)
    world.x = false
    await lib.loadMotivations(true)
    // the held answer, given while it was shared, lands now
    h.held[0].resolve(page([task('g_1', [refOf(x)])]))
    await older
    await flush()
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    expect(shown()).not.toContain(x.title)
  })

  it('(b) an id the store never saw, in an answer that started before the snapshot, is dropped; a listed one beside it stays', async () => {
    const y = mo('mo_kept')
    const u = { id: 'mo_never', title: 'Never listed for you', status: 'active' as const }
    const h = hive(() => [y], () => [task('g_1', [refOf(y)])])
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    h.ctl.hold = true
    const older = lib.loadTaskLinks(true)
    await flush()
    await lib.loadMotivations(true)
    h.held[0].resolve(page([task('g_1', [refOf(y), u]), task('g_2', [u])]))
    await older
    await flush()
    const s = useHive.getState()
    expect(s.taskLinks.g_1).toEqual([refOf(y)])
    expect(s.taskLinks.g_2).toEqual([])
    expect(shown()).not.toContain(u.id)
    expect(shown()).not.toContain(u.title)
  })

  it('(c) re-shared: an older answer keeps a motivation the newest snapshot lists again, titled as that snapshot says; an unlisted ref beside it goes', async () => {
    const x = mo('mo_again')
    const renamed = { ...x, title: 'Shared again, renamed', rev: 2, updated_at: '2026-10-07T00:00:05Z' }
    const u = { id: 'mo_other', title: 'Not yours', status: 'active' as const }
    const world = { x: true as boolean, now: x }
    const h = hive(() => (world.x ? [world.now] : []), () => [task('g_1', world.x ? [refOf(world.now)] : [])])
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    world.x = false
    await lib.revalidateMotivations()
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    // a task read starts; it is answered (late) with the old title and an unlisted ref
    h.ctl.hold = true
    const older = lib.loadTaskLinks(true)
    await flush()
    // shared again (and renamed): the newest snapshot lists it
    world.x = true
    world.now = renamed
    await lib.loadMotivations(true)
    h.held[0].resolve(page([task('g_1', [refOf(x), u])]))
    await older
    await flush()
    const s = useHive.getState()
    expect(s.taskLinks.g_1).toEqual([refOf(renamed)])
    expect(shown()).not.toContain(u.title)
    expect(shown()).not.toContain(x.title)
  })

  it('the stand-in’s exact reproduction: deferred task read; motivations read returns nothing; the older answer with mo_unseen installs nothing', async () => {
    const h = hive(() => [], () => [])
    h.ctl.hold = true
    const older = lib.loadTaskLinks(true)
    await flush()
    await lib.loadMotivations(true)
    h.held[0].resolve(page([task('g_1', [{ id: 'mo_unseen', title: 'Revoked secret', status: 'active' }])]))
    await older
    await flush()
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    expect(shown()).not.toContain('mo_unseen')
    expect(shown()).not.toContain('Revoked secret')
  })

  it('the detail view’s task read (one motivation’s tasks) is held to the same allow-list', async () => {
    const y = mo('mo_detail4')
    const late = deferred<Page>()
    fakeHive({
      listMotivations: async () => ({ items: [y], cursor: null }),
      listTasks: async (q: { motivation?: string }) => (q.motivation ? late.promise : page([task('g_1', [refOf(y)])])),
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    const pending = lib.readMotivationTasks(y.id)
    await flush()
    await lib.loadMotivations(true)
    late.resolve(page([task('g_1', [refOf(y), { id: 'mo_unseen', title: 'Revoked secret', status: 'active' }])]))
    await pending
    expect(useHive.getState().taskLinks.g_1).toEqual([refOf(y)])
    expect(shown()).not.toContain('Revoked secret')
  })

  it('before any snapshot, refs are kept but a title no motivations read delivered is never shown; the read that delivers it fills it in', async () => {
    const y = mo('mo_first')
    const motivationsAnswer = deferred<{ items: Motivation[]; cursor: null }>()
    fakeHive({
      listMotivations: () => motivationsAnswer.promise,
      listTasks: async () => page([task('g_1', [refOf(y)])]),
    })
    const both = Promise.all([lib.loadMotivations(), lib.loadTaskLinks()])
    await flush()
    const before = useHive.getState().taskLinks.g_1
    expect(before.map((r) => r.id)).toEqual([y.id])
    expect(shown()).not.toContain(y.title)
    expect(before[0].title).toBe(L.UNREAD_TITLE)
    motivationsAnswer.resolve({ items: [y], cursor: null })
    await both
    expect(useHive.getState().taskLinks.g_1).toEqual([refOf(y)])
  })

  it('a read that starts after the snapshot landed keeps what it carries (liveness), titled once a motivations read delivers it', async () => {
    const y = mo('mo_new')
    const world = { y: false }
    hive(() => (world.y ? [y] : []), () => [task('g_1', world.y ? [refOf(y)] : [])])
    await lib.loadMotivations()
    world.y = true
    await lib.loadTaskLinks(true)
    expect(useHive.getState().taskLinks.g_1.map((r) => r.id)).toEqual([y.id])
    expect(shown()).not.toContain(y.title)
    await lib.loadMotivations(true)
    expect(useHive.getState().taskLinks.g_1).toEqual([refOf(y)])
  })
})
