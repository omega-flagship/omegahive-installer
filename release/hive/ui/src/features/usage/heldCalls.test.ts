// Purpose: the held calls part of the Usage screen MeTTa composes (usage.metta, orders 200 to 299) from what heldCallsScreen states: which parts show while the held list loads, when it can't be read, with nothing held, with held calls, with calls in flight (the row closed and open), with one estimate, several and more than the list shows, and with overruns; and the rows' words. INVENTED DATA only.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CostOverrun, CostReservation, EstimatedCall } from '../../api/moneyWork'
import type { ResourceStatus } from '../../lib/useResource'
import { Screen } from '../../screens/Screen'
import { ScreensSpace, type ScreenPlan } from '../../screens/screenSpace'
import { ESTIMATES_SHOWN, heldCallsScreen } from './heldCallsScreen'

const t = 1_800_000_000
const now = t * 1000
const name = (_kind: 'agent' | 'swarm' | 'key', id: string) => (id === 'a_ada' ? 'Ada' : id)
const held = (id: string, over: Partial<CostReservation> = {}): CostReservation => ({
  id, state: 'unknown', held_usd: 0.012, scopes: ['hive:month'], metadata: { agent: 'a_ada', model: 'openrouter/x' }, observation: null,
  settles: 'record', unknown_at: t - 18 * 60, auto_settles_at: t + 42 * 60, ...over,
})
const flight = (id: string): CostReservation => ({ ...held(id), state: 'dispatched', settles: 'answer', unknown_at: null, auto_settles_at: undefined, dispatched_at: t - 120 })
const est = (id: string, usd = 0.05): EstimatedCall => ({
  id, estimate_usd: usd, settled_at: t - 3 * 3600, correctable_until: t - 3 * 3600 + 30 * 86_400, metadata: { agent: 'a_ada', model: 'm' },
  observation: { cause: 'No answer from Anthropic before the hive stopped waiting.' }, scopes: ['hive:month'],
})
const overrun: CostOverrun = { reservation: 'r9', agent: 'a_ada', maximum: 100_000, actual: 150_000, source: 'provider-record', at: t - 60 }

const space = ScreensSpace.open()
const list = (status: ResourceStatus, data?: CostReservation[], error?: unknown) => ({ status, data, error })
function draw(res: ReturnType<typeof list>, estimates?: EstimatedCall[], overruns?: CostOverrun[], open = false) {
  const { data, facts } = heldCallsScreen(res, estimates, overruns, name, now, open)
  const plan = space.compose('usage', 'classic', facts)
  return { plan, data, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, onOpen: () => undefined, onAction: () => undefined } })) }
}
// the held calls' own orders on the Usage screen
const orders = (plan: ScreenPlan) => plan.parts.map((p) => p.order).filter((o) => o >= 200 && o < 300)

describe('the held calls on the Usage screen MeTTa composes (usage.metta)', () => {
  it('says what it is about while the held list loads, with a placeholder and no counts', () => {
    const { plan, html } = draw(list('loading'))
    expect(orders(plan)).toEqual([200, 211, 212])
    expect(html).toContain('You don’t need to do anything')
  })

  it('says why the held list could not be read, with Try again', () => {
    const { plan, html } = draw(list('error', undefined, new Error('the hive is restarting')))
    expect(orders(plan)).toEqual([200, 211, 215, 216])
    expect(html).toContain('Could not read held costs: the hive is restarting')
    expect(html).toContain('Try again')
  })

  it('says nothing is held when every answered call’s cost is known', () => {
    const { plan, html } = draw(list('ready', []))
    expect(orders(plan)).toEqual([200, 210, 211, 220])
    expect(html).toContain('0 outcome unknown · 0 in flight')
    expect(html).toContain('Nothing held')
  })

  it('lists each held call with what it holds, for whom, how and when it settles, why it was held and its id', () => {
    const { plan, html } = draw(list('ready', [held('res-1'), held('res-free', { held_usd: 0.000001 })]))
    expect(orders(plan)).toEqual([200, 210, 211, 221])
    expect(plan.parts.find((p) => p.order === 221)!.block).toBe('entries')
    expect(html).toContain('$0.012 held for Ada on openrouter/x')
    expect(html).toContain('A free model’s call for Ada')
    expect(html).toContain('settles from OpenRouter’s record of it, or at its worst case in 42 minutes if no record comes')
    expect(html).toContain('res-1')
  })

  it('keeps calls in flight behind a row that opens, and lists them once it is open', () => {
    const closed = draw(list('ready', [held('res-1'), flight('fl-1')]))
    expect(orders(closed.plan)).toEqual([200, 210, 211, 221, 230])
    expect(closed.html).toContain('Still in flight (1)')
    expect(closed.html).toContain('aria-expanded="false"')
    const open = draw(list('ready', [held('res-1'), flight('fl-1')]), undefined, undefined, true)
    expect(orders(open.plan)).toEqual([200, 210, 211, 221, 230, 231])
    expect(open.html).toContain('aria-expanded="true"')
    expect(open.html).toContain('dispatched')
  })

  it('offers one estimate its own Correct, and two or more one decision for all of them', () => {
    const one = draw(list('ready', []), [est('est-1')])
    expect(orders(one.plan)).toEqual([200, 210, 211, 220, 240, 242])
    expect(one.html).toContain('Settled at an estimate')
    expect(one.html).toContain('$0.05 estimated in total')
    expect(one.html).toContain('estimated')
    expect(one.html).toContain('Correct…')
    const two = draw(list('ready', []), [est('est-1'), est('est-2', 0.25)])
    expect(orders(two.plan)).toEqual([200, 210, 211, 220, 240, 241, 242])
    expect(two.html).toContain('Correct or release all 2…')
    expect(two.html).toContain('$0.30 estimated in total')
  })

  it(`shows ${ESTIMATES_SHOWN} estimates and says how many more Correct all takes`, () => {
    const many = Array.from({ length: ESTIMATES_SHOWN + 2 }, (_, i) => est(`est-${i}`))
    const { plan, data, html } = draw(list('ready', []), many)
    expect(orders(plan)).toEqual([200, 210, 211, 220, 240, 241, 242, 243])
    expect((data['estimates.shown'] as unknown[]).length).toBe(ESTIMATES_SHOWN)
    expect(html).toContain('and 2 more estimates, all included in Correct all')
  })

  it('names the source of a cost above its hold, newest first', () => {
    const { plan, html } = draw(list('ready', []), undefined, [overrun])
    expect(orders(plan)).toEqual([200, 210, 211, 220, 250, 251])
    expect(html).toContain('+$0.05')
    expect(html).toContain('Ada: held $0.10, cost $0.15')
    expect(html).toContain('found in OpenRouter’s record')
  })

  it('leaves an estimate out once its 30 days to correct it are over', () => {
    const old = { ...est('est-old'), correctable_until: t - 1 }
    expect(orders(draw(list('ready', []), [old]).plan)).toEqual([200, 210, 211, 220])
  })
})
