import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { LiveClient } from '../../api/live'
import { SimClient } from '../../api/sim/SimClient'
import type { Goal, PatchGoalBody } from '../../api/types'
import { answerLost, useHive } from '../../store/store'

// Review B1 (next23b 49ab303 / next24 15f9bcb): a write the hive COMMITTED whose 2xx answer body cannot be read
// (truncated, not JSON) must never be reported as refused and rolled back. The live transport normalises a success
// body decode failure to ApiError status 0 ("answer_unreadable"), which the store treats as an unknown outcome and
// reconciles. Real API refusals (non-2xx) stay refusals. INVENTED DATA.

const st = () => useHive.getState()
const clients: SimClient[] = []
beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const respond = (status: number, body: string) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })))

describe('transport: success-body decode failure is an unknown outcome, not a refusal', () => {
  it('a 200 with a truncated body rejects as ApiError status 0 answer_unreadable, which answerLost counts as lost', async () => {
    respond(200, '{"id":"g_invented","status":"do')
    const live = new LiveClient('http://hive.invalid')
    const err = await live.patchGoal('g_invented', { status: 'done' }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'answer_unreadable' })
    expect(answerLost(err)).toBe(true)
  })
  it('a 200 with a non-JSON body is the same', async () => {
    respond(200, '<html>proxy page</html>')
    const err = await new LiveClient('http://hive.invalid').patchGoal('g_invented', { status: 'done' }).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ status: 0, code: 'answer_unreadable' })
  })
  it('a real hive refusal stays a refusal (not lost)', async () => {
    respond(409, JSON.stringify({ error: { code: 'goal_conflict', message: 'invented refusal' } }))
    const err = await new LiveClient('http://hive.invalid').patchGoal('g_invented', { status: 'done' }).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ status: 409 })
    expect(answerLost(err)).toBe(false)
  })
  it('a good 200 still returns the body', async () => {
    respond(200, JSON.stringify({ id: 'g_invented', status: 'done' }))
    await expect(new LiveClient('http://hive.invalid').patchGoal('g_invented', { status: 'done' })).resolves.toMatchObject({ status: 'done' })
  })
})

describe('store: a committed goal write whose answer body was unreadable is reconciled, never rolled back as refused', () => {
  it('Review regression: the hive applies the change, the answer body is truncated: writeGoal re-reads and reports taken', async () => {
    const c = new SimClient({ seed: 77, latency: false, autoStart: false, historyDays: 1 })
    clients.push(c)
    await st().init(c)
    const all = Object.values(st().goals)
    const g = all.find((x) => !x.parent_id && x.status === 'open') ?? all[0]
    await c.patchGoal(g.id, { status: 'open' })
    await st().loadGoals(g.swarm_id, true)
    const original = c.patchGoal.bind(c)
    // exactly what the live transport now throws after a 2xx whose body would not decode
    vi.spyOn(c, 'patchGoal').mockImplementationOnce(async (id: string, body: PatchGoalBody): Promise<Goal> => {
      await original(id, body)
      throw new ApiError(0, 'answer_unreadable', 'The hive answered but its answer could not be read (SyntaxError).')
    })
    const getGoal = vi.spyOn(c, 'getGoal')
    const r = await st().writeGoal(g.id, { status: 'done' }, st().session)
    expect(getGoal).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ kind: 'taken', checked: true })
    expect(st().goals[g.id].status).toBe('done')
  })
})
