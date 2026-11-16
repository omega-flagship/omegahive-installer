import { useEffect, useMemo, useState } from 'react'
import type { LabRunSummary, LabSuite } from '../../api/types'
import { cx } from '../../lib/cx'
import { useHive } from '../../store/store'
import { EmptyState, Skeleton } from '../../ui/primitives'
import { fmtDuration, formerlyText, labText, STATUS } from './labUtil'
import { Card, DemoChip } from './parts'
import { compareRuns, defaultPair, judgementText, sideText, STATUS_WORD, versionLabel, type Change, type CaseRow, type Observation } from './stallCompare'

const TONE: Record<Change, string> = {
  better: 'text-good',
  worse: 'text-bad',
  same: 'text-ink-4',
  changed: 'text-warn',
  'only-a': 'text-ink-4',
  'only-b': 'text-ink-4',
  'not-comparable': 'text-ink-3',
  unknown: 'text-ink-4',
}

/**
 * Two versions of a suite side by side (demo D3; the groundwork for a personal mind's "best version"): pick run A and
 * run B, see B against A case by case and metric by metric, judged by each metric's own direction (lower or higher is
 * better). Read only. lab-compare r1: each side keeps its own value and unit; better or worse only when the two are
 * comparable (same definition and direction, declared-convertible units), otherwise "not comparable: <reason>".
 */
export function SuiteCompare({ suite }: { suite: LabSuite }) {
  const all = useHive((s) => s.labRuns)
  const runs = useMemo(() => Object.values(all).filter((r) => r.suite === suite.id && r.status !== 'running' && r.status !== 'cancelled').sort((x, y) => y.started_at.localeCompare(x.started_at)), [all, suite.id])
  const pair = useMemo(() => defaultPair(runs), [runs])
  const [a, setA] = useState<string | null>(null)
  const [b, setB] = useState<string | null>(null)
  const idA = a ?? pair.a
  const idB = b ?? pair.b
  const load = useHive((s) => s.loadLabRun)
  const casesA = useHive((s) => (idA ? s.labCases[idA] : undefined))
  const casesB = useHive((s) => (idB ? s.labCases[idB] : undefined))
  useEffect(() => {
    if (idA) void load(idA).catch(() => undefined)
    if (idB) void load(idB).catch(() => undefined)
  }, [idA, idB, load])
  const [everything, setEverything] = useState(false)
  const cmp = useMemo(() => (casesA && casesB ? compareRuns(casesA, casesB) : null), [casesA, casesB])

  if (runs.length < 2) return <Card><EmptyState icon="flask" title="Nothing to compare yet" body="Comparing needs two finished runs of this suite." /></Card>
  const runA = runs.find((r) => r.id === idA)
  const runB = runs.find((r) => r.id === idB)
  const interesting = (r: CaseRow) => r.status !== 'same' || r.metrics.some((m) => m.change !== 'same')
  const rows = cmp ? (everything ? cmp.rows : cmp.rows.filter((r) => interesting(r) || r.metrics.length > 0)) : []
  const hidden = cmp ? cmp.rows.length - rows.length : 0

  return (
    <div className="space-y-3" data-lab-compare={suite.id}>
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <RunPick label="Version A" runs={runs} value={idA} other={idB} onChange={setA} run={runA} />
          <RunPick label="Version B" runs={runs} value={idB} other={idA} onChange={setB} run={runB} />
        </div>
        {cmp && runA && runB ? (
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2" data-compare-summary data-tour="lab-compare">
            B passed {cmp.passed.b} of {cmp.judged.b} cases, A {cmp.passed.a} of {cmp.judged.a}.{' '}
            {cmp.metrics.better + cmp.metrics.worse + cmp.metrics.same > 0
              ? `Against A, B is better on ${cmp.metrics.better} measure${cmp.metrics.better === 1 ? '' : 's'}, worse on ${cmp.metrics.worse} and about the same on ${cmp.metrics.same}.`
              : cmp.unjudged.notComparable + cmp.unjudged.unknown === 0
                ? 'This suite records pass or fail only, no measures.'
                : 'No measure here can be judged between the two versions.'}{' '}
            {cmp.unjudged.notComparable ? `${cmp.unjudged.notComparable} measure${cmp.unjudged.notComparable === 1 ? ' is' : 's are'} not comparable (see why below). ` : ''}
            {cmp.unjudged.unknown ? `${cmp.unjudged.unknown} measure${cmp.unjudged.unknown === 1 ? ' is' : 's are'} not judged: no unit or no readable value recorded. ` : ''}
            {cmp.statuses.worse ? `${cmp.statuses.worse} case${cmp.statuses.worse === 1 ? '' : 's'} got worse. ` : ''}
            Run time {fmtDuration(runA.duration_ms)} → {fmtDuration(runB.duration_ms)}.
          </p>
        ) : (
          <Skeleton className="mt-3 h-5 w-2/3 rounded-md" />
        )}
      </Card>
      {cmp && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[560px] text-left text-[12.5px]">
            <caption className="sr-only">Version B against version A, case by case</caption>
            <thead className="text-[11px] tracking-wide text-ink-4 uppercase">
              <tr className="border-b border-line">
                <th scope="col" className="px-3 py-2 font-medium">Case or measure</th>
                <th scope="col" className="px-3 py-2 font-medium">A</th>
                <th scope="col" className="px-3 py-2 font-medium">B</th>
                <th scope="col" className="px-3 py-2 font-medium">B against A</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CaseRows key={r.id} row={r} />
              ))}
            </tbody>
          </table>
          <p className="px-3 pt-2 text-[11.5px] text-ink-4" data-compare-note>
            Better and worse compare the two recorded values only, each shown in its own unit. “About the same” means within 0.5 %. Neither is a confidence or significance test.
          </p>
          {hidden > 0 && (
            <button className="m-3 text-[12px] font-medium text-accent hover:underline" onClick={() => setEverything(true)}>
              Show {hidden} unchanged pass/fail case{hidden === 1 ? '' : 's'}
            </button>
          )}
        </Card>
      )}
    </div>
  )
}

