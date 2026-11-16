import { afterEach, expect, it, vi } from 'vitest'
import { LiveClient } from './live'
afterEach(() => vi.unstubAllGlobals())
// ask-takeover r2 (stand-in P1): the person's takeover reaches the host, so the conductor turn ends there too
it('the live client posts the takeover for the turn to the host', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token' })
  const receipt = { operation_id: 'op 1', turn_id: 't_1', state: 'taken_over', ended_at: '2026-10-08T20:00:00Z' }
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  const client = new LiveClient('https://example.test/omegahive/')
  expect(typeof client.askTakeover).toBe('function')
  expect(await client.askTakeover!('op 1')).toEqual(receipt)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe('https://example.test/omegahive/api/ask/op%201/takeover')
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body)).toEqual({ reason: 'user_took_over' })
})
