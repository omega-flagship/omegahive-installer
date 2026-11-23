// Purpose: the Usage screen MeTTa composes (usage.metta) from what its adapters state (usageScreen.ts, heldCallsScreen.ts, limitsScreen.ts): which parts show for your spend, the held calls, the limits and the spend over time in each of their states, each limit row's parts, the words each part draws, every part reachable, and the same parts in every look. INVENTED DATA only.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import type { CostOverrun, CostReservation, EstimatedCall } from '../../api/moneyWork'
import type { MySpendSummary, Usage } from '../../api/types'
import { ALL_EXPERIENCES } from '../../experiences/registry'
import { Screen } from '../../screens/Screen'
import { ScreensSpace, type ScreenFacts, type ScreenPlan } from '../../screens/screenSpace'
import type { ResourceLike } from '../../screens/resourceFacts'
import { heldCallsScreen } from './heldCallsScreen'
import { HIVE_EDITOR, limitsScreen, ownOldDefaults, type AddingCap } from './limitsScreen'
import type { LimitsView } from './limitsView'
import { joinScreens, mySpendScreen, spendScreen, type Group, type Range, type View } from './usageScreen'

// each file opens a real MeTTa space: allow for a loaded machine (the screen cap, api/sim/simTimeouts.test.ts)
vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open()
const compose = (screen: string, facts: ScreenFacts) => space.compose(screen, 'classic', facts)
const t = 1_800_000_000
const now = t * 1000
const ready = <T,>(data: T) => ({ status: 'ready' as const, data, error: undefined })
const loading = { status: 'loading' as const, data: undefined, error: undefined }
const refused = { status: 'error' as const, data: undefined, error: new ApiError(403, 'forbidden', 'Admins only') }
const failed = (why: string) => ({ status: 'error' as const, data: undefined, error: new Error(why) })
const unsupported = { status: 'unsupported' as const, data: undefined, error: undefined }

const me: MySpendSummary = {
  principal: 'p_ada', since: '2026-11-01', hive_paid_usd: 41.5, own_keys_usd: 0, own_keys: 0, allowance_usd: 50, allowance_origin: 'rule',
  remaining_usd: 8.5, held_usd: 0.75, by_mind: [{ agent_id: 'a_nori', name: 'Nori', cost_usd: 30.25 }, { agent_id: 'a_deneb', name: 'Deneb', cost_usd: 11.25 }],
}
const row = (key: string, over: Partial<LimitsView['caps'][number]> = {}) => ({ key, scope: key.split(':').slice(0, -1).join(':'), period: 'month', limit_usd: 20, spent_usd: 4, held_usd: 0, room_usd: 16, source: 'set', ...over })
const VIEW: LimitsView = {
  hive: { cap: row('hive:month', { scope: 'hive', limit_usd: 1200, spent_usd: 100, held_usd: 5, room_usd: 1095, rule_id: 'r_hive' }), all_time: null, month_spent_usd: 100, pace_usd_per_day: 3.2 },
  people: [
    { person_id: 'p_tomas', name: 'Tomás Reyes', role: 'member', source: 'member-default', spent_usd: 12.4, pace_usd_per_day: 0.5, grants: 0,
      allowance: row('person:p_tomas:month', { limit_usd: 50, spent_usd: 12.4, room_usd: 37.6, source: 'member-default' }) },
    { person_id: 'p_ada', name: 'Ada', role: 'admin', source: 'none', spent_usd: 7.5, pace_usd_per_day: 0, grants: 1, allowance: null },
  ],
  caps: [
    row('swarm:s_forge:month', { limit_usd: 20, spent_usd: 19, held_usd: 0.5, room_usd: 0.5, rule_id: 'r_forge' }),
    row('agent:a_deneb:day', { period: 'day', limit_usd: 2, spent_usd: 0.4, room_usd: 1.6, source: 'session' }),
  ],
  old_defaults: [{ kind: 'mind', id: 'a_wisp', name: 'Wisp', change: 'Wisp: $5.00 lifetime cap -> no cap of its own', reasons: ['a round figure', 'set by the old mind form'], reset: { kind: 'mind', agent_id: 'a_wisp' } }],
}
const names = { swarms: { s_forge: { name: 'Forge', hue: 30 } }, agents: { a_deneb: { name: 'Deneb', hue: 205 }, a_nori: { name: 'Nori', hue: 150 } }, keys: [] }
const unknown = (id: string): CostReservation => ({
  id, state: 'unknown', held_usd: 0.012, scopes: ['hive:month'], metadata: { agent: 'a_nori', model: 'openrouter/x' }, observation: null,
  settles: 'record', unknown_at: t - 18 * 60, auto_settles_at: t + 42 * 60,
})
const estimate = (id: string): EstimatedCall => ({
  id, estimate_usd: 0.05, settled_at: t - 3 * 3600, correctable_until: t - 3 * 3600 + 30 * 86_400, metadata: { agent: 'a_nori', model: 'm' },
  observation: { cause: 'No answer before the hive stopped waiting.' }, scopes: ['hive:month'],
})
const overrun: CostOverrun = { reservation: 'r9', agent: 'a_nori', maximum: 100_000, actual: 150_000, source: 'provider-record', at: t - 60 }
const call = (agent: string, model: string, hoursAgo: number, cost: number, estimated?: number): Usage =>
  ({ agent_id: agent, model, prompt_tokens: 1200, completion_tokens: 300, cost_usd: cost, created_at: new Date(now - hoursAgo * 3_600_000).toISOString(), ...(estimated ? { estimated } : {}) })
