import { describe, expect, it, vi } from 'vitest'
import { harden, sandboxReport, WAYS_OUT } from './viewSandbox'
import { ViewBroken, ViewSession, ViewStopped, type ViewPort } from './viewSession'
import type { ViewReply, ViewRequest } from './viewProtocol'

/** A worker's scope as a browser builds it: the ways out on the global object and on its prototypes. */
function workerLikeScope() {
  const top = { fetch: () => 'sent', importScripts: () => 'loaded' }
  const middle = Object.create(top, { indexedDB: { get: () => ({ open: () => 'db' }), configurable: true } })
  const scope = Object.create(middle) as Record<string, unknown>
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'BroadcastChannel', 'Worker', 'caches']) scope[name] = function Out() { return name }
  scope.Function = Function
  scope.eval = eval
  return scope
}

describe("a view worker's scope", () => {
  it('loses every way out, here and on its prototypes, and cannot generate code; the report says so', () => {
    const scope = workerLikeScope()
    expect(sandboxReport(scope).ok).toBe(false)
    harden(scope)
    for (const name of WAYS_OUT) expect(scope[name], name).toBeUndefined()
    expect(() => new (scope.Function as new (b: string) => unknown)('return 1')).toThrow(EvalError)
    expect(() => (scope.eval as (s: string) => unknown)('1')).toThrow(EvalError)
    // what is not a way out still works, and functions are still functions
    expect((() => 1) instanceof (scope.Function as unknown as typeof Function)).toBe(true)
    expect(sandboxReport(scope)).toEqual({ ok: true, open: [] })
  })

  it('reports what is still open when a name cannot be taken away', () => {
    const scope = workerLikeScope()
    Object.defineProperty(scope, 'WebSocket', { value: function Fixed() { return 'stuck' }, configurable: false, writable: false })
    harden(scope)
    expect(sandboxReport(scope)).toEqual({ ok: false, open: ['WebSocket'] })
  })
})

/** A worker that answers only what the test tells it to. */
function manualPort() {
  const sent: ViewRequest[] = []
  const port: ViewPort & { reply(r: ViewReply): void; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: (m) => { sent.push(m) },
    terminate: () => { port.terminated = true },
    reply: (r) => port.onmessage?.({ data: r }),
  }
  return { port, sent }
}

describe("the page's session with a view's worker", () => {
  it('matches each reply to its request, and a view mistake comes back as ViewBroken', async () => {
    const { port, sent } = manualPort()
    const session = new ViewSession(port, 1_000)
    port.reply({ id: 0, ready: { ok: true, open: [] } })
    expect(await session.ready).toEqual({ ok: true, open: [] })
    const first = session.ask({ kind: 'look', look: 'classic' })
    const second = session.ask({ kind: 'look', look: 'cosmos' })
    expect(sent.map((m) => m.id)).toEqual([1, 2])
    const frame = { plan: { screen: 's', title: null, look: 'cosmos', space: 'flat' as const, parts: [], missing: [] }, data: {}, says: [] }
    port.reply({ id: 2, ok: true, frame })
    port.reply({ id: 1, ok: false, problem: 'part 10 uses the island block, which a view may not use' })
    await expect(second).resolves.toEqual(frame)
    await expect(first).rejects.toEqual(new ViewBroken('part 10 uses the island block, which a view may not use'))
    session.stop()
  })

  it('ends a worker that stops answering and refuses everything that waits, and anything asked after', async () => {
    vi.useFakeTimers()
    try {
      const { port } = manualPort()
      const session = new ViewSession(port, 50)
      port.reply({ id: 0, ready: { ok: true, open: [] } })
      const waiting = session.ask({ kind: 'look', look: 'classic' })
      const refused = expect(waiting).rejects.toBeInstanceOf(ViewStopped)
      await vi.advanceTimersByTimeAsync(60)
      await refused
      expect(port.terminated).toBe(true)
      expect(session.isStopped).toBe(true)
      await expect(session.ask({ kind: 'look', look: 'classic' })).rejects.toBeInstanceOf(ViewStopped)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a worker that never starts is ended too', async () => {
    vi.useFakeTimers()
    try {
      const { port } = manualPort()
      const session = new ViewSession(port, 50)
      const ready = expect(session.ready).rejects.toEqual(new ViewStopped('the view did not start'))
      await vi.advanceTimersByTimeAsync(60)
      await ready
      expect(port.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
