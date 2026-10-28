import { AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { GoalGrant } from '../../api/types'
import { boundNote } from '../../lib/decisionGate'
import { localWhen } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { navigate } from '../../lib/router'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Page } from '../../ui/Page'
import { Button, EmptyState } from '../../ui/primitives'
import type { Opened, Target } from './CodePage'
import { closedReason, grantBound, grantRead, grantSeenOf, grantStanding, judgeSaved, notEditable, notEditableText, originLabel, revocableGrant, savedIdentity, targetBound, targetOpenable, targetSeenOf, type NotEditable, type Origin } from './editSessionRules'
import { dropSessionIf, readSession, saveSession, sessionKey } from './savedSession'

/**
 * Surface request H (G1, G3, G4): which task and edit grant the Code workbench uses, said in plain words, and the two
 * deliberate controls around it: "Start a new edit task" (POST /api/code/open, which always makes a new task and grant)
 * and "Stop editing: revoke my edit grant" (DELETE /api/goals/{task}/grants/{grant}). Both go through DecisionDialog.
 * Reusing the task saved in this browser is a choice on the start screen, never automatic.
 *
 * Surface request L: the saved session is kept per principal and target (savedSession.ts) and is offered only after its
 * grant is checked (judgeSaved); a target that cannot be opened says why and offers nothing; a 409 not_editable
 * (next10) or 403 repository_unregistered (live 0aa6330) says the repository isn't editable in the hive.
 *
 * Surface L1: the grant lookup is bound to the client, the principal, the target and the saved task AND grant
 * (useResource context). Its answer, success or failure, is used only for that identity: while the lookup for a new
 * identity is pending the page says "checking" and neither offers reuse nor forgets anything on an older answer. The
 * entry is forgotten only on a definite judgement made for the current identity, and only if storage still holds that
 * same task and grant (dropSessionIf). Policy: a definite judgement (the grant is missing, revoked, ended, another
 * sign-in's, or the task is gone) forgets the entry whether or not the target can be opened right now; a target that
 * cannot be opened keeps an entry only while its grant is still good or cannot be checked.
 *
 * Only this start screen checks the grant before offering reuse. The task and repository routes (CodePage) read the
 * principal-keyed entry and rely on the hive refusing a stale grant (handled there); they are not checked beforehand.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const mono = (s: string) => <span className="font-mono text-[12px]">{s}</span>

/** The signed-in principal: undefined while it is read, null when it cannot be read (nothing saved is then offered). */
const missingAuthContext = Object.freeze({})
const noAuthSubscription = () => () => undefined

/** Host identity plus local change detection. A local handle is never the session reference. */
export function useCodeIdentity(): { principal: string | null; personSession: string | null } | undefined {
  const client = useHive((s) => s.client)
  const context = useSyncExternalStore(client?.onAuthChange ?? noAuthSubscription,
    client?.authContext ?? (() => missingAuthContext), () => missingAuthContext)
  const [identity, setIdentity] = useState<{ client: unknown; context: object; principal: string | null; personSession: string | null } | null>(null)
  useEffect(() => {
    let live = true
    if (!client?.me) return
    void client.me().then((m) => {
      if (!live || (client.authContext && client.authContext() !== context)) return
      const principal = typeof m?.principal === 'string' && m.principal ? m.principal : null
      const personSession = client.authContext && client.onAuthChange && principal && typeof m?.auth_session_ref === 'string' && /^as1_[a-f0-9]{64}$/.test(m.auth_session_ref) ? m.auth_session_ref : null
      setIdentity({ client, context, principal, personSession })
    }, () => {
      if (live && (!client.authContext || client.authContext() === context)) setIdentity({ client, context, principal: null, personSession: null })
    })
    return () => { live = false }
  }, [client, context])
  if (!client?.me) return { principal: null, personSession: null }
  return identity && identity.client === client && identity.context === context ? identity : undefined
}

export function usePrincipal(): string | null | undefined {
  return useCodeIdentity()?.principal
}

