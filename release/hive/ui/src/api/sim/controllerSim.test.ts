import { describe, expect, it } from 'vitest'
import { SimController } from './controllerSim'

const make = (o: { on?: boolean; apply?: boolean } = {}) => {
  let t = 0
  const c = new SimController({ on: () => o.on ?? true, applyOn: () => o.apply ?? false, known: (id) => id === 'rq_sim1', now: () => t })
  return { c, at: (ms: number) => { t = ms } }
}
const act = (v: Record<string, unknown>, name: string) => (v.actions as { name: string; available: boolean; why_not: string | null }[]).find((a) => a.name === name)!

describe('sim controller (?simengine=1): the engine-driven person path', () => {
  it('is a 404 when off or for an unknown request, as a host without the controller', () => {
    expect(() => make({ on: false }).c.view('rq_sim1')).toThrow(/no request/)
    expect(() => make().c.view('rq_other')).toThrow(/no request/)
  })
  it('moves awaiting a helper → writing → testing → ready (unreviewed), with the test line and the three actions', () => {
    const { c, at } = make()
    const first = c.view('rq_sim1')
    expect(first).toMatchObject({ status: 'writing', next_action: '(rest awaiting-helper)', review_policy: 'review-waivable', unreviewed: false })
    at(2000); expect(c.view('rq_sim1')).toMatchObject({ status: 'writing', next_action: '(think make-the-smallest-change)' })
    at(5000); expect(c.view('rq_sim1').status).toBe('testing')
    at(8000); const v = c.view('rq_sim1')
    expect(v).toMatchObject({ status: 'ready_for_you', unreviewed: true, review: 'unavailable', review_policy: 'review-waivable', second_opinion: null })
    expect(v.next_action).toBe('(tell confirm-unreviewed-to-apply "sg_sim_1")')
    expect(JSON.stringify(v.test)).toContain('1 passed in 0.02s')
    expect(act(v, 'changes').available).toBe(true)
    expect(act(v, 'discard').available).toBe(true)
  })
  it('refuses Apply honestly like the live hive today, and lets it through with ?simapply=on', () => {
    const off = make(); off.at(0); off.c.view('rq_sim1'); off.at(8000)
    expect(act(off.c.view('rq_sim1'), 'apply')).toMatchObject({ available: false, why_not: 'Applying isn’t switched on for this project yet.' })
    expect(() => off.c.apply('rq_sim1')).toThrow(/copy-apply/)
    const on = make({ apply: true }); on.c.view('rq_sim1'); on.at(8000)
    expect(on.c.apply('rq_sim1').status).toBe('applied')
  })
  it('the review setting (GET/PUT /api/me/code-controller): a 404 when off; applies to new requests; review-required ends blocked', () => {
    expect(() => make({ on: false }).c.prefs()).toThrow(/no code controller/)
    const { c, at } = make()
    expect(c.prefs()).toEqual({ review_policy: 'review-waivable', applies_to: 'new Code requests' })
    c.view('rq_sim1')
    expect(() => c.setPrefs({ review_policy: 'sometimes' })).toThrow(/review_policy is one of/)
    expect(c.setPrefs({ review_policy: 'review-required' })).toMatchObject({ review_policy: 'review-required' })
    at(8000)
    // the run already under way keeps the setting it started under
    expect(c.view('rq_sim1')).toMatchObject({ status: 'ready_for_you', review_policy: 'review-waivable' })
    const fresh = make(); fresh.c.setPrefs({ review_policy: 'review-required' }); fresh.c.view('rq_sim1'); fresh.at(8000)
    const v = fresh.c.view('rq_sim1')
    expect(v).toMatchObject({ status: 'needs_you', phase: 'blocked', review: 'unavailable', unreviewed: false, review_policy: 'review-required' })
    expect(act(v, 'apply').available).toBe(false)
  })
  it('Ask for changes starts round 2; Discard stops it', () => {
    const { c, at } = make(); c.view('rq_sim1'); at(8000)
    expect(() => c.changes('rq_sim1', '')).toThrow(/1-4000/)
    expect(c.changes('rq_sim1', 'Keep the docstring').status).toBe('writing')
    expect(c.discard('rq_sim1').status).toBe('stopped')
  })
})
