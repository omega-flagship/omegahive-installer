/** Host Google connector, separate from People Google sign-in. No OAuth token is a UI value. */
import type { Agent } from './types'

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'
const ID = /^[A-Za-z0-9_.:-]{1,128}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface GoogleConnectorStatus {
  ready: boolean
  connected: boolean
  backend: 'B'
  allowed_minds: string[]
  calendar_scope: typeof GOOGLE_CALENDAR_SCOPE
}

/** Keep only the five safe fields. A malformed consent list never becomes an empty grant list. */
export function readGoogleConnectorStatus(v: unknown): GoogleConnectorStatus | null {
  if (!object(v) || typeof v.ready !== 'boolean' || typeof v.connected !== 'boolean' || v.backend !== 'B' ||
      v.calendar_scope !== GOOGLE_CALENDAR_SCOPE || !Array.isArray(v.allowed_minds) || v.allowed_minds.length > 1000 ||
      !v.allowed_minds.every((id): id is string => typeof id === 'string' && ID.test(id)) ||
      new Set(v.allowed_minds).size !== v.allowed_minds.length) return null
  return { ready: v.ready, connected: v.connected, backend: 'B', allowed_minds: [...v.allowed_minds], calendar_scope: GOOGLE_CALENDAR_SCOPE }
}

/** An admin/visibility flag is not ownership, and a module is not an independently consented mind. */
export function ownGoogleMinds(agents: readonly Agent[], principal: string): Agent[] {
  return agents.filter((a) => a.owner === principal && (a.kind === 'omega' || a.kind === 'iter') && ID.test(a.id))
}

export function googleMindConsent(id: string, allowed: boolean): { allowed: boolean } {
  if (!ID.test(id) || typeof allowed !== 'boolean') throw new TypeError('Choose one current mind and an explicit allow choice.')
  return { allowed }
}

/** Only the fixed Google authorization endpoint returned by authenticated /start may receive top-level navigation. */
export function readGoogleAuthorization(v: unknown): string | null {
  if (!object(v) || Object.keys(v).some((key) => key !== 'authorization_url' && key !== 'expires_at') || typeof v.authorization_url !== 'string' || v.authorization_url.length > 8192 || /[\u0000-\u0020\u007f]/.test(v.authorization_url)) return null
  try {
    const u = new URL(v.authorization_url)
    if (u.origin !== 'https://accounts.google.com' || u.pathname !== '/o/oauth2/v2/auth' || u.username || u.password || u.hash ||
        ['access_token', 'refresh_token', 'id_token', 'client_secret', 'code'].some((key) => u.searchParams.has(key))) return null
    return u.href
  } catch { return null }
}

export interface GoogleIdentityBinding {
  current(): boolean
  commit<T>(write: () => T): unknown
}

export function googleTopLevelWindow(view: { top: unknown; self: unknown; fence?: unknown }): boolean {
  return !!view.self && view.top === view.self && !view.fence
}

/** The profile can close without changing the signed-in person; that also retires its pending navigation. */
export function bindGoogleView(identity: GoogleIdentityBinding, mounted: () => boolean): GoogleIdentityBinding {
  return {
    current: () => mounted() && identity.current(),
    commit<T>(write: () => T) { return identity.commit(() => mounted() ? write() : undefined) },
  }
}

/** Bind before the first await; no start from a frame and no navigation for an earlier sign-in. */
export async function startGoogleAuthorization(start: () => Promise<unknown>, binding: GoogleIdentityBinding, topLevel: () => boolean, go: (url: string) => void): Promise<void> {
  if (!binding.current()) return
  if (!topLevel()) throw new Error('Open Google connection settings in the full hive window.')
  const url = readGoogleAuthorization(await start())
  if (!binding.current()) return
  if (!url) throw new Error('The hive did not return a safe Google sign-in address.')
  binding.commit(() => {
    if (!topLevel()) throw new Error('Open Google connection settings in the full hive window.')
    go(url)
  })
}

export type GoogleRevocation = 'confirmed' | 'unconfirmed' | 'not_needed'
export function readGoogleRevocation(v: unknown): GoogleRevocation | null {
  return object(v) && typeof v.revocation === 'string' && ['confirmed', 'unconfirmed', 'not_needed'].includes(v.revocation) ? v.revocation as GoogleRevocation : null
}
export function googleRevocationWords(value: GoogleRevocation | null): string {
  if (value === 'confirmed') return 'Disconnected. Google confirmed revocation.'
  if (value === 'not_needed') return 'Disconnected here. There was no saved grant to revoke.'
  return 'Disconnected here. Google revocation could not be confirmed.'
}

/** A callback hint is only a reason to reread status, never proof of a grant. */
export function isGoogleConnectorReturn(search: string): boolean {
  const q = new URLSearchParams(search)
  return q.get('google_connector') === 'connected' || ['connection_failed', 'cancelled'].includes(q.get('google_connector_error') ?? '')
}
