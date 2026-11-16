import { describe, expect, it } from 'vitest'
import { CLASSIC_CHROME, chromeFromSwatch, type ExperienceChrome } from '../experiences/chrome'
import { EXPERIENCES } from '../experiences/registry'
import { chrome as canvas } from '../experiences/canvas/chrome'
import { chrome as construct } from '../experiences/construct/chrome'
import { chrome as cosmos } from '../experiences/cosmos/chrome'
import { chrome as flux } from '../experiences/flux/chrome'
import { chrome as still } from '../experiences/still/chrome'
import { appIdentityTokens, DESIGNED_APPS } from '../shell/appLook'
import { DEFAULT_VARIANT } from '../shell/uiVariant'
import { SimClient } from '../api/sim/SimClient'
import {
  APP_CONTEXT_SCHEMA,
  appContext,
  artifactCandidates,
  assetCandidates,
  BRIDGE_LIMITS,
  cancelledReply,
  chromeTokens,
  identityTokens,
  kindMatches,
  MAX_BRIDGE_MESSAGE,
  parseBridgeMessage,
  pickedReply,
  rateLimit,
  safeToken,
} from './appBridge'

const ch = '12345678-1234-1234-1234-123456789abc'
const D = (s: string) => `sha256:${s.repeat(64).slice(0, 64)}`
const HEXSHA = 'ab'.repeat(32)

/** Only plain data: strings, finite numbers, booleans, null, arrays and plain objects. */
function plainData(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(plainData)
  if (typeof v === 'object') return Object.getPrototypeOf(v) === Object.prototype && Object.values(v as object).every(plainData)
  return false
}
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])

