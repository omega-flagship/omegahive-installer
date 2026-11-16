import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { closesPop, closesScopedPop, popRoom, POP_GAP } from './popDismiss'
import { PanelView } from './ClassicAsk'
import classicSource from './ClassicAsk.tsx?raw'
import fieldSource from './useAskField.ts?raw'
import chooserSource from './AnswererPicker.tsx?raw'
import dotSource from '../dot/DotPanel.tsx?raw'

// mind-chat r1 item 1: a "Did you mean…" panel sat over a mind's chat and composer, with no visible way to close it.
describe('what the Ask opens under its field never covers a mind chat, and always closes', () => {
  it('Esc closes it wherever focus is; typing outside the Ask (a mind composer) closes it; typing in the Ask does not', () => {
    expect(closesPop({ type: 'keydown', key: 'Escape' }, false)).toBe(true)
    expect(closesPop({ type: 'keydown', key: 'Escape' }, true)).toBe(true)
    expect(closesPop({ type: 'keydown', key: 'a' }, false)).toBe(false)
    expect(closesPop({ type: 'input' }, false)).toBe(true)
    expect(closesPop({ type: 'input' }, true)).toBe(false)
    expect(closesPop({ type: 'click' }, false)).toBe(false)
  })
  it('a mind panel sharing its column ends its content above it; one beside it (a wide desk) is left alone', () => {
    const vh = 900
    const pop = { left: 400, right: 1040, top: 520 }
    // desktop side panel 988..1428: shares the column 988..1040, so its chat ends above the panel's top
    expect(popRoom(pop, { left: 988, right: 1428, top: 200, bottom: 800 }, vh)).toBe(vh - 520 + POP_GAP)
    // a panel entirely to the right of the Ask: nothing moves
    expect(popRoom(pop, { left: 1060, right: 1428, top: 200, bottom: 800 }, vh)).toBe(0)
    // no mind panel open: nothing moves
    expect(popRoom(pop, null, vh)).toBe(0)
    // a phone: the sheet spans the width
    expect(popRoom({ left: 10, right: 380, top: 500 }, { left: 0, right: 390, top: 150, bottom: 780 }, 844)).toBe(844 - 500 + POP_GAP)
  })
  it('the policy panel ("Did you mean…") carries a visible close that empties it', () => {
    let closed: unknown = 'open'
    const f = { panel: { kind: 'choose', options: [] }, value: 'make it calm', answerer: undefined, setPanel: (p: unknown) => (closed = p) } as unknown as Parameters<typeof PanelView>[0]['f']
    const html = renderToStaticMarkup(createElement(PanelView, { f }))
    expect(html).toContain('Did you mean')
    expect(html).toMatch(/<button[^>]*class="ask-pop-close"[^>]*aria-label="Close this"/)
    expect(closed).toBe('open')
  })
  it('is wired: the field closes on Esc and typing elsewhere, the capsule makes room, the mind panel is marked', () => {
    expect(fieldSource).toContain('usePopDismiss(!!panel, () => setPanel(null))')
    expect(chooserSource).toContain('usePopDismiss(open, (event) =>')
    expect(chooserSource).toContain('}, owner)')
    expect(chooserSource).toContain('ref={owner} className="ask-scoped-answerer"')
    expect(classicSource).toContain('root.style.setProperty(POP_ROOM_VAR')
    expect(classicSource).toContain('ref={popRef} className="ask-pop"')
    expect(dotSource).toContain('data-mind-panel-body=""')
  })
})

describe('scoped chooser dismissal behaviour', () => {
  it('Escape closes from any focus location', () => {
    expect(closesScopedPop({ type: 'keydown', key: 'Escape' }, false, false)).toBe(true)
    expect(closesScopedPop({ type: 'keydown', key: 'Escape' }, true, true)).toBe(true)
  })
  it('typing outside Ask closes; typing in its field does not', () => {
    expect(closesScopedPop({ type: 'input' }, false, false)).toBe(true)
    expect(closesScopedPop({ type: 'input' }, true, false)).toBe(false)
  })
  it('pointer outside closes even inside Ask; pointer inside chooser leaves choice and footer usable', () => {
    expect(closesScopedPop({ type: 'pointerdown' }, false, false)).toBe(true)
    expect(closesScopedPop({ type: 'pointerdown' }, true, false)).toBe(true)
    expect(closesScopedPop({ type: 'pointerdown' }, true, true)).toBe(false)
  })
})
