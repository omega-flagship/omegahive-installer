/**
 * The person's three decisions on a request (Apply, Ask for changes, Discard), routed in ONE place.
 *
 * - The engine drives the request (GET …/controller answered): the decisions go ONLY through the engine's person
 *   routes. Its reducer journals approval-needed → approved → applied around the real effect, so the canvas's older
 *   accept / reject / consent paths would let its state and the person's file drift apart; they are never used here.
 *   Ask for changes goes to the engine too (it re-prompts its helper), not discard + a new request.
 *   A route the client does not carry yet: the button stays, disabled, with one calm line; no fallback.
 * - No controller run (an older host, 404) or no controller read on this client: there is no reducer to drift from, so
 *   the canvas's existing paths are used exactly as today (DecisionDialog accept, the consent route where copy-apply is
 *   on, reject / decline; Ask for changes = discard through reject, then a new request on the same scope).
 * - Not known yet (the controller read has not answered, or failed): nothing is offered until it is known.
 *
 * The engine's person routes (host commit 826b23a0): HiveClient.requestApply(id), requestChanges(id, text),
 * requestDiscard(id) (src/api/client.ts; live.ts POST /api/requests/{id}/controller/apply | changes | discard). Each
 * answers 200 with the controller view, which is parsed and handed back at once (`after(view)`); the event re-read
 * follows. Whether each is offered now is the engine's own word (`state.actions[name].available`, its `why_not` the one
 * line); a refusal becomes plain words (actionRefusalWords), never a code.
 */
import { ApiError } from '../../../../api/client'
import { carriesController, parseControllerState, type ActionName, type ControllerState } from './controllerState'

export interface PersonRoutesClient {
  requestApply?: (requestId: string) => Promise<unknown>
  requestChanges?: (requestId: string, text: string) => Promise<unknown>
  requestDiscard?: (requestId: string) => Promise<unknown>
}
export interface LegacyPaths {
  apply: () => void
  discard: () => void
  askChanges: (note: string) => void
}
/** How the controller read stands for the shown request. */
export type Driver = { kind: 'engine'; requestId: string; state: ControllerState } | { kind: 'none' } | { kind: 'checking' }
export interface RoutedActions {
  /** null: shown, but not offered here */
  apply: (() => void | Promise<void>) | null
  discard: (() => void | Promise<void>) | null
  askChanges: ((note: string) => void | Promise<void>) | null
  /** one calm line under the actions, when something is not offered */
  line: string | null
  via: 'engine' | 'canvas' | 'checking'
  /** the longest note Ask for changes takes on this path */
  noteMax: number
}

/** the engine's change note: 1–4000 characters (host request_changes) */
export const ENGINE_NOTE_MAX = 4000
/** the canvas's own path folds the note into the next instruction: kept short */
export const CANVAS_NOTE_MAX = 600

/** A person route that didn't go through, already in plain words (`message`). */
export class ActionRefused extends Error {
  readonly action: ActionName
  constructor(action: ActionName, words: string) {
    super(words)
    this.name = 'ActionRefused'
    this.action = action
  }
}

const CONSENT_CODES = new Set(['lease_required', 'not_controller', 'request_closed'])
/** What a refused person route means, in plain words (never a code). Pure. */
export function actionRefusalWords(action: ActionName, e: unknown): string {
  const status = e instanceof ApiError ? e.status : null
  const code = e instanceof ApiError ? e.code : null
  if (code === 'copy_apply_off') return 'Applying isn’t switched on for this project yet.'
  if (code === 'not_ready') return action === 'apply' ? 'It isn’t ready to apply yet — the work is still moving.' : 'It isn’t ready for that yet — the work is still moving.'
  if (code === 'not_request_person') return 'Only the person who asked can decide on this change.'
  if (status === 404) return 'This request is no longer here.'
  // the person's own consent record (copy-apply consent) refused before anything was applied
  if (action === 'apply' && code && (CONSENT_CODES.has(code) || code.startsWith('consent') || status === 400)) return 'Your OK couldn’t be recorded, so nothing was applied.'
  if (action === 'changes' && status === 400) return 'Say what should change in a few words (up to 4000 characters).'
  return 'That didn’t go through. Nothing changed.'
}

