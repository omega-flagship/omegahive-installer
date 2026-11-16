// @vitest-environment node
// Purpose: verify with real React effects that a chat marks its mind in use while mounted and releases it when it closes,
// two chats at once leaving the later one in use until it closes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../../ui/miniDom.testkit'
import { mindInUse, useMindInUse } from './mindInUse'

function Chat({ id }: { id: string }) {
  useMindInUse(id)
  return <p>{id}</p>
}

let root: Root
let container: MiniNode
let saved: Record<string, unknown>

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = { window: g.window, document: g.document, HTMLIFrameElement: g.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT }
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '', search: '', pathname: '/' } }
  doc.defaultView = win
  g.window = win
  g.document = doc
  g.HTMLIFrameElement = win.HTMLIFrameElement
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div')
  doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  mindInUse.clear()
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

describe('a mounted chat marks its mind in use', () => {
  it('while it is open, the later of two open chats is the one in use, and closing it falls back', async () => {
    await act(async () => root.render(<Chat id="a_worker01" />))
    expect(mindInUse.get()).toBe('a_worker01')
    await act(async () => root.render(<><Chat id="a_worker01" /><Chat id="a_taiga01" /></>))
    expect(mindInUse.get()).toBe('a_taiga01')
    await act(async () => root.render(<Chat id="a_worker01" />))
    expect(mindInUse.get()).toBe('a_worker01')
    await act(async () => root.render(<p>nothing open</p>))
    expect(mindInUse.get()).toBeNull()
  })
})
