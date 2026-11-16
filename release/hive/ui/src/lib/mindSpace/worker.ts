/**
 * The personal mind's own thread: a MeTTaScript runner with the hive's lib_nal, lib_pln and lib_hive and lib_mind,
 * loaded once. It makes no request of any kind: the space lives in this browser (IndexedDB), nothing leaves it.
 * (Pattern after Symega's browser/worker.js: open once, then answer requests by id.)
 *
 * CSP: NOT QUALIFIED in r2. Nothing here sets a policy for the worker; the UI-wiring round must serve it under the
 * app's CSP (worker-src 'self'; connect-src 'none' for this worker) and check it in a real browser.
 */
import { MindHost, broadcastNotices } from './host'
import { memoryStore, openStore } from './persist'
import { MindError } from './core'
import { OPS, type Reply, type Request } from './protocol'

// the worker's own scope (the app's tsconfig has DOM types, not WebWorker ones)
const scope = self as unknown as { postMessage(m: Reply): void; onmessage: ((e: MessageEvent<Request>) => void) | null }
const t0 = performance.now()
let host: Promise<MindHost> | null = null

const reply = (r: Reply) => scope.postMessage(r)

scope.onmessage = async ({ data }: MessageEvent<Request>) => {
  const { id } = data
  try {
    if ('open' in data) {
      if (host) throw new Error('already open')
      host = (data.open.memoryOnly ? Promise.resolve(memoryStore()) : openStore(data.open.key)).then((s) => MindHost.open(s, { notices: data.open.memoryOnly ? null : broadcastNotices(data.open.key) }))
      const h = await host
      reply({ id, ok: true, value: { storage: h.store.kind, durable: h.store.durable, gen: h.generation, coldMs: performance.now() - t0 }, durable: h.store.durable, gen: h.generation })
      return
    }
    if (!host) throw new Error('not open')
    if (!(OPS as readonly string[]).includes(data.op)) throw new Error(`unknown op ${String(data.op)}`)
    const h = await host
    const r = await h.run(data.op, data.args as unknown[])
    reply({ id, ok: true, ...r })
  } catch (e) {
    reply({ id, ok: false, error: String((e as Error)?.message ?? e), ...(e instanceof MindError ? { code: e.code } : {}) })
  }
}
