/**
 * Performs what the fast path understood (lib/intent), from any classic page or experience: a route with Back, a
 * feature through experiences/targets openFeature, a look applied at once with Undo, and Still's reviewed person-typed
 * hive actions (send, wake, sleep, goal) through the store, exactly as Still does them. Every result becomes a
 * device-local thread row (Host §2.1: fast-path turns never go to the host).
 *
 * Nothing here can perform an app act or a decision: a decision or money feature only opens its existing page or
 * dialog, and app acts only come from the host as `action-needs-confirm` (experiences/ask.test.ts enforces it).
 *
 * ORIGIN (Review B1, 32d704a). Every act runs under the origin it started in (store/ask askOrigin: client, store
 * session, init count, principal, Ask epoch). After every await nothing is dispatched, published or undone unless that
 * origin still holds, so a late answer never writes the earlier person's words into a newly bound thread, and an old
 * Undo never acts on the current client. Outcomes are said honestly: "Sent" only once the hive took the message, and
 * a lifecycle or goal call that did not say yes is "not confirmed", never "Nothing changed" (the store's false/null
 * does not tell a refusal from a lost answer).
 */
import { featureById } from '../registry'
import { openFeature } from '../../experiences/targets'
import { applyLookPatch, lookPatchProblem, type IntentAct } from '../../lib/intent'
import { href, navigate, parse, type Route } from '../../lib/router'
import type { Feature } from '../registry'
import { keepLook, lookState, openGallery, previewLook, type UiPrefs } from '../../shell/uiVariant'
import { askOrigin, useAskStore, lookBase, routeLabel, type AskOrigin, type RowState } from '../../store/ask'
import { storeIdentity, useHive } from '../../store/store'
import { actHandlerFor, type ActHandler } from './handlers'
import { guidedIntent } from '../guided/match'
import { useGuide } from '../guided/store'
import { openSwarmDelete } from '../swarm/deleteRequest'
import { useScene } from '../../scene/sceneStore'
import { useViewer } from '../../scene/viewer'
import { resetPositions } from '../../scene/galaxyPositions'

export interface RunCtx {
  /** what the person typed, for the thread */
  you: string
  /** "on Goals" */
  where?: string
}

export const WAIT_MS = 15_000
function within<T>(p: Promise<T>): Promise<T | 'timeout'> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), WAIT_MS)))]).finally(() => clearTimeout(t))
}

const LOST = 'Not confirmed: the hive’s answer was lost. Look before trying again.'
const EARLIER = 'This was done under an earlier connection or person; nothing was undone.'
/** An Undo that only ever runs under the origin it was made in. */
const fenced = (origin: AskOrigin, fn: () => Promise<void> | void) => () => {
  if (!origin.ok()) throw new Error(EARLIER)
  return fn()
}

/**
 * Move the page now; the returned Back returns only if the person has not moved on since, and only under `origin`.
 * Shared by the fast path and the conductor (`move`: how the page moves; the conductor's moves are the mind's).
 */
export function moveWithBack(hash: string, origin: AskOrigin, move: (r: Route) => void = navigate): () => Promise<void> | void {
  const from = window.location.hash || '#/'
  move(parse(hash))
  return fenced(origin, () => {
    if (window.location.hash === hash) move(parse(from))
  })
}

/** Open a feature now (experiences/targets openFeature); Back when the page moved. Null when it cannot open here. */
export function openWithBack(f: Feature, origin: AskOrigin, mind?: string, swarm?: string): { moved: boolean; to: string; back?: () => Promise<void> | void } | null {
  const from = window.location.hash || '#/'
  const ok = mind || swarm ? openFeature(f, mind, swarm) : openFeature(f)
  if (!ok) return null
  // where the open took the page, read now: a caller that waits afterwards checks this route, not whatever the hash is later
  const to = window.location.hash || '#/'
  const moved = to !== from
  return {
    moved,
    to,
    back: moved
      ? fenced(origin, () => {
          if (window.location.hash !== from) navigate(parse(from))
        })
      : undefined,
  }
}

