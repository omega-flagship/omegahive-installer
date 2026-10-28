/**
 * The vibe flow's state, outside React (r3: stand-in Review P1-1, P1-2, P2-3; so its rules are tested as behaviour):
 * say what you want → scope → a mind's proposal → integrity check → placed in the code → keep/skip → confirm → decide.
 *
 * - **One request at a time, fenced.** Every ask has a request number; a newer ask (or a reset) makes every earlier
 *   continuation a no-op. Instruction, scope, proposal, integrity verdict and placement are ONE associated result,
 *   set together or not at all, so the confirm can never pair one request's scope with another's proposal.
 * - **Bound to its file.** The result carries the saved file it was placed on (path + digest). Shown on another file
 *   (or another version of it), nothing is drawn and nothing can be decided.
 * - **Integrity per read.** Every read that replaces the shown proposal is re-verified; a verdict counts only for the
 *   exact record digest it was computed on.
 *
 * - **The route is the Ask's linkage intents** (spec r3.6 §(a); host release main 39c0731; ./vibeRoute): the person's
 *   words become an Ask turn, one `code.request` intent is recorded on it and submitted (team controller → suggest-only
 *   child → retained proposal on the person's scope), and the proposal is read when it arrives. Never /api/requests.
 * - **Apply-to-live only** (the owner, 2026-10-07): where the host's copy-apply is switched on, the controller puts the
 *   proposal into the person's workspace copy itself; the canvas shows it and offers Undo, with no Accept step. Where it
 *   is off (or cannot be read), the existing Accept + confirm stays and the card says why. No host gate is bypassed.
 * - **One person.** Every write after an await is bound to the identity it started under (lib/identityEpoch
 *   bindEpoch().commit); a change of person stops the waits and drops their answers.
 *
 * Every other rule is the suggestion panel's pure model, unchanged (suggestions/model.ts + contract.ts).
 */
import { ApiError, type CodeContext, type HiveClient } from '../../../api/client'
import { parseDecisionResult, parseScopeRecord, parseSuggestionRead, verifyIntegrity, type ChangeSet, type SuggestionRead, type WorkspaceHead } from '../suggestions/contract'
import { decisionRequest, describeFailure, dirtyConflict, groupsOf, hunkStates, newOperationId, retryRequest, stage, stagedProblem, type Choice, type PendingDecision, type Staged } from '../suggestions/model'
import { savedHunkRanges, savedSelection } from '../suggestions/savedSelection'
import { apply, choreograph, EMPTY, finalState, type PlacedChange, type Presence } from './codePresence'
import { DEPENDENT_GROUPS, groupsProblem, PLAIN_SUMMARY, type Caps } from './features'
import type { ChangeView } from './layers'
import { describeChange, scopeWords, summarize, wholeFile, type ScopeShown } from './vibe'
import type { FunctionPick } from './functionPick'
import { bindEpoch, STALE, type EpochBinding } from '../../../lib/identityEpoch'
import { INTENT_KIND, codeRequest, vibeWordsProblem } from '../../../api/askIntents'
import { applicationInJournal, CHANGED_SINCE, intentsClient, intentWords, NO_INTENTS, NO_MIND_STARTED, NOT_YOURS, proposalsOnScope, readIfOurs, readApplication, recordAndSubmit, requestProgress, SPAWN_OFF, undoApplication, undoWords, vibeAvailability, type Application, type CopyApply, type SentRequest } from './vibeRoute'
import { authorization, CHANGED_REVIEW_AGAIN, CONFIRM_AGAIN, consentWords, giveConsent, validFor, type Authorization, type Consent } from './vibeConsent'

export interface SavedFile {
  path: string
  content: string
  digest: string
}
export type VibePhase =
  | { kind: 'idle' }
  /** `starting`: the request is admitted and no mind has been seen starting on it yet (never called "working") */
  | { kind: 'working'; step: 'scope' | 'turn' | 'send' | 'starting' | 'mind' | 'read' }
  | { kind: 'writing' }
  | { kind: 'review' }
  /** copy-apply on: the team's controller is putting the proposal into the person's copy */
  | { kind: 'applying' }
  /** the person accepted and confirmed (a consent for exactly this digest); the team may now put it into their copy */
  | { kind: 'consented'; valid: string; expires_at: string }
  /**
   * the person declined (the consent route). A decline revokes what is to come, not an application already made, so
   * `checking` until the journal shows none for this proposal (one already made is shown with Undo instead); `unknown`
   * when the journal can't be read
   */
  | { kind: 'declined'; checking: boolean; unknown?: boolean }
  /**
   * the controller put it into the person's copy. `current`: the copy is exactly as it left it, so Undo can put it
   * back; `stale`: the copy has changed since, so Undo cannot (nothing is offered)
   */
  /**
   * the team's change is in the person's copy. `authorization` (r5): `consented` only with the host's evidence that it
   * was made under this person's consent; `unconsented` when the host says no consent; `unverified` otherwise (never
   * shown as accepted). `acceptedHere`: the person gave an OK on this page. `beforeDecline`: found after a decline.
   */
  | { kind: 'applied'; words: string[]; currency: 'current' | 'stale'; authorization?: Authorization; acceptedHere?: boolean; beforeDecline?: boolean }
  /** undone: here (`elsewhere` false), or already before this page saw it (another tab or person) */
  | { kind: 'undone'; elsewhere?: boolean }
  | { kind: 'done'; kept: number; skipped: number; change?: ChangeSet }
  | { kind: 'error'; text: string }
  | { kind: 'unavailable'; text: string }
