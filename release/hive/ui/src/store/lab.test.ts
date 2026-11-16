import { describe, expect, it } from 'vitest'
import type { HiveEvent, LabCase, LabHistory, LabRunSummary, LabSuite } from '../api/types'
import { emptyData, foldRunIntoHistory, LAB_LOG_CAP, labHealth, reduce, type HiveData } from './reducer'

const at = '2026-10-03T12:00:00.000Z'
const summary = (p: Partial<LabRunSummary> = {}): LabRunSummary => ({
  id: 'run_1', suite: 'bench-drift', status: 'running', started_at: at, finished_at: null, duration_ms: null,
  passed: 0, failed: 0, skipped: 0, errors: 0, commit_sha: 'abc1234', ...p,
})
const kase = (p: Partial<LabCase> = {}): LabCase => ({
  run_id: 'run_1', id: 'bench-drift::echo_storm', name: 'Echo storm', group: 'beliefs', dimension: 'drift', status: 'passed',
  duration_ms: 685, message: null, notes: null,
  metrics: [{ name: 'confidence inflation', value: 0, unit: '', better: 'lower', target: 1e-9, ok: true }],
  series: [], ...p,
})
const suite = (p: Partial<LabSuite> = {}): LabSuite => ({
  id: 'bench-drift', kind: 'bench', title: 'Drift scenarios', description: '', estimate_s: 20, needs: [], missing: [],
  runnable: true, last_run: null, ...p,
})
const run = (events: HiveEvent[], s: HiveData = emptyData()) => events.reduce(reduce, s)

describe('reduce · Lab', () => {
  it('tracks a run and makes it the suite’s last run', () => {
    const s0 = { ...emptyData(), labSuites: [suite(), suite({ id: 'tests-ui', kind: 'tests' })] }
    const s = run([{ type: 'lab.run', at, run: summary() }], s0)
    expect(s.labRuns.run_1.status).toBe('running')
    expect(s.labSuites![0].last_run?.id).toBe('run_1')
    expect(s.labSuites![1].last_run).toBeNull()
    expect(s0.labRuns).toEqual({}) // pure
  })

  it('does not let an older run replace a newer last run', () => {
    const newer = summary({ id: 'run_2', started_at: '2026-10-03T13:00:00.000Z' })
    const s = run([{ type: 'lab.run', at, run: summary({ status: 'passed' }) }], { ...emptyData(), labSuites: [suite({ last_run: newer })] })
    expect(s.labSuites![0].last_run?.id).toBe('run_2')
  })

  it('streams cases in order and replaces a repeated case by id', () => {
    const s = run([
      { type: 'lab.case', at, case: kase() },
      { type: 'lab.case', at, case: kase({ id: 'bench-drift::retry_storm', name: 'Retry storm' }) },
      { type: 'lab.case', at, case: kase({ status: 'failed' }) },
    ])
    expect(s.labCases.run_1.map((c) => c.name)).toEqual(['Echo storm', 'Retry storm'])
    expect(s.labCases.run_1[0].status).toBe('failed')
  })

  it('appends live log lines per run, capped', () => {
    const events: HiveEvent[] = Array.from({ length: LAB_LOG_CAP + 5 }, (_, i) => ({ type: 'lab.log', at, run_id: 'run_1', text: `line ${i}` }))
    const s = run(events)
    expect(s.labLogs.run_1).toHaveLength(LAB_LOG_CAP)
    expect(s.labLogs.run_1.at(-1)).toBe(`line ${LAB_LOG_CAP + 4}`)
  })

  it('folds a finished run and its metric values into a loaded history', () => {
    const history: LabHistory = {
      suite: 'bench-drift',
      runs: [summary({ id: 'run_0', status: 'passed', started_at: '2026-10-02T12:00:00.000Z' })],
      metrics: [{ case_id: 'bench-drift::echo_storm', case: 'Echo storm', metric: 'confidence inflation', unit: '', better: 'lower', target: 1e-9, points: [{ run_id: 'run_0', at: '2026-10-02T12:00:00.000Z', value: 0, ok: true }] }],
    }
    const s0 = { ...emptyData(), labHistory: { 'bench-drift': history } }
    const s = run([
      { type: 'lab.run', at, run: summary() },
      { type: 'lab.case', at, case: kase({ metrics: [...kase().metrics, { name: 'echoes absorbed', value: 45, unit: '', better: 'equal', target: 45, ok: true }] }) },
    ], s0)
    // still running: history untouched
    expect(s.labHistory['bench-drift'].runs).toHaveLength(1)
    const done = run([{ type: 'lab.run', at, run: summary({ status: 'passed', passed: 1, finished_at: at }) }], s)
    const h = done.labHistory['bench-drift']
    expect(h.runs.map((r) => r.id)).toEqual(['run_0', 'run_1'])
    expect(h.metrics.find((m) => m.metric === 'confidence inflation')!.points.map((p) => p.run_id)).toEqual(['run_0', 'run_1'])
    expect(h.metrics.find((m) => m.metric === 'echoes absorbed')!.points).toHaveLength(1)
    // folding the same run again replaces, never duplicates
    const again = foldRunIntoHistory(h, summary({ status: 'passed' }), done.labCases.run_1)
    expect(again.runs).toHaveLength(2)
    expect(again.metrics[0].points).toHaveLength(2)
  })

  it('summarises health from each suite’s last run', () => {
    expect(labHealth(null).state).toBe('unknown')
    const passed = summary({ status: 'passed' })
    expect(labHealth([suite({ last_run: passed }), suite({ id: 'x' })])).toMatchObject({ state: 'passing', passing: 1, ran: 1, total: 2 })
    expect(labHealth([suite({ last_run: passed }), suite({ id: 'x', last_run: summary({ status: 'running' }) })]).state).toBe('running')
    expect(labHealth([suite({ last_run: summary({ status: 'failed' }) }), suite({ id: 'x', last_run: summary({ status: 'running' }) })]).state).toBe('failing')
  })
})
