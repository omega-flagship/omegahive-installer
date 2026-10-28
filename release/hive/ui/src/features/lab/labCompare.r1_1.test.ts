import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LabCase, LabMetric } from '../../api/types'
import { epistemicCounts, epistemicVerdict } from './epistemicCompare'
import { EpistemicBoard } from './Epistemic'
import { alignCaseMetric, CHANGE_WORD, compareRuns, conversion, judgeMetric, judgementText, sideText, STATUS_WORD, type MetricRecord } from './stallCompare'

/** lab-compare r1.1: the stand-in's FIX-FIRST items and Kimi's findings, each pinned. */
const m = (value: number, unit: string, better: LabMetric['better'] | null = 'lower', extra: Partial<MetricRecord> = {}): MetricRecord => ({ name: 'latency', value, unit, better, target: null, ...extra })

describe('a unit must be recorded and declared', () => {
  it('both units missing is unknown with a reason, never comparable (stand-in repro: 100 vs 50, both blank)', () => {
    const j = judgeMetric(m(100, ''), m(50, ''))
    expect(j.verdict).toBe('unknown')
    expect(j.change).toBe('unknown')
    expect(judgementText(j)).toBe('unknown: no unit recorded')
    expect(judgeMetric(m(100, '  '), m(50, '  ')).verdict).toBe('unknown')
    expect(judgeMetric(m(100, undefined as never), m(50, undefined as never)).verdict).toBe('unknown')
    expect(judgeMetric(m(100, 'ms'), m(50, '')).verdict).toBe('unknown')
  })
  it('an explicit unitless declaration is comparable', () => {
    expect(judgeMetric(m(0.9, 'ratio', 'higher'), m(0.95, 'ratio', 'higher')).change).toBe('better')
    expect(judgeMetric(m(3, 'unitless'), m(2, 'unitless')).change).toBe('better')
    expect(judgeMetric(m(3, 'ratio'), m(3, 'unitless')).verdict).toBe('not_comparable')
  })
  it('identical but undeclared units are not comparable (Kimi K2: furlongs vs furlongs)', () => {
    const j = judgeMetric(m(10, 'furlongs'), m(5, 'furlongs'))
    expect(j.verdict).toBe('not_comparable')
    expect(j.reason).toBe('unit furlongs is not declared')
  })
  it('the units the hive’s own suites record are declared, and compare only with themselves', () => {
    for (const u of ['ms', '$', 'MB', '%', 'steps', '% of a core', 'tokens', 's', 'ops/s', 'per 15 s', 'core·s', 'J', 'Wh', 'W']) expect(judgeMetric(m(2, u), m(1, u)).verdict).toBe('comparable')
    expect(judgeMetric(m(1, 'Wh'), m(3600, 'J')).change).toBe('same')
    expect(judgeMetric(m(1, 'steps'), m(1, 'tokens')).verdict).toBe('not_comparable')
  })
})

describe('conversion safety', () => {
  it('only the table’s own entries are units: inherited names never convert (stand-in repro: constructor vs toString)', () => {
    for (const [x, y] of [['constructor', 'toString'], ['__proto__', '__proto__'], ['hasOwnProperty', 'valueOf'], ['toString', 'toString']]) {
      const j = judgeMetric(m(1, x), m(2, y))
      expect(j.verdict).toBe('not_comparable')
      expect(j.change).not.toMatch(/better|worse|same/)
    }
  })
  it('an overflowing conversion is refused (stand-in repro: 1 B vs 1e308 GB)', () => {
    const j = judgeMetric(m(1, 'B'), m(1e308, 'GB'))
    expect(j.verdict).toBe('unknown')
    expect(j.change).toBe('unknown')
    expect(j.reason).toMatch(/out of range/)
    expect(conversion(1e308, 'GB', 'B').ok).toBe(false)
  })
  it('a non-zero value that underflows to 0 is refused; a true 0 is not', () => {
    expect(judgeMetric(m(1, 'GB'), m(5e-324, 'B')).verdict).toBe('unknown')
    expect(conversion(5e-324, 'B', 'GB').ok).toBe(false)
    expect(judgeMetric(m(0, 'ms'), m(0, 's')).change).toBe('same')
  })
})

