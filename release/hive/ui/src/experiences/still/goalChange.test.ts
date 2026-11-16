import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { Goal, PatchGoalBody } from '../../api/types'
import { ARM_MS } from '../../lib/decisionGate'
import { GOAL_UNCHECKED, seenOf } from '../../lib/goalDecision'
import { useHive } from '../../store/store'
import sheetsSource from './Sheets.tsx?raw'
import { changeGoal, checkNoteFor, recheckGoal, type GoalAsk, type GoalNote } from './goalChange'

// Review B1 (next22b/next23b): Still's goal sheet words a change from writeGoal's typed outcome. A lost answer is never
// "nothing changed"; an unknown outcome offers a read-only Check again, and the goal takes no further decision until
// it is read. Through Still's own consumer (goalChange, which Sheets.tsx calls), the real store and the simulator.
// INVENTED DATA, simulator only.

const clients: SimClient[] = []
const st = () => useHive.getState()
const sim = (seed: number) => {
  const c = new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
  clients.push(c)
  return c
}

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openGoal(seed: number): Promise<{ c: SimClient; g: Goal }> {
  const c = sim(seed)
  await st().init(c)
  const all = Object.values(st().goals)
  const g = all.find((x) => x.status === 'open' && !all.some((y) => y.parent_id === x.id))!
  expect(g).toBeTruthy()
  return { c, g }
}
/** The person's confirm, as Sheets.tsx builds it, and a Yes made well after it appeared (a fresh activation). */
const askOf = (g: Goal, to: Goal['status']): GoalAsk => ({ id: g.id, to, seen: seenOf(g), shownAt: 0 })
const yes = { at: ARM_MS + 100 }

/** The hive applies the change, then its answer is lost. */
function commitThenLose(c: SimClient) {
  const original = c.patchGoal.bind(c)
  return vi.spyOn(c, 'patchGoal').mockImplementationOnce(async (id: string, body: PatchGoalBody) => {
    await original(id, body)
    throw new ApiError(0, 'network', 'Network error')
  })
}

const NO_EFFECT = /nothing changed|did not take|was refused/i

async function sent(a: GoalAsk): Promise<GoalNote | null> {
  const r = await changeGoal(a, yes, () => undefined)
  if (r.kind !== 'sent') throw new Error(`held: ${r.why}`)
  return r.note
}

