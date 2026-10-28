import type { ActionResult, ProgramAction, ProgramStage, WorkGraph, WorkItem, WorkSource } from '../api/types'
import { plural } from '../lib/plural'

/**
 * The open program session: pure helpers for the trail (how you got here), back, stage changes,
 * reconciling full snapshots by item id, and turning action results into host state.
 * Everything here is unit-tested; the store only wires it to the client.
 */

export interface TrailStep {
  stage: ProgramStage
  /** An item id, or null for the program's starting view. */
  focus: string | null
  /** Compare: the chosen items (empty or absent = the program's groups). */
  compare?: string[]
}

export type NoticeKind = 'stale' | 'revision' | 'result' | 'refused' | 'error' | 'load'
export interface ProgramNotice {
  id: number
  kind: NoticeKind
  tone: 'info' | 'good' | 'warn' | 'bad'
  title: string
  body?: string
}

/** A `needs_input` result waiting for the person. */
export interface PendingInput {
  action: string
  items: string[]
  /** param -> what is missing (from the result), merged with the action's own params description. */
  needs: Record<string, string>
  message?: string
  params: Record<string, unknown>
}

/** What `inspect-source` returned, shown in the sources rail. */
export interface SourceDetail {
  items: string[]
  sources: WorkSource[]
  message?: string
  at: number
}

/**
 * Whether a result says it ran now. Read only from the program's own flags (`executed_now` / `executed`): `banked`
 * means recorded or previewed earlier and not run by this action; `current` means the program says it ran now;
 * `unstated` means the result does not say, and is shown as uncertain.
 */
export type ResultBasis = 'banked' | 'current' | 'unstated'

/**
 * Everything else a `done` result returned (its `detail` minus `sources`, which keep their own rendering), kept so the
 * host can show it as inert text. Bound to the action, the chosen items, the app/swarm/session and the revision the
 * action was asked against; a later revision marks it `stale` rather than passing it off as current.
 */
export interface ResultDetail {
  seq: number
  action: string
  label: string
  items: string[]
  programId: string
  swarmId: string
  sessionKey: string
  /** The view revision the action was asked against (its base revision). */
  revision: string | null
  at: number
  message?: string
  /** Returned fields in the order returned, sources excluded. Values are data only: rendered as text, never markup. */
  fields: [string, unknown][]
  basis: ResultBasis
  /** The view has changed since this result was returned. */
  stale: boolean
}

/** A `started` action: a swarm goal followed live. */
export interface TaskRef {
  id: string
  kind: string
  status: string
  action: string
  label: string
  items: string[]
  at: number
}

export interface ProgramSession {
  key: string
  programId: string
  swarmId: string
  graph: WorkGraph | null
  /** Oldest first; the last step is where the person is. Never empty. */
  trail: TrailStep[]
  selection: string[]
  loading: boolean
  error: { code: string; message: string } | null
  notice: ProgramNotice | null
  /** The program's suggested stage, shown as a gentle hint (never an automatic jump). */
  suggestion: ProgramStage | null
  input: PendingInput | null
  sourceDetail: SourceDetail | null
  /** The last action's returned data (not its sources), or null. Reset by a new action, navigation or session. */
  result: ResultDetail | null
  tasks: TaskRef[]
  /** The action in flight, if any. */
  busy: string | null
}

export const TRAIL_CAP = 40
export const sessionKey = (programId: string, swarmId: string) => `${programId}\u0000${swarmId}`

export function newSession(programId: string, swarmId: string, trail?: TrailStep[]): ProgramSession {
  return {
    key: sessionKey(programId, swarmId),
    programId,
    swarmId,
    graph: null,
    trail: trail?.length ? trail : [{ stage: 'unfold', focus: null }],
    selection: [],
    loading: false,
    error: null,
    notice: null,
    suggestion: null,
    input: null,
    sourceDetail: null,
    result: null,
    tasks: [],
    busy: null,
  }
}

export const currentStep = (s: Pick<ProgramSession, 'trail'>): TrailStep => s.trail[s.trail.length - 1]

