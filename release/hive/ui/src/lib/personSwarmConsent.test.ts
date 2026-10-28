import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { PersonSwarmCard } from '../api/personSwarms'
import { PersonSwarmConsent, type PersonSwarmClient } from './personSwarmConsent'

const fixture = (extra: Partial<PersonSwarmCard> = {}): PersonSwarmCard => ({
  program_id: 'p', program_name: 'Any app', template_id: 't', template_digest: 'td', key_id: 'own', month_usd: 5,
  consent_revision: null, authority_revision: 'ar', providers: ['provider'], spend_note: 'Exact host note.', consent_current: false,
  minds: [{ slot: 'helper', name: 'A helper', persona: '', model: 'provider/model', budget_usd: 0 }], rules: [], ...extra,
})
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const setup = () => {
  let now = 0, current = true
  const api = {
    program: vi.fn<PersonSwarmClient['program']>(async () => ({ person_swarm: { release_digest: 'release', template_ids: ['t'], template_digests: { t: 'td' } } })),
    appSwarmCard: vi.fn<NonNullable<PersonSwarmClient['appSwarmCard']>>(async () => fixture()),
    consentAppSwarm: vi.fn<NonNullable<PersonSwarmClient['consentAppSwarm']>>(async () => fixture()),
  }
  const log = vi.fn()
  const host = new PersonSwarmConsent(api, 'p', () => current, () => now, log)
  return { host, api, log, time: (value: number) => { now = value }, retire: () => { current = false } }
}

