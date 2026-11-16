/**
 * Where a showreel mark's label sits (pure, tested). Above the mark, since the guided caption usually sits below its
 * target; below it when there is no room above, or when above would cover the title of the dialog the mark is in.
 */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** the label's room: its widest (.sr-ink-label max-width) and about its height, with the gap to the mark */
export const LABEL_W = 210
export const LABEL_H = 26
const GAP_ABOVE = 34

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

export function labelTop(mark: Box, left: number, vh: number, title?: Box | null): number {
  const below = Math.min(vh - 40, mark.bottom + 14)
  const above = mark.top - GAP_ABOVE
  if (above < 8) return below
  if (title && overlaps({ left, right: left + LABEL_W, top: above, bottom: above + LABEL_H }, title)) return below
  return above
}

/** The title of the dialog an element is in (its aria-labelledby, else its first heading), or null. */
export function dialogTitle(el: Element | null): Element | null {
  const d = el?.closest('[role="dialog"],[role="alertdialog"]')
  if (!d) return null
  const id = d.getAttribute('aria-labelledby')?.split(/\s+/)[0]
  return (id && d.ownerDocument.getElementById(id)) || d.querySelector('h1,h2,h3')
}
