import { describe, expect, it } from 'vitest'
import { translate } from './draftOps'
import type { Scene } from './model'
import { apply as nativeApply, initial } from './native/scene.mjs'

// Piece 2's seam: the Phase 2a qualified vocabulary (contract r3 §1, §3.3) as this canvas's native changes. INVENTED scene.

const scene = (): Scene => ({
  schema: 'omega-scene-1',
  id: 'scene-x',
  title: 'Invented',
  width: 1000,
  height: 600,
  background: '#FFFFFF',
  criteria: [],
  elements: [{ id: 'mine', kind: 'text', x: 10, y: 10, width: 300, height: 60, text: 'Hello', fontSize: 30, color: '#111111', weight: 'normal' }],
})
const owned = new Map([['title', 'ask-title'], ['gone', 'ask-gone']])
const withOwned = (): Scene => {
  const s = scene()
  s.elements.push({ id: 'ask-title', kind: 'text', x: 100, y: 100, width: 400, height: 80, text: 'Hi', fontSize: 40, color: '#222222', weight: 'bold' })
  s.elements.push({ id: 'ask-box', kind: 'rect', x: 0, y: 300, width: 200, height: 100, fill: '#AA3300', radius: 10 })
  return s
}
const ownedBox = new Map([...owned, ['box', 'ask-box']])