/**
 * Apply a look now; the Undo restores the look before it (through the client it was kept with). A hive that cannot
 * store a look shows it as a preview instead. 'stale': the origin no longer holds after the save, nothing is said.
 */
export async function applyLookWithUndo(next: UiPrefs, origin: AskOrigin): Promise<{ state: 'kept' | 'preview'; undo: () => Promise<void> | void } | 'stale'> {
  const before = lookState().saved
  const blank: UiPrefs = { variant: null, layout: null, apps: before?.apps ?? null, experience: before?.experience ?? null }
  try {
    await keepLook(origin.client, next)
  } catch {
    // never on a page that has since become someone else's
    if (!origin.ok()) return 'stale'
    previewLook(next)
    return { state: 'preview', undo: fenced(origin, () => previewLook(null)) }
  }
  if (!origin.ok()) return 'stale'
  return { state: 'kept', undo: fenced(origin, async () => void (await keepLook(origin.client, before ?? blank))) }
}

/** Move the page, with a Back that returns only if the person has not moved on since. */
function go(hash: string, label: string, ctx: RunCtx, origin: AskOrigin) {
  const undo = moveWithBack(hash, origin)
  useAskStore.getState().addLocal(ctx.you, `Opened ${label}`, { where: ctx.where, back: true, origin, undo })
}

/** Apply a look the person asked for, now; Undo restores the look before it (through the client it was kept with). */
async function look(next: UiPrefs, label: string, ctx: RunCtx, origin: AskOrigin) {
  const r = await applyLookWithUndo(next, origin)
  if (r === 'stale') return
  const text = r.state === 'preview' ? `${label}. Showing as a preview: this hive could not save it` : `${label}. Changed`
  useAskStore.getState().addLocal(ctx.you, text, { where: ctx.where, origin, undo: r.undo })
}

/**
 * A hive action the person typed: a row at once saying it is under way, then the hive's answer on that row, only
 * under the origin it started in. No answer in WAIT_MS: "nothing is confirmed"; a later answer still settles the row.
 */
async function hiveAct<T>(ctx: RunCtx, origin: AskOrigin, pending: string, job: Promise<T>, said: (r: T) => { text: string; state: RowState }, late: string) {
  const ask = useAskStore.getState()
  const row = ask.addLocal(ctx.you, pending, { where: ctx.where, origin, state: 'sending' })
  let r: T | 'timeout'
  try {
    r = await within(job)
  } catch {
    // an error is not a refusal: the outcome is unknown
    if (origin.ok()) ask.settleLocal(row, LOST, origin, 'failed')
    return
  }
  if (!origin.ok()) return
  if (r === 'timeout') {
    ask.settleLocal(row, late, origin, 'waiting')
    void job.then(
      (v) => {
        const s = said(v)
        ask.settleLocal(row, `${s.text} (the hive answered late)`, origin, s.state)
      },
      () => undefined,
    )
    return
  }
  const s = said(r)
  ask.settleLocal(row, s.text, origin, s.state)
}

/**
 * Run one understood act. Returns false when it was not run (the caller says why). `origin` is where the act started
 * (the caller takes it before any owner handler's await); nothing runs if it no longer holds.
 */
