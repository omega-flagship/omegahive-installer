import { afterEach, expect, it, vi } from 'vitest'
import { LiveClient } from './live'
afterEach(() => vi.unstubAllGlobals())
it('reads archive pages through the base-path host session without putting tokens in the URL', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token' })
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  const client = new LiveClient('https://example.test/omegahive/')
  await client.archivedTraces('a fixture', '2026-10-04', 100, 200)
  expect(fetcher).toHaveBeenCalledWith('https://example.test/omegahive/api/agents/a%20fixture/traces/archive/2026-10-04?limit=100&offset=200', expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer synthetic-token' } }))
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ days: [], logs: [] }), { status: 200 }))
  expect(await client.traceArchive('a fixture')).toEqual({ days: [], logs: [] })
  expect(fetcher.mock.calls[1][0]).toBe('https://example.test/omegahive/api/agents/a%20fixture/traces/archive')
})
