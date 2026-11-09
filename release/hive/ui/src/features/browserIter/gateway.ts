/** The page's HTTP adapter for Surface's broker. Credentials stay in this identity-bound closure, never the worker. */
export interface BrokerReply {
  status: number
  body?: Record<string, unknown>
}
export interface BrowserMindGateway {
  prepare(): Promise<boolean | 'rate-limited'>
  refresh(): Promise<boolean | 'rate-limited'>
  llm(body: object, opts: { idemKey: string; isLive(): boolean }): Promise<BrokerReply>
}

interface Options {
  base: string
  sessionToken: string
  current(): boolean
  /** Read the existing admission by operation id, including after reload; never admit a replacement turn. */
  readTurn(operationId: string): Promise<{ operation_id: string; turn_id: string; route?: string }>
  fetch?: typeof fetch
  now?: () => number
}

export function createBrowserMindGateway(opts: Options): BrowserMindGateway {
  const send = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  let token: string | null = null
  let expires = 0
  let minting: Promise<boolean | 'rate-limited'> | null = null
  const turns = new Map<string, string>()
  const bodies = new Map<string, string>()
  const current = () => {
    if (!opts.current()) {
      token = null
      turns.clear()
      bodies.clear()
      throw new Error('browser mind identity changed')
    }
  }
  const post = async (path: string, bearer: string, body: string, extra: Record<string, string> = {}, isLive = () => true) => {
    current()
    // No await may separate the turn's liveness check from the actual dispatch.
    if (!isLive()) return { status: 0, body: {} as Record<string, unknown> }
    const response = await send(opts.base + path, {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...extra },
      body,
    })
    current()
    // A lost/malformed answer is unknown, so the broker retries the same key. Never invent a terminal refusal.
    const data = await response.json() as Record<string, unknown>
    current()
    return { status: response.status, body: data }
  }
  const refresh = (): Promise<boolean | 'rate-limited'> => {
    current()
    if (minting) return minting
    minting = (async () => {
      token = null
      const r = await post('/api/me/mind/session', opts.sessionToken, '{}')
      if (r.status === 429) return 'rate-limited' as const
      if (r.status !== 201) return false
      const raw = r.body.token
      const until = typeof r.body.expires_at === 'string' ? Date.parse(r.body.expires_at) : NaN
      if (typeof raw !== 'string' || !/^mt_[A-Za-z0-9_-]{43}$/.test(raw) || !Number.isFinite(until) || until <= now()) {
        throw new Error('unreadable mind-session answer')
      }
      token = raw
      expires = until
      return true
    })().finally(() => { minting = null })
    return minting
  }
  return {
    prepare: () => { current(); return token && expires > now() + 60_000 ? Promise.resolve(true) : refresh() },
    refresh,
    async llm(body, { idemKey, isLive }) {
      current()
      if (minting) await minting
      current()
      if (!isLive()) return { status: 0 }
      // The broker key names the Ask OPERATION. X-Mind-Turn must name the distinct host turn id.
      const split = idemKey.lastIndexOf(':')
      const operation = idemKey.slice(0, split)
      if (split < 1 || !/^(0|[1-9]\d*)$/.test(idemKey.slice(split + 1))) throw new Error('invalid broker step key')
      if (!token) return { status: 401, body: { error: { code: 'mind_token_required' } } }
      let turn = turns.get(operation)
      if (!turn) {
        const admitted = await opts.readTurn(operation)
        current()
        if (admitted.operation_id !== operation || admitted.route !== 'browser_mind' || !admitted.turn_id) {
          throw new Error('not this browser turn admission')
        }
        turn = admitted.turn_id
        turns.set(operation, turn)
      }
      let serialized = bodies.get(idemKey)
      if (serialized === undefined) { serialized = JSON.stringify(body); bodies.set(idemKey, serialized) }
      const r = await post('/api/me/mind/llm/v1/chat/completions', token, serialized, {
        'Idempotency-Key': idemKey, 'X-Mind-Purpose': 'turn', 'X-Mind-Turn': turn,
      }, isLive)
      if (r.status !== 200) {
        const error = r.body.error as { message?: unknown } | undefined
        return { ...r, body: { ...r.body, ...(typeof error?.message === 'string' ? { reason: error.message } : {}) } }
      }
      const choices = r.body.choices as { message?: { content?: unknown; tool_calls?: { id: string }[] }; finish_reason?: string }[] | undefined
      const choice = choices?.[0]
      if (!choice?.message) throw new Error('unreadable model answer')
      return { status: 200, body: {
        message: choice.message,
        finishReason: choice.finish_reason ?? 'stop', response: JSON.stringify(r.body),
        usage: JSON.stringify(r.body.usage ?? {}), toolCallIds: (choice.message.tool_calls ?? []).map(c => c.id),
      } }
    },
  }
}
