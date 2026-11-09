// @vitest-environment node
/** The rename block on real ReactDOM (the MiniDOM): it starts from the bound name, Enter sends the new one, Escape and leaving cancel. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, reactProps, type MiniNode } from '../ui/miniDom.testkit'
import { Screen, type ScreenHost, type ScreenItem } from './Screen'
import { ScreensSpace, SCREEN_SOURCES } from './screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open([...SCREEN_SOURCES, ['jar', `
(Screen jar "Jar")
(Part jar 10 rename ((label "Jar name") (value (bind jar.name)) (maxlength 20) (action rename-jar) (cancel_action keep-name)))
`]])
let container: MiniNode, root: Root
let saved: Record<string, unknown>

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

describe('the rename block, mounted', () => {
  it('starts from the bound name; Enter sends the trimmed new name; Escape and leaving the field cancel', async () => {
    const plan = space.compose('jar', 'classic')
    expect(plan.parts.map((p) => [p.block, p.depth.layer])).toEqual([['rename', 'raised']])
    const got: [string, ScreenItem][] = []
    const host: ScreenHost = { data: { 'jar.name': 'Quince' }, onAction: (a, it) => got.push([a, it]) }
    await act(async () => root.render(createElement(Screen, { plan, host })))
    const input = container.findAll((n) => n.tagName === 'INPUT')[0]
    const form = container.findAll((n) => n.tagName === 'FORM')[0]
    expect(reactProps(input).value).toBe('Quince')
    expect(reactProps(input)['aria-label']).toBe('Jar name')
    expect(reactProps(input).maxLength).toBe(20)
    await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: '  Plum jam ' } }) })
    await act(async () => { (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    expect(got).toEqual([['rename-jar', { value: 'Plum jam' }]])
    expect(host.data).toEqual({ 'jar.name': 'Quince' })
    await act(async () => { (reactProps(input).onKeyDown as (e: unknown) => void)({ key: 'Escape' }) })
    expect(got.at(-1)).toEqual(['keep-name', {}])
    await act(async () => { (reactProps(input).onKeyDown as (e: unknown) => void)({ key: 'a' }) })
    expect(got).toHaveLength(2)
    await act(async () => { (reactProps(input).onBlur as () => void)() })
    expect(got.at(-1)).toEqual(['keep-name', {}])
  })
})
