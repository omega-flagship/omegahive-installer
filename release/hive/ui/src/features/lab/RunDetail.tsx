import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LabCase, LabRunSummary, LabSuite } from '../../api/types'
import { cx } from '../../lib/cx'
import { useNow, useReducedMotion } from '../../lib/hooks'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, EmptyState, Segmented, Skeleton } from '../../ui/primitives'
import { SeriesChart } from './charts'
import { DriftBoard } from './Drift'
import { EpistemicBoard } from './Epistemic'
import {
  dimMeta,
  DIM_ORDER,
  filterCases,
  fmtDuration,
  fmtValue,
  groupCases,
  groupSeries,
  labText,
  provenanceChips,
  runProgress,
  seriesTitle,
  STATUS,
  total,
  type CaseFilter,
} from './labUtil'
import { DEMO_LABEL, formerlyText } from './labUtil'
import { aboutSince, stalledFor } from './stallCompare'
import { Card, Counts, DemoChip, MetricTile, StatusChip, StatusIcon } from './parts'

/** The previous finished run of the same suite: how many cases to expect. */
function usePrevious(run: LabRunSummary | undefined): LabRunSummary | null {
  const runs = useHive((s) => s.labRuns)
  return useMemo(() => {
    if (!run) return null
    let best: LabRunSummary | null = null
    for (const r of Object.values(runs)) {
      if (r.suite !== run.suite || r.id === run.id || r.status === 'running' || r.status === 'cancelled' || r.started_at > run.started_at) continue
      if (!best || r.started_at > best.started_at) best = r
    }
    return best
  }, [runs, run])
}

