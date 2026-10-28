import { describe, expect, it, vi } from 'vitest'

/**
 * professional-release r1.1 (Kimi r1): the identity epoch bumps on EVERY change of principal, A→B→A included (the
 * second A is a new sign-in, never "the same as before"), and does not bump while the principal stays. readContext is
 * stubbed to give distinct keys for distinct principals, so this checks the epoch's own rule. INVENTED principals.
 */
const who = vi.hoisted(() => ({ principal: 'user:invented-a' }))
vi.mock('./readContext', async (orig) => ({
  ...(await orig<typeof import('./readContext')>()),
  readContext: () => `principal:${who.principal}`,
}))

describe('identity epoch: A→B→A', () => {
  it('bumps on each change of principal, including the return to A, and runs the clear hooks each time', async () => {
    const { currentEpoch, onIdentityChange, bindEpoch } = await import('./identityEpoch')
    const { useHive } = await import('../store/store')
    const cleared: string[] = []
    const off = onIdentityChange(() => cleared.push(who.principal))
    const a1 = currentEpoch()
    const boundUnderA = bindEpoch()
    expect(currentEpoch()).toBe(a1) // no change, no bump

    who.principal = 'user:invented-b'
    const b = currentEpoch()
    expect(b).toBe(a1 + 1)
    expect(boundUnderA.current()).toBe(false)

    who.principal = 'user:invented-a'
    useHive.setState({}) // the store's own listener sees it too (sync runs on every store change)
    const a2 = currentEpoch()
    expect(a2).toBe(b + 1)
    expect(a2).not.toBe(a1) // back to A is a new epoch: work bound under the first A stays stale
    expect(boundUnderA.current()).toBe(false)
    expect(boundUnderA.commit(() => 'written')).not.toBe('written')

    expect(currentEpoch()).toBe(a2)
    expect(cleared).toEqual(['user:invented-b', 'user:invented-a'])
    off()
  })
})