const sameIds = (a?: string[], b?: string[]) => (a ?? []).join('\u0000') === (b ?? []).join('\u0000')
export const sameStep = (a: TrailStep, b: TrailStep) => a.stage === b.stage && a.focus === b.focus && (a.stage !== 'compare' || sameIds(a.compare, b.compare))

/** Go somewhere new: appended unless it is where you already are. */
export function pushStep(trail: TrailStep[], step: TrailStep): TrailStep[] {
  const last = trail[trail.length - 1]
  if (last && sameStep(last, step)) return trail
  const next = [...trail, step]
  return next.length > TRAIL_CAP ? next.slice(next.length - TRAIL_CAP) : next
}

/** Change where you are without adding a step (e.g. the program settled the focus). */
export function replaceStep(trail: TrailStep[], step: TrailStep): TrailStep[] {
  return [...trail.slice(0, -1), step]
}

/** Back one step; the first step stays. */
export function backStep(trail: TrailStep[]): TrailStep[] {
  return trail.length > 1 ? trail.slice(0, -1) : trail
}

/** Jump to a breadcrumb: everything after it is dropped. */
export function jumpTo(trail: TrailStep[], index: number): TrailStep[] {
  if (index < 0 || index >= trail.length) return trail
  return trail.slice(0, index + 1)
}

export const canGoBack = (trail: TrailStep[]) => trail.length > 1

/** The item the step is about, if the graph has it; else the graph's own focus. */
export function resolveFocus(step: TrailStep, graph: WorkGraph | null): string | null {
  if (!graph) return step.focus
  const ids = new Set(graph.items.map((i) => i.id))
  if (step.focus && ids.has(step.focus)) return step.focus
  if (graph.focus && ids.has(graph.focus)) return graph.focus
  return graph.items[0]?.id ?? null
}

export function itemMap(graph: WorkGraph | null): Map<string, WorkItem> {
  return new Map((graph?.items ?? []).map((i) => [i.id, i]))
}

/**
 * Replace the graph with a new full snapshot. Ids are stable, so the trail survives: the current
 * step keeps its focus if the item still exists, otherwise it settles on the graph's focus. The
 * selection keeps the items that still exist.
 */
export function reconcile(s: ProgramSession, graph: WorkGraph): ProgramSession {
  const ids = new Set(graph.items.map((i) => i.id))
  const step = currentStep(s)
  const focus = step.focus && ids.has(step.focus) ? step.focus : (graph.focus ?? step.focus)
  const compare = step.compare?.filter((id) => ids.has(id))
  const nextStep: TrailStep = { ...step, focus, ...(step.compare ? { compare } : {}) }
  return {
    ...s,
    graph,
    trail: sameStep(step, nextStep) && sameIds(step.compare, compare) ? s.trail : replaceStep(s.trail, nextStep),
    selection: s.selection.filter((id) => ids.has(id)),
    sourceDetail: s.sourceDetail && s.sourceDetail.items.every((id) => ids.has(id)) ? s.sourceDetail : null,
    // a result about items no longer in view goes; one whose revision has moved on is kept but marked stale
    result: !s.result || !s.result.items.every((id) => ids.has(id)) ? null : s.result.revision !== graph.revision && !s.result.stale ? { ...s.result, stale: true } : s.result,
  }
}

let noticeSeq = 0
export const notice = (n: Omit<ProgramNotice, 'id'>): ProgramNotice => ({ ...n, id: ++noticeSeq })

/**
 * A view arrived for the current step. A view that drops the requested focus while the revision is
 * unchanged is ignored (the program did not centre on that item; the current snapshot still holds
 * it). A changed revision is announced calmly.
 */
export function receiveView(s: ProgramSession, graph: WorkGraph, opts: { quiet?: boolean } = {}): ProgramSession {
  const step = currentStep(s)
  const prev = s.graph
  const hasFocus = !step.focus || graph.items.some((i) => i.id === step.focus)
  if (prev && !hasFocus && prev.revision === graph.revision && prev.items.some((i) => i.id === step.focus)) {
    return { ...s, loading: false, error: null }
  }
  let next = reconcile({ ...s, loading: false, error: null }, graph)
  if (prev && prev.revision !== graph.revision && !opts.quiet) {
    next = { ...next, notice: notice({ kind: 'revision', tone: 'info', title: `Updated to ${graph.revision}`, body: `The program's view changed since ${prev.revision}. Your place is kept.` }) }
  }
  const suggested = graph.suggested_stage ?? null
  next = { ...next, suggestion: suggested && suggested !== step.stage ? suggested : null }
  return next
}

