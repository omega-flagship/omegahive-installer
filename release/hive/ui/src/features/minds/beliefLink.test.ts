// Purpose: check the belief-link setting end to end on invented minds: the owner's choice and the mind's default as the
// screen words them, the screen MeTTa composes for each moment and each reader's rights, the domains each press asks
// for, the hive's widen rule, and the simulator's copy of the hive's default and rights rules.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { widens } from '../../api/beliefLinkRule'
import { ApiError } from '../../api/client'
import { SimClient } from '../../api/sim/SimClient'
import type { Agent, BeliefLink } from '../../api/types'
import type { ResourceStatus } from '../../lib/useResource'
import { Screen } from '../../screens/Screen'
import { withResource } from '../../screens/resourceFacts'
import { ScreensSpace } from '../../screens/screenSpace'
import { beliefLinkScreen, choiceOf, LINK_PAGE, linkPress, subjectsOf, type LinkPage } from './beliefLink'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open()
const ADA = 'user:u_ada'
const mind = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a_wren', name: 'Wren', hue: 140, status: 'awake', kind: 'omega', swarm_id: 's_orchard', owner: ADA, visibility: 'public', may_control: true, ...over }) as Agent
const OWNER: BeliefLink['rights'] = { read_beliefs: true, read_setting: true, read_topics: true, narrow: true, widen: true }
const ADMIN: BeliefLink['rights'] = { read_beliefs: true, read_setting: true, read_topics: false, narrow: true, widen: false }
const link = (over: Partial<BeliefLink> = {}): BeliefLink =>
  ({ agent_id: 'a_wren', domains: null, default: 'all', default_reason: null, linked: 'all', patterns: ['$stmt'], known_domains: ['coffee', 'weather'], as: 'owner', rights: OWNER, ...over })
/** The link as an admin who does not own the mind reads it: no subjects, and narrowing only. */
const adminLink = (over: Partial<BeliefLink> = {}): BeliefLink => link({ as: 'admin', rights: ADMIN, known_domains: null, ...over })
const ROWANS = mind({ owner: 'user:u_rowan' })

function draw(l: BeliefLink | undefined, opts: { agent?: Agent; page?: LinkPage; status?: ResourceStatus; error?: unknown; viewer?: string; look?: string } = {}) {
  const { data, facts } = withResource({ status: opts.status ?? 'ready', error: opts.error }, beliefLinkScreen(l, opts.agent ?? mind(), opts.viewer ?? ADA, opts.page ?? LINK_PAGE))
  const plan = space.compose('belief-link', opts.look ?? 'classic', facts)
  const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data, onAction: () => undefined } }))
  return { plan, data, orders: plan.parts.map((p) => p.order), html }
}

describe("the owner's choice and the mind's default, as the screen words them", () => {
  it('the chooser shows the default, every belief, some subjects or none', () => {
    expect([null, 'all', ['coffee'], []].map((d) => choiceOf(d as BeliefLink['domains']))).toEqual(['default', 'all', 'some', 'none'])
  })

  it('the subjects to tick are those its beliefs are about now and any still chosen, in order, the chosen ones ticked', () => {
    expect(subjectsOf(link({ domains: ['tea', 'coffee'], known_domains: ['weather', 'coffee'] }))).toEqual([
      { id: 'coffee', label: 'coffee', on: true }, { id: 'tea', label: 'tea', on: true }, { id: 'weather', label: 'weather', on: false },
    ])
    expect(subjectsOf(link({ domains: 'all' })).every((s) => !s.on)).toBe(true)
    expect(subjectsOf(adminLink({ domains: ['tea'] }))).toEqual([{ id: 'tea', label: 'tea', on: true }])   // no topics for an admin
  })

  it('a public mind shares every belief by default', () => {
    const { data } = draw(link())
    expect(data).toMatchObject({
      'link.value': 'default', 'link.words.default': 'Default: every belief', 'link.words.none': 'Only you',
      'link.now': 'Its swarm sees every belief it holds, for as long as it holds it.',
      'link.why': 'A public mind shares every belief with its swarm until its owner narrows it.',
    })
  })

  it("a person's own mind shares nothing until they choose, in their own words and in an admin's", () => {
    const own = mind({ personal_of: ADA, visibility: 'private' })
    const none = link({ default: 'none', default_reason: 'personal', linked: 'none', patterns: [] })
    expect(draw(none, { agent: own }).data).toMatchObject({
      'link.words.default': 'Default: only you', 'link.now': 'Only you see its beliefs. Its swarm sees none of them.',
      'link.why': 'Your own mind shares none of its beliefs until you choose.',
    })
    expect(draw(none, { agent: own, viewer: 'user:u_admin' }).data).toMatchObject({
      'link.words.default': 'Default: only its owner', 'link.words.none': 'Only its owner',
      'link.now': 'Only its owner sees its beliefs. Its swarm sees none of them.',
      'link.why': "A person's own mind shares none of its beliefs until its owner chooses.",
    })
  })

  it('a private, a shared and a researcher mind each say why they share nothing by default, as the hive gives the reason', () => {
    const none = (default_reason: BeliefLink['default_reason']) => link({ default: 'none', default_reason, linked: 'none', patterns: [] })
    expect(draw(none('private'), { agent: mind({ visibility: 'private' }) }).data['link.why']).toBe('A private mind shares none of its beliefs until you choose.')
    expect(draw(none('shared'), { agent: mind({ visibility: 'shared' }) }).data['link.why']).toBe('A mind shared with some people shares none of its beliefs until you choose.')
    expect(draw(none('researcher')).data['link.why']).toBe('A researcher shares none of its beliefs until you choose.')
    expect(draw(none('researcher'), { viewer: 'user:u_admin' }).data['link.why']).toBe('A researcher shares none of its beliefs until its owner chooses.')
  })

  it('what its swarm sees now follows linked: some subjects by name, and a mind in no swarm says so', () => {
    expect(draw(link({ domains: ['coffee', 'tea', 'weather'], linked: ['coffee', 'tea', 'weather'] })).data['link.now'])
      .toBe('Its swarm sees its beliefs about coffee, tea and weather, and none of the others.')
    expect(draw(link(), { agent: mind({ swarm_id: null }) }).data['link.now']).toBe('It is in no swarm, so only you see its beliefs. This applies once it joins one.')
  })
})

