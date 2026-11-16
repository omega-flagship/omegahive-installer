import type { Activity } from '../store/reducer'
import type { Route } from './router'

/**
 * Where an activity line leads: a line about a message opens that message where its conversation lives, read from the
 * conversation id's own grammar. A room's id (r_…) or alias (coffee, team_<swarm>) and an Ask turn (ask:<turn>, its
 * thread, for the person who asked) open in Messages, which finds the message by its id or by the id its room copy was
 * made from (rooms.py source_message_id). A person's chat with a mind (c_<mind>, c_<mind>~<person>:
 * hive.person_conversation) opens that mind's chat, and so does any other conversation, in the chat of the mind whose
 * messages hold it. Any other line leads nowhere.
 */
export function activityRoute(a: Pick<Activity, 'kind' | 'conversation_id' | 'message_id' | 'chat_id'>): Route | null {
  if (a.kind !== 'message' || !a.conversation_id || !a.message_id) return null
  const c = a.conversation_id
  if (c === 'coffee' || c.startsWith('ask:') || /^(r|team)_/.test(c)) return { name: 'messages', room: c, message: a.message_id }
  const mind = /^c_(a_[^~]+)(?:~|$)/.exec(c)?.[1] ?? a.chat_id
  return mind ? { name: 'dot', id: mind, tab: 'chat', message: a.message_id } : null
}