export interface Placed extends PlacedChange {
  from: number
  to: number
  before: string
}
/** One request's whole answer: shown together, decided together. */
export interface VibeResult {
  request: number
  instruction: string
  scope: ScopeShown
  /** the saved file the proposal was placed on */
  file: { path: string; digest: string }
  read: SuggestionRead
  /** the verdict, for exactly this record digest */
  integrity: { digest: string; ok: boolean; problems: string[] }
  placed: Placed[]
  elsewhere: string[]
  /** what this page sent: every later read of the proposal is re-verified against it (r4 [P1] refresh) */
  sent: SentRequest
  /** set when a re-read found the proposal is no longer exactly what was shown and verified: it can't be decided */
  gone?: string
}
export interface VibeState {
  phase: VibePhase
  /** the request in flight or shown (its instruction and scope, before the proposal arrives) */
  asking: { request: number; instruction: string; scope: ScopeShown | null } | null
  result: VibeResult | null
  staged: Staged
  presence: Presence
  pending: PendingDecision | null
  reviewing: PendingDecision | null
  note: string | null
  /** how this request travelled: the team, its request, and whether the host puts proposals into the copy itself */
  route: { team: string; request_id: string; copyApply: CopyApply } | null
  /** the controller's application of the shown proposal to the person's copy */
  applied: Application | null
  /** an Undo in flight or refused (its operation id is reused on a retry, so it is never done twice) */
  undo: { op: string; busy: boolean; note: string | null; retry: boolean } | null
  /**
   * How the shown proposal lands (r4 [P1], the owner: the person accepts): `confirm` it changes nothing until the person
   * accepts and confirms, always, whatever the host's copy-apply switch; `unknown` it may already be in the copy (the
   * journal could not be read). A change the team put in without that OK is the `applied` phase, `unconsented`.
   */
  lands: 'confirm' | 'unknown' | null
  /** `unknown`: the proposal's currency and decisions must be freshly re-read and verified before any confirm */
  verify: { busy: boolean; failed: string | null } | null
  /** the person's live consent for the shown proposal (copy-apply on), or null */
  consent: Consent | null
}
export interface Deps {
  client: HiveClient | null
  ctx: CodeContext | null
  ws: WorkspaceHead | null
  onWorkspace: (current: WorkspaceHead, touched: string[]) => Promise<void>
  /** the person's words as an Ask turn (the universal Ask): resolves to the turn's operation id */
  turn?: (words: string) => Promise<string>
}
export interface VibeOptions {
  /** the identity binding for every write after an await (default lib/identityEpoch bindEpoch) */
  bind?: () => EpochBinding
  /** how long to wait for the team's proposal before saying so (ms) */
  proposalWaitMs?: number
  /** how long to wait for the controller to put it into the copy before asking for an OK (ms) */
  applyWaitMs?: number
  /** how long to wait for a mind to be seen starting on the request before saying none has (ms) */
  startWaitMs?: number
  /** the gaps between looks (ms): growing, then the last one repeated */
  pollMs?: number[]
}

/** Whole lines around an editor selection (a mind sees the lines it is asked about, not half of one). */
export function wholeLines(text: string, from: number, to: number): { from: number; to: number } {
  const a = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const end = to > from && text[to - 1] === '\n' ? to - 1 : to
  const z = text.indexOf('\n', end)
  return { from: from === 0 ? 0 : a, to: z === -1 ? text.length : z }
}
const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length
const INITIAL: VibeState = { phase: { kind: 'idle' }, asking: null, result: null, staged: {}, presence: EMPTY, pending: null, reviewing: null, note: null, route: null, applied: null, undo: null, lands: null, verify: null, consent: null }
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const POLL = [150, 300, 600, 1200, 2000]

export class VibeSession {
  private state: VibeState = INITIAL
  private seq = 0
  private timers: ReturnType<typeof setTimeout>[] = []
  private subs = new Set<() => void>()
  deps: Deps = { client: null, ctx: null, ws: null, onWorkspace: async () => undefined }
  private readonly opts: Required<VibeOptions>
  constructor(
    private readonly timer: { set: (f: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) },
    opts: VibeOptions = {},
  ) {
    this.opts = { bind: opts.bind ?? bindEpoch, proposalWaitMs: opts.proposalWaitMs ?? 10 * 60_000, applyWaitMs: opts.applyWaitMs ?? 60_000, startWaitMs: opts.startWaitMs ?? 90_000, pollMs: opts.pollMs?.length ? opts.pollMs : POLL }
  }
  private gap(i: number) {
    const p = this.opts.pollMs
    return p[Math.min(i, p.length - 1)]
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }
  getState = () => this.state
  setDeps(d: Deps) {
    this.deps = d
  }
  private set(patch: Partial<VibeState>) {
    this.state = { ...this.state, ...patch }
    this.subs.forEach((f) => f())
  }
  private stopScript() {
    this.timers.forEach((t) => this.timer.clear(t))
    this.timers = []
  }
  dispose() {
    this.seq++
    this.stopScript()
  }