function RunPick({ label, runs, value, other, onChange, run }: { label: string; runs: LabRunSummary[]; value: string | null; other: string | null; onChange: (id: string) => void; run: LabRunSummary | undefined }) {
  return (
    <label className="block min-w-0">
      <span className="flex items-center gap-2 text-[12px] text-ink-3">
        {label} {run && <DemoChip demo={run.demo} />}
      </span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2">
        {runs.map((r) => (
          <option key={r.id} value={r.id} disabled={r.id === other}>
            {versionLabel(r)} · {r.passed} passed{r.failed + r.errors ? `, ${r.failed + r.errors} not` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

export function CaseRows({ row }: { row: CaseRow }) {
  const st = (s: CaseRow['a']) => (s ? STATUS[s].label : '–')
  return (
    <>
      <tr className="border-b border-line/60 align-top">
        <th scope="row" className="px-3 py-2 font-medium text-ink">
          {labText(row.name)}
          {row.group && <span className="ml-1.5 font-normal text-ink-4">{labText(row.group)}</span>}
        </th>
        <td className="px-3 py-2 text-ink-2">{st(row.a)}</td>
        <td className="px-3 py-2 text-ink-2">{st(row.b)}</td>
        <td className={cx('px-3 py-2', TONE[row.status])}>{row.status === 'same' ? '' : STATUS_WORD[row.status]}</td>
      </tr>
      {row.metrics.map((m) => (
        <tr key={m.name} className="border-b border-line/40 text-ink-3" data-metric-verdict={m.verdict}>
          <th scope="row" className="py-1.5 pr-3 pl-7 font-normal">
            {labText(m.name)}
            {m.formerly.length > 0 && <span className="ml-1.5 text-[11px] text-ink-4" data-metric-formerly="">{formerlyText(m.formerly)}</span>}
          </th>
          <td className="px-3 py-1.5 tabular-nums">{shown(m.a)}</td>
          <td className="px-3 py-1.5 tabular-nums">{shown(m.b)}</td>
          <td className={cx('px-3 py-1.5', TONE[m.change])}>{judgementText(m)}</td>
        </tr>
      ))}
    </>
  )
}

/** One side's value and its own target, each in that side's recorded unit (never the other side's). */
function shown(o: Observation | null) {
  const t = sideText(o)
  return (
    <>
      {t.value}
      {t.target && <span className="block text-[11px] text-ink-4">{t.target}</span>}
    </>
  )
}