describe('bridge context (data only)', () => {
  const identity = appIdentityTokens(DESIGNED_APPS.omegadesign?.theme ?? Object.values(DESIGNED_APPS)[0].theme, DEFAULT_VARIANT)

  it('carries the schema, experience, grammar, chrome, identity, motion and capabilities, as plain data', () => {
    const c = appContext({ experience: 'still', chrome: still, identity, reducedMotion: true, picker: true })
    expect(c.schema).toBe(APP_CONTEXT_SCHEMA)
    expect(c).toMatchObject({ experience: 'still', grammar: 'still', reducedMotion: true, capabilities: { picker: true, draftSave: false, presence: false, handoff: false } })
    expect(c.chrome).toEqual(still)
    expect(c.appIdentity).toEqual(identity)
    expect(Object.keys(c).sort()).toEqual(['appIdentity', 'capabilities', 'chrome', 'experience', 'grammar', 'insets', 'person', 'reducedMotion', 'reserved', 'schema'])
    expect(c.person).toBeNull()
    expect(plainData(c)).toBe(true)
    expect(structuredClone(c)).toEqual(c)   // survives postMessage unchanged
    expect(strings(c).some((s) => /url\(|https?:|javascript:|data:/i.test(s))).toBe(false)
  })

  it('every shipped experience chrome (and every swatch stand-in) passes through unchanged', () => {
    for (const c of [CLASSIC_CHROME, canvas, construct, cosmos, flux, still, ...EXPERIENCES.map((e) => chromeFromSwatch(e.swatch))]) expect(chromeTokens(c)).toEqual(c)
  })

  it('classic: null chrome is the classic chrome; unknown experiences are classic', () => {
    expect(appContext({ experience: 'classic', chrome: null, identity: null, reducedMotion: false, picker: false }).chrome).toEqual(CLASSIC_CHROME)
    const odd = appContext({ experience: 'Robots; drop', chrome: null, identity: null, reducedMotion: false, picker: false })
    expect(odd.experience).toBe('classic')
    expect(odd.grammar).toBe('classic')
    expect(appContext({ experience: 'future-ui', chrome: null, identity: null, reducedMotion: false, picker: false }).grammar).toBe('classic')
  })

  it('replaces anything that is not a plain token, and drops functions and extra keys', () => {
    const bad = {
      ...CLASSIC_CHROME,
      surface: 'url(https://evil.test/x.png)',
      ink: 'red; background: url(x)',
      font: 'x'.repeat(161),
      accent: (() => 'red') as unknown as string,
      material: 'video',
      scheme: 'sepia',
      extra: 'leak',
    } as unknown as ExperienceChrome
    const t = chromeTokens(bad)
    expect(t.surface).toBe(CLASSIC_CHROME.surface)
    expect(t.ink).toBe(CLASSIC_CHROME.ink)
    expect(t.font).toBe(CLASSIC_CHROME.font)
    expect(t.accent).toBe(CLASSIC_CHROME.accent)
    expect(t.material).toBe(CLASSIC_CHROME.material)
    expect(t.scheme).toBe(CLASSIC_CHROME.scheme)
    expect('extra' in t).toBe(false)
    for (const v of ['image-set(x 1x)', 'a\\62 c', '@import x', '<b>', '/* x */', 'data:text/html,x', '', 5]) expect(safeToken(v)).toBe(false)
    for (const v of ['#a493ff', 'rgb(11 11 33 / 0.96)', 'color-mix(in srgb, #fff 7%, #000)', "'Inter Variable', Inter, system-ui, sans-serif", '0 30px 80px -24px rgb(0 0 0 / 0.85)']) expect(safeToken(v)).toBe(true)
  })

  it('identity is all-valid data or null', () => {
    expect(identityTokens(identity)).toEqual(identity)
    expect(identityTokens({ ...identity, accent: 'red' })).toBeNull()
    expect(identityTokens({ ...identity, motif: 'video' })).toBeNull()
    expect(identityTokens(null)).toBeNull()
    expect(Object.keys(identity).sort()).toEqual(['accent', 'accent_2', 'ink', 'motif', 'surface', 'type'])
  })
})

describe('bridge messages from a frame', () => {
  it('accepts well-formed context? and pick', () => {
    expect(parseBridgeMessage({ type: 'context?', channel: ch })).toEqual({ ok: true, msg: { type: 'context?' } })
    expect(parseBridgeMessage({ type: 'pick', channel: ch, id: 'p1', accept: ['artifact', 'asset'] })).toEqual({ ok: true, msg: { type: 'pick', id: 'p1', accept: ['artifact', 'asset'], kinds: null } })
    expect(parseBridgeMessage({ type: 'pick', channel: ch, id: 'p2', accept: ['asset'], kinds: ['image/*', 'image/*', 'studio-source'] })).toEqual({ ok: true, msg: { type: 'pick', id: 'p2', accept: ['asset'], kinds: ['image/*', 'studio-source'] } })
  })

  it('ignores unknown and non-bridge types (null), so existing messages keep their own handling', () => {
    for (const m of [{ type: 'app-ready' }, { type: 'app-request', id: 'x', op: 'view' }, { type: 'pick-everything', id: 'x' }, { type: 'PICK', id: 'x' }, null, 'pick', [], 5]) expect(parseBridgeMessage(m)).toBeNull()
  })

  it('refuses bad shapes, naming the request when its id is usable', () => {
    const bad = [
      { type: 'pick', id: 'p', accept: [] },
      { type: 'pick', id: 'p', accept: ['artifact', 'artifact'] },
      { type: 'pick', id: 'p', accept: ['everything'] },
      { type: 'pick', id: 'p', accept: 'artifact' },
      { type: 'pick', id: 'p', accept: ['asset'], kinds: [] },
      { type: 'pick', id: 'p', accept: ['asset'], kinds: ['../etc'] },
      { type: 'pick', id: 'p', accept: ['asset'], kinds: Array.from({ length: 17 }, (_, i) => `k${i}`) },
      { type: 'pick', id: 'p', accept: ['asset'], swarm_id: 's_other' },
      { type: 'pick', id: 'p', accept: ['artifact'], artifact_id: 'a' },
    ]
    for (const m of bad) expect(parseBridgeMessage(m)).toEqual({ ok: false, id: 'p', reason: 'invalid' })
    expect(parseBridgeMessage({ type: 'pick', id: 'has space', accept: ['asset'] })).toEqual({ ok: false, id: null, reason: 'invalid' })
    expect(parseBridgeMessage({ type: 'pick', id: 7, accept: ['asset'] })).toEqual({ ok: false, id: null, reason: 'invalid' })
    expect(parseBridgeMessage({ type: 'context?', extra: 1 })).toEqual({ ok: false, id: null, reason: 'invalid' })
  })

  it('refuses oversize messages before reading them further', () => {
    const big = { type: 'pick', id: 'p', accept: ['asset'], kinds: ['a'], pad: 'x'.repeat(MAX_BRIDGE_MESSAGE) }
    expect(parseBridgeMessage(big)).toEqual({ ok: false, id: 'p', reason: 'too-large' })
    const cyclic: Record<string, unknown> = { type: 'pick', id: 'p', accept: ['asset'] }
    cyclic.self = cyclic
    expect(parseBridgeMessage(cyclic)).toEqual({ ok: false, id: 'p', reason: 'too-large' })
  })

  it('rate-limits per kind over a sliding window', () => {
    let t = 0
    const [max, win] = BRIDGE_LIMITS.pick
    const allow = rateLimit(max, win, () => t)
    for (let i = 0; i < max; i++) expect(allow('pick')).toBe(true)
    expect(allow('pick')).toBe(false)
    expect(allow('context?')).toBe(true)   // another key has its own budget
    t = win - 1
    expect(allow('pick')).toBe(false)
    t = win + 1
    expect(allow('pick')).toBe(true)
  })
})

describe('picker candidates and replies', () => {
  const arts = [
    { artifact_id: 'ar_1', kind: 'studio-source', title: 'Poster', revision: 3, digest: D('a'), created_at: 'c', revised_at: 'r' },
    { artifact_id: 'ar_2', kind: 'scene-deck', title: 'Deck', revision: 1, digest: D('b'), created_at: 'c', revised_at: 'r' },
    { artifact_id: 'ar_bad', kind: 'studio-source', title: 'Not exact', revision: 0, digest: D('c'), created_at: 'c', revised_at: 'r' },
    { artifact_id: 'ar_bad2', kind: 'studio-source', title: 'Bad digest', revision: 1, digest: 'sha1:x', created_at: 'c', revised_at: 'r' },
  ]
  const asset = (sha: string, owners: string[], mime = 'image/png') => ({ sha256: sha, mime, bytes: 10, name: 'logo.png', owner_swarm: owners[0] ?? null, owners, created_by: 'agent:x', created_at: 't', local_only: false, placements: ['local'], history: [] })

  it('lists only exact references, filtered by kind', () => {
    expect(artifactCandidates(arts, null).map((c) => c.key)).toEqual(['artifact:ar_1', 'artifact:ar_2'])
    expect(artifactCandidates(arts, ['scene-deck']).map((c) => c.key)).toEqual(['artifact:ar_2'])
  })

  it('lists only this swarm’s files, filtered by mime', () => {
    const rows = [asset(HEXSHA, ['s_mine']), asset('cd'.repeat(32), ['s_other']), asset('ef'.repeat(32), ['s_mine'], 'application/pdf'), asset('not-a-sha', ['s_mine'])]
    expect(assetCandidates(rows, 's_mine', null).map((c) => c.key)).toEqual([`asset:${HEXSHA}`, `asset:${'ef'.repeat(32)}`])
    expect(assetCandidates(rows, 's_mine', ['image/*']).map((c) => c.key)).toEqual([`asset:${HEXSHA}`])
    expect(kindMatches(['image/*'], 'imagex/png', true)).toBe(false)
    expect(kindMatches(['image/*'], 'image/png', false)).toBe(false)   // wildcards are for mime types only
  })

  it('replies with exactly one authorised reference, or a cancellation', () => {
    const [a] = artifactCandidates(arts, null)
    expect(pickedReply('p1', a)).toEqual({ type: 'picked', id: 'p1', source: { artifact_id: 'ar_1', revision: 3, digest: D('a') } })
    const [f] = assetCandidates([asset(HEXSHA, ['s_mine'])], 's_mine', null)
    expect(pickedReply('p2', f)).toEqual({ type: 'picked', id: 'p2', asset: { handle: HEXSHA, name: 'logo.png', mime: 'image/png', size: 10 } })
    expect(cancelledReply('p3')).toEqual({ type: 'picked', id: 'p3', cancelled: true })
    expect(cancelledReply('p4', 'busy')).toEqual({ type: 'picked', id: 'p4', cancelled: true, reason: 'busy' })
    // a tampered candidate is never forwarded
    expect(() => pickedReply('p5', { ...a, reference: { ...a.reference, revision: 0 } } as never)).toThrow()
    expect(() => pickedReply('p6', { ...f, reference: { ...f.reference, handle: '../x' } } as never)).toThrow()
    for (const r of [pickedReply('p1', a), pickedReply('p2', f), cancelledReply('p3')]) expect(plainData(r)).toBe(true)
  })
})

describe('sim fixture for the picker (?sim=1)', () => {
  it('lists invented artifacts and files for a swarm, and refuses an unknown one', async () => {
    const sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    const arts = await sim.swarmArtifacts('s_lyra')
    expect(arts.length).toBeGreaterThanOrEqual(3)
    expect(artifactCandidates(arts, null)).toHaveLength(arts.length)   // every row is an exact reference
    expect((await sim.swarmArtifacts('s_lyra', { kind: 'studio-source' })).every((a) => a.kind === 'studio-source')).toBe(true)
    const files = assetCandidates(await sim.listAssets('s_lyra'), 's_lyra', ['image/*'])
    expect(files.length).toBeGreaterThanOrEqual(2)
    await expect(sim.swarmArtifacts('nope')).rejects.toMatchObject({ status: 404 })
  })
})