  /** Whether this client can carry the route at all (the hive's own answers decide the rest, on each ask). */
  get available() {
    return !!intentsClient(this.deps.client)
  }

  /** Close without deciding; every earlier continuation becomes a no-op. */
  reset() {
    this.seq++
    this.decided = false
    this.stopScript()
    this.state = INITIAL
    this.subs.forEach((f) => f())
  }

  /** Say what you want. `range`: the editor selection (whole lines are used), or null for the whole file. */
  async ask(words: string, range: { from: number; to: number } | null, file: SavedFile | null, dirty: boolean, who: (author: string) => string, reduced: boolean, fn?: FunctionPick | null): Promise<void> {
    const said = words.trim()
    if (!said) return
    // one limit end to end, checked before anything is issued or sent: refused, never cut
    const tooLong = vibeWordsProblem(said)
    if (tooLong) return this.set({ phase: { kind: 'error', text: tooLong } })
    const { client, ctx, ws, turn } = this.deps
    if (!this.available || !ctx || !ws || !client) return this.set({ phase: { kind: 'unavailable', text: NO_INTENTS } })
    if (!file) return this.set({ phase: { kind: 'error', text: 'Open a file first.' } })
    if (dirty) return this.set({ phase: { kind: 'error', text: 'You have unsaved edits in this file. Save or discard them first, so the mind works on exactly what is saved.' } })
    this.reset()
    const mine = this.seq
    const binding = this.opts.bind()
    // still this request, for the same person (read now, synchronously)
    const live = () => mine === this.seq && binding.current()
    // every write after an await: this request only, and only for the person it started under, in the same tick
    const put = (patch: Partial<VibeState>) => mine === this.seq && binding.commit(() => this.set(patch)) !== STALE
    try {
      const bytes = new TextEncoder().encode(file.content)
      let ranges: Record<string, [number, number][]>
      let scope: ScopeShown
      // a picked function, still exactly on screen: the person issues a function scope (exact, from the service's parser)
      const picked = fn && range && fn.path === file.path && fn.digest === file.digest && fn.generation === ws.generation && fn.from === range.from && fn.to === range.to ? fn : null
      if (picked) {
        scope = { path: file.path, lines: { first: lineOf(file.content, picked.from), last: lineOf(file.content, picked.to) }, fn: picked.name }
        ranges = { [file.path]: [[picked.start_byte, picked.end_byte]] }
      } else if (range && range.to > range.from) {
        const lines = wholeLines(file.content, range.from, range.to)
        const s = await savedSelection(bytes, file.digest, file.content, lines.from, lines.to)
        ranges = { [file.path]: [[s.start_byte, s.end_byte]] }
        scope = { path: file.path, lines: { first: lineOf(file.content, lines.from), last: lineOf(file.content, lines.to) } }
      } else {
        ranges = wholeFile(file.path, bytes.length)
        scope = { path: file.path, lines: null }
      }
      if (!put({ asking: { request: mine, instruction: said, scope }, phase: { kind: 'working', step: 'scope' } })) return
      // 1. is the route on this hive, and which team would take it? (the hive's own answers)
      const avail = await vibeAvailability(client, ctx, ws.id)
      if (!live()) return
      if (!avail.ok) return void put({ phase: { kind: 'unavailable', text: avail.text } })
      if (!turn) return void put({ phase: { kind: 'unavailable', text: 'The Ask is not on this page, so your words have no turn to travel on. Open the Ask and try again.' } })
      // the person marks the lines the mind may change (a scope minted for this request alone)
      let issuedScope: unknown
      if (picked) {
        if (!client.codeProxy) throw new Error('This client cannot reach function scopes.')
        issuedScope = await client.codeProxy('POST', `/v1/workspaces/${ws.id}/function-scopes`, { ...ctx }, { operation_id: newOperationId('fnscope'), expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, path: file.path, source_digest: picked.source_digest, caret_byte: picked.caret_byte, selection_digest: picked.selection_digest })
      } else {
        issuedScope = await client.codeSuggestionScope!(ctx, ws.id, { operation_id: newOperationId('scope'), expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges })
      }
      const issued = parseScopeRecord(issuedScope, ws.id)
      if (!put({ phase: { kind: 'working', step: 'turn' } })) return
      // 2. the words as an Ask turn; 3. one code.request intent on it, then submit
      const op = await turn(said)
      if (!put({ phase: { kind: 'working', step: 'send' } })) return
      const request = codeRequest({ offer: avail.offer, instruction: said, title: `${scopeWords(scope)}: ${said}`, origin: { task_id: ctx.task_id, repository_id: ctx.repository_id, workspace_id: ws.id, scope_id: issued.id, scope_digest_hex: issued.digest, generation: ws.generation }, now: Date.now() })
      let sent: Awaited<ReturnType<typeof recordAndSubmit>>
      try {
        sent = await recordAndSubmit(client, op, { kind: INTENT_KIND, request }, wait, live)
      } catch (e) {
        if (!live()) return
        return void put({ phase: { kind: 'error', text: `Nothing was handed to ${avail.offer.team_name}: ${intentWords(e)}` } })
      }
      // admitted is not working (r4 [P2]): the host admits before any mind starts, so the card says "working" only once a
      // mind is seen started for this request
      if (!put({ route: { team: avail.offer.team_name, request_id: sent.request_id, copyApply: avail.copyApply }, phase: { kind: 'working', step: 'starting' } })) return
      const startBy = Date.now() + this.opts.startWaitMs
      let started = false
      // 4. the team's proposal: candidates on the scope this request carries, each accepted only when its retained
      //    request provenance is exactly this request's (anything else is not shown, and the wait goes on)
      const deadline = Math.min(Date.now() + this.opts.proposalWaitMs, Date.parse(request.lifetime.until))
      const sentReq = { request_id: sent.request_id, task_id: ctx.task_id, repository_id: ctx.repository_id, workspace_id: ws.id, origin_scope: { scope_id: issued.id, scope_digest: request.origin.scope_digest, generation: request.origin.generation } }
      const notOurs = new Set<string>()
      let id: string | null = null
      let ours: unknown = null
      for (let i = 0; live() && !id; i++) {
        if (!started && i % 3 === 0) {
          let pr: Awaited<ReturnType<typeof requestProgress>> = null
          try {
            pr = await requestProgress(client, request.to_swarm, sent.request_id)
          } catch {
            pr = null // unreadable: nothing is claimed either way; the wait still ends at the start limit
          }
          if (!live()) return
          if (pr?.refused === 'spawn_disabled') return void put({ note: null, phase: { kind: 'error', text: SPAWN_OFF } })
          if (pr?.closed) return void put({ note: null, phase: { kind: 'error', text: pr.closed === 'cancelled' ? 'The request was cancelled before a change was proposed.' : `The request ended (${pr.closed}) without a change for you.` } })
          if (pr?.started) {
            started = true
            if (!put({ phase: { kind: 'working', step: 'mind' } })) return
          }
        }
        for (const cand of await proposalsOnScope(client, ctx, ws.id, issued.id, live, notOurs)) {
          if (!live()) break
          const r = await readIfOurs(client, ctx, ws.id, cand, sentReq)
          if (r) {
            id = cand
            ours = r
            break
          }
          // not this request's (missing, null, foreign or tampered provenance): never shown; the person is told
          if (!notOurs.size && !put({ note: NOT_YOURS })) return
          notOurs.add(cand)
        }
        if (id || !live()) break
        if (!started && Date.now() > startBy) return void put({ note: null, phase: { kind: 'error', text: `${NO_MIND_STARTED} The request stays open until ${new Date(request.lifetime.until).toLocaleTimeString()}; if a mind starts later, its proposal will appear in the drawer’s Proposals.` } })
        if (Date.now() > deadline) return void put({ note: null, phase: { kind: 'error', text: `${avail.offer.team_name} has not proposed a change yet.${notOurs.size ? ` ${NOT_YOURS}` : ''} The request stays open until ${new Date(request.lifetime.until).toLocaleTimeString()}; its proposal will appear in the drawer’s Proposals.` } })
        await wait(this.gap(i))
      }
      if (!id || !put({ note: null, phase: { kind: 'working', step: 'read' } })) return
      const read = parseSuggestionRead(ours, { workspace_id: ws.id, suggestion_id: id })
      const check = await verifyIntegrity(read)
      const placed = await place(read, file)
      if (!live()) return
      let staged: Staged = {}
      for (const h of read.content.hunks) if (hunkStates(read).get(h.id)?.kind === 'open') staged = stage(read, staged, h.id, 'accept').staged
      const result: VibeResult = { request: mine, instruction: said, scope, file: { path: file.path, digest: file.digest }, read, integrity: { digest: read.record.digest, ...check }, placed: placed.placed, elsewhere: placed.elsewhere, sent: sentReq }
      if (!put({ result, staged })) return
      // 5. The owner: the person accepts. Always the plain summary, then Accept → confirm; the host's copy-apply switch never
      //    stands in for that OK (r4 [P1]). Where the host could put a change in by itself, watch for it and say so.
      if (!put({ lands: 'confirm' })) return
      this.play(result.placed, who(read.record.author), reduced, 'review')
      if (avail.copyApply !== 'off') void this.watchUnconsented(mine, binding, result)
    } catch (e) {
      if (!live()) return
      const f = describeFailure(e)
      put({ phase: f.kind === 'unavailable' ? { kind: 'unavailable', text: f.text } : { kind: 'error', text: `No change was proposed: ${f.text}` } })
    }
  }

