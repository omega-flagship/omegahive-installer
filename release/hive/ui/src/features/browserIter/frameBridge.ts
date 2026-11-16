import { iterSiblingOrigin } from './siblingOrigin'

const READY = 'iter-frame-ready'
const CONNECT = 'iter-frame-connect'
const CONNECTED = 'iter-frame-connected'
const STOP = 'iter-frame-stop'

/** The page owns credentials/broker/RPC. Only this dedicated port reaches the sibling worker. */
export function createIterFrame(opts: {
  origin?: string
  current(): boolean
  signal: AbortSignal
  message(data: unknown): void
  timeoutMs?: number
  window?: Window
  document?: Document
}) {
  const page = opts.window ?? window, doc = opts.document ?? document
  const origin = iterSiblingOrigin(page.location.href, opts.origin)
  if (!origin || opts.signal.aborted || !opts.current()) throw new Error('Browser Iter sibling unavailable')
  const channel = crypto.randomUUID(), ports = new MessageChannel()
  const frame = doc.createElement('iframe')
  frame.hidden = true
  frame.title = 'Your browser mind'
  frame.referrerPolicy = 'no-referrer'
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  const address = new URL('/mind-iter/frame.html', origin)
  // The entry's trusted configuration supplies the allowed parent origin; the fragment supplies only this nonce.
  address.hash = new URLSearchParams({ channel }).toString()
  frame.src = address.href
  let closed = false, connected = false, settled = false
  let accept!: () => void, reject!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => { accept = yes; reject = no })
  const dispose = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    page.removeEventListener('message', connect)
    opts.signal.removeEventListener('abort', dispose)
    if (connected) { try { ports.port1.postMessage({ type: STOP }) } catch { /* frame removal also ends its worker */ } }
    ports.port1.onmessage = null
    ports.port1.close(); ports.port2.close()
    frame.remove()
    if (!settled) { settled = true; reject(new Error('Browser Iter frame closed before connection')) }
  }
  const current = () => !closed && !opts.signal.aborted && opts.current()
  const connect = (event: MessageEvent) => {
    if (!current()) { dispose(); return }
    if (connected || event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== READY || event.data?.channel !== channel) return
    if (!frame.contentWindow) { dispose(); return }
    try {
      frame.contentWindow.postMessage({ type: CONNECT, channel }, origin, [ports.port2])
      if (!current()) { dispose(); return }
      connected = true
      page.removeEventListener('message', connect)
    } catch { dispose() }
  }
  ports.port1.onmessage = event => {
    if (!current()) { dispose(); return }
    if (!settled) {
      if (!connected || event.data?.type !== CONNECTED) { dispose(); return }
      settled = true
      clearTimeout(timer)
      accept()
      return
    }
    opts.message(event.data)
  }
  const timer = setTimeout(dispose, opts.timeoutMs ?? 10_000)
  page.addEventListener('message', connect)
  opts.signal.addEventListener('abort', dispose, { once: true })
  doc.body.appendChild(frame)
  return {
    ready,
    post(data: object) {
      if (!current()) { dispose(); throw new Error('Browser Iter frame is stale') }
      if (!connected || !settled) throw new Error('Browser Iter frame is not connected')
      ports.port1.postMessage(data)
    },
    dispose,
  }
}

/** Runs only in the configured sibling document. This wraps the accepted startWorker bundle, not another engine. */
export function serveIterFrame(opts: {
  parentOrigin: string
  workerUrl: string
  channel: string
  window?: Window
  worker?: (url: string) => Worker
}) {
  const page = opts.window ?? window
  const origin = iterSiblingOrigin(page.location.href, opts.parentOrigin)
  const workerUrl = new URL(opts.workerUrl, page.location.href)
  if (!origin || origin !== opts.parentOrigin || page.parent === page || !/^[a-f0-9-]{36}$/.test(opts.channel) || workerUrl.origin !== page.location.origin || workerUrl.username || workerUrl.password || workerUrl.hash || workerUrl.search) throw new Error('Invalid browser Iter frame configuration')
  let closed = false, connected = false, booted = false
  let port: MessagePort | null = null, worker: Worker | null = null
  const dispose = () => {
    if (closed) return
    closed = true
    page.removeEventListener('message', connect)
    page.removeEventListener('pagehide', dispose)
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate() }
    if (port) { port.onmessage = null; port.close() }
  }
  const connect = (event: MessageEvent) => {
    if (closed || connected || event.source !== page.parent || event.origin !== origin || event.data?.type !== CONNECT || event.data?.channel !== opts.channel || event.ports.length !== 1) return
    connected = true
    page.removeEventListener('message', connect)
    port = event.ports[0]
    try {
      worker = (opts.worker ?? (url => new Worker(url, { type: 'module' })))(workerUrl.href)
      worker.onmessage = message => { if (!closed) port!.postMessage(message.data) }
      worker.onerror = () => { if (!closed) { port!.postMessage({ type: 'failed', error: 'Browser Iter worker failed' }); dispose() } }
      port.onmessage = message => {
        if (closed) return
        const data = message.data
        if (data?.type === STOP) { dispose(); return }
        if (data?.type === 'boot' && !booted) { booted = true; worker!.postMessage(data); return }
        if (booted && Number.isSafeInteger(data?.reply) && data.reply > 0) { worker!.postMessage(data); return }
        port!.postMessage({ type: 'failed', error: 'Invalid browser Iter frame message' }); dispose()
      }
      port.start()
      port.postMessage({ type: CONNECTED })
    } catch {
      port.postMessage({ type: 'failed', error: 'Browser Iter worker unavailable' }); dispose()
    }
  }
  page.addEventListener('message', connect)
  page.addEventListener('pagehide', dispose, { once: true })
  page.parent.postMessage({ type: READY, channel: opts.channel }, origin)
  return dispose
}
