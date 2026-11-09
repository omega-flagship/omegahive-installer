import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ALL_EXPERIENCES } from '../experiences/registry'
import { href, parse } from '../lib/router'
import { Screen } from './Screen'
import { rememberedCompose, ScreensError, ScreensSpace, SCREEN_SOURCES } from './screenSpace'
import { clearMissingBlocks, missingBlocks, reportMissing, screensRelease } from './buildTasks'
import { resourceFacts } from './resourceFacts'
import { ApiError } from '../api/client'

vi.setConfig({ testTimeout: 20_000 })

/** The engine's own promises: what reaches MeTTa, what leaves it, and what the page draws. Invented data only. */
const FIXTURE = `
(Screen demo "Demo")
(RolePart demo 20 collection ((source items) (title title)))
(When demo 20 (has items))
(Part demo 21 empty ((title "Nothing yet")))
(When demo 21 (none items))
(Part demo 30 timeline ((source events)))
(= (scr-compose broken $look) one)
(= (scr-compose broken $look) two)
`
const space = ScreensSpace.open([...SCREEN_SOURCES, ['demo', FIXTURE]])

describe('what reaches MeTTa', () => {
  it('refuses a fact that is not a plain name, count or flag', () => {
    expect(() => space.compose('demo', 'classic', { counts: { '(bad)': 1 } })).toThrow(ScreensError)
    expect(() => space.compose('demo', 'classic', { counts: { items: -1 } })).toThrow(ScreensError)
    expect(() => space.compose('demo', 'classic', { counts: { items: 1.5 } })).toThrow(ScreensError)
    expect(() => space.compose('demo', 'classic', { flags: { '$x': true } })).toThrow(ScreensError)
    expect(() => space.compose('demo', 'classic', { values: { mode: 'two words' } })).toThrow(ScreensError)
    expect(() => space.compose('(demo)', 'classic')).toThrow(ScreensError)
  })
  it('removes this moment’s facts even when composing fails', () => {
    expect(() => space.compose('broken', 'classic', { counts: { items: 3 } })).toThrow(ScreensError)
    expect(space.compose('demo', 'classic').parts.map((p) => p.block)).toEqual(['empty', 'list'])
  })
})

describe('values are compared as data, never run', () => {
  it('a value that names a MeTTa function (member, empty, and, if, True) matches only itself', () => {
    const src = `(Screen q "Q")\n(Part q 10 notice ((text "member")))\n(When q 10 (is role member))\n(Part q 20 notice ((text "admin")))\n(When q 20 (is role admin))`
    const s = ScreensSpace.open([...SCREEN_SOURCES, ['q', src]])
    const shown = (role: string) => s.compose('q', 'classic', { values: { role } }).parts.map((p) => p.order)
    expect(shown('member')).toEqual([10])
    expect(shown('admin')).toEqual([20])
    for (const word of ['empty', 'and', 'if', 'True', 'none']) expect(shown(word)).toEqual([])
    expect(s.compose('q', 'classic').parts).toEqual([])
  })
})

describe('props are data, never run', () => {
  it('a prop named after a library function (max, min, empty, and) is kept as written, and the part stays', () => {
    const src = `(Screen q "Q")\n(Part q 10 notice ((text "hi") (max 60) (empty "e") (min 2) (and x)))`
    const p = ScreensSpace.open([...SCREEN_SOURCES, ['q', src]]).compose('q', 'classic')
    expect(p.parts.map((x) => x.props)).toEqual([{ text: 'hi', max: 60, empty: 'e', min: 2, and: 'x' }])
  })
})

describe('what the page draws', () => {
  it('a person’s words are drawn as text, never as markup', () => {
    const plan = space.compose('demo', 'classic', { counts: { items: 1 } })
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: { items: [{ id: 'x', title: '<img src=x onerror=alert(1)><script>bad()</script>' }] } } }))
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
  it('a composition that throws draws a plain notice, and is tried again next time', () => {
    let calls = 0
    const flaky = { compose: () => { calls++; throw new ScreensError('invented fault') } } as unknown as ScreensSpace
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const compose = rememberedCompose('classic', () => flaky)
    const plan = compose('demo', {})
    expect(plan.parts.map((p) => p.block)).toEqual(['notice'])
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data: {} } }))).toContain('could not be drawn just now')
    compose('demo', {})
    expect(calls).toBe(2)
    errors.mockRestore()
  })
  it('the same facts are asked once', () => {
    let calls = 0
    const counting = { compose: (s: string, l: string, f: Parameters<ScreensSpace['compose']>[2]) => { calls++; return space.compose(s, l, f) } } as unknown as ScreensSpace
    const compose = rememberedCompose('classic', () => counting)
    compose('demo', { counts: { items: 2 } })
    compose('demo', { counts: { items: 2 } })
    compose('demo', { counts: { items: 0 } })
    expect(calls).toBe(2)
  })
})

