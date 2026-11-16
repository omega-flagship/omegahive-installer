import { expect, it } from 'vitest'
import type { AskAccepted, AskBody } from '../../api/ask'
import { createBrowserTurnLifecycle, type IterBroker } from './lifecycle'

const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const body = (id = 'op-one'): AskBody => ({ operation_id: id, text: 'Synthetic question', context: { route: '/', experience: 'still' }, via: 'typed' })
const ack = (id = 'op-one') => ({ operation_id: id, turn_id: 'host-' + id, route: 'browser_mind', state: 'browser' }) as AskAccepted
function setup() {
  let alive = true, worker = true
  const posts: AskBody[] = []
  let admit = async (b: AskBody) => ack(b.operation_id)
  let resume = async (): Promise<unknown[]> => []
  let done = async (operation_id: string) => ({ operation_id, state: 'done' })
  let llm = async (): Promise<unknown> => 'answer'
  const broker: IterBroker = {
    turn: null,
    resume: () => resume(),
    startTurn(id) { (this as { turn: unknown }).turn = { id, closed: false } },
    async endTurn(id) { if (this.turn?.id === id) this.turn.closed = true; return true },
    llm: () => llm(),
  }
  const lifecycle = createBrowserTurnLifecycle({ broker, gateway: { prepare: async () => true, refresh: async () => true, llm: async () => ({ status: 200 }) }, current: () => alive, workerReady: () => worker,
    admit: b => { posts.push(b); return admit(b) }, done: op => done(op) })
  return { lifecycle, broker, posts, invalidate: () => { alive = false }, worker: (v: boolean) => { worker = v }, resume: (fn: typeof resume) => { resume = fn }, admit: (fn: typeof admit) => { admit = fn }, done: (fn: typeof done) => { done = fn }, llm: (fn: typeof llm) => { llm = fn } }
}

it('accepts terminal lost-admission proof only for the exact browser operation and rejects its delayed admission after a new turn', async () => {
  const s = setup(), pending = deferred<AskAccepted>()
  await s.lifecycle.restore(); s.admit(() => pending.promise)
  const old = s.lifecycle.begin(body())
  for (const answer of [{ operation_id: 'wrong', route: 'browser_mind', state: 'done' }, { operation_id: 'op-one', state: 'done' }, { ...ack(), state: 'browser' }]) {
    expect(() => s.lifecycle.reconcileClosed(answer as AskAccepted)).toThrow('unconfirmed')
    expect(s.lifecycle.phase).toBe('admitting')
  }
  s.lifecycle.reconcileClosed({ operation_id: 'op-one', route: 'browser_mind', state: 'done' })
  expect(s.lifecycle.phase).toBe('ready')
  expect(s.broker.turn).toBeNull()
  s.admit(async b => ack(b.operation_id)); await s.lifecycle.begin(body('op-two'))
  pending.resolve(ack()); await expect(old).rejects.toThrow('unconfirmed')
  expect(s.lifecycle.operation).toBe('op-two')
  expect(s.broker.turn?.id).toBe('op-two')
})

it('holds admission until resume has finished and never replaces a restored open turn', async () => {
  const s = setup(), restoring = deferred<unknown[]>()
  s.resume(() => restoring.promise)
  const ready = s.lifecycle.restore()
  await expect(s.lifecycle.begin(body())).rejects.toThrow('not ready')
  await Promise.resolve()
  s.broker.startTurn('old-operation', 'iter', 'Existing words')
  restoring.resolve([{ turnId: 'old-operation', step: 0 }]); await ready
  await expect(s.lifecycle.begin(body())).rejects.toThrow('not ready')
  expect(s.lifecycle.operation).toBe('old-operation')
  expect(s.posts).toHaveLength(0)
})

it('reserves before HTTP and reconciles a lost admission under the original operation only', async () => {
  const s = setup(), admission = deferred<AskAccepted>()
  await s.lifecycle.restore(); s.admit(() => admission.promise)
  const first = s.lifecycle.begin(body())
  await expect(s.lifecycle.begin(body('op-two'))).rejects.toThrow('not ready')
  admission.reject(new Error('answer lost'))
  await expect(first).rejects.toThrow('answer lost')
  expect(s.lifecycle.phase).toBe('admitting')
  expect(s.posts).toHaveLength(1)
  expect(s.posts[0].answer_in).toBe('browser')
  expect(() => s.lifecycle.reconcile(ack('op-two'))).toThrow('unconfirmed')
  s.lifecycle.reconcile(ack())
  expect(s.broker.turn?.id).toBe('op-one')
})

it('worker readiness determines whether a new browser turn may be admitted, without changing an admitted owner', async () => {
  const s = setup(); await s.lifecycle.restore(); s.worker(false)
  await expect(s.lifecycle.begin(body())).rejects.toThrow('not ready')
  expect(s.posts).toHaveLength(0)
  s.worker(true); await s.lifecycle.begin(body()); s.worker(false)
  expect(await s.lifecycle.request({})).toBe('answer')
  expect(s.posts).toHaveLength(1)
})

