import { hasHostFlags, type HostFlags, type IdleMind } from '../../api/idleMinds'

/**
 * The flags and status a card acts on (Health idle r1.4).
 * - Flags: whichever source was read LATER. The idle row was read at `rowAt` (IdleOverview.read_at); the store's agent
 *   view carries flags only from a fresh GET /api/agents/{id}, read at `agentAt` (store flagsAt). An agent.updated never
 *   carries flags and never moves `agentAt`, so a flag kept across an event loses to the next idle poll. No time, no win.
 * - Status: the store's agent view when there is one (events keep it current), else the row's.
 * Fail closed either way: a flag counts only as exactly true.
 */
export function cardView(
  row: IdleMind,
  rowAt: number,
  agent: (HostFlags & { status?: string }) | null | undefined,
  agentAt: number | undefined,
): IdleMind {
  const status = agent?.status ?? row.mind_status
  const agentNewer = !!agent && hasHostFlags(agent) && agentAt !== undefined && agentAt > rowAt
  if (!agentNewer) return { ...row, mind_status: status }
  return { ...row, may_remind: agent.may_remind === true, may_sleep: agent.may_sleep === true, is_mine: agent.is_mine === true, mind_status: status }
}

/**
 * Health's Sleep: ask first (bound to the identity it was opened under: an identity change answers "no"), then hand
 * it to the store's checked sleep with that SAME identity (`who`), which drops it if the person changed, and re-reads
 * the host's flags and status after the confirmation.
 */
export async function sleepFlow(
  who: string,
  confirm: () => Promise<boolean>,
  send: (who: string) => Promise<{ ok: boolean; text: string } | null>,
): Promise<{ ok: boolean; text: string } | null> {
  if (!(await confirm())) return null
  return send(who)
}
