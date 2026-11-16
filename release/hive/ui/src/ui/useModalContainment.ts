import { useIsPresent } from 'framer-motion'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { LayerStack, outsideOf, planInert, tabStep, type TabFrom } from '../lib/modalContainment'

/**
 * Modal containment for every aria-modal dialog (Review A2/B1/E1). While the dialog is open and on top:
 *  - Tab and Shift-Tab cycle through the dialog's own controls only, from wherever focus is: a control, a tabIndex=-1
 *    heading, the dialog itself, or nowhere; a dialog with no control keeps focus on itself.
 *  - Everything outside the dialog's layer is `inert` (not focusable, not clickable, not in the accessibility tree):
 *    the body-level siblings of a portaled dialog, and the siblings along the whole path for one rendered in place.
 *    Prior inert state is restored exactly on close; nodes that were already inert are never touched.
 *  - Layers stack: a dialog opened from a dialog is the only live one; closing it makes the one below live again.
 *  - On close, focus returns to whatever opened it (or `restoreFocus(opener)`, or nowhere with `restoreFocus: false`).
 * Escape stays with each dialog (lib/hooks useEscape or its own onKeyDown). Inside framer-motion's AnimatePresence the
 * layer is released as soon as the exit starts, so a closing dialog never holds the page.
 */
export interface ModalOptions {
  /** Default true. A hook that is always mounted (a host) passes whether its dialog is showing. */
  active?: boolean
  /** Other elements that belong to this layer and must stay live (a backdrop rendered as the dialog's sibling). */
  also?: RefObject<HTMLElement | null>[]
  /** Focus this on open. Otherwise the dialog focuses its own heading or field; if nothing inside has focus, the dialog itself does. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Default true (the opener). A function picks the element; false leaves restoring to the dialog. */
  restoreFocus?: boolean | ((opener: HTMLElement | null) => HTMLElement | null | undefined)
}

interface Layer {
  el: HTMLElement
  also: () => HTMLElement[]
}

const stack = new LayerStack<Layer>()
/** Nodes made inert by this module (they were not inert before). */
const made = new Set<Element>()
let observer: MutationObserver | null = null
/** Recently focused elements, newest last: the opener when a dialog's child took focus before we could look. */
const recent: HTMLElement[] = []

const TABBABLE =
  'a[href],area[href],button,input:not([type="hidden"]),select,textarea,iframe,summary,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex]'

function visible(el: HTMLElement): boolean {
  if (!el.getClientRects().length) return false
  return getComputedStyle(el).visibility !== 'hidden'
}

/** The dialog's controls in Tab order (document order; positive tabIndex is not used in this UI). */
export function tabbablesIn(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(TABBABLE)]
  const radios = new Map<string, HTMLInputElement[]>()
  for (const el of all) if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) radios.set(el.name, [...(radios.get(el.name) ?? []), el])
  return all.filter((el) => {
    if (el.tabIndex < 0) return false
    if (el.matches(':disabled')) return false
    if (el.closest('[inert]')) return false
    const closed = el.closest('details:not([open])')
    if (closed && !(el.tagName === 'SUMMARY' && el.parentElement === closed)) return false
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const group = radios.get(el.name) ?? [el]
      const checked = group.find((r) => r.checked)
      if (checked ? checked !== el : group[0] !== el) return false
    }
    return visible(el)
  })
}

/**
 * App-level layers that sit above every dialog by design and must stay usable (the guided tour, which drives the app
 * and may open a dialog itself) carry data-modal-keep. They stay live; Tab containment still covers only the dialog.
 */
const KEEP = '[data-modal-keep]'

function within(layer: Layer, node: Node | null): boolean {
  if (!node) return false
  if (layer.el.contains(node) || layer.also().some((a) => a.contains(node))) return true
  const el = node instanceof Element ? node : node.parentElement
  return !!el?.closest(KEEP)
}

