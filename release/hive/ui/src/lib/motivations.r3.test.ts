import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '../api/client'
import type { Goal, HiveEvent, Motivation, MotivationRef, Swarm, TaskItem } from '../api/types'
import { SimMotivations } from '../api/sim/motivations'
import { useHive } from '../store/store'
import * as lib from './motivations'
import { run } from '../experiences/construct/commands'
import { useC } from '../experiences/construct/state'
import motivationsPage from '../features/tasks/MotivationsPage.tsx?raw'
import tasksPage from '../features/tasks/TasksPage.tsx?raw'
import fluxSheets from '../experiences/flux/sheets.tsx?raw'
import cosmosDeck from '../experiences/cosmos/Deck.tsx?raw'
import canvasPanel from '../experiences/canvas/HivePanel.tsx?raw'
import stillSheets from '../experiences/still/Sheets.tsx?raw'

/**
 * Stand-in FIX-FIRST on 57e64ca (STANDIN_SURFACE_MOTIVATIONS_r2_VERDICT_20261007): Construct's console forgets a revoked
 * motivation's words (P1-1), a late task answer never restores revoked chips (P1-2), shared is a real choice with named
 * people that round-trips exactly (P2-3), and counts from a partial read say they may be short (P2-4).
 * INVENTED DATA, fake hive only.
 */
