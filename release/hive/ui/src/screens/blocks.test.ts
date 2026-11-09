import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Screen, scopedHost, type ScreenHost, type ScreenItem } from './Screen'
import { ScreensSpace, SCREEN_SOURCES, type ScreenFacts } from './screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The blocks for islands, tallies, choices, stacks, lines, disclosures, code, key fields and orbs, on invented screens. */
const FIXTURE = `
(Screen garden "Garden")
(Part garden 10 island ((name weather)))
(Part garden 20 tally ((label "Beds") (items ((item (bind beds.ok) "growing" good) (item (bind beds.dry) "dry" warn)))))
(Part garden 30 segmented ((label "Which beds") (bind which) (options ((option dry "Dry ones") (option all "All beds")))))
(Part garden 40 stack ((source beds) (frame card) (label "Beds")))
(When garden 40 (has beds))

(Screen bed "A bed")
(Part bed 10 line ((title (bind bed.name)) (meta (bind bed.note)) (open bed) (badge "Dry") (tone warn)))
(Part bed 20 disclosure ((badge "tip") (tone info) (title "Water at dusk") (meta "twice a week") (note "from last spring")
  (quiet yes) (expanded bed.open) (action toggle-tip)))
(Part bed 30 code ((label "Log") (text (bind bed.log))))
(When bed 30 (on bed.open))

(Screen shed "The shed")
(Part shed 10 keyfield ((label "Shed padlock code") (placeholder "four digits") (submit "Unlock") (waiting "Trying…")
  (busy shed.trying) (focus shed.here) (action unlock) (cancel "Not now") (cancel_action leave)
  (help "The code is on the tag.") (link (bind shed.link)) (link_label "Open")))
(Part shed 20 orbs ((source shed.helpers) (open helper) (most 2) (aria "{name}, see their jobs") (label "Helpers")))
(Screen barn "Barn")
(Part barn 10 buttons ((items ((button "Lock…" lock ((aria "Lock {shed.name}") (icon pause) (variant ghost)))
  (button "Open" open-shed ((variant primary))) (button (bind shed.third) sweep ())))))
(Screen cellar "Cellar")
(Part cellar 10 island ((name press) (hidden-when (cellar.dark cellar.flooded))))
(Part cellar 20 tabs ((label "Shelves") (bind shelf) (source cellar.shelves)))
(Screen porch "Porch")
(Part porch 10 paragraph ((tour (bind porch.tour)) (text (bind porch.words))))
(Part porch 20 note ((tour porch-note) (text "Small print")))
(Screen loft "The loft")
(Part loft 10 fields ((columns two) (items ((field select "Crate" loft.crate ((source loft.crates) (prompt "Pick one") (waits loft.locked)))
  (field number (words "Jars (at most " (bind loft.most) ")") loft.jars ((least 1) (most (bind loft.most))))
  (field text "Label for the crate" loft.label ((placeholder (words "What " (bind loft.who) " stores")) (quiet yes)))
  (field checks "Shelves it goes on" loft.shelves ((action shelve)))))))
(Screen harvest "Harvest")
(Part harvest 10 progress ((source harvest.parts) (text (bind harvest.words)) (partial harvest.partial)))
`
const space = ScreensSpace.open([...SCREEN_SOURCES, ['garden', FIXTURE]])
const compose = (screen: string, facts: ScreenFacts = {}) => space.compose(screen, 'classic', facts)
const draw = (screen: string, facts: ScreenFacts, host: ScreenHost) => renderToStaticMarkup(createElement(Screen, { plan: compose(screen, facts), host }))

