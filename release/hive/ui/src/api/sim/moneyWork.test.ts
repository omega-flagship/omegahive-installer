// Purpose: tests that the simulator's held calls say how each settles itself, that it settles an unknown call at its
// worst case (a free model's at $0) after an hour as an estimate a person corrects, alone or all at once, and that its
// 5-cent batch reads like a real night.
import { describe, expect, it } from 'vitest'
import { heldBatch, SimMoneyWork, type SimMoneyHooks } from './moneyWork'
import type { Usage } from '../types'

const sim = () => new SimMoneyWork(<T,>(fn: () => T) => Promise.resolve().then(fn))
/** A sim whose charges and estimate events are kept, as SimClient records them. */
const watched = () => {
  const charges: Usage[] = []
  const events: Parameters<SimMoneyHooks['estimated']>[0][] = []
  const s = new SimMoneyWork(<T,>(fn: () => T) => Promise.resolve().then(fn), { charge: (u) => charges.push(u), estimated: (e) => events.push(e) })
  return { s, charges, events }
}

describe('the sim’s held calls settle themselves, as cost_reservations.outstanding says (INVENTED data)', () => {
  it('says how each settles: from OpenRouter’s record, at its worst case within the hour, or when it answers', async () => {
    const s = sim()
    const rows = await s.listReservations()
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by['chat:a_mira04:7e3b19a2'].settles).toBe('record')                  // an OpenRouter answer with its gen- id
    expect(by['chat:a_deneb2:2b7c90e4'].settles).toBe('estimate')
    expect(by['chat:a_coral5:3f60b2d8']).toMatchObject({ settles: 'estimate', held_usd: 0.000001 })   // a free model's floor
    expect(by['chat:a_bell10:5d91e0c3']).toMatchObject({ settles: 'answer', auto_settles_at: null })
    const unknown = rows.filter((r) => r.state === 'unknown')
    expect(unknown.every((r) => typeof r.auto_settles_at === 'number' && r.auto_settles_at - Date.now() / 1000 <= 3600)).toBe(true)
    expect(rows.some((r) => 'resolvable' in r)).toBe(false)
    expect('resolveReservation' in s || 'resolveReservations' in s).toBe(false)   // nobody settles a held call by hand
  })

  it('settles a free model’s unknown call at $0, its price, an hour on', async () => {
    const { s, charges } = watched()
    const realNow = Date.now
    Date.now = () => realNow() + 2 * 3600_000
    try {
      const free = (await s.listEstimated()).find((e) => e.id === 'chat:a_coral5:3f60b2d8')
      expect(free?.estimate_usd).toBe(0)
      expect(charges.some((u) => u.cost_usd === 0 && u.estimated === 1)).toBe(true)
      expect((await s.listReservations()).some((r) => r.id === 'chat:a_coral5:3f60b2d8')).toBe(false)
    } finally {
      Date.now = realNow
    }
  })

  it('Correct all refuses what it cannot take whole', async () => {
    const s = sim()
    for (const body of [
      { action: 'release' as const, ids: [], reason: 'x' },
      { action: 'release' as const, ids: ['a', 'a'], reason: 'x' },
      { action: 'release' as const, ids: ['a'], reason: ' ' },
    ]) await expect(s.correctReservations(body)).rejects.toMatchObject({ status: 400 })
    const held = (await s.listReservations()).find((r) => r.state === 'unknown')!
    await expect(s.correctReservations({ action: 'release', ids: [held.id], reason: 'x' })).rejects.toMatchObject({ status: 409, code: 'not_correctable' })
  })

  it('heldBatch: unknown calls of about 5 cents, over three minds and two models, each id once', () => {
    const rows = heldBatch(52)
    expect(rows).toHaveLength(52)
    expect(new Set(rows.map((r) => r.id)).size).toBe(52)
    expect(rows.every((r) => r.state === 'unknown' && r.held_usd >= 0.045 && r.held_usd <= 0.055)).toBe(true)
    expect(new Set(rows.map((r) => r.metadata.agent)).size).toBe(3)
    expect(new Set(rows.map((r) => r.metadata.model)).size).toBe(2)
  })
})

