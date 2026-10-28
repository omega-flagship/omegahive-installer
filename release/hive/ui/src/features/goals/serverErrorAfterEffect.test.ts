import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { Goal, PatchGoalBody } from '../../api/types'
import { decisionShown, NOTHING_CHANGED } from '../../lib/decisionGate'
import { goalWriteResult } from '../../lib/goalDecision'
import { EARLIER_SESSION, useHive } from '../../store/store'

// Review ed50158: a 500 that comes AFTER the hive applied a goal change must not be shown as "Nothing changed; you can
// try again". Assembled path: the store's writeGoal -> goalWriteResult -> the DecisionDialog text. The known no-send
// and the real refusal keep their "Nothing changed". INVENTED DATA, simulator only.

const st = () => useHive.getState()
const clients: SimClient[] = []
beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openGoal(seed: number): Promise<{ c: SimClient; g: Goal }> {
  const c = new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
  clients.push(c)
  await st().init(c)
  const all = Object.values(st().goals)
  const g = all.find((x) => !x.parent_id && x.status === 'open') ?? all[0]
  await c.patchGoal(g.id, { status: 'open' })
  await st().loadGoals(g.swarm_id, true)
  return { c, g: st().goals[g.id] }
}
const shownText = (outcome: Parameters<typeof goalWriteResult>[0]) => JSON.stringify(decisionShown(goalWriteResult(outcome, async () => 'unused')))

describe('a server error after the effect is an unknown outcome, never "Nothing changed"', () => {
  for (const status of [500, 503]) {
    it(`${status} after the hive applied Done: re-read, reported taken, no "Nothing changed"`, async () => {
      const { c, g } = await openGoal(90 + status)
      const original = c.patchGoal.bind(c)
      vi.spyOn(c, 'patchGoal').mockImplementationOnce(async (id: string, body: PatchGoalBody): Promise<Goal> => {
        await original(id, body)
        throw new ApiError(status, 'internal', 'failed after updating')
      })
      const getGoal = vi.spyOn(c, 'getGoal')
      const out = await st().writeGoal(g.id, { status: 'done' }, st().session, { quiet: true })
      expect(getGoal).toHaveBeenCalledTimes(1)
      expect(out).toMatchObject({ kind: 'taken', checked: true })
      expect(shownText(out)).not.toContain(NOTHING_CHANGED)
    })
  }
  it('500 when the hive did NOT apply it: re-read shows unchanged (untaken), not a refusal from the error alone', async () => {
    const { c, g } = await openGoal(97)
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(500, 'internal', 'failed'))
    const out = await st().writeGoal(g.id, { status: 'done' }, st().session, { quiet: true })
    expect(out.kind).toBe('untaken')
    expect(st().goals[g.id].status).toBe('open')
  })
  it('control: a real refusal (409) stays a refusal and keeps "Nothing changed"', async () => {
    const { c, g } = await openGoal(98)
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(409, 'conflict', 'invented refusal'))
    const out = await st().writeGoal(g.id, { status: 'done' }, st().session, { quiet: true })
    expect(out.kind).toBe('refused')
    expect(shownText(out)).toContain(NOTHING_CHANGED)
  })
  it('control: a known no-send (earlier session) keeps "Nothing changed" and sends nothing', async () => {
    const { c, g } = await openGoal(99)
    const patch = vi.spyOn(c, 'patchGoal')
    const out = await st().writeGoal(g.id, { status: 'done' }, 'an-earlier-session', { quiet: true })
    expect(patch).not.toHaveBeenCalled()
    expect(out).toEqual({ kind: 'refused', why: EARLIER_SESSION })
    expect(shownText(out)).toContain(NOTHING_CHANGED)
  })
})
