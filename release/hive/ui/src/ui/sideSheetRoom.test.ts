import { afterEach, describe, expect, it } from 'vitest'
import { SIDE_SHEET_ATTR, SIDE_SHEET_VAR, resetSideSheetRooms, setSideSheetRoom, type SideSheetRoot } from './sideSheetRoom'
import sheetSource from './Sheet.tsx?raw'

// vitest hands CSS imports back empty: read the file itself (the same way ui/overlays.test.ts does)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const indexCss = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')
const askCss = fs.readFileSync(new URL('../features/ask/ask.css', import.meta.url), 'utf8')

/** A stand-in <html>: the attributes and custom properties the helper sets. */
function root() {
  const attrs = new Map<string, string>()
  const props = new Map<string, string>()
  const r: SideSheetRoot = {
    setAttribute: (k, v) => void attrs.set(k, v),
    removeAttribute: (k) => void attrs.delete(k),
    style: { setProperty: (k, v) => void props.set(k, v), removeProperty: (k) => (props.delete(k), '') },
  }
  return { r, attrs, props }
}

afterEach(() => resetSideSheetRooms())

describe('toasts keep clear of an open desktop side sheet (pr-79 #16: the privacy note over the feedback form)', () => {
  it('an open side sheet publishes the room it takes on the root', () => {
    const { r, attrs, props } = root()
    setSideSheetRoom('a', 452, r)
    expect(attrs.has(SIDE_SHEET_ATTR)).toBe(true)
    expect(props.get(SIDE_SHEET_VAR)).toBe('452px')
  })

  it('with two open, the wider one wins; the last to close clears it', () => {
    const { r, attrs, props } = root()
    setSideSheetRoom('a', 452, r)
    setSideSheetRoom('b', 600.4, r)
    expect(props.get(SIDE_SHEET_VAR)).toBe('601px')
    setSideSheetRoom('b', null, r)
    expect(props.get(SIDE_SHEET_VAR)).toBe('452px')
    setSideSheetRoom('a', null, r)
    expect(attrs.has(SIDE_SHEET_ATTR)).toBe(false)
    expect(props.has(SIDE_SHEET_VAR)).toBe(false)
  })

  it('a room that cannot be measured counts as closed', () => {
    const { r, attrs } = root()
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      setSideSheetRoom('a', bad, r)
      expect(attrs.has(SIDE_SHEET_ATTR)).toBe(false)
    }
  })

  it('on desktop the toast stack stands left of that room', () => {
    expect(indexCss).toMatch(
      /@media \(min-width: 768px\) \{\s*html\[data-side-sheet\] \.toast-stack \{ right: var\(--side-sheet-room, 0px\); \}\s*\}/,
    )
  })

  it('the desktop Sheet reports its room with the same 8 px gap as its scene inset, and clears it when it closes', () => {
    expect(sheetSource).toContain('setSideSheetRoom(id, desktop ? window.innerWidth - r.left + 8 : null)')
    expect(sheetSource).toContain('setInset(id, { right: window.innerWidth - r.left + 8 })')
    expect(sheetSource).toContain('setSideSheetRoom(id, null)')
  })

  // ask.css loads after index.css with the same specificity: its rules must give way to a wider side sheet (QA N1)
  it('with the Ask pinned, the toast stack still stands left of a wider side sheet', () => {
    expect(askCss).toMatch(
      /html\[data-ask-side='desktop'\] \.toast-stack \{\s*right: max\(404px, var\(--side-sheet-room, 0px\)\);\s*\}/,
    )
    expect(askCss).toMatch(
      /html\[data-ask-side='landscape'\] \.toast-stack \{\s*right: max\(50vw, var\(--side-sheet-room, 0px\)\);\s*\}/,
    )
  })
})
