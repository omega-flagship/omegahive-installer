// Purpose: the Canvas board as MeTTa arranges it (board.metta through board.ts) is the board the look drew before its
// placement moved out of TypeScript: for 24 seeded boards (empty ones, tall ones, swarms with no minds, unassigned minds,
// up to 40 tasks and 5 decisions) every island, card, sticky, lane, decision, bound and empty board sits where
// layout.ts's computeLayout put it (board.fixture.json, recorded from it). INVENTED swarms, minds and tasks.
import { beforeAll, describe, expect, it } from 'vitest'
import type { Agent, Approval, Goal, Swarm } from '../sdk'
import { boardInput, composeBoard } from './board'
import { pendingDecisions } from './layout'
import fixture from './board.fixture.json'

interface Case {
  seed: number
  aspect: number
  swarms: Swarm[]
  agents: Agent[]
  goals: Goal[]
  approvals: Record<string, Approval>
  out: {
    laneMode: string
    islands: { id: string; x: number; y: number; w: number; h: number; cols: number; goals: string[]; doneHidden: number }[]
    items: { key: string; kind: string; id: string; island: string | null; x: number; y: number; w: number; h: number }[]
    lane: { x: number; y: number; w: number; h: number }
    bounds: { x: number; y: number; w: number; h: number }
    empty: { x: number; y: number; w: number; h: number } | null
    decisions: string[]
  }
}
const cases = (fixture as unknown as { cases: Case[] }).cases
const near = (a: number, b: number, why: string) => expect(Math.abs(a - b), why).toBeLessThan(1e-6)
const same = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, why: string) => {
  near(a.x, b.x, `${why} x`)
  near(a.y, b.y, `${why} y`)
  near(a.w, b.w, `${why} w`)
  near(a.h, b.h, `${why} h`)
}

describe('the Canvas board, arranged by MeTTa', () => {
  // the first arrangement loads MeTTa and the rules, so it is paid once here, under the hook's own timeout, and each
  // board below is one arrangement's work under the test's
  beforeAll(() => {
    composeBoard(boardInput([], [], [], [], 1.6))
  })

  it('holds the 24 seeded boards the layout was recorded for', () => {
    expect(cases.length).toBe(24)
  })

  it.each(cases)('puts every island, card, sticky, lane and decision of board $seed where the reviewed layout did', (c) => {
    const why = `seed ${c.seed}`
    const got = composeBoard(boardInput(c.agents, c.swarms, c.goals, pendingDecisions(c.approvals), c.aspect))
    expect(got.laneMode, why).toBe(c.out.laneMode)
    expect(got.decisions, why).toEqual(c.out.decisions)
    expect(got.islands.map((i) => i.id), why).toEqual(c.out.islands.map((i) => i.id))
    got.islands.forEach((i, n) => {
      const want = c.out.islands[n]
      same(i, want, `${why} island ${i.id}`)
      expect([i.cols, i.goals, i.doneHidden], `${why} island ${i.id}`).toEqual([want.cols, want.goals, want.doneHidden])
    })
    const items = [...got.items.values()].sort((a, b) => a.key.localeCompare(b.key))
    expect(items.map((i) => i.key), why).toEqual(c.out.items.map((i) => i.key))
    items.forEach((i, n) => {
      const want = c.out.items[n]
      expect([i.kind, i.id, i.island ?? null], `${why} ${i.key}`).toEqual([want.kind, want.id, want.island])
      same(i, want, `${why} ${i.key}`)
    })
    same(got.lane, c.out.lane, `${why} lane`)
    same(got.bounds, c.out.bounds, `${why} bounds`)
    if (c.out.empty) same(got.empty!, c.out.empty, `${why} empty`)
    else expect(got.empty, why).toBeNull()
  })

  it('opens a mind’s chat card at its card, at the chat’s own size, and frames the lane’s first decisions', () => {
    const c = cases.find((x) => x.out.items.some((i) => i.kind === 'mind') && x.out.laneMode === 'column' && x.out.decisions.length > 0)!
    const mind = c.out.items.find((i) => i.kind === 'mind')!
    const got = composeBoard(boardInput(c.agents, c.swarms, c.goals, pendingDecisions(c.approvals), c.aspect, mind.id))
    const chat = got.items.get(`chat:${mind.id}`)!
    expect([chat.x, chat.y, chat.w, chat.h]).toEqual([mind.x, mind.y, 404, 548])
    expect(got.laneFocus.x).toBe(got.lane.x)
    expect(got.laneFocus.h).toBeLessThanOrEqual(got.lane.h)
  })
})
