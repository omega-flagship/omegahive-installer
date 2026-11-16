import { describe, expect, it } from 'vitest'
import { placeAsk } from '../features/ask/placement'
import { askRoom } from '../features/ask/askRoom'
import { ASK_RESERVE, coveredBy, openOverlays, registerOverlay } from './overlays'
import navSource from '../shell/Nav.tsx?raw'
import menuSource from '../shell/NavMenu.tsx?raw'
import sheetSource from './Sheet.tsx?raw'
import viewInfoSource from '../tour/ViewInfo.tsx?raw'

// vitest hands CSS imports back empty: read the file itself (the same way experiences/ask.test.ts does)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const askCss = fs.readFileSync(new URL('../features/ask/ask.css', import.meta.url), 'utf8')

/** A stand-in element: `contains` is all coveredBy and the registry use. */
const el = (kids: unknown[] = []) => ({ contains: (n: unknown) => kids.includes(n) }) as unknown as HTMLElement

describe('an open phone sheet keeps the Ask’s room clear at its bottom (classic nav regression)', () => {
  it('reserves the safe area plus the Ask’s room', () => {
    expect(ASK_RESERVE).toBe('calc(var(--sab, 0px) + var(--ask-room, 0px))')
  })
  it('the room the Ask reports is taller than the Ask itself, on the hive and on a page with the tab bar', () => {
    // AskHost reports askRoom() as --ask-room (features/ask/askRoom, r5.1): place.bottom + 64; the capsule is 54px at rest
    // (ask.css .ask-capsule min-height)
    const capsule = Number(/\.ask-capsule \{[^}]*min-height: (\d+)px/.exec(askCss)![1])
    expect(capsule).toBeLessThanOrEqual(64)
    for (const page of [false, true]) {
      const p = placeAsk({ width: 390, height: 844, layout: 'rail', page, tabBar: true, omegaRight: null })
      const room = askRoom(p, false, 0)
      expect(room).toBe(p.bottom + 64)
      // the sheet's content ends at the reserve, above the capsule's top
      expect(room).toBeGreaterThanOrEqual(p.bottom + capsule)
    }
  })
  it('the More sheet and every phone sheet end their content at the reserve', () => {
    expect(navSource).toContain('paddingBottom: `calc(${ASK_RESERVE} + 8px)`')
    // ...and never less than the OS clock's lift (shell/osClock.css), which sits over the sheet's bottom-right corner
    // ...and above what the Ask opened under its field while it is open (mind-chat r1, features/ask/popDismiss)
    expect(sheetSource).toContain('style={{ height: `max(${ASK_RESERVE}, var(--os-clock-lift, 0px), var(--xc-omega-floor, 0px), var(--ask-pop-room, 0px))` }}')
    expect(sheetSource).toContain('bottom: `max(12px, var(--os-clock-lift, 0px), ${ASK_RESERVE}, var(--ask-pop-room, 0px))`')
  })
})

describe('first-visit hints wait while a sheet or menu they are not part of is open', () => {
  it('registers and unregisters open overlays', () => {
    const a = el()
    const off = registerOverlay(a)
    expect(openOverlays()).toContain(a)
    off()
    expect(openOverlays()).not.toContain(a)
  })
  it('an overlay covers a hint outside it, never one inside it', () => {
    const btn = {} as Node
    expect(coveredBy([], btn)).toBe(false)
    expect(coveredBy([el()], btn)).toBe(true)
    expect(coveredBy([el([btn])], btn)).toBe(false)
  })
  it('the More sheet, the nav menu and phone sheets register; the hint waits on them', () => {
    expect(navSource).toContain('useOverlay(ref)')
    expect(menuSource).toContain('useOverlay(menu)')
    expect(sheetSource).toContain('useOverlay(ref)')
    expect(viewInfoSource).toContain('const covered = useCovered(btn)')
    expect(viewInfoSource).toContain('const hintShown = hint && !busy && !covered')
  })
})
