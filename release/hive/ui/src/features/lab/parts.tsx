import type { ReactNode } from 'react'
import type { LabCaseStatus, LabMetric, LabRunStatus, LabRunSummary, LabSuite } from '../../api/types'
import { cx } from '../../lib/cx'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { BAD, BETTER_ARROW, BETTER_TEXT, DEMO_LABEL, GOOD, fmtValue, formerlyText, formerNames, labText, needsText, STATUS, SURFACE, targetText, total } from './labUtil'

export function StatusIcon({ status, size = 22 }: { status: LabRunStatus | LabCaseStatus; size?: number }) {
  const s = STATUS[status]
  return (
    <span
      className={cx('relative inline-flex shrink-0 items-center justify-center rounded-full', status === 'running' && 'animate-pulse')}
      style={{ width: size, height: size, color: s.color, background: `color-mix(in srgb, ${s.color} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${s.color} 35%, transparent)` }}
      role="img"
      aria-label={s.label}
    >
      <Icon name={s.icon} size={Math.round(size * 0.58)} strokeWidth={2.4} />
    </span>
  )
}

export function StatusChip({ status, className }: { status: LabRunStatus | LabCaseStatus; className?: string }) {
  const s = STATUS[status]
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap', className)}
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 10%, transparent)`, borderColor: `color-mix(in srgb, ${s.color} 32%, transparent)` }}
    >
      <Icon name={s.icon} size={11} strokeWidth={2.6} />
      {s.label}
    </span>
  )
}

/** passed · failed · skipped · errors, only the non-zero ones (passed always). */
export function Counts({ run, className }: { run: Pick<LabRunSummary, 'passed' | 'failed' | 'skipped' | 'errors'>; className?: string }) {
  const items: [string, number, string][] = [
    ['passed', run.passed, STATUS.passed.color],
    ['failed', run.failed, STATUS.failed.color],
    ['errors', run.errors, STATUS.error.color],
    ['skipped', run.skipped, STATUS.skipped.color],
  ]
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] tabular-nums', className)}>
      {items
        .filter(([k, n]) => n > 0 || k === 'passed')
        .map(([k, n, color]) => (
          <span key={k} className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />
            <b className="font-semibold text-ink">{n}</b>
            <span className="text-ink-3">{k}</span>
          </span>
        ))}
    </span>
  )
}

/** A strip of recent runs, oldest → newest, one tick per run coloured by its result. */
export function RunStrip({ runs, max = 12, onPick }: { runs: LabRunSummary[]; max?: number; onPick?: (id: string) => void }) {
  const list = runs.slice(-max)
  return (
    <span className="inline-flex items-end gap-[3px]" role="list" aria-label="Recent runs, oldest first">
      {Array.from({ length: Math.max(0, max - list.length) }, (_, i) => (
        <span key={`e${i}`} className="h-3.5 w-1.5 rounded-[2px] bg-tint/[0.05]" aria-hidden="true" />
      ))}
      {list.map((r) => {
        const s = STATUS[r.status]
        const n = total(r)
        return (
          <button
            key={r.id}
            role="listitem"
            onClick={onPick ? (e) => (e.stopPropagation(), onPick(r.id)) : undefined}
            tabIndex={onPick ? 0 : -1}
            className={cx('h-3.5 w-1.5 rounded-[2px] transition-transform hover:scale-y-125', r.status === 'running' && 'animate-pulse')}
            style={{ background: s.color, opacity: r.demo === 'example' ? 0.5 : 1 }}
            title={`${s.label} · ${r.passed}/${n} · ${new Date(r.started_at).toLocaleString()}${r.demo === 'example' ? ' · example history' : ''}`}
            aria-label={`${s.label} run, ${new Date(r.started_at).toLocaleString()}`}
          />
        )
      })}
    </span>
  )
}

export function MetricTile({ m }: { m: LabMetric }) {
  const tt = targetText(m)
  // a renamed measure's old name, as a quiet line under its name (never a measure of its own)
  const former = formerlyText(formerNames([m], m.name))
  const tone = m.ok === false ? BAD : m.ok ? GOOD : undefined
  return (
    <div
      className="relative min-w-0 overflow-hidden rounded-xl border px-3 py-2.5"
      style={{ background: 'var(--lab-well)', borderColor: tone ? `color-mix(in srgb, ${tone} 28%, transparent)` : 'var(--color-line)' }}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <span className="min-w-0 flex-1 truncate" title={labText(m.name)}>
          {labText(m.name)}
        </span>
        <span title={BETTER_TEXT[m.better]} className="font-mono text-[11px] text-ink-4" aria-label={BETTER_TEXT[m.better]}>
          {BETTER_ARROW[m.better]}
        </span>
      </div>
      {former && <div className="truncate text-[10.5px] text-ink-4" data-metric-formerly="">{former}</div>}
      <div className="mt-0.5 truncate font-display text-[19px] leading-tight font-semibold tracking-tight text-ink tabular-nums" title={String(m.value)}>
        {fmtValue(m.value, m.unit)}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px]">
        {m.ok === null ? (
          <span className="text-ink-4">informational</span>
        ) : (
          <span className="inline-flex items-center gap-1 font-semibold" style={{ color: tone }}>
            <Icon name={m.ok ? 'check' : 'x'} size={11} strokeWidth={2.8} />
            {m.ok ? 'met' : 'missed'}
          </span>
        )}
        {tt && <span className="truncate text-ink-3 tabular-nums">target {tt}</span>}
      </div>
    </div>
  )
}

export function Card({ title, subtitle, actions, children, className, tone, tour }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; tone?: string; tour?: string }) {
  return (
    <section
      data-tour={tour}
      className={cx('relative rounded-[20px] border p-4 md:p-5', className)}
      style={{ background: SURFACE, borderColor: tone ? `color-mix(in srgb, ${tone} 30%, transparent)` : 'var(--color-line)' }}
    >
      {(title || actions) && (
        <header className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{subtitle}</div>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

/** Run, or Cancel while running; disabled with the reason when requirements are missing. */
export function RunButton({ suite, size = 'md', className }: { suite: LabSuite; size?: 'md' | 'sm'; className?: string }) {
  const start = useHive((s) => s.startLab)
  const cancel = useHive((s) => s.cancelLab)
  const run = suite.last_run
  const running = run?.status === 'running'
  if (running) {
    return (
      <Button variant="danger" icon="stop" onClick={(e) => (e.stopPropagation(), void cancel(run.id))} className={cx(size === 'sm' && 'min-h-9 px-3 text-[13px]', className)} aria-label={`Cancel ${suite.title}`}>
        Cancel
      </Button>
    )
  }
  const reason = suite.runnable ? undefined : `Needs ${needsText(suite.missing)}`
  return (
    <Button
      variant={suite.runnable ? 'subtle' : 'ghost'}
      icon="play"
      disabled={!suite.runnable}
      title={reason ?? `Run ${suite.title}`}
      aria-label={reason ? `Run ${suite.title} (unavailable: ${reason})` : `Run ${suite.title}`}
      onClick={(e) => (e.stopPropagation(), void start(suite.id))}
      className={cx(size === 'sm' && 'min-h-9 px-3 text-[13px]', className)}
    >
      Run
    </Button>
  )
}

/** In sim/demo mode: where the numbers come from, and that early history is example data. */
export function DemoBanner({ recordedAt }: { recordedAt: string | null }) {
  const when = recordedAt ? new Date(recordedAt).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className="mb-4 flex items-start gap-3 rounded-2xl border border-warn/25 bg-warn/[0.06] px-3.5 py-2.5 text-[12.5px] leading-snug text-ink-2" role="note">
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
        <Icon name="replay" size={14} strokeWidth={2} />
      </span>
      <p className="min-w-0">
        <b className="font-semibold text-warn">Demo</b>
        <span className="text-ink-2"> · recorded results{when ? ` from ${when}` : ''}.</span>{' '}
        <span className="text-ink-3">
          Run replays a suite's real recorded cases at their recorded pace. Earlier history is <b className="font-medium text-ink-2">example data</b>, the recording with small jitter, shown hollow and marked “example”.
        </span>{' '}
        <span className="text-ink-3">Elsewhere in the demo, costs are simulated: made-up token counts × list prices. No model was called and nothing was charged.</span>
      </p>
    </div>
  )
}

export function DemoChip({ demo }: { demo?: LabRunSummary['demo'] }) {
  if (!demo) return null
  const d = DEMO_LABEL[demo]
  return (
    <span
      title={d.title}
      className={cx(
        'inline-flex shrink-0 items-center rounded-md border px-1.5 py-px text-[10.5px] font-semibold tracking-wide uppercase',
        demo === 'example' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-line-2 bg-tint/[0.04] text-ink-3',
      )}
    >
      {d.label}
    </span>
  )
}
