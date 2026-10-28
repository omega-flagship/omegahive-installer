import { useHive } from '../store/store'
import { askConfirm } from '../ui/confirm'
import { readContext } from './readContext'

/**
 * Surface identity epoch: one helper so a person's state never outlives an identity change, by construction.
 *
 * "Who and where" is one key, built from the pieces that already define it (nothing new is invented here):
 * - the client instance and its current sign-in (lib/readContext: clientIdentity + authIdentity, Platform person-session),
 * - the hive store's session and init count (store/store: `session`, `inits`; Surface R O-B1, Kimi K3).
 * Whenever that key changes the epoch bumps, synchronously, and every registered clear hook runs before the change is
 * seen by anyone subscribed later (React re-renders included: they are scheduled by store listeners, never run inside
 * them). A sign-in replaced on the same client is caught even before its observer has run: every read of the epoch
 * re-reads the key from the client itself (as store/ask's askOrigin does).
 *
 * Not in the key: the store's `connection`. A reconnect, an 'idle' or a dropped socket is not a change of person. A
 * terminal session expiry on the events socket (close 4401/1008) is: api/live invalidates the credential for it exactly
 * as for a current-bearer HTTP 401 (new sign-in handle + onAuthChange), so it bumps the epoch through the key above.
 *
 * Writing after an await (stand-in r1 P2): a check made in one microtask says nothing about the next one; an identity
 * change can land between `guard`'s check and the consumer resuming after `await guard(...)`. So EVERY per-person
 * state write that follows an await goes through `binding.commit(write)` (the epoch is checked in the same synchronous
 * tick as the write, and the write is skipped if it moved), or is immediately preceded, in the same synchronous run,
 * by a `binding.current()` check. `guard` only lets a continuation stop early; it never makes a later write safe.
 *
 * Relation to store/ask: Ask's own `epoch` / `askOrigin()` is finer, a THREAD epoch (it also bumps on New thread and
 * Delete thread, and its origin includes the bound principal). Every identity change here also resets Ask (store/ask
 * subscribes to the same session/inits/onAuthChange), never the other way round. Per-person state outside the Ask
 * thread (consoles, previews, transcripts, memories, caches) binds to THIS epoch; acts inside the thread keep askOrigin.
 */

/** The identity everything per-person belongs to, as one comparable string (readContext of client, session, inits). */
export function identityKey(): string {
  const { client, session, inits } = useHive.getState()
  return readContext(client, session, inits)
}

let epoch = 0
let key = identityKey()
const hooks = new Set<() => void>()

/** Re-read the key; on a change bump the epoch first, then run every clear hook (each once, all of them, in order). */
function sync(): void {
  const now = identityKey()
  if (now === key) return
  key = now
  epoch++
  const errors: unknown[] = []
  for (const fn of [...hooks]) {
    try {
      fn()
    } catch (e) {
      errors.push(e)
    }
  }
  // a broken hook never stops the others clearing, nor the store's own listeners; it is still reported
  for (const e of errors) queueMicrotask(() => { throw e })
}

// registered at module load, so before any component (or later module) subscribes to the hive store
useHive.subscribe(sync)

/** The current identity epoch (a number that changes exactly when identityKey() does). */
export function currentEpoch(): number {
  sync()
  return epoch
}

/**
 * Register a synchronous clear: it runs inside the identity change itself, before anything later sees the new
 * identity. Use it for every per-person store, console, preview, transcript and cache. Returns an unsubscribe.
 */
export function onIdentityChange(fn: () => void): () => void {
  hooks.add(fn)
  return () => {
    hooks.delete(fn)
  }
}

/** What a guarded promise resolves to, and a skipped commit returns, once the bound identity is no longer current. */
export const STALE: unique symbol = Symbol('identity-epoch:stale')
export type Stale = typeof STALE

/** An async continuation's binding: capture before the first await; every later write goes through `commit`. */
export interface EpochBinding {
  readonly epoch: number
  /** Whether the identity this binding was made under is still the current one (read now, synchronously). */
  current(): boolean
  /**
   * The guarded write: runs `write` (synchronously, now) only if the identity is still the one bound, checked in the
   * same tick as the write, and returns its result; otherwise does nothing and returns STALE. Use it for every
   * per-person state write that follows an await.
   */
  commit<R>(write: () => R): R | Stale
}
export function bindEpoch(): EpochBinding {
  const at = currentEpoch()
  const current = () => currentEpoch() === at
  return { epoch: at, current, commit: (write) => (current() ? write() : STALE) }
}

/**
 * The promise's answer while the identity it started under is still current; otherwise STALE. A failure after an
 * identity change is STALE too (it belongs to the earlier person); a failure for the current one rejects as before.
 * The check is made when the promise settles, one microtask before the awaiting code resumes, so a non-STALE answer
 * is NOT permission to write: write it with `binding.commit(...)` (pass the same binding here and there).
 *
 *   const binding = bindEpoch()
 *   const v = await guard(client.read(), binding)
 *   if (v !== STALE) binding.commit(() => set({ value: v }))
 */
export function guard<T>(promise: Promise<T>, binding: EpochBinding = bindEpoch()): Promise<T | Stale> {
  return promise.then(
    (v) => (binding.current() ? v : STALE),
    (e: unknown) => {
      if (!binding.current()) return STALE
      throw e
    },
  )
}

/**
 * ui/confirm's askConfirm, bound to the identity it was asked under: an identity change answers the open question
 * "no" at once (through confirm's `signal`, so only this question, never a newer one), and a "yes" that arrives
 * after a change is a "no". Asked when the identity has already changed under the binding: "no", nothing shown.
 */
export function askConfirmBound(message: string, confirmLabel?: string, opts: { danger?: boolean; binding?: EpochBinding } = {}): Promise<boolean> {
  const binding = opts.binding ?? bindEpoch()
  const ac = new AbortController()
  const off = onIdentityChange(() => ac.abort())
  if (!binding.current()) ac.abort()
  return askConfirm(message, confirmLabel, { danger: opts.danger, signal: ac.signal })
    .then((ok) => ok && binding.current())
    .finally(off)
}
