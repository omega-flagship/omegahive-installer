// Purpose: tests of the words for a Code request a spending limit stopped: the row the hive names, in the person's words, and the plain words when no row comes with it.
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../api/client'
import { intentWords, requestBoundOf } from './vibeRoute'

const refusal = (limit: Record<string, unknown> | null) =>
  new ApiError(402, 'spend_limit', 'the instruction asks for $0.50', limit ? { envelope: { code: 'spend_limit', limit, ceiling_usd: limit.room_usd } } : undefined)
const row = (over: Record<string, unknown> = {}) => ({ label: 'person:u_1:month', scope: 'person:u_1', period: 'month', limit_usd: 50, spent_usd: 49.8, held_usd: 0.4, room_usd: 0, kind: 'member_allowance', ...over })

describe('a request a spending limit stopped', () => {
  it('says which limit and what is left under it', () => {
    expect(intentWords(refusal(row()))).toBe('Nothing is left under your $50 monthly allowance ($49.80 spent and $0.40 held), so nothing was sent.')
    expect(intentWords(refusal(row({ limit_usd: 2, spent_usd: 1, held_usd: 0.4, room_usd: 0.6 })))).toBe(
      'Only $0.60 is left under your $2.00 monthly allowance ($1.00 spent and $0.40 held), less than this request’s budget, so nothing was sent.')
    expect(intentWords(refusal(row({ scope: 'hive', kind: 'hive_cap', limit_usd: 50, spent_usd: 50, held_usd: 0 })))).toBe(
      'Nothing is left under the hive’s $50 monthly cap ($50 spent and $0 held), so nothing was sent.')
    expect(intentWords(refusal(row({ scope: 'swarm:s_1', period: 'day', kind: 'swarm_cap', limit_usd: 0.6, spent_usd: 0, held_usd: 0, room_usd: 0.6 })))).toContain('this swarm’s $0.60 daily cap')
    expect(intentWords(refusal(row({ scope: 'agent:a_1', period: 'total', kind: 'mind_cap', limit_usd: 5, spent_usd: 5, held_usd: 0 })))).toContain('its controller’s own $5.00 all-time cap')
  })

  it('keeps the plain words when the refusal names no limit it can read', () => {
    expect(requestBoundOf(refusal(null))).toBeNull()
    expect(requestBoundOf(refusal(row({ kind: 'mystery' })))).toBeNull()
    expect(requestBoundOf(refusal(row({ room_usd: -1 })))).toBeNull()
    expect(intentWords(refusal(null))).toBe('The request is over a spending limit, so nothing was sent.')
    expect(requestBoundOf(new ApiError(403, 'not_offered', 'x'))).toBeNull()
  })
})
