// Purpose: verify the hosted spend alert wire contract and reject invalid replies.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from './live'
import { readSpendAlerts, type SpendAlert } from './spendAlerts'

const hive: SpendAlert = {
  id: 'alert:a/b', scope: 'hive', agent_id: null, name: null, opened_at: '2026-11-23T08:00:00Z', closed_at: null,
  window_seconds: 3600, spent_usd: 3.005002, projected_usd: null, limit_usd: null, paused: false, can_control: true,
}

afterEach(() => vi.unstubAllGlobals())

describe('live spend alerts', () => {
  it('preserves null fields and the ledger value, and sends only the selected action', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    fetch.mockResolvedValueOnce(Response.json({ alerts: [hive] }))
    fetch.mockResolvedValueOnce(Response.json({ ...hive, paused: true }))
    vi.stubGlobal('fetch', fetch)
    const client = new LiveClient('http://hive.test')
    try {
      expect(await client.spendAlerts()).toEqual([hive])
      expect(await client.controlSpendAlert(hive.id, 'pause')).toEqual({ ...hive, paused: true })
      expect(fetch.mock.calls[0]).toEqual(['http://hive.test/api/usage/spend-alerts', expect.objectContaining({ method: 'GET' })])
      expect(fetch.mock.calls[1]).toEqual(['http://hive.test/api/usage/spend-alerts/alert%3Aa%2Fb/control',
        expect.objectContaining({ method: 'POST', body: '{"action":"pause"}' })])
    } finally {
      client.dispose()
    }
  })

  it('rejects an incomplete, inconsistent or ambiguous reply rather than exposing controls', () => {
    for (const alerts of [
      [{ ...hive, projected_usd: undefined }],
      [{ ...hive, closed_at: 'not a date' }],
      [{ ...hive, scope: 'mind' }],
      [{ ...hive, can_control: 'true' }],
      [{ ...hive, spent_usd: Infinity }],
      [hive, hive],
    ]) expect(() => readSpendAlerts({ alerts })).toThrow()
  })

  it('rejects a write reply for a different alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...hive, id: 'somewhere-else', paused: true })))
    const client = new LiveClient('http://hive.test')
    try {
      await expect(client.controlSpendAlert(hive.id, 'pause')).rejects.toThrow('did not confirm')
    } finally {
      client.dispose()
    }
  })
})
