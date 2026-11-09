import { afterEach, expect, it, vi } from 'vitest'
import { createIterFrame, serveIterFrame } from './frameBridge'
import { iterSiblingOrigin } from './siblingOrigin'

const nonce = '11111111-2222-4333-8444-555555555555'
class Port {
  peer!: Port
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(data: unknown) { if (!this.closed) queueMicrotask(() => { if (!this.peer.closed) this.peer.onmessage?.({ data }) }) }
  start() {}
  close() { this.closed = true }
}
class Channel {
  port1 = new Port(); port2 = new Port()
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1 }
}
function send(target: EventTarget, origin: string, source: unknown, data: unknown, ports: unknown[] = []) {
  target.dispatchEvent(Object.assign(new Event('message'), { origin, source, data, ports }))
}
function setup() {
  vi.stubGlobal('MessageChannel', Channel)
  vi.stubGlobal('crypto', { randomUUID: () => nonce })
  const parentOrigin = 'http://127.0.0.1:18840', childOrigin = 'http://iter.localhost:18841'
  const page = Object.assign(new EventTarget(), { location: { href: parentOrigin + '/?sim=1', origin: parentOrigin } })
  const child = Object.assign(new EventTarget(), { location: { href: childOrigin + '/mind-iter/frame.html', origin: childOrigin }, parent: page })
  const transfers: unknown[][] = [], received: unknown[] = [], workerPosts: unknown[] = []
  const worker = { onmessage: null as ((event: { data: unknown }) => void) | null, onerror: null as (() => void) | null, postMessage: (value: unknown) => workerPosts.push(value), terminate: vi.fn() }
  const makeWorker = vi.fn(() => worker as unknown as Worker)
  Object.assign(page, { postMessage: (data: unknown, origin: string) => { if (origin === parentOrigin) queueMicrotask(() => send(page, childOrigin, child, data)) } })
  Object.assign(child, { postMessage: (data: unknown, origin: string, ports: unknown[]) => { transfers.push(ports); if (origin === childOrigin) queueMicrotask(() => send(child, parentOrigin, page, data, ports)) } })
  const frame = { hidden: false, title: '', referrerPolicy: '', src: '', contentWindow: child, attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value }, remove: vi.fn(() => child.dispatchEvent(new Event('pagehide'))) }
  const doc = { createElement: vi.fn(() => frame), body: { appendChild: vi.fn() } }
  const abort = new AbortController()
  const mount = () => serveIterFrame({ parentOrigin, workerUrl: childOrigin + '/mind-iter/worker.js', channel: nonce, window: child as never, worker: makeWorker })
  const create = (extra = {}) => createIterFrame({ origin: childOrigin, current: () => true, signal: abort.signal, message: value => received.push(value), window: page as never, document: doc as never, ...extra })
  return { page, child, frame, doc, abort, transfers, received, worker, workerPosts, makeWorker, mount, create, parentOrigin, childOrigin }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('uses iter.localhost only for local testing and requires a distinct configured origin publicly', () => {
  expect(iterSiblingOrigin('http://127.0.0.1:18840/')).toBe('http://iter.localhost:18840')
  expect(iterSiblingOrigin('https://hive.invalid/')).toBeNull()
  expect(iterSiblingOrigin('https://hive.invalid/', 'https://iter.invalid')).toBe('https://iter.invalid')
  for (const value of ['https://hive.invalid', 'https://user:secret@iter.invalid', 'https://iter.invalid/path', 'https://iter.invalid/?q=1', 'https://iter.invalid/#x', 'http://iter.invalid', 'data:text/html,x']) {
    expect(iterSiblingOrigin('https://hive.invalid/', value), value).toBeNull()
  }
})

it('ignores a guessed nonce, foreign window or wrong origin before transferring any port', async () => {
  const s = setup(), bridge = s.create(), failure = bridge.ready.catch(error => error)
  const ready = { type: 'iter-frame-ready', channel: nonce }
  send(s.page, s.childOrigin, {}, ready)
  send(s.page, 'https://foreign.invalid', s.child, ready)
  send(s.page, s.childOrigin, s.child, { ...ready, channel: 'guessed' })
  expect(s.transfers).toEqual([])
  expect(s.makeWorker).not.toHaveBeenCalled()
  bridge.dispose()
  expect(await failure).toBeInstanceOf(Error)
})

it('connects once to the exact sibling and carries only the worker protocol through its private port', async () => {
  const s = setup(), bridge = s.create(), close = s.mount()
  await bridge.ready
  expect(s.frame.attributes.sandbox).toBe('allow-scripts allow-same-origin')
  expect(s.frame.src).toBe(s.childOrigin + '/mind-iter/frame.html#channel=' + nonce)
  expect(s.makeWorker).toHaveBeenCalledTimes(1)
  expect(s.makeWorker).toHaveBeenCalledWith(s.childOrigin + '/mind-iter/worker.js')
  const boot = { type: 'boot', transformedDigest: 'synthetic-pin', assets: {} }
  bridge.post(boot); await Promise.resolve()
  expect(s.workerPosts).toEqual([boot])
  s.worker.onmessage!({ data: { type: 'ready' } }); await Promise.resolve()
  expect(s.received).toEqual([{ type: 'ready' }])
  send(s.page, s.childOrigin, s.child, { type: 'iter-frame-ready', channel: nonce })
  expect(s.transfers).toHaveLength(1)
  bridge.dispose(); close()
  expect(s.worker.terminate).toHaveBeenCalledTimes(1)
})

