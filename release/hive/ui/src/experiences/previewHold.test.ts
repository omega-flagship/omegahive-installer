import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Approval } from '../api/types'

/**
 * UI review 2026-10-12 S5 (TF-01, M01): in a surface-preview build, approving inside Professional, Cosmos, Construct or
 * Flux said "Not confirmed as approved: the hive did not confirm the answer" (Construct: "the hive did not take the
 * answer"), because the preview deliberately hands approvals to the classic Inbox. The hold now says it opened the
 * Inbox, the dialog closes, and nothing claims "approved" or "not confirmed". A release build answers as before.
 * These re-import the real modules under a production env (as reviewGate.test.ts does). INVENTED data only.
 */
vi.mock('../shell/uiVariant', async (orig) => ({ ...(await orig<typeof import('../shell/uiVariant')>()), openGallery: () => undefined }))
vi.mock('../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))
// the dialog's props are what an approval does; the portal itself needs a DOM
let dialog: { actions: { label: string; run: () => Promise<unknown> }[] } | null = null
vi.mock('../ui/DecisionDialog', () => ({
  DecisionDialog: (p: typeof dialog) => {
    dialog = p
    return null
  },
}))

const ask = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap_1', agent_id: 'a_vega01', skill: 'shell', command: '(shell-confirm "ls /srv/scratch")', reason: 'shell always needs a person',
  risk: 'high', status: 'pending', decided_by: null, created_at: '2026-10-05T09:00:00Z', decided_at: null, ...over,
})
const answers: string[] = []
const client = () => ({
  approve: async (id: string) => (answers.push(id), { ...ask(), id, status: 'approved' as const }),
  deny: async (id: string) => (answers.push(id), { ...ask(), id, status: 'denied' as const }),
})

async function buildAs(mode: string) {
  vi.resetModules()
  vi.stubEnv('PROD', true)
  vi.stubEnv('DEV', false)
  vi.stubEnv('MODE', mode)
  vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })
  const sdk = await import('./sdk')
  const { useHive: store } = await import('../store/store')
  store.setState({ client: client() as never, approvals: { ap_1: ask() }, agents: {}, swarms: {}, deciding: {}, toasts: [] })
  return { sdk, store }
}

let clock = 5_000_000
beforeEach(() => {
  answers.length = 0
  dialog = null
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('S5: the surface-preview approval hold is said honestly, never as a failure', () => {
  it('the hold opens the Inbox, says so once, answers nothing, and is recognisably a hold', async () => {
    const { sdk, store } = await buildAs('surface-preview')
    const r = await sdk.useHive.getState().decide('ap_1', 'approve', undefined, store.getState().session)
    expect(answers).toEqual([]) // nothing reached the hive from inside the experience
    expect(window.location.hash).toBe('#/approvals')
    expect(sdk.heldForInbox(r)).toBe(true)
    const t = store.getState().toasts
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ tone: 'info', title: sdk.PREVIEW_HELD_WORDS.title, body: sdk.PREVIEW_HELD_WORDS.body })
    expect(t[0].ttl).toBeGreaterThanOrEqual(8000) // long enough to read once the dialog has closed (the default is 3.5 s)
    expect(`${t[0].title} ${t[0].body}`).not.toMatch(/not confirmed|did not|failed|approved/i)
  })

  it('Professional, Cosmos, Flux (the shared dialog): Approve once closes the dialog; never "Not confirmed as approved"', async () => {
    const { store } = await buildAs('surface-preview')
    const { ApprovalDecision } = await import('./ApprovalDecision')
    const { decisionShown } = await import('../lib/decisionGate')
    const { APPROVAL_UNCONFIRMED } = await import('../lib/approvalDecision')
    renderToStaticMarkup(createElement(ApprovalDecision, { seen: ask(), session: store.getState().session, onClose: () => undefined }))
    for (const label of ['Approve once', 'Deny']) {
      const r = await dialog!.actions.find((a) => a.label === label)!.run()
      expect(r).not.toEqual({ failed: APPROVAL_UNCONFIRMED })
      expect(decisionShown(r as never).kind).toBe('close')
    }
    expect(answers).toEqual([])
  })

  it('Construct: approve, yes says it opened the Inbox; never "did not take the answer", never "approved once"', async () => {
    await buildAs('surface-preview')
    const { run } = await import('./construct/commands')
    const { useC } = await import('./construct/state')
    const { PREVIEW_HELD_WORDS } = await import('./sdk')
    const text = () => useC.getState().console.slice(-12).map((l) => l.segs.map((s) => s.t).join('')).join('\n')
    await run('approve 1')
    clock += 5_000
    await run('yes')
    expect(answers).toEqual([])
    expect(text()).toContain('opened the Inbox')
    expect(text()).toContain(PREVIEW_HELD_WORDS.body)
    expect(text()).not.toMatch(/did not take the answer|approved once/)
  })

  it('a release build does not hold: the SDK answers through the store, and the dialog approves', async () => {
    const { sdk, store } = await buildAs('production')
    expect(sdk.useHive.getState().decide).toBe(store.getState().decide)
    const { ApprovalDecision } = await import('./ApprovalDecision')
    renderToStaticMarkup(createElement(ApprovalDecision, { seen: ask(), session: store.getState().session, onClose: () => undefined }))
    expect(await dialog!.actions.find((a) => a.label === 'Approve once')!.run()).toBe(true)
    expect(answers).toEqual(['ap_1'])
    expect(window.location.hash).toBe('#/')
  })
})
