import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * The one add-your-key step where people meet own_key_needed: Studio's card (studioLive/refusals) and the Ask thread
 * (api/ask refusalDetails, the refused row). With the host's step details the sheet replaces "go to Keys"; without them
 * (an older host) the old way on stays. INVENTED data, no network.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
const kv = new Map<string, string>()
const storage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, localStorage: storage })
vi.stubGlobal('localStorage', storage)

// a static render reads a zustand store's initial state, so the hive client the sheet needs is supplied here
const hiveClient: { current: unknown } = { current: null }
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  const real = actual.useHive
  const useHive = Object.assign((sel: (x: unknown) => unknown) => sel({ ...real.getState(), client: hiveClient.current ?? real.getState().client }), real)
  return { ...actual, useHive }
})

const { ApiError } = await import('../../api/client')
const { refusalDetails } = await import('../../api/ask')
const { studioRefusal, OWN_KEY_WORDS, OWN_KEY_SHEET_WORDS } = await import('../studioLive/refusals')
const { ThreadLog } = await import('../ask/Thread')

const STEP = { provider: 'openrouter', provider_label: 'OpenRouter', has_total: false, suggested_month_usd: 50 }
const body = (extra: object) => ({ error: { code: 'own_key_needed', message: 'x', scope: 'studio_maker', pays: 'own-key', ...extra } })
const refusal = (extra: object) => { const b = body(extra); return new ApiError(402, 'own_key_needed', 'x', { envelope: b.error, body: b }) }

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

  it('Ask: the refused row shows the sheet in place of "Add your own key", and asks again with her words', () => {
    hiveClient.current = { mode: 'live', addKey: async () => ({}), myKeyLimits: async () => ({ keys: [], own: [] }), setOwnKeyLimit: async () => ({}) }
    const keySetup = { provider: 'openrouter', providerLabel: 'OpenRouter', hasTotal: false, suggestedMonthUsd: 50 }
    const rows = [
      { id: 'o#you', op: 'o', kind: 'you' as const, text: 'Plan the picnic' },
      { id: 'o#refused', op: 'o', kind: 'refused' as const, text: '', reason: 'own_key_needed' as const, keySetup },
    ]
    const html = renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows: rows as never }))
    expect(html).toContain('data-own-key-sheet="ask"')
    expect(html).toContain('Add your OpenRouter key')
    expect(html).toContain('Add key and ask')
    expect(html).not.toContain('>Add your own key<')
    const old = renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows: [rows[0], { ...rows[1], keySetup: undefined }] as never }))
    expect(old).not.toContain('data-own-key-sheet')
    expect(old).toContain('Add your own key')
  })

  it('sol R2 P3: a client that cannot set the monthly total keeps "Add your own key" (Keys) instead of a sheet', () => {
    hiveClient.current = { mode: 'live', addKey: async () => ({}), myKeyLimits: async () => ({ keys: [], own: [] }) }   // no setOwnKeyLimit
    const keySetup = { provider: 'openrouter', providerLabel: 'OpenRouter', hasTotal: false, suggestedMonthUsd: 50 }
    const rows = [
      { id: 'o#you', op: 'o', kind: 'you' as const, text: 'Plan the picnic' },
      { id: 'o#refused', op: 'o', kind: 'refused' as const, text: '', reason: 'own_key_needed' as const, keySetup },
    ]
    const html = renderToStaticMarkup(createElement(ThreadLog, { variant: 'glass', rows: rows as never }))
    expect(html).not.toContain('data-own-key-sheet')
    expect(html).toContain('Add your own key')
  })
})
