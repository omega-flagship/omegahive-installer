import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ApiError, type HiveClient } from '../../api/client'
import type { ActionResult } from '../../api/types'
import type { FormActResult } from '../../forms/contract'
import { bindTo } from '../../lib/decisionGate'
import {
  actionOf, CLOSED_RUNNING, CONFIRM_AGAIN, CONFIRM_UNAVAILABLE, DECLINED_UNKNOWN, IDENTITY_CHANGED, IDENTITY_CHANGED_SENT, needsConfirm, paramsSummary, prepareConfirm, priorWords,
  recoveryOf, runConfirmed, runningWords, type ConfirmIntent, type ConfirmOutcome, type FrameConfirmReason,
} from '../../lib/hostConfirm'
import { applyResult } from '../../store/programSession'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'

/**
 * The host's confirm for an app act (PROGRAMS.md §9d): one DecisionDialog with the full context (app, swarm, action,
 * items, params, file), focus on its heading, armed only after it has been on screen unchanged, refusing held keys,
 * and refusing while the app or the action changed under it (drift). Only the person's press mints the token
 * (lib/hostConfirm.runConfirmed); the token never leaves the host.
 *
 * Identity (review B1): an intent is bound, when it is admitted (the moment the person is asked), to the client
 * instance, the store session (Surface R: client + init epoch) and its init count, and to the app and swarm. Before
 * the mint, after every await and before every act, all of them must still be the same, and the intent must still be
 * the open one of a mounted host; otherwise nothing is minted or sent. A change (or an unmount) cancels the intent at
 * once: the dialog closes, the caller hears `stale` in a plain sentence, and whatever answers later (a result, a lost
 * answer, a recovery check) is dropped: it never updates the page, reopens a dialog or mints.
 */

/** How one confirm ended, for the caller (a frame, a form, the program host). Never carries the token. */
export type HostConfirmFinal =
  | { kind: 'done'; result: ActionResult }
  /**
   * The person cancelled. `uncertain`: an earlier attempt of this intent had an unknown outcome (it may have acted).
   * `running`: they closed the still-running check (Kimi r2 #3): the earlier attempt may still finish.
   */
  | { kind: 'declined'; uncertain: boolean; running?: boolean }
  | { kind: 'refused'; reason: FrameConfirmReason; message: string }
  /** Review B1: the identity changed or the host went away; `sent`: the act may already have been sent. Nothing to show. */
  | { kind: 'stale'; sent: boolean; message: string }
  /** `sent`: the act had been sent when it failed, so it may have had its effect (Review B1, commons f0818d8). */
  | { kind: 'failed'; error: unknown; sent?: boolean }

export interface HostConfirmShown {
  /** Shown only: the file the act sends (the bytes are already encoded into the body). */
  file?: { name: string; mime: string; size: number }
}

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

/**
 * The words a form or the program host shows for a confirm that did not produce a result. Review B1 (commons f0818d8):
 * whenever the act may already have had its effect, the result says so (`unknown`), so a form never reads it as a
 * known refusal ("nothing changed"): a re-ask the person closed for an attempt whose effect is unknown, an identity
 * change after the act was sent, and a failure after it was sent that is not the hive's refusal.
 */
export function finalAsResult(f: HostConfirmFinal): FormActResult {
  if (f.kind === 'done') return f.result
  if (f.kind === 'declined') {
    const unknown = f.running || f.uncertain
    return { status: 'refused', message: f.running ? CLOSED_RUNNING : f.uncertain ? DECLINED_UNKNOWN : 'You cancelled. Nothing was sent.', ...(unknown ? { unknown: true as const } : {}) }
  }
  if (f.kind === 'stale') return { status: 'refused', message: f.message, ...(f.sent ? { unknown: true as const } : {}) }
  if (f.kind === 'refused') return { status: 'refused', message: f.message }
  const refused = f.error instanceof ApiError && f.error.status >= 400 && f.error.status < 500
  return { status: 'error', message: f.error instanceof Error ? f.error.message : CONFIRM_UNAVAILABLE, ...(f.sent && !refused ? { unknown: true as const } : {}), ...(refused && f.error instanceof ApiError && f.error.code ? { code: f.error.code } : {}) }
}

