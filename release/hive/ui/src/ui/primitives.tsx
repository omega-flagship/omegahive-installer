import { m } from 'framer-motion'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { AgentStatus, ThinkingPhase } from '../api/types'
import { hsl } from '../lib/color'
import { cx } from '../lib/cx'
import { Icon, type IconName } from './Icon'
import { MODE_STYLE } from './modes'


type BtnVariant = 'primary' | 'ghost' | 'subtle' | 'danger'

/** The one primary fill: Omega's lavender. A mind's hue belongs on its orb, never on a call to action. */
const PRIMARY_STYLE = {
  background: 'linear-gradient(180deg, var(--color-primary-top), var(--color-accent))',
} as React.CSSProperties

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: BtnVariant
    icon?: IconName
    size?: 'md' | 'lg'
    /** @deprecated Ignored: every primary button uses the brand gradient. Kept so older call sites compile. */
    hue?: number
  }
>(function Button({ variant = 'subtle', icon, size = 'md', hue: _hue, className, children, style, ...rest }, ref) {
  const base =
    'relative inline-flex items-center justify-center gap-2 rounded-xl font-medium select-none transition-[background,border-color,box-shadow,transform,opacity] duration-200 active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100'
  const sizes = size === 'lg' ? 'min-h-12 px-5 text-[15px]' : 'min-h-11 px-4 text-sm'
  const variants: Record<BtnVariant, string> = {
    primary: 'text-[var(--color-primary-ink)] font-semibold border border-control/50 hover:brightness-110',
    ghost: 'text-ink-2 hover:text-ink hover:bg-tint/[0.06]',
    subtle: 'text-ink bg-tint/[0.06] border border-line hover:bg-tint/[0.1] hover:border-line-2',
    danger: 'text-bad bg-bad/10 border border-bad/25 hover:bg-bad/15',
  }
  return (
    <button ref={ref} className={cx(base, sizes, variants[variant], className)} style={variant === 'primary' ? { ...PRIMARY_STYLE, ...style } : style} {...rest}>
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: number; active?: boolean }
>(function IconButton({ icon, label, size = 20, active, className, ...rest }, ref) {
  return (
    <button
      type="button"
      ref={ref}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-2 transition-colors duration-150 hover:bg-tint/[0.07] hover:text-ink active:scale-95',
        active && 'bg-tint/[0.09] text-ink',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  )
})

/** The agent's identity: a little glowing orb in its hue. */
export function Orb({ hue, size = 28, status = 'awake', thinking, className }: { hue: number; size?: number; status?: AgentStatus; thinking?: ThinkingPhase | null; className?: string }) {
  const dim = status === 'asleep' ? 0.45 : status === 'stopped' ? 0.22 : status === 'created' || status === 'starting' ? 0.7 : 1
  const h = status === 'error' ? 356 : hue
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }} aria-hidden="true">
      <span
        className={cx('absolute inset-0 rounded-full', status === 'awake' && 'animate-breathe')}
        style={{
          background: `radial-gradient(circle at 50% 50%, #fff 0 9%, ${hsl(h, 100, 80)} 18%, ${hsl(h, 95, 62, 0.55)} 38%, ${hsl(h, 90, 55, 0)} 70%)`,
          opacity: dim,
          filter: status === 'stopped' ? 'grayscale(0.7)' : undefined,
        }}
      />
      {thinking && thinking !== 'idle' && (
        <span
          className="absolute -inset-[3px] rounded-full animate-spin-slow"
          style={{
            border: `1.5px solid transparent`,
            borderTopColor: hsl(thinking === 'skills' ? h + 55 : h, 100, 78),
            borderBottomColor: hsl(thinking === 'skills' ? h + 55 : h, 100, 78, 0.4),
            animationDuration: thinking === 'skills' ? '1.1s' : '2s',
          }}
        />
      )}
    </span>
  )
}

const STATUS_STYLE: Record<AgentStatus, { label: string; color: string }> = {
  awake: { label: 'Awake', color: '#5eead4' },
  asleep: { label: 'Asleep', color: '#a5b4fc' },
  starting: { label: 'Starting', color: '#fde68a' },
  created: { label: 'Created', color: '#c4b5fd' },
  stopped: { label: 'Stopped', color: '#9ca3af' },
  error: { label: 'Error', color: 'var(--color-bad)' },
}

