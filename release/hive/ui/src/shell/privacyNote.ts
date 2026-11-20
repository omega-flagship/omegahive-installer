import type { HiveClient } from '../api/client'
import { useHive } from '../store/store'

/**
 * Per-person privacy is intended but not yet in place (Kabir parked #595 and asked for a note on staging meanwhile):
 * other members and admins may see a person's tasks and app data. Said only when the hive has someone else in it
 * (othersInHive: a tester's own hive, one person who is its admin, is told nothing), once per store session, as an info notice that
 * stays a minute and can be dismissed, so nobody has to hunt for it and it never blocks work. A store session is one
 * page load's sign-in: a new sign-in (login, SSO, another tab's sign-in or sign-out, a different principal) starts a
 * new one, and so does a reload, since `said` is in memory. So the note shows once per page load and again after a
 * sign-in change, never on a re-render or a page change. The live client has no silent token refresh (a credential
 * changes only through login, SSO, sign-out or another tab), so it never comes back mid-work.
 */
export const PRIVACY_NOTE_TITLE = 'Per-person privacy is not in place yet'
export const PRIVACY_NOTE_BODY = 'It is intended, but for now other members and admins may see your tasks and app data.'
export const PRIVACY_NOTE_TTL = 60_000

/** The sessions (store `session`, one per client and sign-in) already told; a re-render or a page change says nothing new. */
const said = new Set<string>()

/**
 * Whether anyone besides the signed-in person can sign in to this hive, so the note has someone to warn about: a
 * tester's own hive holds one person, who is also its admin, and is told nothing. A member always has an admin beside
 * them. An admin (or the operator's password session) lists the people (admins only) and counts the enabled ones other
 * than themself; a disabled person signs in to nothing, and an open invitation is nobody yet (its sign-in starts a new
 * session for the admin's next page load). If the hive cannot say, the note is said: a warning too many beats one missing.
 */
export async function othersInHive(client: Pick<HiveClient, 'me' | 'listPeople'>): Promise<boolean> {
  try {
    const me = await client.me!()
    if (me.kind !== 'password' && me.role !== 'admin') return true
    const { people } = await client.listPeople!()
    return people.some((p) => !p.disabled && p.id !== me.person?.id)
  } catch {
    return true
  }
}

/**
 * Say the note for this session if it hasn't been said: only on a live hive (a simulator's data is invented and nobody
 * else sees it) once the person is signed in and the hive is ready, since binding a client empties the notices, and
 * only when the hive has someone else in it (othersInHive). The session is marked before the hive is asked, so a
 * re-render meanwhile asks nothing twice; an answer that comes back after the sign-in changed says nothing (the new
 * session asks for itself). Resolves to whether it spoke.
 */
export async function announcePrivacyNote(signedIn: boolean): Promise<boolean> {
  const s = useHive.getState()
  if (!signedIn || !s.ready || s.client?.mode !== 'live' || said.has(s.session)) return false
  const client = s.client
  const session = s.session
  said.add(session)
  if (!(await othersInHive(client))) return false
  const now = useHive.getState()
  if (now.session !== session || now.client !== client) return false
  now.toast({ tone: 'info', icon: 'info', title: PRIVACY_NOTE_TITLE, body: PRIVACY_NOTE_BODY, ttl: PRIVACY_NOTE_TTL, group: 'privacy-note' })
  return true
}

/** For tests: forget which sessions were told. */
export const resetPrivacyNote = (): void => said.clear()
