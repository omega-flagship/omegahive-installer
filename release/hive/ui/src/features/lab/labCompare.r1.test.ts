import { describe, expect, it } from 'vitest'
import type { LabCase, LabMetric } from '../../api/types'
import { alignMetric, compareRuns, convertUnit, judgeMetric, judgementText, type MetricRecord } from './stallCompare'

/** lab-compare r1: units, definitions and directions are checked before anything is called better or worse. */
const m = (value: number, unit: string, better: LabMetric['better'] | null = 'lower', extra: Partial<MetricRecord> = {}): MetricRecord => ({ name: 'latency', value, unit, better, target: null, ...extra })
const kase = (id: string, metrics: MetricRecord[], dimension = 'latency'): LabCase => ({
  run_id: 'r', id, name: id, group: '', dimension, status: 'passed', duration_ms: 1, message: null, notes: null, series: [],
  metrics: metrics.map((x) => ({ ok: null, ...x }) as LabMetric),
})

describe('the probe: A = 1000 ms against B = 2 s, lower is better', () => {
  it('converts before judging, so B is worse, and keeps each side in its own unit', () => {
    const j = judgeMetric(m(1000, 'ms'), m(2, 's'))
    expect(j.verdict).toBe('comparable')
    expect(j.change).toBe('worse')
    expect(j.a).toEqual({ value: 1000, unit: 'ms', better: 'lower', target: null })
    expect(j.b).toEqual({ value: 2, unit: 's', better: 'lower', target: null })
    expect(judgementText(j)).toBe('worse (lower is better)')
  })
  it('the same probe through compareRuns: counted worse, never better, and A keeps ms', () => {
    const c = compareRuns([kase('x', [m(1000, 'ms')])], [kase('x', [m(2, 's')])])
    const row = c.rows[0].metrics[0]
    expect(row.change).toBe('worse')
    expect(row.a?.unit).toBe('ms')
    expect(row.b?.unit).toBe('s')
    expect(c.metrics).toEqual({ better: 0, worse: 1, same: 0 })
    expect(c.unjudged).toEqual({ notComparable: 0, unknown: 0 })
  })
  it('the other way round, and equal amounts in different units read as the same', () => {
    expect(judgeMetric(m(2, 's'), m(1000, 'ms')).change).toBe('better')
    expect(judgeMetric(m(1, 's'), m(1000, 'ms')).change).toBe('same')
    expect(judgeMetric(m(1, 'MiB', 'lower'), m(1_048_576, 'B', 'lower')).change).toBe('same')
    expect(judgeMetric(m(1, 'MB', 'lower'), m(1, 'MiB', 'lower')).change).toBe('worse')
  })
})

describe('the declared conversion table', () => {
  it('converts within time, bytes (decimal and binary apart) and counts; nothing across', () => {
    expect(convertUnit(90, 'min', 'h')).toBeCloseTo(1.5)
    expect(convertUnit(1500, 'µs', 'ms')).toBeCloseTo(1.5)
    expect(convertUnit(1, 'GB', 'MB')).toBeCloseTo(1000)
    expect(convertUnit(1, 'GiB', 'MiB')).toBeCloseTo(1024)
    expect(convertUnit(3, 'count', 'counts')).toBe(3)
    expect(convertUnit(1, 's', 'MB')).toBeNull()
    expect(convertUnit(1, 'Mb', 'MB')).toBeNull()
    expect(convertUnit(1, 'steps', 's')).toBeNull()
    expect(convertUnit(7, 'steps', 'steps')).toBe(7) // declared in UNIT_TABLE (r1.1)
    expect(convertUnit(7, 'furlongs', 'furlongs')).toBeNull() // identical but undeclared: never a pass-through (r1.1, K2)
  })
})

describe('not comparable, with a reason, and never better or worse', () => {
  it('incompatible units', () => {
    const j = judgeMetric(m(1000, 'ms'), m(2, 'MB'))
    expect(j.verdict).toBe('not_comparable')
    expect(j.change).toBe('not-comparable')
    expect(judgementText(j)).toBe('not comparable: units ms and MB have no declared conversion')
    expect(judgeMetric(m(5, 'ms'), m(5, '%')).verdict).toBe('not_comparable')
    expect(judgeMetric(m(5, ''), m(5, '%')).verdict).toBe('unknown') // r1.1: a blank unit is unknown, not a unit
  })
  it('a different metric definition, cohort or split', () => {
    expect(judgeMetric(m(1, 'ms', 'lower', { definition: 'p50' }), m(1, 'ms', 'lower', { definition: 'p99' })).reason).toBe('different definition (p50 vs p99)')
    expect(judgeMetric(m(1, 'ms', 'lower', { cohort: 'warm' }), m(1, 'ms')).verdict).toBe('not_comparable')
    expect(judgeMetric(m(1, 'ms', 'lower', { split: 'test' }), m(1, 'ms', 'lower', { split: 'train' })).change).toBe('not-comparable')
    const c = compareRuns([kase('x', [m(100, 'ms')], 'latency')], [kase('x', [m(50, 'ms')], 'efficiency')])
    expect(c.rows[0].metrics[0].verdict).toBe('not_comparable')
    expect(c.metrics).toEqual({ better: 0, worse: 0, same: 0 })
    expect(c.unjudged).toEqual({ notComparable: 1, unknown: 0 })
  })
  it('a missing or conflicting direction', () => {
    const j = judgeMetric(m(100, 'ms', null), m(50, 'ms', null))
    expect(['not_comparable', 'unknown']).toContain(j.verdict)
    expect(j.change).not.toMatch(/better|worse/)
    expect(judgeMetric(m(100, 'ms', 'lower'), m(50, 'ms', null)).verdict).toBe('not_comparable')
    expect(judgeMetric(m(100, 'ms', 'lower'), m(50, 'ms', 'higher')).reason).toBe('directions differ (lower vs higher is better)')
    expect(judgeMetric(m(100, 'ms', 'sideways' as never), m(50, 'ms', 'sideways' as never)).verdict).toBe('not_comparable')
  })
  it('a measure recorded twice in one run', () => {
    const c = compareRuns([kase('x', [m(1, 'ms'), m(2, 'ms')])], [kase('x', [m(1, 'ms')])])
    expect(c.rows[0].metrics[0].verdict).toBe('not_comparable')
  })
})

describe('unknown', () => {
  it('a missing or unreadable value is unknown, not judged', () => {
    expect(judgeMetric(m(Number.NaN, 'ms'), m(1, 'ms')).verdict).toBe('unknown')
    expect(judgeMetric(m(Number.NaN, 'ms'), m(1, 'ms')).change).toBe('unknown')
    expect(judgeMetric(undefined, m(1, 'ms')).change).toBe('only-b')
    expect(alignMetric(m(1, 'ms'), undefined).bInA).toBeNull()
  })
})