describe('conditions and layout', () => {
  const src = `(Screen c "C")
(Part c 10 notice ((text "either")))
(When c 10 (any ((on a) (on b))))
(Part c 20 notice ((text "neither a")))
(When c 20 (none-of ((on a))))
(Part c 30 actions ((items ((action "One" one)))))
(Row c 30 tools)
(Part c 31 actions ((items ((action "Two" two)))))
(Row c 31 tools)
(Part c 40 notice ((text "aside")))
(Region c 40 aside)`
  const s = ScreensSpace.open([...SCREEN_SOURCES, ['c', src]])
  const shown = (flags: Record<string, boolean>) => s.compose('c', 'classic', { flags }).parts.map((p) => p.order)
  it('(any …) holds when one condition does, (none-of …) when none does', () => {
    expect(shown({})).toEqual([20, 30, 31, 40])
    expect(shown({ a: true })).toEqual([10, 30, 31, 40])
    expect(shown({ b: true })).toEqual([10, 20, 30, 31, 40])
  })
  it('parts sharing a row sit side by side; an aside part takes the side column', () => {
    const plan = s.compose('c', 'classic')
    expect(plan.parts.map((p) => [p.order, p.place.region, p.place.row])).toEqual([[20, 'main', null], [30, 'main', 'tools'], [31, 'main', 'tools'], [40, 'aside', null]])
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: {} } }))
    expect(html).toMatch(/data-screen-row="tools" class="flex[^"]*"><div data-screen-part="c\.30"[^]*data-screen-part="c\.31"/)
    expect(html).toMatch(/<aside[^>]*data-screen-region="aside"><div data-screen-part="c\.40"/)
  })
  it('a region other than main or aside, or an unknown condition, is refused by the guards', () => {
    const bad = ScreensSpace.open([...SCREEN_SOURCES, ['c', src + '\n(Region c 20 sidebar)']])
    expect(bad.guards().badRegions).toEqual(['(c 20 sidebar)'])
    const odd = ScreensSpace.open([...SCREEN_SOURCES, ['c', src + '\n(When c 40 (not (on a)))\n(When c 30 (hass x))']])
    expect(odd.guards().badConditions.sort()).toEqual(['(c 30)', '(c 40)'])
  })
})

describe('the Ask can explain a part', () => {
  it('says what a part is, in plain words, and what it needs to show, from the atoms that drew it', () => {
    const s = ScreensSpace.open()
    const why = s.explain('tools', 14)
    expect(why).toMatchObject({ declared: { kind: 'block', name: 'notice' }, role: 'message', words: 'a notice', region: 'main', row: null })
    expect(why?.conditions).toEqual(['(on tool.gone)'])
    expect(s.explain('tools', 30)).toMatchObject({ declared: { kind: 'role', name: 'collection' }, words: 'a list of things' })
    expect(s.explain('tools', 999)).toBeNull()
    // a shared resource piece: explained from the screen's Resource declaration, in plain words
    expect(s.explain('roles', 10)).toMatchObject({ declared: { kind: 'resource', name: 'waiting' }, role: 'absence', words: 'what shows while this page loads', conditions: ['(is resource loading)'] })
    expect(s.explain('roles', 17)).toMatchObject({ declared: { kind: 'resource', name: 'stale-retry' }, role: 'commands' })
    expect(s.explain('roles', 16)).toBeNull()   // stale-reason: Roles does not ask for it, so it is not there
    expect(s.guards().rolesWithoutWords).toEqual([])
  })
})

