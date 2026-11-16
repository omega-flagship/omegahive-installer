import { describe, expect, it, vi } from 'vitest'

/** POST /api/keys starting_limit (Jon 11-09): the one plain sentence, on Keys' own add (the store's toast). Invented data. */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }),
  addEventListener: () => undefined, removeEventListener: () => undefined })
const { startingLimitWords } = await import('./startingLimit')
const { useHive } = await import('../../store/store')
type HiveClient = import('../../api/client').HiveClient

const key = { id: 'k_0000c0c2', provider: 'anthropic', provider_label: 'Anthropic', label: 'Home', owner: 'user:u_mia', hint: '…c0c2', default: true }

describe('the starting limit, in words', () => {
  it('says the figure with money() and where to change it', () => {
    expect(startingLimitWords({ starting_limit: { usd: 50, scope: 'hive' } })).toBe('Your monthly limit starts at $50. Change it on Limits.')
    expect(startingLimitWords({ starting_limit: { usd: 12.5, scope: 'own' } })).toBe('Your monthly limit starts at $12.50. Change it on Limits.')
  })
  it('says nothing for an answer without one, or one it cannot read', () => {
    for (const v of [null, {}, { starting_limit: null }, { starting_limit: { usd: -1, scope: 'hive' } }, { starting_limit: { usd: Infinity, scope: 'own' } }, { starting_limit: { usd: 50 } }])
      expect(startingLimitWords(v)).toBeNull()
  })
  it("Keys' add says it in the success toast, and only when the host set one", async () => {
    for (const [extra, tail] of [[{ starting_limit: { usd: 50, scope: 'hive' } }, '. Your monthly limit starts at $50. Change it on Limits.'], [{}, '']] as const) {
      const client = { mode: 'live', addKey: vi.fn(async () => ({ ...key, ...extra })), listKeys: vi.fn(async () => [key]), listProviders: vi.fn(async () => []),
        getModels: vi.fn(async () => []) } as unknown as HiveClient
      useHive.setState({ client, catalog: null })
      expect(await useHive.getState().addKey({ provider: 'anthropic', key: 'sk-ant-invented-c0c2' })).toMatchObject({ id: key.id })
      expect(useHive.getState().toasts.at(-1)?.body).toBe(`Anthropic key …c0c2 · hive default${tail}`)
    }
  })
})
