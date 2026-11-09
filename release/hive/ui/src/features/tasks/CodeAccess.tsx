import { plural } from '../../lib/plural'
import { AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import type { HiveClient, Person } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'
import type { AddGoalGrantBody } from '../../api/missingUi'
import type { Goal, GoalGrant } from '../../api/types'
import { decisionFailure } from '../../lib/decisionGate'
import { ago } from '../../lib/format'
import { useMe } from '../../lib/useAdmin'
import { errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'

/** How long a grant lasts; the host clamps to 5..1440 minutes (services.py grant). */
export const GRANT_TTLS: { minutes: number; label: string }[] = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 120, label: '2 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 1440, label: '24 hours (the most)' },
]

/** One line for a grant's standing. Pure. */
export function grantLine(g: Pick<GoalGrant, 'active' | 'revoked_at' | 'expires_at' | 'scope'>, now = Date.now()): string {
  if (g.revoked_at) return `${g.scope}, revoked ${ago(g.revoked_at, now)}`
  if (!g.active || g.expires_at * 1000 <= now) return `${g.scope}, expired`
  return `${g.scope}, until ${new Date(g.expires_at * 1000).toLocaleString()}`
}

/**
 * Who can be given code access here. The hive opens a task's code (POST /api/code/capability and the Code proxy)
 * for admins only for now, so a grant given to a member could not be used. Only enabled admins are offered. Pure.
 */
export function grantRecipients<P extends Pick<Person, 'role' | 'disabled'>>(people: readonly P[]): P[] {
  return people.filter((p) => !p.disabled && p.role === 'admin')
}

/** What each choice of access lets the person do. The hive enforces it: a read grant cannot change code (grant_scope). */
export const SCOPE_WORDS: Record<'edit' | 'read', string> = {
  edit: 'Edit: read, propose and change the task’s code workspace',
  read: 'Read: look, never change. The hive refuses any change made with it.',
}

/**
 * The Give action, bound to the identity it was pressed under (r5, stand-in r4 P1): the grant's answer is written
 * (onDone, the toast) only if the same person is still signed in, checked in the same tick as the write.
 */
export function giveGrantRun(d: { client: HiveClient | null; goalId: string; person: Pick<Person, 'id' | 'name'> | undefined; scope: 'edit' | 'read'; minutes: number; onDone: (g: GoalGrant) => void; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    const chosen = d.person
    if (!chosen) return 'Choose a person.'
    try {
      const g = await need(d.client, 'addGoalGrant', 'Giving code access')(d.goalId, grantBody(chosen.id, d.scope, d.minutes))
      binding.commit(() => {
        d.onDone(g)
        d.toast({ tone: 'success', icon: 'terminal', title: `${chosen.name} was given ${g.scope === 'read' ? 'read-only' : g.scope} code access`, body: grantLine(g) })
      })
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

/** The body sent for a choice; the principal is always a person (user:<id>), as the host requires. Pure. */
export function grantBody(personId: string, scope: 'edit' | 'read', minutes: number): AddGoalGrantBody {
  return { principal: `user:${personId}`, scope, ttl_minutes: Math.max(5, Math.min(1440, Math.round(minutes))) }
}

/**
 * Code access on a task, in the task's detail (GET and POST /api/goals/{id}/grants, the host route keeps its backend
 * name; Surface missing-UI batch 1 r2, audit item 12). Anyone who sees the task sees who holds access; only an admin
 * gives access, decided in full view. Only admins can be given it: the hive opens a task's code for admins only for
 * now, so a member's grant would not work (r4, stand-in r3 item 2). A read grant only lets its holder look; the hive
 * refuses a change made with it (403 grant_scope, platform bfbb100). (A person's code capability itself, POST /api/code/capability,
 * is not shown: reading it would mint a live key; see the batch's review request.)
 */
export function TaskCodeAccess({ task: goal }: { task: Goal }) {
  const client = useHive((s) => s.client)
  const [open, setOpen] = useState(false)
  if (!has(client, 'goalGrants')) return null
  return (
    <div className="rounded-lg border border-line bg-shade/20 px-2.5 py-1.5 text-[11.5px]" data-task-code-access>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1 text-left text-ink-4 hover:text-ink-2">
        <span className="flex-1">Who has code access to this task</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <GrantList goal={goal} />}
    </div>
  )
}

function GrantList({ goal }: { goal: Goal }) {
  const client = useHive((s) => s.client)
  const { admin } = useMe()
  const res = useResource(() => need(client, 'goalGrants', 'Code access')(goal.id), { context: goal.id })
  const [giving, setGiving] = useState(false)
  return (
    <div className="mt-1 space-y-1">
      {res.status === 'loading' ? (
        <span className="text-ink-4">Loading…</span>
      ) : res.status === 'error' ? (
        <span className="text-bad">{errorMessage(res.error)}</span>
      ) : res.status === 'empty' || !res.data?.length ? (
        <span className="text-ink-4">Nobody holds code access to this task.</span>
      ) : (
        <ul className="space-y-0.5">
          {res.data.map((g) => (
            <li key={g.id} className={g.active ? 'text-ink-2' : 'text-ink-4'}>
              {g.principal.replace(/^user:/, '')} · {grantLine(g)} · given by {g.created_by.replace(/^user:/, '')}
            </li>
          ))}
        </ul>
      )}
      {admin && has(client, 'addGoalGrant') && (
        <button type="button" onClick={() => setGiving(true)} className="block text-left text-accent hover:text-ink">
          Give a person code access…
        </button>
      )}
      <AnimatePresence>{giving && <GiveGrant goal={goal} onClose={() => setGiving(false)} onDone={(g) => res.mutate((l) => [...(l ?? []), g])} />}</AnimatePresence>
    </div>
  )
}

function GiveGrant({ goal, onClose, onDone }: { goal: Goal; onClose: () => void; onDone: (g: GoalGrant) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const people = useResource(() => need(client, 'listPeople', 'People')(), { isEmpty: () => false })
  const [person, setPerson] = useState('')
  const [scope, setScope] = useState<'edit' | 'read'>('edit')
  const [minutes, setMinutes] = useState(120)
  const list: Person[] = grantRecipients(people.data?.people ?? [])
  const chosen = list.find((p) => p.id === person)
  return (
    <DecisionDialog
      icon="terminal"
      eyebrow="Code access"
      title={chosen ? `Give ${chosen.name} ${scope} access to “${goal.title}”?` : `Give a person code access to “${goal.title}”?`}
      facts={[
        ['Task', `${goal.title} (${goal.id})`],
        ['Person', chosen ? `${chosen.name} <${chosen.email}> (user:${chosen.id})` : 'not chosen yet'],
        ['Who can be given it', 'Admins only. The hive opens a task’s code for admins only for now, so a member could not use it.'],
        ['Access', SCOPE_WORDS[scope]],
        ['Lasts', GRANT_TTLS.find((t) => t.minutes === minutes)?.label ?? plural(minutes, 'minute')],
        ['Undo', 'Revoke it any time from Code; every call made with it is refused from then on.'],
      ]}
      bound={{ kind: 'ready' }}
      thing="This grant"
      onClose={onClose}
      actions={[
        {
          label: 'Give access',
          busyLabel: 'Giving',
          tone: 'primary',
          blocked: chosen ? null : 'Choose a person.',
          // r5: bound to the identity it was pressed under; a late answer writes nothing for a newer person
          run: giveGrantRun({ client, goalId: goal.id, person: chosen, scope, minutes, onDone, toast }),
        },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">Person (admins only)</span>
        <select value={person} onChange={(e) => setPerson(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
          <option value="">{people.status === 'loading' ? 'Loading people…' : list.length ? 'Choose an admin' : 'No enabled admin to choose'}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.email})
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-wrap gap-3 text-[13px] text-ink-2">
        <legend className="mb-1 text-[12px] text-ink-3">Access</legend>
        {(['edit', 'read'] as const).map((s) => (
          <label key={s} className="inline-flex items-center gap-1.5">
            <input type="radio" name="grant-scope" checked={scope === s} onChange={() => setScope(s)} /> {s === 'edit' ? 'Edit' : 'Read only'}
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="text-[12px] text-ink-3">For</span>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
          {GRANT_TTLS.map((t) => (
            <option key={t.minutes} value={t.minutes}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    </DecisionDialog>
  )
}