export async function runIntent(act: IntentAct, ctx: RunCtx, origin: AskOrigin = askOrigin()): Promise<boolean> {
  if (!origin.ok()) return true
  const s = useHive.getState()
  const ask = useAskStore.getState()
  const say = (text: string) => ask.addLocal(ctx.you, text, { where: ctx.where, origin })
  const offline = (what: string) => say(`Not connected to the hive, so ${what}.`)
  switch (act.do) {
    case 'route':
      go(href(act.route), act.label, ctx, origin)
      return true
    case 'feature':
    case 'scoped': {
      const f = featureById(act.id)
      if (!f) return false
      const opened = act.do === 'scoped' ? openWithBack(f, origin, act.mind, act.swarm) : openWithBack(f, origin)
      if (!opened) return false
      ask.addLocal(ctx.you, `Opened ${f.label}${f.decision || f.money ? '. Nothing is decided until you do it there' : ''}`, { where: ctx.where, back: opened.moved, origin, undo: opened.back })
      return true
    }
    case 'look': {
      const { saved, base, seeds } = lookBase()
      // a named accent that cannot be read here is said plainly, and nothing changes (never a drifted colour)
      const problem = lookPatchProblem(saved, act.patch, base)
      if (problem) return (say(problem), true)
      await look(applyLookPatch(saved, act.patch, base, seeds), act.label, ctx, origin)
      return true
    }
    case 'open':
      go(href({ name: 'dot', id: act.mind.id }), `your conversation with ${act.mind.name}`, ctx, origin)
      return true
    case 'swarm':
      go(href({ name: 'swarm', id: act.swarm.id }), `the ${act.swarm.name} swarm`, ctx, origin)
      return true
    case 'scroll': {
      const r = act.to === 'needs' ? ({ name: 'approvals' } as const) : act.to === 'learned' ? ({ name: 'swarms' } as const) : ({ name: 'hive' } as const)
      go(href(r), act.to === 'needs' ? 'Decisions waiting on you' : act.to === 'learned' ? 'what swarms believe' : routeLabel(r), ctx, origin)
      return true
    }
    case 'gallery':
      openGallery(true)
      say('Opened Change UI')
      return true
    case 'search':
      s.openPalette(act.text)
      say(`Searching for “${act.text}”`)
      return true
    case 'send': {
      if (!s.client) return (offline('nothing was sent'), true)
      const mind = act.mind
      navigate({ name: 'dot', id: mind.id })
      const before = new Set((s.pending[mind.id] ?? []).map((p) => p.tempId))
      const job = s.sendMessage(mind.id, act.text)
      // the store queues the message before its first await: this is the one this act sent
      const tempId = (useHive.getState().pending[mind.id] ?? []).find((p) => !before.has(p.tempId))?.tempId
      await hiveAct(
        ctx,
        origin,
        `Sending to ${mind.name}: “${act.text}”`,
        job,
        () => {
          const p = tempId ? (useHive.getState().pending[mind.id] ?? []).find((x) => x.tempId === tempId) : undefined
          if (!p) return { text: `Sent to ${mind.name}: “${act.text}”`, state: 'sent' }
          if (p.status === 'failed') return { text: `Not sent to ${mind.name}: the hive did not take it. Your words are kept in the conversation, with Retry.`, state: 'failed' }
          return { text: `Not confirmed: no answer yet about your message to ${mind.name}. See the conversation.`, state: 'waiting' }
        },
        `No answer from the hive yet about your message to ${mind.name}. Nothing is confirmed; it shows in the conversation if it arrives.`,
      )
      return true
    }
    case 'sleep': {
      const name = act.mind.name
      if (!s.client) return (offline(`${name} was not put to sleep`), true)
      // the store re-reads the host's may_sleep and the mind's status at the press (GET /api/agents/{id}), by the one
      // awake rule, and sends nothing unless both hold (Health idle r1.3)
      await hiveAct(
        ctx,
        origin,
        `Asking the hive to put ${name} to sleep…`,
        // r1.4: bound to the identity this act started under (captured with `s`, the same tick as origin.ok())
        s.sleepChecked(act.mind.id, name, storeIdentity(s)),
        (r) => (r ? { text: r.text, state: r.ok ? 'applied' : 'failed' } : { text: LOST, state: 'failed' }),
        `No answer from the hive about putting ${name} to sleep yet. Nothing is confirmed.`,
      )
      return true
    }
    case 'wake': {
      const name = act.mind.name
      if (!s.client) return (offline(`${name} was not woken`), true)
      await hiveAct(
        ctx,
        origin,
        `Asking the hive to wake ${name}…`,
        s.agentAction(act.mind.id, 'wake'),
        // the store's false is a refusal or a lost answer alike: never "Nothing changed"
        (r) => (r ? { text: `Waking ${name}.`, state: 'applied' } : { text: `Not confirmed: the hive did not say yes to waking ${name}. Look at ${name} before trying again.`, state: 'failed' }),
        `No answer from the hive about waking ${name} yet. Nothing is confirmed.`,
      )
      return true
    }
    case 'remind': {
      const name = act.mind.name
      if (!s.client) return (offline(`Health did not remind ${name}`), true)
      // the store re-reads the host's may_remind at the press (GET /api/agents/{id}) and sends nothing unless it holds
      await hiveAct(
        ctx,
        origin,
        `Asking Health to remind ${name}…`,
        // a refusal the shapes name is said plainly (the store's words); any other error is a lost answer
        s.remindIdle(act.mind.id, name, storeIdentity(s)),
        (r) => (r ? { text: r.text, state: r.ok ? 'applied' : 'failed' } : { text: LOST, state: 'failed' }),
        `No answer from the hive about reminding ${name} yet. Nothing is confirmed.`,
      )
      return true
    }
    case 'goal': {
      if (!s.client) return (offline('no task was made'), true)
      await hiveAct(
        ctx,
        origin,
        `Asking the hive for a new task for ${act.swarm.name}…`,
        s.createGoal(act.swarm.id, { title: act.title }),
        // null is a refusal or a lost answer alike (the store does not say which): unknown, never "Nothing changed"
        (g) => (g ? { text: `${act.swarm.name} has a new task: “${g.title}”.`, state: 'applied' } : { text: `Not confirmed: the hive did not say the task for ${act.swarm.name} was made. Look at its tasks before asking again.`, state: 'failed' }),
        `No answer from the hive about the task for ${act.swarm.name} yet. Nothing is confirmed.`,
      )
      return true
    }
    case 'guide': {
      // a guided demo: it drives the screen client-side, step by step, under this origin (features/guided)
      const g = guidedIntent(act.text)
      if (!g) return false
      return useGuide.getState().start(g, { you: ctx.you, where: ctx.where, origin })
    }
    case 'deleteSwarm':
      // the warning: its minds, tasks and history, and the exact name typed before the one press (SwarmDeleteDialog)
      openSwarmDelete(act.swarm.id)
      say(`Opened the warning for deleting ${act.swarm.name} and its minds. Nothing is deleted until you type its name and press Delete`)
      return true
    case 'map':
      return runMap(act, say)
    case 'mind':
      return false
  }
}