describe('R8 options', () => {
  const src = `(Screen opt "Options")
(Part opt 10 chooser ((label "Status") (value st) (action set-status) (waits st.saving) (options ((option active "Active") (option paused "Paused") (option done "Done")))))
(Part opt 20 buttons ((items ((button "My groups" toggle ((expanded groups.open)))))))
(Part opt 30 pills ((label "Kinds") (bind kinds) (multi yes) (action kind) (source kind.all)))
(Part opt 40 notice ((region_label "Filters") (text "side")))
(Region opt 40 aside)`
  const plan = ScreensSpace.open([...SCREEN_SOURCES, ['opt', src]]).compose('opt', 'classic')
  const html = (data: Record<string, unknown>) => renderToStaticMarkup(createElement(Screen, { plan, host: { data, onAction: () => {} } }))
  const data = { st: 'paused', 'groups.open': true, kinds: ['mind'], 'kind.all': [{ id: 'mind', label: 'Minds' }, { id: 'task', label: 'Tasks' }] }
  it('a chooser has one tab stop on the chosen option and the radio roles; a held one is disabled', () => {
    const h = html(data)
    expect(h.match(/role="radio"/g)).toHaveLength(3)
    expect(h).toMatch(/aria-checked="true" tabindex="0"[^>]*>Paused</)
    expect(h.match(/tabindex="-1"/g)).toHaveLength(2)
    expect(h).not.toContain('disabled=""')
    expect(html({ ...data, 'st.saving': true }).match(/disabled=""/g)).toHaveLength(3)   // saving: all three options wait
  })
  it('a button says whether what it opens is open; multi pills press each on and off; the side column is named', () => {
    const h = html(data)
    expect(h).toMatch(/aria-expanded="true"[^>]*>[^<]*(<[^>]*>)*My groups/)
    expect(h).toMatch(/aria-pressed="true"[^>]*><span[^>]*>Minds/)
    expect(h).toMatch(/aria-pressed="false"[^>]*><span[^>]*>Tasks/)
    expect(h).toContain('data-screen-region="aside" aria-label="Filters"')
  })
})

describe('a part that fills', () => {
  it('(fill yes) makes the screen a full-height column and lets that part take the rest of it', () => {
    const src = `(Screen fl "Fill")\n(Part fl 10 notice ((text "top")))\n(Part fl 20 island ((name studio) (fill yes)))`
    const plan = ScreensSpace.open([...SCREEN_SOURCES, ['fl', src]]).compose('fl', 'classic')
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: {}, islands: { studio: createElement('iframe', { title: 'studio' }) } } }))
    expect(html).toMatch(/class="[^"]*flex h-full min-h-0 flex-col[^"]*" data-screen="fl"/)
    expect(html).toMatch(/data-block="island"[^>]*class="flex min-h-0 flex-1 flex-col"/)
  })
})

describe('tour marks', () => {
  it('a part carrying (tour name) is marked for guided tours; Updates marks its holds again', () => {
    const src = `(Screen t "T")\n(Part t 10 notice ((tour first-step) (text "Start here")))`
    const plan = ScreensSpace.open([...SCREEN_SOURCES, ['t', src]]).compose('t', 'classic')
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data: {} } }))).toContain('data-tour="first-step"')
    const holds = ScreensSpace.open().compose('updates', 'classic', { flags: { 'updates.loaded': true } }).parts.find((p) => p.order === 10)
    expect(holds?.props.tour).toBe('update-holds')
  })
})

describe('the 3D stage', () => {
  it('lifts the parts MeTTa draws to their depth, keeps islands flat, and anchors the view at the top', () => {
    const src = `(Screen stage "Stage")\n(Part stage 10 header ((title "Hi")))\n(Part stage 20 island ((name panel)))`
    const plan = ScreensSpace.open([...SCREEN_SOURCES, ['stage', src]]).compose('stage', 'cosmos')
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: {}, islands: { panel: createElement('p', null, 'hand-built') } } }))
    expect(html).toContain('perspective-origin:50% 0')
    expect(html).toMatch(/data-block="header"[^>]*style="transform:translateZ\(\d+px\)/)
    expect(html).toMatch(/data-block="island"[^>]*>(?!.*translateZ)/)
    expect(html).not.toMatch(/data-block="island"[^>]*style=/)
  })
})

describe('blocks nothing draws yet', () => {
  it('each becomes one build task, however often the screen is drawn', () => {
    clearMissingBlocks()
    const compose = rememberedCompose('classic', () => space)
    compose('demo', { counts: { items: 1 } })
    compose('demo', { counts: { items: 0 } })
    expect(missingBlocks().map((m) => [m.screen, m.wanted, m.drawnAs])).toEqual([['demo', 'timeline', 'list']])
  })
})

