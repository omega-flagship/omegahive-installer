import { afterEach, expect, it, vi } from 'vitest'
import type { HiveClient } from '../api/client'
import { readBrowserMindRoute } from '../api/ask'

vi.stubGlobal('window', Object.assign(new EventTarget(), {
  location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }),
}))
const { useHive } = await import('./store')
const { useAskStore } = await import('./ask')
const body = () => ({ mind: { id: 'a_personal', name: 'Invented personal mind', browser_mind: true }, capabilities: { gateway: true, browser_mind: true } })
const settings = { swarm_id: null, thread_budget_usd: 1, eligible: [] }
let sequence = 0
function start(over: Partial<HiveClient> = {}) {
  const gateway = vi.fn()
  const client = { mode: 'sim', myMind: vi.fn(async () => body()), askSettings: vi.fn(async () => settings), browserMindGateway: gateway, ...over } as unknown as HiveClient
  useHive.setState({ client, session: `browser-metadata-${++sequence}`, inits: sequence })
  useAskStore.getState().bind(useHive.getState().session, 'user:invented')
  return { client, gateway }
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }
afterEach(() => useAskStore.getState().reset())

it.each([
  undefined, {}, { mind: null }, { ...body(), capabilities: { conductor: true, memory: true } },
  { ...body(), capabilities: { gateway: 'true', browser_mind: true } },
  { ...body(), mind: { ...body().mind, browser_mind: 1 } },
  { ...body(), capabilities: { gateway: true } },
  { ...body(), mind: { ...body().mind, id: '' } },
])('does not invent browser eligibility from a missing, old or malformed host advertisement: %j', value => {
  expect(readBrowserMindRoute(value)).toBeNull()
})

it('keeps host capability and person preference separate, including explicit false', () => {
  const value = body()
  value.mind.browser_mind = false
  expect(readBrowserMindRoute(value)).toEqual({ mindId: 'a_personal', gateway: true, available: true, preference: false })
  value.mind.browser_mind = true; value.capabilities.browser_mind = false
  expect(readBrowserMindRoute(value)).toEqual({ mindId: 'a_personal', gateway: true, available: false, preference: true })
})

it('the actual Ask loader publishes the mind and browser advertisement from one authenticated read, without minting', async () => {
  const { client, gateway } = start()
  await useAskStore.getState().loadSettings(); await flush()
  expect(client.myMind).toHaveBeenCalledTimes(1)
  expect(useAskStore.getState().personal?.id).toBe('a_personal')
  expect(useAskStore.getState().browserMind).toEqual({ mindId: 'a_personal', gateway: true, available: true, preference: true })
  expect(gateway).not.toHaveBeenCalled()
})

it('a later unreadable or unsupported host answer clears earlier browser metadata', async () => {
  const { client } = start()
  await useAskStore.getState().loadSettings(); await flush()
  client.myMind = vi.fn(async () => { throw new Error('synthetic unavailable mind endpoint') })
  await useAskStore.getState().loadSettings(); await flush()
  expect(useAskStore.getState().browserMind).toBeNull()
  expect(useAskStore.getState().personal).toBeNull()
})

it('an older same-person read cannot overwrite a newer disabled browser preference', async () => {
  let resolve!: (value: unknown) => void
  const disabled = body(); disabled.mind.browser_mind = false
  start({ myMind: vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue(disabled) })
  await useAskStore.getState().loadSettings()
  await useAskStore.getState().loadSettings(); await flush()
  expect(useAskStore.getState().browserMind?.preference).toBe(false)
  resolve(body()); await flush()
  expect(useAskStore.getState().browserMind?.preference).toBe(false)
})

it('a late previous-person read cannot install metadata after a store rebind', async () => {
  let resolve!: (value: unknown) => void
  start({ myMind: () => new Promise(r => { resolve = r }) })
  await useAskStore.getState().loadSettings()
  start()
  resolve(body()); await flush()
  expect(useAskStore.getState().browserMind).toBeUndefined()
  expect(useAskStore.getState().personal).toBeUndefined()
})

it('a credential change on the same client invalidates a late read even before its observer runs', async () => {
  let credential = {}, resolve!: (value: unknown) => void
  start({ authContext: () => credential, myMind: () => new Promise(r => { resolve = r }) })
  await useAskStore.getState().loadSettings()
  credential = {}
  resolve(body()); await flush()
  expect(useAskStore.getState().browserMind).toBeUndefined()
  expect(useAskStore.getState().personal).toBeUndefined()
})
