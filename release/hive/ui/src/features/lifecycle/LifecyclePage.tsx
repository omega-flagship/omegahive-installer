import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Goal } from '../../api/types'
import { ApiError } from '../../api/client'
import { experienceById } from '../../experiences/registry'
import { navigate } from '../../lib/router'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { bindOperation, OPERATION_STOPPED_WORDS, stopped, useAlive, type BoundOperation } from '../../lib/boundOperation'
import { Page } from '../../ui/Page'
import { shown } from '../../lib/displayName'
import { COORDINATOR_SKILLS, lifecycleScreen, MAX_SECONDS, namer } from './data'
import { missingSkills } from './steps'

const explain = (e: unknown) => {
  if (e instanceof ApiError && e.status === 403)
    return 'Only an admin who signed in as a person (Google) can do this. The hive password cannot, by design.'
  return e instanceof Error ? e.message : String(e)
}

/**
 * #/swarms/<id>/lifecycle: a person reviews and applies what a coordinating mind may run.
 * Nothing here takes effect without an explicit, confirmed Apply, and the hive itself refuses anyone but a
 * signed-in admin person (hive/core/delegation.py). A lease is one run: a member, an open task assigned to it,
 * a duration and a budget; the hive stops the member when the task ends, the lease expires or the budget is spent.
 *
 * The page and each skill on it are atoms (lifecycle.metta) that MeTTa composes for the look being worn: which steps
 * are open, every hint, every field and button. This page loads the data, states the facts, and carries out a press.
 */
