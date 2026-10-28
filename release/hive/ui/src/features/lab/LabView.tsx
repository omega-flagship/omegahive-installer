import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import type { LabCase, LabRunSummary, LabScorecardEntry, LabSuite } from '../../api/types'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate, useRoute, type LabTab } from '../../lib/router'
import { labHealth } from '../../store/reducer'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState, ErrorState, Segmented, Skeleton } from '../../ui/primitives'
import { Sparkline } from './charts'
import { SuiteHistory } from './History'
import { SuiteCompare } from './Compare'
import { aboutSince, stalledFor } from './stallCompare'
import { BAD, dimMeta, DIM_ORDER, fmtDuration, fmtValue, GOOD, hair, labText, needsText, RUNNING, runProgress, STATUS, total } from './labUtil'
import { Card, Counts, DemoBanner, DemoChip, MetricTile, RunButton, RunStrip, StatusIcon } from './parts'
import { CaseList, RunDetail } from './RunDetail'
import PcFamily from './pc/PcFamily'

const HEALTH_COLOR = { failing: BAD, running: RUNNING, passing: GOOD, unknown: 'var(--color-ink-5)' } as const

/** Runs per suite, oldest first. */
function useRunsBySuite(): Record<string, LabRunSummary[]> {
  const runs = useHive((s) => s.labRuns)
  return useMemo(() => {
    const out: Record<string, LabRunSummary[]> = {}
    for (const r of Object.values(runs)) (out[r.suite] ??= []).push(r)
    for (const k in out) out[k].sort((a, b) => a.started_at.localeCompare(b.started_at))
    return out
  }, [runs])
}

/** The demo's recording date: the earliest real recorded run. */
function useRecordedAt(): string | null {
  const runs = useHive((s) => s.labRuns)
  return useMemo(() => {
    let at: string | null = null
    for (const r of Object.values(runs)) if (r.demo === 'recorded' && (!at || r.started_at < at)) at = r.started_at
    return at
  }, [runs])
}

