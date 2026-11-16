import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../ui/miniDom.testkit'
import type { Approval } from '../api/types'
import { ApiError } from '../api/client'
import { DURABLE_REFUSED_WORDS, GONE_OR_HIDDEN_WORDS, NOT_VISIBLE_WORDS, approvalRefusalWords } from '../lib/approvalRefusal'

/**
 * professional-release r1.1 (Kimi r1 + Platform host-identity r1), the shared approval dialog (Professional, Cosmos,
 * Flux, Construct's dialog), in a RELEASE build:
 * - every standing answer (Allow for 1 hour, Always allow this, Never allow this) is offered only behind the same
 *   `canAnswer` hint (the client's answerApproval); Approve once and Deny always are;
 * - the host's 403 (cannot see the mind; a durable answer by someone neither the mind's owner nor a hive admin) is said
 *   in plain words, in the dialog and its toast: never a generic error, never success.
 * The host is the lock; the hint only hides what it would refuse. INVENTED data only.
 */
vi.mock('../shell/uiVariant', async (orig) => ({ ...(await orig<typeof import('../shell/uiVariant')>()), openGallery: () => undefined }))
vi.mock('../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))
let dialog: { actions: { label: string; run: () => Promise<unknown> }[] } | null = null
vi.mock('../ui/DecisionDialog', () => ({ DecisionDialog: (p: typeof dialog) => { dialog = p; return null } }))

const ask = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap_1', agent_id: 'a_invented', skill: 'shell', command: '(shell-confirm "ls /srv/scratch")', reason: 'shell always needs a person',
  risk: 'high', status: 'pending', decided_by: null, created_at: '2026-10-05T09:00:00Z', decided_at: null, ...over,
})

// a DOM for react-dom, installed once for this file (a late scheduler tick must still find it)
const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
const doc = new MiniDocument()
// followups-r8 (P3): the first test pays this file's cold transform of the store and dialog graph (worst 7750 ms
// measured with six other heavy files in parallel, load 7-8.5: over vitest's 5 s default). A measured, bounded
// per-file timeout, listed in api/sim/simTimeouts.test.ts like the other heavy files.
vi.setConfig({ testTimeout: 23000 })
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  const win = { document: doc, location: { hash: '#/', search: '', pathname: '/' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
  doc.defaultView = win
  Object.assign(g, { window: win, document: doc, HTMLIFrameElement: win.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })
})
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50)) // let react-dom's last scheduled tick run while its DOM is here
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

/** The error class of the modules under test (re-imported after resetModules: a stale class would fail instanceof). */
let HostError: typeof ApiError = ApiError
const roots: { unmount(): void }[] = []
async function release(client: object) {
  vi.resetModules()
  vi.stubEnv('PROD', true)
  vi.stubEnv('DEV', false)
  vi.stubEnv('MODE', 'production')
  HostError = (await import('../api/client')).ApiError
  const { useHive: store } = await import('../store/store')
  store.setState({ client: client as never, approvals: { ap_1: ask() }, agents: {}, swarms: {}, deciding: {}, toasts: [] })
  const { ApprovalDecision } = await import('./ApprovalDecision')
  // mounted (react-dom), not server-rendered: a server render reads the store's INITIAL state (no client)
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(doc.body.appendChild(doc.createElement('div')) as unknown as Element)
  roots.push({ unmount: () => act(() => root.unmount()) })
  await act(async () => root.render(createElement(ApprovalDecision, { current: () => true, seen: ask(), session: store.getState().session, onClose: () => undefined })))
  return { store, labels: dialog!.actions.map((a) => a.label), run: (label: string) => dialog!.actions.find((a) => a.label === label)!.run() }
}
const ok = (id: string) => ({ ...ask(), id, status: 'approved' as const })

const clock = 5_000_000
beforeEach(() => { dialog = null; vi.spyOn(performance, 'now').mockImplementation(() => clock) })
afterEach(() => { roots.splice(0).forEach((r) => r.unmount()); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules() })

