import type { ProgramDescription } from '../../api/types'
import { isConsequential } from './gate'
import { FILTERS, matches, type Filter, type Sky, type Unfolded } from './model'

/**
 * For the host's shared Ask layer (Jon, 2026-10-05: every app has a floating text and voice input; a request reshapes
 * the world around it). The form does not build its own input. It offers two pure things:
 *
 *  1. `surfaceOf`: what the commons shows and can do right now (focus, visible entities, available acts with their
 *     act ids and whether they need the host confirm). Data only; nothing here can act.
 *  2. `CommonsNav` + `navFor`: navigation as state. A request like "show me the beliefs about vega" becomes
 *     { query: 'vega' } (and a focus when exactly one belief matches); the form applies it with `setNav`, no clicks.
 *
 * An act the Ask proposes still goes through the form's own request path (cs.requestAsk), so the host DecisionDialog,
 * arming and drift rules hold whatever asked for it.
 */

export interface CommonsNav {
  /** The unfolded belief (b:<statement>), or null for the sky. */
  focus: string | null
  filter: Filter
  query: string
}

export const HOME: CommonsNav = { focus: null, filter: 'all', query: '' }

export interface SurfaceEntity {
  id: string
  kind: 'belief' | 'report' | 'rival' | 'gap'
  label: string
  /** The plain reading (beliefs and rivals). */
  reading?: string
  truth?: string
}

export interface SurfaceAction {
  /** The program's act id (describe().actions[].id). */
  act: string
  label: string
  /** The items it would be sent with. */
  items: string[]
  /** True: only through the host DecisionDialog (posts a goal). */
  confirm: boolean
}

export interface CommonsSurface {
  form: 'commons'
  program: string
  revision: string
  question: string
  nav: CommonsNav
  /** What is on screen: the visible beliefs, or the unfolded belief's reports, rivals and gaps. */
  entities: SurfaceEntity[]
  actions: SurfaceAction[]
  /** Navigation the Ask may set (filter ids and their labels). */
  filters: { id: Filter; label: string }[]
}

const tv = (t: { f: number; c: number } | null) => (t ? `f ${t.f.toFixed(2)} c ${t.c.toFixed(2)}` : 'unassessed')

export function surfaceOf(programId: string, sky: Sky, nav: CommonsNav, unfolded: Unfolded | null, describe: ProgramDescription | null | undefined): CommonsSurface {
  const has = (id: string) => describe?.actions.find((a) => a.id === id)
  const act = (id: string, items: string[]): SurfaceAction[] => {
    const d = has(id)
    return d ? [{ act: id, label: d.label ?? id, items, confirm: isConsequential(id) }] : []
  }
  if (nav.focus && unfolded && unfolded.star.id === nav.focus) {
    const u = unfolded
    return {
      form: 'commons',
      program: programId,
      revision: u.revision,
      question: sky.question,
      nav,
      entities: [
        { id: u.star.id, kind: 'belief', label: u.star.statement, reading: u.star.reading, truth: tv(u.star.truth) },
        ...u.reports.map((r) => ({ id: r.id, kind: 'report' as const, label: `${r.who} ${r.stance}`, truth: tv(r.truth) })),
        ...u.rivals.map((r) => ({ id: r.id, kind: 'rival' as const, label: r.statement, reading: r.reading, truth: tv(r.truth) })),
        ...u.gaps.map((g) => ({ id: g.id, kind: 'gap' as const, label: g.label })),
      ],
      actions: [
        ...act('challenge', [u.star.id]),
        ...u.reports.flatMap((r) => act('inspect-source', [r.id])),
        ...u.rivals.flatMap((r) => act('compare', [u.star.id, r.id])),
        ...u.gaps.flatMap((g) => act('investigate-gap', [g.id])),
      ],
      filters: FILTERS,
    }
  }
  const visible = sky.stars.filter((s) => matches(s, nav.filter, nav.query))
  return {
    form: 'commons',
    program: programId,
    revision: sky.revision,
    question: sky.question,
    nav: { ...nav, focus: null },
    entities: visible.map((s) => ({ id: s.id, kind: 'belief', label: s.statement, reading: s.reading, truth: tv(s.truth) })),
    actions: [],
    filters: FILTERS,
  }
}

/**
 * A request's navigation, as state: { about } searches (and unfolds when exactly one belief matches), { belief }
 * unfolds that belief (by id or exact statement), { filter } chooses a filter, {} goes home. Unknown beliefs leave the
 * focus empty; nothing here guesses.
 */
export function navFor(sky: Sky, intent: { about?: string; belief?: string; filter?: Filter }): CommonsNav {
  const filter = intent.filter && FILTERS.some((f) => f.id === intent.filter) ? intent.filter : 'all'
  if (intent.belief) {
    const s = sky.stars.find((x) => x.id === intent.belief || x.statement === intent.belief)
    return { focus: s?.id ?? null, filter, query: s ? '' : intent.belief }
  }
  const query = (intent.about ?? '').trim()
  if (!query) return { focus: null, filter, query: '' }
  const hits = sky.stars.filter((s) => matches(s, filter, query))
  return { focus: hits.length === 1 ? hits[0].id : null, filter, query }
}
