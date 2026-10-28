import type { ConnectionState } from '../api/client'

/**
 * Where the sign-in page stands with the hive, for the brand's status line: `checking` while it asks the hive how to
 * sign in, `reachable` once the hive answered (or cannot be asked), `unreachable` when asking failed or the device is
 * offline.
 */
export type SigninReach = 'checking' | 'reachable' | 'unreachable'

/**
 * The brand's status words. On the sign-in page a person who is signed out is not offline (demo audit P1 #4): the
 * line says "Signed out" once the hive has answered, nothing while it is asked, and "Offline" only when it could not
 * be reached. Elsewhere, a client that is not connected is offline.
 */
export function brandStatus(mode: string | undefined, connection: ConnectionState, signin?: SigninReach): string | null {
  if (mode === 'sim') return 'Simulation'
  if (connection === 'open') return 'Live'
  if (connection === 'reconnecting') return 'Reconnecting'
  if (connection === 'connecting') return 'Connecting'
  if (connection === 'unauthorized') return 'Signed out'
  if (signin === 'checking') return null
  if (signin === 'reachable') return 'Signed out'
  return 'Offline'
}
