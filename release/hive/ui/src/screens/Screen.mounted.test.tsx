// @vitest-environment node
// Purpose: composed screens mounted: a search narrowing what MeTTa composed, a switch's press back to the page, an
// input's scope inside a stack item, and an island MeTTa moves to another part kept mounted with the mark's press.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useMemo, useState } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../ui/miniDom.testkit'
import { simToolsCatalogue } from '../api/sim/simTools'
import { toolScreen, toolsScreen } from '../features/tools/data'
import type { Agent } from '../api/types'
import { InlineParts, Screen, type ScreenHost, type ScreenItem } from './Screen'
import type { ScreenPlan } from './screenSpace'
import { useCompose } from './useCompose'

vi.setConfig({ testTimeout: 20_000 })

/**
 * A composed screen, mounted: a person types into the search MeTTa placed and the list it composed narrows; a switch
 * hands its press back to the page. The harness plays the page: it states facts, composes, and keeps the state.
 */
const catalogue = simToolsCatalogue()
const onToggle = vi.fn()
function ToolsHarness({ look }: { look: string }) {
  const compose = useCompose(look)
  const [query, setQuery] = useState('')
  const { plan, data } = useMemo(() => {
    const { data, facts } = toolsScreen({ state: 'ready', catalogue }, query)
    return { plan: compose('tools', facts), data }
  }, [compose, query])
  return <Screen plan={plan} host={{ data, framed: true, onInput: (bind, v) => { if (bind === 'query') setQuery(v) } }} />
}
function ToolHarness() {
  const compose = useCompose('classic')
  const minds = [{ id: 'a1', name: 'Ada', options: { tools: [] } }] as unknown as Agent[]
  const { data, facts } = toolScreen(catalogue.items[0], minds)
  return <Screen plan={compose('tool', facts)} host={{ data, framed: true, onAction: (a, item, v) => onToggle(a, item.id, v) }} />
}

let container: MiniNode, root: Root
let saved: Record<string, unknown>
const titles = () => container.findAll((n) => n.tagName === 'SPAN' && /font-medium/.test(n.getAttribute('class') ?? '')).map((n) => n.textContent)

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '', search: '', pathname: '/' },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  onToggle.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

describe('a composed screen, mounted', () => {
  it('typing in the search narrows the list MeTTa composed, and an unmatched word brings its empty state', async () => {
    await act(async () => root.render(<ToolsHarness look="classic" />))
    expect(titles()).toEqual(['Explain it simply', 'Find contradictions', 'Plan in steps', 'Weigh the evidence'])
    const input = container.findAll((n) => n.tagName === 'INPUT')[0]
    await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: 'memory lab' } }) })
    expect(titles()).toEqual(['Weigh the evidence'])
    await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: 'nothing like this' } }) })
    expect(container.textContent).toContain('No tool matches')
  })
  it('a switch hands its press back to the page with the item and the new value', async () => {
    await act(async () => root.render(<ToolHarness />))
    const sw = container.findAll((n) => n.getAttribute('role') === 'switch')[0]
    expect(sw.getAttribute('aria-label')).toBe('Let Ada use Weigh the evidence')
    await act(async () => { press(sw) })
    expect(onToggle).toHaveBeenCalledWith('toggle-tool', 'a1', true)
  })
})

/**
 * An input inside a stack item says which item it is in (scopedHost), as a press does: two items with the same bound
 * search, and typing in the second reports scope ['b'] (Peter's question on omegahive#73: the input used to arrive
 * with no item, so the page could not tell them apart).
 */
describe('an input inside a stack item carries its scope', () => {
  const part = (order: number, block: string, props: Record<string, unknown>) =>
    ({ order, block, how: { kind: 'direct' }, props, depth: { layer: 'ground', z: 0 }, place: { region: 'main', row: null } }) as never
  const plan = (screen: string, parts: never[]): ScreenPlan => ({ screen, title: null, look: 'classic', space: 'flat', parts, missing: [] })
  const item = (id: string): ScreenItem => ({ id, plan: plan(`item-${id}`, [part(10, 'search', { label: `Find in ${id}`, bind: 'q' })]), data: { q: `words in ${id}` } })

  it('typing in the second item reports scope [b]; a top-level input reports none', async () => {
    const seen: [string, string, string[] | undefined][] = []
    const host: ScreenHost = { data: { items: [item('a'), item('b')], top: '' }, framed: true, onInput: (bind, value, scope) => void seen.push([bind, value, scope]) }
    const screen = plan('stacked', [part(10, 'search', { label: 'Find', bind: 'top' }), part(20, 'stack', { source: 'items' })])
    await act(async () => root.render(<Screen plan={screen} host={host} />))
    const inputs = container.findAll((n) => n.tagName === 'INPUT')
    expect(inputs.map((n) => reactProps(n).value)).toEqual(['', 'words in a', 'words in b'])
    await act(async () => { (reactProps(inputs[2]).onChange as (e: unknown) => void)({ target: { value: 'new words' } }) })
    await act(async () => { (reactProps(inputs[0]).onChange as (e: unknown) => void)({ target: { value: 'top words' } }) })
    expect(seen).toEqual([['q', 'new words', ['b']], ['top', 'top words', undefined]])
  })
})

