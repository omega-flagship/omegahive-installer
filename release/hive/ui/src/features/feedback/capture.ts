// Purpose: a picture of the hive's own page for a report, drawn from the page itself, never from the screen or a window
// (a screen capture once carried a tester's bookmarks and other people's names into the board), with the feedback area
// left out. modern-screenshot is loaded only when a report is made, so no other page pays for it.

/** Marks what the picture leaves out: the feedback entry and the feedback area itself. */
export const LEAVE_OUT = 'data-feedback-leave-out'

/**
 * The page as the person sees it now, as a PNG data address at one pixel per CSS pixel: what was on screen, at the
 * size it was, not a print of the whole scrolled page. modern-screenshot clones the page and lets the browser draw the
 * clone (an SVG foreignObject), so colours and fonts draw as they do on screen; frames from elsewhere and 3D scenes
 * come out blank. Rejects when the browser cannot draw it, which the page says.
 */
export async function capturePage(doc: Document = document): Promise<string> {
  const { domToPng } = await import('modern-screenshot')
  const win = doc.defaultView ?? window
  return domToPng(doc.body, {
    width: win.innerWidth,
    height: win.innerHeight,
    scale: 1,
    backgroundColor: win.getComputedStyle(doc.body).backgroundColor || null,
    filter: (node) => !(node instanceof Element && node.closest(`[${LEAVE_OUT}]`)),
  })
}

/** A PNG data address as the bytes a file or a share needs. */
export function pngBlob(dataUrl: string): Blob {
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i)
  return new Blob([out], { type: 'image/png' })
}
