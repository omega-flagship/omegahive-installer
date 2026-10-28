import { describe, expect, it } from 'vitest'
import { mayReview, reviewBlocked, reviewedLine, reviewerWords } from './goalReview'

const admin = { kind: 'sso' as const, role: 'admin' as const, principal: 'user:p_ada' }
const member = { kind: 'sso' as const, role: 'member' as const, principal: 'user:p_bo' }
const operator = { kind: 'password' as const, role: 'admin' as const, principal: 'user:operator' }

describe('goal review state (R17)', () => {
  it('names the reviewer; absent review_by reads "a person" exactly as before', () => {
    expect(reviewerWords(undefined)).toBe('a person')
    expect(reviewerWords('person')).toBe('a person')
    expect(reviewerWords('agent:a_vega01', (id) => (id === 'a_vega01' ? 'Vega' : undefined))).toBe('Vega (a mind)')
    expect(reviewerWords('mandate:qa')).toBe('a mind holding the qa mandate')
    expect(reviewerWords('requester')).toMatch(/requesting swarm/)
  })
  it('never guesses who may review when review_by is absent', () => {
    expect(mayReview({}, admin).may).toBeNull()
    expect(mayReview({}, member).may).toBeNull()
    expect(mayReview({}, undefined).may).toBeNull()
  })
  it('follows the hive: password never, admin person any reviewed goal, member only "person"', () => {
    expect(mayReview({ review_by: 'person' }, operator).may).toBe(false)
    expect(mayReview({}, operator).may).toBe(false)
    expect(mayReview({ review_by: 'agent:a_x' }, admin).may).toBe(true)
    expect(mayReview({ review_by: 'person' }, member).may).toBe(true)
    expect(mayReview({ review_by: 'agent:a_x' }, member)).toEqual({ may: false, why: 'Reviewed by a_x (a mind), not by you.' })
    expect(mayReview({ review_by: 'none' }, admin).may).toBe(false)
  })
  it('reviewed line comes from fields on the row; a return needs notes', () => {
    expect(reviewedLine({ reviewed_by: 'user:p_ada', reviewed_at: 'x' })).toBe('Reviewed by user:p_ada')
    expect(reviewedLine({})).toBeNull()
    expect(reviewBlocked('return', ' ')).toMatch(/change/)
    expect(reviewBlocked('accept', '')).toBeNull()
  })
})