const L = lib as unknown as Record<string, unknown>
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const at = '2026-10-07T00:00:00Z'
const mo = (id: string, extra: Partial<Motivation> = {}): Motivation => ({ id, title: `Secret aim ${id}`, why: `words only the named people may read ${id}`, owner: 'user:p_one', swarm_id: null, status: 'active', visibility: 'shared', rev: 1, parent_id: null, created_by: 'user:p_one', created_at: at, updated_at: at, status_changed_at: null, editable: false, ...extra })
const task = (id: string, refs: MotivationRef[]): TaskItem => ({ id, swarm_id: 's_a', parent_id: null, title: `task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: at, updated_at: at, motivations: refs, requests: [] })
const refOf = (m: Motivation): MotivationRef => ({ id: m.id, title: m.title, status: m.status })
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function useFake(client: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  useHive.setState({ client: client as never, session: `test-${Math.random()}`, motivations: {}, motivationsLoaded: false, motivationsPartial: false, taskLinks: {}, taskLinksLoaded: false, taskLinksPartial: false, goals: {}, swarms: {}, agents: {}, linksSeq: 0, ...extra } as never)
}
const consoleText = () => JSON.stringify([useC.getState().console, useC.getState().flash])

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } })
  useC.setState({ console: [], flash: null })
})
afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------- P1-1

describe('P1-1: Construct’s console keeps nothing of a motivation once it is revoked', () => {
  it('`motivation 1` and `motivations` print its title and why; after revocation and a re-read, neither is left in the console or the flash', async () => {
    const world = { shared: true }
    const m = mo('mo_con')
    useFake({
      listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }),
      listTasks: async () => ({ items: [task('g_1', world.shared ? [refOf(m)] : [])], counts: { total: 1, by_status: {} }, cursor: null }),
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    await run('motivation 1')
    await run('motivations')
    expect(consoleText()).toContain(m.title)
    expect(consoleText()).toContain(m.why)
    expect(consoleText()).toContain('"t":"task g_1"')

    // person one makes it private: person two's full re-read no longer lists it
    world.shared = false
    await lib.revalidateMotivations()
    await flush()
    expect(useHive.getState().motivations[m.id]).toBeUndefined()
    expect(consoleText()).not.toContain(m.title)
    expect(consoleText()).not.toContain(m.why)
    // the tasks it listed under it (membership comes from the motivation) go too
    expect(consoleText()).not.toContain('"t":"task g_1"')
    expect(consoleText()).toContain('no longer see')
  })

  it('a task line’s motivation chip is redacted too, and a motivation still readable is left alone', async () => {
    const gone = mo('mo_gone')
    const kept = mo('mo_kept', { visibility: 'public' })
    const world = { shared: true }
    const sw = { id: 's_a', name: 'lyra', hue: 200, created_at: at } as unknown as Swarm
    const goal = (id: string): Goal => ({ ...task(id, []), motivations: undefined, requests: undefined } as unknown as Goal)
    useFake(
      {
        listMotivations: async () => ({ items: world.shared ? [gone, kept] : [kept], cursor: null }),
        listTasks: async () => ({ items: [task('g_1', world.shared ? [refOf(gone)] : []), task('g_2', [refOf(kept)])], counts: { total: 2, by_status: {} }, cursor: null }),
        listGoals: async () => [],
      },
      { swarms: { s_a: sw }, goals: { g_1: goal('g_1'), g_2: goal('g_2') } },
    )
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    await run('tasks for 1')
    await run('tasks')
    expect(consoleText()).toContain(gone.title)
    world.shared = false
    await lib.loadMotivations(true)
    expect(consoleText()).not.toContain(gone.title)
    expect(consoleText()).toContain(kept.title)
  })
})

// ---------------------------------------------------------------- P1-2

describe('P1-2: a late task answer never brings revoked chips back', () => {
  it('an older task read resolving after the revocation purge restores nothing (deferred, then revoked, then resolved)', async () => {
    const m = mo('mo_late')
    const world = { shared: true }
    const late = deferred<{ items: TaskItem[]; counts: object; cursor: null }>()
    let calls = 0
    useFake({
      listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }),
      listTasks: async () => (++calls === 2 ? late.promise : { items: [task('g_1', world.shared ? [refOf(m)] : [])], counts: { total: 1, by_status: {} }, cursor: null }),
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    expect(useHive.getState().taskLinks.g_1).toEqual([refOf(m)])

    // a task read starts while the hive still lists the motivation; its answer is held back
    const older = lib.loadTaskLinks(true)
    await flush()
    // the motivation is made private, and a full motivations read purges it
    world.shared = false
    await lib.loadMotivations(true)
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    // the older answer lands now, still carrying the revoked ref
    late.resolve({ items: [task('g_1', [refOf(m)])], counts: { total: 1, by_status: {} }, cursor: null })
    await older
    await flush()
    const s = useHive.getState()
    expect(s.taskLinks.g_1).toEqual([])
    expect(JSON.stringify(s.taskLinks)).not.toContain(m.title)
  })

  it('the stand-in’s reproduction: in one re-read, the task answer lands after the motivations purge and is dropped', async () => {
    const m = mo('mo_race')
    const world = { shared: true }
    let hold: ReturnType<typeof deferred<{ items: TaskItem[]; counts: object; cursor: null }>> | null = null
    useFake({
      listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }),
      listTasks: async () => (hold ? hold.promise : { items: [task('g_1', [refOf(m)])], counts: { total: 1, by_status: {} }, cursor: null }),
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    world.shared = false
    hold = deferred()
    const both = lib.revalidateMotivations()
    await flush()
    // the motivations answer has landed and purged; the task answer (served before the revocation) lands afterwards
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    hold.resolve({ items: [task('g_1', [refOf(m)])], counts: { total: 1, by_status: {} }, cursor: null })
    await both
    await flush()
    expect(useHive.getState().taskLinks.g_1).toEqual([])
  })

  it('the detail view’s own task read (one motivation’s tasks) is held to the same rule', async () => {
    const m = mo('mo_detail')
    const world = { shared: true }
    const late = deferred<{ items: TaskItem[]; counts: object; cursor: null }>()
    useFake({
      listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }),
      listTasks: async (q: { motivation?: string }) => (q.motivation ? late.promise : { items: [task('g_1', world.shared ? [refOf(m)] : [])], counts: { total: 1, by_status: {} }, cursor: null }),
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    const readOne = L.readMotivationTasks as undefined | ((id: string) => Promise<unknown>)
    expect(typeof readOne, 'the detail read lives in lib, with a generation').toBe('function')
    const pending = readOne!(m.id)
    await flush()
    world.shared = false
    await lib.loadMotivations(true)
    late.resolve({ items: [task('g_1', [refOf(m)]), task('g_9', [refOf(m)])], counts: { total: 2, by_status: {} }, cursor: null })
    await pending
    const s = useHive.getState()
    expect(s.taskLinks.g_1).toEqual([])
    expect(s.taskLinks.g_9).toEqual([])
    // and the page uses it rather than writing task links itself
    expect(motivationsPage).toMatch(/readMotivationTasks\(id\)/)
    expect(motivationsPage).not.toMatch(/taskLinks\[it\.id\] = it\.motivations/)
  })

  it('a read that starts after the purge landed shows a motivation shared again', async () => {
    const m = mo('mo_back')
    const world = { shared: true }
    useFake({
      listMotivations: async () => ({ items: world.shared ? [m] : [], cursor: null }),
      listTasks: async () => ({ items: [task('g_1', world.shared ? [refOf(m)] : [])], counts: { total: 1, by_status: {} }, cursor: null }),
    })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    world.shared = false
    await lib.revalidateMotivations()
    expect(useHive.getState().taskLinks.g_1).toEqual([])
    world.shared = true
    await lib.revalidateMotivations()
    await lib.loadTaskLinks(true)
    expect(useHive.getState().taskLinks.g_1).toEqual([refOf(m)])
  })
})

// ---------------------------------------------------------------- P2-3

function simClient() {
  const swarms = new Map([['s_a', { id: 's_a', name: 's_a', owner: 'user:p_owner', visibility: 'public', created_at: at } as unknown as Swarm]])
  const events: HiveEvent[] = []
  const viewer: Me = { principal: 'user:p_owner', kind: 'sso', role: 'member', expires_at: null, person: { id: 'p_owner', email: null, name: 'Owner' } }
  let t = 0
  const sim = new SimMotivations({ me: () => viewer, swarms: () => swarms, goals: () => new Map(), goalRow: (g) => g, requestsFor: () => [], emit: (e) => events.push(e), now: () => `2026-10-07T00:00:${String(++t).padStart(2, '0')}Z` })
  const sent: unknown[] = []
  return {
    sent,
    client: {
      createMotivation: async (b: object) => (sent.push(['create', b]), sim.create(b as never)),
      setMotivationVisibility: async (id: string, b: object) => (sent.push(['visibility', b]), sim.setVisibility(id, b as never)),
      getMotivation: async (id: string) => sim.get(id),
      listMotivations: async () => ({ items: sim.list({}).items, cursor: null }),
    },
  }
}

describe('P2-3: shared, with named people, is a real choice and round-trips exactly', () => {
  it('create shared with recipients: the body says shared (never private) and names them as the hive keeps them', () => {
    const createBody = L.createBody as undefined | ((f: object) => Record<string, unknown>)
    expect(typeof createBody).toBe('function')
    const body = createBody!({ title: ' Teach newcomers ', why: 'plain words', whose: 'me', visibility: 'shared', sharedWith: ['user:p_rowan', 'user:p_ada', 'user:p_rowan'] })
    expect(body).toEqual({ title: 'Teach newcomers', why: 'plain words', visibility: 'shared', shared_with: ['user:p_ada', 'user:p_rowan'] })
    expect(createBody!({ title: 'x', why: '', whose: 'team:s_a', visibility: 'public' })).toEqual({ title: 'x', why: '', owner: 'swarm:s_a', swarm_id: 's_a', visibility: 'public' })
    expect(createBody!({ title: 'x', why: '', whose: 'me:s_a', visibility: 'private' })).toEqual({ title: 'x', why: '', swarm_id: 's_a', visibility: 'private' })
  })

  it('create shared, change the people, read it back: the same people each time', async () => {
    const { client, sent } = simClient()
    useFake(client)
    const createBody = L.createBody as (f: object) => never
    const made = await lib.createMotivation(createBody({ title: 'Explain the science', why: '', whose: 'me', visibility: 'shared', sharedWith: ['user:p_rowan', 'user:p_ada'] }))
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.value.visibility).toBe('shared')
    expect(made.value.shared_with).toEqual(['user:p_ada', 'user:p_rowan'])
    expect((await lib.refreshMotivation(made.value.id))?.shared_with).toEqual(['user:p_ada', 'user:p_rowan'])

    // change the people (one out, one in), against the revision opened
    const seen = useHive.getState().motivations[made.value.id]
    const changed = await lib.setMotivationVisibility(seen, 'shared', ['user:p_zed', 'user:p_ada'])
    expect(changed.ok).toBe(true)
    expect(sent.at(-1)).toEqual(['visibility', { visibility: 'shared', shared_with: ['user:p_ada', 'user:p_zed'], expected_rev: seen.rev }])
    const back = await lib.refreshMotivation(made.value.id)
    expect(back?.visibility).toBe('shared')
    expect(back?.shared_with).toEqual(['user:p_ada', 'user:p_zed'])
    expect(useHive.getState().motivations[made.value.id].shared_with).toEqual(['user:p_ada', 'user:p_zed'])
  })

  it('shared needs at least one person before it can be saved', () => {
    const problem = L.visibilityProblem as undefined | ((v: string, p: string[]) => string | null)
    expect(typeof problem).toBe('function')
    expect(problem!('shared', [])).toMatch(/at least one person/)
    expect(problem!('shared', ['user:p_ada'])).toBeNull()
    expect(problem!('private', [])).toBeNull()
  })

  it('the page offers shared and editing its people, and never turns shared into private', () => {
    expect(motivationsPage).not.toMatch(/'shared' \? 'private'/)
    expect(motivationsPage).not.toMatch(/\(\['private', 'public'\] as const\)/)
    expect(motivationsPage).toMatch(/VISIBILITY_CHOICES\.map/)
    expect(motivationsPage).toMatch(/<PeoplePicker /)
    expect(motivationsPage).toMatch(/setMotivationVisibility\(sharing\.seen, 'shared', sharing\.people\)/)
    expect(L.VISIBILITY_CHOICES).toEqual(['private', 'shared', 'public'])
  })
})

// ---------------------------------------------------------------- P2-4

describe('P2-4: counts from a partial read say they may be short, everywhere they show', () => {
  it('a count from a partial read is a floor', () => {
    const atLeast = L.atLeast as undefined | ((n: number, p: boolean) => string)
    expect(typeof atLeast).toBe('function')
    expect(atLeast!(3, true)).toBe('3+')
    expect(atLeast!(3, false)).toBe('3')
  })

  it('Construct says so beside its counts', async () => {
    const m = mo('mo_part', { visibility: 'public' })
    useFake({ listMotivations: async () => ({ items: [m], cursor: null }), listTasks: async () => ({ items: [], counts: { total: 0, by_status: {} }, cursor: null }) })
    await lib.loadMotivations()
    await lib.loadTaskLinks()
    useHive.setState({ taskLinksPartial: true } as never)
    await run('motivations')
    expect(consoleText()).toContain('may be short')
    await run('motivation 1')
    expect(consoleText().match(/may be short/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('the Tasks page, the motivation in full, and every experience’s motivation counts consult the partial flags', () => {
    const uses = (src: string) => /useCountsPartial\(\)/.test(src) && /PARTIAL_WORDS/.test(src)
    for (const [name, src] of [['TasksPage', tasksPage], ['MotivationsPage', motivationsPage], ['flux', fluxSheets], ['cosmos', cosmosDeck], ['canvas', canvasPanel], ['still', stillSheets]] as const) expect(uses(src), name).toBe(true)
    // the detail view also counts its own read's completeness
    expect(motivationsPage).toMatch(/setDetailComplete\(read\.complete\)/)
    expect(motivationsPage).toMatch(/<ProgressBar p=\{progress\} partial=\{partial\} \/>/)
    expect(motivationsPage).toMatch(/atLeast\(ids\.size, partial\)/)
    expect(tasksPage).toMatch(/atLeast\(perMotivation\.out\[x\.id\] \?\? 0, partial\)/)
    expect(tasksPage).toMatch(/atLeast\(perMotivation\.unsorted, partial\)/)
  })
})
