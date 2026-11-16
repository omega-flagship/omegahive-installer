import { ApiError, type Person } from '../../api/client'
import { askConfirmBound, bindEpoch, STALE, type EpochBinding } from '../../lib/identityEpoch'
import { isUnsupported } from '../../lib/useResource'

/**
 * "Clear Google identity" (admins): unlinks a person's Google sign-in and signs them out everywhere, so their next
 * Google sign-in links an account afresh. Asked first under the identity it was asked by (askConfirmBound): a sign-in
 * change while the question is open answers it "no". Every outcome in plain words; never the host's raw text.
 */

/** The person's sign-in in plain words: "Signs in with Google" when a Google identity is linked; nothing otherwise. */
export const signInWords = (google: boolean | undefined) => (google === true ? 'Signs in with Google' : null)

export type ClearToast = { tone: 'success' | 'error' | 'info'; title: string; body?: string }

const who = (p: Pick<Person, 'name' | 'email'>) => p.name || p.email

export const clearGoogleQuestion = (p: Pick<Person, 'name' | 'email'>) =>
  `Clear ${who(p)}'s Google sign-in? They'll be signed out and must sign in with Google again to link an account.`

/** The failure in plain words. */
export function clearGoogleFailure(p: Pick<Person, 'name' | 'email'>, e: unknown): ClearToast {
  if (isUnsupported(e)) return { tone: 'info', title: 'Not available here', body: 'This hive cannot clear Google sign-ins yet.' }
  const title = `Could not clear ${who(p)}'s Google sign-in`
  if (e instanceof ApiError) {
    if (e.status === 0) return { tone: 'error', title, body: 'Could not reach the hive. Check the connection and try again.' }
    if (e.status === 401) return { tone: 'error', title, body: 'Your sign-in ended. Sign in again, then try once more.' }
    if (e.status === 403) return { tone: 'error', title, body: 'Only admins can do this.' }
    if (e.status === 404) return { tone: 'error', title, body: 'That person is no longer in this hive.' }
  }
  return { tone: 'error', title, body: 'Nothing changed. Please try again.' }
}

/**
 * Runs the action: nothing at all unless `admin`; asks first; on "yes" calls `clear` once, then `show`s the outcome
 * and, on success, `reload`s. Bound to the identity it started under (stand-in r1 P1): the binding is captured before
 * the question and passed to it; the PATCH is dispatched only through `binding.commit` (checked in the same tick), and
 * the outcome and reload after the PATCH's await go through `binding.commit` too. A sign-in change at any point
 * means nothing more is sent or shown. Returns what was shown (null: nothing was).
 */
export async function clearGoogleSignIn(
  p: Pick<Person, 'id' | 'name' | 'email'>,
  deps: {
    admin: boolean
    clear: ((id: string) => Promise<unknown>) | undefined
    show: (t: ClearToast) => void
    reload?: () => void
    ask?: (message: string, confirmLabel?: string, opts?: { danger?: boolean; binding?: EpochBinding }) => Promise<boolean>
    binding?: EpochBinding
  },
): Promise<ClearToast | null> {
  const clear = deps.clear
  if (!deps.admin || !clear) return null
  const binding = deps.binding ?? bindEpoch()
  const ask = deps.ask ?? askConfirmBound
  if (!(await ask(clearGoogleQuestion(p), 'Clear Google sign-in', { danger: true, binding }))) return null
  // dispatched only if the identity that was asked is still the current one, checked in this same tick
  const sent = binding.commit(() => clear(p.id))
  if (sent === STALE) return null
  let outcome: ClearToast
  let ok = false
  try {
    await sent
    ok = true
    outcome = { tone: 'success', title: `${who(p)}'s Google sign-in is cleared`, body: "They've been signed out and will link an account the next time they sign in with Google." }
  } catch (e) {
    outcome = clearGoogleFailure(p, e)
  }
  const shown = binding.commit(() => {
    deps.show(outcome)
    if (ok) deps.reload?.()
    return outcome
  })
  return shown === STALE ? null : shown
}