export default function LabView() {
  const route = useRoute()
  const r = route.name === 'lab' ? route : { name: 'lab' as const }
  const sim = useHive((s) => s.client?.mode === 'sim')
  const suites = useHive((s) => s.labSuites)
  const loaded = useHive((s) => s.labLoaded)
  const loadLab = useHive((s) => s.loadLab)
  const run = useHive((s) => (r.run ? s.labRuns[r.run] : undefined))
  const recordedAt = useRecordedAt()
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    loadLab().catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not reach the Lab'))
  }, [loadLab])

  const suiteId = r.suite ?? run?.suite
  const suite = suites?.find((x) => x.id === suiteId)
  const dim = r.dimension
  const view = r.run ? 'run' : r.suite ? 'suite' : dim ? 'dim' : 'overview'
  const title = view === 'overview' ? 'Lab' : view === 'dim' ? dimMeta(dim!).label : (suite?.title ?? suiteId ?? 'Run')
  const eyebrow = view === 'overview' ? 'Tests & benchmarks' : view === 'dim' ? 'Lab · dimension' : `Lab · ${suite?.kind === 'tests' ? 'Tests' : 'Benchmarks'}`
  const back = view === 'overview' ? undefined : view === 'run' && suiteId ? () => navigate({ name: 'lab', suite: suiteId }) : () => navigate({ name: 'lab' })

  return (
    <Page
      label="Lab"
      eyebrow={eyebrow}
      title={title}
      onClose={() => navigate({ name: 'hive' })}
      onBack={back}
      info="lab"
      actions={suite && view !== 'overview' && suite.last_run?.status !== 'running' ? <RunButton suite={suite} className="mr-1" /> : undefined}
    >
      <div className="mx-auto w-full max-w-[1280px] px-3 pb-[calc(var(--sab)+96px)] md:px-6 md:pb-10">
        {sim && <DemoBanner recordedAt={recordedAt} />}
        {!loaded && err ? (
          <ErrorState title="The Lab is not available" body={`${err}. This hive may be older than the Lab API.`} onRetry={() => (setErr(null), void loadLab().catch(() => undefined))} />
        ) : !suites ? (
          <div className="space-y-3">
            <Skeleton className="h-44 w-full rounded-[20px]" />
            <div className="grid gap-3 md:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-36 rounded-[20px]" />
              ))}
            </div>
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <m.div key={`${view}-${r.suite ?? r.run ?? dim ?? ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {view === 'overview' && <Overview suites={suites} />}
              {view === 'dim' && <DimensionView dimension={dim!} suites={suites} />}
              {view === 'suite' && (suite ? <SuiteView suite={suite} tab={r.tab ?? 'run'} /> : <EmptyState icon="flask" title="No such suite" body={`The Lab has no suite called ${r.suite}.`} />)}
              {view === 'run' && <RunView runId={r.run!} suite={suite} />}
            </m.div>
          </AnimatePresence>
        )}
      </div>
    </Page>
  )
}

// ---------------------------------------------------------------- overview

function Overview({ suites }: { suites: LabSuite[] }) {
  const bySuite = useRunsBySuite()
  return (
    <div className="space-y-6">
      <Scorecard suites={suites} />
      {(['tests', 'bench'] as const).map((kind) => {
        const list = suites.filter((x) => x.kind === kind)
        if (!list.length) return null
        return (
          <section key={kind} aria-labelledby={`lab-${kind}`}>
            <div className="mb-2.5 flex items-baseline gap-2 px-1">
              <h2 id={`lab-${kind}`} className="eyebrow">
                {kind === 'tests' ? 'Tests' : 'Benchmarks'}
              </h2>
              <span className="text-[12px] text-ink-4">{plural(list.length, 'suite')}</span>
            </div>
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((x) => (
                <SuiteCard key={x.id} suite={x} runs={bySuite[x.id] ?? []} />
              ))}
            </ul>
          </section>
        )
      })}
      {/* the predictive-coding family: its own bands, read from OmegaEvolve; never counted in the scorecard above */}
      <PcFamily />
    </div>
  )
}

function Scorecard({ suites }: { suites: LabSuite[] }) {
  const card = useHive((s) => s.labScorecard)
  const queue = useHive((s) => s.labQueue)
  const runAll = useHive((s) => s.runAllLab)
  const stopQueue = useHive((s) => s.stopLabQueue)
  const now = useNow(30_000)
  const h = labHealth(suites)
  const runnable = suites.filter((x) => x.runnable).length
  const running = suites.filter((x) => x.last_run?.status === 'running')
  const last = suites.reduce<string | null>((acc, x) => {
    const at = x.last_run?.finished_at ?? x.last_run?.started_at ?? null
    return at && (!acc || at > acc) ? at : acc
  }, null)
  const casesPassed = suites.reduce((n, x) => n + (x.last_run?.passed ?? 0), 0)
  const casesTotal = suites.reduce((n, x) => n + (x.last_run ? total(x.last_run) : 0), 0)
  const casesFailed = suites.reduce((n, x) => n + (x.last_run ? x.last_run.failed + x.last_run.errors : 0), 0)
  const color = HEALTH_COLOR[h.state]
  const frac = h.ran ? h.passing / h.ran : 0
  const busy = queue.length > 0 || running.length > 0

  const entries = useMemo(() => {
    const byDim = new Map((card ?? []).map((e) => [e.dimension, e]))
    const dims = [...DIM_ORDER, ...[...byDim.keys()].filter((d) => !DIM_ORDER.includes(d))]
    return dims.map((d) => ({ d, e: byDim.get(d) ?? null }))
  }, [card])

  return (
    <section aria-label="Scorecard" className="space-y-3">
      <Card className="overflow-hidden" tour="lab-scorecard">
        <div className="pointer-events-none absolute -top-28 -right-10 size-80 rounded-full opacity-50" style={{ background: `radial-gradient(circle, color-mix(in srgb, ${color} 20%, transparent), transparent 70%)` }} />
        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="flex items-center gap-4">
            <HealthRing frac={frac} color={color} label={h.ran ? `${Math.round(frac * 100)}%` : '–'} />
            <div>
              <div className="font-display text-[22px] leading-tight font-semibold tracking-tight">
                {h.state === 'unknown' ? 'Nothing has run yet' : h.passing === h.ran ? `All ${h.ran} suites passing` : `${h.passing} of ${h.ran} suites passing`}
              </div>
              <div className="mt-1 text-[13px] text-ink-3">
                {running.length ? `${running.map((x) => x.title).join(', ')} running now` : last ? `Last finished ${ago(last, now)}` : 'Run a suite to see its health here'}
                {h.ran < h.total ? ` · ${h.total - h.ran} never run` : ''}
              </div>
            </div>
          </div>
          <dl className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:min-w-[300px] sm:flex-1">
            <Figure label="Cases passing" value={`${casesPassed}`} sub={`of ${casesTotal}`} />
            <Figure label="Failing now" value={String(casesFailed)} tone={casesFailed ? 'bad' : 'good'} />
            <Figure label="Runnable here" value={String(runnable)} sub={`of ${plural(suites.length, 'suite')}`} />
          </dl>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {queue.length > 0 ? (
              <Button variant="ghost" icon="stop" onClick={stopQueue} className="w-full sm:w-auto">
                Stop after this one · {queue.length} queued
              </Button>
            ) : (
              <Button variant="primary" icon="play" onClick={() => void runAll()} disabled={busy || !runnable} className="w-full sm:w-auto" title="Runs every runnable suite one after another, tests first">
                {busy ? 'Running…' : 'Run everything'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5" aria-label="Health by dimension" data-tour="lab-dims">
        {entries.map(({ d, e }) => (
          <DimensionTile key={d} d={d} e={e} suites={suites} />
        ))}
      </ul>
    </section>
  )
}

function HealthRing({ frac, color, label }: { frac: number; color: string; label: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <span className="relative inline-flex size-[76px] shrink-0 items-center justify-center" role="img" aria-label={`Health ${label}`}>
      <svg width="76" height="76" className="-rotate-90" aria-hidden="true">
        <circle cx="38" cy="38" r={r} fill="none" strokeWidth="6" style={{ stroke: hair(8) }} />
        <m.circle cx="38" cy="38" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - frac) }} transition={{ type: 'spring', stiffness: 60, damping: 18 }} style={{ stroke: color, filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} 53%, transparent))` }} />
      </svg>
      <span className="absolute font-display text-[17px] font-semibold tabular-nums">{label}</span>
    </span>
  )
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-black/20 px-3 py-2">
      <dt className="truncate text-[11px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1">
        <span className={cx('font-display text-[20px] leading-none font-semibold tabular-nums', tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-ink')}>{value}</span>
        {sub && <span className="truncate text-[11px] text-ink-4">{sub}</span>}
      </dd>
    </div>
  )
}

