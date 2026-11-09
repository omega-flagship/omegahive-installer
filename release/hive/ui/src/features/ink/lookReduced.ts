/** Reduced motion for the ink layer: the system's, or the look's own "no motion" (InkLayer). */
import { useSyncExternalStore } from 'react'
import { useReducedMotion } from '../../lib/hooks'
import { reducedMotion } from '../ask/conductor'
import { subscribeLook } from '../../shell/uiVariant'

export function useLookReduced(): boolean {
  const media = useReducedMotion()
  // the look's own "no motion" (conductor reducedMotion) as well as the system's, read when the look changes (no poll)
  const look = useSyncExternalStore(
    subscribeLook,
    () => reducedMotion(),
    () => false,
  )
  return media || look
}