/** Where a confirm host is: its app, and its swarm when it is fixed to one (null: the intent's own swarm). */
export interface ConfirmScope {
  programId: string
  swarmId: string | null
}

/** The identity an intent was admitted under (review B1). */
export interface ConfirmOrigin {
  client: HiveClient
  session: string
  inits: number
  programId: string
  swarmId: string
}

/** The store's side of an origin, as it is now. */
export type StoreIdentity = () => { client: HiveClient | null; session: string; inits: number }
const storeIdentity: StoreIdentity = () => {
  const s = useHive.getState()
  return { client: s.client, session: s.session, inits: s.inits }
}

interface Open {
  seq: number
  intent: ConfirmIntent
  shown: HostConfirmShown
  origin: ConfirmOrigin
  /** asking: the dialog waits for the person; running: their confirm is minting/acting */
  phase: 'asking' | 'running'
  /**
   * Kimi r2 #3: the hive still says this intent is running. The dialog then offers only this further bounded check
   * (the same token; never a mint, never a new confirm) or closing.
   */
  recheck?: () => Promise<ConfirmOutcome>
  /** the act of this intent (or an earlier attempt of it) may have been sent */
  sent: boolean
  settled: boolean
  resolve: (f: HostConfirmFinal) => void
}

/** What the dialog renders: the open intent while it is asking or running. */
export interface ConfirmView {
  seq: number
  intent: ConfirmIntent
  shown: HostConfirmShown
  /** The intent is still running: the dialog shows that and offers "Check again" instead of any confirm. */
  stillRunning: boolean
}

/**
 * One host confirm at a time for one host (an app frame, a form, the program host), bound to its origin identity.
 * Plain class so the whole lifecycle (admit, confirm, re-ask, cancel, dispose) is testable without a DOM; the hook
 * below only wires it to React and to the store.
 */
export class HostConfirmController {
  private open: Open | null = null
  private seq = 0
  private live = true
  private view: ConfirmView | null = null
  private listeners = new Set<() => void>()

  constructor(private scope: ConfirmScope, private identity: StoreIdentity = storeIdentity) {}

  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  readonly snapshot = () => this.view
  readonly isOpen = () => !!this.open

  private emit() {
    const o = this.open
    this.view = o ? { seq: o.seq, intent: o.intent, shown: o.shown, stillRunning: !!o.recheck } : null
    this.listeners.forEach((f) => f())
  }

  /** The host moved to another app or swarm: an intent admitted elsewhere is cancelled. */
  setScope(scope: ConfirmScope) {
    this.scope = scope
    this.check()
  }

  private sameOrigin(origin: ConfirmOrigin): boolean {
    const now = this.identity()
    return now.client === origin.client && now.session === origin.session && now.inits === origin.inits &&
      this.scope.programId === origin.programId && (this.scope.swarmId === null || this.scope.swarmId === origin.swarmId)
  }

  /** The intent may still mint, act and report: the host is mounted, it is the open one, and its identity holds. */
  private alive(o: Open): boolean {
    return this.live && !o.settled && this.open === o && this.sameOrigin(o.origin)
  }

  private settle(o: Open, f: HostConfirmFinal) {
    if (o.settled) return
    o.settled = true
    if (this.open === o) {
      this.open = null
      this.emit()
    }
    o.resolve(f)
  }

  private cancel(o: Open) {
    // the person's earlier attempt (a repeat confirm) or this one's act may already have gone: say so, never "nothing"
    const sent = o.sent || !!o.intent.prior
    this.settle(o, { kind: 'stale', sent, message: sent ? IDENTITY_CHANGED_SENT : IDENTITY_CHANGED })
  }

  /** Called on every store change and scope change: an intent whose identity moved is cancelled at once. */
  check() {
    const o = this.open
    if (o && !o.settled && !this.sameOrigin(o.origin)) this.cancel(o)
  }

