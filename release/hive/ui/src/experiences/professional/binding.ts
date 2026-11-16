import { useHive } from '../sdk'
import { currentEpoch } from '../../lib/identityEpoch'

/** Use Surface’s exact canonical epoch; the existing host remains the permission authority. */
export function contextOf(_s: ReturnType<typeof useHive.getState>): string {
  return String(currentEpoch())
}

/** Check again in the event handler, including same-client credential changes. */
export function current(ctx: string): boolean {
  const s = useHive.getState()
  return contextOf(s) === ctx && !!s.client && s.ready && s.connection !== 'unauthorized'
}
