import { describe, expect, it, vi } from 'vitest'
import type { EpochBinding } from '../identityEpoch'
import { MemoryCommitCancelled, memoryBackend, type MemoryBackend, type MemoryCommitGuard } from './backend'
import { AskMemoryStore, type MemoryReviewSnapshot } from './store'
import type { Belief } from './types'

// Fixed invented storage records. Tests never call learning, recall or a truth-revision function.
const T0 = 1_700_000_000_000
const OWNER = { principal: 'user:p8-invented', hive: 'live@invented-host' }
const OTHER = { principal: 'user:p8-other', hive: 'live@invented-host' }
const belief = (over: Partial<Belief> = {}): Belief => ({ id: 'p8_note', kind: 'preference', statement: 'Invented: prefers short notes.',
  truth: { frequency: 0.6, confidence: 0.7 }, uses: 4, last_used_at: T0 - 10, created_at: T0 - 100, updated_at: T0,
  source_turn: 'invented-turn', ...over })
const guard = () => { const controller = new AbortController(); return { controller, fence: { signal: controller.signal, current: () => !controller.signal.aborted } } }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }
async function seed(db: MemoryBackend, record = belief()) {
  await db.commit({ op: 'put', gen: 0, base: null, belief: record,
    trace: [{ id: `seed_${record.id}`, at: T0, turn_id: null, kind: 'edit', summary: record.statement, belief_id: record.id }] })
}
async function setup(backend?: MemoryBackend) {
  const inner = backend ?? memoryBackend()
  if (!backend) await seed(inner)
  const other = memoryBackend()
  let epoch = 0
  const hooks = new Set<() => void>()
  const bind = (): EpochBinding => { const at = epoch; const current = () => epoch === at; return { epoch: at, current, commit: (fn) => current() ? fn() : Symbol('stale') as never } }
  const reasoning = vi.fn(() => { throw new Error('P8 must not run an embedder or recaller') })
  const store = new AskMemoryStore({ backend: (name) => name.includes('p8-other') ? other : inner, now: () => T0 + 100,
    persist: () => undefined, channel: null, bind, onIdentityChange: (fn) => { hooks.add(fn); return () => hooks.delete(fn) },
    embedder: { id: 'p8-no-reasoning', embed: reasoning }, recaller: { recall: reasoning } })
  store.use(OWNER); await store.whenReady()
  return { store, inner, other, reasoning, changeIdentity: async () => { epoch++; hooks.forEach((fn) => fn()); store.use(OTHER); await store.whenReady() } }
}
async function opening(store: AskMemoryStore, fence: MemoryCommitGuard): Promise<MemoryReviewSnapshot> {
  const snapshot = await store.openReview(fence)
  if (!snapshot) throw new Error('expected current host review')
  return snapshot
}

