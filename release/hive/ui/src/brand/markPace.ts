/**
 * When a living mark may draw its next frame (Ask-and-apps contract R1.1 §9.4, the counted gate; Dot 3 Nov). Pure, so
 * the scheduler is unit-tested without WebGL. A mark draws only while it is really shown (on screen, the tab visible,
 * and not hidden by CSS: visibility, display or opacity), and never while the shell rests: at rest every mark is still.
 *   'still' draws no loop (one frame when woken, to show a change);
 *   'awake': a hero ~18 frames a second, a corner ~30, by a timer before each frame (no display-rate callbacks); at
 *   shell awake only the look's own hero lives, corner marks are still;
 *   'full' (a hero only) every display frame.
 */
export type MarkPace = 'still' | 'awake' | 'full'

export function effectivePace(pace: MarkPace, shown: boolean, shellPhase: string | null | undefined, size: 'corner' | 'hero' = 'hero'): MarkPace {
  if (!shown) return 'still'
  if (shellPhase === 'rest') return 'still'
  // awake has one living mark, the look's own Ω (a hero); corner marks (the Ask's, the menus') hold still there
  if (shellPhase === 'awake' && size === 'corner') return 'still'
  return pace
}

/** 'none': stop until woken; 'raf': the next display frame; a number: wait that many ms, then one display frame. */
export function nextFrame(pace: MarkPace, size: 'corner' | 'hero'): 'none' | 'raf' | number {
  if (pace === 'still') return 'none'
  if (size === 'hero' && pace === 'full') return 'raf'
  // an awake hero breathes at ~18 frames a second (with the scene's ~18, the awake page stays near 35; Dot 3 Nov)
  if (size === 'hero') return 55
  return 33
}

/** Is this element really shown (CSS included)? checkVisibility where the browser has it; else assume shown. */
export function reallyShown(el: Element | null, inView: boolean, docHidden: boolean): boolean {
  if (!el || !inView || docHidden) return false
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility
  return typeof check === 'function' ? check.call(el, { checkOpacity: true, checkVisibilityCSS: true }) : true
}
