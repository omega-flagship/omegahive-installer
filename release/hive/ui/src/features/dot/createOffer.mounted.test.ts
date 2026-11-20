// @vitest-environment node
// Purpose: the mind-create-offers screen (createOffer.metta, createOffer.ts) mounted on real ReactDOM in every look: a
// mind's open offers to build in Create show as cards with what to build, Start in Create and Not now pressed for that
// offer, a press that failed says why, and with no offer nothing shows; every look's own chat with a mind draws the card
// above its composer, in that look's own chrome; the offer routes' answers are read exactly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { CreateOffer } from '../../api/types'
import { href, parse } from '../../lib/router'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { offersScreen, parseOffer, parseOffers, startedPlan } from './createOffer'
import classicChat from './Chat.tsx?raw'
import canvasChat from '../../experiences/canvas/chat.tsx?raw'
import fluxPanels from '../../experiences/flux/panels.tsx?raw'
import cosmosPanels from '../../experiences/cosmos/Panels.tsx?raw'
import stillReading from '../../experiences/still/Reading.tsx?raw'
import constructPanes from '../../experiences/construct/Panes.tsx?raw'
import professionalConversation from '../../experiences/professional/Conversation.tsx?raw'
import createOffersHost from './CreateOffers.tsx?raw'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

// under vitest a `?raw` import of a .css file comes back empty (theme/lightTokens.test.ts), so the stylesheet is read
// from disk
const fsName = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const indexCss = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')

const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const offer = (over: Partial<CreateOffer> = {}): CreateOffer => ({
  id: 'cof_1', mind: { id: 'a_dot', name: 'Dot' }, sentence: 'a tip calculator', state: 'offered', plan_id: null,
  created_at: '2026-11-17T06:00:00Z', ...over,
})
const space = ScreensSpace.open()
let container: MiniNode, root: Root
let saved: Record<string, unknown>

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

async function mount(look: string, offers: CreateOffer[], alert: string | null = null) {
  const compose = (screen: string, facts: Parameters<typeof space.compose>[2]) => space.compose(screen, look, facts)
  const { data, facts } = offersScreen(offers, 'Dot', alert, compose)
  const pressed: [string, string[] | undefined][] = []
  const host: ScreenHost = { data, onAction: (a, item) => void pressed.push([a, item.scope as string[] | undefined]) }
  const plan = compose('mind-create-offers', facts)
  await act(async () => root.render(createElement(Screen, { plan, host })))
  const buttons = container.findAll((n) => n.tagName === 'BUTTON')
  return { plan, pressed, text: container.textContent, buttons: (label: string) => buttons.filter((b) => b.textContent === label) }
}