  /**
   * Where the host's copy-apply is on (or can't be read): watch the workspace journal while the proposal waits for the
   * person's OK. If the team's controller puts THIS proposal into the copy without it, say so plainly with Undo, never
   * as accepted (r4 [P1]). The watch ends when the person decides or the card moves on. A journal that can't be read
   * means it may already be in the copy: the confirm is blocked until the proposal is freshly re-read and verified.
   */
  private async watchUnconsented(mine: number, binding: EpochBinding, result: VibeResult): Promise<void> {
    const { client, ctx, ws, onWorkspace } = this.deps
    if (!client || !ctx || !ws) return
    const declinedChecking = () => this.state.phase.kind === 'declined' && this.state.phase.checking
    const watching = () => mine === this.seq && binding.current() && (['writing', 'review', 'consented'].includes(this.state.phase.kind) || declinedChecking()) && !this.decided
    const put = (patch: Partial<VibeState>) => mine === this.seq && binding.commit(() => this.set(patch)) !== STALE
    let after = 0
    this.watchingFor = mine
    try {
      for (let i = 0; watching(); i++) {
        // the person's OK or decline is on its way: wait for its answer, then look again (never drop the watch)
        if (this.state.pending) {
          await wait(this.gap(i))
          continue
        }
        try {
          const r = await applicationInJournal(client, ctx, ws.id, result.read, after)
          after = r.after
          if (!r.id) {
            // after a decline: no application in the journal once the in-flight window has passed → truly declined
            if (declinedChecking() && Date.now() > this.declinedUntil) {
              put({ phase: { kind: 'declined', checking: false } })
              return
            }
            const c = this.state.consent
            if (this.state.phase.kind === 'consented' && c?.expires_at && Date.parse(c.expires_at) <= Date.now()) {
              // the OK ran out before the team used it: nothing went in; a fresh Accept gives a fresh one
              put({ consent: null, phase: { kind: 'review' }, note: 'Your OK ran out before the swarm put it in. Nothing went into your copy. Accept again to give a fresh one.' })
              continue
            }
            await wait(this.gap(i))
            continue
          }
          const app = await readApplication(client, ctx, ws.id, r.id, result.read)
          if (!watching()) return
          if (this.state.pending) {
            after = 0 // read it again once the answer is in, so a decline in flight is reconciled against it
            continue
          }
          const words = result.placed.map((c) => `${c.line === c.lastLine ? `Line ${c.line}` : `Lines ${c.line}–${c.lastLine}`}: ${c.words}`)
          this.stopScript()
          // r5: consented only on the host's evidence (consent_id + applied_at inside that consent's validity, no grace)
          const c = this.state.consent
          const mineConsent = c && c.suggestion_id === app.suggestion_id && c.suggestion_digest === app.suggestion_digest ? c : null
          const beforeDecline = declinedChecking()
          const phase: VibePhase = app.currency === 'undone' ? { kind: 'undone', elsewhere: true } : { kind: 'applied', words, currency: app.currency, authorization: authorization(app.evidence, mineConsent), acceptedHere: !!mineConsent, ...(beforeDecline ? { beforeDecline: true } : {}) }
          if (!put({ applied: app.currency === 'current' ? app : null, presence: EMPTY, staged: {}, note: null, reviewing: null, consent: null, result: { ...result, placed: [] }, phase })) return
          await onWorkspace(app.workspace, app.paths)
          return
        } catch {
          if (!watching()) return
          if (declinedChecking()) return void put({ phase: { kind: 'declined', checking: false, unknown: true } })
          // the application status is UNKNOWN: never imply it did not happen; the confirm waits for a verified re-read
          put({ note: 'This may already be in your copy. Check before confirming.', lands: 'unknown', verify: { busy: true, failed: null } })
          await this.recheck()
          return
        }
      }
    } finally {
      if (this.watchingFor === mine) this.watchingFor = null
    }
  }
  /** the request whose application watch is running (one per request; a newer request's never counts as this one's) */
  private watchingFor: number | null = null
  /** after a decline, how long an application already in flight may still land (ms since epoch) */
  private declinedUntil = 0
  /** the person has sent a decision for the shown proposal (the unconsented watch stops) */
  private decided = false

