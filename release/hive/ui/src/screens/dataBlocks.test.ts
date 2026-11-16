// Purpose: tests of the blocks that draw figures and charts (figures, chart, bars, table) and of the layout props sticky and grow, on invented screens with real MeTTa. INVENTED DATA only.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ALL_EXPERIENCES } from '../experiences/registry'
import { Screen, type ScreenHost } from './Screen'
import { ScreensSpace, SCREEN_SOURCES, type ScreenFacts } from './screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const FIXTURE = `
(Screen orchard "Orchard")
(Part orchard 10 figures ((label "This season") (source orchard.figures)))
(Part orchard 20 chart ((title "Apples picked, by row") (subtitle "Per day") (chip (bind orchard.chip)) (chip_title "Counted by hand")
  (chip_aria "hand counted") (source orchard.days) (series orchard.rows) (axis orchard.axis) (label "Apples picked each day")))
(Part orchard 30 bars ((title "By tree") (source orchard.trees) (legend orchard.kinds) (empty "No trees yet.")))
(Part orchard 40 table ((caption "Trees") (source orchard.table) (columns ((column name (bind orchard.noun) ())
  (column picked "Picked" ((align end) (tone quiet))) (column spoiled "Spoiled" ((align end) (phone hide)))
  (column share "Share" ((align end) (tone faint) (mark flag) (mark_title flag_title)))))))
