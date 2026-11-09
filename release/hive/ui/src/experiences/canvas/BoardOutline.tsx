import { useCanvasCurrent } from './actionAuthority'
import { plural } from '../../lib/plural'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { openClassic, shown, useHive } from '../sdk'
import { withBusy } from './busy'
import { GOAL_LABEL, isAwake, STATUS_LABEL } from './data'
import type { Outline } from './outline'
import { NO_MOTIVES } from './motives'
import { Target } from './parts'
import type { MotivationRef } from '../../api/types'

/**
 * "Board outline": a stable list of every swarm, mind, task and decision, mounted wherever the camera is. It is
 * the first stop in the tab order and stays visually hidden until it holds focus (or is opened from the toolbar,
 * key O), so keyboard and screen-reader users can find, open and act on anything the board has unmounted.
 */
export function BoardOutline({
  outline,
  open,
  onClose,
  onLocate,
  onInspect,
  onDecideGoal,
  onTalk,
  onAddGoal,
}: {
  outline: Outline
  open: boolean
  onClose: () => void
  onLocate: (key: string) => void
  onInspect: (id: string) => void
  /** Review D1: opens the shared GoalDecision on the task (a goal underneath) as the outline shows it (never a one-tap write). */
  onDecideGoal: (id: string, to: 'done' | 'open') => void
  onTalk: (id: string) => void
  onAddGoal: (swarmId: string) => void
}) {
  const current = useCanvasCurrent()
  const head = useId()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
  const agents = useHive((s) => s.agents)
  const taskLinks = useHive((s) => s.taskLinks)
  return (
    <nav
      data-chrome
      data-ownkeys
      data-open={open ? '' : undefined}
      aria-labelledby={head}
      onKeyDown={onKeyDown}
      className="cv-outline absolute top-[64px] bottom-[72px] left-3 flex w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-[16px] border border-[var(--chrome-line)] bg-[var(--card)] shadow-[var(--shadow-lg)] select-text"
      style={{ zIndex: 45 }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <h2 id={head} className="m-0 flex-1 text-[15px] font-semibold text-[var(--ink)]">
          Canvas outline <span className="font-normal text-[var(--ink-3)]">· {plural(outline.count, 'item')}</span>
        </h2>
        <button onClick={onClose} className="h-8 rounded-[8px] px-2.5 text-[13px] font-medium text-[var(--ink-2)] hover:bg-[var(--accent-soft)]">
          {open ? 'Close' : 'Back to canvas'}
        </button>
      </div>
      <div data-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-2 pb-4" style={{ touchAction: 'pan-y' }}>
        <p className="m-0 mb-2 px-1 text-[12.5px] leading-[1.4] text-[var(--ink-2)]">Every swarm, mind, task and decision on the canvas. Locate flies the canvas to it and puts focus on it.</p>

        <Section title={`Decisions (${outline.decisions.length})`}>
          {outline.decisions.length === 0 ? (
            <p className="m-0 px-1 text-[13px] text-[var(--ink-2)]">Nothing needs you right now.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {outline.decisions.map((d) => {
                const who = d.agentName ? shown(d.agentName) : 'A mind'
                return (
                  <li key={d.id} data-outline-decision={d.id} className="rounded-[10px] px-1 py-1.5">
                    <div className="text-[13.5px] text-[var(--ink)] [overflow-wrap:anywhere]">
                      <span className="font-semibold">{who}</span>
                      {d.swarmName && <span className="text-[var(--ink-2)]"> · {shown(d.swarmName)}</span>} asks to use <span className="font-semibold">{d.skill}</span>{' '}
                      <span className="text-[var(--ink-2)]">({d.risk} risk)</span>
                    </div>
                    <Btns>
                      <Btn strong label={`Review the request from ${who} to use ${d.skill}`} onClick={() => onInspect(d.id)}>Review</Btn>
                      <Btn label={`Locate the request from ${who} on the canvas`} onClick={() => onLocate(d.key)}>Locate</Btn>
                    </Btns>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        {outline.groups.map((g) => (
          <Section key={g.id} title={g.isSwarm ? shown(g.name) : 'Unassigned minds'}>
            <Btns>
              <Btn label={`Locate ${g.isSwarm ? `swarm ${shown(g.name)}` : 'unassigned minds'}`} onClick={() => onLocate(g.key)}>Locate</Btn>
              {g.isSwarm && <Btn label={`Add a task to ${shown(g.name)}`} onClick={() => onAddGoal(g.id)}>Add task</Btn>}
            </Btns>
            {g.minds.length > 0 && (
              <>
                <h4 className="m-0 mt-2 px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">Minds</h4>
                <ul className="m-0 list-none p-0">
                  {g.minds.map((m) => {
                    const a = agents[m.id]
                    const awake = a ? isAwake(a) : false
                    return (
                      <Li key={m.id}>
                        <div className="text-[13.5px] text-[var(--ink)] [overflow-wrap:anywhere]">
                          <span className="font-semibold">{shown(m.name)}</span> <span className="text-[var(--ink-2)]">· {STATUS_LABEL[m.status] ?? m.status}</span>
                          {m.asks > 0 && <span className="font-semibold text-[var(--bad)]"> · waiting on {m.asks === 1 ? 'a decision' : `${m.asks} decisions`}</span>}
                        </div>
                        <Btns>
                          <Btn label={`Locate ${shown(m.name)}`} onClick={() => onLocate(m.key)} disabled={!m.onBoard}>Locate</Btn>
                          <Btn label={`Talk with ${shown(m.name)}`} onClick={() => onTalk(m.id)} disabled={!m.onBoard}>Talk</Btn>
                          {a && <Act label={`${awake ? 'Put' : 'Wake'} ${shown(m.name)}${awake ? ' to sleep' : ''}`} run={async () => { if (current()) return useHive.getState().agentAction(m.id, awake ? 'sleep' : 'wake') }}>{awake ? 'Sleep' : 'Wake'}</Act>}
                        </Btns>
                      </Li>
                    )
                  })}
                </ul>
              </>
            )}
            {g.goals.length > 0 && (
              <>
                <h4 className="m-0 mt-2 px-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--ink-3)] uppercase">Tasks</h4>
                <ul className="m-0 list-none p-0">
                  {g.goals.map((x) => {
                    const closed = x.status === 'done' || x.status === 'cancelled' || x.status === 'failed'
                    const serves = taskLinks[x.id] ?? NO_MOTIVES
                    return (
                      <Li key={x.id}>
                        <div className="text-[13.5px] text-[var(--ink)] [overflow-wrap:anywhere]">
                          <span className="font-semibold">{x.title}</span> <span className="text-[var(--ink-2)]">· {GOAL_LABEL[x.status] ?? x.status}</span>
                        </div>
                        {serves.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={`Motivations ${x.title} serves`}>
                            {serves.map((m) => (
                              <MotiveChip key={m.id} m={m} />
                            ))}
                          </div>
                        )}
                        <Btns>
                          {x.onBoard ? (
                            <Btn label={`Locate task ${x.title}`} onClick={() => onLocate(x.key)}>Locate</Btn>
                          ) : (
                            <Btn label={`Open task ${x.title} in the Tasks page (not pinned on the canvas)`} onClick={() => openClassic({ name: 'tasks', swarm: g.isSwarm ? g.id : undefined, task: x.id })}>Open in Tasks</Btn>
                          )}
                          <Btn label={`${closed ? 'Reopen' : 'Mark done'}: ${x.title}`} onClick={() => onDecideGoal(x.id, closed ? 'open' : 'done')}>
                            {closed ? 'Reopen' : 'Mark done'}
                          </Btn>
                        </Btns>
                      </Li>
                    )
                  })}
                </ul>
              </>
            )}
          </Section>
        ))}
      </div>
    </nav>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mt-3 border-t border-[var(--line)] pt-2.5 first-of-type:border-t-0">
      <h3 id={id} className="m-0 mb-1 px-1 text-[14px] font-semibold text-[var(--ink)] [overflow-wrap:anywhere]">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** A motivation a task serves: opens the classic Tasks page filtered to it (association only; it tells no mind anything). */
export function MotiveChip({ m }: { m: Pick<MotivationRef, 'id' | 'title' | 'status'> }) {
  const quiet = m.status !== 'active'
  return (
    <button
      data-motivation-chip={m.id}
      onClick={() => openClassic({ name: 'tasks', motivation: m.id })}
      aria-label={`Tasks under the motivation ${m.title}${quiet ? ` (${m.status})` : ''}`}
      className="inline-flex min-h-[28px] max-w-full items-center gap-1 rounded-full px-2 text-[12px] font-medium"
      style={quiet ? { border: '1px solid var(--line-2)', color: 'var(--ink-2)' } : { background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}
    >
      <Target size={10} />
      <span className="truncate">{m.title}</span>
      {quiet && <span className="shrink-0 text-[var(--ink-3)]">· {m.status}</span>}
    </button>
  )
}

const Li = ({ children }: { children: ReactNode }) => <li className="rounded-[10px] px-1 py-1.5">{children}</li>

const Btns = ({ children }: { children: ReactNode }) => <div className="mt-1 flex flex-wrap gap-1.5">{children}</div>

function Btn({ label, onClick, children, strong, disabled }: { label: string; onClick: () => void; children: ReactNode; strong?: boolean; disabled?: boolean }) {
  const current = useCanvasCurrent()
  return (
    <button
      aria-label={label}
      onClick={() => { if (current()) onClick() }}
      disabled={disabled}
      className="min-h-[32px] rounded-[8px] px-2.5 text-[12.5px] font-medium disabled:opacity-50"
      style={strong ? { background: 'var(--accent)', color: 'var(--on-accent)' } : { border: '1px solid var(--line-2)', color: 'var(--ink)' }}
    >
      {children}
    </button>
  )
}

/** A button that runs a hive action: busy while it runs, always released, and says so plainly if it failed. */
export function Act({ label, run, children }: { label: string; run: () => Promise<unknown>; children: ReactNode }) {
  const current = useCanvasCurrent()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button
        aria-label={label}
        aria-busy={busy}
        disabled={busy}
        onClick={async () => {
          if (!current()) return
          setError(null)
          const r = await withBusy(setBusy, run)
          if (!current()) return
          if (!r.ok) setError(`Did not work: ${r.error}`)
        }}
        className="min-h-[32px] rounded-[8px] px-2.5 text-[12.5px] font-medium disabled:opacity-50"
        style={{ border: '1px solid var(--line-2)', color: 'var(--ink)' }}
      >
        {busy ? '…' : children}
      </button>
      {error && (
        <span role="alert" className="basis-full text-[12px] font-semibold text-[var(--bad)]">
          {error}
        </span>
      )}
    </>
  )
}
