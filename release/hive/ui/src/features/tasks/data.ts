import type { Agent, Goal, Motivation, MotivationRef, Swarm } from '../../api/types'
import { hsl } from '../../lib/color'
import { shown } from '../../lib/displayName'
import { isActive } from '../../lib/goals'
import { atLeast, isUnsorted, PARTIAL_WORDS, sortMotivations, WORDS } from '../../lib/motivations'
import { pluralAtLeast } from '../../lib/plural'
import type { Route, TaskView } from '../../lib/router'
import type { ScreenFacts } from '../../screens/screenSpace'

/**
 * What the Tasks screen is told (tasks.metta): the values it draws (bound by path) and this moment's facts (counts,
 * flags and known values) from which MeTTa composes it. Pure: the hive's data comes in as arguments.
 */
export type TasksRoute = Omit<Extract<Route, { name: 'tasks' }>, 'name'>

export interface TasksInput {
  route: TasksRoute
  /** the words typed into Find a task */
  query: string
  swarms: Record<string, Swarm>
  agents: Record<string, Agent>
  goals: Record<string, Goal>
  links: Record<string, MotivationRef[]>
  motivations: Record<string, Motivation>
  /** the hive lists Motivations and Tasks */
  supported: boolean
  /** a read of motivations or task links stopped early */
  countsPartial: boolean
  linksLoaded: boolean
}

export interface TasksScreen {
  data: Record<string, unknown>
  facts: ScreenFacts
  /** the swarm the board shows, when the address names one that exists */
  team: string | undefined
  /** the motivation the page is filtered to, when this person can read it */
  chosen: Motivation | undefined
  view: TaskView
}

/** The filter every view shares: mind (assignee, holder or creator, as the hive's mind filter), motivation, words. */
export function taskFilter(route: TasksRoute, query: string, links: Record<string, MotivationRef[]>): (g: Goal) => boolean {
  const { mind, motivation } = route
  const needle = query.trim().toLowerCase()
  return (g: Goal) =>
    (!mind || g.assignee === mind || g.claimed_by === mind || g.created_by === `agent:${mind}`) &&
    (!motivation || (motivation === 'none' ? isUnsorted(links, g.id) : (links[g.id] ?? []).some((l) => l.id === motivation))) &&
    (!needle || `${g.title}\n${g.detail}`.toLowerCase().includes(needle))
}

export function tasksScreen(input: TasksInput): TasksScreen {
  const { route, query, swarms, agents, goals, links, motivations, supported, linksLoaded } = input
  const { swarm, mind, motivation } = route
  const view: TaskView = route.view ?? 'board'
  // a read that did not finish makes every count by motivation a floor (stand-in P2-4 on 57e64ca)
  const partial = input.countsPartial && supported
  const teams = Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const team = swarm && swarms[swarm] ? swarm : undefined
  const chosen = motivation && motivation !== 'none' ? motivations[motivation] : undefined
  const missing = !!motivation && motivation !== 'none' && supported && linksLoaded && !chosen
  const only = taskFilter(route, query, links)

  // counts for the filters: live tasks in the chosen swarm, each counted once
  const inTeam = Object.values(goals).filter((g) => !team || g.swarm_id === team)
  const live = inTeam.filter(isActive)
  const perTeam: Record<string, number> = {}
  for (const g of Object.values(goals)) if (isActive(g)) perTeam[g.swarm_id] = (perTeam[g.swarm_id] ?? 0) + 1
  const perMotivation = { out: {} as Record<string, number>, unsorted: 0 }
  for (const g of live) {
    const refs = links[g.id] ?? []
    if (isUnsorted(links, g.id)) perMotivation.unsorted++
    for (const r of new Set(refs.map((x) => x.id))) perMotivation.out[r] = (perMotivation.out[r] ?? 0) + 1
  }
  const shownMotivations = sortMotivations(Object.values(motivations).filter((x) => (x.status !== 'retired' && x.status !== 'achieved') || x.id === motivation))
  const shownCount = inTeam.filter(only).length
  const countTitle = partial ? PARTIAL_WORDS : ''

  const swarmTabs = [
    { id: '', label: 'All swarms', count: Object.values(perTeam).reduce((a, b) => a + b, 0) },
    ...teams.map((s) => ({ id: s.id, label: shown(s.name), count: perTeam[s.id] ?? 0, color: hsl(s.hue, 95, 68), glow: hsl(s.hue, 100, 60), tint: hsl(s.hue, 80, 55, 0.14) })),
  ]
  const motivationPills = [
    { id: '', label: 'Any motivation' },
    ...shownMotivations.map((x) => ({
      id: x.id,
      label: x.title,
      title: x.why || x.title,
      note: x.status !== 'active' ? x.status : '',
      count: atLeast(perMotivation.out[x.id] ?? 0, partial),
      count_title: countTitle,
      partial,
      accent: true,
    })),
    {
      id: 'none',
      label: WORDS.unsorted,
      count: atLeast(perMotivation.unsorted, partial),
      count_title: countTitle,
      partial,
      quiet: true,
      hint: motivation !== 'none' && perMotivation.unsorted > 0 ? 'Sort these' : '',
    },
  ]
  const minds = Object.values(agents)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ id: a.id, label: shown(a.name) }))
  const total =
    pluralAtLeast(shownCount, !!motivation && partial, 'task') +
    (motivation === 'none' ? ' under no motivation you can see' : chosen ? ` under “${chosen.title}”` : '') +
    (motivation && partial ? ` (${PARTIAL_WORDS})` : '')

  return {
    data: {
      'tasks.swarms': swarmTabs,
      'tasks.motivations': motivationPills,
      'tasks.minds': minds,
      'tasks.total': total,
      'counts.partial.text': `Counts by motivation ${PARTIAL_WORDS}. Tasks it did not reach are not counted as under no motivation.`,
      'motivation.why': chosen?.why ?? '',
      swarm: team ?? '',
      motivation: motivation ?? '',
      mind: mind ?? '',
      view,
      query,
    },
    facts: {
      counts: { swarms: teams.length, 'tasks.shown': shownCount, 'tasks.unsorted': perMotivation.unsorted },
      flags: {
        'motivations.supported': supported,
        'counts.partial': partial,
        'motivation.chosen': !!chosen,
        'motivation.why': !!chosen?.why,
        'motivation.missing': missing,
      },
      values: { view, 'filter.motivation': !motivation ? 'any' : motivation === 'none' ? 'unsorted' : 'one' },
    },
    team,
    chosen,
    view,
  }
}

/**
 * Where a pick on the screen takes the address: `bind` names the field the screen bound. Pressing the motivation already
 * chosen clears it, as does Any; the board is the view an address leaves out. Words typed into Find a task stay on the
 * page (null).
 */
export function routeAfter(route: TasksRoute, bind: string, value: string): Partial<TasksRoute> | null {
  switch (bind) {
    case 'swarm': return { swarm: value || undefined }
    case 'mind': return { mind: value || undefined }
    case 'motivation': return { motivation: !value || value === route.motivation ? undefined : value }
    case 'view': return value === 'board' || value === 'list' ? { view: value === 'board' ? undefined : value } : null
    default: return null
  }
}