const USAGE = [call('a_nori', 'claude', 30, 0.5), call('a_deneb', 'gpt', 50, 0.25, 1), call('a_nori', 'claude', 200, 0.4)]

interface State {
  mine?: ResourceLike & { data?: MySpendSummary }
  held?: ResourceLike & { data?: CostReservation[] }
  estimates?: EstimatedCall[]
  overruns?: CostOverrun[]
  limits?: ResourceLike & { data?: LimitsView }
  can?: { set: boolean; remove: boolean }
  drafts?: Record<string, string>
  adding?: AddingCap | null
  spend?: ResourceLike
  usage?: Usage[]
  range?: Range
  group?: Group
  view?: View
  sim?: boolean
}
function draw(s: State = {}) {
  const lim = s.limits ?? ready(VIEW)
  const parts = limitsScreen(lim, { view: lim.data, names, canSet: s.can?.set ?? true, canRemove: s.can?.remove ?? true, canPatchAgent: true, drafts: s.drafts ?? {}, adding: s.adding ?? null }, compose)
  const screen = joinScreens(
    mySpendScreen(s.mine ?? ready(me)),
    heldCallsScreen(s.held ?? ready([unknown('res-1')]), s.estimates, s.overruns, (_k, id) => names.agents[id as 'a_nori']?.name ?? id, now, false),
    parts,
    spendScreen(s.spend ?? { status: 'ready', error: undefined }, { usage: s.usage ?? USAGE, range: s.range ?? '7d', group: s.group ?? 'agent', view: s.view ?? 'chart', now,
      name: (k) => names.agents[k as 'a_nori']?.name ?? k, mind: (id) => (id === 'a_nori' ? { hue: 150, status: 'awake', budget_usd: 5 } : undefined), sim: s.sim ?? false }),
  )
  const plan = compose('usage', screen.facts)
  const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: screen.data, islands: {}, onOpen: () => undefined, onAction: () => undefined, onInput: () => undefined } }))
  return { plan, data: screen.data, facts: screen.facts, html, actions: parts.actions }
}
const orders = (plan: ScreenPlan, from = 0, to = 1000) => plan.parts.map((p) => p.order).filter((o) => o >= from && o < to)
/** the orders a limit row's own screen draws, by the row's id */
const rowOrders = (data: Record<string, unknown>, list: string, id: string) =>
  orders(((data[list] as { id: string; plan: ScreenPlan }[]).find((r) => r.id === id) ?? { plan: { parts: [] } as unknown as ScreenPlan }).plan)

