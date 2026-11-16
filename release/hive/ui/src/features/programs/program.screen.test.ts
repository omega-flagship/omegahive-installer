import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PERSON_APP_REASONS, type PersonAppReason } from '../../api/personApps'
import type { PersonAppState } from '../../lib/personAppOpen'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { ScreensSpace, type ScreenFacts, type ScreenPlan } from '../../screens/screenSpace'
import { appPage, closedPage, menuSections, type AppPageState } from './appPage'

vi.setConfig({ testTimeout: 20_000 })

/** One app's page end to end: invented apps and swarms → facts → MeTTa composes the notes, the stage and Ω → drawn. */
const space = ScreensSpace.open()
const seen = new Map<string, Set<number>>()
const compose = (screen: string, facts: ScreenFacts): ScreenPlan => {
  const plan = space.compose(screen, 'classic', facts)
  const orders = seen.get(screen) ?? new Set<number>()
  for (const p of plan.parts) orders.add(p.order)
  seen.set(screen, orders)
  return plan
}

const OFF = { graph: false, own: false, code: false, flow: false, make: false, access: false }
const st = (over: Partial<AppPageState> = {}): AppPageState => ({
  name: 'Seed Ledger', swarm: 's_orchard', swarmName: 'Orchard', ui: true, form: null, create: false, person: false,
  personState: { kind: 'opening' }, view: OFF, canAccess: true, homesState: { kind: 'known', homes: [{ swarm_id: 's_orchard', why: 'configured' }] },
  homesKnown: [{ id: 's_orchard', name: 'Orchard' }], pick: undefined, choices: [],
  swarms: [{ id: 's_meadow', name: 'Meadow' }, { id: 's_orchard', name: 'Orchard' }], ...over,
})
const plans = (s: AppPageState) => {
  const { data, facts } = appPage(s)
  return { data, chrome: compose('program', facts), stage: compose('program-stage', facts), menu: compose('program-menu', facts) }
}
/** The islands a plan places, in order (the app's own surfaces and the page's dialogs). */
const islands = (plan: ScreenPlan) => plan.parts.filter((p) => p.block === 'island').map((p) => p.props.name)
const ISLANDS = Object.fromEntries(['studio-live', 'coordinator', 'drawing-entry', 'app-frame', 'app-form', 'app-graph', 'code-bench', 'flow-bench', 'make-bench', 'omega-menu', 'app-access', 'confirm', 'consent']
  .map((n) => [n, createElement('i', { 'data-island': n })]))
const draw = (plan: ScreenPlan, data: Record<string, unknown>, extra: Partial<ScreenHost> = {}) =>
  renderToStaticMarkup(createElement(Screen, { plan, host: { data, islands: ISLANDS, onOpen: () => undefined, onAction: () => undefined, ...extra } }))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')
const menu = (s: AppPageState) => {
  const { data, menu: plan } = plans(s)
  return menuSections(plan, data)
}
const labels = (s: AppPageState) => menu(s).map((x) => [x.title ?? '', x.items.map((i) => (i.checked === undefined ? i.label : `${i.label}${i.checked ? ' ✓' : ''}`))])

