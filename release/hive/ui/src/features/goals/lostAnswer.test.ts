import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { Goal, PatchGoalBody } from '../../api/types'
import { decisionShown, type DecisionResult } from '../../lib/decisionGate'
import { GOAL_UNCHECKED, goalBound, goalDrift, goalRecheckResult, goalWriteResult, seenOf } from '../../lib/goalDecision'
import { GOAL_UNSURE, NOT_CONFIRMED, useHive } from '../../store/store'
import { cardAsk } from './cardActions'

// Review B1 (next22) and Kimi #1 on Surface's Classic goals D1. A status write whose answer is lost is never reported
// as refused or "nothing changed": the store reads the goal again and the dialog says what the read shows. INVENTED
// DATA, simulator only.

const sim = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
const clients: SimClient[] = []
const st = () => useHive.getState()

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A fresh simulator hive with one top-level goal put into `from` (through the simulator's own write). */
async function hiveWith(seed: number, from: Goal['status']): Promise<{ c: SimClient; g: Goal }> {
  const c = sim(seed)
  clients.push(c)
  await st().init(c)
  const all = Object.values(st().goals)
  const pick = all.find((x) => !x.parent_id && !all.some((y) => y.parent_id === x.id) && x.status !== 'submitted') ?? all[0]
  await c.patchGoal(pick.id, { status: from })
  await st().loadGoals(pick.swarm_id, true)
  const g = st().goals[pick.id]
  expect(g.status).toBe(from)
  return { c, g }
}

/** The hive applies the change, then its answer is lost (a network drop after commit). */
function commitThenLose(c: SimClient, err: unknown = new ApiError(0, 'network', 'Network error')) {
  const original = c.patchGoal.bind(c)
  return vi.spyOn(c, 'patchGoal').mockImplementationOnce(async (id: string, body: PatchGoalBody) => {
    await original(id, body)
    throw err
  })
}
/** The answer is lost and the hive never applied the change. */
const loseUnapplied = (c: SimClient) => vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))

const noRecheck = async (): Promise<DecisionResult> => 'unused'

// Done, Failed, Cancel and Re-open (from stalled, the banner; and from failed, the card)
const CASES: { name: string; from: Goal['status']; to: Goal['status'] }[] = [
  { name: 'Done', from: 'open', to: 'done' },
  { name: 'Failed', from: 'open', to: 'failed' },
  { name: 'Cancel', from: 'open', to: 'cancelled' },
  { name: 'Re-open (stalled banner)', from: 'stalled', to: 'open' },
  { name: 'Reopen (failed card)', from: 'failed', to: 'open' },
]

