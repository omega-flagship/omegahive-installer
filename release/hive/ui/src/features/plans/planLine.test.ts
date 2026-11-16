import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { localWhen } from '../../lib/format'
import { PlanUsageLines } from './PlanUsage'
import { planLine, readPlanStatus } from './planLine'

/** Invented readings in the shape GET /api/subscriptions/status answers (the bridge's own numbers, re-checked). */
const WEEK_END = 1794589200
const when = (s: number) => localWhen(new Date(s * 1000).toISOString())
const claude = {
  provider: 'subscription-cli', vendor: 'claude', plan_type: 'max', status: 'allowed', reported: true,
  windows: [{ name: 'seven_day', used_fraction: 0.53, resets_at: WEEK_END }, { name: 'five_hour', used_fraction: 0.1, resets_at: 1794500000 }],
  overage: { status: 'rejected', in_use: false, disabled_reason: 'org_level_disabled' }, credits: null, observed_at: 1794400000,
  hive_calls_today: 37, hive_daily_cap: 500, hive_resets_at: '2026-11-10T00:00:00Z',
}
const codex = {
  provider: 'subscription-codex', vendor: 'codex', plan_type: 'promax', status: 'reported', reported: true,
  windows: [{ name: 'seven_day', used_fraction: 1, resets_at: 1794489818 }], overage: null,
  credits: { has_credits: true, unlimited: false, balance: 4873.24 }, observed_at: 1794400000, hive_calls_today: 4, hive_daily_cap: 500,
}
const unknown = { provider: 'subscription-cli', vendor: 'claude', plan_type: null, status: 'unknown', reported: false, windows: [],
  overage: null, credits: null, observed_at: null, hive_calls_today: 0, hive_daily_cap: 500 }

describe('what is left of each plan', () => {
  it('Claude: the window nearest its limit, when it resets, and the hive guard', () => {
    const [row] = readPlanStatus({ subscriptions: [claude] })
    expect(planLine(row)).toBe(`Claude plan: 53% of this week used · resets ${when(WEEK_END)} · 37 of 500 hive calls today`)
  })
  it('Codex: a used weekly limit on credits, with the balance the provider reported', () => {
    const [row] = readPlanStatus({ subscriptions: [codex] })
    expect(planLine(row)).toBe(`Codex: weekly limit used, on credits (4,873 left) · resets ${when(1794489818)} · 4 of 500 hive calls today`)
  })
  it('nothing reported: says so, and still shows the hive count', () => {
    const [row] = readPlanStatus({ subscriptions: [unknown] })
    expect(planLine(row)).toBe('Claude plan: usage not reported yet · 0 of 500 hive calls today')
    // reported but no window left (every one has reset): the same, never a stale or guessed figure
    const [empty] = readPlanStatus({ subscriptions: [{ ...claude, windows: [] }] })
    expect(planLine(empty)).toBe('Claude plan: usage not reported yet · 37 of 500 hive calls today')
  })
  it('extra usage, unlimited and spent credits are said plainly', () => {
    const [over] = readPlanStatus({ subscriptions: [{ ...claude, windows: [{ name: 'five_hour', used_fraction: 1, resets_at: null }], overage: { status: 'allowed', in_use: true, disabled_reason: null } }] })
    expect(planLine(over)).toBe('Claude plan: 5-hour limit used, on extra usage · 37 of 500 hive calls today')
    const [unl] = readPlanStatus({ subscriptions: [{ ...codex, credits: { has_credits: true, unlimited: true, balance: null } }] })
    expect(planLine(unl)).toContain('weekly limit used, on unlimited credits')
    const [none] = readPlanStatus({ subscriptions: [{ ...codex, credits: { has_credits: false, unlimited: false, balance: 0 } }] })
    expect(planLine(none)).toContain('weekly limit used, no credits left')
  })
  it('reads the answer strictly: malformed rows and fields never become numbers', () => {
    expect(readPlanStatus(null)).toEqual([])
    expect(readPlanStatus({ subscriptions: 'x' })).toEqual([])
    expect(readPlanStatus({ subscriptions: [{ provider: 'subscription-cli' }] })).toEqual([])   // no hive counts: dropped
    const [row] = readPlanStatus({ subscriptions: [{ ...claude, windows: [{ name: 'seven_day', used_fraction: '53%' }, { used_fraction: 0.2 }],
      credits: { has_credits: 'yes', balance: '4873' } }] })
    expect(row.windows).toEqual([])
    expect(row.credits).toEqual({ has_credits: null, unlimited: null, balance: null })
    // not reported: any numbers that came along anyway are dropped
    const [stale] = readPlanStatus({ subscriptions: [{ ...claude, reported: false }] })
    expect(stale.windows).toEqual([])
    expect(stale.credits).toBeNull()
  })
  it('draws one line per plan, and nothing at all for an empty list (anyone but the owner)', () => {
    const html = renderToStaticMarkup(createElement(PlanUsageLines, { rows: readPlanStatus({ subscriptions: [claude, codex] }) }))
    expect(html).toContain('>Your plans</h2>')
    expect(html.match(/<li /g)?.length).toBe(2)
    expect(html).toContain('data-plan="subscription-codex"')
    expect(renderToStaticMarkup(createElement(PlanUsageLines, { rows: [] }))).toBe('')
  })
})
