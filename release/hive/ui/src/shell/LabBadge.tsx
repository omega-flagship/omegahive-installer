import { plural } from '../lib/plural'
import { ago } from '../lib/format'
import { useNow } from '../lib/hooks'
import { navigate } from '../lib/router'
import { labHealth } from '../store/reducer'
import { useHive } from '../store/store'
import { Icon } from '../ui/Icon'
import { cx } from '../lib/cx'

const HEALTH_COLOR = { failing: '#fb7185', running: '#7dd3fc', passing: '#4ade80', unknown: '#5d5c86' } as const

/** The Lab at a glance in the HUD: last-run health of every suite; tapping opens the Lab. */
export function LabBadge({ compactMode }: { compactMode?: boolean }) {
  const suites = useHive((s) => s.labSuites)
  if (!suites?.length) return null
  const h = labHealth(suites)
  const color = HEALTH_COLOR[h.state]
  const label =
    h.state === 'running'
      ? `Lab: a suite is running; ${h.passing} of ${h.total} passing`
      : h.state === 'unknown'
        ? 'Lab: no runs yet'
        : `Lab: ${h.passing} of ${plural(h.total, 'suite')} passing on their last run`
  return (
    <button
      onClick={() => navigate({ name: 'lab' })}
      className={cx(
        'glass relative flex h-11 items-center gap-1.5 rounded-2xl text-[13px] font-semibold transition-colors hover:text-ink',
        compactMode ? 'w-11 justify-center' : 'pr-3 pl-2.5',
        h.state === 'failing' ? 'text-bad' : 'text-ink-2',
      )}
      aria-label={label}
      title={`${label} (G L)`}
    >
      {h.state === 'failing' && <span className="absolute inset-0 rounded-2xl border border-bad/30" style={{ boxShadow: '0 0 18px -4px color-mix(in oklab, var(--color-bad) 50%, transparent)' }} aria-hidden="true" />}
      <span className="relative">
        <Icon name="flask" size={18} />
        <span
          className={cx('absolute -right-1 -bottom-0.5 size-2 rounded-full', h.state === 'running' && 'animate-pulse')}
          style={{ background: color, boxShadow: `0 0 0 2px var(--color-abyss), 0 0 8px ${color}` }}
          aria-hidden="true"
        />
      </span>
      {!compactMode && (
        <span className="tabular-nums">
          {h.passing}
          <span className="text-ink-4">/{h.total}</span>
        </span>
      )}
    </button>
  )
}

/**
 * Inside a dot: the drift guards that protect every mind (echoes, retry and spend runaways,
 * abandoned goals), as of the last drift-scenario run.
 */
export function LabGuards() {
  const suite = useHive((s) => s.labSuites?.find((x) => x.id === 'bench-drift'))
  const now = useNow(30_000)
  if (!suite) return null
  const r = suite.last_run
  const total = r ? r.passed + r.failed + r.skipped + r.errors : 0
  const state = !r ? 'unknown' : r.status === 'running' ? 'running' : r.status === 'passed' ? 'passing' : r.status === 'cancelled' || r.status === 'skipped' ? 'unknown' : 'failing'
  const color = HEALTH_COLOR[state]
  const text = !r
    ? 'Drift guards have not been tested yet'
    : state === 'running'
      ? 'Drift scenarios are running now'
      : state === 'passing'
        ? `Drift guards held · ${r.passed}/${total}`
        : state === 'failing'
          ? `Drift guard breached · ${r.failed + r.errors} of ${total}`
          : `Last drift run ${r.status}`
  return (
    <button
      onClick={() => navigate({ name: 'lab', suite: 'bench-drift' })}
      className="group flex min-h-11 w-full items-center gap-3 rounded-xl border border-line bg-tint/[0.025] px-3 text-left transition-colors hover:border-line-2 hover:bg-tint/[0.05]"
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-shade/25 text-ink-2">
        <Icon name="shield" size={16} />
        <span className={cx('absolute -top-0.5 -right-0.5 size-2 rounded-full', state === 'running' && 'animate-pulse')} style={{ background: color, boxShadow: `0 0 8px ${color}` }} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{text}</span>
        <span className="block truncate text-[11.5px] text-ink-3">
          Echo storms, retry and spend runaways, abandoned tasks{r?.finished_at ? ` · ${ago(r.finished_at, now)}` : ''}
        </span>
      </span>
      <Icon name="chevron" size={16} className="shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}
