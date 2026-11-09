import { AnimatePresence, m } from 'framer-motion'
import { useId, useState, type ReactNode } from 'react'
import type { ProgramRole, Uncertainty, WorkItem, WorkSource } from '../../api/types'
import { surenessColor } from '../../lib/color'
import { cx } from '../../lib/cx'
import { Icon, type IconName } from '../../ui/Icon'
import { f2, FLAG_TEXT, num, numeric, ROLE, SOURCE_STATUS, toneInk, ulabel, uncertaintyText } from './style'

// ---------------------------------------------------------------- shared styling




export function RoleMark({ role, kindLabel, className }: { role: ProgramRole; kindLabel: string; className?: string }) {
  const r = ROLE[role]
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase', className)} style={{ color: toneInk(r.color) }}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: r.color, boxShadow: `0 0 8px ${r.color}` }} aria-hidden="true" />
      <span className="truncate">{kindLabel}</span>
    </span>
  )
}

// ---------------------------------------------------------------- uncertainty: one visual language




/**
 * A small ring: the arc is the value, coloured by how sure (NAL expectation of value and confidence, uifix-r3.4), the
 * core's brightness is the confidence. Same glyph for NAL and PLN; the method is always named next to it or on hover.
 */
export function UGlyph({ value, conf, size = 18 }: { value: number; conf: number; size?: number }) {
  const r = size / 2 - 2
  const c = 2 * Math.PI * r
  const col = surenessColor({ f: Math.min(1, Math.max(0, value)), c: Math.min(1, Math.max(0, conf)) })
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="color-mix(in oklab, var(--color-ink) 12%, transparent)" strokeWidth={2} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={2.2} strokeLinecap="round" strokeDasharray={`${Math.max(0.5, value * c)} ${c}`} style={{ filter: `drop-shadow(0 0 3px ${col})` }} />
      <circle cx={size / 2} cy={size / 2} r={r * 0.46} fill="#eceaff" opacity={0.12 + conf * 0.85} />
    </svg>
  )
}

/** Compact form for cards: glyph or chip only; the card's label carries the exact words. */
export function UMini({ u }: { u: Uncertainty | null | undefined }) {
  const n = numeric(u)
  if (n)
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-3 tabular-nums" title={uncertaintyText(u)}>
        <UGlyph value={n.value} conf={n.conf} size={16} />
        <span className="group-hover:hidden group-focus-visible:hidden">{n.method.toUpperCase()}</span>
        <span className="hidden text-ink-2 group-hover:inline group-focus-visible:inline">
          {f2(n.value)}·{f2(n.conf)}
        </span>
      </span>
    )
  return <UChip u={u} compact />
}

export function UChip({ u, compact }: { u: Uncertainty | null | undefined; compact?: boolean }) {
  if (!u)
    return (
      <span className={cx('inline-flex shrink-0 items-center rounded-md border border-dashed border-line-2 font-medium text-ink-4', compact ? 'px-1 text-[10px]' : 'px-1.5 py-0.5 text-[11px]')} title="No uncertainty given: unassessed, which is not zero">
        unassessed
      </span>
    )
  const qual = u.method === 'qualitative'
  const text = qual ? String((u as { status?: unknown }).status ?? '') : ulabel(u)
  return (
    <span
      className={cx('inline-flex max-w-full min-w-0 shrink items-center gap-1 rounded-md border font-medium', compact ? 'px-1 text-[10px]' : 'px-1.5 py-0.5 text-[11.5px]')}
      style={{ color: '#d8d1ff', borderColor: 'color-mix(in oklab, var(--color-ink) 30%, transparent)', background: 'color-mix(in oklab, var(--color-ink) 8%, transparent)' }}
      title={uncertaintyText(u)}
    >
      <span aria-hidden="true" className="opacity-70">≈</span>
      <span className="truncate">{text}</span>
      {!qual && <span className="shrink-0 font-mono text-[9.5px] text-ink-4">{u.method}</span>}
    </span>
  )
}

/** The full reading, with a focusable tooltip for the exact numbers and the method. */
export function UReading({ u, large }: { u: Uncertainty | null | undefined; large?: boolean }) {
  const n = numeric(u)
  const id = useId()
  if (!n) return <UChip u={u} />
  return (
    <span className="group/u relative inline-flex items-center gap-2 rounded-lg outline-none" tabIndex={0} aria-describedby={id}>
      <UGlyph value={n.value} conf={n.conf} size={large ? 30 : 20} />
      <span className={cx('font-mono tabular-nums', large ? 'text-[13px] text-ink' : 'text-[11.5px] text-ink-2')}>
        {n.method === 'nal' ? 'f' : 's'} {f2(n.value)} · c {f2(n.conf)}
      </span>
      <span className="rounded border border-line px-1 font-mono text-[9.5px] tracking-wide text-ink-3 uppercase">{n.method}</span>
      <span id={id} role="tooltip" className="glass-strong pointer-events-none absolute top-full left-0 z-30 mt-1.5 w-max max-w-[260px] rounded-xl px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-2 opacity-0 transition-opacity group-hover/u:opacity-100 group-focus-visible/u:opacity-100">
        <b className="font-semibold text-ink">{n.method === 'nal' ? 'NAL truth value' : 'PLN truth value'}</b>
        <br />
        {n.vName} {num(n.value).toFixed(3)} · {n.cName} {num(n.conf).toFixed(3)}
        <br />
        <span className="text-ink-4">Shown as given; never converted to another method.</span>
      </span>
    </span>
  )
}

// ---------------------------------------------------------------- status and flags


