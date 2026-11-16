import { describe, expect, it } from 'vitest'
import { ASK_RESERVE } from '../ui/overlays'
import { askRoom, askRoomFor, HALF_GAP, setAskRoom } from '../features/ask/askRoom'
import { useScene } from '../scene/sceneStore'
import cosmosPanels from './cosmos/Panels.tsx?raw'
import cosmosDeck from './cosmos/Deck.tsx?raw'
import fluxSheets from './flux/sheets.tsx?raw'
import boardOutline from './canvas/BoardOutline.tsx?raw'
import ambient from '../shell/Ambient.tsx?raw'
import stillReading from './still/Reading.tsx?raw'
import fluxPanels from './flux/panels.tsx?raw'
import professionalIndex from './professional/index.tsx?raw'
import dotPanel from '../features/dot/DotPanel.tsx?raw'
import sheet from '../ui/Sheet.tsx?raw'
import changeUi from '../shell/ChangeUi.tsx?raw'
import askHost from '../features/ask/AskHost.tsx?raw'
import messagesPage from '../features/messages/MessagesPage.tsx?raw'

// vitest hands CSS imports back empty: read the file itself (the same way ui/overlays.test.ts does)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const professionalCss = fs.readFileSync(new URL('./professional/styles.css', import.meta.url), 'utf8')
const professionalPhasesCss = fs.readFileSync(new URL('./professional/phases.css', import.meta.url), 'utf8')
const askCss = fs.readFileSync(new URL('../features/ask/ask.css', import.meta.url), 'utf8')
const indexCss = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** The source of one top-level function, from its declaration to the next top-level declaration. */
function fn(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?function ${name}\\b`, 'm'))
  expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0)
  const rest = src.slice(start + 1)
  const next = rest.search(/^(export )?(function|const) /m)
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next)
}

/** The room the shared phone sheet keeps under its content (ui/Sheet): the Ask's reserve, or the OS clock's lift. */
const SHEET_ROOM = 'max(${ASK_RESERVE}, var(--os-clock-lift, 0px))'

describe('every mind panel’s composer ends above the universal Ask (shared clearance, ui/overlays ASK_RESERVE)', () => {
  it('the shared reserve is the safe area plus the room the Ask reports', () => {
    expect(ASK_RESERVE).toBe('calc(var(--sab, 0px) + var(--ask-room, 0px))')
  })

  it('Cosmos: the phone transmission panel reaches the bottom edge, so it keeps the shared sheet room under its composer', () => {
    expect(cosmosPanels).toContain("import { ASK_RESERVE } from '../../ui/overlays'")
    const panel = fn(cosmosPanels, 'MindPanel')
    // the phone panel is bottom-anchored (bottom: 0): without the reserve its composer sits under the Ask capsule
    expect(panel).toMatch(/: \{ left: 0, right: 0, bottom: 0, height: '58%'/)
    expect(panel).toContain(`{!desktop && <div aria-hidden className="shrink-0" data-ask-reserve="" style={{ height: \`${SHEET_ROOM}\` }} />}`)
    // the reserve comes after the composer (Comms is the last thing before it in the panel)
    expect(panel.indexOf('data-ask-reserve')).toBeGreaterThan(panel.indexOf("{tab === 'vitals' && <Vitals"))
    // the composer itself does not hand-roll a second room
    expect(fn(cosmosPanels, 'Comms')).not.toContain('--ask-room')
  })

  it('Cosmos: the panel’s other tabs no longer hand-roll the Ask room (one source: the panel’s reserve)', () => {
    for (const name of ['SwarmBeliefs', 'Log', 'Vitals']) expect(fn(cosmosPanels, name), name).not.toContain('--ask-room')
  })

  it('Still: the reading room’s composer ends above the floating line that takes over while the room covers Still’s own box', () => {
    expect(stillReading).toContain("import { ASK_RESERVE } from '../../ui/overlays'")
    expect(stillReading).toContain('<div className="st-compose-wrap" style={{ paddingBottom: `max(18px, ${ASK_RESERVE})` }}>')
  })

  it('Flux: the phone mind panel ends above the Ask room', () => {
    const geo = fn(fluxPanels, 'usePanelGeometry')
    expect(geo).toContain('bottom-[calc(max(76px,var(--ask-room,0px))+var(--sab,0px))]')
    expect(fn(fluxPanels, 'MindPanel')).toContain('const geo = usePanelGeometry()')
  })

  it('Messages: on a phone the room panel reaches the bottom edge, so it keeps the shared sheet room under its content', () => {
    expect(messagesPage).toContain("import { ASK_RESERVE } from '../../ui/overlays'")
    const panel = fn(messagesPage, 'Conversation')
    // the panel is absolute from top to bottom below md: without the reserve its last buttons sit under the Ask
    expect(panel).toContain('max-md:absolute max-md:inset-y-0')
    expect(panel).toContain(`<div aria-hidden className="md:hidden" data-ask-reserve="" style={{ height: \`${SHEET_ROOM}\` }} />`)
    // the reserve is the panel's last child, after whichever settings it shows
    expect(panel.indexOf('data-ask-reserve')).toBeGreaterThan(panel.indexOf('<RoomSettings room={room}'))
  })

  it('Classic: the mind panel is the shared Sheet', () => {
    expect(dotPanel).toContain("import { Sheet } from '../../ui/Sheet'")
    expect(dotPanel).toMatch(/<Sheet label=\{`\$\{shown\(agent\.name\)\} panel`\}/)
    // ...and, while the Ask has something open under its field, above that too (mind-chat r1, features/ask/popDismiss)
    expect(sheet).toContain('style={{ height: `max(${ASK_RESERVE}, var(--os-clock-lift, 0px), var(--xc-omega-floor, 0px), var(--ask-pop-room, 0px))` }}')
  })

  it('Professional: the conversation sits in the workspace, which pads its scroll past the Ask room', () => {
    expect(professionalIndex).toMatch(/<main id="pr-main"[^>]*className="pr-main"/)
    expect(professionalCss).toMatch(/\.pr-main \{[^}]*var\(--ask-room,0px\)/)
  })
})