/** beside Apply when the proposal had no second opinion (unreviewed under the person's review setting) */
export const UNREVIEWED_LINE = 'Not reviewed. Look it over before you apply.'
const OFFER = (names: string[]) => `${names.join(' and ')} ${names.length === 1 ? 'arrives' : 'arrive'} here as soon as this hive offers ${names.length === 1 ? 'it' : 'them'}.`
/** the host's reason as a sentence */
const sentence = (s: string) => { const t = s.trim(); return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?…]$/.test(t) ? '' : '.'}` : t }

/** Which way the request's controller read points: the engine, the canvas's own paths, or not known yet. */
export function driverOf(client: unknown, requestId: string | null, read: { kind: 'engine'; state: ControllerState } | { kind: 'none' } | { kind: 'unknown' } | null): Driver {
  if (!carriesController(client) || !requestId) return { kind: 'none' }
  if (!read || read.kind === 'unknown') return { kind: 'checking' }
  if (read.kind === 'none') return { kind: 'none' }
  return read.state.request_id === requestId ? { kind: 'engine', requestId, state: read.state } : { kind: 'checking' }
}

/**
 * The three decisions for this request. `after(view)`: called once an engine route answered, with the view it answered
 * (parsed; null when it can't be trusted, then re-read). Engine route failures reject with ActionRefused (plain words).
 * Each is offered only when the client carries its route AND the engine says it is available (an engine that does not
 * describe an action leaves it to the route, which answers plainly if it refuses).
 */
export function routeActions(client: unknown, driver: Driver, legacy: LegacyPaths, after: (view: ControllerState | null) => void): RoutedActions {
  if (driver.kind === 'none') return { apply: legacy.apply, discard: legacy.discard, askChanges: legacy.askChanges, line: null, via: 'canvas', noteMax: CANVAS_NOTE_MAX }
  if (driver.kind === 'checking') return { apply: null, discard: null, askChanges: null, line: 'Checking how this hive applies changes…', via: 'checking', noteMax: ENGINE_NOTE_MAX }
  const c = (client ?? {}) as PersonRoutesClient
  const id = driver.requestId
  const described = driver.state.actions
  const run = (name: ActionName, call: () => Promise<unknown>) => async () => {
    let raw: unknown
    try {
      raw = await call()
    } catch (e) {
      throw new ActionRefused(name, actionRefusalWords(name, e))
    }
    const view = parseControllerState(raw)
    after(view && view.request_id === id ? view : null)
  }
  const offered = (name: ActionName, has: boolean) => has && (described[name]?.available ?? true)
  const apply = offered('apply', !!c.requestApply) ? run('apply', () => c.requestApply!(id)) : null
  const discard = offered('discard', !!c.requestDiscard) ? run('discard', () => c.requestDiscard!(id)) : null
  const askChanges = offered('changes', !!c.requestChanges)
    ? async (note: string) => {
        const text = note.trim()
        if (!text || text.length > ENGINE_NOTE_MAX) throw new ActionRefused('changes', 'Say what should change in a few words (up to 4000 characters).')
        await run('changes', () => c.requestChanges!(id, text))()
      }
    : null
  const missing = [c.requestApply ? null : 'Apply', c.requestChanges ? null : 'Ask for changes', c.requestDiscard ? null : 'Discard'].filter((x): x is string => !!x)
  // the one line: Apply's reason first, else the first reason the engine gives, else what this hive doesn't offer yet
  const why = (name: ActionName, has: boolean) => (has && described[name] && !described[name]!.available ? described[name]!.why_not : null)
  const applyWhy = why('apply', !!c.requestApply)
  const reason = !apply && !c.requestApply ? null : applyWhy ?? why('changes', !!c.requestChanges) ?? why('discard', !!c.requestDiscard)
  const line = !apply && !c.requestApply ? OFFER(missing.length === 3 ? ['Apply'] : missing) : reason ? sentence(reason) : missing.length ? OFFER(missing) : null
  // R3.12: Apply offered on a proposal no second opinion checked (the person's review setting allowed it): said beside
  // Apply, plainly, whenever no other line takes the place
  const unreviewedLine = apply && driver.state.status === 'ready_for_you' && driver.state.unreviewed ? UNREVIEWED_LINE : null
  return { apply, discard, askChanges, line: line ?? unreviewedLine, via: 'engine', noteMax: ENGINE_NOTE_MAX }
}

/**
 * The canvas's own path (no controller drives the request): Apply is offered only once the proposal passed its test on
 * a copy, as the design says (tested, then reviewed, then yours). `testsHere`: this hive runs tests on a copy at all; a
 * hive without them never holds Apply back on a test it cannot run. The engine path needs none of this: the controller
 * says itself whether Apply is available (actions[].available, why_not).
 */
export function canvasApplyGate(stages: readonly { key: string; state: string }[], testsHere: boolean): { ok: true } | { ok: false; why: string } {
  if (!testsHere) return { ok: true }
  const test = stages.find((s) => s.key === 'test')
  const review = stages.find((s) => s.key === 'review')
  if (test?.state === 'failed') return { ok: false, why: 'A test failed on a copy. Ask for changes, or discard it.' }
  if (test?.state !== 'done') return { ok: false, why: 'Waiting for the test on a copy.' }
  if (review?.state === 'active') return { ok: false, why: 'Waiting for the review.' }
  if (review?.state === 'failed') return { ok: false, why: 'The review asked for changes. Ask for changes, or discard it.' }
  return { ok: true }
}
