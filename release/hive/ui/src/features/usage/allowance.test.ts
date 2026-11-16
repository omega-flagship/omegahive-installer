// Purpose: the battery meter's rules and its parts in the frame's usage region: spend and held calls together are what an allowance or the hive cap has used, the battery reads low under a fifth left and used up at nothing left, what the frame is told, which battery MeTTa composes into the usage region for which facts (allowance.metta), in every look, and what the progress block draws for it. INVENTED DATA only.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MySpendSummary } from '../../api/types'
import { RegionParts } from '../../screens/Screen'
import { ScreensSpace, type ScreenPlan } from '../../screens/screenSpace'
import { allowanceBattery, allowanceScreen, batteryLeft, batteryParts, hiveBattery, LOW_SHARE, type Battery } from './allowance'
import type { LimitRowView } from './limitsView'

const me = (over: Partial<MySpendSummary> = {}): MySpendSummary => ({
  principal: 'user:u_rowan', since: '2026-11-01T00:00:00Z', hive_paid_usd: 30.4, own_keys_usd: 0, own_keys: 0,
  allowance_usd: 50, allowance_origin: 'member-default', remaining_usd: 19.6, held_usd: 0.6, by_mind: [], ...over,
})
const cap = (over: Partial<LimitRowView> = {}): LimitRowView => ({
  key: 'hive:month', scope: 'hive', period: 'month', limit_usd: 500, spent_usd: 116, held_usd: 4, room_usd: 380, source: 'set', ...over,
})

describe('the battery meter counts what admission counts', () => {
  it("a person's battery is their spend plus what calls not yet settled hold, against their allowance", () => {
    const b = allowanceBattery(me())!
    expect(b).toMatchObject({ kind: 'allowance', used_usd: 31, held_usd: 0.6, max_usd: 50, left_usd: 19, tone: 'ok', period: 'month' })
    expect(b.level).toBeCloseTo(0.38)
    expect(batteryLeft(b)).toBe('$19 left')
  })

  it('gives cents once under $10 is left', () => {
    expect(batteryLeft(allowanceBattery(me({ hive_paid_usd: 45.4, held_usd: 0 }))!)).toBe('$4.60 left')
  })

  it('reads low under a fifth left and used up once nothing is left, never below zero', () => {
    expect(allowanceBattery(me({ hive_paid_usd: 50 * (1 - LOW_SHARE) + 0.01, held_usd: 0 }))!.tone).toBe('low')
    expect(allowanceBattery(me({ hive_paid_usd: 50 * (1 - LOW_SHARE) - 0.01, held_usd: 0 }))!.tone).toBe('ok')
    const out = allowanceBattery(me({ hive_paid_usd: 49.8, held_usd: 0.9 }))!
    expect(out).toMatchObject({ tone: 'out', left_usd: 0, level: 0 })
    expect(batteryLeft(out)).toBe('used up')
  })

  it('has no battery without an allowance: an admin with no rule of their own, or a hive that sends none', () => {
    expect(allowanceBattery(me({ allowance_usd: null, allowance_origin: null, remaining_usd: null }))).toBeNull()
    expect(allowanceBattery(null)).toBeNull()
  })

  it("the hive cap's battery counts its spend and held calls, follows its period, and there is none without a cap", () => {
    const b = hiveBattery(cap())!
    expect(b).toMatchObject({ kind: 'hive', used_usd: 120, left_usd: 380, tone: 'ok', period: 'month' })
    expect(batteryLeft(b)).toBe('$380 left')
    expect(hiveBattery(cap({ key: 'hive:day', period: 'day', limit_usd: 5, spent_usd: 1.25, held_usd: 0, room_usd: 3.75 }))!.period).toBe('day')
    expect(hiveBattery(null)).toBeNull()
    expect(hiveBattery(cap({ limit_usd: 0 }))).toBeNull()
  })
})

describe("what the battery's screen is told", () => {
  it('splits a battery into what is left in its tone, what calls hold and what is spent, in dollars', () => {
    expect(batteryParts(allowanceBattery(me())!)).toEqual([
      { label: 'dollars left', n: 19, color: 'hsl(252 90% 62%)' },
      { label: 'dollars held', n: 0.6, color: 'hsl(252 90% 62% / 0.4)' },
      { label: 'dollars spent', n: 30.4 },
    ])
    expect(batteryParts(allowanceBattery(me({ hive_paid_usd: 45.4, held_usd: 0 }))!)[0].color).toBe('hsl(38 90% 62%)')
  })

  it('states each battery by path and whether it shows as a flag, and nothing for a battery that is not there', () => {
    const { data, facts } = allowanceScreen([allowanceBattery(me())!])
    expect(facts).toEqual({ flags: { 'allowance.mine': true, 'allowance.hive': false } })
    expect(Object.keys(data).sort()).toEqual(['allowance.mine.left', 'allowance.mine.parts'])
    expect(data['allowance.mine.left']).toBe('$19 left')
  })
})

describe("the battery is the frame's usage region, composed by MeTTa (allowance.metta)", () => {
  const space = ScreensSpace.open()
  const draw = (batteries: Battery[], look = 'classic') => {
    const { data, facts } = allowanceScreen(batteries)
    const plan = space.compose('frame', look, facts)
    return { plan, html: renderToStaticMarkup(createElement(RegionParts, { plan, host: { data }, region: 'usage' })) }
  }
  const shown = (plan: ScreenPlan) => plan.parts.filter((p) => p.place.region === 'usage').map((p) => [p.order, p.block])

  it('a member sees their own battery, drawn by the progress block, with what is left under it', () => {
    const { plan, html } = draw([allowanceBattery(me())!])
    expect(shown(plan)).toEqual([[10, 'progress']])
    expect(html).toContain('$19 left')
    expect(html).toContain('aria-label="19 dollars left, 0.6 dollars held, 30.4 dollars spent"')
  })

  it("an admin with no allowance of their own sees the hive cap's battery, which needs no name on its own", () => {
    const { plan, html } = draw([hiveBattery(cap())!])
    expect(shown(plan)).toEqual([[20, 'progress']])
    expect(html).toContain('$380 left')
    expect(html).not.toContain('hive $380')
  })

  it("an admin with an allowance sees both side by side, the hive cap's named as the hive's", () => {
    const { plan, html } = draw([allowanceBattery(me())!, hiveBattery(cap())!])
    expect(shown(plan)).toEqual([[10, 'progress'], [21, 'progress']])
    expect(plan.parts.map((p) => p.place.row)).toEqual(['batteries', 'batteries'])
    expect(html).toContain('$19 left')
    expect(html).toContain('hive $380 left')
  })

  it('composes nothing without an allowance or a cap', () => {
    expect(draw([]).plan.parts).toEqual([])
  })

  it('every look places it in the usage region and draws it with the progress block, the measure role’s block', () => {
    for (const look of ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']) {
      expect(shown(draw([allowanceBattery(me())!], look).plan)).toEqual([[10, 'progress']])
    }
  })
})
