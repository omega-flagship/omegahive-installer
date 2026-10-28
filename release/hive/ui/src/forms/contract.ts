import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ActionResult, Program, ProgramDescription, ProgramStage, WorkGraph } from '../api/types'
import type { CreationReference } from '../lib/router'

/**
 * App forms: a view built for one app's purpose, rendered in the grammar of the experience it is opened in.
 * The same data and the same act() contract as the generic program host; only the presentation changes.
 * Host-owned safety (labelled uncertainty, provenance, transport/review, dispatch confirm) is inside every form.
 */

export type Grammar = 'classic' | 'cosmos' | 'construct' | 'still' | 'flux' | 'canvas'
export const GRAMMARS: Grammar[] = ['classic', 'cosmos', 'construct', 'still', 'flux', 'canvas']

export interface FormProps {
  program: Program
  describe: ProgramDescription | null
  graph: WorkGraph
  grammar: Grammar
  /**
   * The program's act(). The host binds swarm and base_revision. A form that confirmed an action against a revision it
   * showed passes that inspected revision (Review C2); the host then sends exactly it, never a newer one, so the host's
   * stale-revision check refuses a consent given on an older record. Without it the host uses the session's revision.
   */
  act: (action: string, items: string[], params?: Record<string, unknown>, ctx?: ActContext) => Promise<FormActResult>
  /** Tell the host which item the person is looking at (null: none). */
  focus: (itemId: string | null) => void
  busy?: boolean
  /** Who is looking (a form may show the owner their own record and anyone else an empty view or an explicit sample). */
  viewer?: { isOwner: boolean }
  /**
   * The program's view() for another focus and stage, bound by the host to this program and swarm. A read only: it
   * does not move the host's session. Optional (a host without it: the form shows what the session's graph holds).
   */
  view?: (focus: string | null, stage?: ProgramStage) => Promise<WorkGraph>
  /** The swarm the form works in: part of the identity every read is bound to (lib/readContext). */
  scope?: string
  /** The exact creation the page was opened on (the route's `source`), for forms that open one work (Design's canvas). */
  source?: CreationReference
  /** The form holds edits the hive does not have yet: the host then asks before anything replaces them. */
  onDirty?: (dirty: boolean) => void
  /** Open the app's own interface instead (a program that ships one); absent when it has none. */
  openOwn?: () => void
  /**
   * The experience the form is opened in when the form has no rendering of its own for it (`grammar` is then the
   * rendering it falls back to): the form wears that experience's chrome tokens (forms/chromeDress.ts). Absent in
   * classic and in every experience the form renders natively.
   */
  dressFrom?: Grammar
}

/**
 * What act() resolves to: the app's result as the hive returned it, or the host's account of an act that did not
 * produce one. `unknown` (Review B1, commons f0818d8): the act may have been delivered and its outcome is not known (no
 * answer came back, the far side failed after it may have acted, the person closed a re-ask for an attempt whose
 * effect is unknown, or the identity changed after it was sent). A form must never say "nothing changed" or invite a
 * plain retry for it; it tells the person to check first. Without `unknown`, a `refused` or `stale` is a known no.
 */
export type FormActResult = ActionResult & { unknown?: true; /** the hive's refusal code, when it refused before acting (demo D3: app_inactive) */ code?: string }

export interface ActContext {
  /** The graph revision the person inspected when they confirmed. */
  baseRevision?: string | null
  /**
   * §9d: the form showed its own full-context confirm and the person confirmed it. The host then mints the confirm
   * token at once instead of showing a second dialog. Without it, an act on a confirm action is asked in the host.
   */
  confirmed?: true
}

/** The base revision the host sends: the inspected one when a form gave it, else the session's current one. */
export const baseRevisionOf = (ctx: ActContext | undefined, sessionRevision: string | null | undefined): string | null =>
  ctx && ctx.baseRevision !== undefined ? ctx.baseRevision : (sessionRevision ?? null)

/**
 * Forms that belong to closed-source apps (for example the case file and the body map) ship with those apps, in their
 * own repositories; such a program opens on the generic host stage or in its own pinned frame here.
 */
export type FormId = 'commons' | 'design-canvas'

/** Programs that always open as a given form. */
const BY_PROGRAM: Record<string, FormId> = { 'commons-explorer': 'commons', omegadesign: 'design-canvas' }

/**
 * Programs that ship their own interface (a pinned frame) AND have a Surface form over the same data contract: the
 * form opens first, the app's own interface stays one choice away (Ω → View). Design's living canvas (the owner,
 * 2026-10-05: "one huge living canvas"); Design's engine, contract and custody are unchanged.
 */
export const FORM_OVER_FRAME = new Set<string>(['omegadesign'])

/** The form for a program, or null for the generic host stage. `describe` is reserved for forms chosen by shape. */
export function formFor(programId: string, _describe: ProgramDescription | null): FormId | null {
  return BY_PROGRAM[programId] ?? null
}

/** Grammars a form has its own rendering for; the others use its classic rendering for now. */
export const NATIVE_GRAMMARS: Record<FormId, Grammar[]> = { commons: ['classic', 'still', 'canvas'], 'design-canvas': ['classic'] }

/** Form components, loaded on first use so the forms never weigh on the app's first paint. */
export const FORMS: Record<FormId, LazyExoticComponent<ComponentType<FormProps>>> = {
  commons: lazy(() => import('./commons/Commons')),
  'design-canvas': lazy(() => import('./designCanvas/DesignCanvas')),
}
