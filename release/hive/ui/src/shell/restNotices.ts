import { restHolds, usePhase } from './phase'
import { dropParkedNotices, pauseNotices, releaseParkedNotices, setNoticeHold, useHive } from '../store/store'
import { onIdentityChange } from '../lib/identityEpoch'

/**
 * Notices at rest (Ask-and-apps R1.1 #7; Codex 3 Nov): a rest draws no toasts, so their time is held while it is in
 * front (each pauses with the time it has left; one arriving at rest parks with its whole time); leaving rest resumes
 * them, so on wake they all appear, and rest → wake → rest never refills a time. The rest shows
 * one quiet count instead (PhaseRendererProps.waiting). An identity change drops the earlier person's parked notices.
 */
export { restHolds }

setNoticeHold(() => restHolds(usePhase.getState()))
usePhase.subscribe((s, prev) => {
  if (!restHolds(prev) && restHolds(s)) pauseNotices()
  if (restHolds(prev) && !restHolds(s)) releaseParkedNotices()
})
onIdentityChange(dropParkedNotices)

/** How many notices are waiting while the shell rests (0 otherwise). */
export function useRestWaiting(): number {
  const resting = usePhase((s) => restHolds(s))
  const n = useHive((s) => s.toasts.length)
  return resting ? n : 0
}
