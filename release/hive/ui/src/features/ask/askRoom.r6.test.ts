import { describe, expect, it } from 'vitest'
import { readAskRoom, setAskRoom } from './askRoom'
import { useScene } from '../../scene/sceneStore'

/**
 * followups-r6 item 1 (Kimi on r5.1): `--ask-room` has ONE writer, setAskRoom, so the CSS value and the hive map's `ask`
 * inset can never drift apart, and code reads it through ONE getter, readAskRoom.
 * The single-writer rule is one invariant over the whole tree, so it is checked by a scan of every source file, read
 * through vite's own `import.meta.glob` keyed from the project root (no node fs): only a scan can see "nobody else
 * writes it".
 */

const SOURCES = import.meta.glob<string>(['/src/**/*.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
const OWN = '/src/features/ask/askRoom.ts'
const SELF = '/src/features/ask/askRoom.r6.test.ts'

/** Any write of the variable: the style API (set or remove), or a style object's key (`{ '--ask-room': … }`). */
const WRITE = /\b(setProperty|removeProperty)\(\s*['"`]--ask-room['"`]|['"`]--ask-room['"`]\s*:/
/** Any code read of it from a style declaration (CSS's own `var(--ask-room, …)` is not a code read). */
const READ = /\bgetPropertyValue\(\s*['"`]--ask-room['"`]/

/** A root whose style behaves like a CSSStyleDeclaration for custom properties. */
function root() {
  const props = new Map<string, string>()
  return {
    props,
    style: {
      setProperty: (k: string, v: string | null) => void props.set(k, String(v)),
      removeProperty: (k: string) => { const v = props.get(k) ?? ''; props.delete(k); return v },
      getPropertyValue: (k: string) => props.get(k) ?? '',
    },
  }
}

describe('followups-r6 item 1: one writer and one reader for --ask-room', () => {
  it('the scan sees the tree (sanity: it finds the writer itself and the known readers)', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(200)
    expect(SOURCES[OWN]).toMatch(WRITE)
    expect(SOURCES[OWN]).toMatch(READ)
  })

  it('no source file but features/ask/askRoom.ts writes --ask-room', () => {
    const writers = Object.entries(SOURCES).filter(([f, src]) => f !== OWN && f !== SELF && WRITE.test(src)).map(([f]) => f)
    expect(writers).toEqual([])
  })

  it('no source file but features/ask/askRoom.ts reads --ask-room from a style declaration: readers use readAskRoom', () => {
    const readers = Object.entries(SOURCES).filter(([f, src]) => f !== OWN && f !== SELF && READ.test(src)).map(([f]) => f)
    expect(readers).toEqual([])
    // the readers r5.1 left reading it directly now go through the getter
    for (const f of ['/src/features/code/canvas/askBridge.ts', '/src/forms/designCanvas/DesignCanvas.tsx', '/src/tour/ViewInfo.tsx']) expect(SOURCES[f], f).toContain('readAskRoom(')
  })

  it('readAskRoom reads exactly what setAskRoom wrote, and 0 once it is cleared; the map inset agrees', () => {
    const r = root()
    expect(readAskRoom(r)).toBe(0)
    setAskRoom(r, 146)
    expect(readAskRoom(r)).toBe(146)
    expect(useScene.getState().insetSources.ask).toEqual({ bottom: 146 })
    setAskRoom(r, 82.5)
    expect(readAskRoom(r)).toBe(82.5)
    setAskRoom(r, null)
    expect(readAskRoom(r)).toBe(0)
    expect(r.props.has('--ask-room')).toBe(false)
    expect(useScene.getState().insetSources.ask).toBeUndefined()
  })
})
