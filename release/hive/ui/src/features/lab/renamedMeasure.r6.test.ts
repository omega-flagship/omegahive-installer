import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LabCase, LabMetric } from '../../api/types'
import { CaseRows } from './Compare'
import { formerlyText, formerNames } from './labUtil'
import { MetricTile } from './parts'
import { compareRuns } from './stallCompare'

/**
 * followups-r6 item 10 (Jon): minds were once called "dots", and the host renames its bench strings. It sends
 * `legacy_names` on a metric and `renamed_from` on an old record served under the new name. Measures pair on `name`
 * alone, so a renamed measure is ONE measure; the old name shows only as a quiet "formerly …" detail. INVENTED data.
 */
const metric = (value: number, extra: Partial<LabMetric> = {}): LabMetric => ({ name: 'memory per mind', value, unit: 'MB', better: 'lower', target: 600, ok: true, ...extra })
const kase = (metrics: LabMetric[], run: string): LabCase => ({ run_id: run, id: 'bench::memory', name: 'Memory at rest', group: 'bench', dimension: 'efficiency', status: 'passed', duration_ms: 10, message: null, notes: null, metrics, series: [] })

describe('item 10: a renamed measure compares as one measure', () => {
  it('two runs, the older served with renamed_from "memory per dot": one row, comparable, judged, with the old name as a detail', () => {
    const older = kase([metric(180, { renamed_from: 'memory per dot' })], 'r_old')
    const newer = kase([metric(150, { legacy_names: ['memory per dot'] })], 'r_new')
    const c = compareRuns([older], [newer])
    expect(c.rows).toHaveLength(1)
    expect(c.rows[0].metrics).toHaveLength(1)
    const m = c.rows[0].metrics[0]
    expect(m).toMatchObject({ name: 'memory per mind', verdict: 'comparable', change: 'better', formerly: ['memory per dot'] })
    expect(c.metrics).toEqual({ better: 1, worse: 0, same: 0 })
    expect(c.unjudged).toEqual({ notComparable: 0, unknown: 0 })
  })
  it('the compare table shows the measure once, its old name only as a quiet "formerly" detail', () => {
    const c = compareRuns([kase([metric(180, { renamed_from: 'memory per dot' })], 'a')], [kase([metric(150)], 'b')])
    const html = renderToStaticMarkup(createElement('table', null, createElement('tbody', null, createElement(CaseRows, { row: c.rows[0] }))))
    expect(html.match(/data-metric-verdict=/g)).toHaveLength(1)
    expect(html).toContain('memory per mind')
    expect(html).toMatch(/<span[^>]*data-metric-formerly=""[^>]*>formerly ‘memory per dot’<\/span>/)
  })
  it('the old name is never a measure of its own: a run that names neither keeps one row and no detail', () => {
    const c = compareRuns([kase([metric(180)], 'a')], [kase([metric(150)], 'b')])
    expect(c.rows[0].metrics.map((m) => [m.name, m.formerly])).toEqual([['memory per mind', []]])
  })
  it('formerNames: each old name once, never the current name, from either field', () => {
    expect(formerNames([{ name: 'x', renamed_from: 'x' }], 'x')).toEqual([])
    expect(formerNames([{ name: 'm', renamed_from: 'a', legacy_names: ['a', 'b', ' '] }, undefined, { name: 'm', legacy_names: ['b', 'c'] }], 'm')).toEqual(['a', 'b', 'c'])
    expect(formerlyText([])).toBeNull()
    expect(formerlyText(['a', 'b'])).toBe('formerly ‘a’, ‘b’')
  })
  it('a run’s metric tile shows the measure once, with its old name as a quiet line', () => {
    const html = renderToStaticMarkup(createElement(MetricTile, { m: metric(150, { legacy_names: ['memory per dot'] }) }))
    expect(html).toMatch(/data-metric-formerly="">formerly ‘memory per dot’</)
    expect(renderToStaticMarkup(createElement(MetricTile, { m: metric(150) }))).not.toContain('formerly')
  })
})

describe('item 10: the host’s rename fields, as served (platform 09fd208)', () => {
  it('the sim history (as the host builds it) keeps a renamed measure as ONE series, its old name a quiet detail', async () => {
    const { SimClient } = await import('../../api/sim/SimClient')
    const sim = new SimClient({ seed: 7, latency: false, autoStart: false, historyDays: 1 })
    const ids = (await sim.listLabSuites()).map((s) => s.id)
    expect(ids).toContain('bench-ops')
    let found: { metric: string; legacy?: string[]; points: { renamed_from?: string }[] } | null = null
    for (const id of ids) {
      const h = await sim.getLabHistory(id)
      const m = h.metrics.find((x) => x.metric === 'memory per mind')
      if (m) found = { metric: m.metric, legacy: m.legacy_names, points: m.points }
      // never a separate series under the old name
      expect(h.metrics.filter((x) => x.metric === 'memory per dot')).toEqual([])
    }
    sim.disconnect()
    expect(found).not.toBeNull()
    expect(found!.legacy).toEqual(['memory per dot'])
    expect(formerNames([{ name: found!.metric, legacy_names: found!.legacy }, ...found!.points.map((p) => ({ name: found!.metric, renamed_from: p.renamed_from }))], found!.metric)).toEqual(['memory per dot'])
  })
})
