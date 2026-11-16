import type { Route } from '../sdk'

/**
 * close-home r4: Still's reading room and sheets hold the pointer, keyboard and screen reader (modal containment,
 * aria-modal) only while Still itself is in front, that is while the route is home. A shared page or mind panel
 * opened from them ("Everything about <mind>", a classic link) sits on top and must be fully usable, its X included;
 * so while one is open the containment lets go, without pulling focus back into Still (restoreFocus: false).
 */
export function stillModal(route: Route['name'], open = true): { active: boolean; restoreFocus?: false; ariaModal: boolean } {
  const front = route === 'hive'
  return { active: open && front, ...(front ? {} : { restoreFocus: false as const }), ariaModal: front }
}