export default function LifecyclePage({ swarmId }: { swarmId: string }) {
  const client = useHive((s) => s.client)
  const swarm = useHive((s) => s.swarms[swarmId])
  const agents = useHive((s) => s.agents)
  const policy = useHive((s) => s.policy)
  const loadPolicy = useHive((s) => s.loadPolicy)
  const sendMessage = useHive((s) => s.sendMessage)
  const toast = useHive((s) => s.toast)
  const look = experienceById(useLook().current?.experience).id

  const [picked, setCoordinator] = useState<string>('')
  const coordinator = picked || swarm?.coordinator_id || ''
  const [chosen, setChosen] = useState<string[]>([])
  const [current, setCurrent] = useState<string[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [specialist, setSpecialist] = useState('')
  const [task, setTask] = useState('')
  const [seconds, setSeconds] = useState(300)
  const [budget, setBudget] = useState(0.1)
  const [busy, setBusy] = useState(false)
  const [lease, setLease] = useState<string | null>(null)
  const [newTask, setNewTask] = useState('')

  useEffect(() => {
    void loadPolicy().catch(() => undefined)
    void client?.listGoals(swarmId).then(setGoals).catch(() => setGoals([]))
  }, [client, swarmId, loadPolicy])
  useEffect(() => {
    if (!coordinator || !client?.listDelegations) return
    void client.listDelegations().then((rows) => {
      const ids = rows.filter((r) => r.coordinator_id === coordinator).map((r) => r.specialist_id)
      setCurrent(ids)
      setChosen(ids)
    }).catch(() => setCurrent([]))
  }, [client, coordinator])

  const allowed = useCallback((skill: string) =>
    (policy ?? []).some((r) => r.scope === `agent:${coordinator}` && r.skill === skill && r.mode === 'allow'), [policy, coordinator])
  const missing = missingSkills(coordinator, COORDINATOR_SKILLS, allowed)
  const name = namer(agents)

  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const { data, facts } = lifecycleScreen(
      { swarm, agents, coordinator, chosen, current, goals, member: specialist, task, seconds, budget, newTask, lease, allowed },
      { delegate: !!client?.setDelegation, lease: !!client?.issueLease, write: !!client },
      compose,
    )
    return { plan: compose('lifecycle', facts), data }
  }, [swarm, agents, coordinator, chosen, current, goals, specialist, task, seconds, budget, newTask, lease, allowed, client, compose])

  // professional-release r1.2 (stand-in r1.1 P1): each Apply is one bound operation (lib/boundOperation). Its confirm
  // and every write are checked against the sign-in it began under and this page's lifetime right before they act;
  // a change stops it there, says so, and sends nothing more (no lease message under another sign-in)
  const alive = useAlive()
  const run = async (what: string, fn: (op: BoundOperation) => Promise<void>) => {
    const op = bindOperation(alive)
    setBusy(true)
    try {
      await fn(op)
    } catch (e) {
      if (stopped(e)) { if (alive()) toast({ tone: 'error', title: `Did not ${what}`, body: OPERATION_STOPPED_WORDS }) }
      else if (op.current()) toast({ tone: 'error', title: `Could not ${what}`, body: explain(e) })
    } finally {
      if (alive()) setBusy(false)
    }
  }

  const applyDelegation = () => run('save the delegation', async (op) => {
    const text = chosen.length ? `${name(coordinator)} may run ${chosen.map(name).join(', ')}.` : `${name(coordinator)} may run no one.`
    if (!(await op.confirm(`Apply: ${text}`, 'Apply'))) return
    await op.write(() => client!.setDelegation!(coordinator, chosen))
    setCurrent(chosen)
    toast({ tone: 'success', title: 'Delegation applied', body: text })
  })
  const allowRules = () => run('add the rules', async (op) => {
    if (!(await op.confirm(`Allow ${name(coordinator)} exactly: ${missing.join(', ')}? Nothing else changes.`, 'Allow'))) return
    for (const skill of missing) await op.write(() => client!.createPolicy({ scope: `agent:${coordinator}`, skill, mode: 'allow', note: 'lifecycle coordinator' } as never))
    await loadPolicy()
    toast({ tone: 'success', title: 'Rules added' })
  })
  const createTask = () => run('create the task', async (op) => {
    const title = newTask.trim()
    if (!(await op.confirm(`Create the task "${title}" for ${name(specialist)}? It only becomes a run when you issue a lease.`, 'Create task'))) return
    const goal = await op.write(() => client!.createGoal(swarmId, { title, assignee: specialist }))
    setGoals((g) => [goal, ...g])
    setTask(goal.id)
    setNewTask('')
  })
  const issueLease = () => run('issue the lease', async (op) => {
    const text = `${name(coordinator)} may run ${name(specialist)} on "${goals.find((g) => g.id === task)?.title}" for ${seconds}s, spending at most $${budget.toFixed(2)}.`
    if (!(await op.confirm(`Issue this lease? ${text}`, 'Issue lease'))) return
    const out = await op.write(() => client!.issueLease!({ coordinator, specialist, task, seconds, budget_usd: budget }))
    setLease(out.lease)
    // the lease's instructions go to the coordinator only under the sign-in that issued it (checked right here)
    await op.write(() => sendMessage(coordinator, `[LIFECYCLE-LEASE] ${text} Start it with hive-lifecycle-start ${out.lease}; check it with hive-lifecycle-status ${out.lease}.`))
    toast({ tone: 'success', title: 'Lease issued and sent to the coordinator', body: text })
  })

  const onInput = (bind: string, value: string) => {
    if (bind === 'deleg.coordinator') setCoordinator(value)
    else if (bind === 'lease.member') { setSpecialist(value); setTask('') }
    else if (bind === 'lease.task') setTask(value)
    else if (bind === 'lease.seconds') setSeconds(Math.min(MAX_SECONDS, Number(value) || 0))
    else if (bind === 'lease.budget') setBudget(Number(value) || 0)
    else if (bind === 'task.new') setNewTask(value)
  }
  // a press MeTTa drew only when its step is open; each write still checks what it needs (a held button sends nothing)
  const onAction = (action: string, item: ScreenItem, value?: boolean) => {
    if (action === 'pick-member') {
      const id = String(item.id)
      setChosen((c) => (value ? [...c.filter((x) => x !== id), id] : c.filter((x) => x !== id)))
    } else if (action === 'apply-delegation') void applyDelegation()
    else if (action === 'allow-rules') void allowRules()
    else if (action === 'create-task') void createTask()
    else if (action === 'issue-lease') void issueLease()
  }

  return (
    <Page title="Lifecycle" eyebrow={swarm ? shown(swarm.name) : undefined} label="Lifecycle"
      onClose={swarm ? () => navigate({ name: 'swarm', id: swarmId }) : undefined}>
      <ConfirmHost />
      <div className="mx-auto max-w-3xl px-4 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{ data, framed: true, busy, onInput, onAction }} />
      </div>
    </Page>
  )
}
