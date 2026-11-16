import { describe, expect, it } from 'vitest'
import { withBusy } from './busy'

describe('withBusy', () => {
  it('clears busy after success', async () => {
    const calls: boolean[] = []
    const r = await withBusy((b) => calls.push(b), async () => 7)
    expect(r).toEqual({ ok: true, value: 7 })
    expect(calls).toEqual([true, false])
  })
  it('clears busy after a rejection and reports it plainly', async () => {
    const calls: boolean[] = []
    const r = await withBusy((b) => calls.push(b), async () => {
      throw new Error('offline')
    })
    expect(r).toEqual({ ok: false, error: 'offline' })
    expect(calls).toEqual([true, false])
  })
  it('clears busy when the action throws synchronously', async () => {
    const calls: boolean[] = []
    const r = await withBusy((b) => calls.push(b), () => {
      throw 'boom'
    })
    expect(r).toEqual({ ok: false, error: 'Something went wrong.' })
    expect(calls).toEqual([true, false])
  })
  it('stays busy exactly while the action is pending', async () => {
    let busy = false
    let release!: () => void
    const p = withBusy((b) => (busy = b), () => new Promise<void>((r) => (release = r)))
    expect(busy).toBe(true)
    release()
    await p
    expect(busy).toBe(false)
  })
})
