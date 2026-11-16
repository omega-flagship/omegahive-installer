import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode, reactProps } from '../../ui/miniDom.testkit'
import { ApiError } from '../../api/client'
import { OwnKeySheet, type OwnKeyClient } from './OwnKeySheet'
import { SIM_DEMO_KEY, type KeySetup } from './addOwnKey'
import { useHive } from '../../store/store'
import { SimClient } from '../../api/sim/SimClient'

/**
 * The add-your-key sheet, MOUNTED: typed into, submitted, and read back. The caller's retry (`onDone`) runs once, only
 * after both the key and the limit are set; a key saved with the limit refused leaves the sheet in "set limit" state.
 * sol on 4e3cd2b6: a sign-in change or the sheet going away while an answer is held ends the chain (no limit write, no
 * retry, the earlier person's sheet gone); in the sim no credential is taken, and a pasted secret never stays there.
 */
const SETUP: KeySetup = { provider: 'openrouter', providerLabel: 'OpenRouter', hasTotal: false, suggestedMonthUsd: 50 }
let doc: MiniDocument
let container: MiniNode
let root: Root | null

beforeEach(async () => {
  doc = new MiniDocument()
  const win = { document: doc, location: { hash: '#/', pathname: '/', search: '' }, HTMLElement: MiniNode, HTMLIFrameElement: class {}, Node: MiniNode,
    navigator: { userAgent: 'mini-dom-own-key-sheet' }, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('navigator', win.navigator)
  vi.stubGlobal('HTMLElement', MiniNode)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement)
  vi.stubGlobal('Node', MiniNode)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = doc.body.appendChild(doc.createElement('div'))
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as HTMLElement)
})
afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  vi.unstubAllGlobals()
})

