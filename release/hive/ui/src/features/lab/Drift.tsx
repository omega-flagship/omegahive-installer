import { useEffect, useMemo, useState } from 'react'
import type { LabCase, LabSeries } from '../../api/types'
import { cx } from '../../lib/cx'
import { Icon } from '../../ui/Icon'
import { SeriesChart, type ChartSeries } from './charts'
import { BAD, caseKey, codedLabels, GOOD, findMetric, findSeries, fmtValue, labText, parseEvents, SLOTS, STATUS } from './labUtil'
import { Card, StatusIcon } from './parts'

interface Readout {
  label: string
  value: string
  /** A guard reading that must stay at zero. */
  leak?: boolean
  bad?: boolean
}
interface ChartSpec {
  series: ChartSeries[]
  /** The series the scrubber walks. */
  primary: LabSeries
  xLabels?: Record<number, string>
  yLabels?: Record<number, string>
  marker?: { x: number; label: string }
  readout: (i: number) => Readout[]
  events?: string[]
}
interface Gauge {
  label: string
  tried: number
  got: number
  cap: number
}
interface Spec {
  verdict: (c: LabCase) => string
  chart?: (c: LabCase) => ChartSpec | null
  gauges?: (c: LabCase) => Gauge[]
  /** Corroboration is the control: real evidence must still count. */
  control?: boolean
}

const v = (c: LabCase, name: string) => findMetric(c, name)?.value
const f2 = (n: number | undefined) => (n == null ? '–' : n.toFixed(2))

/**
 * One plain-language verdict and one picture per scenario in hive/bench/benchmarks.py.
 * Every number comes from the case's metrics and series.
 */
