/**
 * Who did something, in words: a mind by its name, a person by their display name. A person's raw principal
 * ("user:p_ada") is shown only when the hive does not say their name to this viewer (Surface demo D2).
 */
import type { Me, Person } from '../api/client'
import type { Agent } from '../api/types'
import { useHive } from '../store/store'
import { shown } from './displayName'
import { useMe } from './useAdmin'
import { need, useResource } from './useResource'

export interface PeopleNames {
  /** the signed-in person (their own name is known even where the people list is not readable) */
  me?: Pick<Me, 'principal' | 'person'> | null
  /** the hive's people, as GET /api/people says (admins); null when not read */
  people?: Pick<Person, 'id' | 'name'>[] | null
}

export function principalLabel(p: string, agents: Record<string, Agent>, names: PeopleNames = {}): string {
  if (p.startsWith('agent:')) return shown(agents[p.slice(6)]?.name ?? p.slice(6))
  if (!p.startsWith('user:')) return p
  const own = names.me?.principal === p ? names.me.person?.name?.trim() : ''
  if (own) return shown(own)
  const id = p.slice(5)
  const named = names.people?.find((x) => x.id === id)?.name?.trim()
  return named ? shown(named) : id
}

/**
 * Who a person's message in a mind's chat is from (followups r4; mind chats carry the real sender principal since
 * Platform privacy r4, and an admin's audit reads other people's): "You" only when it is the viewer's own principal;
 * the hive-password operator is "the operator"; anyone else by their display name from the people list, else by their
 * principal without "user:".
 */
export function chatSender(p: string, names: PeopleNames = {}): string {
  if (names.me?.principal && p === names.me.principal) return 'You'
  if (p === 'user:operator') return 'the operator'
  return principalLabel(p, {}, { people: names.people })
}

/** A person's message in a mind's chat: its label (chatSender), and whether it is the viewer's own (drawn as theirs). */
export function chatPerson(p: string, names: PeopleNames = {}): { label: string; mine: boolean } {
  return { label: chatSender(p, names), mine: !!names.me?.principal && p === names.me.principal }
}

/**
 * The names this viewer may see: themselves (GET /api/auth/me) and, where the hive lists them, its people. Both reads
 * are bound to the identity they were made under (useResource), so an earlier sign-in's names are never shown.
 */
export function usePeopleNames(): PeopleNames {
  const client = useHive((s) => s.client)
  const { me } = useMe()
  const people = useResource(() => need(client, 'listPeople', 'People')().then((r) => r.people), { isEmpty: () => false })
  return { me: me ?? null, people: people.status === 'ready' ? (people.data ?? null) : null }
}
