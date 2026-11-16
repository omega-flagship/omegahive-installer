/**
 * The hive's side of the MCP Apps protocol (modelcontextprotocol/ext-apps, specification 2026-01-26 and its draft):
 * JSON-RPC 2.0 over postMessage with one view's frame. The view asks (ui/initialize, ui/message, ui/open-link,
 * ui/download-file, ui/request-display-mode, ping) and tells (initialized, size-changed, logging, request-teardown);
 * the hive answers each from what the page does for this view (ViewHost) and tells the view of context changes and
 * teardown. The frame's origin is opaque, so messages to it go to '*' and messages from it are told apart by their
 * source window alone, as the SDK's PostMessageTransport does.
 *
 * Behaviour taken from ext-apps' AppBridge (src/app-bridge.ts): a supported protocol version is echoed, any other gets
 * the latest; a second ui/initialize is answered again; a display-mode request answers the mode in force; a context
 * change carries only the fields that changed; nothing is sent to the view before it says initialized. What acts on the
 * person's behalf (a message, a link, a download) needs their click inside this frame (ViewHost.acting), the rule the
 * Syntropy site settled on because user activation alone is page-wide.
 */

export const MCP_APPS_PROTOCOL = '2026-01-26'
const SUPPORTED_PROTOCOLS: readonly string[] = [MCP_APPS_PROTOCOL]

export type DisplayMode = 'inline' | 'fullscreen' | 'pip'
/** The modes the hive draws a view in. Picture-in-picture is not offered. */
export const HOST_DISPLAY_MODES: readonly DisplayMode[] = ['inline', 'fullscreen']

/** MCP Apps HostContext, the fields the hive sends. */
export interface HostContext {
  theme?: 'light' | 'dark'
  styles?: { variables?: Record<string, string> }
  displayMode?: DisplayMode
  availableDisplayModes?: DisplayMode[]
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number }
  locale?: string
  timeZone?: string
  userAgent?: string
  platform?: 'web' | 'desktop' | 'mobile'
  deviceCapabilities?: { touch?: boolean; hover?: boolean }
}

export interface DownloadFile { name: string; mimeType: string; bytes: Uint8Array }

/** What the page does for one view. Each acting request reaches it only after the person's click in the frame. */
export interface ViewHost {
  /** The view's reported content size, in CSS pixels. */
  size(width: number | undefined, height: number | undefined): void
  /** Switch to `mode` (already checked against both sides' modes) and return the mode now in force. */
  displayMode(mode: DisplayMode): DisplayMode
  /** Words the view offers as the person's message; absent where there is no conversation to put them in. */
  message?(text: string): void
  /** Show the person where the link goes; resolves true once they open it, false when they decline. */
  openLink(url: URL): Promise<boolean>
  /** Ask the person; resolves true once the file is saved, false when they decline. */
  download(file: DownloadFile): Promise<boolean>
  log(level: string, data: unknown): void
  requestTeardown(): void
  /** Whether the person is acting inside this frame right now (a fresh click with the frame focused). */
  acting(): boolean
}

type Json = Record<string, unknown>
type Id = string | number

/** JSON-RPC error codes the hive answers with. */
export const RPC = { methodNotFound: -32601, invalidParams: -32602, denied: -32000 } as const

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** The last path segment of a resource uri, with nothing that could leave the download folder or confuse a file
 *  system: separators, control characters and a leading dot go, and an empty name becomes "download". */
export function fileName(uri: string): string {
  let last = uri
  try { last = decodeURIComponent(new URL(uri).pathname) } catch { /* not a URL: the text itself */ }
  last = last.split(/[\\/]/).filter(Boolean).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120)
  return clean || 'download'
}

function bytesOf(resource: Json): Uint8Array {
  if (typeof resource.text === 'string') return new TextEncoder().encode(resource.text)
  if (typeof resource.blob === 'string') {
    let bin: string
    try { bin = atob(resource.blob) } catch { throw new RpcError(RPC.invalidParams, 'Invalid content: the blob is not base64') }
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  }
  throw new RpcError(RPC.invalidParams, 'Invalid content: a file needs text or blob')
}

/** The text of ui/message content: the draft sends one block, the SDK a list; only text blocks are accepted. */
function messageText(params: Json): string {
  if (params.role !== 'user') throw new RpcError(RPC.invalidParams, 'Invalid message format: role must be user')
  const blocks = Array.isArray(params.content) ? params.content : [params.content]
  const texts = blocks.map((b) => (isObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : null))
  if (!texts.length || texts.some((t) => t === null)) throw new RpcError(RPC.invalidParams, 'Invalid message format: only text is accepted')
  const text = texts.join('\n').trim()
  if (!text) throw new RpcError(RPC.invalidParams, 'Invalid message format: the message is empty')
  return text
}

export class ViewBridge {
  private initialized = false
  /** The modes the view said it supports in ui/initialize; undefined when it said nothing. */
  private viewModes: DisplayMode[] | undefined
  private nextId = 1

  constructor(
    private readonly frame: () => Window | null,
    private readonly host: ViewHost,
    private context: HostContext,
    private readonly hostInfo = { name: 'OmegaHive', version: '1' },
  ) {}

