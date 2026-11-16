import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { installBody, PERSON_APP_REASONS, personAppReason, readPersonAppOpen } from '../api/personApps'
import { BUSY_RETRIES, PersonAppOpener, type PersonAppClient } from './personAppOpen'

/** P14: a person app's host open. Invented app, swarms and people only. */
const READY = { state: 'ready', program: 'p', swarm_id: 's_own', needs: [], helpers: 'none', private: 'Private to you; hive admins can audit.' }
const helpers = (h: string, extra: object = {}) => ({ ...READY, helpers: h, ...extra })
const unavailable = (reason: string, status = 409, message = 'raw /secret/path s_other k_key Traceback') =>
  new ApiError(status, 'app_unavailable', message, { envelope: { code: 'app_unavailable', message, reason, action: 'try_again' } })

const setup = () => {
  let current = true
  const waits: { ms: number; run: () => void }[] = []
  const api = {
    openPersonApp: vi.fn<NonNullable<PersonAppClient['openPersonApp']>>(async () => READY),
    resetPersonApp: vi.fn<NonNullable<PersonAppClient['resetPersonApp']>>(async () => READY),
  }
  const opener = new PersonAppOpener(api, 'p', () => current, (ms, run) => { waits.push({ ms, run }); return 0 as never })
  return { opener, api, waits, retire: () => { current = false } }
}

describe('opening a person app', () => {
  it('a ready answer opens straight into the host-named context, with no swarm to pick', async () => {
    const { opener, api } = setup()
    await opener.open()
    expect(api.openPersonApp).toHaveBeenCalledWith('p')
    expect(opener.getSnapshot()).toEqual({ kind: 'ready', swarmId: 's_own', needs: [], helpers: 'none', spaceLine: null })
  })
  it('no key: the app is open, the helpers wait for the key card; opening again resumes the same flow', async () => {
    const { opener, api } = setup()
    api.openPersonApp.mockResolvedValueOnce(helpers('key_required', { needs: ['ai_key', 'monthly_total'] }))
    await opener.open()
    expect(opener.getSnapshot()).toMatchObject({ kind: 'ready', swarmId: 's_own', helpers: 'key', needs: ['ai_key', 'monthly_total'] })
    api.openPersonApp.mockResolvedValueOnce(helpers('consent_required', { space_line: 'Any app will set up your space.' }))
    await opener.open()
    expect(opener.getSnapshot()).toMatchObject({ kind: 'ready', helpers: 'consent', spaceLine: 'Any app will set up your space.' })
  })
  it("the host card's saved answer opens again (P2's ensure deploys); declining keeps the app open with nothing made", async () => {
    const { opener, api } = setup()
    api.openPersonApp.mockResolvedValueOnce(helpers('consent_required', { space_line: 'line', swarm_id: 's_new' }))
    await opener.open()
    opener.settled('saved')
    await vi.waitFor(() => expect(opener.getSnapshot()).toMatchObject({ helpers: 'none' }))
    expect(api.openPersonApp).toHaveBeenCalledTimes(2)
    api.openPersonApp.mockResolvedValue(helpers('consent_required', { space_line: 'line', program: 'p' }))
    await opener.open()
    opener.settled('declined')
    expect(opener.getSnapshot()).toMatchObject({ kind: 'ready', swarmId: 's_own', helpers: 'declined' })
    await opener.open()                                    // a reload in this tab does not ask again
    expect(opener.getSnapshot()).toMatchObject({ helpers: 'declined' })
    opener.askHelpers()                                    // the banner's "Set up helpers" does
    await vi.waitFor(() => expect(opener.getSnapshot()).toMatchObject({ helpers: 'consent' }))
    api.openPersonApp.mockReset()
  })
  it('a settled outcome outside the card is ignored (never a frame message)', async () => {
    const { opener, api } = setup()
    await opener.open()
    opener.settled('saved')
    opener.settled('declined')
    expect(opener.getSnapshot()).toMatchObject({ kind: 'ready', helpers: 'none' })
    expect(api.openPersonApp).toHaveBeenCalledTimes(1)
  })
  it('every failure is one approved reason in fixed words; nothing the answer carried is kept', async () => {
    for (const reason of Object.keys(PERSON_APP_REASONS)) {
      if (reason === 'busy') continue
      const { opener, api } = setup()
      api.openPersonApp.mockRejectedValueOnce(unavailable(reason))
      await opener.open()
      expect(opener.getSnapshot()).toEqual({ kind: 'failed', reason })
      expect(JSON.stringify(opener.getSnapshot())).not.toMatch(/secret|s_other|k_key|Traceback/)
    }
  })
  it('an unknown reason, a fault or an unreadable answer is "your hive couldn\'t create your space"', async () => {
    expect(personAppReason(unavailable('invented_reason'))).toBe('space_failed')
    expect(personAppReason(new Error('boom'))).toBe('space_failed')
    expect(personAppReason(new ApiError(403, 'person_required', 'x'))).toBe('not_available_to_you')
    const { opener, api } = setup()
    api.openPersonApp.mockResolvedValueOnce({ ...READY, program: 'another-app' })
    await opener.open()
    expect(opener.getSnapshot()).toEqual({ kind: 'failed', reason: 'space_failed' })
  })
  it('"Set up again" is the host reset, never a silent replacement by a plain open', async () => {
    const { opener, api } = setup()
    api.openPersonApp.mockRejectedValueOnce(unavailable('space_needs_setup'))
    await opener.open()
    expect(opener.getSnapshot()).toEqual({ kind: 'failed', reason: 'space_needs_setup' })
    expect(api.resetPersonApp).not.toHaveBeenCalled()
    await opener.open(true)
    expect(api.resetPersonApp).toHaveBeenCalledWith('p')
    expect(opener.getSnapshot().kind).toBe('ready')
  })
  it('busy retries are bounded with growing waits, then the busy card stays', async () => {
    const { opener, api, waits } = setup()
    api.openPersonApp.mockRejectedValue(unavailable('busy', 429))
    await opener.open()
    for (let i = 0; i < BUSY_RETRIES.length; i++) {
      expect(waits[i].ms).toBe(BUSY_RETRIES[i])
      waits[i].run()
      await vi.waitFor(() => expect(api.openPersonApp).toHaveBeenCalledTimes(i + 2))
    }
    await vi.waitFor(() => expect(opener.getSnapshot()).toEqual({ kind: 'failed', reason: 'busy' }))
    expect(waits).toHaveLength(BUSY_RETRIES.length)
    expect([...BUSY_RETRIES]).toEqual([1000, 2000, 4000])
  })
  it('an answer for an earlier identity or a stopped page never lands', async () => {
    const { opener, api, retire } = setup()
    let resolve!: (v: unknown) => void
    api.openPersonApp.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const pending = opener.open()
    retire()
    resolve(READY)
    await pending
    expect(opener.getSnapshot().kind).toBe('opening')
    const second = setup()
    let late!: (v: unknown) => void
    second.api.openPersonApp.mockReturnValueOnce(new Promise((r) => { late = r }))
    const run = second.opener.open()
    second.opener.stop()
    late(READY)
    await run
    expect(second.opener.getSnapshot().kind).toBe('opening')
  })
})

