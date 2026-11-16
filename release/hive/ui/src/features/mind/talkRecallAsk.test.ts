import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * r2.3, end to end through the Ask store's real send(): with "Use my swarm talk in answers" off, a collected
 * conversation never appears in the turn's memory_notes, so none of it reaches what the Ask sends; turned on, it does;
 * turned off again, the very next turn has none. A hand-made client plays the host and records each request body.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), addEventListener: vi.fn(), removeEventListener: vi.fn() })

const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { askMemory } = await import('../../lib/askMemory')
const { memoryBackend } = await import('../../lib/askMemory/backend')
type AskBody = import('../../api/ask').AskBody
type HiveClient = import('../../api/client').HiveClient
type MemoryBackend = import('../../lib/askMemory/backend').MemoryBackend

// the page's memory, on durable storage (IndexedDB's stand-in), so collected conversations are kept as in a browser
const dbs = new Map<string, MemoryBackend>()
;(askMemory as unknown as { deps: { backend: (n: string) => MemoryBackend } }).deps.backend = (n) => dbs.get(n) ?? (dbs.set(n, { ...memoryBackend(), durable: true }), dbs.get(n)!)

const sent: AskBody[] = []
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
const client = {
  mode: 'sim',
  ask: vi.fn(async (b: AskBody) => {
    sent.push(JSON.parse(JSON.stringify(b)))
    return { operation_id: b.operation_id, turn_id: `t${sent.length}`, thread, state: 'accepted' as const, conductor: { model: 'm' } }
  }),
  askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't', events: [], more: false })),
  askStop: vi.fn(async () => ({})),
} as unknown as HiveClient

const FROST = { id: 'pi_frost', turn_id: 't_frost', at: Date.now() - 3_600_000, words: 'When is the first frost due at the garden?', answer: 'Around 24 October on the usual dates; the Garden swarm will cover the seedlings the week before.', truncated: false }
const notesText = (b: AskBody) => JSON.stringify(b.memory_notes ?? [])

async function turn(text: string): Promise<AskBody> {
  await useAskStore.getState().send(text, { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
  const body = sent[sent.length - 1]
  await useAskStore.getState().stop()
  useAskStore.getState().reset()
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await askMemory.whenReady()
  return body
}

afterEach(() => {
  sent.length = 0
})

describe('r2.3: what the Ask sends, with the setting off and on', () => {
  it('off (the default): collected talk present, and none of it in memory_notes; on: it goes; off again: the next turn has none', async () => {
    useHive.setState({ client, session: 'session-r23', inits: 1 })
    useAskStore.getState().bind('session-r23', 'user:p_ada')
    await askMemory.whenReady()
    await askMemory.rememberTalks([FROST])
    expect(askMemory.getView().talks.map((t) => t.id)).toEqual(['pi_frost'])
    expect(askMemory.getView().talkRecall).toBe(false)

    const off = await turn('is the garden frost coming soon')
    expect(off.text).toBe('is the garden frost coming soon')
    expect(notesText(off)).not.toMatch(/frost due|Garden swarm|conversation:/)

    askMemory.setTalkRecall(true)
    const on = await turn('is the garden frost coming soon')
    expect(notesText(on)).toMatch(/conversation: you asked “When is the first frost due at the garden\?”/)

    askMemory.setTalkRecall(false)
    const offAgain = await turn('is the garden frost coming soon')
    expect(notesText(offAgain)).not.toMatch(/frost due|Garden swarm|conversation:/)
  })
})
