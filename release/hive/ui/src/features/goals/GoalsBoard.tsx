import { useVisibleAuthority } from '../../lib/useVisibleAuthority'
import { plural } from '../../lib/plural'
import { AnimatePresence, LayoutGroup, m } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Agent, Goal, GoalStatus, Motivation, Swarm } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { useIsDesktop, useNow, useReducedMotion } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { leaseOf, leaseText, LEASE_LAPSES } from '../../lib/goals'
import { useHive } from '../../store/store'
import { has } from '../../lib/useResource'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, ErrorState, Orb, ProgressRing, Skeleton } from '../../ui/primitives'
import { shown } from '../../lib/displayName'
import { GoalDecision } from '../../experiences/GoalDecision'
import { cardActions, cardAsk, KEEP_THE_GOAL, type CardAsk } from './cardActions'
import { ReviewDialog, ReviewHistory } from './Review'
import { TaskAttempts } from '../tasks/Attempts'
import { TaskCodeAccess } from '../tasks/CodeAccess'
import { mayReview, principalWords, reviewedLine, reviewerWords } from '../../lib/goalReview'
import { useMe } from '../../lib/useAdmin'
import { changeLinks, linkable, LINK_MEANS } from '../../lib/motivations'
import { TaskChips, TaskLinks } from '../tasks/TaskLinks'

type Col = 'open' | 'claimed' | 'review' | 'done' | 'failed'
const COLS: { key: Col; label: string; short?: string; color: string; icon: IconName }[] = [
  { key: 'open', label: 'Open', color: '#a5b4fc', icon: 'target' },
  { key: 'claimed', label: 'Claimed', color: '#7dd3fc', icon: 'bolt' },
  // R17: done means reviewed, so submitted work waits here, not among the claimed (same words as Boards)
  { key: 'review', label: 'Awaiting review', short: 'Review', color: '#a78bfa', icon: 'check' },
  { key: 'done', label: 'Done', color: 'var(--color-good)', icon: 'check' },
  { key: 'failed', label: 'Failed', color: 'var(--color-bad)', icon: 'x' },
]
/** Stalled tasks are unclaimed and need a person, so they lead the Open column; waiting tasks are still held; submitted work awaits review. */
const colOf = (s: GoalStatus): Col => (s === 'cancelled' ? 'failed' : s === 'stalled' ? 'open' : s === 'waiting' ? 'claimed' : s === 'submitted' ? 'review' : s)
/** Calm amber: delivered, the ball is in the operator's court. */
const WAITING = '#f5c06b'
const STALLED = '#fb7185'

const PRIORITIES = [
  { label: 'Low', value: 0.3 },
  { label: 'Normal', value: 0.55 },
  { label: 'High', value: 0.85 },
]
const priorityColor = (p: number) => (p >= 0.75 ? '#fb7185' : p >= 0.5 ? '#fbbf24' : '#7aa2d6')
const priorityLabel = (p: number) => (p >= 0.75 ? 'High' : p >= 0.5 ? 'Normal' : 'Low')

const EMPTY: Goal[] = []
/** Last `updated_at` each card showed, so a card that moved columns can flash on arrival. */
const seenAt = new Map<string, string>()

/** Which tasks a board shows beyond its team: the Tasks page's filters (mind, motivation, search). */
export type TaskFilter = (g: Goal) => boolean

/**
 * The task board (Motivations above Tasks: today's goals, shown as tasks). One team (`swarmId`, as on a swarm's page)
 * or every team the person sees; `only` narrows it (the Tasks page's mind, motivation and search filters); `layout`
 * shows status columns or one list. Every status change still goes through the shared GoalDecision (Review D1).
 */
