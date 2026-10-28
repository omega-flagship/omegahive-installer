/**
 * Sign-in problems in plain words. After a failed Google sign-in the hive sends the browser back to the sign-in page
 * with `signin_error=<code>` in the address (query or hash; Platform's sign-in hardening). The page shows fixed words
 * for the code and never the code itself, nor anything else from the address (tokens, emails). The parameter is
 * cleared from the address bar once read, so a reload does not show a stale problem.
 */

export const SIGNIN_PARAM = 'signin_error'

/** The code that asks for the Google button: this account signs in with Google, not the hive password. */
export const GOOGLE_REQUIRED = 'google_signin_required'

const WORDS: Record<string, string> = {
  // Platform's sign-in hardening (2026-10-07)
  identity_mismatch: "This Google account isn't the one linked to that email. Ask an admin to check your account.",
  domain_unverified: 'Please sign in with your SingularityNET Workspace account.',
  state_mismatch: 'That sign-in started in another browser or took too long. Please try again.',
  bad_id_token: "Google's answer couldn't be verified. Please try again.",
  [GOOGLE_REQUIRED]: 'This account signs in with Google.',
  google_unavailable: 'Google sign-in is unavailable right now. Try again shortly.',
  signin_failed: 'Sign-in did not complete. Try again.',
  // invitations and the Google round trip (earlier codes, unchanged)
  not_invited: 'That Google account has not been invited to this hive. Ask the person who runs it for an invitation.',
  wrong_account: 'That invitation was sent to a different Google account. Sign in with the address it was sent to.',
  invite_unavailable: 'That invitation has expired, been used, or been withdrawn. Ask for a new one.',
  email_unverified: 'Google has not verified that account’s email address.',
  bad_state: 'That sign-in link expired. Start again.',
  google_refused: 'Google did not complete the sign-in. Try again.',
  google_cancelled: 'Sign-in was cancelled.',
}

export const UNKNOWN_SIGNIN_WORDS = "Sign-in didn't complete. Please try again."

/** The words for a code: its own when known, the neutral words otherwise; null when there is no code. */
export function signinErrorWords(code: string | null | undefined): string | null {
  if (!code) return null
  return Object.prototype.hasOwnProperty.call(WORDS, code) ? WORDS[code] : UNKNOWN_SIGNIN_WORDS
}

type Where = { search: string; hash: string }

/** The hash's own query: `#signin_error=x`, or the router's `#/path?signin_error=x`. */
function hashQuery(hash: string): { head: string; query: string } {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  if (q >= 0) return { head: raw.slice(0, q), query: raw.slice(q + 1) }
  return raw.includes('=') ? { head: '', query: raw } : { head: raw, query: '' }
}

/** The signin_error code in the address (the query first, then the hash), or null. */
export function readSigninError(where: Where): string | null {
  return new URLSearchParams(where.search).get(SIGNIN_PARAM) || new URLSearchParams(hashQuery(where.hash).query).get(SIGNIN_PARAM) || null
}

/** The same address without signin_error (everything else kept), or null when it carries none. */
export function withoutSigninError(where: Where & { pathname: string }): string | null {
  const search = new URLSearchParams(where.search)
  const h = hashQuery(where.hash)
  const hq = new URLSearchParams(h.query)
  if (!search.has(SIGNIN_PARAM) && !hq.has(SIGNIN_PARAM)) return null
  search.delete(SIGNIN_PARAM)
  hq.delete(SIGNIN_PARAM)
  const s = search.toString()
  const hs = hq.toString()
  const hash = h.head || hs ? `#${h.head}${hs ? `${h.head ? '?' : ''}${hs}` : ''}` : ''
  return `${where.pathname}${s ? `?${s}` : ''}${hash}`
}

/** Removes signin_error from the address bar without a reload or a new history entry. */
export function clearSigninError(win: Pick<Window, 'location' | 'history'> = window): void {
  const next = withoutSigninError(win.location)
  if (next !== null) win.history.replaceState(win.history.state, '', next)
}