describe('Still goal sheet: the outcome of a change', () => {
  it('commit, lost answer, failed re-read: unknown, never "nothing changed"; Check again offered; repeat decisions fenced', async () => {
    const { c, g } = await openGoal(491)
    const patch = commitThenLose(c)
    const read = vi.spyOn(c, 'getGoal').mockRejectedValue(new Error('read lost'))
    const a = askOf(g, 'done')
    const n = await sent(a)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect((await c.listGoals(g.swarm_id)).find((x) => x.id === g.id)?.status).toBe('done') // it did happen
    expect(n).not.toBeNull()
    expect(n!.text).not.toMatch(NO_EFFECT)
    expect(n!.text).toMatch(/whether this change happened is not known/)
    expect(n!.recheck).toBe(true)
    expect(st().goalsUnsure[g.id]).toBe(true)
    // a repeat decision is held, and nothing more is sent
    const again = await changeGoal(askOf(st().goals[g.id], 'done'), yes, () => undefined)
    expect(again.kind).toBe('held')
    expect(again.kind === 'held' && again.why.startsWith(GOAL_UNCHECKED)).toBe(true)
    const other = await changeGoal(askOf(st().goals[g.id], 'cancelled'), yes, () => undefined)
    expect(other.kind).toBe('held')
    expect(patch).toHaveBeenCalledTimes(1)
    // the Check again that fails too still says only that it is not known
    const still = await recheckGoal(n!)
    expect(still.text).not.toMatch(NO_EFFECT)
    expect(still.text).toMatch(/still could not be read/)
    expect(still.recheck).toBe(true)
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('a successful Check again after an unknown outcome: the change is there; the goal takes decisions again; the check sent nothing', async () => {
    const { c, g } = await openGoal(492)
    const patch = commitThenLose(c)
    vi.spyOn(c, 'getGoal').mockRejectedValueOnce(new Error('read lost'))
    const n = await sent(askOf(g, 'done'))
    expect(n!.recheck).toBe(true)
    const r = await recheckGoal(n!)
    expect(r.text).toMatch(/^Checked again: the change is there\. It is done now\.$/)
    expect(r.recheck).toBe(false)
    expect(st().goalsUnsure[g.id]).toBeUndefined()
    expect(st().goals[g.id].status).toBe('done')
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('unapplied change, lost answer, lost re-read: unknown (not refused), then Check again reads it unchanged', async () => {
    const { c, g } = await openGoal(493)
    const patch = vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    vi.spyOn(c, 'getGoal').mockRejectedValueOnce(new Error('read lost'))
    const n = await sent(askOf(g, 'cancelled'))
    expect(n!.text).not.toMatch(NO_EFFECT)
    expect(n!.text).toMatch(/not known/)
    expect(st().goalsUnsure[g.id]).toBe(true)
    const r = await recheckGoal(n!)
    expect(r.text).toBe('Checked again: the task is unchanged; it is still waiting for a taker. Ask again if you still want it.')
    expect(st().goalsUnsure[g.id]).toBeUndefined()
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('unapplied change, lost answer, re-read works: untaken, said as unchanged after checking', async () => {
    const { c, g } = await openGoal(494)
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(0, 'network', 'Network error'))
    const n = await sent(askOf(g, 'failed'))
    expect(n!.text).toBe('The hive’s answer was lost. The task was read again and is unchanged: it is still waiting for a taker. Ask again if you still want it.')
    expect(n!.recheck).toBe(false)
    expect(st().goalsUnsure[g.id]).toBeUndefined()
  })

  it('commit, lost answer, re-read works: taken, said as there after a read', async () => {
    const { c, g } = await openGoal(495)
    commitThenLose(c)
    const n = await sent(askOf(g, 'done'))
    expect(n!.text).toMatch(/the change is there\. It is done now\./)
  })

  it('a refusal is said as refused', async () => {
    const { c, g } = await openGoal(496)
    vi.spyOn(c, 'patchGoal').mockRejectedValueOnce(new ApiError(409, 'conflict', 'That goal cannot change now.'))
    const read = vi.spyOn(c, 'getGoal')
    const n = await sent(askOf(g, 'done'))
    expect(n!.text).toMatch(/^This change was refused\. /)
    expect(n!.recheck).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('taken on the hive’s own answer: no note', async () => {
    const { g } = await openGoal(497)
    expect(await sent(askOf(g, 'done'))).toBeNull()
    expect(st().goals[g.id].status).toBe('done')
  })

  it('identity change while unconfirmed: Check again does not read the new hive, and the old confirm stays held', async () => {
    const { c, g } = await openGoal(498)
    const patch = commitThenLose(c)
    vi.spyOn(c, 'getGoal').mockRejectedValue(new Error('read lost'))
    const a = askOf(g, 'done')
    const n = await sent(a)
    expect(n!.recheck).toBe(true)
    // another identity: a fresh client (same seed, so the same goal ids exist there)
    const b = sim(498)
    const readB = vi.spyOn(b, 'getGoal')
    const patchB = vi.spyOn(b, 'patchGoal')
    await st().init(b)
    expect(st().goalsUnsure[g.id]).toBeUndefined()
    const r = await recheckGoal(n!)
    expect(r.text).toMatch(/earlier connection to the hive/)
    expect(r.text).not.toMatch(NO_EFFECT)
    expect(r.recheck).toBe(false)
    expect(readB).not.toHaveBeenCalled()
    // the confirm opened under the first identity is never sent to the second
    const held = await changeGoal(a, yes, () => undefined)
    expect(held.kind).toBe('held')
    expect(patchB).not.toHaveBeenCalled()
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('identity change while the write is in flight: unknown, not checkable from the new connection, never "nothing changed"', async () => {
    const { c, g } = await openGoal(499)
    const b = sim(499)
    vi.spyOn(c, 'patchGoal').mockImplementationOnce(async () => {
      await st().init(b)
      throw new ApiError(0, 'network', 'Network error')
    })
    const n = await sent(askOf(g, 'done'))
    expect(n!.text).toMatch(/connection to the hive changed before it answered/)
    expect(n!.text).toMatch(/earlier connection/)
    expect(n!.text).not.toMatch(NO_EFFECT)
    expect(n!.recheck).toBe(false)
  })

  it('a check made with the note put away reports what the goal is', async () => {
    const { c, g } = await openGoal(500)
    commitThenLose(c)
    vi.spyOn(c, 'getGoal').mockRejectedValueOnce(new Error('read lost'))
    await sent(askOf(g, 'done'))
    expect(st().goalsUnsure[g.id]).toBe(true)
    const r = await recheckGoal(checkNoteFor(st().goals[g.id]))
    expect(r.text).toBe('Checked again: it is done.')
    expect(st().goalsUnsure[g.id]).toBeUndefined()
  })

  it('Sheets.tsx words no goal-write outcome from a bare boolean and carries no no-effect sentence for it', () => {
    const src = sheetsSource
    expect(src).not.toMatch(/patchGoal/)
    expect(src).not.toMatch(/The hive did not take this change/)
    expect(src).toMatch(/changeGoal\(/)
    expect(src).toMatch(/recheckGoal\(/)
  })
})
