import type { Agent, Swarm } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import type { ScreenFacts } from '../../screens/screenSpace'
import type { RecentChat } from './recent'

/** One row of Recent conversations: a mind, its orb, and the line under its name. */
export interface ConversationRow { id: string; name: string; hue: number; status: string; detail: string; go: string }

/**
 * The facts and data the conversations screen composes from (conversations.metta): one row per recent chat, newest
 * first as `recentChats` gave them. Facts are a count only; the words stay in the data. Pure.
 */
export function conversationsScreen(rows: RecentChat[], agents: Record<string, Agent>, swarms: Record<string, Swarm>): { data: Record<string, unknown>; facts: ScreenFacts } {
  const items: ConversationRow[] = rows.flatMap((r) => {
    const a = agents[r.id]
    if (!a) return []
    const swarm = a.swarm_id ? swarms[a.swarm_id] : undefined
    return [{ id: r.id, name: shown(a.name), hue: a.hue, status: a.status,
      detail: `${swarm ? shown(swarm.name) : 'No swarm'} · ${a.status} · you wrote ${ago(r.at)}`, go: 'Open chat ›' }]
  })
  return { data: { 'conversations.rows': items }, facts: { counts: { conversations: items.length } } }
}
