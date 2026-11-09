// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the client, the canvas and the panel */
/** Real ReactDOM mounts/effects on the existing MiniDOM; presentation/transport are doubles.
 * No browser gesture, live admission, service or sandbox qualification. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ client: null as any, toast: vi.fn(), confirm: vi.fn(), canvas: null as any, panel: null as any, principal: 'person:one', admit: vi.fn() }))
vi.mock('../../store/store', () => ({ useHive: (select: any) => select({ client: T.client, toast: T.toast }) }))
vi.mock('../../ui/confirm', () => ({ askConfirm: (...args: any[]) => T.confirm(...args), ConfirmHost: () => null }))
vi.mock('../../lib/router', () => ({ navigate: () => undefined, closeToHome: () => undefined }))
vi.mock('../ask/dirty', () => ({ useUnsaved: () => undefined }))
vi.mock('./canvas/askBridge', () => ({ useAskTurn: () => T.admit }))
vi.mock('../../lib/identityEpoch', () => ({ bindEpoch: () => ({ current: () => true, commit: (f: () => unknown) => f() }) }))
vi.mock('./EditSession', () => ({ usePrincipal: () => T.principal, NotEditableState: () => null, SessionBar: () => null, StartEditing: () => null, StartTaskDialog: () => null }))
vi.mock('./savedSession', () => ({ readSession: () => null, readWorkspace: () => null, saveSession: () => undefined, saveWorkspaceFor: () => false, dropSessionIf: () => false }))
vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: any) => children, m: { div: ({ children }: any) => <div>{children}</div> } }))
vi.mock('../../ui/Page', () => ({ Page: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../ui/primitives', () => ({ Button: ({ children, onClick, disabled }: any) => <button onClick={onClick} disabled={disabled}>{children}</button>, EmptyState: ({ title }: any) => <p>{title}</p>, Skeleton: () => null }))
vi.mock('./TargetCard', () => ({ KIND: { repository: { label: 'Repository', icon: 'doc' } }, TargetCard: () => null }))
vi.mock('./LiveWork', () => ({ LiveWork: () => null }))
vi.mock('./EvidenceHistory', () => ({ EvidenceHistory: () => null, RunOutput: () => null }))
vi.mock('./GitExportPanel', () => ({ GitExportPanel: () => null }))
vi.mock('./MergePanel', () => ({ MergePanel: () => null }))
vi.mock('./SymbolicPanel', () => ({ SymbolicPanel: () => null }))
vi.mock('./DebuggerPanel', () => ({ DebuggerPanel: () => null }))
vi.mock('./SourceReview', () => ({ SourceReview: () => null }))
vi.mock('./FileActions', () => ({ FileActions: () => null }))
vi.mock('./suggestions/WorkbenchSuggestionPanel', () => ({ WorkbenchSuggestionPanel: () => null }))
vi.mock('./suggestions/ProjectTestEvidencePanel', () => ({ ProjectTestEvidencePanel: (props: any) => { T.panel = props; return <p>Selected proposal evidence</p> } }))
vi.mock('./canvas/CodeCanvas', () => ({ CodeCanvas: (props: any) => {
  T.canvas = props
  return <section>
    <textarea aria-label="Mounted editor" value={props.text} onChange={e => props.onText(e.target.value)} />
    <button onClick={() => void props.openFile('a.py')}>Open a</button>
    <button onClick={() => void props.openFile('b.py')}>Open b</button>
    <button onClick={props.onBack}>Back</button>
    <button onClick={props.onClose}>Close</button>
    {props.drawer('files', () => undefined)}{props.drawer('tests', () => undefined)}{props.banner}
  </section>
} }))

import { EmbeddedCodeWorkbench } from './EmbeddedCodeWorkbench'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let container: MiniNode, root: Root, doc: MiniDocument
let savedGlobals: Record<string, unknown>
let load: (path: string) => Promise<any>
let workspace: () => Promise<any>
const attachment = { task: 'task-a', repository: 'repo-a', workspace: 'ws-a' }
const onBack = vi.fn(), onClose = vi.fn()
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function mount(a = attachment, extra = {}) {
  await act(async () => root.render(<EmbeddedCodeWorkbench sandboxTestAvailable attachment={a} onBack={onBack} onClose={onClose} {...extra} />))
  await flush()
}
async function click(text: string) {
  const button = container.findAll(n => n.tagName === 'BUTTON').find(b => b.textContent === text)
  expect(button, text).toBeTruthy()
  await act(async () => { press(button!) })
}
async function edit(text: string) {
  const input = container.findAll(n => n.getAttribute('aria-label') === 'Mounted editor')[0]
  await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: text } }) })
}
function value() { return reactProps(container.findAll(n => n.getAttribute('aria-label') === 'Mounted editor')[0]).value }
function copies() { return container.findAll(n => n.tagName === 'TEXTAREA' && reactProps(n).readOnly === true) }

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  savedGlobals = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) savedGlobals[key] = g[key]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined,
    removeEventListener: () => undefined, location: { hash: '', search: '', pathname: '/' },
    history: { state: null, replaceState: () => undefined, pushState: () => undefined },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  T.confirm.mockReset().mockResolvedValue(true); T.toast.mockReset(); T.admit.mockReset().mockResolvedValue('original-ask-operation'); T.panel = null; onBack.mockReset(); onClose.mockReset()
  load = async path => ({ content: `saved ${path}`, digest: `digest:${path}`, generation: 1, tree_digest: 'd'.repeat(64) })
  workspace = async () => ({ id: 'ws-a', generation: 1, tree_digest: 'd'.repeat(64), base_commit: 'commit' })
  const auth = {}
  T.client = { authContext: () => auth,
    codeAttach: vi.fn(async (task: string, ws: string, repo: string) => ({
      target: { label: repo, kind: 'repository', repo: null }, task_id: task, grant_id: 'grant-'+task,
      repository_id: repo, swarm_id: 'swarm', base_commit: 'commit', workspace_id: ws })),
    codeProxy: vi.fn(async (method: string, path: string, query: Record<string,string>) => {
      expect(method).toBe('GET')
      if (path.endsWith('/tree')) return { files: [{ path: 'a.py' }, { path: 'b.py' }] }
      if (path.endsWith('/files')) return load(query.path)
      return { ...(await workspace()), id: path.split('/').at(-1) }
    }) }
})
afterEach(async () => { await act(async () => root.unmount()); container.parentNode?.removeChild(container); for (const [k,v] of Object.entries(savedGlobals)) (globalThis as any)[k] = v })

describe('mounted embedded controller lifetime and draft recovery', () => {
  it('the embedded X invokes the same dirty departure guard before its parent close callback', async () => {
    await mount(); await click('Open a'); await edit('invented dirty close')
    T.confirm.mockResolvedValue(false)
    await click('Close'); await flush()
    expect(onClose).not.toHaveBeenCalled()
    expect(value()).toBe('invented dirty close')
    T.confirm.mockResolvedValue(true)
    await click('Close'); await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('keeps the actual unsaved text recoverable on attachment replacement', async () => {
    await mount(); await click('Open a'); await edit('my unsaved attachment draft')
    await mount({ task: 'task-b', repository: 'repo-b', workspace: 'ws-b' })
    expect(T.client.codeAttach).toHaveBeenLastCalledWith('task-b', 'ws-b', 'repo-b')
    await click('1 unsaved draft kept in this tab')
    expect(copies().map(x => reactProps(x).value)).toContain('my unsaved attachment draft')
    expect(container.textContent).toContain('task-a')
  })
  it('keeps the latest edit across forced parent unmount and remount', async () => {
    await mount(); await click('Open a'); await edit('recover after parent unmount')
    await act(async () => root.render(null))
    await mount()
    await click('1 unsaved draft kept in this tab')
    expect(reactProps(copies()[0]).value).toBe('recover after parent unmount')
  })
  it('rejects an earlier file reply after a later file has loaded', async () => {
    await mount()
    const a = deferred<any>(), b = deferred<any>()
    load = path => path === 'a.py' ? a.promise : b.promise
    await click('Open a'); await click('Open b')
    await act(async () => b.resolve({ content: 'B', digest: 'B', generation: 1, tree_digest: 'tree' }))
    await act(async () => a.resolve({ content: 'OLD A', digest: 'A', generation: 1, tree_digest: 'tree' }))
    expect(T.canvas.path).toBe('b.py'); expect(value()).toBe('B')
  })
  it('does not overwrite edits made after a file-switch request', async () => {
    await mount(); await click('Open a')
    const b = deferred<any>(); load = () => b.promise
    await click('Open b'); await edit('edited after request')
    await act(async () => b.resolve({ content: 'B', digest: 'B', generation: 1, tree_digest: 'tree' }))
    expect(T.canvas.path).toBe('a.py'); expect(value()).toBe('edited after request')
  })
  it('does not clear a newer draft after reload awaits its workspace', async () => {
    await mount(); await click('Open a'); await edit('before reload')
    const pending = deferred<any>(); workspace = () => pending.promise
    await click('Reload this copy'); await edit('newer than reload')
    await act(async () => pending.resolve({ id: 'ws-a', generation: 2, tree_digest: 'newtree' }))
    expect(value()).toBe('newer than reload'); expect(T.canvas.path).toBe('a.py')
  })
  it('a delayed leave confirmation cannot navigate after parent unmount', async () => {
    await mount(); await click('Open a'); await edit('keep on late confirmation')
    const decision = deferred<boolean>(); T.confirm.mockReturnValue(decision.promise)
    await click('Back'); await act(async () => root.render(null))
    await act(async () => decision.resolve(true))
    expect(onBack).not.toHaveBeenCalled()
    await mount(); expect(container.textContent).toContain('1 unsaved draft kept in this tab')
  })
  it('does not expose another client or sign-in retained draft', async () => {
    await mount(); await click('Open a'); await edit('private local draft')
    T.principal = 'person:other'
    await mount()
    expect(container.textContent).not.toContain('unsaved draft kept')
    expect(copies()[0] ?? null).toBeNull()
    T.principal = 'person:one'
  })
})

it('hands sandbox admission an actual editor/source/lifetime guard and no UTF16 byte claim', async () => {
  let current!: () => boolean
  const done = deferred<void>()
  const handler = vi.fn(async (_what, _selection, _refs, guard) => { current = guard; await done.promise })
  await mount(attachment, { onSandboxTest: handler })
  await click('Open a')
  const references = { request_id: 'rq_retained', proposal: { proposal_id: 'suggestion-retained', proposal_digest: 'digest', normalized_hunks_digest: 'hunks' }, parent: { generation: 1, tree_digest: 'tree' } }
  let pending!: Promise<void>
  await act(async () => { pending = T.canvas.onSandboxTest('the tests', { path: 'a.py', from: 0, to: 2 }, references, () => true) })
  expect(handler).toHaveBeenCalledWith('the tests', undefined, references, expect.any(Function))
  expect(current()).toBe(true)
  await edit('newer than the test request')
  expect(current()).toBe(false)
  done.resolve(); await act(async () => { await pending })
  expect(T.client.codeProxy.mock.calls.every((call: any[]) => call[0] === 'GET')).toBe(true)
})

it('refuses missing retained proposal without a generic run fallback', async () => {
  await mount(); await click('Open a')
  await expect(T.canvas.onSandboxTest('tests')).rejects.toThrow('retained proposed change')
  expect(T.client.codeProxy.mock.calls.every((call: any[]) => call[0] === 'GET')).toBe(true)
})

function exactReferences() {
  return { request_id: 'rq_original', proposal: { proposal_id: 'suggestion_'+'a'.repeat(32), proposal_digest: 'sha256:'+'b'.repeat(64), normalized_hunks_digest: 'sha256:'+'c'.repeat(64) }, parent: { generation: 1, tree_digest: 'sha256:'+'d'.repeat(64) } }
}
function installIntentMethods() {
  const intent = 'ai_'+'f'.repeat(24)
  T.client.askRecordCodeTestIntent = vi.fn(async (_op: string, body: any) => ({ kind: 'code.test', intent_id: intent,
    request_operation_id: 'ask.'+intent, state: 'pending', request: body.request }))
  T.client.askSubmitIntent = vi.fn(async () => ({ schema: 'hive.code-test-intent-receipt/1', kind: 'code.test',
    request_id: 'rq_original', proposal_id: 'suggestion_'+'a'.repeat(32), lease_id: 'lease-original',
    receiving_goal: 'goal-original', controller_id: 'controller-original', message_id: 'message-original',
    state: 'queued', tested: false, accepted_source: false }))
}

it('the mounted default Test path records and submits only the admitted original Ask intent', async () => {
  await mount(); await click('Open a'); installIntentMethods()
  await act(async () => { await T.canvas.onSandboxTest('whole proposal', undefined, exactReferences(), () => true) })
  expect(T.admit).toHaveBeenCalledTimes(1)
  expect(T.client.askRecordCodeTestIntent).toHaveBeenCalledWith('original-ask-operation', {
    kind: 'code.test', request: { request_id: 'rq_original', proposal_id: 'suggestion_'+'a'.repeat(32) } })
  expect(T.client.askSubmitIntent).toHaveBeenCalledWith('ai_'+'f'.repeat(24))
  // embedded (Create): the work stream shows the queued test as its own step; the page says only a problem
  expect(container.textContent).not.toContain('Test request queued.')
  expect(container.textContent).not.toContain('could not be confirmed')
  expect(container.textContent).not.toContain('tests passed')
  expect(T.client.codeProxy.mock.calls.every((call: any[]) => call[0] === 'GET')).toBe(true)
  expect(T.panel.subject).toEqual({ workspace_id: 'ws-a', generation: 1, tree_digest: 'd'.repeat(64),
    proposal_id: 'suggestion_'+'a'.repeat(32), proposal_digest: 'b'.repeat(64), normalized_hunks_digest: 'c'.repeat(64) })
  await act(async () => { await T.panel.call('GET', '/v1/workspaces/ws-a/suggestions/suggestion_'+'a'.repeat(32)+'/project-tests', undefined, { limit: '4', cursor: '0' }) })
  expect(T.client.codeProxy).toHaveBeenLastCalledWith('GET', '/v1/workspaces/ws-a/suggestions/suggestion_'+'a'.repeat(32)+'/project-tests',
    { task_id: 'task-a', grant_id: 'grant-task-a', repository_id: 'repo-a', limit: '4', cursor: '0' }, undefined)
})

it('two mounted Test calls during admission create only one original Ask turn', async () => {
  await mount(); await click('Open a'); installIntentMethods()
  const admitted = deferred<string>(); T.admit.mockReturnValue(admitted.promise)
  let pending!: Promise<void>
  await act(async () => { pending = T.canvas.onSandboxTest('whole proposal', undefined, exactReferences(), () => true) })
  await expect(T.canvas.onSandboxTest('whole proposal', undefined, exactReferences(), () => true)).rejects.toThrow('already being checked')
  expect(T.admit).toHaveBeenCalledTimes(1)
  admitted.resolve('original-ask-operation'); await act(async () => { await pending })
  expect(T.client.askRecordCodeTestIntent).toHaveBeenCalledTimes(1)
})

it('a newer edit during mounted Ask admission prevents intent record and submit', async () => {
  await mount(); await click('Open a'); installIntentMethods()
  const admitted = deferred<string>(); T.admit.mockReturnValue(admitted.promise)
  let pending!: Promise<void>
  await act(async () => { pending = T.canvas.onSandboxTest('whole proposal', undefined, exactReferences(), () => true) })
  await edit('do not clear this newer draft')
  admitted.resolve('original-ask-operation')
  await act(async () => { await pending })
  expect(T.client.askRecordCodeTestIntent).not.toHaveBeenCalled()
  expect(T.client.askSubmitIntent).not.toHaveBeenCalled()
  expect(value()).toBe('do not clear this newer draft')
})

it('unknown mounted record recovery repeats the same attempt without a second Ask', async () => {
  await mount(); await click('Open a'); installIntentMethods()
  const record = T.client.askRecordCodeTestIntent
  record.mockRejectedValueOnce(new Error('PRIVATE_RESPONSE_MUST_NOT_RENDER'))
  await act(async () => { await T.canvas.onSandboxTest('whole proposal', undefined, exactReferences(), () => true) })
  expect(container.textContent).toContain('could not be confirmed')
  expect(container.textContent).not.toContain('PRIVATE_RESPONSE')
  await expect(T.canvas.onSandboxTest('whole proposal', undefined, exactReferences(), () => true)).rejects.toThrow('Check same test request')
  await click('Check same test request')
  expect(T.admit).toHaveBeenCalledTimes(1)
  expect(record).toHaveBeenCalledTimes(2)
  expect(record.mock.calls[0]).toEqual(record.mock.calls[1])
  expect(T.client.askSubmitIntent).toHaveBeenCalledTimes(1)
  // recovered: the problem line is gone (embedded, the queued test is the work stream's own step)
  expect(container.textContent).not.toContain('could not be confirmed')
  expect(container.textContent).not.toContain('Test request queued.')
})
