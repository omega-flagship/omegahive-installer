// Purpose: pins that the Lab offers starting and cancelling runs only to people the hive lets run them (may_run).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LabRunSummary, LabSuite } from '../../api/types'
import { mayStart, runRefusal } from './labUtil'
import { RunButton } from './parts'

/** Review #299: starting and cancelling a Lab run is an admin's; GET /api/lab/suites says may_run for the person. */
const suite = (p: Partial<LabSuite> = {}): LabSuite => ({
  id: 'bench-drift', kind: 'bench', title: 'Drift', description: 'Invented drift cases', estimate_s: 30, needs: [], missing: [],
  runnable: true, last_run: null, ...p,
})
const running: LabRunSummary = {
  id: 'run_1', suite: 'bench-drift', status: 'running', started_at: '2026-11-13T00:00:00Z', finished_at: null, duration_ms: null,
  passed: 0, failed: 0, skipped: 0, errors: 0, commit_sha: null,
}
const button = (s: LabSuite) => renderToStaticMarkup(createElement(RunButton, { suite: s }))

describe('who may start a Lab suite', () => {
  it('needs both the hive’s yes and the suite’s requirements; a hive that does not say leaves it to the route', () => {
    expect([true, false, undefined].flatMap((may_run) => [true, false].map((runnable) => mayStart(suite({ may_run, runnable })))))
      .toEqual([true, false, false, false, true, false])
    expect(runRefusal(suite({ may_run: false }))).toBe('Only a hive admin runs suites')
    expect([runRefusal(suite({ may_run: true })), runRefusal(suite()), runRefusal(undefined)]).toEqual([null, null, null])
  })

  it('a member sees Run disabled with the reason, and no Cancel while a run goes on', () => {
    const member = button(suite({ may_run: false }))
    expect(member).toMatch(/<button[^>]*disabled=""/)
    expect(member).toContain('title="Only a hive admin runs suites"')
    expect(button(suite({ may_run: false, last_run: running }))).toBe('')
  })

  it('an admin runs a suite whose requirements are met, and cancels a run', () => {
    const admin = button(suite({ may_run: true }))
    expect(admin).not.toContain('disabled=""')
    expect(admin).toContain('title="Run Drift"')
    expect(button(suite({ may_run: true, last_run: running }))).toContain('aria-label="Cancel Drift"')
    expect(button(suite({ may_run: true, runnable: false, missing: ['petta'] }))).toMatch(/<button[^>]*disabled=""/)
  })
})