it('a lost close keeps the original turn reserved; concurrent close and new admission are refused', async () => {
  const s = setup(), close = deferred<{ operation_id: string; state: string }>()
  await s.lifecycle.restore(); await s.lifecycle.begin(body()); s.done(() => close.promise)
  const finishing = s.lifecycle.finish('answered')
  await expect(s.lifecycle.begin(body('op-two'))).rejects.toThrow('not ready')
  await expect(s.lifecycle.finish('stopped')).rejects.toThrow('no browser turn')
  close.reject(new Error('close answer lost')); await expect(finishing).rejects.toThrow('close answer lost')
  expect(s.lifecycle.phase).toBe('running')
  expect(s.broker.turn?.closed).toBe(false)
  s.done(async operation_id => ({ operation_id, state: 'done' }))
  await s.lifecycle.finish('answered')
  await s.lifecycle.begin(body('op-two'))
  expect(s.broker.turn?.id).toBe('op-two')
})

it('rejects a late request result after close and rejects admission answers after identity changes', async () => {
  const s = setup(), answer = deferred<unknown>()
  await s.lifecycle.restore(); await s.lifecycle.begin(body()); s.llm(() => answer.promise)
  const request = s.lifecycle.request({})
  await s.lifecycle.finish('stopped'); await s.lifecycle.begin(body('op-two'))
  answer.resolve('old answer'); await expect(request).rejects.toThrow('late browser turn')
  const other = setup(), admission = deferred<AskAccepted>()
  await other.lifecycle.restore(); other.admit(() => admission.promise)
  const pending = other.lifecycle.begin(body()); other.invalidate(); admission.resolve(ack())
  await expect(pending).rejects.toThrow('identity changed')
  expect(other.broker.turn).toBe(null)
})

it('holds navigation and new turns until endTurn cleanup succeeds, retrying without a second host close', async () => {
  const s = setup(); await s.lifecycle.restore(); await s.lifecycle.begin(body())
  let closes = 0, cleanup = 0
  s.done(async operation_id => { closes++; return { operation_id, state: 'done' } })
  s.broker.endTurn = async () => ++cleanup > 1
  await expect(s.lifecycle.finish('answered')).rejects.toThrow('cleanup incomplete')
  expect(s.lifecycle.phase).toBe('cleanup')
  await expect(s.lifecycle.begin(body('op-two'))).rejects.toThrow('not ready')
  await expect(s.lifecycle.request({})).rejects.toThrow('no running')
  await s.lifecycle.finish('answered')
  expect(closes).toBe(1)
  expect(cleanup).toBe(2)
  expect(s.lifecycle.phase).toBe('ready')
})

it('closes a between-step interrupted broker before any worker or new admission, retaining the host close handshake', async () => {
  const s = setup(), events: string[] = []
  s.resume(async () => {
    s.broker.startTurn('interrupted-operation', 'iter', 'Earlier words')
    return [{ turnId: 'interrupted-operation', step: null, interrupted: true, parked: { action: 'ask-again' } }]
  })
  s.broker.endTurn = async id => { events.push('broker:' + id); s.broker.turn!.closed = true; return true }
  s.done(async id => { events.push('host:' + id); return { operation_id: id, state: 'done' } })
  await s.lifecycle.restore()
  expect(events).toEqual(['broker:interrupted-operation'])
  expect(s.lifecycle.phase).toBe('parked')
  await expect(s.lifecycle.request({})).rejects.toThrow('no running')
  await expect(s.lifecycle.begin(body())).rejects.toThrow('not ready')
  expect(s.posts).toEqual([])
  await s.lifecycle.finish('incomplete')
  expect(events).toEqual(['broker:interrupted-operation', 'host:interrupted-operation', 'broker:interrupted-operation'])
  await s.lifecycle.begin(body())
  expect(s.lifecycle.phase).toBe('running')
})

it('retains an interrupted operation through failed immediate and final cleanup without repeating its host close', async () => {
  const s = setup(); let cleanups = 0, closes = 0
  s.resume(async () => { s.broker.startTurn('interrupted-operation', 'iter', 'Earlier words'); return [{ turnId: 'interrupted-operation', step: null, interrupted: true }] })
  s.broker.endTurn = async () => ++cleanups >= 3
  s.done(async id => { closes++; return { operation_id: id, state: 'done' } })
  await s.lifecycle.restore()
  expect(s.lifecycle.operation).toBe('interrupted-operation')
  await expect(s.lifecycle.begin(body())).rejects.toThrow('not ready')
  await expect(s.lifecycle.finish('incomplete')).rejects.toThrow('cleanup incomplete')
  expect(s.lifecycle.phase).toBe('cleanup')
  await s.lifecycle.finish('incomplete')
  expect(closes).toBe(1)
  expect(cleanups).toBe(3)
  expect(s.lifecycle.phase).toBe('ready')
})
