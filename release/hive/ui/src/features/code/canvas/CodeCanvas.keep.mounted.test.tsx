// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the client, the session and the dialog */
/** The full Code page's card, mounted in the real CodeCanvas on the existing MiniDOM, with the vibe session a double:
 * each change's Keep is a tick box that is ticked while the change is kept, and unticking it skips that change.
 * Synthetic data only. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, reactProps, type MiniNode } from '../../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ toast: vi.fn(), vibe: null as any, turnOpts: null as any }))
vi.mock('../../../store/store', () => ({ useHive: (select: any) => select({ agents: {}, toast: T.toast }), hiveBus: { on: () => () => undefined } }))
vi.mock('../../../lib/decisionGate', () => ({ bindTo: () => ({ kind: 'ready' }) }))
vi.mock('../../../lib/hooks', () => ({ useReducedMotion: () => true, useMediaQuery: () => false, useEscape: () => undefined, isTypingTarget: () => false }))
vi.mock('../../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../../ui/DecisionDialog', () => ({ DecisionDialog: () => null }))
vi.mock('../../ask/view', () => ({ useAskView: () => undefined }))
vi.mock('../../ask/fields', () => ({ useAskFillable: () => ({}) }))
vi.mock('./askBridge', () => ({ useAskRoom: () => ({ room: 0, present: false }), useAskSend: () => vi.fn(), useAskTurn: (o: unknown) => { T.turnOpts = o; return vi.fn() } }))
vi.mock('./features', () => ({ identity: () => 'fixture', useCodeFeatures: () => ({ key: 'fixture', status: 'ready', features: new Set() }) }))
vi.mock('./useTestRun', () => ({ useTestRun: () => ({ state: { kind: 'idle' }, run: vi.fn() }) }))
vi.mock('./useLanguage', () => ({ useLanguage: () => ({ offer: {}, rename: null, completion: null, note: null }) }))
vi.mock('./languageSession', () => ({ renameViews: () => [] }))
vi.mock('./LanguageParts', () => ({ CompletionList: () => null, DefinitionChooser: () => null, RenameCard: () => null, RenamePrompt: () => null }))
vi.mock('./Minimap', () => ({ Minimap: () => null }))
vi.mock('./IterationsDrawer', () => ({ Iterations: () => null }))
vi.mock('./MergeReviewCard', () => ({ MergeReviewCard: () => null }))
vi.mock('./useVibe', () => ({ useVibe: () => T.vibe }))
vi.mock('../Editor', () => ({ Editor: () => <div aria-label="Mounted editor stand-in" /> }))
import { CodeCanvas, type CodeCanvasProps } from './CodeCanvas'

const HEX = (c: string) => c.repeat(64)
const HELPER = 'a_3f69c61d422c5fc5621211adfc8fb5da'
const SUGGESTION = 'suggestion_' + 'd'.repeat(32)
// the hive records a request helper's proposal under its bare mind id (minds.py claims actor)
const read = { currency: 'current', record: { id: SUGGESTION, digest: HEX('b'), author: HELPER },
  content: { digest: HEX('c'), binding: { generation: 1, tree_digest: HEX('a') }, hunks: [{ id: 'h1', path: 'app.js' }] } }
const placed = [{ id: 'h1', from: 0, to: 5, before: 'old', after: 'new', line: 2, lastLine: 2, col16: 0, words: 'adds a Reset button' }]
const result = { request: 1, instruction: 'Add a Reset button', scope: { path: 'app.js', lines: null },
  file: { path: 'app.js', digest: 'file' }, read, integrity: { digest: HEX('b'), ok: true, problems: [] }, placed, elsewhere: [],
  sent: { request_id: 'rq_fixture', workspace_id: 'ws' } }
const headline = (mind: string) => ({ headline: `${mind} proposes 1 change to app.js (line 2).`, lines: [], why: '' })
function vibe(over: Record<string, unknown> = {}) {
  return { phase: { kind: 'review' }, read, result, instruction: result.instruction, scope: result.scope, integrity: result.integrity,
    route: { team: 'Create · Code', request_id: 'rq_fixture', copyApply: 'off' }, placed, elsewhere: [], onFile: true,
    staged: { h1: 'accept' }, presence: {}, changeViews: [], note: null, pending: null, reviewing: null, blockedWhy: null,
    summary: { text: vi.fn(headline) }, lands: 'confirm', verify: null,
    review: vi.fn(), ask: vi.fn(async () => undefined), choose: vi.fn(), finish: vi.fn(), reset: vi.fn(), setReviewing: vi.fn(),
    send: vi.fn(async () => true), facts: () => [], undo: vi.fn(), recheck: vi.fn(), undoing: null, applied: null, setNote: vi.fn(), ...over }
}

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>, props: CodeCanvasProps
async function mount(extra: Partial<CodeCanvasProps> = {}) {
  props = { ...props, ...extra }
  await act(async () => { root.render(<CodeCanvas {...props} />); await Promise.resolve() })
}
const card = () => host.findAll(n => n.tagName === 'ASIDE')[0]
const button = (name: string) => host.findAll(n => n.tagName === 'BUTTON' && n.textContent === name)[0]
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
  T.toast.mockReset(); T.vibe = vibe(); T.turnOpts = null
  props = { label: 'small-app', eyebrow: 'Fixture', client: {} as any, ctx: { task_id: 'task', grant_id: 'grant', repository_id: 'repo' },
    call: vi.fn() as any, ws: { id: 'ws', generation: 1, tree_digest: HEX('a'), base_commit: 'fixture-base' },
    files: ['README.md', 'app.js', 'index.html', 'style.css'], path: 'app.js', file: { path: 'app.js', content: 'const app = 1\n', digest: 'file' },
    text: 'const app = 1\n', dirty: false, busy: null, selection: null, onText: vi.fn(), onSelect: vi.fn(), openFile: vi.fn(),
    save: vi.fn(), onWorkspace: vi.fn(), drawer: () => null, onBack: vi.fn(), onClose: vi.fn() }
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('Keep is a tick box, ticked while the change is kept', () => {
  const box = () => card().findAll(n => n.tagName === 'INPUT' && reactProps(n).type === 'checkbox')
  it('ticked while kept; unticking skips that change', async () => {
    await mount()
    expect(box().map(n => [n.getAttribute('aria-label'), reactProps(n).checked])).toEqual([['Keep change 1', true]])
    expect(card().findAll(n => n.tagName === 'BUTTON' && /^(Keep|Skipped)$/.test(n.textContent ?? ''))).toHaveLength(0)
    await act(async () => { (reactProps(box()[0]).onChange as () => void)() })
    expect(T.vibe.choose).toHaveBeenLastCalledWith('h1', 'reject')
  })

  it('unticked while skipped, the change struck through; ticking keeps it again', async () => {
    T.vibe = vibe({ staged: { h1: 'reject' } })
    await mount()
    expect(reactProps(box()[0]).checked).toBe(false)
    expect(card().findAll(n => n.tagName === 'LI')[0].getAttribute('data-skip')).not.toBeNull()
    // nothing kept: the card's Accept has nothing to put in
    expect(button('Accept 0, skip 1').getAttribute('disabled')).not.toBeNull()
    await act(async () => { (reactProps(box()[0]).onChange as () => void)() })
    expect(T.vibe.choose).toHaveBeenLastCalledWith('h1', 'accept')
  })
})