const DRIFT: Record<string, Spec> = {
  echo_storm: {
    verdict: (c) => {
      const s = findSeries(c, 'commons confidence')
      const start = s?.points[0]?.[1]
      const naive = v(c, 'naive inflation avoided')
      return `${v(c, 'echoes absorbed') ?? '?'} echoes absorbed and confidence held at ${f2(start)}. Naive revision would have pushed it to ${f2(start != null && naive != null ? start + naive : undefined)}.`
    },
    chart: (c) => {
      const s = findSeries(c, 'commons confidence')
      const n = findSeries(c, 'naive revision')
      if (!s) return null
      const c0 = s.points[0]?.[1] ?? 0
      return {
        series: [s, ...(n ? [n] : [])],
        primary: s,
        readout: (i) => {
          const [x, y] = s.points[i]
          const naive = n?.points[i]?.[1]
          return [
            { label: 'echoes', value: String(x) },
            { label: 'commons c', value: y.toFixed(3) },
            ...(naive != null ? [{ label: 'naive c', value: naive.toFixed(3) }] : []),
            { label: 'confidence leaked', value: (y - c0).toFixed(3), leak: true, bad: y - c0 > 1e-9 },
          ]
        },
      }
    },
  },
  corroboration: {
    control: true,
    verdict: (c) => {
      const s = findSeries(c, 'commons confidence')
      const err = v(c, 'error vs NAL')
      return `${s?.points.length ?? '?'} independent sources raised confidence to ${f2(v(c, 'final confidence'))}, ${err === 0 ? 'exactly' : `within ${fmtValue(err ?? NaN)} of`} what NAL predicts. The echo guard does not block real evidence.`
    },
    chart: (c) => {
      const s = findSeries(c, 'commons confidence')
      if (!s?.points.length) return null
      // NAL revision of n independent, equal reports: w = n·w₁, c = w / (w + 1); computed here as the reference
      const c1 = s.points[0][1]
      const w1 = c1 / (1 - c1)
      const model: ChartSeries = { name: 'NAL prediction', unit: '', kind: 'line', x: s.x, points: s.points.map(([x]) => [x, (x * w1) / (x * w1 + 1)]), dashed: true, color: SLOTS[1] }
      return {
        series: [s, model],
        primary: s,
        readout: (i) => {
          const [x, y] = s.points[i]
          return [
            { label: 'sources', value: String(x) },
            { label: 'commons c', value: y.toFixed(3) },
            { label: 'NAL c', value: model.points[i][1].toFixed(3) },
            { label: 'gap', value: Math.abs(y - model.points[i][1]).toFixed(4), bad: Math.abs(y - model.points[i][1]) > 1e-5 },
          ]
        },
      }
    },
  },
  self_repetition: {
    verdict: (c) => {
      const s = findSeries(c, 'confidence')
      return `Said ${s?.points.length ?? '?'} times by one mind; confidence stayed at ${f2(s?.points[0]?.[1])}. Repeating yourself is not evidence.`
    },
    chart: (c) => {
      const s = findSeries(c, 'confidence')
      if (!s?.points.length) return null
      const c0 = s.points[0][1]
      return {
        series: [s],
        primary: s,
        readout: (i) => [
          { label: 'repeats', value: String(s.points[i][0]) },
          { label: 'confidence', value: s.points[i][1].toFixed(3) },
          { label: 'drift', value: (s.points[i][1] - c0).toFixed(3), leak: true, bad: s.points[i][1] - c0 > 1e-9 },
        ],
      }
    },
  },
  retry_storm: {
    verdict: (c) => `The calls-per-minute ceiling served ${v(c, 'calls served') ?? '?'} calls and refused the other ${v(c, 'calls refused') ?? '?'}: a stuck loop cannot hammer the model.`,
    chart: (c) => {
      const s = findSeries(c, 'calls served')
      const cap = findMetric(c, 'calls served')?.target
      if (!s?.points.length) return null
      const last = s.points[s.points.length - 1][0]
      const ceiling: ChartSeries | null = cap != null ? { name: `ceiling (${cap} a minute)`, unit: '', kind: 'line', x: s.x, points: [[s.points[0][0], cap], [last, cap]], dashed: true, color: '#b9b8dc' } : null
      return {
        series: [s, ...(ceiling ? [ceiling] : [])],
        primary: s,
        readout: (i) => {
          const [x, y] = s.points[i]
          return [
            { label: 'attempts', value: String(x) },
            { label: 'served', value: String(y) },
            { label: 'refused', value: String(x - y) },
            { label: 'over ceiling', value: String(Math.max(0, y - (cap ?? Infinity))), leak: true, bad: cap != null && y > cap },
          ]
        },
      }
    },
  },
  spend_runaway: {
    verdict: (c) => {
      const budget = findMetric(c, 'spent')?.target
      const first = v(c, 'first refusal at call')
      return `Refused from call ${first ?? '?'} on. It spent ${fmtValue(v(c, 'spent') ?? NaN, '$')} of a ${fmtValue(budget ?? NaN, '$')} budget and never went over: each call's worst case is reserved first.`
    },
    chart: (c) => {
      const s = findSeries(c, 'spent')
      const b = findSeries(c, 'budget')
      const budget = findMetric(c, 'spent')?.target ?? b?.points[0]?.[1]
      const first = v(c, 'first refusal at call')
      if (!s?.points.length) return null
      return {
        series: [s, ...(b ? [{ ...b, dashed: true, color: '#b9b8dc' }] : [])],
        primary: s,
        marker: first ? { x: first, label: 'refused from here' } : undefined,
        readout: (i) => {
          const [x, y] = s.points[i]
          return [
            { label: 'call', value: String(x) },
            { label: 'spent', value: fmtValue(y, '$') },
            { label: 'status', value: first && x >= first ? 'refused' : 'served' },
            { label: 'over budget', value: fmtValue(Math.max(0, y - (budget ?? Infinity)), '$'), leak: true, bad: budget != null && y > budget + 1e-9 },
          ]
        },
      }
    },
  },
  abandoned_goal: {
    verdict: (c) => {
      const failing = c.metrics.filter((m) => m.ok === false).map((m) => labText(m.name))
      return failing.length
        ? `Missed: ${failing.join(', ')}.`
        : 'The silent mind’s lease lapsed, the task went back to the swarm and a second mind finished it. Waiting on a person kept the claim; an impossible task stalled after 3 lapses instead of looping.'
    },
    chart: (c) => {
      // the host serves 'task state (…)' since host-wording r1 (old runs too); the recorded sim fixture still says 'goal state (…)'
      const s = c.series.find((x) => x.name.startsWith('task state') || x.name.startsWith('goal state'))
      if (!s?.points.length) return null
      const events = parseEvents(c.notes)?.map((e) => labText(e.label))
      const coded = codedLabels(s.name) ?? undefined
      const yLabels: Record<number, string> | undefined = coded ? { ...coded, 3: coded[3] ?? 'stalled' } : undefined
      return {
        series: [{ ...s, name: 'task state' }],
        primary: s,
        yLabels,
        xLabels: Object.fromEntries(s.points.map(([x]) => [x, String(x + 1)])),
        events,
        readout: (i) => [
          { label: 'event', value: `${i + 1}. ${events?.[i] ?? ''}` },
          { label: 'state', value: yLabels?.[s.points[i][1]] ?? String(s.points[i][1]) },
        ],
      }
    },
  },
  subgoal_explosion: {
    verdict: (c) => `Splitting stopped at ${v(c, 'subgoals accepted') ?? '?'} subtasks wide and ${v(c, 'depth reached') ?? '?'} levels deep, however hard the mind pushed.`,
    // attempts as driven by benchmarks.py: 100 splits of one task, then nesting 10 deep
    gauges: (c) => [
      { label: 'Subtasks under one task', tried: 100, got: v(c, 'subgoals accepted') ?? 0, cap: findMetric(c, 'subgoals accepted')?.target ?? 12 },
      { label: 'Nesting depth', tried: 10, got: v(c, 'depth reached') ?? 0, cap: findMetric(c, 'depth reached')?.target ?? 3 },
    ],
  },
  refusals: {
    verdict: (c) => (c.metrics.every((m) => m.ok !== false) ? 'A paid model with no budget, and a model with no price, were both refused before any money moved.' : `Not refused: ${c.metrics.filter((m) => m.ok === false).map((m) => labText(m.name)).join(', ')}.`),
  },
}

