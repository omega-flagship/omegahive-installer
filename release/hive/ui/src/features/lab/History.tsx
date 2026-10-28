import { plural } from '../../lib/plural'
import { useEffect, useMemo, useState } from 'react'
import type { LabSuite } from '../../api/types'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { ErrorState, Skeleton } from '../../ui/primitives'
import { Sparkline, TrendChart, type TrendPoint } from './charts'
import { BETTER_TEXT, fmtDuration, fmtValue, formerlyText, formerNames, labText, targetText, total } from './labUtil'
import { Card, Counts, DemoChip, StatusIcon } from './parts'

interface Row {
  key: string
  group: string
  name: string
  unit: string
  better: 'lower' | 'higher' | 'equal' | null
  target: number | null
  points: TrendPoint[]
  /** Names the measure had before (a quiet detail; old and new runs are one series). */
  formerly: string[]
}

/** Benchmarks over time: pick a metric, see it across runs against its target; the runs below. */
export function SuiteHistory({ suite }: { suite: LabSuite }) {
  const h = useHive((s) => s.labHistory[suite.id])
  const load = useHive((s) => s.loadLabHistory)
  const [err, setErr] = useState<string | null>(null)
  const now = useNow(30_000)
  useEffect(() => {
    load(suite.id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load history'))
  }, [load, suite.id])

  const rows = useMemo<Row[]>(() => {
    if (!h) return []
    const example = new Set(h.runs.filter((r) => r.demo === 'example').map((r) => r.id))
    const runs = h.runs.filter((r) => r.status !== 'cancelled')
    const builtin: Row[] = [
      {
        key: '__duration',
        group: 'Run',
        name: 'run duration',
        unit: 'ms',
        better: 'lower',
        target: null,
        formerly: [],
        points: runs.filter((r) => r.duration_ms != null).map((r) => ({ key: r.id, at: r.started_at, value: r.duration_ms!, ok: null, example: example.has(r.id) })),
      },
      {
        key: '__passed',
        group: 'Run',
        name: 'cases passed',
        unit: '',
        better: 'higher',
        target: null,
        formerly: [],
        points: runs.map((r) => ({ key: r.id, at: r.started_at, value: r.passed, ok: r.failed + r.errors ? false : null, example: example.has(r.id) })),
      },
    ]
    const metrics = h.metrics.map<Row>((m) => ({
      key: `${m.case_id}::${m.metric}`,
      group: m.case,
      name: m.metric,
      unit: m.unit,
      better: m.better,
      target: m.target,
      formerly: formerNames([{ name: m.metric, legacy_names: m.legacy_names }, ...m.points.map((p) => ({ name: m.metric, renamed_from: p.renamed_from }))], m.metric),
      points: m.points.map((p) => ({ key: p.run_id, at: p.at, value: p.value, ok: p.ok, example: example.has(p.run_id) })),
    }))
    return [...metrics, ...builtin]
  }, [h])

  const [pick, setPick] = useState<string | null>(null)
  const selected = rows.find((r) => r.key === pick) ?? rows.find((r) => r.target != null) ?? rows.find((r) => r.key === '__duration') ?? rows[0]
  const groups = useMemo(() => {
    const out = new Map<string, Row[]>()
    for (const r of rows) out.set(r.group, [...(out.get(r.group) ?? []), r])
    return [...out.entries()]
  }, [rows])

  if (err && !h) return <ErrorState title="Could not load history" body={err} onRetry={() => (setErr(null), void load(suite.id))} />
  if (!h) return <Skeleton className="h-80 w-full rounded-[20px]" />
  const runsNewest = [...h.runs].reverse()
  const pts = selected?.points ?? []
  const latest = pts[pts.length - 1]
  const first = pts[0]
  const misses = pts.filter((p) => p.ok === false).length
  const delta = latest && first && pts.length > 1 && first.value !== 0 ? (latest.value - first.value) / Math.abs(first.value) : null
  const improving = delta == null || !selected?.better || selected.better === 'equal' ? null : selected.better === 'lower' ? delta < 0 : delta > 0

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]" data-tour="lab-history">
        <Card
          title={selected ? `${selected.group === 'Run' ? '' : `${labText(selected.group)} · `}${labText(selected.name)}` : 'History'}
          subtitle={selected ? `${plural(pts.length, 'run')}, oldest to newest${selected.better ? ` · ${BETTER_TEXT[selected.better]}` : ''}${targetText({ better: selected.better ?? 'lower', target: selected.target, unit: selected.unit }) ? ` · target ${targetText({ better: selected.better ?? 'lower', target: selected.target, unit: selected.unit })}` : ''}` : undefined}
        >
          {selected && (
            <>
              <dl className="mb-3 grid grid-cols-3 gap-2">
                <Stat label="Latest" value={latest ? fmtValue(latest.value, selected.unit) : '–'} />
                <Stat
                  label="Since first run"
                  value={delta == null ? '–' : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}%`}
                  tone={improving == null ? undefined : improving ? 'good' : 'bad'}
                />
                <Stat label="Missed target" value={selected.target == null ? 'no target' : `${misses} of ${pts.length}`} tone={misses ? 'bad' : selected.target != null ? 'good' : undefined} />
              </dl>
              <TrendChart
                points={pts}
                unit={selected.unit}
                target={selected.target}
                better={selected.better}
                label={`${labText(selected.name)} across runs`}
                onPick={(id) => navigate({ name: 'lab', run: id })}
              />
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full border-2 border-[#3987e5] bg-[#3987e5]" /> run
                </span>
                {pts.some((p) => p.example) && (
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full border-2 border-[#3987e5]" /> example history (demo)
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="size-3 rounded-full border-2 border-bad" /> missed its target
                </span>
                {selected.target != null && (
                  <span className="flex items-center gap-1.5">
                    <svg width="16" height="6" aria-hidden="true">
                      <line x1="1" x2="15" y1="3" y2="3" style={{ stroke: 'var(--color-ink)' }} strokeOpacity="0.6" strokeDasharray="4 3" strokeWidth="1.5" />
                    </svg>
                    target, passing side tinted
                  </span>
                )}
              </p>
            </>
          )}
        </Card>
        <Card title="Metrics" subtitle="Pick one to chart it" className="lg:max-h-[460px] lg:overflow-hidden">
          <div className="thin-scroll -mx-2 max-h-[340px] overflow-y-auto px-2 lg:max-h-[370px]">
            {groups.map(([g, list]) => (
              <div key={g} className="mb-2">
                <div className="sticky top-0 z-[1] bg-(--lab-tile) py-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{g}</div>
                {list.map((r) => {
                  const last = r.points[r.points.length - 1]
                  const on = selected?.key === r.key
                  return (
                    <button
                      key={r.key}
                      onClick={() => setPick(r.key)}
                      aria-pressed={on}
                      className={cx('flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] transition-colors', on ? 'bg-white/[0.08] text-ink' : 'text-ink-2 hover:bg-white/[0.04]')}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {labText(r.name)}
                        {r.formerly.length > 0 && <span className="block truncate text-[10.5px] text-ink-4" data-metric-formerly="">{formerlyText(r.formerly)}</span>}
                      </span>
                      <Sparkline values={r.points.map((p) => p.value)} marks={r.points.map((p) => p.ok)} width={56} height={18} color={on ? '#3987e5' : '#9085e9'} />
                      <span className={cx('w-[74px] shrink-0 truncate text-right tabular-nums', last?.ok === false ? 'text-bad' : 'text-ink')}>{last ? fmtValue(last.value, r.unit, { short: true }) : '–'}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Runs" subtitle={`${plural(h.runs.length, 'finished run')}, newest first`}>
        <ul className="-mx-2 divide-y divide-line">
          {runsNewest.map((r) => (
            <li key={r.id}>
              <button onClick={() => navigate({ name: 'lab', run: r.id })} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]">
                <StatusIcon status={r.status} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[13px] text-ink">{new Date(r.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    <span className="text-[12px] text-ink-4">{ago(r.started_at, now)}</span>
                    <DemoChip demo={r.demo} />
                  </span>
                  <Counts run={r} className="mt-0.5" />
                </span>
                <span className="hidden w-20 shrink-0 text-right font-mono text-[11.5px] text-ink-3 sm:block">{r.commit_sha ?? '—'}</span>
                <span className="w-16 shrink-0 text-right text-[12px] text-ink-2 tabular-nums">{fmtDuration(r.duration_ms)}</span>
                <span className="hidden w-12 shrink-0 text-right text-[12px] text-ink-3 tabular-nums md:block">{total(r)}</span>
              </button>
            </li>
          ))}
          {!runsNewest.length && <li className="px-2 py-6 text-center text-[13px] text-ink-3">No finished runs yet. Run the suite to start its history.</li>}
        </ul>
      </Card>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-black/20 px-3 py-2">
      <dt className="truncate text-[11px] text-ink-3">{label}</dt>
      <dd className={cx('mt-0.5 truncate text-[16px] font-semibold tabular-nums', tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-ink')}>{value}</dd>
    </div>
  )
}
