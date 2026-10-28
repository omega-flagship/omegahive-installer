import { useSyncExternalStore } from 'react'
import { decisionFailure, type DecisionResult } from './decisionGate'
import { bindEpoch, currentEpoch, onIdentityChange, STALE, type EpochBinding, type Stale } from './identityEpoch'
import type { Toast } from '../store/store'

/** The store's toast, as the batch's actions take it (so each action is testable with the real one). */
export type ToastFn = (t: Omit<Toast, 'id'>) => void

/**
 * Missing-UI batch 1 r5 (stand-in r4 P1): every completion that lands after an await belongs to the identity the
 * action or read started under (lib/identityEpoch). These two small adapters apply the live helper to the batch's
 * DecisionDialog actions and to its component-local reads.
 */

/**
 * A DecisionDialog action bound to the identity it was pressed under. `work` receives the binding, made before its
 * first await, and does every completion write (onDone, toast, list updates) through `binding.commit(...)`. If the
 * identity changed before the answer, nothing is written for the new person: no toast, no callback, no failure
 * words; it resolves STALE (r6), which every consumer checks synchronously before writing anything. The dialog
 * (ui/DecisionDialog) also binds before it awaits, and closes on the identity change itself.
 */
export function boundRun(work: (binding: EpochBinding) => Promise<DecisionResult>): () => Promise<DecisionResult | Stale> {
  return async () => {
    const binding = bindEpoch()
    try {
      const r = await work(binding)
      return binding.current() ? r : STALE
    } catch (e) {
      return binding.current() ? decisionFailure(e) : STALE
    }
  }
}

/**
 * The current identity epoch, re-rendering when it changes. Key component-local per-person state with it (a list
 * read in an effect, an opened answer), so an identity change, including a credential replaced on the same client,
 * starts that state empty for the new person.
 */
export function useIdentityEpoch(): number {
  return useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
}
