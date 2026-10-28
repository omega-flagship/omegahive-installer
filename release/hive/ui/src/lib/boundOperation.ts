import { useCallback, useEffect, useRef } from 'react'
import { IDENTITY_CHANGED_WORDS, isIdentityChanged } from '../api/client'
import { askConfirmBound, bindEpoch, type EpochBinding } from './identityEpoch'

/**
 * professional-release r1.2 (stand-in r1.1 P1, the class): one helper for every chain of hive writes a person starts.
 *
 * A chain (swarm → minds → starts → task; lease → message; one policy rule per skill) belongs to the sign-in it began
 * under and to the page or dialog that started it. The live client refuses an answer that arrives after a sign-in change
 * (api/live `identity_changed`), but that check cannot close the gap between a promise settling and its caller
 * resuming: the caller may resume under a new sign-in and send its next write there. So the check is made where it
 * matters, IMMEDIATELY before each write, in the same synchronous run that sends it:
 *
 *   const op = bindOperation(alive)            // before the first await (a confirm included)
 *   if (!(await op.confirm('Issue this lease?', 'Issue'))) return
 *   const out = await op.write(() => client.issueLease(...))
 *   await op.write(() => sendMessage(...))     // checked again right here
 *
 * `write` throws OperationStopped (and never sends) once the sign-in changed or the caller went away; an answer that
 * arrives after that throws it too, so nothing after it acts. `stopped(e)` recognises it, and the client's own
 * `identity_changed`. src/mutationChains.test.ts holds every chain in src to this helper (or an allowance with a reason).
 */
export class OperationStopped extends Error {
  readonly code = 'operation_stopped'
  constructor() {
    super(IDENTITY_CHANGED_WORDS)
    this.name = 'OperationStopped'
  }
}
export const OPERATION_STOPPED_WORDS = IDENTITY_CHANGED_WORDS
/** A stop, from this helper or from the client: the sign-in changed (or the caller went away). Say it, retry nothing. */
export const stopped = (e: unknown): boolean => e instanceof OperationStopped || isIdentityChanged(e)

export interface BoundOperation {
  /** the binding to the sign-in the operation began under */
  readonly binding: EpochBinding
  /** still the same sign-in, and the caller still alive (read now) */
  current(): boolean
  /** one hive write: sent only if current() holds right now; its answer taken only if it still holds */
  write<T>(send: () => Promise<T>): Promise<T>
  /** a person's confirm bound to the same sign-in: a change answers it "no" (identityEpoch askConfirmBound) */
  confirm(message: string, confirmLabel?: string, opts?: { danger?: boolean }): Promise<boolean>
}

export function bindOperation(alive: () => boolean = () => true): BoundOperation {
  const binding = bindEpoch()
  const current = () => binding.current() && alive()
  return {
    binding,
    current,
    async write<T>(send: () => Promise<T>): Promise<T> {
      if (!current()) throw new OperationStopped()
      const answer = await send()
      if (!current()) throw new OperationStopped()
      return answer
    },
    async confirm(message, confirmLabel, opts = {}) {
      if (!current()) return false
      const ok = await askConfirmBound(message, confirmLabel, { ...opts, binding })
      return ok && current()
    },
  }
}

/** A component's lifetime as `alive()`: true while mounted, false from its unmount on. Pass it to bindOperation. */
export function useAlive(): () => boolean {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return useCallback(() => mounted.current, [])
}
