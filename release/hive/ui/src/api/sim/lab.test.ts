import { describe, expect, it } from 'vitest'
import type { HiveEvent } from '../types'
import { judge, normaliseCase, SimLab, type LabRecord } from './lab'
import { mulberry32 } from './SimClient'

const T0 = 1_790_000_000
const record: LabRecord = {
  runs: [
    {
      suite: 'bench-drift', status: 'passed', started: T0, finished: T0 + 3,
      cases: [
        { id: 'bench-drift::echo_storm', name: 'Echo storm', group: 'beliefs', status: 'passed', duration_ms: 600,
          metrics: [{ name: 'confidence inflation', value: 0, unit: '', better: 'lower', target: 1e-9, ok: true },
            { name: 'naive inflation avoided', value: 0.38, unit: '', better: 'higher', target: null, ok: null }],
          series: [{ name: 'commons confidence', unit: '', kind: 'line', x: 'echo', points: [[0, 0.6], [1, 0.6]] }] },
        { id: 'bench-drift::retry_storm', name: 'Retry storm', group: 'spend', dimension: 'cost', status: 'passed', duration_ms: 300 },
      ],
    },
    { suite: 'tests-ui', status: 'passed', started: T0 + 10, finished: T0 + 12, cases: [{ id: 'lib::x', name: 'x', group: 'lib', status: 'passed', duration_ms: 1 }] },
  ],
}

const make = (events: HiveEvent[] = [], maxReplayMs = 120) =>
  new SimLab({ emit: (e) => events.push(e), rng: mulberry32(3), latency: false, load: async () => structuredClone(record), maxReplayMs, minReplayMs: 40 })

describe('SimLab', () => {
  it('normalises recorded cases, defaulting dimensions', () => {
    const c = normaliseCase({ id: 'a', name: 'A', status: 'passed' }, 'r', 'tests-hive')
    expect(c).toMatchObject({ run_id: 'r', group: '', dimension: 'correctness', metrics: [], series: [], message: null, notes: null })
    expect(normaliseCase({ id: 'a', name: 'A', status: 'passed' }, 'r', 'bench-core').dimension).toBe('drift')
    expect(normaliseCase({ id: 'a', name: 'A', status: 'passed', dimension: 'cost' }, 'r', 'bench-core').dimension).toBe('cost')
    expect(judge(3, 'lower', 4)).toBe(true)
    expect(judge(3, 'higher', 4)).toBe(false)
    expect(judge(3, 'equal', null)).toBeNull()
  })

  it('lists suites, with unrecorded ones not runnable', async () => {
    const lab = make()
    const suites = await lab.suites()
    expect(suites.find((s) => s.id === 'bench-drift')).toMatchObject({ runnable: true, missing: [] })
    expect(suites.find((s) => s.id === 'bench-ops')).toMatchObject({ runnable: false, missing: ['demo-recording'] })
    expect(suites.find((s) => s.id === 'bench-drift')!.last_run?.demo).toBe('recorded')
  })

  it('seeds example history that is marked and never flips a verdict', async () => {
    const lab = make()
    const runs = await lab.listRuns({ suite: 'bench-drift' })
    expect(runs[0].demo).toBe('recorded')
    expect(runs.slice(1).every((r) => r.demo === 'example')).toBe(true)
    expect(runs.length).toBeGreaterThan(3)
    const h = await lab.history('bench-drift')
    expect(h.runs.map((r) => r.started_at)).toEqual([...h.runs.map((r) => r.started_at)].sort())
    const inflation = h.metrics.find((m) => m.metric === 'confidence inflation')!
    expect(inflation.points.every((p) => p.value === 0 && p.ok)).toBe(true)
    const naive = h.metrics.find((m) => m.metric === 'naive inflation avoided')!
    expect(new Set(naive.points.map((p) => p.value)).size).toBeGreaterThan(1) // jittered
  })

  it('replays a recorded run through events, then it lands in history and the scorecard', async () => {
    const events: HiveEvent[] = []
    const lab = make(events)
    const started = await lab.start('bench-drift')
    expect(started.status).toBe('running')
    await expect(lab.start('bench-drift')).rejects.toMatchObject({ status: 409, code: 'already_running' })
    await expect(lab.start('bench-ops')).rejects.toMatchObject({ status: 400, code: 'missing_requirements' })
    await new Promise((r) => setTimeout(r, 400))
    const cases = events.filter((e) => e.type === 'lab.case')
    expect(cases.map((e) => (e.type === 'lab.case' ? e.case.name : ''))).toEqual(['Echo storm', 'Retry storm'])
    expect(events.some((e) => e.type === 'lab.log')).toBe(true)
    const last = events.filter((e) => e.type === 'lab.run').at(-1)
    expect(last?.type === 'lab.run' && last.run).toMatchObject({ id: started.id, status: 'passed', passed: 2, demo: 'replay' })
    const h = await lab.history('bench-drift')
    expect(h.runs.at(-1)?.id).toBe(started.id)
    const card = await lab.scorecard()
    expect(card.map((e) => e.dimension)).toEqual(['correctness', 'cost', 'drift'])
    expect(card.find((e) => e.dimension === 'drift')).toMatchObject({ passed: 1, score: 1, suites: ['bench-drift'] })
  })

  it('paces replays by recorded duration within the cap', () => {
    const lab = make([], 20_000)
    const times = lab.replayTimes({ ...record.runs[0], finished: T0 + 300 })
    expect(times.at(-1)).toBeLessThanOrEqual(20_000)
    expect(times[0]).toBeGreaterThan(times[1] - times[0]) // the 600 ms case takes longer than the 300 ms one
  })

  it('cancels a replay', async () => {
    const events: HiveEvent[] = []
    const lab = make(events, 2000)
    const r = await lab.start('bench-drift')
    await lab.cancel(r.id)
    await new Promise((res) => setTimeout(res, 350))
    const last = events.filter((e) => e.type === 'lab.run').at(-1)
    expect(last?.type === 'lab.run' && last.run.status).toBe('cancelled')
    lab.stop()
  })
})
