/**
 * The Ask conductor's executor (ASK_CONDUCTOR_ACTION_VOCABULARY_v1_20261007, confirmed by Platform). The host's
 * conductor streams `act` frames; the store hands each one here in seq order, once. Each act is applied at once, on
 * screen only, and its result is posted back with the page view after it, so the conductor sees the new screen
 * without screenshots:
 *
 *   POST /api/ask/{op}/acts/{act_id}/result  { ok, reason?, view, route, experience }   (≤ 8 KB)
 *
 * Rules carried here:
 *  - ORIGIN. A turn's acts run under the origin taken at its first act (store/ask askOrigin: client, session,
 *    person, epoch). If that no longer holds nothing is applied and nothing is posted (a different person's client
 *    never answers for this one). If the turn is no longer the open one, or the person took over the page, the act is
 *    answered `stale_origin` and not applied.
 *  - REUSE. Moves, feature opens and looks go through the fast path's own cores (run.ts moveWithBack, openWithBack,
 *    applyLookWithUndo), so their Back and Undo are the same, fenced to the origin, shown on the turn's thread row.
 *  - FILL types only into a field the page declared (fields.ts), through its own setter. It never submits.
 *  - PRIVATE APPS (Atlas, Truth): no view or id leaves them (the result's view is empty and its route is 'private'),
 *    no act is done on their pages, and the conductor does not move the page into them (`private`). The host drops
 *    such acts too; this is the client's fence.
 *  - REASONS (Platform r2 Q3, r3): invalid | not_declared | act_cap | private | blocked (could not proceed, for no
 *    more specific reason), plus stale_origin (the turn is not the open
 *    one, the person took over, or the page holds unsaved changes) and reduced_motion_skipped (done, without motion).
 *  - REFUSED APPS: a move (navigate or open) into an app the current swarm refuses is still made, so the person sees
 *    RefusedHere as today, but it is answered ok:false with the fixed reason REFUSED_APP_REASON, never ok. The check is
 *    ProgramHost's own: the app's session for that swarm reads 403 program_refused. A read that has not settled in
 *    time is answered ok:false too (APP_UNRESOLVED_REASON): unconfirmed is never ok.
 *  - REDUCED MOTION: presence never travels; a point is still shown in place and answered ok.
 *  - TOUR.STEP is the guided-demo runner (features/guided/store tourStep): screen-only, like every act here.
 *  - At most 32 acts per turn; the rest are answered `act_cap` and the thread says so once.
 *  - The result route: 409 means already recorded (success, not retried); 404 means not this person's turn: the
 *    conductor stops for that turn.
 */
import { ACT_RESULT_MAX_BYTES, type ActReason, type ActResult, type AskEvent, type AskView } from '../../api/ask'
import { ApiError } from '../../api/client'
import { experienceById, EXPERIENCES } from '../../experiences/registry'
import { resolvePresence } from '../../lib/presence'
import { href, parse, type Route } from '../../lib/router'
import { lookState } from '../../shell/uiVariant'
import { askOrigin, markMindMove, moveAsMind, proposalRoute, proposedLook, routeLabel, setConductor, useAskStore, type AskOrigin, type RowState } from '../../store/ask'
import { featureById } from '../registry'
import { contextRoute, isPrivateAppRoute, isPrivateRoute, pageView, whereOf } from './context'
import { isPrivateHash } from './view'
import { domUnsaved, hasUnsaved } from './dirty'
import { fillField } from './fields'
import { applyLookWithUndo, moveWithBack, openWithBack } from './run'
import { tourStep } from '../guided/store'
import { useHive } from '../../store/store'
import { sessionKey } from '../../store/programSession'
import { appAskTracked, framePresentsAsk, hostPresentsAppAskAct } from '../../store/appAsk'
import { admitHostAskAct, hostAskRecipient } from '../../api/appAsk'

export const ACTS_PER_TURN = 32