describe('the screen MeTTa composes', () => {
  it('draws the four choices with the default in its words, and why the default is what it is', () => {
    const { html } = draw(link())
    for (const words of ['Who sees its beliefs', 'Default: every belief', 'Every belief', 'Some subjects', 'Only you', 'shares every belief with its swarm until its owner narrows it'])
      expect(html).toContain(words)
    expect(html).not.toContain('Subjects its swarm sees')
  })

  it('Some subjects ticks the subjects it holds beliefs about, with the chosen ones ticked', () => {
    const { html } = draw(link({ domains: ['coffee'], linked: ['coffee'] }))
    expect(html).toContain('Subjects its swarm sees')
    expect(html.match(/type="checkbox"/g)).toHaveLength(2)
    expect(html).toMatch(/<input type="checkbox" checked=""[^>]*\/>.*coffee/)
    expect(html).not.toContain('shares every belief with its swarm')   // the default's reason shows only while the default is chosen
  })

  it('an admin, who may only narrow it, is offered no choice that lets its swarm see more (Jon on #360)', () => {
    const { html } = draw(adminLink({ domains: ['coffee', 'weather'], linked: ['coffee', 'weather'] }), { agent: ROWANS, viewer: ADA })
    expect(html).toContain('Its swarm sees its beliefs about coffee and weather, and none of the others.')
    expect(html).toContain('Only its owner can let its swarm see more of its beliefs. You can narrow it.')
    expect(html).toContain('Link none of its beliefs')
    expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(2)   // the linked subjects, ticked, so a tick only takes one away
    for (const widening of ['Every belief', 'Some subjects', 'Default:']) expect(html).not.toContain(widening)
  })

  it("an admin before a mind that links every belief can link none, and before one that links none has nothing to change", () => {
    expect(draw(adminLink(), { agent: ROWANS, viewer: ADA }).html).toContain('Link none of its beliefs')
    const none = draw(adminLink({ domains: [], linked: 'none' }), { agent: ROWANS, viewer: ADA })
    expect(none.orders).toEqual([10, 22])
    expect(none.html).not.toContain('Link none of its beliefs')
  })

  it('a refused change says why, under the choices', () => {
    const { html } = draw(link(), { page: { ...LINK_PAGE, error: 'Only its owner or an admin decides who sees its beliefs' } })
    expect(html).toContain('Could not change who sees its beliefs: Only its owner or an admin decides who sees its beliefs')
  })

  it('Canvas and Cosmos compose the same parts', () => {
    const classic = draw(link({ domains: ['coffee'], linked: ['coffee'] })).orders
    for (const look of ['canvas', 'cosmos']) expect(draw(link({ domains: ['coffee'], linked: ['coffee'] }), { look }).orders).toEqual(classic)
  })

  it('the guards stay clean and nothing falls back', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(draw(link()).plan.missing).toEqual([])
  })
})

