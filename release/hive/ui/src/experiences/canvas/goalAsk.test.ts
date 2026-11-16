import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { Goal } from '../../api/types'
import { confirmGoalChange, goalBound, goalDrift, seenOf } from '../../lib/goalDecision'
import { useHive } from '../../store/store'
import { goalAsk, goalBarActions } from './goalAsk'

/**
 * Kimi follow-up (Canvas is live): the selection bar's and the outline's goal actions open the shared GoalDecision
 * with the goal as shown and the session it was shown under; a stale-session change is refused by the binding and
 * by the store at dispatch. Two real SimClients, real init, invented data only.
 */

const sim = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
const clients: SimClient[] = []
/** What GoalDecision binds: the goal as seen, stamped with the ask's session. */
const seenOfAsk = (ask: ReturnType<typeof goalAsk>) => ({ ...seenOf(ask.seen), session: ask.session })

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

describe('Canvas goal actions (Review D1, Kimi follow-up)', () => {
  it('every status action on the selection bar is a GoalDecision verb; Release is decided as a re-open', () => {
    expect(goalBarActions('open')).toEqual([
      { label: 'Mark done', to: 'done', strong: true },
      { label: 'Cancel', to: 'cancelled' },
    ])
    expect(goalBarActions('stalled').map((a) => [a.label, a.to])).toEqual([['Mark done', 'done'], ['Release', 'open'], ['Cancel', 'cancelled']])
    expect(goalBarActions('waiting').map((a) => [a.label, a.to])).toEqual([['Mark done', 'done'], ['Release', 'open'], ['Cancel', 'cancelled']])
    for (const closed of ['done', 'cancelled', 'failed'] as const) expect(goalBarActions(closed).map((a) => [a.label, a.to])).toEqual([['Reopen', 'open']])
  })

  it('no Canvas file writes a goal directly: only GoalDecision dispatches patchGoal', async () => {
    for (const f of ['./index.tsx', './BoardOutline.tsx', './overlays.tsx', './parts.tsx', './slots.tsx', './HivePanel.tsx', './Inspect.tsx', './chat.tsx']) {
      const text = await source(f)
      expect(text, f).not.toMatch(/patchGoal\s*\(/)
    }
    const index = await source('./index.tsx')
    expect(index).toMatch(/<GoalDecision[^>]*session=\{goalAsking\.session\}/)
  })

  it('a stale-session change from Canvas is refused by the binding and by the store; nothing reaches the new client', async () => {
    const a = sim(21)
    const b = sim(22)
    clients.push(a, b)
    await useHive.getState().init(a)
    const goalA = Object.values(useHive.getState().goals).find((g) => g.status === 'open') ?? Object.values(useHive.getState().goals)[0]
    expect(goalA).toBeTruthy()
    // the person pressed Mark done on the bar under A
    const ask = goalAsk(goalA, 'done', useHive.getState().session)
    // B holds the very same goal (reused id, identical fields)
    vi.spyOn(b, 'listGoals').mockImplementation(async (sw: string) => (sw === goalA.swarm_id ? [goalA] : []))
    const patchB = vi.spyOn(b, 'patchGoal')
    await useHive.getState().init(b)
    const s = useHive.getState()
    expect(s.goals[goalA.id]).toEqual(goalA)
    const seen = seenOfAsk(ask)
    expect(goalBound(seen, s.goals[goalA.id], 'done').kind).toBe('closed')
    expect(goalDrift(seen, s.goals[goalA.id], 'done')).toMatch(/earlier connection/)
    expect(await s.patchGoal(goalA.id, { status: 'done' }, ask.session)).toBe(false)
    expect(patchB).not.toHaveBeenCalled()
    expect(useHive.getState().goals[goalA.id].status).toBe(goalA.status)
  })

  it('the session comes from the ask, not from when the dialog renders: a goal shown under A stays bound to A', async () => {
    const a = sim(23)
    const b = sim(24)
    clients.push(a, b)
    await useHive.getState().init(a)
    const goalA = Object.values(useHive.getState().goals)[0]
    const shownUnder = useHive.getState().session
    vi.spyOn(b, 'listGoals').mockImplementation(async (sw: string) => (sw === goalA.swarm_id ? [goalA] : []))
    await useHive.getState().init(b)
    // the dialog mounts after the switch: seenOf alone would stamp B; the ask's session keeps it A, and it is refused
    expect(seenOf(goalA).session).toBe(useHive.getState().session)
    expect(goalBound(seenOfAsk(goalAsk(goalA, 'cancelled', shownUnder)), useHive.getState().goals[goalA.id], 'cancelled').kind).toBe('closed')
  })

  it('same session: premature press refused, drift refused, a settled press goes and the hive takes it', async () => {
    const a = sim(25)
    clients.push(a)
    await useHive.getState().init(a)
    const g = Object.values(useHive.getState().goals).find((x) => x.status === 'open' || x.status === 'claimed' || x.status === 'stalled') as Goal
    expect(g).toBeTruthy()
    const ask = goalAsk(g, 'cancelled', useHive.getState().session)
    const seen = seenOfAsk(ask)
    const shownAt = 1000
    // inside the arming window
    expect(confirmGoalChange(seen, 'cancelled', shownAt, useHive.getState().goals[g.id], { at: shownAt + 100 }).ok).toBe(false)
    // a held key
    expect(confirmGoalChange(seen, 'cancelled', shownAt, useHive.getState().goals[g.id], { at: shownAt + 2000, repeat: true }).ok).toBe(false)
    // someone else changed it while it was open
    const drifted = { ...g, title: `${g.title} (renamed elsewhere)`, updated_at: new Date(Date.parse(g.updated_at) + 1000).toISOString() }
    expect(goalBound(seen, drifted, 'cancelled').kind).toBe('changed')
    expect(confirmGoalChange(seen, 'cancelled', shownAt, drifted, { at: shownAt + 2000 }).ok).toBe(false)
    // settled, unchanged: it goes, under the ask's session
    expect(confirmGoalChange(seen, 'cancelled', shownAt, useHive.getState().goals[g.id], { at: shownAt + 2000 }).ok).toBe(true)
    expect(await useHive.getState().patchGoal(g.id, { status: 'cancelled' }, ask.session)).toBe(true)
    expect(useHive.getState().goals[g.id].status).toBe('cancelled')
  })
})
