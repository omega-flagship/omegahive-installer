// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store */
// Purpose: a mounted test of the Usage page, the screen MeTTa composes, on the simulator: your spend, the held calls, the limits (the hive cap once, one row per person, the caps set) with the old form defaults removed in one action after one confirmation that lists each change, and the spend view's filters and its empty state; a cap on someone else's mind or swarm stays its owner's to change or remove; and the held calls' admin-only reads are asked once by a member, whose polls stop at the hive's 403.
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
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import { money } from '../../lib/format'
import UsageView from './UsageView'
import type { SpendAlertsView } from './useSpendAlerts'

// App gives the page the signed-in spend alerts it reads (#706, useSpendAlerts); these tests read the limits and held
// calls, so the page gets a feed with no alerts that asks the hive nothing
const noAlerts: SpendAlertsView = {
  status: 'empty', readError: undefined, reload: () => undefined, alerts: [], canControl: false,
  pending: null, actionError: undefined, change: async () => undefined,
}
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
    await render(createElement(UsageView, { spendAlerts: noAlerts }))
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
    await render(createElement(UsageView, { spendAlerts: noAlerts }))
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

  it("leaves a cap on someone else's mind to its owner, and the one action removes only the viewer's own old defaults", async () => {
    // the hive's may_change: Nori is someone else's mind, so its cap and its old default are its owner's (limit_refusal)
    const cap = (scope: string, may_change: boolean) => ({ key: `${scope}:month`, scope, period: 'month', limit_usd: 5, spent_usd: 0, held_usd: 0, room_usd: 5, source: 'set', rule_id: `b_${scope.slice(-6)}`, may_change })
    const old = (id: string, name: string, may_change: boolean) => ({ kind: 'mind', agent_id: id, name, change: `${name}: $10.00 lifetime cap -> the hive cap and its payer's allowance`, reasons: ["equals a form's pre-filled $10.00"], reset: { method: 'PATCH', path: `/api/agents/${id}`, body: { budget_usd: 0 } }, may_change })
    const c = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
    const patched: string[] = []
    const patch = c.patchAgent.bind(c)
    Object.assign(c, {
      budgetLimitsView: async () => ({ hive: { cap: null, all_time: null, month_spent_usd: 0, pace_usd_per_day: 0 }, people: [],
        caps: [cap('agent:a_nori06', false), cap('swarm:s_forge', true)], old_defaults: [old('a_nori06', 'Nori', false), old('a_deneb2', 'Deneb', true)] }),
      patchAgent: async (id: string, body: Parameters<SimClient['patchAgent']>[1]) => (patched.push(id), patch(id, body)),
    })
    T.client = c
    await render(createElement(UsageView, { spendAlerts: noAlerts }))
    // Nori's cap reads as its owner's, with nothing to change it; Forge's, the viewer's own, keeps its remover
    expect(host.textContent).toContain('its owner’s to change')
    expect(host.findAll((n) => n.tagName === 'BUTTON' && n.getAttribute?.('aria-label') === 'Remove this limit')).toHaveLength(1)
    expect(host.textContent).toContain('A cap on someone else’s mind or swarm is theirs to remove.')
    expect(host.textContent).toContain('its owner’s to remove')
    expect(button('Remove all 2')).toBeUndefined()
    await act(async () => press(button('Remove yours')))
    await flush()
    expect(T.asked.at(-1)).toContain('Deneb: $10.00 lifetime cap')
    expect(T.asked.at(-1)).not.toContain('Nori')
    expect(patched).toEqual(['a_deneb2'])
  })
})

// acceptance-tests#13 (#635): GET /api/budgets/reservations and /overruns are admin-only on the hive today (each
// `admin(request)` in hive/core/app.py), and the page polled them for anyone every 15 s and 60 s, filling a member's
// recent errors with 403s. The page doesn't decide who reads them, the hive does: it asks once, and a 403 stops the
// polls (useResource). Only setInterval, the polls, is faked.
describe('the held calls: the hive decides who reads them', () => {
  const as = (admin: boolean) => {
    const c = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
    const adminOnly = <T,>(read: () => Promise<T>) => vi.fn(async () => {
      if (!admin) throw new ApiError(403, 'forbidden', 'admin only')
      return read()
    })
    const reads = { listReservations: adminOnly(c.listReservations.bind(c)), listOverruns: adminOnly(c.listOverruns.bind(c)) }
    Object.assign(c, reads)
    return { client: c, ...reads }
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('a member asks each once, and ten minutes of polls ask nothing more', async () => {
    const { client, listReservations, listOverruns } = as(false)
    T.client = client
    await render(createElement(UsageView, { spendAlerts: noAlerts }))
    expect(listReservations).toHaveBeenCalledTimes(1)
    expect(listOverruns).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    await flush()
    expect(listReservations).toHaveBeenCalledTimes(1)
    expect(listOverruns).toHaveBeenCalledTimes(1)
  })

  it('an admin reads both and keeps polling', async () => {
    const { client, listReservations, listOverruns } = as(true)
    T.client = client
    await render(createElement(UsageView, { spendAlerts: noAlerts }))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(listReservations.mock.calls.length).toBeGreaterThan(1)
    expect(listOverruns.mock.calls.length).toBeGreaterThan(1)
  })
})