describe('reporting missing blocks to the hive', () => {
  it('sends each block once, batched, with the screens release; a failed send is tried again later', async () => {
    vi.useFakeTimers()
    try {
      clearMissingBlocks()
      rememberedCompose('classic', () => space)('demo', { counts: { items: 1 } })
      const sent: unknown[][] = []
      let fail = true
      const send = async (items: unknown[]) => { sent.push(items); if (fail) throw new Error('invented outage') }
      reportMissing(send, 'scr-test', 10)
      reportMissing(send, 'scr-test', 10)          // one batch, not two
      await vi.advanceTimersByTimeAsync(20)
      expect(sent).toEqual([[{ ui_release: 'scr-test', screen: 'demo', wanted: 'timeline', drawn_as: 'list' }]])
      fail = false
      reportMissing(send, 'scr-test', 10)          // the failed one goes again
      await vi.advanceTimersByTimeAsync(20)
      reportMissing(send, 'scr-test', 10)          // and, once sent, never again this session
      await vi.advanceTimersByTimeAsync(20)
      expect(sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('the release name follows the screens: same sources, same name', () => {
    expect(screensRelease(SCREEN_SOURCES)).toBe(screensRelease(SCREEN_SOURCES))
    expect(screensRelease(SCREEN_SOURCES)).not.toBe(screensRelease([...SCREEN_SOURCES, ['x', '(Screen x "X")']]))
    expect(screensRelease(SCREEN_SOURCES)).toMatch(/^scr-[0-9a-f]{8}$/)
  })
})

describe('the rules point at real things', () => {
  it('every look a screen rule names is an experience this build has', () => {
    const real = new Set(['classic', ...ALL_EXPERIENCES.map((e) => e.id)])
    const named = ScreensSpace.open().looks()
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((l) => !real.has(l))).toEqual([])
  })
  it('every island a screen places is offered by its page (by name, in the page source)', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
    // one page per line, so pages added on different branches merge cleanly
    const PAGES: Record<string, string> = {
      health: 'features/health/HealthPage.tsx',
      settings: 'features/settings/SettingsPage.tsx',
      role: 'features/roles/RolesPage.tsx',
      models: 'features/models/ModelsPage.tsx',
      people: 'features/people/PeoplePage.tsx',
      updates: 'features/updates/UpdatesPage.tsx',
      tasks: 'features/tasks/TasksPage.tsx',
      motivations: 'features/tasks/MotivationsPage.tsx',
      'motivation-new': 'features/tasks/MotivationsPage.tsx',
      motivation: 'features/tasks/MotivationsPage.tsx',
      'motivation-about': 'features/tasks/MotivationsPage.tsx',
      swarms: 'features/swarm/SwarmsIndex.tsx',
      programs: 'features/programs/ProgramsIndex.tsx',
      program: 'features/programs/ProgramPage.tsx',
      'program-stage': 'features/programs/ProgramPage.tsx',
      'program-closed': 'features/programs/ProgramPage.tsx',
      profile: 'features/keys/ProfilePage.tsx',
      explore: 'features/explore/ExplorePage.tsx',
      flow: 'features/flow/FlowPage.tsx',
      setup: 'features/setup/SetupPage.tsx',
      mind: 'features/mind/PersonalMindPage.tsx',
      'mind-remembers': 'features/mind/PersonalMindPage.tsx',
      'plan-start': 'features/createPlan/PlanCanvas.tsx',
      plan: 'features/createPlan/PlanCanvas.tsx',
      'plan-ready': 'features/createPlan/PlanCanvas.tsx',
    }
    const placed = ScreensSpace.open().islands()
    expect(placed.length).toBeGreaterThan(0)
    for (const { screen, name } of placed) {
      const page = PAGES[screen]
      expect(page, `no page known for island screen ${screen}`).toBeTruthy()
      const source = fs.readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')
      expect(source.includes(`'${name}'`), `${page} offers no island named ${name}`).toBe(true)
    }
  })
  it('the Tools pages route there and back, with an id that needs encoding', () => {
    const id = 'sim tool/ü?&#'
    expect(parse(href({ name: 'tools', id }).slice(1))).toEqual({ name: 'tools', id })
    expect(parse(href({ name: 'tools' }).slice(1))).toEqual({ name: 'tools' })
  })
})

describe('the shared resource-state fragment', () => {
  // an invented screen: a heading, the fragment from order 10, and the content once ready
  const src = `(Screen shelf "Shelf")
(Part shelf 1 header ((title "Shelf")))
(Resource shelf 10 ((noun "jars") (unsupported "This pantry has no shelf yet.") (unsupported-icon ban)
  (forbidden "Only the cook can see the shelf.") (retry reload)))
(Part shelf 20 list ((source jars) (title title)))
(When shelf 20 (is resource ready))`
  const s = ScreensSpace.open([...SCREEN_SOURCES, ['shelf', src]])
  const at = (res: Parameters<typeof resourceFacts>[0]) => {
    const { data, facts } = resourceFacts(res)
    const plan = s.compose('shelf', 'classic', facts)
    return { plan, orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data: { ...data, jars: [{ id: 'j1', title: 'Quince jam' }] } } })) }
  }
  it('loading: the waiting part, named from the noun', () => {
    const { orders, html, plan } = at({ status: 'loading', error: undefined })
    expect(orders).toEqual([1, 10])
    expect(plan.parts[1]).toMatchObject({ block: 'waiting', how: { kind: 'direct' } })
    expect(html).toContain('aria-label="Loading jars"')
  })
  it('unsupported and forbidden: their own notices', () => {
    const un = at({ status: 'unsupported', error: undefined })
    expect(un.orders).toEqual([1, 11])
    expect(un.html).toContain('Not available here')
    expect(un.html).toContain('This pantry has no shelf yet.')
    const no = at({ status: 'error', error: new ApiError(403, 'forbidden', 'no') })
    expect(no.orders).toEqual([1, 12])
    expect(no.html).toContain('Admins only')
    expect(no.html).not.toContain('Try again')
  })
  it('failed: the error after the noun, and Try again', () => {
    const { orders, html } = at({ status: 'error', error: new Error('The invented pantry is locked.') })
    expect(orders).toEqual([1, 13, 14])
    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not load jars: The invented pantry is locked.')
    expect(html).toContain('>Try again</button>')
  })
  it('ready, and a failed refresh that keeps the last data with Retry', () => {
    expect(at({ status: 'ready', error: undefined }).orders).toEqual([1, 20])
    expect(at({ status: 'empty', error: undefined }).orders).toEqual([1, 20])
    const { orders, html } = at({ status: 'ready', error: new Error('No answer.') })
    expect(orders).toEqual([1, 15, 17, 20])
    expect(html).toContain('Could not refresh: No answer. Showing the last loaded data.')
    expect(html).toContain('>Retry</button>')
    expect(html).toContain('Quince jam')
  })
  it('only the pieces asked for are drawn; without a forbidden piece, forbidden shows the failure; texts and parts can be the page’s own', () => {
    const own = `(Screen jar "Jar")
(Resource jar 30 ((failed-title "Could not open the jar") (stale "Could not refresh the jar.") (stale-reason "Why")
  (part waiting notice ((tone info) (text "Opening the jar…")))))`
    const j = ScreensSpace.open([...SCREEN_SOURCES, ['jar', own]])
    expect(j.orders('jar')).toEqual([30, 33, 35, 36])
    const draw = (res: Parameters<typeof resourceFacts>[0]) => {
      const { data, facts } = resourceFacts(res)
      const plan = j.compose('jar', 'classic', facts)
      return { orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data } })) }
    }
    expect(draw({ status: 'loading', error: undefined }).html).toContain('Opening the jar…')
    expect(draw({ status: 'unsupported', error: undefined }).orders).toEqual([])
    const forbidden = draw({ status: 'error', error: new ApiError(403, 'forbidden', 'Cooks only') })
    expect(forbidden.orders).toEqual([33])
    expect(forbidden.html).toContain('Could not open the jar')
    expect(forbidden.html).toContain('Cooks only')
    const stale = draw({ status: 'ready', error: new Error('Lid stuck') })
    expect(stale.orders).toEqual([35, 36])
    expect(stale.html).toContain('Could not refresh the jar.')
    expect(stale.html).toMatch(/Reason<\/dt><dd[^>]*>Lid stuck/)
    expect(s.orders('shelf')).toEqual([1, 10, 11, 12, 13, 14, 15, 17, 20])
    expect(j.guards().badResources).toEqual([])
  })
  it('a declaration that cannot draw as declared is refused by the guards', () => {
    expect(s.guards().badResources).toEqual([])
    const bad = ScreensSpace.open([...SCREEN_SOURCES, ['shelf', src + `
(Part shelf 13 notice ((text "mine")))
(Resource ghost 10 ((noun "ghosts")))
(Resource shelf 40 ((waitng "Loading") (part sideways notice ((text "x")))))`]])
    expect(bad.guards().badResources.sort()).toEqual(['(ghost undeclared)', '(shelf ((waitng "Loading") (part sideways notice ((text "x")))))', '(shelf 13 clash)', '(shelf twice)'])
  })
})
