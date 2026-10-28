/**
 * A region of the page can own a global shortcut while focus is inside it: it says so with
 * `data-owns-shortcut="mod+k mod+e"` (space-separated combos), and the app-wide handlers for those combos (the Ask's
 * summon, the palette) yield there instead of racing it in the capture phase. Everywhere else they work as before.
 * Combos are lower-case, `mod` = ⌘ on a Mac and Ctrl elsewhere.
 */
export const OWNS_SHORTCUT = 'data-owns-shortcut'

interface Owner {
  getAttribute(name: string): string | null
}
interface Target {
  closest?(selector: string): unknown
}

/** True when the event's target sits inside a region that owns `combo`. */
export function ownsShortcut(target: unknown, combo: string): boolean {
  const t = target as Target | null
  if (!t || typeof t.closest !== 'function') return false
  const owner = t.closest(`[${OWNS_SHORTCUT}]`) as Owner | null
  if (!owner || typeof owner.getAttribute !== 'function') return false
  return (owner.getAttribute(OWNS_SHORTCUT) ?? '').split(/\s+/).includes(combo)
}

/** A Mac (or iPad) keyboard: there `mod` is ⌘, as in CodeMirror's `Mod-`; elsewhere it is Ctrl. */
export function macKeys(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  return !!nav && /Mac|iPhone|iPad|iPod/.test((nav as { platform?: string }).platform || nav.userAgent || '')
}

/**
 * True when this key event is the platform's `mod` (⌘ on a Mac, Ctrl elsewhere) inside a region that owns
 * `mod+<key>`. On a Mac, Ctrl+K is not `mod+k` (in the code it is the text convention "delete to the line end"), so the
 * app-wide shortcut keeps it.
 */
export function ownedHere(e: { metaKey: boolean; ctrlKey: boolean; target: unknown }, combo: string, mac = macKeys()): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey
  return mod && ownsShortcut(e.target, combo)
}
