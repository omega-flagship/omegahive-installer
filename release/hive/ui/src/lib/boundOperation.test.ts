import { describe, expect, it } from 'vitest'
import { bindOperation, OperationStopped, stopped } from './boundOperation'
import { useHive } from '../store/store'
import { ApiError, IDENTITY_CHANGED } from '../api/client'

/** professional-release r1.2: the shared bound operation. INVENTED values only. */
const bump = () => useHive.setState({ inits: useHive.getState().inits + 1 }) // a new sign-in (identity epoch)

describe('bindOperation', () => {
  it('sends while current, and returns the answer', async () => {
    const op = bindOperation()
    const sent: number[] = []
    expect(await op.write(async () => { sent.push(1); return 'a' })).toBe('a')
    expect(await op.write(async () => { sent.push(2); return 'b' })).toBe('b')
    expect(sent).toEqual([1, 2])
  })
  it('after a sign-in change: never sends, throws the typed stop', async () => {
    const op = bindOperation()
    bump()
    let sent = false
    const e = await op.write(async () => { sent = true }).catch((x: unknown) => x)
    expect(sent).toBe(false)
    expect(e).toBeInstanceOf(OperationStopped)
    expect(stopped(e)).toBe(true)
  })
  it('a change while a write is in flight: its answer is not taken, and the next write is never sent', async () => {
    const op = bindOperation()
    const sent: string[] = []
    const first = op.write(async () => { sent.push('first'); bump(); return 1 })
    await expect(first).rejects.toBeInstanceOf(OperationStopped)
    await expect(op.write(async () => { sent.push('second') })).rejects.toBeInstanceOf(OperationStopped)
    expect(sent).toEqual(['first'])
  })
  it('the caller going away stops it the same way', async () => {
    let alive = true
    const op = bindOperation(() => alive)
    alive = false
    await expect(op.write(async () => 1)).rejects.toBeInstanceOf(OperationStopped)
    expect(await op.confirm('Invented?')).toBe(false) // a confirm is not even asked
  })
  it("stopped() also recognises the client's identity_changed, and nothing else", () => {
    expect(stopped(new ApiError(409, IDENTITY_CHANGED, 'x'))).toBe(true)
    expect(stopped(new ApiError(409, 'conflict', 'x'))).toBe(false)
    expect(stopped(new Error('x'))).toBe(false)
  })
})