  /** Undo the applied change (person-only; the same operation id on a retry, so it is never done twice). */
  async undo(): Promise<void> {
    const { client, ctx, ws, onWorkspace } = this.deps
    const app = this.state.applied
    if (!app || app.currency !== 'current' || this.state.phase.kind !== 'applied' || this.state.phase.currency !== 'current' || !client || !ctx || !ws || this.state.undo?.busy) return
    const mine = this.seq
    const binding = this.opts.bind()
    const put = (patch: Partial<VibeState>) => mine === this.seq && binding.commit(() => this.set(patch)) !== STALE
    const op = this.state.undo?.retry ? this.state.undo.op : newOperationId('undo')
    this.set({ undo: { op, busy: true, note: null, retry: false } })
    try {
      const r = await undoApplication(client, ctx, ws.id, app, op)
      if (!put({ undo: null, applied: null, phase: { kind: 'undone' } })) return
      await onWorkspace(r.workspace, app.paths)
    } catch (e) {
      const w = undoWords(e)
      if (e instanceof Error && (e as { code?: string }).code === 'already_undone') return void put({ undo: null, applied: null, phase: { kind: 'undone', elsewhere: true } })
      put({ undo: { op, busy: false, note: w.text, retry: w.retry } })
    }
  }

  /** where the shown proposal goes after it is written in: the person's OK, or the controller's copy-apply */
  private then: 'review' | 'applying' = 'review'
  private play(changes: Placed[], who: string, reduced: boolean, then: 'review' | 'applying' = 'review') {
    this.stopScript()
    this.then = then
    const end = (): VibePhase => (this.state.phase.kind === 'applied' ? this.state.phase : { kind: then })
    if (reduced || !changes.length) return this.set({ presence: finalState(changes), phase: end() })
    this.set({ phase: { kind: 'writing' }, presence: EMPTY })
    const mine = this.seq
    const steps = choreograph(changes, who)
    let p = EMPTY
    for (const s of steps)
      this.timers.push(
        this.timer.set(() => {
          if (mine !== this.seq) return
          p = apply(p, s.op)
          this.set({ presence: p })
        }, s.at),
      )
    this.timers.push(this.timer.set(() => mine === this.seq && this.set({ phase: end() }), (steps[steps.length - 1]?.at ?? 0) + 250))
  }

