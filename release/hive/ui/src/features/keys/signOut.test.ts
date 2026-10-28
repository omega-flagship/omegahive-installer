/**
 * The visible Sign out control (pairs with host b203496): it is on You & your keys, it leaves the profile before the
 * session ends, and it waits for the client's sign-out. INVENTED clients only.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ client: { logout: vi.fn() } as { logout: () => void | Promise<void> } | null }))
// SignOut reads the client through the hook (invented); everything else of the store is the real one, for modules the
// profile page now also imports (the Ask's memory section: lib/identityEpoch reads the store when it loads)
vi.mock('../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store')>()
  return { ...real, useHive: Object.assign((sel: (s: unknown) => unknown) => sel({ client: h.client }), real.useHive) }
})

const { SignOut, signOutNow } = await import('./ProfilePage')

describe('Sign out on You & your keys', () => {
  it('shows a Sign out button when a client is connected, and nothing without one', () => {
    h.client = { logout: vi.fn() }
    expect(renderToStaticMarkup(createElement(SignOut))).toContain('Sign out')
    h.client = null
    expect(renderToStaticMarkup(createElement(SignOut))).toBe('')
  })
  it('leaves the profile first, then waits for the client to end the session', async () => {
    const order: string[] = []
    let finish!: () => void
    const client = { logout: vi.fn(() => (order.push('logout'), new Promise<void>((r) => (finish = r)))) }
    const done = signOutNow(client, (r) => order.push(`go:${r.name}`))
    expect(order).toEqual(['go:hive', 'logout'])
    let settled = false
    void done.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false) // still waiting for the hive
    finish()
    await done
    expect(settled).toBe(true)
  })
})
