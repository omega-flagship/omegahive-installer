// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store */
/**
 * The Artifacts page's Ask <mind> button opens that mind's chat with the artifact on its box: the chip names it, and the
 * question the person sends carries the artifact's id on a line of its own, so the mind is asked about that artifact.
 * Taking the chip off sends the words alone. Mounted on the MiniDOM with the real chat; a synthetic mind and artifact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ sent: [] as [string, string][] }))
vi.mock('../../store/store', () => {
  const state = {
    client: null, messages: {}, pending: {}, messagesLoaded: { a_taiga: true }, thinking: {}, freshMessages: {}, agents: {},
    loadMessages: async () => undefined, sendMessage: (id: string, text: string) => { T.sent.push([id, text]) },
    retryMessage: () => undefined, dismissPending: () => undefined,
  }
  const useHive = Object.assign((select: (s: any) => unknown) => select(state), { getState: () => state, subscribe: () => () => undefined, setState: () => undefined })
  return { useHive, hiveBus: { on: () => () => undefined } }
})
import { Chat } from './Chat'
import { attachAbout } from './chatAbout'
import { readDraft } from '../../experiences/drafts'

const ARTIFACT = { id: `ar_${'7'.repeat(32)}`, title: 'Family Trip App v1 (Draft)' }
const agent = { id: 'a_taiga', name: 'Taiga', hue: 140, status: 'awake' } as any

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const chip = () => host.findAll((n) => n.getAttribute('data-chat-about') !== null)[0]
const box = () => host.findAll((n) => n.tagName === 'TEXTAREA')[0]

async function ask(words: string) {
  await act(async () => { (reactProps(box()).onChange as (e: unknown) => void)({ target: { value: words } }) })
  const form = host.findAll((n) => n.tagName === 'FORM')[0]
  await act(async () => { (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
  await flush()
}

beforeEach(async () => {
  const g = globalThis as any
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame']) saved[k] = g[k]
  doc = new MiniDocument()
  const matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame = () => 0
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
  T.sent = []
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.parentNode?.removeChild(host)
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v
})

describe("an artifact taken to a mind's chat by Ask <mind>", () => {
  it('shows on the box by its title, and the question sent carries its id, once', async () => {
    attachAbout(agent.id, ARTIFACT)
    await act(async () => root.render(createElement(Chat, { agent })))
    await flush()
    expect(chip()?.textContent).toContain(ARTIFACT.title)
    expect(box().getAttribute('placeholder')).toBe(`Ask Taiga about ${ARTIFACT.title}…`)
    await ask('What does it still need before the trip?')
    expect(T.sent).toEqual([[agent.id, `What does it still need before the trip?\n\n\`${ARTIFACT.id}\``]])
    expect(chip()).toBeUndefined()
    expect(readDraft(`dot:chat:${agent.id}:about`)).toBe('')
    await ask('And who made it?')   // the next message is the person's words alone
    expect(T.sent[1]).toEqual([agent.id, 'And who made it?'])
  })

  it('taken off the box, goes with nothing', async () => {
    attachAbout(agent.id, ARTIFACT)
    await act(async () => root.render(createElement(Chat, { agent })))
    await flush()
    await act(async () => press(chip().findAll((n) => n.tagName === 'BUTTON')[0]))
    await flush()
    expect(chip()).toBeUndefined()
    await ask('Hello')
    expect(T.sent).toEqual([[agent.id, 'Hello']])
  })
})
