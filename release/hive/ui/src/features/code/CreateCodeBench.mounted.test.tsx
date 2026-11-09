// @vitest-environment node
/** Real ReactDOM mounts/effects on the existing MiniDOM; presentation/transport are doubles.
 * No browser gesture, live admission, service or sandbox qualification. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ client: null as any, toast: vi.fn(), confirm: vi.fn(), canvas: null as any, panel: null as any, principal: 'person:one', admit: vi.fn() }))
vi.mock('../../ui/confirm', () => ({ askConfirm: (...args: any[]) => T.confirm(...args), ConfirmHost: () => null }))
vi.mock('../../lib/router', () => ({ navigate: () => undefined, closeToHome: () => undefined }))
vi.mock('../ask/dirty', () => ({ useUnsaved: () => undefined }))
vi.mock('./canvas/askBridge', () => ({ useAskTurn: () => T.admit }))
vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: any) => children, m: { div: ({ children }: any) => <div>{children}</div> } }))
vi.mock('../../ui/Page', () => ({ Page: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../ui/primitives', () => ({ Button: ({ children, onClick, disabled }: any) => <button onClick={onClick} disabled={disabled}>{children}</button>, EmptyState: ({ title }: any) => <p>{title}</p>, Skeleton: () => null, Orb: () => null }))
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
    {props.drawer('files', () => undefined)}{props.drawer('tests', () => undefined)}{props.banner}
  </section>
} }))

vi.mock('../../ui/DecisionDialog', () => ({ DecisionDialog: (p: any) => <section aria-label="Start confirmation">
  <h2>{p.title}</h2>{p.actions.map((a: any) => <button key={a.label} onClick={() => void a.run()}>{a.label}</button>)}
</section> }))

import CreateCodeBench from './CreateCodeBench'
import { readSession, saveSession } from './savedSession'
import { useHive } from '../../store/store'
import { useAskStore } from '../../store/ask'
const departure = { current: null as null | ((done: () => void) => void) }

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let container: MiniNode, root: Root, doc: MiniDocument
let savedGlobals: Record<string, unknown>
let load: (path: string) => Promise<any>
let workspace: () => Promise<any>
const attachment = { task: 'task-a', repository: 'repo-a', workspace: 'ws-a' }
const onBack = vi.fn(), onClose = vi.fn()
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function mount() {
  await act(async () => root.render(<CreateCodeBench onBack={onBack} departure={departure} />))
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

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  savedGlobals = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage']) savedGlobals[key] = g[key]
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
  const values = new Map<string, string>()
  g.localStorage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) }
  const target = { id: 'repo:repo-a', kind: 'repository', label: 'Invented registered project', detail: 'Invented source', source: '/invented/repo', repository_id: 'repo-a', repo: { root: '/invented/repo', commit: 'commit', branch: 'main', dirty: false, subdir: '' }, owner: 'person:one', private: false, openable: true, apply: { how: 'review', ready: false, note: 'proposal only' } }
  const opened = { target, task_id: attachment.task, repository_id: attachment.repository, grant_id: 'grant-task-a', swarm_id: 'swarm', base_commit: 'commit', workspace_id: attachment.workspace }

  T.client = { authContext: () => auth, onAuthChange: () => () => {}, me: async () => ({ principal: 'person:one' }),
    codeTargets: vi.fn(async () => [target]), codeOpen: vi.fn(async () => opened), codeSelect: vi.fn(async () => opened),
    codeAttach: vi.fn(async (task: string, ws: string, repo: string) => ({
      target: { label: repo, kind: 'repository', repo: null }, task_id: task, grant_id: 'grant-'+task,
      repository_id: repo, swarm_id: 'swarm', base_commit: 'commit', workspace_id: ws })),
    codeProxy: vi.fn(async (method: string, path: string, query: Record<string,string>) => {
      expect(method).toBe('GET')
      if (path.endsWith('/tree')) return { files: [{ path: 'a.py' }, { path: 'b.py' }] }
      if (path.endsWith('/files')) return load(query.path)
      return { ...(await workspace()), id: path.split('/').at(-1) }
    }) }
  useHive.setState({ client: T.client, session: 'invented-create-session', inits: useHive.getState().inits + 1 })
  useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 1, capabilities: { conductor: true, memory: false, code_test_intents: true } } })
})
afterEach(async () => { await act(async () => root.unmount()); container.parentNode?.removeChild(container); for (const [k,v] of Object.entries(savedGlobals)) (globalThis as any)[k] = v })


async function openProject() {
  await mount(); for (let i = 0; i < 8; i++) await flush()
}
describe('Create opens straight into a project and the original Workbench', () => {
  it('explains an empty host target list without inventing or opening a project', async () => {
    T.client.codeTargets.mockResolvedValue([])
    await mount()
    expect(container.textContent).toContain('No project to work on yet')
    expect(T.client.codeOpen).not.toHaveBeenCalled()
    expect(T.client.codeSelect).not.toHaveBeenCalled()
  })
  it('opens the only project at once, with no confirmation and no ids, and attaches only the exact returned task and repository', async () => {
    await openProject()
    expect(container.findAll(n => n.getAttribute('aria-label') === 'Start confirmation')).toHaveLength(0)
    expect(T.client.codeOpen).toHaveBeenCalledTimes(1)
    expect(T.client.codeOpen).toHaveBeenCalledWith('repo:repo-a')
    expect(T.client.codeSelect).toHaveBeenCalledWith('task-a', 'repo-a')
    expect(T.client.codeAttach).not.toHaveBeenCalled()
    expect(T.canvas.ctx).toMatchObject({ task_id: 'task-a', repository_id: 'repo-a' })
    expect(T.canvas.embedded).toBe(true)
    expect(T.canvas.proposalOnly).toBe(true)
    expect(T.canvas.sandboxTestAvailable).toBe(true)
    await click('Open a'); expect(value()).toBe('saved a.py')
    await edit('invented unsaved Create draft')
    T.confirm.mockResolvedValue(false)
    await act(async () => { departure.current!(onBack) }); await flush()
    expect(onBack).not.toHaveBeenCalled()
    expect(value()).toBe('invented unsaved Create draft')
    T.confirm.mockResolvedValue(true)
    await act(async () => { departure.current!(onBack) }); await flush()
    expect(onBack).toHaveBeenCalledTimes(1)
  })
  it('does not mistake installed client methods for the host capability advertisement', async () => {
    await openProject()
    await act(async () => { useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 1, capabilities: { conductor: true, memory: false } } }) })
    expect(T.canvas.sandboxTestAvailable).toBe(false)
    expect(container.textContent).toContain("Testing isn't available on this hive yet")
    expect(T.admit).not.toHaveBeenCalled()
  })
  it('drops a late attachment after the original identity has changed', async () => {
    const pending = deferred<any>()
    T.client.codeOpen.mockReturnValueOnce(pending.promise)
    await mount()
    await act(async () => { useHive.setState({ inits: useHive.getState().inits + 1 }) })
    await act(async () => { pending.resolve({ task_id: 'old-task', repository_id: 'old-repo', grant_id: 'old-grant', target: {}, swarm_id: 'swarm', base_commit: 'commit' }) }); await flush()
    expect(T.client.codeSelect).not.toHaveBeenCalledWith('old-task', 'old-repo')
  })
  it('reuses the task saved in this browser once its grant is this person’s and active, creating nothing', async () => {
    saveSession('person:one', 'repo:repo-a', { task_id: 'g_saved', grant_id: 'grant-task-a', repository_id: 'repo-a', swarm_id: 'swarm', base_commit: 'commit' }, true)
    expect(readSession('person:one', 'repo:repo-a')).toMatchObject({ task_id: 'g_saved' })
    T.client.goalGrants = vi.fn(async () => [{ id: 'grant-task-a', goal_id: 'g_saved', principal: 'person:one', active: true, revoked_at: null, expires_at: Date.now() / 1000 + 3600, scope: 'edit', workspace_id: null }])
    await openProject()
    expect(T.client.goalGrants).toHaveBeenCalledWith('g_saved')
    expect(T.client.codeOpen).not.toHaveBeenCalled()
    expect(T.client.codeSelect).toHaveBeenCalledWith('g_saved', 'repo-a')
  })
  it('opens fresh when the saved grant has ended, and forgets the saved task', async () => {
    saveSession('person:one', 'repo:repo-a', { task_id: 'g_old', grant_id: 'grant-old', repository_id: 'repo-a' }, true)
    T.client.goalGrants = vi.fn(async () => [{ id: 'grant-old', goal_id: 'g_old', principal: 'person:one', active: false, revoked_at: null, expires_at: 1, scope: 'edit', workspace_id: null }])
    await openProject()
    expect(T.client.codeOpen).toHaveBeenCalledWith('repo:repo-a')
    expect(T.canvas.ctx).toMatchObject({ task_id: 'task-a' })
  })
  it('asks which project, one tap and no confirmation, when several are editable and none was used before', async () => {
    const second = { ...(await T.client.codeTargets())[0], id: 'repo:repo-b', label: 'Second invented project', repository_id: 'repo-b' }
    T.client.codeTargets.mockResolvedValue([(await T.client.codeTargets())[0], second])
    await mount(); await flush()
    expect(container.textContent).toContain('What are we working on?')
    expect(T.client.codeOpen).not.toHaveBeenCalled()
    await click('Second invented projectInvented source'); await flush(); await flush()
    expect(T.client.codeOpen).toHaveBeenCalledWith('repo:repo-b')
  })
})
