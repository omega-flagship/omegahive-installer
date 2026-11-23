// Purpose: draws what MeTTa composed: one small component per block, filled from the page's data, every press handed
// back to the page, and tells the stage which parts the open page draws.
import { AnimatePresence, m } from 'framer-motion'
import { Component, Fragment, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react'
import type { AgentStatus } from '../api/types'
import { guardComposing } from '../features/ask/keys'
import { refPieces } from '../lib/artifactRefs'
import { plainPieces } from '../lib/beliefSentence'
import { cx } from '../lib/cx'
import { screenFailed } from '../lib/screenFailures'
import { Button, EmptyState, Orb, Segmented, Skeleton, Switch } from '../ui/primitives'
import { hsl } from '../lib/color'
import { radioProps } from '../lib/radio'
import { Icon } from '../ui/Icon'
import { iconOr } from '../ui/iconPaths'
import type { DrawnPart, PropValue, Props, ScreenPlan } from './screenSpace'
import { NotThePage, publishScreen } from './openScreens'

/**
 * Draws what MeTTa composed (screens/space.ts). One small component per block; nothing here chooses which parts show
 * or which block draws them. Values marked (bind path) are filled from `data`; a person's input goes back through
 * `onInput`, and every press through `onOpen` or `onAction`, so the page decides what a press does.
 */
export type ScreenItem = Record<string, unknown>
export interface ScreenHost {
  data: Record<string, unknown>
  /**
   * A person's change to a bound value. Inside a stack item, `scope` names the item (and any item inside it) the input
   * is in, outermost first, as `item.scope` does for a press; at the top of the screen it is absent.
   */
  onInput?: (bind: string, value: string, scope?: string[]) => void
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
   * An island is one element wherever it is placed: it is keyed by its name (partKey), so a screen may move it from one
   * part to another without mounting it again, as the Ask's own look moves between its sizes (screens/ask.metta).
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
 * The host for one item of a stack: the item's own data over the page's, and every press and every input carried up
 * with the item's id at the front of `scope`, so the page knows which item (and which item inside it) it came from.
 * An item marked busy holds its own buttons as a busy page does (a spend alert while its pause is being written).
 */
export function scopedHost(host: ScreenHost, item: ScreenItem): ScreenHost {
  const id = str(item.id)
  const own = typeof item.data === 'object' && item.data !== null && !Array.isArray(item.data) ? (item.data as Record<string, unknown>) : {}
  const scoped = (it: ScreenItem): ScreenItem => ({ ...it, scope: [id, ...(Array.isArray(it.scope) ? it.scope : [])] })
  return {
    ...host,
    data: { ...host.data, ...own },
    busy: host.busy === true || item.busy === true,
    onOpen: host.onOpen && ((target, it) => host.onOpen!(target, scoped(it))),
    onAction: host.onAction && ((action, it, value) => host.onAction!(action, scoped(it), value)),
    onInput: host.onInput && ((bind, value, scope) => host.onInput!(bind, value, [id, ...(scope ?? [])])),
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
      {/* (title_id …): the id the title carries, so the page can name what the header heads by it (aria-labelledby) */}
      {!host.framed && <h2 id={text(p.title_id, host) || undefined} className="text-xl font-semibold text-balance text-ink">{text(p.title, host)}</h2>}
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
  /**
   * A picture, such as a screenshot: (source (bind path)) a data: or blob: address the page made (nothing from another
   * origin), (alt "…") what it shows in words, an optional (caption "…"), and an optional button under it,
   * (action <intent>) named (action_label "Remove the picture"). An optional (error_action <intent>) receives image
   * load errors. The optional (max_height <percent>) caps the image height in dynamic viewport units.
   */
  picture: (p, host) => {
    const src = text(p.source, host)
    if (!/^(data:image\/|blob:)/.test(src)) return null
    const onError = name(p.error_action)
    const height = Number(text(p.max_height, host))
    const maxHeight = height > 0 && height <= 100 ? `${height}dvh` : undefined
    return (
      <figure className="space-y-2">
        <img src={src} alt={text(p.alt, host)} className="max-h-64 w-auto max-w-full rounded-lg border border-line object-contain"
          style={maxHeight ? { maxHeight } : undefined} onError={onError ? () => host.onAction?.(onError, {}) : undefined} />
        {p.caption && <figcaption className="text-meta text-ink-3">{text(p.caption, host)}</figcaption>}
        {p.action && (
          <button type="button" disabled={host.busy} onClick={() => host.onAction?.(name(p.action), {})}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:border-accent disabled:opacity-50">
            {text(p.action_label, host) || 'Remove'}
          </button>
        )}
      </figure>
    )
  },
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
  /**
   * Key figures as tiles (`source`): each item's label and value, an optional chip (a short mark with its own title and
   * name), a note in the warn tone with its title, and a change against the period before: `delta` (its words),
   * `delta_dir` up or down, `delta_tone` good or bad, `delta_note`. An item with `hero` true is the large first tile.
   */
  figures: (p, host) => (
    <section aria-label={text(p.label, host) || undefined} className="grid grid-cols-3 gap-2.5 md:grid-cols-4 md:gap-3">
      {(list(host, p.source) as ScreenItem[]).map((item, i) => <FigureTile key={itemKey(item, i)} item={item} />)}
    </section>
  ),
  /**
   * Columns over time, each a stack of its series' values, in a captioned card: `source` the columns (each its `x`
   * label, `at` heading, `total`, `total_words`, `aria` and `parts`, each part a series' `key`, `n` and `words`),
   * `series` each key's `label` and `color`, bottom first, drawn as the legend, and `axis` the scale (`max`, and `ticks`
   * with `n` and `words`). Hovering or focusing a column shows its total and each series' part; the axis labels thin out
   * to fit the width. `title`, `subtitle` and a `chip` (`chip_title`, `chip_aria`) caption the card.
   */
  chart: (p, host) => (
    <Card p={p} host={host}>
      <Legend items={list(host, p.series) as ScreenItem[]} />
      <Columns p={p} host={host} />
    </Card>
  ),
  /**
   * Rows of bars scaled to the largest row, in a captioned card (as chart): each row its `label`, its `value` in words,
   * its `parts` side by side (each its `n` and `color`), an orb when it carries an `orb` hue (and `status`), and a
   * `detail` line shown while it is hovered or focused; `aria` names it. `legend` names the parts' colours; `empty` is
   * said when there are no rows.
   */
  bars: (p, host) => (
    <Card p={p} host={host}>
      <Legend items={list(host, p.legend) as ScreenItem[]} />
      <BarRows p={p} host={host} />
    </Card>
  ),
  /**
   * A table of rows (`source`): `(columns ((column <field> <header> ((align end) (phone hide) (tone quiet) (mark <field>)
   * (mark_title <field>))) …))`, the header text or bound; `(phone hide)` keeps a column off a phone; `(tone quiet)` or
   * `(tone faint)` softens its cells; a row's `mark` field, when it has words, draws a small warn tag after the value,
   * titled by its `mark_title` field. `caption` names the table for assistive technology.
   */
  table: (p, host) => {
    const columns = (Array.isArray(p.columns) ? p.columns : []).flatMap((c) => (Array.isArray(c) && c[0] === 'column' ? [tableColumn(c, host)] : []))
    return (
      <div className="overflow-x-auto rounded-[20px] border border-line bg-tint/[0.03]">
        <table className="w-full text-left text-[13px]">
          {p.caption !== undefined && <caption className="sr-only">{text(p.caption, host)}</caption>}
          <thead className="text-[11px] text-ink-3">
            <tr>{columns.map((c) => <th key={c.field} scope="col" className={cx('px-4 py-3 font-medium', c.end && 'text-right', c.phoneHide && 'hidden sm:table-cell')}>{c.header}</th>)}</tr>
          </thead>
          <tbody className="tabular-nums">
            {(list(host, p.source) as ScreenItem[]).map((row, i) => (
              <tr key={itemKey(row, i)} className="border-t border-line">
                {columns.map((c) => {
                  const mark = c.mark ? str(row[c.mark]) : ''
                  return (
                    <td key={c.field} className={cx('px-4 py-2.5', c.end && 'text-right', c.phoneHide && 'hidden sm:table-cell', c.tone === 'quiet' ? 'text-ink-2' : c.tone === 'faint' ? 'text-ink-3' : 'text-ink')}>
                      {str(row[c.field])}
                      {mark && <span className="ml-1.5 rounded-md bg-warn/10 px-1.5 py-0.5 text-[10.5px] font-medium text-warn" title={c.markTitle ? str(row[c.markTitle]) || undefined : undefined}>{mark}</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  },
  /**
   * Words someone said in the hive (features/views/words.metta), drawn inside the look's own line or bubble: each
   * statement or truth value said in English (marked data-said), and each artifact id the words name, a statement's
   * names included, drawn as the artifact's title, a chip that opens it (withChips, below). The id itself is never drawn.
   * A chip carries no colour of its own: it reads in the colour of the words around it, so in every look's line or
   * bubble it has the words' own contrast.
   * The words between chips take the page's own mark when it gives one (`words.mark`: the Ask lights up what was asked).
   * A chip's words are the part's: (unnamed …) while its title is still being read, (missing …) and (missing_why …) for
   * one this person cannot open.
   */
  said: (p, host) => {
    const mark = host.data['words.mark'] as ((words: string) => ReactNode) | undefined
    const named = chipWords(p, host)
    return (
      <>
        {plainPieces(text(p.text, host)).map((piece, i) =>
          piece.raw === undefined ? <Fragment key={i}>{withChips(piece.t, host, named, mark)}</Fragment> : <span key={i} data-said={piece.kind}>{withChips(piece.t, host, named, mark)}</span>)}
      </>
    )
  },
  /** The same words as they were written, behind a small disclosure, (show …) while closed and (hide …) while open; an
   *  artifact id in them is still drawn as its chip, in the chip words `said` takes. Closed, the words stay in the DOM,
   *  hidden, so aria-controls always names them. (class …) is the place's own class for the disclosure (the commons
   *  style it). */
  written: (p, host) => <Written words={text(p.text, host)} show={text(p.show, host)} hide={text(p.hide, host)} named={chipWords(p, host)} className={text(p.class, host)} host={host} />,
  /**
   * The Ask collapsed to its mark (screens/ask.metta): one round control where the Ask's row starts, showing the
   * page's own glyph ((glyph <island>), the look's living Omega), dressed as the look's field is (features/ask/ask.css
   * .ask-collapsed). (label …) says what a press does and (title …) adds its keys; (state answering) traces its rim
   * while a turn runs, as the field's does; (news <flag>) puts a dot on it when an answer came after it was collapsed;
   * (left …) (bottom …) (mode …) place it on the screen. A press sends (action …).
   */
  mark: (p, host) => <Mark p={p} host={host} />,
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
   * A (link label href) in the same list opens an internal hash route.
   */
  buttons: (p, host) => <div className="flex flex-wrap items-center gap-2">{buttonItems(p.items, host)}</div>,
  /**
   * The bar above something the page draws under it, such as a view: an icon, the title on one line, and its buttons at
   * the end, as `buttons` draws them. (title_id …) is the id the title carries, so the page names what the bar heads by
   * it (aria-labelledby); (edge flag-path): while that bound flag is true the bar is the top edge of a full-screen frame.
   */
  bar: (p, host) => (
    <div className={cx('flex items-center gap-2', host.data[name(p.edge)] === true ? 'h-12 border-b border-line px-3' : 'pb-1.5')}>
      {p.icon !== undefined && <Icon name={iconOr(name(p.icon), 'apps')} size={15} className="shrink-0 text-ink-3" />}
      <span id={text(p.title_id, host) || undefined} className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-2">{text(p.title, host)}</span>
      {buttonItems(p.items, host, 'min-h-9 px-2.5 text-[12px]')}
    </div>
  ),
  /**
   * A question, then one button that goes ahead (drawn as risky) and one that cancels. (tone plain) draws the go-ahead
   * as an ordinary button, for a yes that destroys nothing. (alert yes): an alertdialog, which a screen reader announces
   * as it appears, named by (label …) and described by the question.
   */
  confirm: (p, host) => <Confirm p={p} host={host} />,
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
 * The buttons of `buttons` and `bar`: (button label action ((aria "…") (icon pause) (variant primary) (expanded flag)
 * (on flag) (off flag))). (on flag) draws a button only while that bound flag is true, (off flag) only while it is
 * false. Each is keyed by its place among those drawn, so two that trade places on a flag (Full screen, then Close) are
 * one element, and the person's focus stays on it.
 */
function buttonItems(items: PropValue | undefined, host: ScreenHost, className?: string): ReactNode[] {
  const drawn = (Array.isArray(items) ? items : []).flatMap((b) => {
    if (!Array.isArray(b) || (b[0] !== 'button' && b[0] !== 'link')) return []
    const opts: Record<string, PropValue> = {}
    for (const o of Array.isArray(b[3]) ? b[3] : []) if (Array.isArray(o) && o.length === 2 && typeof o[0] === 'string') opts[o[0]] = o[1]
    const holds = (opts.on === undefined || host.data[name(opts.on)] === true) && (opts.off === undefined || host.data[name(opts.off)] !== true)
    return holds ? [{ b, opts }] : []
  })
  return drawn.map(({ b, opts }, i) => {
    if (b[0] === 'link') {
      const href = text(b[2], host)
      return href.startsWith('#/')
        ? <a key={i} href={href} className="min-h-9 content-center px-2.5 text-sm text-ink underline underline-offset-4">{text(b[1], host)}</a>
        : null
    }
    const variant = name(opts.variant)
    const aria = text(opts.aria, host)
    return (
      // (expanded flag-path): a button that opens and closes something says which it is
      <Button key={i} type="button" disabled={host.busy} variant={variant === 'primary' || variant === 'ghost' || variant === 'danger' ? variant : 'subtle'}
        icon={opts.icon ? iconOr(name(opts.icon), 'sparkles') : undefined} aria-label={aria ? fill(aria, {}, host) : undefined}
        aria-expanded={opts.expanded !== undefined ? host.data[name(opts.expanded)] === true : undefined}
        className={className} onClick={() => host.onAction?.(name(b[2]), {})}>
        {text(b[1], host)}
      </Button>
    )
  })
}

/** The confirm block: the question and its two buttons, one group, or one alertdialog the question describes. */
function Confirm({ p, host }: { p: Props; host: ScreenHost }) {
  const question = useId()
  const alert = p.alert === 'yes'
  const words = text(p.text, host)
  return (
    <div role={alert ? 'alertdialog' : 'group'} aria-label={text(p.label, host) || words} aria-describedby={alert ? question : undefined} className="flex flex-wrap items-center gap-2">
      <span id={alert ? question : undefined} className="min-w-0 text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">{words}</span>
      <Button type="button" variant={p.tone === 'plain' ? 'subtle' : 'danger'} disabled={host.busy} className="min-h-8 px-3 text-[12.5px]" onClick={() => host.onAction?.(name(p.yes_action), {})}>{text(p.yes, host)}</Button>
      <Button type="button" variant="ghost" disabled={host.busy} className="min-h-8 px-3 text-[12.5px]" onClick={() => host.onAction?.(name(p.no_action), {})}>{text(p.no, host)}</Button>
    </div>
  )
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
 *   long     text on several lines: (rows n) its starting height, (placeholder …) (quiet yes) as for text
 *   checks   a group of tick boxes under the label as its legend, one per item of the list at <bind> (id, label, on);
 *            a tick sends (action …) with the item and whether it is now ticked
 * `(columns two)` lays the fields two to a row on a wider screen. `(submit <action>)`: Enter in a number or text field
 * sends that action, as the form's own button does (never while the field waits, nor for an input method's confirming
 * Enter). `(focus yes)` on a field gives it the focus when it is drawn, as an editor that has just opened.
 */
function Fields({ p, host }: { p: Props; host: ScreenHost }) {
  const fields = (Array.isArray(p.items) ? p.items : []).flatMap((f) => (Array.isArray(f) && f[0] === 'field' ? [f] : []))
  const submit = name(p.submit)
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
        if (kind === 'long') {
          return (
            <label key={i} className="block text-[12.5px] text-ink-3">
              {quiet ? <span className="sr-only">{label}</span> : label}
              <textarea value={str(host.data[bind])} disabled={held} rows={Number(text(opts.rows, host)) || 3} onChange={(e) => change(e.target.value)}
                placeholder={text(opts.placeholder, host) || undefined} className={cx(FIELD_INPUT, 'resize-y', !quiet && 'mt-1')} />
            </label>
          )
        }
        return (
          <label key={i} className="block text-[12.5px] text-ink-3">
            {quiet ? <span className="sr-only">{label}</span> : label}
            <input type={kind === 'number' ? 'number' : 'text'} value={str(host.data[bind])} disabled={held} onChange={(e) => change(e.target.value)}
              min={text(opts.least, host) || undefined} max={text(opts.most, host) || undefined} step={text(opts.step, host) || undefined}
              autoFocus={name(opts.focus) === 'yes' || undefined}
              onKeyDown={submit ? (e) => { if (guardComposing(e)) return; if (e.key === 'Enter' && !held) { e.preventDefault(); host.onAction?.(submit, {}) } } : undefined}
              placeholder={text(opts.placeholder, host) || undefined} className={cx(FIELD_INPUT, !quiet && 'mt-1')} />
          </label>
        )
      })}
    </div>
  )
}

/** A short mark beside a figure or a caption (sim and demo mode's "sim", say), with its own title and accessible name. */
function Chip({ label, title, aria }: { label: string; title?: string; aria?: string }) {
  return (
    <span title={title || undefined} aria-label={aria || undefined}
      className="inline-flex shrink-0 items-center rounded-[5px] border border-warn/30 bg-warn/[0.09] px-1 py-px text-[9px] leading-none font-semibold tracking-[0.06em] text-warn/90 uppercase">
      {label}
    </span>
  )
}

/** One key figure: its label (and chip), its value, a note, and its change against the period before. */
function FigureTile({ item }: { item: ScreenItem }) {
  const hero = item.hero === true
  const [chip, note, delta] = [str(item.chip), str(item.note), str(item.delta)]
  return (
    <div className={cx('rounded-2xl border border-line bg-tint/[0.03]', hero ? 'col-span-3 p-4 md:col-span-1' : 'p-3 md:p-4')}>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
        <span className="truncate">{str(item.label)}</span>
        {chip && <Chip label={chip} title={str(item.chip_title)} aria={str(item.chip_aria)} />}
      </div>
      <div className={cx('mt-1 font-sans font-semibold tracking-tight text-ink', hero ? 'text-[44px] leading-none md:text-[48px]' : 'text-xl md:text-2xl')}>{str(item.value)}</div>
      {note && <div className="mt-1.5 text-[11px] text-warn md:text-[12px]" title={str(item.note_title) || undefined}>{note}</div>}
      {delta && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1 text-[11px] md:text-[12px]">
          <span className={item.delta_tone === 'bad' ? 'text-bad' : 'text-good'}>
            <Icon name="chevron" size={12} className={cx('inline', item.delta_dir === 'down' ? 'rotate-90' : '-rotate-90')} /> {delta}
          </span>
          {item.delta_note !== undefined && <span className="text-ink-4">{str(item.delta_note)}</span>}
        </div>
      )}
    </div>
  )
}

/** A chart's card: its caption (the title, a chip, the subtitle) when it has a title, then the chart. */
function Card({ p, host, children }: { p: Props; host: ScreenHost; children: ReactNode }) {
  const [title, chip] = [text(p.title, host), text(p.chip, host)]
  return (
    <figure className="rounded-[20px] border border-line bg-tint/[0.03] p-4 md:p-5">
      {title && (
        <figcaption className="mb-3">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            {title}
            {chip && <Chip label={chip} title={text(p.chip_title, host)} aria={text(p.chip_aria, host)} />}
          </div>
          {p.subtitle !== undefined && <div className="text-[12px] text-ink-3">{text(p.subtitle, host)}</div>}
        </figcaption>
      )}
      {children}
    </figure>
  )
}

/** The colours a chart uses, each with its words. */
function Legend({ items }: { items: ScreenItem[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-2" aria-label="Legend">
      {items.map((it, i) => (
        <li key={str(it.key) || i} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: str(it.color) || undefined }} aria-hidden="true" />
          {str(it.label)}
        </li>
      ))}
    </ul>
  )
}

/** A chart's or a bar's parts as the page gave them: each a key, a finite number, its words and a colour. */
const partsOf = (item: ScreenItem): { key: string; n: number; words: string; color: string }[] =>
  (Array.isArray(item.parts) ? item.parts : []).flatMap((x) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) return []
    const r = x as Record<string, unknown>
    return typeof r.n === 'number' && Number.isFinite(r.n) ? [{ key: str(r.key), n: r.n, words: str(r.words), color: str(r.color) }] : []
  })

/** px a chart is drawn at until it is measured: a render on the server or in a test, or a browser without ResizeObserver. */
const CHART_WIDTH = 640

/** An element's width, kept current as it resizes; CHART_WIDTH until the element is measured. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(CHART_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/**
 * The chart block's columns: a stack per column, bottom first in the series' order, scaled to the axis' max, with the
 * axis ticks, an x label every so many columns (as many as fit, about one per 64px), and per column a focusable band
 * that shows its tooltip. Time: c·s per draw, c columns, s series.
 */
function Columns({ p, host }: { p: Props; host: ScreenHost }) {
  const cols = list(host, p.source) as ScreenItem[]
  const series = (list(host, p.series) as ScreenItem[]).map((s) => ({ key: str(s.key), label: str(s.label), color: str(s.color) }))
  const colorOf = (k: string) => series.find((s) => s.key === k)?.color || undefined
  const labelOf = (k: string) => series.find((s) => s.key === k)?.label ?? k
  const axisValue = host.data[name(p.axis)]
  const axis = typeof axisValue === 'object' && axisValue !== null && !Array.isArray(axisValue) ? (axisValue as Record<string, unknown>) : {}
  const max = typeof axis.max === 'number' && axis.max > 0 ? axis.max : 1
  const ticks = (Array.isArray(axis.ticks) ? axis.ticks : []).flatMap((t) => {
    const r = typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : {}
    return typeof r.n === 'number' ? [{ n: r.n, words: str(r.words) }] : []
  })
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 220
  const padL = 44
  const padB = 26
  const plotW = Math.max(10, width - padL - 4)
  const plotH = H - padB - 8
  const band = plotW / Math.max(1, cols.length)
  const bw = Math.min(24, Math.max(3, band - Math.max(2, band * 0.3)))
  const y = (v: number) => 8 + plotH - (v / max) * plotH
  const labelEvery = Math.ceil(cols.length / Math.max(2, Math.floor(plotW / 64)))
  const shown = hover !== null ? cols[hover] : undefined
  return (
    <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={text(p.label, host) || undefined}>
          {ticks.map((t) => (
            <g key={t.n}>
              <line x1={padL} x2={width} y1={y(t.n)} y2={y(t.n)} stroke="color-mix(in oklab, var(--color-ink) 7%, transparent)" />
              <text x={padL - 8} y={y(t.n)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-ink-3)" style={{ fontVariantNumeric: 'tabular-nums' }}>{t.words}</text>
            </g>
          ))}
          <line x1={padL} x2={width} y1={y(0)} y2={y(0)} stroke="color-mix(in oklab, var(--color-ink) 18%, transparent)" />
          {cols.map((c, i) => {
            const x = padL + i * band + (band - bw) / 2
            const byKey = new Map(partsOf(c).map((q) => [q.key, q.n]))
            const present = series.map((s) => s.key).filter((k) => (byKey.get(k) ?? 0) > 0)
            let acc = 0
            return (
              <g key={itemKey(c, i)} opacity={hover === null || hover === i ? 1 : 0.45} style={{ transition: 'opacity 120ms' }}>
                {present.map((k, si) => {
                  const y0 = y(acc)
                  acc += byKey.get(k) ?? 0
                  const y1 = y(acc)
                  const gap = si > 0 ? 2 : 0
                  const hgt = Math.max(0, y0 - y1 - gap)
                  if (hgt <= 0.2) return null
                  // the top of a column is rounded; the parts below it are square
                  const r = si === present.length - 1 ? Math.min(4, bw / 2, hgt) : 0
                  const d = `M${x},${y1 + hgt} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y1 + hgt} Z`
                  return <path key={k} d={d} fill={colorOf(k)} />
                })}
              </g>
            )
          })}
          {cols.map((c, i) => (i % labelEvery === 0 ? (
            <text key={itemKey(c, i)} x={padL + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--color-ink-3)">{str(c.x)}</text>
          ) : null))}
          {/* hit targets: the whole band, larger than the mark */}
          {cols.map((c, i) => (
            <rect key={itemKey(c, i)} x={padL + i * band} y={0} width={band} height={H - padB} fill="transparent" tabIndex={0} aria-label={str(c.aria) || undefined}
              onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} className="outline-none" />
          ))}
        </svg>
      )}
      <AnimatePresence>
        {shown && hover !== null && (
          <m.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}
            className="glass-strong pointer-events-none absolute top-0 z-10 min-w-44 rounded-xl px-3 py-2 text-[12px]"
            style={{ left: Math.min(Math.max(0, padL + hover * band + band / 2 - 88), Math.max(0, width - 180)) }}>
            <div className="mb-1 text-ink-3">{str(shown.at)}</div>
            <div className="mb-1.5 text-[15px] font-semibold text-ink">{str(shown.total_words)}</div>
            {partsOf(shown).filter((q) => q.n > 0).sort((a, b) => b.n - a.n).map((q) => (
              <div key={q.key} className="flex items-center gap-2 py-0.5">
                <span className="h-0.5 w-3 rounded-full" style={{ background: colorOf(q.key) }} />
                <span className="font-medium text-ink tabular-nums">{q.words}</span>
                <span className="truncate text-ink-3">{labelOf(q.key)}</span>
              </div>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** The bars block's rows: each row's parts side by side, as wide as their share of the largest row's total. */
function BarRows({ p, host }: { p: Props; host: ScreenHost }) {
  const rows = list(host, p.source) as ScreenItem[]
  const [hover, setHover] = useState<string | null>(null)
  if (rows.length === 0) return <p className="text-sm text-ink-3">{text(p.empty, host)}</p>
  const max = Math.max(...rows.map((r) => partsOf(r).reduce((sum, q) => sum + Math.max(0, q.n), 0)), 0.0001)
  return (
    <ul className="space-y-2.5" onPointerLeave={() => setHover(null)}>
      {rows.map((r, i) => {
        const id = itemKey(r, i)
        const detail = str(r.detail)
        const parts = partsOf(r).filter((q) => q.n > 0)
        // a row with a detail line opens it while hovered or focused, and dims the others
        const open = detail ? { tabIndex: 0, onPointerEnter: () => setHover(id), onFocus: () => setHover(id), onBlur: () => setHover(null) } : {}
        return (
          <li key={id} className="relative" aria-label={str(r.aria) || undefined} {...open}>
            <div className="mb-1 flex items-center gap-2 text-[12px]">
              {typeof r.orb === 'number' && <Orb hue={r.orb} status={(str(r.status) || undefined) as AgentStatus | undefined} size={14} />}
              <span className="min-w-0 flex-1 truncate text-ink-2">{str(r.label)}</span>
              <span className="shrink-0 font-medium text-ink tabular-nums">{str(r.value)}</span>
            </div>
            <div className="flex h-3 gap-[2px]" style={{ opacity: hover !== null && hover !== id ? 0.5 : 1 }}>
              {parts.map((q, j) => (
                <span key={q.key || j} className={cx('h-full transition-[width] duration-300', j === 0 && 'rounded-l-[2px]', j === parts.length - 1 && 'rounded-r-[4px]')}
                  style={{ width: `${(q.n / max) * 100}%`, minWidth: 2, background: q.color || undefined }} />
              ))}
            </div>
            {hover === id && detail && (
              <div className="glass-strong pointer-events-none absolute right-0 -top-1 z-10 -translate-y-full rounded-lg px-2.5 py-1.5 text-[11px] text-ink-2">{detail}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** A table column as declared: (column <field> <header> ((align end) (phone hide) (tone quiet) (mark f) (mark_title f))). */
function tableColumn(c: PropValue[], host: ScreenHost) {
  const opts: Record<string, PropValue> = {}
  for (const o of Array.isArray(c[3]) ? c[3] : []) if (Array.isArray(o) && o.length === 2 && typeof o[0] === 'string') opts[o[0]] = o[1]
  return { field: name(c[1]), header: text(c[2], host), end: name(opts.align) === 'end', phoneHide: name(opts.phone) === 'hide', tone: name(opts.tone), mark: name(opts.mark), markTitle: name(opts.mark_title) }
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
 * row's own button. The button shows only when the item carries its label, and a press opens `open` with the item; the
 * item's `aria` field, when the screen names one, is the button's accessible name ("Remove the old default on Nori").
 */
function Entry({ p, item, host, first }: { p: Props; item: ScreenItem; host: ScreenHost; first: boolean }) {
  const field = (k: PropValue | undefined) => str(item[name(k)])
  const [badge, meta, detail, code, action, aria] = [field(p.badge), field(p.meta), field(p.detail), field(p.code), field(p.action), field(p.aria)]
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
        <Button variant="ghost" className="min-h-9 shrink-0 px-2.5 text-[12px]" aria-label={aria || undefined} onClick={() => host.onOpen!(target, item)}>
          {action}
        </Button>
      )}
      {/* (row_actions ((action label intent [aria]) …)): buttons of the row's own, each pressed with the row's item; the
          aria text may name the row ("Dismiss {title}") */}
      {Array.isArray(p.row_actions) && host.onAction && (
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {p.row_actions.map((a, i) => Array.isArray(a) && a[0] === 'action' ? (
            <Button key={i} variant="ghost" className="min-h-9 px-2.5 text-[12px]" disabled={host.busy}
              aria-label={a[3] !== undefined ? fill(text(a[3], host), item, host) : undefined} onClick={() => host.onAction!(name(a[2]), item)}>
              {text(a[1], host)}
            </Button>
          ) : null)}
        </span>
      )}
    </li>
  )
}

/**
 * One part's drawing, apart from the rest: a part that throws while it is drawn shows a short line in its place, the
 * other parts stay, and the failure is told to lib/screenFailures, which the page's errors hear and the feedback area
 * drafts a report from.
 */
class PartBoundary extends Component<{ screen: string; order: number; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    screenFailed({ where: `${this.props.screen} (part ${this.props.order})`, message: error instanceof Error ? error.message : String(error) })
  }
  render() {
    return this.state.failed ? <p role="status" className="rounded-xl border border-line px-4 py-2.5 text-[13px] text-ink-3">This part could not be drawn.</p> : this.props.children
  }
}

/** A block drawn inside its part's boundary, so a throw while drawing it is caught there. */
function Drawn({ draw, props, host }: { draw: Block; props: Props; host: ScreenHost }) {
  return <>{draw(props, host)}</>
}

/** One artifact the words name, as the page looked it up for this person: its title and kind, or that it is missing. */
export interface NamedArtifact { title?: string; kind?: string; missing?: boolean }
/** What a chip says that is not the artifact's own title: while it is read, and for one this person cannot open. */
type ChipWords = { unnamed: string; missing: string; why: string }
const chipWords = (p: Props, host: ScreenHost): ChipWords => ({ unnamed: text(p.unnamed, host), missing: text(p.missing, host), why: text(p.missing_why, host) })
const CHIP = 'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 align-baseline text-[0.92em] leading-snug'

/**
 * Words with every artifact id in them drawn as its artifact (lib/artifactRefs finds them): the title the page found
 * in `words.named`, the part's words for one still being read, and a plain notice for one this person cannot open. A
 * press goes to the page as `onOpen('artifact', { id, kind })`. `mark`, when given, draws the words between chips.
 */
function withChips(words: string, host: ScreenHost, said: ChipWords, mark?: (words: string) => ReactNode): ReactNode {
  const named = (host.data['words.named'] ?? {}) as Record<string, NamedArtifact>
  return refPieces(words).map((piece, i) => {
    if (piece.ref === undefined) return <Fragment key={i}>{mark ? mark(piece.text) : piece.text}</Fragment>
    const id = piece.ref
    const found = own(named, id) ?? {}
    if (found.missing) {
      return (
        <span key={i} className={cx(CHIP, 'border-dashed border-current/30 text-inherit')} title={said.why || undefined} data-artifact-ref="missing">
          <Icon name="doc" size={12} className="shrink-0 opacity-70" />
          <span className="truncate">{said.missing}</span>
        </span>
      )
    }
    return (
      <button key={i} type="button" data-artifact-ref={id} onClick={(e) => { e.stopPropagation(); host.onOpen?.('artifact', { id, kind: found.kind }) }}
        className={cx(CHIP, 'border-current/30 bg-current/[0.06] font-medium text-inherit hover:bg-current/[0.12] focus-visible:outline-2 focus-visible:outline-offset-1')}>
        <Icon name={found.kind === 'view' ? 'apps' : 'doc'} size={12} className="shrink-0 opacity-70" />
        <span className="truncate">{found.title?.trim() || said.unnamed}</span>
      </button>
    )
  })
}

/** The written block: a closed disclosure that reveals the words exactly as written (uifix-r3, r3.1). */
function Written({ words, show, hide, named, className, host }: { words: string; show: string; hide: string; named: ChipWords; className: string; host: ScreenHost }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className={cx('belief-as-written', className)}>
      <button
        type="button"
        className="ml-1.5 inline cursor-pointer border-0 bg-transparent p-0 align-baseline text-[0.78em] underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100 focus-visible:opacity-100"
        style={{ color: 'inherit', fontFamily: 'inherit' }}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {open ? hide : show}
      </button>
      <code id={id} hidden={!open} data-as-written="" className={cx('mt-1 font-mono text-[0.85em] opacity-80 [overflow-wrap:anywhere]', open && 'block')}>
        {withChips(words, host, named)}
      </code>
    </span>
  )
}

/** The mark block (above): fixed where the page places it, and kept clear by the experiences' floating chrome, as the Ask is. */
function Mark({ p, host }: { p: Props; host: ScreenHost }) {
  const state = text(p.state, host) || 'resting'
  const px = (v: PropValue | undefined) => Number(text(v, host)) || 0
  return (
    <div className="ask-dock ask-collapsed-dock" data-block="mark" data-mode={text(p.mode, host)} data-state={state} data-xc-keep-clear=""
      style={{ left: px(p.left), bottom: `calc(var(--sab) + ${px(p.bottom)}px)` }}>
      <button type="button" className="ask-capsule ask-collapsed" data-state={state} data-ask-mark-open="" onClick={() => host.onAction?.(name(p.action), {})}
        aria-label={text(p.label, host)} title={text(p.title, host) || undefined}>
        <span className="ask-aurora" aria-hidden />
        <span className="ask-mark" aria-hidden>{own(host.islands, name(p.glyph)) ?? null}</span>
        {host.data[name(p.news)] === true && <span className="ask-dot" aria-hidden />}
      </button>
    </div>
  )
}

/**
 * A part's identity among its siblings: its order, except an island's, which is its name. An island is the page's own
 * element, so when MeTTa moves it to another part (the Ask's look going from one size to another) it stays mounted,
 * with what the person typed in it.
 */
const partKey = (part: DrawnPart): string => (part.block === 'island' ? `island ${name(part.props.name)}` : String(part.order))

/**
 * A composed screen drawn inside a look's own text, such as the words of a conversation (features/views/Words.tsx):
 * each part MeTTa placed, by its block, in order, with no wrapper, layer or region, so it can sit in a line or a
 * paragraph, or over the page where its blocks place themselves, as the Ask's mark and its look do
 * (features/ask/askScreen.ts: a wrapper's depth would become the containing block of their fixed places). A part with
 * no drawable block draws nothing.
 */
export function InlineParts({ plan, host }: { plan: ScreenPlan; host: ScreenHost }) {
  return (
    <>
      {plan.parts.map((part) => {
        const draw = part.block ? own(BLOCKS, part.block) : undefined
        return draw ? <Fragment key={partKey(part)}>{draw(part.props, host)}</Fragment> : null
      })}
    </>
  )
}

/** px of depth per layer in a 3D look: enough to read as stacked planes, never enough to blur text. */
const Z_STEP = 18
/**
 * px from the person to the screen in a 3D look. Each lifted part is drawn under its own perspective, about its own
 * centre, so a part at depth z draws P/(P−z) as large (1.3%, 2.6% and 3.9% for the three layers above ground) and stays
 * where its layout puts it. One perspective for the whole screen moved every part by its distance from the top times
 * z/(P−z): 150px for a raised part 7000px down a long screen, onto its neighbours.
 */
const PERSPECTIVE = 1400

/** A sticky part's frame: at the top of the scrolling page, over what scrolls under it, in the page's own surface
 *  (--xc-surface: classic's navy, and each look's chrome inside an experience), solid under every line of a row that
 *  wraps on a phone and fading out only in its bottom padding. */
const STICKY = 'sticky top-0 z-[2] bg-gradient-to-b from-(--xc-surface) via-(--xc-surface) via-85% to-transparent pt-1 pb-3'

/**
 * The parts MeTTa composed, in order, each at the depth MeTTa gave it. A flat look shows depth as elevation (a softer
 * or stronger shadow); a 3D look draws each part at its own depth, nearer parts a little larger, each in its place. A
 * part with no drawable block draws nothing (it is in `plan.missing`).
 */
export function Screen({ plan, host, className }: { plan: ScreenPlan; host: ScreenHost; className?: string }) {
  // the page's own screen tells the stage what it draws, so the stage can arrange its parts beside what a mind shows;
  // a screen inside a view's frame or a stage tile, or inside this one, is not the page's
  const inner = useContext(NotThePage)
  const owner = useMemo(() => Symbol('screen'), [])
  useEffect(() => {
    if (!inner) publishScreen(owner, plan, host)
  }, [inner, owner, plan, host])
  useEffect(() => () => publishScreen(owner, null), [owner])
  return <NotThePage.Provider value={true}><Parts plan={plan} host={host} className={cx('space-y-5', className)} /></NotThePage.Provider>
}

/** One composed part alone, by its block, through the host of the page that composed it: a page's part on the stage. */
export function PartAlone({ part, host }: { part: DrawnPart; host: ScreenHost }) {
  const draw = part.block ? own(BLOCKS, part.block) : undefined
  return draw ? <NotThePage.Provider value={true}>{draw(part.props, host)}</NotThePage.Provider> : null
}

/**
 * The parts MeTTa placed in one region a look's frame draws (usage: where the look shows usage), as a page draws its
 * main column; nothing when the region holds none, so the frame leaves no empty box behind. A page's own Screen never
 * draws a frame region.
 */
export function RegionParts({ plan, host, region, className }: { plan: ScreenPlan; host: ScreenHost; region: 'usage'; className?: string }) {
  const parts = plan.parts.filter((p) => p.place.region === region)
  if (parts.length === 0) return null
  return (
    <div className={className} data-screen-region={region}>
      <Parts plan={{ ...plan, parts: parts.map((p) => ({ ...p, place: { ...p.place, region: 'main' } })) }} host={host} className="" />
    </div>
  )
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
      <div key={partKey(part)} data-screen-part={`${plan.screen}.${part.order}`} data-block={part.block!} data-layer={part.depth.layer}
        data-tour={text(part.props.tour, host) || undefined} hidden={hidden || undefined}
        // (fill yes): the part grows to the height its screen is given (a studio or canvas that fills its bench); (grow
        // yes): in a row it takes an equal share of the width, at least 20rem, so on a narrow screen it has the row to itself;
        // (flush yes): the part sits right against the one after it, without the screen's spacing (a bar on its view)
        className={cx(!deep && part.depth.z >= 3 && 'drop-shadow-[0_6px_18px_rgb(0_0_0/0.18)]', !deep && part.depth.z === 2 && 'drop-shadow-[0_2px_8px_rgb(0_0_0/0.12)]',
          part.props.fill === 'yes' && 'flex min-h-0 flex-1 flex-col', part.props.grow === 'yes' && 'min-w-[min(100%,20rem)] flex-1', part.props.flush === 'yes' && 'mb-0')}
        style={lift ? { transform: `perspective(${PERSPECTIVE}px) translateZ(${part.depth.z * Z_STEP}px)` } : undefined}>
        <PartBoundary screen={plan.screen} order={part.order}><Drawn draw={draw} props={part.props} host={host} /></PartBoundary>
      </div>
    )
  }
  // parts MeTTa put in one row sit side by side (wrapping when narrow); the rest each take the full width. (sticky yes)
  // on a part keeps it, or the row it shares, at the top while the page scrolls under it, on the page's own background
  // (STICKY: the page's surface token)
  const column = (parts: DrawnPart[]) => {
    const out: ReactNode[] = []
    for (let i = 0; i < parts.length; ) {
      const row = parts[i].place.row
      let j = i + 1
      if (row) while (j < parts.length && parts[j].place.row === row) j++
      const group = parts.slice(i, j)
      const sticky = group.some((p) => p.props.sticky === 'yes')
      const drawn = group.map(drawPart).filter(Boolean)
      if (row && drawn.length > 0) out.push(<div key={`row-${row}-${parts[i].order}`} data-screen-row={row} className={cx('flex flex-wrap items-start gap-2', sticky && STICKY)}>{drawn}</div>)
      else if (sticky && drawn.length > 0) out.push(<div key={`sticky-${parts[i].order}`} className={STICKY}>{drawn}</div>)
      else out.push(...drawn)
      i = j
    }
    return out
  }
  const main = plan.parts.filter((p) => p.place.region === 'main')
  const aside = plan.parts.filter((p) => p.place.region === 'aside')
  if (aside.length === 0) {
    // a screen with a part that fills is a column as tall as its parent, so that part can take the rest of it
    const fills = main.some((p) => p.props.fill === 'yes')
    return <div className={cx(className, fills && 'flex h-full min-h-0 flex-col')} data-screen={plan.screen} data-look={plan.look} data-space={plan.space}>{column(main)}</div>
  }
  // a side column on a wide screen, after the main column on a narrow one; any aside part may name it, (region_label …)
  const asideLabel = aside.map((p) => text(p.props.region_label, host)).find(Boolean)
  return (
    <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] md:items-start md:gap-6" data-screen={plan.screen} data-look={plan.look} data-space={plan.space}>
      <div className={cx(className, 'min-w-0')}>{column(main)}</div>
      <aside className={cx(className, 'mt-5 min-w-0 md:mt-0')} data-screen-region="aside" aria-label={asideLabel || undefined}>{column(aside)}</aside>
    </div>
  )
}

/** The blocks this renderer draws: the build checks the MeTTa vocabulary against it. */
export const DRAWN_BLOCKS = Object.keys(BLOCKS).sort()
