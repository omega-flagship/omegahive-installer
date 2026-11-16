import { heldInPreview, heldWords, SURFACE_PREVIEW } from '../experiences/registry'
import { useHive } from '../store/store'

/** Each held experience is announced once per page load (a re-render or a look change back and forth says nothing new). */
const said = new Set<string>()

/**
 * UI review 2026-10-12 TF-03: a surface-preview build holds Still and Canvas back, and a saved choice of one shows
 * Classic. Say so, once, in the shared notices: "Still isn't in this preview build; showing Classic." Returns whether it
 * spoke. A release build never holds, so it never speaks.
 */
export function announceHeld(wanted: string | null | undefined, preview: boolean = SURFACE_PREVIEW): boolean {
  const held = heldInPreview(wanted, preview)
  if (!held || said.has(held.id)) return false
  said.add(held.id)
  useHive.getState().toast({ tone: 'info', icon: 'info', title: heldWords(held.name), ttl: 12_000, group: 'held-experience' })
  return true
}

/** For tests: forget what was announced. */
export const resetHeldNotices = (): void => said.clear()
