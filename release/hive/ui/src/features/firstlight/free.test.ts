// Purpose: First Light's free inference way to think (free.metta, plans.freeRoute/freeWay/freeLapse, SingleScreen,
// store.thinkWith): what MeTTa composes in every look, when the way is offered, what the card says when a mind set to it
// can't use it now, that anyone signed in may choose it while a hive key stays the owner's to choose, and that the card
// says who pays only while the route serves the mind.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderStatus } from '../../api/types'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { BLANK_PROGRESS, liveHost, type FlClient } from './host'
import { payerLine } from './honest'
import { FREE_PROVIDER, freeLapse, freeRoute, freeWay, onFreeWay } from './plans'
import { SingleScreen, connectionState } from './SingleScreen'
import { setFlScreen, useFirstLight, whoOf, type FlScreen, type Run } from './store'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const MODEL = 'minimax/minimax-m3.1-flash'
const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const space = ScreensSpace.open()
const draw = (offered: boolean, chosen: boolean, lapse = 'none', look = 'classic') => {
  const plan = space.compose('first-light-free', look, { flags: { 'free.offered': offered, 'free.chosen': chosen }, values: { 'free.lapse': lapse } })
  const pressed: string[] = []
  const host = { data: { 'free.daily_calls': 200, 'free.model': MODEL, 'free.host': 'inference.asicloud.cudos.org', 'mind.name': 'Wren' },
    onAction: (a: string) => void pressed.push(a) }
  return { plan, orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host })) }
}

describe('free inference in First Light, composed by MeTTa', () => {
  it.each(LOOKS)('%s: offered, chosen and lapsed, each in its plain words', (look) => {
    const offered = draw(true, false, 'none', look)
    expect(offered.orders).toEqual([10, 20])
    expect(offered.html).toContain('>Use free inference<')
    expect(offered.html).toContain('aria-label="Use this hive&#x27;s free inference for Wren"')
    expect(offered.html).toContain(`This hive&#x27;s deploy provides ${MODEL} for free: up to 200 model calls a day for you, with no key of your own, counting your mind&#x27;s replies in rooms and its goals too.`)
    expect(offered.html).toContain('What you write goes to inference.asicloud.cudos.org to be answered.')
    const chosen = draw(false, true, 'none', look)   // chosen holds even while the route hasn't answered lately
    expect(chosen.orders).toEqual([30])
    expect(chosen.html).toContain(`Thinking with ${MODEL}, which this hive&#x27;s deploy provides: up to 200 model calls a day, its replies in rooms and its goals included.`)
    expect(chosen.html).not.toContain('Use free inference')
    const off = draw(false, false, 'off', look)
    expect(off.orders).toEqual([4])
    expect(off.html).toContain('Wren can&#x27;t think with free inference now: this hive doesn&#x27;t offer it to you. Choose another way for it to think.')
    const dropped = draw(true, false, 'model', look)   // the reason first, then the press that moves it to the default
    expect(dropped.orders).toEqual([6, 10, 20])
    expect(dropped.html).toContain(`Wren was set to a model this hive&#x27;s free inference no longer offers. Use free inference to move it to ${MODEL}, or choose another way.`)
    expect(offered.plan.missing).toEqual([])
  })
  it('not offered and not set to it, nothing shows', () => {
    expect(draw(false, false).orders).toEqual([])
  })
  it('the guards stay clean', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
})

const provider = (name: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  name, label: name, local: false, needs_key: false, connected: true, configured: true, readiness: 'unverified', answer_ready: false,
  source: null, keys: 0, key_hint: '', key_env: '', base_url: 'https://inference.asicloud.cudos.org/v1', models: [MODEL], ...over,
} as ProviderStatus)
const free = provider(FREE_PROVIDER, { label: 'Free inference', daily_calls: 200 })
const route = { model: `free/${MODEL}`, models: [`free/${MODEL}`], dailyCalls: 200, host: 'inference.asicloud.cudos.org' }

