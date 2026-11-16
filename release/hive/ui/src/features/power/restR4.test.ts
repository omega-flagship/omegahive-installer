import { describe, expect, it } from 'vitest'
import * as rest from './rest'
import type { RestAlert, RestView } from './rest'

/** Stand-in Review (STANDIN_surface_VERDICT_20261006 resting items 3-4) and Kimi r3's note, as tests. Synthetic only. */
const IDLE = 120_000
const ask: RestAlert = { kind: 'ask', title: null, key: 'ask:r1' }
const goal: RestAlert = { kind: 'goal', title: 'Map', key: 'goal:g1' }
const wakeWith = (admin: boolean, alerts: RestAlert[]): RestView => {
  let v = rest.restReducer(rest.restInitial(0, 'c'), { type: 'tick', at: IDLE, idleMs: IDLE })
  for (const alert of alerts) v = rest.restReducer(v, { type: 'alert', ctx: 'c', admin, alert } as never)
  return rest.restReducer(v, { type: 'input', at: IDLE + 1 })
}

describe('stand-in 3: the history is recorded in the viewer’s scope', () => {
  it('“A non-admin receiving an ask event while resting can therefore see ‘ask waiting’ in the wake summary”: never', () => {
    const member = wakeWith(false, [ask, goal])
    // \b: “task done” contains the letters of “ask”; what must never show is an ask waiting
    expect(member.summary).not.toMatch(/\basks? waiting/)
    expect(member.summary).toMatch(/1 task done/)
    expect(member.missed.map((a) => a.kind)).toEqual(['goal'])
    expect(member.away).toEqual([])
    // an admin's history keeps it
    expect(wakeWith(true, [ask, goal]).summary).toMatch(/1 ask waiting/)
  })
  it('a non-admin ask is not admitted at all (no line while resting either)', () => {
    let v = rest.restReducer(rest.restInitial(0, 'c'), { type: 'tick', at: IDLE, idleMs: IDLE })
    v = rest.restReducer(v, { type: 'alert', ctx: 'c', admin: false, alert: ask } as never)
    expect(v.showing).toBeNull()
    expect(v.away).toEqual([])
  })
})

describe('stand-in 4: the bar is shown only while something is left to act on', () => {
  it('awayBarShown: words and at least one live action', () => {
    const r = rest as unknown as { awayBarShown: (s: string | null, n: number) => boolean }
    expect(r.awayBarShown('While you were away: 1 decision waiting.', 0)).toBe(false)
    expect(r.awayBarShown('While you were away: 1 task done.', 1)).toBe(true)
    expect(r.awayBarShown(null, 2)).toBe(false)
  })
})

describe('Kimi r3 note: words and chips agree about health', () => {
  it('health is a live count, never part of the away history: the away bar never offers it and its words never name it', () => {
    const v = wakeWith(true, [goal])
    const chips = rest.awayChips(rest.liveAlerts(v.missed, new Set<string>()), 5)
    expect(chips.map((c) => c.id)).not.toContain('health')
    expect(v.summary).not.toMatch(/health|need/)
    // a health chip on the rest face takes no history with it (there is none of that kind)
    expect(rest.CHIP_KINDS.health).toEqual([])
    const after = rest.restReducer(v, { type: 'acted', chip: 'health' })
    expect(after.summary).toBe(v.summary)
  })
})
