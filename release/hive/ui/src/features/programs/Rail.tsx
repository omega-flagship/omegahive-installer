import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ProgramAction, WorkItem } from '../../api/types'
import { cx } from '../../lib/cx'
import { navigate } from '../../lib/router'
import type { PendingInput, ProgramNotice, SourceDetail, TaskRef } from '../../store/programSession'
import { useHive } from '../../store/store'
import { Icon, type IconName } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import type { GraphIndex } from './layout'
import { ACTION_ICON } from './style'
import { ExternalNote, RoleMark, SameOriginBadge, SourceFields, SourceStatus, StatusLine, UReading } from './parts'
import { collectSources } from './sources'

// ---------------------------------------------------------------- sources rail

export function SourcesPanel({
  gi,
  subjects,
  inspectable,
  onInspect,
  inspecting,
  detail,
  onCloseDetail,
  onSelect,
}: {
  gi: GraphIndex
  subjects: string[]
  /** Item ids whose kind takes inspect-source. */
  inspectable: (itemId: string) => boolean
  onInspect(itemId: string): void
  inspecting: boolean
  detail: SourceDetail | null
  onCloseDetail(): void
  onSelect(id: string): void
}) {
  const { groups, own, via } = useMemo(() => collectSources(gi, subjects), [gi, subjects])
  const total = groups.reduce((n, g) => n + g.uses.length, 0)
  const sharedCount = groups.filter((g) => g.shared).length
  const subjectLabel = subjects.length === 1 ? gi.items.get(subjects[0])?.label : `${subjects.length} items`
  return (
    <section aria-label="Sources" className="min-w-0" data-tour="program-sources">
      <header className="mb-2 flex items-baseline gap-2">
        <h3 className="eyebrow">Sources</h3>
        <span className="text-[11.5px] text-ink-4 tabular-nums">
          {total ? `${total} · ${groups.length} origin${groups.length === 1 ? '' : 's'}` : 'none'}
        </span>
      </header>
      {!total ? (
        <p className="rounded-xl border border-dashed border-line-2 px-3 py-3 text-[12px] leading-snug text-ink-3">
          No sources on {subjectLabel ? <q className="text-ink-2">{subjectLabel}</q> : 'this'} or the items linked to it. Treat it as unsupported until one is found.
        </p>
      ) : (
        <>
          {sharedCount > 0 && (
            <p className="mb-2 flex items-start gap-2 rounded-xl border border-warn/25 bg-warn/[0.07] px-2.5 py-2 text-[11.5px] leading-snug text-ink-2" role="note">
              <Icon name="alert" size={14} className="mt-px shrink-0 text-warn" />
              <span>
                Some sources share an origin. Count each origin once: they are <b className="font-semibold text-warn">not independent</b>.
              </span>
            </p>
          )}
          <ul className="space-y-2">
            {groups.map((g) => (
              <li key={g.origin ?? g.uses[0].source.id} className={cx('rounded-xl border', g.shared ? 'border-warn/30 bg-warn/[0.03]' : 'border-line bg-white/[0.02]')}>
                <div className="flex items-center gap-2 px-2.5 pt-2 pb-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3" title={g.origin ?? 'No origin given'}>
                    {g.origin ? `origin · ${g.origin}` : 'origin not given'}
                  </span>
                  {g.shared && <SameOriginBadge n={new Set(g.uses.map((u) => u.source.id)).size} origin={g.origin!} />}
                </div>
                <ul>
                  {g.uses.map((u) => {
                    const citing = u.citedBy[0].id
                    const open = detail?.sources.find((s) => s.id === u.source.id && detail.items.some((i) => u.citedBy.some((c) => c.id === i)))
                    return (
                      <li key={u.source.id + (u.source.url ?? '')} className="hairline-t px-2.5 py-2 first:border-t-0">
                        <div className="flex items-start gap-2">
                          <Icon name={u.source.url ? 'external' : u.source.local_ref ? 'database' : 'link'} size={13} className="mt-0.5 shrink-0 text-ink-3" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] leading-snug font-medium text-ink">{u.source.label}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-3">
                              <SourceStatus status={u.source.status} />
                              {u.source.date && <span className="tabular-nums">{u.source.date}</span>}
                              {u.source.locator && <span className="truncate">{u.source.locator}</span>}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {u.citedBy.map((c) => (
                                <button key={c.id} onClick={() => onSelect(c.id)} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-line bg-white/[0.03] px-1.5 py-px text-[10.5px] text-ink-2 hover:border-line-2 hover:text-ink" title={gi.items.get(c.id)?.label}>
                                  <span className="truncate">{c.via ? `via ${gi.items.get(c.id)?.label ?? c.id}` : 'this item'}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                          {inspectable(citing) && (
                            <Button variant="subtle" className="min-h-8 shrink-0 rounded-lg px-2.5 text-[12px]" disabled={inspecting} onClick={() => onInspect(citing)} aria-label={`Open source ${u.source.label} through the program`}>
                              Open
                            </Button>
                          )}
                        </div>
                        <AnimatePresence initial={false}>
                          {open && (
                            <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                              <div className="mt-2 rounded-lg border border-accent-2/25 bg-accent-2/[0.04] p-2.5">
                                <div className="mb-1.5 flex items-center gap-2">
                                  <span className="text-[10.5px] font-semibold tracking-[0.1em] text-accent-2 uppercase">Returned by the program</span>
                                  <span className="flex-1" />
                                  <button onClick={onCloseDetail} className="text-ink-3 hover:text-ink" aria-label="Close source detail">
                                    <Icon name="x" size={14} />
                                  </button>
                                </div>
                                <SourceFields s={open} dense />
                                {detail?.message && <p className="mt-2 text-[11.5px] leading-snug text-ink-3">{detail.message}</p>}
                              </div>
                            </m.div>
                          )}
                        </AnimatePresence>
                        {!open && (u.source.url || u.source.local_ref) && (
                          <div className="mt-1.5 pl-[21px]">
                            {u.source.url ? (
                              <a href={u.source.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 text-[11px] text-accent-2 hover:underline">
                                <span className="truncate">{u.source.url.replace(/^https?:\/\//, '')}</span>
                                <Icon name="external" size={10} className="shrink-0" />
                                <span className="shrink-0 text-ink-4">external reference</span>
                              </a>
                            ) : (
                              <span className="font-mono text-[10.5px] break-all text-ink-3">local · {u.source.local_ref}</span>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-ink-4">
              {own} own · {via} via linked items
            </span>
          </div>
          <div className="mt-1">
            <ExternalNote />
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- selection summary and actions

const NAV: { id: 'unfold' | 'map' | 'detail'; label: string; icon: IconName; hint: string }[] = [
  { id: 'unfold', label: 'Unfold', icon: 'unfold', hint: 'Put it at the centre with its evidence around it' },
  { id: 'map', label: 'Follow', icon: 'graph', hint: 'Grow the map outward from it' },
  { id: 'detail', label: 'Open', icon: 'doc', hint: 'Everything about it' },
]

export function ItemSummary({ item, gi, compact }: { item: WorkItem; gi: GraphIndex; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <RoleMark role={gi.role(item.kind)} kindLabel={gi.kindLabel(item.kind)} />
        <span className="font-mono text-[10px] text-ink-4">{item.id}</span>
      </div>
      <div className={cx('mt-1 leading-snug font-medium text-ink', compact ? 'line-clamp-2 text-[13px]' : 'text-[14px]', item.status === 'retracted' && 'line-through decoration-bad/70')}>{item.label}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <UReading u={item.uncertainty} />
        <StatusLine item={item} compact={compact} />
      </div>
    </div>
  )
}

export function ActionBar({
  items,
  gi,
  actions,
  busy,
  onNav,
  onCompare,
  onAct,
  compact,
}: {
  items: WorkItem[]
  gi: GraphIndex
  actions: ProgramAction[]
  busy: string | null
  onNav(stage: 'unfold' | 'map' | 'detail', id: string): void
  onCompare(ids: string[]): void
  onAct(action: ProgramAction, ids: string[]): void
  compact?: boolean
}) {
  if (!items.length) return null
  const ids = items.map((i) => i.id)
  const single = items.length === 1
  const btn = cx('min-h-9 rounded-lg px-2.5 text-[12.5px]', compact && 'px-2')
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={single ? `Actions for ${items[0].label}` : `Actions for ${items.length} items`}>
      {single &&
        NAV.map((n) => (
          <Button key={n.id} variant="subtle" icon={n.icon} className={btn} title={n.hint} onClick={() => onNav(n.id, ids[0])}>
            {n.label}
          </Button>
        ))}
      {items.length >= 2 && (
        <Button variant="primary" hue={190} icon="columns" className={btn} onClick={() => onCompare(ids)} title="Put them side by side: agreement, conflict and what is missing">
          Compare {items.length}
        </Button>
      )}
      {actions
        .filter((a) => !(a.id === 'compare' && items.length >= 2))
        .map((a) => (
          <Button key={a.id} variant="ghost" className={cx(btn, 'border border-line')} disabled={!!busy} onClick={() => onAct(a, ids)} aria-busy={busy === a.id}>
            {busy === a.id ? <span className="size-3.5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" aria-hidden="true" /> : <Icon name={ACTION_ICON[a.id] ?? 'bolt'} size={15} />}
            {a.label ?? a.id}
          </Button>
        ))}
      {single && !gi.items.get(ids[0]) && null}
    </div>
  )
}


// ---------------------------------------------------------------- needs_input

export function InputForm({ input, def, busy, onSubmit, onCancel }: { input: PendingInput; def?: ProgramAction; busy: boolean; onSubmit(params: Record<string, unknown>): void; onCancel(): void }) {
  const fields = Object.entries(input.needs).filter(([k]) => k !== 'items')
  const needsItems = 'items' in input.needs
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([k]) => [k, String(input.params[k] ?? '')])))
  const first = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  useEffect(() => {
    const t = setTimeout(() => first.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit({ ...input.params, ...values })
  }
  return (
    <m.form
      onSubmit={submit}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      className="rounded-2xl border border-accent-2/30 p-3.5"
      style={{ background: 'linear-gradient(180deg, rgb(110 231 255 / 0.06), rgb(110 231 255 / 0.02)), rgb(10 10 32 / 0.9)' }}
      aria-label={`${def?.label ?? input.action}: more input needed`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-2/15 text-accent-2">
          <Icon name={ACTION_ICON[input.action] ?? 'edit'} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{def?.label ?? input.action}: the program needs more</div>
          {input.message && <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{input.message}</p>}
        </div>
      </div>
      {needsItems && (
        <p className="mt-2.5 rounded-lg border border-line bg-white/[0.03] px-2.5 py-2 text-[12px] text-ink-2">
          <b className="font-semibold">Items:</b> {input.needs.items}. Select them on the stage (shift-click, or “Select more”), then run it again.
        </p>
      )}
      <div className="mt-3 space-y-2.5">
        {fields.map(([k, desc], i) => (
          <label key={k} className="block">
            <span className="mb-1 flex items-baseline gap-2 text-[12px]">
              <span className="font-mono text-ink-2">{k}</span>
              <span className="text-ink-4">{desc}</span>
            </span>
            {k === 'text' || desc.length > 40 ? (
              <textarea
                ref={i === 0 ? (el) => void (first.current = el) : undefined}
                value={values[k] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                rows={2}
                className="w-full resize-y rounded-xl border border-line-2 bg-black/30 px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-accent-2/60"
                placeholder={desc}
              />
            ) : (
              <input
                ref={i === 0 ? (el) => void (first.current = el) : undefined}
                value={values[k] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                className="min-h-10 w-full rounded-xl border border-line-2 bg-black/30 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-accent-2/60"
                placeholder={desc}
              />
            )}
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" className="min-h-9 text-[13px]" onClick={onCancel}>
          Cancel
        </Button>
        {fields.length > 0 && (
          <Button type="submit" variant="primary" hue={190} className="min-h-9 text-[13px]" disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        )}
      </div>
    </m.form>
  )
}

// ---------------------------------------------------------------- notices

const TONE: Record<ProgramNotice['tone'], { color: string; icon: IconName }> = {
  info: { color: '#7dd3fc', icon: 'info' },
  good: { color: '#4ade80', icon: 'check' },
  warn: { color: '#fbbf24', icon: 'alert' },
  bad: { color: '#fb7185', icon: 'alert' },
}

export function NoticeBar({ notice, onDismiss }: { notice: ProgramNotice; onDismiss(): void }) {
  const t = TONE[notice.tone]
  useEffect(() => {
    if (notice.kind !== 'revision' && notice.kind !== 'result') return
    const id = setTimeout(onDismiss, notice.kind === 'revision' ? 7000 : 9000)
    return () => clearTimeout(id)
  }, [notice, onDismiss])
  return (
    <m.div
      layout
      role={notice.tone === 'bad' || notice.tone === 'warn' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
      className="flex items-start gap-2.5 rounded-2xl border px-3 py-2.5 shadow-[0_18px_50px_-16px_rgb(0_0_0/0.9)]"
      style={{ borderColor: `color-mix(in srgb, ${t.color} 35%, transparent)`, background: `linear-gradient(180deg, color-mix(in srgb, ${t.color} 7%, transparent), transparent), rgb(12 12 34)` }}
    >
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-lg" style={{ color: t.color, background: `color-mix(in srgb, ${t.color} 15%, transparent)` }}>
        <Icon name={t.icon} size={14} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink">{notice.title}</div>
        {notice.body && <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{notice.body}</p>}
      </div>
      <button onClick={onDismiss} className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Dismiss">
        <Icon name="x" size={15} />
      </button>
    </m.div>
  )
}

// ---------------------------------------------------------------- tasks

const LIVE = new Set(['open', 'claimed', 'waiting', 'stalled'])
const GOAL_COLOR: Record<string, string> = { open: '#7dd3fc', claimed: '#fbbf24', waiting: '#fbbf24', stalled: '#fb7185', done: '#4ade80', failed: '#fb7185', cancelled: '#8a89b3' }

export function TaskChips({ tasks, swarmId, onCancel }: { tasks: TaskRef[]; swarmId: string; onCancel(id: string): void }) {
  const goals = useHive((s) => s.goals)
  const agents = useHive((s) => s.agents)
  if (!tasks.length) return null
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tasks started from this program">
      <AnimatePresence initial={false}>
        {tasks.map((t) => {
          const g = goals[t.id]
          const status = g?.status ?? t.status
          const color = GOAL_COLOR[status] ?? '#8a89b3'
          const who = g?.claimed_by ? agents[g.claimed_by]?.name : null
          return (
            <m.li key={t.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="flex min-w-0 items-center gap-1 rounded-xl border border-line bg-white/[0.035] py-1 pr-1 pl-2">
              <span className={cx('size-2 shrink-0 rounded-full', LIVE.has(status) && 'animate-pulse')} style={{ background: color, boxShadow: `0 0 8px ${color}` }} aria-hidden="true" />
              <button
                onClick={() => navigate({ name: 'tasks', swarm: swarmId })}
                className="min-w-0 truncate text-left text-[12px] text-ink-2 hover:text-ink"
                title={g ? `${g.title} — open its tasks` : 'Open its tasks'}
              >
                <span className="font-medium text-ink">{t.label}</span>
                <span className="text-ink-4"> · task </span>
                <span className="font-mono text-[11px]">{t.id}</span>
              </button>
              <span className="shrink-0 rounded-md px-1.5 py-px text-[10.5px] font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>
                {status}
                {who ? ` · ${who}` : ''}
              </span>
              {LIVE.has(status) && (
                <button onClick={() => onCancel(t.id)} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-3 hover:bg-bad/10 hover:text-bad" aria-label={`Cancel task ${t.id}`}>
                  Cancel
                </button>
              )}
            </m.li>
          )
        })}
      </AnimatePresence>
    </ul>
  )
}
