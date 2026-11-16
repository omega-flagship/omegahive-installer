// Purpose: place a box that opens from a button on the page itself, above every panel, kept inside the window.

/**
 * Where a box that opens from a button goes, in window coordinates (position: fixed): under the button with its right
 * edge on the button's, or above the button when there is no room below, and moved sideways to stay 8 px inside the
 * window. A box drawn inside a panel is cut wherever the panel hides overflow (a mind panel's Public or Private picker
 * was cut in half), so it is drawn on the page and placed here instead; this is Floating UI's flip and shift, for one
 * placement. Pure: the button's rectangle, the box's size and the window's are handed in.
 */
export function anchoredBox(button: { top: number; right: number; bottom: number }, box: { width: number; height: number }, view: { width: number; height: number }, gap = 8, margin = 8): { top: number; left: number } {
  const below = button.bottom + gap
  const top = below + box.height <= view.height - margin || button.top - gap - box.height < margin ? below : button.top - gap - box.height
  const left = Math.min(Math.max(margin, button.right - box.width), Math.max(margin, view.width - margin - box.width))
  return { top, left }
}
