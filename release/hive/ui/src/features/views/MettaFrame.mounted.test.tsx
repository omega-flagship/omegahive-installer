// @vitest-environment node
// Purpose: a view a mind wrote in MeTTa, mounted as a person sees it: drawn by the hive's blocks from its MeTTa under the
// bar views.metta composes, typed into, changed by its mind while open, and, when a change can't be drawn, why, in words
// views.metta says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode, press, reactProps } from '../../ui/miniDom.testkit'
import { useHive } from '../../store/store'
import { MettaFrame, type MettaFrameProps } from './MettaFrame'
import { viewAnswerer } from './viewProtocol'
import type { SandboxReport } from './viewSandbox'
import type { ViewPort } from './viewSession'
import tipSource from '../../../../tests/fixtures/views-tip.metta?raw'

vi.setConfig({ testTimeout: 20_000 })

/**
 * A view a mind wrote in MeTTa, mounted as a person sees it: drawn by the hive's blocks from its MeTTa, typed into, and
 * changed by its mind while it is open. The worker here answers in this thread with the same answerer the real worker
 * runs (viewProtocol.ts), so what is drawn is what the view's MeTTa composed. INVENTED mind, ids and sums.
 */
const ID = `ar_${'5'.repeat(32)}`
// as the hive hands a view out once its person pressed Run it: with its text
const revision = (n: number, source: string): MettaFrameProps['view'] => ({
  artifact_id: ID, kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'a1', revision: n,
  digest: `sha256:${String(n).repeat(64)}`, created_at: '2026-11-13T00:00:00Z', carrier: 'metta', grant: { ran: true, reach: false }, source,
})
const tipChanged = tipSource
  .replace('(option "10" "10%") (option "15" "15%") (option "20" "20%")', '(option "18" "18%") (option "20" "20%") (option "25" "25%")')
  .replace('(Start pct "15")', '(Start pct "18")')

let started = 0
const portWith = (sandbox: SandboxReport) => (): ViewPort => {
  started++
  const answer = viewAnswerer(sandbox)
  const port: ViewPort = {
    onmessage: null,
    onerror: null,
    postMessage: (req) => { queueMicrotask(() => port.onmessage?.({ data: answer(req) })) },
    terminate: () => { port.onmessage = null },
  }
  queueMicrotask(() => port.onmessage?.({ data: { id: 0, ready: sandbox } }))
  return port
}
const bared = portWith({ ok: true, open: [] })

// the hive as the page sees it: revision notices, and the view's latest revision on request
const listeners = new Set<(event: Record<string, unknown>) => void>()
let latest = revision(1, tipSource)
const client = {
  subscribe: (fn: (event: Record<string, unknown>) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  artifactView: async () => latest,
}
const saved = async (next: MettaFrameProps['view']) => {
  latest = next
  for (const l of listeners) l({ type: 'artifact.revision', at: 't', swarm_id: 's1', artifact_id: ID, revision: next.revision, digest: next.digest, created_at: 't' })
  await settle()
}

let container: MiniNode, root: Root
let kept: Record<string, unknown>
const DIALOG = { matches: () => false, showModal: () => undefined, close: () => undefined }
async function settle() {
  await act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)) })
}
const text = () => container.textContent
const inputs = () => container.findAll((n) => n.tagName === 'INPUT')
const type = async (input: MiniNode, value: string) => {
  await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value } }) })
  await settle()
}
const dialog = () => container.findAll((n) => n.tagName === 'DIALOG')[0]

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  kept = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) kept[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '', search: '', pathname: '/' },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  // the view's frame is a <dialog>: inline it opens by its attribute (viewChrome.tsx useDialogMode)
  Object.assign(MiniNode.prototype, DIALOG)
  Object.defineProperty(MiniNode.prototype, 'open', { get(this: MiniNode) { return this.getAttribute('open') !== null }, configurable: true })
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  started = 0
  latest = revision(1, tipSource)
  useHive.setState({ client: client as never, agents: { a1: { id: 'a1', name: 'Wren' } } as never })
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const key of Object.keys(DIALOG)) delete (MiniNode.prototype as unknown as Record<string, unknown>)[key]
  delete (MiniNode.prototype as unknown as Record<string, unknown>).open
  useHive.setState({ client: null as never, agents: {} as never })
  for (const [k, v] of Object.entries(kept)) (globalThis as Record<string, unknown>)[k] = v
})

