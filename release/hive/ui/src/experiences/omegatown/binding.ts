import { useHive } from '../sdk'
import { currentEpoch, onIdentityChange } from '../../lib/identityEpoch'

/** The canonical Surface epoch binds this presentation; no local identity counter or grant. */
export const contextOf = (_s: ReturnType<typeof useHive.getState>) => String(currentEpoch())
export function current(ctx: string): boolean {
  const s = useHive.getState()
  return contextOf(s) === ctx && !!s.client && s.ready && s.connection !== 'unauthorized'
}

export type LocalPose = { x: number; y: number; coat: 'amber' | 'fern' | 'violet'; kit: 'woodland' | 'modern' | 'future' }
export const START: LocalPose = { x: 600, y: 650, coat: 'amber', kit: 'woodland' }
// One bounded, volatile view-only slot. No canonical records, draft, message, person or facility assignment.
let remembered: { ctx: string; pose: LocalPose } | null = null
onIdentityChange(() => { remembered = null })
export const restorePose = (ctx: string): LocalPose => {
  if (remembered?.ctx !== ctx) remembered = null
  return { ...(remembered?.pose ?? START) }
}
export function rememberPose(ctx: string, pose: LocalPose): void {
  remembered = current(ctx) ? { ctx, pose: { ...pose } } : null
}
