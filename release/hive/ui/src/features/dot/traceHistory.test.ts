import { describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { Trace } from '../../api/types'
import { HISTORY_PAGE, TraceHistory } from './traceHistory'

const trace = (id: number, mind = 'a_fixture'): Trace => ({ id, agent_id: mind, iteration: id, input: null, response: 'Synthetic thought', commands: [{ command: '(synthetic)', result: 'recorded' }], llm_ms: null, tokens: null, created_at: '2026-10-04T00:00:00Z' })
const index = { days: [{ day: '2026-10-04', entries: 201, updated_at: '' }], logs: [] }
function fixture() {
  const traceArchive = vi.fn().mockResolvedValue(index)
  const archivedTraces = vi.fn().mockResolvedValue([trace(41)])
  const client = { traceArchive, archivedTraces } as unknown as HiveClient
  return { client, traceArchive, archivedTraces, history: new TraceHistory(client, 'a_fixture') }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { resolve, promise }
}
describe('archived trace continuity', () => {
  it('uses the exact mind/day/offset and retains original identity and command result', async () => {
    const f = fixture()
    await f.history.index(); await f.history.page('2026-10-04', HISTORY_PAGE)
    expect(f.traceArchive).toHaveBeenCalledWith('a_fixture')
    expect(f.archivedTraces).toHaveBeenCalledWith('a_fixture', '2026-10-04', 100, 100)
    expect(f.history.getState()).toMatchObject({ phase: 'ready', offset: 100, rows: [{ id: 41, agent_id: 'a_fixture', commands: [{ result: 'recorded' }] }] })
  })
  it('clears the previous page immediately and ignores a late response from a superseded selection', async () => {
    const f = fixture(), late = deferred<Trace[]>()
    await f.history.index(); await f.history.page('2026-10-04')
    f.archivedTraces.mockReturnValueOnce(late.promise).mockResolvedValueOnce([trace(99)])
    const old = f.history.page('2026-10-04', 100)
    expect(f.history.getState().rows).toEqual([])
    await f.history.page('2026-10-04', 200)
    late.resolve([trace(12)]); await old
    expect(f.history.getState()).toMatchObject({ offset: 200, rows: [{ id: 99 }] })
  })
  it('cannot repopulate history after logout/visibility invalidation or context unmount', async () => {
    const f = fixture(), late = deferred<Trace[]>()
    f.archivedTraces.mockReturnValueOnce(late.promise)
    const pending = f.history.page('2026-10-04')
    f.history.clear(); late.resolve([trace(1)]); await pending
    expect(f.history.getState()).toMatchObject({ phase: 'idle', rows: [], days: [] })
    const lateIndex = deferred<typeof index>(); f.traceArchive.mockReturnValueOnce(lateIndex.promise)
    const pendingIndex = f.history.index(); f.history.stop(); lateIndex.resolve(index); await pendingIndex
    expect(f.history.getState().days).toEqual([])
    expect(new TraceHistory(f.client, 'a_other').getState().rows).toEqual([])
  })
  it('drops cached content on a revoked read and retries exactly the failed page', async () => {
    const f = fixture()
    await f.history.index(); await f.history.page('2026-10-04', 100)
    f.archivedTraces.mockRejectedValueOnce(new ApiError(404, 'not_found', 'No such mind'))
    await f.history.page('2026-10-04', 100)
    expect(f.history.getState()).toMatchObject({ phase: 'error', rows: [], days: [] })
    await f.history.retry()
    expect(f.archivedTraces).toHaveBeenLastCalledWith('a_fixture', '2026-10-04', 100, 100)
    expect(f.history.getState().phase).toBe('ready')
  })
  it('distinguishes missing capabilities, empty index and exhausted page', async () => {
    const missing = new TraceHistory({} as HiveClient, 'a_fixture')
    await missing.index(); expect(missing.getState().phase).toBe('unsupported')
    const f = fixture()
    f.traceArchive.mockResolvedValueOnce({ days: [], logs: [] })
    await f.history.index(); expect(f.history.getState()).toMatchObject({ phase: 'empty', day: null })
    f.archivedTraces.mockResolvedValueOnce([])
    await f.history.page('2026-10-04', 200)
    expect(f.history.getState()).toMatchObject({ phase: 'empty', day: '2026-10-04', offset: 200 })
  })
  it('refuses mixed mind/day identity, duplicate traces and invalid page locations', async () => {
    const f = fixture()
    for (const rows of [[trace(1, 'a_foreign')], [{ ...trace(1), created_at: '2026-10-03T00:00:00Z' }], [trace(1), trace(1)]]) {
      f.archivedTraces.mockResolvedValueOnce(rows)
      await f.history.page('2026-10-04')
      expect(f.history.getState()).toMatchObject({ phase: 'error', rows: [] })
    }
    f.archivedTraces.mockClear()
    await expect(f.history.page('../private')).rejects.toThrow('Invalid archive page')
    await expect(f.history.page('2026-10-04', -1)).rejects.toThrow('Invalid archive page')
    expect(f.archivedTraces).not.toHaveBeenCalled()
  })
})