export function GoalsBoard({
  swarmId,
  className,
  focus,
  only,
  layout = 'board',
  addUnder,
}: {
  /** One team; absent = every team this person sees. */
  swarmId?: string
  className?: string
  /** A task to open and bring into view (navigation only). */
  focus?: string
  only?: TaskFilter
  layout?: 'board' | 'list'
  /** The motivation the Tasks page is filtered to: offered (removable) for new tasks. */
  addUnder?: Motivation | null
}) {
  const allGoals = useHive((s) => s.goals)
  const loaded = useHive((s) => (swarmId ? !!s.goalsLoaded[swarmId] : Object.keys(s.swarms).every((id) => s.goalsLoaded[id])))
  const load = useHive((s) => s.loadGoals)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const swarmKey = swarmId ?? Object.keys(swarms).sort().join(',')
  const desktop = useIsDesktop()
  const [err, setErr] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<Col>('open')
  // Review D1 (Platform ruling): every status change on a card (Done, Failed, Cancel, Re-open) is decided in the shared
  // GoalDecision, on the goal as the card showed it and the session it was shown under. The dialog lives here, not on
  // the card, so it stays open (and says what changed) when the goal moves columns under it.
  const [asking, setAsking] = useState<CardAsk | null>(null)
  const decisionCurrent = useVisibleAuthority('page', true, 'tasks-board')
  const closeAsk = useCallback(() => setAsking(null), [])
  // focus goes back to the button that asked; if the card moved columns since (the old card may still be leaving),
  // to that goal's card in the column it is in now
  const askHome = useCallback(
    (opener: HTMLElement | null) => {
      const id = asking?.seen.id
      const live = id ? useHive.getState().goals[id] : undefined
      const col = live ? scroller.current?.querySelector<HTMLElement>(layout === 'list' ? '[data-col="list"]' : `[data-col="${colOf(live.status)}"]`) : null
      if (opener?.isConnected && (!col || col.contains(opener))) return opener
      return id ? col?.querySelector<HTMLElement>(`[data-goal="${CSS.escape(id)}"] button[aria-expanded]`) : null
    },
    [asking, layout],
  )

  const loadAll = useCallback(
    (force = false) => Promise.all(swarmKey.split(',').filter(Boolean).map((id) => load(id, force))),
    [swarmKey, load],
  )
  useEffect(() => {
    loadAll().then(() => setErr(null), (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load tasks'))
  }, [loadAll])

  const { byCol, children, list } = useMemo(() => {
    const goals = Object.values(allGoals).filter((g) => (!swarmId || g.swarm_id === swarmId) && (!only || only(g)))
    const children = new Map<string, Goal[]>()
    const top: Goal[] = []
    const ids = new Set(goals.map((g) => g.id))
    for (const g of goals) {
      if (g.parent_id && ids.has(g.parent_id)) {
        if (!children.has(g.parent_id)) children.set(g.parent_id, [])
        children.get(g.parent_id)!.push(g)
      } else top.push(g)
    }
    for (const list of children.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at))
    const byCol: Record<Col, Goal[]> = { open: [], claimed: [], review: [], done: [], failed: [] }
    for (const g of top) byCol[colOf(g.status)].push(g)
    const needsYou = (g: Goal) => (g.status === 'stalled' || g.status === 'waiting' || g.status === 'submitted' ? 1 : 0)
    byCol.open.sort((a, b) => needsYou(b) - needsYou(a) || b.priority - a.priority || b.created_at.localeCompare(a.created_at))
    byCol.claimed.sort((a, b) => needsYou(b) - needsYou(a) || b.priority - a.priority || b.updated_at.localeCompare(a.updated_at))
    byCol.review.sort((a, b) => (a.submitted_at ?? a.updated_at).localeCompare(b.submitted_at ?? b.updated_at))
    byCol.done.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    byCol.failed.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    // the list: what needs a person first, then live work by priority, then what is finished, newest first
    const closed = (g: Goal) => (g.status === 'done' || g.status === 'failed' || g.status === 'cancelled' ? 1 : 0)
    const list = [...top].sort((a, b) => closed(a) - closed(b) || needsYou(b) - needsYou(a) || (closed(a) ? b.updated_at.localeCompare(a.updated_at) : b.priority - a.priority || b.updated_at.localeCompare(a.updated_at)))
    return { byCol, children, list }
  }, [allGoals, swarmId, only])

  // mobile: which column is in view, for the pager pills
  useEffect(() => {
    const el = scroller.current
    if (!el || desktop || layout === 'list') return
    const onScroll = () => {
      const i = Math.round(el.scrollLeft / (el.scrollWidth / COLS.length))
      setVisible(COLS[Math.max(0, Math.min(COLS.length - 1, i))].key)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [desktop, layout])

  // phones: open on the first column that has something in it (or the focused goal's column)
  const focused = focus ? allGoals[focus] : undefined
  const inScope = (g: Goal | undefined) => !!g && (!swarmId || g.swarm_id === swarmId)
  const focusTop = inScope(focused) ? (focused!.parent_id && inScope(allGoals[focused!.parent_id]) ? allGoals[focused!.parent_id] : focused) : undefined
  const firstFull = focusTop ? colOf(focusTop.status) : (COLS.find((c) => byCol[c.key].length > 0)?.key ?? 'open')
  // which landing this board has done: the first one, then again for each new focus target (Review P-B1: a mounted
  // board must follow `?goal=` A -> B within the same swarm, not only on first entry)
  const landed = useRef<string | null>(null)
  const landKey = focusTop?.id ?? ''
  useEffect(() => {
    if (landed.current === landKey || desktop || !loaded || layout === 'list') return
    landed.current = landKey
    if (firstFull === 'open') return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-col="${firstFull}"]`)
    if (el && scroller.current) scroller.current.scrollLeft = el.offsetLeft - 12
  }, [desktop, loaded, firstFull, landKey, layout])
  // a focused goal (from a request's "Open receiving goal"): bring its card into view once it is on the board
  const brought = useRef<string | null>(null)
  useEffect(() => {
    if (!focusTop || brought.current === focusTop.id || !loaded) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-goal="${CSS.escape(focusTop.id)}"]`)
    if (!el) return
    brought.current = focusTop.id
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })

  if (err && !loaded) return <ErrorState title="Could not load tasks" body={err} onRetry={() => loadAll(true).then(() => setErr(null), () => undefined)} />

  const jump = (c: Col) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-col="${c}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }
  const hueOf = (g: Goal) => swarms[g.swarm_id]?.hue ?? 252
  const card = (g: Goal) => (
    <GoalCard key={g.id} goal={g} subgoals={children.get(g.id) ?? EMPTY} agents={agents} swarmHue={hueOf(g)} team={swarmId ? undefined : swarms[g.swarm_id]} focused={focusTop?.id === g.id} onDecide={setAsking} />
  )

  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <QuickAdd swarmId={swarmId} addUnder={addUnder ?? null} />
      {focus && loaded && !focusTop && <p role="status" className="mb-2 text-small text-ink-3">That task is not here: it is not visible to you, or it belongs to another swarm.</p>}
      {layout === 'list' ? (
        <LayoutGroup id={`tasks-list-${swarmKey}`}>
          <section ref={scroller} data-col="list" aria-label="Tasks" className="min-h-0 flex-1 space-y-2">
            {!loaded && list.length === 0 ? (
              <>
                <Skeleton className="h-16 w-full rounded-2xl" />
                <Skeleton className="h-16 w-full rounded-2xl" />
              </>
            ) : list.length === 0 ? (
              <div className="flex h-20 items-center justify-center rounded-2xl border border-dashed border-line text-[12px] text-ink-4">No tasks here</div>
            ) : (
              <AnimatePresence initial={false} mode="popLayout">
                {list.map(card)}
              </AnimatePresence>
            )}
          </section>
        </LayoutGroup>
      ) : (
        <>
          {!desktop && (
            <div className="mb-2 flex gap-1.5" role="tablist" aria-label="Task columns">
              {COLS.map((c) => (
                <button
                  key={c.key}
                  role="tab"
                  aria-selected={visible === c.key}
                  onClick={() => jump(c.key)}
                  className={cx('flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1 text-[12px] font-medium transition-colors', visible === c.key ? 'border-line-2 bg-tint/[0.08] text-ink' : 'border-transparent text-ink-3')}
                >
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: c.color }} />
                  <span className="truncate" aria-label={c.label}>{c.short ?? c.label}</span>
                  <span className="text-ink-4 tabular-nums">{byCol[c.key].length}</span>
                </button>
              ))}
            </div>
          )}
          <LayoutGroup id={`goals-${swarmKey}`}>
            <div
              ref={scroller}
              className={cx(
                'min-h-0 flex-1',
                desktop ? 'grid grid-cols-5 gap-3' : 'no-scrollbar -mx-3 flex snap-x snap-mandatory items-start gap-2.5 overflow-x-auto scroll-px-3 px-3 pb-2',
              )}
            >
              {COLS.map((c) => (
                <section
                  key={c.key}
                  data-col={c.key}
                  data-tour={`goals-col-${c.key}`}
                  aria-label={`${c.label} tasks`}
                  className={cx('flex min-h-0 flex-col rounded-[20px] border border-line bg-tint/[0.02]', !desktop && 'w-[86%] shrink-0 snap-start')}
                >
                  <header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
                    <span className="size-2 rounded-full" style={{ background: c.color, boxShadow: `0 0 10px ${c.color}` }} />
                    <h3 className="font-display text-[13px] font-semibold tracking-wide">{c.label}</h3>
                    <span className="font-mono text-[12px] text-ink-4">{byCol[c.key].length}</span>
                    <ColumnFlag goals={byCol[c.key]} col={c.key} />
                  </header>
                  <div className={cx('min-h-[120px] space-y-2 px-2 pb-2', desktop && 'thin-scroll flex-1 overflow-y-auto')}>
                    {!loaded && byCol[c.key].length === 0 ? (
                      <>
                        <Skeleton className="h-20 w-full rounded-2xl" />
                        <Skeleton className="h-16 w-full rounded-2xl" />
                      </>
                    ) : byCol[c.key].length === 0 ? (
                      <div className="flex h-20 items-center justify-center rounded-2xl border border-dashed border-line text-[12px] text-ink-4">
                        {c.key === 'open' ? 'Nothing open' : c.key === 'claimed' ? 'Nobody is on it' : c.key === 'review' ? 'Nothing to review' : c.key === 'done' ? 'Nothing finished yet' : 'No failures'}
                      </div>
                    ) : (
                      <AnimatePresence initial={false} mode="popLayout">
                        {byCol[c.key].map(card)}
                      </AnimatePresence>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </LayoutGroup>
        </>
      )}
      <AnimatePresence>
        {asking && <GoalDecision current={decisionCurrent} key={`${asking.seen.id}:${asking.to}`} seen={asking.seen} to={asking.to} session={asking.session} onClose={closeAsk} dismissLabel={KEEP_THE_GOAL} restoreFocus={askHome} />}
      </AnimatePresence>
    </div>
  )
}

function ColumnFlag({ goals, col }: { goals: Goal[]; col: Col }) {
  const status = col === 'open' ? 'stalled' : col === 'claimed' ? 'waiting' : null
  const n = status ? goals.filter((g) => g.status === status).length : 0
  if (!n) return null
  const color = status === 'stalled' ? STALLED : WAITING
  return (
    <span className="ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-semibold" style={{ color, background: `${color}18` }}>
      <Icon name={status === 'stalled' ? 'alert' : 'clock'} size={10} strokeWidth={2.4} />
      {n} {status}
    </span>
  )
}

/**
 * Add a task: for one team, or (every team shown) for the team chosen here. On a page filtered to a motivation the
 * person may link to, the new task is offered under it as a removable chip: one explicit link after the task is made
 * (association only; the hive never infers one).
 */
function QuickAdd({ swarmId, addUnder }: { swarmId?: string; addUnder: Motivation | null }) {
  const create = useHive((s) => s.createGoal)
  const swarms = useHive((s) => s.swarms)
  const toast = useHive((s) => s.toast)
  const open = useMemo(() => Object.values(swarms).filter((s) => !s.archived_at).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
  const [picked, setPicked] = useState<string | null>(null)
  const team = swarmId ?? (picked && swarms[picked] ? picked : (addUnder?.swarm_id ?? open[0]?.id ?? null))
  const swarm = team ? swarms[team] : undefined
  const hue = swarm?.hue ?? 252
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState(0.55)
  const [busy, setBusy] = useState(false)
  const under = addUnder && addUnder.editable && linkable(addUnder) && (!addUnder.swarm_id || addUnder.swarm_id === team) ? addUnder : null
  const [skipUnder, setSkipUnder] = useState<string | null>(null)
  const linkTo = under && skipUnder !== under.id ? under : null
  if (!team) return null
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    const g = await create(team, { title: title.trim(), priority })
    if (g && linkTo) {
      const r = await changeLinks(linkTo, 'link', [g.id], false)
      if (!r.ok) toast({ tone: 'error', title: 'The task was made, but not filed under the motivation', body: r.why })
    }
    setBusy(false)
    if (g) setTitle('')
  }
  return (
    <form onSubmit={submit} data-tour="goals-add" className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[18px] border border-line bg-shade/20 p-1.5 focus-within:border-line-2 md:flex-nowrap">
      <div className="flex min-w-0 basis-full items-center gap-2 md:basis-auto md:flex-1">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: hsl(hue, 80, 55, 0.15), color: hsl(hue, 100, 80) }}>
          <Icon name="plus" size={18} />
        </span>
        <label htmlFor={`task-${swarmId ?? 'any'}`} className="sr-only">
          New task title
        </label>
        <input
          id={`task-${swarmId ?? 'any'}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Add a task for ${shown(swarm?.name) || 'this swarm'}…`}
          className="min-h-10 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
          enterKeyHint="send"
        />
      </div>
      {!swarmId && open.length > 1 && (
        <label className="flex min-h-9 items-center gap-1 text-[12px] text-ink-3">
          <span className="sr-only">Swarm</span>
          <select value={team} onChange={(e) => setPicked(e.target.value)} className="min-h-9 max-w-[10rem] rounded-lg border border-line bg-shade/30 px-2 text-[12px] text-ink-2">
            {open.map((s) => (
              <option key={s.id} value={s.id}>
                {shown(s.name)}
              </option>
            ))}
          </select>
        </label>
      )}
      {linkTo && (
        <span className="inline-flex min-h-9 max-w-[16rem] items-center gap-1 rounded-full border border-accent/30 bg-accent/10 pr-1 pl-2.5 text-[12px] text-accent" data-add-under title={LINK_MEANS}>
          <span className="truncate">under “{linkTo.title}”</span>
          <button type="button" onClick={() => setSkipUnder(linkTo.id)} aria-label={`Do not file the new task under ${linkTo.title}`} className="flex size-6 items-center justify-center rounded-full hover:bg-tint/10">
            <Icon name="x" size={11} />
          </button>
        </span>
      )}
      <div role="radiogroup" aria-label="Priority" className="flex flex-1 gap-1 md:flex-none">
        {PRIORITIES.map((p) => {
          const on = priority === p.value
          return (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPriority(p.value)}
              className="flex min-h-9 items-center gap-1 rounded-lg border px-2 text-[12px] font-medium transition-colors"
              style={{ borderColor: on ? `${priorityColor(p.value)}66` : 'transparent', background: on ? `${priorityColor(p.value)}18` : undefined, color: on ? priorityColor(p.value) : 'var(--color-ink-3)' }}
            >
              <PriorityBars p={p.value} />
              {p.label}
            </button>
          )
        })}
      </div>
      <Button type="submit" variant={title.trim() ? 'primary' : 'subtle'} hue={hue} disabled={!title.trim() || busy} className="min-h-10 px-3.5">
        {busy ? 'Adding…' : 'Add'}
      </Button>
    </form>
  )
}