const one = (attr: string) => container.findAll((n) => n.hasAttribute(attr))[0]
const sheet = () => one('data-own-key-sheet')
async function type(attr: string, value: string) {
  await act(async () => { (reactProps(one(attr)).onChange as (e: unknown) => void)({ target: { value } }) })
}
async function submit() {
  await act(async () => { (reactProps(sheet()).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function mount(setup: KeySetup, client: OwnKeyClient, onDone: () => void) {
  await act(async () => { root!.render(createElement(OwnKeySheet, { setup, client, onDone })) })
}

/** an invented hive client: her keys and her total, readable (GET /api/me/key-limits), with the add held if asked */
function fake(o: { hold?: Promise<void>; putFails?: () => boolean; total?: number | null; mode?: string } = {}) {
  const calls: string[] = []
  const st = { total: o.total ?? null as number | null, keys: [] as { provider: string; hint: string }[] }
  const client: OwnKeyClient = {
    mode: o.mode,
    addKey: (async (b: { provider: string; key: string }) => { calls.push('add ' + JSON.stringify(b)); if (o.hold) await o.hold; st.keys.push({ provider: b.provider, hint: '…' + b.key.slice(-4) }); return { id: 'k_1' } }) as never,
    myKeyLimits: async () => { calls.push('read'); return { keys: st.keys.map((k, i) => ({ id: `k_${i}`, label: 'x', ...k })), own: st.total === null ? [] : [{ key_id: '*', month_usd: st.total, active: true }] } },
    setOwnKeyLimit: async (b: Record<string, unknown>) => { calls.push('put ' + JSON.stringify(b)); if (o.putFails?.()) throw new ApiError(503, 'unavailable', 'busy'); st.total = b.month_usd as number; return {} },
  }
  return { client, calls }
}
const writes = (calls: string[]) => calls.filter((c) => c !== 'read')

describe('OwnKeySheet', () => {
  it('one paste, the limit pre-filled, one press: the key, the limit, then the retry once', async () => {
    const { client, calls } = fake()
    const onDone = vi.fn()
    await mount(SETUP, client, onDone)
    expect(sheet().getAttribute('data-own-key-sheet')).toBe('ask')
    expect(sheet().textContent).toContain('Add your OpenRouter key')
    expect(reactProps(one('data-own-key-month')).value).toBe('50')
    expect(reactProps(one('data-own-key-input')).type).toBe('password')
    await type('data-own-key-input', 'sk-or-ann-invented')
    await submit()
    expect(writes(calls)).toEqual(['add {"provider":"openrouter","key":"sk-or-ann-invented","month_usd":50}', 'put {"key_id":"*","month_usd":50,"expected_month_usd":null}'])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(sheet().getAttribute('data-own-key-sheet')).toBe('done')
  })

  it('the key saved and the limit unconfirmed: "key saved; set your limit", no retry, and Retry writes only the limit', async () => {
    let fail = true
    const { client, calls } = fake({ putFails: () => fail })
    const onDone = vi.fn()
    await mount(SETUP, client, onDone)
    await type('data-own-key-input', 'sk-or-x-invented')
    await submit()
    expect(sheet().getAttribute('data-own-key-sheet')).toBe('needs-limit')
    expect(one('data-own-key-saved').textContent).toBe('Your key is saved. Set your monthly limit to continue.')
    expect(one('data-own-key-input')).toBeUndefined()
    expect(one('data-own-key-submit').textContent).toBe('Set limit and draw')
    expect(onDone).not.toHaveBeenCalled()
    fail = false
    await submit()
    expect(writes(calls).filter((c) => c.startsWith('add'))).toHaveLength(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('a total set meanwhile is shown and kept unless she replaces it (fresh consent)', async () => {
    const { client, calls } = fake({ total: 8 })
    const onDone = vi.fn()
    await mount(SETUP, client, onDone)
    await type('data-own-key-input', 'sk-or-x-invented')
    await submit()
    expect(sheet().getAttribute('data-own-key-sheet')).toBe('confirm-limit')
    expect(one('data-own-key-governing').textContent).toContain('$8')
    expect(writes(calls).filter((c) => c.startsWith('put'))).toEqual([])
    await act(async () => { (reactProps(one('data-own-key-keep')).onClick as () => void)() })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(writes(calls).filter((c) => c.startsWith('put'))).toEqual([])
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('someone with a monthly total already is asked for the key only', async () => {
    const { client, calls } = fake()
    const onDone = vi.fn()
    await mount({ ...SETUP, hasTotal: true, suggestedMonthUsd: null }, client, onDone)
    expect(one('data-own-key-month')).toBeUndefined()
    await type('data-own-key-input', 'sk-or-x-invented')
    await submit()
    expect(writes(calls)).toEqual(['add {"provider":"openrouter","key":"sk-or-x-invented"}'])
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('sol P1: another person signs in while the key\'s answer is held: no limit write, no retry, a fresh sheet', async () => {
    let release!: () => void
    const { client, calls } = fake({ hold: new Promise<void>((r) => { release = r }) })
    const onDone = vi.fn()
    await mount(SETUP, client, onDone)
    await type('data-own-key-input', 'sk-or-ann-invented')
    await act(async () => { (reactProps(sheet()).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    await act(async () => { useHive.setState({ inits: useHive.getState().inits + 1 }) })   // the sign-in changes
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)) })
    expect(writes(calls)).toEqual(['add {"provider":"openrouter","key":"sk-or-ann-invented","month_usd":50}'])
    expect(onDone).not.toHaveBeenCalled()
    expect(sheet().getAttribute('data-own-key-sheet')).toBe('ask')                       // the new person's own sheet
    expect(reactProps(one('data-own-key-input')).value).toBe('')                          // nothing typed carries over
  })

  it('sol P1: a sign-in change landing after the last answer but before the sheet acts on it: no retry, at any moment', async () => {
    // the change is scheduled N microtasks after the final readback resolves, so across N it lands at every point from
    // inside the chain to just before the sheet's own commit; the retry must never run once the person is not current
    for (let n = 0; n <= 12; n++) {
      let reads = 0
      let changedAt: number | null = null
      const order: string[] = []
      const { client } = fake()
      const read = client.myKeyLimits!.bind(client)
      client.myKeyLimits = async () => {
        const out = await read()
        if (++reads === 2) {   // the readback after the PUT: the last answer of the chain
          let k = n
          const tick = () => { if (k-- > 0) queueMicrotask(tick); else { changedAt = order.length; order.push('change'); useHive.setState({ inits: useHive.getState().inits + 1 }) } }
          queueMicrotask(tick)
        }
        return out
      }
      const onDone = vi.fn(() => { order.push('done') })
      await mount(SETUP, client, onDone)
      await type('data-own-key-input', 'sk-or-ann-invented')
      await submit()
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      if (changedAt !== null && order.indexOf('done') > changedAt) throw new Error(`n=${n}: the retry ran after the sign-in changed`)
      if (order.indexOf('done') === -1) expect(changedAt, `n=${n}`).not.toBeNull()   // no retry only because the person changed
      await act(async () => { root!.render(null) })
    }
  })

  it('sol P1: the sheet goes away while the answer is held: no limit write, no retry', async () => {
    let release!: () => void
    const { client, calls } = fake({ hold: new Promise<void>((r) => { release = r }) })
    const onDone = vi.fn()
    await mount(SETUP, client, onDone)
    await type('data-own-key-input', 'sk-or-ann-invented')
    await act(async () => { (reactProps(sheet()).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    await act(async () => { root!.render(null) })
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)) })
    expect(writes(calls)).toHaveLength(1)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('the missing total alone: the limit is pre-filled from the host\'s own suggestion, not a fixed figure', async () => {
    const { client } = fake()
    const read = client.myKeyLimits!.bind(client)
    client.myKeyLimits = async () => ({ ...(await read() as object), suggested_month_usd: 75 })
    await mount({ provider: null, providerLabel: '', hasTotal: false, suggestedMonthUsd: null }, client, vi.fn())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(reactProps(one('data-own-key-month')).value).toBe('75')
  })

  it('sol P1: in the sim no credential is taken: no key field, an invented key stands in', async () => {
    const { client, calls } = fake({ mode: 'sim' })
    const onDone = vi.fn()
    await mount(SETUP, client, onDone)
    expect(one('data-own-key-input')).toBeUndefined()
    expect(sheet().textContent).toContain('demonstration')
    expect(one('data-own-key-submit').textContent).toBe('Use a demo key and draw')
    await submit()
    expect(writes(calls)[0]).toBe(`add {"provider":"openrouter","key":"${SIM_DEMO_KEY}","month_usd":50}`)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('sol P1: a secret handed to the sim is never kept there (only a fingerprint and the hint)', async () => {
    const sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    const SENTINEL = 'invented-SENTINEL-must-never-be-kept-9z9z'   // no provider prefix: never shaped like a real key
    const k = await sim.addKey({ provider: 'openrouter', key: SENTINEL })
    expect(k.hint).toBe('…9z9z')
    const seen = new WeakSet<object>()
    const scan = (v: unknown, depth = 0): boolean => {
      if (typeof v === 'string') return v.includes('SENTINEL')
      if (!v || typeof v !== 'object' || depth > 6 || seen.has(v as object)) return false
      seen.add(v as object)
      return Object.values(v as Record<string, unknown>).some((x) => scan(x, depth + 1))
    }
    expect(scan(sim)).toBe(false)
    await expect(sim.addKey({ provider: 'openrouter', key: SENTINEL })).rejects.toMatchObject({ code: 'duplicate_key' })
  })

  it('Dot on b7de1e5b: a provider key typed on the sim\'s Providers page is never kept either (fingerprint and hint only)', async () => {
    const sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    const SENTINEL = 'sk-or-SENTINEL-provider-page-7q7q'
    const status = await sim.setProviderKey('openrouter', `  ${SENTINEL}  `)
    expect((status as { key_hint: string; connected: boolean }).key_hint).toBe('…7q7q')
    expect((status as { connected: boolean }).connected).toBe(true)
    const seen = new WeakSet<object>()
    const scan = (v: unknown, depth = 0): boolean => {
      if (typeof v === 'string') return v.includes('SENTINEL')
      if (!v || typeof v !== 'object' || depth > 6 || seen.has(v as object)) return false
      seen.add(v as object)
      return Object.values(v as Record<string, unknown>).some((x) => scan(x, depth + 1))
    }
    expect(scan(sim)).toBe(false)
  })
})
