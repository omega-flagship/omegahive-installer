/**
 * Create's Code bench opens straight into a project (Jon 11-05: friction-free; a setup prompt is a bug). The person
 * never confirms a task, a grant or an id: opening a project in Create IS starting work on it.
 *
 * Which project, in order:
 *  1. the one this person last worked on in Create (kept in this browser, per sign-in), when it is still editable;
 *  2. one with a task saved in this browser (its grant is checked before it is reused; a definite "no" opens fresh);
 *  3. the only editable project;
 *  4. the hive's disposable synthetic project (repo:synthetic) when it is editable;
 *  otherwise the person picks one with one tap (no confirmation after it).
 *
 * The full Code page (#/code) keeps its explicit, confirmed start: this is only Create's bench.
 */
import type { Target } from './CodePage'
import { targetOpenable } from './editSessionRules'

export const SYNTHETIC = 'repo:synthetic'
const LAST = 'omegadots.create.code.last.v1|'

export type BenchPlan =
  | { kind: 'open'; target: Target; reuse: boolean }
  | { kind: 'choose'; targets: Target[] }
  | { kind: 'none' }

export function benchPlan(targets: readonly Target[], hasSaved: (targetId: string) => boolean, last: string | null): BenchPlan {
  const editable = targets.filter((t) => targetOpenable(t))
  if (!editable.length) return { kind: 'none' }
  const pick = (t: Target | undefined): BenchPlan | null => (t ? { kind: 'open', target: t, reuse: hasSaved(t.id) } : null)
  return pick(editable.find((t) => t.id === last))
    ?? pick(editable.find((t) => hasSaved(t.id)))
    ?? (editable.length === 1 ? pick(editable[0]) : null)
    ?? pick(editable.find((t) => t.id === SYNTHETIC))
    ?? { kind: 'choose', targets: editable }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>
const browser = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

export function lastProject(principal: string | null | undefined, store: Store | null = browser()): string | null {
  if (!principal || !store) return null
  try { return store.getItem(LAST + principal) } catch { return null }
}
export function rememberProject(principal: string | null | undefined, targetId: string, store: Store | null = browser()): void {
  if (!principal || !store) return
  try { store.setItem(LAST + principal, targetId) } catch { /* a convenience only */ }
}