describe('the Usage screen MeTTa composes (usage.metta)', () => {
  it('your spend: the month in words, the meter, where it went, and with no key of your own a nudge, Ask for more while it runs low', () => {
    const { plan, html } = draw()
    expect(orders(plan, 100, 200)).toEqual([100, 110, 120, 130, 131, 132])
    expect(html).toContain('$41.50 of your $50 allowance, with $0.75 held for calls not yet settled')
    expect(html).toContain('Mostly: Nori $30.25 · Deneb $11.25')
    expect(html).toContain('Your allowance is running low. Add your own AI key to work without an allowance limit')
    expect(html).toContain('aria-label="41.5 dollars spent, 0.75 dollars held, 7.75 dollars left"')
    const roomy = draw({ mine: ready({ ...me, remaining_usd: 40, own_keys: 1, own_keys_usd: 3 }) })
    expect(orders(roomy.plan, 100, 200)).toEqual([100, 110, 120])
    expect(roomy.html).toContain(' · $3.00 on your own keys')
    const uncapped = draw({ mine: ready({ ...me, allowance_usd: null, remaining_usd: null, by_mind: [] }) })
    expect(orders(uncapped.plan, 100, 200)).toEqual([100])
    expect(uncapped.html).toContain('$41.50 (no allowance cap)')
    for (const res of [loading, failed('No answer.'), unsupported]) expect(orders(draw({ mine: res }).plan, 100, 200)).toEqual([])
  })

  it('held calls: their heading, words and list as the panel had them; a member, whose read is refused, sees none of it', () => {
    const { plan, html } = draw({ estimates: [estimate('e1'), estimate('e2')], overruns: [overrun] })
    expect(orders(plan, 200, 300)).toEqual([200, 210, 211, 221, 240, 241, 242, 250, 251])
    expect(plan.parts.find((p) => p.order === 200)!.props.tour).toBe('held-calls')
    expect(html).toContain('data-tour="held-calls"')
    expect(html).toContain('1 outcome unknown · 0 in flight')
    expect(html).toContain('Correct or release all 2…')
    expect(orders(draw({ held: loading }).plan, 200, 300)).toEqual([200, 211, 212])
    const broken = draw({ held: failed('the hive is restarting') })
    expect(orders(broken.plan, 200, 300)).toEqual([200, 211, 215, 216])
    expect(broken.html).toContain('Could not read held costs: the hive is restarting')
    for (const res of [refused, unsupported]) expect(orders(draw({ held: res, estimates: [estimate('e1')], overruns: [overrun] }).plan, 200, 300)).toEqual([])
  })

  it('limits: the heading, Add a cap and the plans line in every state; loading, admins only, not here and a failure each their own part', () => {
    expect(orders(draw({ limits: loading }).plan, 300, 400)).toEqual([300, 301, 302, 305])
    const admins = draw({ limits: refused })
    expect(orders(admins.plan, 300, 400)).toEqual([300, 302, 307])
    expect(admins.html).toContain('Only admins can see and set spending limits.')
    expect(admins.plan.parts.find((p) => p.order === 307)!.props.icon).toBe('shield')
    const absent = draw({ limits: unsupported })
    expect(orders(absent.plan, 300, 400)).toEqual([300, 302, 306])
    expect(absent.html).toContain('This hive or the demo does not offer spending limits.')
    const broken = draw({ limits: failed('The hive is busy.') })
    expect(orders(broken.plan, 300, 400)).toEqual([300, 302, 308, 309])
    expect(broken.html).toContain('Could not load spending limits')
    expect(broken.html).toContain('The hive is busy.')
    expect(orders(draw({ limits: { ...ready(VIEW), error: new Error('Lost the answer.') } }).plan, 300, 400)).toContain(310)
    expect(orders(draw({ can: { set: false, remove: false } }).plan, 300, 310)).toEqual([300, 302])
  })

  it('limits, read: the hive cap, each person, the caps set and the old defaults, each limit a row of its own', () => {
    const { plan, data, html, actions } = draw()
    expect(orders(plan, 300, 400)).toEqual([300, 301, 302, 320, 321, 330, 332, 340, 342, 350, 351, 352])
    for (const words of ['The hive cap', 'People', 'Caps set', 'Old form defaults', 'Tomás Reyes', 'member default', 'Forge', 'Wisp: $5.00 lifetime cap -&gt; no cap of its own'])
      expect(html).toContain(words)
    expect(html).toContain('An admin with no allowance of their own: the hive cap holds what they spend on the hive’s money ($7.50 this month).')
    expect(html).toContain('plus a grant on an owner’s key')
    expect(html).toContain('$100 + $5.00 held / $1200 per month')
    expect(html).toContain('$100 spent and $5.00 held for calls not yet settled. $1095 of room, at $3.20 a day so far this month.')
    expect(html).toContain('aria-label="Remove the old default on Wisp"')
    expect(html).toContain('>Remove it</button>')
    // one hive cap, stated once
    expect((data['limits.hive'] as { id: string }[]).map((r) => r.id)).toEqual(['hive:month'])
    // the hive cap: its figures open its editor, nothing removes it, and its holds point at the held calls
    expect(rowOrders(data, 'limits.hive', 'hive:month')).toEqual([9, 11, 20, 21])
    // a person on the member default; an admin with none (Set an allowance); a cap someone set; a session's cap
    expect(rowOrders(data, 'limits.people', 'person:p_tomas')).toEqual([10, 11, 20])
    expect(rowOrders(data, 'limits.people', 'person:p_ada')).toEqual([10, 13, 22])
    expect(rowOrders(data, 'limits.caps', 'swarm:s_forge:monthr_forge')).toEqual([9, 11, 16, 20, 21])
    expect(rowOrders(data, 'limits.caps', 'agent:a_deneb:day')).toEqual([10, 12, 20])
    expect(html).toContain('while a session runs')
    expect(actions['swarm:s_forge:monthr_forge']).toMatchObject({ current: 20, save: { scope: 'swarm:s_forge', period: 'month', label: 'Forge' }, remove: { label: 'Forge' } })
    expect(actions['person:p_ada']).toMatchObject({ current: null, save: { scope: 'person:p_ada', period: 'month', label: 'Ada' } })
    expect(actions['agent:a_deneb:day']).toEqual({ id: 'agent:a_deneb:day', current: 2 })
    // nobody may change or remove: no editors, no removals, no Add a cap
    const readOnly = draw({ can: { set: false, remove: false } })
    expect(rowOrders(readOnly.data, 'limits.caps', 'swarm:s_forge:monthr_forge')).toEqual([9, 12, 20, 21])
    expect(rowOrders(readOnly.data, 'limits.people', 'person:p_ada')).toEqual([10, 22])
    expect(orders(readOnly.plan, 350, 360)).toEqual([350, 352])
    expect(readOnly.html).not.toContain('aria-label="Remove the old default on Wisp"')
  })

  it('limits, owners: a cap on someone else’s mind or swarm stays theirs, and Remove covers only your own old defaults (#704)', () => {
    const forge = row('swarm:s_forge:month', { limit_usd: 20, spent_usd: 19, held_usd: 0.5, room_usd: 0.5, rule_id: 'r_forge', may_change: false })
    const theirs = { kind: 'swarm' as const, id: 's_forge', name: 'Forge', change: 'Forge: $20.00 month cap -> no cap of its own', reasons: ['a round figure'],
      reset: { kind: 'rule' as const, rule_id: 'r_forge' }, may_change: false }
    const view: LimitsView = { ...VIEW, caps: [forge, VIEW.caps[1]], old_defaults: [{ ...VIEW.old_defaults[0], may_change: true }, theirs] }
    const own = { ...names, swarms: { s_forge: { name: 'Forge', hue: 30, may_cap: false } } }
    const parts = limitsScreen(ready(view), { view, names: own, canSet: true, canRemove: true, canPatchAgent: true, drafts: {}, adding: null }, compose)
    // someone else's cap: no editor, no removal, and its row says whose it is
    expect(parts.actions['swarm:s_forge:monthr_forge']).toEqual({ id: 'swarm:s_forge:monthr_forge', current: 20 })
    const forgeRow = (parts.data['limits.caps'] as { id: string; data: Record<string, unknown> }[]).find((r) => r.id === 'swarm:s_forge:monthr_forge')
    expect(forgeRow?.data['limit.badge']).toBe('its owner’s to change')
    // the old defaults: yours carries Remove, theirs says whose it is, and the one action names only yours
    expect(parts.data['limits.old']).toMatchObject([{ id: 'mind:a_wisp', action: 'Remove' }, { id: 'swarm:s_forge', action: '', reasons: 'a round figure · its owner’s to remove' }])
    expect(parts.data['limits.old.all']).toBe('Remove yours')
    expect(parts.facts.flags?.['limits.old.others']).toBe(true)
    expect(parts.facts.counts?.['limits.old.mine']).toBe(1)
    expect(ownOldDefaults(view).map((o) => o.id)).toEqual(['a_wisp'])
    const plan = compose('usage', parts.facts)
    expect(orders(plan, 350, 360)).toEqual([350, 351, 352, 353])
    // Add a cap offers only your own swarms and minds
    expect((parts.data['limits.add.scopes'] as { id: string }[]).map((s) => s.id)).not.toContain('swarm:s_forge')
    // with only someone else's old default, there is no Remove at all
    const none = { ...view, old_defaults: [theirs] }
    const only = limitsScreen(ready(none), { view: none, names: own, canSet: true, canRemove: true, canPatchAgent: true, drafts: {}, adding: null }, compose)
    expect(orders(compose('usage', only.facts), 350, 360)).toEqual([350, 352, 353])
  })

  it('limits, changing: an open editor in place of the figures, a monthly hive cap to set, and the Add a cap form', () => {
    const editing = draw({ drafts: { 'swarm:s_forge:monthr_forge': '25.00' } })
    expect(rowOrders(editing.data, 'limits.caps', 'swarm:s_forge:monthr_forge')).toEqual([9, 14, 15, 20, 21])
    const capless = { ...VIEW, hive: { ...VIEW.hive, cap: null, all_time: row('hive:all-time', { scope: 'hive', period: 'all-time', limit_usd: 100, source: 'server-settings' }) } }
    const none = draw({ limits: ready(capless) })
    expect(orders(none.plan, 320, 330)).toEqual([320, 322, 323, 326])
    expect(none.html).toContain('No hive cap. A mind with no cap of its own makes no paid calls until there is one.')
    expect(none.html).toContain('HIVE_BUDGET_USD, until the hive has a cap')
    expect(orders(draw({ limits: ready(capless), drafts: { [HIVE_EDITOR]: '' } }).plan, 320, 330)).toEqual([320, 322, 324, 325, 326])
    const adding = draw({ adding: { scope: 'every-mind', period: 'day', limit: '10' } })
    expect(orders(adding.plan, 300, 305)).toEqual([300, 302, 303, 304])
    expect(adding.data).toMatchObject({ 'limits.add.scope': 'every-mind', 'limits.add.period': 'month', 'limits.add.every-mind': true, 'limits.add.limit': '10' })
    expect(adding.html).toContain('Every mind with no cap of its own')
    expect(adding.html).toContain('Swarm · Forge')
    expect(adding.html).toContain('>Save cap</button>')
  })

  it('spend: the filters always, then loading, a failure, nothing yet, or the figures and the charts, or the table', () => {
    expect(orders(draw({ spend: { status: 'loading' } }).plan, 400, 500)).toEqual([400, 401, 402, 403])
    const broken = draw({ spend: { status: 'error', error: new Error('The gateway is down.') } })
    expect(orders(broken.plan, 400, 500)).toEqual([400, 401, 402, 406])
    expect(broken.html).toContain('Could not load usage')
    expect(broken.html).toContain('The gateway is down.')
    const quiet = draw({ usage: [], range: '24h' })
    expect(orders(quiet.plan, 400, 500)).toEqual([400, 401, 402, 410])
    expect(quiet.html).toContain('Nothing was spent in the last 24 hours. When minds think, the gateway meters every call here.')
    const charts = draw()
    expect(orders(charts.plan, 400, 500)).toEqual([400, 401, 402, 420, 440, 450, 451])
    expect(charts.html).toMatch(/data-screen-row="filters" class="[^"]*sticky top-0/)
    expect(charts.html).toContain('Spend · last 7 days')
    expect(charts.html).toContain('includes $0.25 estimated')
    expect(charts.html).toContain('Spend over time, by mind')
    expect(charts.html).toContain('Spend by mind')
    expect(charts.html).toContain('Tokens by kind')
    expect(charts.html).toContain('aria-label="Nori: $0.50, 1 requests"')
    expect(charts.html).toMatch(/data-screen-row="per-entity"[^>]*>(<div[^>]*min-w-\[min\(100%,20rem\)\] flex-1[^>]*>[^]*?){2}/)
    const table = draw({ view: 'table', group: 'model' })
    expect(orders(table.plan, 400, 500)).toEqual([400, 401, 402, 420, 430])
    expect(table.html).toContain('<caption class="sr-only">Usage by model</caption>')
    expect(table.html).toMatch(/<th scope="col" class="px-4 py-3 font-medium">Model<\/th>/)
    expect(table.html).toMatch(/>\$0\.25<span [^>]*title="\$0\.25 of this is estimated\. [^"]*">estimated<\/span>/)
    const simulated = draw({ sim: true })
    expect(orders(simulated.plan, 400, 500)).toEqual([400, 401, 402, 411, 420, 440, 450, 451])
    expect(simulated.html).toContain('Simulated · Costs here are simulated')
    expect(simulated.html).toContain('aria-label="simulated"')
  })

  it('every part of the screen and of a limit row can be reached, and every look composes the same parts', () => {
    const plans = [
      draw(), draw({ estimates: [estimate('e1'), estimate('e2')], overruns: [overrun], held: ready([unknown('r1'), { ...unknown('f1'), state: 'dispatched', settles: 'answer', unknown_at: null, auto_settles_at: undefined, dispatched_at: t - 120 }]) }),
      draw({ held: ready([]), estimates: Array.from({ length: 10 }, (_, i) => estimate(`e${i}`)) }),
      draw({ held: loading, limits: loading, spend: { status: 'loading' } }), draw({ held: failed('x'), limits: failed('x'), spend: { status: 'error', error: new Error('x') } }),
      draw({ held: { ...ready([]), error: new Error('x') }, limits: { ...ready(VIEW), error: new Error('x') } }), draw({ limits: refused }), draw({ limits: unsupported }),
      draw({ limits: ready({ ...VIEW, hive: { ...VIEW.hive, cap: null, all_time: row('hive:all-time', { scope: 'hive', source: 'server-settings' }) }, people: [], caps: [] }), drafts: { [HIVE_EDITOR]: '' }, adding: { scope: 'hive', period: 'day', limit: '1' } }),
      draw({ limits: ready({ ...VIEW, hive: { ...VIEW.hive, cap: null } }) }),
      // someone else's old default beside the viewer's own: the note that it stays theirs (#704)
      draw({ limits: ready({ ...VIEW, old_defaults: [...VIEW.old_defaults, { kind: 'swarm', id: 's_forge', name: 'Forge', change: 'Forge: $20.00 month cap -> no cap of its own', reasons: ['a round figure'], reset: { kind: 'rule', rule_id: 'r_forge' }, may_change: false }] }) }),
      draw({ usage: [] }), draw({ view: 'table', sim: true }),
      draw({ drafts: { 'person:p_ada': '', 'hive:month': '9' } }),
    ]
    const screenOrders = new Set(plans.flatMap((x) => orders(x.plan)))
    // the in-flight list needs its row open: the page states that flag itself
    const open = compose('usage', { ...heldCallsScreen(ready([{ ...unknown('f1'), state: 'dispatched' }]), undefined, undefined, (_k, id) => id, now, true).facts, values: { held: 'ready' } })
    for (const o of orders(open)) screenOrders.add(o)
    // the spend alerts (#706): each state of their read, with an alert this viewer may control and a press that failed
    for (const read of ['loading', 'error', 'empty', 'ready']) {
      const alerts = { counts: { 'alerts.controls': 1 }, flags: { 'alerts.available': true, 'alerts.action-failed': true }, values: { 'alerts.read': read } }
      for (const o of orders(compose('usage', alerts))) screenOrders.add(o)
    }
    expect(space.orders('usage').filter((o) => !screenOrders.has(o))).toEqual([])
    const rowPlans = plans.flatMap((x) => ['limits.hive', 'limits.hive.all-time', 'limits.people', 'limits.caps'].flatMap((k) => (x.data[k] as { plan: ScreenPlan }[]).map((r) => r.plan)))
    const rowSeen = new Set(rowPlans.flatMap((p) => orders(p)))
    expect(space.orders('usage-limit').filter((o) => !rowSeen.has(o))).toEqual([])
    expect(Object.values(space.guards()).flat()).toEqual([])
    // every part names its block, so each look draws the same parts with the same blocks
    const full = draw({ sim: true, estimates: [estimate('e1')], overruns: [overrun] })
    const drawn = (p: ScreenPlan) => p.parts.map((x) => [x.order, x.block])
    for (const look of ALL_EXPERIENCES.map((x) => x.id)) expect(drawn(space.compose('usage', look, full.facts))).toEqual(drawn(full.plan))
    expect(full.plan.parts.every((p) => p.block !== null && p.how.kind === 'direct')).toBe(true)
  })
})