describe('judging after conversion', () => {
  it('higher is better succeeds across units', () => {
    const j = judgeMetric(m(10, 'MB', 'higher'), m(20_000, 'kB', 'higher'))
    expect(j.verdict).toBe('comparable')
    expect(j.change).toBe('better')
    expect(judgementText(j)).toBe('better (higher is better)')
    expect(judgeMetric(m(20, 'MB', 'higher'), m(10_000, 'kB', 'higher')).change).toBe('worse')
  })
  it('precision boundaries: the 0.5 % line holds after conversion', () => {
    expect(judgeMetric(m(1, 's'), m(1005, 'ms')).change).toBe('same')
    expect(judgeMetric(m(1, 's'), m(1006, 'ms')).change).toBe('worse')
    expect(judgeMetric(m(1, 's'), m(994, 'ms')).change).toBe('better')
    expect(judgeMetric(m(1, 'h'), m(3599.999, 's')).change).toBe('same')
  })
  it('zero and negative values across units (Kimi K6)', () => {
    expect(judgeMetric(m(0, 'ms'), m(0, 's')).change).toBe('same')
    expect(judgeMetric(m(-5, 'ms'), m(-0.005, 's')).change).toBe('same')
    expect(judgeMetric(m(-5, 'ms'), m(-0.006, 's')).change).toBe('better')
  })
})

describe('the compare table', () => {
  it('each side keeps its own target, in its own unit (Kimi K3)', () => {
    const j = judgeMetric(m(1000, 'ms', 'lower', { target: 1500 }), m(2, 's', 'lower', { target: 3 }))
    expect(sideText(j.a)).toEqual({ value: '1.00 s', target: 'target ≤ 1.50 s' })
    expect(sideText(j.b)).toEqual({ value: '2 s', target: 'target ≤ 3 s' })
    expect(sideText(judgeMetric(m(1, 'ms'), m(1, 'ms')).a).target).toBeNull()
    expect(sideText(null)).toEqual({ value: '–', target: null })
  })
  it('case status says "same"; only measures say "about the same" (Kimi K4)', () => {
    expect(STATUS_WORD.same).toBe('same')
    expect(CHANGE_WORD.same).toBe('about the same')
  })
  it('one record per name, through the shared case guard', () => {
    const k = (metrics: MetricRecord[]) => ({ dimension: 'latency', metrics: metrics.map((x) => ({ ok: null, ...x }) as LabMetric) })
    expect(alignCaseMetric(k([m(1, 'ms'), m(2, 'ms')]), k([m(1, 'ms')]), 'latency').verdict).toBe('not_comparable')
    expect(alignCaseMetric(k([m(1, 'ms')]), k([m(1, 'ms')]), 'latency').verdict).toBe('comparable')
    const c = compareRuns([{ run_id: 'r', id: 'x', name: 'x', group: '', status: 'passed', duration_ms: 1, message: null, notes: null, series: [], ...k([m(100, ''), m(1, 'ms', 'lower', { name: 'p50' })]) }], [{ run_id: 'r', id: 'x', name: 'x', group: '', status: 'passed', duration_ms: 1, message: null, notes: null, series: [], ...k([m(50, ''), m(2, 'ms', 'lower', { name: 'p50' })]) }])
    expect(c.metrics).toEqual({ better: 0, worse: 1, same: 0 })
    expect(c.unjudged).toEqual({ notComparable: 0, unknown: 1 })
  })
})

// ---------------------------------------------------------------- Epistemic board

