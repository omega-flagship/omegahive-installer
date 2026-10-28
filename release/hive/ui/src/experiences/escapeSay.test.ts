import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import hostSource from './ExperienceHost.tsx?raw'

/**
 * r1f: an escape (or a reset) for A answered after a sign-in change says nothing to B. The REAL store identity change
 * (identityEpoch testkit), synthetic SimClients, invented looks only.
 */
const mem = new Map<string, string>()
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

import type { UiPrefs } from '../shell/uiVariant'
const { escapeToClassic, lookState, resetLook, SEED_VARIANTS } = await import('../shell/uiVariant')
const { loadLookBound } = await import('../shell/lookIdentity')
const { escapeAndSay } = await import('./escapeSay')
const { isCurrent, releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')
type Person = ReturnType<typeof testPerson>

const lookOf = (id: string, experience: string | null = null): UiPrefs => ({ variant: SEED_VARIANTS.find((v) => v.id === id)!, layout: null, apps: null, experience })
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Same-tab A then B; A's saves wait to be released (or fail), everything else answers at once. */
function tab(name: string, opts: { fail?: boolean } = {}) {
  const a = testPerson(`${name}-a`)
  const b = testPerson(`${name}-b`, { sameTab: a })
  const gates: (() => void)[] = []
  const forA = () => isCurrent(a)
  Object.assign(a.client, {
    me: async () => ({ principal: forA() ? 'user:p_inv_esc_a' : 'user:p_inv_esc_b' }),
    uiPrefs: async () => ({ prefs: forA() ? lookOf('ember-forge', 'still') : lookOf('deep-sea'), updated_at: null }),
    setUiPrefs: (p: UiPrefs) => new Promise((res, rej) => gates.push(() => (opts.fail ? rej(new Error('offline')) : res({ prefs: p, updated_at: 'now' })))),
    resetUiPrefs: () => new Promise((res) => gates.push(() => res({ prefs: null, updated_at: null }))),
  })
  return { a, b, release: () => gates.splice(0).forEach((g) => g()) }
}
async function asA(t: { a: Person }) {
  await signInAs(t.a)
  await loadLookBound(t.a.client)
  expect(lookState().saved?.experience).toBe('still')
}

beforeEach(() => mem.clear())
afterEach(() => releasePersons())

describe('r1f: a late answer for A says nothing to B', () => {
  it.each([
    ['the crash guard (always says)', 'always', false],
    ['the Ω way back, kept on this device only (says when local)', 'local', true],
  ] as const)('escape: %s, answered after the switch: B sees no message', async (_n, when, fail) => {
    const t = tab(`esc-${when}`, { fail })
    await asA(t)
    const said: string[] = []
    const late = escapeAndSay('Back to the classic hive', { when, say: (m) => void said.push(m.title) })
    await settle()
    await switchPerson(t.a, t.b)
    await settle()
    t.release() // A's answer lands under B
    expect(await late).toBe('stale')
    await settle()
    expect(said).toEqual([])
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
  })

  it('escape answered for the same person still says so', async () => {
    const t = tab('esc-same', { fail: true })
    await asA(t)
    const said: string[] = []
    const p = escapeAndSay('Back to the classic hive', { when: 'local', say: (m) => void said.push(m.title) })
    await settle()
    t.release()
    expect(await p).toBe('local')
    expect(said).toEqual(['Back to the classic hive'])
  })

  it('escapeToClassic and resetLook themselves answer stale after a switch', async () => {
    const t = tab('raw')
    await asA(t)
    const esc = escapeToClassic(t.a.client)
    const rst = resetLook(t.a.client)
    await settle()
    await switchPerson(t.a, t.b)
    t.release()
    expect(await esc).toBe('stale')
    expect(await rst).toBe('stale')
  })

  it('the experience host only escapes through escapeAndSay (no unbound announcement left)', () => {
    expect(hostSource).not.toMatch(/escapeToClassic\(/)
    expect(hostSource.match(/escapeAndSay\(/g)?.length).toBe(2)
  })
})