function PriorityBars({ p }: { p: number }) {
  const n = p >= 0.75 ? 3 : p >= 0.5 ? 2 : 1
  return (
    <span className="flex items-end gap-[2px]" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-[3px] rounded-[1px]" style={{ height: 4 + i * 2.5, background: 'currentColor', opacity: i < n ? 1 : 0.25 }} />
      ))}
    </span>
  )
}

function Claimant({ agent, size = 18 }: { agent: Agent | undefined; size?: number }) {
  const thinking = useHive((s) => (agent ? s.thinking[agent.id] : undefined))
  if (!agent) return <span className="inline-block shrink-0 rounded-full border border-dashed border-line-2" style={{ width: size, height: size }} aria-hidden="true" />
  return <Orb hue={agent.hue} status={agent.status} thinking={thinking} size={size} />
}

const by = (createdBy: string, agents: Record<string, Agent>) =>
  createdBy.startsWith('agent:') ? (agents[createdBy.slice(6)]?.name ?? 'a mind') : createdBy.replace(/^user:/, '')

function GoalCard({ goal: g, subgoals, agents, swarmHue, team, focused = false, onDecide }: { goal: Goal; subgoals: Goal[]; agents: Record<string, Agent>; swarmHue: number; /** Shown when the board spans teams. */ team?: Swarm; focused?: boolean; onDecide: (ask: CardAsk) => void }) {
  const patch = useHive((s) => s.patchGoal)
  // Surface R / D1: the session this card's goal was read under; its decisions and priority changes go only in that session
  const session = useHive((s) => s.session)
  const create = useHive((s) => s.createGoal)
  const client = useHive((s) => s.client)
  const submitted = g.status === 'submitted'
  const { me } = useMe()
  const may = mayReview(g, me)
  const [reviewing, setReviewing] = useState<{ seen: Goal; decision: 'accept' | 'return' } | null>(null)
  const reviewer = reviewerWords(g.review_by, (id) => (agents[id] ? shown(agents[id].name) : undefined))
  const reviewed = reviewedLine(g, (p) => principalWords(p, agents))
  const reduced = useReducedMotion()
  const now = useNow(30_000)
  const [open, setOpen] = useState(focused)
  // becoming the focus target (a new `?goal=` on a mounted board) opens the card; losing focus leaves the person's
  // own open/closed choice alone
  const [wasFocused, setWasFocused] = useState(focused)
  if (focused !== wasFocused) {
    setWasFocused(focused)
    if (focused) setOpen(true)
  }
  const [sub, setSub] = useState('')
  const claimant = g.claimed_by ? agents[g.claimed_by] : undefined
  const done = subgoals.filter((s) => s.status === 'done').length
  const col = colOf(g.status)
  // glow when the goal changed since this board last showed it (survives the column hop remount)
  const [baseline] = useState(() => seenAt.get(g.id) ?? g.updated_at)
  useEffect(() => {
    seenAt.set(g.id, g.updated_at)
  })
  const fresh = g.updated_at !== baseline
  const stalled = g.status === 'stalled'
  const waiting = g.status === 'waiting'
  const leaseMinutes = useHive((s) => s.hive?.limits?.goal_lease_minutes)
  const lease = leaseOf(g, now, leaseMinutes || 60)
  const accent = stalled ? STALLED : waiting ? WAITING : col === 'failed' ? '#fb7185' : priorityColor(g.priority)

  return (
    <m.article
      layout={!reduced}
      layoutId={reduced ? undefined : g.id}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      data-tour={`goal-${g.status}`}
      data-goal={g.id}
      aria-current={focused ? 'true' : undefined}
      className={cx('relative overflow-hidden rounded-2xl border bg-[#12122e]/80', col === 'done' && 'opacity-85', open ? 'border-line-2' : 'border-line', focused && 'ring-2 ring-accent/70')}
      style={stalled ? { borderColor: `${STALLED}66`, boxShadow: `0 0 22px -8px ${STALLED}` } : waiting ? { borderColor: `${WAITING}4d` } : undefined}
    >
      {submitted && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-accent/30 bg-accent/10 px-3.5 py-1.5 text-[11.5px] font-semibold text-accent" data-review-banner>
          <Icon name="check" size={12} strokeWidth={2.4} />
          <span className="min-w-0 flex-1">
            Waiting for review by {reviewer}
            {g.returns ? ` · returned ${g.returns}×` : ''}
          </span>
          {may.may !== null && <span className={cx('shrink-0 font-normal', may.may ? 'text-good' : 'text-ink-3')} title={may.why}>{may.may ? 'you may review' : 'not you'}</span>}
        </div>
      )}
      {(stalled || waiting) && (
        <div className="flex items-center gap-2 border-b px-3.5 py-1.5 text-[11.5px] font-semibold" style={{ color: stalled ? STALLED : WAITING, background: `${stalled ? STALLED : WAITING}12`, borderColor: `${stalled ? STALLED : WAITING}2e` }}>
          <Icon name={stalled ? 'alert' : 'clock'} size={12} strokeWidth={2.4} />
          <span className="min-w-0 flex-1 truncate">{stalled ? `Stalled · ${g.attempts ?? LEASE_LAPSES} claims lapsed` : 'Waiting on you'}</span>
          {stalled && (
            <button onClick={() => onDecide(cardAsk(g, 'open', session))} className="-my-1 -mr-1.5 inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-ink hover:bg-tint/[0.07]" aria-label={`Re-open ${g.title}`}>
              <Icon name="reset" size={12} strokeWidth={2.2} />
              Re-open
            </button>
          )}
        </div>
      )}
      {fresh && !reduced && (
        <m.span
          key={g.updated_at}
          className="pointer-events-none absolute inset-0 rounded-2xl"
          initial={{ boxShadow: `inset 0 0 0 1px ${hsl(swarmHue, 100, 75, 0.8)}, 0 0 24px ${hsl(swarmHue, 100, 65, 0.5)}` }}
          animate={{ boxShadow: `inset 0 0 0 1px ${hsl(swarmHue, 100, 75, 0)}, 0 0 0px ${hsl(swarmHue, 100, 65, 0)}` }}
          transition={{ duration: 1.8, ease: 'easeOut' }}
        />
      )}
      <span className="absolute bottom-2 left-0 w-[3px] rounded-r" style={{ top: stalled || waiting ? 40 : 8, background: accent, opacity: col === 'done' ? 0.4 : 0.9 }} aria-hidden="true" />
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="block w-full py-2.5 pr-3 pl-3.5 text-left">
        <div className="flex items-start gap-2">
          <h4 className={cx('min-w-0 flex-1 text-[14px] leading-snug font-medium', col === 'done' && 'text-ink-2', g.status === 'cancelled' && 'text-ink-3 line-through decoration-ink-4')}>{g.title}</h4>
          {subgoals.length > 0 && <ProgressRing value={done} total={subgoals.length} size={30} hue={col === 'failed' ? 356 : 142} label={`${done} of ${plural(subgoals.length, 'subtask')} done`} />}
        </div>
        {team && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-ink-3" data-task-team>
            <span className="size-1.5 rounded-full" style={{ background: hsl(team.hue, 95, 68) }} aria-hidden="true" />
            {shown(team.name)}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1 font-medium" style={{ color: priorityColor(g.priority) }} title={`Priority ${g.priority.toFixed(2)}`}>
            <PriorityBars p={g.priority} />
            {priorityLabel(g.priority)}
          </span>
          <span className="text-ink-4">·</span>
          {claimant ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Claimant agent={claimant} size={16} />
              <span className="truncate text-ink-2">{shown(claimant.name)}</span>
            </span>
          ) : g.status === 'cancelled' ? (
            <span>cancelled</span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
              <Claimant agent={undefined} size={14} />
              <span className="truncate">unclaimed</span>
            </span>
          )}
          <span className="ml-auto shrink-0 text-ink-4">{ago(g.updated_at, now)}</span>
        </div>
        {(lease || (g.attempts ?? 0) > 0) && !stalled && col !== 'done' && col !== 'failed' && <LeaseRow lease={lease} attempts={g.attempts ?? 0} />}
        {reviewed && col === 'done' && (
          <p className="mt-1 text-[11px] text-ink-3" data-reviewed-by>
            {reviewed}
            {g.reviewed_at ? ` · ${ago(g.reviewed_at, now)}` : ''}
          </p>
        )}
        {g.result && !open && <p className={cx('mt-1.5 line-clamp-1 text-[12px]', col === 'failed' ? 'text-bad/80' : waiting ? 'text-ink-2' : 'text-ink-3')}>{g.result}</p>}
      </button>

      <TaskChips goal={g} />
      {subgoals.length > 0 && (
        <ul className="mx-2 mb-2 space-y-px rounded-xl bg-shade/25 p-1" aria-label="Subtasks">
          <AnimatePresence initial={false}>
            {subgoals.map((s) => (
              <SubRow key={s.id} goal={s} agent={s.claimed_by ? agents[s.claimed_by] : undefined} />
            ))}
          </AnimatePresence>
        </ul>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="space-y-2.5 border-t border-line px-3.5 pt-2.5 pb-3">
              {g.detail && <p className="text-[13px] leading-relaxed text-ink-2">{g.detail}</p>}
              {g.result && (
                <p className={cx('rounded-lg border px-2.5 py-1.5 text-[12px]', col === 'failed' ? 'border-bad/25 bg-bad/[0.06] text-bad' : 'border-good/20 bg-good/[0.05] text-ink-2')}>
                  <span className="text-ink-4">Result · </span>
                  {g.result}
                </p>
              )}
              <div className="flex flex-wrap gap-x-3 text-[11px] text-ink-4">
                <span>by {by(g.created_by, agents)}</span>
                <span>created {ago(g.created_at, now)}</span>
                <span className="break-all font-mono text-ink-3" aria-label="Task ID">Task {g.id}</span>
                {claimant && (
                  <button onClick={() => navigate({ name: 'dot', id: claimant.id, tab: 'mind' })} className="inline-flex items-center gap-0.5 text-accent hover:text-ink">
                    watch {shown(claimant.name)} think <Icon name="chevron" size={11} />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {submitted && has(client, 'reviewGoal') && may.may !== false && (
                  <>
                    <MiniAction icon="check" label="Accept · done…" color="#4ade80" onClick={() => setReviewing({ seen: { ...g }, decision: 'accept' })} />
                    <MiniAction icon="reset" label="Return with notes…" color="#fbbf24" onClick={() => setReviewing({ seen: { ...g }, decision: 'return' })} />
                  </>
                )}
                {submitted && may.may === false && <span className="text-[11.5px] text-ink-3">{may.why}</span>}
                {cardActions(g).map((a) => (
                  <MiniAction key={a.label} icon={a.icon} label={`${a.label}…`} color={a.color} onClick={() => onDecide(cardAsk(g, a.to, session))} />
                ))}
                <span className="ml-auto flex gap-1" role="radiogroup" aria-label="Priority">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p.label}
                      role="radio"
                      aria-checked={Math.abs(g.priority - p.value) < 0.13}
                      aria-label={`${p.label} priority`}
                      onClick={() => void patch(g.id, { priority: p.value }, session)}
                      className="flex size-8 items-center justify-center rounded-lg border transition-colors"
                      style={{ color: priorityColor(p.value), borderColor: Math.abs(g.priority - p.value) < 0.13 ? `${priorityColor(p.value)}66` : 'transparent' }}
                    >
                      <PriorityBars p={p.value} />
                    </button>
                  ))}
                </span>
              </div>
              <TaskLinks goal={g} subtasks={subgoals.length} />
              {(submitted || g.reviewed_by || g.returns || g.review_notes) && <ReviewHistory goal={g} />}
              <TaskAttempts task={g} />
              <TaskCodeAccess task={g} />
              {g.status !== 'done' && g.status !== 'cancelled' && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!sub.trim()) return
                    const ok = await create(g.swarm_id, { title: sub.trim(), parent_id: g.id, priority: Math.max(0.1, g.priority - 0.1) })
                    if (ok) setSub('')
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    value={sub}
                    onChange={(e) => setSub(e.target.value)}
                    placeholder="Add a subtask…"
                    aria-label="New subtask"
                    className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-shade/25 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
                  />
                  <button type="submit" disabled={!sub.trim()} aria-label="Add subtask" className="flex size-9 items-center justify-center rounded-lg border border-line text-ink-2 disabled:opacity-40">
                    <Icon name="plus" size={16} />
                  </button>
                </form>
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{reviewing && <ReviewDialog seen={reviewing.seen} decision={reviewing.decision} onClose={() => setReviewing(null)} />}</AnimatePresence>
    </m.article>
  )
}

