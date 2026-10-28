import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { endsHiveSession, parseErrorBody } from './relayedError'
import { describeFailure } from '../features/code/suggestions/model'

const toError = (status: number, body: unknown) => {
  const p = parseErrorBody(status, '', body)
  return { parsed: p, error: new ApiError(status, p.code, p.message, p.source ? { source: p.source, upstreamStatus: p.upstreamStatus } : undefined) }
}

describe('relayed OmegaCode errors: the next8 envelope (live)', () => {
  it('reads source/upstream_status; a service 401 relayed as 403 maps to revoked, never a sign-out', () => {
    const body = { error: { code: 'invalid_capability', message: 'capability is expired or revoked', source: 'omegacode', upstream_status: 401 } }
    const { parsed, error } = toError(403, body)
    expect(parsed).toEqual({ code: 'invalid_capability', message: 'capability is expired or revoked', source: 'omegacode', upstreamStatus: 401 })
    expect(endsHiveSession(403)).toBe(false)
    expect(describeFailure(error).kind).toBe('revoked')
  })

  it('maps preserved service codes and upstream statuses to the panel refusal states', () => {
    const env = (status: number, code: string, upstream: number) => toError(status, { error: { code, message: 'm', source: 'omegacode', upstream_status: upstream, details: { x: 1 } } }).error
    expect(describeFailure(env(409, 'suggestion_stale', 409)).kind).toBe('stale')
    expect(describeFailure(env(409, 'suggestion_decided', 409)).kind).toBe('decided')
    expect(describeFailure(env(409, 'operation_conflict', 409)).kind).toBe('conflict')
    expect(describeFailure(env(429, 'suggestion_budget', 429)).kind).toBe('limit')
    expect(describeFailure(env(502, 'service_error', 503)).kind).toBe('unknown')
    expect(describeFailure(env(403, 'some_new_code', 401)).kind).toBe('revoked')
    expect(describeFailure(env(400, 'suggestion_decision', 400)).kind).toBe('refused')
  })

  it('a malformed upstream_status is dropped, the source kept', () => {
    expect(parseErrorBody(502, '', { error: { code: 'service_error', message: 'm', source: 'omegacode', upstream_status: '503' } })).toEqual({ code: 'service_error', message: 'm', source: 'omegacode' })
  })
})

describe('the 401 special case is gone (next8 live, 2026-10-05)', () => {
  it('any 401 ends the hive session, on the proxy path too: the hive relays a service 401 as 403', () => {
    expect(endsHiveSession(401)).toBe(true)
    expect(endsHiveSession(403)).toBe(false)
    expect(endsHiveSession(404)).toBe(false)
  })

  it('a bare raw-relay body keeps its code but is never taken for a relayed service error', () => {
    const p = parseErrorBody(401, '', { error: 'invalid_capability', message: 'capability is expired or revoked' })
    expect(p).toEqual({ code: 'invalid_capability', message: 'capability is expired or revoked' })
    expect(p.source).toBeUndefined()
  })

  it('hive errors keep their shape', () => {
    expect(parseErrorBody(401, '', { error: { code: 'unauthorized', message: 'sign in' } })).toEqual({ code: 'unauthorized', message: 'sign in' })
    expect(parseErrorBody(404, '', { error: { code: 'not_relayed', message: 'x' } })).toEqual({ code: 'not_relayed', message: 'x' })
    expect(parseErrorBody(500, 'Server Error', null)).toEqual({ code: 'http_500', message: 'Server Error' })
  })
})
