import { useCallback, useEffect, useMemo, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { cx } from '../../lib/cx'
import { useCountsPartial, useMotivationData, WORDS } from '../../lib/motivations'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { GoalsBoard } from '../goals/GoalsBoard'
import { routeAfter, taskFilter, tasksScreen, type TasksRoute } from './data'
import { FindHelp } from './FindHelp'
import { TASKS_BOARD, TASKS_BOARD_PART, TASKS_PAGE_BODY, TASKS_SCREEN } from './layout'

/**
 * #/tasks: the concrete work (today's goals, unchanged underneath), in one place: in columns or one list, for every
 * swarm or one, one mind, one motivation or the Unsorted (under no motivation this person can read), and a search. Each
 * task counts once, however many motivations it serves. The screen is atoms (tasks.metta) that MeTTa composes for the
 * look being worn; this page only reads the hive, states the facts, and carries out a press. The task board itself is
 * the one the swarm page shares, offered as an island.
 */
export default function TasksPage(route: TasksRoute) {
  const { swarm, mind, motivation, task } = route
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const goals = useHive((s) => s.goals)
  const links = useHive((s) => s.taskLinks)
  const motivations = useHive((s) => s.motivations)
  const linksLoaded = useHive((s) => s.taskLinksLoaded)
  const { supported } = useMotivationData()
  const countsPartial = useCountsPartial()
  const look = experienceById(useLook().current?.experience).id
  const [q, setQ] = useState('')
  // an old #/goals or #/boards link: show the address it now lives at (same filter), without a new history entry
  useEffect(() => {
    if (/^#\/(goals|boards)\b/.test(window.location.hash)) navigate({ name: 'tasks', ...route }, { replace: true })
  }, [route])
  const go = useCallback((change: Partial<TasksRoute>) => navigate({ name: 'tasks', swarm, mind, motivation, view: route.view, ...change, task: undefined }, { replace: true }), [swarm, mind, motivation, route.view])

  const compose = useCompose(look)
  const only = useMemo(() => taskFilter({ mind, motivation }, q, links), [mind, motivation, q, links])
  const { plan, data, team, chosen, view } = useMemo(() => {
    const s = tasksScreen({ route: { swarm, mind, motivation, view: route.view }, query: q, swarms, agents, goals, links, motivations, supported, countsPartial, linksLoaded })
    return { ...s, plan: compose('tasks', s.facts) }
  }, [swarm, mind, motivation, route.view, q, swarms, agents, goals, links, motivations, supported, countsPartial, linksLoaded, compose])

  const board = (layout: 'board' | 'list') => (
    <div data-tasks-board className={TASKS_BOARD_PART}>
      <GoalsBoard key={`${team ?? 'all'}:${view}`} swarmId={team} only={only} layout={layout} focus={task} addUnder={chosen ?? null} className={TASKS_BOARD} />
    </div>
  )
  const islands = { 'task-columns': board('board'), 'task-list': board('list'), 'find-help': <FindHelp /> }

  return (
    <Page label={WORDS.tasks} eyebrow="The work" title={WORDS.tasks} info="goals">
      <div className={cx(TASKS_PAGE_BODY, 'px-3 pb-[calc(var(--sab)+92px)] md:px-6 md:pb-6')}>
        <Screen plan={plan} className={TASKS_SCREEN} host={{
          data,
          framed: true,
          islands,
          onInput: (bind, value) => {
            if (bind === 'query') return setQ(value)
            const change = routeAfter(route, bind, value)
            if (change) go(change)
          },
          onOpen: (target) => { if (target === 'motivation' && chosen) navigate({ name: 'motivations', id: chosen.id }) },
          onAction: (action) => { if (action === 'open-motivations') navigate({ name: 'motivations' }) },
        }} />
      </div>
    </Page>
  )
}
