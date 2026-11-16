// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the client, the session and the dialog */
/** The full Code page's card, mounted in the real CodeCanvas on the existing MiniDOM, with the vibe session a double:
 * once a change is in the copy, See my page shows the copy's index.html, style.css and app.js as one sandboxed page,
 * read at the copy's one generation. Synthetic data only. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ toast: vi.fn(), vibe: null as any, turnOpts: null as any, closeThread: vi.fn() }))
vi.mock('../../../store/store', () => ({ useHive: (select: any) => select({ agents: {}, toast: T.toast }), hiveBus: { on: () => () => undefined } }))
vi.mock('../../../lib/decisionGate', () => ({ bindTo: () => ({ kind: 'ready' }) }))
vi.mock('../../../lib/hooks', () => ({ useReducedMotion: () => true, useMediaQuery: () => false, useEscape: () => undefined, isTypingTarget: () => false }))
vi.mock('../../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../../ui/DecisionDialog', () => ({ DecisionDialog: () => null }))
vi.mock('../../ask/view', () => ({ useAskView: () => undefined }))
vi.mock('../../ask/fields', () => ({ useAskFillable: () => ({}) }))
vi.mock('./askBridge', () => ({ useAskRoom: () => ({ room: 0, present: false }), useAskSend: () => vi.fn(), useAskTurn: (o: unknown) => { T.turnOpts = o; return vi.fn() }, closeAskThread: T.closeThread }))
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
import { PAGE_FORMAT } from './pagePreview'

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
const applied = { kind: 'applied', words: ['Line 2: adds a Reset button'], currency: 'current', authorization: 'consented', acceptedHere: true }
const PAGE = {
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><main id="app"></main><script type="module" src="./app.js"></script></body></html>',
  'style.css': 'body { margin: 2rem; }',
  'app.js': "document.getElementById('app').textContent = 'Tip calculator with a Reset button'",
}

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>, props: CodeCanvasProps, reads: [string, string, unknown][]
async function mount(extra: Partial<CodeCanvasProps> = {}) {
  props = { ...props, ...extra }
  await act(async () => { root.render(<CodeCanvas {...props} />); await Promise.resolve() })
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
const card = () => host.findAll(n => n.tagName === 'ASIDE')[0]
const button = (name: string) => host.findAll(n => n.tagName === 'BUTTON' && n.textContent === name)[0]
// a Code relay double: the workspace at generation 2, and the page's three files at exactly that generation
const relay = (files: Record<string, string> = PAGE, fail?: Error) => vi.fn(async (method: string, path: string, _body?: unknown, query?: Record<string, string>) => {
  reads.push([method, path, query])
  if (fail) throw fail
  if (path === '/v1/workspaces/ws') return { id: 'ws', generation: 2 }
  if (path === '/v1/workspaces/ws/files' && query && query.path in files) return { content: files[query.path], digest: 'd', generation: 2, tree_digest: HEX('e') }
  throw new Error(`no ${path} in this fixture`)
})

beforeEach(async () => {
  const g = globalThis as any; saved = {}; reads = []
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined,
    setTimeout, clearTimeout, innerWidth: 1400, innerHeight: 900, getComputedStyle: () => ({ getPropertyValue: () => '' }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement
  g.IS_REACT_ACT_ENVIRONMENT = true; g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0); g.cancelAnimationFrame = clearTimeout
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client'); root = createRoot(host as unknown as Element)
  T.toast.mockReset(); T.vibe = vibe(); T.turnOpts = null; T.closeThread.mockReset()
  props = { label: 'small-app', eyebrow: 'Fixture', client: {} as any, ctx: { task_id: 'task', grant_id: 'grant', repository_id: 'repo' },
    call: relay() as any, ws: { id: 'ws', generation: 1, tree_digest: HEX('a'), base_commit: 'fixture-base' },
    files: ['README.md', 'app.js', 'index.html', 'style.css'], path: 'app.js', file: { path: 'app.js', content: 'const app = 1\n', digest: 'file' },
    text: 'const app = 1\n', dirty: false, busy: null, selection: null, onText: vi.fn(), onSelect: vi.fn(), openFile: vi.fn(),
    save: vi.fn(), onWorkspace: vi.fn(), drawer: () => null, onBack: vi.fn(), onClose: vi.fn(),
    runAuthority: { available: true, why_not: null, argv_prefixes: [['/venv/bin/python', 'check_app.py']] } }
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('See my page shows the copy as a page once the change is in it', () => {
  const frame = () => host.findAll(n => n.tagName === 'IFRAME')[0]
  it('after Accept: the three files read at the copy’s one generation, as one sandboxed page', async () => {
    T.vibe = vibe({ phase: applied })
    await mount()
    expect(card().textContent).toContain('nothing is online yet')
    await act(async () => press(button('See my page')))
    await flush()
    expect(reads.map(([, path, q]) => (q as any)?.path ? `${path}?${(q as any).path}@${(q as any).expected_generation}` : path)).toEqual([
      '/v1/workspaces/ws', '/v1/workspaces/ws/files?index.html@2', '/v1/workspaces/ws/files?style.css@2', '/v1/workspaces/ws/files?app.js@2'])
    const f = frame()
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('referrerpolicy') ?? f.getAttribute('referrerPolicy')).toBe('no-referrer')
    const html = String(reactProps(f).srcDoc)
    // the frame's CSP comes first, then the page with its style and script inlined
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<main id="app">'))
    expect(html).toContain('Tip calculator with a Reset button')
    expect(html).toContain('body { margin: 2rem; }')
    expect(html).not.toContain('src="./app.js"')
    // an open Ask panel is drawn above every page, so it folds down to its composer, which stays usable: not modal
    expect(T.closeThread).toHaveBeenCalledTimes(1)
    const dialog = host.findAll(n => n.getAttribute('class') === 'cc-page')[0]
    expect([dialog.getAttribute('role'), dialog.getAttribute('aria-modal')]).toEqual(['dialog', null])
    await act(async () => press(host.findAll(n => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Close').slice(-1)[0]))
    expect(frame()).toBeUndefined()
  })

  it('the done card keeps its line whole: its buttons sit on a row of their own, never beside the line', async () => {
    T.vibe = vibe({ phase: { kind: 'done', kept: 1, skipped: 0, change: { generation: 2, paths: ['app.js'] } } })
    await mount()
    const line = card().findAll(n => n.getAttribute('role') === 'status' && (n.textContent ?? '').includes('Kept 1 change'))[0]
    expect(line.textContent).toContain('Your copy is now at generation 2; nothing is online yet.')
    expect(line.findAll(n => n.tagName === 'BUTTON').map(n => n.textContent)).toEqual([''])
    expect(card().findAll(n => n.getAttribute('class') === 'cc-card-row')[0].findAll(n => n.tagName === 'BUTTON').map(n => n.textContent)).toEqual(['Test it', 'See the change', 'See my page'])
  })

  it('never before the change is in, nor for a copy that is not a page', async () => {
    await mount()
    expect(button('See my page')).toBeUndefined()
    T.vibe = vibe({ phase: applied })
    await mount({ files: ['README.md', 'app.js'] })
    expect(button('See my page')).toBeUndefined()
  })

  it('a page whose index.html does not load its style and script says so; a read that fails says why', async () => {
    T.vibe = vibe({ phase: applied })
    await mount({ call: relay({ ...PAGE, 'index.html': '<p>no script</p>' }) as any })
    await act(async () => press(button('See my page')))
    await flush()
    expect(frame()).toBeUndefined()
    expect(host.textContent).toContain(PAGE_FORMAT)
    await mount({ call: relay(PAGE, new Error('the Code service is not answering')) as any })
    await act(async () => press(button('Reload')))
    await flush()
    expect(host.textContent).toContain('Your page couldn’t be read: the Code service is not answering')
  })
})
