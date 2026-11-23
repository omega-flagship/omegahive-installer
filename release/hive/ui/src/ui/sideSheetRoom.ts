/**
 * The room open desktop side sheets (ui/Sheet) take at the right edge, published on <html> so the toast stack stands
 * beside them rather than over their foot (pr-79 #16: the privacy note covered the feedback form's last rows).
 * index.css reads it: `html[data-side-sheet] .toast-stack { right: var(--side-sheet-room) }` on md and up.
 * Several open: the widest wins; the last to close clears both. The Ask's own side sheet keeps its rule (ask.css).
 */
export const SIDE_SHEET_ATTR = 'data-side-sheet'
export const SIDE_SHEET_VAR = '--side-sheet-room'

/** What the helper touches on <html>; a stand-in in tests. */
export type SideSheetRoot = {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string }
}

const rooms = new Map<string, number>()

/** Record (px) or clear (null) the room sheet `id` takes from the right edge, and publish the widest on the root. */
export function setSideSheetRoom(
  id: string,
  px: number | null,
  root: SideSheetRoot | undefined = typeof document !== 'undefined' ? document.documentElement : undefined,
): void {
  if (px !== null && Number.isFinite(px) && px > 0) rooms.set(id, px)
  else rooms.delete(id)
  if (!root) return
  if (rooms.size === 0) {
    root.removeAttribute(SIDE_SHEET_ATTR)
    root.style.removeProperty(SIDE_SHEET_VAR)
    return
  }
  root.setAttribute(SIDE_SHEET_ATTR, '')
  root.style.setProperty(SIDE_SHEET_VAR, `${Math.ceil(Math.max(...rooms.values()))}px`)
}

/** Tests: forget every recorded sheet. */
export const resetSideSheetRooms = (): void => rooms.clear()
