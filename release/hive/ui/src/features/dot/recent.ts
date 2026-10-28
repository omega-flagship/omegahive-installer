import type { Agent, Message } from '../../api/types'
import { onIdentityChange } from '../../lib/identityEpoch'
import { useHive } from '../../store/store'

/**
 * Recent conversations (mind-chat r1): the minds this person has chatted with lately, newest first, each opening
 * straight into its Chat tab (`#/dot/<id>`). Built in the client from what the UI already holds; the host has no
 * "my conversations" route, and none is invented here:
 * - this person's own sends from this client (store `chattedAt`, set by sendMessage);
 * - messages already read (a chat opened, live events) whose sender is exactly this person's principal (`/api/me`).
 *   A message sent as some other person, or as the shared `user:operator` name a signed-in person is not, never
 *   counts: a mind someone else talks to is not this person's conversation.
 * Only minds this person can see now and can talk to (Omega and iter minds) are listed. Per person: an identity change
 * empties it (lib/identityEpoch), and nothing is kept in browser storage.
 */
export interface RecentChat {
  id: string
  /** ISO time of this person's latest message to it */
  at: string
}

export const RECENT_MAX = 12

const chatty = (a: Agent | undefined): a is Agent => !!a && (a.kind === 'omega' || a.kind === 'iter')

export function recentChats(
  s: { chattedAt: Record<string, string>; messages: Record<string, Message[]>; agents: Record<string, Agent> },
  principal: string | null | undefined,
  max = RECENT_MAX,
): RecentChat[] {
  const at = new Map<string, string>()
  const note = (id: string, t: string) => {
    const was = at.get(id)
    if (!was || Date.parse(t) > Date.parse(was)) at.set(id, t)
  }
  for (const [id, t] of Object.entries(s.chattedAt)) note(id, t)
  if (principal) {
    for (const [id, list] of Object.entries(s.messages)) {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (m.direction === 'in' && m.sender === principal) {
          note(id, m.created_at)
          break
        }
      }
    }
  }
  return [...at.entries()]
    .filter(([id]) => chatty(s.agents[id]))
    .map(([id, t]) => ({ id, at: t }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
    .slice(0, max)
}

// per person: a sign-in change on the same client takes the earlier person's list with it
onIdentityChange(() => useHive.setState({ chattedAt: {} }))
