// @vitest-environment node
/**
 * The Canvas outline's own button, pressed on real ReactDOM (the MiniDOM). The outline shows while it holds focus, so
 * closing it has to leave focus outside it: Back to canvas (and Close, once the toolbar opened it) and Escape always
 * close it, even when the board's first tab stop can't take focus. A tester on v0.31 (Lisbon, 16 Nov): "The 'Back to
 * canvas' does nothing when clicked, and this takes up 1/3 of the screen all the time".
 *
 * For this file the MiniDOM's elements get the few selectors the outline uses (tag, .class, [attr], [attr="v"],
 * descendants and lists) and the browser's rule that a disabled control, or anything under an inert or hidden
 * element, refuses focus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode, press, reactProps } from '../../ui/miniDom.testkit'
import { BoardOutline } from './BoardOutline'
import type { Outline } from './outline'

type Compound = { tag: string | null; classes: string[]; attrs: [string, string | null][] }

// One compound selector, such as button[data-x="1"].on; anything else this file doesn't use is refused loudly.
function compound(text: string): Compound {
  const out: Compound = { tag: null, classes: [], attrs: [] }
  const rest = text.replace(/^[a-z][a-z0-9-]*/i, (t) => { out.tag = t.toUpperCase(); return '' })
    .replace(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g, (_m, cls: string, attr: string, value: string | undefined) => {
      if (cls) out.classes.push(cls)
      else out.attrs.push([attr, value ?? null])
      return ''
    })
  if (rest) throw new Error(`selector part this test doesn't support: ${text}`)
  return out
}
const parse = (selector: string) => selector.split(',').map((one) => one.trim().split(/\s+/).map(compound))
function fits(n: MiniNode, c: Compound): boolean {
  if (n.nodeType !== 1 || (c.tag && n.nodeName !== c.tag)) return false
  const classes = (n.getAttribute('class') ?? '').split(/\s+/)
  return c.classes.every((x) => classes.includes(x)) && c.attrs.every(([k, v]) => n.hasAttribute(k) && (v === null || n.getAttribute(k) === v))
}
// a descendant chain: the last part is the node, each earlier part some ancestor above the one after it
function chain(n: MiniNode, parts: Compound[]): boolean {
  if (!fits(n, parts[parts.length - 1])) return false
  let at: MiniNode | null = n.parentNode
  for (let i = parts.length - 2; i >= 0; i--) {
    while (at && !fits(at, parts[i])) at = at.parentNode
    if (!at) return false
    at = at.parentNode
  }
  return true
}
const matches = (n: MiniNode, selector: string) => parse(selector).some((parts) => chain(n, parts))
function refusesFocus(n: MiniNode): boolean {
  if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(n.nodeName) && n.hasAttribute('disabled')) return true
  for (let p: MiniNode | null = n; p; p = p.parentNode) if (p.nodeType === 1 && (p.hasAttribute('inert') || p.hasAttribute('hidden'))) return true
  return false
}
function closestFrom(n: MiniNode, s: string): MiniNode | null {
  for (let p: MiniNode | null = n; p; p = p.parentNode) if (matches(p, s)) return p
  return null
}
const kit = {
  matches(this: MiniNode, s: string) { return matches(this, s) },
  closest(this: MiniNode, s: string) { return closestFrom(this, s) },
  querySelectorAll(this: MiniNode, s: string) { return this.findAll((n) => matches(n, s)) },
  querySelector(this: MiniNode, s: string) { return this.findAll((n) => matches(n, s))[0] ?? null },
  focus(this: MiniNode) { if (!refusesFocus(this)) this.ownerDocument.activeElement = this },
}
const proto = MiniNode.prototype as unknown as Record<string, unknown>
const before = Object.fromEntries(Object.keys(kit).map((k) => [k, proto[k]]))

const OUTLINE: Outline = { decisions: [], groups: [], count: 0 }
const noop = () => undefined
let doc: MiniDocument
let root: Root
let saved: Record<string, unknown>

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = Object.fromEntries(['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT'].map((k) => [k, g[k]]))
  Object.assign(MiniNode.prototype, kit)
  doc = new MiniDocument()
  const media = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop })
  // React DOM's focus tracking asks whether the active element is an iframe
  const win = { document: doc, HTMLIFrameElement: class {}, innerWidth: 1280, innerHeight: 800, location: { hash: '#/', search: '' }, matchMedia: media, addEventListener: noop, removeEventListener: noop }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  const container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  Object.assign(MiniNode.prototype, before)
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
  vi.restoreAllMocks()
})

