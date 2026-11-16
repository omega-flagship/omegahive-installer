/** Purpose: find the shell's one Ask field on the page, put the caret in it, and open a collapsed Ask to do so.
 * The one place that finds the shell's Ask field on the page (Ask-and-apps contract R1 §5). Every skin marks its field
 * with `data-ask-input`. No imports, so the shell's phase rules can use it without loading the Ask.
 */
export const ASK_FIELD = '[data-ask-input]'

export type AskDoc = Pick<Document, 'querySelectorAll'> & { activeElement: Element | null }

/**
 * How a collapsed Ask opens: AskHost registers it while the Ask's screen shows its mark (screens/ask.metta). Asking for
 * the field of a collapsed Ask opens it at the size it was collapsed from, and its field takes the cursor once drawn.
 */
let opener: (() => boolean) | null = null
export function setAskOpener(open: (() => boolean) | null): void {
  opener = open
}
/** Open the Ask if it is collapsed; true when it was. */
export const openCollapsedAsk = (): boolean => opener?.() ?? false

/**
 * Move the caret into the last mounted, enabled Ask field that is shown; true when it took focus, or when the Ask was
 * collapsed and opens (its field then takes the cursor once drawn). A collapsed Ask's field is hidden, never focused.
 */
export function focusAskField(doc: AskDoc | null = typeof document === 'undefined' ? null : document): boolean {
  if (!doc) return false
  const all = [...doc.querySelectorAll<HTMLElement>(ASK_FIELD)].filter((el) => !(el as HTMLInputElement).disabled && !el.closest?.('[hidden]'))
  const el = all[all.length - 1]
  if (!el) return openCollapsedAsk()
  el.focus({ preventScroll: true })
  return doc.activeElement === el
}

export interface AskDispatch {
  you: string
  steering: boolean
}
const listeners = new Set<(d: AskDispatch) => void>()
/** useAskField calls this as it sends (beside its own onDispatch prop). */
export function emitAskDispatch(d: AskDispatch): void {
  for (const cb of [...listeners]) {
    try { cb(d) } catch { /* one look's listener never stops the send or the others */ }
  }
}
/** Listen for sends from the Ask; returns the unsubscribe. */
export function onAskDispatch(cb: (d: AskDispatch) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Whether the Ask holds words now, as a signal a look's presentation can follow (contract R1.1 §6: listening). */
let words = false
const wordListeners = new Set<() => void>()
export function noteAskWords(has: boolean): void {
  if (has === words) return
  words = has
  for (const cb of [...wordListeners]) cb()
}
export const askHasWords = (): boolean => words
export function onAskWords(cb: () => void): () => void {
  wordListeners.add(cb)
  return () => { wordListeners.delete(cb) }
}
