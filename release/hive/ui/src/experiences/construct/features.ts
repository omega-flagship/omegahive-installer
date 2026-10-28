import { FEATURES, GROUP_LABEL, type Feature, type FeatureGroup } from '../../features/registry'

/**
 * Every hive feature, as the construct reaches it: a native command when the construct does it in its own grammar,
 * otherwise `page <feature>` opens the classic page over the construct. Pure (no store), so it can be tested.
 */

/** The command that does a feature natively. `arg` commands need a target; `page <feature>` pre-fills them. */
/** `viaPage`: the command opens the classic flow over the construct (so it is not counted as native). */
/**
 * `fuller`: the command is the construct's own (read-only or quick) form, and the classic page does more (inviting,
 * history and limits, the full creation flow). `open <id>` runs the command; `page <id>` opens that page.
 */
export const NATIVE_CMD: Record<string, { cmd: string; arg?: string; viaPage?: true; fuller?: true }> = {
  'minds.see': { cmd: 'ls minds' },
  'minds.create': { cmd: 'spawn', arg: '<name> [in <swarm>] [model <id>] [budget <usd>]', fuller: true },
  'minds.talk': { cmd: 'open', arg: '<mind>' },
  'minds.wake': { cmd: 'wake', arg: '<mind>' },
  'swarms.see': { cmd: 'ls swarms' },
  'swarms.launch': { cmd: 'swarm new', viaPage: true },
  'swarms.beliefs': { cmd: 'beliefs', arg: '<swarm> [filter]' },
  'work.motivations': { cmd: 'motivations', fuller: true },
  'work.goals': { cmd: 'tasks' },
  'decide.approvals': { cmd: 'inbox' },
  'decide.history': { cmd: 'decided', fuller: true },
  'decide.rules': { cmd: 'rules', fuller: true },
  'decide.stopall': { cmd: 'stopall' },
  'watch.activity': { cmd: 'activity' },
  'money.usage': { cmd: 'usage', fuller: true },
  'people.manage': { cmd: 'people', fuller: true },
  'hive.search': { cmd: 'palette' },
  'hive.changeui': { cmd: 'ui' },
  'hive.help': { cmd: 'help' },
}

/** `page <id>` on a feature whose classic page does more than its command opens that page (never a loop back). */
export const pageOpensClassic = (f: Feature): boolean => !!(NATIVE_CMD[f.id]?.fuller && f.classic)

/** Feature ids the construct does natively (its line in experiences/coverage.ts NATIVE). */
export const CONSTRUCT_NATIVE = Object.keys(NATIVE_CMD).filter((id) => !NATIVE_CMD[id].viaPage)

/** Find a feature by what was typed: its id, the tail of its id, a classic page name, or words of its label. */
export function findFeature(q: string | undefined): Feature | null {
  const s = (q ?? '').trim().toLowerCase()
  if (!s) return null
  const exact = FEATURES.find((f) => f.id === s)
  if (exact) return exact
  const tail = FEATURES.filter((f) => f.id.split('.')[1] === s)
  if (tail.length === 1) return tail[0]
  // a classic route name (`page usage`, `page people`): the first feature that lives there
  const byRoute = FEATURES.find((f) => f.classic?.name === s && !('tab' in f.classic))
  if (byRoute) return byRoute
  const pre = FEATURES.filter((f) => f.id.startsWith(s) || f.id.split('.')[1]?.startsWith(s))
  if (pre.length === 1) return pre[0]
  const words = s.split(/[\s-]+/).filter(Boolean)
  const hit = FEATURES.filter((f) => words.every((w) => `${f.id} ${f.label} ${f.blurb} ${f.keywords ?? ''}`.toLowerCase().includes(w)))
  return hit.length === 1 ? hit[0] : null
}

export const featuresByGroup = (): [FeatureGroup, string, Feature[]][] => {
  const by = new Map<FeatureGroup, Feature[]>()
  for (const f of FEATURES) by.set(f.group, [...(by.get(f.group) ?? []), f])
  return [...by.entries()].map(([g, list]) => [g, GROUP_LABEL[g], list])
}

/** How the construct reaches a feature, for `help features`. */
export function reachLine(f: Feature): { native: boolean; how: string } {
  const n = NATIVE_CMD[f.id]
  if (n) return { native: !n.viaPage, how: n.arg ? `${n.cmd} ${n.arg}` : n.cmd }
  return { native: false, how: f.classic ? `page ${f.id}` : 'not built yet' }
}
