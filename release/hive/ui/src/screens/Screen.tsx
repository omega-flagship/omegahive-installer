import { m } from 'framer-motion'
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { AgentStatus } from '../api/types'
import { cx } from '../lib/cx'
import { Button, EmptyState, Orb, Segmented, Skeleton, Switch } from '../ui/primitives'
import { hsl } from '../lib/color'
import { radioProps } from '../lib/radio'
import { Icon } from '../ui/Icon'
import { iconOr } from '../ui/iconPaths'
import type { DrawnPart, PropValue, Props, ScreenPlan } from './screenSpace'

/**
 * Draws what MeTTa composed (screens/space.ts). One small component per block; nothing here chooses which parts show
 * or which block draws them. Values marked (bind path) are filled from `data`; a person's input goes back through
 * `onInput`, and every press through `onOpen` or `onAction`, so the page decides what a press does.
 */
export type ScreenItem = Record<string, unknown>
export interface ScreenHost {
  data: Record<string, unknown>
  onInput?: (bind: string, value: string) => void
  onOpen?: (target: string, item: ScreenItem) => void
  onAction?: (action: string, item: ScreenItem, value?: boolean) => void
  onBack?: (target: string) => void
  /** an action in flight: its controls wait */
  busy?: boolean
  /** the screen sits in a page frame that already shows its title: the header keeps only its words and Back */
  framed?: boolean
  /**
   * Islands: parts the page still draws itself, each under a name. A screen places one with the island block
   * ((name <island>)); MeTTa decides where it sits and whether it shows. A name the page does not offer draws nothing.
   */
  islands?: Record<string, ReactNode>
}

const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const isBound = (v: PropValue | undefined): v is { bind: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { bind?: unknown }).bind === 'string'
/** A prop's text: itself, its bound value, or `(words "…" (bind path) …)` joined (strings and bound values only). */
function text(p: PropValue | undefined, host: ScreenHost): string {
  if (p === undefined) return ''
  if (isBound(p)) return str(host.data[p.bind])
  if (Array.isArray(p) && p[0] === 'words') return p.slice(1).map((w) => (isBound(w) || typeof w === 'string' || typeof w === 'number' ? text(w, host) : '')).join('')
  return typeof p === 'string' || typeof p === 'number' ? String(p) : ''
}
const name = (p: PropValue | undefined): string => (typeof p === 'string' ? p : '')
const list = (host: ScreenHost, p: PropValue | undefined): unknown[] => {
  const v = host.data[name(p)]
  return Array.isArray(v) ? v : []
}
/** "Let {name} use {tool.title}": an item's field, else the page's value. */
const fill = (template: string, item: ScreenItem, host: ScreenHost) => template.replace(/\{([a-z0-9_.]+)\}/gi, (_, k: string) => str(item[k] ?? host.data[k]))
const itemKey = (item: ScreenItem, i: number) => str(item.id) || String(i)

/** Tone names a screen may give a badge or a tally: a plain set, plus the hive's severity words. */
const TONES: Record<string, string> = {
  bad: 'border-bad/40 bg-bad/[0.10] text-bad',
  warn: 'border-warn/40 bg-warn/[0.08] text-warn',
  low: 'border-line-2 bg-tint/[0.04] text-ink-2',
  info: 'border-line bg-tint/[0.02] text-ink-3',
  good: 'border-good/30 bg-good/[0.06] text-good',
}
const TONE_ALIAS: Record<string, string> = { high: 'bad', medium: 'warn', ok: 'good' }
/** An own entry only: a name such as `constructor` never reaches Object.prototype. */
function own<T>(table: Record<string, T> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined
}
const toneOf = (p: PropValue | undefined, host: ScreenHost) => {
  const t = text(p, host)
  return own(TONES, own(TONE_ALIAS, t) ?? t) ?? TONES.info
}
/** How a stack frames each of its items. */
const FRAMES: Record<string, string> = {
  card: 'rounded-2xl border border-line bg-tint/[0.03] p-4',
  inset: 'rounded-xl border border-line bg-shade/20 p-3',
}
const isPlan = (v: unknown): v is ScreenPlan => typeof v === 'object' && v !== null && Array.isArray((v as ScreenPlan).parts) && typeof (v as ScreenPlan).screen === 'string'

/**
 * The host for one item of a stack: the item's own data over the page's, and every press carried up with the item's id
 * at the front of `scope`, so the page knows which item (and which item inside it) was pressed.
 */
export function scopedHost(host: ScreenHost, item: ScreenItem): ScreenHost {
  const id = str(item.id)
  const own = typeof item.data === 'object' && item.data !== null && !Array.isArray(item.data) ? (item.data as Record<string, unknown>) : {}
  const scoped = (it: ScreenItem): ScreenItem => ({ ...it, scope: [id, ...(Array.isArray(it.scope) ? it.scope : [])] })
  return {
    ...host,
    data: { ...host.data, ...own },
    onOpen: host.onOpen && ((target, it) => host.onOpen!(target, scoped(it))),
    onAction: host.onAction && ((action, it, value) => host.onAction!(action, scoped(it), value)),
  }
}

type Block = (props: Props, host: ScreenHost) => ReactNode

