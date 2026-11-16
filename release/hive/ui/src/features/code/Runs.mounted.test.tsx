// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the store, the panels and the relay */
/** Real ReactDOM mount of the drawer's Tests (CodePage Runs) on the MiniDOM. Each target `run` is the hive's own answer
 * (runAuthority.fixture.json, checked against the hive by hive/tests/test_code_api.py); the relay is a double. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import fixture from './runAuthority.fixture.json'

const T = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../../store/store', () => ({ useHive: (select: any) => select({ client: null, toast: T.toast }) }))
vi.mock('../../ui/confirm', () => ({ askConfirm: () => Promise.resolve(true), ConfirmHost: () => null }))
vi.mock('../../lib/router', () => ({ navigate: () => undefined, closeToHome: () => undefined }))
vi.mock('../ask/dirty', () => ({ useUnsaved: () => undefined }))
vi.mock('./canvas/askBridge', () => ({ useAskTurn: () => vi.fn() }))
vi.mock('../../lib/identityEpoch', () => ({ bindEpoch: () => ({ current: () => true, commit: (f: () => unknown) => f() }) }))
vi.mock('./EditSession', () => ({ usePrincipal: () => 'person:one', NotEditableState: () => null, SessionBar: () => null, StartEditing: () => null, StartTaskDialog: () => null }))
vi.mock('./savedSession', () => ({ readSession: () => null, readWorkspace: () => null, saveSession: () => undefined, saveWorkspaceFor: () => false, dropSessionIf: () => false }))
vi.mock('framer-motion', () => ({ AnimatePresence: ({ children }: any) => children, m: { div: ({ children }: any) => <div>{children}</div> } }))
vi.mock('../../ui/Page', () => ({ Page: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../ui/primitives', () => ({
  Button: ({ children, icon: _i, hue: _h, variant: _v, ...rest }: any) => <button {...rest}>{children}</button>,
  EmptyState: ({ title }: any) => <p>{title}</p>, Skeleton: () => null,
}))
vi.mock('./TargetCard', () => ({ KIND: { repository: { label: 'Repository', icon: 'doc' } }, TargetCard: () => null }))
vi.mock('./LiveWork', () => ({ LiveWork: () => null }))
vi.mock('./EvidenceHistory', () => ({ EvidenceHistory: () => null, RunOutput: () => <p>Run output stand-in</p> }))
vi.mock('./GitExportPanel', () => ({ GitExportPanel: () => null }))
vi.mock('./MergePanel', () => ({ MergePanel: () => null }))
vi.mock('./SymbolicPanel', () => ({ SymbolicPanel: () => null }))
vi.mock('./DebuggerPanel', () => ({ DebuggerPanel: () => null }))
vi.mock('./SourceReview', () => ({ SourceReview: () => null }))
vi.mock('./FileActions', () => ({ FileActions: () => null }))
vi.mock('./suggestions/WorkbenchSuggestionPanel', () => ({ WorkbenchSuggestionPanel: () => null }))
vi.mock('./canvas/CodeCanvas', () => ({ CodeCanvas: () => null }))

import { Runs } from './CodePage'
import type { RunAuthority } from './runAuthority'

const answer = (name: string) => fixture.cases.find((c) => c.name === name)!.run as RunAuthority
const WS = { id: 'ws_1', generation: 3, tree_digest: 'a'.repeat(64), base_commit: 'base' }
let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
let call: ReturnType<typeof vi.fn>

async function mount(authority: RunAuthority | undefined) {
  await act(async () => { root.render(<Runs call={call as any} ws={WS} authority={authority} />) })
  await act(async () => { await Promise.resolve() })
}
const find = (f: (n: MiniNode) => boolean) => host.findAll(f)
const commandInput = () => find((n) => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Command')[0]
const runButton = () => find((n) => n.tagName === 'BUTTON' && /^Run on generation/.test(n.textContent ?? ''))[0]
const typed = async (text: string) => act(async () => { (reactProps(commandInput()).onChange as any)({ target: { value: text } }) })
const submit = async () => act(async () => { (reactProps(find((n) => n.tagName === 'FORM')[0]).onSubmit as any)({ preventDefault: () => undefined }) })

beforeEach(async () => {
  const g = globalThis as any; saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client'); root = createRoot(host as unknown as Element)
  T.toast.mockReset()
  call = vi.fn(async (_method: string, path: string, body?: any) =>
    path === '/v1/runs' ? { id: 'run_1', status: 'succeeded', argv: body.argv, exit_code: 0, generation: 3 } : {})
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('mounted drawer Tests: Run is offered only for what the hive allows', () => {
  it.each(['none-granted', 'proposal-only', 'invalid', 'unreadable-policy'])('%s: says why and offers no command or Run', async (name) => {
    await mount(answer(name))
    const status = find((n) => n.getAttribute('aria-label') === 'No command can run here')[0]
    expect(status.textContent).toContain(`No command can run here: ${answer(name).why_not}.`)
    expect(commandInput()).toBeUndefined()
    expect(runButton()).toBeUndefined()
    expect(host.textContent).not.toContain('pytest -q')
    expect(call).not.toHaveBeenCalled()
  })
  it('an older hive that reports no run is not offered a guessed command either', async () => {
    await mount(undefined)
    expect(host.textContent).toContain('No command can run here: this hive does not say which commands may run.')
    expect(runButton()).toBeUndefined()
  })
  it('with one granted command, fills it in and runs exactly it', async () => {
    await mount(answer('granted-one'))
    expect(reactProps(commandInput()).value).toBe('make check')
    expect(!!reactProps(runButton()).disabled).toBe(false)
    await submit()
    expect(call).toHaveBeenCalledWith('POST', '/v1/runs', expect.objectContaining({ argv: ['make', 'check'], workspace_id: 'ws_1', expected_generation: 3 }))
  })
  it('with several, fills in the plain python file command and lists every allowed one as a choice', async () => {
    await mount(answer('granted'))
    expect(reactProps(commandInput()).value).toBe('/opt/omegahive/venv/bin/python check_app.py')
    const allowed = find((n) => n.getAttribute('aria-label') === 'Allowed commands')[0]
    const choices = allowed.findAll((n) => n.tagName === 'BUTTON').map((n) => n.textContent)
    expect(choices).toEqual(['/opt/omegahive/venv/bin/python check_app.py', 'python3 -m pytest'])
    await act(async () => press(allowed.findAll((n) => n.tagName === 'BUTTON')[1]))
    expect(reactProps(commandInput()).value).toBe('python3 -m pytest')
  })
  it('refuses a typed command outside the grant before sending it, and allows arguments after a granted one', async () => {
    await mount(answer('granted'))
    await typed('python3 -m pip install evil')
    expect(find((n) => n.getAttribute('role') === 'alert')[0].textContent).toBe('This command does not begin with an allowed command, so it would be refused.')
    expect(!!reactProps(runButton()).disabled).toBe(true)
    await submit()
    expect(call).not.toHaveBeenCalled()
    await typed('python3 -m pytest -q tests/test_app.py')
    expect(!!reactProps(runButton()).disabled).toBe(false)
    await submit()
    expect(call).toHaveBeenCalledWith('POST', '/v1/runs', expect.objectContaining({ argv: ['python3', '-m', 'pytest', '-q', 'tests/test_app.py'] }))
  })
})
