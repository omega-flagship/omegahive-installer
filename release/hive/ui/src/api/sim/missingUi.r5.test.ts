import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../client'
import { useHive } from '../../store/store'
import { bindEpoch, STALE } from '../../lib/identityEpoch'
import { releasePersons, signInAs, switchPerson, testPerson, type TestPerson } from '../../lib/identityEpoch.testkit'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 1929 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
// followups-r6 MEASURED (r5's 60 s hook figure was an estimate): its beforeEach (signInAs) and its tests timed, caps
// lifted, two passes alone (1 worker) and two beside the other eight sim files (3 workers, load to 8.5). Worst hook
// 31587 ms, worst test 32564 ms (both in the loaded pass); about 3x that. simTimeouts.test bounds it from both sides.
vi.setConfig({ testTimeout: 100000, hookTimeout: 100000 })

/**
 * Missing-UI batch 1 r5 (stand-in r4 P1, STANDIN_MISSING_UI_B1_R4_VERDICT_20261007): an answer that arrives after an
 * identity change writes nothing for the new person: no toast in the store, no callback, no list update. The change is
 * the hardest kind, a credential replaced on the SAME client (testkit switchPerson with sameTab). Each test fails on
 * cab29d9 and passes after; modules are imported inside each test so one missing export fails only its own test.
 * INVENTED DATA only.
 */

function defer<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)))
  return { promise, resolve, reject }
}
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
const storeToast = (t: Parameters<ReturnType<typeof useHive.getState>['toast']>[0]) => useHive.getState().toast(t)
const toastTitles = () => useHive.getState().toasts.map((t) => t.title)