/**
 * An island is the page's own element under a name: when MeTTa places it in another part (the Ask's look going from one
 * size to another, screens/ask.metta), it stays mounted with what is in it, in a framed screen and drawn inline alike;
 * and a press on the mark block reaches the page.
 */
describe('an island MeTTa moves to another part stays mounted', () => {
  const part = (order: number, block: string, props: Record<string, unknown>) =>
    ({ order, block, how: { kind: 'direct' }, props, depth: { layer: 'surface', z: 1 }, place: { region: 'main', row: null } }) as never
  const plan = (parts: never[]): ScreenPlan => ({ screen: 'gate', title: null, look: 'classic', space: 'flat', parts, missing: [] })
  let mounts = 0
  function Lane() {
    const [n] = useState(() => ++mounts)
    return <p data-lane={n}>lane</p>
  }
  const lanes = () => container.findAll((n) => n.getAttribute('data-lane') !== null)

  it.each(['framed', 'inline'] as const)('%s: the same element before and after it moves, and the mark’s press reaches the page', async (how) => {
    mounts = 0
    const pressed = vi.fn()
    const host: ScreenHost = { data: { label: 'Open' }, islands: { lane: <Lane /> }, onAction: (action) => pressed(action) }
    const draw = (p: ScreenPlan) => (how === 'framed' ? <Screen plan={p} host={host} /> : <InlineParts plan={p} host={host} />)
    await act(async () => root.render(draw(plan([part(10, 'mark', { label: { bind: 'label' }, action: 'open-gate' }), part(20, 'island', { name: 'lane' })]))))
    const lane = lanes()[0]
    expect(lane.getAttribute('data-lane')).toBe('1')
    await act(async () => { press(container.findAll((n) => n.getAttribute('data-ask-mark-open') !== null)[0]) })
    expect(pressed).toHaveBeenCalledWith('open-gate')
    await act(async () => root.render(draw(plan([part(22, 'island', { name: 'lane' })]))))
    expect(lanes()).toEqual([lane])
    expect(mounts).toBe(1)
  })
})

/**
 * A row's own buttons (entries' row_actions) hand the press back with that row's item; a part that throws while it is
 * drawn shows a short line in its place, the other parts stay, and the failure goes with the page's errors.
 */
describe('row buttons, and a part that fails to draw', () => {
  const part = (order: number, block: string, props: Record<string, unknown>) =>
    ({ order, block, how: { kind: 'direct' }, props, depth: { layer: 'ground', z: 0 }, place: { region: 'main', row: null } }) as never
  const plan = (parts: never[]): ScreenPlan => ({ screen: 'cellar', title: null, look: 'classic', space: 'flat', parts, missing: [] })
  const shelves = [{ id: 'jam', title: 'Jam' }, { id: 'cider', title: 'Cider' }]

  it('each row has its buttons, named for the row; a press hands back the row it is on', async () => {
    const onAction = vi.fn()
    const p = plan([part(10, 'entries', { label: 'Shelves', source: 'shelves', title: 'title',
      row_actions: [['action', 'Use it', 'use-shelf', 'Use {title}'], ['action', 'Dismiss', 'drop-shelf']] })])
    await act(async () => root.render(<Screen plan={p} host={{ data: { shelves }, onAction }} />))
    const buttons = container.findAll((n) => n.tagName === 'BUTTON')
    expect(buttons.map((b) => [b.textContent, b.getAttribute('aria-label')])).toEqual([['Use it', 'Use Jam'], ['Dismiss', null], ['Use it', 'Use Cider'], ['Dismiss', null]])
    await act(async () => { press(buttons[3]) })
    expect(onAction).toHaveBeenCalledWith('drop-shelf', shelves[1])
  })
  it('a part that throws is a short line; the part beside it is drawn; the page keeps the error', async () => {
    const { clearPageErrors, pageErrors } = await import('../lib/recentErrors')
    clearPageErrors()
    const broken = Object.defineProperty({}, 'text', { get: () => { throw new Error('the cellar door jammed') } })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => root.render(<Screen plan={plan([part(10, 'notice', { text: 'The shelves are full.' }), part(20, 'notice', broken)])} host={{ data: {} }} />))
    quiet.mockRestore()
    expect(container.textContent).toContain('The shelves are full.')
    expect(container.textContent).toContain('This part could not be drawn.')
    expect(pageErrors().map((e) => [e.kind, e.where, e.message])).toEqual([['screen', 'cellar (part 20)', 'the cellar door jammed']])
  })
})
