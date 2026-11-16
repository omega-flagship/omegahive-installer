import type { Route } from '../../lib/router'

export type CodeRoute = Extract<Route, { name: 'code' }>

/**
 * Surface S (workbench load): which Code view a `#/code…` route shows. Pure, so the page decides from the route it
 * was opened for (App passes it) and never from the live hash.
 *
 * Why: App renders the Code page inside AnimatePresence, which keeps a leaving page mounted for its exit. A page that
 * read the live hash re-rendered that leaving copy for the NEXT route: leaving a workbench for any other page swapped
 * it for the Code targets list (unmounting the workbench, so a workspace create still in flight landed on nothing and
 * its tree was never asked for; the list's reads went out again), and opening a target from the list mounted the
 * target twice (live 1286cd9: two POST /api/code/open per click, so two tasks and two edit grants).
 */
export type CodeView =
  | { kind: 'attach'; task: string; workspace: string; repository: string }
  | { kind: 'select'; task: string; repository: string }
  | { kind: 'choose'; task: string }
  | { kind: 'target'; target: string }
  | { kind: 'list' }
  /** Workbench Map: a repository revision's map (repo and sha empty: the list of maps; sha empty: the newest one) */
  | { kind: 'map'; repo: string; sha: string }

export function codeView(route: CodeRoute): CodeView {
  if (route.map !== undefined) {
    const at = route.map.lastIndexOf('@')
    return at > 0 ? { kind: 'map', repo: route.map.slice(0, at), sha: route.map.slice(at + 1) } : { kind: 'map', repo: route.map, sha: '' }
  }
  if (route.workspace && route.task && route.repository) return { kind: 'attach', task: route.task, workspace: route.workspace, repository: route.repository }
  // a task with no workspace yet: the person picks its repository first, and the exact task is kept
  if (!route.workspace && route.task && route.repository) return { kind: 'select', task: route.task, repository: route.repository }
  if (!route.workspace && route.task) return { kind: 'choose', task: route.task }
  if (route.target) return { kind: 'target', target: route.target }
  return { kind: 'list' }
}
