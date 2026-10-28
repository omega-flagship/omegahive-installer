import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from '../../api/live'
import { ApiError } from '../../api/client'
import { setupRefusal, SETUP_NEEDS_TURN_WORDS, STUDIO_OFF_WORDS, TURN_TOO_OLD_WORDS } from './refusals'
import type { SetupPrep } from './api'

/** r1.10 (host R7 client contract): POST /api/studio/setup from the live client, and its refusals. INVENTED values. */
beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
const prep: SetupPrep = { operation_id: 'op_inv_turn', title: 'Picnic poster', detail: 'A poster for the picnic', scene_id: 'scene_inv1', max_steps: 12, window_minutes: 60, source_ref: { artifact_id: 'ar_inv_piece', revision: 2, digest: 'sha256:piece' }, studio_swarm: 's_mystudio' }
const answer = { maker: { id: 'a_mine', name: 'My maker', swarm_id: 's_mystudio', kind: 'omega' }, request: { maker_id: 'a_mine' }, consent: {}, consent_digest: `sha256:${'a'.repeat(64)}`, maker_name: 'My maker', key_label: 'my key' }

describe('r1.10: the live client asks the host for the setup card', () => {
  it('POSTs /api/studio/setup with ONLY what the person chose (no maker, key, model, role or swarm), and adds the turn and prep', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }) }))
    const v = await new LiveClient('http://hive.invalid').studioSetupProposal('omegadesign', 's_page', prep) as Record<string, unknown>
    expect(calls.map((c) => [c.method, c.url.replace('http://hive.invalid', '')])).toEqual([['POST', '/api/studio/setup']])
    const body = calls[0].body as { request: Record<string, unknown> }
    expect(Object.keys(body)).toEqual(['request'])
    expect(Object.keys(body.request).sort()).toEqual(['detail', 'max_steps', 'piece', 'program_id', 'title', 'window_minutes'])
    expect(body.request.piece).toEqual({ scene_id: 'scene_inv1', source_ref: { artifact_id: 'ar_inv_piece', revision: 2, digest: 'sha256:piece' } })   // r1.13: the picked saved canvas, exactly
    for (const k of ['maker_id', 'key_id', 'model', 'role_id', 'tools', 'swarm_id', 'app_pin', 'consent_digest', 'operation_id']) expect(k in body.request).toBe(false)
    expect(v.operation_id).toBe('op_inv_turn')
    expect(v.prep).toEqual(prep)
    expect(v.request).toEqual(answer.request)                         // the host's request, untouched
  })
  it('without an Ask turn to start from it sends nothing and says Studio starts from the Ask', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const e = await new LiveClient('http://hive.invalid').studioSetupProposal('omegadesign', 's_page').then(() => null, (x: unknown) => x)
    expect(f).not.toHaveBeenCalled()
    expect(setupRefusal(e).words).toBe(SETUP_NEEDS_TURN_WORDS)
  })
})

describe('r1.10: every R7 setup code in plain words with a way on', () => {
  const r = (status: number, code: string, envelope: Record<string, unknown> = {}) => setupRefusal(new ApiError(status, code, 'x', { envelope: { code, message: 'x', ...envelope } }))
  it('own_key_needed (scope studio_maker): Keys, nothing started', () => {
    const x = r(402, 'own_key_needed', { scope: 'studio_maker', pays: 'own-key', provider: 'openrouter' })
    expect([x.code, x.remedy?.go]).toEqual(['own_key_needed', 'keys'])
  })
  it('own_key_only (R7.2 PATCH): plain words and Keys; O3 never offers that edit', () => {
    const x = r(403, 'own_key_only')
    expect(x.words).toMatch(/can only run on your own key/)
    expect(x.remedy?.go).toBe('keys')
  })
  it('the maker codes', () => {
    expect(r(409, 'studio_maker_unavailable', { reason: 'template_unset' }).words).toMatch(/An admin needs to set it up/)
    expect(r(409, 'studio_maker_missing').words).toMatch(/Load the card again to set it up/)
    expect(r(409, 'maker_not_yours').words).toMatch(/someone else’s own Studio maker/)
    expect(r(409, 'studio_maker_attach_unsupported').words).toMatch(/needs an admin to attach makers/)
    expect(r(409, 'app_not_attached').words).toMatch(/isn’t available for that app/)
  })
  it('404 not_available at setup is Studio off; 400 turn_too_old asks again; the monthly total keeps its remedy', () => {
    expect(r(404, 'not_available').words).toBe(STUDIO_OFF_WORDS)
    expect(r(400, 'bad_request', { reason: 'turn_too_old' }).words).toBe(TURN_TOO_OLD_WORDS)
    const m = setupRefusal(new ApiError(402, 'spend_limit', 'x', { envelope: { code: 'spend_limit', message: 'x', limit: { kind: 'own_key_limit' }, detail: { reason: 'monthly_total_required' } } }))
    expect([m.code, m.remedy?.go]).toEqual(['monthly_total_required', 'me'])
  })
})
