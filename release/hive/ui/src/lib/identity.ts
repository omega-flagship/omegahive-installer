import type { Me } from '../api/client'
import { errorMessage, type ResourceState } from './useResource'

/**
 * Who is signed in, without guessing: a password session is the hive's operator (an admin); a Google session
 * or a member's hive-made password (T-101) shows the role the hive reports; if the hive cannot say, the role is "unknown", never assumed.
 */
export function identityLine(me: ResourceState<Me>): string {
  if (me.status === 'loading') return 'Checking who you are…'
  const m = me.data
  if (!m) return me.status === 'unsupported' ? 'Role unknown (this hive does not say who is signed in)' : `Role unknown (could not check: ${errorMessage(me.error)})`
  // how they signed in: the host's `signin` when it says (J1b: the installer's local sign-in is an sso-kind session but
  // not Google); an older host without it falls back to a neutral word, never a guessed Google
  const how = m.signin === 'local_install' ? 'Signed in on this computer'
    : m.signin === 'google' ? 'Signed in with Google'
    : m.signin === 'password' ? 'Signed in on the hive’s own machine'
    // r1.1 (stand-in P2): an older host that doesn't say how never gets "Google" guessed (a local install is sso-kind)
    : m.kind === 'member_password' ? 'Signed in with a hive password'
    : m.kind === 'sso' ? 'Signed in' : 'Signed in on the hive’s own machine'
  const role = m.kind === 'password' ? 'Operator (admin)' : m.role === 'admin' ? 'Admin' : m.role === 'member' ? 'Member' : 'role unknown'
  return `${m.person?.email ? `${m.person.email} · ` : ''}${how} · ${role}`
}