/** Move to a step (push), or back / jump (already applied to the trail). Clears transient UI. */
export function goTo(s: ProgramSession, trail: TrailStep[]): ProgramSession {
  const step = trail[trail.length - 1]
  return {
    ...s,
    trail,
    suggestion: null,
    input: s.input,
    result: null,
    selection: step.stage === 'compare' ? s.selection : s.selection.filter((id) => id === step.focus),
  }
}

export interface ActContext {
  action: string
  items: string[]
  params: Record<string, unknown>
  /** The action's description (for labels, params and its stage hint). */
  def?: ProgramAction
  now?: number
  /** The view revision the action was sent with (`base_revision`); defaults to the session's current one. */
  baseRevision?: string | null
}

/** A value worth showing: not absent, not an empty string, list or object. */
export function showable(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/** The program's own word on whether this ran now. */
export function resultBasis(detail: Record<string, unknown>): ResultBasis {
  const flags = [detail.executed_now, detail.executed].filter((x) => typeof x === 'boolean')
  if (flags.includes(true)) return 'current'
  if (flags.includes(false)) return 'banked'
  return 'unstated'
}

let resultSeq = 0
function resultOf(s: ProgramSession, r: ActionResult, ctx: ActContext, label: string): ResultDetail | null {
  const detail = r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {}
  const fields = Object.entries(detail).filter(([k, v]) => k !== 'sources' && showable(v))
  if (!fields.length) return null
  // a result that brought its own graph is about that graph; otherwise about the revision it was asked against
  const revision = r.graph?.revision ?? (ctx.baseRevision !== undefined ? ctx.baseRevision : (s.graph?.revision ?? null))
  return {
    seq: ++resultSeq,
    action: ctx.action,
    label,
    items: [...ctx.items],
    programId: s.programId,
    swarmId: s.swarmId,
    sessionKey: s.key,
    revision,
    at: ctx.now ?? Date.now(),
    message: r.message,
    fields,
    basis: resultBasis(detail),
    stale: !!s.graph && revision !== s.graph.revision,
  }
}


/**
 * Fold an action result into the session. Results from an action the person just took may move the
 * stage (the program's suggested stage); everything else only suggests.
 */
export function applyResult(s: ProgramSession, r: ActionResult, ctx: ActContext): { session: ProgramSession; refresh: boolean } {
  const label = ctx.def?.label ?? ctx.action
  // every result replaces the last one's data: a declined, stale or failed action never leaves earlier data looking current
  let next: ProgramSession = { ...s, busy: null, result: null }
  switch (r.status) {
    case 'done': {
      next = { ...next, input: null }
      if (r.graph) {
        const prevStep = currentStep(next)
        next = reconcile(next, r.graph)
        const stage = r.graph.suggested_stage
        if (stage) {
          const focus = r.graph.focus ?? currentStep(next).focus
          // compare: the program's own groups when it returned some, else the chosen items side by side
          const chosen = r.graph.groups.length ? [] : ctx.items.length > 1 ? ctx.items : []
          const step: TrailStep = stage === 'compare' ? { stage, focus, compare: chosen } : { stage, focus }
          if (!sameStep(prevStep, step)) next = goTo(next, pushStep(next.trail, step))
        }
      }
      if (r.detail?.sources) next = { ...next, sourceDetail: { items: ctx.items, sources: r.detail.sources, message: r.message, at: ctx.now ?? Date.now() } }
      if (r.message && !r.detail?.sources) next = { ...next, notice: notice({ kind: 'result', tone: 'good', title: `${label}: done`, body: r.message }) }
      next = { ...next, result: resultOf(next, r, ctx, label) }
      // nothing at all to show: say so plainly instead of silence
      if (!next.result && !r.graph && !r.message && !r.detail?.sources?.length) {
        next = { ...next, notice: notice({ kind: 'result', tone: 'info', title: 'Nothing to show for this result', body: `${label} finished and returned nothing to show.` }) }
      }
      return { session: next, refresh: false }
    }
    case 'started': {
      const t = r.task!
      const task: TaskRef = { id: t.id, kind: t.kind, status: t.status, action: ctx.action, label, items: ctx.items, at: ctx.now ?? Date.now() }
      next = { ...next, input: null, tasks: [task, ...next.tasks.filter((x) => x.id !== t.id)].slice(0, 8), notice: notice({ kind: 'result', tone: 'info', title: `${label}: started`, body: r.message ?? `Posted ${t.kind} ${t.id} to the swarm.` }) }
      return { session: next, refresh: false }
    }
    case 'needs_input': {
      const needs: Record<string, string> = { ...(ctx.def?.params ?? {}), ...(r.needs ?? {}) }
      // only what the result asks for, described by the action's own params when it has words for it
      const asked = Object.keys(r.needs ?? {}).length ? Object.keys(r.needs ?? {}) : Object.keys(needs)
      const described = Object.fromEntries(asked.map((k) => [k, r.needs?.[k] || ctx.def?.params?.[k] || k]))
      next = { ...next, input: { action: ctx.action, items: ctx.items, needs: described, message: r.message, params: ctx.params } }
      return { session: next, refresh: false }
    }
    case 'stale': {
      const before = s.graph?.revision
      if (r.graph) next = reconcile(next, r.graph)
      const now = next.graph?.revision
      next = {
        ...next,
        input: null,
        notice: notice({
          kind: 'stale',
          tone: 'warn',
          title: `${label} was not applied`,
          body: `The view changed${before && now && before !== now ? ` from ${before} to ${now}` : ''} before it ran, so nothing was changed. Review the current view and try again.`,
        }),
      }
      return { session: next, refresh: true }
    }
    case 'refused':
      return { session: { ...next, notice: notice({ kind: 'refused', tone: 'warn', title: `${label} declined`, body: r.message ?? 'The program declined this action.' }) }, refresh: false }
    case 'error':
    default:
      return { session: { ...next, notice: notice({ kind: 'error', tone: 'bad', title: `${label} failed`, body: r.message ?? 'The program failed.' }) }, refresh: false }
  }
}

/** Actions that apply to every selected item's kind (absent applies_to = any kind). */
export function actionsFor(actions: ProgramAction[], kinds: string[]): ProgramAction[] {
  if (!kinds.length) return []
  return actions.filter((a) => !a.applies_to || kinds.every((k) => a.applies_to!.includes(k)))
}

/** A short count of changes between two snapshots, for the revision notice. */
export function diffSummary(prev: WorkGraph | null, next: WorkGraph): string | null {
  if (!prev) return null
  const before = itemMap(prev)
  let added = 0
  let changed = 0
  for (const it of next.items) {
    const b = before.get(it.id)
    if (!b) added++
    else if (b.label !== it.label || b.status !== it.status || (b.flags ?? []).join() !== (it.flags ?? []).join()) changed++
  }
  const removed = prev.items.filter((i) => !next.items.some((x) => x.id === i.id)).length
  const parts = [added && plural(added, 'new item'), changed && plural(changed, 'changed item'), removed && `${removed} out of view`].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

// ---------------------------------------------------------------- persistence (optional)

const storeKey = (key: string) => `omegadots.program.trail.${key.replace('\u0000', '/')}`

export function saveTrail(key: string, trail: TrailStep[]): void {
  try {
    localStorage.setItem(storeKey(key), JSON.stringify(trail.slice(-TRAIL_CAP)))
  } catch {
    /* storage unavailable: the trail lives in memory only */
  }
}

export function loadTrail(key: string): TrailStep[] | null {
  try {
    const raw = localStorage.getItem(storeKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as TrailStep[]
    const ok = Array.isArray(parsed) && parsed.every((s) => s && ['unfold', 'map', 'compare', 'detail'].includes(s.stage) && (s.focus === null || typeof s.focus === 'string'))
    return ok && parsed.length ? parsed : null
  } catch {
    return null
  }
}
