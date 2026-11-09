// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the client, the session and the dialog */
/** The work stream mounted in the real CodeCanvas (Create's bench mode) on the existing MiniDOM. The vibe session is a
 * double with spies, so this pins the wiring: the three actions appear when ready and go to the existing accept /
 * reject paths; Ask for changes discards through reject and then asks again on the same route; the test on a copy is
 * asked for by itself, once per proposal. Synthetic data only. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, reactProps, type MiniNode } from '../../../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ toast: vi.fn(), vibe: null as any, dialog: null as any, listeners: new Set<(e: unknown) => void>() }))
vi.mock('../../../../store/store', () => ({ useHive: (select: any) => select({ agents: {}, toast: T.toast }),
  hiveBus: { on: (fn: (e: unknown) => void) => { T.listeners.add(fn); return () => { T.listeners.delete(fn) } } } }))
const emitHive = (e: unknown) => { for (const fn of [...T.listeners]) fn(e) }
vi.mock('../../../../lib/decisionGate', () => ({ bindTo: () => ({ kind: 'ready' }) }))
vi.mock('../../../../lib/hooks', () => ({ useReducedMotion: () => true, useMediaQuery: () => false, useEscape: () => undefined, isTypingTarget: () => false }))
vi.mock('../../../../ui/Icon', () => ({ Icon: () => null }))
vi.mock('../../../../ui/DecisionDialog', () => ({ DecisionDialog: (props: any) => { T.dialog = props; return null } }))
vi.mock('../../../ask/view', () => ({ useAskView: () => undefined }))
vi.mock('../../../ask/fields', () => ({ useAskFillable: () => ({}) }))
vi.mock('../askBridge', () => ({ useAskRoom: () => ({ room: 0, present: false }), useAskSend: () => vi.fn(), useAskTurn: () => vi.fn() }))
vi.mock('../features', () => ({ identity: () => 'fixture', useCodeFeatures: () => ({ key: 'fixture', status: 'ready', features: new Set() }) }))
vi.mock('../useTestRun', () => ({ useTestRun: () => ({ state: { kind: 'idle' }, run: vi.fn() }) }))
vi.mock('../useLanguage', () => ({ useLanguage: () => ({ offer: {}, rename: null, completion: null, note: null }) }))
vi.mock('../languageSession', () => ({ renameViews: () => [] }))
vi.mock('../LanguageParts', () => ({ CompletionList: () => null, DefinitionChooser: () => null, RenameCard: () => null, RenamePrompt: () => null }))
vi.mock('../Minimap', () => ({ Minimap: () => null }))
vi.mock('../IterationsDrawer', () => ({ Iterations: () => null }))
vi.mock('../MergeReviewCard', () => ({ MergeReviewCard: () => null }))
vi.mock('../useVibe', () => ({ useVibe: () => T.vibe }))
vi.mock('../../Editor', () => ({ Editor: () => <div aria-label="Mounted editor stand-in" /> }))
import { CodeCanvas, type CodeCanvasProps } from '../CodeCanvas'

const HEX = (c: string) => c.repeat(64)
const SUGGESTION = 'suggestion_' + 'd'.repeat(32)
const read = { currency: 'current', record: { id: SUGGESTION, digest: HEX('b'), author: 'agent:helper' },
  content: { digest: HEX('c'), binding: { generation: 1, tree_digest: HEX('a') }, hunks: [{ id: 'h1', path: 'calc.py' }] } }
const placed = [{ id: 'h1', from: 0, to: 5, before: 'a - b', after: 'a + b', line: 2, lastLine: 2, col16: 0, words: 'a - b becomes a + b' }]
const result = { request: 1, instruction: 'Fix add() in the calculator', scope: { path: 'calc.py', lines: { first: 1, last: 2 }, fn: 'add' },
  file: { path: 'calc.py', digest: 'file' }, read, integrity: { digest: HEX('b'), ok: true, problems: [] }, placed, elsewhere: [],
  sent: { request_id: 'rq_fixture', workspace_id: 'ws' } }
function vibe(over: Record<string, unknown> = {}) {
  return { phase: { kind: 'review' }, read, result, instruction: result.instruction, scope: result.scope, integrity: result.integrity,
    route: { team: 'Code team', request_id: 'rq_fixture', copyApply: 'off' }, placed, elsewhere: [], onFile: true,
    staged: { h1: 'accept' }, presence: {}, changeViews: [], note: null, pending: null, reviewing: null, blockedWhy: null,
    summary: { text: () => ({ headline: 'helper proposes one change.', lines: [], why: '' }) }, lands: 'confirm', verify: null,
    review: vi.fn(), ask: vi.fn(async () => undefined), choose: vi.fn(), finish: vi.fn(), reset: vi.fn(), setReviewing: vi.fn(),
    send: vi.fn(async () => true), facts: () => [], undo: vi.fn(), recheck: vi.fn(), undoing: null, applied: null, setNote: vi.fn(), ...over }
}

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>, props: CodeCanvasProps
async function mount(extra: Partial<CodeCanvasProps> = {}) {
  props = { ...props, ...extra }
  await act(async () => root.render(<CodeCanvas {...props} />))
  await act(async () => { await Promise.resolve() })
}
const stream = () => host.findAll(n => n.tagName === 'SECTION' && n.getAttribute('aria-label') === 'The work on your request')[0]
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
  T.toast.mockReset(); T.vibe = vibe(); T.dialog = null
  props = { label: 'Calculator', eyebrow: 'Fixture', client: {} as any, ctx: { task_id: 'task', grant_id: 'grant', repository_id: 'repo' },
    call: vi.fn(async () => { throw new Error('no evidence in this fixture') }), ws: { id: 'ws', generation: 1, tree_digest: HEX('a'), base_commit: 'fixture-base' },
    files: ['calc.py'], path: 'calc.py', file: { path: 'calc.py', content: 'def add(a, b):\n    return a - b\n', digest: 'file' },
    text: 'def add(a, b):\n    return a - b\n', dirty: false, busy: null, selection: null, onText: vi.fn(), onSelect: vi.fn(), openFile: vi.fn(),
    save: vi.fn(), onWorkspace: vi.fn(), drawer: () => null, onBack: vi.fn(), onClose: vi.fn(), proposalOnly: true, embedded: true, sandboxTestAvailable: false }
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('the work stream on the Create bench', () => {
  it('shows the timeline and exactly three actions when ready; Apply and Discard use the existing accept / reject paths', async () => {
    await mount()
    const s = stream()
    expect(s).toBeTruthy()
    expect(s.findAll(n => n.tagName === 'OL')[0].findAll(n => n.tagName === 'LI' && n.hasAttribute('data-key')).map(n => n.getAttribute('data-key'))).toEqual(['ask', 'mind', 'change', 'test', 'review', 'ready'])
    const group = s.findAll(n => n.getAttribute('role') === 'group' && n.getAttribute('aria-label') === 'Your decision')[0]
    expect(group.findAll(n => n.tagName === 'BUTTON').map(n => n.textContent)).toEqual(['Discard', 'Ask for changes', 'Apply'])
    expect(s.textContent).toContain('“Fix add() in the calculator”')
    expect(s.textContent).toContain('Proposes one change in calc.py')
    // the legacy Accept / Reject / Later row is not shown alongside
    expect(button('Accept')).toBeUndefined(); expect(button('Later')).toBeUndefined()
    // the per-change Keep stays where it lives (inside the change step)
    expect(s.findAll(n => n.tagName === 'BUTTON' && n.textContent === 'Keep')).toHaveLength(1)
    await act(async () => press(button('Apply')))
    expect(T.vibe.review).toHaveBeenLastCalledWith()
    await act(async () => press(button('Discard')))
    expect(T.vibe.review).toHaveBeenLastCalledWith('reject')
  })

  it('Apply then confirms through the existing DecisionDialog, whose action is the session send', async () => {
    const reviewing = { request: { suggestion_id: SUGGESTION, suggestion_digest: HEX('b'), expected_generation: 1, expected_tree_digest: HEX('a'), accepted_hunk_ids: ['h1'], rejected_hunk_ids: [], operation_id: 'op' } }
    T.vibe = vibe({ reviewing })
    await mount()
    expect(T.dialog?.title).toBe('Accept 1 change')
    // while the confirm is open, the stream's actions wait
    expect(button('Apply').getAttribute('disabled')).not.toBeNull()
    await act(async () => { await T.dialog.actions[0].run() })
    expect(T.vibe.send).toHaveBeenCalledWith(reviewing)
  })

  it('Apply is held while the proposal cannot be decided, and says why', async () => {
    T.vibe = vibe({ blockedWhy: 'calc.py changed since this was proposed. Ask again on the current code.' })
    await mount()
    expect(button('Apply').getAttribute('disabled')).not.toBeNull()
    expect(stream().textContent).toContain('calc.py changed since this was proposed')
  })

  it('Ask for changes discards through reject, then asks again on the same route with the note (round 2)', async () => {
    await mount()
    await act(async () => press(button('Ask for changes')))
    const input = host.findAll(n => n.tagName === 'INPUT')[0]
    expect(input).toBeTruthy()
    await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: 'keep the docstring' } }) })
    const form = host.findAll(n => n.tagName === 'FORM' && n.getAttribute('class') === 'ws-ask')[0]
    T.vibe = vibe({ reviewing: { request: { suggestion_id: SUGGESTION, accepted_hunk_ids: [], rejected_hunk_ids: ['h1'] } }, review: T.vibe.review, ask: T.vibe.ask })
    await act(async () => { (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    expect(T.vibe.review).toHaveBeenLastCalledWith('reject')
    await mount()
    expect(T.vibe.ask).not.toHaveBeenCalled()
    // the reject is recorded: kept nothing → the new round goes out
    T.vibe = vibe({ phase: { kind: 'done', kept: 0, skipped: 1 }, review: T.vibe.review, ask: T.vibe.ask })
    await mount()
    expect(T.vibe.ask).toHaveBeenCalledTimes(1)
    expect(T.vibe.ask.mock.calls[0][0]).toBe('Fix add() in the calculator\n\nChanges asked for: keep the docstring')
    // the round shows in the timeline
    T.vibe = vibe({ phase: { kind: 'working', step: 'mind' }, read: null, result: null, integrity: null, instruction: T.vibe.ask.mock.calls[0][0], placed: [], review: T.vibe.review, ask: T.vibe.ask })
    await mount()
    expect(stream().textContent).toContain('Round 2')
    expect(stream().textContent).toContain('Changes asked for: keep the docstring')
    expect(T.vibe.ask).toHaveBeenCalledTimes(1)
  })

  it('a cancelled discard asks nothing again', async () => {
    await mount()
    await act(async () => press(button('Ask for changes')))
    const input = host.findAll(n => n.tagName === 'INPUT')[0]
    await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: 'smaller' } }) })
    const form = host.findAll(n => n.tagName === 'FORM' && n.getAttribute('class') === 'ws-ask')[0]
    T.vibe = vibe({ reviewing: { request: { suggestion_id: SUGGESTION, accepted_hunk_ids: [], rejected_hunk_ids: ['h1'] } }, review: T.vibe.review, ask: T.vibe.ask })
    await act(async () => { (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    await mount()
    T.vibe = vibe({ review: T.vibe.review, ask: T.vibe.ask }) // the confirm closed without a decision
    await mount()
    T.vibe = vibe({ phase: { kind: 'done', kept: 0, skipped: 1 }, review: T.vibe.review, ask: T.vibe.ask })
    await mount()
    expect(T.vibe.ask).not.toHaveBeenCalled()
  })

  it('asks for the test on a copy by itself, once per proposal, through the registered sandbox path', async () => {
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    await mount({ sandboxTestAvailable: true, onSandboxTest: callback })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0][2]).toEqual({ request_id: 'rq_fixture', proposal: { proposal_id: SUGGESTION, proposal_digest: 'sha256:' + HEX('b'), normalized_hunks_digest: 'sha256:' + HEX('c') }, parent: { generation: 1, tree_digest: 'sha256:' + HEX('a') } })
    await mount({ text: props.text }) // a re-render
    await mount()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(stream().textContent).toMatch(/Waiting for the test run to start|Asking for a test run/)
  })

  it('never asks for a test while the proposal is unverified, or where tests are not available', async () => {
    const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
    T.vibe = vibe({ result: { ...result, integrity: { digest: HEX('b'), ok: false, problems: ['digest mismatch'] } }, integrity: { digest: HEX('b'), ok: false, problems: ['digest mismatch'] } })
    await mount({ sandboxTestAvailable: true, onSandboxTest: callback })
    expect(callback).not.toHaveBeenCalled()
    expect(stream().textContent).toContain('did not pass its integrity check')
    T.vibe = vibe()
    await mount({ sandboxTestAvailable: false })
    expect(callback).not.toHaveBeenCalled()
    expect(stream().textContent).toContain('Tests can’t run here')
  })

  it('the full canvas outside Create keeps the existing card (no stream)', async () => {
    await mount({ proposalOnly: false, embedded: false })
    expect(stream()).toBeUndefined()
    expect(button('Accept')).toBeTruthy()
  })

  describe('when the engine drives the request', () => {
    const view = (over: Record<string, unknown> = {}) => ({ request_id: 'rq_fixture', engine: 'metta-coding-controller/3', phase: 'green', status: 'ready_for_you', candidate: SUGGESTION, review: 'not_configured', max_repairs: 3,
      test: { state: 'done', tested: true, command_outcome: 'succeeded', exit_code: 0, logs: { stdout: { text: '== 1 passed in 0.01s ==', classification: 'untrusted' } } }, journal: [], effects: [], ...over })
    const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
    it('Apply, Discard and Ask for changes go only through its person routes; no old path, no sandbox test of ours', async () => {
      const client = { requestController: vi.fn(async () => view()), requestApply: vi.fn(async () => ({})), requestDiscard: vi.fn(async () => ({})), requestChanges: vi.fn(async () => ({})) }
      const callback = vi.fn<NonNullable<CodeCanvasProps['onSandboxTest']>>(async () => undefined)
      await mount({ client: client as any, sandboxTestAvailable: true, onSandboxTest: callback })
      await flush()
      expect(client.requestController).toHaveBeenCalledWith('rq_fixture')
      expect(stream().textContent).toContain('1 passed in 0.01s')
      expect(stream().textContent).toContain('Review isn’t set up yet')
      await act(async () => press(button('Apply')))
      await flush()
      expect(client.requestApply).toHaveBeenCalledWith('rq_fixture')
      await act(async () => press(button('Discard')))
      await flush()
      expect(client.requestDiscard).toHaveBeenCalledWith('rq_fixture')
      await act(async () => press(button('Ask for changes')))
      const input = host.findAll(n => n.tagName === 'INPUT')[0]
      await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: 'keep the docstring' } }) })
      const form = host.findAll(n => n.tagName === 'FORM' && n.getAttribute('class') === 'ws-ask')[0]
      await act(async () => { (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
      await flush()
      expect(client.requestChanges).toHaveBeenCalledWith('rq_fixture', 'keep the docstring')
      expect(T.vibe.review).not.toHaveBeenCalled()
      expect(T.vibe.ask).not.toHaveBeenCalled()
      expect(callback).not.toHaveBeenCalled()
      // each answered route re-reads the engine's state
      expect(client.requestController.mock.calls.length).toBeGreaterThanOrEqual(4)
    })
    it('without its person routes: the buttons stay, disabled, with one calm line, and no old-path fallback', async () => {
      const client = { requestController: vi.fn(async () => view()) }
      await mount({ client: client as any })
      await flush()
      for (const name of ['Apply', 'Discard', 'Ask for changes']) expect(button(name).getAttribute('disabled'), name).not.toBeNull()
      expect(stream().textContent).toContain('Apply arrives here as soon as this hive offers it.')
      expect(T.vibe.review).not.toHaveBeenCalled()
    })
    const offers = (apply: { available: boolean; why_not: string | null }) => [
      { name: 'apply', label: 'Apply', method: 'POST', path: '/api/requests/rq_fixture/controller/apply', body: {}, ...apply },
      { name: 'changes', label: 'Ask for changes', method: 'POST', path: '/api/requests/rq_fixture/controller/changes', body: { text: 'string, 1-4000 characters' }, available: true, why_not: null },
      { name: 'discard', label: 'Discard', method: 'POST', path: '/api/requests/rq_fixture/controller/discard', body: {}, available: true, why_not: null }]
    it('Apply the engine does not offer now: disabled, with its reason as the one line; the others stay', async () => {
      const client = { requestController: vi.fn(async () => view({ status: 'review_unavailable', review: 'unavailable', actions: offers({ available: false, why_not: 'applying is off on this hive' }) })), requestApply: vi.fn(), requestDiscard: vi.fn(async () => ({})), requestChanges: vi.fn(async () => ({})) }
      await mount({ client: client as any })
      await flush()
      expect(button('Apply').getAttribute('disabled')).not.toBeNull()
      expect(button('Discard').getAttribute('disabled')).toBeNull()
      expect(button('Ask for changes').getAttribute('disabled')).toBeNull()
      expect(stream().textContent).toContain('Applying is off on this hive.')
      expect(stream().textContent).toContain('A second opinion isn’t available right now')
      // no handler at all: there is nothing to press
      expect(() => press(button('Apply'))).toThrow('nothing to press')
      expect(client.requestApply).not.toHaveBeenCalled()
    })
    it('a refused Apply (copy_apply_off) says so in plain words, as one alert line', async () => {
      const { ApiError } = await import('../../../../api/client')
      const client = { requestController: vi.fn(async () => view({ actions: offers({ available: true, why_not: null }) })),
        requestApply: vi.fn(async () => { throw new ApiError(503, 'copy_apply_off', 'applying is off on this hive (HIVE_COPY_APPLY_CLAIMS)') }), requestDiscard: vi.fn(), requestChanges: vi.fn() }
      await mount({ client: client as any })
      await flush()
      await act(async () => press(button('Apply')))
      await flush()
      expect(client.requestApply).toHaveBeenCalledWith('rq_fixture')
      const alerts = stream().findAll(n => n.getAttribute('role') === 'alert')
      expect(alerts.map(n => n.textContent)).toEqual(['Applying isn’t switched on for this project yet.'])
      expect(stream().textContent).not.toMatch(/copy_apply|HIVE_|503/)
      expect(T.vibe.review).not.toHaveBeenCalled()
    })
    it('a 404 (no controller run, an older host): the canvas’s existing paths, as today', async () => {
      const { ApiError } = await import('../../../../api/client')
      const client = { requestController: vi.fn(async () => { throw new ApiError(404, 'not_found', 'no controller run') }) }
      await mount({ client: client as any })
      await flush()
      await act(async () => press(button('Apply')))
      expect(T.vibe.review).toHaveBeenLastCalledWith()
    })
    it('code.controller.applied for this request: the workbench reads the applied paths again (once per application)', async () => {
      const client = { requestController: vi.fn(async () => view({ status: 'applied', phase: 'delivered' })), requestApply: vi.fn() }
      await mount({ client: client as any })
      await flush()
      const reads = client.requestController.mock.calls.length
      const applied = { type: 'code.controller.applied', at: '2026-11-08T10:00:00Z', request_id: 'rq_fixture', candidate: SUGGESTION, workspace_id: 'ws',
        paths: ['calc.py'], application_id: 'application_' + 'e'.repeat(32), after: { generation: 2, tree_digest: HEX('f') } }
      await act(async () => { emitHive(applied); emitHive(applied) })
      await flush()
      expect(props.onWorkspace).toHaveBeenCalledTimes(1)
      expect(props.onWorkspace).toHaveBeenCalledWith({ id: 'ws', generation: 2, tree_digest: HEX('f'), base_commit: 'fixture-base' }, ['calc.py'])
      expect(client.requestController.mock.calls.length).toBeGreaterThan(reads)
      // another request, another workspace, or no head after: nothing is re-read
      await act(async () => {
        emitHive({ ...applied, request_id: 'rq_other', application_id: 'application_' + '1'.repeat(32) })
        emitHive({ ...applied, workspace_id: 'ws_other', application_id: 'application_' + '2'.repeat(32) })
        emitHive({ ...applied, after: null, application_id: 'application_' + '3'.repeat(32) })
      })
      expect(props.onWorkspace).toHaveBeenCalledTimes(1)
      expect(stream().textContent).toContain('Applied to your copy')
    })
    it('an older host (untyped notices only): code.controller re-reads the controller', async () => {
      const client = { requestController: vi.fn(async () => view()), requestApply: vi.fn() }
      await mount({ client: client as any })
      await flush()
      const reads = client.requestController.mock.calls.length
      await act(async () => emitHive({ type: 'code.controller', request_id: 'rq_fixture', status: 'ready_for_you' }))
      await flush()
      expect(client.requestController.mock.calls.length).toBe(reads + 1)
    })
    it('code.controller.status for this request re-reads the controller; the unreviewed ready words show', async () => {
      const client = { requestController: vi.fn(async () => view({ review: 'unavailable', unreviewed: true, review_policy: 'review-waivable', next_action: '(tell confirm-unreviewed-to-apply "x")', actions: offers({ available: true, why_not: null }) })), requestApply: vi.fn(), requestChanges: vi.fn(), requestDiscard: vi.fn() }
      await mount({ client: client as any })
      await flush()
      const reads = client.requestController.mock.calls.length
      await act(async () => emitHive({ type: 'code.controller.status', at: '2026-11-08T10:00:00Z', request_id: 'rq_fixture', status: 'ready_for_you', phase: 'ready', candidate: SUGGESTION }))
      await flush()
      expect(client.requestController.mock.calls.length).toBe(reads + 1)
      // a typed event arrived: the untyped notices fired alongside are not read again
      await act(async () => { emitHive({ type: 'code.controller', request_id: 'rq_fixture', status: 'ready_for_you' }); emitHive({ type: 'code.controller.ready', request_id: 'rq_fixture', candidate: SUGGESTION }) })
      await flush()
      expect(client.requestController.mock.calls.length).toBe(reads + 1)
      expect(stream().textContent).toContain('Not reviewed: your review setting lets you apply without a second opinion')
      expect(stream().textContent).toContain('No one else has checked this change.')
      // beside Apply (kept as "Apply"), plainly
      expect(button('Apply').getAttribute('disabled')).toBeNull()
      expect(stream().findAll(n => n.getAttribute('role') === 'status').map(n => n.textContent)).toContain('Not reviewed. Look it over before you apply.')
    })
    it('while the engine is still testing, the decision waits', async () => {
      const client = { requestController: vi.fn(async () => view({ status: 'testing', phase: 'edited', test: { state: 'journaled' } })), requestApply: vi.fn() }
      await mount({ client: client as any })
      await flush()
      expect(button('Apply')).toBeUndefined()
      expect(stream().textContent).toContain('Testing on a copy…')
    })
  })

  describe('the empty canvas: say it before any file is open', () => {
    const say = async (words: string) => {
      const input = host.findAll(n => n.tagName === 'INPUT' && n.getAttribute('aria-label') === 'Say what should change')[0]
      await act(async () => { (reactProps(input).onChange as (e: unknown) => void)({ target: { value: words } }) })
      const form = host.findAll(n => n.tagName === 'FORM' && n.getAttribute('class') === 'cc-say')[0]
      await act(async () => { (reactProps(form).onSubmit as (e: unknown) => void)({ preventDefault: () => undefined }) })
    }
    beforeEach(() => { T.vibe = vibe({ phase: { kind: 'idle' }, read: null, result: null, integrity: null, instruction: null, route: null, placed: [] }) })
    it('one file named: it opens, and the request goes out on the whole file through vibe.ask', async () => {
      await mount({ files: ['calculator.py', 'README.md'], path: null, file: null, text: '' })
      await say('Fix add() in the calculator')
      expect(props.openFile).toHaveBeenCalledWith('calculator.py')
      expect(T.vibe.ask).not.toHaveBeenCalled()
      await mount({ path: 'calculator.py', file: { path: 'calculator.py', content: 'def add(a, b):\n    return a - b\n', digest: 'file' }, text: 'def add(a, b):\n    return a - b\n' })
      expect(T.vibe.ask).toHaveBeenCalledTimes(1)
      expect(T.vibe.ask.mock.calls[0].slice(0, 2)).toEqual(['Fix add() in the calculator', null])
      await mount()
      expect(T.vibe.ask).toHaveBeenCalledTimes(1)
    })
    it('several or none: the chooser opens with the named files first; picking one asks', async () => {
      await mount({ files: ['README.md', 'a/helpers.py', 'b/helpers.py'], path: null, file: null, text: '' })
      await say('fix helpers')
      expect(props.openFile).not.toHaveBeenCalled()
      const dialog = host.findAll(n => n.getAttribute('aria-label') === 'Open a file')[0]
      expect(dialog.textContent).toContain('Which file did you mean for “fix helpers”?')
      const options = dialog.findAll(n => n.getAttribute('role') === 'option')
      expect(options.slice(0, 2).map(o => o.hasAttribute('data-named'))).toEqual([true, true])
      await act(async () => press(options[1]))
      expect(props.openFile).toHaveBeenCalledWith('b/helpers.py')
      await mount({ path: 'b/helpers.py', file: { path: 'b/helpers.py', content: 'x = 1\n', digest: 'file' }, text: 'x = 1\n' })
      expect(T.vibe.ask.mock.calls[0][0]).toBe('fix helpers')
    })
  })
})