describe('a sheet’s bottom row (the Change UI gallery’s sticky Keep footer) ends above the universal Ask, in every experience', () => {
  it('desktop: the side sheet ends above the Ask’s room, not only above the OS clock (the Ask spans the bottom centre)', () => {
    expect(sheet).toContain("style={{ width, bottom: `max(12px, var(--os-clock-lift, 0px), ${ASK_RESERVE}, var(--ask-pop-room, 0px))` }}")
  })

  it('phone: inside an experience the dress keeps Ω’s corner as a floor, never a fixed height in place of the Ask’s room', () => {
    expect(indexCss).not.toMatch(/\.xc-omega-spacer \{[^}]*height:/)
    expect(indexCss).toContain('html[data-xc-active] .xc-dress .xc-omega-spacer { --xc-omega-floor: calc(48px + var(--sab, 0px)); }')
    expect(sheet).toContain('var(--xc-omega-floor, 0px), var(--ask-pop-room, 0px))` }}')
  })

  it('Change experience: the gallery body is the sheet’s scroller, so its sticky footer sticks above the sheet’s reserve, not at its edge', () => {
    const body = /<Sheet label="Change experience"[^\n]*\n(?:\s*\{\/\*[\s\S]*?\*\/\}\n)?\s*<div className="([^"]*)" data-tour="change-ui">/.exec(changeUi)
    expect(body, 'the gallery body').not.toBeNull()
    for (const c of ['min-h-0', 'flex-1', 'overflow-y-auto']) expect(body![1].split(' '), c).toContain(c)
    // the Keep footer is a sticky row inside that body
    expect(changeUi.indexOf('data-tour="change-ui"')).toBeLessThan(changeUi.indexOf('className="sticky bottom-0'))
  })

  it('every experience’s floating Ask reports its room while it shows (AskHost), so each sheet’s reserve follows it', () => {
    // Every floating dock reports its actual height plus its gap, with a 64px minimum; Professional keeps 12px.
    expect(askRoom({ bottom: 18 }, false, 0)).toBe(18 + 64)
    expect(askRoom({ bottom: 74 }, false, 500)).toBe(74 + 500 + 8)
    expect(askRoom({ bottom: 18 }, true, 40)).toBe(18 + 64)
    expect(askRoom({ bottom: 18 }, true, 120)).toBe(18 + 120 + 12)
    // reported where it is read: --ask-room and the hive map's "ask" inset, the same value; cleared from both
    const props = new Map<string, string>()
    const root = { style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => (props.delete(k), '') } }
    for (const [isPro, h] of [[false, 0], [true, 120]] as const) {
      const room = askRoom({ bottom: 86 }, isPro, h)
      setAskRoom(root, room)
      expect(props.get('--ask-room')).toBe(`${room}px`)
      expect(useScene.getState().insetSources.ask).toEqual({ bottom: room })
      setAskRoom(root, null)
      expect(props.has('--ask-room')).toBe(false)
      expect(useScene.getState().insetSources.ask).toBeUndefined()
    }
    // The native command prompt reports its measured room; floating fields report askRoom(). With neither owner,
    // and on cleanup, both the CSS reserve and scene inset are cleared by the same helper.
    expect(askHost).toContain("const nativeConstruct = !inApp && skin === 'command-line' && constructPlace === 'native' && ownLive")
    expect(askHost).toContain("useOwnReservation(nativeConstruct ? '.cx-cmd' : null)")
    expect(askHost).toContain('const room = nativeReservation ? { bottom: nativeReservation.room, left: 0 } : askRoomFor(region, place, isPro, measuredDockHeight)')
    expect(askHost).toContain('setAskRoom(root, room.bottom, room.left)')
    // a look aligning with the Ask (Professional's home column) aligns with the bubble's row in every size, never with
    // the mark's 44 px or the half column
    expect(askHost).toContain("const row = region === 'bubble' ? place : bubblePlace")
    expect(askHost).toContain("root.style.setProperty('--ask-width', `${nativeReservation?.width ?? row.width}px`)")
    expect(askHost).toMatch(/if \(!shown && !nativeReservation\) \{\s*setAskRoom\(root, null\)/)
    expect(askHost).toMatch(/return \(\) => \{\s*setAskRoom\(root, null\)/)
    expect(askHost).not.toMatch(/--ask-room|setInset\(/)
  })
})