const BLOCKS: Record<string, Block> = {
  header: (p, host) => (
    <header className="space-y-1.5">
      {p.back && host.onBack && (
        <button type="button" onClick={() => host.onBack!(name(p.back))} className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-ink-3 hover:text-ink">
          <Icon name="back" size={14} /> Back
        </button>
      )}
      {!host.framed && p.eyebrow && <p className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{text(p.eyebrow, host)}</p>}
      {!host.framed && <h2 className="text-xl font-semibold text-balance text-ink">{text(p.title, host)}</h2>}
      {p.body && <p className="max-w-prose text-sm text-ink-2">{text(p.body, host)}</p>}
    </header>
  ),
  section: (p, host) => (
    <div className="space-y-1 border-t border-line pt-5">
      <h3 className="text-sm font-semibold text-ink">{text(p.title, host)}</h3>
      {p.body && <p className="max-w-prose text-[13px] text-ink-3">{text(p.body, host)}</p>}
    </div>
  ),
  search: (p, host) => {
    const bind = name(p.bind)
    return (
      <label className="flex items-center gap-2 rounded-xl border border-line bg-tint/[0.02] px-3 py-2 focus-within:border-accent">
        <Icon name="search" size={15} className="text-ink-3" />
        <span className="sr-only">{text(p.label, host)}</span>
        <input type="search" value={str(host.data[bind])} placeholder={text(p.placeholder, host)} onChange={(e) => host.onInput?.(bind, e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4" />
      </label>
    )
  },
  chips: (p, host) => (
    <div className="space-y-2">
      {p.label && <p className="text-[12px] text-ink-3">{text(p.label, host)}</p>}
      <ul className="flex flex-wrap gap-1.5">
        {list(host, p.source).map((c, i) => <li key={i} className="rounded-full border border-line bg-tint/[0.03] px-2.5 py-0.5 text-[12px] text-ink-2">{str(c)}</li>)}
      </ul>
    </div>
  ),
  list: (p, host) => (
    <ul aria-label={text(p.label, host)} className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {(list(host, p.source) as ScreenItem[]).map((item, i) => (
        <li key={itemKey(item, i)}>
          <Row p={p} item={item} host={host} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-tint/[0.03]" />
        </li>
      ))}
    </ul>
  ),
  cards: (p, host) => (
    <ul aria-label={text(p.label, host)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(list(host, p.source) as ScreenItem[]).map((item, i) => (
        <li key={itemKey(item, i)}>
          <Row p={p} item={item} host={host} className="flex h-full w-full flex-col gap-1.5 rounded-2xl border border-line bg-tint/[0.03] p-4 text-left hover:border-accent/60" />
        </li>
      ))}
    </ul>
  ),
  facts: (p, host) => (
    <section aria-label={text(p.label, host)}>
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        {(Array.isArray(p.rows) ? p.rows : []).map((r, i) => {
          if (!Array.isArray(r) || r[0] !== 'row') return null
          const value = text(r[2], host)
          return value ? [<dt key={`t${i}`} className="text-ink-3">{text(r[1], host)}</dt>, <dd key={`d${i}`} className="min-w-0 break-words text-ink">{value}</dd>] : null
        })}
      </dl>
    </section>
  ),
  toggles: (p, host) => (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {(list(host, p.source) as ScreenItem[]).map((item, i) => (
        <li key={itemKey(item, i)} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="min-w-0 truncate text-sm text-ink">{str(item[name(p.label)])}</span>
          <Switch checked={item[name(p.checked)] === true} disabled={host.busy} label={fill(text(p.aria, host) || str(item[name(p.label)]), item, host)}
            onChange={(v) => host.onAction?.(name(p.action), item, v)} />
        </li>
      ))}
    </ul>
  ),
  notice: (p, host) => (
    <p role={p.tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-xl border px-4 py-2.5 text-[13px]',
      p.tone === 'warn' ? 'border-warn/40 bg-warn/[0.08] text-warn' : p.tone === 'bad' ? 'border-bad/40 bg-bad/[0.10] text-bad' : 'border-line bg-tint/[0.03] text-ink-2')}>
      {text(p.text, host)}
    </p>
  ),
  empty: (p, host) => <EmptyState icon={iconOr(text(p.icon, host), 'sparkles')} title={text(p.title, host)} body={text(p.body, host) || undefined} />,
  waiting: (p, host) => (
    <div role="status" aria-label={text(p.label, host) || 'Loading'}>
      <Skeleton className="h-40" />
    </div>
  ),
  note: (p, host) => <p className="text-meta text-ink-4">{text(p.text, host)}</p>,
  /** A paragraph of plain words, such as what an app does: body text, neither a heading nor small print. */
  paragraph: (p, host) => <p className="max-w-prose text-[13px] leading-relaxed text-ink-2">{text(p.text, host)}</p>,
  segments: (p, host) => {
    const bind = name(p.bind)
    const current = str(host.data[bind])
    return (
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={text(p.label, host)}>
        {(list(host, p.source) as ScreenItem[]).map((item, i) => {
          const id = str(item.id)
          return (
            <button key={id || i} type="button" role="radio" aria-checked={current === id} onClick={() => host.onInput?.(bind, id)}
              className={cx('min-h-9 rounded-full border px-3 text-[12.5px]', current === id ? 'border-control bg-tint/[0.09] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}>
              {str(item.label)} <span className="text-ink-4">{str(item.count) || '0'}</span>
            </button>
          )
        })}
      </div>
    )
  },
  menus: (p, host) => (
    <div className="flex flex-wrap gap-2">
      {(Array.isArray(p.menus) ? p.menus : []).map((m, i) => {
        // (menu label bind source every)
        if (!Array.isArray(m) || m[0] !== 'menu') return null
        const bind = name(m[2])
        return (
          <select key={i} aria-label={text(m[1], host)} value={str(host.data[bind])} onChange={(e) => host.onInput?.(bind, e.target.value)}
            className="min-h-10 rounded-xl border border-line bg-shade/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
            <option value="">{text(m[4], host)}</option>
            {(list(host, m[3]) as ScreenItem[]).map((o, j) => <option key={str(o.id) || j} value={str(o.id)}>{str(o.label)}</option>)}
          </select>
        )
      })}
    </div>
  ),
  entries: (p, host) => (
    <ul aria-label={text(p.label, host)} className="overflow-hidden rounded-2xl border border-line bg-tint/[0.02]">
      {(list(host, p.source) as ScreenItem[]).map((item, i) => <Entry key={itemKey(item, i)} p={p} item={item} host={host} first={i === 0} />)}
    </ul>
  ),
  island: (p, host) => <>{own(host.islands, name(p.name)) ?? null}</>,
  tally: (p, host) => (
    <ul aria-label={text(p.label, host) || undefined} className="flex flex-wrap items-center gap-2">
      {(Array.isArray(p.items) ? p.items : []).map((it, i) => Array.isArray(it) && it[0] === 'item' ? (
        <li key={i} className={cx('rounded-full border px-3 py-1 text-[12px]', toneOf(it[3], host))}>{text(it[1], host)} {text(it[2], host)}</li>
      ) : null)}
    </ul>
  ),
  segmented: (p, host) => {
    const bind = name(p.bind)
    const options = (Array.isArray(p.options) ? p.options : []).flatMap((o) => Array.isArray(o) && o[0] === 'option' ? [{ value: text(o[1], host), label: text(o[2], host) }] : [])
    return <Segmented label={text(p.label, host)} value={str(host.data[bind])} options={options} onChange={(v) => host.onInput?.(bind, v)} />
  },
  stack: (p, host) => (
    // (columns auto): the items share a responsive grid (one column on a phone, more as the screen widens)
    <ul aria-label={text(p.label, host) || undefined}
      className={name(p.columns) === 'auto' ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3' : name(p.frame) === 'card' ? 'space-y-4' : 'space-y-2'}>
      {(list(host, p.source) as ScreenItem[]).map((item, i) => {
        if (!isPlan(item.plan)) return null
        // (current (bind id)): the item the person came for is ringed and marked
        const current = p.current !== undefined && str(item.id) === text(p.current, host)
        return (
          // an item may wear a look of its own (an app's identity: its colour variables, type and motif)
          <li key={itemKey(item, i)} aria-current={current || undefined} data-app-type={itemLook(item)?.type}
            className={cx(own(FRAMES, name(p.frame)), current && 'ring-2 ring-accent/60', itemLook(item) && 'relative overflow-hidden')} style={itemLook(item)?.style}>
            {itemLook(item)?.motif && itemLook(item)?.motif !== 'none' && <div className="app-motif" data-motif={itemLook(item)!.motif} aria-hidden="true" />}
            <Parts plan={item.plan} host={scopedHost(host, item)} className="relative space-y-3" />
          </li>
        )
      })}
    </ul>
  ),
  line: (p, host) => {
    const title = text(p.title, host)
    const target = name(p.open)
    return (
      <div className={cx('flex items-center gap-3', p.dim !== undefined && host.data[name(p.dim)] === true && 'opacity-60')}>
        {/* (orb hue-path) (status status-path) (orb-size n): a mind's or a person's orb before the name */}
        {typeof host.data[name(p.orb)] === 'number' && <Orb hue={host.data[name(p.orb)] as number} size={typeof p['orb-size'] === 'number' ? p['orb-size'] : 22} status={(str(host.data[name(p.status)]) || 'awake') as AgentStatus} />}
        {/* (icon icon-path) (lit flag-path): an icon tile before the name, lit in the accent while the flag holds */}
        {p.icon !== undefined && str(host.data[name(p.icon)]) !== '' && (
          <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-2xl border border-line bg-tint/[0.04]', host.data[name(p.lit)] === true ? 'text-accent shadow-[0_0_30px_-8px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]' : 'text-ink-3')}>
            <Icon name={iconOr(str(host.data[name(p.icon)]), 'spark')} size={22} />
          </span>
        )}
        {target && host.onOpen
          ? <button type="button" className="text-left text-[14px] font-medium text-ink hover:underline" onClick={() => host.onOpen!(target, {})}>{title}</button>
          : <span className="text-[14px] font-medium text-ink">{title}</span>}
        {p.meta && <span className="text-[11.5px] text-ink-4">{text(p.meta, host)}</span>}
        {p.badge && <span className={cx('ml-auto rounded-full border px-2.5 py-0.5 text-[11px]', toneOf(p.tone, host))}>{text(p.badge, host)}</span>}
      </div>
    )
  },
  disclosure: (p, host) => {
    const open = host.data[name(p.expanded)] === true
    const meta = [text(p.meta, host), text(p.note, host)].filter(Boolean).join(' · ')
    return (
      <button type="button" aria-expanded={open} onClick={() => host.onAction?.(name(p.action), {})}
        className={cx('flex w-full items-start gap-3 text-left', p.quiet === 'yes' && 'opacity-55')}>
        {p.badge && <span className={cx('mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[11px]', toneOf(p.tone, host))}>{text(p.badge, host)}</span>}
        <span className="min-w-0 flex-1 text-[13px]">
          <span className="text-ink">{text(p.title, host)}</span>
          {meta && <span className="text-ink-4"> · {meta}</span>}
        </span>
        <Icon name="chevron" className={cx('shrink-0 text-ink-4 transition-transform', open ? '-rotate-90' : 'rotate-90')} />
      </button>
    )
  },
  /**
   * One choice from a few that changes a record (a person's role, say). Unlike segmented, which binds a page value, a
   * press goes out as `action` with the chosen value in the item, so inside a stack it carries the item's scope.
   */
  /**
   * A choice that changes a record (each choice is a write): a radio group with one tab stop, where the arrow keys move
   * focus without choosing and Space, Enter or a press chooses (lib/radio 'focus' mode). (waits flag) holds it, as
   * does a page that is busy.
   */
  chooser: (p, host) => {
    const options = (Array.isArray(p.options) ? p.options : []).flatMap((o) => Array.isArray(o) && o[0] === 'option' ? [{ value: text(o[1], host), label: text(o[2], host) }] : [])
    const values = options.map((o) => o.value)
    const current = str(host.data[name(p.value)])
    const held = host.busy === true || (p.waits !== undefined && host.data[name(p.waits)] === true)
    const choose = (v: string) => { if (!held && v !== current) host.onAction?.(name(p.action), { value: v }) }
    return (
      <div role="radiogroup" aria-label={text(p.label, host)} aria-disabled={held || undefined} className="relative inline-flex rounded-xl border border-line bg-tint/[0.03] p-1">
        {options.map((o) => {
          const on = o.value === current
          return (
            <button key={o.value} type="button" disabled={held} {...radioProps(o.value, values, current, choose, 'focus')} onClick={() => choose(o.value)}
              className={cx('relative min-h-9 flex-1 rounded-lg px-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:opacity-50',
                on ? 'border border-control bg-tint/[0.09] text-ink' : 'border border-transparent text-ink-3 hover:text-ink-2')}>
              {o.label}
            </button>
          )
        })}
      </div>
    )
  },
  code: (p, host) => (
    <pre aria-label={text(p.label, host) || undefined} className="max-h-48 overflow-auto rounded-lg border border-line bg-shade/30 p-3 font-mono text-[12px] whitespace-pre-wrap break-words text-ink-2">{text(p.text, host)}</pre>
  ),
  keyfield: (p, host) => <KeyField p={p} host={host} />,
  rename: (p, host) => <RenameField p={p} host={host} />,
  /**
   * A bar split into the parts of a whole (`source`: items with `n`, `label` and `color`), each as wide as its count,
   * named for assistive technology by its counts; `text` is the line under it, marked possibly short by `partial`.
   */
  progress: (p, host) => {
    const parts = (list(host, p.source) as ScreenItem[]).filter((s) => typeof s.n === 'number' && s.n > 0)
    const whole = Math.max(1, parts.reduce((sum, s) => sum + (s.n as number), 0))
    const partial = p.partial !== undefined && host.data[name(p.partial)] === true
    return (
      <div className="space-y-1">
        <div role="img" aria-label={parts.map((s) => `${str(s.n)} ${str(s.label)}`).join(', ')} className="flex h-1.5 overflow-hidden rounded-full bg-tint/[0.06]">
          {parts.map((s, i) => <span key={str(s.label) || i} style={{ width: `${((s.n as number) / whole) * 100}%`, background: str(s.color) || undefined }} />)}
        </div>
        {p.text && <p className="text-[12px] text-ink-3" data-partial={partial || undefined}>{text(p.text, host)}</p>}
      </div>
    )
  },
  orrery: (p, host) => <Orrery p={p} host={host} />,
  fields: (p, host) => <Fields p={p} host={host} />,
  orbs: (p, host) => {
    const items = list(host, p.source) as ScreenItem[]
    const most = typeof p.most === 'number' && p.most >= 0 ? p.most : items.length
    const target = name(p.open)
    return (
      <ul aria-label={text(p.label, host) || undefined} className="flex flex-wrap items-center gap-1">
        {items.slice(0, most).map((item, i) => {
          const label = fill(text(p.aria, host) || str(item.name), item, host)
          const orb = <Orb hue={typeof item.hue === 'number' ? item.hue : 252} status={(str(item.status) || undefined) as AgentStatus | undefined} size={18} />
          return (
            <li key={itemKey(item, i)}>
              {target && host.onOpen
                ? <button type="button" title={str(item.name)} aria-label={label} onClick={() => host.onOpen!(target, item)} className="rounded-full p-0.5 hover:bg-tint/[0.06]">{orb}</button>
                : <span role="img" title={str(item.name)} aria-label={label} className="inline-flex p-0.5">{orb}</span>}
            </li>
          )
        })}
        {items.length > most && <li className="text-[11px] text-ink-4">+{items.length - most}</li>}
      </ul>
    )
  },
  /** One choice from a few, as tabs: each with its count when the item carries one, and a colour dot and tint when it does. */
  tabs: (p, host) => {
    const bind = name(p.bind)
    const current = str(host.data[bind])
    return (
      <div role="tablist" aria-label={text(p.label, host)} className="no-scrollbar flex gap-2 overflow-x-auto">
        {(list(host, p.source) as ScreenItem[]).map((item, i) => {
          const id = str(item.id)
          const on = current === id
          const [color, glow, tint] = [str(item.color), str(item.glow), str(item.tint)]
          return (
            <button key={id || i} type="button" role="tab" aria-selected={on} onClick={() => host.onInput?.(bind, id)}
              className={cx('relative flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[13.5px] transition-colors', on ? 'border-line-2 text-ink' : 'border-line text-ink-3 hover:text-ink-2')}>
              {on && <m.span layoutId={`tabs-${bind}`} className={cx('absolute inset-0 rounded-full', !tint && 'bg-tint/[0.07]')} style={tint ? { background: tint } : undefined}
                transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              {color && <span className="relative size-2.5 rounded-full" style={{ background: color, boxShadow: glow ? `0 0 10px ${glow}` : undefined }} />}
              <span className="relative font-medium">{str(item.label)}</span>
              {item.count !== undefined && <span className="relative font-mono text-[12px] text-ink-4">{str(item.count) || '0'}</span>}
            </button>
          )
        })}
      </div>
    )
  },
  /**
   * A row of filters that press on and off (aria-pressed), each with an optional note, count (and the count's own
   * title), and hint; a quiet item is drawn dashed. A press sends the item's id to `bind`; the page decides what pressing
   * the current one means. An optional link at the end (`more`, `more_action`).
   */
  pills: (p, host) => {
    const bind = name(p.bind)
    // (multi yes): several may be on; the bound value is a list, and a press sends `action` with the item and its new state
    const multi = p.multi === 'yes'
    const chosen = multi && Array.isArray(host.data[bind]) ? (host.data[bind] as unknown[]).map(str) : []
    const current = str(host.data[bind])
    const more = name(p.more_action)
    return (
      <div role="group" aria-label={text(p.label, host)} className="no-scrollbar flex items-center gap-1.5 overflow-x-auto">
        {p.icon && <Icon name={iconOr(text(p.icon, host), 'filter')} size={13} className="shrink-0 text-ink-4" />}
        {(list(host, p.source) as ScreenItem[]).map((item, i) => {
          const id = str(item.id)
          const on = multi ? chosen.includes(id) : current === id
          const quiet = item.quiet === true
          const [note, count, hint] = [str(item.note), str(item.count), str(item.hint)]
          return (
            <button key={id || i} type="button" aria-pressed={on} title={str(item.title) || undefined} onClick={() => (multi ? host.onAction?.(name(p.action), item, !on) : host.onInput?.(bind, id))}
              className={cx('flex min-h-8 max-w-[18rem] shrink-0 items-center gap-1.5 rounded-full border px-3', quiet ? 'border-dashed text-[12px]' : 'text-[12.5px]',
                on ? (item.accent === true ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line-2 bg-tint/[0.07] text-ink') : quiet ? 'border-line text-ink-4 hover:text-ink-2' : 'border-line text-ink-2 hover:text-ink')}>
              <span className="truncate">{str(item.label)}</span>
              {note && <span className="text-ink-4">{`· ${note}`}</span>}
              {count && <span className="font-mono text-[11.5px] text-ink-4" title={str(item.count_title) || undefined} data-count-partial={item.partial === true || undefined}>{count}</span>}
              {hint && <span className="text-ink-3">{`· ${hint}`}</span>}
            </button>
          )
        })}
        {more && (
          <button type="button" onClick={() => host.onAction?.(more, {})} className="ml-1 flex min-h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] text-accent hover:text-ink">
            {text(p.more, host)} <Icon name="chevron" size={11} />
          </button>
        )}
      </div>
    )
  },
  /** One way to see something, from a few, each with an icon: radio buttons with one tab stop that the arrow keys move. */
  switcher: (p, host) => {
    const bind = name(p.bind)
    const current = str(host.data[bind])
    const options = (Array.isArray(p.options) ? p.options : []).flatMap((o) => Array.isArray(o) && o[0] === 'option' ? [{ value: text(o[1], host), label: text(o[2], host), icon: text(o[3], host) }] : [])
    const values = options.map((o) => o.value)
    const choose = (v: string) => host.onInput?.(bind, v)
    return (
      <div role="radiogroup" aria-label={text(p.label, host)} className="inline-flex rounded-xl border border-line p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" {...radioProps(o.value, values, current, choose)} onClick={() => choose(o.value)}
            className={cx('flex min-h-9 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium', current === o.value ? 'bg-tint/[0.09] text-ink' : 'text-ink-3 hover:text-ink-2')}>
            {o.icon && <Icon name={iconOr(o.icon, 'list')} size={13} />}
            {o.label}
          </button>
        ))}
      </div>
    )
  },
  actions: (p, host) => (
    <div className="flex flex-wrap gap-2">
      {(Array.isArray(p.items) ? p.items : []).map((a, i) => {
        // (action label intent [waits-on] [icon]): the bound flag (- for none) holds this one button while it is true
        if (!Array.isArray(a) || a[0] !== 'action') return null
        const waits = a[3] !== undefined && name(a[3]) !== '-' ? name(a[3]) : ''
        const disabled = host.busy || (waits !== '' && host.data[waits] === true)
        const press = () => host.onAction?.(name(a[2]), {})
        const icon = a[4] !== undefined ? iconOr(name(a[4]), 'plus') : undefined
        // (tone primary): the page's main action, drawn as the look's primary button
        return p.tone === 'primary'
          ? <Button key={i} type="button" variant="primary" icon={icon} disabled={disabled} onClick={press}>{text(a[1], host)}</Button>
          : <button key={i} type="button" disabled={disabled} onClick={press} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:border-accent disabled:opacity-50">{text(a[1], host)}</button>
      })}
    </div>
  ),
  /**
   * Buttons that each carry their own weight, icon and accessible name: (button label action ((aria "…") (icon pause)
   * (variant primary))). The aria text may name the row it sits in ("Hold reloads of {app.name}").
   */
  buttons: (p, host) => (
    <div className="flex flex-wrap items-center gap-2">
      {(Array.isArray(p.items) ? p.items : []).map((b, i) => {
        if (!Array.isArray(b) || b[0] !== 'button') return null
        const opts: Record<string, PropValue> = {}
        for (const o of Array.isArray(b[3]) ? b[3] : []) if (Array.isArray(o) && o.length === 2 && typeof o[0] === 'string') opts[o[0]] = o[1]
        const variant = name(opts.variant)
        const aria = text(opts.aria, host)
        return (
          // (expanded flag-path): a button that opens and closes something says which it is
          <Button key={i} type="button" disabled={host.busy} variant={variant === 'primary' || variant === 'ghost' || variant === 'danger' ? variant : 'subtle'}
            icon={opts.icon ? iconOr(name(opts.icon), 'sparkles') : undefined} aria-label={aria ? fill(aria, {}, host) : undefined}
            aria-expanded={opts.expanded !== undefined ? host.data[name(opts.expanded)] === true : undefined}
            onClick={() => host.onAction?.(name(b[2]), {})}>
            {text(b[1], host)}
          </Button>
        )
      })}
    </div>
  ),
  /** A question, then one button that goes ahead (drawn as risky) and one that cancels. */
  confirm: (p, host) => (
    <div role="group" aria-label={text(p.text, host)} className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] text-ink-2">{text(p.text, host)}</span>
      <Button type="button" variant="danger" disabled={host.busy} className="min-h-8 px-3 text-[12.5px]" onClick={() => host.onAction?.(name(p.yes_action), {})}>{text(p.yes, host)}</Button>
      <Button type="button" variant="ghost" disabled={host.busy} className="min-h-8 px-3 text-[12.5px]" onClick={() => host.onAction?.(name(p.no_action), {})}>{text(p.no, host)}</Button>
    </div>
  ),
  /**
   * A value shown once (a new password, say): a warning above it, Copy and Hide beside it, a note under it. The two
   * buttons may be renamed (copy_label, hide_label); (alert yes) announces the value as it appears.
   */
  reveal: (p, host) => (
    <div className="space-y-1.5" role={p.alert === 'yes' ? 'alert' : undefined}>
      <p className="text-[12.5px] text-warn">{text(p.label, host)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-lg bg-shade/40 px-2 py-1 font-mono text-[13px] break-all text-ink">{text(p.value, host)}</code>
        <Button type="button" variant="subtle" icon="copy" className="min-h-8 px-2.5 text-[12px]" onClick={() => host.onAction?.(name(p.copy), {})}>{text(p.copy_label, host) || 'Copy'}</Button>
        <Button type="button" variant="ghost" className="min-h-8 px-2.5 text-[12px]" onClick={() => host.onAction?.(name(p.hide), {})}>{text(p.hide_label, host) || 'Hide'}</Button>
      </div>
      {p.note && <p className="text-[12px] text-ink-4">{text(p.note, host)}</p>}
    </div>
  ),
}

/**
 * A hidden field for pasting a key. What is typed stays in this field: it goes back only with the submit press, as the
 * item's `value`, and never into the page's data. The field waits while the bound `busy` flag is true, takes focus when
 * the bound `focus` flag is, and the help line links out only to an https address.
 */
function KeyField({ p, host }: { p: Props; host: ScreenHost }) {
  const [value, setValue] = useState('')
  const busy = host.data[name(p.busy)] === true
  const focus = host.data[name(p.focus)] === true
  const [help, href, linkLabel] = [text(p.help, host), text(p.link, host), text(p.link_label, host)]
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    if (v && !busy) host.onAction?.(name(p.action), { value: v })
  }
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <input type="password" autoComplete="off" spellCheck={false} data-autofocus={focus ? '' : undefined} autoFocus={focus}
          aria-label={text(p.label, host)} placeholder={text(p.placeholder, host)} value={value} onChange={(e) => setValue(e.target.value)}
          className="min-h-11 min-w-0 flex-1 basis-full rounded-xl border border-line bg-shade/25 px-3 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2 sm:basis-0" />
        <Button type="submit" variant="primary" disabled={!value.trim() || busy} icon={busy ? undefined : 'link'}>
          {busy ? text(p.waiting, host) || text(p.submit, host) : text(p.submit, host)}
        </Button>
        {p.cancel && <Button type="button" variant="ghost" onClick={() => host.onAction?.(name(p.cancel_action), {})}>{text(p.cancel, host)}</Button>}
      </div>
      {help && (
        <p className="text-[11px] text-ink-4">
          {help}
          {/^https:\/\//.test(href) && linkLabel && (
            <>
              {' '}
              <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink-3 underline-offset-2 hover:text-ink hover:underline">
                {linkLabel} <Icon name="external" size={11} />
              </a>
            </>
          )}
        </p>
      )}
    </form>
  )
}

/**
 * A name being changed: a text field that starts from the bound `value` and takes focus. Enter sends `action` with the
 * trimmed value (the page decides whether it changed); Escape or leaving the field sends `cancel_action`.
 */
function RenameField({ p, host }: { p: Props; host: ScreenHost }) {
  const [value, setValue] = useState(() => text(p.value, host))
  const cancel = () => host.onAction?.(name(p.cancel_action), {})
  const submit = (e: FormEvent) => {
    e.preventDefault()
    host.onAction?.(name(p.action), { value: value.trim() })
  }
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 gap-1.5">
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={cancel} onKeyDown={(e) => { if (e.key === 'Escape') cancel() }}
        aria-label={text(p.label, host)} maxLength={typeof p.maxlength === 'number' && p.maxlength > 0 ? p.maxlength : undefined}
        className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-shade/30 px-2 text-[14px] text-ink outline-none" />
    </form>
  )
}

/**
 * A group's minds circling a glow in its hue (`hue`: a bound number; `minds`: a bound list, each with `hue` and
 * `status`). With `open` the whole of it is one button, named by `aria` ("Open {swarm.name}"); the sky itself is
 * decoration, hidden from assistive technology.
 */
function Orrery({ p, host }: { p: Props; host: ScreenHost }) {
  const h = host.data[name(p.hue)]
  const hue = typeof h === 'number' ? h : 252
  const minds = list(host, p.minds) as ScreenItem[]
  const target = name(p.open)
  const label = fill(text(p.aria, host), {}, host)
  const sky = (
    <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
      <span className="absolute inset-0" style={{ background: `radial-gradient(60% 80% at 50% 55%, ${hsl(hue, 90, 55, 0.35)}, transparent 70%)` }} />
      <span className="absolute size-7 rounded-full" style={{ background: `radial-gradient(circle, #fff 0 12%, ${hsl(hue, 100, 75)} 30%, ${hsl(hue, 90, 60, 0)} 72%)`, boxShadow: `0 0 40px ${hsl(hue, 100, 60, 0.6)}` }} />
      {[46, 70, 94].map((r) => <span key={r} className="absolute rounded-full border" style={{ width: r * 2, height: r * 0.8, borderColor: hsl(hue, 80, 75, 0.12) }} />)}
      {minds.map((mind, i) => {
        const rx = 46 + (i % 3) * 24
        const T = 16 + i * 4.5
        const delay = -((i * 7.3) % T)
        const status = (str(mind.status) || undefined) as AgentStatus | undefined
        return (
          <span key={itemKey(mind, i)} className="absolute" style={{ ['--r' as string]: `${rx}px`, animation: `orbit-x ${T / 2}s ease-in-out ${delay}s infinite alternate` }}>
            <span className="block" style={{ ['--r' as string]: `${rx * 0.4}px`, animation: `orbit-y ${T / 2}s ease-in-out ${delay - T / 4}s infinite alternate` }}>
              <Orb hue={typeof mind.hue === 'number' ? mind.hue : 252} status={status} size={status === 'awake' ? 18 : 13} />
            </span>
          </span>
        )
      })}
    </span>
  )
  const cls = 'relative block h-36 w-full overflow-hidden rounded-xl'
  return target && host.onOpen
    ? <button type="button" aria-label={label || undefined} onClick={() => host.onOpen!(target, {})} className={cls}>{sky}</button>
    : <div className={cls}>{sky}</div>
}

const FIELD_INPUT = 'block w-full rounded-xl border border-line bg-shade/25 px-3 py-2 text-[14px] text-ink disabled:opacity-60'

/**
 * Labelled fields to fill in: (field <kind> <label> <bind> ((option value) …)). A select, number or text field shows the
 * bound value and sends each change back through `onInput`; `(waits <flag>)` holds a field while the bound flag is true.
 *   select   (source <list of id and label>) (prompt "Choose"): the empty choice first, so labelled
 *   number   (least …) (most …) (step …): its lowest and highest values, and the step between
 *   text     (placeholder …) (quiet yes): the label is for assistive technology only
 *   checks   a group of tick boxes under the label as its legend, one per item of the list at <bind> (id, label, on);
 *            a tick sends (action …) with the item and whether it is now ticked
 * `(columns two)` lays the fields two to a row on a wider screen.
 */
function Fields({ p, host }: { p: Props; host: ScreenHost }) {
  const fields = (Array.isArray(p.items) ? p.items : []).flatMap((f) => (Array.isArray(f) && f[0] === 'field' ? [f] : []))
  return (
    <div className={name(p.columns) === 'two' ? 'grid gap-3 sm:grid-cols-2' : 'space-y-3'}>
      {fields.map((f, i) => {
        const opts: Record<string, PropValue> = {}
        for (const o of Array.isArray(f[4]) ? f[4] : []) if (Array.isArray(o) && o.length === 2 && typeof o[0] === 'string') opts[o[0]] = o[1]
        const [kind, label, bind] = [name(f[1]), text(f[2], host), name(f[3])]
        const held = opts.waits !== undefined && host.data[name(opts.waits)] === true
        const change = (v: string) => host.onInput?.(bind, v)
        if (kind === 'checks') {
          const action = name(opts.action)
          return (
            <fieldset key={i}>
              <legend className="text-[12.5px] text-ink-3">{label}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(list(host, bind) as ScreenItem[]).map((item, j) => (
                  <label key={itemKey(item, j)} className="flex items-center gap-2 rounded-xl border border-line px-3 py-1.5 text-[13px] text-ink">
                    <input type="checkbox" checked={item.on === true} disabled={held} onChange={(e) => host.onAction?.(action, item, e.target.checked)} />
                    {str(item.label)}
                  </label>
                ))}
              </div>
            </fieldset>
          )
        }
        if (kind === 'select') {
          return (
            <label key={i} className="block text-[12.5px] text-ink-3">
              {label}
              <select className={cx(FIELD_INPUT, 'mt-1')} value={str(host.data[bind])} disabled={held} onChange={(e) => change(e.target.value)}>
                <option value="">{text(opts.prompt, host)}</option>
                {(list(host, opts.source) as ScreenItem[]).map((o, j) => <option key={str(o.id) || j} value={str(o.id)}>{str(o.label)}</option>)}
              </select>
            </label>
          )
        }
        const quiet = name(opts.quiet) === 'yes'
        return (
          <label key={i} className="block text-[12.5px] text-ink-3">
            {quiet ? <span className="sr-only">{label}</span> : label}
            <input type={kind === 'number' ? 'number' : 'text'} value={str(host.data[bind])} disabled={held} onChange={(e) => change(e.target.value)}
              min={text(opts.least, host) || undefined} max={text(opts.most, host) || undefined} step={text(opts.step, host) || undefined}
              placeholder={text(opts.placeholder, host) || undefined} className={cx(FIELD_INPUT, !quiet && 'mt-1')} />
          </label>
        )
      })}
    </div>
  )
}