function DimensionTile({ d, e, suites }: { d: string; e: LabScorecardEntry | null; suites: LabSuite[] }) {
  const meta = dimMeta(d)
  const judged = e ? e.passed + e.failed + e.errors : 0
  const tone = !e || e.score == null ? undefined : e.score >= 1 ? GOOD : BAD
  const from = meta.sources.map((id) => suites.find((x) => x.id === id)).filter((x): x is LabSuite => !!x)
  const blocked = from.length > 0 && from.every((x) => !x.runnable)
  const empty = !e || e.passed + e.failed + e.errors + e.skipped === 0
  const reason = !empty
    ? null
    : blocked
      ? `Needs ${needsText([...new Set(from.flatMap((x) => x.missing))])}`
      : from.length
        ? `Run ${from.map((x) => x.title).join(' or ')}`
        : 'No suite measures this yet'
  const top = (e?.highlights ?? []).slice(0, 2)
  return (
    <li data-tour={`lab-dim-${d}`}>
      <button
        onClick={() => navigate({ name: 'lab', dimension: d })}
        className={cx('group relative flex h-full min-h-[132px] w-full flex-col rounded-2xl border p-3 text-left transition-colors hover:border-line-2', empty && 'opacity-80')}
        style={{
          background: empty ? `repeating-linear-gradient(135deg, ${hair(1.8)} 0 6px, transparent 6px 12px), var(--lab-tile-empty)` : 'var(--lab-tile)',
          borderColor: tone ? `color-mix(in srgb, ${tone} 26%, transparent)` : undefined,
        }}
        aria-label={`${meta.label}: ${e?.score != null ? `${Math.round(e.score * 100)}%` : 'not measured'}${reason ? `, ${reason}` : ''}`}
      >
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
          <Icon name={meta.icon} size={14} className="text-ink-3" />
          <span className="flex-1 truncate">{meta.label}</span>
          <Icon name="chevron" size={13} className="text-ink-4 transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1.5 flex items-baseline gap-1.5">
          <span className="font-display text-[26px] leading-none font-semibold tabular-nums" style={{ color: tone ?? 'var(--color-ink-4)' }}>
            {e?.score != null ? `${Math.round(e.score * 100)}%` : '–'}
          </span>
          {e && judged > 0 && (
            <span className="text-[11px] text-ink-3 tabular-nums">
              {e.passed}/{judged}
              {e.skipped ? ` · ${e.skipped} skipped` : ''}
            </span>
          )}
        </span>
        {reason ? (
          <span className="mt-auto pt-2 text-[11.5px] leading-snug text-ink-4">{reason}</span>
        ) : (
          <span className="mt-auto space-y-0.5 pt-2">
            {top.length ? (
              top.map((h) => (
                <span key={`${h.case}-${h.name}`} className="flex items-baseline gap-1 text-[11px]">
                  <Icon name={h.ok === false ? 'x' : 'check'} size={10} strokeWidth={3} className={cx('shrink-0 self-center', h.ok === false ? 'text-bad' : 'text-good')} />
                  <span className="min-w-0 flex-1 truncate text-ink-3" title={`${labText(h.case)}: ${labText(h.name)}`}>
                    {labText(h.name)}
                  </span>
                  <span className="shrink-0 text-ink-2 tabular-nums">{fmtValue(h.value, h.unit, { short: true })}</span>
                </span>
              ))
            ) : (
              <span className="text-[11px] text-ink-4">{meta.blurb}</span>
            )}
          </span>
        )}
      </button>
    </li>
  )
}