/** The claim is a lease: a draining bar with the time left, amber near the end, red once lapsed. */
function LeaseRow({ lease, attempts }: { lease: ReturnType<typeof leaseOf>; attempts: number }) {
  const left = lease?.kind === 'running' ? lease.ms : 0
  const frac = lease?.kind === 'running' ? Math.max(0.02, Math.min(1, lease.ms / lease.total)) : 0
  const color = lease?.kind === 'lapsed' ? STALLED : lease?.kind === 'paused' ? WAITING : left < 10 * 60_000 ? '#fbbf24' : '#7dd3fc'
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[10.5px]" data-tour={lease?.kind === 'running' ? 'goal-lease' : undefined}>
      {lease && (
        <>
          <Icon name="clock" size={11} style={{ color }} />
          <span className="font-mono tabular-nums" style={{ color }}>
            {lease.kind === 'running' ? `lease ${leaseText(left)}` : lease.kind === 'lapsed' ? 'lease lapsed' : 'lease paused'}
          </span>
          {lease.kind === 'running' && (
            <span className="h-[3px] w-14 overflow-hidden rounded-full bg-tint/[0.08]" aria-hidden="true">
              <m.span className="block h-full rounded-full" initial={false} animate={{ width: `${frac * 100}%` }} style={{ background: color }} />
            </span>
          )}
        </>
      )}
      {attempts > 0 && (
        <span className="ml-auto rounded px-1 font-semibold" style={{ color: attempts >= LEASE_LAPSES - 1 ? '#fbbf24' : 'var(--color-ink-3)', background: 'color-mix(in oklab, var(--color-ink) 5%, transparent)' }} title={`${attempts} earlier claim${attempts === 1 ? '' : 's'} lapsed; ${LEASE_LAPSES} stall the task`}>
          {attempts}/{LEASE_LAPSES} lapsed
        </span>
      )}
    </div>
  )
}

