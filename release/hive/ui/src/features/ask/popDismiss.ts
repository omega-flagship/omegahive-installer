import { useEffect, useRef, type RefObject } from 'react'

/**
 * What opens under the Ask's field ("Did you mean…", a clarifying question, a limit, the answerer picker) is the Ask's
 * own short-lived layer (mind-chat r1). It never outstays the person's attention: Esc closes it wherever focus is, and
 * typing anywhere outside the Ask (a mind's composer, a form) closes it. It never covers a mind's chat either: while a
 * mind panel is open beside or under it, the panel makes room for it (popRoom, ui/Sheet `--ask-pop-room`).
 */

/** The Ask's own surfaces: typing there is the person using the Ask, never a reason to close what it opened. */
export const ASK_OWN = '.ask-root, [data-ask-zone]'

/** Whether an event closes the Ask's open layer: Esc anywhere, or words typed outside the Ask. */
export function closesPop(e: { type: string; key?: string }, inAsk: boolean): boolean {
  if (e.type === 'keydown') return e.key === 'Escape'
  if (e.type === 'input') return !inAsk
  return false
}

/** Scoped chooser: pointer presses outside its own boundary also dismiss it. */
export function closesScopedPop(e: { type: string; key?: string }, inAsk: boolean, inChooser: boolean): boolean {
  return closesPop(e, inAsk) || (e.type === 'pointerdown' && !inChooser)
}

/**
 * `html[data-ask-pop]` while any of the Ask's layers is open (counted: the policy panel and the answerer picker can
 * overlap), so an open mind panel can make its chat compact under it (ask.css: the live log strip yields).
 */
let popHolds = 0
export function holdPopFlag(): () => void {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  popHolds++
  if (root?.dataset) root.dataset.askPop = ''
  let released = false
  return () => {
    if (released) return
    released = true
    popHolds = Math.max(0, popHolds - 1)
    if (!popHolds && root?.dataset) delete root.dataset.askPop
  }
}

/** Esc and typing elsewhere close the layer while it is open (`close` is called at most once per event). */
export function usePopDismiss(open: boolean, close: (event?: Event) => void, boundary?: RefObject<HTMLElement | null>): void {
  const fn = useRef(close)
  useEffect(() => {
    fn.current = close
  })
  useEffect(() => {
    if (!open) return
    const release = holdPopFlag()
    const on = (e: Event) => {
      const t = typeof Element !== 'undefined' && e.target instanceof Element ? e.target : null
      const input = { type: e.type, key: (e as KeyboardEvent).key }
      const inAsk = !!t?.closest(ASK_OWN)
      if (!(boundary ? closesScopedPop(input, inAsk, !!t && !!boundary.current?.contains(t)) : closesPop(input, inAsk))) return
      // Esc is spent here: the layer closes first, before a sheet or page under it hears it (lib/hooks escape stack)
      if (e.type === 'keydown') e.preventDefault()
      fn.current(e)
    }
    // a test's or a headless host's stub window may have no listeners at all: then nothing is watched
    const w = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null
    const d = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null
    w?.addEventListener('keydown', on, true)
    d?.addEventListener('input', on, true)
    if (boundary) d?.addEventListener('pointerdown', on, true)
    return () => {
      release()
      w?.removeEventListener('keydown', on, true)
      d?.removeEventListener('input', on, true)
      if (boundary) d?.removeEventListener('pointerdown', on, true)
    }
  }, [open, boundary])
}

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** Air between the Ask's layer and the panel content above it (px). */
export const POP_GAP = 12

/**
 * How far up from the screen's bottom a mind panel's content must end so the Ask's open layer covers none of it: the
 * layer's top plus a gap, when the layer and the panel's chat share any column; 0 when they do not (a desk where the
 * Ask sits clear of the side panel) or no mind panel is open.
 */
export function popRoom(pop: Pick<Box, 'left' | 'right' | 'top'>, panel: Box | null, viewportHeight: number): number {
  if (!panel) return 0
  const shareColumn = pop.left < panel.right && panel.left < pop.right
  if (!shareColumn) return 0
  return Math.max(0, Math.ceil(viewportHeight - pop.top + POP_GAP))
}

/** The CSS variable a sheet keeps its content above (ui/Sheet), set on the document root while the layer is open. */
export const POP_ROOM_VAR = '--ask-pop-room'
/** The mind panel's chat body (features/dot/DotPanel): what the Ask's layer must never cover. */
export const MIND_PANEL_BODY = '[data-mind-panel-body]'
