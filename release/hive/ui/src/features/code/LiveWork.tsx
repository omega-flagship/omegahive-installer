import { useEffect, useMemo, useRef, useState } from 'react'
import type { GoalGrant } from '../../api/types'
import { hsl } from '../../lib/color'
import { ago } from '../../lib/format'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import type { Target } from './CodePage'
import { grantProbe, liveCodingWork, type LiveWorkItem } from './codingWork'
import { targetOpenable } from './editSessionRules'
import { shown } from '../../lib/displayName'

/** The app's text-field look (as in Launch and Schedule). */
const FIELD = 'min-h-11 w-full rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2'
const FIELD_MONO = `${FIELD} font-mono`

const NONE: Record<string, GoalGrant[]> = {}

const STATUS: Record<string, string> = { open: 'not started', claimed: 'in progress', waiting: 'waiting on you', stalled: 'stalled' }

/** "Live coding work": unfinished goals in coding swarms, each with a Join that asks only for what is not known. */
export function LiveWork({ targets }: { targets: Target[] | null }) {
  const client = useHive((s) => s.client)
  const goals = useHive((s) => s.goals)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  // Surface K1/L1 audit: grants belong to the client they were read through; another client starts from nothing
  const ctx = readContext(client)
  const [grantsRead, setGrants] = useState<Tagged<Record<string, GoalGrant[]>> | null>(null)
  const grants = taggedFor(grantsRead, ctx) ?? NONE
  const [manual, setManual] = useState(false)

  const probe = useMemo(() => grantProbe(goals, swarms), [goals, swarms])
  // order-free, so a goal update that only reorders the list does not ask again
  const probeKey = [...probe].sort().join(',')
  const asked = useRef({ ctx, ids: new Set<string>() })
  useEffect(() => {
    const askedCtx = readContext(client)
    if (asked.current.ctx !== askedCtx) asked.current = { ctx: askedCtx, ids: new Set<string>() }
    const seen = asked.current.ids
    const ids = (probeKey ? probeKey.split(',') : []).filter((id) => !seen.has(id))
    if (!client?.goalGrants || !ids.length) return
    for (const id of ids) seen.add(id)
    let cancelled = false
    let finished = false
    const ask = client.goalGrants.bind(client)
    void Promise.allSettled(ids.map((id) => ask(id))).then((results) => {
      finished = true
      if (cancelled) return
      // a goal whose grants cannot be read counts as having none
      const found: Record<string, GoalGrant[]> = {}
      results.forEach((r, i) => (found[ids[i]] = r.status === 'fulfilled' ? r.value : []))
      setGrants((cur) => ({ ctx: askedCtx, value: { ...(taggedFor(cur, askedCtx) ?? {}), ...found } }))
    })
    return () => {
      cancelled = true
      // an ask cancelled before it answered is asked again next time
      if (!finished) for (const id of ids) seen.delete(id)
    }
  }, [client, probeKey])

  const probing = !!client?.goalGrants && probe.some((id) => !(id in grants))
  const items = useMemo(() => liveCodingWork(goals, swarms, grants), [goals, swarms, grants])
  const repos = useMemo(() => (targets ?? []).filter((t) => t.kind === 'repository' && targetOpenable(t)), [targets])

  return (
    <section className="space-y-3" aria-labelledby="live-work-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="live-work-h" className="eyebrow flex items-center gap-2">
          <Icon name="live" size={13} /> Live coding work
        </h2>
        <button onClick={() => setManual((v) => !v)} aria-expanded={manual} className="inline-flex min-h-8 items-center gap-1 text-[12px] text-ink-3 hover:text-ink">
          <Icon name={manual ? 'chevronDown' : 'chevron'} size={12} /> Join by id
        </button>
      </div>
      {manual && <JoinById repos={repos} />}
      {items.length ? (
        <ul className="space-y-2">
          {items.map((it) => (
            <WorkRow key={it.goal.id} item={it} repos={repos} swarm={swarms[it.goal.swarm_id]} worker={it.goal.claimed_by ? agents[it.goal.claimed_by.replace(/^agent:/, '')] : undefined} />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-line px-4 py-3 text-[12.5px] text-ink-3">
          {probing ? 'Looking for coding work…' : 'No live coding work right now. When a mind takes a coding task, it shows up here to join. Or open something below to start your own.'}
        </p>
      )}
    </section>
  )
}

function WorkRow({ item, repos, swarm, worker }: { item: LiveWorkItem; repos: Target[]; swarm?: { name: string; hue: number }; worker?: { name: string; hue: number } }) {
  const { goal, workspaces } = item
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-xl border border-line bg-white/[0.025] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-ink" title={goal.title}>{goal.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink-3">
            {swarm && (
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ background: hsl(swarm.hue, 90, 65) }} />
                {shown(swarm.name)}
              </span>
            )}
            <span>{worker ? `${worker.name} · ${STATUS[goal.status] ?? goal.status}` : STATUS[goal.status] ?? goal.status}</span>
            <span>updated {ago(goal.updated_at)}</span>
            {workspaces[0] && <span className="font-mono text-ink-4">{workspaces[0]}</span>}
          </div>
        </div>
        {workspaces.length === 0 && (
          <Button variant="primary" hue={200} icon="edit" onClick={() => navigate({ name: 'code', task: goal.id })} className="min-h-9 px-3 text-[12.5px]" title="This task has no workspace yet: choose where to edit, keeping the task as it is">
            Choose where to edit
          </Button>
        )}
        <Button variant="subtle" icon="link" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="min-h-9 px-3 text-[12.5px]">
          Join
        </Button>
      </div>
      {open && <JoinForm taskId={goal.id} workspaces={workspaces} repository={item.repository} repos={repos} />}
    </li>
  )
}