describe('the host answer reader', () => {
  it('reads only the three known states for this app', () => {
    expect(readPersonAppOpen(READY, 'p')?.state).toBe('ready')
    expect(readPersonAppOpen({ ...READY, program: 'q' }, 'p')).toBeNull()
    expect(readPersonAppOpen({ ...READY, needs: ['someone_elses_key'] }, 'p')).toBeNull()
    expect(readPersonAppOpen({ state: 'pick_a_swarm', program: 'p' }, 'p')).toBeNull()
    expect(readPersonAppOpen({ ...READY, helpers: 'pick_a_swarm' }, 'p')).toBeNull()
    expect(readPersonAppOpen({ ...READY, helpers: 'consent_required' }, 'p')).toBeNull()   // the card line is required
    expect(readPersonAppOpen({ ...READY, swarm_id: '' }, 'p')).toBeNull()
  })
})

describe('installing is the review', () => {
  const person = { program: 'p', placement: 'person' as const, installed: false, release_digest: 'sha256:r', person_allow: 'all' as const }
  const swarm = { program: 'q', placement: 'swarm' as const, installed: false, release_digest: 'sha256:q' }
  it('sends exactly the release and placement shown, and the audience chosen', () => {
    expect(installBody(person, { everyone: true, people: [], useIn: ['s_1'] })).toEqual({ release_digest: 'sha256:r', placement: 'person' })
    expect(installBody(person, { everyone: false, people: ['user:u_b', 'user:u_a', 'user:u_a'], useIn: [] }))
      .toEqual({ release_digest: 'sha256:r', placement: 'person', person_allow: ['user:u_a', 'user:u_b'] })
    expect(installBody(person, { everyone: false, people: [], useIn: [] })).toBeNull()
  })
  it('a swarm app offers "Use in" in the same step', () => {
    expect(installBody(swarm, { everyone: true, people: [], useIn: ['s_1', 's_2'] })).toEqual({ release_digest: 'sha256:q', placement: 'swarm', use_in: ['s_1', 's_2'] })
    expect(installBody(swarm, { everyone: true, people: [], useIn: [] })).toEqual({ release_digest: 'sha256:q', placement: 'swarm' })
  })
  it('an unpinned release cannot be installed', () => {
    expect(installBody({ ...person, release_digest: null }, { everyone: true, people: [], useIn: [] })).toBeNull()
  })
})
