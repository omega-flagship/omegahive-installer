import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../ui/miniDom.testkit'

/**
 * followups-r6 item 9 (found by Code): in a confirmed simulation the preview marker said "live hive data: every action
 * is real", which is false there. Its detail now follows the hive client's mode. Mounted (react-dom on
 * ui/miniDom.testkit) so the store subscription is the real one. A release build still renders nothing. INVENTED data.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, location: { hash: '', search: '', pathname: '/' }, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {} }
  doc.defaultView = win
  g.window = win
  g.document = doc
  g.HTMLIFrameElement = win.HTMLIFrameElement
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

async function mountBanner(preview: boolean) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { PreviewBuildBanner } = await import('./PreviewBuildBanner')
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => root.render(createElement(PreviewBuildBanner, { preview })))
  return { act, container, unmount: () => act(async () => root.unmount()) }
}

async function client(mode: string | null | { noMode: true }) {
  const { useHive } = await import('../store/store')
  const { act } = await import('react')
  await act(async () => useHive.setState({ client: (mode === null ? null : typeof mode === 'object' ? {} : { mode }) as never }))
}

const marker = (c: { findAll: MiniDocument['findAll'] }) => c.findAll((n) => n.hasAttribute('data-preview-build'))

describe('item 9: the preview marker says what the data is', () => {
  it('a confirmed simulation: simulated data, no action real; never "every action is real"', async () => {
    await client('sim')
    const b = await mountBanner(true)
    const [m] = marker(b.container)
    expect(m.textContent).toMatch(/^PREVIEW BUILD · not a release/)
    expect(m.textContent).toMatch(/simulated data: no action here is real/)
    expect(m.textContent).not.toMatch(/every action is real|live hive data/)
    expect(m.getAttribute('aria-label')).toBe(m.textContent)
    expect(m.getAttribute('data-preview-data')).toBe('sim')
    await b.unmount()
  })
  it('a live hive: live data, every action real', async () => {
    await client('live')
    const b = await mountBanner(true)
    const [m] = marker(b.container)
    expect(m.textContent).toMatch(/live hive data: every action is real/)
    expect(m.textContent).not.toMatch(/simulated/)
    expect(m.getAttribute('data-preview-data')).toBe('live')
    await b.unmount()
  })
  it('not yet known (no client): the careful live words, never a claim that nothing is real', async () => {
    await client(null)
    const b = await mountBanner(true)
    expect(marker(b.container)[0].textContent).toMatch(/every action is real/)
    await b.unmount()
  })
  it('the words follow the client when it changes under a mounted marker', async () => {
    await client('live')
    const b = await mountBanner(true)
    expect(marker(b.container)[0].textContent).toMatch(/every action is real/)
    await client('sim')
    expect(marker(b.container)[0].textContent).toMatch(/simulated data/)
    await b.unmount()
  })
  it('a release build renders nothing, live or simulated', async () => {
    for (const mode of ['live', 'sim'] as const) {
      await client(mode)
      const b = await mountBanner(false)
      expect(marker(b.container)).toEqual([])
      expect(b.container.childNodes).toEqual([])
      await b.unmount()
    }
  })
})

/**
 * followups-r7 item 3 (Kimi r6, the sharpest point): THE FAIL-SAFE. The direction of the unknown-client default is the
 * safety-critical decision on this banner. An unknown mode (no client yet, a client with no mode, a mode this build
 * does not know) must show the LIVE warning words ("every action is real") and never "simulated". If the default were
 * flipped, a live hive would be labelled "simulated data: no action here is real", teaching people that real actions
 * are fake. Only a client that says exactly `sim` gets the simulated words.
 */
describe('fail-safe: an UNKNOWN client mode shows the LIVE warning words, never "simulated"', () => {
  const LIVE_WORDS = /live hive data: every action is real/
  const unknown: [string, string | null | { noMode: true }][] = [
    ['no client yet', null],
    ['a client with no mode', { noMode: true }],
    ['a mode this build does not know', 'invented-mode'],
    ['an empty mode', ''],
    ['a near miss of sim', 'SIM'],
  ]
  for (const [name, mode] of unknown) {
    it(`${name}: the live warning words`, async () => {
      await client(mode)
      const b = await mountBanner(true)
      const [m] = marker(b.container)
      expect(m.textContent).toMatch(LIVE_WORDS)
      expect(m.textContent).not.toMatch(/simulated|no action here is real/)
      expect(m.getAttribute('data-preview-data')).toBe('live')
      await b.unmount()
    })
  }
  it('the marker on its own, with no sim flag given: the live warning words (its default is the careful one)', async () => {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { PreviewBuildMarker } = await import('./PreviewBuildMarker')
    const container = doc.body.appendChild(doc.createElement('div'))
    const root = createRoot(container as unknown as HTMLElement)
    await act(async () => root.render(createElement(PreviewBuildMarker, { preview: true })))
    const [m] = marker(container)
    expect(m.textContent).toMatch(LIVE_WORDS)
    expect(m.textContent).not.toMatch(/simulated/)
    await act(async () => root.unmount())
  })
})
