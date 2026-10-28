import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { accepts, ARM_MS, bindTo, boundNote, decisionFailure, decisionShown, NOTHING_CHANGED, OUTCOME_UNKNOWN, outcomeUnknown } from './decisionGate'
import { UnsupportedError } from './useResource'

describe('decision gate', () => {
  it('never accepts a held key, and nothing inside the arming window', () => {
    expect(accepts({ repeat: true, at: 10_000 }, 0)).toBe(false)
    expect(accepts({ at: ARM_MS - 1 }, 0)).toBe(false)
    expect(accepts({ at: ARM_MS }, 0)).toBe(true)
  })

  it('binds to the snapshot: gone, changed, closed or ready', () => {
    const seen = { id: 'r1', held: 0.4, scopes: ['a', 'b'], state: 'unknown' }
    const fields = ['id', 'held', 'scopes'] as const
    expect(bindTo(seen, undefined, fields).kind).toBe('gone')
    expect(bindTo(seen, { ...seen, scopes: ['a', 'b'] }, fields).kind).toBe('ready')
    expect(bindTo(seen, { ...seen, held: 0.5 }, fields)).toEqual({ kind: 'changed', fields: ['held'] })
    const closed = bindTo(seen, { ...seen, state: 'settled' }, fields, (l) => (l.state !== 'unknown' ? 'Already settled.' : null))
    expect(closed).toEqual({ kind: 'closed', why: 'Already settled.' })
    expect(boundNote(closed)).toContain('Nothing was decided here.')
    expect(boundNote({ kind: 'ready' })).toBeNull()
  })
})

describe('Review B1 (commons f0818d8): only a known refusal says "Nothing changed"', () => {
  it('decisionShown: refusal words get the assurance; unsettled and plain errors never do', () => {
    expect(decisionShown(true)).toEqual({ kind: 'close' })
    expect(decisionShown('The hive refused it.')).toEqual({ kind: 'error', text: `The hive refused it. ${NOTHING_CHANGED}` })
    expect(decisionShown({ failed: 'the client broke' })).toEqual({ kind: 'error', text: 'the client broke' })
    expect(decisionShown({ unsettled: 'not known' })).toEqual({ kind: 'unsettled', unsettled: { unsettled: 'not known' } })
  })

  it('decisionFailure: a lost or late answer, a 5xx, or still in progress is unsettled; a 4xx is a refusal; anything else is plain', async () => {
    const recheck = async () => true as const
    for (const e of [
      new ApiError(0, 'network', 'Failed to fetch'),
      new ApiError(0, 'answer_unreadable', 'The hive answered but its answer could not be read (SyntaxError).'),
      new ApiError(502, 'bad_gateway', 'Bad gateway'),
      new ApiError(504, 'gateway_timeout', 'Gateway timeout'),
      new TypeError('Failed to fetch'),
      new DOMException('timed out', 'TimeoutError'),
    ]) {
      expect(outcomeUnknown(e)).toBe(true)
      expect(decisionFailure(e)).toEqual({ unsettled: OUTCOME_UNKNOWN })
      expect(decisionFailure(e, recheck)).toEqual({ unsettled: OUTCOME_UNKNOWN, recheck })
    }
    const failed500 = decisionFailure(new ApiError(500, 'internal', 'boom after the write'))
    expect(failed500).toEqual({ unsettled: expect.stringContaining('may have acted first') })
    expect(decisionFailure(new ApiError(409, 'in_progress', 'still running'))).toEqual({ unsettled: expect.stringContaining('not known') })
    expect(decisionFailure(new ApiError(403, 'forbidden', 'Not yours to change.'))).toBe('Not yours to change.')
    expect(decisionFailure(new UnsupportedError('Archiving'))).toBe('Archiving is not available here.')
    expect(decisionFailure(new Error('undefined is not a function'))).toEqual({ failed: 'undefined is not a function' })
    for (const r of [failed500, decisionFailure(new ApiError(0, 'network', 'x')), decisionFailure(new Error('y'))])
      expect(JSON.stringify(decisionShown(r))).not.toContain(NOTHING_CHANGED)
  })
})