/** The canvas around the outline: its board (a tab stop the arrangement may have put away, then a swarm) and the toolbar's outline button. */
async function canvas(opts: { open: boolean; firstAway?: boolean; boardAway?: boolean; toolbarOff?: boolean }) {
  const onClose = vi.fn()
  await act(async () => root.render(createElement('div', { className: 'cv-root' },
    createElement(BoardOutline, { outline: OUTLINE, open: opts.open, onClose, onLocate: noop, onInspect: noop, onDecideGoal: noop, onTalk: noop, onAddGoal: noop }),
    createElement('div', { className: 'cv-world', hidden: opts.boardAway || undefined },
      createElement('div', { 'data-item': 'goal:put-away', tabIndex: 0, inert: opts.firstAway || undefined }, 'A task the arrangement put away'),
      createElement('div', { 'data-item': 'island:s1', tabIndex: 0 }, 'Lyra')),
    createElement('button', { 'data-cv-outline-btn': '', disabled: opts.toolbarOff || undefined }, 'Canvas outline'))))
  const nav = doc.body.findAll((n) => matches(n, '.cv-outline'))[0]
  const button = nav.findAll((n) => n.nodeName === 'BUTTON')[0]
  const item = (key: string) => doc.body.findAll((n) => n.getAttribute('data-item') === key)[0]
  const toolbar = doc.body.findAll((n) => n.hasAttribute('data-cv-outline-btn'))[0]
  button.focus()   // reached by Tab: the outline holds focus, so it shows
  expect(nav.contains(doc.activeElement)).toBe(true)
  return { onClose, nav, button, item, toolbar }
}

describe('the Canvas outline closes from its own button', () => {
  it('Back to canvas moves focus on to the board, past a tab stop that refuses it', async () => {
    const c = await canvas({ open: false, firstAway: true })
    expect(c.button.textContent).toBe('Back to canvas')
    await act(async () => press(c.button))
    expect(c.onClose).toHaveBeenCalledTimes(1)
    expect(doc.activeElement).toBe(c.item('island:s1'))
    expect(c.nav.contains(doc.activeElement)).toBe(false)
  })

  it('Back to canvas takes the first thing on the board when it can take focus', async () => {
    const c = await canvas({ open: false })
    await act(async () => press(c.button))
    expect(doc.activeElement).toBe(c.item('goal:put-away'))
  })

  it('Back to canvas falls back to the toolbar button when nothing on the board takes focus', async () => {
    const c = await canvas({ open: false, boardAway: true })
    await act(async () => press(c.button))
    expect(doc.activeElement).toBe(c.toolbar)
  })

  it('Back to canvas lets focus go when nothing can take it, so the outline still closes', async () => {
    const c = await canvas({ open: false, boardAway: true, toolbarOff: true })
    await act(async () => press(c.button))
    expect(c.onClose).toHaveBeenCalledTimes(1)
    expect(c.nav.contains(doc.activeElement)).toBe(false)
  })

  it('Close, once the toolbar opened it, returns focus to the toolbar button', async () => {
    const c = await canvas({ open: true, firstAway: true })
    expect(c.button.textContent).toBe('Close')
    await act(async () => press(c.button))
    expect(c.onClose).toHaveBeenCalledTimes(1)
    expect(doc.activeElement).toBe(c.toolbar)
  })

  it('Escape inside the outline closes it the same way', async () => {
    const c = await canvas({ open: false, firstAway: true })
    await act(async () => {
      (reactProps(c.nav).onKeyDown as (e: unknown) => void)({ key: 'Escape', preventDefault: noop, stopPropagation: noop, currentTarget: c.nav, target: c.button })
    })
    expect(c.onClose).toHaveBeenCalledTimes(1)
    expect(doc.activeElement).toBe(c.item('island:s1'))
  })
})
