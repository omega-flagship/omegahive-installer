/**
 * Purpose: what the mounted view tests share: a mini page to mount into (ui/miniDom.testkit, with the <dialog> calls a
 * view's frame makes), a worker that answers in the test's own thread with the same answerer the real worker runs
 * (viewProtocol.ts), and a wait for the answers in flight to land.
 */
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode } from '../../ui/miniDom.testkit'
import { viewAnswerer } from './viewProtocol'
import type { SandboxReport } from './viewSandbox'
import type { ViewPort } from './viewSession'

const DIALOG = { matches: () => false, showModal: () => undefined, close: () => undefined }

export interface MountedPage { container: MiniNode; root: Root; restore: () => Promise<void> }

/** A mini page with a root to render into; restore puts every global back. */
export async function mountPage(): Promise<MountedPage> {
  const g = globalThis as unknown as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) kept[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '', search: '', pathname: '/' },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  // a view's frame is a <dialog>: inline it opens by its attribute (viewChrome.ts useDialogMode)
  Object.assign(MiniNode.prototype, DIALOG)
  Object.defineProperty(MiniNode.prototype, 'open', { get(this: MiniNode) { return this.getAttribute('open') !== null }, configurable: true })
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(container as unknown as Element)
  return {
    container, root,
    restore: async () => {
      await act(async () => root.unmount())
      for (const key of Object.keys(DIALOG)) delete (MiniNode.prototype as unknown as Record<string, unknown>)[key]
      delete (MiniNode.prototype as unknown as Record<string, unknown>).open
      for (const [k, v] of Object.entries(kept)) g[k] = v
    },
  }
}

/** Let the answers in flight land: the local worker answers on the next turns of the event loop. */
export async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)) })
}

/** A worker answering in this thread, reporting `sandbox` as its scope; `made` counts how many were started. */
export function localPorts(sandbox: SandboxReport = { ok: true, open: [] }) {
  const ports = { made: 0, port: (): ViewPort => {
    ports.made++
    const answer = viewAnswerer(sandbox)
    const port: ViewPort = {
      onmessage: null,
      onerror: null,
      postMessage: (req) => { queueMicrotask(() => port.onmessage?.({ data: answer(req) })) },
      terminate: () => { port.onmessage = null },
    }
    queueMicrotask(() => port.onmessage?.({ data: { id: 0, ready: sandbox } }))
    return port
  } }
  return ports
}