function recompute() {
  if (typeof document === 'undefined') return
  const top = stack.top()
  const want = top && top.el.isConnected ? outsideOf<Element>([top.el, ...top.also(), ...document.querySelectorAll(KEEP)], document.body) : []
  const plan = planInert<Element>(made, want, (el) => el.hasAttribute('inert'))
  for (const el of plan.release) {
    made.delete(el)
    el.removeAttribute('inert')
  }
  for (const el of plan.set) {
    made.add(el)
    el.setAttribute('inert', '')
  }
  // follow the top layer's path: a node added beside it later (a toast, another portal) becomes inert too
  observer?.disconnect()
  if (top && top.el.isConnected && typeof MutationObserver !== 'undefined') {
    observer ??= new MutationObserver(recompute)
    const watched = new Set<Element>()
    for (const k of [top.el, ...top.also()]) {
      for (let n: Element | null = k.parentElement; n; n = n === document.body ? null : n.parentElement) watched.add(n)
    }
    for (const n of watched) observer.observe(n, { childList: true })
  }
}

function focusSelf(el: HTMLElement) {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
    el.style.outline = 'none'
  }
  el.focus({ preventScroll: true })
}

let installed = false
function install() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      const top = stack.top()
      if (top && !within(top, t)) {
        // focus reached the background before it was made inert (it was just added): bring it back
        focusSelf(top.el)
        return
      }
      if (recent[recent.length - 1] !== t) recent.push(t)
      if (recent.length > 12) recent.shift()
    },
    true,
  )
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    const top = stack.top()
    if (!top) return
    const list = tabbablesIn(top.el)
    const active = document.activeElement
    let from: TabFrom
    if (!active || active === document.body || !top.el.contains(active)) from = { kind: 'outside' }
    else {
      const i = list.indexOf(active as HTMLElement)
      from = i >= 0 ? { kind: 'at', index: i } : { kind: 'between', before: list.filter((x) => active.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING).length }
    }
    e.preventDefault()
    const to = tabStep(list.length, from, e.shiftKey)
    if (to === null) {
      if (from.kind === 'outside') focusSelf(top.el)
      return
    }
    list[to].focus()
  })
}

/** For tests and the harness: how many modal layers are open, and whether `el` is the live one. */
export const modalLayers = {
  get size() {
    return stack.size
  },
  isTop: (el: HTMLElement | null) => !!el && stack.top()?.el === el,
}

export function useModalContainment(ref: RefObject<HTMLElement | null>, options: ModalOptions = {}): void {
  install()
  const present = useIsPresent()
  const active = options.active !== false && present
  const opts = useRef(options)
  useLayoutEffect(() => {
    opts.current = options
  })
  // whatever had focus when a dialog that mounts open first rendered: its opener, before any child focuses itself
  const [rendered] = useState(() => (active && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null))
  // the opener of the current opening; kept across StrictMode's unmount/remount of the same opening
  const opener = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const layer: Layer = { el, also: () => (opts.current.also ?? []).map((r) => r.current).filter((x): x is HTMLElement => !!x) }
    const ok = (c: Element | null | undefined): c is HTMLElement => c instanceof HTMLElement && c !== document.body && c.isConnected && !within(layer, c)
    if (!ok(opener.current)) opener.current = [document.activeElement, rendered, ...[...recent].reverse()].find(ok) ?? null
    const id = stack.push(layer)
    recompute()
    const want = opts.current.initialFocus?.current
    if (want) want.focus({ preventScroll: true })
    else if (!el.contains(document.activeElement)) focusSelf(el)
    return () => {
      const wasTop = stack.remove(id)
      recompute()
      // after the commit: React puts back whatever had focus before a commit once its mutations are done, so focus
      // moved inside this cleanup would be undone
      queueMicrotask(() => {
        // StrictMode (or a quick re-open) mounted the same dialog again: it keeps focus and its opener
        if (stack.has((l) => l.el === el)) return
        const from = opener.current
        opener.current = null
        const restore = opts.current.restoreFocus ?? true
        if (!wasTop || restore === false) return
        const target = typeof restore === 'function' ? restore(from) : from
        // only when focus is still ours to give: in the closing dialog, or nowhere
        const now = document.activeElement
        const ours = !now || now === document.body || el.contains(now) || !now.isConnected
        if (target && target.isConnected && ours) target.focus({ preventScroll: true })
      })
    }
    // re-run only when the dialog opens or closes; options are read through opts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref])
}
