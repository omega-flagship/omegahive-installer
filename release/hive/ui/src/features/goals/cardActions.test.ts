import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { Goal } from '../../api/types'
import { ARM_MS, accepts } from '../../lib/decisionGate'
import { confirmGoalChange, goalBound, goalDrift, goalEffect, seenOf, verbFor } from '../../lib/goalDecision'
import { useHive } from '../../store/store'
import { cardActions, cardAsk, KEEP_THE_GOAL } from './cardActions'

// Surface request H (G2) and Review D1 (Platform ruling: no one-click status change on the Classic card). INVENTED DATA only.
const goal: Goal = { id: 'g_card01', swarm_id: 's_forge', parent_id: null, assignee: null, title: 'Edit code: Invented', detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z', lease_until: null, attempts: 0 }
const shape = (g: Pick<Goal, 'status'>) => cardActions(g).map((a) => `${a.label}:${a.to}`)

const sim = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
const clients: SimClient[] = []
/** What GoalDecision binds for a board ask: the goal as the card showed it, stamped with the card's session. */
const seenOfAsk = (ask: ReturnType<typeof cardAsk>) => ({ ...seenOf(ask.seen), session: ask.session })

async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('D1: every Classic goals-card status action goes through GoalDecision', () => {
  it('the card offers the same actions as before, and each is a GoalDecision verb (no one-click exception)', () => {
    for (const status of ['open', 'claimed'] as const) expect(shape({ status })).toEqual(['Done:done', 'Failed:failed', 'Cancel:cancelled'])
    expect(shape({ status: 'waiting' })).toEqual(['Accept · done:done', 'Failed:failed', 'Cancel:cancelled'])
    expect(shape({ status: 'stalled' })).toEqual(['Re-open:open', 'Done:done', 'Failed:failed', 'Cancel:cancelled'])
    for (const status of ['done', 'failed', 'cancelled'] as const) expect(shape({ status })).toEqual(['Reopen:open'])
    expect(shape({ status: 'submitted' })).toEqual([])
    for (const status of ['open', 'claimed', 'waiting', 'stalled', 'done', 'failed', 'cancelled'] as const) for (const a of cardActions({ status })) expect(verbFor(a.to), `${status}:${a.label}`).not.toBeNull()
    // the shape no longer carries a one-click switch
    expect(cardActions({ status: 'open' }).every((a) => !('confirm' in a))).toBe(true)
  })

  it('GoalsBoard writes no status directly: every status change opens GoalDecision; priority is stamped with the session', async () => {
    const text = await source('./GoalsBoard.tsx')
    // the only patchGoal calls left on the board are priority writes, and each carries the card's session
    const calls = [...text.matchAll(/\bpatch\(([^)]*\))/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c, c).not.toMatch(/status/)
      expect(c, c).toMatch(/,\s*session\)$/)
    }
    expect(text).not.toMatch(/patchGoal\s*\(/)
    // Done / Failed / Cancel / Re-open (the card's actions and the stalled banner's Re-open) all ask through cardAsk
    expect(text).toMatch(/onClick=\{\(\) => onDecide\(cardAsk\(g, a\.to, session\)\)\}/)
    expect(text).toMatch(/onClick=\{\(\) => onDecide\(cardAsk\(g, 'open', session\)\)\}/)
    expect(text).not.toMatch(/a\.confirm/)
    // one dialog, at board level, with the ask's session, "Keep the task", and focus home
    expect(text).toMatch(/<GoalDecision[^>]*session=\{asking\.session\}[^>]*dismissLabel=\{KEEP_THE_GOAL\}[^>]*restoreFocus=\{askHome\}/)
    expect(KEEP_THE_GOAL).toBe('Keep the task')
  })

  it('a board ask is the goal as seen (a copy) with the card session', () => {
    const ask = cardAsk(goal, 'done', 'sess-A')
    expect(ask).toEqual({ seen: goal, to: 'done', session: 'sess-A' })
    expect(ask.seen).not.toBe(goal)
  })

  it('the decision is bound to the goal as seen: drift and an already-terminal goal refuse', () => {
    const seen = seenOf(goal)
    for (const to of ['done', 'failed', 'cancelled'] as const) {
      expect(goalBound(seen, goal, to)).toEqual({ kind: 'ready' })
      expect(goalBound(seen, { ...goal, status: 'claimed', claimed_by: 'a_anvl09', updated_at: '2026-10-05T10:01:00Z' }, to).kind).toBe('changed')
      expect(goalBound(seen, { ...goal, status: to }, to).kind).toBe('closed')
    }
    const stalled = { ...goal, status: 'stalled' as const }
    expect(goalBound(seenOf(stalled), stalled, 'open')).toEqual({ kind: 'ready' })
    expect(goalBound(seenOf(stalled), { ...stalled, title: 'Renamed elsewhere', updated_at: '2026-10-05T10:02:00Z' }, 'open').kind).toBe('changed')
    expect(goalBound(seen, undefined, 'done')).toEqual({ kind: 'gone' })
    expect(goalEffect(goal, 'cancelled', null)).toMatch(/cannot be re-opened/)
    expect(goalEffect(goal, 'done', null)).toMatch(/finished for good/)
  })

  it('a premature press (inside the arming window) or a held key is not a decision', () => {
    expect(accepts({ at: ARM_MS - 1 }, 0)).toBe(false)
    expect(accepts({ at: ARM_MS + 10, repeat: true }, 0)).toBe(false)
  })

  it('a stale-session board ask (status or priority) is refused by the binding and the store; nothing reaches the new client', async () => {
    const a = sim(31)
    const b = sim(32)
    clients.push(a, b)
    await useHive.getState().init(a)
    const g = Object.values(useHive.getState().goals).find((x) => x.status === 'open') ?? Object.values(useHive.getState().goals)[0]
    expect(g).toBeTruthy()
    const shownUnder = useHive.getState().session
    const asks = (['done', 'failed', 'open'] as const).map((to) => cardAsk(g, to, shownUnder))
    vi.spyOn(b, 'listGoals').mockImplementation(async (sw: string) => (sw === g.swarm_id ? [g] : []))
    const patchB = vi.spyOn(b, 'patchGoal')
    await useHive.getState().init(b)
    const s = useHive.getState()
    for (const ask of asks) {
      expect(goalBound(seenOfAsk(ask), s.goals[g.id], ask.to).kind).toBe('closed')
      expect(goalDrift(seenOfAsk(ask), s.goals[g.id], ask.to)).toMatch(/earlier connection/)
      expect(await s.patchGoal(g.id, { status: ask.to }, ask.session)).toBe(false)
    }
    // priority is not terminal (no confirm) but carries the session too: an earlier session's write is refused
    expect(await s.patchGoal(g.id, { priority: 0.85 }, shownUnder)).toBe(false)
    expect(patchB).not.toHaveBeenCalled()
    expect(useHive.getState().goals[g.id]).toEqual(g)
  })

  it('same session: premature press and drift refused; a settled confirm writes exactly once; a stamped priority write goes', async () => {
    const a = sim(33)
    clients.push(a)
    await useHive.getState().init(a)
    const g = Object.values(useHive.getState().goals).find((x) => x.status === 'open' || x.status === 'claimed') as Goal
    expect(g).toBeTruthy()
    const patchA = vi.spyOn(a, 'patchGoal')
    const ask = cardAsk(g, 'failed', useHive.getState().session)
    const seen = seenOfAsk(ask)
    const shownAt = 1000
    expect(confirmGoalChange(seen, 'failed', shownAt, useHive.getState().goals[g.id], { at: shownAt + 100 }).ok).toBe(false)
    expect(confirmGoalChange(seen, 'failed', shownAt, useHive.getState().goals[g.id], { at: shownAt + 2000, repeat: true }).ok).toBe(false)
    const drifted = { ...g, title: `${g.title} (renamed elsewhere)`, updated_at: new Date(Date.parse(g.updated_at) + 1000).toISOString() }
    expect(confirmGoalChange(seen, 'failed', shownAt, drifted, { at: shownAt + 2000 }).ok).toBe(false)
    expect(patchA).not.toHaveBeenCalled()
    expect(confirmGoalChange(seen, 'failed', shownAt, useHive.getState().goals[g.id], { at: shownAt + 2000 }).ok).toBe(true)
    expect(await useHive.getState().patchGoal(g.id, { status: 'failed' }, ask.session)).toBe(true)
    expect(patchA).toHaveBeenCalledTimes(1)
    expect(useHive.getState().goals[g.id].status).toBe('failed')
    expect(await useHive.getState().patchGoal(g.id, { priority: 0.3 }, useHive.getState().session)).toBe(true)
    expect(useHive.getState().goals[g.id].priority).toBe(0.3)
  })
})

