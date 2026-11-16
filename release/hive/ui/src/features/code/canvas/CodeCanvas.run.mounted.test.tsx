/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store, the editor, the client and the window */
// @vitest-environment node
/** Actual ReactDOM component/effects on the existing MiniDOM, on the full Code page (native runs, not Create's sandbox):
 * the canvas Test runs only a command the hive grants (the target's run, runAuthority.fixture.json). Editor, transport
 * and other feature hooks are explicit doubles, as in CodeCanvas.sandbox.mounted.test.tsx. */
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
import fixture from '../runAuthority.fixture.json'
import type { RunAuthority } from '../runAuthority'

const answer = (name: string) => fixture.cases.find((c) => c.name === name)!.run as RunAuthority
let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
let props: CodeCanvasProps
async function mount(extra: Partial<CodeCanvasProps> = {}) {
  props = { ...props, ...extra }
  await act(async () => { root.render(<CodeCanvas {...props} />) })
  await act(async () => { await Promise.resolve() })
}
const testButton = () => host.findAll(n => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Run the tests on what is saved (⌘;)')[0]
const pill = (label: string) => host.findAll(n => n.tagName === 'BUTTON' && n.textContent === label)[0]
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
  T.toast.mockReset(); T.nativeRun.mockReset(); T.testHook.mockReset(); T.result = null; T.editor = null; T.phone = false
  props = { label: 'small-app', eyebrow: 'Fixture', client: {} as any, ctx: { task_id: 'task', grant_id: 'grant', repository_id: 'small-app' },
    call: vi.fn(), ws: { id: 'ws', generation: 1, tree_digest: 'a'.repeat(64), base_commit: 'fixture-base' }, files: ['app.js'], path: 'app.js',
    file: { path: 'app.js', content: 'x\n', digest: 'file' }, text: 'x\n', dirty: false, busy: null, selection: null,
    onText: vi.fn(), onSelect: vi.fn(), openFile: vi.fn(), save: vi.fn(), onWorkspace: vi.fn(), drawer: vi.fn(() => null),
    onBack: vi.fn(), onClose: vi.fn(), proposalOnly: false }
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k,v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('mounted Canvas native Test: only a command the hive grants', () => {
  it.each(['none-granted', 'proposal-only'])('%s: no Test, no shortcut, and a pill that says why and opens Tests', async (name) => {
    await mount({ runAuthority: answer(name) })
    expect(testButton()).toBeUndefined()
    expect(host.findAll(n => n.tagName === 'BUTTON' && n.textContent?.trim() === 'Test')).toHaveLength(0)
    expect(T.editor.keys['Mod-;']()).toBe(false)
    const why = pill('Tests can’t run here')
    expect(why.getAttribute('title')).toBe(`No command can run here: ${answer(name).why_not}. Open Tests.`)
    await act(async () => press(why))
    expect(props.drawer).toHaveBeenCalledWith('tests', expect.any(Function))
    expect(T.nativeRun).not.toHaveBeenCalled()
  })
  it('runs the one granted command from Test and from its shortcut', async () => {
    await mount({ runAuthority: answer('granted-one') })
    expect(T.testHook).toHaveBeenLastCalledWith(props.call)
    await act(async () => press(testButton()))
    expect(T.nativeRun).toHaveBeenLastCalledWith('the tests', ['make', 'check'])
    await act(async () => { T.editor.keys['Mod-;']() })
    expect(T.nativeRun).toHaveBeenCalledTimes(2)
    expect(pill('Tests can’t run here')).toBeUndefined()
  })
  it('runs the plain python file command among several', async () => {
    await mount({ runAuthority: answer('granted') })
    await act(async () => press(testButton()))
    expect(T.nativeRun).toHaveBeenLastCalledWith('the tests', ['/opt/omegahive/venv/bin/python', 'check_app.py'])
  })
  it('guesses nothing when several commands could be the tests: the pill sends the person to choose', async () => {
    await mount({ runAuthority: { available: true, why_not: null, argv_prefixes: [['make', 'check'], ['npm', 'test']] } })
    expect(testButton()).toBeUndefined()
    expect(pill('Choose a test command').getAttribute('title')).toBe('More than one command may run here: choose one in Tests. Open Tests.')
    expect(T.nativeRun).not.toHaveBeenCalled()
  })
})
