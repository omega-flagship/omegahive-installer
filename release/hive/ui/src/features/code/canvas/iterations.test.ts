import { describe, expect, it } from 'vitest'
import { SimCodeService } from '../../../api/sim/codeService'
import { iterationRequest, outcomeWords, parseIteration, parseIterationEvents } from './iterations'

// Phase 2.3, row 27: iterations as a quiet checkpoint history (OmegaCode iterations.py; relay d5f608a code.py 82–83, 70)
const WS = 'ws_it01'

describe('iteration records, in plain words', () => {
  it('builds the closed request: the command, the evidence, the limits, and what the person reports', () => {
    const r = iterationRequest({ command: ['python3', '-m', 'pytest', '-q'], evidence: ['ver_1'], attempts: 2 }, { generation: 3, tree_digest: 't'.repeat(64) }, 'op-1')
    expect(Object.keys(r).sort()).toEqual(['commands', 'expected_generation', 'expected_tree_digest', 'limits', 'observations', 'operation_id', 'verification_ids'])
    expect(r.observations).toEqual({ attempts: 2, elapsed_seconds: null, observed_cost: null, host_admitted: false, cancelled: false })
    expect(r.commands).toEqual([['python3', '-m', 'pytest', '-q']])
  })
  it('says what an outcome means without claiming more than it is', () => {
    expect(outcomeWords({ state: 'paused', reason: 'host_admission_unavailable' })).toMatch(/not admitted/i)
    expect(outcomeWords({ state: 'stopped', reason: 'attempt_limit' })).toMatch(/attempt limit/i)
    expect(outcomeWords({ state: 'odd', reason: 'x_y' })).toBe('odd: x y')
  })
  it('lists only iteration events, newest first, and refuses odd ones', () => {
    const ev = { events: [{ seq: 1, kind: 'run.started', body: {} }, { seq: 2, kind: 'iteration.observation', body: { id: 'iteration_a', created_at: 10, author: 'user:you', digest: 'd' } }, { seq: 3, kind: 'iteration.observation', body: { id: 'iteration_b', created_at: 20, author: 'user:you', digest: 'd' } }] }
    expect(parseIterationEvents(ev).map((x) => x.id)).toEqual(['iteration_b', 'iteration_a'])
    expect(() => parseIterationEvents({ events: [{ seq: 1, kind: 'iteration.observation', body: { id: 5 } }] })).toThrow()
  })
})

describe('the simulator keeps iterations as the service does (sim only)', () => {
  it('records one bound to the generation, lists it from the events, reads it back read-only, and refuses a stale or open-ended one', async () => {
    const svc = new SimCodeService({ workspace_id: WS })
    const h = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, null)) as { generation: number; tree_digest: string }
    const body = iterationRequest({ command: ['python3', '-m', 'pytest', '-q'], evidence: [], attempts: 1 }, h, 'it-1')
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/iterations`, {}, { ...body, expected_generation: h.generation + 1 })).rejects.toMatchObject({ code: 'stale_workspace' })
    await expect(svc.proxy('POST', `/v1/workspaces/${WS}/iterations`, {}, { ...body, schedule: 'every hour' })).rejects.toMatchObject({ code: 'iteration_fields' })
    const made = (await svc.proxy('POST', `/v1/workspaces/${WS}/iterations`, {}, body)) as { record: { id: string } }
    const list = parseIterationEvents(await svc.proxy('GET', '/v1/events', { workspace_id: WS, after: '0' }, null))
    expect(list.map((x) => x.id)).toEqual([made.record.id])
    const one = parseIteration(await svc.proxy('GET', `/v1/workspaces/${WS}/iterations/${made.record.id}`, {}, null))
    expect(one).toMatchObject({ id: made.record.id, commands: [['python3', '-m', 'pytest', '-q']], generation: h.generation, currency: 'current', outcome: { state: 'paused', reason: 'host_admission_unavailable' } })
  })
})