describe('standing answers sit behind one gate', () => {
  it('without answerApproval: only Approve once and Deny (no Always, no For an hour, no Never)', async () => {
    const { labels } = await release({ approve: async (id: string) => ok(id), deny: async (id: string) => ok(id), listPolicy: async () => [] })
    expect(labels).toEqual(['Approve once', 'Deny'])
  })
  it('with answerApproval: all five', async () => {
    const { labels } = await release({ approve: async (id: string) => ok(id), deny: async (id: string) => ok(id), answerApproval: async (id: string) => ok(id), listPolicy: async () => [] })
    expect(labels).toEqual(['Approve once', 'Deny', 'Allow for 1 hour', 'Always allow this', 'Never allow this'])
  })
})

describe("the host's 403 is said plainly, never as a generic error or success", () => {
  const refuse = (code: string, status = 403) => async () => { throw new HostError(status, code, 'invented host words') }
  it('a durable answer refused (not the owner, not an admin): the owner/admin sentence, in the dialog and its toast', async () => {
    // the live host's code (host-identity r1 `answerable`): 403 owner_only
    const { store, run } = await release({ approve: refuse('owner_only'), deny: refuse('owner_only'), answerApproval: refuse('owner_only'), listPolicy: async () => [] })
    for (const label of ['Always allow this', 'Allow for 1 hour', 'Never allow this']) {
      store.setState({ toasts: [] })
      const r = await run(label)
      expect(r, label).toEqual({ failed: DURABLE_REFUSED_WORDS })
      expect(store.getState().toasts.at(-1)?.body, label).toBe(DURABLE_REFUSED_WORDS)
      expect(JSON.stringify(store.getState().toasts)).not.toMatch(/invented host words|Not confirmed/)
    }
  })
  it('a once-answer refused (cannot see the mind): the cannot-see sentence', async () => {
    const { store, run } = await release({ approve: refuse('forbidden'), deny: refuse('forbidden'), listPolicy: async () => [] })
    for (const label of ['Approve once', 'Deny']) {
      const r = await run(label)
      expect(r, label).toEqual({ failed: NOT_VISIBLE_WORDS })
      expect(store.getState().toasts.at(-1)?.body).toBe(NOT_VISIBLE_WORDS)
    }
  })
  it("a request the person cannot see (the live host's 404 not_found): gone-or-hidden words, never the host's own", async () => {
    const { store, run } = await release({ approve: refuse('not_found', 404), deny: refuse('not_found', 404), answerApproval: refuse('not_found', 404), listPolicy: async () => [] })
    for (const label of ['Approve once', 'Deny', 'Always allow this']) {
      const r = await run(label)
      expect(r, label).toEqual({ failed: GONE_OR_HIDDEN_WORDS })
      expect(store.getState().toasts.at(-1)?.body, label).toBe(GONE_OR_HIDDEN_WORDS)
    }
    expect(JSON.stringify(store.getState().toasts)).not.toMatch(/invented host words/)
  })
  it('the host code decides when it names the reason; other errors keep their own words', () => {
    expect(approvalRefusalWords(new ApiError(403, 'mind_not_visible', 'x'), 'remember')).toBe(NOT_VISIBLE_WORDS)
    expect(approvalRefusalWords(new ApiError(403, 'owner_or_admin_required', 'x'), 'approve')).toBe(DURABLE_REFUSED_WORDS)
    expect(approvalRefusalWords(new ApiError(403, 'forbidden', 'x'), 'never')).toBe(DURABLE_REFUSED_WORDS)
    expect(approvalRefusalWords(new ApiError(403, 'forbidden', 'x'), 'deny')).toBe(NOT_VISIBLE_WORDS)
    expect(approvalRefusalWords(new ApiError(403, 'owner_only', 'x'), 'remember')).toBe(DURABLE_REFUSED_WORDS)
    expect(approvalRefusalWords(new ApiError(404, 'not_found', 'x'), 'approve')).toBe(GONE_OR_HIDDEN_WORDS)
    expect(approvalRefusalWords(new ApiError(404, 'no_route', 'x'), 'approve')).toBeNull()
    expect(approvalRefusalWords(new ApiError(500, 'boom', 'x'), 'approve')).toBeNull()
    expect(approvalRefusalWords(new Error('x'), 'approve')).toBeNull()
  })
})
