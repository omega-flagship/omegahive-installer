import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { finalAsResult } from '../features/programs/HostConfirm'
import { actErrorResult } from '../forms/actResult'
import { APPROVAL_REFUSAL_UNCONFIRMED, APPROVAL_UNCONFIRMED } from './approvalDecision'
import { decisionShown, NOTHING_CHANGED } from './decisionGate'
import { CLOSED_RUNNING, DECLINED_UNKNOWN, IDENTITY_CHANGED, IDENTITY_CHANGED_SENT } from './hostConfirm'

/**
 * Review B1 (commons f0818d8), every other DecisionDialog consumer: an error alone never says "Nothing changed; you can
 * try again." Function-level where the decision is a function (the dialog's thrown run, the host confirm's result, the
 * growth lab, the approval answer); source-level for the pages whose run is inline JSX: each catch inside a
 * DecisionDialog run returns lib/decisionGate.decisionFailure(e) (lost answer: unsettled; 4xx: the refusal; else
 * plain), never actionFailure(e, ...).body (which read every error, a lost answer included, as a refusal).
 */
let readFileSync: (p: URL, e: string) => string
beforeAll(async () => {
  const fsName = 'node:fs'   // not in the app's types: loaded at test time only
  readFileSync = ((await import(/* @vite-ignore */ fsName)) as { readFileSync: typeof readFileSync }).readFileSync
})
const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const shownText = (r: Parameters<typeof decisionShown>[0]) => JSON.stringify(decisionShown(r))

describe('the dialog itself: a run that throws', () => {
  it('is read by decisionFailure (a lost answer stays unsettled), never mapped to a refusal string', () => {
    const s = src('../ui/DecisionDialog.tsx')
    expect(s).toContain('a.run().catch((err: unknown) => decisionFailure(err))')
    expect(s).not.toMatch(/a\.run\(\)\.catch\(failed\)/)
  })
})

describe.each([
  ['features/swarm/SwarmServices.tsx', 1],
  ['features/swarm/ArchivedSwarms.tsx', 1],
  ['features/swarm/SwarmSettings.tsx', 1],
  ['features/minds/MemorySharing.tsx', 1],
  ['features/minds/MoveMind.tsx', 4],
  ['features/goals/Review.tsx', 1],
  ['features/updates/Holds.tsx', 2],
  ['features/usage/SettleCalls.tsx', 1],
  ['features/programs/AppActivity.tsx', 3],
  ['features/assets/AssetsPage.tsx', 1],
])('%s', (file, n) => {
  it(`its ${n} DecisionDialog catch(es) return decisionFailure(e), never actionFailure(...).body`, () => {
    const s = src(`../${file}`)
    expect(s.match(/return decisionFailure\(e\)/g)?.length).toBe(n)
    expect(s).not.toMatch(/return actionFailure\([^)]*\)\.body/)
  })
})

describe('the host confirm (HostConfirm.finalAsResult): unknown whenever the act may have had its effect', () => {
  it('a closed re-ask for an unknown earlier attempt, or a closed still-running check: unknown', () => {
    expect(finalAsResult({ kind: 'declined', uncertain: true })).toEqual({ status: 'refused', message: DECLINED_UNKNOWN, unknown: true })
    expect(finalAsResult({ kind: 'declined', uncertain: true, running: true })).toEqual({ status: 'refused', message: CLOSED_RUNNING, unknown: true })
    expect(finalAsResult({ kind: 'declined', uncertain: false })).toEqual({ status: 'refused', message: 'You cancelled. Nothing was sent.' })
  })
  it('an identity change after sending is unknown; before sending it is a known no', () => {
    expect(finalAsResult({ kind: 'stale', sent: true, message: IDENTITY_CHANGED_SENT })).toMatchObject({ unknown: true })
    expect(finalAsResult({ kind: 'stale', sent: false, message: IDENTITY_CHANGED })).not.toHaveProperty('unknown')
  })
  it('a failure after sending is unknown unless the hive refused it (4xx); a failure before sending is plain', () => {
    expect(finalAsResult({ kind: 'failed', error: new Error('client broke'), sent: true })).toMatchObject({ status: 'error', unknown: true })
    expect(finalAsResult({ kind: 'failed', error: new ApiError(422, 'bad_params', 'no'), sent: true })).not.toHaveProperty('unknown')
    expect(finalAsResult({ kind: 'failed', error: new ApiError(0, 'network', 'mint lost'), sent: false })).not.toHaveProperty('unknown')
  })
  it('the host act that threw (ProgramForm): unknown when it may have been delivered', () => {
    expect(actErrorResult(new ApiError(0, 'answer_unreadable', 'unreadable'))).toEqual({ status: 'error', message: 'unreadable', unknown: true })
    expect(actErrorResult(new ApiError(500, 'program_error', 'raised'))).toMatchObject({ unknown: true })
    expect(actErrorResult(new ApiError(400, 'bad', 'no'))).toEqual({ status: 'error', message: 'no' })
  })
})

describe('the approval answer (experiences/ApprovalDecision)', () => {
  it('a store answer of "not taken" (a lost answer among the reasons) is a plain error, never "Nothing changed"', () => {
    const s = src('../experiences/ApprovalDecision.tsx')
    expect(s).toContain("return { failed: d === 'deny' || d === 'never' ? APPROVAL_REFUSAL_UNCONFIRMED : APPROVAL_UNCONFIRMED }")
    for (const t of [APPROVAL_UNCONFIRMED, APPROVAL_REFUSAL_UNCONFIRMED]) expect(shownText({ failed: t })).not.toContain(NOTHING_CHANGED)
  })
})