describe('the half size’s column takes the left of the screen, and what a look draws there starts right of it (askRoom --ask-room-left)', () => {
  it('the column takes the left to its right edge and its gap, and nothing at the foot, since its field is inside it', () => {
    expect(askRoomFor('half-left', { bottom: 18, left: 236, width: 578 }, false, 80)).toEqual({ bottom: 0, left: 236 + 578 + HALF_GAP })
    expect(askRoomFor('half-left', { bottom: 18, left: 216, width: 594 }, true, 0)).toEqual({ bottom: 0, left: 216 + 594 + HALF_GAP })
    // every other region is a dock across the foot (or the mark there), and takes no room on the left
    for (const region of ['bubble', 'mark', 'sheet']) expect(askRoomFor(region, { bottom: 86, left: 60, width: 44 }, false, 0), region).toEqual({ bottom: askRoom({ bottom: 86 }, false, 0), left: 0 })
  })

  it('reported once: --ask-room-left and the hive map’s inset agree, and both go when the column goes', () => {
    const props = new Map<string, string>()
    const root = { style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => (props.delete(k), '') } }
    setAskRoom(root, 0, 826)
    expect([props.get('--ask-room'), props.get('--ask-room-left')]).toEqual(['0px', '826px'])
    expect(useScene.getState().insetSources.ask).toEqual({ bottom: 0, left: 826 })
    // back to the bubble: no room on the left, so the variable is absent and var(--ask-room-left, 0px) reads 0
    setAskRoom(root, 82)
    expect(props.has('--ask-room-left')).toBe(false)
    expect(useScene.getState().insetSources.ask).toEqual({ bottom: 82 })
    setAskRoom(root, 0, 826)
    setAskRoom(root, null)
    expect(props.has('--ask-room-left')).toBe(false)
    expect(useScene.getState().insetSources.ask).toBeUndefined()
  })

  it('a page’s window, Professional’s awake home and workspace, and each look’s left panel start right of the column', () => {
    expect(askCss).toMatch(/html\[data-ask-side='half'\] \.xc-page \{\s*left: var\(--ask-room-left, 0px\);/)
    // at rest the Ask is hidden, so the home keeps the whole screen
    expect(professionalPhasesCss).toContain("html[data-ask-side='half']:not([data-shell-phase='rest']) .prh { padding-left: max(20px, var(--ask-room-left, 0px)); }")
    // the workspace starts at the sidebar's edge, where the column starts: it is padded by the column's width and gap
    expect(professionalCss).toContain('html[data-ask-side=half] .pr-workspace { padding-left:max(0px, calc(var(--ask-room-left,0px) - var(--pr-side))); }')
    expect(professionalCss).toContain('grid-template-columns:var(--pr-side) minmax(0,1fr)')
    expect(cosmosDeck).toContain("left: 'max(20px, var(--ask-room-left, 0px))'")
    expect(cosmosPanels).toContain("left: 'calc(50% + var(--ask-room-left, 0px) / 2)', width: 560, marginLeft: -280")
    expect(fluxSheets).toContain('left-[max(20px,var(--ask-room-left,0px))] z-[35] w-[440px]')
    expect(boardOutline).toContain('left-[max(12px,var(--ask-room-left,0px))]')
    expect(ambient).toContain('left-[max(calc(var(--rail-x,84px)+12px),var(--ask-room-left,0px))]')
  })
})