describe('D1: SessionView answers an approval only in the session it was shown under', () => {
  it('the decide call carries the session the timeline was read under', async () => {
    const text = await source('../messages/SessionView.tsx')
    // Kimi #4: the call moved into sessionDecide.answerShown (which also reloads the timeline after a refusal)
    expect(text).toMatch(/answerShown\(id, d, shownUnder, storeDecide, load\)/)
    expect(text).toMatch(/setShownUnder\(asked\)/)
    expect(text).not.toMatch(/storeDecide\(id, d\)/)
    expect(await source('../messages/sessionDecide.ts')).toMatch(/decide\(id, d, undefined, shownUnder\)/)
  })

  it('an approval shown under an earlier session is refused by the store; nothing reaches the new client', async () => {
    const a = sim(34)
    const b = sim(35)
    clients.push(a, b)
    await useHive.getState().init(a)
    const shownUnder = useHive.getState().session
    const pending = (await a.listApprovals('pending'))[0]
    expect(pending).toBeTruthy()
    const approveB = vi.spyOn(b, 'approve')
    const denyB = vi.spyOn(b, 'deny')
    await useHive.getState().init(b)
    expect(await useHive.getState().decide(pending.id, 'approve', undefined, shownUnder)).toBeNull()
    expect(await useHive.getState().decide(pending.id, 'deny', undefined, shownUnder)).toBeNull()
    expect(approveB).not.toHaveBeenCalled()
    expect(denyB).not.toHaveBeenCalled()
  })

  it('same session: the stamped answer goes', async () => {
    const a = sim(36)
    clients.push(a)
    await useHive.getState().init(a)
    const pending = (await a.listApprovals('pending'))[0]
    const approveA = vi.spyOn(a, 'approve')
    const r = await useHive.getState().decide(pending.id, 'approve', undefined, useHive.getState().session)
    expect(r?.status).toBe('approved')
    expect(approveA).toHaveBeenCalledTimes(1)
  })
})