function SuiteCard({ suite, runs }: { suite: LabSuite; runs: LabRunSummary[] }) {
  const last = suite.last_run
  const now = useNow(last?.status === 'running' ? 500 : 30_000)
  const finished = runs.filter((r) => r.status !== 'running')
  const running = last?.status === 'running'
  const cases = useHive((s) => (last ? (s.labCases[last.id]?.length ?? total(last)) : 0))
  // demo D3: a running run that has made no progress for a long while reads as stalled (its cases are read once for it)
  const caseList = useHive((s) => (last ? s.labCases[last.id] : undefined))
  const loadRun = useHive((s) => s.loadLabRun)
  useEffect(() => {
    if (running && last && !caseList && total(last) > 0) void loadRun(last.id).catch(() => undefined)
  }, [running, last, caseList, loadRun])
  const stalled = running && last && (caseList || total(last) === 0) ? stalledFor(last, caseList ?? [], suite.estimate_s, now) : null
  const prev = finished[finished.length - 1]
  const p = running && last ? runProgress(cases, prev ? total(prev) : null, now - Date.parse(last.started_at), suite.estimate_s) : 0
  const tone = !last ? undefined : last.status === 'failed' || last.status === 'error' || stalled != null ? BAD : running ? RUNNING : undefined
  return (
    <li>
      <article
        className="group relative flex h-full flex-col rounded-[20px] border p-4 transition-colors hover:border-line-2"
        style={{ background: 'var(--lab-tile)', borderColor: tone ? `color-mix(in srgb, ${tone} 32%, transparent)` : 'var(--color-line)' }}
      >
        <button className="absolute inset-0 rounded-[20px]" onClick={() => navigate({ name: 'lab', suite: suite.id })} aria-label={`Open ${suite.title}`} />
        <header className="pointer-events-none relative flex items-start gap-3">
          {last ? <StatusIcon status={last.status} size={28} /> : <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-line-2 text-ink-4"><Icon name="flask" size={14} /></span>}
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-display text-[15.5px] font-semibold tracking-tight">{suite.title}</h3>
            <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-3">{labText(suite.description)}</p>
          </div>
          <div className="pointer-events-auto relative">
            <RunButton suite={suite} size="sm" />
          </div>
        </header>
        <div className="pointer-events-none relative mt-auto pt-3">
          {stalled != null ? (
            <div data-lab-stalled={last!.id} data-tour="lab-stalled">
              <div className="text-[12.5px] font-semibold text-bad">Stalled</div>
              <div className="mt-0.5 text-[11.5px] text-ink-3 tabular-nums">
                No new case for {aboutSince(stalled)} · {cases}
                {prev ? `/${total(prev)}` : ''} cases in · still marked running
              </div>
              <DemoChip demo={last!.demo} />
            </div>
          ) : running ? (
            <div>
              <div className="h-1 overflow-hidden rounded-full bg-(--lab-running)/15">
                <m.div className="h-full rounded-full bg-(--lab-running)" initial={false} animate={{ width: `${p * 100}%` }} transition={{ type: 'spring', stiffness: 90, damping: 20 }} style={{ boxShadow: '0 0 10px rgb(125 211 252 / 0.7)' }} />
              </div>
              <div className="mt-1.5 flex justify-between text-[11.5px] text-(--lab-running) tabular-nums">
                <span>
                  Running · {cases}
                  {prev ? `/${total(prev)}` : ''} cases
                </span>
                <span className="text-ink-3">{fmtDuration(now - Date.parse(last!.started_at))}</span>
              </div>
            </div>
          ) : last ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Counts run={last} />
              <span className="text-[11.5px] text-ink-4 tabular-nums">
                {fmtDuration(last.duration_ms)} · {ago(last.finished_at ?? last.started_at, now)}
              </span>
              <DemoChip demo={last.demo} />
            </div>
          ) : (
            <div className="text-[12px] text-ink-4">{suite.runnable ? `Never run · about ${fmtDuration(suite.estimate_s * 1000)}` : `Needs ${needsText(suite.missing)}`}</div>
          )}
          {finished.length > 0 && (
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <RunStrip runs={finished} />
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-4" title="Run duration across runs">
                duration
                <Sparkline values={finished.map((r) => r.duration_ms ?? 0)} width={64} height={18} />
              </span>
            </div>
          )}
          {!suite.runnable && last && <div className="mt-2 text-[11.5px] text-ink-4">Can’t run here: needs {needsText(suite.missing)}</div>}
        </div>
      </article>
    </li>
  )
}