/**
 * The hive map's own words (lib/intent/hiveMap): the view moves, or the person's own arrangement is put back. Nothing
 * on the hive changes. Only where the map is drawn (Classic); elsewhere it says so and changes nothing.
 */
function runMap(act: Extract<IntentAct, { do: 'map' }>, say: (text: string) => void): boolean {
  const engine = useScene.getState().engine
  if (!engine) return (say('The hive map is shown in Classic. Switch to Classic to see it'), true)
  if (parse(window.location.hash).name !== 'hive') navigate({ name: 'hive' })
  switch (act.op) {
    case 'overview':
      engine.overview()
      say('Showing every hive')
      return true
    case 'zoomIn':
      engine.zoomBy(1.6)
      say('Zoomed in')
      return true
    case 'zoomOut':
      engine.zoomBy(1 / 1.6)
      say('Zoomed out')
      return true
    case 'galaxy':
      if (!act.hive || !engine.flyToGalaxy(act.hive)) return (say(`${act.label} is not on your map now`), true)
      say(`Showing ${act.label}`)
      return true
    case 'resetLayout':
      resetPositions(useViewer.getState().viewer.principal)
      engine.setPinned({})
      engine.overview()
      say('Put the hives back in their own places. Only your view changed')
      return true
  }
}

/**
 * What the Ask field does with an understood act (useAskField's run): the experience's own handler first (Still's
 * sheets), then the shared runner. Both run under the origin taken before the first await (Review B1); 'stale' means
 * the session, person or thread changed meanwhile, so nothing more ran and the caller keeps none of the words.
 */
export async function performAct(act: IntentAct, ctx: RunCtx & { experience: string; onAct?: ActHandler }, origin: AskOrigin = askOrigin()): Promise<'stale' | boolean | 'keep'> {
  const own = ctx.onAct ?? actHandlerFor(ctx.experience)
  const handled = own ? await own(act, ctx.you) : false
  if (!origin.ok()) return 'stale'
  if (!handled) await runIntent(act, { you: ctx.you, where: ctx.where }, origin)
  if (!origin.ok()) return 'stale'
  return handled
}
