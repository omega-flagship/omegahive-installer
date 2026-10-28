import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from './live'
import { formatPersonSwarmUSD, P2_SAVED, personSwarmCardRoute, readPersonSwarmCard, shownPersonSwarm, singlePersonSwarm, type PersonSwarmCard } from './personSwarms'

const card = (): PersonSwarmCard => ({
  program_id: 'a/b', program_name: 'A different app', template_id: 't?', template_digest: 'template-hash',
  key_id: 'own-key', month_usd: 13.125, consent_revision: { granted_at: 'old', withdrawn_at: null }, authority_revision: 'authority',
  providers: ['p'], spend_note: 'Host note <keep as text>', consent_current: false,
  minds: [{ slot: 'one', name: 'Only one helper', persona: 'General purpose', model: 'p/m', budget_usd: 0 }], rules: [],
})
afterEach(() => vi.unstubAllGlobals())

describe('P2 typed host card and existing wire contract', () => {
  it('shows the actual USD amount without rounding a tiny positive limit to zero or converting currency', () => {
    expect(formatPersonSwarmUSD(1e-12)).toBe('1e-12 USD')
    expect(formatPersonSwarmUSD(13.125)).toBe('13.125 USD')
  })
  it('uses the existing route, encodes each id, and never appends /card', () => {
    expect(personSwarmCardRoute('a/b', 't?')).toBe('/api/me/app-swarms/a%2Fb/t%3F')
  })
  it('requires host spend_note/current verdict/identity and refuses malformed or nonfinite data', () => {
    expect(readPersonSwarmCard(card(), 'a/b', 't?')).not.toBeNull()
    expect(readPersonSwarmCard({ ...card(), spend_note: '' }, 'a/b', 't?')).toBeNull()
    expect(readPersonSwarmCard({ ...card(), consent_current: undefined }, 'a/b', 't?')).toBeNull()
    expect(readPersonSwarmCard({ ...card(), month_usd: Infinity }, 'a/b', 't?')).toBeNull()
    expect(readPersonSwarmCard(card(), 'another', 't?')).toBeNull()
  })
  it('copies and freezes the displayed snapshot and echoes all five bindings without coercion', () => {
    const raw = card()
    const parsed = readPersonSwarmCard(raw, 'a/b', 't?')!
    raw.consent_revision!.granted_at = 'mutated'
    raw.minds[0].name = 'mutated'
    expect(parsed.minds[0].name).toBe('Only one helper')
    expect(Object.isFrozen(parsed.consent_revision)).toBe(true)
    expect(shownPersonSwarm(parsed)).toEqual({ template_digest: 'template-hash', key_id: 'own-key', month_usd: 13.125, consent_revision: { granted_at: 'old', withdrawn_at: null }, authority_revision: 'authority' })
    expect(Object.keys(shownPersonSwarm(parsed)).sort()).toEqual(['authority_revision', 'consent_revision', 'key_id', 'month_usd', 'template_digest'])
  })
  it('accepts exactly one verified pinned template, never an unbound or multiple-template list', () => {
    expect(singlePersonSwarm({ release_digest: 'release', template_ids: ['t'], template_digests: { t: 'digest' } })).toEqual({ releaseDigest: 'release', templateId: 't', templateDigest: 'digest' })
    expect(singlePersonSwarm({ release_digest: 'release', template_ids: ['t'] })).toBeNull()
    expect(singlePersonSwarm({ release_digest: 'release', template_ids: ['t', 'x'], template_digests: { t: 'digest' } })).toBeNull()
  })
  it('GETs the real card and posts the exact five-field snapshot to /consent', async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(card()), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = new LiveClient('http://hive.test')
    const snapshot = await client.appSwarmCard('a/b', 't?')
    await client.consentAppSwarm('a/b', 't?', shownPersonSwarm(snapshot))
    expect(fetch.mock.calls[0][0]).toBe('http://hive.test/api/me/app-swarms/a%2Fb/t%3F')
    expect(fetch.mock.calls[1][0]).toBe('http://hive.test/api/me/app-swarms/a%2Fb/t%3F/consent')
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual(shownPersonSwarm(snapshot))
    client.dispose()
  })
  it('does not infer a host act hint from forged app JSON and keeps the default body untouched', async () => {
    const body = { status: 'done', detail: { consent_required: true, personSwarmConsentRequired: true } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    const client = new LiveClient('http://hive.test')
    const sent = { swarm_id: 's', action: 'a', items: [] }
    expect(await client.hostProgramAct('p', sent)).toEqual({ result: body, personSwarmConsentRequired: false })
    expect(await client.programAct('p', sent)).toEqual(body)
    client.dispose()
  })
  it('consumes only the host advisory header out of band; frame/default result remains identical', async () => {
    const body = { status: 'refused', message: 'Existing application words' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'X-Hive-Person-Swarm-Consent-Required': '1' } })))
    const client = new LiveClient('http://hive.test')
    const sent = { swarm_id: 's', action: 'a', items: [] }
    expect(await client.hostProgramAct('p', sent)).toEqual({ result: body, personSwarmConsentRequired: true })
    expect(await client.programAct('p', sent)).toEqual(body)
    client.dispose()
  })
  it('retains the owner exact saved line without claiming that helpers exist', () => {
    expect(P2_SAVED).toBe('Saved. Your helpers will be set up the next time the app needs them.')
  })
})