describe('B1: commit-then-lost-answer, for every Classic status action', () => {
  CASES.forEach(({ name, from, to }, i) => {
    it(`${name}: the hive applied it and the answer was lost: reported as taken after a re-read, never "nothing changed"`, async () => {
      const { c, g } = await hiveWith(41 + i, from)
      const ask = cardAsk(g, to, st().session)
      expect(goalBound({ ...seenOf(ask.seen), session: ask.session }, st().goals[g.id], to)).toEqual({ kind: 'ready' })
      const patch = commitThenLose(c, i % 2 ? new TypeError('Failed to fetch') : undefined)
      const getGoal = vi.spyOn(c, 'getGoal')
      const r = await st().writeGoal(g.id, { status: to }, ask.session)
      expect(patch).toHaveBeenCalledTimes(1)
      expect(getGoal).toHaveBeenCalledTimes(1)
      expect(r).toMatchObject({ kind: 'taken', checked: true })
      expect((await c.getGoal(g.id)).status).toBe(to)
      expect(st().goals[g.id].status).toBe(to)
      expect(st().goalsUnsure[g.id]).toBeUndefined()
      expect(st().toasts.at(-1)).toMatchObject({ tone: 'success', title: 'The task was updated' })
      // the dialog closes on it; it never shows a refusal
      const shown = decisionShown(goalWriteResult(r, noRecheck))
      expect(shown).toEqual({ kind: 'close' })
    })

    it(`${name}: the answer was lost and the hive did not apply it: "could not confirm", re-read unchanged, retry only through a fresh GoalDecision`, async () => {
      const { c, g } = await hiveWith(51 + i, from)
      const ask = cardAsk(g, to, st().session)
      const patch = loseUnapplied(c)
      const r = await st().writeGoal(g.id, { status: to }, ask.session)
      expect(patch).toHaveBeenCalledTimes(1)
      expect(r.kind).toBe('untaken')
      expect(st().goals[g.id]).toMatchObject({ status: from, updated_at: g.updated_at })
      expect(st().goalsUnsure[g.id]).toBeUndefined()
      const shown = decisionShown(goalWriteResult(r, noRecheck))
      expect(shown.kind).toBe('unsettled')
      if (shown.kind !== 'unsettled') return
      expect(shown.unsettled.unsettled).toContain(NOT_CONFIRMED)
      expect(shown.unsettled.unsettled).toMatch(/unchanged/)
      expect(shown.unsettled.unsettled).not.toMatch(/Nothing changed|did not take/)
      // this dialog is spent (no recheck, no decision); a fresh GoalDecision on the goal as now read is ready and writes once
      expect(shown.unsettled.recheck).toBeUndefined()
      const fresh = cardAsk(st().goals[g.id], to, st().session)
      expect(goalBound({ ...seenOf(fresh.seen), session: fresh.session }, st().goals[g.id], to)).toEqual({ kind: 'ready' })
      expect(await st().writeGoal(g.id, { status: to }, fresh.session)).toMatchObject({ kind: 'taken', checked: false })
      expect(patch).toHaveBeenCalledTimes(2)
      expect(st().goals[g.id].status).toBe(to)
    })
  })

  it('the answer was lost and the goal cannot be read again: stays unknown, no retry until a manual Check again reads it', async () => {
    const { c, g } = await hiveWith(61, 'open')
    const ask = cardAsk(g, 'done', st().session)
    const patch = commitThenLose(c)
    const getGoal = vi.spyOn(c, 'getGoal').mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    const r = await st().writeGoal(g.id, { status: 'done' }, ask.session)
    expect(r.kind).toBe('unknown')
    expect(st().goalsUnsure[g.id]).toBe(true)
    const toast = st().toasts.at(-1)!
    expect(toast.title).toBe('Not confirmed')
    expect(toast.body).toContain(NOT_CONFIRMED)
    expect(toast.action?.label).toBe('Check again')
    // the dialog keeps the uncertainty and offers Check again; it never says "nothing changed"
    let rechecked = 0
    const recheck = async (): Promise<DecisionResult> => (rechecked++, goalRecheckResult(await st().reconcileGoal(g.id), g, 'done', recheck))
    const shown = decisionShown(goalWriteResult(r, recheck))
    expect(shown.kind).toBe('unsettled')
    if (shown.kind !== 'unsettled') return
    expect(shown.unsettled.unsettled).toContain(NOT_CONFIRMED)
    expect(shown.unsettled.unsettled).not.toMatch(/Nothing changed/)
    expect(shown.unsettled.recheck).toBe(recheck)
    // no retry while unsure: every goal decision path refuses (binding), and the store sends nothing
    const again = cardAsk(st().goals[g.id], 'done', st().session)
    expect(goalBound({ ...seenOf(again.seen), session: again.session }, st().goals[g.id], 'done')).toEqual({ kind: 'closed', why: GOAL_UNCHECKED })
    expect(goalDrift(seenOf(st().goals[g.id]), st().goals[g.id], 'failed')).toMatch(/not confirmed/)
    expect(await st().writeGoal(g.id, { status: 'done' }, again.session)).toEqual({ kind: 'refused', why: GOAL_UNSURE })
    expect(await st().patchGoal(g.id, { priority: 0.4 }, again.session)).toBe(false)
    expect(patch).toHaveBeenCalledTimes(1)
    // a recheck that still cannot read keeps it unknown, with Check again
    getGoal.mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    const still = await shown.unsettled.recheck!()
    expect(still).toMatchObject({ unsettled: expect.stringContaining('still could not be read'), recheck })
    expect(st().goalsUnsure[g.id]).toBe(true)
    // the read comes back: the change is there, the dialog closes, the goal is settled
    expect(await shown.unsettled.recheck!()).toBe(true)
    expect(rechecked).toBe(2)
    expect(st().goalsUnsure[g.id]).toBeUndefined()
    expect(st().goals[g.id].status).toBe('done')
  })

  it("the toast's Check again reads the goal and settles it (manual refresh outside the dialog)", async () => {
    const { c, g } = await hiveWith(62, 'open')
    loseUnapplied(c)
    vi.spyOn(c, 'getGoal').mockRejectedValueOnce(new ApiError(504, 'gateway', 'Gateway timeout'))
    expect((await st().writeGoal(g.id, { status: 'failed' }, st().session)).kind).toBe('unknown')
    expect(st().goalsUnsure[g.id]).toBe(true)
    st().toasts.at(-1)!.action!.run()
    await vi.waitFor(() => expect(st().goalsUnsure[g.id]).toBeUndefined())
    expect(st().goals[g.id].status).toBe('open')
    expect(st().toasts.at(-1)?.body).toMatch(/is unchanged\. Look at it, then ask again/)
  })

  it('GoalDecision asks the store to stay quiet: the dialog shows "not confirmed" itself, no notice covers it', async () => {
    const { c, g } = await hiveWith(64, 'open')
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: string) => string }
    const text = fs.readFileSync(new URL('../../experiences/GoalDecision.tsx', import.meta.url), 'utf8')
    expect(text).toMatch(/writeGoal\(seen\.id, \{ status: to \}, snap\.session, \{ quiet: true \}\)/)
    expect(text).toMatch(/onClose=\{close\}/)
    const toasts = st().toasts.length
    loseUnapplied(c)
    expect((await st().writeGoal(g.id, { status: 'done' }, st().session, { quiet: true })).kind).toBe('untaken')
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.spyOn(c, 'getGoal').mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await st().writeGoal(g.id, { status: 'done' }, st().session, { quiet: true })).kind).toBe('unknown')
    expect(st().toasts.length).toBe(toasts)
    expect(st().goalsUnsure[g.id]).toBe(true)
  })

  it('a definite refusal (the hive answered 4xx) is still a refusal: rolled back, "did not take", no re-read; a 5xx is re-read', async () => {
    const { c, g } = await hiveWith(63, 'open')
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(409, 'conflict', 'That goal changed'))
    const getGoal = vi.spyOn(c, 'getGoal')
    const r = await st().writeGoal(g.id, { status: 'done' }, st().session)
    expect(r).toEqual({ kind: 'refused', why: 'That goal changed' })
    expect(getGoal).not.toHaveBeenCalled()
    expect(st().goals[g.id]).toEqual(g)
    expect(decisionShown(goalWriteResult(r, noRecheck))).toEqual({ kind: 'error', text: 'The hive did not take this change. Nothing changed; you can try again.' })
    // a 5xx may come after the change was applied (Review ed50158): never a refusal, the goal is read again; so are
    // 502 and 504 (a gateway that lost the answer)
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(500, 'boom', 'Nope'))
    expect((await st().writeGoal(g.id, { status: 'done' }, st().session)).kind).toBe('untaken')
    expect(getGoal).toHaveBeenCalledTimes(1)
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(502, 'bad_gateway', 'Bad gateway'))
    expect((await st().writeGoal(g.id, { status: 'done' }, st().session)).kind).toBe('untaken')
    expect(getGoal).toHaveBeenCalledTimes(2)
  })
})