describe('a view a mind wrote in MeTTa, as a person sees it', () => {
  it('is drawn from its MeTTa, takes typing, and takes up its mind\'s change live with no restart, keeping what was typed', async () => {
    await act(async () => root.render(<MettaFrame view={latest} place="page" port={bared} />))
    await settle()
    expect(dialog().getAttribute('data-view-state')).toBe('drawn')
    // the bar above it, its title naming the view's dialog
    const title = container.findAll((n) => n.nodeType === 1 && n.getAttribute('id') === dialog().getAttribute('aria-labelledby'))[0]
    expect(title?.textContent).toBe('Tip calculator')
    expect(container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Full screen')).toHaveLength(1)
    expect(text()).toContain('Type the bill to see the split.')
    expect(text()).toContain('View made by Wren. It runs on its own and cannot see your hive.')

    await type(inputs()[0], '84.50')
    expect(text()).not.toContain('Type the bill to see the split.')
    expect(text()).toContain('12.68')
    expect(text()).toContain('97.18')

    // the mind changes the view's MeTTa: other tips, from 18%
    await saved(revision(2, tipChanged))
    expect(dialog().getAttribute('data-view-revision')).toBe('2')
    expect(text()).toContain('25%')
    expect(text()).toContain('15.21')
    expect(reactProps(inputs()[0]).value).toBe('84.50')
    expect(started).toBe(1)   // the same worker took the change: nothing was started again, nothing rebuilt
  })

  it('a press puts the view\'s words in its maker\'s message box for the person to send', async () => {
    const onMessage = vi.fn()
    await act(async () => root.render(<MettaFrame view={latest} place="page" port={bared} onMessage={onMessage} />))
    await settle()
    await type(inputs()[0], '84.50')
    const book = container.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Ask to book it')[0]
    await act(async () => { press(book) })
    await settle()
    expect(onMessage).toHaveBeenCalledWith('Please book a table for 2. The bill comes to 97.18 with the tip.', expect.objectContaining({ artifact_id: ID }))
  })

  it('keeps drawing the last view when a change cannot be drawn, and says why', async () => {
    await act(async () => root.render(<MettaFrame view={latest} place="page" port={bared} />))
    await settle()
    await type(inputs()[0], '10')
    await saved(revision(3, `${tipSource}\n(Part tip 70 keyfield ((label "Your key")))`))
    expect(text()).toContain("The view kept its last state: revision 3 can't be drawn: part 70 uses the keyfield block, which a view may not use.")
    expect(text()).toContain('1.50')
  })

  it('says when its mind saved a revision that is no longer a view written in MeTTa, and keeps the last one drawn', async () => {
    await act(async () => root.render(<MettaFrame view={latest} place="page" port={bared} />))
    await settle()
    await saved({ ...revision(2, tipSource), carrier: 'view', source: null } as never)
    expect(text()).toContain('Revision 2 is not one this view can take up, so open the view again to see it.')
    expect(text()).toContain('Type the bill to see the split.')
  })

  it('names a mind the person cannot see as a mind', async () => {
    useHive.setState({ agents: {} as never })
    await act(async () => root.render(<MettaFrame view={latest} place="page" port={bared} />))
    await settle()
    expect(text()).toContain('View made by a mind. It runs on its own and cannot see your hive.')
  })

  it('draws nothing in a worker whose scope was not bared', async () => {
    await act(async () => root.render(<MettaFrame view={latest} place="page" port={portWith({ ok: false, open: ['fetch'] })} />))
    await settle()
    expect(dialog().getAttribute('data-view-state')).toBe('unsafe')
    expect(text()).toContain("This browser can't keep the view apart from your hive, so it isn't drawn.")
    expect(inputs()).toHaveLength(0)
  })
})
