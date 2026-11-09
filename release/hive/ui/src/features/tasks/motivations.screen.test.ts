import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Me, Person } from '../../api/client'
import type { Agent, Goal, Motivation, MotivationRef, Swarm } from '../../api/types'
import { PARTIAL_WORDS, STATUS_ORDER, STATUS_WORDS } from '../../lib/motivations'
import motivationsPage from './MotivationsPage.tsx?raw'
import { DRAWN_BLOCKS, Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace, type Compose, type ScreenFacts } from '../../screens/screenSpace'
import motivationsSource from './motivations.metta?raw'
import {
  chooserPress,
  createChoice,
  evolveScreen,
  fileCandidates,
  motivationScreen,
  motivationsScreen,
  NEW_DRAFT,
  NEW_FILE,
  peopleChoices,
  progressWords,
  type DetailInput,
  type ListInput,
} from './motivationsData'

vi.setConfig({ testTimeout: 20_000 })

/** The Motivations page end to end: an invented hive → facts → MeTTa composes each screen → drawn. INVENTED DATA only. */
const space = ScreensSpace.open()
const SCREENS = ['motivations', 'motivation-card', 'motivation-new', 'motivation', 'motivation-about', 'motivation-sharing', 'motivation-file', 'evolve-objective']
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen: string, facts: ScreenFacts) => {
  const plan = space.compose(screen, 'classic', facts)
  const got = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) got.add(p.order)
  seen.set(screen, got)
  return plan
}
const at = '2026-03-01T09:00:00Z'
const NOW = Date.parse('2026-03-02T09:00:00Z')

