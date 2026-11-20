// @vitest-environment node
// Purpose: verify a read shared by name (useResource's `share`) under real React: every mounted user reads through one
// fetch, reloads asked in one run make one read, a mutate reaches every user, the last user to leave stops it and drops
// its answer, and a store resync reads it again once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../ui/miniDom.testkit'
import { useHive } from '../store/store'
import { useResource, type ResourceHandle } from './useResource'

let host: MiniNode, root: Root, saved: Record<string, unknown>
let reads = 0
// while set, a read waits for it, so a test can look at what a user shows before the answer lands
let held: Promise<void> | null = null
const handles: Record<string, ResourceHandle<string[]>> = {}

// a user of the shared read 'share-test', recording what it shows under its name once each render commits
function User({ name }: { name: string }) {
  const read = useResource(async () => {
    const n = ++reads
    if (held) await held
    return [`read ${n}`]
  }, { share: 'share-test' })
  useEffect(() => { handles[name] = read })
  return null
}

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  root = (await import('react-dom/client')).createRoot(host as unknown as Element)
  reads = 0
  held = null
  for (const k of Object.keys(handles)) delete handles[k]
})
afterEach(async () => {
  await act(async () => root.unmount())
  const g = globalThis as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const both = () => <><User key="cards" name="cards" /><User key="mark" name="mark" /></>

describe('a read shared by name', () => {
  it('reads once for every user, once per run of reloads, and a mutate reaches them all', async () => {
    await act(async () => root.render(both()))
    await flush()
    expect(reads).toBe(1)
    expect(handles.cards.data).toEqual(['read 1'])
    expect(handles.mark.data).toEqual(['read 1'])

    // an event each user listens for asks a reload of each in the same run: one read
    await act(async () => { handles.cards.reload(); handles.mark.reload() })
    await flush()
    expect(reads).toBe(2)
    expect(handles.mark.data).toEqual(['read 2'])

    // a press in one place (Not now on a card) changes what every place shows, with no read
    await act(async () => handles.cards.mutate(() => []))
    expect(handles.mark.status).toBe('empty')
    expect(reads).toBe(2)
  })

  it('stops and drops its answer when the last user leaves, so the next user starts from a fresh read', async () => {
    await act(async () => root.render(both()))
    await flush()
    await act(async () => root.render(<><User key="mark" name="mark" /></>))   // one user left: still the same read, no new one
    await flush()
    expect(reads).toBe(1)
    expect(handles.mark.data).toEqual(['read 1'])
    await act(async () => root.render(null))
    let release = () => undefined as void
    held = new Promise<void>((done) => { release = done })
    await act(async () => root.render(<User name="again" />))
    await flush()
    expect(reads).toBe(2)
    expect(handles.again.status).toBe('loading')   // nothing kept from before: never shown as this read's answer
    await act(async () => release())
    await flush()
    expect(handles.again.data).toEqual(['read 2'])
  })

  it('reads again once when the store resyncs, however many users see it', async () => {
    await act(async () => root.render(both()))
    await flush()
    await act(async () => { useHive.setState((s) => ({ resyncs: s.resyncs + 1 })) })
    await flush()
    expect(reads).toBe(2)
    expect(handles.cards.data).toEqual(['read 2'])
    expect(handles.mark.data).toEqual(['read 2'])
  })
})
