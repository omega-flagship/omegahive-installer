// Purpose: Jon on #364: a per-look test that the Ask's composed screen is mounted. For every look the registry offers,
// mounted as AskHost draws it (InlineParts with askScreen.ts's host, the look's own Ask from AskHost's LookAsk as its island): the
// mark is mounted only while the Ask is collapsed, carries the look's glyph and opens the Ask when pressed; the look's
// own Ask is mounted at every size, the same element throughout (what was typed stays), laid out in the region MeTTa
// gives: hidden behind the mark, the bubble, the left half, and a phone's full sheet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { mountPage, settle, type MountedPage } from '../views/mountedView.testkit'
import { press, type MiniNode } from '../../ui/miniDom.testkit'
import type { AskSize } from '../../shell/uiVariant'
import { useAskStore } from '../../store/ask'
import { ASK_SKINS, LookAsk } from './AskHost'
import { InlineParts } from '../../screens/Screen'
import { askScreenHost, composeAsk, type MarkState } from './askScreen'
import type { Placement } from './placement'
import { SIZE_WORDS } from './words'

vi.mock('../../shell/uiVariant', async (orig) => ({ ...(await orig<typeof import('../../shell/uiVariant')>()), openGallery: () => undefined }))
vi.mock('../../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))
// MeTTa opens the Ask's space once for the file, and each look loads its own Ask: the standard screen cap, over 10x the
// worst measured (1.7 s at load 95 to 165)
vi.setConfig({ testTimeout: 20_000 })

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const SRC = new URL('../..', import.meta.url).pathname
/** Every look the registry offers, read from its source, so a new look is mounted here with no edit. */
const LOOKS = [...fs.readFileSync(`${SRC}experiences/registry.ts`, 'utf8').matchAll(/^\s+id: '([a-z]+)',/gm)].map((m) => m[1]).sort()
// Professional's card is fetched lazily with its look (AskHost): fetched first here, its lazy skin draws within a settle
await import('./professionalSkin')

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
const resting: MarkState = { state: 'resting', news: false, label: SIZE_WORDS.open, title: `${SIZE_WORDS.open} (Ctrl+K or /)` }
const all = (pred: (n: MiniNode) => boolean) => page.container.findAll(pred)
/** The look's own Ask: the outermost element that says which region it is laid out in. */
const lookAsk = () => all((n) => n.getAttribute('data-region') !== null)[0]
const marks = () => all((n) => n.getAttribute('data-ask-mark-open') !== null)

/** The look's Ask screen as AskHost draws it, at `size` on the screen `place` is on. */
async function draw(look: string, size: AskSize, place: Placement, opened: () => void) {
  const skin = ASK_SKINS[look]
  if (!skin || skin === 'phase-2') throw new Error(`${look} has no Ask skin`)
  const { plan, region } = composeAsk(look, size, place.mode, true)
  await act(async () => page.root.render(
    <InlineParts plan={plan} host={askScreenHost({
      place, mark: resting, onOpen: opened, glyph: <i data-glyph={look} />,
      island: <LookAsk skin={skin} experience={look} place={place} region={region} inputRef={createRef<HTMLInputElement>()} floatingBox={() => undefined}
        professionalBox={() => undefined} floating line={skin === 'still-line'} awake ctx="ctx" words={[]} />,
    })} />,
  ))
  await settle()
}

describe('every look mounts the Ask’s composed screen (Jon on #364)', () => {
  it('reads every look the registry offers', () => {
    expect(LOOKS.length).toBeGreaterThan(5)
  })

  it.each(LOOKS)('%s: the mark only while collapsed, and the look’s own Ask mounted once across every size, in MeTTa’s region', async (look) => {
    const opened = vi.fn()
    await draw(look, 'bubble', desk, opened)
    const ask = lookAsk()
    expect(ask, look).toBeDefined()
    expect(ask.getAttribute('data-region')).toBe('bubble')
    expect(ask.getAttribute('hidden')).toBeNull()
    expect(marks()).toEqual([])

    await draw(look, 'collapsed', desk, opened)
    expect(lookAsk()).toBe(ask)
    expect(ask.getAttribute('data-region')).toBe('mark')
    expect(ask.getAttribute('hidden')).not.toBeNull()
    const mark = marks()
    expect(mark).toHaveLength(1)
    expect(mark[0].getAttribute('aria-label')).toBe(SIZE_WORDS.open)
    expect(mark[0].findAll((n) => n.getAttribute('data-glyph') === look)).toHaveLength(1)
    await act(async () => press(mark[0]))
    expect(opened).toHaveBeenCalledTimes(1)

    await draw(look, 'half', desk, opened)
    expect(lookAsk()).toBe(ask)
    expect(ask.getAttribute('data-region')).toBe('half-left')
    expect(ask.getAttribute('hidden')).toBeNull()
    expect(marks()).toEqual([])

    await draw(look, 'half', phone, opened)
    expect(lookAsk()).toBe(ask)
    expect(ask.getAttribute('data-region')).toBe('sheet')
  })
})