type ActFrame = Extract<AskEvent, { phase: 'act' }>
type Act = ActFrame['act']

interface Run {
  origin: AskOrigin
  chain: Promise<void>
  posts: Promise<void>[]
  /** acts seen (applied or answered) this turn */
  count: number
  lastSeq: number
  /** the host said this is not the person's turn (404): nothing more is done for it */
  stopped: boolean
  capped: boolean
}
const runs = new Map<string, Run>()

/**
 * The fixed result code of a move into an app the current swarm refuses. The host's closed reason set
 * (core/conductor.py RESULT_REASONS) has no refusal code of its own, so it is 'blocked' (could not proceed); any other
 * word would be refused 400 by the host. The thread row says what happened in plain words.
 */
export const REFUSED_APP_REASON: ActReason = 'blocked'
/** How long a move into an app waits for the app's read to begin (no app session: nothing refused it). */
export const APP_READ_START_MS = 800
/** How long a move into an app waits, at most, for that read to settle. */
export const APP_READ_SETTLE_MS = 4000
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

/**
 * The fixed result code of a move into an app whose read did not settle in time: it is not known whether the swarm
 * allows it, so it is never answered ok (r2 P2). The host's closed set has no "unconfirmed" code; the closest is
 * 'blocked' (could not proceed, for no more specific reason), the same word as a refusal. The thread row tells them
 * apart in plain words.
 */
export const APP_UNRESOLVED_REASON: ActReason = 'blocked'

/** What a move into an app found: allowed (or not an app the host reads), refused (RefusedHere), or not known in time. */
export type AppRead = 'allowed' | 'refused' | 'unresolved'

/**
 * Whether the page, moved to `hash`, now shows an app its swarm refuses: ProgramHost's own check (the app's session
 * for that swarm settled with 403 program_refused and no graph, which is when it shows RefusedHere).
 *  - 'allowed': not an app route; the read settled with anything else; or no read began (an app shown through its own
 *    frame or a form, which has no session), or the origin no longer holds (the caller posts nothing then).
 *  - 'refused': settled as program_refused.
 *  - 'unresolved': a read began but had not settled after `settleMs`, or the turn stopped holding (closed, or the
 *    person took over) while it was still loading: never taken as allowed, and never held past the turn.
 */
export async function refusedApp(hash: string, origin: AskOrigin, holds: () => boolean = () => true, startMs = APP_READ_START_MS, settleMs = APP_READ_SETTLE_MS): Promise<AppRead> {
  let target: Route
  try {
    target = parse(hash)
  } catch {
    return 'allowed'
  }
  if (target.name !== 'program') return 'allowed'
  const began = Date.now()
  // the read starts when the page renders the app: give it a moment, so a settled read from before is not taken
  await sleep(50)
  for (;;) {
    if (!origin.ok()) return 'allowed'
    const now = here()
    // the swarm: the route's own, or the one the app page settled on (it rewrites the route with it)
    const swarm = target.swarm ?? (now.name === 'program' && now.id === target.id ? now.swarm : undefined)
    const s = swarm ? useHive.getState().programSessions[sessionKey(target.id, swarm)] : undefined
    if (s && !s.loading && (s.error || s.graph)) return !s.graph && s.error?.code === 'program_refused' ? 'refused' : 'allowed'
    const waited = Date.now() - began
    if (!s && waited >= startMs) return 'allowed'
    if (waited >= settleMs) return 'unresolved'
    // the turn closed or the person took over: stop waiting now (its late result is answered 409 anyway)
    if (!holds()) return 'unresolved'
    await sleep(50)
  }
}

