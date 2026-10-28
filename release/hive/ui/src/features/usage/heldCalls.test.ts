import { describe, expect, it } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { CostReservation } from '../../api/moneyWork'
import { heldCount, watchHeldCalls } from './heldCalls'

const row = (state: CostReservation['state'], resolvable?: boolean): CostReservation => ({ id: state, state, held_usd: 1, scopes: [], metadata: {}, observation: null, ...(resolvable === undefined ? {} : { resolvable }) })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the Usage badge (held calls waiting on a person)', () => {
  it('counts what a person may settle now', () => {
    expect(heldCount([row('unknown'), row('dispatched'), row('dispatched', true)])).toBe(2)
  })
  it('polls only for admins, through the visible-page poller', async () => {
    let polls = 0
    const client = { listReservations: async () => [row('unknown')] } as unknown as HiveClient
    const got: number[] = []
    watchHeldCalls(client, async () => false, (n) => got.push(n), (fn) => (polls++, fn(), () => undefined))
    await flush()
    expect(polls).toBe(0)
    watchHeldCalls(client, async () => true, (n) => got.push(n), (fn) => (polls++, fn(), () => undefined))
    await flush()
    await flush()
    expect(polls).toBe(1)
    expect(got).toEqual([1])
  })
  it('stops for good on a 403, and does nothing on a client without the route', async () => {
    let stopped = 0
    const client = { listReservations: async () => { throw new ApiError(403, 'admin_only', 'no') } } as unknown as HiveClient
    const got: number[] = []
    watchHeldCalls(client, async () => true, (n) => got.push(n), (fn) => (fn(), () => void stopped++))
    await flush()
    await flush()
    expect(got).toEqual([0])
    expect(stopped).toBe(1)
    expect(typeof watchHeldCalls({} as HiveClient, async () => true, () => undefined)).toBe('function')
  })
})