// ---------------------------------------------------------------- suite + run

function SuiteView({ suite, tab }: { suite: LabSuite; tab: LabTab }) {
  const bySuite = useRunsBySuite()
  const runs = bySuite[suite.id] ?? []
  const latest = runs[runs.length - 1]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-80 text-[13px] leading-relaxed text-ink-3">
          {labText(suite.description)}
          {!suite.runnable && <span className="text-warn"> Can’t run here: needs {needsText(suite.missing)}.</span>}
        </p>
        <Segmented<LabTab>
          label="Suite section"
          tour="lab-suite-tab"
          value={tab}
          onChange={(t) => navigate({ name: 'lab', suite: suite.id, tab: t }, { replace: true })}
          options={[
            { value: 'run', label: latest?.status === 'running' ? 'Live run' : 'Latest run' },
            { value: 'history', label: `History · ${runs.filter((r) => r.status !== 'running').length}` },
            { value: 'compare', label: 'Compare' },
          ]}
        />
      </div>
      {tab === 'history' ? (
        <SuiteHistory suite={suite} />
      ) : tab === 'compare' ? (
        <SuiteCompare suite={suite} />
      ) : latest ? (
        <RunDetail key={latest.id} runId={latest.id} suite={suite} />
      ) : (
        <Card>
          <EmptyState icon="flask" title="Not run yet" body={suite.runnable ? `Run it to see every case stream in. It takes about ${fmtDuration(suite.estimate_s * 1000)}.` : `It needs ${needsText(suite.missing)}.`} action={<RunButton suite={suite} />} />
        </Card>
      )}
    </div>
  )
}