export function StatusPill({ status, thinking }: { status: AgentStatus; thinking?: ThinkingPhase | null }) {
  // the server can report statuses this build does not name (a settled mind is 'moved')
  const s = STATUS_STYLE[status] ?? { label: (status as string) === 'moved' ? 'Moved away' : String(status), color: '#9ca3af' }
  const label = status === 'awake' && thinking && thinking !== 'idle' ? (thinking === 'llm' ? 'Thinking' : 'Using skills') : s.label
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-tint/[0.04] px-2 py-0.5 text-[11px] font-medium text-ink-2">
      <span
        className={cx('size-1.5 rounded-full', (status === 'awake' || status === 'starting') && 'animate-pulse')}
        style={{ background: s.color, boxShadow: `0 0 8px ${s.color}` }}
      />
      {label}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded-md border border-line-2 bg-tint/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
      {children}
    </kbd>
  )
}

/** A same-ramp meter: the track is a lighter step of the fill so state reads across the bar. */
export function Meter({ value, max, label, hue = 252 }: { value: number; max: number; label: string; hue?: number }) {
  const unlimited = max <= 0
  const pct = unlimited ? 0 : Math.min(1, value / max)
  const tone = pct > 0.9 ? 356 : pct > 0.7 ? 38 : hue
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={unlimited ? undefined : max} aria-valuenow={value}>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: hsl(tone, 60, 50, 0.18) }}>
        {!unlimited && (
          <m.div
            className="h-full rounded-full"
            initial={false}
            animate={{ width: `${Math.max(2, pct * 100)}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            style={{ background: `linear-gradient(90deg, ${hsl(tone, 90, 60)}, ${hsl(tone, 100, 75)})`, boxShadow: `0 0 12px ${hsl(tone, 100, 65, 0.6)}` }}
          />
        )}
      </div>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  dense,
  tour,
}: {
  value: T
  options: { value: T; label: string; badge?: ReactNode }[]
  onChange: (v: T) => void
  label: string
  className?: string
  /** Tighter padding for 4-5 options on a phone. */
  dense?: boolean
  /** Tour anchor: the group gets this data-tour name and each option `${tour}-${value}`. */
  tour?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} data-tour={tour} className={cx('relative inline-flex rounded-xl border border-line bg-tint/[0.03] p-1', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            type="button"
            key={o.value}
            role="radio"
            aria-checked={on}
            data-tour={tour ? `${tour}-${o.value}` : undefined}
            onClick={() => onChange(o.value)}
            className={cx(
              'relative min-h-9 flex-1 rounded-lg font-medium whitespace-nowrap transition-colors',
              dense ? 'px-1.5 text-[12.5px]' : 'px-3 text-[13px]',
              on ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {on && (
              <m.span
                layoutId={`seg-${label}`}
                className="absolute inset-0 rounded-lg border border-control bg-tint/[0.09]"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1">
              {o.label}
              {o.badge}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function EmptyState({ icon = 'sparkles', title, body, action }: { icon?: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="relative flex size-14 items-center justify-center rounded-2xl border border-line bg-tint/[0.03] text-ink-3">
        <div className="absolute inset-0 rounded-2xl" style={{ boxShadow: '0 0 40px -6px color-mix(in oklab, var(--color-accent) 35%, transparent)' }} />
        <Icon name={icon} size={24} />
      </div>
      <div className="font-display text-[15px] font-semibold text-ink">{title}</div>
      {body && <p className="max-w-xs text-sm leading-relaxed text-ink-3">{body}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ title = 'Something went wrong', body, onRetry }: { title?: string; body?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-bad/25 bg-bad/10 text-bad">
        <Icon name="alert" size={22} />
      </div>
      <div className="font-display text-[15px] font-semibold">{title}</div>
      {body && <p className="max-w-xs text-sm text-ink-3">{body}</p>}
      {onRetry && (
        <Button onClick={onRetry} icon="sparkles">
          Try again
        </Button>
      )}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />
}

/** Truth value: two thin bars, frequency on the diverging scale, confidence as brightness. */
/** uifix-r3 (S3): the two numbers of a truth value, labelled in words (never a bare "f" and "c"). */
export function TruthBars({ f, c, compact }: { f: number; c: number; compact?: boolean }) {
  return (
    <div className={cx('grid items-center gap-x-2 gap-y-1 tabular-nums', compact ? 'text-[11px]' : 'text-xs')} style={{ gridTemplateColumns: 'auto 1fr auto' }}>
      <span className="text-ink-3">Likelihood</span>
      <div className="relative h-1.5 rounded-full bg-tint/[0.07]">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${f * 100}%`, background: 'linear-gradient(90deg, var(--color-bad), var(--color-ink-2), rgb(92 162 245))', backgroundSize: `${100 / Math.max(f, 0.01)}% 100%` }} />
      </div>
      <span className="font-mono text-ink-2">{f.toFixed(2)}</span>
      <span className="text-ink-3">Confidence</span>
      <div className="relative h-1.5 rounded-full bg-tint/[0.07]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${c * 100}%`, opacity: 0.35 + c * 0.6, boxShadow: `0 0 ${4 + c * 10}px rgb(236 234 255 / ${c * 0.6})` }} />
      </div>
      <span className="font-mono text-ink-2">{c.toFixed(2)}</span>
    </div>
  )
}

