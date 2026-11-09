import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { HiveClient } from '../../api/client'
import { STALE } from '../../lib/identityEpoch'
import type { DecisionAction } from '../../ui/DecisionDialog'

// Same bounded hook-slot stand-in used by HostConfirm.test.ts. It runs the real
// hook/parser, effects and cleanups; it is not a browser/gesture qualification.
const R = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, ei: 0,
  effects: [] as { deps?: unknown[]; cleanup?: unknown }[], pending: [] as (() => void)[] }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const slot = (init: () => unknown) => { const n = R.i++; if (!(n in R.slots)) R.slots[n] = init(); return n }
  return { ...actual,
    useRef: (v: unknown) => R.slots[slot(() => ({ current: v }))],
    useState: (v: unknown) => {
      const n = slot(() => typeof v === 'function' ? (v as () => unknown)() : v)
      return [R.slots[n], (next: unknown) => { R.slots[n] = typeof next === 'function' ? (next as (old: unknown) => unknown)(R.slots[n]) : next }]
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const n = R.ei++, old = R.effects[n]
      if (!old || !deps || !old.deps || deps.length !== old.deps.length || deps.some((d, k) => !Object.is(d, old.deps![k]))) R.pending.push(() => {
        if (typeof old?.cleanup === 'function') old.cleanup()
        R.effects[n] = { deps, cleanup: fn() }
      })
    },
  }
})
vi.mock('../../ui/DecisionDialog', () => ({ DecisionDialog: () => null }))
vi.mock('./PersonSwarmConsent', () => ({ PersonSwarmCardDetails: () => null }))
vi.mock('../../lib/appBridge', () => ({ MAX_BRIDGE_MESSAGE: 2048 }))

import { useAppLinks } from './AppLinks'

const channel = '11111111-1111-1111-1111-111111111111'
const nextChannel = '22222222-2222-2222-2222-222222222222'
const review = { id: 'review-one', kind: 'app-setup', caller_name: 'Pinned caller', target_name: 'Pinned target', target: 'target-fixture',
  release_digest: 'sha256:' + 'a'.repeat(64), version: '1', approved_revision: '2026-10-26T00:00:00.000001Z',
  template: { program_id: 'target-fixture', program_name: 'Pinned target', template_id: 'helpers', template_digest: 'b'.repeat(64),
    key_id: 'own-key-fixture', month_usd: 10, providers: ['mock'], spend_note: 'Host spending note', consent_revision: null,
    authority_revision: null, minds: [{ slot: 'helper', name: 'Helper', persona: '', model: 'mock/echo', budget_usd: 0 }], rules: [] },
  price_guide: ['Host-only price line'], session_permission: 'may send to and show your Ask while open', related_apps: [] }