describe('the composing blocks (real MeTTa)', () => {
  it('MeTTa knows every new block by its role, and the guards stay clean', () => {
    const p = compose('garden', { counts: { beds: 1 } })
    expect(p.parts.map((x) => x.block)).toEqual(['island', 'tally', 'segmented', 'stack'])
    expect(p.missing).toEqual([])
    expect(Object.values(space.guards()).flat()).toEqual([])
  })
  it('an island draws what the page offers under its name, and nothing for a name it does not offer', () => {
    const offered = draw('garden', {}, { data: {}, islands: { weather: createElement('p', null, 'Rain by noon') } })
    expect(offered).toContain('Rain by noon')
    const absent = draw('garden', {}, { data: {}, islands: { other: createElement('p', null, 'Elsewhere') } })
    expect(absent).not.toContain('Elsewhere')
    expect(absent).not.toContain('data-block="island"')   // no empty, spaced wrapper left behind
  })
  it('a tally draws each count with its word, in its tone; a segmented choice marks the bound option', () => {
    const html = draw('garden', {}, { data: { 'beds.ok': 4, 'beds.dry': 1, which: 'all' } })
    expect(html).toContain('aria-label="Beds"')
    expect(html).toMatch(/text-good[^>]*>4 growing</)
    expect(html).toMatch(/text-warn[^>]*>1 dry</)
    expect(html).toContain('aria-label="Which beds"')
    expect(html).toMatch(/aria-checked="true"(?:(?!<\/button>).)*>All beds</)
  })
  it('a stack draws each item as its own composed screen, with its own values', () => {
    const closed = { id: 'b1', plan: compose('bed', { flags: { 'bed.open': false } }), data: { 'bed.name': 'Herbs', 'bed.note': 'by the gate', 'bed.open': false, 'bed.log': 'watered' } }
    const opened = { id: 'b2', plan: compose('bed', { flags: { 'bed.open': true } }), data: { 'bed.name': 'Beans', 'bed.note': '', 'bed.open': true, 'bed.log': 'picked\n→ a basket' } }
    const html = draw('garden', { counts: { beds: 2 } }, { data: { beds: [closed, opened] }, onOpen: () => {}, onAction: () => {} })
    expect(html).toContain('data-screen="bed"')
    expect(html).toMatch(/<button[^>]*>Herbs<\/button>/)
    expect(html).toContain('by the gate')
    expect(html).toContain('Dry')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('twice a week · from last spring')
    expect(html).toContain('opacity-55')
    expect(html).toContain('<pre aria-label="Log"')
    expect(html).toContain('picked\n→ a basket')
    expect(html).not.toContain('watered')
  })
  it('a key field is hidden, waits while busy, takes focus when asked, and links out only to https', () => {
    const p = compose('shed')
    expect(p.parts.map((x) => [x.block, x.depth.layer])).toEqual([['keyfield', 'raised'], ['orbs', 'surface']])
    const calm = draw('shed', {}, { data: { 'shed.link': 'https://example.org/tags', 'shed.helpers': [] }, onAction: () => {} })
    expect(calm).toContain('type="password"')
    expect(calm).toContain('aria-label="Shed padlock code"')
    expect(calm).toContain('placeholder="four digits"')
    expect(calm).toMatch(/type="submit" disabled=""><svg[^>]*>.*?<\/svg>Unlock<\/button>/)
    expect(calm).toContain('Not now</button>')
    expect(calm).toContain('The code is on the tag.')
    expect(calm).toContain('href="https://example.org/tags"')
    expect(calm).not.toContain('data-autofocus')
    const busy = draw('shed', {}, { data: { 'shed.trying': true, 'shed.here': true, 'shed.link': 'javascript:alert(1)', 'shed.helpers': [] } })
    expect(busy).toContain('Trying…')
    expect(busy).toContain('data-autofocus=""')
    expect(busy).not.toContain('href=')
  })
  it('orbs draw each mind up to the most, then how many more; each opens with its own name', () => {
    const helpers = [{ id: 'h1', name: 'Wren', hue: 30, status: 'awake' }, { id: 'h2', name: 'Moss', hue: 140, status: 'asleep' }, { id: 'h3', name: 'Fern', hue: 200 }]
    const html = draw('shed', {}, { data: { 'shed.helpers': helpers }, onOpen: () => {} })
    expect(html).toContain('aria-label="Helpers"')
    expect(html).toMatch(/<button[^>]*aria-label="Wren, see their jobs"/)
    expect(html).toContain('aria-label="Moss, see their jobs"')
    expect(html).not.toContain('Fern')
    expect(html).toContain('+1')
    // with no way to open, each orb is a named picture, not a button
    expect(draw('shed', {}, { data: { 'shed.helpers': helpers } })).toMatch(/<span role="img"[^>]*aria-label="Wren, see their jobs"/)
  })
  it('a line without a way to open draws its name as text', () => {
    const item = { id: 'b1', plan: compose('bed'), data: { 'bed.name': 'Herbs' } }
    expect(draw('garden', { counts: { beds: 1 } }, { data: { beds: [item] } })).not.toMatch(/<button[^>]*>Herbs/)
  })
  it("a press inside a stack comes back with the item's id first in scope, through every level", () => {
    const got: [string, ScreenItem][] = []
    const page: ScreenHost = { data: { who: 'page' }, onAction: (a, it) => got.push([a, it]), onOpen: (t, it) => got.push([t, it]) }
    const outer = scopedHost(page, { id: 'bed-1', data: { 'bed.name': 'Herbs' } })
    const inner = scopedHost(outer, { id: 'tip-2' })
    inner.onAction!('toggle-tip', {})
    outer.onOpen!('bed', {})
    expect(got).toEqual([['toggle-tip', { scope: ['bed-1', 'tip-2'] }], ['bed', { scope: ['bed-1'] }]])
    expect(outer.data).toEqual({ who: 'page', 'bed.name': 'Herbs' })
    expect(scopedHost({ data: {} }, { id: 'x' }).onAction).toBeUndefined()
  })
  it('fields: labelled selects, numbers, text and tick boxes, each showing its bound value; waits holds a field', () => {
    const p = compose('loft')
    expect(p.parts.map((x) => [x.block, x.how.kind, x.depth.layer])).toEqual([['fields', 'direct', 'surface']])
    expect(space.explain('loft', 10)).toMatchObject({ role: 'form', words: 'fields to fill in' })
    const data = { 'loft.crate': 'c2', 'loft.crates': [{ id: 'c1', label: 'Apples' }, { id: 'c2', label: 'Pears' }], 'loft.most': 12, 'loft.jars': '4',
      'loft.label': '', 'loft.who': 'Wren', 'loft.shelves': [{ id: 's1', label: 'Top', on: true }, { id: 's2', label: 'Low', on: false }], 'loft.locked': false }
    const html = draw('loft', {}, { data, onInput: () => {}, onAction: () => {} })
    expect(html).toContain('class="grid gap-3 sm:grid-cols-2"')
    expect(html).toMatch(/<label[^>]*>Crate<select[^>]*>/)
    expect(html).toContain('<option value="">Pick one</option>')
    expect(html).toMatch(/<option value="c2" selected="">Pears<\/option>/)
    expect(html).toMatch(/<label[^>]*>Jars \(at most 12\)<input type="number" min="1" max="12"[^>]*value="4"/)
    expect(html).toMatch(/<span class="sr-only">Label for the crate<\/span><input type="text"[^>]*placeholder="What Wren stores"/)
    expect(html).toContain('<legend class="text-[12.5px] text-ink-3">Shelves it goes on</legend>')
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Top<\/label>/)
    expect(html).toMatch(/<input type="checkbox"\/>Low<\/label>/)
    expect(html).not.toContain('disabled=""')
    expect(draw('loft', {}, { data: { ...data, 'loft.locked': true } })).toMatch(/<select[^>]*disabled=""/)
  })
  it('buttons: each with its own accessible name, weight and icon; busy holds them all', () => {
    const host: ScreenHost = { data: { 'shed.name': 'the blue shed', 'shed.third': 'Sweep' }, onAction: () => {} }
    const plan = compose('barn')
    expect(plan.parts.map((x) => [x.block, x.how.kind])).toEqual([['buttons', 'direct']])
    const html = renderToStaticMarkup(createElement(Screen, { plan, host }))
    expect(html).toMatch(/<button[^>]*aria-label="Lock the blue shed"[^>]*>.*Lock…<\/button>/)
    expect(html).toMatch(/<button[^>]*style="background[^>]*>Open<\/button>/)   // the primary fill
    expect(html).toMatch(/>Sweep<\/button>/)
    expect(html).not.toContain('disabled=""')
    expect(html.match(/<svg/g)).toHaveLength(1)   // only Lock has an icon
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { ...host, busy: true } })).match(/disabled=""/g)).toHaveLength(3)
    expect(plan.parts[0].props.items).toEqual([
      ['button', 'Lock…', 'lock', [['aria', 'Lock {shed.name}'], ['icon', 'pause'], ['variant', 'ghost']]],
      ['button', 'Open', 'open-shed', [['variant', 'primary']]],
      ['button', { bind: 'shed.third' }, 'sweep', []],
    ])
  })
  it('progress: a bar of the parts of a whole, each as wide as its count, named by its counts; the words under it', () => {
    const plan = compose('harvest')
    expect(plan.parts.map((x) => [x.block, x.how.kind, x.depth.layer])).toEqual([['progress', 'direct', 'surface']])
    const parts = [{ n: 3, label: 'picked', color: '#4ade80' }, { n: 0, label: 'bruised', color: '#fb7185' }, { n: 1, label: 'left', color: '#a5b4fc' }]
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: { 'harvest.parts': parts, 'harvest.words': '3 of 4 apples picked', 'harvest.partial': false } } }))
    expect(html).toContain('role="img" aria-label="3 picked, 1 left"')
    expect(html).toContain('width:75%;background:#4ade80')
    expect(html).toContain('width:25%;background:#a5b4fc')
    expect(html).not.toContain('#fb7185')
    expect(html).toMatch(/<p class="[^"]*">3 of 4 apples picked<\/p>/)
    const partial = renderToStaticMarkup(createElement(Screen, { plan, host: { data: { 'harvest.parts': [], 'harvest.words': 'none yet', 'harvest.partial': true } } }))
    expect(partial).toContain('aria-label=""')
    expect(partial).toContain('data-partial="true">none yet')
    expect(space.explain('harvest', 10)?.words).toBe('a bar showing how far along it is')
  })
  it('a paragraph draws plain words as body text; a tour name may be bound, so each item can carry its own', () => {
    const plan = compose('porch')
    expect(plan.parts.map((x) => [x.block, x.how.kind, x.depth.layer])).toEqual([['paragraph', 'direct', 'surface'], ['note', 'direct', 'raised']])
    const html = renderToStaticMarkup(createElement(Screen, { plan, host: { data: { 'porch.tour': 'porch-swing', 'porch.words': 'The swing creaks <loudly>.' } } }))
    expect(html).toMatch(/data-tour="porch-swing"[^>]*><p class="[^"]*text-ink-2[^"]*">The swing creaks &lt;loudly&gt;\.<\/p>/)
    expect(html).toContain('data-tour="porch-note"')
    // a bound tour with no value leaves no attribute behind
    expect(renderToStaticMarkup(createElement(Screen, { plan, host: { data: {} } })).match(/data-tour=/g)).toHaveLength(1)
    expect(space.explain('porch', 10)?.words).toBe('a paragraph of words')
  })
  it('a part with hidden-when stays drawn but hidden while any of its flags is true; tabs show a count only when the item has one', () => {
    const plan = compose('cellar')
    const draw = (data: Record<string, unknown>) => renderToStaticMarkup(createElement(Screen, { plan, host: { data: { 'cellar.shelves': [{ id: 'jam', label: 'Jam' }, { id: 'cider', label: 'Cider', count: 0 }], ...data }, islands: { press: createElement('i', null, 'apple press') } } }))
    expect(draw({})).toMatch(/data-screen-part="cellar.10"[^>]*><i>apple press<\/i>/)
    expect(draw({})).not.toMatch(/data-screen-part="cellar.10"[^>]*hidden/)
    expect(draw({ 'cellar.flooded': true })).toMatch(/data-screen-part="cellar.10"[^>]*hidden=""[^>]*><i>apple press<\/i>/)
    expect(draw({ 'cellar.dark': 'yes' })).not.toMatch(/hidden/)   // a flag is true only when it is true
    const html = draw({})
    expect(html.match(/font-mono/g)).toHaveLength(1)   // Cider's 0; Jam carries no count
    expect(html).toMatch(/>Cider<\/span><span[^>]*font-mono[^>]*>0</)
  })
})
