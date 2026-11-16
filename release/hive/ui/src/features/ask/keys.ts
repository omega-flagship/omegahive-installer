/**
 * IME composition (UI review r2, stand-in #2 and Kimi #1). While a word is still being composed (Japanese, Chinese,
 * Korean, and other input methods), its keys belong to the input method: the Enter that confirms a candidate must never
 * send half-composed words. Every handler that acts on Enter in a text field checks this first (guardComposing; the
 * standing check is src/enterGuard.test.ts, which scans the whole tree).
 *
 * A key is composing when the browser says so (`isComposing`), or when it arrives as keyCode 229 in a field that is
 * composing, or as the FIRST key in a field whose composition has just ended (Safari sends its confirming Enter as 229
 * just after compositionend, after an unbounded delay on a busy page: the rule is ordinal, not timed; r2.3).
 *
 * The state is per field (Kimi r2.3 #4): a composition in one field never arms another's next key. And the decision is
 * made once per key, in the capture phase on the window, before any field sees it (Kimi r2.3 #2): that listener marks the
 * event if it is its field's confirming key, and spends the field's credit for every key, so a key a field later stops
 * from propagating can never leave the credit armed. A stray 229 with no composition just before it in its own field
 * (some WebViews send 229 for ordinary keys) is an ordinary key: it is never dead.
 *
 * The same capture listener cancels the default of a confirming Enter after the composition has ended, once, for the
 * whole app: no enclosing <form> anywhere can implicitly submit it (stand-in r2.2 P1, r2.4: the class, not one form).
 * While a composition is still under way the input method's own Enter is left alone (cancelling it can stop WebKit from
 * committing the candidate).
 */
export interface ComposingKey {
  keyCode?: number
  isComposing?: boolean
  target?: unknown
  nativeEvent?: { isComposing?: boolean; keyCode?: number; target?: unknown }
}

interface FieldState {
  active: boolean
  justEnded: boolean
}
/** Events with no element (tests, synthetic) share one field. */
const NO_FIELD = {}
const fields = new WeakMap<object, FieldState>()
const fieldOf = (t: unknown): object => (t && typeof t === 'object' ? (t as object) : NO_FIELD)
const stateOf = (t: unknown): FieldState => {
  const f = fieldOf(t)
  let s = fields.get(f)
  if (!s) fields.set(f, (s = { active: false, justEnded: false }))
  return s
}
/** The keys the capture listener judged to be their field's composition key (the native events themselves). */
const confirming = new WeakSet<object>()

/** A field's composition, as the browser reports it (registered once, below; tests call it directly). */
export function noteComposition(kind: 'start' | 'end', target?: unknown): void {
  const s = stateOf(target)
  s.active = kind === 'start'
  s.justEnded = kind === 'end'
}

interface CapturedKey {
  key?: string
  keyCode?: number
  isComposing?: boolean
  target?: unknown
  preventDefault?: () => void
}
/**
 * Every key, first (window, capture phase): is it its field's composition key? Mark it, cancel a confirming Enter's
 * default once the composition has ended (no implicit form submission, app-wide), and spend the field's credit.
 */
export function noteKeyCapture(ev: CapturedKey): void {
  const s = fields.get(fieldOf(ev.target))
  if (!s) return
  if (!ev.isComposing && ev.keyCode === 229 && (s.active || s.justEnded)) {
    confirming.add(ev as object)
    if (ev.key === 'Enter' && !s.active) ev.preventDefault?.()
  }
  s.justEnded = false
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // captured, on the document: every field (any skin, any experience) reports through the same two events
  document.addEventListener('compositionstart', (e) => noteComposition('start', e.target), true)
  document.addEventListener('compositionend', (e) => noteComposition('end', e.target), true)
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // captured, on the window: before every field's own handler, and whatever a field does with the key afterwards
  window.addEventListener('keydown', noteKeyCapture, true)
}

export const composingKey = (e: ComposingKey): boolean => {
  if (e.isComposing || e.nativeEvent?.isComposing) return true
  const is229 = e.keyCode === 229 || e.nativeEvent?.keyCode === 229
  if (!is229) return false
  const native = (e.nativeEvent ?? e) as object
  return confirming.has(native) || !!fields.get(fieldOf(e.nativeEvent?.target ?? e.target))?.active
}

export interface GuardableKey extends ComposingKey {
  key?: string
  preventDefault?: () => void
}
/**
 * The first line of every handler that acts on Enter in a text field (r2.3, stand-in P1): true when the key belongs to
 * the input method, and the caller returns. A confirming Enter after the composition has ended also has its default
 * cancelled here (as the capture listener already does, app-wide), so no enclosing form can submit it. While a
 * composition is still under way the input method itself consumes Enter, and the default is left alone.
 */
export function guardComposing(e: GuardableKey): boolean {
  if (!composingKey(e)) return false
  // still composing (the browser says so, or the field's composition has not ended): the input method owns Enter
  const active = !!(e.isComposing || e.nativeEvent?.isComposing) || !!fields.get(fieldOf(e.nativeEvent?.target ?? e.target))?.active
  if (e.key === 'Enter' && !active) e.preventDefault?.()
  return true
}

/** For tests: no composition in the shared no-element field (tests give any other field its own object). */
export const resetComposition = (): void => {
  fields.delete(NO_FIELD)
}
