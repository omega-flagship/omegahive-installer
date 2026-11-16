import { describe, expect, it, vi } from 'vitest'
import { ApiError, type SwarmDeletePreview } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import { STALE, type EpochBinding } from '../../lib/identityEpoch'
import { deleteSwarmCandidates } from '../../lib/intent/swarmDelete'
import type { World } from '../../lib/intent/types'
import { addAttempt, afterFinishRefusal, deleteActionFor, fetchPreview, knownReleased, nameMatches, NO_PROGRESS, outcomeUnknown, pressDelete, previewWords, readPreview, reconcile, reconciledWords, refusalWords, resultWords, stoppedWords } from './deleteWithMinds'

const held = (): EpochBinding => ({ epoch: 1, current: () => true, commit: (w) => w() })
const moved = (): EpochBinding => ({ epoch: 1, current: () => false, commit: () => STALE })
/** Bound when the call goes out, changed before the answer lands. */
const changesMidway = (): EpochBinding => {
  let now = true
  return { epoch: 1, current: () => now, commit: (w) => { const r = now ? w() : STALE; now = false; return r } }
}

const PREVIEW: SwarmDeletePreview = {
  name: 'Forge',
  counts: { minds: 3, members: 1, goals: 4, artifacts: 0, child_swarms: 1 },
  awake_minds: [{ id: 'a_anvl09', name: 'Anvil' }, { id: 'a_bell10', name: 'Bellows' }],
  would: 'archive',
  reason: 'it has history (4 tasks, 1 external member)',
  released_tasks_estimate: 2,
  busy: false,
}
const noGoalWords = (s: string) => expect(s).not.toMatch(/\bgoals?\b|\bboards?\b/i)

describe('the preview, in plain words', () => {
  it('reads the host preview field by field, and refuses what is not one', () => {
    expect(readPreview(PREVIEW)).toEqual(PREVIEW)
    expect(readPreview({ name: 'x' })).toBeNull()
    expect(readPreview(null)).toBeNull()
    const odd = readPreview({ ...PREVIEW, busy: 'a flow is still running here', counts: { minds: -1, goals: 'x' }, awake_minds: [{ name: 'no id' }, { id: 'a1' }] })!
    expect(odd.busy).toBe('a flow is still running here')
    expect(odd.counts).toEqual({ minds: 0, members: 0, goals: 0, artifacts: 0, child_swarms: 0 })
    expect(odd.awake_minds).toEqual([{ id: 'a1', name: 'a1' }])
  })
  it('says what is removed, how many minds, which are awake, the tasks released and what happens to the swarm', () => {
    const w = previewWords('Forge', PREVIEW)
    expect(w.minds).toBe('3 minds will be deleted.')
    expect(w.awake).toBe('Awake now, stopped first: Anvil, Bellows.')
    expect(w.tasks).toMatch(/^2 unfinished tasks held by or given to these minds will be released: back to open/)
    expect(w.fate).toMatch(/archived, not deleted, because it has history \(4 tasks, 1 external member\)/)
    expect(w.kept.join(' ')).toMatch(/Up to 1 swarm sits inside its minds or members\. None is deleted; any inside the minds deleted here will stand on its own, and the result lists which\..*1 external member is never deleted/)
    expect(w.busy).toBeNull()
    for (const s of [w.minds, w.awake!, w.tasks, w.fate, ...w.kept]) noGoalWords(s)
  })
  it('a swarm with nothing left says it will be deleted for good, and older host words never say goals', () => {
    const w = previewWords('Forge', { ...PREVIEW, would: 'delete', reason: 'nothing would remain once its minds are deleted', awake_minds: [], released_tasks_estimate: 0 })
    expect(w.fate).toMatch(/itself will be deleted.*cannot be undone/)
    expect(w.awake).toBeNull()
    expect(w.tasks).toMatch(/none are released/)
    noGoalWords(previewWords('F', { ...PREVIEW, reason: 'it has history (2 goals)' }).fate)
  })
  it('busy is plain words', () => {
    const w = previewWords('Forge', { ...PREVIEW, busy: 'a flow is still running here' })
    expect(w.busy).toBe('Busy right now: a flow is still running here. Deleting would be refused until that finishes. Check again in a moment.')
  })
})

