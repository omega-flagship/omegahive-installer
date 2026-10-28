/**
 * Where a small hint card goes beside its anchor without covering controls or titles. Candidates are tried in
 * order (below, above, outside the anchor's panel, beside the anchor, then the first clear band further down); each
 * must fit the viewport, and the first covering none wins. None: `covers: -1`, and the hint is not shown there.
 */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Placed extends Box {
  side: 'below' | 'above' | 'outside' | 'beside' | 'clear'
  /** How many controls (and titles) it would cover; -1 when no place covers none (the hint then waits, unshown). */
  covers: number
}

const M = 8

const overlaps = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

export function placeHint(anchor: Box, size: { width: number; height: number }, viewport: { width: number; height: number }, controls: Box[], panel?: Box | null, reserveBottom = 0): Placed {
  const { width: vw, height: vh } = viewport
  const w = Math.min(size.width, vw - 2 * M - 8)
  const h = size.height
  const clampX = (x: number, ww: number) => Math.max(M, Math.min(x, vw - ww - M))
  const clampY = (y: number) => Math.max(M, Math.min(y, vh - h - M))
  const rightAligned = clampX(anchor.left + anchor.width - w, w)
  const cands: Omit<Placed, 'covers'>[] = [
    { side: 'below', left: rightAligned, top: anchor.top + anchor.height + M, width: w, height: h },
    { side: 'above', left: rightAligned, top: anchor.top - M - h, width: w, height: h },
  ]
  if (panel) {
    cands.push({ side: 'outside', left: panel.left - 12 - w, top: clampY(anchor.top - 4), width: w, height: h })
    cands.push({ side: 'outside', left: panel.left - 12 - w, top: clampY(anchor.top + anchor.height + M), width: w, height: h })
  }
  const besideW = Math.min(w, anchor.left - M - 2 * M)
  if (besideW >= 180) cands.push({ side: 'beside', left: anchor.left - M - besideW, top: clampY(anchor.top + anchor.height / 2 - h / 2), width: besideW, height: h + Math.ceil(((w - besideW) / besideW) * h) })
  // last: the first clear band further down the screen (a phone header where every spot beside the button is a title
  // or a control), above the bottom reserve (the Ask's room)
  for (let top = anchor.top + anchor.height + M; top + h <= vh - M - reserveBottom; top += 8) cands.push({ side: 'clear', left: rightAligned, top, width: w, height: h })
  for (const c of cands) {
    if (c.left < M || c.top < M || c.left + c.width > vw - M || c.top + c.height > vh - M) continue
    if (!controls.some((b) => overlaps(c, b))) return { ...c, covers: 0 }
  }
  // nowhere covers nothing: never placed over a title or a control; the hint waits
  return { side: 'below', left: rightAligned, top: Math.min(anchor.top + anchor.height + M, vh - h - M), width: w, height: h, covers: -1 }
}

/** A rough height for a one-paragraph hint at the given width (12.5px text, a close button). */
export const hintHeight = (text: string, width: number) => {
  const perLine = Math.max(16, Math.floor((width - 64) / 6.4))
  return Math.max(44, Math.ceil(text.length / perLine) * 18 + 12)
}
