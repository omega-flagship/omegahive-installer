import { useEffect, useMemo, useState } from 'react'
import type { Goal } from '../../api/types'
import { ApiError } from '../../api/client'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { bindOperation, OPERATION_STOPPED_WORDS, stopped, useAlive, type BoundOperation } from '../../lib/boundOperation'
import { Page } from '../../ui/Page'
import { Button, EmptyState } from '../../ui/primitives'
import { LEASE_HINT, leaseStep, missingSkills } from './steps'
import { shown } from '../../lib/displayName'

/** Skills a coordinator needs to run its members under a lease, as exact allow rules for that coordinator. */
const COORDINATOR_SKILLS = ['hive-lifecycle-start', 'hive-lifecycle-stop', 'hive-lifecycle-status', 'hive-goals', 'hive-goal-get']
const MAX_SECONDS = 900

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
 */
export default function LifecyclePage({ swarmId }: { swarmId: string }) {
  const client = useHive((s) => s.client)
  const swarm = useHive((s) => s.swarms[swarmId])
  const agents = useHive((s) => s.agents)
  const policy = useHive((s) => s.policy)
  const loadPolicy = useHive((s) => s.loadPolicy)
  const sendMessage = useHive((s) => s.sendMessage)
  const toast = useHive((s) => s.toast)

  const members = useMemo(() => Object.values(agents).filter((a) => a.swarm_id === swarmId), [agents, swarmId])
  const native = members.filter((a) => a.kind !== 'module')
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

  const ruleExists = (skill: string) =>
    (policy ?? []).some((r) => r.scope === `agent:${coordinator}` && r.skill === skill && r.mode === 'allow')
  const missing = missingSkills(coordinator, COORDINATOR_SKILLS, ruleExists)
  const openTasks = goals.filter((g) => (g.status === 'open' || g.status === 'claimed') && g.assignee === specialist)
  const name = (id: string) => agents[id]?.name ?? id

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

  if (!swarm) return <Page title="Lifecycle" label="Lifecycle"><EmptyState icon="alert" title="No such swarm" /></Page>

  return (
    <Page title="Lifecycle" eyebrow={shown(swarm.name)} label="Lifecycle" onClose={() => navigate({ name: 'swarm', id: swarmId })}>
      <ConfirmHost />
      <div className="mx-auto max-w-3xl space-y-6 px-4 pt-2 pb-12 md:px-6">
        <div className="space-y-2 text-[13px] text-ink-3">
          <p>
            <span className="text-ink-2">This is a setup page, not a list of waiting approvals.</span> Nothing here is pending until you prepare it, and
            nothing takes effect until you apply it. Work through the three steps in order.
          </p>
          <p>
            A <span className="text-ink-2">delegation</span> (step 1) is standing: it says which members a coordinating mind may run, and lasts until you
            change it. A <span className="text-ink-2">lease</span> (step 3) is one run: one member, one task assigned to it, a time limit and a budget,
            usable once. The hive stops the member when its task ends, the lease expires, the budget runs out or its sandbox is missing.
          </p>
          <p>Only an admin signed in as a person can apply anything here.</p>
        </div>

        <section className="rounded-2xl border border-line bg-white/[0.03] p-4" aria-labelledby="deleg-h">
          <h2 id="deleg-h" className="text-[14px] font-medium text-ink">1. Who may run whom</h2>
          <label className="mt-3 block text-[12.5px] text-ink-3">
            Coordinator
            <select className="mt-1 block w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" value={coordinator}
              onChange={(e) => setCoordinator(e.target.value)}>
              <option value="">Choose a mind</option>
              {native.map((a) => <option key={a.id} value={a.id}>{shown(a.name)}{swarm.coordinator_id === a.id ? ' (coordinator)' : ''}</option>)}
            </select>
          </label>
          {!coordinator && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              {native.length < 2
                ? 'This swarm needs at least two native minds (a coordinator and a member) before anything can be delegated.'
                : swarm.coordinator_id ? '' : 'This swarm has no coordinator set. Choose the mind that should run the others.'}
            </p>
          )}
          {coordinator && (
            <fieldset className="mt-3">
              <legend className="text-[12.5px] text-ink-3">Members it may run (native minds of this swarm)</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {native.filter((a) => a.id !== coordinator).map((a) => (
                  <label key={a.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-1.5 text-[13px] text-ink">
                    <input type="checkbox" checked={chosen.includes(a.id)}
                      onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id)))} />
                    {shown(a.name)}
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button variant="primary" disabled={busy || !client?.setDelegation || JSON.stringify([...chosen].sort()) === JSON.stringify([...current].sort())}
                  onClick={() => void run('save the delegation', async (op) => {
                    const text = chosen.length ? `${name(coordinator)} may run ${chosen.map(name).join(', ')}.` : `${name(coordinator)} may run no one.`
                    if (!(await op.confirm(`Apply: ${text}`, 'Apply'))) return
                    await op.write(() => client!.setDelegation!(coordinator, chosen))
                    setCurrent(chosen)
                    toast({ tone: 'success', title: 'Delegation applied', body: text })
                  })}>
                  Apply delegation
                </Button>
                <span className="text-[12px] text-ink-4">Now: {current.length ? current.map(name).join(', ') : 'nobody'}</span>
              </div>
            </fieldset>
          )}
        </section>

        <section className={`rounded-2xl border border-line bg-white/[0.03] p-4 ${coordinator ? '' : 'opacity-60'}`} aria-labelledby="rules-h">
            <h2 id="rules-h" className="text-[14px] font-medium text-ink">2. Skills the coordinator needs</h2>
            {!coordinator && <p className="mt-1 text-[12.5px] text-ink-3">Needs step 1: choose a coordinator first.</p>}
            <ul className="mt-2 space-y-1 text-[13px]">
              {COORDINATOR_SKILLS.map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <code className="font-mono text-ink-2">{s}</code>
                  {coordinator && <span className={ruleExists(s) ? 'text-good' : 'text-warn'}>{ruleExists(s) ? 'allowed' : 'not allowed yet'}</span>}
                </li>
              ))}
            </ul>
            <Button className="mt-3" variant="primary" disabled={busy || !coordinator || !missing.length}
              onClick={() => void run('add the rules', async (op) => {
                if (!(await op.confirm(`Allow ${name(coordinator)} exactly: ${missing.join(', ')}? Nothing else changes.`, 'Allow'))) return
                for (const skill of missing) await op.write(() => client!.createPolicy({ scope: `agent:${coordinator}`, skill, mode: 'allow', note: 'lifecycle coordinator' } as never))
                await loadPolicy()
                toast({ tone: 'success', title: 'Rules added' })
              })}>
              {!coordinator ? 'Choose a coordinator first' : missing.length ? `Allow ${missing.length} skill${missing.length === 1 ? '' : 's'}` : 'All allowed'}
            </Button>
          </section>

        {!(coordinator && current.length > 0) ? (
          <section className="rounded-2xl border border-line bg-white/[0.03] p-4 opacity-60" aria-labelledby="lease-h">
            <h2 id="lease-h" className="text-[14px] font-medium text-ink">3. One run (a lease)</h2>
            <p className="mt-1 text-[12.5px] text-ink-3">
              {LEASE_HINT[coordinator ? 'needs-delegation' : 'needs-coordinator']} Then you pick a member, a task assigned to it, a time limit
              and a budget. Nothing starts until the coordinator uses the lease.
            </p>
          </section>
        ) : (
          <section className="rounded-2xl border border-line bg-white/[0.03] p-4" aria-labelledby="lease-h">
            <h2 id="lease-h" className="text-[14px] font-medium text-ink">3. One run (a lease)</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-[12.5px] text-ink-3">Member
                <select className="mt-1 block w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" value={specialist}
                  onChange={(e) => { setSpecialist(e.target.value); setTask('') }}>
                  <option value="">Choose</option>
                  {current.map((id) => <option key={id} value={id}>{name(id)}</option>)}
                </select>
              </label>
              <label className="text-[12.5px] text-ink-3">Task assigned to it
                <select className="mt-1 block w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" value={task}
                  onChange={(e) => setTask(e.target.value)} disabled={!specialist}>
                  <option value="">{specialist && !openTasks.length ? 'No open task assigned to this member' : 'Choose'}</option>
                  {openTasks.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                </select>
              </label>
              <label className="text-[12.5px] text-ink-3">Duration (seconds, at most {MAX_SECONDS})
                <input type="number" min={10} max={MAX_SECONDS} value={seconds} onChange={(e) => setSeconds(Math.min(MAX_SECONDS, Number(e.target.value) || 0))}
                  className="mt-1 block w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" />
              </label>
              <label className="text-[12.5px] text-ink-3">Budget for this run (USD)
                <input type="number" min={0.01} step={0.01} value={budget} onChange={(e) => setBudget(Number(e.target.value) || 0)}
                  className="mt-1 block w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" />
              </label>
            </div>
            {specialist && !openTasks.length && (
              <div className="mt-3 rounded-xl border border-line p-3">
                <p className="text-[12.5px] text-ink-3">{name(specialist)} has no open task assigned to it. A lease always runs one assigned task. Create one here:</p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder={`What ${name(specialist)} should do`} aria-label="New task title"
                    className="block w-full rounded-xl border border-line bg-black/25 px-3 py-2 text-[14px] text-ink" />
                  <Button variant="subtle" disabled={busy || !newTask.trim() || !client}
                    onClick={() => void run('create the task', async (op) => {
                      const title = newTask.trim()
                      if (!(await op.confirm(`Create the task "${title}" for ${name(specialist)}? It only becomes a run when you issue a lease.`, 'Create task'))) return
                      const goal = await op.write(() => client!.createGoal(swarmId, { title, assignee: specialist }))
                      setGoals((g) => [goal, ...g])
                      setTask(goal.id)
                      setNewTask('')
                    })}>
                    Create task
                  </Button>
                </div>
              </div>
            )}
            {(() => {
              const step = leaseStep({ coordinator, delegated: current, member: specialist, openTasks: openTasks.length, task })
              return step === 'ready' || (step === 'needs-task' && !openTasks.length && specialist) ? null
                : <p className="mt-3 text-[12.5px] text-ink-3">{LEASE_HINT[step]}</p>
            })()}
            <Button className="mt-3" variant="primary" disabled={busy || !specialist || !task || seconds <= 0 || budget <= 0 || !client?.issueLease}
              onClick={() => void run('issue the lease', async (op) => {
                const text = `${name(coordinator)} may run ${name(specialist)} on "${goals.find((g) => g.id === task)?.title}" for ${seconds}s, spending at most $${budget.toFixed(2)}.`
                if (!(await op.confirm(`Issue this lease? ${text}`, 'Issue lease'))) return
                const out = await op.write(() => client!.issueLease!({ coordinator, specialist, task, seconds, budget_usd: budget }))
                setLease(out.lease)
                // the lease's instructions go to the coordinator only under the sign-in that issued it (checked right here)
                await op.write(() => sendMessage(coordinator, `[LIFECYCLE-LEASE] ${text} Start it with hive-lifecycle-start ${out.lease}; check it with hive-lifecycle-status ${out.lease}.`))
                toast({ tone: 'success', title: 'Lease issued and sent to the coordinator', body: text })
              })}>
              Issue lease
            </Button>
            {lease && <p className="mt-2 text-[12px] text-ink-3">Sent to {name(coordinator)}. It can be used once, and only by {name(coordinator)}.</p>}
          </section>
        )}
      </div>
    </Page>
  )
}