(Screen gate "Gate")
(Part gate 10 segmented ((label "Season") (bind season) (sticky yes) (options ((option "spring" "Spring") (option "fall" "Fall")))))
(Part gate 11 switcher ((label "Show as") (bind view) (options ((option chart "Chart" chart) (option table "Table" table)))))
(Row gate 10 filters)
(Row gate 11 filters)
(Part gate 20 note ((text "Picked by hand") (sticky yes)))
(Part gate 30 bars ((source a) (grow yes)))
(Part gate 31 bars ((source b) (grow yes)))
(Row gate 30 halves)
(Row gate 31 halves)
(Screen gauge "Gauge")
(RolePart gauge 10 measure ((source gauge.parts)))
(Screen yard "Yard")
(Part yard 10 entries ((source yard.old) (title change) (action action) (aria aria) (open remove)))
`
const space = ScreensSpace.open([...SCREEN_SOURCES, ['orchard', FIXTURE]])
const draw = (screen: string, host: ScreenHost, facts: ScreenFacts = {}) => renderToStaticMarkup(createElement(Screen, { plan: space.compose(screen, 'classic', facts), host }))

const DATA = {
  'orchard.figures': [
    { id: 'picked', label: 'Picked · this week', value: '1,240', hero: true, chip: 'est', chip_title: 'Counted by hand', chip_aria: 'hand counted',
      note: 'includes 40 windfalls', note_title: 'Fallen apples count too', delta: '12%', delta_dir: 'up', delta_tone: 'bad', delta_note: 'vs previous' },
    { id: 'trees', label: 'Trees', value: '18', delta: '5%', delta_dir: 'down', delta_tone: 'good', delta_note: 'vs previous' },
    { id: 'avg', label: 'Per tree', value: '69' },
  ],
  'orchard.chip': 'hand',
  'orchard.days': [
    { id: 'd1', x: 'Mon', at: 'Monday', total: 30, total_words: '30 apples', aria: 'Mon: 30 apples', parts: [{ key: 'north', n: 10, words: '10' }, { key: 'south', n: 20, words: '20' }] },
    { id: 'd2', x: 'Tue', at: 'Tuesday', total: 0, total_words: '0 apples', aria: 'Tue: 0 apples', parts: [] },
  ],
  'orchard.rows': [{ key: 'north', label: 'North row', color: '#3987e5' }, { key: 'south', label: 'South row', color: '#d95926' }],
  'orchard.axis': { max: 40, ticks: [{ n: 0, words: '0' }, { n: 20, words: '20' }, { n: 40, words: '40' }] },
  'orchard.trees': [
    { id: 't1', label: 'Old pippin', value: '80', orb: 120, aria: 'Old pippin: 80', parts: [{ key: 'ripe', n: 60, color: '#199e70' }, { key: 'green', n: 20, color: '#c98500' }] },
    { id: 't2', label: 'Young russet', value: '40', detail: '2 ladders', parts: [{ key: 'ripe', n: 40, color: '#199e70' }] },
  ],
  'orchard.kinds': [{ key: 'ripe', label: 'Ripe', color: '#199e70' }, { key: 'green', label: 'Green', color: '#c98500' }],
  'orchard.noun': 'Tree',
  'orchard.table': [
    { id: 't1', name: 'Old pippin', picked: '80', spoiled: '3', share: '66.7%', flag: 'windfall', flag_title: 'Some fell' },
    { id: 't2', name: 'Young russet', picked: '40', spoiled: '0', share: '33.3%' },
  ],
}

describe('the blocks that draw figures and charts (real MeTTa)', () => {
  it('MeTTa knows each by its role and draws it as named; measure still defaults to progress in every look', () => {
    const plan = space.compose('orchard', 'classic')
    expect(plan.parts.map((p) => [p.order, p.block, p.how.kind])).toEqual([[10, 'figures', 'direct'], [20, 'chart', 'direct'], [30, 'bars', 'direct'], [40, 'table', 'direct']])
    expect(plan.missing).toEqual([])
    expect(space.blocks()).toEqual(expect.arrayContaining(['bars', 'chart', 'figures', 'table']))
    expect(Object.values(space.guards()).flat()).toEqual([])
    for (const look of ALL_EXPERIENCES.map((x) => x.id)) expect(space.compose('gauge', look).parts.map((p) => p.block)).toEqual(['progress'])
  })

  it('figures: each tile its label, value, chip, note and change, the first large', () => {
    const html = draw('orchard', { data: DATA })
    expect(html).toContain('aria-label="This season"')
    expect(html).toMatch(/col-span-3[^"]*md:col-span-1/)
    expect(html).toContain('>1,240</div>')
    expect(html).toContain('title="Counted by hand" aria-label="hand counted"')
    expect(html).toMatch(/title="Fallen apples count too"[^>]*>includes 40 windfalls/)
    expect(html).toMatch(/text-bad"><svg[^]*?-rotate-90[^]*?<\/svg> 12%/)
    expect(html).toMatch(/text-good"><svg[^]*? rotate-90[^]*?<\/svg> 5%/)
    expect(html.match(/vs previous/g)).toHaveLength(2)
  })

  it('chart: the caption, the legend, a stack per column scaled to the axis, its ticks, labels and focusable bands', () => {
    const html = draw('orchard', { data: DATA })
    expect(html).toMatch(/<figcaption[^]*Apples picked, by row[^]*aria-label="hand counted"[^]*Per day[^]*<\/figcaption>/)
    expect(html).toContain('North row')
    expect(html).toContain('South row')
    expect(html).toContain('role="img" aria-label="Apples picked each day"')
    // two parts for Monday, none for the empty Tuesday: the north part at the bottom, square, the south on top, rounded
    expect(html.match(/<path [^>]*fill="#3987e5"/g)).toHaveLength(1)
    expect(html.match(/<path [^>]*fill="#d95926"/g)).toHaveLength(1)
    for (const words of ['>0</text>', '>20</text>', '>40</text>', '>Mon</text>', '>Tue</text>']) expect(html).toContain(words)
    expect(html).toContain('aria-label="Mon: 30 apples"')
    expect(html).toContain('aria-label="Tue: 0 apples"')
  })

  it('bars: rows scaled to the largest, parts side by side, an orb, the legend; no rows says so', () => {
    const html = draw('orchard', { data: DATA })
    expect(html).toContain('aria-label="Old pippin: 80"')
    expect(html).toContain('width:75%')       // 60 of the largest row's 80
    expect(html).toContain('width:25%')
    expect(html).toContain('width:50%')       // 40 of 80
    expect(html).toContain('>Young russet</span>')
    expect(html).toContain('tabindex="0"')     // the row with a detail line can take focus to show it
    expect(html).toContain('>Ripe</li>')
    const empty = draw('orchard', { data: { ...DATA, 'orchard.trees': [] } })
    expect(empty).toContain('No trees yet.')
  })

  it('table: its caption for assistive technology, headers (one bound), alignment, softer cells, a column kept off a phone, a cell mark', () => {
    const html = draw('orchard', { data: DATA })
    expect(html).toContain('<caption class="sr-only">Trees</caption>')
    expect(html).toMatch(/<th scope="col" class="px-4 py-3 font-medium">Tree<\/th>/)
    expect(html).toMatch(/<th scope="col" class="px-4 py-3 font-medium text-right hidden sm:table-cell">Spoiled<\/th>/)
    expect(html).toMatch(/<td class="px-4 py-2.5 text-right text-ink-2">80<\/td>/)
    expect(html).toMatch(/<td class="px-4 py-2.5 text-right text-ink-3">66.7%<span [^>]*title="Some fell">windfall<\/span><\/td>/)
    expect(html).toMatch(/<td class="px-4 py-2.5 text-right text-ink-3">33.3%<\/td>/)
  })
})

describe('entries', () => {
  it('a row’s button takes its accessible name from the row when the screen names a field for it', () => {
    const html = draw('yard', { data: { 'yard.old': [{ id: 'o1', change: 'Nori: $10.00 lifetime cap', action: 'Remove', aria: 'Remove the old default on Nori' }, { id: 'o2', change: 'Wisp', action: 'Remove' }] }, onOpen: () => undefined })
    expect(html).toMatch(/<button[^>]*aria-label="Remove the old default on Nori"[^>]*>Remove<\/button>/)
    expect(html.match(/aria-label=/g)).toHaveLength(2)    // the list's own name and Nori's button; Wisp's button has none
  })
})

describe('islands', () => {
  it('an island the page offers that draws nothing leaves an empty wrapper, which the stylesheet gives no room', async () => {
    const porch = ScreensSpace.open([...SCREEN_SOURCES, ['porch', `(Screen porch "Porch")