describe('the typed name and the press', () => {
  it('only the exact name: capitals and spaces count', () => {
    expect(nameMatches('Forge', 'Forge')).toBe(true)
    expect(nameMatches('forge', 'Forge')).toBe(false)
    expect(nameMatches('Forge ', 'Forge')).toBe(false)
  })
  it('a wrong name sends nothing', async () => {
    const del = vi.fn()
    expect(await pressDelete({ id: 's', name: 'Forge' }, 'forge', { binding: held(), del })).toBeNull()
    expect(del).not.toHaveBeenCalled()
  })
  it('is never sent under a changed identity, and an answer after a change is dropped', async () => {
    const del = vi.fn(async () => ({ deleted_minds: [], swarm: 'deleted' as const }))
    expect(await pressDelete({ id: 's', name: 'F' }, 'F', { binding: moved(), del })).toBeNull()
    expect(del).not.toHaveBeenCalled()
    expect(await pressDelete({ id: 's', name: 'F' }, 'F', { binding: changesMidway(), del })).toBeNull()
    expect(del).toHaveBeenCalledTimes(1)
  })
  it('the preview read is bound the same way', async () => {
    const preview = vi.fn(async () => PREVIEW)
    expect(await fetchPreview({ id: 's' }, { binding: moved(), preview })).toBeNull()
    expect(preview).not.toHaveBeenCalled()
    expect(await fetchPreview({ id: 's' }, { binding: changesMidway(), preview })).toBeNull()
    expect(await fetchPreview({ id: 's' }, { binding: held(), preview })).toEqual({ ok: true, preview: PREVIEW })
    expect(await fetchPreview({ id: 's' }, { binding: held(), preview: async () => { throw new ApiError(404, 'not_found', 'Not Found') } })).toEqual({ ok: false, words: expect.stringMatching(/isn't here any more/) })
  })
})

describe('refusals and results, honestly', () => {
  it("the host's mismatch shows the name it expects", () => {
    const e = new ApiError(400, 'confirm_mismatch', "confirm must be the swarm's exact name", { envelope: { expected: 'Forge II' } })
    expect(refusalWords(e, 'Forge')).toEqual({ words: expect.stringMatching(/now called exactly “Forge II”/), expected: 'Forge II' })
    expect(refusalWords(new ApiError(400, 'confirm_mismatch', 'x', { envelope: { expected: 'Forge' } }), 'Forge').words).toMatch(/isn't exactly “Forge”.*Nothing changed/)
  })
  it('busy, from any write that holds the swarm, is plain and says nothing was deleted', () => {
    const w = refusalWords(new ApiError(409, 'swarm_busy', 'this swarm is being deleted or restored right now; try again shortly'), 'Forge').words
    expect(w).toMatch(/^Forge is busy right now: this swarm is being deleted or restored right now.*Nothing was deleted/)
  })
  it('minds that would not stop are named; nothing was deleted', () => {
    const e = new ApiError(409, 'minds_unstoppable', 'x', { envelope: { failed: [{ id: 'a', name: 'Mira', error: 'no' }] } })
    expect(refusalWords(e, 'Lyra')).toEqual({ words: expect.stringMatching(/^Nothing was deleted: this mind could not be stopped/), minds: ['Mira'] })
  })
  it('a partial answer says cleanup is pending, and how to finish', () => {
    const w = resultWords('Forge', { swarm: 'archived', deleted_minds: ['a', 'b'], remaining_minds: ['c'], cleanup_pending: ['b'], error: { code: 'cleanup_failed', message: 'x', mind: 'b' }, hint: 'send again', released_tasks: 1 })
    expect(w.partial).toBe(true)
    expect(w.title).toBe('Forge was only partly deleted')
    expect(w.body).toMatch(/archived and none of its minds is running\. b was deleted, but its cleanup did not finish\. 2 minds were deleted\. Cleanup is still pending for 1 deleted mind\. Still in the swarm: c\. Finish the delete to complete it \(it deletes that mind too\)/)
    expect(w.body).toMatch(/1 task was released back to open/)
  })
  it('whole results: deleted, or archived with its reason in task words', () => {
    expect(resultWords('Forge', { swarm: 'deleted', deleted_minds: ['a'], released_tasks: 0 })).toEqual({ title: 'Forge was deleted', body: 'The swarm was deleted, with its 1 mind.', detached: [], partial: false })
    const a = resultWords('Forge', { swarm: 'archived', deleted_minds: ['a', 'b'], reason: 'it has history (3 goals)', released_tasks: 2, skipped_minds: [{ id: 'x', name: 'Quench', reason: 'moved' }] })
    expect(a.body).toMatch(/because it has history \(3 tasks\).*2 tasks were released back to open\. Quench moved to another swarm meanwhile and was left alone\./)
    noGoalWords(a.body)
  })
  it('names the loaded tasks the delete would release (release_rows selection)', () => {
    const g = (id: string, status: string, assignee: string | null, claimed_by: string | null = null) => ({ id, title: id, status, assignee, claimed_by })
    const out = knownReleased([g('1', 'open', 'm'), g('2', 'claimed', null, 'm'), g('3', 'submitted', 'm'), g('4', 'submitted', null, 'm'), g('5', 'done', 'm'), g('6', 'open', 'x')], new Set(['m']))
    expect(out.map((x) => x.id)).toEqual(['1', '2', '3'])
  })
})

describe('the Ask opens the warning, never deletes', () => {
  const world = { minds: [], swarms: [{ id: 's_forge', name: 'Forge' }, { id: 's_kelp', name: 'Kelp' }], apps: [], pending: 0 } as unknown as World
  it('"delete the Forge swarm" opens its decision', () => {
    const [c] = deleteSwarmCandidates('delete the Forge swarm', world)
    expect(c.act).toEqual({ do: 'deleteSwarm', swarm: { id: 's_forge', name: 'Forge' } })
    expect(c.effect).toBe('open-decision')
    expect(deleteSwarmCandidates('delete Forge and its minds', world)).toHaveLength(1)
    expect(deleteSwarmCandidates('delete Forge', world)).toEqual([])
    expect(deleteSwarmCandidates('delete the Nowhere swarm', world)).toEqual([])
  })
})

describe('the sim host, as the r3 contract', () => {
  const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  it('the preview writes nothing', async () => {
    const a = sim()
    const before = JSON.stringify([await a.getSwarm('s_forge'), (await a.listAgents()).length])
    const p = await a.deleteSwarmPreview('s_forge')
    expect(p.name).toBe('Forge')
    expect(p.counts.minds).toBeGreaterThan(0)
    expect(JSON.stringify([await a.getSwarm('s_forge'), (await a.listAgents()).length])).toBe(before)
    expect((await a.deleteSwarmPreview('s_kelp')).busy).toBe('a flow is still running here')
  })
  it('mismatch carries expected; busy refuses; a partial answer then the same request finishes', async () => {
    const a = sim()
    await expect(a.deleteSwarmWithMinds('s_forge', 'forge')).rejects.toMatchObject({ code: 'confirm_mismatch', envelope: { expected: 'Forge' } })
    await expect(a.deleteSwarmWithMinds('s_kelp', 'Kelp Commons')).rejects.toMatchObject({ code: 'swarm_busy' })
    const estimate = (await a.deleteSwarmPreview('s_forge')).released_tasks_estimate
    // Kimi K6: the sim's partials are not only the easy one. Forge: Anvil's cleanup fails (2 remain), then Quench's
    // delete fails before its commit (a 200 with minds_unstoppable, 1 remains), then the same request finishes
    const first = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    expect(first).toMatchObject({ swarm: 'archived', cleanup_pending: ['a_anvl09'], remaining_minds: ['a_bell10', 'a_qnch11'], error: { code: 'cleanup_failed', mind: 'a_anvl09' }, detached_swarms: ['s_lyra'] })
    const second = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    expect(second).toMatchObject({ swarm: 'archived', deleted_minds: ['a_anvl09', 'a_bell10'], remaining_minds: ['a_qnch11'], error: { code: 'minds_unstoppable', mind: 'a_qnch11' } })
    expect(second.cleanup_pending).toBeUndefined()
    expect(second.detached_swarms).toBeUndefined()
    const third = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    expect(third.error).toBeUndefined()
    expect(third.deleted_minds).toEqual(['a_qnch11'])
    expect([first, second, third].reduce((s, r) => s + (r.released_tasks ?? 0), 0)).toBe(estimate)
  })
})

describe('r2: the stand-in r1 findings', () => {
  const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  it('P2-1: a partial that deleted the last mind stays finishable: settings, preview words and the Ask', async () => {
    const a = sim()
    // the easy partial: the LAST mind's cleanup fails, so no minds remain
    a.simCleanupFailsOnce = new Set(['a_qnch11'])
    a.simDeleteStopFailsOnce.clear()
    const first = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    expect(first.cleanup_pending).toEqual(['a_qnch11'])
    // no minds left, archived: the preview still answers, in finish words, and settings offer Finish deleting
    const p = await a.deleteSwarmPreview('s_forge')
    expect(p.counts.minds).toBe(0)
    expect(previewWords('Forge', p).minds).toMatch(/No minds remain in it\. If an earlier delete left cleanup unfinished, this finishes it\./)
    expect(deleteActionFor({ minds: 0, archived: true })).toBe('finish')
    expect(deleteActionFor({ minds: 2, archived: false })).toBe('delete')
    expect(deleteActionFor({ minds: 0, archived: false })).toBeNull()
    // the Ask names an archived swarm too (the hive leaves it out of the normal list)
    const world = { minds: [], swarms: [], archivedSwarms: [{ id: 's_forge', name: 'Forge' }], apps: [], pending: 0 } as unknown as World
    expect(deleteSwarmCandidates('delete the Forge swarm', world)[0]?.act).toEqual({ do: 'deleteSwarm', swarm: { id: 's_forge', name: 'Forge' } })
    // and the same request finishes it
    const again = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    expect(again.error).toBeUndefined()
    expect(again.deleted_minds).toEqual(['a_qnch11'])
  })
  it('P2-2: a rename between attempts goes back to typing the name the hive expects', async () => {
    const a = sim()
    a.simDeleteStopFailsOnce.clear()
    await a.deleteSwarmWithMinds('s_forge', 'Forge')
    await a.updateSwarm!('s_forge', { name: 'Forge II' })
    const err = await a.deleteSwarmWithMinds('s_forge', 'Forge').catch((e: unknown) => e)
    expect(afterFinishRefusal(err, 'Forge')).toEqual({ kind: 'reconfirm', name: 'Forge II', refusal: expect.stringMatching(/now called exactly “Forge II”/) })
    expect(afterFinishRefusal(new ApiError(409, 'swarm_busy', 'a flow is still running here'), 'Forge')).toEqual({ kind: 'done', refusal: expect.stringMatching(/busy right now/) })
    // the expected name then finishes it
    expect((await a.deleteSwarmWithMinds('s_forge', 'Forge II')).error).toBeUndefined()
  })
  it('P2-3: a lost answer is "not known", never "try again", and is settled by reading', async () => {
    const lost = new ApiError(0, 'answer_unreadable', 'x')
    expect(outcomeUnknown(lost)).toBe(true)
    expect(outcomeUnknown(new ApiError(409, 'swarm_busy', 'x'))).toBe(false)
    expect(refusalWords(lost, 'Forge').words).not.toMatch(/try again/i)
    const a = sim()
    a.simLoseAnswerOnce.add('s_kelp')
    a.simRunningFlows.clear()
    await expect(a.deleteSwarmWithMinds('s_kelp', 'Kelp Commons')).rejects.toMatchObject({ status: 0 })
    // it went through: the read says so (Kelp kept history, so it is archived with no minds), and nothing is resent
    const r = await reconcile({ id: 's_kelp' }, { binding: held(), preview: (id) => a.deleteSwarmPreview(id) })
    expect(r).toMatchObject({ gone: false, preview: { counts: { minds: 0 } } })
    expect(reconciledWords('Kelp Commons', r!).body).toMatch(/answer was lost; reading again shows Kelp Commons has no minds left\. Nothing more is sent unless you confirm again/)
    expect(await reconcile({ id: 's' }, { binding: held(), preview: async () => { throw new ApiError(404, 'not_found', 'x') } })).toEqual({ gone: true })
    expect(await reconcile({ id: 's' }, { binding: moved(), preview: async () => PREVIEW })).toBeNull()
    expect(reconciledWords('F', { failed: 'The hive did not answer.' }).body).toMatch(/still not known/)
  })
  it('P2-4: a retry keeps the totals of every attempt', () => {
    const r1 = { swarm: 'archived' as const, deleted_minds: ['a', 'b', 'c'], remaining_minds: [], cleanup_pending: ['c'], error: { code: 'cleanup_failed', message: 'x' }, released_tasks: 5 }
    const r2 = { swarm: 'archived' as const, deleted_minds: ['c'], reason: 'it has history (12 tasks)', released_tasks: 0 }
    const t1 = addAttempt(NO_PROGRESS, r1)
    const t2 = addAttempt(t1, r2)
    expect(t2).toEqual({ attempts: 2, minds: ['a', 'b', 'c'], released: 5, detached: [] })
    const w = resultWords('Forge', r2, t2)
    expect(w.body).toMatch(/^3 minds were deleted over 2 attempts\. .*5 tasks were released back to open in all\. This attempt finished 1 mind\.$/)
  })
})

describe("r2: Kimi's r1 findings", () => {
  const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  it('K1: a partial names the minds that remain, and Finish says it deletes them', async () => {
    const a = sim()
    const names: Record<string, string> = { a_anvl09: 'Anvil', a_bell10: 'Bellows', a_qnch11: 'Quench' }
    const r = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    const w = resultWords('Forge', r, addAttempt(NO_PROGRESS, r), (id) => names[id] ?? id)
    expect(w.remaining).toEqual(['Bellows', 'Quench'])
    expect(w.body).toMatch(/Still in the swarm: Bellows, Quench\. Finish the delete to complete it \(it deletes those minds too\)/)
  })
  it('K3: the preview never promises detachments; the result lists the real ones', () => {
    const w = previewWords('Forge', { ...PREVIEW, counts: { ...PREVIEW.counts, child_swarms: 2 } })
    expect(w.kept[0]).toMatch(/^Up to 2 swarms sit inside its minds or members\. None is deleted/)
    expect(w.kept[0]).not.toMatch(/will be detached|they are kept and will stand/)
    expect(resultWords('Forge', { swarm: 'deleted', deleted_minds: ['a'], detached_swarms: ['s_lyra'], released_tasks: 0 }).detached).toEqual(['s_lyra'])
  })
  it('K4: an error code inside a 200 gets its own words', async () => {
    const nameOf = (id: string) => ({ a_qnch11: 'Quench', a_anvl09: 'Anvil' })[id] ?? id
    expect(stoppedWords({ code: 'minds_unstoppable', message: 'x', mind: 'a_qnch11' }, nameOf)).toBe("1 mind wouldn't stop: Quench. Nothing more was deleted.")
    expect(stoppedWords({ code: 'cleanup_failed', message: 'x', mind: 'a_anvl09' }, nameOf)).toBe('Anvil was deleted, but its cleanup did not finish.')
    expect(stoppedWords({ code: 'mind_moved', message: 'its goal moved', mind: 'z' })).toBe('It stopped at z: its task moved. Nothing more was deleted.')
    const a = sim()
    await a.deleteSwarmWithMinds('s_forge', 'Forge')
    const second = await a.deleteSwarmWithMinds('s_forge', 'Forge')
    const w = resultWords('Forge', second, addAttempt(NO_PROGRESS, second), nameOf)
    expect(w.stopped).toBe("1 mind wouldn't stop: Quench. Nothing more was deleted.")
    expect(w.pending).toBe(0)
    expect(w.body).not.toMatch(/Cleanup is still pending/)
  })
  it('K5: an unknown `would` reads as archive (the safe direction)', () => {
    expect(readPreview({ ...PREVIEW, would: 'obliterate' })!.would).toBe('archive')
    expect(readPreview({ ...PREVIEW, would: undefined })!.would).toBe('archive')
    expect(readPreview({ ...PREVIEW, would: 'delete' })!.would).toBe('delete')
  })
})
