/**
 * j0-fixes r1 item 6 (J0 live): Messages listed every Ask thread as "Ask thread" (ten rooms, all alike). An Ask-thread
 * session's row now says which mind, the first words asked, and when, from data the page already has for that room or
 * session; anything it does not have is left out, never invented. An ended session says "ended".
 */
import type { Room, WorkSession } from '../../api/types'
import { shown } from '../../lib/displayName'

/** The host's own title for an Ask thread's session and room (core/ask.py). */
export const ASK_THREAD = 'Ask thread'

/**
 * What an Ask session is, in ONE place (j0-fixes r1.5, Kimi r1.4): the host's `purpose: 'ask'` when it says; an older
 * host without purpose: the Ask's fixed title on the session or its room. Messages and "Your open threads" both use it.
 */
export function isAskSession(session: Pick<WorkSession, 'purpose' | 'title'> | null | undefined, roomName?: string | null): boolean {
  if (session?.purpose != null) return session.purpose === 'ask'
  return session?.title === ASK_THREAD || roomName === ASK_THREAD
}

/** An Ask thread's session room (a session room whose session is an Ask session). */
export function isAskThread(room: Pick<Room, 'kind' | 'name'>, session?: Pick<WorkSession, 'purpose' | 'title'> | null): boolean {
  return room.kind === 'session' && isAskSession(session, room.name)
}

/** The first words of a request, cut on a word and marked when cut. */
export function firstWords(text: string, max = 28): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

/** "14:27" today, "Oct 12" before; null when the time is missing or unreadable. */
export function when(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return now.toDateString() === d.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The mind a session room is with: the session's mind, else the host's room topic ("Session with <mind>"). */
function mindOf(room: Pick<Room, 'topic'>, session?: Pick<WorkSession, 'mind'> | null): string | null {
  const n = session?.mind?.name?.trim()
  if (n) return shown(n)
  const m = /^Session with (.+)$/.exec(room.topic ?? '')
  return m ? shown(m[1].trim()) : null
}

/**
 * An Ask-thread session's list title: "Product Design · Make a poster for the… · 14:27". `asked`: the first request's
 * words when the page has them (the Ask thread it holds); the time is when it was last updated, else when it started.
 * Null for any other room (its own title stands). `ended`: the session has ended.
 */
export function askThreadTitle(room: Pick<Room, 'kind' | 'name' | 'topic' | 'updated_at' | 'created_at'>, session?: Pick<WorkSession, 'purpose' | 'title' | 'mind' | 'status' | 'created_at' | 'goal'> | null, asked?: string | null, now = new Date()): { title: string; ended: boolean } | null {
  if (!isAskThread(room, session)) return null
  // a session's own task, when the host made one, is the request it was opened for
  const goal = session?.goal?.title?.trim()
  const words = asked?.trim() || (goal && goal !== ASK_THREAD ? goal : '')
  const parts = [mindOf(room, session) ?? ASK_THREAD, words ? firstWords(words) : null, when(room.updated_at || session?.created_at || room.created_at, now)].filter((x): x is string => !!x)
  return { title: parts.join(' · '), ended: session?.status === 'ended' }
}