  /** Skip ahead: the finished change at once. */
  finish() {
    this.stopScript()
    const ph = this.state.phase.kind
    this.set({ presence: finalState(this.state.result?.placed ?? []), phase: ph === 'applied' ? this.state.phase : { kind: ph === 'writing' ? this.then : 'review' } })
  }

  /**
   * The candidate moved (another actor): re-read the shown proposal and verify THAT read before it replaces anything.
   * r4 [P1]: every re-read is the provenance read (include_request_binding=true), re-verified against exactly what this
   * page sent, and pinned to the proposal digest the person saw. Not ours → "not yours"; another digest → "changed
   * since you saw it". Either way nothing is swapped in and the proposal can't be decided.
   */
  async refresh(): Promise<{ ok: true } | { ok: false; text: string }> {
    const r = this.state.result
    const { client, ctx, ws } = this.deps
    if (!r || !ws || !client?.codeProxy || !ctx || this.state.phase.kind === 'done') return { ok: false, text: 'there is no proposal to read again' }
    if (r.gone) return { ok: false, text: r.gone }
    const mine = this.seq
    const binding = this.opts.bind()
    const hold = (gone: string) => {
      binding.commit(() => mine === this.seq && this.state.result?.request === r.request && this.set({ result: { ...this.state.result, gone }, reviewing: null, note: gone }))
      return { ok: false as const, text: gone }
    }
    try {
      const ours = await readIfOurs(client, ctx, ws.id, r.read.record.id, r.sent)
      if (!ours) return hold(NOT_YOURS)
      const read = parseSuggestionRead(ours, { workspace_id: ws.id, suggestion_id: r.read.record.id })
      if (read.record.digest !== r.read.record.digest || read.record.digest !== r.integrity.digest) return hold(CHANGED_SINCE)
      const check = await verifyIntegrity(read)
      const wrote = binding.commit(() => {
        if (mine !== this.seq || this.state.result?.request !== r.request) return false
        this.set({ result: { ...this.state.result, read, integrity: { digest: read.record.digest, ...check } } })
        return true
      })
      if (wrote !== true) return { ok: false, text: 'the request or the person changed' }
      return check.ok ? { ok: true } : { ok: false, text: `it failed its integrity check (${check.problems[0]})` }
    } catch (e) {
      const text = describeFailure(e).text
      binding.commit(() => mine === this.seq && this.set({ note: `The proposal could not be read again: ${text}` }))
      return { ok: false, text }
    }
  }

  /**
   * The application's status is unknown: read the proposal again (currency and decisions, verified) before any confirm
   * is possible. Until it succeeds the confirm stays blocked; a failure says so and offers Try again.
   */
  async recheck(): Promise<void> {
    if (!this.state.verify || this.rechecking) return
    const mine = this.seq
    const binding = this.opts.bind()
    this.rechecking = true
    this.set({ verify: { busy: true, failed: null } })
    try {
      const r = await this.refresh()
      binding.commit(() => mine === this.seq && this.set(r.ok ? { verify: null, note: 'This may already be in your copy. Check before confirming.' } : { verify: { busy: false, failed: r.text } }))
    } finally {
      this.rechecking = false
    }
  }
  private rechecking = false

  /** Is the shown result for exactly this saved file? (path and digest; never another file's offsets) */
  static onFile(r: VibeResult | null, file: SavedFile | null, dirty: boolean): boolean {
    return !!r && !!file && !dirty && r.file.path === file.path && r.file.digest === file.digest
  }

  /** Why the shown proposal cannot be decided now, or null. */
  blockedWhy(file: SavedFile | null, dirty: boolean, caps: Pick<Caps, 'status' | 'features'>): string | null {
    const { result: r, staged, pending } = this.state
    if (!r) return null
    if (r.gone) return r.gone
    if (!file || file.path !== r.file.path) return `This proposal is for ${r.file.path}. Open it to decide.`
    if (file.digest !== r.file.digest && !dirty) return `${r.file.path} changed since this was proposed. Ask again on the current code.`
    const v = this.state.verify
    if (v) return v.busy ? 'Checking whether this is already in your copy before it can be confirmed…' : `Couldn’t check whether this is already in your copy (${v.failed}). It can’t be confirmed until that is known.`
    return (
      groupsProblem(r.read.content.hunk_groups, caps) ??
      (r.integrity.digest !== r.read.record.digest ? 'This proposal has not been checked in this browser yet.' : !r.integrity.ok ? `This proposal failed its integrity check (${r.integrity.problems[0]}). It cannot be decided.` : null) ??
      (r.read.currency !== 'current' ? 'The source moved since this was proposed, so it can no longer be applied. Ask again on the current code.' : null) ??
      (pending ? 'An earlier decision has no answer yet. Retry it first.' : null) ??
      stagedProblem(r.read, staged) ??
      dirtyConflict(r.read, staged, { path: file.path, dirty })
    )
  }