describe('the free route, as the host states it to this person', () => {
  it('names its models, calls a day and endpoint, and is offered unless it has not answered lately', () => {
    expect(freeRoute([provider('openrouter', { needs_key: true }), free])).toEqual(route)
    expect(freeWay([free])).toEqual(route)
    expect(freeRoute([{ ...free, models: [' ', 'asi1-mini', MODEL] }])).toEqual({ ...route, model: 'free/asi1-mini', models: ['free/asi1-mini', `free/${MODEL}`] })
    expect(freeRoute([{ ...free, base_url: 'https://compute.example.org/v1' }])?.host).toBe('compute.example.org')
    expect(freeRoute([{ ...free, readiness: 'not_answering' }])).toEqual(route)
    expect(freeWay([{ ...free, readiness: 'not_answering' }])).toBeNull()
    for (const off of [null, [], [provider('openrouter')], [{ ...free, configured: false, connected: false }],
      [{ ...free, test_only: true }], [{ ...free, models: [] }], [{ ...free, daily_calls: 0 }]]) {
      expect(freeRoute(off)).toBeNull()
      expect(freeWay(off)).toBeNull()
    }
    expect(onFreeWay(`free/${MODEL}`)).toBe(true)
    expect(onFreeWay('openrouter/free/x')).toBe(false)
    expect(onFreeWay(null)).toBe(false)
  })
  it('says why a mind set to it can’t use it now, and only then', () => {
    expect(freeLapse(`free/${MODEL}`, [free])).toBeNull()
    expect(freeLapse(`free/${MODEL}`, [{ ...free, readiness: 'not_answering' }])).toBeNull()   // connectionState's case
    expect(freeLapse(`free/${MODEL}`, [])).toBe('off')                                           // the deploy took the key away
    expect(freeLapse(`free/${MODEL}`, [{ ...free, daily_calls: 0 }])).toBe('off')
    expect(freeLapse(`free/${MODEL}`, [{ ...free, configured: false, connected: false }])).toBe('off')   // not open to them
    expect(freeLapse('free/invented/dropped', [free])).toBe('model')
    expect(freeLapse('openrouter/x', [])).toBeNull()
    expect(freeLapse(`free/${MODEL}`, null)).toBeNull()   // not read yet: connectionState says unknown
    expect(connectionState(`free/${MODEL}`, [])).toBe('unavailable')
    expect(connectionState('free/invented/dropped', [free])).toBe('unavailable')
  })
})

const run = (over: Partial<Run> = {}): Run => ({
  id: 1, mode: 'live', path: 'member', status: 'playing', loadError: null,
  facts: { name: 'Ann', host: 'Rowan', mind: { id: 'a_personal', name: 'Wren', status: 'asleep' }, askHow: '', ownKeys: 0, limit: null },
  hello: { hello: null, postedAt: null },
  u1: { context: 'known', model: 'mock/echo', busy: false, phase: 'editing', error: null, profileSaved: false },
  ...over,
} as unknown as Run)
const on = (model: string) => run({ u1: { context: 'known', model, busy: false, phase: 'editing', error: null, profileSaved: false } } as Partial<Run>)
const render = (r: Run, providers: ProviderStatus[]) => renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers }))
const FREE_PAYS = 'This hive’s deploy pays for your mind’s free inference: nothing to you, and you need no key of your own.'