describe('qualified draft ops → native changes', () => {
  it('add-shape and add-text need exact absence and the full native shape, inside the artboard', async () => {
    const s = scene()
    const t = translate(s, new Map(), 'add-shape', { id: 'band', kind: 'rect', x: 0, y: 0, width: 1000, height: 20, fill: '#C8553D', absent: true })
    expect(t).toEqual({ kind: 'change', change: { op: 'add', element: 'ask-band', value: { id: 'ask-band', kind: 'rect', x: 0, y: 0, width: 1000, height: 20, fill: '#C8553D' } }, owns: { logical: 'band', native: 'ask-band' } })
    const root = await initial(s)
    if (t.kind === 'change') expect((await nativeApply(root, root.digest, [t.change])).scene.elements).toHaveLength(2)   // Design's own apply accepts it
    expect(translate(s, new Map(), 'add-text', { id: 'line', x: 0, y: 0, width: 100, height: 40, text: 'Hi', fontSize: 20, color: '#000000', weight: 'bold', absent: true })).toMatchObject({ kind: 'change', change: { op: 'add', value: { kind: 'text', text: 'Hi' } } })
    expect(translate(s, new Map(), 'add-shape', { id: 'band', kind: 'rect', x: 900, y: 0, width: 200, height: 20, fill: '#C8553D', absent: true })).toEqual({ kind: 'refused', reason: 'out-of-bounds' })
    expect(translate(s, new Map(), 'add-shape', { id: 'band', kind: 'rect', x: 0, y: 0, width: 20, height: 20, fill: '#C8553D', radius: 11, absent: true })).toEqual({ kind: 'refused', reason: 'out-of-bounds' })
    expect(translate(s, owned, 'add-text', { id: 'title', x: 0, y: 0, width: 100, height: 40, text: 'Hi', fontSize: 20, color: '#000000', weight: 'bold', absent: true })).toEqual({ kind: 'refused', reason: 'precondition' })
    expect(translate(s, new Map(), 'add-shape', { id: 'band', kind: 'ellipse', x: 0, y: 0, width: 20, height: 20, fill: '#C8553D', absent: true })).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(translate(s, new Map(), 'add-shape', { id: 'band', kind: 'rect', x: 0, y: 0, width: 20, height: 20, fill: 'red', absent: true })).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(translate(s, new Map(), 'add-shape', { id: 'Band!', kind: 'rect', x: 0, y: 0, width: 20, height: 20, fill: '#C8553D', absent: true })).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(translate(s, new Map(), 'add-text', { id: 'l', x: 0, y: 0, width: 100, height: 40, text: 'a\u0007b', fontSize: 20, color: '#000000', weight: 'bold', absent: true })).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(translate(s, new Map(), 'add-text', { id: 'l', x: 0, y: 0, width: 100, height: 40, text: 'a\nb', fontSize: 20, color: '#000000', weight: 'bold', absent: true, extra: 1 })).toEqual({ kind: 'refused', reason: 'invalid' })
    const full = scene()
    full.elements = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, kind: 'rect' as const, x: 0, y: 0, width: 1, height: 1, fill: '#000000' }))
    expect(translate(full, new Map(), 'add-shape', { id: 'one', kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#000000', absent: true })).toEqual({ kind: 'refused', reason: 'limit' })
  })
  it('set-element changes only stream-owned elements, with the exact prior value of each field it sets, fitting the kind', () => {
    const s = withOwned()
    expect(translate(s, ownedBox, 'set-element', { id: 'title', prior: { fontSize: 40 }, value: { fontSize: 48 } })).toEqual({ kind: 'change', change: { op: 'set', element: 'ask-title', patch: { fontSize: 48 } } })
    expect(translate(s, ownedBox, 'set-element', { id: 'title', prior: { fontSize: 39 }, value: { fontSize: 48 } })).toEqual({ kind: 'refused', reason: 'precondition' })
    expect(translate(s, ownedBox, 'set-element', { id: 'title', prior: { fill: '#000000' }, value: { fill: '#FFFFFF' } })).toEqual({ kind: 'refused', reason: 'invalid' })   // fill is not a text field
    expect(translate(s, ownedBox, 'set-element', { id: 'box', prior: { color: '#000000' }, value: { color: '#FFFFFF' } })).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(translate(s, ownedBox, 'set-element', { id: 'title', prior: { x: 100 }, value: { x: 700 } })).toEqual({ kind: 'refused', reason: 'out-of-bounds' })
    expect(translate(s, ownedBox, 'set-element', { id: 'box', prior: { height: 100 }, value: { height: 10 } })).toEqual({ kind: 'refused', reason: 'out-of-bounds' })   // radius 10 > 10/2
    expect(translate(s, ownedBox, 'set-element', { id: 'title', prior: { x: 100, y: 100 }, value: { x: 120 } })).toEqual({ kind: 'refused', reason: 'invalid' })   // same keys
    expect(translate(s, ownedBox, 'set-element', { id: 'gone', prior: { x: 1 }, value: { x: 2 } })).toEqual({ kind: 'refused', reason: 'unknown-element' })
    expect(translate(s, ownedBox, 'set-element', { id: 'mine', prior: { x: 10 }, value: { x: 20 } })).toEqual({ kind: 'refused', reason: 'unknown-element' })   // the person's own element is not the stream's
  })
  it('select-element and cursor resolve only through stream-owned, live elements; cursor is artboard-normalised', () => {
    const s = withOwned()
    expect(translate(s, ownedBox, 'select-element', { id: 'title' })).toEqual({ kind: 'select', native: 'ask-title' })
    expect(translate(s, ownedBox, 'select-element', { id: 'gone' })).toEqual({ kind: 'refused', reason: 'unknown-element' })
    expect(translate(s, ownedBox, 'cursor', { x: 0.5, y: 0.25, caption: 'Warming the headline', near: 'title' })).toEqual({ kind: 'cursor', x: 0.5, y: 0.25, caption: 'Warming the headline', near: 'ask-title' })
    expect(translate(s, ownedBox, 'cursor', { x: 0.5, y: 0.25, near: 'mine' })).toEqual({ kind: 'cursor', x: 0.5, y: 0.25 })
    expect(translate(s, ownedBox, 'cursor', { x: 1.5, y: 0 })).toEqual({ kind: 'refused', reason: 'invalid' })
    expect(translate(s, ownedBox, 'cursor', { x: 0, y: 0, caption: 'x'.repeat(121) })).toEqual({ kind: 'refused', reason: 'invalid' })
  })
  it('refuses anything outside the qualified vocabulary', () => {
    for (const op of ['remove-element', 'add-image', 'revert', 'narrate', 'set-background']) expect(translate(scene(), owned, op, { id: 'x' })).toEqual({ kind: 'refused', reason: 'invalid' })
  })
})