describe('P8 real store and backend host review', () => {
  it('awaits a real CAS fix and preserves the original truth and usage exactly', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    expect(await h.store.fixReview(snap, 'p8_note', 'Invented: prefers concise notes.', g.fence)).toEqual({ kind: 'done' })
    const stored = (await h.inner.load()).beliefs[0]
    expect(stored.statement).toBe('Invented: prefers concise notes.')
    expect(stored.truth).toEqual(belief().truth)
    expect(stored.uses).toBe(4); expect(stored.last_used_at).toBe(T0 - 10)
    expect(stored.source_turn).toBeNull()
    expect(h.reasoning).not.toHaveBeenCalled()
  })

  it('returns current text instead of overwriting a newer base', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    await h.inner.commit({ op: 'put', gen: 0, base: T0, belief: belief({ updated_at: T0 + 1, statement: 'Invented: changed elsewhere.' }), trace: [] })
    const result = await h.store.fixReview(snap, 'p8_note', 'Invented: a stale correction.', g.fence)
    expect(result.kind).toBe('stale')
    if (result.kind === 'stale') expect(result.snapshot?.beliefs[0].statement).toBe('Invented: changed elsewhere.')
    expect((await h.inner.load()).beliefs[0].statement).toBe('Invented: changed elsewhere.')
  })

  it('detects changed words even when a legacy writer reused the same timestamp', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    await h.inner.commit({ op: 'put', gen: 0, base: T0, belief: belief({ statement: 'Invented: different words, same timestamp.' }), trace: [] })
    expect((await h.store.fixReview(snap, 'p8_note', 'Invented: obsolete correction.', g.fence)).kind).toBe('stale')
    expect((await h.inner.load()).beliefs[0].statement).toBe('Invented: different words, same timestamp.')
  })

  it('requires a fresh review before forgetting changed words', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    await h.inner.commit({ op: 'put', gen: 0, base: T0, belief: belief({ updated_at: T0 + 1, statement: 'Invented: revised note.' }), trace: [] })
    expect((await h.store.forgetReview(snap, 'p8_note', g.fence)).kind).toBe('stale')
    expect((await h.inner.load()).beliefs).toHaveLength(1)
    const fresh = await opening(h.store, g.fence)
    expect(await h.store.forgetReview(fresh, 'p8_note', g.fence)).toEqual({ kind: 'done' })
    const stored = await h.inner.load()
    expect(stored.beliefs).toEqual([])
    expect(stored.tombs.some((t) => t.id === 'p8_note')).toBe(true)
    expect(stored.trace.every((t) => !t.summary.includes('notes') && !t.summary.includes('revised'))).toBe(true)
  })

  it('cannot recreate notes after another tab forgot everything', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    await h.inner.commit({ op: 'forget_all', gen: 0, at: T0 + 1, trace: [] })
    expect((await h.store.fixReview(snap, 'p8_note', 'Invented: must stay gone.', g.fence)).kind).toBe('stale')
    expect((await h.inner.load()).beliefs).toEqual([])
  })

  it('rejects copied review tokens and old-person tokens without touching either store', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    const forged = { ...snap, token: { ...snap.token } }
    expect(await h.store.fixReview(forged, 'p8_note', 'Invented: forged token.', g.fence)).toEqual({ kind: 'refused', reason: 'unavailable' })
    await h.changeIdentity()
    expect(await h.store.forgetReview(snap, 'p8_note', g.fence)).toEqual({ kind: 'refused', reason: 'unavailable' })
    expect((await h.inner.load()).beliefs[0].statement).toBe(belief().statement)
    expect((await h.other.load()).beliefs).toEqual([])
  })

  it('cancels a queued backend write when its host document closes', async () => {
    const inner = memoryBackend(); await seed(inner)
    const started = deferred(), released = deferred()
    const backend: MemoryBackend = { ...inner, async commit(change, fence) { started.resolve(); await released.promise; return inner.commit(change, fence) } }
    const h = await setup(backend), g = guard(), snap = await opening(h.store, g.fence), before = await inner.load()
    const pending = h.store.fixReview(snap, 'p8_note', 'Invented: late write.', g.fence)
    await started.promise; g.controller.abort(); released.resolve()
    expect(await pending).toEqual({ kind: 'refused', reason: 'unavailable' })
    expect(await inner.load()).toEqual(before)
  })

  it('rolls back a provisional in-memory write when cancellation lands before its journal write', async () => {
    const db = memoryBackend(); await seed(db)
    const g = guard(), before = await db.load()
    const replacement = 'Invented: rolled back.'
    let provisionalWriteObserved = false
    const originalSet = Map.prototype.set
    // Observe the actual in-memory storage write after it happens, then close
    // the host review. The serialized command and journal remain ordinary data.
    const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      const result = originalSet.call(this, key, value)
      if (key === 'p8_note' && (value as Belief | undefined)?.statement === replacement) {
        provisionalWriteObserved = true
        g.controller.abort()
      }
      return result
    })
    try {
      await expect(db.commit({ op: 'put', gen: 0, base: T0, belief: belief({ statement: replacement }),
        trace: [{ id: 'late', at: T0, turn_id: null, kind: 'edit', summary: 'Invented late', belief_id: 'p8_note' }] }, g.fence)).rejects.toBeInstanceOf(MemoryCommitCancelled)
    } finally { set.mockRestore() }
    expect(provisionalWriteObserved).toBe(true)
    expect(await db.load()).toEqual(before)
  })

  it('exports only to its current host caller and refuses after teardown', async () => {
    const h = await setup(), g = guard(), snap = await opening(h.store, g.fence)
    const exported = await h.store.exportReview(snap, g.fence)
    expect(exported?.text).toContain(belief().statement)
    g.controller.abort()
    expect(await h.store.exportReview(snap, g.fence)).toBeNull()
    expect(await h.store.openReview(g.fence)).toBeNull()
    expect(h.reasoning).not.toHaveBeenCalled()
  })
})
