/**
 * The visible Sign out control (pairs with host b203496): it is on You & your keys, it leaves the profile before the
 * session ends, and it waits for the client's sign-out. INVENTED clients only.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { profileScreen, type ProfileInput } from './data'

// opens a real MeTTa space: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const { signOutNow } = await import('./ProfilePage')

const space = ScreensSpace.open()
const compose = (screen: string, facts: Parameters<ScreensSpace['compose']>[2]) => space.compose(screen, 'classic', facts)
const input = (over: Partial<ProfileInput>): ProfileInput => ({
  me: { status: 'loading', data: undefined, error: undefined, refreshing: false }, keys: [], keysError: undefined, agents: [],
  connected: true, signingOut: false, adding: false, work: { editing: new Set(), confirming: new Set() }, ...over,
})
const html = (over: Partial<ProfileInput>) => {
  const { data, facts } = profileScreen(input(over), compose)
  return renderToStaticMarkup(createElement(Screen, { plan: compose('profile', facts), host: { data, onAction: () => {} } }))
}

describe('Sign out on You & your keys', () => {
  it('MeTTa shows a Sign out button when a client is connected, and none without one; it waits while signing out', () => {
    expect(html({})).toContain('>Sign out</button>')
    expect(html({ connected: false })).not.toContain('Sign out')
    expect(html({ signingOut: true })).toMatch(/<button type="button" disabled=""[^>]*>Signing out…<\/button>/)
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
