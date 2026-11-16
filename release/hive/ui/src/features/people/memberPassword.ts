import type { MemberPassword, Person } from '../../api/client'
import { askConfirmBound, bindEpoch, STALE, type EpochBinding } from '../../lib/identityEpoch'

/**
 * Member passwords (T-101, admins): add a member who signs in with a password the hive makes, reset it, or remove it.
 * The password is in exactly one answer (the add or the reset) and is shown once, under the identity that asked for
 * it: a sign-in change while the request is open means nothing is shown (the binding, as clearGoogle.ts does).
 */

/** The one place the password is ever shown. */
export interface ShownPassword {
  email: string
  name: string
  password: string
  /** what the hive did to get it */
  reason: 'added' | 'reset'
  /** the member's password sign-ins the reset ended */
  endedSessions?: number
}

export const NOT_AGAIN = 'It will not be shown again. Copy it now and give it to them privately; the hive keeps only a hash of it.'

/** The member's sign-in in plain words, next to signInWords(google). */
export const passwordWords = (p: Pick<Person, 'password_set'>) => (p.password_set === true ? 'Signs in with a hive password' : null)

const who = (p: Pick<Person, 'name' | 'email'>) => p.name || p.email

export const resetQuestion = (p: Pick<Person, 'name' | 'email' | 'password_set'>) =>
  p.password_set
    ? `Make a new password for ${who(p)}? Their old one stops working and their password sign-ins end now.`
    : `Make a password for ${who(p)}? They can then sign in with their email and it.`

export const removeQuestion = (p: Pick<Person, 'name' | 'email'>) =>
  `Remove ${who(p)}'s password? Their password sign-ins end now; Google sign-in, once set up, still works.`

export const shownFrom = (r: MemberPassword, reason: ShownPassword['reason']): ShownPassword => ({
  email: r.person.email,
  name: r.person.name,
  password: r.password,
  reason,
  endedSessions: r.ended_sessions,
})

type Ask = (message: string, confirmLabel?: string, opts?: { danger?: boolean; binding?: EpochBinding }) => Promise<boolean>

/**
 * Runs one password act: asks first when `question` is given; dispatches `call` and handles its outcome only while
 * the identity that asked is still the current one. `onDone` gets the answer (to show a password or a toast),
 * `onFail` the error. Returns false when nothing was sent or the outcome was dropped as stale.
 */
export async function passwordAct<T>(
  call: () => Promise<T>,
  deps: { onDone: (r: T) => void; onFail: (e: unknown) => void; question?: { text: string; label: string }; ask?: Ask; binding?: EpochBinding },
): Promise<boolean> {
  const binding = deps.binding ?? bindEpoch()
  if (deps.question && !(await (deps.ask ?? askConfirmBound)(deps.question.text, deps.question.label, { danger: true, binding }))) return false
  const sent = binding.commit(call)
  if (sent === STALE) return false
  let done: () => void
  try {
    const r = await sent
    done = () => deps.onDone(r)
  } catch (e) {
    done = () => deps.onFail(e)
  }
  return binding.commit(() => (done(), true)) !== STALE
}
