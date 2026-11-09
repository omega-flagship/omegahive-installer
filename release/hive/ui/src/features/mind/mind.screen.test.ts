import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PersonalMind } from '../../api/personalMind'
import { Screen, scopedHost, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { ScreensSpace, type Compose } from '../../screens/screenSpace'
import mindSource from './mind.metta?raw'
import { mindScreen, type MindInput } from './data'
import type { Hands } from './hands'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The personal mind page end to end: an invented mind and memory → facts → MeTTa composes each screen → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose: Compose = (screen, facts) => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}

const MIND: PersonalMind = { id: 'a_wren', name: 'Wren', swarm_id: 's_wren', status: 'asleep', version: null, adopted_at: null, previous_version_id: null, allowance_usd: 20 }
const HOUR = 3600_000
const TALKS = [
  { id: 'pt_1', words: 'Which seeds go in first this spring?', answer: 'Broad beans and peas, once the soil can be worked.', truncated: false, at: Date.now() - 3 * HOUR, uses: 0 },
  { id: 'pt_2', words: 'How long do the hens need light?', answer: `${'About fourteen hours a day keeps them laying. '.repeat(8)}`, truncated: true, at: Date.now() - HOUR, uses: 2 },
]
const HANDS: Hands = { op: 'op_1', live: true, rows: [{ id: 'r1', text: 'Opened the Tasks page', state: 'done' }, { id: 'r2', text: 'Filling in the task title', state: 'now' }] }
const V7 = { id: 'mv_7', label: 'v7 Wren', score: { success: 0.81, steps: 7.4, cost_usd: 0.041 }, measured_at: null, suite_run_id: null }
const V8 = { id: 'mv_8', label: 'v8 Wren', score: { success: 0.9, steps: 6.1, cost_usd: 0.035 }, measured_at: new Date(Date.now() - 2 * HOUR).toISOString(), suite_run_id: 'lab_42' }

const input = (over: Partial<MindInput> = {}): MindInput => ({
  state: 'ready', mind: MIND, absentWhy: null, presence: 'asleep', openTalks: new Set(), hands: null, handed: [],
  rename: { editing: false, problem: null },
  memory: { ready: true, signedIn: true, hive: 'learning', capabilities: null, notes: 2, talks: TALKS, talkRecall: false },
  collect: { state: 'done', collecting: false, lost: false },
  versions: { state: 'later', data: null, busy: false, say: null, canAdopt: true, canRollback: true },
  ...over,
})
const ISLANDS = Object.fromEntries(['figure', 'notes', 'keep-safe'].map((n) => [n, createElement('p', null, `[${n}]`)]))

function page(over: Partial<MindInput> = {}, host: Partial<ScreenHost> = {}) {
  const { data, facts } = mindScreen(input(over), compose)
  const plan = compose('mind', facts)
  return { plan, data, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, islands: ISLANDS, onOpen: () => {}, onAction: () => {}, ...host } })) }
}
const islands = (p: { plan: { parts: { block: string | null; props: Record<string, unknown> }[] } }) => p.plan.parts.filter((x) => x.block === 'island').map((x) => x.props.name)
/** One card, from its screen to the next card. */
const CARDS = ['mind-hands', 'mind-remembers', 'mind-version', 'mind-handed']
const card = (html: string, screen: string) => {
  const start = html.indexOf(`data-screen="${screen}"`)
  const next = CARDS.slice(CARDS.indexOf(screen) + 1).map((c) => html.indexOf(`data-screen="${c}"`)).filter((i) => i > start)
  return html.slice(start, next.length ? Math.min(...next) : undefined)
}

