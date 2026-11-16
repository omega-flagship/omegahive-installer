import type { Agent, AgentStatus } from '../api/types'

/**
 * Request helpers on the hive map (every look that draws swarms with their minds: the classic star map, Cosmos).
 *
 * A request helper is a child mind a team's controller spawns for one request (hive/core/minds.py spawn, a row in
 * mind_children). The agent view (hive.py agent_view) carries no child field, so the structural marker is the host's
 * own spawn contract: a child is created named `<template_id> <4 hex>` (minds.py: `f"{template['template_id']}
 * {secrets.token_hex(2)}"`), where a template id is 1-80 of [A-Za-z0-9_.:-] (minds.py TEMPLATE_ID; registered ids are
 * dotted, `foundation.code-helper.v1`). No template id is matched by name: any registered template's child qualifies.
 * A mind a person renamed is no longer a child by this marker and is drawn as any other mind.
 *
 * Finished or asleep helpers (asleep, stopped, error, or live but silent for longer than any request lives) are folded
 * under their team into ONE quiet "+N helpers" orb; it opens to show them, and closes again. Live helpers (awake,
 * starting, created) are drawn individually. A helper's label is never the raw template id: it is "Helper <n>", n its
 * order of birth among its team's helpers.
 */

/** The host's child name: a template id, one space, two random bytes in hex (minds.py spawn). */
const CHILD_NAME = /^([A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)+) ([0-9a-f]{4})$/

/** Whether this mind is a spawned request helper (by the host's spawn naming contract, above). */
export function isHelper(a: Pick<Agent, 'name'>): boolean {
  const m = CHILD_NAME.exec(a.name ?? '')
  return !!m && m[1].length <= 80
}

/** Statuses of a helper that is still working (drawn individually). */
const LIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['awake', 'starting', 'created'])

/**
 * A live helper silent this long is past any request (a foundation request lives 600 s, minds.py lifetime_seconds;
 * the longest a person's request may ask is far under an hour): it is folded with the finished ones.
 */
export const HELPER_STALE_MS = 60 * 60_000

/** Whether a helper is finished or asleep (folded), at `now` (ms). */
export function helperFinished(a: Pick<Agent, 'status' | 'last_active_at' | 'created_at'>, now: number): boolean {
  if (!LIVE.has(a.status)) return true
  if (a.status === 'starting') return false
  const at = Date.parse(a.last_active_at ?? a.created_at ?? '')
  return Number.isFinite(at) && now - at > HELPER_STALE_MS
}

/** The id of a team's helper group (on the map it stands where a mind's id would). */
export const helperGroupId = (teamId: string): string => `helpers:${teamId}`
export const isHelperGroupId = (id: string): boolean => id.startsWith('helpers:')

export interface HelperGroup {
  /** helperGroupId(teamId) */
  id: string
  teamId: string
  /** the folded helpers, oldest first */
  memberIds: string[]
  /** open: its members are drawn individually (in `shown`); the group orb stays, to close it again */
  expanded: boolean
}

/** "Helper <n>" for every helper id, n its order of birth (created_at, then id) among its team's helpers. */
export function helperLabels(minds: readonly Agent[]): Map<string, string> {
  const byTeam = new Map<string, Agent[]>()
  for (const a of minds) {
    if (!isHelper(a)) continue
    const k = a.swarm_id ?? ''
    if (!byTeam.has(k)) byTeam.set(k, [])
    byTeam.get(k)!.push(a)
  }
  const out = new Map<string, string>()
  for (const list of byTeam.values()) {
    list.sort((x, y) => (x.created_at ?? '').localeCompare(y.created_at ?? '') || x.id.localeCompare(y.id))
    list.forEach((a, i) => out.set(a.id, `Helper ${i + 1}`))
  }
  return out
}

/** A mind's label on the map: its given name, or "Helper <n>" for a helper (never the template id). */
export function mindLabel(a: Agent, labels: ReadonlyMap<string, string>): string {
  return labels.get(a.id) ?? a.name
}

/** The group orb's words: what it shows on the map, and what it says to a screen reader. */
export function helperGroupWords(g: Pick<HelperGroup, 'memberIds' | 'expanded'>, teamName: string): { label: string; aria: string } {
  const n = g.memberIds.length
  const helpers = n === 1 ? 'helper' : 'helpers'
  return g.expanded
    ? { label: `Hide ${n} ${helpers}`, aria: `${n} finished ${helpers} of ${teamName}, hide them` }
    : { label: `+${n} ${helpers}`, aria: `${n} finished ${helpers} of ${teamName}, show them` }
}

/**
 * Which minds a map draws. `shown`: every mind to draw individually (helpers relabelled "Helper <n>"), in input order;
 * `groups`: one per team with at least one finished helper. A team's group is open when its id is in `expanded`, or
 * when it holds `reveal` (the mind the page has open), so a selected helper is never hidden. Minds without a team are
 * never grouped. Pure: the same minds, time and choices give the same answer.
 */
export function groupHelpers(
  minds: readonly Agent[],
  now: number,
  opts: { expanded?: ReadonlySet<string>; reveal?: string | null } = {},
): { shown: Agent[]; groups: HelperGroup[] } {
  const labels = helperLabels(minds)
  const folded = new Map<string, Agent[]>()
  for (const a of minds) {
    if (!a.swarm_id || !labels.has(a.id) || !helperFinished(a, now)) continue
    if (!folded.has(a.swarm_id)) folded.set(a.swarm_id, [])
    folded.get(a.swarm_id)!.push(a)
  }
  const groups: HelperGroup[] = []
  const hidden = new Set<string>()
  for (const [teamId, list] of folded) {
    list.sort((x, y) => (x.created_at ?? '').localeCompare(y.created_at ?? '') || x.id.localeCompare(y.id))
    const id = helperGroupId(teamId)
    const expanded = !!opts.expanded?.has(id) || (!!opts.reveal && list.some((a) => a.id === opts.reveal))
    groups.push({ id, teamId, memberIds: list.map((a) => a.id), expanded })
    if (!expanded) for (const a of list) hidden.add(a.id)
  }
  groups.sort((x, y) => x.teamId.localeCompare(y.teamId))
  const shown: Agent[] = []
  for (const a of minds) {
    if (hidden.has(a.id)) continue
    const label = labels.get(a.id)
    shown.push(label ? { ...a, name: label } : a)
  }
  return { shown, groups }
}
