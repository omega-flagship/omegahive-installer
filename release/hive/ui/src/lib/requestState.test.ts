import { describe, expect, it } from 'vitest'
import { REQUEST_STATE } from '../api/sim/requests'
import { isTerminalRequest, REQUEST_STATE_LABEL, REQUEST_STATE_MEANING, REQUEST_STATE_TONE, REQUEST_STATES, REQUEST_TERMINAL, requestStateLabel } from './requestState'

// The host's request states (hive/core/collab.py at ad9e82c: REQUEST_STATE, line 27, and request_view, line 271).
const HOST_REQUEST_STATE = { open: 'queued', claimed: 'working', waiting: 'needs-approval', submitted: 'in-review', done: 'completed', failed: 'failed', cancelled: 'cancelled' }
const HOST_STATES = new Set([...Object.values(HOST_REQUEST_STATE), 'accepted', 'cancelled'])

describe('request states: the host contract, in-review included', () => {
  it('the UI knows exactly the states the host reports', () => {
    expect(new Set(REQUEST_STATES)).toEqual(HOST_STATES)
    expect(REQUEST_STATES).toHaveLength(HOST_STATES.size)
  })
  it('the sim maps goal statuses to request states exactly as the host', () => {
    expect(REQUEST_STATE).toEqual(HOST_REQUEST_STATE)
  })
  it('every state has its own label, meaning and tone', () => {
    for (const s of REQUEST_STATES) {
      expect(REQUEST_STATE_LABEL[s], s).toBeTruthy()
      expect(REQUEST_STATE_MEANING[s], s).toBeTruthy()
      expect(REQUEST_STATE_TONE[s], s).toBeTruthy()
    }
    expect(new Set(Object.values(REQUEST_STATE_LABEL)).size).toBe(REQUEST_STATES.length)
  })
  it('submitted work is in review: not completed, not terminal, cancellable', () => {
    expect(REQUEST_STATE_LABEL['in-review']).toBe('In review')
    expect(REQUEST_STATE_TONE['in-review']).not.toBe(REQUEST_STATE_TONE.completed)
    expect(REQUEST_TERMINAL.has('in-review')).toBe(false)
    expect(isTerminalRequest({ state: 'in-review', cancelled_at: null })).toBe(false)
    expect(isTerminalRequest({ state: 'completed', cancelled_at: null })).toBe(true)
    expect(isTerminalRequest({ state: 'working', cancelled_at: '2026-10-05T10:00:00Z' })).toBe(true)
  })
  it('an unknown state is said to be unknown, never mapped onto a known one', () => {
    expect(requestStateLabel('reviewed')).toBe('Unknown state (reviewed)')
    expect(requestStateLabel('in-review')).toBe('In review')
  })
})
