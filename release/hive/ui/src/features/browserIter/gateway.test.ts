import { describe, expect, it } from 'vitest'
import { createBrowserMindGateway } from './gateway'

const token = 'mt_' + 'a'.repeat(43)
const model = { choices: [{ message: { content: 'Hello', tool_calls: [{ id: 'tool-1' }] }, finish_reason: 'tool_calls' }], usage: { completion_tokens: 3 } }
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function setup() {
  const sent: { url: string; init: RequestInit }[] = []
  let alive = true
  let reads = 0
  let handler = async (_url: string, _init: RequestInit) => answer(model)
  const options = {
    base: 'http://127.0.0.1:8790', sessionToken: 'synthetic-person-session', current: () => alive,
    readTurn: async (op: string) => { reads++; return { operation_id: op, turn_id: 'host-turn-different-from-operation', route: 'browser_mind' } },
    fetch: (async (url, init) => {
      sent.push({ url: String(url), init: init! })
      return String(url).endsWith('/session')
        ? answer({ token, expires_at: '2099-01-01T00:00:00Z' }, 201)
        : handler(String(url), init!)
    }) as typeof fetch,
  }
  return { options, sent, gateway: createBrowserMindGateway(options), setHandler: (next: typeof handler) => { handler = next }, invalidate: () => { alive = false }, reads: () => reads }
}

describe('browser Iter gateway HTTP custody', () => {
  it('uses the person only for mint, the mind token for calls, and the distinct admitted host turn', async () => {
    const s = setup()
    expect(await s.gateway.prepare()).toBe(true)
    const r = await s.gateway.llm({ messages: [{ role: 'user', content: 'Synthetic question' }] }, { isLive: () => true, idemKey: 'ask-operation:0' })
    expect(s.sent[0].init.headers).toMatchObject({ Authorization: 'Bearer synthetic-person-session' })
    expect(s.sent[1].init.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'Idempotency-Key': 'ask-operation:0', 'X-Mind-Turn': 'host-turn-different-from-operation', 'X-Mind-Purpose': 'turn' })
    expect(s.sent[1].init.redirect).toBe('error')
    expect(r.body).toMatchObject({ message: model.choices[0].message, finishReason: 'tool_calls', toolCallIds: ['tool-1'] })
    expect(JSON.parse(r.body!.response as string)).toEqual(model)
    expect(await s.gateway.prepare()).toBe(true)
    expect(s.sent).toHaveLength(2)
  })

  it('keeps exact wire bytes through retry and re-mint, without ending the person session on a mind 401', async () => {
    const s = setup(); await s.gateway.prepare()
    const body = { messages: [{ role: 'user', content: 'First body' }] }
    s.setHandler(async () => answer({ error: { code: 'mind_token_expired', message: 'Mint again' } }, 401))
    expect((await s.gateway.llm(body, { isLive: () => true, idemKey: 'operation:0' })).status).toBe(401)
    body.messages[0].content = 'Do not resend a rebuilt body'
    await s.gateway.refresh(); s.setHandler(async () => answer(model))
    await s.gateway.llm(body, { isLive: () => true, idemKey: 'operation:0' })
    const calls = s.sent.filter(x => x.url.endsWith('/completions'))
    expect(calls.map(x => x.init.body)).toEqual([JSON.stringify({ messages: [{ role: 'user', content: 'First body' }] }), calls[0].init.body])
    expect(s.reads()).toBe(1)
    await s.gateway.llm(body, { isLive: () => true, idemKey: 'operation:1' })
    expect(JSON.parse(s.sent.at(-1)!.init.body as string).messages[0].content).toBe('Do not resend a rebuilt body')
  })

  it('resolves the existing host turn after reload instead of admitting another Ask', async () => {
    const s = setup(); const restored = createBrowserMindGateway(s.options)
    await restored.prepare()
    await restored.llm({ messages: [{ role: 'user', content: 'Persisted step' }] }, { isLive: () => true, idemKey: 'operation:4' })
    expect(s.reads()).toBe(1)
    expect(s.sent.some(x => x.url.endsWith('/api/ask'))).toBe(false)
    expect(s.sent.at(-1)!.init.headers).toMatchObject({ 'Idempotency-Key': 'operation:4', 'X-Mind-Turn': 'host-turn-different-from-operation' })
  })

  it('drops an answer and all subsequent sends when identity changes during the request', async () => {
    const s = setup(); await s.gateway.prepare()
    s.setHandler(async () => { s.invalidate(); return answer(model) })
    await expect(s.gateway.llm({}, { isLive: () => true, idemKey: 'operation:0' })).rejects.toThrow('identity changed')
    const count = s.sent.length
    await expect(s.gateway.llm({}, { isLive: () => true, idemKey: 'operation:0' })).rejects.toThrow('identity changed')
    expect(s.sent).toHaveLength(count)
  })

  it('preserves host refusal codes and treats a malformed successful answer as unknown', async () => {
    const s = setup(); await s.gateway.prepare()
    s.setHandler(async () => answer({ error: { code: 'in_progress', message: 'Still working' } }, 409))
    expect(await s.gateway.llm({}, { isLive: () => true, idemKey: 'operation:0' })).toEqual({ status: 409, body: { error: { code: 'in_progress', message: 'Still working' }, reason: 'Still working' } })
    s.setHandler(async () => answer({ unrelated: true }))
    await expect(s.gateway.llm({}, { isLive: () => true, idemKey: 'operation:0' })).rejects.toThrow('unreadable model answer')
  })
})

it('a turn closed during a token await dispatches no LLM request', async () => {
  let release!: (r: Response) => void
  let live = true
  const sent: string[] = []
  const gateway = createBrowserMindGateway({
    base: 'http://127.0.0.1:8790', sessionToken: 'synthetic', current: () => true,
    readTurn: async op => ({ operation_id: op, turn_id: 'host-turn', route: 'browser_mind' }),
    fetch: (async url => { sent.push(String(url)); return new Promise<Response>(r => { release = r }) }) as typeof fetch,
  })
  const mint = gateway.prepare()
  const request = gateway.llm({}, { idemKey: 'operation:0', isLive: () => live })
  live = false
  release(answer({ token, expires_at: '2099-01-01T00:00:00Z' }, 201))
  await mint
  expect(await request).toEqual({ status: 0 })
  expect(sent.filter(url => url.endsWith('/completions'))).toEqual([])
})

it('checks liveness after reading the existing turn, at the fetch site', async () => {
  const s = setup(); await s.gateway.prepare()
  let live = true
  s.options.readTurn = async op => { live = false; return { operation_id: op, turn_id: 'host-turn', route: 'browser_mind' } }
  expect((await s.gateway.llm({}, { idemKey: 'operation:0', isLive: () => live })).status).toBe(0)
  expect(s.sent).toHaveLength(1)
})