const fallbackVerdict = (c: LabCase) => {
  const failing = c.metrics.filter((m) => m.ok === false)
  if (c.status === 'error') return 'The scenario crashed before it could measure anything.'
  if (failing.length) return `Missed ${failing.map((m) => labText(m.name)).join(', ')}.`
  const guards = c.metrics.filter((m) => m.ok !== null).length
  return guards ? `All ${guards} guard${guards === 1 ? '' : 's'} held.` : c.status === 'passed' ? 'Passed.' : STATUS[c.status].label
}

function verdictOf(c: LabCase): string {
  if (c.status === 'error') return 'The scenario crashed before it could measure anything.'
  try {
    return (DRIFT[caseKey(c)]?.verdict ?? fallbackVerdict)(c)
  } catch {
    return fallbackVerdict(c)
  }
}

/** Every guard reading across the drift run; a leak is any guard that missed. */
function leaks(cases: LabCase[]) {
  let breached = 0
  let held = 0
  for (const c of cases) {
    for (const m of c.metrics) {
      if (m.ok === false) breached++
      else if (m.ok) held++
    }
    if (c.status === 'error') breached++
  }
  return { breached, held }
}

export function DriftBoard({ cases, running, expected, onOpenCase }: { cases: LabCase[]; running: boolean; expected: number | null; onOpenCase: (id: string) => void }) {
  const { breached, held } = leaks(cases)
  const zero = breached === 0
  const color = zero ? GOOD : BAD
  return (
    <div className="space-y-3">
      <Card className="overflow-hidden" tone={cases.length ? color : undefined} tour="drift-leaks">
        <div className="pointer-events-none absolute -top-24 -left-16 size-72 rounded-full opacity-60" style={{ background: `radial-gradient(circle, ${cases.length ? (zero ? 'rgb(74 222 128 / 0.16)' : 'rgb(251 113 133 / 0.2)') : 'transparent'}, transparent 70%)` }} />
        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-4">
            <div
              className="font-display text-[56px] leading-none font-semibold tracking-tight tabular-nums md:text-[64px]"
              style={{ color: cases.length ? color : 'var(--color-ink-4)', textShadow: cases.length ? `0 0 32px ${zero ? 'rgb(74 222 128 / 0.45)' : 'rgb(251 113 133 / 0.5)'}` : undefined }}
              aria-label={`${breached} leaks`}
            >
              {cases.length ? breached : '–'}
            </div>
            <div>
              <div className="eyebrow" style={{ color: 'var(--color-ink-2)' }}>
                Leak counter
              </div>
              <div className="mt-1 text-[13px] text-ink-3">Guards breached across every scenario.</div>
              <div className="text-[13px] font-medium" style={{ color: cases.length ? color : undefined }}>
                {!cases.length ? 'Waiting for the first scenario' : zero ? 'Must read 0, and it does.' : 'Must read 0. Something leaked.'}
              </div>
            </div>
          </div>
          <dl className="ml-auto grid grid-cols-3 gap-x-5 text-right">
            <div>
              <dt className="text-[11px] text-ink-3">Scenarios</dt>
              <dd className="font-display text-xl font-semibold tabular-nums">
                {cases.length}
                {running && expected ? <span className="text-ink-4">/{expected}</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-3">Guards held</dt>
              <dd className="font-display text-xl font-semibold text-good tabular-nums">{held}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-3">Breached</dt>
              <dd className={cx('font-display text-xl font-semibold tabular-nums', breached ? 'text-bad' : 'text-ink-3')}>{breached}</dd>
            </div>
          </dl>
        </div>
        <div className="relative mt-4 flex flex-wrap gap-1.5" aria-label="Scenarios">
          {cases.map((c) => (
            <a
              key={c.id}
              href={`#drift-${caseKey(c)}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(`drift-${caseKey(c)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              }}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-white/[0.03] py-0.5 pr-2.5 pl-1 text-[12px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
            >
              <StatusIcon status={c.status} size={18} />
              {labText(c.name)}
            </a>
          ))}
          {running && expected
            ? Array.from({ length: Math.max(0, expected - cases.length) }, (_, i) => <span key={i} className="skeleton inline-block h-8 w-28 rounded-full" aria-hidden="true" />)
            : null}
        </div>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        {cases.map((c) => (
          <Scenario key={c.id} c={c} onOpen={() => onOpenCase(c.id)} />
        ))}
      </div>
    </div>
  )
}

function Scenario({ c, onOpen }: { c: LabCase; onOpen: () => void }) {
  const spec = DRIFT[caseKey(c)]
  const chart = useMemo(() => {
    try {
      return spec?.chart?.(c) ?? null
    } catch {
      return null
    }
  }, [spec, c])
  const gauges = spec?.gauges?.(c)
  const tone = c.status === 'passed' ? undefined : STATUS[c.status].color
  return (
    <Card tone={tone} className="scroll-mt-20">
      <div id={`drift-${caseKey(c)}`} className="absolute -top-16" aria-hidden="true" />
      <header className="flex items-start gap-3">
        <StatusIcon status={c.status} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="font-display text-[16px] font-semibold tracking-tight">{labText(c.name)}</h3>
            <span className="rounded-md border border-line bg-white/[0.03] px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-3 uppercase">{labText(c.group)}</span>
            {spec?.control && (
              <span className="rounded-md border border-[#7dd3fc]/30 bg-[#7dd3fc]/10 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-[#7dd3fc] uppercase" title="A control: the guards must not block real evidence">
                control
              </span>
            )}
          </div>
          <p className="mt-1 text-[13.5px] leading-snug text-ink-2">{verdictOf(c)}</p>
        </div>
      </header>
      <div className="mt-3">
        {chart ? (
          <Replay chart={chart} name={labText(c.name)} />
        ) : gauges ? (
          <div className="space-y-3">
            {gauges.map((g) => (
              <CapGauge key={g.label} g={g} />
            ))}
          </div>
        ) : c.metrics.length ? (
          <ul className="space-y-1.5">
            {c.metrics.map((m) => (
              <li key={m.name} className="flex min-h-9 items-center gap-2.5 rounded-xl border border-line bg-black/20 px-3 text-[13px]">
                <Icon name={m.ok === false ? 'x' : 'check'} size={15} strokeWidth={2.6} className={m.ok === false ? 'text-bad' : 'text-good'} />
                <span className="flex-1 text-ink-2">{labText(m.name)}</span>
                <span className={cx('text-[12px] font-semibold', m.ok === false ? 'text-bad' : 'text-good')}>{m.ok === false ? 'not refused' : 'refused'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <NoPicture reason={c.status === 'error' ? 'It crashed, so there is nothing to draw. The error is in the case below.' : 'This scenario recorded no series or guard metrics.'} />
        )}
      </div>
      <button onClick={onOpen} className="mt-3 inline-flex min-h-9 items-center gap-1 text-[12.5px] font-medium text-accent hover:text-ink">
        Metrics and notes <Icon name="chevron" size={14} />
      </button>
    </Card>
  )
}

/** Greyed out with the reason, never a misleading zero. */
function NoPicture({ reason }: { reason: string }) {
  return (
    <div
      className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-line px-4 text-center text-[12.5px] text-ink-4"
      style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.025) 0 6px, transparent 6px 12px)' }}
    >
      {reason}
    </div>
  )
}

/** Attempts against the cap: the bar is the attempts, the solid part what the hive accepted. */
function CapGauge({ g }: { g: Gauge }) {
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / g.tried) * 100))}%`
  const over = g.got > g.cap
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2 text-[12.5px]">
        <span className="flex-1 text-ink-2">{g.label}</span>
        <span className="tabular-nums">
          <b className={cx('font-semibold', over ? 'text-bad' : 'text-ink')}>{g.got}</b>
          <span className="text-ink-3"> accepted of {g.tried} tried</span>
        </span>
      </div>
      <div className="relative h-3 rounded-full" style={{ background: 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.07) 0 4px, rgb(255 255 255 / 0.03) 4px 8px)' }} role="img" aria-label={`${g.got} accepted of ${g.tried} attempts, cap ${g.cap}`}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pct(g.got), background: over ? '#fb7185' : SLOTS[0] }} />
        <div className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: pct(g.cap) }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-4 tabular-nums">
        <span>0</span>
        <span style={{ marginLeft: pct(g.cap) }} className="-translate-x-1/2 text-ink-3">
          cap {g.cap}
        </span>
        <span className="ml-auto">{g.tried} tried</span>
      </div>
    </div>
  )
}

/** "As of this step": scrub or play through the scenario; readouts and the leak follow the cursor. */
function Replay({ chart, name }: { chart: ChartSpec; name: string }) {
  const n = chart.primary.points.length
  const [i, setI] = useState(n - 1)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    const stepMs = Math.max(40, Math.min(400, 3600 / n))
    const t = setInterval(() => {
      setI((cur) => {
        if (cur >= n - 1) {
          setPlaying(false)
          return n - 1
        }
        return cur + 1
      })
    }, stepMs)
    return () => clearInterval(t)
  }, [playing, n])
  const idx = Math.min(i, n - 1)
  const x = chart.primary.points[idx]?.[0] ?? 0
  const atEnd = idx === n - 1
  const reads = chart.readout(idx)
  return (
    <div>
      <SeriesChart
        series={chart.series}
        cursor={atEnd && !playing ? null : x}
        xLabels={chart.xLabels}
        yLabels={chart.yLabels}
        height={190}
        label={`${name}: ${chart.series.map((s) => s.name).join(', ')}`}
        extra={
          chart.marker
            ? (sx) => (
                <g>
                  <line x1={sx(chart.marker!.x)} x2={sx(chart.marker!.x)} y1={8} y2={156} stroke="#fb7185" strokeOpacity={0.55} strokeDasharray="3 3" />
                  <text x={sx(chart.marker!.x) + 5} y={20} fontSize={10.5} fill="#fda4af">
                    {chart.marker!.label}
                  </text>
                </g>
              )
            : undefined
        }
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => {
            if (atEnd) setI(0)
            setPlaying(!playing)
          }}
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-white/[0.04] text-ink-2 hover:text-ink"
          aria-label={playing ? 'Pause the replay' : 'Replay the scenario step by step'}
        >
          <Icon name={playing ? 'pause' : 'play'} size={15} />
        </button>
        <input
          type="range"
          className="scrub min-w-0 flex-1"
          min={0}
          max={n - 1}
          value={idx}
          onChange={(e) => {
            setPlaying(false)
            setI(Number(e.target.value))
          }}
          aria-label={`As of step (${labText(chart.primary.x)})`}
          style={{ ['--hue' as string]: 214, ['--fill' as string]: `${(idx / Math.max(1, n - 1)) * 100}%` }}
        />
        <span className="w-16 shrink-0 text-right text-[11px] text-ink-3 tabular-nums">{atEnd ? 'final' : `as of ${idx + 1}/${n}`}</span>
      </div>
      <dl className="mt-2 flex flex-wrap gap-1.5" aria-live="polite">
        {reads.map((r) => (
          <div
            key={r.label}
            className={cx('flex min-h-8 items-center gap-1.5 rounded-lg border px-2 text-[12px]', r.leak ? (r.bad ? 'border-bad/40 bg-bad/10' : 'border-good/25 bg-good/[0.06]') : 'border-line bg-black/20')}
          >
            <dt className="text-ink-3">{r.label}</dt>
            <dd className={cx('font-semibold tabular-nums', r.leak ? (r.bad ? 'text-bad' : 'text-good') : r.bad ? 'text-bad' : 'text-ink')}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {chart.events && (
        <ol className="mt-2 grid gap-x-3 gap-y-0.5 text-[12px] sm:grid-cols-2">
          {chart.events.map((e, k) => (
            <li key={k} className={cx('flex items-baseline gap-1.5 rounded px-1 transition-colors', k === idx ? 'bg-white/[0.06] text-ink' : k > idx ? 'text-ink-4' : 'text-ink-3')}>
              <span className="w-4 shrink-0 text-right font-mono text-[10.5px] text-ink-4">{k + 1}</span>
              {e}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