/** The look a stack item wears, when the page gave it one: CSS variables, a type and a motif (an app's identity). */
type ItemLook = { style?: CSSProperties; type?: string; motif?: string }
const itemLook = (item: ScreenItem): ItemLook | null => {
  const l = item.look
  return l && typeof l === 'object' && !Array.isArray(l) ? (l as ItemLook) : null
}

/** One item in a list or a card: its title, summary and meta fields; pressing it opens `open` when the screen says so. */
function Row({ p, item, host, className }: { p: Props; item: ScreenItem; host: ScreenHost; className: string }) {
  const meta = (Array.isArray(p.meta) ? p.meta : []).map((f) => str(item[name(f)])).filter(Boolean)
  // optional item fields the screen can name: a leading icon, a colour dot, a mind's orb
  const icon = p.icon ? str(item[name(p.icon)]) : ''
  const hue = p.hue ? item[name(p.hue)] : undefined
  const orbHue = p.orb ? item[name(p.orb)] : undefined
  // the row the person has open, when the screen binds one: highlighted and announced as current
  const selected = p.current ? text(p.current, host) : ''
  const current = selected !== '' && str(item.id) === selected
  const body = (
    <>
      {icon && <Icon name={iconOr(icon, 'sparkles')} size={16} className="mt-0.5 shrink-0 text-ink-3" />}
      {typeof hue === 'number' && <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: hsl(hue) }} />}
      {typeof orbHue === 'number' && <Orb hue={orbHue} size={22} status={(str(item[name(p.status)]) || 'awake') as AgentStatus} />}
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm font-medium text-ink">{str(item[name(p.title)])}</span>
        {p.summary && <span className="line-clamp-2 block text-[13px] text-ink-2">{str(item[name(p.summary)])}</span>}
        {meta.length > 0 && <span className="block text-[12px] text-ink-3">{meta.join(' · ')}</span>}
      </span>
    </>
  )
  const cls = cx(className, current && 'bg-tint/[0.07]')
  const target = name(p.open)
  if (!target || !host.onOpen) return <div className={cls} aria-current={current || undefined}>{body}</div>
  return <button type="button" className={cls} aria-current={current || undefined} onClick={() => host.onOpen!(target, item)}>{body}</button>
}

