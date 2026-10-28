import { memo, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useDraft } from '../drafts'
import { m } from 'framer-motion'
import { plainText, shown, type Agent, type Approval, type Goal, type Message, type Swarm } from '../sdk'
import type { MotivationRef } from '../../api/types'
import { servesWords, stickyLine } from './motives'
import { ago, GOAL_LABEL, GOAL_PAPER, RISK_PAPER, shortModel, STATUS_LABEL } from './data'
import type { Lod } from './engine'
import { hashAngle, type Rect } from './layout'
import { avatarFill, MONO, tint, type Mode } from './theme'
import { place, ring, sc } from './util'
import { withBusy } from './busy'
import { plural } from '../../lib/plural'
import { guardComposing } from '../../features/ask/keys'


export function Avatar({ name, hue, size, radius }: { name: string; hue: number; size: number; radius?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center font-semibold text-white select-none"
      style={{ width: size, height: size, borderRadius: radius ?? size * 0.3, background: avatarFill(hue), fontSize: size * 0.46, letterSpacing: '-0.02em' }}
    >
      {shown(name).slice(0, 1).toUpperCase()}
    </span>
  )
}

function StatusDot({ status, thinking, size = 8 }: { status: string; thinking: boolean; size?: number }) {
  const c = status === 'awake' ? 'var(--good)' : status === 'starting' ? 'var(--warn)' : status === 'error' ? 'var(--bad)' : 'var(--sleep)'
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {thinking && <span className="cv-ping absolute inset-0 rounded-full" style={{ background: 'var(--accent)' }} />}
      <span className="absolute inset-0 rounded-full" style={{ background: thinking ? 'var(--accent)' : c }} />
    </span>
  )
}

/** Follow focus with the camera only for keyboard focus on the item itself (not a click on a button inside it). */
const kbd = (fn: () => void) => (e: FocusEvent) => {
  if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) fn()
}

const onKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fn()
  }
}

// ------------------------------------------------------------------ islands

export interface IslandProps {
  r: Rect
  id: string
  swarm: Swarm | null
  name: string
  hue: number | null
  mode: Mode
  lod: Lod
  members: Agent[]
  goalCount: number
  openGoals: number
  beliefCount: number
  coordinator: string | null
  selected: boolean
  hidden: number
  onSelect: () => void
  onFocusItem: () => void
}