describe('an open app: MeTTa places its own surfaces', () => {
  it('an app with its own interface: the frame, and the dialogs over it', () => {
    const { stage, chrome } = plans(st())
    expect(islands(stage)).toEqual(['app-frame', 'omega-menu', 'confirm', 'consent'])
    expect(islands(chrome)).toEqual(['coordinator', 'studio-live'])
    expect(chrome.parts.filter((p) => p.block !== 'island')).toEqual([])   // set up here, a swarm app: no notes
  })
  it('the graph view: the frame stays placed, hidden, and the graph shows', () => {
    const { stage, data } = plans(st({ view: { ...OFF, graph: true } }))
    expect(islands(stage).slice(0, 2)).toEqual(['app-frame', 'app-graph'])
    const html = draw(stage, data)
    expect(html).toMatch(/data-screen-part="program-stage.10"[^>]*hidden=""/)
    expect(html).not.toMatch(/data-screen-part="program-stage.30"[^>]*hidden/)
    // and back: the same part, now shown
    const back = plans(st())
    expect(draw(back.stage, back.data)).not.toMatch(/data-screen-part="program-stage.10"[^>]*hidden/)
  })
  it('an app with neither an interface nor a form: its work graph is its view', () => {
    expect(islands(plans(st({ ui: false })).stage)[0]).toBe('app-graph')
  })
  it('a form built for an app without an interface: the form, or the graph', () => {
    expect(islands(plans(st({ ui: false, form: 'case-file' })).stage)[0]).toBe('app-form')
    expect(islands(plans(st({ ui: false, form: 'case-file', view: { ...OFF, graph: true } })).stage)[0]).toBe('app-graph')
  })
  it('Create: its canvas form, its own Studio over it, and the Code and Flow benches over both (kept, hidden)', () => {
    const create = { ui: true, form: 'design-canvas' as const, create: true, name: 'Create' }
    expect(islands(plans(st(create)).stage)[0]).toBe('app-form')
    expect(islands(plans(st({ ...create, view: { ...OFF, own: true } })).stage)[0]).toBe('app-frame')
    const code = plans(st({ ...create, view: { ...OFF, code: true } }))
    expect(islands(code.stage).slice(0, 2)).toEqual(['app-form', 'code-bench'])
    expect(draw(code.stage, code.data)).toMatch(/data-screen-part="program-stage.20"[^>]*hidden=""/)
    const flow = plans(st({ ...create, view: { ...OFF, own: true, flow: true } }))
    expect(islands(flow.stage).slice(0, 2)).toEqual(['app-frame', 'flow-bench'])
    expect(draw(flow.stage, flow.data)).toMatch(/data-screen-part="program-stage.10"[^>]*hidden=""/)
    // the bench tabs and the drawing entry above it
    const html = draw(code.chrome, code.data)
    expect(html).toContain('aria-label="Create benches"')
    expect(html).toContain('data-tour="create-benches"')
    expect(html.match(/role="tab"/g)).toHaveLength(4)
    expect(html).toMatch(/aria-selected="true"[^>]*>(<[^>]+>)*Code/)
    expect(html).not.toMatch(/font-mono/)   // a bench carries no count
    expect(islands(code.chrome)).toContain('drawing-entry')
    expect(islands(plans(st()).chrome)).not.toContain('drawing-entry')
    // Make: one sentence to a planned, built thing; the app's own surfaces stay mounted, hidden, under it
    const make = plans(st({ ...create, view: { ...OFF, make: true } }))
    expect(islands(make.stage).slice(0, 2)).toEqual(['app-form', 'make-bench'])
    expect(draw(make.stage, make.data)).toMatch(/data-screen-part="program-stage.20"[^>]*hidden=""/)
    expect(draw(make.chrome, make.data)).toMatch(/aria-selected="true"[^>]*>(<[^>]+>)*Make/)
  })
  it('where it runs opens over the app', () => {
    expect(islands(plans(st({ view: { ...OFF, access: true } })).stage)).toContain('app-access')
  })
  it('opened where it is not set up: says so, with each place it works as a button', () => {
    const s = st({ swarm: 's_meadow', swarmName: 'Meadow' })
    const { chrome, data } = plans(s)
    const pressed: unknown[] = []
    const html = draw(chrome, data, { onOpen: (t, item) => pressed.push([t, item.id]) })
    expect(text(html)).toContain('Seed Ledger is not set up in Meadow. It works in:')
    expect(html).toContain('data-screen-row="homes"')
    expect(html).toMatch(/<button[^>]*>(<[^>]+>)*Orchard</)
  })
})