const entry = { id: 'host-only-pass', app: 'target-fixture', swarm_id: 'target-only-swarm', name: 'Pinned target', back_name: 'Pinned caller' }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function context() {
  const client = {
    mode: 'live', appLinkFrame: vi.fn().mockResolvedValue({ frame_id: 'frame-one' }), appLinkClose: vi.fn().mockResolvedValue({ closed: true }),
    appLinkPrepare: vi.fn().mockResolvedValue({ review }), appLinkInspect: vi.fn().mockResolvedValue({ review }),
    appLinkDecide: vi.fn().mockResolvedValue({ result: { state: 'ready' } }), appLinkBack: vi.fn(),
    appLinkEntryCard: vi.fn(), appLinkRedeem: vi.fn(), appLinkCheck: vi.fn(),
  }
  let valid = true
  const input = { client: client as unknown as HiveClient, app: 'caller-fixture', swarm: 'caller-swarm', channel,
    binding: { epoch: 1, current: () => valid, commit: <T,>(fn: () => T) => fn() }, person: true, documentReady: true,
    current: () => valid, visible: () => true, modal: () => false, post: vi.fn(), navigate: vi.fn() }
  return { client, input, invalidate: () => { valid = false } }
}
function render(input: Parameters<typeof useAppLinks>[0]) {
  R.i = 0; R.ei = 0
  const hook = useAppLinks(input)
  for (const effect of R.pending.splice(0)) effect()
  return hook
}
type Dialog = { onClose(): void; actions: DecisionAction[] }
const dialog = (hook: ReturnType<typeof useAppLinks>) => (hook.controls as ReactElement<Dialog>).props
beforeEach(() => {
  R.slots = []; R.effects = []; R.pending = []; R.i = 0; R.ei = 0
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis)
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
})
afterEach(() => {
  for (const effect of R.effects) if (typeof effect?.cleanup === 'function') effect.cleanup()
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('real P12/P13 parent hook, synthetic API and explicit host decisions', () => {
  it('does not turn a frame-approved/isTrusted flag into a host confirmation', async () => {
    const t = context(), hook = render(t.input); await flush()
    expect(await hook.receive({ type: 'app-setup', id: 's1', app: 'target-fixture', approved: true, isTrusted: true })).toEqual({ type: 'app-setup-result', id: 's1', state: 'refused', reason: 'not_available' })
    expect(t.client.appLinkPrepare).not.toHaveBeenCalled(); expect(t.client.appLinkDecide).not.toHaveBeenCalled()
  })
  it('reuses the same pending card and returns only state to every waiter', async () => {
    const t = context(); let hook = render(t.input); await flush()
    const a = hook.receive({ type: 'app-setup', id: 's1', app: 'target-fixture' })!
    const b = hook.receive({ type: 'app-setup', id: 's2', app: 'target-fixture' })!
    await flush(); hook = render(t.input)
    expect(t.client.appLinkDecide).not.toHaveBeenCalled()
    const d = dialog(hook); expect(await d.actions[0].run()).toBe(true); d.onClose()
    expect(await a).toEqual({ type: 'app-setup-result', id: 's1', state: 'ready' })
    expect(await b).toEqual({ type: 'app-setup-result', id: 's2', state: 'ready' })
    expect(t.client.appLinkDecide).toHaveBeenCalledTimes(1)
    expect(t.client.appLinkDecide).toHaveBeenCalledWith('caller-fixture', 'frame-one', review.id, { approve: true, open_now: false })
  })
  it('keeps a different-binding busy refusal from stacking a second card', async () => {
    const t = context(); t.client.appLinkPrepare.mockResolvedValueOnce({ review }).mockResolvedValueOnce({ result: { state: 'refused', reason: 'busy' } })
    let hook = render(t.input); await flush()
    const a = hook.receive({ type: 'app-setup', id: 's1', app: 'target-fixture' })!
    await flush()
    const b = hook.receive({ type: 'app-setup', id: 's2', app: 'third-fixture' })!
    expect(await b).toEqual({ type: 'app-setup-result', id: 's2', state: 'refused', reason: 'busy' })
    hook = render(t.input); dialog(hook).onClose()
    expect(await a).toEqual({ type: 'app-setup-result', id: 's1', state: 'declined' })
  })
  it('drops a prepare response from the prior document even within the same identity epoch', async () => {
    const t = context(), late = deferred<unknown>()
    t.client.appLinkFrame.mockResolvedValueOnce({ frame_id: 'old-document' }).mockResolvedValueOnce({ frame_id: 'new-document' })
    t.client.appLinkPrepare.mockReturnValueOnce(late.promise)
    let hook = render(t.input); await flush()
    const old = hook.receive({ type: 'app-setup', id: 'old', app: 'target-fixture' })!
    await flush(); hook = render({ ...t.input, channel: nextChannel }); await flush()
    late.resolve({ review }); await flush()
    expect(await old).toBeNull(); expect(hook.controls).toBeNull(); expect(t.input.navigate).not.toHaveBeenCalled()
  })
  it('discards a completed approval after identity teardown', async () => {
    const t = context(), late = deferred<unknown>()
    t.client.appLinkDecide.mockReturnValueOnce(late.promise)
    let hook = render(t.input); await flush()
    const pending = hook.receive({ type: 'app-setup', id: 's1', app: 'target-fixture' })!
    await flush(); hook = render(t.input)
    const run = dialog(hook).actions[1].run()
    t.invalidate(); render({ ...t.input, channel: nextChannel }); await flush()
    late.resolve({ result: { state: 'ready' }, entry }); expect(await run).toBe(STALE)
    expect(await pending).toEqual({ type: 'app-setup-result', id: 's1', state: 'declined' })
    expect(t.input.navigate).not.toHaveBeenCalled()
  })
  it('keeps an entry secret out of replies and carries intent only as target view data', async () => {
    const t = context(), openReview = { ...review, kind: 'app-open', approved_revision: null }
    t.client.appLinkPrepare.mockResolvedValue({ review: openReview }); t.client.appLinkDecide.mockResolvedValue({ result: { state: 'ready' }, entry })
    let hook = render(t.input); await flush()
    const pending = hook.receive({ type: 'app-open', id: 'o1', app: 'target-fixture', intent: 'untrusted view words' })!
    await flush(); hook = render(t.input)
    const d = dialog(hook), run = d.actions[0].run(); await flush()
    const request = t.input.post.mock.calls[0][0]
    expect(request.type).toBe('presentation-snapshot')
    expect(hook.presentation({ type: 'presentation-state', id: request.id, version: 1, state: { draft: 'caller only' }, channel })).toBe(true)
    expect(await run).toBe(true); d.onClose()
    expect(await pending).toEqual({ type: 'app-open-result', id: 'o1', state: 'ready' })
    await vi.advanceTimersByTimeAsync(1)
    expect(t.input.navigate).toHaveBeenCalledWith(entry, 'untrusted view words', { version: 1, state: { draft: 'caller only' } }, false)
  })
  it('expires a changed consent revision while pending and never approves the old card', async () => {
    const t = context(); t.client.appLinkInspect.mockResolvedValue({ result: { state: 'declined' } })
    let hook = render(t.input); await flush()
    const pending = hook.receive({ type: 'app-setup', id: 's1', app: 'target-fixture' })!
    await flush(); hook = render(t.input)
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual({ type: 'app-setup-result', id: 's1', state: 'declined' })
    expect(await dialog(hook).actions[0].run()).toBe(STALE)
    expect(t.client.appLinkDecide).not.toHaveBeenCalled()
  })
  it('keeps unsupported/sim clients unavailable instead of inventing a live adapter', async () => {
    const t = context(); t.input.client = { ...t.client, mode: 'sim' } as unknown as HiveClient
    const hook = render(t.input)
    expect(await hook.receive({ type: 'app-open', id: 'o1', app: 'target-fixture' })).toEqual({ type: 'app-open-result', id: 'o1', state: 'refused', reason: 'not_available' })
    expect(t.client.appLinkPrepare).not.toHaveBeenCalled()
  })
  it('withholds target readiness failures until its own host notice is dismissed', async () => {
    const t = context(); t.client.appLinkPrepare.mockResolvedValue({ result: { state: 'refused', reason: 'not_ready' }, notice: 'This app is not ready for you yet.' })
    let hook = render(t.input); await flush()
    let settled = false
    const pending = hook.receive({ type: 'app-open', id: 'o1', app: 'target-fixture' })!.then(value => { settled = true; return value })
    await flush(); hook = render(t.input)
    expect(settled).toBe(false); expect(hook.controls).not.toBeNull()
    dialog(hook).onClose()
    expect(await pending).toEqual({ type: 'app-open-result', id: 'o1', state: 'refused', reason: 'not_ready' })
    expect(t.client.appLinkDecide).not.toHaveBeenCalled()
  })
  it('keeps a retired decision callback stale while a newer host card remains open', async () => {
    const t = context(); let hook = render(t.input); await flush()
    const first = hook.receive({ type: 'app-setup', id: 'old', app: 'target-fixture' })!
    await flush(); hook = render(t.input)
    const retired = dialog(hook); retired.onClose()
    expect(await first).toEqual({ type: 'app-setup-result', id: 'old', state: 'declined' })
    t.client.appLinkPrepare.mockResolvedValue({ review: { ...review, id: 'review-two' } })
    let settled = false
    const second = hook.receive({ type: 'app-setup', id: 'new', app: 'target-fixture' })!.then(value => { settled = true; return value })
    await flush(); hook = render(t.input)
    const newer = dialog(hook), before = t.client.appLinkDecide.mock.calls.length
    expect(await retired.actions[0].run()).toBe(STALE)
    expect(t.client.appLinkDecide).toHaveBeenCalledTimes(before)
    expect(settled).toBe(false); expect(render(t.input).controls).not.toBeNull()
    expect(await newer.actions[0].run()).toBe(true); newer.onClose()
    expect(await second).toEqual({ type: 'app-setup-result', id: 'new', state: 'ready' })
    expect(t.client.appLinkDecide).toHaveBeenLastCalledWith('caller-fixture', 'frame-one', 'review-two', { approve: true, open_now: false })
  })
  it('ignores a duplicate decision callback while the original approval is in flight', async () => {
    const t = context(), late = deferred<unknown>()
    t.client.appLinkDecide.mockReturnValueOnce(late.promise)
    let hook = render(t.input); await flush()
    const pending = hook.receive({ type: 'app-setup', id: 's1', app: 'target-fixture' })!
    await flush(); hook = render(t.input)
    const d = dialog(hook), original = d.actions[0].run()
    await flush()
    expect(await d.actions[1].run()).toBe(STALE)
    expect(t.client.appLinkDecide).toHaveBeenCalledTimes(1)
    late.resolve({ result: { state: 'ready' } })
    expect(await original).toBe(true); d.onClose()
    expect(await pending).toEqual({ type: 'app-setup-result', id: 's1', state: 'ready' })
    expect(t.client.appLinkDecide).toHaveBeenCalledTimes(1)
  })

})
