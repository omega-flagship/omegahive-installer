import { describe, expect, it } from 'vitest'
import * as rest from './rest'
import type { RestAlert, RestView } from './rest'

/** Kimi resting r2 (FIX-FIRST) and Surface's r3 rulings, as tests. Synthetic data only. */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const HERE = new URL('.', import.meta.url).pathname
const src = (p: string) => fs.readFileSync(`${HERE}${p}`, 'utf8')
const r = rest as unknown as Record<string, (...a: unknown[]) => unknown>
const IDLE = 120_000
const goal = (id: string, t = 'G'): RestAlert => ({ kind: 'goal', title: t, key: `goal:${id}` })
const decision = (id: string): RestAlert => ({ kind: 'decision', title: null, key: `decision:${id}` })
const thread = (id: string): RestAlert => ({ kind: 'thread', title: null, key: `thread:${id}` })
const awayWith = (alerts: RestAlert[]): RestView => {
  let v = rest.restReducer(rest.restInitial(0, 'c'), { type: 'tick', at: IDLE, idleMs: IDLE })
  for (const alert of alerts) v = rest.restReducer(v, { type: 'alert', ctx: 'c', admin: true, alert })
  return rest.restReducer(v, { type: 'input', at: IDLE + 1 })
}

describe('Kimi r2 1: a press ends when the buttons are seen released', () => {
  it('a pointermove with no buttons held ends a press (a release outside the window the page never saw)', () => {
    expect(r.pressEndedBy({ type: 'pointermove', buttons: 0 })).toBe(true)
    expect(r.pressEndedBy({ type: 'pointermove', buttons: 1 })).toBe(false)
    expect(r.pressEndedBy({ type: 'pointerup', buttons: 0 })).toBe(true)
    expect(r.pressEndedBy({ type: 'pointercancel', buttons: 0 })).toBe(true)
    expect(r.pressEndedBy({ type: 'pointerdown', buttons: 1 })).toBe(false)
    // window pointerleave never fires for element leaves; it is not relied on
    expect(rest.PRESS_ENDS as readonly string[]).not.toContain('pointerleave')
    expect(src('RestScreen.tsx')).toMatch(/pressEndedBy\(\{ type: t, buttons: pe\.buttons \}\)/)
  })
})

describe('Kimi r2 2: screen-reader-only text is defined globally', () => {
  it('index.css ends with the global .sr-only block (identical to the voice builder’s)', () => {
    const css = fs.readFileSync(`${HERE}../../index.css`, 'utf8').trimEnd()
    expect(css.endsWith('/* screen-reader-only text (global) */\n.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }')).toBe(true)
    expect(src('RestFaces.tsx')).toMatch(/className="pw-clock sr-only"/)
  })
})

describe('Kimi r2 3: the click shield belongs to one sign-in and one wake', () => {
  it('a shield raised under A is never drawn for B, nor while resting', () => {
    expect(r.shieldShown('ctxA', 'ctxA', false)).toBe(true)
    expect(r.shieldShown('ctxA', 'ctxB', false)).toBe(false)
    expect(r.shieldShown('ctxA', 'ctxA', true)).toBe(false)
    expect(r.shieldShown(null, 'ctxA', false)).toBe(false)
    const host = src('RestScreen.tsx')
    // cleared on the reset/identity path too
    expect(host).toMatch(/setShield\(null\)/)
  })
})

describe('Kimi r2 4: a way in clears only itself', () => {
  it('acting on one kind leaves the others offered; the bar goes when nothing is left to act on', () => {
    let v = awayWith([goal('g1'), thread('t1')])
    expect(v.missed.map((a) => a.kind)).toEqual(['goal', 'thread'])
    v = rest.restReducer(v, { type: 'acted', chip: 'goals' } as never)
    expect(v.missed.map((a) => a.kind)).toEqual(['thread'])
    expect(v.summary).not.toBeNull()
    v = rest.restReducer(v, { type: 'acted', chip: 'answers' } as never)
    expect(v.missed).toEqual([])
    expect(v.summary).toBeNull()
    expect(src('RestScreen.tsx')).toMatch(/dispatch\(\{ type: 'acted', chip: id \}\)/)
  })
})

describe('Kimi r2 5 / Surface ruling: the away line is a HISTORY; its buttons are ACTIONS', () => {
  it('the words are what the page received and never change once shown; only the actions follow what is still live', () => {
    const v = awayWith([decision('d1'), goal('g1', 'Map')])
    const words = v.summary
    expect(words).toMatch(/1 decision waiting/)
    // the decision is settled elsewhere: the history keeps it; the action goes
    const host = src('RestScreen.tsx')
    expect(host).toMatch(/<span>\{v\.summary\}<\/span>/)
    expect(host).not.toMatch(/awaySummary\(liveMissed\)/)
    const actions = rest.awayChips(rest.liveAlerts(v.missed, new Set<string>()), 0)
    expect(actions.map((c) => c.id)).toEqual(['goals'])
    expect(v.summary).toBe(words)
  })
})
