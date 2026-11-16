// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for the client */
/** The person's review setting row (GET/PUT /api/me/code-controller) on the MiniDOM. Synthetic data only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../../../ui/miniDom.testkit'

const T = vi.hoisted(() => ({ epoch: true }))
vi.mock('../../../../lib/identityEpoch', () => ({ bindEpoch: () => ({ current: () => T.epoch }), askConfirmBound: async () => false }))
vi.mock('../../../../ui/primitives', () => ({
  Switch: ({ checked, onChange, label, disabled }: any) => <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />,
}))
import { ApiError } from '../../../../api/client'
import { ReviewSettingRow } from './ReviewSettingRow'
import { parseReviewPolicy } from './reviewPolicy'

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
const mount = async (client: unknown) => { await act(async () => root.render(<ReviewSettingRow client={client} />)); await flush() }
const toggle = () => host.findAll(n => n.getAttribute('role') === 'switch')[0]

beforeEach(async () => {
  const g = globalThis as any; saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client'); root = createRoot(host as unknown as Element)
  T.epoch = true
})
afterEach(async () => { await act(async () => root.unmount()); host.parentNode?.removeChild(host); for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v })

describe('the review setting row', () => {
  it('parses only the two policies', () => {
    expect(parseReviewPolicy({ review_policy: 'review-required' })).toBe('review-required')
    expect(parseReviewPolicy({ review_policy: 'review-waivable', applies_to: 'new Code requests' })).toBe('review-waivable')
    for (const raw of [null, [], {}, { review_policy: 'sometimes' }, { review_policy: 1 }]) expect(parseReviewPolicy(raw)).toBeNull()
  })
  it('reads on mount: on = review-required, with its label and hint', async () => {
    const client = { codeControllerPrefs: vi.fn(async () => ({ review_policy: 'review-required', applies_to: 'new Code requests' })), setCodeControllerPrefs: vi.fn() }
    await mount(client)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Ask for a second opinion before changes go in')
    expect(host.textContent).toContain('Applies to new requests.')
    expect(client.codeControllerPrefs).toHaveBeenCalledTimes(1)
  })
  it('hidden on an older host (404), an untrusted answer, or a client without the read', async () => {
    await mount({ codeControllerPrefs: async () => { throw new ApiError(404, 'not_found', 'no route') } })
    expect(toggle()).toBeUndefined()
    await mount({ codeControllerPrefs: async () => ({ review_policy: 'maybe' }) })
    expect(toggle()).toBeUndefined()
    await mount({})
    expect(toggle()).toBeUndefined()
  })
  it('a toggle writes the policy; off = review-waivable', async () => {
    const client = { codeControllerPrefs: async () => ({ review_policy: 'review-required' }), setCodeControllerPrefs: vi.fn(async (b: any) => ({ review_policy: b.review_policy, applies_to: 'new Code requests' })) }
    await mount(client)
    await act(async () => press(toggle()))
    await flush()
    expect(client.setCodeControllerPrefs).toHaveBeenCalledWith({ review_policy: 'review-waivable' })
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(host.findAll(n => n.getAttribute('role') === 'alert')).toEqual([])
  })
  it('a failed save says so plainly and reverts', async () => {
    const client = { codeControllerPrefs: async () => ({ review_policy: 'review-required' }), setCodeControllerPrefs: vi.fn(async () => { throw new ApiError(500, 'internal', 'boom') }) }
    await mount(client)
    await act(async () => press(toggle()))
    await flush()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(host.findAll(n => n.getAttribute('role') === 'alert').map(n => n.textContent)).toEqual(['Your setting couldn’t be saved, so it’s back as it was.'])
    expect(host.textContent).not.toMatch(/boom|500|internal/)
  })
  it('after a sign-in change nothing is sent, and the switch is put back', async () => {
    const client = { codeControllerPrefs: async () => ({ review_policy: 'review-required' }), setCodeControllerPrefs: vi.fn() }
    await mount(client)
    T.epoch = false
    await act(async () => press(toggle()))
    await flush()
    expect(client.setCodeControllerPrefs).not.toHaveBeenCalled()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })
})