  /** Keep or skip one change (its whole dependent group moves with it). */
  choose(id: string, choice: Choice) {
    const r = this.state.result
    if (!r) return
    const groups = groupsOf(r.read)
    let s = this.state.staged
    for (const h of groups.get(id) ?? [id]) s = stage(r.read, s, h, null).staged
    for (const h of groups.get(id) ?? [id]) {
      const next = stage(r.read, s, h, choice)
      if (next.refused) return this.set({ note: next.refused })
      s = next.staged
    }
    this.set({ staged: s, note: null })
  }

  /** Accept (keep what is kept, skip the rest) or Reject (skip all): opens the confirm for THIS result. */
  review(file: SavedFile | null, dirty: boolean, caps: Pick<Caps, 'status' | 'features'>, all?: 'reject') {
    const r = this.state.result
    if (!r) return
    if (all === 'reject') {
      let s: Staged = {}
      for (const h of r.read.content.hunks) if (hunkStates(r.read).get(h.id)?.kind === 'open') s = stage(r.read, s, h.id, 'reject').staged
      this.set({ staged: s })
    }
    const problem = this.blockedWhy(file, dirty, caps)
    if (problem) return this.set({ note: problem })
    this.set({ reviewing: { request: decisionRequest(r.read, this.state.staged, newOperationId('decide')) }, note: null })
  }
  setReviewing(p: PendingDecision | null) {
    this.set({ reviewing: p })
  }
  setNote(n: string | null) {
    this.set({ note: n })
  }

  async send(p: PendingDecision): Promise<true> {
    const { client, ctx, ws, onWorkspace } = this.deps
    const r = this.state.result
    if (!client?.codeSuggestionDecide || !ctx || !ws || !r || p.request.suggestion_id !== r.read.record.id) return true
    const request = retryRequest(p)
    const mine = this.seq
    const binding = this.opts.bind()
    // copy-apply on, and the whole proposal accepted or declined: the person's OK is the hive's consent for exactly this
    // digest (Platform 66312cd); the team then puts it in. Otherwise: the person's own decision (the suggestion decide).
    const open = r.read.content.hunks.filter((h) => hunkStates(r.read).get(h.id)?.kind === 'open').map((h) => h.id)
    const whole = request.accepted_hunk_ids.length === open.length ? 'accept' : request.rejected_hunk_ids.length === open.length ? 'decline' : null
    if (this.state.route?.copyApply === 'on' && client.proposalConsent && whole) return this.consent(p, whole)
    this.set({ pending: p })
    this.decided = true
    try {
      const done = parseDecisionResult(await client.codeSuggestionDecide(ctx, ws.id, request), request)
      const wrote = binding.commit(() => {
        if (mine !== this.seq) return false
        this.stopScript()
        this.set({ pending: null, reviewing: null, presence: EMPTY, phase: { kind: 'done', kept: request.accepted_hunk_ids.length, skipped: request.rejected_hunk_ids.length, change: done.change }, result: { ...r, placed: [] } })
        return true
      })
      if (wrote === true && done.change) await onWorkspace(done.workspace, done.change.paths)
    } catch (e) {
      // the host wants a fresh confirmed OK (missing, spent, or the proposal changed)
      if (e instanceof ApiError && (e.code === 'consent_required' || e.code === 'consent_stale')) {
        binding.commit(() => {
          if (mine !== this.seq) return
          this.decided = false
          this.set({ pending: null, reviewing: null, note: e.code === 'consent_stale' ? CHANGED_REVIEW_AGAIN : CONFIRM_AGAIN })
        })
        return true
      }
      const f = describeFailure(e)
      binding.commit(() => mine === this.seq && this.set(f.kind === 'unknown' ? { pending: { ...p, unknown: f.text } } : { pending: null, note: f.text }))
    }
    return true
  }

  /**
   * Accept → confirm, or Reject → confirm, where the host's copy-apply is on: POST the person's consent (or decline) for
   * exactly the digest they were shown, then show it plainly ("valid for 10 minutes"). Never applies anything itself;
   * the team's application is then read from the workspace journal and shown as theirs-with-your-OK.
   */
  private async consent(p: PendingDecision, decision: 'accept' | 'decline'): Promise<true> {
    const { client } = this.deps
    const r = this.state.result!
    const mine = this.seq
    const binding = this.opts.bind()
    // r5 [P2] (stand-in r4 #1): every change after the await (flags, timers, state) happens inside ONE commit that is
    // checked against this request and this person first; a late answer for anyone else changes nothing
    const commit = (fn: () => void) => mine === this.seq && binding.commit(() => (mine === this.seq ? (fn(), true) : false)) === true
    this.set({ pending: p })
    try {
      const c = await giveConsent(client!, decision, { request_id: r.sent.request_id, suggestion_id: r.read.record.id, suggestion_digest: r.read.record.digest })
      if (decision === 'decline') {
        // a decline revokes what is to come, not an application already made: keep watching briefly (r5, stand-in r4 #3)
        const ok = commit(() => {
          this.stopScript()
          this.declinedUntil = Date.now() + this.opts.applyWaitMs
          this.set({ pending: null, reviewing: null, consent: null, presence: EMPTY, note: null, phase: { kind: 'declined', checking: true }, result: { ...r, placed: [] } })
        })
        if (ok && this.watchingFor !== mine) void this.watchUnconsented(mine, binding, r)
        return true
      }
      const ok = commit(() => this.set({ pending: null, reviewing: null, consent: c, note: null, phase: { kind: 'consented', valid: validFor(c), expires_at: c.expires_at! } }))
      // the watch for the team's application (started when the proposal was shown) is still running, unless it ended
      if (ok && this.watchingFor !== mine) void this.watchUnconsented(mine, binding, r)
    } catch (e) {
      const text = consentWords(e)
      commit(() => this.set({ pending: null, reviewing: null, note: text, ...(e instanceof ApiError && e.code === 'consent_stale' ? { result: { ...r, gone: CHANGED_REVIEW_AGAIN } } : {}) }))
    }
    return true
  }

