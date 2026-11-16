/** The page's trusted RPC boundary. The worker receives neither credentials nor an HTTP client. */
export function createIterWorkerRpc(opts: {
  operation: string
  current(): boolean
  operationNow(): string | null
  experience(): string
  memory(): Promise<[string, string][]>
  /** The broker owns and checkpoints step time; never synthesize a clock value in this adapter. */
  clock?(operation: string): string | Promise<string>
  /** The broker alone owns queued, checkpointed channel input at the next step boundary. */
  receive?(operation: string): string | Promise<string>
  request(body: object): Promise<unknown>
  workerReply(body: unknown): unknown
  tool(operation: string, id: string, name: string, args: string): Promise<unknown>
  reply(message: { reply: number; value: unknown }): void
}) {
  const seen = new Set<number>()
  let busy = false, disposed = false
  const alive = () => !disposed && opts.current() && opts.operationNow() === opts.operation
  const assertLive = () => { if (!alive()) throw new Error('stale Iter worker') }
  return {
    async handle(data: unknown): Promise<void> {
      assertLive()
      if (!data || typeof data !== 'object') throw new Error('invalid Iter RPC')
      const { rpc, type, payload } = data as { rpc?: unknown; type?: unknown; payload?: unknown }
      if (typeof rpc !== 'number' || !Number.isSafeInteger(rpc) || rpc < 1 || seen.has(rpc) || busy) throw new Error('duplicate or concurrent Iter RPC')
      seen.add(rpc)
      busy = true
      try {
        let value: unknown
        if (type === 'experience') value = opts.experience()
        else if (type === 'memory.list') value = await opts.memory()
        else if (type === 'receive') {
          if (!opts.receive) throw new Error('Iter channel input unavailable')
          const words = await opts.receive(opts.operation)
          if (typeof words !== 'string') throw new Error('invalid Iter channel input')
          value = { words }
        }
        else if (type === 'clock') {
          if (!opts.clock) throw new Error('Iter step clock unavailable')
          const time = await opts.clock(opts.operation)
          if (typeof time !== 'string' || !time) throw new Error('invalid Iter step clock')
          value = { time }
        }
        else if (type === 'llm') {
          const p = payload as { messages?: unknown; tools?: unknown; maxTokens?: unknown } | null
          if (!p || typeof p.messages !== 'string' || typeof p.tools !== 'string' || typeof p.maxTokens !== 'number' || !Number.isSafeInteger(p.maxTokens) || p.maxTokens < 1) throw new Error('invalid Iter model request')
          const messages: unknown = JSON.parse(p.messages), tools: unknown = JSON.parse(p.tools)
          if (!Array.isArray(messages) || !messages.length || !Array.isArray(tools)) throw new Error('invalid Iter model body')
          const answer = await opts.request({ messages, tools, max_tokens: Math.min(p.maxTokens, 8192) })
          assertLive()
          value = opts.workerReply(answer)
        } else if (type === 'tool') {
          const p = payload as { toolCallId?: unknown; name?: unknown; args?: unknown } | null
          if (!p || typeof p.toolCallId !== 'string' || !p.toolCallId || typeof p.name !== 'string' || typeof p.args !== 'string') throw new Error('invalid Iter tool request')
          // The accepted broker checks the model-issued id, name and exact arguments. Never infer an id here.
          value = await opts.tool(opts.operation, p.toolCallId, p.name, p.args)
        } else throw new Error('unknown Iter RPC')
        assertLive()
        opts.reply({ reply: rpc, value })
      } finally { busy = false }
    },
    dispose() { disposed = true },
  }
}
