import { macKeys, ownedHere } from '../../lib/shortcutOwner'

export interface SummonKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  target: EventTarget | null | unknown
}

/**
 * Whether a key summons the Ask: ⌘K / Ctrl+K anywhere except the platform's mod+K (⌘K on a Mac, Ctrl+K elsewhere)
 * inside a region that owns it (the Code canvas, where it is Change…); and `/` when the person is not typing.
 */
export function askSummons(e: SummonKey, mac = macKeys()): boolean {
  const k = e.key.toLowerCase()
  if ((e.metaKey || e.ctrlKey) && k === 'k') return !ownedHere(e, 'mod+k', mac)
  return e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)
}

/** The same test as lib/hooks isTypingTarget, by shape (so it also holds outside a browser). */
function typing(t: unknown): boolean {
  const el = t as { isContentEditable?: boolean; tagName?: string } | null
  return !!el && (!!el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName ?? ''))
}

interface Focusable {
  focus(): void
}
export interface AskKeyEvent extends SummonKey {
  preventDefault(): void
  stopImmediatePropagation(): void
}

/**
 * The Ask's capture-phase key handler (AskHost binds exactly this): when the key summons the Ask and no modal is open,
 * it takes the key (prevents it and stops it reaching anything else) and focuses the Ask, or Still's own question box
 * while that is on screen. Inside a region that owns ⌘K it does nothing at all, so the region's own handler gets it.
 * Returns whether it took the key.
 */
export function handleAskKey(e: AskKeyEvent, d: { stillBox: (() => Focusable | null) | null; input: () => Focusable | null; modalOpen: () => boolean }, mac = macKeys()): boolean {
  if (!askSummons(e, mac) || d.modalOpen()) return false
  const target = d.stillBox ? d.stillBox() : d.input()
  if (!target) return false
  e.preventDefault()
  e.stopImmediatePropagation()
  target.focus()
  return true
}
