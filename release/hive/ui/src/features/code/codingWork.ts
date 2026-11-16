import type { Goal, GoalGrant, Swarm } from '../../api/types'

/** The swarm the hive files "Edit code" goals under (hive/core/code.py code_swarm). */
export const CODE_SWARM_NAME = 'Code local'
/** At most this many goals are asked for their grants when the Code page opens. */
export const GRANT_PROBE_CAP = 30

const ACTIVE: ReadonlySet<Goal['status']> = new Set(['open', 'claimed', 'waiting', 'stalled'])

export interface LiveWorkItem {
  goal: Goal
  /** Workspace ids named by this goal's grants, newest first (an attach records the workspace it joined). */
  workspaces: string[]
  /** The registered repository the goal names (code.py writes "repository=<id>" into an opened goal's detail). */
  repository: string | null
}

const isCodeSwarm = (s: Swarm | undefined) => !!s && s.name === CODE_SWARM_NAME

/** Goals worth asking for grants: open work in the code swarm first, then work a mind holds, newest first. */
export function grantProbe(goals: Record<string, Goal>, swarms: Record<string, Swarm>, cap = GRANT_PROBE_CAP): string[] {
  const rank = (g: Goal) => (isCodeSwarm(swarms[g.swarm_id]) ? 0 : g.claimed_by ? 1 : 2)
  return Object.values(goals)
    .filter((g) => ACTIVE.has(g.status) && rank(g) < 2)
    .sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at))
    .slice(0, cap)
    .map((g) => g.id)
}

/**
 * Live coding work: unfinished goals in coding swarms. A coding swarm is the hive's code swarm, or any
 * swarm with a goal that has a coding grant. Goals with a known workspace come first.
 */
export function liveCodingWork(goals: Record<string, Goal>, swarms: Record<string, Swarm>, grants: Record<string, GoalGrant[]>): LiveWorkItem[] {
  const coding = new Set<string>()
  for (const s of Object.values(swarms)) if (isCodeSwarm(s)) coding.add(s.id)
  for (const [goalId, list] of Object.entries(grants)) {
    const g = goals[goalId]
    if (g && list.length) coding.add(g.swarm_id)
  }
  const items: LiveWorkItem[] = []
  for (const g of Object.values(goals)) {
    if (!ACTIVE.has(g.status) || !coding.has(g.swarm_id)) continue
    const workspaces = [
      ...new Set(
        (grants[g.id] ?? [])
          .filter((x) => x.workspace_id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((x) => x.workspace_id as string),
      ),
    ]
    items.push({ goal: g, workspaces, repository: /(?:^|\s)repository=(\S+)/.exec(g.detail ?? '')?.[1] ?? null })
  }
  return items.sort((a, b) => (b.workspaces.length ? 1 : 0) - (a.workspaces.length ? 1 : 0) || b.goal.updated_at.localeCompare(a.goal.updated_at))
}