describe('what a mind offers to build in Create, mounted in every look', () => {
  it.each(LOOKS)('%s: an offer says what to build, and its presses come back for that offer', async (look) => {
    const { plan, pressed, text, buttons } = await mount(look, [offer()])
    expect(plan.parts.map((p) => p.order)).toEqual([10])
    expect(text).toContain('Dot can build this in Create: “a tip calculator”')
    expect(text).toContain('Nothing is built until you start it.')
    await act(async () => { press(buttons('Start in Create')[0]) })
    await act(async () => { press(buttons('Not now')[0]) })
    expect(pressed).toEqual([['start-offer', ['cof_1']], ['dismiss-offer', ['cof_1']]])
    expect(plan.missing).toEqual([])
  })
  it.each(LOOKS)('%s: two offers are two cards, each pressed for its own', async (look) => {
    const { pressed, text, buttons } = await mount(look, [offer(), offer({ id: 'cof_2', sentence: 'a packing list' })])
    expect(text).toContain('“a packing list”')
    await act(async () => { press(buttons('Start in Create')[1]) })
    expect(pressed).toEqual([['start-offer', ['cof_2']]])
  })
  it.each(LOOKS)('%s: a press that didn’t go through says why', async (look) => {
    const { plan, text } = await mount(look, [offer()], 'Create isn’t switched on in this hive.')
    expect(plan.parts.map((p) => p.order)).toEqual([10, 20])
    expect(plan.parts.find((p) => p.order === 20)?.props.tone).toBe('bad')
    expect(text).toContain('Create isn’t switched on in this hive.')
  })
  it('with no open offer, nothing shows', async () => {
    expect((await mount('classic', [])).plan.parts).toEqual([])
  })
  it('the guards stay clean', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})

describe('every look’s own chat with a mind draws its offers', () => {
  // Each look draws a mind's chat itself (classic's mind panel, which #/dot/<mind> opens in every look, and the board
  // card, panels, reading room, session and mind view of the others), so each mounts the card in that chat, between the
  // conversation and its composer, where the person reads the mind's answer; the looks above show it draws in each.
  it.each([
    ['classic', classicChat, 'data-tour="chat-composer"'],
    ['canvas', canvasChat, 'ref={inputRef}'],
    ['flux', fluxPanels, '<form className="px-4 pb-4"'],
    ['cosmos', cosmosPanels, 'Transmit to'],
    ['still', stillReading, 'className="st-compose-wrap"'],
    ['construct', constructPanes, '<label className="cx-sin">'],
    ['professional', professionalConversation, 'className="pr-composer"'],
  ])('%s: the card sits above the composer of the same chat', (_look, source, composer) => {
    const at = source.indexOf(composer)
    const card = source.lastIndexOf('<CreateOffers agent={agent}', at)
    expect(at).toBeGreaterThan(-1)
    expect(card).toBeGreaterThan(-1)
    // in the same component: no function starts between the card and the composer
    expect(source.slice(card, at)).not.toMatch(/\n(export )?function /)
  })
  // Mounted shrink-0, two cards and a mind's error notice pushed classic's composer under its Live log bar at 1440x900,
  // where neither the box nor Send took a pointer (a dry run on a hive with no model, 19 Nov). So the cards give way
  // first: the host lets them shrink below their height and scroll inside, and no look's mount keeps them from it.
  it.each([
    ['classic', classicChat], ['canvas', canvasChat], ['flux', fluxPanels], ['cosmos', cosmosPanels],
    ['still', stillReading], ['construct', constructPanes], ['professional', professionalConversation],
  ])('%s: the cards give way before the composer does', (_look, source) => {
    const from = source.indexOf('<CreateOffers agent={agent}')
    expect(from).toBeGreaterThan(-1)
    expect(source.slice(from, source.indexOf('/>', from))).not.toMatch(/\b(shrink-0|flex-none|flex-shrink-0)\b/)
  })
  it('the host lets its cards shrink and scroll inside, whatever spacing a look gives', () => {
    const giveWay = /const GIVE_WAY = '([^']*)'/.exec(createOffersHost)?.[1].split(' ') ?? []
    expect(giveWay).toEqual(expect.arrayContaining(['min-h-0', 'overflow-y-auto']))
    expect(createOffersHost).toContain('className={cx(DRESS, GIVE_WAY, className)}')
  })
  // Each experience draws its chat in its own tree, outside the classic pages' dress, and the cards' blocks draw in the
  // classic tokens: undressed, Canvas's white chat drew the offer and Not now in classic's #eceaff, about 1.2:1 on white
  // (the v0.40 Mac kit, 20 Nov). Dressed, inside an experience the tokens they draw with follow its chrome.
  it('inside an experience the cards wear its chrome, so their words read on its surfaces', () => {
    expect(/const DRESS = '([^']*)'/.exec(createOffersHost)?.[1]).toBe('xc-dress')
    const dress = /html\[data-xc-active\] \.xc-dress \{([^}]*)\}/.exec(indexCss)?.[1] ?? ''
    for (const [token, chrome] of [['ink', 'ink'], ['ink-2', 'ink-2'], ['primary-ink', 'on-accent'], ['primary-top', 'accent']]) {
      expect(dress).toMatch(new RegExp(`--color-${token}: var\\(--xc-${chrome}\\);`))
    }
  })
})

describe('the offer routes’ answers, read exactly', () => {
  it('keeps only well-formed open offers', () => {
    const raw = [offer(), { ...offer({ id: 'cof_2' }), state: 'started' }, { id: 'cof_3' }, null, 'cof_4',
      { ...offer({ id: 'cof_5' }), mind: 'Dot' }]
    expect(parseOffers(raw).map((o) => [o.id, o.mind])).toEqual([['cof_1', { id: 'a_dot', name: 'Dot' }], ['cof_5', null]])
    expect(parseOffers({ offers: [] })).toEqual([])
    expect(parseOffer({ ...offer(), state: 'built' })).toBeNull()
  })
  it('reads the plan a press started, or none', () => {
    expect(startedPlan({ offer: offer({ state: 'started', plan_id: 'pl_1' }), plan: { plan_id: 'pl_1' } })).toBe('pl_1')
    expect(startedPlan({ offer: offer() })).toBeNull()
    expect(startedPlan('pl_1')).toBeNull()
  })
  it('a press opens Create on its Make bench, a link that reads back the same', () => {
    const make = { name: 'program' as const, id: 'omegadesign', view: 'make' as const }
    expect(href(make)).toBe('#/program/omegadesign?view=make')
    expect(parse(href(make))).toEqual(make)
  })
})