/** The answer for a move into an app that was not plainly allowed: refused, or not known in time. */
function appMoveDone(read: AppRead, label: string, back: (() => Promise<void> | void) | undefined): Done | null {
  if (read === 'refused') return { ok: false, reason: REFUSED_APP_REASON, row: { text: `Opened ${label}, but this swarm doesn’t allow it here.`, state: 'failed', back: !!back }, undo: back }
  if (read === 'unresolved') return { ok: false, reason: APP_UNRESOLVED_REASON, row: { text: `Opened ${label}, but it didn’t finish loading, so it isn’t known yet whether this swarm allows it.`, state: 'failed', back: !!back }, undo: back }
  return null
}

interface Done {
  ok: boolean
  reason?: ActReason
  /** the thread row for it (navigate, open, look, fill) */
  row?: { text: string; state: RowState; back?: boolean }
  undo?: () => Promise<void> | void
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
const words = (s: string | undefined, max = 60) => (s ?? '').replace(/[<>]/g, '').slice(0, max)

const rawHash = () => (typeof window === 'undefined' ? '#/' : window.location.hash || '#/')
/** The page now; an unreadable hash (a malformed escape) reads as the hive, and as private (inPrivate). */
const here = (): Route => {
  try {
    return parse(rawHash())
  } catch {
    return { name: 'hive' }
  }
}
/** On a private app's page now: by the route, and by the raw hash (decoded, lowercased; unreadable = private). */
const inPrivate = (): boolean => isPrivateHash(rawHash()) || isPrivateRoute(here())
export const currentExperience = (): string => experienceById((lookState().preview ?? lookState().saved)?.experience).id
export const reducedMotion = (): boolean => (typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) || lookState().saved?.variant?.motion === 'none'
const doc = () => (typeof document === 'undefined' ? null : document)
const viewport = () => ({ width: typeof window === 'undefined' ? 0 : window.innerWidth, height: typeof window === 'undefined' ? 0 : window.innerHeight })

/** The result body (≤ 8 KB): what happened and the page now. A private app's page gives an empty view. */
export function resultBody(ok: boolean, reason?: ActReason): ActResult {
  const r = here()
  const experience = currentExperience()
  const priv = inPrivate()
  const view: AskView = priv ? {} : pageView(r, whereOf(r, experience))
  // a private app's page names nothing: not its id in the route either (Platform r2 Q6)
  const body: ActResult = { ok, ...(reason ? { reason } : {}), view, route: priv ? 'private' : contextRoute(r), experience }
  // the view is ≤ 2 KB already; trimmed further rather than ever sent over 8 KB
  while (bytes(body) > ACT_RESULT_MAX_BYTES && body.view.refs?.length) body.view.refs = body.view.refs.slice(0, -1)
  if (bytes(body) > ACT_RESULT_MAX_BYTES) body.view = {}
  return body
}

/** The turn is still the person's open turn, and they have not taken over the page. */
function turnHolds(op: string): boolean {
  const s = useAskStore.getState()
  const t = s.turns[op]
  return !!t && s.open === op && (t.state === 'open' || t.state === 'sending') && !t.tookOver
}

/** A point or highlight: shown only where the target is on screen now; never searched for or scrolled to. */
function presence(op: string, seq: number, act: Extract<Act, { kind: 'point' | 'highlight' }>): Done {
  const root = doc()
  const found = root ? resolvePresence(act.target, root, viewport()) : { kind: 'not-on-screen' as const }
  if (found.kind !== 'found') return { ok: false, reason: 'not_declared' }
  const thread = useAskStore.getState().thread
  const highlight = act.kind === 'highlight'
  useAskStore.getState().showPresence({
    id: `${op}#${seq}`,
    op,
    actor: thread?.mind ?? { id: 'ask', name: 'the orchestrator' },
    verb: highlight ? (act.ink ? 'sketch' : 'look') : 'point',
    target: act.target,
    caption: words(act.caption ?? act.label, 140),
    at: Date.now(),
    still: highlight || undefined,
  })
  // reduced motion: shown in place, without travel; still done
  return !highlight && reducedMotion() ? { ok: true, reason: 'reduced_motion_skipped' } : { ok: true }
}

function scroll(act: Extract<Act, { kind: 'scroll' }>): Done {
  const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth'
  const root = doc()
  if (act.target) {
    const found = root ? resolvePresence(act.target, root, { width: Infinity, height: Infinity }) : { kind: 'not-on-screen' as const }
    if (found.kind !== 'found') return { ok: false, reason: 'not_declared' }
    ;(found.els[0] as unknown as Element).scrollIntoView?.({ block: 'center', behavior })
    return { ok: true }
  }
  const page = root?.querySelector?.('[data-presence-region="page"]') as HTMLElement | null | undefined
  for (const el of [page, root?.scrollingElement as HTMLElement | null | undefined]) {
    if (!el?.scrollTo) continue
    el.scrollTo({ top: act.to === 'top' ? 0 : el.scrollHeight, behavior })
  }
  return { ok: true }
}

/** Apply one readable act. Every branch is on-screen only. */
async function perform(op: string, seq: number, act: Exclude<Act, { kind: 'unreadable' }>, origin: AskOrigin, alive?: () => boolean): Promise<Done | 'stale'> {
  const priv = inPrivate()
  // on a private app's page nothing is pointed at, filled or scrolled; leaving it by a move is fine
  if (priv && act.kind !== 'navigate' && act.kind !== 'open' && act.kind !== 'look') return { ok: false, reason: 'private' }
  const unsaved = () => hasUnsaved({ domUnsaved, lookPreview: () => lookState().preview !== null })
  switch (act.kind) {
    case 'navigate': {
      // the raw route first: an encoded private app never reaches the router (and a malformed escape is private)
      if (isPrivateHash(act.route)) return { ok: false, reason: 'private' }
      let target: ReturnType<typeof proposalRoute>
      try {
        target = proposalRoute(act.route)
      } catch {
        return { ok: false, reason: 'private' }
      }
      if (!target) return { ok: false, reason: 'not_declared' }
      const label = words(act.label) || routeLabel(target.route)
      if (isPrivateAppRoute(target.route) || isPrivateHash(target.hash)) return { ok: false, reason: 'private' }
      if (unsaved()) return { ok: false, reason: 'stale_origin', row: { text: `Not opened: ${label}. This page has unsaved changes.`, state: 'failed' } }
      const animate = act.animate === true && !reducedMotion()
      const back = moveWithBack(target.hash, origin, (r) => moveAsMind(r, animate))
      // moved into an app this swarm refuses (the person sees RefusedHere), or whose read did not settle: never ok
      const notAllowed = appMoveDone(await refusedApp(target.hash, origin, () => turnHolds(op)), label, back)
      if (notAllowed) return notAllowed
      return { ok: true, row: { text: `Opened ${label}`, state: 'applied', back: true }, undo: back }
    }
    case 'open': {
      const f = featureById(act.feature)
      if (!f) return { ok: false, reason: 'not_declared' }
      if (f.classic && (isPrivateAppRoute(f.classic) || isPrivateHash(href(f.classic)))) return { ok: false, reason: 'private' }
      if (unsaved()) return { ok: false, reason: 'stale_origin', row: { text: `Not opened: ${f.label}. This page has unsaved changes.`, state: 'failed' } }
      const e = act.entity
      // the page moves for the mind: the takeover watch must not read its hash change as the person's Back
      markMindMove()
      const opened = openWithBack(f, origin, e?.kind === 'mind' ? e.ref : undefined, e?.kind === 'swarm' ? e.ref : undefined)
      // the feature exists but cannot be opened here (it needs a subject this page does not give): blocked
      if (!opened) return { ok: false, reason: 'blocked' }
      const notAllowed = opened.moved ? appMoveDone(await refusedApp(opened.to, origin, () => turnHolds(op)), f.label, opened.back) : null
      if (notAllowed) return notAllowed
      const decision = f.decision || f.money ? '. Nothing is decided until you do it there' : ''
      return { ok: true, row: { text: `Opened ${f.label}${decision}`, state: 'applied', back: opened.moved }, undo: opened.back }
    }
    case 'look': {
      const prefs = { ...act.prefs, ...(act.prefs.variant === null ? { variant: 'default' } : {}) }
      const { next, dropped } = proposedLook(prefs, lookState().saved, EXPERIENCES)
      // a look this build cannot show in full is not guessed at: nothing changes
      if (dropped.length) return { ok: false, reason: 'invalid', row: { text: `Not changed: ${dropped.join(', ')}.`, state: 'failed' } }
      const label = words(act.label) || 'A new look'
      const r = await applyLookWithUndo(next, origin)
      if (r === 'stale') return 'stale'
      return { ok: true, row: { text: r.state === 'preview' ? `${label}. Showing as a preview: this hive could not save it` : `${label}. Changed`, state: 'applied' }, undo: r.undo }
    }
    case 'point':
    case 'highlight':
      return presence(op, seq, act)
    case 'fill': {
      const field = fillField(act.field, act.text)
      if (!field) return { ok: false, reason: 'not_declared' }
      const shown = act.text.length > 60 ? `${act.text.slice(0, 60)}…` : act.text
      return { ok: true, row: { text: `Typed into ${field.label}: “${shown}”. Nothing is sent until you do.`, state: 'applied' } }
    }
    case 'scroll':
      return scroll(act)
    case 'tour.step': {
      // the guided-demo runner (features/guided) places the demo at the step and plays it on screen, under this
      // turn's origin; the person always wins (a demo they paused or took over is not moved)
      if (unsaved()) return { ok: false, reason: 'stale_origin', row: { text: 'Not moved: this page has unsaved changes.', state: 'failed' } }
      const r = await tourStep(act.script, act.step, origin, op, reducedMotion(), alive)
      return r.ok ? { ok: true, ...(r.reason ? { reason: r.reason } : {}) } : { ok: false, reason: r.reason }
    }
  }
}

function post(run: Run, op: string, actId: string, body: ActResult): void {
  const client = run.origin.client
  if (!client?.askActResult || !run.origin.ok() || framePresentsAsk(op)) return
  run.posts.push(
    client.askActResult(op, actId, body).then(
      () => undefined,
      (err: unknown) => {
        // 409: already recorded (act_result_recorded), which is success; or turn_closed: the person took over (or the
        // turn ended) before this result arrived, which is expected. Neither is an error; never retried
        if (err instanceof ApiError && err.status === 409) return
        // 404: not this person's turn (or not one the host has): the conductor stops for it
        if (err instanceof ApiError && err.status === 404 && !run.stopped) {
          run.stopped = true
          if (run.origin.ok()) useAskStore.getState().turnNote(op, 'Stopped following the orchestrator’s steps on this page: the hive does not have this turn for you.')
        }
        // anything else: the host carries on without it after its own wait (no_result)
      },
    ),
  )
}

async function step(op: string, e: ActFrame, run: Run): Promise<void> {
  if (run.stopped || e.seq <= run.lastSeq) return
  run.lastSeq = e.seq
  const tracked = () => appAskTracked(op) || useAskStore.getState().turns[op]?.appAsk === true
  const origin: AskOrigin = { ...run.origin, ok: () => run.origin.ok() && !framePresentsAsk(op) && (!tracked() || hostPresentsAppAskAct(op, e.turn_id, e.recipient)) }
  // a different person, session or client: nothing is applied and nothing answers for them
  if (!origin.ok()) return
  // Last authoritative admission before any perform() screen effect. A lost/duplicate claim never executes/retries.
  if (!await admitHostAskAct({ recipient: e.recipient, tracked: tracked(),
    operation: op, act: e.act.act_id, current: origin.ok, claim: origin.client?.askActClaim?.bind(origin.client) })) return
  if (!origin.ok()) return   // same synchronous tick as the first possible effect after the awaited claim
  const act = e.act
  const answer = (ok: boolean, reason?: ActReason) => post(run, op, act.act_id, resultBody(ok, reason))
  if (++run.count > ACTS_PER_TURN) {
    if (!run.capped) {
      run.capped = true
      useAskStore.getState().turnNote(op, `The orchestrator asked for more than ${ACTS_PER_TURN} steps on the page in one go; the rest were not done here.`)
    }
    return answer(false, 'act_cap')
  }
  if (act.kind === 'unreadable') return answer(false, 'invalid')
  if (!turnHolds(op)) return answer(false, 'stale_origin')
  let done: Done | 'stale'
  try {
    done = await perform(op, e.seq, act, origin)
  } catch {
    // applying it failed, for no reason more specific than that
    done = { ok: false, reason: 'blocked' }
  }
  if (done === 'stale' || !origin.ok()) return
  if (done.row) useAskStore.getState().actOutcome(op, e.seq, done.row, done.undo, origin)
  answer(done.ok, done.reason)
}

/** Take one act frame (the store calls this in seq order): queued behind the turn's earlier acts, applied once. */
export function conduct(op: string, e: ActFrame): void {
  if (framePresentsAsk(op) || !hostAskRecipient(e.recipient, appAskTracked(op) || useAskStore.getState().turns[op]?.appAsk === true)) return
  let run = runs.get(op)
  if (!run) {
    run = { origin: askOrigin(), chain: Promise.resolve(), posts: [], count: 0, lastSeq: 0, stopped: false, capped: false }
    runs.set(op, run)
    // only recent turns are remembered
    if (runs.size > 20) runs.delete(runs.keys().next().value!)
  }
  const r = run
  r.chain = r.chain.then(() => step(op, e, r)).catch(() => undefined)
}

/** An act as `perform` takes it: any readable conductor act. */
export type LocalAct = Exclude<Act, { kind: 'unreadable' }>

/**
 * The demo showreel's acts (features/showreel; demo mode only): one act applied through this same executor, under the
 * showreel's own origin, so a move, open, point or tour step is exactly what the conductor does for a turn (the same
 * private-app fence, unsaved-changes refusal, refused-app reading and reduced-motion answer). There is no turn: nothing
 * is posted to the hive and no thread row is written. `op` names the showreel step (its presence and tour step).
 *
 * `alive` (D4 r2): the showreel's own step check, so an act already in flight does nothing more once the person takes
 * over. A move or point runs under an origin that folds it in (every origin.ok() the executor makes after an await
 * fails, and the act answers stale_origin). A tour step keeps the plain origin (the guided run keeps it for as long as
 * it shows, past this step) and is handed `alive` itself: it is checked before the step is placed and once it shows.
 */
export async function performLocal(op: string, seq: number, act: LocalAct, origin: AskOrigin, alive: () => boolean = () => true): Promise<{ ok: boolean; reason?: ActReason }> {
  const fenced: AskOrigin = { ...origin, ok: () => origin.ok() && alive() }
  if (!fenced.ok()) return { ok: false, reason: 'stale_origin' }
  try {
    const done = await perform(op, seq, act, act.kind === 'tour.step' ? origin : fenced, alive)
    if (done === 'stale' || !fenced.ok()) return { ok: false, reason: 'stale_origin' }
    return { ok: done.ok, ...(done.reason ? { reason: done.reason } : {}) }
  } catch {
    return { ok: false, reason: 'blocked' }
  }
}

/** Tests and checks: resolves once every act queued for the turn has run and its result post has settled. */
export async function conductorSettled(op: string): Promise<void> {
  const r = runs.get(op)
  if (!r) return
  let seen = -1
  while (seen !== r.posts.length) {
    await r.chain
    seen = r.posts.length
    await Promise.all(r.posts)
  }
}

/** Tests: forget every turn's run. */
export function resetConductor(): void {
  runs.clear()
}

setConductor(conduct)