describe('the personal mind page, composed by MeTTa', () => {
  it('its screens are known; the guards stay clean; nothing falls back', () => {
    expect(space.screens()).toEqual(expect.arrayContaining(['mind', 'mind-hands', 'mind-remembers', 'mind-talk', 'mind-version', 'mind-handed']))
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(page().plan.missing).toEqual([])
    expect(space.islands().filter((i) => i.screen.startsWith('mind'))).toEqual(expect.arrayContaining([
      { screen: 'mind', name: 'figure' }, { screen: 'mind-remembers', name: 'notes' }, { screen: 'mind-remembers', name: 'keep-safe' }]))
  })
  it('while it is found: a placeholder, nothing else', () => {
    const { plan, html } = page({ state: 'loading', mind: null })
    expect(plan.parts.map((p) => p.order)).toEqual([10])
    expect(html).toContain('aria-label="Finding your mind"')
  })
  it('when it could not be read: says so, with Try again', () => {
    const { plan, html } = page({ state: 'error', mind: null })
    expect(plan.parts.map((p) => p.order)).toEqual([13, 14])
    expect(html).toContain('role="alert"')
    expect(html).toContain('Your personal mind could not be read just now.')
    expect(html).toContain('>Try again</button>')
  })
  it('no personal mind on this hive, or none for this account: said calmly, with Back to You', () => {
    const route = page({ state: 'absent', mind: null, absentWhy: 'no_route' })
    expect(route.plan.parts.map((p) => p.order)).toEqual([11, 15])
    expect(route.html).toContain('Your personal mind isn’t set up on this hive yet')
    expect(route.html).toContain('When this hive has personal minds, yours will be here, named after you.')
    expect(route.html).toContain('Back to You</button>')
    const person = page({ state: 'absent', mind: null, absentWhy: 'person_required' })
    expect(person.plan.parts.map((p) => p.order)).toEqual([12, 15])
    expect(person.html).toContain('A personal mind belongs to a signed-in person with an account here.')
    const none = page({ state: 'none', mind: null })
    expect(none.plan.parts.map((p) => p.order)).toEqual([11, 15])
  })
  it('who it is: its name, Rename, whether it is awake, what it holds, its energy and its figure', () => {
    const { html, plan } = page()
    expect(html).toContain('Your personal mind</p>')
    expect(html).toContain('>Wren</h2>')
    expect(html).toContain('Your mind · alone in its own swarm')
    expect(html).toContain('Rename</button>')
    expect(html).toContain('aria-label="Who it is"')
    expect(html).toContain('>Asleep</dd>')
    expect(html).toContain('>2 notes · 2 talks</dd>')
    expect(html).toContain('your allowance · $20 a month')
    expect(html).not.toContain('>Version</dt>')
    expect(islands({ plan })).toEqual(['figure'])
    expect(page({ mind: { ...MIND, allowance_usd: null } }).html).toContain('>your allowance</dd>')
    expect(page({ mind: { ...MIND, version: V7 } }).html).toContain('>v7 Wren</dd>')
  })
  it('renaming: a field holding its name in place of Rename, capped at 80; a refusal says why', () => {
    const { html } = page({ rename: { editing: true, problem: null } })
    expect(html).toContain('aria-label="Your mind’s name"')
    expect(html).toContain('value="Wren"')
    expect(html).toContain('maxLength="80"')
    expect(html).not.toContain('Rename</button>')
    const refused = page({ rename: { editing: true, problem: 'The hive did not take that name. Try plain words.' } }).html
    expect(refused).toContain('role="alert"')
    expect(refused).toContain('The hive did not take that name. Try plain words.')
  })
  it('the cards: its hands and what it remembers in the main column, its version and handoffs beside them', () => {
    const { html } = page()
    expect(html).toContain('aria-label="Its hands"')
    expect(html).toContain('aria-label="What Wren remembers"')
    expect(html).toContain('data-tour="mind-remembers"')
    expect(html).toContain('aria-label="Its version and what it handed on"')
    const aside = html.slice(html.indexOf('data-screen-region="aside"'))
    expect(aside).toContain('data-screen="mind-version"')
    expect(aside).toContain('data-screen="mind-handed"')
    expect(aside).not.toContain('data-screen="mind-hands"')
    expect(html.indexOf('data-screen="mind-hands"')).toBeLessThan(html.indexOf('data-screen="mind-remembers"'))
  })
  it('its hands: resting, what it did last, and while it acts each step with Take back control', () => {
    const resting = card(page().html, 'mind-hands')
    expect(resting).toContain('Wren is not acting on your screen. When the Ask acts for you, you will see each step here.')
    expect(resting).not.toContain('Take back control')
    const acting = card(page({ hands: HANDS, presence: 'working' }).html, 'mind-hands')
    expect(acting).toContain('Acting on your screen')
    expect(acting).toContain('What Wren is doing on this screen right now.')
    expect(acting).toContain('aria-label="Its steps"')
    expect(acting).toContain('Filling in the task title')
    expect(acting).toContain('Take back control</button>')
    expect(acting).toContain('or click anywhere')
    const last = card(page({ hands: { ...HANDS, live: false } }).html, 'mind-hands')
    expect(last).toContain('What Wren did on your screen last.')
    expect(last).not.toContain('Take back control')
  })
  it('what it remembers: the memory badge, its notes (or none, or still reading), and keeping it safe', () => {
    const p = page()
    const mem = card(p.html, 'mind-remembers')
    expect(mem).toContain('What Wren remembers')
    expect(mem).toContain('Memory on')
    expect(mem).toContain('[notes]')
    expect(mem).toContain('[keep-safe]')
    expect(card(page({ memory: { ...input().memory, hive: 'off' } }).html, 'mind-remembers')).toContain('Memory off')
    expect(card(page({ memory: { ...input().memory, hive: 'unknown' } }).html, 'mind-remembers')).toMatch(/>Memory<\/span>/)
    expect(card(page({ memory: { ...input().memory, notes: 0 } }).html, 'mind-remembers')).toContain('No notes yet.')
    const reading = card(page({ memory: { ...input().memory, ready: false } }).html, 'mind-remembers')
    expect(reading).toContain('Reading this browser’s memory…')
    expect(reading).not.toContain('[notes]')
    expect(reading).not.toContain('aria-label="Use my swarm talk in answers"')
  })
  it('the swarm talk: the choice (off until turned on), each conversation newest first, View and Forget', () => {
    const mem = card(page().html, 'mind-remembers')
    expect(mem).toContain('From your swarm talk')
    expect(mem).toContain('remembered without waking Wren')
    expect(mem).toContain('data-tour="mind-talk-recall"')
    expect(mem).toContain('aria-label="Use my swarm talk in answers"')
    expect(mem).toContain('Kept in your browser, not used in answers yet.')
    expect(mem).toContain('Forget everything clears what’s remembered')
    expect(mem.indexOf('How long do the hens need light?')).toBeLessThan(mem.indexOf('Which seeds go in first'))
    expect(mem).toContain('used 2 times when you asked')
    expect(mem).toContain('not used yet')
    expect(mem).toContain('aria-label="All of: Which seeds go in first this spring?"')
    expect(mem).toContain('aria-label="Forget: Which seeds go in first this spring?"')
    expect(mem).toContain('aria-expanded="false"')
    expect(mem).not.toContain('(cut short by the hive)')
    const on = card(page({ memory: { ...input().memory, talkRecall: true }, openTalks: new Set(['pt_1', 'pt_2']) }).html, 'mind-remembers')
    expect(on).toContain('so Wren gets to know you')
    expect(on).toContain('aria-label="Less of: How long do the hens need light?"')
    expect(on).toContain('aria-expanded="true"')
    expect(on).toContain('(cut short by the hive)')
    expect(on.match(/\(cut short by the hive\)/g)).toHaveLength(1)
    expect(on).toContain('aria-label="Less of: Which seeds go in first this spring?"')
  })
  it('no swarm talk yet, a hive that keeps none, and what collecting says', () => {
    const none = { ...input().memory, talks: [] }
    expect(card(page({ memory: none }).html, 'mind-remembers')).toContain('Nothing yet. When you talk with one of your swarms, a copy is kept here.')
    expect(card(page({ memory: none, collect: { state: 'absent', collecting: false, lost: false } }).html, 'mind-remembers')).toContain('Swarm talk is not kept on this hive yet.')
    expect(card(page({ collect: { state: null, collecting: true, lost: false } }).html, 'mind-remembers')).toContain('Collecting from the hive…')
    expect(card(page({ collect: { state: 'done', collecting: false, lost: true } }).html, 'mind-remembers')).toContain('Some older conversations weren’t collected in time')
    expect(card(page({ collect: { state: 'volatile', collecting: false, lost: false } }).html, 'mind-remembers')).toContain('Your browser isn’t keeping memory here')
    expect(card(page({ collect: { state: 'failed', collecting: false, lost: false } }).html, 'mind-remembers')).toContain('The hive could not be reached just now')
  })
  it('its version: comes later, being read, or could not be read', () => {
    expect(card(page().html, 'mind-version')).toContain('Version choice comes later.')
    expect(card(page({ versions: { ...input().versions, state: 'loading' } }).html, 'mind-version')).toContain('Reading its version…')
    expect(card(page({ versions: { ...input().versions, state: 'error' } }).html, 'mind-version')).toContain('Its version could not be read just now.')
    expect(card(page({ versions: { ...input().versions, state: 'ready', data: null } }).html, 'mind-version')).toContain('Its version could not be read just now.')
  })
  it('its version: the best so far, or not known yet', () => {
    const best = card(page({ versions: { ...input().versions, state: 'ready', data: { current: V7, best: V7, candidates: [] } } }).html, 'mind-version')
    expect(best).toContain('Wren runs v7 Wren. It is the best measured so far.')
    expect(best).not.toContain('Adopt')
    const unknown = card(page({ versions: { ...input().versions, state: 'ready', data: { current: null, best: null, candidates: [] } } }).html, 'mind-version')
    expect(unknown).toContain('Wren’s version is not known yet.')
  })
  it('a better version waiting: how they measured, Adopt and Roll back, each held while one is under way', () => {
    const adopted = { ...MIND, version: V7, adopted_at: new Date(Date.now() - 26 * HOUR).toISOString(), previous_version_id: 'mv_6' }
    const ready = { ...input().versions, state: 'ready' as const, data: { current: V7, best: V8, candidates: [] } }
    const v = card(page({ mind: adopted, versions: ready }).html, 'mind-version')
    expect(v).toContain('v8 Wren is waiting')
    expect(v).toContain('Wren runs v7 Wren, adopted')
    expect(v).toContain('A better one is waiting.')
    expect(v).toContain('aria-label="Now · v7 Wren, best · v8 Wren"')
    expect(v).toContain('81% now · 90% at best')
    expect(v).toContain('7.4 now · 6.1 at best')
    expect(v).toContain('$0.041 now · $0.035 at best')
    expect(v).toContain('v8 Wren: measured 2h ago · Lab run lab_42.')
    expect(v).toMatch(/<button[^>]*>Adopt v8 Wren<\/button>/)
    expect(v).toMatch(/<button[^>]*>Roll back<\/button>/)
    const busy = card(page({ mind: adopted, versions: { ...ready, busy: true, say: 'Wren now runs v8 Wren.' } }).html, 'mind-version')
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Adopt v8 Wren<\/button>/)
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Roll back<\/button>/)
    expect(busy).toContain('Wren now runs v8 Wren.')
    // a hive that cannot adopt or roll back offers neither
    const cannot = card(page({ mind: adopted, versions: { ...ready, canAdopt: false, canRollback: false } }).html, 'mind-version')
    expect(cannot).not.toContain('Adopt v8')
    expect(cannot).not.toContain('Roll back')
  })
  it('what it handed on, or nothing yet', () => {
    expect(card(page().html, 'mind-handed')).toContain('Nothing handed on in this thread yet.')
    const handed = card(page({ handed: [{ id: 'op_1#3', text: 'Plan the bed rotation · Garden swarm', at: new Date(Date.now() - HOUR).toISOString() }] }).html, 'mind-handed')
    expect(handed).toContain('passed to the right swarm’s coordinator')
    expect(handed).toContain('Plan the bed rotation · Garden swarm')
    expect(handed).toContain('1h ago')
  })
  it('a press on a conversation comes back scoped [card, conversation], newest first', () => {
    const presses: [string, unknown][] = []
    const { data } = mindScreen(input(), compose)
    const remembers = (data['remembers.card'] as ScreenItem[])[0]
    const talks = (remembers.data as Record<string, unknown>)['talk.all'] as ScreenItem[]
    expect(talks.map((t) => t.id)).toEqual(['pt_2', 'pt_1'])
    const host: ScreenHost = { data, onAction: (action, item) => presses.push([action, item.scope]) }
    scopedHost(scopedHost(host, remembers), talks[1]).onAction!('forget-talk', {})
    expect(presses).toEqual([['forget-talk', ['remembers', 'pt_1']]])
  })
  it('no internal codes or raw ids in what it says', () => {
    const { html } = page({ hands: HANDS })
    expect(html).not.toMatch(/a_wren|s_wren|mv_\d/)
  })
  it('Cosmos draws the same atoms on a 3D stage', () => {
    const { data, facts } = mindScreen(input(), compose)
    const plan = space.compose('mind', 'cosmos', facts)
    expect(plan.space).toBe('3d')
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data } }))).toContain('What Wren remembers')
  })
  it('every part of every personal mind screen can be reached', () => {
    const declared = new Map<string, Set<number>>()
    for (const [, screen] of mindSource.matchAll(/^\(Screen (\S+) /gm)) declared.set(screen, new Set(space.orders(screen)))
    expect([...declared.keys()].sort()).toEqual(['mind', 'mind-handed', 'mind-hands', 'mind-remembers', 'mind-talk', 'mind-version'])
    expect(declared.get('mind')?.has(13)).toBe(true)
    expect(declared.get('mind-version')?.has(33)).toBe(true)
    for (const [screen, orders] of declared) expect([...orders].filter((o) => !seen.get(screen)?.has(o)), screen).toEqual([])
  })
})