function MiniAction({ icon, label, color, onClick }: { icon: IconName; label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex min-h-8 items-center gap-1 rounded-lg border px-2 text-[12px] font-medium transition-colors hover:brightness-125" style={{ color, borderColor: `${color}40`, background: `${color}10` }}>
      <Icon name={icon} size={12} strokeWidth={2.4} />
      {label}
    </button>
  )
}

const SUB_ICON: Record<GoalStatus, { icon: IconName; color: string }> = {
  open: { icon: 'target', color: 'var(--color-ink-3)' },
  claimed: { icon: 'bolt', color: '#7dd3fc' },
  waiting: { icon: 'clock', color: WAITING },
  stalled: { icon: 'alert', color: STALLED },
  submitted: { icon: 'check', color: '#a78bfa' },
  done: { icon: 'check', color: 'var(--color-good)' },
  failed: { icon: 'x', color: 'var(--color-bad)' },
  cancelled: { icon: 'ban', color: 'var(--color-ink-5)' },
}

function SubRow({ goal: s, agent }: { goal: Goal; agent: Agent | undefined }) {
  const st = SUB_ICON[s.status]
  return (
    <m.li layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex min-h-8 items-center gap-2 rounded-lg px-1.5 text-[12px]">
      <m.span key={s.status} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 20 }} className="flex size-4 shrink-0 items-center justify-center rounded-full" style={{ color: st.color, background: `${st.color}1c` }}>
        <Icon name={st.icon} size={10} strokeWidth={2.6} />
      </m.span>
      <span className={cx('min-w-0 flex-1 truncate', s.status === 'done' ? 'text-ink-3 line-through decoration-ink-4/60' : 'text-ink-2')}>{s.title}</span>
      {agent && <Claimant agent={agent} size={14} />}
    </m.li>
  )
}
