/**
 * Split, merge and move (PLAN_HIVE_VIEW_SCALING r2 §3) change which hive a swarm is in, so they need host routes:
 * Platform's to build, under the no-widening contract (authority over source, destination and every object; a hive
 * is a grouping, never an ACL; a confirmation bound to the exact change; atomic; personal minds stay put). No hive
 * offers them yet, so no control, menu item or Ask word for them exists on the map: this is the capability seam they
 * will hang from. A client offers an action only by implementing the whole route set it needs.
 *
 * Proposed routes (r2 §3; names Platform's to settle):
 *   GET  /api/hives                                  list hives (visibility-scoped fields, P-4)
 *   GET  /api/hives/links                            link aggregates, per visible interaction (P-3)
 *   POST /api/hives/plan {action, …}                 the exact change set + confirmation digest; applies nothing
 *   POST /api/swarms/{id}/move {hive_id, confirm}    move a swarm
 *   POST /api/hives/{id}/split {name, swarm_ids[], confirm}
 *   POST /api/hives/{id}/merge {from_hive_id, confirm}
 */
export type HiveAction = 'split' | 'merge' | 'move'

/** The client methods the routes above would add (not part of HiveClient until a hive serves them). */
interface HiveActionMethods {
  listHives?: unknown
  planHiveChange?: unknown
  splitHive?: unknown
  mergeHives?: unknown
  moveSwarmToHive?: unknown
}

const NEEDS: Record<HiveAction, (keyof HiveActionMethods)[]> = {
  split: ['listHives', 'planHiveChange', 'splitHive'],
  merge: ['listHives', 'planHiveChange', 'mergeHives'],
  move: ['listHives', 'planHiveChange', 'moveSwarmToHive'],
}

/** The actions this client offers: each only when every route it needs is there. Today: none, for every client. */
export function hiveActionsOffered(client: object | null | undefined): ReadonlySet<HiveAction> {
  const c = (client ?? {}) as HiveActionMethods
  const out = new Set<HiveAction>()
  for (const [a, needs] of Object.entries(NEEDS) as [HiveAction, (keyof HiveActionMethods)[]][]) if (needs.every((m) => typeof c[m] === 'function')) out.add(a)
  return out
}
