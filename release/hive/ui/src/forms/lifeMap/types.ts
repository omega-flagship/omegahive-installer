import type { FormProps, Grammar } from '../contract'

/**
 * The Atlas form's props: the shared form contract (forms/contract.ts) plus who is looking.
 * Only the owner (the subject, or whoever holds the Atlas) ever sees a real graph.
 */
export type { Grammar }
export interface LifeMapProps extends FormProps {
  viewer?: { isOwner: boolean }
}

/** Grammars with their own rendering; the rest open in classic. */
export const NATIVE: Grammar[] = ['classic', 'still', 'cosmos']
export const nativeGrammar = (g: Grammar): 'classic' | 'still' | 'cosmos' => (g === 'still' || g === 'cosmos' ? g : 'classic')

/** The four depths of the map: the legacy semantic zoom rail. */
export type Level = 0 | 1 | 2 | 3
export const LEVEL_NAMES = ['Systems', 'Structures', 'Values', 'Provenance'] as const
/** The same depths as altitudes over the planet of self (cosmos). */
export const ALTITUDE_NAMES = ['Orbit', 'Low flight', 'Surface', 'Core sample'] as const
/** The same depths as reading depths of the biography (still). */
export const READING_NAMES = ['Chapters', 'Anatomy', 'Values', 'Footnotes'] as const

/** The four views within the form, as in the legacy bottom bar. */
export type View = 'today' | 'map' | 'timeline' | 'plan'
export const VIEWS: View[] = ['today', 'map', 'timeline', 'plan']
export const VIEW_NAMES: Record<View, string> = { today: 'Today', map: 'Map', timeline: 'Timeline', plan: 'Plan' }
