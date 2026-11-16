// Purpose: verify, mounted, that every floating look and Still's floating line draw the region the Ask's screen gives
// the person's size (askScreen.ts): collapsed hides the look's Ask behind the mark and keeps it mounted; half draws the
// thread as the left half's column whether or not it was open, with its switch back in the head and no Pin; a phone's
// half opens the thread full height without its grip; and the Omega at the field's start collapses the Ask.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { mountPage, settle, type MountedPage } from '../views/mountedView.testkit'
import { press, type MiniNode } from '../../ui/miniDom.testkit'
import { useAskStore } from '../../store/ask'
import { FloatingAsk } from './ClassicAsk'
import { StillLine } from './StillLine'
import { askSizeNow, setAskSize } from './askSize'
import type { AskRegion } from './askScreen'
import { setAskOpener } from './askField'
import { fillAsk } from './useAskField'
import type { Placement } from './placement'
import type { FloatingLook } from './skins'
import { SIZE_WORDS } from './words'

let page: MountedPage
const g = globalThis as unknown as Record<string, unknown>
beforeEach(async () => {
  page = await mountPage()
  Object.assign(g.window as Record<string, unknown>, { innerWidth: 1440, innerHeight: 900 })
  g.requestAnimationFrame = (f: (t: number) => void) => { f(0); return 1 }
  g.cancelAnimationFrame = () => undefined
  // a phone's full sheet is modal: its containment asks whether the focused node is an element of the page
  g.HTMLElement = class {}
})
afterEach(async () => {
  delete g.HTMLElement
  await page.restore()
  await act(async () => useAskStore.getState().setThreadOpen(false))
})

const desk: Placement = { mode: 'desktop', bottom: 18, left: 60, width: 666 }
const phone: Placement = { mode: 'phone', bottom: 10, left: 10, width: 370 }
const LOOKS: FloatingLook[] = ['capsule', 'note', 'transmission', 'liquid', 'terminal']
const all = (pred: (n: MiniNode) => boolean) => page.container.findAll(pred)
const byClass = (c: string) => all((n) => (n.getAttribute('class') ?? '').split(' ').includes(c))
const button = (label: string) => all((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === label)

const floating = async (look: FloatingLook, place: Placement, region: AskRegion) => {
  await act(async () => page.root.render(<FloatingAsk place={place} experience="classic" inputRef={createRef<HTMLInputElement>()} look={look} region={region} />))
  await settle()
}

describe('every floating look draws the person’s size (Jon, 16 Nov: "100% the vision")', () => {
  it('collapsed: the look’s Ask stays mounted, hidden behind the mark, its thread not drawn even when open', async () => {
    await act(async () => useAskStore.getState().setThreadOpen(true))
    for (const look of LOOKS) {
      await floating(look, desk, 'mark')
      const dock = byClass('ask-dock')
      expect(dock.length, look).toBe(1)
      expect(dock[0].getAttribute('hidden'), look).not.toBeNull()
      expect(byClass('ask-panel'), look).toEqual([])
    }
  })

  it('words a card or a look puts into a collapsed Ask open it, and land in its field', async () => {
    await floating('capsule', desk, 'mark')
    const open = vi.fn(() => true)
    setAskOpener(open)
    try {
      expect(fillAsk('open settings')).toBe('filled')
      expect(open).toHaveBeenCalled()
    } finally {
      setAskOpener(null)
    }
  })

  it('half: the thread is the left half’s column at the Ask’s place, drawn though it was closed, its switch in the head and no Pin', async () => {
    await act(async () => void setAskSize(null, 'half'))
    for (const look of LOOKS) {
      await floating(look, desk, 'half-left')
      const col = byClass('ask-half')
      expect(col.length, look).toBe(1)
      const style = col[0].style as Record<string, unknown>
      expect([style.left, style.width], look).toEqual(['60px', '666px'])
      expect(byClass('ask-dock')[0].getAttribute('hidden'), look).toBeNull()
      expect(button(SIZE_WORDS.bubble.label).length, look).toBe(1)
      expect(button('Pin the thread beside the page'), look).toEqual([])
      // the thread is always shown at half: no switch to hide it in the field
      expect(all((n) => n.tagName === 'BUTTON' && /^(Show|Hide) the thread/.test(n.getAttribute('aria-label') ?? '')), look).toEqual([])
    }
  })

  it('a phone at half: the open thread is full height, without the grip that sizes it by hand', async () => {
    await act(async () => useAskStore.getState().setThreadOpen(true))
    for (const look of LOOKS) {
      await floating(look, phone, 'sheet')
      const sheet = byClass('ask-sheet')
      expect(sheet.length, look).toBe(1)
      expect(sheet[0].getAttribute('data-height'), look).toBe('full')
      expect(byClass('ask-grip'), look).toEqual([])
      expect(button(SIZE_WORDS.short.label).length, look).toBe(1)
    }
    await floating('capsule', phone, 'bubble')
    expect(byClass('ask-sheet')[0].getAttribute('data-height')).toBe('half')
    expect(byClass('ask-grip').length).toBe(1)
  })

  it('the bubble: unchanged, and the Omega at the field’s start collapses the Ask', async () => {
    await act(async () => void setAskSize(null, 'bubble'))
    for (const look of LOOKS) {
      await floating(look, desk, 'bubble')
      expect(byClass('ask-dock')[0].getAttribute('hidden'), look).toBeNull()
      expect(byClass('ask-half'), look).toEqual([])
      expect(button('Pin the thread beside the page').length + button('Unpin the thread').length, look).toBe(0)
      const collapse = button(SIZE_WORDS.collapse.label)
      expect(collapse.length, look).toBe(1)
      await act(async () => press(collapse[0]))
      expect(askSizeNow(), look).toBe('collapsed')
      await act(async () => void setAskSize(null, 'bubble'))
    }
  })
})

describe('Still’s floating line draws the person’s size in its own grammar', () => {
  const still = async (region: AskRegion) => {
    await act(async () => page.root.render(<StillLine place={desk} inputRef={createRef<HTMLInputElement>()} words={[]} region={region} />))
    await settle()
  }
  it('collapsed hides the line; half keeps the letter open with both size controls in its head and no Fold', async () => {
    await still('mark')
    expect(byClass('ask-still-line')[0].getAttribute('hidden')).not.toBeNull()
    await act(async () => void setAskSize(null, 'half'))
    await still('half-left')
    const line = byClass('ask-still-line')[0]
    expect(line.getAttribute('hidden')).toBeNull()
    expect(line.getAttribute('data-region')).toBe('half-left')
    expect(byClass('ask-letter').length).toBe(1)
    expect(button(SIZE_WORDS.bubble.label).length).toBe(1)
    expect(button(SIZE_WORDS.collapse.label).length).toBe(1)
    expect(all((n) => n.tagName === 'BUTTON' && /^(Fold|Today’s page)$/.test(n.textContent ?? ''))).toEqual([])
  })
})