let a: TestPerson
let b: TestPerson
beforeEach(async () => {
  vi.stubGlobal('window', { location: { search: '' } })
  a = testPerson('a')
  b = testPerson('b', { sameTab: a })
  await signInAs(a)
})
afterEach(() => {
  releasePersons()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Start `run` as A, switch to B on the same client, then let A's answer land. */
async function lateForA<R>(run: () => Promise<R>, land: () => void): Promise<R> {
  const p = run()
  await switchPerson(a, b)
  land()
  const r = await p
  await flush()
  return r
}

describe('r5: CodeAccess Give, a late answer after a same-client credential replacement', () => {
  const grant = { id: 'gr_1', goal_id: 'g_1', principal: 'user:p_ada', scope: 'read', created_by: 'user:a', created_at: 1, expires_at: Date.now() / 1000 + 3600, revoked_at: null, active: true }

  it('writes nothing for the new person: no onDone, no toast in the store; it resolves STALE (r6)', async () => {
    const { giveGrantRun } = await import('../../features/tasks/CodeAccess')
    const d = defer<typeof grant>()
    const onDone = vi.fn()
    const run = giveGrantRun({ client: { addGoalGrant: () => d.promise } as unknown as HiveClient, goalId: 'g_1', person: { id: 'p_ada', name: 'Ada' }, scope: 'read', minutes: 30, onDone, toast: storeToast })
    const r = await lateForA(run, () => d.resolve(grant))
    expect(r).toBe(STALE)
    expect(onDone).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('a late failure shows nothing either', async () => {
    const { giveGrantRun } = await import('../../features/tasks/CodeAccess')
    const d = defer<typeof grant>()
    const run = giveGrantRun({ client: { addGoalGrant: () => d.promise } as unknown as HiveClient, goalId: 'g_1', person: { id: 'p_ada', name: 'Ada' }, scope: 'read', minutes: 30, onDone: vi.fn(), toast: storeToast })
    expect(await lateForA(run, () => d.reject(new Error('A’s refusal words')))).toBe(STALE)
    expect(toastTitles()).toEqual([])
  })

  it('control: with no identity change the same answer is written', async () => {
    const { giveGrantRun } = await import('../../features/tasks/CodeAccess')
    const onDone = vi.fn()
    const run = giveGrantRun({ client: { addGoalGrant: async () => grant } as unknown as HiveClient, goalId: 'g_1', person: { id: 'p_ada', name: 'Ada' }, scope: 'read', minutes: 30, onDone, toast: storeToast })
    expect(await run()).toBe(true)
    expect(onDone).toHaveBeenCalledWith(grant)
    expect(toastTitles()).toEqual(['Ada was given read-only code access'])
  })
})

describe('r5: every other completion in the batch is bound the same way (one late-answer check per place)', () => {
  it('Cleanup: no onDone, no toast', async () => {
    const { cleanupRun } = await import('../../features/assets/Cleanup')
    const d = defer<unknown>()
    const onDone = vi.fn()
    const run = cleanupRun({ client: { cleanupAsset: () => d.promise } as unknown as HiveClient, seen: { sha256: 'x' }, stores: [], onDone, toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ name: 'f', sha256: 'x', local_only: true, placements: ['local'], history: [] }))).toBe(STALE)
    expect(onDone).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('Outside-agent invitations: no list update, no reload, no toast', async () => {
    const { revokeInviteRun } = await import('../../features/harness/OpenInvites')
    const d = defer<unknown>()
    const res = { mutate: vi.fn(), reload: vi.fn() }
    const run = revokeInviteRun({ client: { revokeHarnessInvite: () => d.promise } as unknown as HiveClient, asking: { id: 'hi_1', status: 'waiting', name: 'x' }, res, toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ id: 'hi_1', status: 'revoked' }))).toBe(STALE)
    expect(res.mutate).not.toHaveBeenCalled()
    expect(res.reload).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('App access pause: no note, no toast', async () => {
    const { appGrantsRun } = await import('../../features/programs/AppGrants')
    const live = await import('../../shell/liveNotices')
    const d = defer<unknown>()
    const session = useHive.getState().session
    const run = appGrantsRun({ client: { revokeProgramGrants: () => d.promise } as unknown as HiveClient, programId: 'p_1', name: 'App', session, what: 'pause', toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ program: 'p_1', grants_revoked: true }))).toBe(STALE)
    expect(live.appGrantsNote('p_1', session)).toBeFalsy()
    expect(live.appGrantsNote('p_1', useHive.getState().session)).toBeFalsy()
    expect(toastTitles()).toEqual([])
  })

  it('Registered services: no list update, no toast', async () => {
    const { serviceRun } = await import('../../features/settings/RegisteredServices')
    const d = defer<unknown>()
    const mutate = vi.fn()
    const run = serviceRun({ client: { setServiceEnabled: () => d.promise } as unknown as HiveClient, asking: { seen: { id: 'sv_1', name: 'S' }, what: 'off' }, mutate, toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ id: 'sv_1', enabled: false }))).toBe(STALE)
    expect(mutate).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('Revoke a connection with a reason: no onDone, no toast', async () => {
    const { revokeConnectionRun } = await import('../../features/swarm/RevokeConnection')
    const d = defer<unknown>()
    const onDone = vi.fn()
    const run = revokeConnectionRun({ client: { connectionAction: () => d.promise } as unknown as HiveClient, id: 'c_1', reason: 'r', onDone, toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ id: 'c_1', status: 'revoked' }))).toBe(STALE)
    expect(onDone).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('Service grant revoke (Swarm services): no onDone, no toast', async () => {
    const { revokeGrantRun } = await import('../../features/swarm/SwarmServices')
    const d = defer<unknown>()
    const onDone = vi.fn()
    const run = revokeGrantRun({ client: { connectionAction: () => d.promise } as unknown as HiveClient, id: 'c_1', reason: '', onDone, toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ id: 'c_1', status: 'revoked' }))).toBe(STALE)
    expect(onDone).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('Ask for an update: no onDone, no toast', async () => {
    const { requestUpdateRun, requestBody } = await import('../../features/updates/RequestUpdate')
    const d = defer<unknown>()
    const onDone = vi.fn()
    const run = requestUpdateRun({ client: { requestUpdate: () => d.promise } as unknown as HiveClient, body: requestBody('platform', 'please', ''), label: 'The platform', onDone, toast: storeToast })
    expect(await lateForA(run, () => d.resolve({ note: 'please' }))).toBe(STALE)
    expect(onDone).not.toHaveBeenCalled()
    expect(toastTitles()).toEqual([])
  })

  it('My Explore groups rename: no list update, no close, no onChanged; back to idle', async () => {
    const { renameGroup } = await import('../../features/explore/MyGroups')
    const d = defer<unknown>()
    const deps = { client: { renameExploreGroup: () => d.promise } as unknown as HiveClient, setGroups: vi.fn(), setEditing: vi.fn(), onChanged: vi.fn(), setBusy: vi.fn(), toast: storeToast }
    await lateForA(() => renameGroup(deps, { id: 'eg_1', name: 'old', members: [] }, 'new'), () => d.resolve({ id: 'eg_1', name: 'new', members: [] }))
    expect(deps.setGroups).not.toHaveBeenCalled()
    expect(deps.setEditing).not.toHaveBeenCalled()
    expect(deps.onChanged).not.toHaveBeenCalled()
    expect(deps.setBusy).toHaveBeenLastCalledWith(false)
    expect(toastTitles()).toEqual([])
  })

  it('Flow adoptions take-back: the re-read is not written into the rows', async () => {
    const { unadoptRun } = await import('../../features/flow/Adoptions')
    const d = defer<unknown>()
    const setReads = vi.fn()
    const run = unadoptRun({ client: { unadoptFlow: async () => ({}), flowRevision: () => d.promise } as unknown as HiveClient, artifactId: 'fl_1', revision: 2, setReads })
    expect(await lateForA(run, () => d.resolve({ revision: 2, adoption: null }))).toBe(STALE)
    expect(setReads).not.toHaveBeenCalled()
  })

  it('Ask audit: a late page is not written (nor its failure)', async () => {
    const { readAuditPage } = await import('../../features/settings/AskAudit')
    const d = defer<unknown[]>()
    const take = vi.fn()
    const fail = vi.fn()
    await lateForA(() => readAuditPage({ askAudit: () => d.promise } as unknown as HiveClient, { limit: 50 }, bindEpoch(), take, fail), () => d.resolve([{ turn_id: 't_secret' }]))
    expect(take).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('Earlier: a late history read is not written (nor its failure)', async () => {
    const { readHistory } = await import('../../features/ask/Earlier')
    const d = defer<unknown[]>()
    const take = vi.fn()
    const fail = vi.fn()
    await lateForA(() => readHistory({ askHistory: () => d.promise } as unknown as HiveClient, 20, bindEpoch(), take, fail), () => d.reject(new Error('A’s words')))
    expect(take).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('the views key their per-person lists by the identity epoch (Earlier, Ask audit, flow rows)', () => {
    const fsName = 'node:fs'
    return import(/* @vite-ignore */ fsName).then((fs: { readFileSync: (p: string, e: 'utf8') => string }) => {
      const SRC = new URL('../..', import.meta.url).pathname
      const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')
      expect(read('features/ask/Earlier.tsx')).toContain('<EarlierFor key={epoch}')
      expect(read('features/settings/AskAudit.tsx')).toContain('<AuditList key={epoch} />')
      expect(read('features/flow/Adoptions.tsx')).toContain('key={`${epoch}:${f.artifact_id}`}')
    })
  })
})