  // ------------------------------------------------------------------ what is shown

  /** What the editor draws: only on the exact saved file the proposal was placed on. */
  changeViews(file: SavedFile | null, dirty: boolean): ChangeView[] {
    const { result: r, staged } = this.state
    if (!r || !VibeSession.onFile(r, file, dirty)) return []
    const states = hunkStates(r.read)
    return r.placed.map((c, i) => {
      const st = states.get(c.id)?.kind
      return { id: c.id, n: i + 1, from: c.from, to: c.to, after: c.after, state: st === 'open' ? (staged[c.id] === 'reject' ? 'skip' : 'keep') : st === 'accepted' ? 'accepted' : st === 'rejected' ? 'rejected' : 'stale' }
    })
  }

  /** The plain summary, from the result itself (its file, its instruction); its "why" waits for the capabilities. */
  summary(mind: string, caps: Pick<Caps, 'status' | 'features'>) {
    const r = this.state.result
    if (!r || !r.placed.length) return null
    const index = new Map(r.placed.map((c, i) => [c.id, i]))
    const declared = caps.status === 'ready'
    const together = (declared && caps.features.has(DEPENDENT_GROUPS) ? r.read.content.hunk_groups : undefined)?.map((g) => g.map((id) => index.get(id)).filter((x): x is number => x !== undefined)) ?? []
    const s = summarize({ instruction: r.instruction, mind, path: r.file.path, changes: r.placed, together, canCarry: declared && caps.features.has(PLAIN_SUMMARY), plain: declared && caps.features.has(PLAIN_SUMMARY) ? (r.read.content.plain_summary ?? null) : null })
    // until the service's features are known, no "why" about its support is chosen: while checking, none; when the
    // check failed, only that it could not be checked (a failure does not show the service lacks support; r4)
    const asked = `You asked: “${r.instruction.trim()}”. `
    return { ...s, why: declared ? s.why : caps.status === 'checking' ? '' : `${asked}Couldn’t check what the code service supports, so whether ${mind} could give a reason is not known.` }
  }

  /** The confirm's facts, all from the ONE result being decided (its scope, its proposal, its binding). */
  facts(p: PendingDecision, headline: string): [string, string][] {
    const r = this.state.result
    if (!r || p.request.suggestion_id !== r.read.record.id) return [['Proposal', 'not the one shown; close and try again']]
    const words = (ids: string[]) => r.placed.filter((c) => ids.includes(c.id)).map((c) => `Line ${c.line}: ${c.words}`).join('; ')
    return [
      ['What', headline],
      ['You allowed', `${scopeWords(r.scope)} (the mind could change nothing outside it)`],
      ['You asked', `“${r.instruction}”`],
      ['Keeps', words(p.request.accepted_hunk_ids) || (p.request.accepted_hunk_ids.length ? `${p.request.accepted_hunk_ids.length} change(s) in other files` : 'nothing')],
      ['Skips', words(p.request.rejected_hunk_ids) || 'nothing'],
      ['Effect', p.request.accepted_hunk_ids.length ? 'One atomic change to your copy (not the running code). Nothing is deployed.' : 'Recorded in the history only; the code is unchanged.'],
      ['Proposal', r.read.record.id],
      ['Bound to', `generation ${p.request.expected_generation} · tree ${p.request.expected_tree_digest.slice(0, 16)}…`],
      ['Operation', p.request.operation_id],
    ]
  }
}

/** Place a retained proposal's hunks on the saved file it was read for (display only). */
async function place(r: SuggestionRead, f: SavedFile): Promise<{ placed: Placed[]; elsewhere: string[] }> {
  const mine = r.content.hunks.filter((h) => h.path === f.path)
  const elsewhere = [...new Set(r.content.hunks.filter((h) => h.path !== f.path).map((h) => h.path))]
  const views = mine.length ? await savedHunkRanges(new TextEncoder().encode(f.content), f.digest, f.content, mine) : []
  const order = r.content.hunks.map((h) => h.id)
  const placed = views
    .map((v) => {
      const line = lineOf(f.content, v.from)
      const lastLine = Math.max(line, lineOf(f.content, Math.max(v.from, v.to - (v.before.endsWith('\n') ? 1 : 0))))
      // editor offsets are UTF-16, so this column is in UTF-16 code units (codePresence col16)
      const col16 = v.from - (f.content.lastIndexOf('\n', v.from - 1) + 1)
      return { id: v.id, from: v.from, to: v.to, before: v.before, after: v.after, line, lastLine, col16, words: describeChange(v.before, v.after) }
    })
    .sort((a, z) => order.indexOf(a.id) - order.indexOf(z.id))
  return { placed, elsewhere }
}