(Part porch 10 island ((name plans)))
(Part porch 20 note ((text "after")))`]])
    const html = renderToStaticMarkup(createElement(Screen, { plan: porch.compose('porch', 'classic'), host: { data: {}, islands: { plans: null } } }))
    expect(html).toMatch(/<div data-screen-part="porch.10" data-block="island"[^>]*><\/div>/)
    // node's file system, the repo's way (no Node types in the app's tsconfig): vitest gives a CSS import no text
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
    const css = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\n\[data-block='island'\]:empty \{\s*display: none;\s*\}/)   // unlayered, at the top level
  })
})

describe('layout props', () => {
  it('(sticky yes) keeps a part, or the row it shares, at the top; (grow yes) shares a row’s width', () => {
    const html = draw('gate', { data: { season: 'spring', view: 'chart', a: [], b: [] } })
    expect(html).toMatch(/<div data-screen-row="filters" class="flex flex-wrap items-start gap-2 sticky top-0 [^"]*">/)
    expect(html).toMatch(/<div class="sticky top-0 [^"]*"><div data-screen-part="gate.20"/)
    expect(html).toMatch(/data-screen-row="halves" class="flex flex-wrap items-start gap-2">/)
    expect(html.match(/data-screen-part="gate.3[01]"[^>]*class="[^"]*min-w-\[min\(100%,20rem\)\] flex-1/g)).toHaveLength(2)
    // in a 3D look a sticky row's parts take their depth like the rest: each is drawn about its own centre, so none moves
    // as the page scrolls under the row
    const deep = renderToStaticMarkup(createElement(Screen, { plan: space.compose('gate', 'cosmos'), host: { data: { season: 'spring', view: 'chart', a: [], b: [] } } }))
    expect(deep).toMatch(/data-screen-row="filters" class="[^"]*sticky top-0[^"]*"><div data-screen-part="gate.10"[^>]*style="transform:perspective\(1400px\) translateZ\(36px\)"/)
    expect(deep).toMatch(/data-screen-part="gate.30"[^>]*style="transform:perspective\(1400px\) translateZ\(18px\)"/)
  })
})