describe('the sim plays estimates as cost_reservations.expire_unknown and correct do (INVENTED data)', () => {
  it('settles an unknown call at its worst case an hour on, as an estimate, with one summary for the pass', async () => {
    const { s, charges, events } = watched()
    const held = await s.listReservations()
    const unknown = held.filter((r) => r.state === 'unknown')
    expect(unknown.length).toBeGreaterThan(0)
    expect(unknown.every((r) => typeof r.auto_settles_at === 'number' && r.auto_settles_at - Date.now() / 1000 <= 3600)).toBe(true)
    const estimates = await s.listEstimated()
    expect(estimates.length).toBe(2)                                  // the seeded calls unknown for 5 and 21 hours
    expect(estimates[0].settled_at).toBeGreaterThan(estimates[1].settled_at)
    expect(estimates.every((e) => e.correctable_until - e.settled_at === 30 * 86_400)).toBe(true)
    expect(charges.map((u) => [u.cost_usd, u.estimated])).toEqual(estimates.map((e) => [e.estimate_usd, 1]))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ count: 2, reservations: estimates.map((e) => e.id) })
    expect(events[0].total_usd).toBeCloseTo(estimates.reduce((n, e) => n + e.estimate_usd, 0), 6)
    await s.listEstimated()
    expect(events).toHaveLength(1)                                     // a pass that settles nothing says nothing
  })

  it('corrects an estimate once, by an adjusting usage row dated with it; the estimate no longer counts as one', async () => {
    const { s, charges } = watched()
    const [e] = await s.listEstimated()
    const out = await s.correctReservation(e.id, { action: 'settle', actual_usd: 0.02, reason: 'billing shows $0.02' })
    expect(out).toMatchObject({ id: e.id, state: 'settled', actual: 20_000, estimate: Math.round(e.estimate_usd * 1e6), action: 'settle' })
    const [estimate, adjusting] = charges.filter((u) => u.created_at === new Date(e.settled_at * 1000).toISOString())
    expect(estimate.estimated).toBe(0)
    expect(adjusting.estimated).toBe(0)
    expect(estimate.cost_usd + adjusting.cost_usd).toBeCloseTo(0.02, 6)
    expect((await s.listEstimated()).map((x) => x.id)).not.toContain(e.id)
    await expect(s.correctReservation(e.id, { action: 'release', reason: 'again' })).rejects.toMatchObject({ status: 409, code: 'not_correctable' })
    await expect(s.correctReservation('no-such-call', { action: 'release', reason: 'x' })).rejects.toMatchObject({ status: 409, code: 'not_correctable' })
    await expect(s.correctReservation(e.id, { action: 'settle', actual_usd: -1, reason: 'x' })).rejects.toMatchObject({ status: 400 })
  })

  it('corrects all estimates as one decision, all or none, through the bulk route', async () => {
    const { s } = watched()
    const estimates = await s.listEstimated()
    await s.correctReservation(estimates[0].id, { action: 'release', reason: 'billing shows nothing' })
    await expect(s.correctReservations({ action: 'release', ids: estimates.map((e) => e.id), reason: 'none billed' })).rejects.toMatchObject({ status: 409, code: 'not_correctable' })
    expect((await s.listEstimated()).map((e) => e.id)).toEqual([estimates[1].id])
    const out = await s.correctReservations({ action: 'release', ids: [estimates[1].id], reason: 'none billed' })
    expect(out.corrected.map((r) => r.actual)).toEqual([0])
    expect(out.estimate_usd).toBeCloseTo(estimates[1].estimate_usd, 6)
    expect(await s.listEstimated()).toEqual([])
  })
})