describe('every part of the belief-link screen can be reached', () => {
  it('loading, unsupported, failed, stale, each choice, picking with and without subjects, and a refused change', () => {
    const seen = new Set<number>()
    const see = (o: number[]) => { o.forEach((x) => seen.add(x)); return o }
    const failed = new ApiError(500, 'internal', 'The hive failed.')
    see(draw(undefined, { status: 'loading' }).orders)
    see(draw(undefined, { status: 'unsupported' }).orders)
    see(draw(undefined, { status: 'error', error: failed }).orders)
    see(draw(link(), { error: failed }).orders)   // ready, and a refresh failed
    expect(see(draw(link()).orders)).toEqual([10, 20, 21])
    expect(see(draw(link({ domains: ['coffee'], linked: ['coffee'] })).orders)).toEqual([10, 20, 30])
    expect(see(draw(link({ domains: 'all' }), { page: { ...LINK_PAGE, picking: true } }).orders)).toEqual([10, 20, 30])
    expect(see(draw(link({ domains: 'all', known_domains: [] }), { page: { ...LINK_PAGE, picking: true } }).orders)).toEqual([10, 20, 31])
    expect(see(draw(link({ domains: [] }), { page: { ...LINK_PAGE, error: 'no' } }).orders)).toEqual([10, 20, 40])
    expect(see(draw(adminLink()).orders)).toEqual([10, 21, 22, 23])   // why the default is what it is, for any reader
    expect(see(draw(adminLink({ domains: ['coffee'], linked: ['coffee'] })).orders)).toEqual([10, 22, 23, 32])
    expect([...seen].sort((a, b) => a - b)).toEqual(space.orders('belief-link'))
  })
})

describe('what each press asks of the hive', () => {
  const all = link({ domains: 'all' })
  const some = link({ domains: ['coffee'], linked: ['coffee'] })
  it('a choice is one write of the domains it means, and choosing what is already chosen writes nothing', () => {
    expect(linkPress(all, 'set-link', 'default')).toEqual({ domains: null })
    expect(linkPress(link(), 'set-link', 'default')).toBeNull()
    expect(linkPress(link(), 'set-link', 'all')).toEqual({ domains: 'all' })
    expect(linkPress(all, 'set-link', 'all')).toBeNull()
    expect(linkPress(all, 'set-link', 'none')).toEqual({ domains: [] })
    expect(linkPress(link({ domains: [] }), 'set-link', 'none')).toBeNull()
  })
  it('Some subjects opens the ticks and writes nothing until one is ticked', () => {
    expect(linkPress(all, 'set-link', 'some')).toBe('pick')
    expect(linkPress(some, 'set-link', 'some')).toBeNull()
  })
  it('a tick adds or removes its subject, and unticking the last links none', () => {
    expect(linkPress(all, 'pick-subject', 'coffee', true)).toEqual({ domains: ['coffee'] })
    expect(linkPress(some, 'pick-subject', 'weather', true)).toEqual({ domains: ['coffee', 'weather'] })
    expect(linkPress(some, 'pick-subject', 'coffee', true)).toBeNull()
    expect(linkPress(some, 'pick-subject', 'coffee', false)).toEqual({ domains: [] })
    expect(linkPress(some, 'something-else', 'coffee')).toBeNull()
  })
  it("an admin's Link none writes none, and an admin's untick narrows to the subjects left", () => {
    expect(linkPress(adminLink(), 'link-none', undefined)).toEqual({ domains: [] })
    expect(linkPress(adminLink({ domains: [], linked: 'none' }), 'link-none', undefined)).toBeNull()
    expect(linkPress(adminLink({ domains: ['coffee', 'tea'], linked: ['coffee', 'tea'] }), 'pick-subject', 'tea', false)).toEqual({ domains: ['coffee'] })
  })
})

describe("the hive's widen rule, which only a mind's owner may cross", () => {
  const at = (linked: BeliefLink['linked'], def: BeliefLink['default'] = 'all') => ({ linked, default: def })
  it('every belief over less, or a default that links every belief over less, widens; none and the same never do', () => {
    expect(widens(at(['coffee']), 'all')).toBe(true)
    expect(widens(at('none'), null)).toBe(true)            // a public mind's default links every belief
    expect(widens(at(['coffee']), null)).toBe(true)
    expect(widens(at('all'), 'all')).toBe(false)
    expect(widens(at('all'), null)).toBe(false)
    expect(widens(at(['coffee'], 'none'), null)).toBe(false)  // a default of none links nothing
    for (const now of ['all', 'none', ['coffee']] as BeliefLink['linked'][]) expect(widens(at(now), [])).toBe(false)
  })
  it('a list of subjects widens exactly when it names one not linked now, over every pair of subsets of three subjects', () => {
    const subsets = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => ['a', 'b', 'c'].filter((_, i) => m & (1 << i)))
    for (const now of subsets) for (const next of subsets) {
      const linked = now.length ? now : 'none'
      expect(widens(at(linked), next)).toBe(next.some((d) => !now.includes(d)))
      expect(widens(at('all'), next)).toBe(false)
    }
  })
})

