import { describe, expect, it } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { CollabRequest } from '../../api/types'
import { readContext } from '../../lib/readContext'
import { href, parse } from '../../lib/router'
import { PENDING, Resource } from '../../lib/useResource'
import { bindCodingInbox, filterRows, inboxIdentity, receivingGoalRoute, REQUEST_PAGE_LIMIT, type CodingInboxRead } from './codingSwarmInbox'

/**
 * Surface request P: Code's 23 helper checks (coordination/omegacode/tools/check_coding_swarm_inbox.py, receipt
 * coding-swarm-inbox-helper.json), ported onto the owner helper and run against the sim's request lifecycle instead of
 * a disposable host. INVENTED data only; no live hive, no model calls.
 *
 * The sim's coding swarm is Forge (s_forge): Lyra's request is submitted (in review), Kelp's first request was
 * cancelled, Kelp's second is being worked on, and Forge's own evidence request to Kelp is nested under Lyra's budget root.
 */
const TEAM = 's_forge'
const fresh = () => new SimClient({ seed: 7, latency: false, autoStart: false, historyDays: 1 })
async function setup() {
  const sim = fresh()
  const ctx = inboxIdentity(sim, 'user:operator', TEAM)
  const requests = await sim.listRequests()
  const raw: CodingInboxRead = { ctx, team_id: TEAM, requests }
  return { sim, ctx, raw, requests }
}
const row = (v: ReturnType<typeof bindCodingInbox>, id: string) => v.rows.find((r) => r.id === id)!