// ---------------------------------------------------------------- Phase 2 primitives

/** A 44px-tall touch target wrapping a pill switch. */
export function Switch({ checked, onChange, label, hue = 252, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hue?: number; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-11 shrink-0 items-center disabled:opacity-45"
    >
      <span
        className="relative inline-flex h-[26px] w-[44px] items-center rounded-full border transition-colors duration-200"
        style={{
          background: checked ? hsl(hue, 90, 64, 0.85) : 'color-mix(in oklab, var(--color-ink) 6%, transparent)',
          borderColor: checked ? hsl(hue, 100, 80, 0.6) : 'var(--color-control)',
          boxShadow: checked ? `0 0 16px ${hsl(hue, 100, 65, 0.45)}` : undefined,
        }}
      >
        <m.span
          className="absolute size-5 rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.45)]"
          initial={false}
          animate={{ x: checked ? 20 : 2 }}
          transition={{ type: 'spring', stiffness: 700, damping: 36 }}
        />
      </span>
    </button>
  )
}

const RISK: Record<'low' | 'medium' | 'high', { label: string; color: string; bg: string }> = {
  low: { label: 'Low risk', color: '#5eead4', bg: 'rgb(94 234 212 / 0.1)' },
  medium: { label: 'Medium risk', color: 'var(--color-warn)', bg: 'color-mix(in oklab, var(--color-warn) 10%, transparent)' },
  high: { label: 'High risk', color: 'var(--color-bad)', bg: 'color-mix(in oklab, var(--color-bad) 12%, transparent)' },
}

export function RiskChip({ risk, compact }: { risk: 'low' | 'medium' | 'high'; compact?: boolean }) {
  const r = RISK[risk]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{ color: r.color, background: r.bg, borderColor: `color-mix(in srgb, ${r.color} 35%, transparent)` }}
    >
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-[3px] rounded-[1px]"
            style={{ height: 4 + i * 2.5, background: r.color, opacity: i <= ['low', 'medium', 'high'].indexOf(risk) ? 1 : 0.25 }}
          />
        ))}
      </span>
      {compact ? risk : r.label}
    </span>
  )
}


/** allow / ask / deny: used for policy rules and per-command gate decisions. */
export function ModeChip({ mode, className }: { mode: 'allow' | 'ask' | 'deny'; className?: string }) {
  const s = MODE_STYLE[mode]
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold', className)}
      style={{ color: s.color, background: s.bg, borderColor: `color-mix(in srgb, ${s.color} 30%, transparent)` }}
    >
      <Icon name={s.icon} size={11} strokeWidth={2.4} />
      {s.label}
    </span>
  )
}

/** A thin ring showing done / total (e.g. subgoals). */
export function ProgressRing({ value, total, size = 30, hue = 152, label }: { value: number; total: number; size?: number; hue?: number; label?: string }) {
  const r = size / 2 - 2.5
  const c = 2 * Math.PI * r
  const pct = total ? value / total : 0
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, boxShadow: pct > 0 ? `0 0 12px -3px ${hsl(hue, 100, 60, 0.6)}` : undefined }}
      role="img"
      aria-label={label ?? `${value} of ${total} done`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="color-mix(in oklab, var(--color-ink) 10%, transparent)" strokeWidth={2.5} />
        <m.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={hsl(hue, 85, 62)}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        />
      </svg>
      <span className="absolute font-mono text-[9px] font-semibold text-ink-2 tabular-nums">
        {value}/{total}
      </span>
    </span>
  )
}

/** A small glowing count (nav badges). Pops when the number changes. */
export function CountBadge({ n, className }: { n: number; className?: string }) {
  if (n <= 0) return null
  return (
    <m.span
      key={n}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 700, damping: 22 }}
      className={cx(
        'pointer-events-none inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10px] leading-none font-bold text-[#1a1003] tabular-nums',
        className,
      )}
      style={{ background: 'linear-gradient(180deg, #ffd88a, #fbbf24)', boxShadow: '0 0 0 2px var(--color-abyss), 0 0 12px color-mix(in oklab, var(--color-warn) 70%, transparent)' }}
      aria-label={`${n} pending`}
    >
      {n > 99 ? '99+' : n}
    </m.span>
  )
}