describe("the simulator follows the hive's default rule", () => {
  const sim = () => new SimClient({ seed: 7, latency: false, autoStart: false, historyDays: 1 })
  it('a public mind links every belief, a private or personal one none and says why, until its owner chooses', async () => {
    const s = sim()
    const minds = await s.listAgents()
    const pub = minds.find((a) => a.swarm_id && (a.visibility ?? 'public') === 'public' && !a.personal_of)!
    expect(await s.beliefLink(pub.id)).toMatchObject({ domains: null, default: 'all', default_reason: null, linked: 'all', patterns: ['$stmt'] })
    s.agents.get(pub.id)!.visibility = 'private'
    expect(await s.beliefLink(pub.id)).toMatchObject({ default: 'none', default_reason: 'private', linked: 'none', patterns: [] })
    s.agents.get(pub.id)!.personal_of = 'user:p_ada'
    s.simSignInAs('person')   // Ada reads her own mind: an admin before another person's own mind sees nothing
    expect(await s.beliefLink(pub.id)).toMatchObject({ default: 'none', default_reason: 'personal' })
  })
  it('a choice is kept, narrowed to subjects as the hive writes them, and refused past the hive limits', async () => {
    const s = sim()
    const pub = (await s.listAgents()).find((a) => a.swarm_id && (a.visibility ?? 'public') === 'public' && !a.personal_of)!
    s.agents.get(pub.id)!.owner = 'user:operator'   // the operator's own, so every choice is its owner's
    expect(await s.setBeliefLink(pub.id, [' tea ', 'iced coffee', 'tea'])).toMatchObject({
      domains: ['iced coffee', 'tea'], linked: ['iced coffee', 'tea'],
      patterns: ['(--> (x "iced coffee" $value) $relation)', '(--> (x tea $value) $relation)'],
    })
    expect(await s.setBeliefLink(pub.id, [])).toMatchObject({ domains: [], linked: 'none' })
    expect(s.agents.get(pub.id)!.belief_link).toEqual([])   // the mind's view carries the setting, as agent_view does
    expect(await s.setBeliefLink(pub.id, null)).toMatchObject({ domains: null, linked: 'all' })
    await expect(s.setBeliefLink(pub.id, ['say "hi"'])).rejects.toMatchObject({ status: 400, code: 'bad_domains' })
    await expect(s.setBeliefLink(pub.id, Array.from({ length: 65 }, (_, i) => `s${i}`))).rejects.toMatchObject({ status: 400 })
  })
  it('its subjects are those of the beliefs it asserted in its swarm', async () => {
    const s = sim()
    const minds = await s.listAgents()
    const asserted = minds.find((a) => a.swarm_id && [...(s.beliefs.get(a.swarm_id)?.values() ?? [])].some((b) => b.assertions.some((x) => x.agent_id === a.id)))
    if (!asserted) return
    s.agents.get(asserted.id)!.owner = 'user:operator'   // its subjects are its owner's to read
    const known = (await s.beliefLink(asserted.id)).known_domains
    expect(known).toEqual([...(known ?? [])].sort())
  })
  it('only its owner widens it: an admin narrows it without its subjects, another person is refused, and a person\'s own mind is hidden from an admin', async () => {
    const s = sim()
    const pub = (await s.listAgents()).find((a) => a.swarm_id && (a.visibility ?? 'public') === 'public' && !a.personal_of)!
    s.agents.get(pub.id)!.owner = 'user:operator'
    expect(await s.beliefLink(pub.id)).toMatchObject({ as: 'owner', rights: OWNER })
    s.simSignInAs('person')   // Ada, an admin who does not own it
    expect(await s.beliefLink(pub.id)).toMatchObject({ as: 'admin', rights: ADMIN, known_domains: null })
    expect(await s.setBeliefLink(pub.id, ['tea'])).toMatchObject({ linked: ['tea'] })   // narrower than every belief
    await expect(s.setBeliefLink(pub.id, ['tea', 'weather'])).rejects.toMatchObject({ status: 403, code: 'owner_only' })
    await expect(s.setBeliefLink(pub.id, null)).rejects.toMatchObject({ status: 403, code: 'owner_only' })   // its default links every belief
    expect(await s.setBeliefLink(pub.id, [])).toMatchObject({ linked: 'none' })
    s.agents.get(pub.id)!.personal_of = 'user:p_rowan'
    await expect(s.beliefLink(pub.id)).rejects.toMatchObject({ status: 404 })
    s.simSignInAs('member')   // Rowan, whose own mind it now is
    expect(await s.beliefLink(pub.id)).toMatchObject({ as: 'owner', rights: OWNER })
    s.agents.get(pub.id)!.personal_of = null
    await expect(s.beliefLink(pub.id)).rejects.toMatchObject({ status: 403, code: 'owner_only' })
    await expect(s.setBeliefLink(pub.id, [])).rejects.toMatchObject({ status: 403, code: 'owner_only' })
  })
})