/**
 * One row of `entries`: an icon, the title with its tag and badge, a meta line, a detail line ending in a code, and the
 * row's own button. The button shows only when the item carries its label, and a press opens `open` with the item.
 */
function Entry({ p, item, host, first }: { p: Props; item: ScreenItem; host: ScreenHost; first: boolean }) {
  const field = (k: PropValue | undefined) => str(item[name(k)])
  const [badge, meta, detail, code, action] = [field(p.badge), field(p.meta), field(p.detail), field(p.code), field(p.action)]
  const target = name(p.open)
  return (
    <li className={cx('flex items-start gap-3 px-4 py-3', !first && 'border-t border-line')}>
      {p.icon && (
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-line bg-tint/[0.04] text-ink-3">
          <Icon name={iconOr(field(p.icon), 'layers')} size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[14px] font-medium text-ink [overflow-wrap:anywhere]">{field(p.title)}</span>
          {p.tag && <span className="text-meta text-ink-4">{field(p.tag)}</span>}
          {badge && <span className="rounded-full border border-line px-1.5 py-px text-[10.5px] text-ink-3">{badge}</span>}
        </div>
        {meta && <div className="mt-0.5 text-[12px] text-ink-3">{meta}</div>}
        {(detail || code) && (
          <div className="mt-0.5 text-meta text-ink-4">
            {detail}
            {code && <span className="font-mono">{detail ? ' · ' : ''}{code}</span>}
          </div>
        )}
      </div>
      {action && target && host.onOpen && (
        <Button variant="ghost" className="min-h-9 shrink-0 px-2.5 text-[12px]" onClick={() => host.onOpen!(target, item)}>
          {action}
        </Button>
      )}
    </li>
  )
}

/** px of depth per layer in a 3D look: enough to read as stacked planes, never enough to blur text. */
const Z_STEP = 18

/**
 * The parts MeTTa composed, in order, each at the depth MeTTa gave it. A flat look shows depth as elevation (a softer
 * or stronger shadow); a 3D look places each part on its own plane in one perspective, nearest first. A part with no
 * drawable block draws nothing (it is in `plan.missing`).
 */
export function Screen({ plan, host, className }: { plan: ScreenPlan; host: ScreenHost; className?: string }) {
  return <Parts plan={plan} host={host} className={cx('space-y-5', className)} />
}

/** One composed plan's parts in a frame (the page's screen, or one item of a stack). */
function Parts({ plan, host, className }: { plan: ScreenPlan; host: ScreenHost; className: string }) {
  const deep = plan.space === '3d'
  const drawPart = (part: DrawnPart) => {
    const draw = part.block ? own(BLOCKS, part.block) : undefined
    if (!draw) return null
    // an island the page does not offer here draws nothing, and leaves no empty, spaced wrapper behind
    if (part.block === 'island' && own(host.islands, name(part.props.name)) === undefined) return null
    // an island stays on the flat plane: a transform would become the containing block of any fixed pop-up inside it
    const lift = deep && part.block !== 'island'
    // (hidden-when (flag …)): drawn and kept mounted, but hidden while any of those bound flags is true (an app's frame
    // under another view keeps its state)
    const hidden = Array.isArray(part.props['hidden-when']) && part.props['hidden-when'].some((f) => host.data[name(f)] === true)
    return (
      <div key={part.order} data-screen-part={`${plan.screen}.${part.order}`} data-block={part.block!} data-layer={part.depth.layer}
        data-tour={text(part.props.tour, host) || undefined} hidden={hidden || undefined}
        // (fill yes): the part grows to the height its screen is given (a studio or canvas that fills its bench)
        className={cx(!deep && part.depth.z >= 3 && 'drop-shadow-[0_6px_18px_rgb(0_0_0/0.18)]', !deep && part.depth.z === 2 && 'drop-shadow-[0_2px_8px_rgb(0_0_0/0.12)]',
          part.props.fill === 'yes' && 'flex min-h-0 flex-1 flex-col')}
        style={lift ? { transform: `translateZ(${part.depth.z * Z_STEP}px)`, transformStyle: 'preserve-3d' } : undefined}>
        {draw(part.props, host)}
      </div>
    )
  }
  // parts MeTTa put in one row sit side by side (wrapping when narrow); the rest each take the full width
  const column = (parts: DrawnPart[]) => {
    const out: ReactNode[] = []
    for (let i = 0; i < parts.length; ) {
      const row = parts[i].place.row
      let j = i + 1
      if (row) while (j < parts.length && parts[j].place.row === row) j++
      const drawn = parts.slice(i, j).map(drawPart).filter(Boolean)
      if (row && drawn.length > 0) out.push(<div key={`row-${row}-${parts[i].order}`} data-screen-row={row} className="flex flex-wrap items-start gap-2">{drawn}</div>)
      else out.push(...drawn)
      i = j
    }
    return out
  }
  const stage = deep ? { perspective: '1400px', perspectiveOrigin: '50% 0', transformStyle: 'preserve-3d' as const } : undefined
  const main = plan.parts.filter((p) => p.place.region === 'main')
  const aside = plan.parts.filter((p) => p.place.region === 'aside')
  if (aside.length === 0) {
    // a screen with a part that fills is a column as tall as its parent, so that part can take the rest of it
    const fills = main.some((p) => p.props.fill === 'yes')
    return <div className={cx(className, fills && 'flex h-full min-h-0 flex-col')} data-screen={plan.screen} data-look={plan.look} data-space={plan.space} style={stage}>{column(main)}</div>
  }
  // a side column on a wide screen, after the main column on a narrow one; any aside part may name it, (region_label …)
  const asideLabel = aside.map((p) => text(p.props.region_label, host)).find(Boolean)
  return (
    <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] md:items-start md:gap-6" data-screen={plan.screen} data-look={plan.look} data-space={plan.space} style={stage}>
      <div className={cx(className, 'min-w-0')}>{column(main)}</div>
      <aside className={cx(className, 'mt-5 min-w-0 md:mt-0')} data-screen-region="aside" aria-label={asideLabel || undefined}>{column(aside)}</aside>
    </div>
  )
}

/** The blocks this renderer draws: the build checks the MeTTa vocabulary against it. */
export const DRAWN_BLOCKS = Object.keys(BLOCKS).sort()
