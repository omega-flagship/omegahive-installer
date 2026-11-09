import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../api/types'
import { simToolsCatalogue } from '../../api/sim/simTools'
import { Screen } from '../../screens/Screen'
import { DRAWN_BLOCKS } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { matches, toolScreen, toolsScreen, withTool, type Loaded } from './data'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** The Tools screens end to end: invented catalogue → facts → MeTTa composes → the renderer draws. */
const space = ScreensSpace.open()
const catalogue = simToolsCatalogue()
const draw = (screen: 'tools' | 'tool', look: string, d: { data: Record<string, unknown>; facts: Parameters<ScreensSpace['compose']>[2] }) =>
  renderToStaticMarkup(createElement(Screen, { plan: space.compose(screen, look, d.facts), host: { data: d.data, framed: true } }))
const mind = (id: string, name: string, tools: string[] = []) => ({ id, name, options: { tools } }) as unknown as Agent

describe('the Tools page, composed by MeTTa', () => {
  it('lists every tool, sorted, and narrows by every word of the search', () => {
    const html = draw('tools', 'classic', toolsScreen({ state: 'ready', catalogue }, ''))
    expect(html.indexOf('Explain it simply')).toBeLessThan(html.indexOf('Weigh the evidence'))
    expect(html).toContain('data-block="list"')
    const narrowed = draw('tools', 'classic', toolsScreen({ state: 'ready', catalogue }, 'memory lab'))
    expect(narrowed).toContain('Weigh the evidence')
    expect(narrowed).not.toContain('Find contradictions')   // reads memory, but made by Example Works
  })
  it('a search with no match says so; a hive without the catalogue says so; nothing invents tools', () => {
    expect(draw('tools', 'classic', toolsScreen({ state: 'ready', catalogue }, 'zzz'))).toContain('No tool matches')
    const none = draw('tools', 'classic', toolsScreen({ state: 'unsupported' }, ''))
    expect(none).toContain('offer a tools catalogue yet')
    expect(none).not.toContain('No tools yet')
  })
  it('Cosmos draws the same atoms as cards on a 3D stage', () => {
    const html = draw('tools', 'cosmos', toolsScreen({ state: 'ready', catalogue }, ''))
    expect(html).toContain('data-block="cards"')
    expect(html).toContain('data-space="3d"')
  })
  it("one tool's page: what it may do, who made it, and a switch per mind that names both", () => {
    const tool = catalogue.items[0]
    const html = draw('tool', 'classic', toolScreen(tool, [mind('a2', 'Wren', [tool.id]), mind('a1', 'Ada')]))
    expect(html).toContain('reads memory')
    expect(html).toContain('Invented Lab')
    expect(html).toContain('aria-label="Let Ada use Weigh the evidence"')
    expect(html.indexOf('Ada')).toBeLessThan(html.indexOf('Wren'))
  })
  it('a tool that cannot be turned on shows why, with no switches', () => {
    const tool = catalogue.items.find((t) => !t.activatable)!
    const html = draw('tool', 'classic', toolScreen(tool, [mind('a1', 'Ada')]))
    expect(html).toContain('be turned on in this hive yet')
    expect(html).not.toContain('role="switch"')
  })
  it("turning a tool on or off keeps the mind's other tools", () => {
    expect(withTool(mind('a', 'A', ['x']), 'y', true)).toEqual(['x', 'y'])
    expect(withTool(mind('a', 'A', ['x', 'y']), 'x', false)).toEqual(['y'])
    expect(matches(catalogue.items[0], 'SUGGESTS beliefs')).toBe(true)
  })
  it('every block MeTTa can choose, the renderer draws', () => {
    const blocks = ScreensSpace.open().blocks()
    expect(DRAWN_BLOCKS).toEqual([...blocks].sort())
  })
})

describe('every part of the Tools screens can be reached', () => {
  const orders = (screen: 'tools' | 'tool', d: { facts: Parameters<ScreensSpace['compose']>[2] }) => space.compose(screen, 'classic', d.facts).parts.map((p) => p.order)
  const ready: Loaded = { state: 'ready', catalogue }
  // each screen's own parts and the orders its resource declaration takes
  const declared = (screen: string) => space.orders(screen)

  it('the list: loading, a failed load, a tool no longer here, no catalogue, offline, empty, no match, and the list', () => {
    const seen = new Set<number>()
    const see = (o: number[]) => { o.forEach((x) => seen.add(x)); return o }
    expect(see(orders('tools', toolsScreen({ state: 'loading' }, '')))).toEqual([10, 12])
    expect(see(orders('tools', toolsScreen({ state: 'error', message: 'invented outage' }, '')))).toEqual([10, 15])
    expect(see(orders('tools', toolsScreen(ready, '', true)))).toEqual([10, 14, 20, 30])
    expect(see(orders('tools', toolsScreen({ state: 'unsupported' }, '')))).toEqual([10, 13])
    expect(see(orders('tools', toolsScreen({ state: 'ready', catalogue: { ...catalogue, offline_candidate: true } }, '')))).toEqual([10, 16, 20, 30])
    expect(see(orders('tools', toolsScreen({ state: 'ready', catalogue: { offline_candidate: false, items: [] } }, '')))).toEqual([10, 32])
    expect(see(orders('tools', toolsScreen(ready, 'nothing like this')))).toEqual([10, 20, 31])
    expect([...seen].sort((a, b) => a - b)).toEqual(declared('tools'))
    expect(declared('tools')).toEqual([10, 12, 13, 14, 15, 16, 20, 30, 31, 32])
  })
  it('the words of the list’s own states', () => {
    expect(draw('tools', 'classic', toolsScreen({ state: 'loading' }, ''))).toContain('aria-label="Loading the tools"')
    expect(draw('tools', 'classic', toolsScreen({ state: 'error', message: 'invented outage' }, ''))).toContain('Could not load the tools: invented outage')
    expect(draw('tools', 'classic', toolsScreen(ready, '', true))).toContain('That tool isn')
    expect(draw('tools', 'classic', toolsScreen({ state: 'unsupported' }, ''))).toContain('offer a tools catalogue yet')
  })
  it("one tool: a failed switch, what it may do, its minds, none yet, or why it can't be turned on", () => {
    const seen = new Set<number>()
    const see = (o: number[]) => { o.forEach((x) => seen.add(x)); return o }
    const [on, off] = [catalogue.items[0], catalogue.items.find((t) => !t.activatable)!]
    const ada = [mind('a1', 'Ada')]
    expect(see(orders('tool', toolScreen(on, ada)))).toEqual([10, 20, 30, 40, 41])
    expect(see(orders('tool', toolScreen(on, ada, 'invented refusal')))).toEqual([10, 15, 20, 30, 40, 41])
    expect(see(orders('tool', toolScreen(on, [])))).toEqual([10, 20, 30, 40, 42])
    expect(see(orders('tool', toolScreen(off, ada)))).toEqual([10, 30, 40, 43])
    expect([...seen].sort((a, b) => a - b)).toEqual(declared('tool'))
    expect(draw('tool', 'classic', toolScreen(on, ada, 'invented refusal'))).toContain('invented refusal')
  })
})
