import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { CollabRequest, CreateRequestConnection } from '../../api/types'
import { reviewCancelRequest, reviewConnectionAction, reviewCreateConnection } from './connectionActions'
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('../../ui/confirm', () => ({ askConfirm: confirm }))
const body = (): CreateRequestConnection => ({ from_swarm: 's_lyra', to_swarm: 's_forge', from_coordinator: 'a_vega01', to_coordinator: 'a_anvl09', purpose: 'Synthetic review', deliverable: 'Findings', success: 'Exact revision', scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['code-review'] }], days: 7, budget_usd: 0, on_end: 'drain' })
const client = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
const request = (): CollabRequest => ({ id: 'request-synthetic', title: 'Review synthetic calculator', kind: 'code-review', from_swarm: 's_lyra', to_swarm: 's_forge', from_goal: 'goal-synthetic', from_principal: 'a_vega01', receiving_goal: null, state: 'working', depth: 1, created_at: '', cancelled_at: null, connection_id: 'connection-synthetic', budget: { root: 'root-synthetic', limit_usd: 0, allocated_usd: 0 } })
beforeEach(() => { confirm.mockReset(); confirm.mockResolvedValue(true) })
describe('shared confirmed connection actions', () => {
  it('cancelled creation does not submit and displays exact identities, scope and allocation', async () => {
    const c = client(), create = vi.spyOn(c, 'createConnection')
    confirm.mockResolvedValue(false)
    expect(await reviewCreateConnection(c, body())).toBeNull()
    expect(create).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0]).toContain('s_lyra → s_forge: code-review')
    expect(confirm.mock.calls[0][0]).toContain('a_vega01 ↔ a_anvl09')
    expect(confirm.mock.calls[0][0]).toContain('Request allocation: $0')
  })
  it('submits only the snapshot reviewed while a caller edits the draft', async () => {
    const c = client(), draft = body()
    confirm.mockImplementation(async () => { draft.budget_usd = 100; draft.to_swarm = 's_kelp'; draft.scopes[0].kinds.push('other'); return true })
    const created = await reviewCreateConnection(c, draft)
    expect(created).toMatchObject({ to_swarm: 's_forge', budget_usd: 0, scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['code-review'] }] })
  })
  it('shows memory recipient and exact agreement during renewal, without changing its grant scopes', async () => {
    const c = client(), one = await c.createConnection(body()), change = vi.spyOn(c, 'connectionAction')
    one.on_end = 'cancel'
    one.scopes.push({ kind: 'memory', side: 'from', mind: 'a_vega01', space: 'synthetic-space', pattern: '(review $x)', access: 'read' })
    confirm.mockResolvedValue(false)
    expect(await reviewConnectionAction(c, one, 'renew', 2)).toBeNull()
    expect(change).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0]).toContain(`${one.id}`)
    expect(confirm.mock.calls[0][0]).toContain('read by a_anvl09')
    expect(confirm.mock.calls[0][0]).toContain('2 days from now')
    expect(confirm.mock.calls[0][0]).toContain('are cancelled under this agreement’s end policy')
  })
  it('refuses invalid action state, non-finite budgets and unsupported clients before confirmation', async () => {
    const c = client(), one = await c.createConnection(body())
    await expect(reviewConnectionAction(c, one, 'resume')).rejects.toMatchObject({ status: 400 })
    await expect(reviewConnectionAction(c, one, 'renew', Infinity)).rejects.toMatchObject({ status: 400 })
    await expect(reviewCreateConnection(c, { ...body(), budget_usd: NaN })).rejects.toMatchObject({ status: 400 })
    await expect(reviewCreateConnection(null, body())).rejects.toMatchObject({ name: 'UnsupportedError' })
    expect(confirm).not.toHaveBeenCalled()
  })
  it('propagates the actual host refusal after confirmation', async () => {
    const c = client(), refusal = new ApiError(403, 'forbidden', 'Admin required')
    vi.spyOn(c, 'createConnection').mockRejectedValue(refusal)
    await expect(reviewCreateConnection(c, body())).rejects.toBe(refusal)
    expect(confirm).toHaveBeenCalledOnce()
  })
  it('cancels the exact reviewed request and refuses terminal cancellation', async () => {
    const cancelRequest = vi.fn().mockResolvedValue({ cancelled: 'request-synthetic', by: 'operator' })
    const c = { cancelRequest } as unknown as HiveClient, r = request()
    confirm.mockImplementation(async () => { r.id = 'changed-during-review'; return true })
    await reviewCancelRequest(c, r)
    expect(cancelRequest).toHaveBeenCalledWith('request-synthetic')
    expect(confirm.mock.calls[0][0]).toContain('Connection: connection-synthetic')
    confirm.mockClear(); cancelRequest.mockClear()
    await expect(reviewCancelRequest(c, { ...request(), state: 'completed' })).rejects.toMatchObject({ status: 400 })
    expect(confirm).not.toHaveBeenCalled(); expect(cancelRequest).not.toHaveBeenCalled()
  })
  it('submitted work in review is not terminal: it can still be cancelled, and the dialog says it is in review', async () => {
    const cancelRequest = vi.fn().mockResolvedValue({ cancelled: ['request-synthetic'], by: 'operator' })
    const c = { cancelRequest } as unknown as HiveClient
    await reviewCancelRequest(c, { ...request(), state: 'in-review' })
    expect(confirm.mock.calls[0][0]).toContain('in review')
    expect(cancelRequest).toHaveBeenCalledWith('request-synthetic')
  })
})
