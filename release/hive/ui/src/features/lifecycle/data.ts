import type { Agent, Goal, Swarm } from '../../api/types'
import { shown } from '../../lib/displayName'
import { plural } from '../../lib/plural'
import type { ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { LEASE_HINT, leaseStep, missingSkills } from './steps'

/**
 * What the Lifecycle screens are told (lifecycle.metta): the values they draw, bound by path, and this moment's facts
 * (counts, flags and the setup step) from which MeTTa composes them. Each skill the coordinator needs is composed as its
 * own small screen, and the lifecycle screen stacks them. Pure: composing and the page's choices so far are handed in.
 */
export type Compose = (screen: string, facts: ScreenFacts) => ScreenPlan
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

/** Skills a coordinator needs to run its members under a lease, as exact allow rules for that coordinator. */
export const COORDINATOR_SKILLS = ['hive-lifecycle-start', 'hive-lifecycle-stop', 'hive-lifecycle-status', 'hive-goals', 'hive-goal-get']
/** The longest a lease may run, in seconds. */
export const MAX_SECONDS = 900

export interface LifecycleInput {
  swarm: Swarm | undefined
  agents: Record<string, Agent>
  /** the chosen coordinator ('' for none) */
  coordinator: string
  /** members ticked in step 1, and the members the hive says the coordinator may run now */
  chosen: string[]
  current: string[]
  goals: Goal[]
  /** step 3 so far: the member, its task, duration, budget, a new task's title, and the lease issued */
  member: string
  task: string
  seconds: number
  budget: number
  newTask: string
  lease: string | null
  /** whether the coordinator already has an allow rule for a skill */
  allowed: (skill: string) => boolean
}
/** What this hive offers here: setting a delegation, issuing a lease, and writing at all (a client). */
export interface Can { delegate: boolean; lease: boolean; write: boolean }

/** The swarm's native minds (not modules): only these can coordinate or be run under a lease. */
export const nativeMinds = (agents: Record<string, Agent>, swarmId: string): Agent[] =>
  Object.values(agents).filter((a) => a.swarm_id === swarmId && a.kind !== 'module')

/** A mind's name as this page writes it in its sentences, from its id. */
export const namer = (agents: Record<string, Agent>) => (id: string): string => agents[id]?.name ?? id

/** Open tasks assigned to one member: the only tasks a lease may run. */
export const openTasksFor = (goals: Goal[], member: string): Goal[] =>
  goals.filter((g) => (g.status === 'open' || g.status === 'claimed') && g.assignee === member)

const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

export function skillItem(skill: string, coordinatorChosen: boolean, allowed: boolean, compose: Compose): StackItem {
  return {
    id: skill,
    plan: compose('lifecycle-skill', { flags: { 'coordinator.chosen': coordinatorChosen, 'skill.allowed': allowed } }),
    data: { 'skill.name': skill },
  }
}

/** The lifecycle screen: the three setup steps, each as far as the person has prepared it. */
export function lifecycleScreen(input: LifecycleInput, can: Can, compose: Compose): Composed {
  const { swarm, coordinator, current, member, task } = input
  const native = swarm ? nativeMinds(input.agents, swarm.id) : []
  const name = namer(input.agents)
  const chosen = coordinator !== ''
  const missing = missingSkills(coordinator, COORDINATOR_SKILLS, (s) => input.allowed(s))
  const open = openTasksFor(input.goals, member)
  const step = leaseStep({ coordinator, delegated: current, member, openTasks: open.length, task })
  return {
    data: {
      'deleg.coordinator': coordinator,
      'deleg.minds': native.map((a) => ({ id: a.id, label: `${shown(a.name)}${swarm?.coordinator_id === a.id ? ' (coordinator)' : ''}` })),
      'deleg.members': native.filter((a) => a.id !== coordinator).map((a) => ({ id: a.id, label: shown(a.name), on: input.chosen.includes(a.id) })),
      'deleg.held': !can.delegate || same(input.chosen, current),
      'deleg.now': current.length ? current.map(name).join(', ') : 'nobody',
      'skills.all': COORDINATOR_SKILLS.map((s) => skillItem(s, chosen, chosen && input.allowed(s), compose)),
      'rules.allow': `Allow ${plural(missing.length, 'skill')}`,
      'rules.held': !chosen || !missing.length,
      'hint.needs-coordinator': LEASE_HINT['needs-coordinator'],
      'hint.needs-delegation': LEASE_HINT['needs-delegation'],
      'hint.needs-member': LEASE_HINT['needs-member'],
      'hint.needs-task': LEASE_HINT['needs-task'],
      'lease.member': member,
      'lease.members': current.map((id) => ({ id, label: name(id) })),
      'lease.member_name': member ? name(member) : '',
      'lease.coordinator_name': chosen ? name(coordinator) : '',
      'lease.task': task,
      'lease.tasks': open.map((g) => ({ id: g.id, label: g.title })),
      'lease.task_prompt': member && !open.length ? 'No open task assigned to this member' : 'Choose',
      'lease.task_held': !member,
      'lease.max': MAX_SECONDS,
      'lease.seconds': String(input.seconds),
      'lease.budget': String(input.budget),
      'lease.held': !member || !task || input.seconds <= 0 || input.budget <= 0 || !can.lease,
      'task.new': input.newTask,
      'task.held': !input.newTask.trim() || !can.write,
    },
    facts: {
      counts: { 'deleg.current': current.length, 'rules.missing': missing.length, 'tasks.open': open.length },
      flags: {
        'swarm.known': swarm !== undefined,
        'swarm.has-coordinator': !!swarm?.coordinator_id,
        'minds.few': native.length < 2,
        'coordinator.chosen': chosen,
        'member.chosen': member !== '',
        'lease.issued': input.lease !== null,
      },
      values: { 'lease.step': step },
    },
  }
}
