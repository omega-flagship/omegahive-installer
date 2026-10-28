import { SURFACE_PREVIEW } from '../experiences/registry'

/** The words on the marker: a surface-preview build must never be mistaken for a release. The short part always shows. */
export const PREVIEW_BUILD_SHORT = 'PREVIEW BUILD · not a release'
export const PREVIEW_BUILD_DETAIL = ' · unreviewed experiences on · live hive data: every action is real · approvals open the classic page'
export const PREVIEW_BUILD_WORDS = PREVIEW_BUILD_SHORT + PREVIEW_BUILD_DETAIL
/**
 * In a confirmed simulation (the client says `sim`) the data is invented and nothing reaches a hive, so the marker must
 * not say every action is real (followups-r6). Until the client is known, the live words stand: the careful default.
 */
export const PREVIEW_BUILD_DETAIL_SIM = ' · unreviewed experiences on · simulated data: no action here is real · approvals open the classic page'
export const PREVIEW_BUILD_WORDS_SIM = PREVIEW_BUILD_SHORT + PREVIEW_BUILD_DETAIL_SIM

/**
 * The visible marker every surface-preview build carries (the only production build allowed to offer unreviewed
 * experiences, experiences/registry UNREVIEWED_ALLOWED). A release build renders nothing here.
 * `sim`: the hive client is the simulator (shell/PreviewBuildBanner reads it from the store).
 * FAIL-SAFE (pinned by shell/previewBuildMarker.r6.test.ts, "fail-safe: an UNKNOWN client mode …"): `sim` defaults to
 * false and only a client that says exactly `sim` sets it, so an unknown mode shows the live warning words, never
 * "simulated". Flipping that default would label a live hive as simulated.
 */
export function PreviewBuildMarker({ preview = SURFACE_PREVIEW, sim = false }: { preview?: boolean; sim?: boolean }) {
  if (!preview) return null
  const detail = sim ? PREVIEW_BUILD_DETAIL_SIM : PREVIEW_BUILD_DETAIL
  return (
    // one compact line at every width: the detail shows only where it fits (md and up); never wraps over the page
    <div role="note" aria-label={PREVIEW_BUILD_SHORT + detail} data-preview-build="" data-preview-data={sim ? 'sim' : 'live'} className="pointer-events-none fixed inset-x-0 top-0 z-[95] overflow-hidden text-ellipsis whitespace-nowrap bg-amber-400/95 px-2 py-0.5 text-center font-mono text-[10.5px] leading-4 font-semibold tracking-wide text-black">
      {PREVIEW_BUILD_SHORT}<span className="hidden md:inline">{detail}</span>
    </div>
  )
}
