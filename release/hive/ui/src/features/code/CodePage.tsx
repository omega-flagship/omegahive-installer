import { useIdentityEpoch } from '../../lib/epochBound'
import type { EmbeddedDepartureHandle } from './embeddedDeparture'
import { CODE_TEST_UNAVAILABLE } from './testIntent'
import { plural } from '../../lib/plural'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { AnimatePresence, m } from 'framer-motion'
import { lazy, Suspense, useLayoutEffect, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import { cx } from '../../lib/cx'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { localWhen } from '../../lib/format'
import { closeToHome, navigate } from '../../lib/router'
import { codeView, type CodeRoute } from './codeView'
import { useHive } from '../../store/store'
import { useUnsaved } from '../ask/dirty'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState, Skeleton } from '../../ui/primitives'
import { LiveWork } from './LiveWork'
import { EvidenceHistory, RunOutput } from './EvidenceHistory'
import { GitExportPanel } from './GitExportPanel'
import { MergePanel } from './MergePanel'
import { SymbolicPanel } from './SymbolicPanel'
import { DebuggerPanel } from './DebuggerPanel'
import { SourceReview } from './SourceReview'
import { FileActions } from './FileActions'
import type { Candidate } from './fileOperations'
import { commandArgs, liveRunStatus } from './commandArgs'
import { WorkbenchSuggestionPanel } from './suggestions/WorkbenchSuggestionPanel'
import { ProjectTestEvidencePanel } from './suggestions/ProjectTestEvidencePanel'
import type { EvidenceCall, EvidenceSubject } from './suggestions/projectTestEvidence'
import type { WorkspaceHead } from './suggestions/contract'
import { NotEditableState, SessionBar, StartEditing, StartTaskDialog, usePrincipal } from './EditSession'
import { closedReason, grantRefused, judgeSaved, notEditable, targetOpenable, type NotEditable, type Origin } from './editSessionRules'
import { dropSessionIf, readSession, readWorkspace, saveSession, saveWorkspaceFor } from './savedSession'
import { KIND, TargetCard } from './TargetCard'
import { confirmEmbeddedDeparture } from './embeddedDeparture'
import { bindEpoch } from '../../lib/identityEpoch'
import { useAskTurn } from './canvas/askBridge'
import { requestCodeTest, resumeCodeTest, type CodeTestOutcome } from './testIntent'
import { newDraftOwner, retainEmbeddedDraft, forgetEmbeddedDraft, type DraftOwner } from './embeddedDrafts'
import { CodeCanvas, type DrawerTab } from './canvas/CodeCanvas'
import { ReviewSettingRow } from './canvas/work/ReviewSettingRow'


export interface Target {
  id: string
  kind: 'hive' | 'program' | 'mind' | 'service' | 'repository'
  label: string
  detail: string
  source: string | null
  repository_id: string
  repo: { root: string; commit: string | null; branch: string | null; dirty: boolean; subdir: string } | null
  owner: string
  private: boolean
  built_in?: boolean
  mind?: { id: string; hue: number; status: 'awake' | 'asleep' | 'starting' | 'created' | 'stopped' | 'error' }
  apply: { how: string; ready: boolean; note: string }
  openable?: boolean
  /** Platform next10 (51a7ccc): why it cannot be opened for editing, in plain words, or null. Absent on live 0aa6330. */
  closed_reason?: string | null
}
export interface Opened {
  target: Target
  task_id: string
  swarm_id: string
  grant_id: string
  repository_id: string
  base_commit: string
  workspace_id?: string
}
interface Workspace {
  id: string
  generation: number
  tree_digest: string
  base_commit: string
}

const MapView = lazy(() => import('./map/MapView'))

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * #/code and #/code/<target>: everything running in the hive, and its code. `route` is the route this page was opened
 * for (App passes it): a leaving copy keeps showing what it showed and never renders the next route (codeView.ts).
 */
export default function CodePage({ route }: { route: CodeRoute }) {
  const view = codeView(route)
  return (
    <>
      {view.kind === 'map' ? <Suspense fallback={null}><MapView repo={view.repo} sha={view.sha} /></Suspense>
        : view.kind === 'attach' ? <Workbench key={view.workspace} targetId={`repo:${view.repository}`} attachment={view} />
        : view.kind === 'select' ? <Workbench key={`${view.task}-${view.repository}`} targetId={`repo:${view.repository}`} attachment={view} />
        : view.kind === 'choose' ? <ChooseTarget task={view.task} />
        : view.kind === 'target' ? <TargetEdit key={view.target} targetId={view.target} /> : <CodeTargets />}
      <ConfirmHost />
    </>
  )
}