function RunView({ runId, suite }: { runId: string; suite: LabSuite | undefined }) {
  const bySuite = useRunsBySuite()
  const runs = suite ? (bySuite[suite.id] ?? []) : []
  const latest = runs[runs.length - 1]
  return (
    <div className="space-y-3">
      {latest && latest.id !== runId && (
        <button onClick={() => navigate({ name: 'lab', suite: suite!.id })} className="flex min-h-11 w-full items-center gap-2 rounded-2xl border border-line bg-white/[0.025] px-3.5 text-left text-[13px] text-ink-2 hover:border-line-2">
          <Icon name="history" size={16} className="text-ink-3" />
          <span className="flex-1">This is an earlier run.</span>
          <span className="font-medium text-accent">Latest run</span>
          <Icon name="chevron" size={14} className="text-accent" />
        </button>
      )}
      <RunDetail key={runId} runId={runId} suite={suite} />
    </div>
  )
}

// ---------------------------------------------------------------- dimension

/** Every case of one dimension, from the latest finished run of each suite that measures it. */
function DimensionView({ dimension, suites }: { dimension: string; suites: LabSuite[] }) {
  const meta = dimMeta(dimension)
  const card = useHive((s) => s.labScorecard?.find((e) => e.dimension === dimension) ?? null)
  const bySuite = useRunsBySuite()
  const allCases = useHive((s) => s.labCases)
  const loadRun = useHive((s) => s.loadLabRun)
  const latest = useMemo(
    () =>
      (card?.suites.length ? card.suites : dimMeta(dimension).sources)
        .map((id) => {
          const finished = (bySuite[id] ?? []).filter((r) => r.status !== 'running' && r.status !== 'cancelled')
          return { suite: suites.find((x) => x.id === id), run: finished[finished.length - 1] }
        })
        .filter((x): x is { suite: LabSuite; run: LabRunSummary } => !!x.suite && !!x.run),
    [card, dimension, bySuite, suites],
  )
  useEffect(() => {
    for (const { run } of latest) if (!useHive.getState().labRunLog[run.id]) void loadRun(run.id).catch(() => undefined)
  }, [latest, loadRun])
  const [open, setOpen] = useState<Record<string, true>>({})
  const judged = card ? card.passed + card.failed + card.errors : 0

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-black/25 text-ink-2">
            <Icon name={meta.icon} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[30px] leading-none font-semibold tabular-nums" style={{ color: card?.score == null ? 'var(--color-ink-4)' : card.score >= 1 ? GOOD : BAD }}>
                {card?.score != null ? `${Math.round(card.score * 100)}%` : '–'}
              </span>
              {card && <Counts run={card} />}
            </div>
            <p className="mt-1 text-[13px] text-ink-3">{meta.blurb}. From the latest finished run of {latest.length ? latest.map((x) => x.suite.title).join(', ') : 'no suite yet'}.</p>
          </div>
        </div>
        {card && card.highlights.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            {card.highlights.map((h) => (
              <div key={`${h.suite}-${h.case}-${h.name}`} className="min-w-0">
                <MetricTile m={h} />
                <div className="mt-1 truncate px-1 text-[10.5px] text-ink-4" title={`${labText(h.case)} · ${labText(h.suite)}`}>
                  {labText(h.case)}
                </div>
              </div>
            ))}
          </div>
        )}
        {!judged && !card?.skipped && (
          <p className="mt-3 rounded-xl border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-4">
            Nothing measured this yet. {meta.sources.length ? `It comes from ${meta.sources.map((id) => suites.find((x) => x.id === id)?.title ?? id).join(' and ')}.` : ''}
          </p>
        )}
      </Card>
      {latest.map(({ suite, run }) => {
        const cases: LabCase[] = (allCases[run.id] ?? []).filter((c) => c.dimension === dimension)
        return (
          <div key={run.id}>
            <div className="mb-1.5 flex items-center gap-2 px-1">
              <StatusIcon status={run.status} size={18} />
              <button onClick={() => navigate({ name: 'lab', run: run.id })} className="min-h-9 truncate text-[13px] font-semibold text-ink hover:text-accent">
                {suite.title}
              </button>
              <DemoChip demo={run.demo} />
              <span className="ml-auto text-[11.5px] text-ink-4">{STATUS[run.status].label}</span>
            </div>
            {allCases[run.id] ? <CaseList cases={cases} running={false} expected={null} openIds={open} setOpen={setOpen} /> : <Skeleton className="h-32 w-full rounded-[20px]" />}
          </div>
        )
      })}
    </div>
  )
}
