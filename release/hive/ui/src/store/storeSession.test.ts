import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../api/sim/SimClient'
import type { Approval, CollabRequest, Goal, HiveEvent, Message, Program } from '../api/types'
import { approvalBound, approvalSeenOf } from '../lib/approvalDecision'
import { goalBound, seenOf } from '../lib/goalDecision'
import { bind, inspect } from '../experiences/canvas/decision'
import { useHive } from './store'

/**
 * Surface R (OmegaReview O-B1): every store read and action is bound to the session (client instance + init) it
 * started under. A late answer from client A must never land after init has switched to client B, even when B has
 * an entity with the same id; A's live events never write into B; a decision inspected under A is refused under B.
 * Two real SimClients, real init, invented data only.
 */

const sim = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
const clients: SimClient[] = []
const pair = () => {
  const a = sim(11)
  const b = sim(12)
  clients.push(a, b)
  return { a, b }
}
function defer<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('store session binding (O-B1)', () => {
  // OmegaReview's reproducible probe (identity-probe.test.ts), ported as written
  it('rejects an approval snapshot from the previous client after a real init switch', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const a = new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })
    const b = new SimClient({ seed: 12, latency: false, autoStart: false, historyDays: 1 })
    await useHive.getState().init(a)
    const sample = Object.values(useHive.getState().approvals)[0]
    let resolve!: (v: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.spyOn(a, 'listApprovals').mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const pending = useHive.getState().loadApprovals()
    await useHive.getState().init(b)
    resolve([{ ...sample, id: 'review_old_client_only', command: 'old-client synthetic request' }])
    await pending
    expect(useHive.getState().client).toBe(b)
    expect(useHive.getState().approvals.review_old_client_only).toBeUndefined()
    a.disconnect(); b.disconnect(); vi.unstubAllGlobals()
  })

  it('approvals: a late A answer for an id B also has never replaces B’s request', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const sample = Object.values(useHive.getState().approvals)[0]
    const mine: Approval = { ...sample, id: 'ap_reused', command: 'invented B request', status: 'pending' }
    vi.spyOn(b, 'listApprovals').mockResolvedValue([mine])
    const late = defer<Approval[]>()
    vi.spyOn(a, 'listApprovals').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().loadApprovals()
    await useHive.getState().init(b)
    late.resolve([{ ...sample, id: 'ap_reused', command: 'invented A-only request', status: 'approved' }])
    await pending
    expect(useHive.getState().approvals.ap_reused).toEqual(mine)
  })

  it('switching client clears everything read under the earlier one before the new client answers', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const s0 = useHive.getState()
    expect(Object.keys(s0.approvals).length + Object.keys(s0.goals).length + Object.keys(s0.agents).length).toBeGreaterThan(0)
    useHive.setState({ paletteOpen: true })
    const hang = defer<never>()
    vi.spyOn(b, 'getHive').mockImplementation(() => hang.promise)
    void useHive.getState().init(b)
    const s = useHive.getState()
    expect(s.client).toBe(b)
    for (const k of ['approvals', 'goals', 'agents', 'swarms', 'messages', 'logs', 'requests', 'traces', 'wakeups', 'deciding', 'programDetails', 'programSessions', 'labRuns', 'endpoints'] as const)
      expect(s[k], k).toEqual({})
    for (const k of ['policy', 'programs', 'providers', 'keys', 'roles', 'catalog', 'labSuites', 'hive'] as const) expect(s[k], k).toBeNull()
    expect(s.approvalsLoaded).toBe(false)
    expect(s.requestsLoaded).toBe(false)
    expect(s.models).toEqual([])
    // client-independent UI stays
    expect(s.paletteOpen).toBe(true)
    useHive.setState({ paletteOpen: false })
  })

  it('goals: a late A list with a reused id (and a newer version) never lands in B', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const swarm = Object.keys(useHive.getState().swarms)[0]
    const sample = Object.values(useHive.getState().goals)[0]
    const mine: Goal = { ...sample, id: 'g_reused', swarm_id: swarm, title: 'invented B goal', updated_at: '2026-01-01T00:00:00.000Z' }
    vi.spyOn(b, 'listGoals').mockImplementation(async (sw: string) => (sw === swarm ? [mine] : []))
    const late = defer<Goal[]>()
    vi.spyOn(a, 'listGoals').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().loadGoals(swarm, true)
    await useHive.getState().init(b)
    late.resolve([{ ...sample, id: 'g_reused', swarm_id: swarm, title: 'invented A-only goal', updated_at: '2099-01-01T00:00:00.000Z' }])
    await pending
    expect(useHive.getState().goals.g_reused).toEqual(mine)
    expect(Object.values(useHive.getState().goals).some((g) => g.title === 'invented A-only goal')).toBe(false)
  })

  it('requests: a late A list with a reused id never lands in B', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const req = (title: string): CollabRequest => ({
      id: 'rq_reused', kind: 'task', title, from_swarm: 's_x', from_goal: null, from_principal: 'person:invented', to_swarm: 's_y',
      receiving_goal: null, state: 'open' as CollabRequest['state'], depth: 0, created_at: '2026-01-01T00:00:00.000Z', cancelled_at: null,
      budget: { root: 'rq_reused', limit_usd: 1, allocated_usd: 0 },
    })
    vi.spyOn(b, 'listRequests').mockResolvedValue([req('invented B request')])
    const late = defer<CollabRequest[]>()
    vi.spyOn(a, 'listRequests').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().loadRequests()
    await useHive.getState().init(b)
    late.resolve([req('invented A-only request')])
    await pending
    expect(useHive.getState().requests.rq_reused?.title).toBe('invented B request')
  })

  it('programs: a late A list (and a late A detail) never lands in B', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const sample = (useHive.getState().programs ?? [])[0] ?? ({ id: 'p', name: 'p', version: '1', description: '', icon: '', capabilities: [], source: 'built-in', enabled: true, error: null } as Program)
    const mine: Program = { ...sample, id: 'p_reused', name: 'invented B program' }
    vi.spyOn(b, 'programs').mockResolvedValue([mine])
    const late = defer<Program[]>()
    vi.spyOn(a, 'programs').mockImplementationOnce(() => late.promise)
    const lateDetail = defer<Awaited<ReturnType<SimClient['program']>>>()
    vi.spyOn(a, 'program').mockImplementationOnce(() => lateDetail.promise)
    const pending = useHive.getState().loadPrograms()
    const pendingDetail = useHive.getState().loadProgram('p_reused')
    await useHive.getState().init(b)
    late.resolve([{ ...sample, id: 'p_reused', name: 'invented A-only program' }])
    lateDetail.resolve({ ...sample, id: 'p_reused', name: 'invented A-only detail' } as Awaited<ReturnType<SimClient['program']>>)
    await pending
    expect(await pendingDetail).toBeNull()
    expect(useHive.getState().programs).toEqual([mine])
    expect(useHive.getState().programDetails.p_reused).toBeUndefined()
  })

  it('messages: a late A history with a reused message id never lands in B', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const agentId = Object.keys(useHive.getState().agents)[0]
    const msg = (text: string): Message => ({ id: 'm_reused', agent_id: agentId, conversation_id: 'c_inv', direction: 'in', sender: 'person:invented', text, created_at: '2026-01-01T00:00:00.000Z' })
    vi.spyOn(b, 'listMessages').mockResolvedValue([msg('invented B message')])
    const late = defer<Message[]>()
    vi.spyOn(a, 'listMessages').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().loadMessages(agentId)
    await useHive.getState().init(b)
    expect(useHive.getState().messagesLoaded[agentId]).toBeUndefined()
    await useHive.getState().loadMessages(agentId)
    late.resolve([msg('invented A-only message')])
    await pending
    expect(useHive.getState().messages[agentId]?.map((m) => m.text)).toEqual(['invented B message'])
  })

  it('A → B → A: a read A started before the switches is still dropped (a new session, not just a new client)', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const sample = Object.values(useHive.getState().approvals)[0]
    const late = defer<Approval[]>()
    vi.spyOn(a, 'listApprovals').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().loadApprovals()
    await useHive.getState().init(b)
    await useHive.getState().init(a)
    late.resolve([{ ...sample, id: 'ap_first_session_only', command: 'invented first-session request' }])
    await pending
    expect(useHive.getState().approvals.ap_first_session_only).toBeUndefined()
  })

  it('a live event from A after the switch never writes into B', async () => {
    const { a, b } = pair()
    const subA = vi.spyOn(a, 'subscribe')
    const connA = vi.spyOn(a, 'onConnection')
    await useHive.getState().init(a)
    const sample = Object.values(useHive.getState().approvals)[0]
    // the listener the store registered on A: a late delivery (or an emitter that still holds it) calls it after the switch
    const deliverA = subA.mock.calls[0][0] as (e: HiveEvent) => void
    const connectionA = connA.mock.calls[0][0] as (s: string) => void
    await useHive.getState().init(b)
    const connectionB = useHive.getState().connection
    deliverA({ type: 'approval.created', at: '2026-01-01T00:00:00.000Z', approval: { ...sample, id: 'ap_live_from_a', command: 'invented live A request', status: 'pending' } } as HiveEvent)
    connectionA('offline')
    expect(useHive.getState().approvals.ap_live_from_a).toBeUndefined()
    expect(useHive.getState().connection).toBe(connectionB)
    // and A's own emitter, after the switch, reaches nothing in B: A answers its request; B's record is untouched
    const before = useHive.getState().approvals[sample.id]
    await a.approve(sample.id).catch(() => undefined)
    expect(useHive.getState().approvals[sample.id]).toEqual(before)
  })

  it('a decision inspected under A is refused under B, even for a same-id, same-content request', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const sample = Object.values(useHive.getState().approvals).find((x) => x.status === 'pending') ?? Object.values(useHive.getState().approvals)[0]
    const pendingA: Approval = { ...sample, status: 'pending' }
    const seen = approvalSeenOf(pendingA)
    const inspected = inspect(pendingA)
    const goalA = Object.values(useHive.getState().goals).find((g) => g.status === 'open') ?? Object.values(useHive.getState().goals)[0]
    const goalSeen = seenOf(goalA)
    // B has the very same records (reused ids, identical inspected fields)
    vi.spyOn(b, 'listApprovals').mockResolvedValue([pendingA])
    vi.spyOn(b, 'listGoals').mockImplementation(async (sw: string) => (sw === goalA.swarm_id ? [goalA] : []))
    const approveB = vi.spyOn(b, 'approve')
    const denyB = vi.spyOn(b, 'deny')
    const patchB = vi.spyOn(b, 'patchGoal')
    await useHive.getState().init(b)
    const s = useHive.getState()
    expect(s.approvals[pendingA.id]).toEqual(pendingA)
    expect(s.goals[goalA.id]).toEqual(goalA)
    // the shared bindings refuse (Cosmos/Flux/Construct, Still, Canvas)
    expect(approvalBound(seen, s.approvals[pendingA.id]).kind).toBe('closed')
    expect(goalBound(goalSeen, s.goals[goalA.id], 'cancelled').kind).toBe('closed')
    expect(bind(inspected, s.approvals[pendingA.id], undefined).kind).toBe('earlier')
    // and the store refuses at dispatch: nothing reaches B
    expect(await s.decide(pendingA.id, 'approve', undefined, seen.session)).toBeNull()
    expect(await s.decide(pendingA.id, 'deny', undefined, inspected.session)).toBeNull()
    expect(await s.patchGoal(goalA.id, { status: 'cancelled' }, goalSeen.session)).toBe(false)
    expect(approveB).not.toHaveBeenCalled()
    expect(denyB).not.toHaveBeenCalled()
    expect(patchB).not.toHaveBeenCalled()
    // a snapshot taken under B is bound and may go
    expect(approvalBound(approvalSeenOf(pendingA), s.approvals[pendingA.id]).kind).toBe('ready')
  })

  it('an answer A was sending when the switch happened does not touch B (result, deciding, toast)', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    const sample = Object.values(useHive.getState().approvals)[0]
    const late = defer<Approval>()
    vi.spyOn(a, 'approve').mockImplementationOnce(() => late.promise)
    const pending = useHive.getState().decide(sample.id, 'approve')
    vi.spyOn(b, 'listApprovals').mockResolvedValue([{ ...sample, status: 'pending' }])
    await useHive.getState().init(b)
    // B is answering its own request with the same id
    useHive.setState({ deciding: { [sample.id]: 'deny' } })
    late.resolve({ ...sample, status: 'approved', decided_by: 'invented A person' })
    expect(await pending).toBeNull()
    expect(useHive.getState().approvals[sample.id].status).toBe('pending')
    expect(useHive.getState().deciding[sample.id]).toBe('deny')
    useHive.setState({ deciding: {} })
  })

  // OmegaReview R-B1 probe (storeSession-with-toast-probe.test.ts), ported as written
  it('Review R-B1: clears client-derived toast contents on switching session', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    useHive.getState().toast({ tone: 'error', title: 'Invented A private mind', body: 'Invented A-private host diagnostic' })
    await useHive.getState().init(b)
    expect(useHive.getState().toasts.some((t) => t.body === 'Invented A-private host diagnostic')).toBe(false)
  })

  it('a toast action from A (e.g. a lab run link) does not survive into B; re-init of the same client keeps toasts', async () => {
    const { a, b } = pair()
    await useHive.getState().init(a)
    let ran = false
    useHive.getState().toast({ tone: 'info', title: 'Invented A lab run finished', action: { label: 'Open run', run: () => { ran = true } } })
    await useHive.getState().init(a) // same client: same-client re-init semantics are kept
    expect(useHive.getState().toasts.some((t) => t.title === 'Invented A lab run finished')).toBe(true)
    await useHive.getState().init(b)
    expect(useHive.getState().toasts.some((t) => t.title === 'Invented A lab run finished')).toBe(false)
    expect(ran).toBe(false)
  })
})