/** The page shown instead of the workbench when the repository isn't editable in the hive. */
export function NotEditableState({ refusal, label, made }: { refusal: NotEditable; label: string; made?: { task_id: string; grant_id: string } | null }) {
  const t = notEditableText(refusal, label, made)
  return (
    <div role="alert" aria-label="Not editable in the hive">
      <EmptyState icon="ban" title={t.title} body={t.body} action={<Button onClick={() => navigate({ name: 'code' })}>Back to the targets list</Button>} />
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ start screen

/**
 * #/code/<target> before anything is open: reuse the saved task (deliberately, and only once its grant checks out) or
 * start a new one (confirmed). `notice` is why the workbench came back here (its grant was refused).
 */
export function StartEditing({ targetId, notice, onOpened }: { targetId: string; notice?: string | null; onOpened: (o: Opened, origin: Origin) => void }) {
  const client = useHive((s) => s.client)
  const principal = usePrincipal()
  // the targets list (or why it did not load) belongs to the client it was read through
  const clientCtx = readContext(client)
  const [targetsRead, setTargets] = useState<Tagged<{ targets: Target[] } | { err: string }> | null>(null)
  const targetsNow = taggedFor(targetsRead, clientCtx)
  const targets = targetsNow && 'targets' in targetsNow ? targetsNow.targets : null
  const err = targetsNow && 'err' in targetsNow ? targetsNow.err : null
  const [refused, setRefused] = useState<NotEditable | null>(null)
  const [checks, setChecks] = useState(0)
  // the entry is read again on "Check again" and when another tab replaces it
  const [stored, setStored] = useState(0)
  useEffect(() => {
    if (!principal) return
    const k = sessionKey(principal, targetId)
    const on = (e: StorageEvent) => {
      if (e.key === k || e.key === null) setStored((n) => n + 1)
    }
    window.addEventListener('storage', on)
    return () => window.removeEventListener('storage', on)
  }, [principal, targetId])
  // read once the principal is known: only this principal's session for this target is ever read
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `checks` and `stored` are re-read triggers
  const saved = useMemo(() => (principal === undefined ? null : readSession(principal, targetId)), [principal, targetId, checks, stored])
  const [asking, setAsking] = useState(false)
  const now = useNow(30_000) / 1000
  useEffect(() => {
    let live = true
    const ctx = readContext(client)
    void client?.codeTargets?.().then((t) => live && setTargets({ ctx, value: { targets: t } })).catch((e) => live && setTargets({ ctx, value: { err: errText(e) } }))
    return () => { live = false }
  }, [client])
  // Surface L1: the grant lookup, bound to client + principal + target + saved task and grant (success and failure alike)
  const lookup = useResource(() => (saved ? need(client, 'goalGrants', 'Grant lookup')(saved.task_id) : Promise.resolve(null)), {
    context: savedIdentity(principal, targetId, saved),
    key: checks,
    isEmpty: () => false,
  })
  const target = targets?.find((t) => t.id === targetId)
  const read = saved ? grantRead(lookup) : null
  const judged = saved ? judgeSaved(saved, read, principal, now, localWhen) : null
  // a definite "no" for the current identity: this browser forgets that exact entry (the page keeps saying why)
  const dropped = saved && judged?.kind === 'drop' ? { task_id: saved.task_id, grant_id: saved.grant_id, why: judged.why } : null
  const droppedTask = dropped?.task_id
  const droppedGrant = dropped?.grant_id
  useEffect(() => {
    if (droppedTask && droppedGrant) dropSessionIf(principal, targetId, { task_id: droppedTask, grant_id: droppedGrant })
  }, [droppedTask, droppedGrant, principal, targetId])
  const openable = target ? targetOpenable(target) : false
  const offer = openable && judged?.kind === 'offer' ? judged.grant : null
  const reuse = () => {
    if (!saved || !target || !offer) return
    onOpened({ target, task_id: saved.task_id, grant_id: saved.grant_id, repository_id: saved.repository_id, swarm_id: saved.swarm_id ?? '', base_commit: saved.base_commit ?? target.repo?.commit ?? '' }, 'reused')
  }
  const reason = target ? closedReason(target) : null
  const droppedNote = dropped && (
    <p role="status" aria-label="Saved task not offered" className="rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
      {dropped.why} This browser has forgotten task {mono(dropped.task_id)}; it is still in Tasks.
    </p>
  )
  return (
    <Page title={target?.label ?? 'Code'} eyebrow="Code · choose how to edit" label="Start editing" onBack={() => navigate({ name: 'code' })} onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 md:px-6" aria-label="How to edit">
        {err ? <EmptyState icon="alert" title="Targets did not load" body={err} />
          : !targets ? <p className="text-[13px] text-ink-4">Loading…</p>
          : !target ? <EmptyState icon="alert" title="No such edit target" body={targetId} />
          : refused ? <NotEditableState refusal={refused} label={target.label} />
          : !openable ? (
            <>
              <div role="status" aria-label="Cannot be edited here">
                <EmptyState icon="ban" title={reason ? 'This repository isn’t editable in the hive' : 'This target cannot be opened for editing'} body={reason ? `${target.label} can’t be opened for editing: ${reason}. Nothing is offered here.` : `${target.label} can’t be opened for editing now (${target.private ? `private: ${target.owner} has to agree first` : 'not under source control'}).`} action={<Button onClick={() => navigate({ name: 'code' })}>Back to the targets list</Button>} />
              </div>
              {/* a definite grant judgement applies here too: say that the entry was forgotten */}
              {droppedNote}
            </>
          )
          : (
            <>
              <p className="text-[13px] leading-relaxed text-ink-2">
                Edits happen on a task, with an edit grant for you. Nothing is created until you choose{offer ? ': reuse the task this browser saved, or start a new one' : ''}.
              </p>
              {notice && (
                <p role="status" aria-label="Why the workbench closed" className="rounded-lg border border-bad/30 bg-bad/[0.07] px-3 py-2 text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
                  <span className="font-semibold text-bad">The hive refused the edit grant this workbench was using.</span> {notice} This browser has forgotten that task. Start a new edit task to edit.
                </p>
              )}
              {droppedNote}
              {saved && !dropped && judged && (
                <section aria-label="Saved in this browser" className="space-y-2 rounded-2xl border border-line bg-white/[0.03] p-4">
                  <h2 className="eyebrow">Saved in this browser</h2>
                  <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
                    <dt className="text-ink-3">Task</dt><dd className="break-all">{mono(saved.task_id)}</dd>
                    <dt className="text-ink-3">Grant</dt><dd className="break-all">{mono(saved.grant_id)}</dd>
                    {saved.saved_at && <><dt className="text-ink-3">Saved</dt><dd>{localWhen(saved.saved_at)}</dd></>}
                    <dt className="text-ink-3">Grant now</dt>
                    <dd>{judged.kind === 'offer' ? `yours, active until ${localWhen(new Date(judged.grant.expires_at * 1000).toISOString())}` : judged.kind === 'unchecked' ? 'could not be checked' : 'checking…'}</dd>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {offer ? <Button icon="reset" onClick={reuse}>Reuse task {saved.task_id}</Button>
                      : judged.kind === 'unchecked' ? <><span className="text-[12px] text-ink-3">{judged.why}</span><Button onClick={() => setChecks((n) => n + 1)}>Check again</Button></>
                      : <span className="text-[12px] text-ink-3">Checking its edit grant before offering it…</span>}
                  </div>
                </section>
              )}
              <section aria-label="Start a new edit task" className="space-y-2 rounded-2xl border border-line bg-white/[0.03] p-4">
                <h2 className="eyebrow">New task</h2>
                <p className="text-[12.5px] text-ink-3">The hive makes a new task “Edit code: {target.label}” and a new 12-hour edit grant for you. You confirm it first.</p>
                <Button variant="primary" icon="plus" onClick={() => setAsking(true)}>Start a new edit task</Button>
              </section>
            </>
          )}
      </div>
      {/* never for a target that cannot be opened, or once the hive said it isn't editable */}
      <AnimatePresence>{asking && target && openable && !refused && <StartTaskDialog target={target} principal={principal} current={saved && offer ? { task_id: saved.task_id, grant_id: saved.grant_id, inUse: false } : null} onStarted={(o) => onOpened(o, 'new')} onRefused={(r) => { setRefused(r); setAsking(false) }} onClose={() => setAsking(false)} />}</AnimatePresence>
    </Page>
  )
}

// ------------------------------------------------------------------------------------------------ start dialog

/** Confirm a fresh POST /api/code/open with everything it does (hive/core/code.py:221-232 at 60fa650). */
export function StartTaskDialog({ target, principal, current, onStarted, onRefused, onClose }: { target: Target; principal: string | null | undefined; current: { task_id: string; grant_id: string; inUse: boolean } | null; onStarted: (o: Opened) => void; onRefused?: (r: NotEditable) => void; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const snap = useMemo(() => targetSeenOf(target), [target])
  const [live, setLive] = useState(snap)
  const [sending, setSending] = useState(false)
  const bound = sending ? ({ kind: 'ready' } as const) : targetBound(snap, live)
  return (
    <DecisionDialog
      icon="plus"
      eyebrow="Code · new edit task"
      title={`Start a new edit task on “${target.label}”?`}
      facts={[
        ['Target', <>{target.label} ({mono(target.id)})</>],
        ['Repository', mono(target.repository_id)],
        ['Base commit', mono(target.repo?.commit ?? 'unknown')],
        ['The hive creates', `A new task “Edit code: ${target.label}” in the hive's Code swarm. Like any new task, the swarm's awake minds are told about it and may claim it.`],
        ['Your access', 'A new edit grant for you on that task, for 12 hours. Its ID is shown as soon as the task starts.'],
        [current?.inUse ? 'In use now' : 'Saved in this browser', current ? <>Task {mono(current.task_id)} with grant {mono(current.grant_id)}. It is not changed or revoked; this browser stops using it. Revoke and cancel it separately when you are done with it.</> : 'Nothing: this is the first task for this target here.'],
        ['Afterwards', 'A task cannot be deleted. When you are done, revoke the grant here (Stop editing), then cancel the task in Tasks.'],
      ]}
      bound={bound}
      thing="This target"
      actions={[
        {
          label: 'Start the new task',
          busyLabel: 'Starting',
          tone: 'primary',
          run: async () => {
            if (!client?.codeOpen || !client.codeTargets) return 'This hive cannot open code here.'
            // the target, read again at the moment of dispatch
            const fresh = (await client.codeTargets()).find((t) => t.id === target.id)
            const now = fresh ? targetSeenOf(fresh) : undefined
            const drift = boundNote(targetBound(snap, now), 'This target')
            if (drift) {
              if (now) setLive(now)
              return drift
            }
            setSending(true)
            try {
              const o = await client.codeOpen(target.id)
              const opened: Opened = { ...o, target: fresh ?? target }
              saveSession(principal, target.id, opened, true)
              onStarted(opened)
              return true
            } catch (e) {
              setSending(false)
              // 409 not_editable (next10): refused before any task or grant; say so where the person can act on it
              const r = notEditable(e)
              if (r && onRefused) {
                onRefused(r)
                return true
              }
              if (r) return notEditableText(r, target.label).body
              throw e
            }
          },
        },
      ]}
      onClose={onClose}
    />
  )
}

// ------------------------------------------------------------------------------------------------ session bar

/**
 * The line above the workbench: task, grant, workspace and generation in full, where they came from, and the person's
 * controls. The revoke control is offered only for the viewer's own active grant (revocableGrant); the hive checks.
 */
export function SessionBar({ opened, origin, ws, onStartNew, onRevoked }: { opened: Opened; origin: Origin; ws: { id: string; generation: number } | null; onStartNew?: () => void; onRevoked?: () => void }) {
  const client = useHive((s) => s.client)
  // Surface L1 audit: the grants and the principal belong to the client and task they were read for
  const ctx = readContext(client, opened.task_id, opened.grant_id)
  const [grantsRead, setGrantsRead] = useState<Tagged<GoalGrant[]> | null>(null)
  const [principalRead, setPrincipal] = useState<Tagged<string | null> | null>(null)
  const grants = taggedFor(grantsRead, ctx)
  const principal = taggedFor(principalRead, ctx)
  const setGrants = (fn: (gs: GoalGrant[] | null) => GoalGrant[]) => setGrantsRead((cur) => ({ ctx, value: fn(taggedFor(cur, ctx)) }))
  const [asking, setAsking] = useState<GoalGrant | null>(null)
  const now = useNow(30_000) / 1000
  const refresh = useCallback(async () => {
    if (!client?.goalGrants) throw new Error('this hive does not list grants')
    const asked = readContext(client, opened.task_id, opened.grant_id)
    const gs = await client.goalGrants(opened.task_id)
    setGrantsRead({ ctx: asked, value: gs })
    return gs
  }, [client, opened.task_id, opened.grant_id])
  useEffect(() => {
    let live = true
    const asked = readContext(client, opened.task_id, opened.grant_id)
    void client?.me?.().then((m) => live && setPrincipal({ ctx: asked, value: typeof m?.principal === 'string' ? m.principal : null }), () => undefined)
    void client?.goalGrants?.(opened.task_id).then((gs) => live && setGrantsRead({ ctx: asked, value: gs }), () => undefined)
    return () => { live = false }
  }, [client, opened.task_id, opened.grant_id])
  const mine = client?.revokeGoalGrant ? revocableGrant(grants, opened, principal, now) : null
  const standing = grantStanding(grants?.find((g) => g.id === opened.grant_id), now)
  return (
    <div className="space-y-1.5 border-b border-line p-2" aria-label="Edit session">
      <div className="break-all font-mono text-xs text-ink-3">
        Task {opened.task_id} · Grant {opened.grant_id} · Workspace {ws?.id ?? '…'} · Generation {ws?.generation ?? '…'}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="min-w-0 basis-full text-ink-2 [overflow-wrap:anywhere] md:basis-0 md:flex-1" aria-label="Where this task came from">{originLabel(origin, opened.task_id)}</span>
        {mine && (
          <Button icon="ban" onClick={() => setAsking(mine)} className="min-h-9 px-3 text-[12.5px]">
            Stop editing: revoke my edit grant
          </Button>
        )}
        {onStartNew && (
          <Button icon="plus" onClick={onStartNew} className="min-h-9 px-3 text-[12.5px]">
            Start a new edit task
          </Button>
        )}
      </div>
      {standing && (
        <p role="status" aria-label="Edit grant revoked" className="rounded-lg border border-bad/30 bg-bad/[0.07] px-2.5 py-1.5 text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
          <span className="font-semibold text-bad">{standing.kind === 'revoked' ? `Your edit grant was revoked (${localWhen(standing.at)}).` : 'Your edit grant has expired.'}</span>{' '}
          Grant {mono(opened.grant_id)} no longer works: the hive refuses every call made with it (grant_invalid), so reading, proposing and deciding here are refused. Nothing else changed: task {mono(opened.task_id)} is still open (cancel it in Tasks), and its workspace and records stay with OmegaCode.{onStartNew ? ' To edit again, start a new edit task.' : ''}
        </p>
      )}
      <AnimatePresence>
        {asking && <RevokeGrantDialog grant={asking} refresh={refresh} onRevoked={(g) => { setGrants((gs) => (gs ?? []).map((x) => (x.id === g.id ? g : x))); onRevoked?.() }} onClose={() => setAsking(null)} />}
      </AnimatePresence>
    </div>
  )
}

/** G1: revoke exactly this grant, on exactly this task, as inspected. */
function RevokeGrantDialog({ grant, refresh, onRevoked, onClose }: { grant: GoalGrant; refresh: () => Promise<GoalGrant[]>; onRevoked: (g: GoalGrant) => void; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const snap = useMemo(() => grantSeenOf(grant), [grant])
  const [live, setLive] = useState<GoalGrant | undefined>(grant)
  const [sending, setSending] = useState(false)
  const now = useNow(5_000) / 1000
  // the live record, re-read while the dialog is open: a grant revoked or changed elsewhere refuses here
  useEffect(() => {
    const t = setInterval(() => void refresh().then((gs) => setLive(gs.find((g) => g.id === grant.id)), () => undefined), 4_000)
    return () => clearInterval(t)
  }, [refresh, grant.id])
  const bound = sending ? ({ kind: 'ready' } as const) : grantBound(snap, live, now)
  return (
    <DecisionDialog
      icon="ban"
      eyebrow="Edit grant · active → revoked"
      title={<>Stop editing: revoke your edit grant on task {grant.goal_id}?</>}
      facts={[
        ['Task', mono(grant.goal_id)],
        ['Grant', mono(grant.id)],
        ['Held by', <>{mono(grant.principal)} (you)</>],
        ['Access', grant.scope === 'edit' ? 'Edit' : 'Read'],
        ['Workspace', grant.workspace_id ? mono(grant.workspace_id) : 'Any workspace of this task'],
        ['Valid until', localWhen(new Date(grant.expires_at * 1000).toISOString())],
        ['What changes', 'The hive marks this grant revoked and withdraws every code capability issued under it. From then on every call made with it (read, list, propose, decide) is refused (grant_invalid) before it reaches OmegaCode. A revoked grant cannot be restored.'],
        ['What stays', 'The task stays open: cancel it in Tasks. The workspace, scopes, suggestions, decisions and ChangeSets stay in OmegaCode as they are.'],
      ]}
      bound={bound}
      thing="This grant"
      actions={[
        {
          label: 'Revoke my edit grant',
          busyLabel: 'Revoking',
          tone: 'danger',
          run: async () => {
            if (!client?.revokeGoalGrant) return 'This hive cannot revoke grants from here.'
            // the same binding, read again at the moment of dispatch
            let fresh: GoalGrant | undefined
            try {
              fresh = (await refresh()).find((g) => g.id === grant.id)
            } catch (e) {
              return `Could not re-read the grant first (${errText(e)}).`
            }
            const drift = boundNote(grantBound(snap, fresh, Date.now() / 1000), 'This grant')
            if (drift) {
              setLive(fresh)
              return drift
            }
            setSending(true)
            try {
              const r = await client.revokeGoalGrant(grant.goal_id, grant.id)
              if (r.id === grant.id && r.revoked_at && !r.active) {
                onRevoked(r)
                return true
              }
              setSending(false)
              return 'The hive did not revoke it.'
            } catch (e) {
              setSending(false)
              throw e
            }
          },
        },
      ]}
      onClose={onClose}
    />
  )
}
