import { useMemo, useState } from 'react'
import type { Goal, Motivation, MotivationRef } from '../../api/types'
import { cx } from '../../lib/cx'
import { changeLinks, linkable, LINK_MEANS, useMotivationData } from '../../lib/motivations'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'

const NONE: MotivationRef[] = []

/** A motivation chip: its title, quieter when it is not active; it opens Tasks filtered to it. */
export function MotivationChip({ m, onClick, title }: { m: Pick<MotivationRef, 'id' | 'title' | 'status'>; onClick?: () => void; title?: string }) {
  const quiet = m.status !== 'active'
  return (
    <button
      type="button"
      onClick={onClick ?? (() => navigate({ name: 'tasks', motivation: m.id }))}
      title={title ?? `Tasks under “${m.title}”${quiet ? ` (${m.status})` : ''}`}
      data-motivation-chip={m.id}
      className={cx('inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors hover:bg-white/[0.06]', quiet ? 'border-line text-ink-3' : 'border-accent/30 bg-accent/[0.07] text-accent')}
    >
      <Icon name="target" size={10} strokeWidth={2.4} />
      <span className="truncate">{m.title}</span>
      {quiet && <span className="text-ink-4">· {m.status}</span>}
    </button>
  )
}

/**
 * The always-visible part of a task card: the motivations it serves (Q7: a task may serve several) and the cross-team
 * requests it is part of. Only links this person can read are known here: a hidden link and no link look the same.
 */
export function TaskChips({ goal }: { goal: Goal }) {
  const links = useHive((s) => s.taskLinks[goal.id] ?? NONE)
  const all = useHive((s) => s.requests)
  const reqs = useMemo(() => Object.values(all).filter((r) => r.from_goal === goal.id || r.receiving_goal === goal.id), [all, goal.id])
  if (!links.length && !reqs.length) return null
  return (
    <div className="-mt-1 flex flex-wrap gap-1 px-3.5 pb-2" data-task-chips>
      {links.map((m) => (
        <MotivationChip key={m.id} m={m} />
      ))}
      {reqs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => navigate({ name: 'swarm', id: goal.swarm_id, tab: 'requests' })}
          className="inline-flex min-h-6 items-center gap-1 rounded-full border border-line px-2 text-[11px] text-ink-3 hover:bg-white/[0.06]"
          title={`Cross-swarm request ${r.id}`}
        >
          <Icon name="link" size={10} />
          {r.kind} · {r.from_goal === goal.id ? 'asked' : 'received'} · {r.state}
        </button>
      ))}
    </div>
  )
}

/**
 * The open card's motivations: file the task under one this person may change, or take it out of one. One explicit
 * choice each, sent as one operation on the hive (the task's subtasks along when asked). Association only.
 */
export function TaskLinks({ goal, subtasks }: { goal: Goal; subtasks: number }) {
  const { supported } = useMotivationData()
  const links = useHive((s) => s.taskLinks[goal.id] ?? NONE)
  const motivations = useHive((s) => s.motivations)
  const toast = useHive((s) => s.toast)
  const [picking, setPicking] = useState(false)
  const [withSubs, setWithSubs] = useState(true)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const candidates = useMemo(
    () =>
      Object.values(motivations)
        .filter((m) => m.editable && linkable(m) && (!m.swarm_id || m.swarm_id === goal.swarm_id) && !links.some((l) => l.id === m.id))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [motivations, links, goal.swarm_id],
  )
  if (!supported) return null
  const run = async (m: Motivation, op: 'link' | 'unlink') => {
    setBusy(true)
    const r = await changeLinks(m, op, [goal.id], subtasks > 0 && withSubs)
    setBusy(false)
    setConfirm(null)
    setPicking(false)
    if (!r.ok) toast({ tone: 'error', title: op === 'link' ? 'Not filed under the motivation' : 'Not taken out of the motivation', body: r.why })
  }
  return (
    <div className="space-y-1.5" data-task-links>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[11px] text-ink-4">Motivations</span>
        {links.length === 0 && <span className="text-[11px] text-ink-3">none you can see</span>}
        {links.map((l) => {
          const m = motivations[l.id]
          return (
            <span key={l.id} className="inline-flex max-w-full items-center gap-0.5">
              <MotivationChip m={l} />
              {m?.editable &&
                (confirm === l.id ? (
                  <span className="inline-flex items-center gap-1 text-[11px]">
                    <button type="button" disabled={busy} onClick={() => void run(m, 'unlink')} className="rounded px-1.5 text-bad hover:bg-white/[0.06]">
                      Take out{subtasks > 0 && withSubs ? ' with subtasks' : ''}
                    </button>
                    <button type="button" onClick={() => setConfirm(null)} className="rounded px-1.5 text-ink-3 hover:bg-white/[0.06]">
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirm(l.id)} aria-label={`Take this task out of “${l.title}”`} className="flex size-6 items-center justify-center rounded-full text-ink-4 hover:bg-white/[0.06] hover:text-ink">
                    <Icon name="x" size={10} />
                  </button>
                ))}
            </span>
          )
        })}
        {candidates.length > 0 && (
          <button type="button" onClick={() => setPicking(!picking)} aria-expanded={picking} className="inline-flex min-h-6 items-center gap-1 rounded-full border border-dashed border-line-2 px-2 text-[11px] text-ink-2 hover:bg-white/[0.06]">
            <Icon name="plus" size={10} />
            File under a motivation
          </button>
        )}
      </div>
      {picking && (
        <div className="rounded-xl border border-line bg-black/30 p-1.5" role="group" aria-label="File this task under a motivation">
          <ul className="max-h-48 space-y-px overflow-y-auto">
            {candidates.map((m) => (
              <li key={m.id}>
                <button type="button" disabled={busy} onClick={() => void run(m, 'link')} className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-ink-2 hover:bg-white/[0.06] disabled:opacity-50">
                  <Icon name="target" size={12} />
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  {m.status === 'paused' && <span className="text-[11px] text-ink-4">paused</span>}
                </button>
              </li>
            ))}
          </ul>
          {subtasks > 0 && (
            <label className="mt-1 flex items-center gap-2 px-2 text-[11.5px] text-ink-3">
              <input type="checkbox" checked={withSubs} onChange={(e) => setWithSubs(e.target.checked)} />
              with its {subtasks} subtask{subtasks === 1 ? '' : 's'}
            </label>
          )}
          <p className="mt-1 px-2 text-[11px] text-ink-4">{LINK_MEANS}</p>
        </div>
      )}
    </div>
  )
}