export function RunDetail({ runId, suite, dimension }: { runId: string; suite: LabSuite | undefined; dimension?: string }) {
  const run = useHive((s) => s.labRuns[runId])
  const cases = useHive((s) => s.labCases[runId])
  const loaded = useHive((s) => s.labRunLog[runId] !== undefined)
  const loadRun = useHive((s) => s.loadLabRun)
  const [err, setErr] = useState<string | null>(null)
  const [openIds, setOpen] = useState<Record<string, true>>({})
  const reduced = useReducedMotion()
  useEffect(() => {
    loadRun(runId).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the run'))
  }, [loadRun, runId])

  const prev = usePrevious(run)
  const expected = prev ? total(prev) : null
  const list = cases ?? []
  const openCase = (id: string) => {
    setOpen((o) => ({ ...o, [id]: true }))
    setTimeout(() => document.getElementById(`case-${id}`)?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' }), 80)
  }

  if (!run) return err ? <EmptyState icon="flask" title="No such run" body={err} /> : <Skeleton className="h-60 w-full rounded-[20px]" />
  const running = run.status === 'running'
  return (
    <div className="space-y-3">
      <RunHeader run={run} suite={suite} cases={list.length} expected={expected} list={list} />
      {!loaded && !running && !list.length ? (
        <Skeleton className="h-72 w-full rounded-[20px]" />
      ) : (
        <>
          {run.suite === 'bench-drift' && <DriftBoard cases={list} running={running} expected={expected} onOpenCase={openCase} />}
          {run.suite === 'bench-epistemic' && <EpistemicBoard cases={list} />}
          <CaseList cases={list} running={running} expected={expected} openIds={openIds} setOpen={setOpen} initialDimension={dimension} />
          <RunLog runId={runId} running={running} />
        </>
      )}
    </div>
  )
}

function RunHeader({ run, suite, cases, expected, list }: { run: LabRunSummary; suite: LabSuite | undefined; cases: number; expected: number | null; list: LabCase[] }) {
  const cancel = useHive((s) => s.cancelLab)
  const running = run.status === 'running'
  const now = useNow(running ? 250 : 15_000)
  // demo D3: no new case for far longer than this suite takes reads plainly as stalled, with how long it has been
  const stalled = stalledFor(run, list, suite?.estimate_s ?? 0, now)
  const elapsed = (run.finished_at ? Date.parse(run.finished_at) : now) - Date.parse(run.started_at)
  const p = running ? runProgress(cases, expected, elapsed, suite?.estimate_s ?? 0) : 1
  const color = STATUS[run.status].color
  return (
    <Card tone={run.status === 'passed' ? undefined : color} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StatusIcon status={run.status} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={run.status} />
            <Counts run={run} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
            <time dateTime={run.started_at} title={new Date(run.started_at).toLocaleString()}>
              {new Date(run.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </time>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{running ? `${fmtDuration(elapsed)} elapsed` : fmtDuration(run.duration_ms)}</span>
            {run.commit_sha && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[11.5px] text-ink-2">{run.commit_sha}</span>
              </>
            )}
            <span className="hidden font-mono text-[11px] text-ink-4 sm:inline">{run.id}</span>
            <DemoChip demo={run.demo} />
          </div>
        </div>
        {running && (
          <Button variant="danger" icon="stop" onClick={() => void cancel(run.id)}>
            Cancel
          </Button>
        )}
      </div>
      {stalled != null && (
        <div role="status" data-lab-stalled={run.id} className="mt-3 rounded-xl border border-bad/40 bg-bad/[0.07] px-3 py-2.5 text-[12.5px] leading-snug">
          <p className="font-semibold text-bad">This run looks stalled: no new case for {aboutSince(stalled)}.</p>
          <p className="mt-0.5 text-ink-2">
            The hive still marks it running, but {suite ? `${suite.title} usually takes about ${fmtDuration(suite.estimate_s * 1000)}` : 'it should have finished long ago'}. {cases} case{cases === 1 ? '' : 's'} came in before it stopped. Cancel it to free the suite for a new run.
          </p>
        </div>
      )}
      {running && stalled == null && (
        <div className="mt-3.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-[#7dd3fc]/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label="Run progress">
            <m.div className="h-full rounded-full" initial={false} animate={{ width: `${p * 100}%` }} transition={{ type: 'spring', stiffness: 90, damping: 20 }} style={{ background: 'linear-gradient(90deg, #3987e5, #7dd3fc)', boxShadow: '0 0 12px rgb(125 211 252 / 0.6)' }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3 tabular-nums">
            <span>
              {cases} {expected ? `of ~${expected} ` : ''}case{cases === 1 && !expected ? '' : 's'} in
            </span>
            <span>{suite?.estimate_s ? `estimate ${fmtDuration(suite.estimate_s * 1000)}` : ''}</span>
          </div>
        </div>
      )}
      {run.demo && <p className="mt-2 text-[11.5px] text-ink-4">{DEMO_LABEL[run.demo].title}.</p>}
    </Card>
  )
}

export function CaseList({
  cases,
  running,
  expected,
  openIds,
  setOpen,
  initialDimension,
}: {
  cases: LabCase[]
  running: boolean
  expected: number | null
  openIds: Record<string, true>
  setOpen: React.Dispatch<React.SetStateAction<Record<string, true>>>
  initialDimension?: string
}) {
  const [f, setF] = useState<CaseFilter>({ status: 'all', q: '' })
  const [dim, setDim] = useState<string>(initialDimension ?? 'all')
  const failed = cases.filter((c) => c.status === 'failed' || c.status === 'error').length
  const skipped = cases.filter((c) => c.status === 'skipped').length
  const dims = useMemo(() => {
    const present = new Map<string, number>()
    for (const c of cases) present.set(c.dimension, (present.get(c.dimension) ?? 0) + 1)
    return [...present.entries()].sort((a, b) => DIM_ORDER.indexOf(a[0]) - DIM_ORDER.indexOf(b[0]))
  }, [cases])
  const shown = useMemo(() => filterCases(cases, f).filter((c) => dim === 'all' || c.dimension === dim), [cases, f, dim])
  const groups = useMemo(() => groupCases(shown), [shown])
  const big = cases.length > 60
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const filtering = f.status !== 'all' || !!f.q.trim() || dim !== 'all'

  return (
    <Card title="Cases" subtitle={running ? 'Streaming in as each one finishes' : `${plural(cases.length, 'case')} in ${plural(groups.length, 'group')}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<CaseFilter['status']>
          label="Show cases"
          value={f.status}
          onChange={(status) => setF((x) => ({ ...x, status }))}
          options={[
            { value: 'all', label: `All · ${cases.length}` },
            { value: 'failed', label: failed ? `Failed · ${failed}` : 'Failed' },
            ...(skipped ? [{ value: 'skipped' as const, label: `Skipped · ${skipped}` }] : []),
          ]}
        />
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-shade/25 px-3 focus-within:border-line-2 sm:max-w-xs">
          <Icon name="search" size={16} className="shrink-0 text-ink-4" />
          <input value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} placeholder="Search cases" aria-label="Search cases" className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4" />
          {f.q && (
            <button onClick={() => setF((x) => ({ ...x, q: '' }))} aria-label="Clear search" className="-mr-1 text-ink-4 hover:text-ink">
              <Icon name="x" size={15} />
            </button>
          )}
        </label>
      </div>
      {dims.length > 1 && (
        <div className="no-scrollbar -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1" role="group" aria-label="Filter by dimension">
          {[['all', cases.length] as [string, number], ...dims].map(([d, n]) => {
            const on = dim === d
            const meta = d === 'all' ? null : dimMeta(d)
            return (
              <button
                key={d}
                onClick={() => setDim(d)}
                aria-pressed={on}
                className={cx('inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors', on ? 'border-line-2 bg-tint/[0.09] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}
              >
                {meta && <Icon name={meta.icon} size={13} />}
                {meta?.label ?? 'Every dimension'}
                <span className="text-ink-4 tabular-nums">{n}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className="space-y-2">
        {groups.map((g) => {
          const isCollapsed = collapsed[g.group] ?? (big && !filtering && g.failed === 0)
          return (
            <section key={g.group} className="overflow-hidden rounded-xl border border-line bg-shade/15">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [g.group]: !isCollapsed }))}
                aria-expanded={!isCollapsed}
                className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-tint/[0.03]"
              >
                <Icon name="chevronDown" size={15} className={cx('shrink-0 text-ink-4 transition-transform', isCollapsed && '-rotate-90')} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-2">{labText(g.group) || 'ungrouped'}</span>
                <GroupChips passed={g.passed} failed={g.failed} skipped={g.skipped} />
              </button>
              {!isCollapsed && (
                <ul className="border-t border-line">
                  <AnimatePresence initial={false}>
                    {g.cases.map((c) => (
                      <CaseRow
                        key={c.id}
                        c={c}
                        open={!!openIds[c.id]}
                        onToggle={() =>
                          setOpen((o) => {
                            const next = { ...o }
                            if (next[c.id]) delete next[c.id]
                            else next[c.id] = true
                            return next
                          })
                        }
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </section>
          )
        })}
        {running && (!expected || cases.length < expected) && !filtering && (
          <div className="flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-line px-3 text-[12.5px] text-ink-3">
            <span className="size-2 animate-pulse rounded-full bg-[#7dd3fc]" /> Waiting for the next case…
          </div>
        )}
        {!groups.length && !running && <EmptyState icon="filter" title={cases.length ? 'Nothing matches' : 'No cases'} body={cases.length ? 'Try another filter or search.' : 'This run reported no cases.'} />}
      </div>
    </Card>
  )
}

function GroupChips({ passed, failed, skipped }: { passed: number; failed: number; skipped: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] tabular-nums">
      {failed > 0 && <span className="rounded-full bg-bad/15 px-1.5 py-px font-semibold text-bad">{failed} failed</span>}
      {skipped > 0 && <span className="rounded-full bg-tint/[0.06] px-1.5 py-px text-ink-3">{skipped} skipped</span>}
      <span className="rounded-full bg-good/10 px-1.5 py-px text-good">{passed} passed</span>
    </span>
  )
}

function CaseRow({ c, open, onToggle }: { c: LabCase; open: boolean; onToggle: () => void }) {
  const reduced = useReducedMotion()
  const headline = c.metrics.find((x) => x.target != null) ?? c.metrics[0]
  const chips = provenanceChips(c)
  const ref = useRef<HTMLLIElement>(null)
  const expandable = !!(c.message || c.notes || c.metrics.length || c.series.length)
  return (
    <m.li
      ref={ref}
      id={`case-${c.id}`}
      layout={reduced ? false : 'position'}
      initial={{ opacity: 0, y: reduced ? 0 : 6, backgroundColor: 'rgb(125 211 252 / 0.10)' }}
      animate={{ opacity: 1, y: 0, backgroundColor: 'rgb(125 211 252 / 0)' }}
      transition={{ duration: 0.5 }}
      className="scroll-mt-24 border-b border-line last:border-b-0"
    >
      <button onClick={onToggle} disabled={!expandable} aria-expanded={expandable ? open : undefined} className="flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-tint/[0.03] disabled:cursor-default disabled:hover:bg-transparent">
        <StatusIcon status={c.status} size={18} />
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[13px]', c.status === 'failed' || c.status === 'error' ? 'text-ink' : 'text-ink-2')} title={labText(c.name)}>
            {labText(c.name)}
          </span>
          {c.renamed_from && c.renamed_from !== c.name && <span className="block truncate text-[10.5px] text-ink-4" data-case-formerly="">{formerlyText([c.renamed_from])}</span>}
          {(c.status === 'failed' || c.status === 'error' || c.status === 'skipped') && c.message && !open && (
            <span className={cx('block truncate font-mono text-[11px]', c.status === 'skipped' ? 'text-ink-4' : 'text-bad/90')}>{c.message.split('\n').find((l) => l.trim()) ?? ''}</span>
          )}
        </span>
        {chips.map((t) => (
          <span key={t} className="hidden shrink-0 rounded-md border border-warn/30 bg-warn/10 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-warn uppercase sm:inline">
            {t}
          </span>
        ))}
        {headline && (
          <span className={cx('hidden max-w-[150px] shrink-0 truncate text-[12px] tabular-nums sm:inline', headline.ok === false ? 'text-bad' : 'text-ink-3')} title={labText(headline.name)}>
            {fmtValue(headline.value, headline.unit, { short: true })}
          </span>
        )}
        <span className="w-14 shrink-0 text-right text-[11.5px] text-ink-4 tabular-nums">{fmtDuration(c.duration_ms)}</span>
        <Icon name="chevronDown" size={15} className={cx('shrink-0 text-ink-4 transition-transform', open && 'rotate-180', !expandable && 'opacity-0')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduced ? 0 : 0.22, ease: [0.4, 0, 0.2, 1] }} className="overflow-hidden">
            <CaseDetail c={c} chips={chips} />
          </m.div>
        )}
      </AnimatePresence>
    </m.li>
  )
}

export function CaseDetail({ c, chips }: { c: LabCase; chips: string[] }) {
  const charts = groupSeries(c.series)
  const failing = c.status === 'failed' || c.status === 'error'
  return (
    <div className="space-y-3 px-3 pt-1 pb-4 md:pl-[42px]">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-4">
        <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px">
          <Icon name={dimMeta(c.dimension).icon} size={11} />
          {dimMeta(c.dimension).label}
        </span>
        {chips.map((t) => (
          <span key={t} className="rounded-md border border-warn/30 bg-warn/10 px-1.5 py-px font-semibold tracking-wide text-warn uppercase">
            {t}
          </span>
        ))}
        <span className="truncate font-mono">{c.id}</span>
      </div>
      {c.message && (
        <div>
          <div className={cx('mb-1 text-[11.5px] font-semibold', failing ? 'text-bad' : 'text-ink-3')}>{failing ? 'Failure' : c.status === 'skipped' ? 'Why it was skipped' : 'Message'}</div>
          <pre className={cx('thin-scroll max-h-72 overflow-auto rounded-xl border p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre', failing ? 'border-bad/25 bg-bad/[0.06] text-[#fecdd3]' : 'border-line bg-shade/30 text-ink-2')}>{c.message}</pre>
        </div>
      )}
      {c.notes && <p className="max-w-3xl text-[13px] leading-relaxed text-ink-2">{labText(c.notes)}</p>}
      {c.metrics.length > 0 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {c.metrics.map((mt) => (
            <MetricTile key={mt.name} m={mt} />
          ))}
        </div>
      )}
      {charts.length > 0 && (
        <div className={cx('grid gap-3', charts.length > 1 && 'lg:grid-cols-2')}>
          {charts.map((g) => (
            <figure key={g.map((s) => s.name).join('|')} className="min-w-0 rounded-xl border border-line bg-shade/20 p-3">
              <figcaption className="mb-1 text-[12.5px] font-medium text-ink-2">{g.map((s) => seriesTitle(s.name)).join(' vs ')}</figcaption>
              <SeriesChart series={g} label={`${labText(c.name)}: ${g.map((s) => labText(s.name)).join(', ')}`} />
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}

function RunLog({ runId, running }: { runId: string; running: boolean }) {
  const live = useHive((s) => s.labLogs[runId])
  const stored = useHive((s) => s.labRunLog[runId])
  const [open, setOpen] = useState(running)
  const lines = useMemo(() => [...(live ?? []), ...(stored ? stored.split('\n') : [])].filter((l) => l.trim()), [live, stored])
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines.length, open])
  return (
    <Card>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-9 w-full items-center gap-2 text-left">
        <Icon name="terminal" size={16} className="text-ink-3" />
        <span className="flex-1 text-[14px] font-semibold text-ink">Log</span>
        {running && <span className="flex items-center gap-1.5 text-[11.5px] text-[#7dd3fc]"><span className="size-1.5 animate-pulse rounded-full bg-[#7dd3fc]" /> live</span>}
        <span className="text-[11.5px] text-ink-4 tabular-nums">{plural(lines.length, 'line')}</span>
        <Icon name="chevronDown" size={15} className={cx('text-ink-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <pre ref={ref} className="thin-scroll mt-2 max-h-64 overflow-auto rounded-xl border border-line bg-shade/40 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {lines.length ? lines.map((l, i) => <div key={i}>{l}</div>) : <span className="text-ink-4">{running ? 'Waiting for output…' : 'No log output.'}</span>}
        </pre>
      )}
    </Card>
  )
}
