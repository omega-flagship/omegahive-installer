import { describe, expect, it, vi } from 'vitest'
import { answerShown } from './sessionDecide'

// Kimi #4 on next22: SessionView reads its timeline again after every answer, taken or refused, so a refused decide
// (an earlier session, a request no longer pending, drift) shows the current state rather than the stale request.

async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}

describe('Kimi #4: SessionView reloads its timeline after a decide, taken or refused', () => {
  it('a refused decide (the store returns null: earlier session or drift) reloads the timeline', async () => {
    const decide = vi.fn(async () => null)
    const reload = vi.fn()
    await answerShown('ap_1', 'approve', 'sess-A', decide, reload)
    expect(decide).toHaveBeenCalledWith('ap_1', 'approve', undefined, 'sess-A')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a taken decide reloads too, and a decide that throws still reloads (and the error is not swallowed)', async () => {
    const reload = vi.fn()
    await answerShown('ap_1', 'deny', 'sess-A', async () => ({ id: 'ap_1', status: 'denied' }), reload)
    expect(reload).toHaveBeenCalledTimes(1)
    await expect(answerShown('ap_2', 'approve', 'sess-A', async () => { throw new Error('lost') }, reload)).rejects.toThrow('lost')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('before the timeline was read (no session stamp) nothing is sent', async () => {
    const decide = vi.fn(async () => null)
    const reload = vi.fn()
    await answerShown('ap_1', 'approve', null, decide, reload)
    expect(decide).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('SessionView answers through answerShown with the session its timeline was read under, and its load', async () => {
    const text = await source('./SessionView.tsx')
    expect(text).toMatch(/answerShown\(id, d, shownUnder, storeDecide, load\)/)
    expect(text).toMatch(/setShownUnder\(asked\)/)
  })
})