  /** What the hive answers, as MCP Apps host capabilities: links, downloads, logging, and messages where it can take
   *  them. No server tools or resources: an artifact view has no server behind it. */
  capabilities(): Json {
    return { openLinks: {}, downloadFile: {}, logging: {}, ...(this.host.message ? { message: { text: {} } } : {}) }
  }

  get ready(): boolean { return this.initialized }

  /** One window message. Returns true when it came from this view's frame (handled or deliberately ignored), false
   *  when it is someone else's and must be left alone. */
  receive(event: { source: unknown; data: unknown }): boolean {
    const win = this.frame()
    if (!win || event.source !== win) return false
    const msg = event.data
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return true   // a response to our teardown, or noise
    const params = isObject(msg.params) ? msg.params : {}
    if (typeof msg.id === 'string' || typeof msg.id === 'number') void this.answer(msg.id, msg.method, params)
    else this.notice(msg.method, params)
    return true
  }

  /** The context changed (look, size, display mode): remember it, and tell an initialized view the fields that changed. */
  setContext(next: HostContext): void {
    const changed: Json = {}
    for (const key of Object.keys(next) as (keyof HostContext)[]) {
      if (JSON.stringify(next[key]) !== JSON.stringify(this.context[key])) changed[key] = next[key]
    }
    this.context = next
    if (this.initialized && Object.keys(changed).length) this.post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: changed })
  }

  /** The frame is going away: the view hears ui/resource-teardown first. The page removes it without waiting. */
  teardown(reason: string): void {
    if (this.initialized) this.post({ jsonrpc: '2.0', id: `hive-${this.nextId++}`, method: 'ui/resource-teardown', params: { reason } })
    this.initialized = false
  }

  private post(message: Json) {
    this.frame()?.postMessage(message, '*')
  }

  private notice(method: string, params: Json) {
    switch (method) {
      case 'ui/notifications/initialized':
        this.initialized = true
        return
      case 'ui/notifications/size-changed':
        this.host.size(finite(params.width), finite(params.height))
        return
      case 'notifications/message':
        this.host.log(typeof params.level === 'string' ? params.level : 'info', params.data)
        return
      case 'ui/notifications/request-teardown':
        this.host.requestTeardown()
        return
      default:
        return   // a notification the hive does not take is dropped, as JSON-RPC allows
    }
  }

  private async answer(id: Id, method: string, params: Json) {
    try {
      this.post({ jsonrpc: '2.0', id, result: await this.handle(method, params) })
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(RPC.denied, e instanceof Error ? e.message : String(e))
      this.post({ jsonrpc: '2.0', id, error: { code: err.code, message: err.message } })
    }
  }

  private gate(what: string) {
    if (!this.host.acting()) throw new RpcError(RPC.denied, `${what} denied: it needs the person's click inside the view`)
  }

  private async handle(method: string, params: Json): Promise<Json> {
    switch (method) {
      case 'ui/initialize': {
        // every document starts with this, a reload or a second mount included: nothing goes to it until it says initialized
        this.initialized = false
        const caps = isObject(params.appCapabilities) ? params.appCapabilities : {}
        this.viewModes = Array.isArray(caps.availableDisplayModes) ? caps.availableDisplayModes.filter((m): m is DisplayMode => typeof m === 'string') as DisplayMode[] : undefined
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : MCP_APPS_PROTOCOL,
          hostCapabilities: this.capabilities(),
          hostInfo: this.hostInfo,
          hostContext: this.context,
        }
      }
      case 'ping':
        return {}
      case 'ui/request-display-mode': {
        const current = this.context.displayMode ?? 'inline'
        const mode = params.mode as DisplayMode
        const allowed = HOST_DISPLAY_MODES.includes(mode) && (this.viewModes === undefined || this.viewModes.includes(mode))
        return { mode: allowed && mode !== current ? this.host.displayMode(mode) : current }
      }
      case 'ui/message': {
        if (!this.host.message) throw new RpcError(RPC.methodNotFound, 'Method not found: ui/message')
        const text = messageText(params)
        this.gate('Message sending')
        this.host.message(text)
        return {}
      }
      case 'ui/open-link': {
        let url: URL
        try { url = new URL(String(params.url)) } catch { throw new RpcError(RPC.invalidParams, 'Invalid URL') }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RpcError(RPC.denied, 'Policy violation: only http and https links open')
        this.gate('Link opening')
        if (!(await this.host.openLink(url))) throw new RpcError(RPC.denied, 'Link opening denied by user')
        return {}
      }
      case 'ui/download-file': {
        const first = Array.isArray(params.contents) ? params.contents[0] : undefined
        if (!isObject(first) || first.type !== 'resource' || !isObject(first.resource)) {
          throw new RpcError(RPC.invalidParams, 'Invalid content: the hive saves inline files only, not links')
        }
        const res = first.resource
        const file = { name: fileName(String(res.uri ?? '')), mimeType: typeof res.mimeType === 'string' ? res.mimeType : 'application/octet-stream', bytes: bytesOf(res) }
        this.gate('Download')
        if (!(await this.host.download(file))) throw new RpcError(RPC.denied, 'Download denied by user')
        return {}
      }
      default:
        // tools/call, resources/read, sampling and model-context updates are not offered to an artifact view
        throw new RpcError(RPC.methodNotFound, `Method not found: ${method}`)
    }
  }
}
