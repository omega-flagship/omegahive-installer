import { describe, expect, it } from 'vitest'
import type { Approval } from '../api/types'
import { approvalBound, approvalDrift, approvalSeenOf, confirmApproval, APPROVAL_SEEN_FIELDS } from './approvalDecision'
import { ARM_MS } from './decisionGate'

const ask = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap_1',
  agent_id: 'a_vega01',
  skill: 'shell',
  command: '(shell-confirm "rm -rf /srv/scratch/run-17")',
  reason: 'shell always needs a person',
  risk: 'high',
  status: 'pending',
  decided_by: null,
  created_at: '2026-10-05T09:00:00Z',
  decided_at: null,
  ...over,
})

describe('Surface O: approval answers bind to the request as inspected (Review R2/R3)', () => {
  const seen = approvalSeenOf(ask())

  it('inspects the same fields as the reviewed Canvas inspection', () => {
    expect([...APPROVAL_SEEN_FIELDS]).toEqual(['id', 'agent_id', 'skill', 'command', 'reason', 'risk', 'created_at'])
  })

  it('the same pending request is ready; any inspected field that moves refuses, by name', () => {
    expect(approvalBound(seen, ask())).toEqual({ kind: 'ready' })
    expect(approvalBound(seen, ask({ command: '(shell-confirm "rm -rf /srv")' }))).toEqual({ kind: 'changed', fields: ['command'] })
    expect(approvalBound(seen, ask({ agent_id: 'a_other' }))).toEqual({ kind: 'changed', fields: ['agent_id'] })
    expect(approvalBound(seen, ask({ risk: 'low' }))).toEqual({ kind: 'changed', fields: ['risk'] })
    expect(approvalBound(seen, ask({ reason: 'rule r9' }))).toEqual({ kind: 'changed', fields: ['reason'] })
  })

  it('two requests sharing a prefix but differing in target are different inspections', () => {
    const other = ask({ id: 'ap_2', command: '(shell-confirm "rm -rf /srv/scratch/run-17 /home")' })
    expect(approvalBound(approvalSeenOf(other), ask()).kind).toBe('changed')
  })

  it('a request that is gone or already answered elsewhere refuses and says nothing was decided', () => {
    expect(approvalBound(seen, undefined)).toEqual({ kind: 'gone' })
    expect(approvalDrift(seen, ask({ status: 'approved', decided_by: 'user:ben' }))).toMatch(/already approved by user:ben elsewhere\. Nothing was decided here/)
    expect(approvalDrift(seen, ask({ status: 'denied' }))).toMatch(/already denied elsewhere/)
    expect(approvalDrift(seen, ask({ status: 'expired' }))).toMatch(/already expired/)
    expect(approvalDrift(seen, ask())).toBeNull()
  })

  it('a command-line yes counts only as a fresh, armed activation on the unchanged request', () => {
    const shownAt = 1000
    expect(confirmApproval(seen, shownAt, ask(), { at: shownAt + ARM_MS, repeat: true })).toMatchObject({ ok: false, why: expect.stringMatching(/held key/) })
    expect(confirmApproval(seen, shownAt, ask(), { at: shownAt + 10 })).toMatchObject({ ok: false, why: expect.stringMatching(/just appeared/) })
    expect(confirmApproval(seen, shownAt, ask({ command: 'x' }), { at: shownAt + ARM_MS })).toMatchObject({ ok: false, why: expect.stringMatching(/changed while it was open \(command\)/) })
    expect(confirmApproval(seen, shownAt, ask({ status: 'approved' }), { at: shownAt + ARM_MS })).toMatchObject({ ok: false })
    expect(confirmApproval(seen, shownAt, ask(), { at: shownAt + ARM_MS })).toEqual({ ok: true })
  })
})