const swarm = (id: string, name: string, over: Partial<Swarm> = {}): Swarm => ({ id, name, description: '', hue: 140, member_ids: [], created_at: at, ...over })
const goal = (id: string, swarm_id: string, over: Partial<Goal> = {}): Goal => ({
  id, swarm_id, parent_id: null, title: `Task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:p_ada', claimed_by: null, result: null, created_at: at, updated_at: at, ...over,
})
const motive = (id: string, title: string, over: Partial<Motivation> = {}): Motivation => ({
  id, title, why: '', owner: 'user:p_ada', swarm_id: null, status: 'active', visibility: 'private', rev: 1, parent_id: null, created_by: 'user:p_ada', created_at: at, updated_at: at, status_changed_at: null, editable: true, ...over,
})
const ref = (m: Motivation): MotivationRef => ({ id: m.id, title: m.title, status: m.status })
const person = (id: string, name: string): Person => ({ id, email: `${id}@example.test`, name, role: 'member', invited_by: null, created_at: at, last_seen_at: null, disabled: false })

const ADA: Me = { principal: 'user:p_ada', kind: 'sso', role: 'member', expires_at: null, person: { id: 'p_ada', email: null, name: 'Ada' } }
const OPERATOR: Me = { principal: 'user:operator', kind: 'password', role: 'admin', expires_at: null, person: null }

const ORCHARD = motive('mo_orchard', 'Grow a small orchard', { why: 'Fruit for the street by next summer.' })
const BEES = motive('mo_bees', 'Keep bees calm', { owner: 'swarm:s_g', swarm_id: 's_g', status: 'paused', visibility: 'public' })
const SOIL = motive('mo_soil', 'Know the soil', { owner: 'agent:a_fern', created_by: 'agent:a_fern', swarm_id: 's_g', editable: false })
const PATH = motive('mo_path', 'Clear the old path', { owner: 'user:p_bo', created_by: 'user:p_bo', visibility: 'shared', shared_with: ['user:p_ada'], editable: false, status: 'achieved' })
const SWARMS = { s_g: swarm('s_g', 'Gardeners', { owner: 'user:p_ada' }), s_old: swarm('s_old', 'Old shed', { archived_at: at }) }
const AGENTS = { a_fern: { id: 'a_fern', name: 'Fern' } as Agent }
const GOALS = {
  g1: goal('g1', 's_g', { title: 'Plant the apple trees', status: 'done' }),
  g2: goal('g2', 's_g', { title: 'Water the saplings', status: 'failed' }),
  g3: goal('g3', 's_g', { title: 'Build a hive box', status: 'submitted', updated_at: '2026-03-01T10:00:00Z' }),
  g4: goal('g4', 's_g', { title: 'Sweep the yard', updated_at: '2026-03-01T11:00:00Z' }),
  g5: goal('g5', 's_g', { title: 'Fetch the ladder', parent_id: 'g4' }),
  g6: goal('g6', 's_old', { title: 'Tidy the old shed' }),
}
const LINKS: Record<string, MotivationRef[]> = { g1: [ref(ORCHARD)], g2: [ref(ORCHARD), ref(ORCHARD)], g3: [ref(BEES)], g4: [], g6: [] }
const LIST: ListInput = {
  motivations: { [ORCHARD.id]: ORCHARD, [BEES.id]: BEES, [SOIL.id]: SOIL, [PATH.id]: PATH },
  links: LINKS, goals: GOALS, me: ADA, agents: AGENTS, swarms: SWARMS,
  supported: true, loaded: true, partial: false, making: false, draft: NEW_DRAFT, people: { read: [], canList: true }, evolveShown: false, now: NOW,
}

function draw(plan: ReturnType<Compose>, data: Record<string, unknown>, host: Partial<ScreenHost> = {}) {
  return renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onInput: () => {}, onOpen: () => {}, onAction: () => {}, ...host } }))
}
const ISLANDS = {
  'create-words': createElement('p', null, 'CREATE-WORDS'), 'evolve-objective': createElement('p', null, 'EVOLVE'), 'edit-words': createElement('p', null, 'EDIT-WORDS'),
  'motivation-tasks': createElement('p', null, 'BOARD'),
}
function list(over: Partial<ListInput> = {}) {
  const s = motivationsScreen({ ...LIST, ...over }, compose)
  const plan = compose('motivations', s.facts)
  return { ...s, plan, orders: plan.parts.map((p) => p.order), html: draw(plan, s.data, { islands: ISLANDS }) }
}
const DETAIL: DetailInput = {
  m: ORCHARD, supported: true, gone: false, links: LINKS, goals: GOALS, names: { me: ADA, agents: AGENTS, swarms: SWARMS }, partial: false, now: NOW,
  words: null, wordsChanged: false, controls: { busy: false, error: null }, sharing: null, people: { read: [], canList: true }, file: NEW_FILE,
}
function detail(over: Partial<DetailInput> = {}) {
  const s = motivationScreen({ ...DETAIL, ...over }, compose)
  const plan = compose('motivation', s.facts)
  return { ...s, plan, orders: plan.parts.map((p) => p.order), html: draw(plan, s.data, { islands: ISLANDS }) }
}
/** The orders of a stacked item's own plan (the first item at a data key). */
const itemOrders = (data: Record<string, unknown>, key: string) => ((data[key] as { plan: ReturnType<Compose> }[])[0]?.plan.parts ?? []).map((p) => p.order)

describe('the Motivations list, composed by MeTTa', () => {
  it('loading, then a hive without motivations: the shared fragment, the page’s own words', () => {
    const loading = list({ loaded: false })
    expect(loading.orders).toEqual([5, 10, 11, 30])
    expect(loading.html).toContain('aria-label="Loading motivations"')
    const none = list({ supported: false })
    expect(none.orders).toEqual([10, 11, 31])
    expect(none.html).toContain('Not on this hive yet')
    expect(none.html).toContain('This hive does not keep motivations yet. Tasks work as before.')
  })

  it('groups them by whose they are, each with its count, then the unsorted line and its nudge', () => {
    const p = list()
    expect(p.orders).toEqual([5, 10, 11, 50, 51, 52, 53, 54, 55, 56, 57, 70])
    expect(p.plan.missing).toEqual([])
    expect(p.html).toMatch(/Yours 1<\/h3>[^]*Swarms 1<\/h3>[^]*Named by minds 1<\/h3>[^]*Shared with you 1<\/h3>/)
    expect(p.html).toContain('aria-label="Yours"')
    expect(p.html).toContain('New motivation')
    expect(p.html).toMatch(/<button[^>]*>Open Tasks →<\/button>/)
    // g4 is live and under none; g6 too (its swarm being archived does not hide it); g1 done, g2 failed are not live
    expect(p.html).toContain('2 live tasks are under no motivation you can see')
    expect(p.html).toContain('Sort these →')
    const sorted = list({ links: { ...LINKS, g4: [ref(ORCHARD)], g6: [ref(ORCHARD)] } })
    expect(sorted.orders).toContain(71)
    expect(sorted.html).toContain('0 live tasks are under no motivation you can see')
    expect(sorted.html).not.toContain('Sort these')
    expect(list({ goals: { g4: GOALS.g4 } }).html).toContain('1 live task is under no motivation you can see')
  })

  it('a card: its title opens it, its status in a tone, its why, its tasks counted once, and whose it is', () => {
    const p = list()
    const card = (p.data['group.mine.cards'] as { id: string; data: Record<string, unknown> }[])[0]
    expect(card.id).toBe(ORCHARD.id)
    expect(p.html).toMatch(/<button[^>]*>Grow a small orchard<\/button>[^]*?text-good[^>]*>Active</)
    expect(p.html).toContain('Fruit for the street by next summer.')
    // g2 is linked twice, counted once: 1 done of 2, 1 failed
    expect(p.html).toContain('role="img" aria-label="1 done, 1 failed"')
    expect(p.html).toContain('1 of 2 tasks done · 1 failed')
    expect(card.data['card.meta']).toMatch(/·/)
    // a paused swarm motivation is quieter, in amber; one without tasks says so
    expect(p.html).toMatch(/opacity-60[^]*?Keep bees calm[^]*?text-warn[^>]*>Paused</)
    expect(p.html).toContain('No tasks you can see under it yet')
  })

  it('a partial read says so, beside the list and on each card', () => {
    const p = list({ partial: true })
    expect(p.orders).toContain(60)
    expect(p.html).toContain('The hive did not finish listing everything, so these counts may be short.')
    expect(p.html).toContain(`No tasks found under it yet; this ${PARTIAL_WORDS}`)
    expect(p.html).toMatch(new RegExp(`data-partial="true">1 of 2 tasks done · 1 failed · ${PARTIAL_WORDS}`))
  })

  it('none yet: an invitation for whoever may make one, plain words for anyone else', () => {
    const mine = list({ motivations: {} })
    expect(mine.orders).toContain(40)
    expect(mine.html).toContain('Name the first one: what is all this work for?')
    const theirs = list({ motivations: {}, me: undefined })
    expect(theirs.orders).toEqual([10, 11, 41, 70])
    expect(theirs.html).toContain('None you can see yet. People, swarm owners and minds name them.')
  })

  it('OmegaEvolve’s objective shows only while the app offers one', () => {
    expect(list({ evolveShown: true }).html).toContain('EVOLVE')
    expect(list().html).not.toContain('EVOLVE')
  })

  it('making one: the form in a card, who can see it, and Make it held until it may be made', () => {
    const p = list({ making: true })
    expect(p.orders).toEqual([10, 11, 20, 50, 51, 52, 53, 54, 55, 56, 57, 70])
    expect(itemOrders(p.data, 'create.form')).toEqual([10, 20, 30, 31])
    expect(p.html).toContain('aria-label="New motivation"')
    expect(p.html).toContain('CREATE-WORDS')
    expect(p.html).toContain('role="radiogroup" aria-label="Who can see it"')
    expect(p.html).toMatch(/aria-checked="true" tabindex="0" data-radio-value="private"[^>]*>Only you</)
    expect(p.html).toMatch(/<button[^>]*disabled=""[^>]*>Make it<\/button>/)
    expect(p.html).toContain('Not now')
    const ready = list({ making: true, draft: { ...NEW_DRAFT, title: 'Learn the birds' } })
    expect(ready.html).not.toMatch(/disabled=""[^>]*>Make it/)
    const busy = list({ making: true, draft: { ...NEW_DRAFT, title: 'Learn the birds', busy: true } })
    expect(busy.html).toMatch(/disabled=""[^>]*>Making…/)
    const failed = list({ making: true, draft: { ...NEW_DRAFT, error: 'The hive refused it.' } })
    expect(itemOrders(failed.data, 'create.form')).toContain(26)
    expect(failed.html).toMatch(/role="alert"[^>]*>The hive refused it\./)
  })

  it('shared is a real choice: the people to name, while they are read, when there are none, and until one is named', () => {
    const shared = { ...NEW_DRAFT, title: 'Share the harvest', visibility: 'shared' as const }
    const reading = list({ making: true, draft: shared, people: { read: null, canList: true } })
    expect(itemOrders(reading.data, 'create.form')).toEqual([10, 20, 22, 24, 30, 31])
    expect(reading.html).toContain('Reading people…')
    expect(reading.html).toContain('Name at least one person to share it with.')
    const nobody = list({ making: true, draft: shared, people: { read: [person('p_ada', 'Ada')], canList: true } })
    expect(itemOrders(nobody.data, 'create.form')).toContain(23)
    expect(nobody.html).toContain('No one else is on this hive yet. Invite people from People first.')
    const named = list({ making: true, draft: { ...shared, people: ['user:p_cy'] }, people: { read: [person('p_ada', 'Ada'), person('p_cy', 'Cy'), person('p_di', 'Di')], canList: true } })
    expect(itemOrders(named.data, 'create.form')).toEqual([10, 20, 21, 30, 31])
    expect(named.html).toContain('<legend class="text-[12.5px] text-ink-3">Shared with</legend>')
    expect(named.html).toMatch(/checked=""\/>Cy<\/label>/)
    expect(named.html).toMatch(/type="checkbox"\/>Di<\/label>/)
    expect(named.html).not.toContain('>Ada<')
    expect(named.html).not.toMatch(/disabled=""[^>]*>Make it/)
  })

  it('the hive password is not a person: it says why, and offers a swarm’s instead (public by default)', () => {
    const p = list({ making: true, me: OPERATOR, draft: { ...NEW_DRAFT, title: 'Mend the fence' } })
    expect(itemOrders(p.data, 'create.form')).toContain(25)
    expect(p.html).toContain('The hive password is not a person.')
    expect(p.html).toMatch(/aria-checked="true"[^>]*data-radio-value="public"[^>]*>Everyone who can see the swarm</)
    expect(createChoice(NEW_DRAFT, OPERATOR, SWARMS).whose).toBe('team:s_g')
  })
})

describe('one motivation, composed by MeTTa', () => {
  it('a hive without motivations, still loading, and one not there for you', () => {
    const none = detail({ supported: false, m: undefined })
    expect(none.orders).toEqual([11, 12])
    expect(none.html).toContain('This hive does not keep motivations yet.')
    expect(none.html).toContain('All motivations')
    expect(none.frame.title).toBe('Motivation')
    const loading = detail({ m: undefined })
    expect(loading.orders).toEqual([10])
    expect(loading.frame.title).toBe('…')
    const gone = detail({ m: undefined, gone: true })
    expect(gone.orders).toEqual([15, 16])
    expect(gone.html).toContain('This motivation is not there for you: it may have been made private, or it no longer exists.')
  })

  it('in full: its card, the tasks under it, the way to Tasks, filing, and the shared board', () => {
    const p = detail()
    expect(p.orders).toEqual([20, 30, 32, 40, 50])
    expect(p.frame).toEqual({ label: 'Grow a small orchard', eyebrow: 'Motivation', title: 'Grow a small orchard', info: 'motivations' })
    expect(itemOrders(p.data, 'about')).toEqual([10, 11, 20, 22, 30, 40, 50, 51, 54])
    expect(p.html).toMatch(/text-good[^>]*>Active /)
    expect(p.html).toContain('Fruit for the street by next summer.')
    expect(p.html).toContain('Edit the words')
    expect(p.html).toContain('1 of 2 tasks done · 1 failed')
    expect(p.html).toMatch(/Who can see it<\/dt><dd[^>]*>Only you</)
    expect(p.html).toContain('Budgets and spend')
    expect(p.html).toMatch(/role="radiogroup" aria-label="Status"[^]*role="radiogroup" aria-label="Who can see it"/)
    expect(p.html).toContain('Status is for people: it never pauses, cancels or reassigns a task. There is no delete; Retired is the end.')
    expect(p.html).toContain('Tasks under it 2')
    expect(p.html).toMatch(/<button[^>]*>Open in Tasks →<\/button>/)
    expect(p.html).toContain('File tasks under it')
    expect(p.html).toContain('BOARD')
    expect([...p.ids].sort()).toEqual(['g1', 'g2'])
  })

  it('a reader sees it without the controls, and one that is achieved takes no tasks', () => {
    const p = detail({ m: PATH })
    expect(itemOrders(p.data, 'about')).toEqual([10, 11, 21, 31, 40])
    expect(p.html).toContain('No why written yet.')
    expect(p.html).toMatch(/Who can see it<\/dt><dd[^>]*>You and the people you name: p_ada</)
    expect(p.orders).not.toContain(40)
    expect(detail({ m: { ...ORCHARD, status: 'retired' } }).orders).not.toContain(40)
  })

  it('a partial read: the count is a floor, and says why', () => {
    const p = detail({ partial: true })
    expect(p.orders).toContain(31)
    expect(p.html).toContain('Tasks under it 2+')
    expect(p.html).toContain(`(${PARTIAL_WORDS})`)
    const empty = detail({ partial: true, m: SOIL })
    expect(itemOrders(empty.data, 'about')).toContain(32)
  })

  it('editing its words: the fields, Save held while blank, a change made meanwhile, and a refusal', () => {
    const words = { seen: ORCHARD, title: 'Grow a bigger orchard', why: 'More fruit.', busy: false, error: null }
    const p = detail({ words })
    expect(itemOrders(p.data, 'about')).toEqual([10, 11, 23, 26, 27, 30, 40, 50, 51, 54])
    expect(p.html).toContain('EDIT-WORDS')
    expect(p.html).toMatch(/data-screen-row="words"[^]*>Save<\/button>[^]*>Cancel<\/button>/)
    expect(detail({ words: { ...words, title: '  ' } }).html).toMatch(/disabled=""[^>]*>Save</)
    expect(detail({ words: { ...words, busy: true } }).html).toMatch(/disabled=""[^>]*>Saving…</)
    const changed = detail({ words, wordsChanged: true })
    expect(itemOrders(changed.data, 'about')).toContain(24)
    expect(changed.html).toContain('Someone changed this motivation since you began editing.')
    const refused = detail({ words: { ...words, error: 'Someone else changed it first.' }, wordsChanged: true })
    expect(itemOrders(refused.data, 'about')).toEqual(expect.arrayContaining([25]))
    expect(itemOrders(refused.data, 'about')).not.toContain(24)
    expect(refused.html).toMatch(/role="alert"[^>]*>Someone else changed it first\./)
  })

  it('who it is shared with: Change who, the people box, and a refusal from the controls', () => {
    const shared = { ...ORCHARD, visibility: 'shared' as const, shared_with: ['user:p_cy'] }
    const p = detail({ m: shared })
    expect(itemOrders(p.data, 'about')).toContain(52)
    expect(p.html).toContain('Change who')
    const people = { read: [person('p_cy', 'Cy'), person('p_di', 'Di')], canList: true }
    const open = detail({ m: shared, sharing: { seen: shared, people: ['user:p_cy'] }, people })
    expect(itemOrders(open.data, 'about')).toContain(53)
    expect(itemOrders(open.data, 'about')).not.toContain(52)
    expect(open.html).toContain('aria-label="Who it is shared with"')
    expect(open.html).toMatch(/checked=""\/>Cy<\/label>/)
    expect(open.html).toMatch(/>Share with these people<\/button>[^]*>Cancel</)
    const sharingItem = (d: Record<string, unknown>) => itemOrders((d.about as { data: Record<string, unknown> }[])[0].data, 'sharing.form')
    expect(sharingItem(open.data)).toEqual([10, 20, 21])
    const none = detail({ m: shared, sharing: { seen: shared, people: [] }, people: { read: [], canList: true } })
    expect(sharingItem(none.data)).toEqual([12, 13, 20, 21])
    expect(none.html).toContain('Name at least one person to share it with.')
    expect(none.html).toMatch(/disabled=""[^>]*>Share with these people/)
    const reading = detail({ m: shared, sharing: { seen: shared, people: ['user:p_cy'] }, people: { read: null, canList: true } })
    expect(sharingItem(reading.data)).toEqual([11, 20, 21])
    const refused = detail({ controls: { busy: false, error: 'Only its owner can change that.' } })
    expect(itemOrders(refused.data, 'about')).toContain(55)
    expect(refused.html).toMatch(/role="alert"[^>]*>Only its owner can change that\./)
  })

  // the two choosers: status and who can see it, each a radio group the screens engine draws
  /** One radio group's markup, by its accessible name. */
  const group = (html: string, label: string) => {
    const at = html.indexOf(`role="radiogroup" aria-label="${label}"`)
    expect(at, `no radio group named ${label}`).toBeGreaterThan(-1)
    return html.slice(at, html.indexOf('</div>', at))
  }
  it('each chooser has one tab stop, on the current value, with the words the page used before', () => {
    const p = detail()
    const status = group(p.html, 'Status')
    expect(status.match(/role="radio"/g)).toHaveLength(4)
    expect(status.match(/tabindex="0"/g)).toHaveLength(1)
    expect(status.match(/tabindex="-1"/g)).toHaveLength(3)
    expect(status).toMatch(/aria-checked="true" tabindex="0"[^>]*>Active</)
    expect([...status.matchAll(/>([^<]+)<\/button>/g)].map((x) => x[1])).toEqual(STATUS_ORDER.map((st) => STATUS_WORDS[st]))
    const who = group(p.html, 'Who can see it')
    expect(who.match(/role="radio"/g)).toHaveLength(3)
    expect(who.match(/tabindex="0"/g)).toHaveLength(1)
    expect(who).toMatch(/aria-checked="true" tabindex="0"[^>]*>Only you</)
    expect([...who.matchAll(/>([^<]+)<\/button>/g)].map((x) => x[1])).toEqual(['Only you', 'You and the people you name', 'Everyone who can see it'])
    expect(p.html).not.toContain('disabled=""')
    // a swarm's: its own status and words for whose it is
    const bees = detail({ m: BEES })
    expect(group(bees.html, 'Status')).toMatch(/aria-checked="true" tabindex="0"[^>]*>Paused</)
    expect(group(bees.html, 'Who can see it')).toMatch(/aria-checked="true" tabindex="0"[^>]*>Everyone who can see the swarm</)
    expect(group(bees.html, 'Who can see it')).toContain('>Only the swarm&#x27;s owner<')
  })

  it('a press sends the existing write: status, who can see it, or the people box for Shared', () => {
    expect(chooserPress('set-status', 'paused', ORCHARD, false)).toEqual({ kind: 'status', status: 'paused' })
    expect(chooserPress('set-visibility', 'public', ORCHARD, false)).toEqual({ kind: 'visibility', visibility: 'public' })
    expect(chooserPress('set-visibility', 'shared', ORCHARD, false)).toEqual({ kind: 'open-sharing' })
    expect(chooserPress('set-visibility', 'private', BEES, false)).toEqual({ kind: 'visibility', visibility: 'private' })
    // nothing for the value it has, one it cannot take, or while a change is saved
    expect(chooserPress('set-status', 'active', ORCHARD, false)).toBeNull()
    expect(chooserPress('set-status', 'deleted', ORCHARD, false)).toBeNull()
    expect(chooserPress('set-visibility', 'private', ORCHARD, false)).toBeNull()
    expect(chooserPress('set-status', 'paused', ORCHARD, true)).toBeNull()
    expect(chooserPress('set-visibility', 'shared', ORCHARD, true)).toBeNull()
    // the page carries each one out with the write the hand-drawn choices used, one at a time (run)
    expect(motivationsPage).toMatch(/case 'set-status':\s*case 'set-visibility': \{\s*const press = m \? chooserPress\(action, item\.value, m, controls\.busy\)/)
    expect(motivationsPage).toMatch(/if \(press\.kind === 'open-sharing'\) return openSharing\(\)/)
    expect(motivationsPage).toMatch(/run\(press\.kind === 'status' \? editMotivation\(m, \{ status: press\.status \}\) : setMotivationVisibility\(m, press\.visibility\)\)/)
    // MeTTa names those presses, holds both on controls.busy, and the page no longer draws them as islands
    expect(motivationsSource).toMatch(/\(Part motivation-about 50 chooser \(\(label "Status"\) \(value status\.value\) \(action set-status\) \(waits controls\.busy\)/)
    expect(motivationsSource).toMatch(/\(Part motivation-about 51 chooser \(\(label "Who can see it"\) \(value visibility\.value\) \(action set-visibility\) \(waits controls\.busy\)/)
    expect(motivationsSource).not.toMatch(/status-choice|visibility-choice/)
    expect(motivationsPage).not.toMatch(/status-choice|visibility-choice|role="radio"/)
  })

  it('both choosers are held while a change is being saved', () => {
    const p = detail({ controls: { busy: true, error: null } })
    for (const [label, n] of [['Status', 4], ['Who can see it', 3]] as const) {
      const g = group(p.html, label)
      expect(g, label).toContain('aria-disabled="true"')
      expect(g.match(/disabled=""/g), label).toHaveLength(n)
    }
    // Change who waits too, on the same flag
    expect(detail({ m: { ...ORCHARD, visibility: 'shared', shared_with: ['user:p_cy'] }, controls: { busy: true, error: null } }).html).toMatch(/disabled=""[^>]*>Change who</)
  })

  it('filing tasks: the box, its search, what can be filed, their subtasks, and how it went', () => {
    const open = detail({ file: { ...NEW_FILE, open: true } })
    expect(open.orders).toEqual([20, 30, 32, 43, 50])
    expect(itemOrders(open.data, 'file.form')).toEqual([10, 20, 30, 40, 41])
    expect(open.html).toContain('aria-label="File tasks under this motivation"')
    expect(open.html).toContain('placeholder="Find a task…"')
    // newest first, top-level only, not already under it, never in an archived swarm
    expect(open.html).toMatch(/Sweep the yard · Gardeners · open[^]*Build a hive box · Gardeners · submitted/)
    expect(open.html).not.toContain('Fetch the ladder')
    expect(open.html).not.toContain('Tidy the old shed')
    expect(open.html).toContain('Linking only files the task under this motivation for people who can read it.')
    expect(open.html).toMatch(/disabled=""[^>]*>File {2}tasks</)
    const picked = detail({ file: { ...NEW_FILE, open: true, picked: ['g4'] } })
    expect(itemOrders(picked.data, 'file.form')).toEqual([10, 20, 22, 30, 40, 41])
    expect(picked.html).toMatch(/checked=""\/>with their subtasks/)
    expect(picked.html).toMatch(/>File 1 task<\/button>/)
    const nothing = detail({ file: { ...NEW_FILE, open: true, query: 'zebra' } })
    expect(itemOrders(nothing.data, 'file.form')).toEqual([10, 21, 30, 40, 41])
    expect(nothing.html).toContain('No other tasks  to file.')
    expect(detail({ m: BEES, file: { ...NEW_FILE, open: true, query: 'zebra' } }).html).toContain('No other tasks in Gardeners to file.')
    const ok = detail({ file: { ...NEW_FILE, message: { tone: 'ok', text: 'Filed 1 task under it.' } } })
    expect(ok.orders).toContain(41)
    expect(ok.html).toMatch(/role="status"[^>]*>Filed 1 task under it\./)
    const bad = detail({ file: { ...NEW_FILE, message: { tone: 'bad', text: 'That task is gone.' } } })
    expect(bad.orders).toContain(42)
  })
})

describe('OmegaEvolve’s objective, composed by MeTTa', () => {
  const evolve = (o: Parameters<typeof evolveScreen>[0]) => {
    const s = evolveScreen(o)
    const plan = compose('evolve-objective', s.facts)
    return { orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data: s.data, onAction: () => {} } })) }
  }
  it('off: says so; on: the objective, what it is, and the growth lab when it has a home', () => {
    expect(evolve({ state: 'none', title: null, swarm: null }).orders).toEqual([10])
    const on = evolve({ state: 'read', title: 'Find kinder ways to grow', swarm: 's_g' })
    expect(on.orders).toEqual([20, 21, 22, 23, 30])
    expect(on.html).toContain('Find kinder ways to grow')
    expect(on.html).toContain('Open the growth lab')
    expect(evolve({ state: 'reading', title: null, swarm: null }).html).toContain('…')
  })
})

describe('the Motivations screens', () => {
  it('pure helpers: people choices keep anyone already named, the candidates, and the words of progress', () => {
    expect(peopleChoices({ read: null, canList: true }, ADA, []).reading).toBe(true)
    expect(peopleChoices({ read: null, canList: false }, ADA, ['user:p_zed'])).toEqual({ reading: false, items: [{ id: 'user:p_zed', label: 'p_zed', on: true }] })
    expect(fileCandidates({ swarm_id: null }, GOALS, new Set(['g1', 'g2']), SWARMS, '').map((g) => g.id)).toEqual(['g4', 'g3'])
    expect(progressWords({ total: 3, open: 0, working: 0, review: 1, done: 1, failed: 0, cancelled: 1, ratio: 0.5 }, false)).toBe('1 of 2 tasks done · 1 awaiting review · 1 cancelled, not counted')
  })

  it('every part of every screen can be reached, every block named is drawn, and the guards stay clean', () => {
    const declared = [...motivationsSource.matchAll(/^\(Part ([\w-]+) (\d+) ([\w-]+)/gm)]
    for (const [, , , block] of declared) expect(DRAWN_BLOCKS).toContain(block)
    for (const screen of SCREENS) expect([...(seen.get(screen) ?? [])].sort((a, b) => a - b), screen).toEqual(space.orders(screen))
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(space.explain('motivation-card', 30)?.words).toBe('a bar showing how far along it is')
  })
})
