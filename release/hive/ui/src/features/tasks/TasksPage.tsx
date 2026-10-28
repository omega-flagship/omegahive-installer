import { m } from 'framer-motion'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Goal } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { isActive } from '../../lib/goals'
import { pluralAtLeast } from '../../lib/plural'
import { atLeast, isUnsorted, PARTIAL_WORDS, radioProps, sortMotivations, useCountsPartial, useMotivationData, WORDS } from '../../lib/motivations'
import { navigate, type Route, type TaskView } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { EmptyState } from '../../ui/primitives'
import { GoalsBoard } from '../goals/GoalsBoard'
import { FindHelp } from './FindHelp'
import { TASKS_BOARD, TASKS_PAGE_BODY } from './layout'

/** The two ways to show tasks (a board is only a view of tasks). */
const VIEWS: readonly TaskView[] = ['board', 'list']

type TasksRoute = Extract<Route, { name: 'tasks' }>

/**
 * #/tasks: the concrete work (today's goals, unchanged underneath), in one place. It replaces both Goals (one team at a
 * time) and Boards (admin-only, across minds and teams): a board or a list, for every team or one, one mind, one
 * motivation or the Unsorted (under no motivation this person can read), and a search. Each task counts once, however
 * many motivations it serves.
 */
export default function TasksPage(route: Omit<TasksRoute, 'name'>) {
  const { swarm, mind, motivation, task } = route
  const view: TaskView = route.view ?? 'board'
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const goals = useHive((s) => s.goals)
  const links = useHive((s) => s.taskLinks)
  const motivations = useHive((s) => s.motivations)
  const linksLoaded = useHive((s) => s.taskLinksLoaded)
  const { supported } = useMotivationData()
  // a read that did not finish makes every count by motivation a floor (stand-in P2-4 on 57e64ca)
  const partial = useCountsPartial() && supported
  const [q, setQ] = useState('')
  // an old #/goals or #/boards link: show the address it now lives at (same filter), without a new history entry
  useEffect(() => {
    if (/^#\/(goals|boards)\b/.test(window.location.hash)) navigate({ name: 'tasks', ...route }, { replace: true })
  }, [route])
  const go = useCallback((change: Partial<TasksRoute>) => navigate({ name: 'tasks', swarm, mind, motivation, view: route.view, ...change, task: undefined }, { replace: true }), [swarm, mind, motivation, route.view])

  const teams = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
  const team = swarm && swarms[swarm] ? swarm : undefined
  const chosen = motivation && motivation !== 'none' ? motivations[motivation] : undefined
  const missing = !!motivation && motivation !== 'none' && supported && linksLoaded && !chosen

  // the filter every view shares: mind (assignee, holder or creator, as the hive's mind filter), motivation, search
  const only = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (g: Goal) =>
      (!mind || g.assignee === mind || g.claimed_by === mind || g.created_by === `agent:${mind}`) &&
      (!motivation || (motivation === 'none' ? isUnsorted(links, g.id) : (links[g.id] ?? []).some((l) => l.id === motivation))) &&
      (!needle || `${g.title}\n${g.detail}`.toLowerCase().includes(needle))
  }, [mind, motivation, q, links])

  // counts for the filter chips: live tasks in the chosen team, each counted once
  const inTeam = useMemo(() => Object.values(goals).filter((g) => !team || g.swarm_id === team), [goals, team])
  const live = useMemo(() => inTeam.filter(isActive), [inTeam])
  const perTeam = useMemo(() => {
    const out: Record<string, number> = {}
    for (const g of Object.values(goals)) if (isActive(g)) out[g.swarm_id] = (out[g.swarm_id] ?? 0) + 1
    return out
  }, [goals])
  const perMotivation = useMemo(() => {
    const out: Record<string, number> = {}
    let unsorted = 0
    for (const g of live) {
      const refs = links[g.id] ?? []
      if (isUnsorted(links, g.id)) unsorted++
      for (const r of new Set(refs.map((x) => x.id))) out[r] = (out[r] ?? 0) + 1
    }
    return { out, unsorted }
  }, [live, links])
  const shownMotivations = useMemo(() => sortMotivations(Object.values(motivations).filter((x) => (x.status !== 'retired' && x.status !== 'achieved') || x.id === motivation)), [motivations, motivation])
  const shownCount = useMemo(() => inTeam.filter(only).length, [inTeam, only])

  const chip = (on: boolean) => cx('relative flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[13.5px] transition-colors', on ? 'border-line-2 text-ink' : 'border-line text-ink-3 hover:text-ink-2')

  return (
    <Page label={WORDS.tasks} eyebrow="The work" title={WORDS.tasks} info="goals">
      <div className={cx(TASKS_PAGE_BODY, 'px-3 pb-[calc(var(--sab)+92px)] md:px-6 md:pb-6')}>
        {teams.length === 0 ? (
          <EmptyState icon="columns" title="No swarms yet" body="Tasks belong to a swarm. Start one first." />
        ) : (
          <>
            {/* teams: all, or one (the old Goals tabs) */}
            <div className="no-scrollbar -mx-3 mb-2 flex gap-2 overflow-x-auto px-3 md:mx-0 md:px-0" role="tablist" aria-label="Swarm">
              <button role="tab" aria-selected={!team} onClick={() => go({ swarm: undefined })} className={chip(!team)}>
                {!team && <m.span layoutId="tasks-team" className="absolute inset-0 rounded-full bg-white/[0.07]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                <span className="relative font-medium">All swarms</span>
                <span className="relative font-mono text-[12px] text-ink-4">{Object.values(perTeam).reduce((a, b) => a + b, 0)}</span>
              </button>
              {teams.map((s) => {
                const on = s.id === team
                return (
                  <button key={s.id} role="tab" aria-selected={on} onClick={() => go({ swarm: s.id })} className={chip(on)}>
                    {on && <m.span layoutId="tasks-team" className="absolute inset-0 rounded-full" style={{ background: hsl(s.hue, 80, 55, 0.14) }} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                    <span className="relative size-2.5 rounded-full" style={{ background: hsl(s.hue, 95, 68), boxShadow: `0 0 10px ${hsl(s.hue, 100, 60)}` }} />
                    <span className="relative font-medium">{shown(s.name)}</span>
                    <span className="relative font-mono text-[12px] text-ink-4">{perTeam[s.id] ?? 0}</span>
                  </button>
                )
              })}
            </div>

            {/* motivations: the why each task serves; Unsorted is quiet but never hidden (S3) */}
            {supported && (
              <div className="no-scrollbar -mx-3 mb-2 flex items-center gap-1.5 overflow-x-auto px-3 md:mx-0 md:px-0" role="group" aria-label="Filter by motivation" data-motivation-filter>
                <Icon name="target" size={13} className="shrink-0 text-ink-4" />
                <button type="button" aria-pressed={!motivation} onClick={() => go({ motivation: undefined })} className={cx('min-h-8 shrink-0 rounded-full border px-3 text-[12.5px]', !motivation ? 'border-line-2 bg-white/[0.07] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}>
                  Any motivation
                </button>
                {shownMotivations.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    aria-pressed={motivation === x.id}
                    onClick={() => go({ motivation: motivation === x.id ? undefined : x.id })}
                    title={x.why || x.title}
                    className={cx('flex min-h-8 max-w-[18rem] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px]', motivation === x.id ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line text-ink-2 hover:text-ink')}
                  >
                    <span className="truncate">{x.title}</span>
                    {x.status !== 'active' && <span className="text-ink-4">· {x.status}</span>}
                    <span className="font-mono text-[11.5px] text-ink-4" title={partial ? PARTIAL_WORDS : undefined} data-count-partial={partial || undefined}>
                      {atLeast(perMotivation.out[x.id] ?? 0, partial)}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={motivation === 'none'}
                  onClick={() => go({ motivation: motivation === 'none' ? undefined : 'none' })}
                  className={cx('flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-dashed px-3 text-[12px]', motivation === 'none' ? 'border-line-2 bg-white/[0.07] text-ink' : 'border-line text-ink-4 hover:text-ink-2')}
                  data-unsorted
                >
                  {WORDS.unsorted}
                  <span className="font-mono" title={partial ? PARTIAL_WORDS : undefined} data-count-partial={partial || undefined}>
                    {atLeast(perMotivation.unsorted, partial)}
                  </span>
                  {motivation !== 'none' && perMotivation.unsorted > 0 && <span className="text-ink-3">· Sort these</span>}
                </button>
                <button type="button" onClick={() => navigate({ name: 'motivations' })} className="ml-1 flex min-h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] text-accent hover:text-ink">
                  {WORDS.motivations} <Icon name="chevron" size={11} />
                </button>
              </div>
            )}
            {partial && (
              <p role="status" className="mb-2 text-[12px] text-ink-3" data-partial>
                Counts by motivation {PARTIAL_WORDS}. Tasks it did not reach are not counted as under no motivation.
              </p>
            )}

            {/* view, mind, search */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div role="radiogroup" aria-label="Show tasks as" className="flex rounded-xl border border-line p-0.5">
                {VIEWS.map((v) => (
                  <button key={v} type="button" {...radioProps(v, VIEWS, view, (to) => go({ view: to === 'board' ? undefined : to }))} role="radio" onClick={() => go({ view: v === 'board' ? undefined : v })} className={cx('flex min-h-9 items-center gap-1.5 rounded-[10px] px-3 text-[12.5px] font-medium', view === v ? 'bg-white/[0.09] text-ink' : 'text-ink-3 hover:text-ink-2')}>
                    <Icon name={v === 'board' ? 'columns' : 'list'} size={13} />
                    {v === 'board' ? 'Columns' : 'List'}
                  </button>
                ))}
              </div>
              <label className="flex min-h-10 items-center gap-1.5 rounded-xl border border-line px-2.5 text-[12.5px] text-ink-3">
                <Icon name="mind" size={13} />
                <span className="sr-only">Mind</span>
                <select value={mind ?? ''} onChange={(e) => go({ mind: e.target.value || undefined })} className="min-h-9 max-w-[11rem] bg-transparent text-ink-2 outline-none">
                  <option value="">Any mind</option>
                  {Object.values(agents)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {shown(a.name)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-line px-2.5 text-[12.5px] text-ink-3 md:max-w-xs">
                <Icon name="search" size={13} />
                <span className="sr-only">Find a task</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task…" className="min-h-9 min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-4" />
              </label>
              <span className="ml-auto text-[12px] text-ink-4" role="status" data-task-total>
                {pluralAtLeast(shownCount, !!motivation && partial, 'task')}
                {motivation === 'none' ? ' under no motivation you can see' : chosen ? ` under “${chosen.title}”` : ''}
                {motivation && partial ? ` (${PARTIAL_WORDS})` : ''}
              </span>
            </div>
            {missing && <p role="status" className="mb-2 text-[12.5px] text-ink-3">That motivation is not there for you: it may have been made private, or it no longer exists.</p>}
            {motivation === 'none' && perMotivation.unsorted > 0 && <p className="mb-2 text-[12.5px] text-ink-3">Open a task and choose “File under a motivation” to sort it. Nothing is filed for you.</p>}
            {chosen && (
              <p className="mb-2 text-[12.5px] text-ink-3">
                {chosen.why ? `${chosen.why} ` : ''}
                <button type="button" onClick={() => navigate({ name: 'motivations', id: chosen.id })} className="text-accent hover:text-ink">
                  About this motivation →
                </button>
              </p>
            )}
            <GoalsBoard key={`${team ?? 'all'}:${view}`} swarmId={team} only={only} layout={view} focus={task} addUnder={chosen ?? null} className={TASKS_BOARD} />
            <FindHelp />
          </>
        )}
      </div>
    </Page>
  )
}
