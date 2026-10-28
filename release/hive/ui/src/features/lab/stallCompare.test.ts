import { describe, expect, it } from 'vitest'
import type { LabCase, LabRunSummary } from '../../api/types'
import { href, parse } from '../../lib/router'
import { aboutSince, compareRuns, defaultPair, lastProgressAt, metricChange, stallAfterMs, stalledFor, versionLabel } from './stallCompare'

const T0 = Date.parse('2026-10-09T10:00:00Z')
const run = (over: Partial<LabRunSummary> = {}): LabRunSummary => ({ id: 'r1', suite: 's', status: 'running', started_at: new Date(T0).toISOString(), finished_at: null, duration_ms: null, passed: 0, failed: 0, skipped: 0, errors: 0, commit_sha: null, ...over })
const kase = (id: string, status: LabCase['status'], metrics: [string, number, 'lower' | 'higher' | 'equal'][] = [], duration = 1000): LabCase => ({
  run_id: 'r', id, name: id, group: '', dimension: 'latency', status, duration_ms: duration, message: null, notes: null, series: [],
  metrics: metrics.map(([name, value, better]) => ({ name, value, unit: 'ms', better, target: null, ok: null })),
})

describe('a stalled run, from what the hive reports', () => {
  it('last progress is the start plus the finished cases’ durations', () => {
    expect(lastProgressAt(run(), [kase('a', 'passed', [], 30_000), kase('b', 'passed', [], 12_000)])).toBe(T0 + 42_000)
  })
  it('reads as stalled only past three estimates and at least ten minutes, and only while running', () => {
    expect(stallAfterMs(20)).toBe(10 * 60_000)
    expect(stallAfterMs(400)).toBe(1_200_000)
    const cases = [kase('a', 'passed', [], 60_000)]
    expect(stalledFor(run(), cases, 200, T0 + 60_000 + 9 * 60_000)).toBeNull()
    expect(stalledFor(run(), cases, 200, T0 + 60_000 + 52 * 60_000)).toBe(52 * 60_000)
    expect(stalledFor(run({ status: 'passed' }), cases, 200, T0 + 99 * 60 * 60_000)).toBeNull()
  })
  it('says how long in plain words', () => {
    expect(aboutSince(52 * 60_000)).toBe('about 52 minutes')
    expect(aboutSince(60_000)).toBe('about 1 minute')
    expect(aboutSince(3 * 3_600_000)).toBe('about 3 hours')
  })
})

describe('comparing two versions', () => {
  it('judges each measure by its own direction; equal measures only say same or changed', () => {
    expect(metricChange('lower', 100, 80)).toBe('better')
    expect(metricChange('lower', 100, 120)).toBe('worse')
    expect(metricChange('higher', 10, 12)).toBe('better')
    expect(metricChange('higher', 10, 10.02)).toBe('same')
    expect(metricChange('equal', 0, 1)).toBe('changed')
    expect(metricChange('equal', 0, 0)).toBe('same')
    expect(metricChange('lower', null, 3)).toBe('only-b')
  })
  it('B against A case by case, with counts', () => {
    const a = [kase('x', 'passed', [['latency', 100, 'lower'], ['rate', 50, 'higher']]), kase('y', 'failed'), kase('z', 'passed')]
    const b = [kase('x', 'passed', [['latency', 80, 'lower'], ['rate', 40, 'higher']]), kase('y', 'passed'), kase('w', 'passed')]
    const c = compareRuns(a, b)
    expect(c.passed).toEqual({ a: 2, b: 3 })
    expect(c.metrics).toEqual({ better: 1, worse: 1, same: 0 })
    expect(c.statuses).toEqual({ better: 1, worse: 0 })
    expect(c.rows.map((r) => [r.id, r.status])).toEqual([['x', 'same'], ['y', 'better'], ['z', 'only-a'], ['w', 'only-b']])
  })
  it('defaults to the newest finished run against the one before; names a version by its commit', () => {
    const runs = [run({ id: 'old', status: 'passed', started_at: '2026-10-01T00:00:00Z' }), run({ id: 'new', status: 'failed', started_at: '2026-10-03T00:00:00Z' }), run({ id: 'mid', status: 'passed', started_at: '2026-10-02T00:00:00Z' }), run({ id: 'live', started_at: '2026-10-04T00:00:00Z' }), run({ id: 'gone', status: 'cancelled', started_at: '2026-10-05T00:00:00Z' })]
    expect(defaultPair(runs)).toEqual({ a: 'mid', b: 'new' })
    expect(defaultPair(runs.slice(0, 1))).toEqual({ a: null, b: 'old' })
    expect(versionLabel(run({ commit_sha: '0123456789abcdef' }))).toMatch(/^0123456789 · /)
    expect(versionLabel(run())).toMatch(/\(no version recorded\)$/)
  })
})

describe('the compare tab has its own address', () => {
  it('#/lab/<suite>/compare round-trips; an unknown tab falls back to the run', () => {
    expect(parse('#/lab/bench-core/compare')).toEqual({ name: 'lab', suite: 'bench-core', tab: 'compare' })
    expect(href({ name: 'lab', suite: 'bench-core', tab: 'compare' })).toBe('#/lab/bench-core/compare')
    expect(href({ name: 'lab', suite: 'bench-core', tab: 'history' })).toBe('#/lab/bench-core/history')
    expect(parse('#/lab/bench-core/other')).toEqual({ name: 'lab', suite: 'bench-core', tab: undefined })
  })
})
