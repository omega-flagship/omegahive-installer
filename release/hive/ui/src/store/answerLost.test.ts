import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { SimClient } from '../api/sim/SimClient'
import { answerLost, useHive } from './store'

// Kimi next22b r2 (nit): only a lost answer is "maybe happened". A network failure (the live client's ApiError status
// 0, a raw fetch failure, a timeout) or a gateway that lost the hive's answer (502, 504) is lost; any other throw (a
// refusal, or a programming error in the client) is an error, never fenced as unknown. INVENTED sim data only.

const st = () => useHive.getState()
const clients: SimClient[] = []
beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('answerLost: network and gateway losses only', () => {
  it('lost: ApiError 0 (network), 502, 504; a raw fetch failure; a timeout', () => {
    expect(answerLost(new ApiError(0, 'network', 'Network error'))).toBe(true)
    expect(answerLost(new ApiError(502, 'bad_gateway', 'x'))).toBe(true)
    expect(answerLost(new ApiError(504, 'gateway_timeout', 'x'))).toBe(true)
    for (const m of ['Failed to fetch', 'fetch failed', 'NetworkError when attempting to fetch resource.', 'Load failed']) expect(answerLost(new TypeError(m)), m).toBe(true)
    expect(answerLost(new DOMException('signal timed out', 'TimeoutError'))).toBe(true)
  })
  it('not lost: refusals and server errors with an answer, and programming errors', () => {
    for (const s of [400, 403, 404, 409, 422]) expect(answerLost(new ApiError(s, 'x', 'x')), String(s)).toBe(false)
    // Review ed50158: a server error may come after the change was applied, so it is an unknown outcome, not a refusal
    for (const s of [500, 502, 503, 504]) expect(answerLost(new ApiError(s, 'x', 'x')), String(s)).toBe(true)
    expect(answerLost(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false)
    expect(answerLost(new TypeError('client.patchGoal is not a function'))).toBe(false)
    expect(answerLost(new RangeError('Invalid time value'))).toBe(false)
    expect(answerLost(new Error('boom'))).toBe(false)
    expect(answerLost('a string')).toBe(false)
    expect(answerLost(undefined)).toBe(false)
  })
})

describe('writeGoal: a programming error surfaces as an error, never as "maybe happened"', () => {
  it('a TypeError from the client is refused with its text; the goal is not fenced unsure and nothing is re-read', async () => {
    const c = new SimClient({ seed: 7, latency: false, autoStart: false, historyDays: 1 })
    clients.push(c)
    await st().init(c)
    const g = Object.values(st().goals).find((x) => x.status === 'open' && !x.parent_id) ?? Object.values(st().goals)[0]
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'status')"))
    const reread = vi.spyOn(st(), 'reconcileGoal')
    const out = await st().writeGoal(g.id, { status: 'done' }, undefined, { quiet: true })
    expect(out.kind).toBe('refused')
    expect(out.kind === 'refused' && out.why).toMatch(/reading 'status'/)
    expect(st().goalsUnsure[g.id]).toBeUndefined()
    expect(reread).not.toHaveBeenCalled()
    expect(st().goals[g.id].status).toBe(g.status)   // its own optimistic value rolled back
  })
  it('a lost answer (ApiError 0) is still reconciled, not refused', async () => {
    const c = new SimClient({ seed: 8, latency: false, autoStart: false, historyDays: 1 })
    clients.push(c)
    await st().init(c)
    const g = Object.values(st().goals).find((x) => x.status === 'open' && !x.parent_id) ?? Object.values(st().goals)[0]
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    const out = await st().writeGoal(g.id, { status: 'done' }, undefined, { quiet: true })
    expect(out.kind).not.toBe('refused')
  })
})
