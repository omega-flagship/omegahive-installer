import { afterEach, describe, expect, it, vi } from 'vitest'

// A change of person while the vibe request waits for the team's proposal (lib/identityEpoch, on the REAL store
// identity change: identityEpoch.testkit's synthetic SimClients). A's request stops being polled, and its late answer
// is never shown to B. INVENTED DATA only; no hive.
vi.stubGlobal('window', { location: { search: '', hash: '#/' }, matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined })

const { SimCodeService } = await import('../../../api/sim/codeService')
const { intentsKit, until } = await import('./vibeIntents.testkit')
const { VibeSession } = await import('./vibeSession')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../../../lib/identityEpoch.testkit')
type WorkspaceHead = import('../suggestions/contract').WorkspaceHead

afterEach(() => releasePersons())

const CTX = { task_id: 'g_vibeid', grant_id: 'grant_vibeid', repository_id: 'sim-suggestions' }

describe('identity: a switch mid-poll drops the request', () => {
  it('A asks; while the team works, B signs in: polling stops, nothing of A’s is written, the late proposal is not shown', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const svc = new SimCodeService({ workspace_id: 'ws_vibeid', task_id: CTX.task_id })
    const ws = (await svc.proxy('GET', '/v1/workspaces/ws_vibeid', {}, null)) as WorkspaceHead
    const kit = intentsKit(svc, { ctx: CTX, gated: true, children: true }) // r4: "working" only once a mind is seen started
    const f = (await svc.proxy('GET', '/v1/workspaces/ws_vibeid/files', { path: 'src/greeting.py' }, null)) as { content: string; digest: string }
    // the default binding: lib/identityEpoch bindEpoch
    const session = new VibeSession({ set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => undefined }, { pollMs: [5] })
    session.setDeps({ client: kit.client, ctx: CTX, ws, turn: kit.turn, onWorkspace: async () => undefined })
    const writes: string[] = []
    session.subscribe(() => writes.push(JSON.stringify(session.getState().phase)))
    const asked = session.ask('use an f-string', null, { path: 'src/greeting.py', content: f.content, digest: f.digest }, false, () => 'Anvil', true)
    await until(() => kit.gates.length === 1)
    const polls = () => kit.log.filter((l) => /\/suggestions$/.test(l)).length
    await until(() => polls() >= 2)
    expect(session.getState().phase).toEqual({ kind: 'working', step: 'mind' })
    await switchPerson(a, b)
    const seen = { writes: writes.length, polls: polls() }
    kit.gates[0].open() // the team files its proposal for A, late
    await asked
    await new Promise((r) => setTimeout(r, 1200))
    expect(writes.length).toBe(seen.writes)
    expect(polls()).toBeLessThanOrEqual(seen.polls + 1) // at most the look already in flight
    expect(session.getState().result).toBeNull()
    expect(kit.log.some((l) => /\/suggestions\/suggestion_/.test(l))).toBe(false)
  })
  it('B signs in while A’s Code team read is in flight: nothing of A’s is written, nothing is issued or sent', async () => {
    const a = testPerson('a2')
    const b = testPerson('b2')
    await signInAs(a)
    const svc = new SimCodeService({ workspace_id: 'ws_vibeid2', task_id: CTX.task_id })
    const ws = (await svc.proxy('GET', '/v1/workspaces/ws_vibeid2', {}, null)) as WorkspaceHead
    const kit = intentsKit(svc, { ctx: CTX })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const offer = kit.client.codeTeamOffer!
    let reading = false
    kit.client.codeTeamOffer = async (c) => ((reading = true), await held, offer(c))
    const f = (await svc.proxy('GET', '/v1/workspaces/ws_vibeid2/files', { path: 'calculator.py' }, null)) as { content: string; digest: string }
    const session = new VibeSession({ set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => undefined }, { pollMs: [5] })
    session.setDeps({ client: kit.client, ctx: CTX, ws, turn: kit.turn, onWorkspace: async () => undefined })
    const writes: string[] = []
    session.subscribe(() => writes.push(JSON.stringify(session.getState().phase)))
    const asked = session.ask('fix the sum', null, { path: 'calculator.py', content: f.content, digest: f.digest }, false, () => 'Anvil', true)
    await until(() => reading)
    await switchPerson(a, b)
    const seen = writes.length
    release()
    await asked
    expect(writes.length).toBe(seen)
    expect(kit.log.some((l) => /suggestion-scopes$|^POST \/api\/ask/.test(l))).toBe(false)
  })
  it('r5: A declines; before the answer lands, B signs in and starts a request; A’s late answer changes nothing of B’s', async () => {
    const a = testPerson('a3')
    const b = testPerson('b3')
    await signInAs(a)
    const svc = new SimCodeService({ workspace_id: 'ws_vibeid3', task_id: CTX.task_id, copyApply: true })
    let ws = (await svc.proxy('GET', '/v1/workspaces/ws_vibeid3', {}, null)) as WorkspaceHead
    const kit = intentsKit(svc, { ctx: CTX, consent: true, children: true })
    const give = kit.client.proposalConsent!
    let land!: () => void
    const held = new Promise<void>((r) => (land = r))
    let declines = 0
    kit.client.proposalConsent = async (rq, id, d, digest) => {
      if (d === 'decline' && declines++ === 0) await held // A's decline answer arrives late
      return give(rq, id, d, digest)
    }
    const f = (await svc.proxy('GET', '/v1/workspaces/ws_vibeid3/files', { path: 'calculator.py' }, null)) as { content: string; digest: string }
    let cleared = 0
    const session = new VibeSession({ set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => void cleared++ }, { pollMs: [5] })
    session.setDeps({ client: kit.client, ctx: CTX, ws, turn: kit.turn, onWorkspace: async (h) => void (ws = h) })
    const file = { path: 'calculator.py', content: f.content, digest: f.digest }
    await session.ask('fix the sum', null, file, false, () => 'Anvil', true)
    expect(session.getState().phase.kind).toBe('review')
    const { DEPENDENT_GROUPS, PLAIN_SUMMARY } = await import('./features')
    const READY = { status: 'ready' as const, key: 'k', features: new Set([DEPENDENT_GROUPS, PLAIN_SUMMARY]) }
    session.review(file, false, READY, 'reject')
    expect(session.getState().reviewing).not.toBeNull()
    const declined = session.send(session.getState().reviewing!)
    await until(() => declines === 1)
    // B signs in and starts their own request on the same page
    await switchPerson(a, b)
    await session.ask('fix the sum, please', null, file, false, () => 'Anvil', false) // not reduced: B's animation is scheduled
    await until(() => ['writing', 'review'].includes(session.getState().phase.kind))
    const before = session.getState()
    const clearsBefore = cleared
    const decidedBefore = (session as unknown as { decided: boolean }).decided
    land()
    await declined
    await new Promise((r) => setTimeout(r, 50))
    // nothing of A's answer reached B: no state write, no timers cleared, no decided flag, no declined phase
    expect(session.getState().phase.kind).not.toBe('declined')
    expect(session.getState().result?.request).toBe(before.result?.request ?? session.getState().result?.request)
    expect(cleared).toBe(clearsBefore)
    expect((session as unknown as { decided: boolean }).decided).toBe(decidedBefore)
    expect(decidedBefore).toBe(false)
  })
})
