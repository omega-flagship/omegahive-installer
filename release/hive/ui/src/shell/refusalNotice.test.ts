// Purpose: tests for the spending notices: a mind paused for spending, an expiry pass's estimate notice, an overrun, and
// a mind the spend-rate guard is slowing.
/**
 * A mind paused for spending says so at the top once per stretch (budget.refused, count 1), naming the limit that has no
 * room when the hive names it; the mind's page then names the same limit and offers to raise the mind's own budget only
 * when that budget is what refused it. Invented minds and teams.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Agent, BudgetRefusal } from '../api/types'
import { SpendingPause, SpendingSlowed } from '../features/dot/SpendingPause'
import { bindingElsewhere, budgetMeter } from '../features/dot/callLimits'
import { estimatedWords, overrunWords, refusalNotice } from './liveNotices'

const at = '2026-11-10T12:00:00Z'
const agents = { a_rev: { id: 'a_rev', name: 'Reviewer' } as Agent }
const swarms = { s_code: { id: 's_code', name: 'Create · Code' } } as never
const team: BudgetRefusal = { code: 'reservation_refused', count: 1, at, limit: { scope: 'swarm:s_code', period: 'day', limit_usd: 2, spent_usd: 1.98, held_usd: 0.04 } }
const ownCap: BudgetRefusal = { code: 'budget_exhausted', count: 1, at, limit: { scope: 'agent:a_rev', period: 'total', limit_usd: 2, spent_usd: 2 } }

describe('a mind paused for spending', () => {
  it('an expiry pass is one notice that says the estimate is an upper bound, and an overrun names only the overrun', () => {
    const pass = { type: 'budget.estimated' as const, at: '2026-11-12T03:00:00Z', count: 3, total_usd: 0.15, payers: [{ payer: 'hive', count: 3, total_usd: 0.15 }], reservations: ['r1', 'r2', 'r3'] }
    expect(estimatedWords(pass)).toEqual({
      title: '3 calls were estimated at $0.15',
      body: 'Their cost never came back, so the hive settled them at the worst case: an upper bound that’s usually lower, which you can correct in Usage within 30 days.',
    })
    // a free model's call settles at $0, its price, and is named, since nothing else says that model's calls end unknown
    expect(estimatedWords({ ...pass, free: [{ model: 'openrouter/x:free', count: 1 }] }).body).toBe(
      'Their cost never came back, so the hive settled them at the worst case: an upper bound that’s usually lower, which you can correct in Usage within 30 days. 1 call to a free model (openrouter/x:free) had an unknown outcome and was settled at $0, its price.',
    )
    expect(estimatedWords({ ...pass, count: 1, total_usd: 0, free: [{ model: 'openrouter/x:free', count: 1 }] }).body).toBe('1 call to a free model (openrouter/x:free) had an unknown outcome and was settled at $0, its price.')
    expect(estimatedWords({ ...pass, count: 1, total_usd: 0.05, reservations: ['r1'] }).title).toBe('1 call was estimated at $0.05')
    expect(overrunWords({ type: 'budget.overrun', at: pass.at, reservation: 'r9', agent: null, held_usd: 0.05, actual_usd: 0.07, source: 'correct' }, (id) => id).title).toBe('A call spent more than was held')
  })
  it('is said at the top on the first refusal of a stretch, naming the limit, and not again on the 20th', () => {
    const state = { agents, swarms, keys: [], refusals: { a_rev: team } } as never
    const first = refusalNotice({ type: 'budget.refused', at, agent_id: 'a_rev', code: 'reservation_refused', count: 1 }, state)
    expect(first).toMatchObject({ tone: 'error', title: 'Reviewer is paused for spending', body: 'No room under swarm Create · Code today: $1.98 spent and $0.04 held for calls not yet settled, of $2.00.' })
    expect(refusalNotice({ type: 'budget.refused', at, agent_id: 'a_rev', code: 'reservation_refused', count: 20 }, state)).toBeNull()
    // an older hive names no limit: the notice still says the mind is paused
    const plain = refusalNotice({ type: 'budget.refused', at, agent_id: 'a_rev', code: 'spend_limit', count: 1 }, { agents, swarms, keys: [], refusals: {} } as never)
    expect(plain?.body).toBe('A spending limit has no room for its next call.')
  })

  it('its page names the same limit, and offers to raise its budget only when its own budget refused it', () => {
    // a static render reads the store's first state, so the team is named by its id here; the words are the notice's
    const page = (r: BudgetRefusal) => renderToStaticMarkup(createElement(SpendingPause, { agent: agents.a_rev, refusal: r, onFixBudget: () => undefined }))
    const byTeam = page(team)
    expect(byTeam).toContain('No room under swarm s_code today: $1.98 spent and $0.04 held for calls not yet settled, of $2.00.')
    expect(byTeam).not.toContain('Raise its budget')
    expect(page(ownCap)).toContain('Raise its budget')
  })

  it('names a limit this viewer may not see only as a spending limit it can’t change, with no numbers', () => {
    // Jon on #52: another person's allowance or key spending reaches only that person and the admins
    const unseen: BudgetRefusal = { code: 'spend_limit', count: 1, at, hidden: true }
    const state = { agents, swarms, keys: [], refusals: { a_rev: unseen } } as never
    expect(refusalNotice({ type: 'budget.refused', at, agent_id: 'a_rev', code: 'spend_limit', count: 1, hidden: true }, state)?.body)
      .toBe('No room under a spending limit it can’t change.')
    const page = renderToStaticMarkup(createElement(SpendingPause, { agent: agents.a_rev, refusal: unseen, onFixBudget: () => undefined }))
    expect(page).toContain('No room under a spending limit it can’t change.')
    expect(page).not.toMatch(/\$\d/)
    expect(page).not.toContain('Raise its budget')
    // the mind's page: an unseen limit with the least room is the one that stops it, whatever else it is
    const hidden = { hidden: true, label: null, scope: null, period: null, limit_usd: null, spent_usd: null, held_usd: null, room_usd: null } as const
    const own = { label: 'agent:a_rev:total', scope: 'agent:a_rev', period: 'total', limit_usd: 2, spent_usd: 0, held_usd: 0, room_usd: 2 }
    expect(bindingElsewhere('a_rev', { free: false, reason: null, limits: [hidden, own] })).toBe(hidden)
    expect(bindingElsewhere('a_rev', { free: false, reason: null, limits: [own, hidden] })).toBeNull()
  })

  it('the mind’s Budget shows the cap admission enforces, holds counted, and the stored budget only when the hive names none', () => {
    const agent = { id: 'a_rev', budget_usd: 2, spent_usd: 0.5 }
    const row = { label: 'agent:a_rev:total', scope: 'agent:a_rev', period: 'total', limit_usd: 1.5, spent_usd: 0.5, held_usd: 0.05, room_usd: 0.95 }
    expect(budgetMeter(agent, { free: false, reason: null, limits: [row] })).toEqual({ cap: 1.5, used: 0.55 })
    expect(budgetMeter(agent, null)).toEqual({ cap: 2, used: 0.5 })
  })
})

describe('a mind the spend-rate guard is slowing', () => {
  it('its page says it is slowed, when its next call fits and that a higher monthly limit speeds it up', () => {
    const now = Date.now()
    const page = (minutes: number) => renderToStaticMarkup(createElement(SpendingSlowed, {
      slowed: { until: new Date(now + minutes * 60000).toISOString(), at },
    }))
    const later = page(21)
    expect(later).toContain('Slowed: spending faster than this month allows')
    expect(later).toMatch(/Its next model call fits again at [^<]+, in about 21 minutes\./)
    expect(later).toContain('A higher monthly limit on Usage and limits speeds it up.')
    expect(later).toContain('Open Usage and limits')
    expect(page(1)).toMatch(/in about 1 minute\./)
    expect(page(-1)).toContain('Its next model call fits again now.')
  })
})