it('does not call a connected channel ready until the child acknowledges its port', async () => {
  const s = setup(), bridge = s.create(), failure = bridge.ready.catch(error => error)
  send(s.page, s.childOrigin, s.child, { type: 'iter-frame-ready', channel: nonce })
  expect(s.transfers).toHaveLength(1)
  expect(() => bridge.post({ type: 'boot' })).toThrow('not connected')
  bridge.dispose(); expect(await failure).toBeInstanceOf(Error)
})

it('an identity abort terminates the frame worker and rejects saved post/result callbacks', async () => {
  const s = setup(), bridge = s.create(), close = s.mount()
  await bridge.ready
  const late = s.worker.onmessage!
  s.abort.abort()
  expect(s.frame.remove).toHaveBeenCalledTimes(1)
  expect(s.worker.terminate).toHaveBeenCalledTimes(1)
  expect(() => bridge.post({ reply: 1, value: 'old result' })).toThrow('stale')
  late({ data: { rpc: 1, type: 'llm', payload: {} } }); await Promise.resolve()
  expect(s.received).toEqual([])
  close()
})

it('a changed current binding blocks delivery even before the abort observer runs', async () => {
  let current = true
  const s = setup(), bridge = s.create({ current: () => current }), close = s.mount()
  await bridge.ready
  current = false
  s.worker.onmessage!({ data: { rpc: 1, type: 'llm', payload: {} } }); await Promise.resolve()
  expect(s.received).toEqual([])
  expect(s.worker.terminate).toHaveBeenCalledTimes(1)
  close()
})

it('refuses an external worker URL, a same-origin frame or an unconfigured public sibling', () => {
  const s = setup()
  expect(() => serveIterFrame({ parentOrigin: s.parentOrigin, workerUrl: 'https://foreign.invalid/worker.js', channel: nonce, window: s.child as never, worker: s.makeWorker })).toThrow('configuration')
  expect(() => s.create({ origin: s.parentOrigin })).toThrow('unavailable')
  Object.assign(s.page.location, { href: 'https://hive.invalid/', origin: 'https://hive.invalid' })
  expect(() => s.create({ origin: undefined })).toThrow('unavailable')
  expect(s.makeWorker).not.toHaveBeenCalled()
})

it('the child refuses an impostor parent or channel before constructing a worker', () => {
  const s = setup(), close = s.mount(), ports = new Channel()
  const connect = { type: 'iter-frame-connect', channel: nonce }
  send(s.child, 'https://foreign.invalid', s.page, connect, [ports.port2])
  send(s.child, s.parentOrigin, {}, connect, [ports.port2])
  send(s.child, s.parentOrigin, s.page, { ...connect, channel: 'guessed' }, [ports.port2])
  expect(s.makeWorker).not.toHaveBeenCalled()
  close()
})

it('a non-worker protocol message is refused without forwarding it to the engine', async () => {
  const s = setup(), bridge = s.create(), close = s.mount()
  await bridge.ready
  bridge.post({ type: 'fetch', url: 'https://foreign.invalid/' })
  await Promise.resolve(); await Promise.resolve()
  expect(s.workerPosts).toEqual([])
  expect(s.received).toEqual([{ type: 'failed', error: 'Invalid browser Iter frame message' }])
  expect(s.worker.terminate).toHaveBeenCalledTimes(1)
  bridge.dispose(); close()
})

it('a duplicate boot stops the child instead of starting another engine', async () => {
  const s = setup(), bridge = s.create(), close = s.mount()
  await bridge.ready
  bridge.post({ type: 'boot' }); await Promise.resolve()
  bridge.post({ type: 'boot' }); await Promise.resolve(); await Promise.resolve()
  expect(s.makeWorker).toHaveBeenCalledTimes(1)
  expect(s.workerPosts).toEqual([{ type: 'boot' }])
  expect(s.worker.terminate).toHaveBeenCalledTimes(1)
  expect(s.received).toEqual([{ type: 'failed', error: 'Invalid browser Iter frame message' }])
  // The frame reports failure, closes its port and cannot accept further traffic.
  bridge.dispose(); close()
})

it('times out an unacknowledged child without leaving an iframe or open listener', async () => {
  vi.useFakeTimers()
  const s = setup(), bridge = s.create({ timeoutMs: 10 }), failure = bridge.ready.catch(error => error)
  await vi.advanceTimersByTimeAsync(11)
  expect(await failure).toBeInstanceOf(Error)
  expect(s.frame.remove).toHaveBeenCalledTimes(1)
  send(s.page, s.childOrigin, s.child, { type: 'iter-frame-ready', channel: nonce })
  expect(s.transfers).toEqual([])
})