describe("Code's 23 helper checks, against the sim (owner helper)", () => {
  it('1-8: the lifecycle reads as the host reports it: in review, cancelled, nested outgoing, roots, review accepted', async () => {
    const { sim, ctx, raw } = await setup()
    const v = bindCodingInbox(raw, TEAM, ctx)
    // 1: every request involving Forge (three in, one out), none of the others
    expect(v.rows.map((r) => r.id).sort()).toEqual(['rq_csforge01', 'rq_cskelp01', 'rq_cskelp02', 'rq_cslyra01'])
    // 2: the cancelled request stays cancelled, with its time
    expect(row(v, 'rq_cskelp01')).toMatchObject({ state: 'cancelled', direction: 'incoming' })
    expect(row(v, 'rq_cskelp01').cancelled_at).toBeTruthy()
    // 3: submitted work is in review, never completed
    expect(row(v, 'rq_cslyra01').state).toBe('in-review')
    // 4: Forge's nested evidence request is outgoing
    expect(row(v, 'rq_csforge01')).toMatchObject({ direction: 'outgoing', depth: 1, from_goal: 'g_csrecv1' })
    // 5: independent roots stay independent; the nested request shares its parent's root (never summed)
    expect(new Set(v.rows.map((r) => r.budget.root))).toEqual(new Set(['rq_cslyra01', 'rq_cskelp01', 'rq_cskelp02']))
    expect(row(v, 'rq_csforge01').budget.root).toBe(row(v, 'rq_cslyra01').budget.root)
    // 6: the parent's allocation to requests is the host's figure, as returned
    expect(row(v, 'rq_cslyra01').budget.allocated_usd).toBe(0.5)
    // 7-8: the requester's review accepts the result: completed, with a retained result returned
    sim.simSession = 'person'
    await sim.reviewGoal('g_csrecv1', 'accept', 'Synthetic acceptance')
    const done = bindCodingInbox({ ...raw, requests: await sim.listRequests() }, TEAM, ctx)
    expect(row(done, 'rq_cslyra01').state).toBe('completed')
    expect(row(done, 'rq_cslyra01').result_returned).toBe(true)
    expect(row(done, 'rq_cskelp01').state).toBe('cancelled')
    expect(row(done, 'rq_csforge01').state).toBe('queued')
  })

  it('9-11: a read for another team, another client or another reader is refused', async () => {
    const { sim, ctx, raw } = await setup()
    expect(() => bindCodingInbox(raw, 's_lyra', ctx)).toThrow()
    expect(() => bindCodingInbox(raw, TEAM, inboxIdentity({}, 'user:operator', TEAM))).toThrow()
    expect(() => bindCodingInbox(raw, TEAM, inboxIdentity(sim, 'user:p_ada', TEAM))).toThrow()
  })

  it.each(['id', 'state', 'budget', 'receiving_goal', 'from_principal', 'depth'])('12-17: a malformed %s withholds the whole page', async (field) => {
    const { ctx, raw } = await setup()
    const changed = structuredClone(raw) as { requests: Record<string, unknown>[] } & CodingInboxRead
    changed.requests[0][field] = field === 'receiving_goal' ? 'invalid /' : null
    expect(() => bindCodingInbox(changed, TEAM, ctx)).toThrow()
  })

  it('18-19: duplicate ids and a page over the host limit are refused', async () => {
    const { ctx, raw, requests } = await setup()
    expect(() => bindCodingInbox({ ...raw, requests: [requests[0], requests[0]] }, TEAM, ctx)).toThrow()
    expect(() => bindCodingInbox({ ...raw, requests: Array(REQUEST_PAGE_LIMIT + 1).fill(requests[0]) }, TEAM, ctx)).toThrow()
  })

  it('20-21: the view is a copy: neither side can change the other', async () => {
    const { ctx, raw } = await setup()
    const isolated = structuredClone(raw) as { requests: CollabRequest[] } & CodingInboxRead
    const copy = bindCodingInbox(isolated, TEAM, ctx)
    const id = isolated.requests[0].id
    isolated.requests[0].budget.root = 'mutated'
    expect(row(copy, id).budget.root).not.toBe('mutated')
    row(copy, id).budget.root = 'view-mutated'
    expect(isolated.requests[0].budget.root).not.toBe('view-mutated')
  })

  it('22: a long title is cut at 2048 code points and says so', async () => {
    const { ctx, raw } = await setup()
    const long = structuredClone(raw) as { requests: CollabRequest[] } & CodingInboxRead
    const id = long.requests.find((r) => r.to_swarm === TEAM)!.id
    long.requests.find((r) => r.id === id)!.title = '🙂'.repeat(2050)
    const r = row(bindCodingInbox(long, TEAM, ctx), id)
    expect(Array.from(r.title)).toHaveLength(2048)
    expect(r.title_truncated).toBe(true)
  })

  it('23: an empty page binds to no rows', async () => {
    const { ctx, raw } = await setup()
    expect(bindCodingInbox({ ...raw, requests: [] }, TEAM, ctx).rows).toHaveLength(0)
  })
})

