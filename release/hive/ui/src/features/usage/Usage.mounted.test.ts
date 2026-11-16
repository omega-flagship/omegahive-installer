// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store */
// Purpose: a mounted test of the Usage page, the screen MeTTa composes, on the simulator: your spend, the held calls, the limits (the hive cap once, one row per person, the caps set) with the old form defaults removed in one action after one confirmation that lists each change, and the spend view's filters and its empty state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'

// real MeTTa composes the page: allow for a loaded machine (the screen cap, api/sim/simTimeouts.test.ts)
vi.setConfig({ testTimeout: 20_000 })

const T = vi.hoisted(() => ({ client: null as any, toasts: [] as any[], asked: [] as string[] }))
vi.mock('../../store/store', () => {
  const state = () => ({
    client: T.client,
    swarms: { s_kelp: { id: 's_kelp', name: 'Kelp', hue: 150 }, s_forge: { id: 's_forge', name: 'Forge', hue: 30 } },
    agents: { a_nori06: { id: 'a_nori06', name: 'Nori', hue: 150 }, a_deneb2: { id: 'a_deneb2', name: 'Deneb', hue: 205 } },
    keys: [],
    usage: [],
    models: [],
    toast: (t: unknown) => T.toasts.push(t),
  })
  const useHive = Object.assign((select: (s: any) => unknown) => select(state()), { getState: state, subscribe: () => () => undefined, setState: () => undefined })
  return { useHive, hiveBus: { on: () => () => undefined } }
})
vi.mock('../plans/PlanUsage', () => ({ PlanUsage: () => null }))
vi.mock('../../ui/confirm', () => ({ askConfirm: async (message: string) => (T.asked.push(message), true), ConfirmHost: () => null }))
// the page's frame (its header and the battery) is the shell's: here only what the page draws inside it
vi.mock('../../ui/Page', () => ({ Page: ({ children }: { children: ReactNode }) => children }))
import { SimClient } from '../../api/sim/SimClient'
import { money } from '../../lib/format'
import UsageView from './UsageView'

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
const render = async (el: ReactElement) => { await act(async () => root.render(el)); await flush() }
const button = (label: string) => host.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0]

beforeEach(async () => {
  const g = globalThis as any
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'matchMedia']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { search: '' } }
  doc.defaultView = win
  g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
  T.toasts = []; T.asked = []
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.parentNode?.removeChild(host)
  for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v
})

describe('the Usage page', () => {
  it('draws the hive cap once, the people and the caps set, and removes the old defaults in one action', async () => {
    const c = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
    await c.patchAgent('a_nori06', { budget_usd: 10 })              // an old form's pre-filled cap on a mind
    T.client = c
    await render(createElement(UsageView))
    const text = host.textContent
    for (const part of ['Spending limits', 'The hive cap', 'People', 'Caps set', 'Old form defaults']) expect(text).toContain(part)
    expect(text).toContain('Tomás Reyes')
    expect(text).toContain('member default')
    expect(text).toContain('An admin with no allowance of their own')     // Ada, the admin
    expect(text).toContain('Forge')                                        // a cap someone set on a swarm
    expect(text).not.toContain('$500 a month unless')                      // no default for every swarm any more
    expect(text.split('All paid calls').length - 1).toBe(1)               // the hive cap, once
    // the held calls and the spend view are on the same page
    expect(text).toContain('Held calls')
    expect(host.findAll((n) => n.getAttribute?.('aria-label') === 'Time range').length).toBe(1)
    expect(text).toContain('No usage yet')

    // the simulator's Quench ($10) and Wisp ($5), Kelp's $500 rule, and Nori's $10 set above
    await act(async () => press(button('Remove all 4')))
    await flush()
    expect(T.asked).toHaveLength(1)                                        // one confirmation for the lot
    for (const change of ['Kelp Commons: $500.00 a month ->', 'Nori: $10.00 lifetime cap ->', 'Quench: $10.00 lifetime cap ->', 'Wisp: $5.00 lifetime cap ->'])
      expect(T.asked[0]).toContain(change)
    expect((await c.listBudgets()).some((b) => b.scope === 'swarm:s_kelp')).toBe(false)
    for (const id of ['a_nori06', 'a_qnch11', 'a_wisp12']) expect(c.agents.get(id)!.budget_usd).toBe(0)
    expect(T.toasts.at(-1)).toMatchObject({ tone: 'success', title: '4 old defaults removed' })
    expect(host.textContent).not.toContain('Old form defaults')            // read again: nothing left to remove
  })

  it('changes a cap in place: its figures open the editor, Enter saves the new figure, and the row reads it again', async () => {
    const c = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
    T.client = c
    await render(createElement(UsageView))
    const forge = (await c.listBudgets()).find((b) => b.scope === 'swarm:s_forge')!
    const figures = host.findAll((n) => n.tagName === 'BUTTON' && (n.textContent ?? '').includes(` / ${money(forge.limit_usd)} per month`))
    expect(figures.length).toBeGreaterThan(0)
    const editors = () => host.findAll((n) => n.tagName === 'INPUT').filter((n) => reactProps(n).type === 'number')
    expect(editors()).toHaveLength(0)
    await act(async () => press(figures[0]))
    expect(editors()).toHaveLength(1)
    expect(reactProps(editors()[0]).value).toBe(forge.limit_usd.toFixed(2))      // the editor starts from the figure, in dollars and cents
    expect(reactProps(editors()[0]).autoFocus).toBe(true)
    await act(async () => (reactProps(editors()[0]).onChange as (e: unknown) => void)({ target: { value: '75' } }))
    await act(async () => (reactProps(editors()[0]).onKeyDown as (e: unknown) => void)({ key: 'Enter', preventDefault: () => undefined, nativeEvent: {}, target: null }))
    await flush()
    expect((await c.listBudgets()).find((b) => b.scope === 'swarm:s_forge')!.limit_usd).toBe(75)
    expect(T.toasts.at(-1)).toMatchObject({ tone: 'success', title: 'Limit saved', body: 'Forge: $75 per month' })
    expect(editors()).toHaveLength(0)   // the editor closed
  })
})
