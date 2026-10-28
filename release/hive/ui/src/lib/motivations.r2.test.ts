import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { Motivation, MotivationRef, TaskItem } from '../api/types'
import { applyMotivation } from '../store/reducer'
import { useHive } from '../store/store'
import * as lib from './motivations'
import motivationsPage from '../features/tasks/MotivationsPage.tsx?raw'
import tasksPage from '../features/tasks/TasksPage.tsx?raw'
import appSrc from '../App.tsx?raw'

/**
 * Stand-in FIX-FIRST on 61936cb (STANDIN_SURFACE_MOTIVATIONS_61936cb_VERDICT_20261007): revoked visibility purges what a
 * second person already holds (P1-1), a draft saves against the revision it was opened at (P1-2), paging never treats a
 * part as the whole (P2-3), and the radio groups move with the arrow keys (P2-4). INVENTED DATA, fake hive only.
 */
const L = lib as unknown as Record<string, unknown>
const flush = () => new Promise((r) => setTimeout(r, 0))
const at = '2026-10-07T00:00:00Z'
const mo = (id: string, extra: Partial<Motivation> = {}): Motivation => ({ id, title: `Shared why ${id}`, why: 'words only the shared people may read', owner: 'user:p_one', swarm_id: null, status: 'active', visibility: 'shared', rev: 1, parent_id: null, created_by: 'user:p_one', created_at: at, updated_at: at, status_changed_at: null, editable: false, ...extra })
const task = (id: string, refs: MotivationRef[]): TaskItem => ({ id, swarm_id: 's_a', parent_id: null, title: `task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: at, updated_at: at, motivations: refs, requests: [] })

function useFake(client: Record<string, unknown>) {
  useHive.setState({ client: client as never, session: `test-${Math.random()}`, motivations: {}, motivationsLoaded: false, taskLinks: {}, taskLinksLoaded: false, goals: {}, linksSeq: 0 })
}

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => vi.unstubAllGlobals())

describe('P1-1: revoked visibility leaves nothing on a second person’s open view', () => {
  it('person one makes a shared motivation private; person two’s open view loses its title, why and chips', async () => {
    // the hive as person two sees it: person one's shared motivation, on one task
    const world = { shared: true }
    const m = mo('mo_shared')
    const ref = { id: m.id, title: m.title, status: m.status }
    useFake({
      listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }),
      listTasks: async () => ({ items: [task('g_1', world.shared ? [ref] : [])], counts: { total: 1, by_status: { open: 1 } }, cursor: null }),
      getMotivation: async (id: string) => {
        if (world.shared && id === m.id) return m
        throw new ApiError(404, 'not_found', 'no such motivation')
      },
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    expect(useHive.getState().motivations[m.id]?.why).toBe(m.why)
    expect(useHive.getState().taskLinks.g_1).toEqual([ref])

    // person one makes it private: the hive sends person two no event at all (it can no longer read the row)
    world.shared = false
    const target = new EventTarget()
    const watch = L.watchMotivations as undefined | ((t: EventTarget, everyMs: number) => () => void)
    const stop = watch ? watch(target, 1e9) : () => undefined
    target.dispatchEvent(new Event('focus'))
    for (let i = 0; i < 5; i++) await flush()
    stop()

    const s = useHive.getState()
    expect(s.motivations[m.id]).toBeUndefined()
    expect(JSON.stringify(s.motivations)).not.toContain(m.why)
    expect(s.taskLinks.g_1).toEqual([])
    expect(JSON.stringify(s.taskLinks)).not.toContain(m.title)
  })

  it('a full re-read purges refs to a motivation it no longer lists, even when the task read has not run again', async () => {
    const world = { shared: true }
    const m = mo('mo_gone')
    useFake({ listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }), listTasks: async () => ({ items: [task('g_2', [{ id: m.id, title: m.title, status: m.status }])], counts: { total: 1, by_status: {} }, cursor: null }) })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    world.shared = false
    await lib.loadMotivations(true)
    expect(useHive.getState().taskLinks.g_2).toEqual([])
  })

  it('an open view with no focus change is still checked again on the timer', async () => {
    const world = { shared: true }
    const m = mo('mo_timer')
    const ref = { id: m.id, title: m.title, status: m.status }
    useFake({ listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }), listTasks: async () => ({ items: [task('g_3', world.shared ? [ref] : [])], counts: { total: 1, by_status: {} }, cursor: null }) })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    world.shared = false
    const watch = L.watchMotivations as undefined | ((t: EventTarget, everyMs: number) => () => void)
    expect(typeof watch).toBe('function')
    const stop = watch!(new EventTarget(), 5)
    await new Promise((r) => setTimeout(r, 40))
    stop()
    expect(useHive.getState().motivations[m.id]).toBeUndefined()
    expect(useHive.getState().taskLinks.g_3).toEqual([])
  })

  it('the app mounts the one watcher for every experience', () => {
    expect(appSrc).toMatch(/useMotivationWatch\(\)/)
  })
})

describe('P1-2: a draft saves against the revision it was opened at', () => {
  it('a live edit arriving before Save is refused, never overwritten (an unchanged draft field included)', async () => {
    const host = { row: mo('mo_edit', { editable: true, owner: 'user:p_me', created_by: 'user:p_me', visibility: 'private' }) }
    const patches: unknown[] = []
    useFake({
      patchMotivation: async (_id: string, body: { title?: string; why?: string; expected_rev: number }) => {
        patches.push(body)
        if (body.expected_rev !== host.row.rev) throw new ApiError(409, 'motivation_changed', 'changed')
        host.row = { ...host.row, ...('title' in body ? { title: body.title! } : {}), ...('why' in body ? { why: body.why! } : {}), rev: host.row.rev + 1 }
        return host.row
      },
      getMotivation: async () => host.row,
    })
    useHive.setState((s) => applyMotivation(s, host.row))
    // the person opens the editor at revision 1
    const seen = useHive.getState().motivations.mo_edit
    const draft = { title: 'My clearer title', why: seen.why }
    // someone else's edit lands live (revision 2): a new why
    host.row = { ...host.row, why: 'their newer why', rev: 2, updated_at: '2026-10-07T00:01:00Z' }
    useHive.setState((s) => applyMotivation(s, host.row))
    expect(useHive.getState().motivations.mo_edit.rev).toBe(2)

    const save = L.saveDraft as undefined | ((seen: Motivation, d: { title: string; why: string }) => Promise<lib.Outcome<Motivation>>)
    expect(typeof save).toBe('function')
    const r = await save!(seen, draft)
    expect(r.ok).toBe(false)
    expect(patches).toEqual([{ title: 'My clearer title', expected_rev: 1 }])
    expect(host.row.why).toBe('their newer why')
    expect(host.row.title).not.toBe('My clearer title')
  })

  it('the page saves the motivation captured when editing began, never the live one, and says when it changed meanwhile', () => {
    expect(motivationsPage).toMatch(/saveDraft\(seen,/)
    expect(motivationsPage).not.toMatch(/editMotivation\(m, \{ \.\.\.\(title/)
    expect(motivationsPage).toMatch(/m\.rev !== seen\.rev/)
    expect(motivationsPage).toMatch(/data-changed-meanwhile/)
  })

  it('an unchanged draft sends nothing', async () => {
    const patches: unknown[] = []
    useFake({ patchMotivation: async (_id: string, body: unknown) => (patches.push(body), mo('mo_same')) })
    const seen = mo('mo_same', { editable: true })
    const save = L.saveDraft as undefined | ((seen: Motivation, d: { title: string; why: string }) => Promise<lib.Outcome<Motivation>>)
    expect(typeof save).toBe('function')
    const r = await save!(seen, { title: `${seen.title}  `, why: seen.why })
    expect(r.ok).toBe(true)
    expect(patches).toEqual([])
  })
})

describe('P2-3: paging never treats a part as the whole', () => {
  it('an eleventh page of tasks and of motivations is read', async () => {
    const pages = 11
    const cursorAt = (n: number) => (n + 1 < pages ? `c${n + 1}` : null)
    const pageOf = (cursor?: string) => (cursor ? Number(cursor.slice(1)) : 0)
    useFake({
      listMotivations: async (q: { cursor?: string }) => {
        const n = pageOf(q.cursor)
        return { items: [mo(`mo_p${n}`)], cursor: cursorAt(n) }
      },
      listTasks: async (q: { cursor?: string }) => {
        const n = pageOf(q.cursor)
        return { items: [task(`g_p${n}`, [{ id: `mo_p${n}`, title: 't', status: 'active' }])], counts: { total: pages, by_status: {} }, cursor: cursorAt(n) }
      },
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    const s = useHive.getState()
    expect(Object.keys(s.motivations)).toHaveLength(pages)
    expect(Object.keys(s.taskLinks)).toHaveLength(pages)
    // r4: the chip shows the title the motivations read delivered, never the one the task answer carried
    expect(s.taskLinks.g_p10).toEqual([{ id: 'mo_p10', title: s.motivations.mo_p10.title, status: 'active' }])
  })

  it('a read stopped by the guard is marked partial and takes nothing away', async () => {
    const m = mo('mo_kept')
    const kept = { id: m.id, title: m.title, status: m.status }
    let n = 0
    useFake({
      listMotivations: async () => ({ items: [mo(`mo_e${n++}`)], cursor: 'more' }),
      listTasks: async () => ({ items: [task(`g_e${n++}`, [])], counts: { total: 0, by_status: {} }, cursor: 'more' }),
    })
    useHive.setState({ motivations: { [m.id]: m }, motivationsLoaded: true, taskLinks: { g_old: [kept] }, taskLinksLoaded: true })
    await lib.loadMotivations(true)
    await lib.loadTaskLinks(true)
    const s = useHive.getState() as unknown as Record<string, unknown> & ReturnType<typeof useHive.getState>
    expect(s.motivationsPartial).toBe(true)
    expect(s.taskLinksPartial).toBe(true)
    expect(s.motivations[m.id]).toBeDefined()
    expect(s.taskLinks.g_old).toEqual([kept])
    const r = (await lib.readAllTasks({}, 2)) as unknown
    expect(r).toMatchObject({ complete: false })
  })

  it('a task whose links were never read is not Unsorted', () => {
    const isUnsorted = L.isUnsorted as undefined | ((links: Record<string, MotivationRef[]>, id: string) => boolean)
    expect(typeof isUnsorted).toBe('function')
    expect(isUnsorted!({ g_read: [] }, 'g_read')).toBe(true)
    expect(isUnsorted!({ g_read: [] }, 'g_never_read')).toBe(false)
  })
})

describe('P2-4: radio groups move with the arrow keys', () => {
  it('arrows, Home and End choose the next value, wrapping', () => {
    const next = L.nextRadio as undefined | (<T>(key: string, values: readonly T[], current: T) => T | null)
    expect(typeof next).toBe('function')
    const v = ['active', 'paused', 'achieved', 'retired'] as const
    expect(next!('ArrowRight', v, 'active')).toBe('paused')
    expect(next!('ArrowDown', v, 'retired')).toBe('active')
    expect(next!('ArrowLeft', v, 'active')).toBe('retired')
    expect(next!('ArrowUp', v, 'paused')).toBe('active')
    expect(next!('Home', v, 'achieved')).toBe('active')
    expect(next!('End', v, 'paused')).toBe('retired')
    expect(next!('a', v, 'paused')).toBeNull()
  })
  it('one tab stop; arrows choose a view, but only move focus over a choice the hive acts on', () => {
    const rp = L.radioProps as undefined | ((v: string, vs: readonly string[], cur: string | undefined, choose: (v: string) => void, mode?: 'select' | 'focus') => { tabIndex: number; 'aria-checked': boolean; onKeyDown(e: unknown): void })
    expect(typeof rp).toBe('function')
    const v = ['board', 'list'] as const
    expect(rp!('board', v, 'list', () => undefined).tabIndex).toBe(-1)
    expect(rp!('list', v, 'list', () => undefined).tabIndex).toBe(0)
    expect(rp!('board', v, undefined, () => undefined).tabIndex).toBe(0)
    const focused: string[] = []
    const ev = { key: 'ArrowRight', preventDefault: () => undefined, currentTarget: { parentElement: { querySelector: (sel: string) => ({ focus: () => focused.push(sel) }) } } }
    const chosen: string[] = []
    rp!('board', v, 'board', (x) => chosen.push(x)).onKeyDown(ev)
    expect(chosen).toEqual(['list'])
    rp!('board', v, 'board', (x) => chosen.push(x), 'focus').onKeyDown(ev)
    expect(chosen).toEqual(['list'])
    expect(focused).toEqual(['[data-radio-value="list"]', '[data-radio-value="list"]'])
  })

  it('every radio group on the two pages uses the keyboard pattern (one tab stop, arrows move)', () => {
    for (const [name, src] of [['MotivationsPage', motivationsPage], ['TasksPage', tasksPage]] as const) {
      const radios = src.match(/role="radio"/g)?.length ?? 0
      expect(radios, name).toBeGreaterThan(0)
      expect(src.match(/\{\.\.\.radioProps\(/g)?.length ?? 0, name).toBe(radios)
    }
  })
})