describe('host P2 consent lifetime and unchanged authority', () => {
  it('does not send the first GET if a synchronous loading subscriber retires the host', async () => {
    const { host, api } = setup()
    host.subscribe(() => { if (host.getSnapshot().kind === 'loading') host.dispose() })
    await host.check()
    expect(api.program).not.toHaveBeenCalled()
    expect(api.appSwarmCard).not.toHaveBeenCalled()
  })
  it('does not offer zero or multiple pinned templates and logs without card or consent requests', async () => {
    const { host, api, log } = setup()
    api.program.mockResolvedValueOnce({ person_swarm: { release_digest: 'r', template_ids: [], template_digests: {} } })
    await host.check()
    expect(host.getSnapshot().kind).toBe('hidden')
    api.program.mockResolvedValueOnce({ person_swarm: { release_digest: 'r', template_ids: ['t', 'other'], template_digests: { t: 'td' } } })
    await host.check()
    expect(api.appSwarmCard).not.toHaveBeenCalled()
    expect(api.consentAppSwarm).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(2)
  })
  it('refuses a card whose template digest is not the verified manifest template', async () => {
    const { host, api } = setup()
    api.appSwarmCard.mockResolvedValueOnce(fixture({ template_digest: 'changed-unbound' }))
    await host.check()
    expect(host.getSnapshot().kind).toBe('unavailable')
    expect(api.consentAppSwarm).not.toHaveBeenCalled()
  })
  it('shows only missing/stale setup consent on open and can recheck a host-observed act', async () => {
    const { host, api } = setup()
    api.appSwarmCard.mockResolvedValue(fixture({ consent_current: true }))
    await host.check()
    expect(host.getSnapshot().kind).toBe('hidden')
    await host.check(true)
    expect(host.getSnapshot().kind).toBe('asking')
  })
  it('never offers approval without an own key and monthly total', async () => {
    const { host, api } = setup()
    api.appSwarmCard.mockResolvedValueOnce(fixture({ key_id: null }))
    await host.check()
    expect(host.getSnapshot().kind).toBe('unavailable')
    api.appSwarmCard.mockResolvedValueOnce(fixture({ month_usd: null }))
    await host.check()
    expect(host.getSnapshot().kind).toBe('unavailable')
  })
  it('rejects an early tap and held key, then saves only the original five bindings', async () => {
    const { host, api, time } = setup()
    await host.check()
    await host.accept({ at: 100000 })   // a supplied future timestamp cannot advance the host clock
    time(449)
    await host.accept({ at: 449 })
    time(450)
    await host.accept({ at: 450, repeat: true })
    expect(api.consentAppSwarm).not.toHaveBeenCalled()
    await host.accept({ at: 450 })
    expect(api.consentAppSwarm).toHaveBeenCalledWith('p', 't', { template_digest: 'td', key_id: 'own', month_usd: 5, consent_revision: null, authority_revision: 'ar' })
    expect(host.getSnapshot().kind).toBe('saved')
  })
  it('Not now writes no consent and makes an already captured accept inert', async () => {
    const { host, api } = setup()
    await host.check()
    host.decline()
    await host.accept({ at: 999 })
    expect(api.consentAppSwarm).not.toHaveBeenCalled()
    expect(host.getSnapshot().kind).toBe('hidden')
  })
  it('serializes duplicate acceptance while a request is in flight', async () => {
    const { host, api, time } = setup()
    const pending = deferred<PersonSwarmCard>()
    api.consentAppSwarm.mockReturnValue(pending.promise)
    await host.check()
    time(450)
    const a = host.accept({ at: 450 })
    await host.accept({ at: 451 })
    expect(api.consentAppSwarm).toHaveBeenCalledTimes(1)
    pending.resolve(fixture())
    await a
    expect(host.getSnapshot().kind).toBe('saved')
  })
  it('a stale card allows only a new read; Look again re-arms and never resends consent itself', async () => {
    const { host, api, time } = setup()
    api.consentAppSwarm.mockRejectedValueOnce(new ApiError(409, 'card_changed', 'untrusted text', { envelope: { card: fixture({ month_usd: 9 }) } }))
    await host.check()
    time(450)
    await host.accept({ at: 450 })
    expect(host.getSnapshot().kind).toBe('changed')
    await host.accept({ at: 999 })
    expect(api.consentAppSwarm).toHaveBeenCalledTimes(1)
    time(1000)
    api.appSwarmCard.mockResolvedValueOnce(fixture({ month_usd: 9 }))
    await host.lookAgain()
    time(1449)
    await host.accept({ at: 1449 })
    expect(api.consentAppSwarm).toHaveBeenCalledTimes(1)
    time(1450)
    await host.accept({ at: 1450 })
    expect(api.consentAppSwarm.mock.calls[1][2].month_usd).toBe(9)
  })
  it('a lost answer stays unknown and never automatically replays the POST', async () => {
    const { host, api, time } = setup()
    api.consentAppSwarm.mockRejectedValueOnce(new ApiError(0, 'answer_unreadable', 'lost'))
    await host.check()
    time(450)
    await host.accept({ at: 450 })
    expect(host.getSnapshot().kind).toBe('unknown')
    await host.accept({ at: 2000 })
    expect(api.consentAppSwarm).toHaveBeenCalledTimes(1)
  })
  it('identity change drops a late card without opening a dialog or sending consent', async () => {
    const { host, api, retire } = setup()
    const pending = deferred<PersonSwarmCard>()
    api.appSwarmCard.mockReturnValue(pending.promise)
    const opened = host.check()
    await Promise.resolve()
    retire()
    pending.resolve(fixture())
    await opened
    expect(host.getSnapshot().kind).toBe('loading')
    await host.accept({ at: 1000 })
    expect(api.consentAppSwarm).not.toHaveBeenCalled()
  })
  it('unmount retires a sent request and drops its late saved state', async () => {
    const { host, api, time } = setup()
    const pending = deferred<PersonSwarmCard>()
    api.consentAppSwarm.mockReturnValue(pending.promise)
    await host.check()
    time(450)
    const accepted = host.accept({ at: 450 })
    host.dispose()
    pending.resolve(fixture())
    await accepted
    expect(host.getSnapshot().kind).not.toBe('saved')
  })
  it('P14: the page opening a person app hears only this card\'s own outcome (saved after the POST, declined from the card)', async () => {
    const { host, time } = setup()
    const heard: string[] = []
    host.onSettle = (kind) => heard.push(kind)
    host.decline()                       // nothing was asked yet: not a decline of the card
    await host.check()
    time(450)
    await host.accept({ at: 450 })
    expect(heard).toEqual(['saved'])
    await host.check(true)
    host.decline()
    expect(heard).toEqual(['saved', 'declined'])
  })
})
