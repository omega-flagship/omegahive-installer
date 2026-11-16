// @vitest-environment node
// Purpose: tests that a mounted useResource reads again when the store resyncs, keeping its last answer on screen.
/**
 * Flagship review #111: a page's own reads (useResource) are part of what the live stream keeps current, so when the
 * store reads again after a stream gap (its `resyncs` count moves) every mounted resource reads again too, the way SWR
 * and TanStack Query refetch active queries on reconnect, keeping its last answer on screen while it does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../ui/miniDom.testkit'
import { useHive } from '../store/store'
import { useResource } from './useResource'

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const seen: { status: string; data: unknown; refreshing: boolean }[] = []
let reads = 0
let release: (() => void) | null = null

function Probe() {
  const r = useResource(async () => {
    reads++
    if (reads > 1) await new Promise<void>((done) => (release = done))   // the re-read stays out until released
    return [`read ${reads}`]
  })
  seen.push({ status: r.status, data: r.data, refreshing: r.refreshing })
  return null
}

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  root = (await import('react-dom/client')).createRoot(host as unknown as Element)
  seen.length = 0
  reads = 0
  release = null
})
afterEach(async () => {
  await act(async () => root.unmount())
  const g = globalThis as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }

describe('useResource after a stream gap', () => {
  it('reads again when the store resyncs, with the last answer still shown meanwhile', async () => {
    await act(async () => root.render(<Probe />))
    await flush()
    expect(reads).toBe(1)
    expect(seen.at(-1)).toEqual({ status: 'ready', data: ['read 1'], refreshing: false })

    await act(async () => { useHive.setState((s) => ({ resyncs: s.resyncs + 1 })) })
    await flush()
    expect(reads).toBe(2)
    expect(seen.at(-1)).toEqual({ status: 'ready', data: ['read 1'], refreshing: true })   // never a blank in between

    await act(async () => { release?.() })
    await flush()
    expect(seen.at(-1)).toEqual({ status: 'ready', data: ['read 2'], refreshing: false })
  })
})
