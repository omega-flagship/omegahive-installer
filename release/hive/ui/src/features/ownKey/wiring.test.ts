// Purpose: verify how Studio and Ask present own-key setup and when they offer the Keys page instead.
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HiveClient } from '../../api/client'

const loc = { hash: '#/', search: '', pathname: '/' }
const kv = new Map<string, string>()
const storage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, localStorage: storage })
vi.stubGlobal('localStorage', storage)

// Read the current store state when rendering to static markup.
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    api.getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})

const { ApiError } = await import('../../api/client')
const { AskRefusal, refusalDetails } = await import('../../api/ask')
const { useHive } = await import('../../store/store')
const { threadRows, useAskStore } = await import('../../store/ask')
const { studioRefusal, OWN_KEY_WORDS, OWN_KEY_SHEET_WORDS } = await import('../studioLive/refusals')
const { ThreadLog } = await import('../ask/Thread')

const STEP = { provider: 'openrouter', provider_label: 'OpenRouter', has_total: false, suggested_month_usd: 50 }
const body = (extra: object) => ({ error: { code: 'own_key_needed', message: 'x', scope: 'studio_maker', pays: 'own-key', ...extra } })
const refusal = (extra: object) => { const b = body(extra); return new ApiError(402, 'own_key_needed', 'x', { envelope: b.error, body: b }) }

function bindAskClient({ details = STEP, canSetMonthlyTotal = true }: { details?: object; canSetMonthlyTotal?: boolean } = {}) {
  const client: Partial<HiveClient> = {
    mode: 'live',
    ask: async () => { throw new AskRefusal(402, 'own_key_needed', 'x', refusalDetails(body(details))) },
    addKey: async () => { throw new Error('Unexpected key write during static rendering') },
    myKeyLimits: async () => ({ keys: [], own: [] }),
    ...(canSetMonthlyTotal ? { setOwnKeyLimit: async () => ({}) } : {}),
  }
  const session = 'own-key-wiring'
  useAskStore.getState().reset()
  useHive.setState({ client: client as HiveClient, session })
  useAskStore.getState().bind(session, 'user:p_ada')
}

function ask(words: string) {
  return useAskStore.getState().send(words, { route: '#/swarm/s_lyra', experience: 'classic', swarm_id: 's_lyra' })
}

function renderAskThread(rows = threadRows(useAskStore.getState())) {
  return renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows }))
}

describe('own_key_needed meets the one step', () => {
  it('Studio: the host names the step, so the card carries it and says so', () => {
    const r = studioRefusal(refusal(STEP))
    expect(r.keySetup).toEqual({ provider: 'openrouter', providerLabel: 'OpenRouter', hasTotal: false, suggestedMonthUsd: 50 })
    expect(r.words).toBe(OWN_KEY_SHEET_WORDS)
    expect(r.keepWords).toBe(true)
  })

  it('Studio: an older host that names no provider keeps the old way on (Keys)', () => {
    const r = studioRefusal(refusal({}))
    expect(r.keySetup).toBeUndefined()
    expect(r.remedy).toEqual({ label: 'Add your own key', go: 'keys' })
    expect(r.words).toBe(OWN_KEY_WORDS)
  })

  it('Studio: the missing monthly total alone opens the sheet on the limit', () => {
    const e = new ApiError(402, 'spend_limit', 'x', { envelope: { limit: { kind: 'own_key_limit' }, detail: { reason: 'monthly_total_required' } } })
    expect(studioRefusal(e).keySetup).toMatchObject({ provider: null, hasTotal: false })
  })

  it('Ask: the refusal details carry the step only for own_key_needed with a well-formed provider', () => {
    expect(refusalDetails(body(STEP)).keySetup).toEqual({ provider: 'openrouter', providerLabel: 'OpenRouter', hasTotal: false, suggestedMonthUsd: 50 })
    expect(refusalDetails(body({ ...STEP, provider: '<script>' })).keySetup).toBeUndefined()
    expect(refusalDetails({ error: { code: 'spend_limit', ...STEP } }).keySetup).toBeUndefined()
  })

  it('Ask: the latest refusal shows "Add key and ask" in place of "Add your own key"', async () => {
    bindAskClient()
    await ask('Plan the picnic')
    const html = renderAskThread()
    expect(html).toContain('data-own-key-sheet="ask"')
    expect(html).toContain('Add your OpenRouter key')
    expect(html).toContain('Add key and ask')
    expect(html).not.toContain('>Add your own key<')
  })

  it('Ask: an older refused request only offers the Keys page', async () => {
    bindAskClient()
    await ask('Plan the picnic')
    const olderOp = threadRows(useAskStore.getState()).find((row) => row.kind === 'refused')?.op
    expect(olderOp).toBeDefined()
    await ask('Bring a blanket')
    const rows = threadRows(useAskStore.getState())
    expect(rows.filter((row) => row.kind === 'refused')).toHaveLength(2)
    const html = renderAskThread(rows.filter((row) => row.op === olderOp))
    expect(html).not.toContain('data-own-key-sheet')
    expect(html).not.toContain('>Try again<')
    expect(html).toContain('>Add your own key<')
  })

  it('Ask: a host without key setup details still offers "Add your own key"', async () => {
    bindAskClient({ details: {} })
    await ask('Plan the picnic')
    const html = renderAskThread()
    expect(html).not.toContain('data-own-key-sheet')
    expect(html).toContain('>Add your own key<')
  })

  it('Ask: a client that cannot set the monthly total still offers "Add your own key"', async () => {
    bindAskClient({ canSetMonthlyTotal: false })
    await ask('Plan the picnic')
    const html = renderAskThread()
    expect(html).not.toContain('data-own-key-sheet')
    expect(html).toContain('>Add your own key<')
  })
})
