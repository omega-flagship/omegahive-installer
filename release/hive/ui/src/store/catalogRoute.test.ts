import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// keyview R13 (sol on d15396ca): someone who does not pay by the hive's OpenRouter key may read its catalogue but not
// refresh it (403 refresh_not_allowed). Adding their own key, and Retry, must leave them with the cached catalogue,
// never in the error state. In-memory client; no network.
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }),
  addEventListener: () => undefined, removeEventListener: () => undefined })
const { useHive } = await import('./store')
const { ApiError } = await import('../api/client')
type HiveClient = import('../api/client').HiveClient

const cached = { models: [{ id: 'x/y', name: 'Y', description: '', context_length: 1000, in_per_m: null, out_per_m: null,
  inputs: [], outputs: [], tools: false, reasoning: false }], fetched_at: null, error: null, can_refresh: false }
const key = { id: 'k_0000c0c1', provider: 'openrouter', provider_label: 'OpenRouter', label: 'My OpenRouter', owner: 'user:u_mia',
  hint: '…c0c1', default: false }
let n = 0
function offRoute() {
  const catalog = vi.fn(async (refresh?: boolean) => {
    if (refresh) throw new ApiError(403, 'refresh_not_allowed', 'only someone who pays by the hive’s OpenRouter key can refresh the catalogue')
    return structuredClone(cached)
  })
  const client = { mode: 'live', addKey: vi.fn(async () => key), listKeys: vi.fn(async () => [key]), listProviders: vi.fn(async () => []),
    getModels: vi.fn(async () => []), openrouterCatalog: catalog } as unknown as HiveClient
  useHive.setState({ client, session: `catalog-${++n}`, inits: n, catalog: null, catalogState: 'idle', catalogError: null })
  return catalog
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { vi.restoreAllMocks() })

describe('the OpenRouter catalogue for someone off its paying route', () => {
  it('adding their own key with no catalogue loaded reads the cache, and is not an error', async () => {
    const catalog = offRoute()
    expect(await useHive.getState().addKey({ provider: 'openrouter', key: 'sk-or-invented-c0c1' } as never)).toEqual(key)
    await settle()
    expect(catalog.mock.calls.map((c) => c[0] === true)).toEqual([false])
    const s = useHive.getState()
    expect([s.catalogState, s.catalogError, s.catalog?.models.length, s.catalog?.can_refresh]).toEqual(['idle', null, 1, false])
  })
  it('a refused refresh (Retry from an older picker, or any caller) falls back to the cache', async () => {
    const catalog = offRoute()
    await useHive.getState().loadCatalog(true)
    expect(catalog.mock.calls.map((c) => c[0] === true)).toEqual([true, false])
    expect([useHive.getState().catalogState, useHive.getState().catalogError]).toEqual(['idle', null])
  })
  it('any other refusal is still an error', async () => {
    const catalog = offRoute()
    catalog.mockImplementationOnce(async () => { throw new ApiError(502, 'catalog_unavailable', 'could not fetch it') })
    await useHive.getState().loadCatalog(true)
    expect(useHive.getState().catalogState).toBe('error')
  })
})
