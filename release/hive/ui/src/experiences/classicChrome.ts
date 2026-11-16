import { useRoute } from '../lib/router'
import { usePhase } from '../shell/phase'

/**
 * Whether Classic's Pro chrome is put away: on a candidate build (dev, surface-preview), while a phase other than Pro
 * holds the hive view itself (no page over it). ClassicProChrome hides its children by it, and the setup nudge's
 * Getting started, mounted outside that chrome (App), hides with it.
 */
export function useClassicChromeHidden(): boolean {
  const held = usePhase((s) => s.phased && s.phase !== 'pro')
  const covered = useRoute().name !== 'hive'
  return (import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true) && held && !covered
}
