// Purpose: drive deletion and unlinking through Files and storage and its real confirmation and identity gates.
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { Asset, LinkedFolder } from '../../api/moneyWork'
import { useHive } from '../../store/store'
import { MiniDocument, MiniNode, press } from '../../ui/miniDom.testkit'
import AssetsPage from './AssetsPage'

// Animation, focus trapping and layout have their own tests; all page, MeTTa, identity and decision logic runs here.
vi.mock('framer-motion', async (original) => ({ ...(await original<typeof import('framer-motion')>()), m: new Proxy({}, { get: (_, tag) => tag }), AnimatePresence: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../ui/useModalContainment', () => ({ useModalContainment: () => undefined }))
vi.mock('../../lib/hooks', async (original) => ({ ...(await original<typeof import('../../lib/hooks')>()), useIsDesktop: () => true, useReducedMotion: () => true, useEscape: () => undefined }))

const asset: Asset = { sha256: 'a'.repeat(64), name: 'notes.txt', mime: 'text/plain', bytes: 12, owner_swarm: 's_one', owners: ['s_one'], created_by: 'user:operator', created_at: '2026-11-17T00:00:00Z', local_only: false, placements: ['local'], history: [] }
const folder: LinkedFolder = { id: 'f_one', label: 'Work', root: '/invented/work', owner_swarm: 's_one', writable: false, writers: 'admins', created_by: 'user:operator', created_at: asset.created_at, scope: 'this_machine_only', available: true, history: [] }
let doc: MiniDocument, root: Root, state: ReturnType<typeof useHive.getState>, now: number
let deleteFile: ReturnType<typeof vi.fn>, unlink: ReturnType<typeof vi.fn>
let files: Asset[], folders: LinkedFolder[]
let saved: Record<string, unknown>
const optionsDescriptor = Object.getOwnPropertyDescriptor(MiniNode.prototype, 'options')
const all = (pick: (node: MiniNode) => boolean) => doc.body.findAll(pick)
const buttons = () => all((n) => n.tagName === 'BUTTON')
function button(label: string): MiniNode {
  const found = buttons().find((node) => node.textContent.trim() === label)
  if (!found) throw new Error(`Missing ${label}; present: ${buttons().map((n) => n.textContent).join(', ')}`)
  return found
}
const flush = async () => { for (let n = 0; n < 8; n++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const tap = async (label: string) => { await act(async () => { await press(button(label)) }); await flush() }

beforeEach(async () => {
  saved = {}
  const globals = globalThis as unknown as Record<string, unknown>
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = globals[key]
  doc = new MiniDocument()
  Object.defineProperty(MiniNode.prototype, 'options', { configurable: true, get(this: MiniNode) { return this.findAll((node) => node.tagName === 'OPTION') } })
  const window = { document: doc, HTMLIFrameElement: class {}, location: { hash: '#/assets', search: '' }, innerWidth: 1280, innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = window
  Object.assign(globals, { window, document: doc, HTMLIFrameElement: window.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  root = (await import('react-dom/client')).createRoot(container as unknown as Element)
  state = useHive.getState()
  files = [structuredClone(asset)]; folders = [structuredClone(folder)]
  deleteFile = vi.fn(async () => { files = []; return { sha256: asset.sha256, deleted: true } })
  unlink = vi.fn(async () => { folders = []; return { id: folder.id, unlinked: true } })
  const client = { listAssets: async () => files, assetStores: async () => [{ name: 'local', kind: 'local' }], listFolders: async () => ({ local: true, scope: 'this_machine_only', folders }),
    me: async () => ({ kind: 'password', role: 'admin', principal: 'user:operator' }), deleteAsset: deleteFile, unlinkFolder: unlink } as unknown as HiveClient
  now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  await act(async () => { useHive.setState({ client, toasts: [] }); root.render(createElement(AssetsPage)) })
  await flush()
})

afterEach(async () => {
  await act(async () => root.unmount())
  useHive.setState(state, true)
  vi.restoreAllMocks()
  if (optionsDescriptor) Object.defineProperty(MiniNode.prototype, 'options', optionsDescriptor)
  else Reflect.deleteProperty(MiniNode.prototype, 'options')
  Object.assign(globalThis, saved)
})

describe.each([
  { opener: 'Delete…', confirm: 'Delete permanently', name: asset.name, id: asset.sha256, effect: 'All recorded copies', action: () => deleteFile },
  { opener: 'Unlink…', confirm: 'Unlink', name: folder.label, id: folder.id, effect: 'Its files stay on disk', action: () => unlink },
])('$opener on Files and storage', ({ opener, confirm, name, id, effect, action }) => {
  it('shows exactly what goes, waits for inspection, cancels, then removes the row only after confirmation', async () => {
    await tap(opener)
    expect(doc.body.textContent).toContain(name)
    expect(doc.body.textContent).toContain(effect)
    expect(all((n) => n.getAttribute('role') === 'alertdialog')).toHaveLength(1)
    await tap(confirm)
    expect(action()).not.toHaveBeenCalled()
    await tap('Cancel')
    expect(action()).not.toHaveBeenCalled()
    expect(all((n) => n.getAttribute('role') === 'alertdialog')).toHaveLength(0)
    await tap(opener)
    now += 1000
    await tap(confirm)
    expect(action()).toHaveBeenCalledExactlyOnceWith(id)
    expect(all((n) => n.getAttribute('role') === 'alertdialog')).toHaveLength(0)
    expect(doc.body.textContent).not.toContain(name)
    expect(useHive.getState().toasts).toHaveLength(1)
  })
  it('keeps the row and displays the hive failure', async () => {
    action().mockRejectedValue(new ApiError(503, 'delete_failed', 'storage refused this copy'))
    await tap(opener)
    now += 1000
    await tap(confirm)
    expect(doc.body.textContent).toContain('storage refused this copy')
    expect(doc.body.textContent).toContain(name)
    expect(all((n) => n.getAttribute('role') === 'alertdialog')).toHaveLength(1)
    expect(useHive.getState().toasts).toHaveLength(0)
  })
  it('discards its confirmation when the active identity changes', async () => {
    await tap(opener)
    await act(async () => useHive.setState({ inits: useHive.getState().inits + 1 }))
    await flush()
    expect(all((n) => n.getAttribute('role') === 'alertdialog')).toHaveLength(0)
    expect(action()).not.toHaveBeenCalled()
  })
})