describe('the single screen with free inference', () => {
  it('a member with no key is offered it among the ways to think, and the key field does not open by itself', () => {
    const html = render(run(), [free])
    expect(html).toContain('>Use free inference<')
    expect(html).toContain(`This hive&#x27;s deploy provides ${MODEL} for free: up to 200 model calls a day for you`)
    expect(html).not.toContain('type="password"')   // the key field is one way among others now
    expect(html.indexOf('Use free inference')).toBeLessThan(html.indexOf('Paste an OpenRouter key'))
  })
  it('once the mind thinks with it, the card says so and who pays', () => {
    const html = render(on(`free/${MODEL}`), [free])
    expect(html).toContain(`Thinking with ${MODEL}, which this hive&#x27;s deploy provides`)
    expect(html).toContain(FREE_PAYS)
    expect(html).toContain('Free inference spends no money of yours: up to 200 model calls a day.')
    expect(html).not.toContain('No monthly limit is set yet.')
    expect(html).not.toContain('>Use free inference<')
  })
  it('set to it after the deploy stopped offering it: the reason, the choices open, and nobody said to pay', () => {
    const html = render(on(`free/${MODEL}`), [provider('openrouter', { needs_key: true, configured: false, connected: false })])
    expect(html).toContain('Wren can&#x27;t think with free inference now: this hive doesn&#x27;t offer it to you.')
    expect(html).toContain('<details open="" data-u1-choices="">')   // the ways to think stay open while it can't think
    expect(html).toContain('Wren can&#x27;t think yet.')
    expect(html).not.toContain(FREE_PAYS)
    expect(html).not.toContain('Free inference spends no money of yours')
    expect(html).not.toContain('>Use free inference<')
  })
  it('set to a model the deploy dropped: the reason, and the press that moves it to the one offered now', () => {
    const html = render(on('free/invented/dropped'), [free])
    expect(html).toContain(`Wren was set to a model this hive&#x27;s free inference no longer offers. Use free inference to move it to ${MODEL}`)
    expect(html).toContain('>Use free inference<')
    expect(html).toContain('<details open="" data-u1-choices="">')
    expect(html).not.toContain(FREE_PAYS)
  })
  it('a hive without it shows none of it', () => {
    expect(render(run(), [provider('openrouter', { needs_key: true, configured: false, connected: false })])).not.toContain('free inference')
  })
})

describe('who pays, in First Light’s words', () => {
  it('free inference pays whatever the path, while it serves the mind; otherwise the words are as they were', () => {
    for (const path of ['owner', 'guest', 'member'] as const)
      expect(payerLine({ path, host: 'Rowan', ownKeys: 0, free: true })).toBe(FREE_PAYS)
    expect(payerLine({ path: 'member', host: 'Rowan', ownKeys: 0 })).toBe('Rowan’s keys pay for your minds here.')
    expect(whoOf(on(`free/${MODEL}`), [free]).free).toBe(true)
    expect(whoOf(on(`free/${MODEL}`), []).free).toBe(false)              // lapsed: never said to pay
    expect(whoOf(on('free/invented/dropped'), [free]).free).toBe(false)
    expect(whoOf(run(), [free]).free).toBe(false)
  })
})

// ---- the press, on the real store over a live host --------------------------------------------------------------

const screen: FlScreen = { act: () => undefined, gallery: () => undefined, galleryOpen: () => false, savedLook: () => 'classic||', savedLookName: () => 'Classic', deviceOnly: () => false }
const g = () => useFirstLight.getState()
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) }

function memberClient(patched: string[]): FlClient {
  return {
    retainedMutationScope: () => ({ host: 'https://free-first-light.invalid', principal: 'user:u_ann' }),
    onboarding: async () => ({ ...BLANK_PROGRESS }),
    mySetup: async () => ({ items: [{ id: 'provider_key', done: false, detail: { own_keys: 0, guest: false } }], complete: false }),
    hiveOwn: async () => ({ owner_name: 'Rowan', you_are_owner: false, your_access: 'legacy', visibility: 'private', pays: 'own-key' }),
    me: async () => ({ person: { name: 'Ann' } }),
    myMind: async () => ({ mind: { id: 'a_ann', name: 'Wren', status: 'asleep' } }),
    getAgent: async (id: string) => ({ id, name: 'Wren', persona: '', model: 'mock/echo' }),
    programs: async () => [],
    patchAgent: async (id: string, body: { model: string }) => { patched.push(`${id}:${body.model}`); return { id, name: 'Wren', model: body.model } },
  } as unknown as FlClient
}

describe('choosing it', () => {
  beforeEach(() => setFlScreen(screen))
  afterEach(() => { g().stop(); setFlScreen(null) })

  it('a member moves their own mind onto free inference; a key the hive pays with stays the owner’s to choose', async () => {
    const patched: string[] = []
    await g().start({ mode: 'live', host: liveHost(memberClient(patched), () => 0), singleScreen: true })
    await flush()
    expect(g().run?.path).toBe('member')
    await g().thinkWith('openrouter/anthropic/claude-sonnet-5.5')
    expect(patched).toEqual([])
    await g().thinkWith(`free/${MODEL}`)
    await flush()
    expect(patched).toEqual([`a_ann:free/${MODEL}`])
    expect(g().run?.u1?.model).toBe(`free/${MODEL}`)
  })
})
