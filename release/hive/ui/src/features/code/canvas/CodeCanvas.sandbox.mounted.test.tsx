// @vitest-environment node
/** Actual ReactDOM component/effects on the existing MiniDOM. Editor, transport
 * and other feature hooks are explicit doubles; no browser or Host admission proof. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ toast: vi.fn(), nativeRun: vi.fn(), testHook: vi.fn(), editor: null as any, result: null as any, phone: false }))
vi.mock('../../../store/store', () => ({ useHive: (select: any) => select({ agents: {}, toast: T.toast }) }))
vi.mock('../../../lib/decisionGate', () => ({ bindTo: () => ({ kind: 'ready' }) }))
vi.mock('../../../lib/hooks', () => ({ useReducedMotion: () => true, useMediaQuery: () => T.phone, useEscape: () => undefined, isTypingTarget: () => false }))
vi.mock('../../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../../ui/DecisionDialog', () => ({ DecisionDialog: () => null }))
vi.mock('../../ask/view', () => ({ useAskView: () => undefined }))
vi.mock('../../ask/fields', () => ({ useAskFillable: () => ({}) }))
vi.mock('./askBridge', () => ({ useAskRoom: () => ({ room: 0, present: false }), useAskSend: () => vi.fn(), useAskTurn: () => vi.fn() }))
vi.mock('./features', () => ({ identity: () => 'fixture', useCodeFeatures: () => ({ key: 'fixture', status: 'ready', features: new Set() }) }))
vi.mock('./useTestRun', () => ({ useTestRun: (call: unknown) => { T.testHook(call); return { state: { kind: 'idle' }, run: T.nativeRun } } }))
vi.mock('./useLanguage', () => ({ useLanguage: () => ({ offer: {}, rename: null, completion: null, note: null }) }))
vi.mock('./languageSession', () => ({ renameViews: () => [] }))
vi.mock('./LanguageParts', () => ({ CompletionList: () => null, DefinitionChooser: () => null, RenameCard: () => null, RenamePrompt: () => null }))
vi.mock('./Minimap', () => ({ Minimap: () => null }))
vi.mock('./IterationsDrawer', () => ({ Iterations: () => null }))
vi.mock('./MergeReviewCard', () => ({ MergeReviewCard: () => null }))
vi.mock('./useVibe', () => ({ useVibe: () => ({ phase: { kind: 'idle' }, read: null, result: T.result,
  changeViews: [], placed: [], staged: {}, presence: {}, chooser: null, note: null, pending: null }) }))
vi.mock('../Editor', () => ({ Editor: (props: any) => { T.editor = props; return <div aria-label="Mounted editor stand-in" /> } }))
import { CodeCanvas, type CodeCanvasProps } from './CodeCanvas'

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
let props: CodeCanvasProps
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function currentResult() { return { gone: undefined, file: { path: 'a.py' }, integrity: { ok: true, digest: 'b'.repeat(64) }, sent: { request_id: 'rq_exact', workspace_id: 'ws' }, read: { currency: 'current', record: { id: 'suggestion_'+'d'.repeat(32), digest: 'b'.repeat(64) }, content: { digest: 'c'.repeat(64), binding: { generation: 1, tree_digest: 'a'.repeat(64) } } } } }
async function mount(extra: Partial<CodeCanvasProps> = {}) {
  props = { ...props, ...extra }
  await act(async () => root.render(<CodeCanvas {...props} />))
  await act(async () => { await Promise.resolve() })
}
function testButton() { return host.findAll(n => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Run the tests on what is saved (⌘;)')[0] }
beforeEach(async () => {
  const g = globalThis as any; saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined,
    setTimeout, clearTimeout, innerWidth: 1400, innerHeight: 900, getComputedStyle: () => ({ getPropertyValue: () => '' }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement
  g.IS_REACT_ACT_ENVIRONMENT = true; g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0); g.cancelAnimationFrame = clearTimeout
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client'); root = createRoot(host as unknown as Element)
  T.toast.mockReset(); T.nativeRun.mockReset(); T.testHook.mockReset(); T.result = currentResult(); T.editor = null; T.phone = false
  props = { label: 'Candidate', eyebrow: 'Fixture', client: {} as any, ctx: { task_id: 'task', grant_id: 'grant', repository_id: 'repo' },
    call: vi.fn(), ws: { id: 'ws', generation: 1, tree_digest: 'a'.repeat(64), base_commit: 'fixture-base' }, files: ['a.py'], path: 'a.py',
    file: { path: 'a.py', content: 'x = 1\n', digest: 'file' }, text: 'x = 1\n', dirty: false, busy: null, selection: null,
    onText: vi.fn(), onSelect: vi.fn(), openFile: vi.fn(), save: vi.fn(), onWorkspace: vi.fn(), drawer: () => null,
    onBack: vi.fn(), onClose: vi.fn(), proposalOnly: true, sandboxTestAvailable: true }
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k,v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('mounted Canvas registered sandbox test seam', () => {
  it('hides Test and leaves its shortcut inert without explicit host protocol support', async () => {
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ sandboxTestAvailable: false, onSandboxTest: callback, selection: { from: 0, to: 1 } })
    expect(testButton()).toBeUndefined()
    expect(host.findAll(n => n.tagName === 'BUTTON' && n.textContent === 'Test')).toHaveLength(0)
    expect(T.editor.keys['Mod-;']()).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(T.nativeRun).not.toHaveBeenCalled()
  })

  it('withdraws continuation authority if host support disappears during admission', async () => {
    const waiting = deferred()
    let current = () => false
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>((_what, _selection, _retained, alive) => {
      current = alive ?? (() => false)
      return waiting.promise
    })
    await mount({ sandboxTestAvailable: true, onSandboxTest: callback })
    await act(async () => { press(testButton()) })
    expect(current()).toBe(true)
    await mount({ sandboxTestAvailable: false })
    expect(current()).toBe(false)
    expect(testButton()).toBeUndefined()
    waiting.resolve(); await act(async () => { await waiting.promise })
    expect(T.nativeRun).not.toHaveBeenCalled()
  })

  it('uses a containing region instead of a fixed full-screen page when embedded', async () => {
    await mount({ embedded: true })
    const region = host.findAll(n => n.hasAttribute('data-code-embedded'))[0]
    expect(region.getAttribute('role')).toBe('region')
    expect(region.getAttribute('class')?.split(' ')).toContain('relative')
    expect(region.getAttribute('class')?.split(' ')).not.toContain('fixed')
  })
  it('keeps Test present but refuses missing admission with no generic run', async () => {
    await mount(); expect(testButton()).toBeTruthy()
    await act(async () => press(testButton()))
    expect(T.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sandbox test admission is unavailable' }))
    expect(T.nativeRun).not.toHaveBeenCalled(); expect(T.testHook).toHaveBeenLastCalledWith(null)
  })
  it('routes both Test and the existing editor shortcut to the explicit callback', async () => {
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ onSandboxTest: callback })
    await act(async () => press(testButton()))
    await act(async () => { T.editor.keys['Mod-;']() })
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback.mock.calls[0][0]).toBe('the tests for this retained proposal')
    expect(T.nativeRun).not.toHaveBeenCalled()
  })
  it('does not send a second admission while the first callback is pending', async () => {
    const waiting = deferred(), callback = vi.fn(() => waiting.promise)
    await mount({ onSandboxTest: callback })
    await act(async () => { T.editor.keys['Mod-;'](); T.editor.keys['Mod-;']() })
    expect(callback).toHaveBeenCalledTimes(1)
    waiting.resolve(); await act(async () => { await waiting.promise })
  })
  it('carries only the actually retained current request/proposal and selected UTF16 metadata', async () => {
    T.result = { gone: undefined, file: { path: 'a.py' }, integrity: { ok: true, digest: 'b'.repeat(64) },
      sent: { request_id: 'rq_exact', workspace_id: 'ws' },
      read: { currency: 'current', record: { id: 'suggestion_'+'d'.repeat(32), digest: 'b'.repeat(64) },
        content: { digest: 'c'.repeat(64), binding: { generation: 1, tree_digest: 'a'.repeat(64) } } } }
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ onSandboxTest: callback, selection: { from: 0, to: 1 } })
    await act(async () => press(testButton()))
    expect(callback.mock.calls[0].slice(0,3)).toEqual(['the tests for this retained proposal', { path: 'a.py', from: 0, to: 1 },
      { request_id: 'rq_exact', proposal: { proposal_id: 'suggestion_'+'d'.repeat(32), proposal_digest: 'sha256:'+'b'.repeat(64), normalized_hunks_digest: 'sha256:'+'c'.repeat(64) },
        parent: { generation: 1, tree_digest: 'sha256:'+'a'.repeat(64) } }])
    expect(T.nativeRun).not.toHaveBeenCalled()
  })
  it('never guesses a proposal when no verified result exists', async () => {
    T.result = null
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ onSandboxTest: callback }); await act(async () => press(testButton()))
    expect(callback).not.toHaveBeenCalled()
    expect(T.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Select a proposed change' }))
  })
  it('the mounted selection toolbar also uses only the registered sandbox callback', async () => {
    T.phone = true
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ onSandboxTest: callback, selection: { from: 0, to: 1 } })
    const toolbar = host.findAll(n => n.getAttribute('role') === 'toolbar')[0]
    const button = toolbar.findAll(n => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Request tests through the registered sandbox')[0]
    await act(async () => press(button))
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][1]).toEqual({ path: 'a.py', from: 0, to: 1 })
    expect(T.nativeRun).not.toHaveBeenCalled()
    expect(toolbar.textContent).not.toContain('Function')
  })
  it('retains the legacy native test path outside the embedded mode', async () => {
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ proposalOnly: false, onSandboxTest: callback }); await act(async () => press(testButton()))
    expect(T.nativeRun).toHaveBeenCalledWith('the tests'); expect(callback).not.toHaveBeenCalled()
  })
})