const NAMES = ['correction latency', 'corruption susceptibility', 'retention', 'recovery'] as const
const BETTER = { 'correction latency': 'lower', 'corruption susceptibility': 'lower', retention: 'higher', recovery: 'higher' } as const
const ecase = (key: string, values: Partial<Record<(typeof NAMES)[number], number>>, unit: (n: string) => string = (n) => (n === 'correction latency' ? 'steps' : ''), extra: LabMetric[] = []): LabCase => ({
  run_id: 'r', id: `bench-epistemic::${key}`, name: `Suite score: ${key}`, group: 'epistemic suite', dimension: 'accuracy', status: 'passed', duration_ms: 1, message: null, notes: null, series: [],
  metrics: [...NAMES.filter((n) => values[n] != null).map((n) => ({ name: n, value: values[n]!, unit: unit(n), better: BETTER[n], target: null, ok: null })), ...extra],
})
const REF = { 'correction latency': 0.4, 'corruption susceptibility': 0.12, retention: 0.88, recovery: 1 }

describe('the Epistemic board judges only what it evaluated', () => {
  it('all four level: the board’s blank units are filled by its own declaration', () => {
    expect(epistemicVerdict(ecase('omegadots-commons', REF), ecase('mock-provenance', REF))).toBe('Level with mock-provenance, the paper’s reference, on all four metrics.')
  })
  it('none evaluated: says so, never "level on all four" (stand-in item 2)', () => {
    const n = epistemicCounts(ecase('omegadots-commons', {}), ecase('mock-provenance', REF))
    expect(n).toEqual({ better: 0, worse: 0, same: 0, notComparable: 0, unknown: 4 })
    const v = epistemicVerdict(ecase('omegadots-commons', {}), ecase('mock-provenance', REF))
    expect(v).toBe('None of the 4 metrics could be compared with mock-provenance: 4 not recorded or unreadable.')
    expect(v).not.toMatch(/all four|Level/)
  })
  it('some unknown: only the evaluated ones are judged, the rest are named', () => {
    const v = epistemicVerdict(ecase('omegadots-commons', { retention: 0.88, recovery: 1 }), ecase('mock-provenance', REF))
    expect(v).toBe('Level with mock-provenance on the 2 metrics compared. Not compared: 2 not recorded or unreadable.')
    const w = epistemicVerdict(ecase('omegadots-commons', { ...REF, retention: 0.5, recovery: Number.NaN }), ecase('mock-provenance', REF))
    expect(w).toBe('Behind mock-provenance on 1 of the 3 metrics compared. Not compared: 1 not recorded or unreadable.')
  })
  it('a duplicate record, an undeclared unit and a recorded unit that wins are not comparable', () => {
    const dup = ecase('omegadots-commons', REF, undefined, [{ name: 'retention', value: 0.1, unit: '', better: 'higher', target: null, ok: null }])
    expect(epistemicCounts(dup, ecase('mock-provenance', REF)).notComparable).toBe(1)
    const furl = ecase('omegadots-commons', REF, (n) => (n === 'recovery' ? 'furlongs' : n === 'correction latency' ? 'steps' : ''))
    expect(epistemicCounts(furl, ecase('mock-provenance', REF))).toEqual({ better: 0, worse: 0, same: 3, notComparable: 1, unknown: 0 })
  })
  it('"same" is the compare’s relative closeness, not an absolute 1e-6 (Kimi K1)', () => {
    const near = { ...REF, retention: 0.8801 }
    expect(epistemicCounts(ecase('omegadots-commons', near), ecase('mock-provenance', REF)).same).toBe(4)
    expect(epistemicCounts(ecase('omegadots-commons', { ...REF, retention: 0.9 }), ecase('mock-provenance', REF)).better).toBe(1)
  })
  it('renders the evaluated-only verdict', () => {
    const html = renderToStaticMarkup(createElement(EpistemicBoard, { cases: [ecase('omegadots-commons', {}), ecase('mock-provenance', REF)] }))
    expect(html).toContain('None of the 4 metrics could be compared with mock-provenance: 4 not recorded or unreadable.')
    expect(html).not.toContain('on all four metrics')
    const ok = renderToStaticMarkup(createElement(EpistemicBoard, { cases: [ecase('omegadots-commons', REF), ecase('mock-provenance', REF)] }))
    expect(ok).toContain('Level with mock-provenance, the paper’s reference, on all four metrics.')
  })
})
