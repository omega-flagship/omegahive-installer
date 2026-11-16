/**
 * The demo cursor and the draw layer (circles, arrows and underlines with a few words), shared by the D4 showreel and
 * guided-play (a guided demo started from the Ask plays itself through). Screen-only state: the cursor and the marks
 * are drawn by InkLayer (mounted once, with the guided layer), and NEVER press anything. A "click" here is a ripple
 * drawn under the cursor; nothing is clicked, dispatched or sent. Over a decision control (Keep, Confirm, Delete,
 * Send, Approve…) the cursor only points: not even the ripple is drawn there.
 *
 * Who draws owns the ink (`owner`): one player's clear never wipes the other's marks.
 */
import { create } from 'zustand'
import type { GuideTarget } from '../guided/types'

/** A mark on the draw layer. */
export interface Mark {
  kind: 'circle' | 'arrow' | 'underline'
  target: GuideTarget[]
  /** a few words beside it (always shown under reduced motion, where the mark does not animate) */
  label?: string
  /** the element the player chose for it (drawn on that one while it is on the page, not a re-match of `target`) */
  el?: Element
}

/** The part of a box inside the window, or null when none of it (or under 8 px of it) is. */
export function visiblePart(r: { left: number; top: number; right: number; bottom: number }, vw: number, vh: number): { left: number; top: number; right: number; bottom: number } | null {
  const b = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(vw, r.right), bottom: Math.min(vh, r.bottom) }
  return b.right - b.left >= 8 && b.bottom - b.top >= 8 ? b : null
}

/**
 * The element a mark draws on. A mark bound to an element (guided-play) draws on that one only: once it leaves the page
 * there is no mark, never a re-match of `target` that could be a different element (r1.2b). An unbound mark (the
 * showreel's) is found from its targets.
 */
export function markElement(m: Pick<Mark, 'el'>, find: () => Element | null | undefined): Element | null {
  if (m.el) return m.el.isConnected ? m.el : null
  return find() ?? null
}

export type InkOwner = 'showreel' | 'guided'

export interface Ink {
  owner: InkOwner | null
  cursor: { x: number; y: number; shown: boolean; clicks: number; jump: boolean }
  marks: Mark[]
}

const HIDDEN = { x: -40, y: -40, shown: false, clicks: 0, jump: true }
export const useInk = create<Ink>()(() => ({ owner: null, cursor: HIDDEN, marks: [] }))

export const GLIDE_MS = 750
export const CLICK_MS = 320
/** under reduced motion the cursor jumps; this is only the beat before the next thing */
export const JUMP_MS = 80

const DECISION = /\b(keep|confirm|delete|send|approve|reject|deny|accept|remove|retire|reset|post|publish|submit|save|discard|pay|spend|revoke|grant|allow)\b/i

/**
 * A control that decides, spends, sends or changes something (by its words or role). The cursor never ripples over
 * one; and nothing here ever presses anything at all.
 */
export function isDecisionControl(el: Element | null): boolean {
  const c = el?.closest?.('button, [role="button"], a[href], input[type="submit"], input[type="button"], [data-decision]')
  if (!c) return false
  if (c.hasAttribute('data-decision')) return true
  const words = `${c.getAttribute('aria-label') ?? ''} ${c.getAttribute('title') ?? ''} ${(c as HTMLElement).innerText ?? c.textContent ?? ''} ${c.getAttribute('value') ?? ''}`
  return DECISION.test(words)
}

/** Where the cursor rests on an element: its middle, or near its top-left on a big one, kept on screen. */
export function restPoint(r: { left: number; top: number; width: number; height: number }, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(vw - 8, r.left + Math.min(r.width / 2, 48))),
    y: Math.max(8, Math.min(vh - 8, r.top + Math.min(r.height / 2, 24))),
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Glide the cursor to `el` (a jump under reduced motion), then, when asked and it is not a decision control, draw a
 * click ripple. Draws only: it never calls click(), dispatches an event or focuses anything.
 */
export async function glideTo(owner: InkOwner, el: Element, click: boolean, reduced: boolean, sleep: (ms: number) => Promise<void> = wait): Promise<void> {
  const r = el.getBoundingClientRect()
  const { x, y } = restPoint(r, window.innerWidth, window.innerHeight)
  useInk.setState((s) => ({ owner, cursor: { ...s.cursor, x, y, shown: true, jump: reduced } }))
  await sleep(reduced ? JUMP_MS : GLIDE_MS)
  if (click && !isDecisionControl(el) && useInk.getState().owner === owner) {
    useInk.setState((s) => ({ cursor: { ...s.cursor, clicks: s.cursor.clicks + 1 } }))
    await sleep(reduced ? JUMP_MS : CLICK_MS)
  }
}

export function drawMarks(owner: InkOwner, marks: Mark[]): void {
  useInk.setState({ owner, marks })
}

/** Clear the marks (and, with `cursor`, hide the cursor) only when `owner` drew them. */
export function clearInk(owner: InkOwner, { cursor = false }: { cursor?: boolean } = {}): void {
  const s = useInk.getState()
  if (s.owner !== owner) return
  useInk.setState({ marks: [], ...(cursor ? { cursor: { ...s.cursor, shown: false }, owner: null } : {}) })
}
