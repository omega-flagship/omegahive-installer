import { SURFACE_PREVIEW } from '../experiences/registry'
import { useSim } from '../lib/sim'
import { PreviewBuildMarker } from './PreviewBuildMarker'

/**
 * The preview marker as App shows it: its words follow the hive client's mode, live or simulated (followups-r6). Kept
 * apart from the marker so the marker's module stays free of the store (the registry gate test imports it cold).
 */
export function PreviewBuildBanner({ preview = SURFACE_PREVIEW }: { preview?: boolean }) {
  const sim = useSim()
  return <PreviewBuildMarker preview={preview} sim={sim} />
}