  /** Admit an intent: capture its origin now, and show the dialog (or, after the caller's own confirm, run at once). */
  ask(intent: ConfirmIntent, shown: HostConfirmShown = {}, opts: { preconfirmed?: boolean } = {}): Promise<HostConfirmFinal> {
    return new Promise<HostConfirmFinal>((resolve) => {
      if (!this.live) return resolve({ kind: 'stale', sent: false, message: IDENTITY_CHANGED })
      if (this.open) return resolve({ kind: 'refused', reason: 'busy', message: 'Another confirmation is open. Finish it first.' })
      const id = this.identity()
      if (!id.client) return resolve({ kind: 'refused', reason: 'unavailable', message: 'Not connected to the hive.' })
      const swarmId = intent.body.swarm_id
      // an intent for another app or swarm than this host's is never admitted here
      if (intent.programId !== this.scope.programId || (this.scope.swarmId !== null && swarmId !== this.scope.swarmId))
        return resolve({ kind: 'stale', sent: false, message: IDENTITY_CHANGED })
      const origin: ConfirmOrigin = { client: id.client, session: id.session, inits: id.inits, programId: intent.programId, swarmId }
      const o: Open = { seq: ++this.seq, intent, shown, origin, phase: opts.preconfirmed ? 'running' : 'asking', sent: false, settled: false, resolve }
      this.open = o
      if (opts.preconfirmed) {
        // the caller's own full-context dialog was the person's confirm: mint now; only an unknown outcome asks here
        void this.run(o)
        return
      }
      this.emit()
    })
  }

  /** The person's press in the dialog `seq`. Resolves true (the dialog closes; a re-ask opens a fresh one). */
  readonly confirm = async (seq: number): Promise<true> => {
    const o = this.open
    if (!o || o.seq !== seq || o.phase !== 'asking') return true
    if (!this.alive(o)) {
      this.cancel(o)
      return true
    }
    o.phase = 'running'
    await this.run(o)
    return true
  }

  /** The person closed the dialog `seq` (Cancel, Escape, backdrop). */
  readonly close = (seq: number) => {
    const o = this.open
    if (o && o.seq === seq && o.phase === 'asking') this.settle(o, { kind: 'declined', uncertain: !!o.intent.prior, ...(o.recheck ? { running: true } : {}) })
  }

  private async run(o: Open): Promise<void> {
    // the ORIGIN client, never the store's current one; `alive` fences every step inside. A still-running intent is
    // only checked again (o.recheck: the same token, bounded), never confirmed or minted afresh.
    const recheck = o.recheck
    o.recheck = undefined
    const out = recheck ? await recheck() : await runConfirmed(o.origin.client, o.intent, () => this.alive(o), () => { o.sent = true })
    if (o.settled) return   // cancelled meanwhile (identity change, unmount): its late answer is dropped here
    if (!this.alive(o)) return this.cancel(o)
    if (out.kind === 'done') return this.settle(o, { kind: 'done', result: out.result })
    if (out.kind === 'uncertain') {
      // the effect is unknown and the hive did not return it as done: a fresh dialog, re-armed, with the repeat-risk
      // words; or, while the hive still says it is running, the still-running dialog that offers only a further check
      o.intent = out.intent
      o.recheck = out.recheck
      o.seq = ++this.seq
      o.phase = 'asking'
      return this.emit()
    }
    if (out.kind === 'stale') return this.settle(o, { kind: 'stale', sent: out.sent, message: out.message })
    if (out.kind === 'again') return this.settle(o, { kind: 'refused', reason: 'confirm-required', message: CONFIRM_AGAIN })
    if (out.kind === 'unsupported') return this.settle(o, { kind: 'refused', reason: 'invalid', message: out.message })
    if (out.kind === 'too-large') return this.settle(o, { kind: 'refused', reason: 'too-large', message: out.message })
    return this.settle(o, { kind: 'failed', error: out.error, sent: o.sent || !!o.intent.prior })
  }