export const Island = memo(function Island(p: IslandProps) {
  const t = tint(p.hue, p.mode)
  const awake = p.members.filter((m) => m.status === 'awake' || m.status === 'starting').length
  const label = `${p.name}: ${plural(p.members.length, 'mind')}, ${awake} awake${p.swarm ? `, ${plural(p.openGoals, 'open task')}` : ''}`
  return (
    <div
      data-item={`island:${p.id}`}
      data-presence-ref={p.swarm ? `swarm:${p.id}` : undefined}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={p.onSelect}
      onFocus={kbd(p.onFocusItem)}
      onKeyDown={onKey(p.onSelect)}
      className="cv-island outline-none"
      style={{ ...place(p.r), background: t.fill, borderRadius: 32, border: `${sc(1)} solid ${t.edge}`, ...(p.selected ? { boxShadow: `0 0 0 ${sc(2)} var(--accent)` } : {}) }}
    >
      {p.lod === 'far' ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-[0.6em] text-center" style={{ fontSize: `min(${sc(15)}, ${p.r.w / 16}px)` }}>
          <div className="font-semibold tracking-[-0.03em]" style={{ fontSize: '2.4em', lineHeight: 1.05, color: t.title }}>
            {shown(p.name)}
          </div>
          <div className="flex items-center gap-[0.35em]" style={{ color: 'var(--ink-2)', fontSize: '1em' }}>
            <span className="font-semibold" style={{ color: 'var(--ink)' }}>{`${awake}/${p.members.length}`}</span> awake
            {p.swarm && (
              <>
                <span aria-hidden>·</span>
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>{p.openGoals}</span> tasks
                <span aria-hidden>·</span>
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>{p.beliefCount}</span> beliefs
              </>
            )}
          </div>
          <div className="mt-[0.2em] flex flex-wrap justify-center gap-[0.4em]">
            {p.members.slice(0, 12).map((m) => (
              <span
                key={m.id}
                className="inline-block rounded-full"
                style={{ width: '1.35em', height: '1.35em', background: avatarFill(m.hue), opacity: m.status === 'awake' ? 1 : 0.35, boxShadow: m.status === 'awake' ? `0 0 0 0.18em ${t.fill}, 0 0 0 0.28em ${t.strong}` : undefined }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-6" style={{ padding: '30px 36px 0' }}>
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="inline-block size-3 rounded-full" style={{ background: t.strong }} />
              <h2 className="m-0 truncate font-semibold tracking-[-0.025em]" style={{ fontSize: p.lod === 'overview' ? 40 : 28, lineHeight: 1.1, color: t.title }}>
                {shown(p.name)}
              </h2>
            </div>
            {p.lod === 'detail' && p.swarm?.description && (
              <p className="m-0 mt-1.5 line-clamp-1 max-w-[560px] text-[14px]" style={{ color: 'var(--ink-2)' }}>
                {p.swarm.description}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" style={{ fontSize: p.lod === 'overview' ? 18 : 12.5 }}>
              <Chip>
                <StatusDot status={awake ? 'awake' : 'asleep'} thinking={false} size={p.lod === 'overview' ? 10 : 7} /> {awake} of {p.members.length} awake
              </Chip>
              {p.swarm && <Chip>{plural(p.goalCount, 'task')}</Chip>}
              {p.swarm && <Chip>{plural(p.beliefCount, 'belief')}</Chip>}
              {p.coordinator && p.lod === 'detail' && <Chip>led by {shown(p.coordinator)}</Chip>}
              {p.hidden > 0 && p.lod === 'detail' && <Chip>+{p.hidden} older tasks</Chip>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[0.4em] rounded-full px-[0.75em] py-[0.25em] font-medium" style={{ background: 'var(--card)', color: 'var(--ink-2)', border: '1px solid var(--line)' }}>
      {children}
    </span>
  )
}

// ------------------------------------------------------------------ mind card

export interface MindProps {
  r: Rect
  agent: Agent
  lod: Lod
  phase: string | undefined
  said: Message | null
  heard: Message | null
  heardFrom: string | null
  now: number
  selected: boolean
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onFocusItem: (key: string) => void
}

export const MindCard = memo(function MindCard(p: MindProps) {
  const a = p.agent
  const thinking = p.phase === 'llm' || p.phase === 'skills'
  const asleep = a.status !== 'awake' && a.status !== 'starting'
  const status = thinking ? (p.phase === 'skills' ? 'Using skills' : 'Thinking') : STATUS_LABEL[a.status] ?? a.status
  const big = p.lod === 'overview'
  return (
    <div
      data-item={`mind:${a.id}`}
      data-presence-ref={`mind:${a.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${shown(a.name)}, ${status}. Press Enter to talk.`}
      onClick={() => p.onSelect(a.id)}
      onKeyDown={onKey(() => p.onOpen(a.id))}
      onFocus={kbd(() => p.onFocusItem(`mind:${a.id}`))}
      className="cv-card group flex flex-col overflow-hidden outline-none"
      style={{ ...place(p.r), background: 'var(--card)', borderRadius: 18, border: '1px solid var(--line)', boxShadow: 'var(--shadow)', ...ring(p.selected), opacity: asleep && !p.selected ? 0.9 : 1 }}
    >
      <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: avatarFill(a.hue), opacity: asleep ? 0.35 : 1 }} />
      {big ? (
        <div className="flex h-full flex-col justify-center gap-3 px-6">
          <div className="flex items-center gap-4">
            <Avatar name={a.name} hue={a.hue} size={58} radius={16} />
            <div className="min-w-0">
              <div className="truncate font-semibold tracking-[-0.02em]" style={{ fontSize: 32, lineHeight: 1.1, color: 'var(--ink)' }}>
                {shown(a.name)}
              </div>
              <div className="mt-1 flex items-center gap-2" style={{ fontSize: 19, color: thinking ? 'var(--accent-ink)' : 'var(--ink-3)' }}>
                <StatusDot status={a.status} thinking={thinking} size={11} /> {status}
              </div>
            </div>
          </div>
          <div className="line-clamp-2" style={{ fontSize: 19, lineHeight: 1.3, color: 'var(--ink-2)' }}>
            {p.said ? plainText(p.said.text) : asleep ? 'Resting.' : 'Listening.'}
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col px-4 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <Avatar name={a.name} hue={a.hue} size={34} radius={10} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[15.5px] font-semibold tracking-[-0.015em]" style={{ color: 'var(--ink)' }}>
                  {shown(a.name)}
                </span>
                {a.kind !== 'omega' && (
                  <span className="rounded px-1 py-px text-[10.5px] font-medium tracking-wide uppercase" style={{ color: 'var(--ink-3)', border: '1px solid var(--line-2)' }}>
                    {a.kind}
                  </span>
                )}
              </div>
              <div className="truncate text-[11.5px]" style={{ color: 'var(--ink-3)', fontFamily: MONO }}>
                {shortModel(a.model)}
              </div>
            </div>
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[11.5px] font-medium"
              style={{ background: thinking ? 'var(--accent-soft)' : 'var(--card-2)', color: thinking ? 'var(--accent-ink)' : 'var(--ink-2)', border: '1px solid var(--line)' }}
            >
              <StatusDot status={a.status} thinking={thinking} size={7} />
              {status}
            </span>
          </div>
          <div className="mt-3 flex-1">
            <div className="text-[10.5px] font-semibold tracking-[0.06em] uppercase" style={{ color: 'var(--ink-3)' }}>
              {thinking ? 'Working' : 'Last thought'}
            </div>
            <div className={`mt-1 line-clamp-2 text-[13.5px] leading-[1.38] ${thinking ? 'cv-shimmer' : ''}`} style={{ color: 'var(--ink)' }}>
              {p.said ? plainText(p.said.text) : asleep ? 'Resting. Wake it to talk.' : 'Nothing said yet.'}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 border-t pt-2 text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-3)' }}>
            <span className="min-w-0 flex-1 truncate">
              {p.heard ? (
                <>
                  <span className="font-medium" style={{ color: 'var(--ink-2)' }}>
                    {p.heardFrom ? shown(p.heardFrom) : 'You'}:
                  </span>{' '}
                  {plainText(p.heard.text)}
                </>
              ) : (
                'No messages yet'
              )}
            </span>
            <span className="shrink-0 tabular-nums">{ago(p.said?.created_at ?? a.last_active_at, p.now)}</span>
          </div>
        </div>
      )}
    </div>
  )
})

// ------------------------------------------------------------------ task stickies (goals underneath)

export interface GoalProps {
  r: Rect
  goal: Goal
  lod: Lod
  holder: Agent | null
  /** The motivations this task serves, as this person can read them (a hidden link and no link look the same). */
  motivations: readonly MotivationRef[]
  selected: boolean
  mode: Mode
  onSelect: (key: string) => void
  onFocusItem: (key: string) => void
}

const priorityDots = (p: number) => Math.max(1, Math.min(3, Math.round(p * 3)))

export const GoalSticky = memo(function GoalSticky(p: GoalProps) {
  const g = p.goal
  const key = `goal:${g.id}`
  const big = p.lod === 'overview'
  const done = g.status === 'done' || g.status === 'cancelled' || g.status === 'failed'
  const serves = stickyLine(p.motivations)
  return (
    <div
      data-item={key}
      data-presence-ref={key}
      role="button"
      tabIndex={0}
      aria-label={`Task: ${plainText(g.title)}. ${GOAL_LABEL[g.status]}.${servesWords(p.motivations)}`}
      onClick={() => p.onSelect(key)}
      onKeyDown={onKey(() => p.onSelect(key))}
      onFocus={kbd(() => p.onFocusItem(key))}
      className="cv-sticky flex flex-col outline-none"
      style={{
        ...place(p.r),
        transform: `translate(${p.r.x}px, ${p.r.y}px) rotate(${hashAngle(g.id)}deg)`,
        background: GOAL_PAPER[g.status],
        color: '#16161a',
        borderRadius: 4,
        padding: big ? '18px 18px' : '14px 15px 12px',
        boxShadow: p.selected ? `0 0 0 ${sc(2)} var(--accent), 0 12px 24px -12px rgba(22,22,26,.35)` : '0 1px 1px rgba(22,22,26,.08), 0 10px 22px -12px rgba(22,22,26,.4)',
        opacity: done ? 0.78 : 1,
        filter: p.mode === 'dark' ? 'brightness(0.93) saturate(1.05)' : undefined,
      }}
    >
      {big ? (
        <div className="line-clamp-4 font-semibold tracking-[-0.015em]" style={{ fontSize: 24, lineHeight: 1.18, textDecoration: done ? 'line-through' : undefined }}>
          {plainText(g.title)}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-[10.5px] font-semibold tracking-[0.06em] uppercase" style={{ color: 'rgba(22,22,26,.72)' }}>
            <span>{GOAL_LABEL[g.status]}</span>
            <span aria-label={`priority ${Math.round(g.priority * 100)}%`} className="flex gap-[3px]">
              {[0, 1, 2].map((i) => (
                <span key={i} className="inline-block size-[5px] rounded-full" style={{ background: i < priorityDots(g.priority) ? '#16161a' : 'rgba(22,22,26,.2)' }} />
              ))}
            </span>
          </div>
          <div className={`mt-1.5 ${serves ? 'line-clamp-3' : 'line-clamp-4'} flex-1 text-[14.5px] leading-[1.28] font-semibold tracking-[-0.01em]`} style={{ textDecoration: done ? 'line-through' : undefined }}>
            {plainText(g.title)}
          </div>
          {serves && (
            <div data-cv-serves aria-hidden className="mt-0.5 flex items-center gap-1 text-[11px] font-medium" style={{ color: 'rgba(22,22,26,.74)' }} title={p.motivations.map((x) => x.title).join(', ')}>
              <Target size={10} />
              <span className="truncate">{serves}</span>
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px]" style={{ color: 'rgba(22,22,26,.74)' }}>
            {p.holder ? (
              <>
                <Avatar name={p.holder.name} hue={p.holder.hue} size={16} radius={5} />
                <span className="truncate font-medium">{shown(p.holder.name)}</span>
              </>
            ) : (
              <span>Unclaimed</span>
            )}
          </div>
        </>
      )}
    </div>
  )
})

/** The motivation mark (a target), the same idea as the classic chips' icon, drawn in Canvas's ink. */
export function Target({ size }: { size: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" className="shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <circle cx="6" cy="6" r="4.9" />
      <circle cx="6" cy="6" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function AddSticky({ r, lod, drafting, reduced, draftKey, onStart, onCancel, onSubmit }: { r: Rect; lod: Lod; drafting: boolean; reduced: boolean; /** where the unsent words live (experiences/drafts) */ draftKey: string; onStart: () => void; onCancel: () => void; onSubmit: (title: string) => Promise<boolean> }) {
  const [text, setText] = useDraft(draftKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errId = useId()
  const draftRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (drafting) draftRef.current?.focus({ preventScroll: true })
  }, [drafting])
  if (drafting) {
    const submit = async () => {
      const t = text.trim()
      if (!t || busy) return
      setError(null)
      // the draft stays until the task is really pinned; busy always clears
      const r = await withBusy(setBusy, () => onSubmit(t))
      if (r.ok && r.value) setText('')
      else setError('Not pinned. Your text is kept; try again.')
    }
    return (
      <m.div
        data-nopan
        initial={reduced ? false : { scale: 0.9, rotate: -3, opacity: 0 }}
        animate={reduced ? { opacity: 1 } : { scale: 1, rotate: -0.6, opacity: 1 }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 28 }}
        className="cv-paper flex flex-col"
        style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, background: GOAL_PAPER.open, color: '#16161a', borderRadius: 4, padding: '12px 14px', boxShadow: `0 0 0 ${sc(2)} var(--accent), 0 16px 30px -14px rgba(22,22,26,.5)`, zIndex: 5 }}
      >
        <div className="text-[10.5px] font-semibold tracking-[0.06em] uppercase" style={{ color: 'rgba(22,22,26,.72)' }}>New task</div>
        <textarea
          ref={draftRef}
          aria-label="New task title"
          aria-describedby={error ? errId : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !guardComposing(e)) {
              e.preventDefault()
              void submit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
          placeholder="What should this swarm do?"
          className="mt-1 w-full flex-1 resize-none border-0 bg-transparent p-0 text-[14.5px] leading-[1.28] font-semibold outline-none placeholder:font-normal placeholder:text-[rgba(22,22,26,.62)]"
          style={{ color: '#16161a' }}
        />
        {error && (
          <div id={errId} role="alert" className="mb-1 text-[11.5px] leading-tight font-semibold" style={{ color: '#8f1d14' }}>
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5">
          <button onClick={onCancel} className="rounded-md px-2 py-1 text-[12px] font-medium hover:bg-black/5" style={{ color: 'rgba(22,22,26,.8)' }}>
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={!text.trim() || busy} className="rounded-md px-2.5 py-1 text-[12px] font-semibold text-white disabled:opacity-50" style={{ background: '#16161a' }}>
            {busy ? 'Pinning…' : 'Pin task'}
          </button>
        </div>
      </m.div>
    )
  }
  return (
    <button
      data-nopan
      onClick={onStart}
      aria-label="Add a task to this swarm"
      className="cv-add grid place-items-center outline-none"
      style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 6, border: '1.5px dashed var(--line-2)', color: 'var(--ink-3)', background: 'transparent' }}
    >
      <span className="flex flex-col items-center gap-1 font-medium" style={{ fontSize: lod === 'overview' ? 22 : 13.5 }}>
        <span aria-hidden className="text-[1.6em] leading-none font-light">+</span>
        Add task
      </span>
    </button>
  )
}

// ------------------------------------------------------------------ decisions

export interface DecisionProps {
  r: Rect
  approval: Approval
  agent: Agent | null
  lod: Lod
  now: number
  selected: boolean
  reduced: boolean
  onSelect: (key: string) => void
  onInspect: (id: string) => void
  onFocusItem: (key: string) => void
}

/**
 * A pinned request. Compact by design, so it never decides anything: it shows who asks and for what, and opens
 * the inspection, where the full request is read and answered.
 */
export const DecisionSticky = memo(function DecisionSticky(p: DecisionProps) {
  const a = p.approval
  const key = `decision:${a.id}`
  const paper = RISK_PAPER[a.risk]
  const big = p.lod === 'overview'
  const who = p.agent ? shown(p.agent.name) : 'A mind'
  const angle = hashAngle(a.id, 3)
  const review = (
    <button
      data-review={a.id}
      onClick={(e) => (e.stopPropagation(), p.onInspect(a.id))}
      onFocus={kbd(() => p.onFocusItem(key))}
      aria-label={`Review the request: ${who} asks to use ${a.skill}, ${a.risk} risk`}
      className={`w-full rounded-[8px] font-semibold text-white ${big ? 'py-2.5 text-[20px]' : 'py-[7px] text-[13px]'}`}
      style={{ background: '#16161a' }}
    >
      Review to decide
    </button>
  )
  return (
    <m.div
      initial={p.reduced ? false : { opacity: 0, y: -18, rotate: -4 }}
      animate={p.reduced ? { opacity: 1, rotate: angle } : { opacity: 1, y: 0, rotate: angle }}
      exit={p.reduced ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, scale: 0.92, rotate: 6, transition: { duration: 0.28 } }}
      transition={p.reduced ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 30 }}
      data-item={key}
      role="group"
      aria-label={`Decision: ${who} asks to use ${a.skill}. ${a.risk} risk.`}
      onClick={() => p.onSelect(key)}
      className="cv-decision cv-paper flex flex-col"
      style={{
        position: 'absolute',
        left: p.r.x,
        top: p.r.y,
        width: p.r.w,
        height: p.r.h,
        background: paper,
        color: '#16161a',
        borderRadius: 5,
        padding: big ? '22px 20px' : '18px 16px 14px',
        boxShadow: p.selected ? `0 0 0 ${sc(2)} var(--accent), 0 18px 34px -14px rgba(22,22,26,.5)` : '0 1px 1px rgba(22,22,26,.1), 0 16px 30px -16px rgba(22,22,26,.55)',
      }}
    >
      <span aria-hidden className="absolute top-[-7px] left-1/2 size-[15px] -translate-x-1/2 rounded-full" style={{ background: 'radial-gradient(circle at 35% 30%, #ff8a7a, #c62a1f 70%)', boxShadow: '0 2px 3px rgba(0,0,0,.35)' }} />
      {big ? (
        <div className="flex h-full flex-col gap-2">
          <div className="text-[15px] font-bold tracking-[0.06em] uppercase">{a.risk} risk</div>
          <div className="line-clamp-3 flex-1 text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] [overflow-wrap:anywhere]">
            {who} wants <span style={{ fontFamily: MONO, fontSize: 23 }}>{a.skill}</span>
          </div>
          <div data-nopan>{review}</div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="rounded-[4px] px-1.5 py-[2px] text-[10.5px] font-bold tracking-[0.08em] uppercase" style={{ background: '#16161a', color: paper }}>
              {a.risk} risk
            </span>
            <span className="text-[11.5px] tabular-nums" style={{ color: 'rgba(22,22,26,.78)' }}>{ago(a.created_at, p.now)}</span>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            {p.agent && <Avatar name={p.agent.name} hue={p.agent.hue} size={22} radius={6} />}
            <div className="line-clamp-2 min-w-0 text-[14px] leading-tight [overflow-wrap:anywhere]">
              <span className="font-semibold">{who}</span> wants to use <span className="font-semibold">{a.skill}</span>
            </div>
          </div>
          {/* a preview only: the inspection shows the whole request before anything can be decided */}
          <div aria-hidden className="mt-2 min-h-0 flex-1 overflow-hidden rounded-[5px] px-2 py-1.5 text-[12px] leading-[1.35] [overflow-wrap:anywhere]" style={{ background: 'rgba(22,22,26,.08)', fontFamily: MONO }}>
            <span className="line-clamp-3">{a.command}</span>
          </div>
          <div data-nopan className="mt-2">
            {review}
          </div>
        </>
      )}
    </m.div>
  )
})

export function Lane({ r, lod, count, mode }: { r: Rect; lod: Lod; count: number; mode: Mode }) {
  const fill = mode === 'light' ? 'rgba(22,22,26,0.035)' : 'rgba(255,255,255,0.03)'
  return (
    <div data-item="lane:decisions" style={{ ...place(r), background: fill, borderRadius: 32, border: `${sc(1)} dashed var(--line-2)` }}>
      {lod === 'far' ? (
        <div className="flex h-full flex-col items-center justify-center gap-[0.5em] text-center" style={{ fontSize: `min(${sc(15)}, ${Math.min(r.w / 7, r.h / 4)}px)` }}>
          <div className="font-semibold tracking-[-0.03em]" style={{ fontSize: '2.4em', color: 'var(--ink)' }}>Decisions</div>
          <div className="rounded-full px-[0.8em] py-[0.2em] font-semibold whitespace-nowrap" style={{ background: count ? 'var(--bad)' : 'var(--card)', color: count ? 'var(--on-bad)' : 'var(--ink-2)', fontSize: '1.2em' }}>
            {count ? `${count} waiting` : 'All clear'}
          </div>
        </div>
      ) : (
        <div style={{ padding: '30px 24px 0' }}>
          <div className="flex items-center gap-2.5">
            <h2 className="m-0 font-semibold tracking-[-0.025em]" style={{ fontSize: lod === 'overview' ? 40 : 28, lineHeight: 1.1, color: 'var(--ink)' }}>
              Decisions
            </h2>
            {count > 0 && (
              <span className="rounded-full px-2.5 py-0.5 font-semibold tabular-nums" style={{ background: 'var(--bad)', color: 'var(--on-bad)', fontSize: lod === 'overview' ? 22 : 14 }}>
                {count}
              </span>
            )}
          </div>
          <p className="m-0 mt-1.5 text-[14px]" style={{ color: 'var(--ink-2)', fontSize: lod === 'overview' ? 18 : 14 }}>
            {count ? 'Minds asking for your OK.' : 'Nothing needs you right now.'}
          </p>
          {count === 0 && lod === 'detail' && (
            <div className="mt-6 rounded-[6px] p-4 text-[13.5px] leading-[1.4]" style={{ border: '1.5px dashed var(--line-2)', color: 'var(--ink-3)' }}>
              When a mind asks to run something that needs a person, it is pinned here. Open a note to read the whole request and answer it.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