describe('owner adaptations', () => {
  it('the identity is the one useResource reads under: readContext(client, [principal, team])', async () => {
    const { sim } = await setup()
    expect(inboxIdentity(sim, 'user:operator', TEAM)).toBe(readContext(sim, ['user:operator', TEAM]))
    expect(inboxIdentity(sim, undefined, TEAM)).not.toBe(inboxIdentity(sim, 'user:operator', TEAM))
  })

  it('submit → in review → returned (working) → submitted again → accepted (completed)', async () => {
    const { sim, ctx, raw } = await setup()
    const state = async () => row(bindCodingInbox({ ...raw, requests: await sim.listRequests() }, TEAM, ctx), 'rq_cskelp02')
    expect((await state()).state).toBe('working')
    sim.simSubmitGoal('g_csrecv3', 'Loop rewritten.')
    expect(await state()).toMatchObject({ state: 'in-review', result_returned: true })
    sim.simSession = 'person'
    await sim.reviewGoal('g_csrecv3', 'return', 'Add a benchmark first')
    expect((await state()).state).toBe('working')
    sim.simSubmitGoal('g_csrecv3', 'Loop rewritten, with a benchmark.')
    expect((await state()).state).toBe('in-review')
    await sim.reviewGoal('g_csrecv3', 'accept')
    expect((await state()).state).toBe('completed')
  })

  it('cancelling a request cancels what it asked for in turn, and ends their open goals', async () => {
    const { sim, ctx, raw } = await setup()
    const res = await sim.cancelRequest('rq_cslyra01')
    expect([...(res.cancelled as string[])].sort()).toEqual(['rq_csforge01', 'rq_cslyra01'])
    const v = bindCodingInbox({ ...raw, requests: await sim.listRequests() }, TEAM, ctx)
    expect(row(v, 'rq_cslyra01').state).toBe('cancelled')
    expect(row(v, 'rq_csforge01').state).toBe('cancelled')
    expect((await sim.getGoal('g_csrecv4')).status).toBe('cancelled')
  })

  it('the page limit is shown honestly: capped exactly at 200, not below', async () => {
    const { ctx, raw, requests } = await setup()
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ ...requests[0], id: `rq_fill${i}`, from_swarm: 's_kelp', to_swarm: 's_lyra' }))
    expect(bindCodingInbox({ ...raw, requests: filler(REQUEST_PAGE_LIMIT) }, TEAM, ctx)).toMatchObject({ possibly_capped: true, returned_count: 200, rows: [] })
    expect(bindCodingInbox({ ...raw, requests: filler(199) }, TEAM, ctx).possibly_capped).toBe(false)
  })

  it('an unknown host state withholds the page rather than being shown as a known one', async () => {
    const { ctx, raw } = await setup()
    const odd = structuredClone(raw) as { requests: Record<string, unknown>[] } & CodingInboxRead
    odd.requests[0].state = 'reviewed'
    expect(() => bindCodingInbox(odd, TEAM, ctx)).toThrow()
  })

  it('filters are presentation only: they narrow the bound rows and never add any', async () => {
    const { ctx, raw } = await setup()
    const v = bindCodingInbox(raw, TEAM, ctx)
    expect(filterRows(v.rows, { direction: 'outgoing', state: 'all' }).map((r) => r.id)).toEqual(['rq_csforge01'])
    expect(filterRows(v.rows, { direction: 'all', state: 'in-review' }).map((r) => r.id)).toEqual(['rq_cslyra01'])
    expect(filterRows(v.rows, { direction: 'incoming', state: 'queued' })).toEqual([])
    expect(filterRows(v.rows, { direction: 'all', state: 'all' })).toHaveLength(v.rows.length)
  })

  it('opening a receiving task is a route to that task on Tasks, and round-trips through the hash', async () => {
    const { ctx, raw } = await setup()
    const r = receivingGoalRoute(row(bindCodingInbox(raw, TEAM, ctx), 'rq_csforge01'))
    expect(r).toEqual({ name: 'tasks', swarm: 's_kelp', task: 'g_csrecv4' })
    expect(parse(href(r))).toEqual(r)
    expect(receivingGoalRoute({ to_swarm: 's_kelp', receiving_goal: null })).toEqual({ name: 'tasks', swarm: 's_kelp' })
    // the old address still lands on the same task
    expect(parse('#/goals/s_kelp?goal=g_csrecv4')).toEqual(r)
    expect(parse('#/swarms/s_forge?tab=requests')).toEqual({ name: 'swarm', id: 's_forge', statement: undefined, tab: 'requests' })
  })

  it('a late read for a replaced client, reader or swarm never lands, and could not bind if it did', async () => {
    const { sim, raw, requests } = await setup()
    const other = fresh()
    for (const next of [inboxIdentity(other, 'user:operator', TEAM), inboxIdentity(sim, 'user:p_ada', TEAM), inboxIdentity(sim, 'user:operator', 's_lyra')]) {
      let land!: (v: CodingInboxRead) => void
      const res = new Resource<CodingInboxRead>(() => new Promise((r) => (land = r)), { isEmpty: () => false }, raw.ctx)
      const loading = res.load()
      await Promise.resolve()
      res.rebind(next)
      land({ ...raw, requests })
      await loading
      expect(res.getState()).toBe(PENDING)
      expect(() => bindCodingInbox(raw, JSON.parse(next)[1][1], next)).toThrow()
    }
  })
})
