/** Purpose: pick which of the person's open Ask sessions the Ask's "Earlier" lists, and say what ending one does.
 * j0-fixes r1 item 4 (pure; OpenThreads.tsx draws them, each with its spend and End). */
import type { WorkSession } from '../../api/types'
import { isAskSession } from '../messages/sessionTitle'

export { isAskSession }

export const END_SAYS = 'Ends the thread; its words stay.'

/** The person's own open sessions, on `mind` when given, newest first; never the thread on the page (New thread ends it). */
export function openThreadsOf(sessions: readonly WorkSession[], me: string | null | undefined, o: { mind?: string | null; current?: string | null } = {}): WorkSession[] {
  if (!me) return []
  return sessions
    .filter((s) => s.status === 'active' && s.owner === me && isAskSession(s) && (!o.mind || s.mind?.id === o.mind) && s.id !== o.current)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}
