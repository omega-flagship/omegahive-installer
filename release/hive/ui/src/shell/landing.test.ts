import { describe, expect, it, vi } from 'vitest'

/**
 * Where a person lands (Ask-and-apps contract R1.1 §7, #6): awake unless their own row says Pro; every whole-preference
 * write keeps it; the write after going to Pro is bound to whoever went there, so a save answering after a sign-in
 * change writes nothing on this page. INVENTED data, no network.
 */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { useHive } = await import('../store/store')
const { carryLanding, withExperience } = await import('./uiVariant')
const { landingOf, rememberLanding } = await import('./landing')
const { bindEpoch } = await import('../lib/identityEpoch')

const base = { variant: null, layout: null, apps: null, experience: null }

describe('landing', () => {
  it('absent means awake; only an explicit pro is Pro', () => {
    expect(landingOf(null)).toBe('awake')
    expect(landingOf(base)).toBe('awake')
    expect(landingOf({ ...base, landing: 'pro' })).toBe('pro')
    expect(landingOf({ ...base, landing: null })).toBe('awake')
  })
  it('every whole-preference write keeps it unless it sets one itself', () => {
    const mine = { ...base, experience: 'cosmos', landing: 'pro' as const }
    expect(withExperience(mine, 'still').landing).toBe('pro')
    expect(carryLanding({ ...base }, mine).landing).toBe('pro')
    expect(carryLanding({ ...base, landing: 'awake' }, mine).landing).toBe('awake')
    expect(carryLanding({ ...base }, null).landing).toBeUndefined()
    expect(carryLanding(null as never, mine)).toBeNull()
  })
  it('a write bound to A, answering after B signed in, is stale; no host is said', async () => {
    let release!: () => void
    const client = { setUiPrefs: () => new Promise((r) => { release = () => r({ prefs: { ...base, landing: 'pro' }, rev: 1 }) }) }
    const binding = bindEpoch()
    const p = rememberLanding(client as never, 'pro', binding)
    useHive.setState({ inits: useHive.getState().inits + 1 })
    release?.()
    expect(['stale']).toContain(await p)
    expect(await rememberLanding(null, 'pro')).toBe('no-host')
    expect(await rememberLanding(client as never, 'awake')).toBe('same')
  })
})
