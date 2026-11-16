// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store and the client */
/**
 * The limits a mind's page shows are read again while the page stays open: on the held-calls cadence, since a call whose
 * cost never comes back keeps its worst case held with no event to say so, and at once when the mind's spend changes.
 * Closing the page stops the reads. Mounted on the MiniDOM with a manual clock; synthetic minds only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ client: null as any }))
vi.mock('../../store/store', () => {
  const state = () => ({ client: T.client })
  const useHive = Object.assign((select: (s: any) => unknown) => select(state()), { getState: state, subscribe: () => () => undefined, setState: () => undefined })
  return { useHive, hiveBus: { on: () => () => undefined } }
})
import { useCallLimits, LIMITS_POLL_MS } from './callLimits'

function Probe({ id, spent }: { id: string; spent: number }) {
  const limits = useCallLimits(id, spent, undefined)
  return createElement('i', { 'data-held': limits ? String(limits.limits[0]?.held_usd) : 'unread' })
}
const probe = (id: string, spent: number) => createElement(Probe, { id, spent })

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const render = async (el: ReactElement) => { await act(async () => root.render(el)); await flush() }
const held = () => host.findAll((n) => n.tagName === 'I')[0]?.getAttribute('data-held')

beforeEach(async () => {
  const g = globalThis as any
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
})
afterEach(() => {
  host.parentNode?.removeChild(host)
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v
  vi.useRealTimers()
})

describe('a mind page’s limits while it stays open', () => {
  it('are read again on the held-calls cadence and at once when the spend changes, and no more once it closes', async () => {
    vi.useFakeTimers()
    // what the hive holds against the mind's $0.10 cap at each read: nothing, then a call whose cost never came back
    const heldAt = [0, 0.0538]
    const reads: string[] = []
    T.client = {
      agentLimits: async (id: string) => {
        reads.push(id)
        const h = heldAt[Math.min(reads.length - 1, heldAt.length - 1)]
        return { free: false, reason: null, limits: [{ label: `agent:${id}:total`, scope: `agent:${id}`, period: 'total', limit_usd: 0.1, spent_usd: 0, held_usd: h, room_usd: 0.1 - h }] }
      },
    }
    await render(probe('a_c', 0))
    expect([reads.length, held()]).toEqual([1, '0'])
    await act(async () => { vi.advanceTimersByTime(LIMITS_POLL_MS - 1) })
    await flush()
    expect(reads.length).toBe(1)   // not before the cadence
    await act(async () => { vi.advanceTimersByTime(1) })
    await flush()
    expect([reads.length, held()]).toEqual([2, '0.0538'])   // the held worst case shows with no event about it
    await render(probe('a_c', 0.01))   // a billed call: read at once, not at the next tick
    expect(reads.length).toBe(3)
    await act(async () => root.unmount())
    await act(async () => { vi.advanceTimersByTime(LIMITS_POLL_MS * 3) })
    await flush()
    expect(reads.length).toBe(3)
  })
})
