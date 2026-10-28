import { useResting } from '../lib/resting'
import { coveredBy, openOverlays } from '../ui/overlays'

/** Read existing presentation coverage at invocation, before passive exporter cleanup. No new modal authority. */
export function viewIsLive(stage: HTMLElement | null): boolean {
  return !!stage && stage.isConnected && !useResting.getState().resting && !stage.closest('[inert], [aria-hidden="true"]') && !coveredBy(openOverlays(), stage)
}