const STATUS_STYLE: Record<string, { label: string; color: string; icon: IconName; why: string }> = {
  corrected: { label: 'Corrected', color: 'var(--color-warn)', icon: 'edit', why: 'The program corrected this item; earlier wording is kept in its revisions.' },
  superseded: { label: 'Superseded', color: '#a1a1c2', icon: 'history', why: 'Replaced by something newer; kept for the record.' },
  retracted: { label: 'Retracted', color: 'var(--color-bad)', icon: 'ban', why: 'Withdrawn: do not rely on it.' },
}

export function StatusChip({ status, compact }: { status?: string; compact?: boolean }) {
  const s = status && STATUS_STYLE[status]
  if (!s) return null
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-md border font-semibold', compact ? 'px-1 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]')}
      style={{ color: toneInk(s.color), borderColor: `color-mix(in srgb, ${s.color} 35%, transparent)`, background: `color-mix(in srgb, ${s.color} 11%, transparent)` }}
      title={s.why}
    >
      <Icon name={s.icon} size={compact ? 10 : 11} strokeWidth={2.4} />
      {s.label}
    </span>
  )
}

export function FlagChip({ flag, compact }: { flag: string; compact?: boolean }) {
  const known = FLAG_TEXT[flag]
  const warn = flag === 'affected-by-correction'
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-md border font-semibold', compact ? 'px-1 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]', warn ? 'border-warn/40 bg-warn/15 text-warn' : 'border-line-2 bg-tint/[0.04] text-ink-2')}
      title={known?.why ?? flag}
    >
      {warn && <Icon name="alert" size={compact ? 10 : 11} strokeWidth={2.4} />}
      {compact && warn ? 'Affected' : (known?.label ?? flag)}
    </span>
  )
}

export function StatusLine({ item, compact }: { item: WorkItem; compact?: boolean }) {
  const flags = item.flags ?? []
  if ((!item.status || item.status === 'current') && !flags.length) return null
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <StatusChip status={item.status} compact={compact} />
      {flags.map((f) => (
        <FlagChip key={f} flag={f} compact={compact} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------- sources


export function SourceStatus({ status }: { status?: string }) {
  const st = SOURCE_STATUS[status ?? 'cited'] ?? { label: status ?? 'cited', color: '#a1a1c2' }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold" style={{ color: toneInk(st.color) }}>
      <span className="size-1.5 rounded-full" style={{ background: st.color }} aria-hidden="true" />
      {st.label}
    </span>
  )
}

const KNOWN_SOURCE_KEYS = new Set(['id', 'label', 'kind', 'url', 'local_ref', 'date', 'locator', 'status', 'origin'])

/** Any extra fields a program returned (e.g. inspect-source's record), as text. */
function extraFields(s: WorkSource): [string, string][] {
  const out: [string, string][] = []
  const walk = (prefix: string, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x)
    else out.push([prefix, Array.isArray(v) ? v.map(String).join(', ') : String(v)])
  }
  for (const [k, v] of Object.entries(s)) if (!KNOWN_SOURCE_KEYS.has(k)) walk(k, v)
  return out
}

/** Every field of a source. References are shown, never fetched: a URL opens in a new tab by the person. */
export function SourceFields({ s, dense }: { s: WorkSource; dense?: boolean }) {
  const rows: [string, ReactNode][] = []
  if (s.url)
    rows.push([
      'URL',
      <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="group/a inline-flex max-w-full min-w-0 items-center gap-1 text-accent-2 hover:underline" title={`${s.url} (external reference: opens a new tab)`}>
        <span className="truncate">{s.url.replace(/^https?:\/\//, '')}</span>
        <Icon name="external" size={11} className="shrink-0" />
        <span className="sr-only">(external reference, opens a new tab)</span>
      </a>,
    ])
  if (s.local_ref) rows.push(['Local ref', <span className="font-mono text-[11px] break-all text-ink-2">{s.local_ref}</span>])
  if (s.date) rows.push(['Date', s.date])
  if (s.locator) rows.push(['Locator', s.locator])
  rows.push(['Status', <SourceStatus status={s.status} />])
  rows.push(['Origin', s.origin ? <span className="font-mono text-[11px] text-ink-2">{s.origin}</span> : <span className="text-ink-4">not given</span>])
  if (s.kind) rows.push(['Kind', s.kind])
  for (const [k, v] of extraFields(s)) rows.push([k, <span className="font-mono text-[11px] break-all text-ink-2">{v}</span>])
  return (
    <dl className={cx('grid gap-x-3 gap-y-1', dense ? 'text-[11.5px]' : 'text-[12px]')} style={{ gridTemplateColumns: 'auto minmax(0, 1fr)' }}>
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="contents">
          <dt className="text-ink-4">{k}</dt>
          <dd className="min-w-0 text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function ExternalNote() {
  return (
    <p className="text-[11px] leading-snug text-ink-4">
      <Icon name="external" size={10} className="mr-1 inline align-[-1px]" />
      Links are external references. The hive never opens them for you.
    </p>
  )
}

export function SameOriginBadge({ n, origin }: { n: number; origin: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warn/40 bg-warn/12 px-1.5 py-0.5 text-[10.5px] font-semibold text-warn" title={`${n} sources share the origin “${origin}”: they are not independent.`}>
      <Icon name="link" size={11} strokeWidth={2.2} />
      Same origin · {n}
    </span>
  )
}

export function Disclosure({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div>
      <button className="flex min-h-9 w-full items-center gap-2 text-left" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={14} className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">{title}</span>
        {right}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div id={id} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