describe('before the app opens: the states, composed', () => {
  const away = (over: Partial<AppPageState>) => {
    const { stage, data } = plans(st({ swarm: null, swarmName: '', ...over }))
    return { stage, html: text(draw(stage, data)), raw: draw(stage, data) }
  }
  it('while it looks for a swarm: an opening line, naming the app', () => {
    const { html, stage } = away({ homesState: { kind: 'pending' } })
    expect(html).toContain('Opening Seed Ledger…')
    expect(islands(stage)).toEqual(['omega-menu', 'confirm', 'consent'])   // no surface without a swarm
  })
  it('could not check where it works: why, nothing opened, Try again', () => {
    expect(away({ homesState: { kind: 'failed', denied: true } }).html).toContain('This hive did not let you see where Seed Ledger is set up. Nothing was opened.')
    const { html } = away({ homesState: { kind: 'failed', denied: false } })
    expect(html).toContain("Couldn't check where Seed Ledger works")
    expect(html).toContain('The hive did not answer where Seed Ledger is set up.')
    expect(html).toContain('Try again')
  })
  it('turned on nowhere the person can use: says who turns it on, and the way back', () => {
    const { html } = away({ homesState: { kind: 'known', homes: [] }, homesKnown: [], pick: null, choices: [{ id: 's_meadow', name: 'Meadow' }] })
    expect(html).toContain("Seed Ledger isn't turned on in a swarm you can use")
    expect(html).toContain('Back to Apps')
    expect(html).not.toContain('Choose where to open')
  })
  it('nowhere to open by itself: the person picks, never a guess', () => {
    const choices = [{ id: 's_meadow', name: 'Meadow' }]
    const homes = { kind: 'known' as const, homes: [{ swarm_id: 's_far', why: 'configured' }] }
    expect(away({ homesState: homes, pick: null, choices }).html).toContain('Seed Ledger works inside a swarm. Pick one you can use.')
    expect(away({ homesState: homes, pick: null, choices }).raw).toMatch(/<button[^>]*>(<[^>]+>)*Meadow</)
    expect(away({ homesState: homes, pick: null }).html).toContain('There is no swarm here that you can use for Seed Ledger yet.')
    expect(away({ homesState: { kind: 'absent' }, pick: null, choices }).html).toContain('works inside a swarm; pick one.')
    expect(away({ homesState: { kind: 'absent' }, pick: null }).html).toContain('Pick one from Ω → Works in.')
  })
  it('a person app: opening while its space is made, then one approved reason and its one action', () => {
    const person = { person: true, homesState: { kind: 'pending' as const } }
    expect(away({ ...person, personState: { kind: 'opening' } }).html).toContain('Opening Seed Ledger…')
    for (const reason of Object.keys(PERSON_APP_REASONS) as PersonAppReason[]) {
      const { html, raw } = away({ ...person, personState: { kind: 'failed', reason } })
      expect(html).toContain(PERSON_APP_REASONS[reason].text)
      expect(raw.match(/<button/g), reason).toHaveLength(1)
      expect(html).not.toContain('Opening Seed Ledger')
    }
  })
})

describe('a person app, open', () => {
  const ready = (extra: Partial<Extract<PersonAppState, { kind: 'ready' }>>): PersonAppState => ({ kind: 'ready', swarmId: 's_own', needs: [], helpers: 'none', spaceLine: null, ...extra })
  const open = (personState: PersonAppState) => plans(st({ person: true, swarm: 's_own', personState, homesState: { kind: 'pending' } }))
  it('its notes over the app; no coordinator note; consent only while helpers are being set up or none are asked', () => {
    const key = open(ready({ helpers: 'key', needs: ['ai_key'] }))
    expect(text(draw(key.chrome, key.data))).toContain("Seed Ledger's helpers run on your own AI key. Opening it costs nothing")
    expect(text(draw(key.chrome, key.data))).not.toContain('monthly total')
    const monthly = open(ready({ helpers: 'key', needs: ['ai_key', 'monthly_total'] }))
    expect(text(draw(monthly.chrome, monthly.data))).toContain('on your own AI key, within a monthly total you set.')
    expect(islands(key.chrome)).not.toContain('coordinator')
    expect(islands(key.stage)).not.toContain('consent')
    expect(islands(open(ready({ helpers: 'declined' })).stage)).not.toContain('consent')
    expect(islands(open(ready({ helpers: 'consent' })).stage)).toContain('consent')
    expect(islands(open({ kind: 'opening' }).stage)).not.toContain('consent')
  })
})

