import { describe, expect, it, vi } from 'vitest'
import { SimClient } from './SimClient'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 2685 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 45000 }) // ~3x the worst case measured under load (followups-r5)

const fresh = () => new SimClient({ seed: 7, latency: false, autoStart: false, historyDays: 1 })

describe('the sim plays request K’s fields (INVENTED data)', () => {
  it('reservations carry timing and resolvable, and can drop them as live 0aa6330 does', async () => {
    const sim = fresh()
    const rows = await sim.listReservations()
    const stuck = rows.find((r) => r.id.startsWith('chat:a_bell10'))!
    expect(stuck).toMatchObject({ state: 'dispatched', resolvable: true, auto_settles_at: null })
    expect(rows.find((r) => r.state === 'unknown')!.auto_settles_at).toBeGreaterThan(Date.now() / 1000)
    expect(rows.find((r) => r.id.startsWith('embed:'))!.resolvable).toBe(false)
    await sim.resolveReservation(stuck.id, { action: 'release', reason: 'billing shows nothing' })
    ;(sim as unknown as { mw: { timingFields: boolean } }).mw.timingFields = false
    const bare = await sim.listReservations()
    expect(bare.every((r) => !('resolvable' in r) && !('dispatched_at' in r))).toBe(true)
  })
  it('archived swarms are listed only on request', async () => {
    const sim = fresh()
    expect((await sim.listSwarms()).some((s) => s.id === 's_tide')).toBe(false)
    expect((await sim.listSwarms({ archived: true })).find((s) => s.id === 's_tide')?.archived_at).toBeTruthy()
    await sim.restoreSwarm('s_tide')
    expect((await sim.listSwarms()).some((s) => s.id === 's_tide')).toBe(true)
  })
  it('shares say who revoked them; an unseen mind answers 404', async () => {
    const sim = fresh()
    const open = (await sim.listShares({ agent_id: 'a_vega01' })).find((s) => s.status === 'active')!
    expect((await sim.revokeShare(open.id)).revoked_by).toBe('user:operator')
    await expect(sim.listShares({ agent_id: 'a_hidden' })).rejects.toMatchObject({ status: 404 })
  })
  it('goal review: the password is refused, a named person accepts, history records it', async () => {
    const sim = fresh()
    const goals = await sim.listGoals('s_lyra')
    const g = goals.find((x) => x.status === 'submitted')!
    expect(g.review_by).toBe('person')
    await expect(sim.reviewGoal(g.id, 'accept')).rejects.toMatchObject({ status: 403, code: 'person_required' })
    sim.simSession = 'person'
    await expect(sim.reviewGoal(g.id, 'return', ' ')).rejects.toMatchObject({ status: 400 })
    const done = await sim.reviewGoal(g.id, 'accept', 'looks right')
    expect(done).toMatchObject({ status: 'done', reviewed_by: 'user:p_ada' })
    const log = await sim.goalReviews(g.id)
    expect(log.at(-1)).toMatchObject({ action: 'accept', by: 'user:p_ada', notes: 'looks right' })
    expect((await sim.getGoal(g.id)).review_by).toBe('person')
    sim.goalReviewByOnRows = false
    expect((await sim.listGoals('s_lyra')).every((x) => !('review_by' in x))).toBe(true)
  })
  it('holds: placed with a valid end, refused with a malformed one, lifted; identity renamed', async () => {
    const sim = fresh()
    const before = (await sim.updates()).holds.length
    await expect(sim.placeHold({ scope: 'restart', reason: 'r', until: 'tomorrow' })).rejects.toMatchObject({ status: 400 })
    // next10: more than 7 days ahead is refused, as the host does
    await expect(sim.placeHold({ scope: 'restart', reason: 'r', until: new Date(Date.now() + 8 * 86_400_000).toISOString() })).rejects.toMatchObject({ status: 400 })
    const h = await sim.placeHold({ scope: 'restart', reason: 'nightly run', until: new Date(Date.now() + 3_600_000).toISOString() })
    expect((await sim.updates()).holds).toHaveLength(before + 1)
    await expect(sim.applyUpdate({ target: 'platform' })).rejects.toMatchObject({ status: 409 })
    await sim.releaseHold(h.id)
    expect((await sim.updates()).holds).toHaveLength(before)
    expect((await sim.setHiveIdentity({ name: '  Home hive ' })).name).toBe('Home hive')
    expect((await sim.setHiveIdentity({ name: '' })).name).toBe('Home hive')
  })
})
