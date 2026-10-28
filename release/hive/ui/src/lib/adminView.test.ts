import { describe, expect, it } from 'vitest'
import { adminViewOf } from './useAdmin'
import navSource from '../shell/Nav.tsx?raw'
import paletteSource from '../features/palette/CommandPalette.tsx?raw'
import shortcutsSource from '../shell/shortcuts.ts?raw'

/** Kimi K3 follow-up (9593fd1) P2-4: the navigation fails closed to the member's view until /me says admin. */
describe('P2-4: admin entries only once the hive has said an admin is signed in', () => {
  it('while /me loads: the member view', () => {
    expect(adminViewOf({ me: undefined, loaded: false })).toBe(false)
    // even a stale admin answer is not trusted while a fresh read is loading
    expect(adminViewOf({ me: { kind: 'sso', role: 'admin' }, loaded: false })).toBe(false)
  })
  it('when /me failed or the hive did not say: the member view', () => {
    expect(adminViewOf({ me: undefined, loaded: true })).toBe(false)
    expect(adminViewOf({ me: null, loaded: true })).toBe(false)
  })
  it('a member: the member view; an admin or the hive password: the admin view', () => {
    expect(adminViewOf({ me: { kind: 'sso', role: 'member' }, loaded: true })).toBe(false)
    expect(adminViewOf({ me: { kind: 'sso', role: 'admin' }, loaded: true })).toBe(true)
    expect(adminViewOf({ me: { kind: 'password', role: undefined } as never, loaded: true })).toBe(true)
  })
  it('the rail, the palette and the g keys all take it from the one place', () => {
    for (const src of [navSource, paletteSource, shortcutsSource]) {
      expect(src).toContain('useAdminView()')
      expect(src).not.toMatch(/!loaded \|\| !me/)
    }
  })
})
