import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDENTITY_CHANGED } from './client'
import { LiveClient } from './live'

// Invented accounts and HTTP stand-ins only. Exercise the actual release LiveClient, not another transport.
const tokenKey = 'omegadots.hive.token'
let listeners: ((event: StorageEvent) => void)[]
let stored: string | null
let calls: { url: string; init: RequestInit }[]
const closed = { operation_id: 'ask:original', turn_id: 'host-distinct', route: 'browser_mind', state: 'done' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
let send: (url: string, init: RequestInit) => Promise<Response>

beforeEach(() => {
  listeners = []; stored = 'invented-session'; calls = []
  vi.stubGlobal('window', {
    location: { href: 'https://hive.invalid/', search: '' },
    addEventListener: (name: string, listener: (event: StorageEvent) => void) => { if (name === 'storage') listeners.push(listener) },
    removeEventListener() {},
  })
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value }, removeItem: () => { stored = null } })
  send = async () => json(closed)
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => { calls.push({ url, init }); return send(url, init) }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('closes exactly the original operation through the existing authenticated host route', async () => {
  const client = new LiveClient('https://hive.invalid')
  expect(await client.askBrowserDone('ask:original', 'answered')).toEqual(closed)
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe('https://hive.invalid/api/ask/ask%3Aoriginal/done')
  expect(calls[0].init.method).toBe('POST')
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ outcome: 'answered' })
  expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer invented-session')
})

it.each([
  { ...closed, operation_id: 'ask:someone-else' },
  { ...closed, route: undefined },
  { ...closed, state: 'browser' },
  { ...closed, turn_id: '' },
])('a mismatched or nonterminal successful close stays unknown, with no retry: %j', async value => {
  send = async () => json(value)
  await expect(new LiveClient('https://hive.invalid').askBrowserDone('ask:original', 'incomplete'))
    .rejects.toMatchObject({ status: 0, code: 'answer_unreadable' })
  expect(calls).toHaveLength(1)
})

it('retains the host refusal and never substitutes another admission or close', async () => {
  send = async () => json({ error: 'not_available', message: 'not available' }, 404)
  await expect(new LiveClient('https://hive.invalid').askBrowserDone('ask:original', 'stopped'))
    .rejects.toMatchObject({ status: 404, code: 'not_available' })
  expect(calls).toHaveLength(1)
})

it('rejects a close that returns after this sign-in ends', async () => {
  let resolve!: (value: Response) => void
  send = () => new Promise<Response>(r => { resolve = r })
  const pending = new LiveClient('https://hive.invalid').askBrowserDone('ask:original', 'answered')
  stored = null
  for (const listener of listeners) listener({ key: tokenKey, newValue: null } as StorageEvent)
  resolve(json(closed))
  await expect(pending).rejects.toMatchObject({ code: IDENTITY_CHANGED })
  expect(calls).toHaveLength(1)
})

it('invalidates the page gateway on sign-out before it can mint or dispatch', async () => {
  const gateway = new LiveClient('https://hive.invalid').browserMindGateway()
  stored = null
  for (const listener of listeners) listener({ key: tokenKey, newValue: null } as StorageEvent)
  expect(() => gateway.prepare()).toThrow('identity changed')
  await expect(gateway.llm({}, { idemKey: 'ask:original:0', isLive: () => true })).rejects.toThrow('identity changed')
  expect(calls).toHaveLength(0)
})

it('preserves the newer myApps endpoint while adding the browser adapters', async () => {
  send = async () => json({ apps: [{ program: 'synthetic-app', label: 'Synthetic app' }] })
  expect(await new LiveClient('https://hive.invalid').myApps()).toMatchObject({ apps: [{ program: 'synthetic-app' }] })
  expect(calls.map(c => c.url)).toEqual(['https://hive.invalid/api/me/apps'])
})