  /** Close any open confirm (the frame or page that asked is gone): nothing more is minted or sent for it. */
  readonly cancelAll = () => {
    const o = this.open
    if (o) this.cancel(o)
  }

  /** Mounted (again: StrictMode remounts). */
  attach() {
    this.live = true
  }
  /** Unmounted: the open intent is cancelled and every late answer is dropped. */
  detach() {
    this.live = false
    this.cancelAll()
  }
}

/**
 * One host confirm at a time for this app (and swarm, when the host is fixed to one). `ask` shows the dialog (or, when
 * the caller's own full-context dialog already confirmed, runs at once) and resolves once with how it ended. An
 * unknown outcome that the hive does not return as done shows the dialog again for the same intent (same idempotency
 * key) with the repeat-risk words; only that new confirm mints a new token.
 */
export function useHostConfirm(programId: string, swarmId: string | null = null): {
  ask: (intent: ConfirmIntent, shown?: HostConfirmShown, opts?: { preconfirmed?: boolean }) => Promise<HostConfirmFinal>
  /** Close any open confirm (the frame or page that asked is gone). */
  cancelAll: () => void
  isOpen: () => boolean
  dialog: ReactNode
} {
  const [c] = useState(() => new HostConfirmController({ programId, swarmId }))
  const view = useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot)
  useEffect(() => c.setScope({ programId, swarmId }), [c, programId, swarmId])
  useEffect(() => {
    c.attach()
    const stop = useHive.subscribe(() => c.check())   // a new client, session or init cancels at once
    return () => {
      stop()
      c.detach()
    }
  }, [c])
  const ask = useCallback((intent: ConfirmIntent, shown?: HostConfirmShown, opts?: { preconfirmed?: boolean }) => c.ask(intent, shown, opts), [c])
  const dialog = view ? (
    <HostConfirmDialog key={view.seq} programId={programId} intent={view.intent} shown={view.shown} stillRunning={view.stillRunning} onConfirm={() => c.confirm(view.seq)} onClose={() => c.close(view.seq)} />
  ) : null
  return { ask, cancelAll: c.cancelAll, isOpen: c.isOpen, dialog }
}

/**
 * The generic program host's act (store.programAct) with the §9d confirm, wrapped at the call site so the store is
 * unchanged: an action that needs no confirm goes to the store as before; a confirm action builds the same body the
 * store sends (the person's step rides along), is asked in the host, and its result is applied to the session exactly
 * as the store applies one (store/programSession.applyResult), only while the identity it was asked under holds.
 */
export function useConfirmedProgramAct(programId: string, swarmId: string | null = null): {
  act: (key: string, action: string, items: string[], params?: Record<string, unknown>) => Promise<void>
  dialog: ReactNode
} {
  const storeAct = useHive((s) => s.programAct)
  const { ask, dialog } = useHostConfirm(programId, swarmId)
  const act = useCallback(
    async (key: string, action: string, items: string[], params: Record<string, unknown> = {}) => {
      const st = useHive.getState()
      const s0 = st.programSessions[key]
      const describe = st.programDetails[programId]?.describe ?? null
      if (!s0 || !needsConfirm(describe, action)) return storeAct(key, action, items, params)
      if (!st.client || s0.busy) return
      const here = s0.trail[s0.trail.length - 1]
      const sent = { focus: here?.focus ?? null, stage: here?.stage ?? 'unfold', ...params }
      const p = prepareConfirm(programId, { swarm_id: s0.swarmId, action, items, params: sent, base_revision: s0.graph?.revision ?? null }, describe)
      const f: HostConfirmFinal = p.ok ? await ask(p.intent) : { kind: 'refused', reason: 'invalid', message: p.message }
      // review B1: a confirm cancelled by an identity change writes nothing to the session
      if (f.kind === 'stale') return
      const r = finalAsResult(f)
      const now = useHive.getState()
      const cur = now.programSessions[key]
      // another connection (a different client, session or init): nothing is written
      if (!cur || now.client !== st.client || now.session !== st.session || now.inits !== st.inits) return
      const out = applyResult(cur, r, { action, items, params, def: actionOf(describe, action), baseRevision: s0.graph?.revision ?? null })
      useHive.setState((x) => ({ programSessions: { ...x.programSessions, [key]: out.session } }))
      if (r.status === 'started') void now.loadGoals(s0.swarmId, true).catch(() => undefined)
      if (out.refresh) void now.programRefresh(key)
    },
    [programId, storeAct, ask],
  )
  return { act, dialog }
}