/** #/code?task=g_…: an existing task with no edit target yet. The person chooses where to edit; the task itself is not changed. */
function ChooseTarget({ task }: { task: string }) {
  const goal = useHive((s) => s.goals[task])
  const { targets, err } = useTargets()
  const repos = (targets ?? []).filter((t) => t.kind === 'repository' && targetOpenable(t))
  const closed = (targets ?? []).filter((t) => t.kind === 'repository' && closedReason(t))
  return (
    <Page title="Choose where to edit" eyebrow="Code · existing task" label="Choose an edit target" onBack={() => navigate({ name: 'code' })} onClose={() => navigate({ name: 'hive' })}>
      <div className="space-y-3 px-4 py-4 md:px-6">
        <p className="text-[13px] text-ink-2">
          This task has no edit target yet{goal ? <>: <span className="text-ink">{goal.title}</span></> : <> (<span className="font-mono">{task}</span>)</>}. Pick the repository to edit. The task stays exactly as it is; only your own edit access to it is added.
        </p>
        {err ? <EmptyState icon="alert" title="Targets did not load" body={err} />
          : !targets ? <p className="text-[13px] text-ink-4">Loading targets…</p>
          : repos.length === 0 && closed.length === 0 ? <EmptyState icon="doc" title="No repositories are registered for coding" body="An admin registers repositories before a task can be edited here." />
          : (
            <ul className="space-y-2">
              {repos.map((t) => (
                <li key={t.id} className="flex items-center gap-3 rounded-xl border border-line bg-tint/[0.025] px-3 py-2.5">
                  <div className="min-w-0 flex-1"><div className="truncate text-[14px] text-ink">{t.label}</div><div className="truncate text-[11.5px] text-ink-3">{t.detail}</div></div>
                  <Button variant="primary" onClick={() => navigate({ name: 'code', task, repository: t.repository_id })}>Edit here</Button>
                </li>
              ))}
              {/* request L: a repository the hive cannot edit stays listed and says why, with nothing to press */}
              {closed.map((t) => (
                <li key={t.id} className="rounded-xl border border-line bg-tint/[0.015] px-3 py-2.5">
                  <div className="truncate text-[14px] text-ink-2">{t.label}</div>
                  <div className="text-[11.5px] text-ink-3 [overflow-wrap:anywhere]">Can’t be edited here: {closedReason(t)}.</div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Page>
  )
}

/** The edit targets, read through the current client; a list (or failure) read through another client is not shown (Surface K1/L1 audit). */
function useTargets(): { targets: Target[] | null; err: string | null } {
  const client = useHive((s) => s.client)
  const epoch = useIdentityEpoch()
  const [read, setRead] = useState<Tagged<{ targets: Target[] | null; err: string | null }> | null>(null)
  useEffect(() => {
    let live = true
    const ctx = readContext(client, epoch)
    void client?.codeTargets?.().then((t) => live && setRead({ ctx, value: { targets: t, err: null } })).catch((e) => live && setRead({ ctx, value: { targets: null, err: errText(e) } }))
    return () => { live = false }
  }, [client, epoch])
  return taggedFor(read, readContext(client, epoch)) ?? { targets: null, err: null }
}

export function CodeTargets({ embedded = false, onSelect }: { embedded?: boolean; onSelect?: (id: string) => void } = {}) {
  const { targets, err } = useTargets()
  const groups = useMemo(() => {
    const by: Record<string, Target[]> = {}
    for (const t of targets ?? []) (by[t.kind] ??= []).push(t)
    return (['repository', 'hive', 'program', 'mind', 'service'] as const).filter((k) => by[k]?.length).map((k) => [k, by[k]] as const)
  }, [targets])
  const content = (
      <div className="mx-auto max-w-4xl space-y-8 px-4 pt-2 pb-12 md:px-6">
        <p className="max-w-2xl text-[13px] leading-relaxed text-ink-3">
          Open the code behind anything that runs here. Edits happen in an isolated copy pinned to the running revision; tests run on exactly what you changed; applying to the live thing is a separate, recorded step.
        </p>
        {!embedded && <LiveWork targets={targets} />}
        {err ? (
          <EmptyState icon="shield" title={embedded ? "Code projects did not load" : "Admins only"} body={err} />
        ) : !targets ? (
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : embedded && targets.length === 0 ? (
          <EmptyState icon="doc" title="No code projects are available here yet" body="This hive has not offered you an edit target. Its owner can register a project for coding." />
        ) : (
          groups.map(([kind, list]) => (
            <section key={kind}>
              <h2 className="eyebrow mb-3 flex items-center gap-2">
                <Icon name={KIND[kind].icon} size={13} /> {KIND[kind].label}
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {list.map((t) => (
                  <TargetCard key={t.id} t={t} onOpen={onSelect} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
  )
  return embedded ? <section aria-label="Code projects" className="h-full overflow-y-auto">{content}</section> : (
    <Page title="Code" eyebrow="Everything running in this hive" label="Code" onClose={() => navigate({ name: 'hive' })} actions={<Button variant="ghost" onClick={() => navigate({ name: 'code', map: '' })}><Icon name="graph" size={15} /> Repository map</Button>}>
      {content}
    </Page>
  )
}

// ---------------------------------------------------------------------------------------- workbench

/**
 * #/code/<target>: nothing opens on its own. The person reuses the task this browser saved (a deliberate choice) or
 * starts a new one through a confirm (StartEditing); POST /api/code/open always makes a new task and grant.
 */
function TargetEdit({ targetId }: { targetId: string }) {
  const [session, setSession] = useState<{ opened: Opened; origin: Origin } | null>(null)
  // request L: why the workbench came back to the start screen (the hive refused the grant it was using)
  const [notice, setNotice] = useState<string | null>(null)
  if (!session) return <StartEditing targetId={targetId} notice={notice} onOpened={(opened, origin) => { setNotice(null); setSession({ opened, origin }) }} />
  return <Workbench key={`${session.opened.task_id}:${session.opened.grant_id}`} targetId={targetId} initial={session} onStarted={(opened) => setSession({ opened, origin: 'new' })} onGrantRefused={(why) => { setNotice(why); setSession(null) }} />
}

export interface SandboxTestReferences {
  request_id: string
  proposal: { proposal_id: string; proposal_digest: string; normalized_hunks_digest: string }
  parent: { generation: number; tree_digest: string }
}
export type SandboxTestHandler = (what: string, selection?: { path: string; from: number; to: number }, retained?: SandboxTestReferences, current?: () => boolean) => Promise<void>
interface EditorDraft { path: string | null; file: { content: string; digest: string } | null; text: string }

export interface CodeWorkbenchProps {
  targetId: string
  attachment?: { task: string; workspace?: string; repository: string }
  initial?: { opened: Opened; origin: Origin }
  onStarted?: (o: Opened) => void
  onGrantRefused?: (why: string) => void
  /** Embedding changes navigation and available controls; it grants no backend authority. */
  embedded?: { onBack: () => void; onClose: () => void; onDraftRetained?: () => void; draftRecovery?: ReactNode; departure?: EmbeddedDepartureHandle }
  onSandboxTest?: SandboxTestHandler
  sandboxTestStatus?: ReactNode
  sandboxTestPanel?: ReactNode
  sandboxTestAvailable?: boolean
}

/** The existing sole task/grant/workspace controller, also used by EmbeddedCodeWorkbench. */
export function Workbench({ targetId, attachment, initial, onStarted, onGrantRefused, embedded, onSandboxTest, sandboxTestStatus, sandboxTestPanel, sandboxTestAvailable }: CodeWorkbenchProps) {
  const testSupport = useRef(false)
  testSupport.current = !embedded || sandboxTestAvailable === true
  const embeddedMode = !!embedded
  const sharedTask = attachment?.task
  const sharedWorkspace = attachment?.workspace
  const sharedRepository = attachment?.repository
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [opened, setOpened] = useState<Opened | null>(initial?.opened ?? null)
  const origin: Origin = initial?.origin ?? (sharedWorkspace ? 'joined' : 'selected')
  const [startingNew, setStartingNew] = useState(false)
  const [ws, setWs] = useState<Workspace | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  // request L: the repository isn't editable in the hive (409 not_editable, 403 repository_unregistered)
  const [unregistered, setUnregistered] = useState<NotEditable | null>(null)
  // request L: the hive refused this workbench's grant while there was an unsaved draft: say so, keep the draft
  const [grantGone, setGrantGone] = useState<string | null>(null)
  const principal = usePrincipal()
  const [files, setFiles] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [editor, setEditor] = useState<EditorDraft>({ path: null, file: null, text: '' })
  const { path, file, text } = editor
  const editorRef = useRef(editor)
  const draftOwner = useRef<DraftOwner | null>(null)
  const retainOnUnmount = useRef(true)
  const request = useRef(0)
  const live = useRef(true)
  const scope = useRef({ client, principal, opened, ws })
  scope.current = { client, principal, opened, ws }
  const contextNow = () => {
    const x = scope.current
    return readContext(x.client, x.principal, x.opened?.task_id, x.opened?.grant_id, x.ws?.id)
  }
  const renderContext = contextNow()
  const askTurn = useAskTurn({ openThread: !embedded })
  const [testRequest, setTestRequest] = useState<{ context: string; outcome: CodeTestOutcome; current: () => boolean } | null>(null)
  const testRequestRef = useRef<typeof testRequest>(null)
  const [testSubject, setTestSubject] = useState<{ context: string; proposal: SandboxTestReferences['proposal'] } | null>(null)
  const sandboxRequestPending = useRef(false)
  const [testNotice, setTestNotice] = useState<string | null>(null)
  const beginRead = () => live.current && renderContext === contextNow()
    ? { id: ++request.current, context: renderContext, draft: editorRef.current } : null
  type ReadTicket = NonNullable<ReturnType<typeof beginRead>>
  const sameRequest = (t: ReadTicket) => live.current && request.current === t.id && contextNow() === t.context
  const sameDraft = (t: ReadTicket) => sameRequest(t) && editorRef.current === t.draft
  const retained = () => {
    const d = editorRef.current
    if (retainOnUnmount.current && draftOwner.current && d.file && d.text !== d.file.content)
      retainEmbeddedDraft(draftOwner.current, d.text)
  }
  const writeEditor = (next: EditorDraft, loaded = false) => {
    if (loaded) {
      const x = scope.current
      draftOwner.current = embedded && x.client && x.principal && x.opened && x.ws && next.path
        ? newDraftOwner({ client: x.client, principal: x.principal, context: readContext(x.client, x.principal),
            task: x.opened.task_id, repository: x.opened.repository_id, workspace: x.ws.id, path: next.path }) : null
      retainOnUnmount.current = true
    }
    editorRef.current = next
    unsaved.current = !!next.file && next.text !== next.file.content
    departure.current = { path: next.path, text: next.text, dirty: unsaved.current }
    setEditor(next)
    if (draftOwner.current && next.file && next.text === next.file.content) forgetEmbeddedDraft(draftOwner.current)
    retained()
    if (embedded) embedded.onDraftRetained?.()
  }
  const changeText = (value: string) => {
    if (!live.current) return
    retainOnUnmount.current = true
    writeEditor({ ...editorRef.current, text: value })
  }
  const discardRetained = () => {
    if (draftOwner.current) forgetEmbeddedDraft(draftOwner.current)
    retainOnUnmount.current = false
    embedded?.onDraftRetained?.()
  }
  useEffect(() => {
    live.current = true
    return () => { retained(); live.current = false; ++request.current }
  }, [])
  const [busy, setBusy] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  const keyId = sharedTask ? `${targetId}@${sharedTask}` : targetId   // a chosen task never borrows another task's saved session
  const unsaved = useRef(false)
  const departure = useRef({ path, text, dirty: false })

  /**
   * request L: the hive refused this workbench's grant (grant_invalid). Unless the person revoked it here (request H keeps
   * those refusals on screen), the saved session is dropped and the start screen says why; an unsaved draft is never
   * thrown away: the page says so and waits.
   */
  const revokedHere = useRef(false)
  const refusedOnce = useRef(false)
  const onRefusal = useCallback(async (e: unknown, o: Opened) => {
    const owner = readContext(client, principal, o.task_id, o.grant_id, scope.current.ws?.id)
    if (!live.current || owner !== contextNow() || !grantRefused(e) || revokedHere.current || refusedOnce.current) return
    refusedOnce.current = true
    // forget exactly the session that was refused, never one that has replaced it since (Surface L1)
    if (!sharedWorkspace) dropSessionIf(principal, keyId, o)
    let why = `The hive refused its edit grant ${o.grant_id} (${(e as { code?: string }).code ?? 'grant_invalid'}).`
    try {
      const grants = client?.goalGrants ? await client.goalGrants(o.task_id) : undefined
      const j = judgeSaved({ task_id: o.task_id, grant_id: o.grant_id, repository_id: o.repository_id }, { grants }, principal ?? null, Date.now() / 1000, localWhen)
      if (j.kind === 'drop') why = j.why.replace('The task saved in this browser', `Task ${o.task_id}`)
    } catch {
      /* the plain refusal stands */
    }
    if (!live.current || owner !== contextNow()) return
    if (onGrantRefused && !unsaved.current) onGrantRefused(why)
    else setGrantGone(why)
  }, [client, principal, keyId, sharedWorkspace, onGrantRefused])

  const call = useCallback(
    async <T,>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => {
      if (!opened || !client?.codeProxy) throw new Error('not open')
      try {
        return await client.codeProxy<T>(method, p, { task_id: opened.task_id, grant_id: opened.grant_id, repository_id: opened.repository_id, ...(query ?? {}) }, body)
      } catch (e) {
        void onRefusal(e, opened)
        throw e
      }
    },
    [client, opened, onRefusal],
  )

  // open (or reopen) the target as a task with an edit grant, then its workspace
  useEffect(() => {
    if (initial) return   // a target route: StartEditing already chose (reuse) or confirmed (new) the task and grant
    if (!sharedWorkspace && principal === undefined) return   // the saved session is kept per principal: wait for it
    let cancelled = false
    const go = async () => {
      try {
        // request L: only this principal's saved session for this task is read (never another sign-in's)
        const saved = sharedWorkspace ? null : readSession(principal, keyId)
        let o: Opened | null = null
        if (saved && saved.task_id === sharedTask && saved.repository_id === sharedRepository && client?.codeTargets) {
          // a saved session carries ids only; the target it edits is read again
          const t = (await client.codeTargets()).find((x) => x.id === targetId)
          if (t) o = { target: t, task_id: saved.task_id, grant_id: saved.grant_id, repository_id: saved.repository_id, swarm_id: saved.swarm_id ?? '', base_commit: saved.base_commit ?? t.repo?.commit ?? '' }
        }
        if (!o) {
          o = sharedTask && sharedWorkspace && sharedRepository ? await client!.codeAttach!(sharedTask, sharedWorkspace, sharedRepository)
            : sharedTask && sharedRepository ? await client!.codeSelect!(sharedTask, sharedRepository)
            : await client!.codeOpen!(targetId)
          if (!sharedWorkspace) saveSession(principal, keyId, o, false)
        }
        if (cancelled) return
        setOpened(o)
      } catch (e) {
        if (cancelled) return
        const r = notEditable(e)
        if (r) setUnregistered(r)
        else setBlocked(errText(e))
      }
    }
    void go()
    return () => {
      cancelled = true
    }
  }, [client, targetId, keyId, sharedTask, sharedWorkspace, sharedRepository, initial, principal])

  useEffect(() => {
    if (!opened) return
    if (!opened.workspace_id && principal === undefined) return   // the saved workspace is kept per principal too
    let cancelled = false
    // the identity this effect runs for, fixed at its start: every read and save below uses it, never a later one
    // (Kimi K1). A change of principal re-runs the effect, and the earlier run only ever touches its own entries.
    const who = principal
    const go = async () => {
      try {
        const saved = opened.workspace_id ?? readWorkspace(who, keyId)
        const w = saved
          ? await call<Workspace>('GET', `/v1/workspaces/${saved}`)
          : await call<Workspace>('POST', '/v1/workspaces', { operation_id: `open-${opened.task_id}`, repository_id: opened.repository_id, task_id: opened.task_id, base_commit: opened.base_commit })
        // Surface S: a workspace this run CREATED is filed before the cancelled check, so a create that lands after the
        // person left is not lost. It is filed for the identity the run started under (`who`) and only while storage
        // still holds that exact task and grant (saveWorkspaceFor). One read from storage is already filed (Kimi K2).
        if (!saved) saveWorkspaceFor(who, keyId, opened, w.id)
        if (cancelled) return
        setWs(w)
        const tree = await call<{ files: { path: string }[] }>('GET', `/v1/workspaces/${w.id}/tree`)
        if (!cancelled) setFiles(tree.files.map((f) => f.path))
      } catch (e) {
        if (cancelled || grantRefused(e)) return   // a refused grant is handled by onRefusal (back to the start screen)
        const r = notEditable(e)
        if (r) {
          // live 0aa6330: the service refused after the hive made the task and grant; this browser stops offering it
          if (!sharedWorkspace) dropSessionIf(who, keyId, opened)
          setUnregistered(r)
        } else setBlocked(e instanceof ApiError && e.code === 'service_unavailable' ? 'OmegaCode is not connected to this hive yet.' : errText(e))
      }
    }
    void go()
    return () => {
      cancelled = true
    }
  }, [opened, call, keyId, principal, sharedWorkspace])

  const openFile = async (p: string) => {
    if (!ws) return
    const t = beginRead()
    if (!t) return
    const before = t.draft
    const dirtyBefore = !!before.file && before.text !== before.file.content
    if (dirtyBefore && !(await askConfirm('Discard unsaved changes in this file?', 'Discard'))) return
    if (!sameDraft(t)) return
    try {
      const f = await call<{ content: string; digest: string; generation: number; tree_digest: string }>('GET', `/v1/workspaces/${ws.id}/files`, undefined, { path: p })
      if (!sameDraft(t)) return
      if (dirtyBefore) discardRetained()
      setWs({ ...ws, generation: f.generation, tree_digest: f.tree_digest })
      setSelection(null)
      writeEditor({ path: p, file: { content: f.content, digest: f.digest }, text: f.content }, true)
    } catch (e) {
      if (sameRequest(t)) toast({ tone: 'error', title: `Could not open ${p}`, body: errText(e) })
    }
  }

  const save = async () => {
    const before = editorRef.current
    if (!ws || !before.path || !before.file || before.text === before.file.content || busy) return
    const t = beginRead()
    if (!t) return
    setBusy('save')
    try {
      const r = await call<{ workspace: Workspace }>('POST', `/v1/workspaces/${ws.id}/patches`, {
        operation_id: `save-${Date.now()}`, expected_generation: ws.generation, expected_tree_digest: ws.tree_digest,
        edits: [{ path: before.path, expected_digest: before.file.digest, content: before.text }],
      })
      if (!sameRequest(t)) return
      setWs(r.workspace)
      const tree = await call<{ files: { path: string }[] }>('GET', `/v1/workspaces/${r.workspace.id}/tree`)
      if (!sameRequest(t)) return
      setFiles(tree.files.map((f) => f.path))
      const f = await call<{ content: string; digest: string }>('GET', `/v1/workspaces/${r.workspace.id}/files`, undefined, { path: before.path, expected_generation: String(r.workspace.generation) })
      if (!sameRequest(t)) return
      const now = editorRef.current
      if (now.path === before.path && now.file?.digest === before.file.digest) {
        if (now === before) discardRetained()
        writeEditor({ path: now.path, file: f, text: now === before ? f.content : now.text })
      }
      toast({ tone: 'success', icon: 'check', title: 'Saved to the candidate', body: `${before.path} · generation ${r.workspace.generation}` })
    } catch (e) {
      if (sameRequest(t)) toast({ tone: 'error', title: e instanceof ApiError && e.status === 409 ? 'Someone changed this first' : 'Could not save', body: errText(e) })
    } finally {
      if (live.current) setBusy(value => value === 'save' ? null : value)
    }
  }

  const reload = async () => {
    if (!ws || busy) return
    const t = beginRead()
    if (!t) return
    const dirtyBefore = !!t.draft.file && t.draft.text !== t.draft.file.content
    if (dirtyBefore && !(await askConfirm('Discard unsaved changes and reload the candidate?', 'Discard and reload'))) return
    if (!sameDraft(t)) return
    setBusy('reload')
    try {
      const current = await call<Workspace>('GET', `/v1/workspaces/${ws.id}`)
      if (!sameDraft(t)) return
      const tree = await call<{ files: { path: string }[] }>('GET', `/v1/workspaces/${current.id}/tree`, undefined, { expected_generation: String(current.generation) })
      if (!sameDraft(t)) return
      if (dirtyBefore) discardRetained()
      setWs(current); setFiles(tree.files.map(f => f.path)); setSelection(null)
      writeEditor({ path: null, file: null, text: '' }, true)
    } catch (e) {
      if (sameRequest(t)) toast({ tone: 'error', title: 'Could not reload the candidate', body: errText(e) })
    } finally { if (live.current) setBusy(value => value === 'reload' ? null : value) }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (q ? files.filter((f) => f.toLowerCase().includes(q)) : files).slice(0, 400)
  }, [files, filter])
  const dirty = !!file && text !== file.content
  // Only embedded departures use this added confirmation. Legacy CodePage navigation is unchanged.
  // writeEditor advances this identity synchronously, including edit-and-revert.
  const departureLife = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!embeddedMode) return
    const life = new AbortController()
    departureLife.current = life
    return () => { life.abort(); departureLife.current = null }
  }, [embeddedMode])
  const leaveEmbedded = (leave: () => void) => {
    const life = departureLife.current
    if (!life) return
    void confirmEmbeddedDeparture(
      () => departure.current,
      () => departureLife.current === life && !life.signal.aborted,
      () => askConfirm('Discard unsaved changes and leave this code bench?', 'Discard and leave', { signal: life.signal }),
      () => { discardRetained(); leave() },
    )
  }
  useLayoutEffect(() => {
    const handle = embedded?.departure
    if (!handle) return
    handle.current = leaveEmbedded
    return () => { if (handle.current === leaveEmbedded) handle.current = null }
  })
  const back = () => embedded ? leaveEmbedded(embedded.onBack) : navigate({ name: 'code' })
  const close = () => embedded ? leaveEmbedded(embedded.onClose) : closeToHome()
  // an unsaved draft holds the orchestrator's page moves as Go cards (features/ask/dirty)
  useUnsaved(dirty)
  const t = opened?.target
  const codeCtx = useMemo(() => (opened ? { task_id: opened.task_id, grant_id: opened.grant_id, repository_id: opened.repository_id } : null), [opened])
  // The candidate moved under the panel (an accepted ChangeSet, or another actor). Unsaved edits are never replaced.
  const onWorkspace = async (current: WorkspaceHead, touched: string[]) => {
    const t = beginRead()
    if (!t || current.id !== ws?.id || current.generation < ws.generation) return
    setWs(w => w ? { ...w, ...current } : w)
    const tree = await call<{ files: { path: string }[] }>('GET', `/v1/workspaces/${current.id}/tree`, undefined, { expected_generation: String(current.generation) })
    if (!sameDraft(t)) return
    setFiles(tree.files.map(f => f.path))
    const before = t.draft
    if (!before.path || !before.file) return
    if (before.text !== before.file.content) {
      if (touched.includes(before.path)) toast({ tone: 'info', title: `${before.path} changed on the candidate`, body: 'Your unsaved draft is kept. Reconcile it with the new source before saving.' })
      return
    }
    const fresh = await call<{ content: string; digest: string }>('GET', `/v1/workspaces/${current.id}/files`, undefined, { path: before.path, expected_generation: String(current.generation) })
    if (sameDraft(t)) writeEditor({ path: before.path, file: fresh, text: fresh.content })
  }

  // This guard restricts only UI continuation. Original Host/controller admission
  // owns work; a stale UI never proves cancellation or no prior dispatch.
  const requestSandboxTest: SandboxTestHandler = async (what, _selection, references, canvasCurrent) => {
    if (!testSupport.current) throw new Error(CODE_TEST_UNAVAILABLE)
    if (sandboxRequestPending.current) throw new Error('A sandbox test request is already being checked.')
    const previous = testRequestRef.current
    if (!onSandboxTest && previous?.outcome.kind === 'unknown' && references
        && previous.outcome.attempt.body.request.request_id === references.request_id
        && previous.outcome.attempt.body.request.proposal_id === references.proposal.proposal_id)
      throw new Error('The previous request is unknown. Use Check same test request; do not create another Ask.')
    const t = beginRead()
    const head = scope.current.ws
    if (!t || !head || !t.draft.file || t.draft.text !== t.draft.file.content)
      throw new Error('Select a retained proposal on the saved candidate before requesting sandbox tests.')
    const binding = bindEpoch()
    const current = () => testSupport.current && binding.current() && sameDraft(t) && scope.current.ws?.id === head.id
      && scope.current.ws.generation === head.generation && scope.current.ws.tree_digest === head.tree_digest
      && (!canvasCurrent || canvasCurrent())
    if (!current()) throw new Error('The candidate changed before test admission.')
    // Canvas ranges are UTF16. This deliberately requests whole-proposal tests
    // without a guessed byte range, operator command or claimed filtered subset.
    if (!references || !client) throw new Error('Ask for or select a retained proposed change before requesting its sandbox tests.')
    sandboxRequestPending.current = true
    try {
      setTestSubject({ context: t.context, proposal: references.proposal })
      if (onSandboxTest) { await onSandboxTest(what, undefined, references, current); return }
      const outcome = await requestCodeTest(client, { request_id: references.request_id,
        proposal_id: references.proposal.proposal_id }, askTurn, current)
      if (current()) binding.commit(() => {
        const value = { context: t.context, outcome, current }
        testRequestRef.current = value; setTestRequest(value); setTestNotice(null)
      })
    } catch {
      if (current()) binding.commit(() => setTestNotice('The Ask admission was not confirmed. Check the existing Ask history before trying another request.'))
    } finally { sandboxRequestPending.current = false }
  }
  const recoverSandboxTest = async () => {
    const prior = testRequestRef.current
    if (!testSupport.current || !client || sandboxRequestPending.current || prior?.outcome.kind !== 'unknown' || !prior.current()) return
    sandboxRequestPending.current = true
    const binding = bindEpoch()
    const current = () => binding.current() && prior.current()
    try {
      const outcome = await resumeCodeTest(client, prior.outcome.attempt, current)
      if (current()) binding.commit(() => {
        const value = { context: prior.context, outcome, current }
        testRequestRef.current = value; setTestRequest(value)
      })
    } finally { sandboxRequestPending.current = false }
  }
  const visibleTestRequest = testRequest?.context === renderContext ? testRequest : null
  // embedded (Create): the work stream shows a queued test as its own step, so only a problem is said here
  const localSandboxStatus = visibleTestRequest?.outcome.kind === 'queued'
    ? embedded ? null : 'Test request queued. Results will appear here when it runs.'
    : visibleTestRequest?.outcome.kind === 'unknown'
      ? 'The test request could not be confirmed. Check it before starting another.'
      : visibleTestRequest?.outcome.kind === 'unavailable'
        ? 'Tests are not available through this hive yet.' : null
  // Read-only evidence follows the proposal the person actually selected for
  // Test. Current workspace primitives affect freshness; no latest-proposal guess.
  const evidenceSubject: EvidenceSubject | null = ws && testSubject?.context === renderContext
    && /^[a-f0-9]{64}$/.test(ws.tree_digest)
    && /^sha256:[a-f0-9]{64}$/.test(testSubject.proposal.proposal_digest)
    && /^sha256:[a-f0-9]{64}$/.test(testSubject.proposal.normalized_hunks_digest)
    ? { workspace_id: ws.id, generation: ws.generation, tree_digest: ws.tree_digest,
        proposal_id: testSubject.proposal.proposal_id,
        proposal_digest: testSubject.proposal.proposal_digest.slice(7),
        normalized_hunks_digest: testSubject.proposal.normalized_hunks_digest.slice(7) } : null
  const evidenceCall = useCallback<EvidenceCall>((method, route, body, query) => call(method, route, body, query), [call])

  const selectionOrNull = useCallback((s: { from: number; to: number } | null) => setSelection(s), [])
  const fileActionsChanged = async (current: Candidate, selected: string | null) => {
    if (!ws || current.id !== ws.id || current.generation < ws.generation) return
    const t = beginRead()
    if (!t) return
    setWs({ ...ws, ...current })
    const tree = await call<{ files: { path: string }[] }>('GET', `/v1/workspaces/${current.id}/tree`, undefined, { expected_generation: String(current.generation) })
    if (!sameDraft(t)) return
    const fresh = selected ? await call<{ content: string; digest: string }>('GET', `/v1/workspaces/${current.id}/files`, undefined, { path: selected, expected_generation: String(current.generation) }) : null
    if (!sameDraft(t)) return
    if (t.draft.file && t.draft.text !== t.draft.file.content) {
      toast({ tone: 'info', title: 'File changed; unsaved draft retained', body: 'Copy or reconcile your draft before loading the changed file.' })
      return
    }
    setFiles(tree.files.map(f => f.path))
    writeEditor({ path: selected, file: fresh, text: fresh?.content ?? '' }, true)
  }
  const restored = async (current: Workspace) => {
    if (current.id !== ws?.id || current.generation < ws.generation) return
    const t = beginRead()
    if (!t) return
    setWs(current)
    const tree = await call<{ files: { path: string }[] }>('GET', `/v1/workspaces/${current.id}/tree`)
    if (!sameDraft(t)) return
    setFiles(tree.files.map(f => f.path))
    if (!t.draft.file || t.draft.text === t.draft.file.content)
      writeEditor({ path: null, file: null, text: '' }, true)
  }
  // the panes that hold work in progress stay mounted once visited (hidden when another tab is shown)
  const [visited, setVisited] = useState<Set<DrawerTab>>(() => new Set())
  const drawer = (tab: DrawerTab, go: (t: DrawerTab | null) => void) => {
    // Defensive rendering guard as well as the Canvas tab/shortcut gates; not a server permission.
    if (embedded && !['files', 'changes', 'proposals', 'tests', 'history', 'session'].includes(tab)) return null
    if (!visited.has(tab)) void Promise.resolve().then(() => setVisited((v) => new Set(v).add(tab)))
    const keep = (id: DrawerTab, node: ReactNode) => ((!embedded || ['files', 'changes', 'proposals', 'tests', 'history', 'session'].includes(id)) && (tab === id || visited.has(id)) ? <div key={id} className={tab === id ? 'h-full' : 'hidden'}>{node}</div> : null)
    if (!ws || !opened) return <EmptyState icon="doc" title="Preparing an isolated copy…" />
    return (
      <>
        {tab === 'files' && (
          <div className="space-y-2 p-3">
            <div className="flex flex-wrap gap-2">
              <Button disabled={!!busy} onClick={() => void reload()}>Reload this copy</Button>
              <FileActions key={ws.id} call={call} ws={ws} file={path && file ? { path, ...file } : null} dirty={dirty} busy={!!busy} onChanged={fileActionsChanged} />
            </div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${plural(files.length, 'file')}`} aria-label="Filter files" className="min-h-9 w-full rounded-lg border border-line bg-shade/25 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
            <div>
              {shown.map((f) => (
                <button key={f} onClick={() => { void openFile(f); go(null) }} title={f} className={cx('block w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] transition-colors', f === path ? 'bg-tint/[0.08] text-ink' : 'text-ink-3 hover:bg-tint/[0.04] hover:text-ink')}>
                  {f}
                </button>
              ))}
            </div>
            {/* Create's bench: the person's review setting for the Code controller (hidden where the hive lacks it) */}
            {embedded && <ReviewSettingRow client={client} />}
          </div>
        )}
        {tab === 'changes' && <Changes call={call} ws={ws} />}
        {keep('proposals', codeCtx && <WorkbenchSuggestionPanel client={client} ctx={codeCtx} ws={ws} file={path && file ? { path, ...file } : null} editorText={text} selection={selection} dirty={dirty} onWorkspace={onWorkspace} onOpenChanges={() => go('changes')} />)}
        {keep('tests', embedded ? (sandboxTestPanel ?? (evidenceSubject
          ? <>{dirty && <p className="p-3 text-xs text-ink-3">Unsaved text has not been tested. This evidence belongs to the saved candidate.</p>}<ProjectTestEvidencePanel call={evidenceCall} subject={evidenceSubject} /></>
          : <EmptyState icon="shield" title="Sandbox test evidence" body="Select a retained proposal with Test to read its sandbox evidence." />)) : <Runs call={call} ws={ws} />)}
        {tab === 'history' && <EvidenceHistory key={ws.id} call={call} workspace={ws.id} />}
        {tab === 'review' && <SourceReview key={`${ws.id}:${ws.generation}:${ws.tree_digest}`} call={call} ws={ws} dirty={dirty} onRestored={restored} />}
        {keep('merge', <MergePanel key={ws.id} call={call} ws={ws} dirty={dirty} onApplied={restored} />)}
        {keep('export', <GitExportPanel key={ws.id} call={call} ws={ws} dirty={dirty} />)}
        {tab === 'recovery' && <Recovery call={call} ws={ws} dirty={dirty} onRestored={restored} />}
        {tab === 'runtimes' && <Runtimes call={call} ws={ws} />}
        {keep('symbolic', <SymbolicPanel key={ws.id} call={call} ws={ws} dirty={dirty} active={tab === 'symbolic'} />)}
        {keep('debug', <DebuggerPanel key={ws.id} call={call} ws={ws} dirty={dirty} active={tab === 'debug'} />)}
        {tab === 'session' && (
          <div className="space-y-3">
            <SessionBar opened={opened} origin={origin} ws={ws} onStartNew={onStarted && targetOpenable(opened.target) ? () => setStartingNew(true) : undefined} onRevoked={() => { revokedHere.current = true }} />
            {t && (
              <p className="px-4 text-[12.5px] text-ink-3">
                <Icon name="bolt" size={13} className="mr-1 inline" />
                Applying to the running {t.kind === 'hive' ? 'hive' : t.kind} ({t.apply.how}) has not landed yet: {t.apply.note}.
              </p>
            )}
          </div>
        )}
      </>
    )
  }

  if (unregistered || blocked) {
    const content = <>
        {embedded?.draftRecovery}
        {unregistered ? (
          <div className="space-y-2">
            {opened?.task_id && <SessionBar opened={opened} origin={origin} ws={null} onRevoked={() => { revokedHere.current = true }} />}
            <NotEditableState refusal={unregistered} label={t?.label ?? targetId} made={opened?.task_id ? opened : null} onBack={embedded ? back : undefined} />
          </div>
        ) : (
          <EmptyState icon="alert" title="The workbench cannot open yet" body={blocked ?? ''} action={<Button onClick={back}>{embedded ? 'Back to Create' : 'Back to everything running'}</Button>} />
        )}
    </>
    return embedded ? <section aria-label="Code workbench" className="relative h-full overflow-y-auto">{content}</section> : (
      <Page title={t?.label ?? 'Code'} eyebrow={t ? `${KIND[t.kind].label} · ${t.repo?.commit?.slice(0, 7) ?? ''}` : 'Opening…'} label="Code workbench" onBack={back} onClose={() => navigate({ name: 'hive' })}>{content}</Page>
    )
  }

  return (
    <>
      <AnimatePresence>{startingNew && opened && onStarted && targetOpenable(opened.target) && <StartTaskDialog target={opened.target} principal={principal} current={{ task_id: opened.task_id, grant_id: opened.grant_id, inUse: true }} onStarted={onStarted} onClose={() => setStartingNew(false)} />}</AnimatePresence>
      <CodeCanvas
        label={t?.label ?? 'Code'}
        // Create's bench names the project only (no commit or generation): the full Code page keeps them
        eyebrow={t ? embedded ? KIND[t.kind].label : `${KIND[t.kind].label} · ${t.repo?.commit?.slice(0, 7) ?? ''}` : 'Opening…'}
        client={client}
        ctx={codeCtx}
        call={opened ? call : null}
        ws={ws}
        files={files}
        path={path}
        file={path && file ? { path, ...file } : null}
        text={text}
        dirty={dirty}
        busy={busy}
        selection={selection}
        onText={changeText}
        onSelect={selectionOrNull}
        openFile={openFile}
        save={() => void save()}
        onWorkspace={onWorkspace}
        drawer={drawer}
        waiting={ws ? null : 'Making your own copy to work in… this can take a few seconds.'}
        onBack={back}
        onClose={close}
        proposalOnly={!!embedded}
        embedded={!!embedded}
        sandboxTestAvailable={sandboxTestAvailable}
        onSandboxTest={embedded ? requestSandboxTest : undefined}
        sandboxTestStatus={sandboxTestStatus ?? localSandboxStatus}
        backLabel={embedded ? 'Back to Create' : undefined}
        banner={<>
          {embedded?.draftRecovery}
          {embedded && sandboxTestAvailable !== true && <p role="status" className="mx-3 mb-2 text-[12.5px] text-ink-3">{CODE_TEST_UNAVAILABLE}</p>}
          {embedded && <p className="mx-3 mb-2 text-[12.5px] text-ink-3" role="status">Changes stay in your copy until you apply them.{sandboxTestAvailable ? " Every change is tested on a copy first." : ""}</p>}
          {embedded && localSandboxStatus && <p role="status" className="mx-3 text-sm">{localSandboxStatus}</p>}
          {embedded && testNotice && <p role="alert" className="mx-3 text-sm">{testNotice}</p>}
          {embedded && sandboxTestAvailable === true && visibleTestRequest?.outcome.kind === 'unknown' && <Button
            disabled={sandboxRequestPending.current || !visibleTestRequest.current()}
            onClick={() => void recoverSandboxTest()}>Check same test request</Button>}
          {grantGone && (
          <div role="alert" aria-label="Edit grant refused" className="relative z-[6] mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-bad/30 bg-bad/[0.07] px-3 py-2 text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
            <span className="min-w-0 flex-1"><span className="font-semibold text-bad">The hive refused this workbench’s edit grant.</span> {grantGone} This browser has forgotten that task.{dirty ? ' Your unsaved draft is still in the editor: copy it before you leave.' : ''}</span>
            {onGrantRefused ? <Button onClick={() => embedded ? leaveEmbedded(() => onGrantRefused(grantGone)) : onGrantRefused(grantGone)} className="min-h-9 px-3 text-[12.5px]">Back to the start screen</Button>
              : sharedTask && !sharedWorkspace ? <Button onClick={embedded ? back : () => navigate({ name: 'code', task: sharedTask })} className="min-h-9 px-3 text-[12.5px]">Open this task again</Button> : null}
          </div>
          )}
        </>}
      />
    </>
  )
}

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

interface Checkpoint { id: string; label: string; decision: string; generation: number; author: string }
function Recovery({ call, ws, dirty, onRestored }: { call: Call; ws: Workspace; dirty: boolean; onRestored: (ws: Workspace) => Promise<void> }) {
  const [items, setItems] = useState<Checkpoint[]>([])
  const [label, setLabel] = useState('Review point')
  const [decision, setDecision] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const r = await call<{ checkpoints: Checkpoint[] }>('GET', `/v1/workspaces/${ws.id}/checkpoints`)
    setItems(r.checkpoints)
  }, [call, ws.id])
  useEffect(() => {
    let cancelled = false
    void call<{ checkpoints: Checkpoint[] }>('GET', `/v1/workspaces/${ws.id}/checkpoints`).then((r) => { if (!cancelled) setItems(r.checkpoints) }).catch((e) => { if (!cancelled) setError(errText(e)) })
    return () => { cancelled = true }
  }, [call, ws.id, ws.generation])
  const save = async () => {
    setBusy(true); setError(null)
    try { await call('POST', `/v1/workspaces/${ws.id}/checkpoints`, { operation_id: `checkpoint-${crypto.randomUUID()}`, label, decision }); await refresh() }
    catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  const restore = async (cp: Checkpoint) => {
    if (dirty || busy) return
    if (!(await askConfirm(`Restore source from ${cp.label}? This creates a new revision and retains the history.`, 'Restore'))) return
    setBusy(true); setError(null)
    try {
      const r = await call<{ workspace: Workspace }>('POST', `/v1/workspaces/${ws.id}/restores`, { operation_id: `restore-${crypto.randomUUID()}`, checkpoint_id: cp.id, expected_generation: ws.generation, expected_tree_digest: ws.tree_digest })
      await onRestored(r.workspace); await refresh()
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return <div className="thin-scroll h-full space-y-3 overflow-auto p-4">
    <h2 className="text-sm text-ink">Source checkpoints</h2>
    <p className="text-xs text-ink-3">Restore source as a new revision. Past changes and test results remain in the history; this does not restore a mind's memory or running processes.</p>
    <label className="block text-xs text-ink-3">Checkpoint name<input value={label} onChange={(e) => setLabel(e.target.value)} className="ml-2 rounded border border-line bg-shade/25 p-2" /></label>
    <label className="block text-xs text-ink-3">Decision<textarea value={decision} onChange={(e) => setDecision(e.target.value)} className="mt-1 block w-full rounded border border-line bg-shade/25 p-2" /></label>
    <Button disabled={busy || !label.trim()} onClick={() => void save()}>Save checkpoint</Button>
    {dirty && <p className="text-xs text-ink-3">Save or discard your unsaved file edits before restoring.</p>}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    {items.map((cp) => <div key={cp.id} className="rounded border border-line p-3"><div className="text-sm">{cp.label} · generation {cp.generation}</div><div className="break-all font-mono text-xs text-ink-3">{cp.id} · {cp.author}</div><p className="my-2 text-xs text-ink-3">{cp.decision}</p><Button disabled={busy || dirty} onClick={() => void restore(cp)}>Restore source</Button></div>)}
  </div>
}

function Runtimes({ call, ws }: { call: Call; ws: Workspace }) {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void call('GET', `/v1/workspaces/${ws.id}/toolchains`).then(setData).catch((e) => setError(errText(e))) }, [call, ws.id])
  return <div className="thin-scroll h-full space-y-3 overflow-auto p-4"><h2 className="text-sm text-ink">Runtime discovery</h2><p className="text-xs text-ink-3">Inspect configured PeTTa and Hyperon versions and batch probes. Persistent REPL and symbolic debugger support are still pending.</p>{error ? <p role="alert" className="text-xs text-bad">{error}</p> : data ? <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(data, null, 2)}</pre> : <Skeleton className="h-24" />}</div>
}

function Changes({ call, ws }: { call: Call; ws: Workspace }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [changes, setChanges] = useState<{ id: string; generation: number; author: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void call<{ diff?: string; unified_diff?: string; changes: { id: string; generation: number; author: string }[] }>('GET', `/v1/workspaces/${ws.id}/changes`)
      .then((r) => { setDiff(r.diff ?? r.unified_diff ?? ''); setChanges(r.changes) })
      .catch((e) => setErr(errText(e)))
  }, [call, ws.id, ws.generation])
  if (err) return <EmptyState icon="alert" title="Could not load the changes" body={err} />
  if (diff === null) return <Skeleton className="m-3 h-40" />
  if (!diff.trim()) return <EmptyState icon="doc" title="No changes yet" body="Save an edit and its diff appears here." />
  return (
    <div className="thin-scroll h-full overflow-auto p-3">
      {changes.map((change) => <div key={change.id} className="break-all font-mono text-xs text-ink-3">ChangeSet {change.id} · generation {change.generation} · {change.author}</div>)}
    <pre className="font-mono text-[12px] leading-relaxed">
      {diff.split('\n').map((line, i) => (
        <div key={i} className={cx(line.startsWith('+') && !line.startsWith('+++') && 'bg-good/10 text-good', line.startsWith('-') && !line.startsWith('---') && 'bg-bad/10 text-bad', line.startsWith('@@') && 'text-accent-2', (line.startsWith('+++') || line.startsWith('---')) && 'text-ink-3')}>
          {line || ' '}
        </div>
      ))}
    </pre>
    </div>
  )
}

interface Run {
  id: string
  status: string
  argv: string[]
  exit_code?: number | null
  generation: number
  output?: string
  stdout?: string
  stderr?: string
  output_digest?: string
}

function Runs({ call, ws }: { call: Call; ws: Workspace }) {
  const toast = useHive((s) => s.toast)
  const [argv, setArgv] = useState('python3 -m pytest -q')
  const [run, setRun] = useState<Run | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [pending, setPending] = useState<'start' | 'stop' | 'verify' | 'refresh' | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const parsed = useMemo(() => {
    try { return { args: commandArgs(argv), error: null } }
    catch (e) { return { args: null, error: errText(e) } }
  }, [argv])
  useEffect(() => {
    if (!run || !liveRunStatus(run.status)) return
    let cancelled = false
    const t = setTimeout(() => {
      void call<Run>('GET', `/v1/runs/${run.id}`)
        .then((result) => { if (!cancelled) { setRun(result); setStatusError(null) } })
        .catch((e) => { if (!cancelled) setStatusError(errText(e)) })
    }, 1200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [run, call])
  const start = async () => {
    if (pending || (run && liveRunStatus(run.status)) || !parsed.args) return
    const payload = { operation_id: `run-${crypto.randomUUID()}`, workspace_id: ws.id, expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, argv: [...parsed.args], timeout_seconds: 120 }
    setPending('start'); setVerdict(null)
    try {
      const r = await call<Run>('POST', '/v1/runs', payload)
      setRun(r); setStatusError(null)
    } catch (e) { toast({ tone: 'error', title: 'Could not start the run', body: errText(e) }) }
    finally { setPending(null) }
  }
  const refresh = async () => {
    if (!run || pending) return
    const id = run.id
    setPending('refresh')
    try { setRun(await call<Run>('GET', `/v1/runs/${id}`)); setStatusError(null) }
    catch (e) { setStatusError(errText(e)) }
    finally { setPending(null) }
  }
  const stop = async () => {
    if (!run || pending) return
    const id = run.id
    setPending('stop')
    try {
      await call('POST', `/v1/runs/${id}/cancel`, { operation_id: `cancel-${id}` })
      // A stop request alone does not prove the process or descendants stopped.
      setRun(await call<Run>('GET', `/v1/runs/${id}`)); setStatusError(null)
    } catch (e) {
      setStatusError(errText(e))
      toast({ tone: 'error', title: 'Could not confirm the stop', body: errText(e) })
    } finally { setPending(null) }
  }
  const verify = async () => {
    if (!run || pending || liveRunStatus(run.status)) return
    const id = run.id
    setPending('verify')
    try {
      const v = await call<{ id: string; outcome?: string; status?: string; currency?: string }>('POST', '/v1/verifications', { operation_id: `verify-${id}`, run_id: id })
      setVerdict(`${v.id} · ${v.outcome ?? v.status ?? 'recorded'}${v.currency ? ` · ${v.currency}` : ''}`)
    } catch (e) { toast({ tone: 'error', title: 'Could not record the verification', body: errText(e) }) }
    finally { setPending(null) }
  }
  const live = run && liveRunStatus(run.status)
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
        className="flex gap-2"
      >
        <input value={argv} onChange={(e) => setArgv(e.target.value)} aria-label="Command" className="min-h-10 min-w-0 flex-1 rounded-xl border border-line bg-shade/25 px-3 font-mono text-[13px] text-ink outline-none focus:border-line-2" />
        <Button type="submit" variant="primary" hue={150} icon="play" disabled={!!live || !!pending || !!parsed.error}>
          {pending === 'start' ? 'Starting…' : `Run on generation ${ws.generation}`}
        </Button>
      </form>
      {parsed.error ? <p role="alert" className="text-xs text-bad">{parsed.error}</p> : <pre aria-label="Parsed command arguments" className="thin-scroll max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-3">{JSON.stringify(parsed.args)}</pre>}
      <p className="text-xs text-ink-3">Quotes group arguments. Commands use direct arguments; no automatic shell expansion.</p>
      <p className="text-[11.5px] text-ink-4">Runs on a frozen copy of exactly this generation, without any keys or hive credentials. Allowed commands are set by the hive's operator.</p>
      <AnimatePresence>
        {run && (
          <m.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex min-h-0 flex-1 flex-col rounded-xl border border-line">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
              <span className={cx('size-2 rounded-full', live ? 'animate-pulse bg-accent-2' : run.exit_code === 0 ? 'bg-good' : 'bg-bad')} />
              <span className="text-ink">{run.status}</span><span className="break-all font-mono text-xs text-ink-3">{run.id}</span>
              {run.exit_code != null && <span className="font-mono text-ink-3">exit {run.exit_code}</span>}
              <span className="font-mono text-ink-4">generation {run.generation}</span>
              <span className="flex-1" />
              {live ? (
                <Button variant="ghost" className="min-h-8 px-2.5 text-[12px]" disabled={!!pending} onClick={() => void stop()}>
                  {pending === 'stop' ? 'Requesting stop…' : 'Stop'}
                </Button>
              ) : (
                <Button variant="subtle" className="min-h-8 px-2.5 text-[12px]" icon="shield" disabled={!!pending} onClick={() => void verify()}>
                  Record as evidence
                </Button>
              )}
            </div>
            <pre className="thin-scroll max-h-20 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-ink-3" aria-label="Recorded run arguments">{JSON.stringify(run.argv)}</pre>
            {statusError && <div role="alert" className="space-y-2 border-b border-line p-3 text-xs text-bad"><p>Run update failed: {statusError}. The displayed status is the last observation.</p><Button disabled={!!pending} onClick={() => void refresh()}>Retry status</Button></div>}
            {verdict && <div className="border-b border-line px-3 py-1.5 text-[12px] text-ink-2">Verification: {verdict}</div>}
            <RunOutput key={run.id} call={call} workspace={ws.id} run={run.id} />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