/** Join one goal's workspace: the task is known; ask only for the workspace (and the repository when it is not). */
function JoinForm({ taskId, workspaces, repository, repos }: { taskId: string; workspaces: string[]; repository: string | null; repos: Target[] }) {
  const known = repository && repos.some((r) => r.repository_id === repository) ? repository : repos.length === 1 ? repos[0].repository_id : ''
  const [workspace, setWorkspace] = useState(workspaces[0] ?? '')
  const [repo, setRepo] = useState(known)
  const valid = /^ws_[A-Za-z0-9_-]+$/.test(workspace.trim())
  const id = `join-${taskId}`
  return (
    <form
      className="mt-2.5 grid gap-2 border-t border-line pt-2.5 md:grid-cols-[1fr_auto_auto] md:items-end"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && repo) navigate({ name: 'code', task: taskId, workspace: workspace.trim(), repository: repo })
      }}
    >
      <label htmlFor={`${id}-ws`} className="block text-[12px] text-ink-3">
        Workspace id
        <input id={`${id}-ws`} list={workspaces.length ? `${id}-wsl` : undefined} required value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="ws_…" autoCapitalize="off" spellCheck={false} className={`mt-1 ${FIELD_MONO}`} />
        {workspaces.length > 1 && (
          <datalist id={`${id}-wsl`}>
            {workspaces.map((w) => <option key={w} value={w} />)}
          </datalist>
        )}
      </label>
      {!known && (
        <label className="block text-[12px] text-ink-3">
          Repository
          <select required value={repo} onChange={(e) => setRepo(e.target.value)} className={`mt-1 ${FIELD}`}>
            <option value="">{repos.length ? 'Choose a repository' : 'No repositories registered'}</option>
            {repos.map((t) => <option key={t.id} value={t.repository_id}>{t.label}</option>)}
          </select>
        </label>
      )}
      <Button type="submit" variant="primary" hue={200} disabled={!valid || !repo}>
        Open shared workspace
      </Button>
      {workspace && !valid && <p className="text-[11.5px] text-warn md:col-span-3">A workspace id starts with ws_.</p>}
    </form>
  )
}

/** The raw form, for a task and workspace someone gave you. */
function JoinById({ repos }: { repos: Target[] }) {
  const [task, setTask] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [repository, setRepository] = useState(repos.length === 1 ? repos[0].repository_id : '')
  return (
    <form className="grid gap-2 rounded-xl border border-line p-3 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); navigate({ name: 'code', task: task.trim(), workspace: workspace.trim(), repository }) }}>
      <p className="text-[12px] text-ink-3 md:col-span-2">Use a worker's existing task and workspace. Your saves share that candidate and keep its history.</p>
      <label className="block text-[12px] text-ink-3">
        Task id
        <input required value={task} onChange={(e) => setTask(e.target.value)} autoCapitalize="off" spellCheck={false} className={`mt-1 ${FIELD_MONO}`} />
      </label>
      <label className="block text-[12px] text-ink-3">
        Workspace id
        <input required value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="ws_…" autoCapitalize="off" spellCheck={false} className={`mt-1 ${FIELD_MONO}`} />
      </label>
      <label className="block text-[12px] text-ink-3">
        Repository
        <select required value={repository} onChange={(e) => setRepository(e.target.value)} className={`mt-1 ${FIELD}`}>
          <option value="">Choose a repository</option>
          {repos.map((t) => <option key={t.id} value={t.repository_id}>{t.label}</option>)}
        </select>
      </label>
      <div className="flex items-end">
        <Button type="submit" disabled={!task.trim() || !workspace.trim() || !repository}>Open shared workspace</Button>
      </div>
    </form>
  )
}
