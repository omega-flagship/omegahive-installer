// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useMemo, useState } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../ui/miniDom.testkit'
import { simToolsCatalogue } from '../api/sim/simTools'
import { toolScreen, toolsScreen } from '../features/tools/data'
import type { Agent } from '../api/types'
import { Screen } from './Screen'
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
