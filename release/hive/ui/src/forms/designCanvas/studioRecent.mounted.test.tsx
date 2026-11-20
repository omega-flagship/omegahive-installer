// Purpose: verify Studio's mounted recent list, its links, and exact opening targets.

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'

const client = vi.hoisted(() => ({ studioRecent: vi.fn(), creationText: vi.fn() }))
vi.mock('../../store/store', () => ({
  useHive: (sel: (s: { client: typeof client; resyncs: number }) => unknown) => sel({ client, resyncs: 0 }),
}))
const { Empty } = await import('./Chrome')
const { StudioRecent } = await import('./StudioRecent')
const { href } = await import('../../lib/router')

vi.setConfig({ testTimeout: 20_000 })

let container: MiniNode
let root: Root

beforeEach(async () => {
  const doc = new MiniDocument()
  const win = {
    document: doc, HTMLIFrameElement: class {}, location: { hash: '', search: '', pathname: '/' },
    addEventListener: () => undefined, removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false }),
  }
  doc.defaultView = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = doc.body.appendChild(doc.createElement('div'))
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})

function button(label: string): MiniNode {
  const match = container.findAll((node) => node.tagName === 'BUTTON' && node.textContent.startsWith(label))
  expect(match).toHaveLength(1)
  return match[0]
}

describe('recent creations in the Studio empty canvas', () => {
  it('preserves the mixed order and opens an exact design, picture, and installed app', async () => {
    const title = 'Warm invitation'
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 8"><text>Invité</text></svg>'
    const at = '2026-11-20T00:00:00Z'
    const image = { id: 'ar_picture', kind: 'image', title, swarm_id: 's_personal', revision: 3, digest: 'sha256:' + 'a'.repeat(64), at }
    const design = { ...image, id: 'ar_design', kind: 'design', title: 'A design', swarm_id: 's_studio' }
    const app = { id: 'example-app', kind: 'app', title: 'Example app', at, swarm_id: 's_apps' }
    client.studioRecent.mockResolvedValue([app, image, design])
    client.creationText.mockResolvedValue({ ...image, body: svg, created_at: at })
    await act(async () => root.render(
      <Empty ask={() => undefined} askReady>
        <StudioRecent />
      </Empty>,
    ))
    expect(client.studioRecent).toHaveBeenCalledWith()
    const list = container.findAll((node) => node.getAttribute('aria-label') === 'Recent creations')[0]
    expect(list.textContent).toBe('Example appAppWarm invitationPictureA designDesign')
    const link = container.findAll((node) => node.tagName === 'A' && node.textContent === 'Artifacts')[0]
    expect(link.getAttribute('href')).toBe('#/artifacts')
    await act(async () => { press(button('A design')) })
    expect(window.location.hash).toBe(href({ name: 'program', id: 'omegadesign', swarm: design.swarm_id,
      source: { artifact_id: design.id, revision: design.revision, digest: design.digest } }))
    await act(async () => { press(button('Example app')) })
    expect(window.location.hash).toBe('#/program/example-app/s_apps')
    await act(async () => { press(button(title)) })
    expect(client.creationText).toHaveBeenCalledWith('ar_picture', 3)
    const previews = container.findAll((node) => node.tagName === 'IMG')
    expect(previews).toHaveLength(1)
    expect(previews[0].getAttribute('alt')).toBe(title)
    expect(decodeURIComponent(previews[0].getAttribute('src')!.split(',')[1])).toBe(svg)
    expect(container.textContent).not.toContain('<svg')
    await act(async () => { (reactProps(previews[0]).onError as () => void)() })
    expect(container.textContent).toContain('This picture could not be displayed.')
    await act(async () => { press(button('Back to recent creations')) })
    expect(button(title)).toBeDefined()
    expect(container.findAll((node) => node.tagName === 'IMG')).toHaveLength(0)
  })
  it('keeps the Artifacts link when there is no saved creation', async () => {
    client.studioRecent.mockResolvedValue([])
    await act(async () => root.render(<StudioRecent />))
    expect(container.findAll((node) => node.tagName === 'A')[0].getAttribute('href')).toBe('#/artifacts')
    expect(container.findAll((node) => node.getAttribute('aria-label') === 'Recent creations')).toHaveLength(0)
  })
})