describe('the page for an app that is not available here', () => {
  const closed = (state: 'opening' | 'unlisted' | 'unreadable', retry = true) => {
    const plan = compose('program-closed', closedPage(state, retry).facts)
    return { plan, html: text(draw(plan, {})) }
  }
  it('names nothing of the app, in each state', () => {
    expect(closed('opening').html).toContain('Opening the app…')
    expect(closed('opening').html).not.toContain('Back to Apps')
    expect(closed('unlisted').html).toContain("This app isn't available to you here")
    expect(closed('unlisted').html).not.toContain('Try again')
    const buttons = (plan: ScreenPlan) => draw(plan, {}).match(/<button[^>]*>Try again</g)?.length ?? 0
    expect(buttons(closed('unreadable').plan)).toBe(1)
    expect(buttons(closed('unreadable', false).plan)).toBe(0)
    expect(closed('unreadable').html).toContain('Back to Apps')
    expect(islands(closed('unlisted').plan)).toEqual(['studio-live', 'omega-menu'])
  })
})

describe('the app’s Ω entries, composed', () => {
  it('a swarm app with its own interface: Leave, Where it runs, its views, and the swarms it can work in', () => {
    expect(labels(st())).toEqual([
      ['', ['Leave Seed Ledger', 'Where it runs…']],
      ['View', ['App ✓', 'Graph']],
      ['Works in', ['Meadow', 'Orchard ✓']],
    ])
    expect(labels(st({ view: { ...OFF, graph: true }, canAccess: false, swarms: [{ id: 's_orchard', name: 'Orchard' }] }))).toEqual([
      ['', ['Leave Seed Ledger']],
      ['View', ['App', 'Graph ✓']],
    ])
  })
  it('each form names its view; Studio or Create over a form', () => {
    const forms = [['case-file', 'Case file'], ['life-map', 'Body map'], ['commons', 'App']] as const
    for (const [form, label] of forms) expect(labels(st({ ui: false, form }))[1]).toEqual(['View', [`${label} ✓`, 'Graph']])
    expect(labels(st({ form: 'case-file', view: { ...OFF, own: true } }))[1]).toEqual(['View', ['Case file', 'Studio ✓', 'Graph']])
  })
  it('Create: Code, Flow and Draw live, and its benches marked', () => {
    const create = st({ create: true, name: 'Create', form: 'design-canvas', view: { ...OFF, code: true } })
    expect(labels(create)).toEqual([
      ['', ['Leave Create', 'Code ✓', 'Flow', 'Make', 'Draw live in Create…', 'Where it runs…']],
      ['View', ['Canvas', 'Create', 'Graph']],
      ['Works in', ['Meadow', 'Orchard ✓']],
    ])
  })
  it('a person app has no Works in; before a swarm opens, no views', () => {
    expect(labels(st({ person: true, swarm: null }))).toEqual([['', ['Leave Seed Ledger', 'Where it runs…']]])
  })
  it('each entry sends its own press, with the swarm it names', () => {
    const got = menu(st()).flatMap((x) => x.items.map((i) => [i.action, i.item.id ?? null]))
    expect(got).toEqual([['leave', null], ['access', null], ['view-own', null], ['view-graph', null], ['works-in', 's_meadow'], ['works-in', 's_orchard']])
  })
})

describe('the page’s screens', () => {
  it('every part of each can be reached', () => {
    for (const screen of ['program', 'program-stage', 'program-menu', 'program-closed']) {
      const missing = space.orders(screen).filter((o) => !seen.get(screen)?.has(o))
      expect(missing, screen).toEqual([])
    }
  })
  it('the guards stay clean', () => {
    for (const [name, list] of Object.entries(space.guards())) expect(list, name).toEqual([])
  })
  it('places only the islands the page offers', () => {
    const placed = new Set(space.islands().filter((x) => x.screen.startsWith('program-') || x.screen === 'program').map((x) => x.name))
    expect([...placed].sort()).toEqual(Object.keys(ISLANDS).sort())
  })
})