/** The dialog itself: everything the act will do, bound to the app and action as they were when it opened. */
export function HostConfirmDialog({ programId, intent, shown, stillRunning = false, onConfirm, onClose }: {
  programId: string
  intent: ConfirmIntent
  shown: HostConfirmShown
  /** Kimi r2 #3: the hive still says the earlier attempt is running; the only action is a further check. */
  stillRunning?: boolean
  onConfirm: () => Promise<true | string>
  onClose: () => void
}) {
  const program = useHive((s) => s.programs?.find((p) => p.id === programId))
  const describe = useHive((s) => s.programDetails[programId]?.describe ?? null)
  const swarmName = useHive((s) => s.swarms?.[intent.body.swarm_id]?.name)
  const appName = program?.name ?? programId
  const body = intent.body
  const action = actionOf(describe, body.action)
  // drift: the app's version and the action's declaration as first shown; a change refuses until reopened
  const live = useMemo(() => ({ version: program?.version ?? null, action: action ? JSON.stringify(action) : null }), [program?.version, action])
  const [seen] = useState(live)
  const bound = bindTo(seen, live, ['version', 'action'])
  const label = action?.label ?? body.action
  const items = body.items?.length ? body.items.join(', ') : 'None'
  const facts: [string, ReactNode][] = [
    ['App', appName],
    ['Swarm', swarmName ?? body.swarm_id],
    ['Action', label === body.action ? label : `${label} (${body.action})`],
    ['Applies to', items],
    ['Details', paramsSummary(body.params)],
  ]
  if (body.base_revision) facts.push(['As of', `revision ${body.base_revision}`])
  if (shown.file) facts.push(['File', shown.file.name], ['Type', shown.file.mime], ['Size', fileSize(shown.file.size)])
  facts.push([
    'What happens',
    stillRunning
      ? 'Checking again asks the hive how the earlier attempt ended. Nothing is sent again: if it has finished, you see its result; if it failed, you are asked whether to send it again.'
      : intent.prior
      ? shown.file
        ? `${appName} is sent the file for this action again, as you. The hive keeps its name, type, size and fingerprint in the action record, never the file itself.`
        : `${appName} is sent this action again, in this swarm, as you. The hive checks it is exactly what you confirmed here.`
      : shown.file
        ? `${appName} receives the file for this action. The hive keeps its name, type, size and fingerprint in the action record, never the file itself.`
        : `${appName} carries out this action in this swarm as you. The hive checks it is exactly what you confirmed here.`,
  ])
  if (intent.prior) facts.push(['Last time', stillRunning ? runningWords(appName) : priorWords(intent.prior, recoveryOf(intent), appName)])
  return (
    <DecisionDialog
      icon={shown.file ? 'doc' : 'alert'}
      eyebrow={stillRunning ? 'Still in progress' : intent.prior ? 'Confirm again' : shown.file ? 'Send a file to an app' : 'Confirm an app action'}
      title={stillRunning ? `${label} in ${appName} is still in progress` : shown.file ? `Send “${shown.file.name}” to ${appName}?` : `${label} in ${appName}?`}
      facts={facts}
      bound={bound}
      thing="This app action"
      onClose={onClose}
      actions={[stillRunning
        ? { label: 'Check again', busyLabel: 'Checking', tone: 'primary', run: onConfirm }
        : { label: intent.prior ? 'Confirm again' : shown.file ? 'Send the file' : 'Confirm', busyLabel: shown.file ? 'Sending' : 'Confirming', tone: 'primary', run: onConfirm }]}
    />
  )
}
