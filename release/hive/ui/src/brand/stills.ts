/** The looks the mark has a material for (each a master-derived still and a live texture under public/brand/). */
export const MARK_LOOKS = ['cosmos', 'classic', 'construct', 'still', 'flux', 'canvas', 'omegatown', 'professional', 'brand'] as const
export type MarkLook = (typeof MARK_LOOKS)[number]

/** A look id from anywhere (an experience, an app) to a mark material; anything else wears the brand teal glass. */
export function markLook(id: string | null | undefined): MarkLook {
  return (MARK_LOOKS as readonly string[]).includes(id ?? '') ? (id as MarkLook) : 'brand'
}

/** The still of the mark in a look: only the mark, on transparency. */
export const stillFor = (look: MarkLook) => `${import.meta.env.BASE_URL}brand/still-${look}.webp`