describe('Kimi #1: the rollback never overwrites a newer goal.updated', () => {
  it('a goal.updated that lands while the write is in flight survives the write failing', async () => {
    const { c, g } = await hiveWith(71, 'open')
    let fail!: (e: unknown) => void
    vi.spyOn(c, 'patchGoal').mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
    const p = st().writeGoal(g.id, { status: 'done' }, st().session)
    expect(st().goals[g.id].status).toBe('done') // optimistic
    // someone else's change, as the hive reports it, lands before our answer
    const theirs: Goal = { ...g, status: 'claimed', claimed_by: 'agent:a_vega01', updated_at: new Date(Date.parse(g.updated_at) + 5000).toISOString() }
    st().apply({ type: 'goal.updated', at: theirs.updated_at, goal: theirs })
    fail(new ApiError(409, 'conflict', 'That goal changed'))
    expect((await p).kind).toBe('refused')
    // not rolled back to `before`: the hive's newer word stays
    expect(st().goals[g.id]).toEqual(theirs)
  })

  it('with no race, a failed write still rolls back to the goal as it was', async () => {
    const { c, g } = await hiveWith(72, 'open')
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(409, 'conflict', 'No'))
    expect(await st().patchGoal(g.id, { status: 'cancelled' }, st().session)).toBe(false)
    expect(st().goals[g.id]).toEqual(g)
  })

  it('the same race on a lost answer: the newer goal.updated is kept, and the re-read decides', async () => {
    const { c, g } = await hiveWith(73, 'open')
    const original = c.patchGoal.bind(c)
    vi.spyOn(c, 'patchGoal').mockImplementationOnce(async (id: string, body: PatchGoalBody) => {
      await original(id, body) // the simulator emits goal.updated (the hive's word) to the store here
      throw new TypeError('Failed to fetch')
    })
    const r = await st().writeGoal(g.id, { status: 'failed' }, st().session)
    expect(r).toMatchObject({ kind: 'taken', checked: true })
    expect(st().goals[g.id].status).toBe('failed')
  })
})
