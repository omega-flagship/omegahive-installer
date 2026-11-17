// Purpose: verify a person's message in a mind's own chat carries the Ask exchanges that chat has not heard, once:
// their own mind hears every exchange, another mind (another person's own mind included) those it answered, a send
// on its way holds them from the next, and a failed send keeps them for its retry.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }) }))

const { useHive } = await import('./store')
const { askMemory } = await import('../lib/askMemory')
const { AskMemoryStore } = await import('../lib/askMemory/store')
const { memoryBackend } = await import('../lib/askMemory/backend')
const { ApiError } = await import('../api/client')
type HiveClient = import('../api/client').HiveClient
type MemoryBackend = import('../lib/askMemory/backend').MemoryBackend
type Exchange = import('../lib/askMemory/types').Exchange

/**
 * Jon, 16 Nov: continuity "regardless of which model you interact", "without needing additional LLM calls to pass
 * through convo". Invented lives only: Ada (user:u_ada), her own mind Taiga, a swarm's mind Worker and Noor's own mind.
 */
const ADA = { principal: 'user:u_ada', hive: 'sim@test' }
const TAIGA = 'a_taiga01'
const WORKER = 'a_worker01'
const NOOR = 'a_noor01'

let backend: MemoryBackend
;(askMemory as unknown as { deps: { backend: (n: string) => MemoryBackend } }).deps.backend = () => backend

const sent: { id: string; body: { text: string; from_ask?: Exchange[] } }[] = []
let refuseNext = false
/** a send the hive holds until it is opened: the next message is still on its way */
let holdNext: Promise<void> | null = null
const client = {
  mode: 'sim',
  sendMessage: vi.fn(async (id: string, body: { text: string; from_ask?: Exchange[] }) => {
    sent.push({ id, body: JSON.parse(JSON.stringify(body)) })
    const hold = holdNext
    holdNext = null
    if (hold) await hold
    if (refuseNext) {
      refuseNext = false
      throw new ApiError(503, 'unavailable', 'Hub offline')
    }
    return { id: `m${sent.length}`, agent_id: id, conversation_id: `c_${id}~user:u_ada`, direction: 'in', sender: 'user:u_ada', text: body.text, created_at: new Date().toISOString() }
  }),
} as unknown as HiveClient

const said = (id: string) => sent.filter((s) => s.id === id).map((s) => s.body.from_ask?.map((e) => e.said) ?? null)

beforeEach(async () => {
  sent.length = 0
  backend = { ...memoryBackend(), durable: true }
  useHive.setState({
    client, session: 'session-mca', inits: 1, pending: {}, messages: {},
    agents: { [TAIGA]: { id: TAIGA, name: 'Taiga', personal_of: 'user:u_ada' }, [WORKER]: { id: WORKER, name: 'Worker', personal_of: null }, [NOOR]: { id: NOOR, name: 'Noor', personal_of: 'user:u_noor' } } as never,
  })
  askMemory.use(null)
  askMemory.use(ADA)
  await askMemory.whenReady()
  await askMemory.rememberTurn({ turn_id: 'at_1', mind_id: TAIGA, mind_name: 'Taiga', words: 'my code word is HEMLOCK-SEVEN', answer: 'Noted.' })
  await askMemory.rememberTurn({ turn_id: 'at_2', mind_id: WORKER, mind_name: 'Worker', words: 'what do you build?', answer: 'The garden planner.' })
})

describe('a mind\'s own chat hears what was said in the Ask, once', () => {
  it('her own mind hears every exchange, whoever answered it, and only once', async () => {
    await useHive.getState().sendMessage(TAIGA, 'what was my code word?')
    await useHive.getState().sendMessage(TAIGA, 'thanks')
    expect(said(TAIGA)).toEqual([['my code word is HEMLOCK-SEVEN', 'what do you build?'], null])
    expect(sent[0].body.from_ask?.map((e) => e.by)).toEqual([TAIGA, WORKER])
  })

  it('another mind hears the exchanges it answered, and later ones as they come', async () => {
    await useHive.getState().sendMessage(WORKER, 'and the seed tracker?')
    await askMemory.rememberTurn({ turn_id: 'at_3', mind_id: WORKER, words: 'is the planner done?', answer: 'Almost.' })
    await useHive.getState().sendMessage(WORKER, 'ok')
    await useHive.getState().sendMessage(WORKER, 'bye')
    expect(said(WORKER)).toEqual([['what do you build?'], ['is the planner done?'], null])
  })

  it('hears an exchange kept in the very millisecond it was told the last one', async () => {
    // the v0.34 tester line on a fast Mac: the next exchange's stamp tied with what the chat had heard, and the chat
    // never heard it; the clock is held at that mark here, so the tie happens on every machine
    await useHive.getState().sendMessage(WORKER, 'and the seed tracker?')
    const heard = Math.max(...(sent[0].body.from_ask ?? []).map((e) => e.at))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(heard)
    try {
      await askMemory.rememberTurn({ turn_id: 'at_3', mind_id: WORKER, words: 'is the planner done?', answer: 'Almost.' })
      await useHive.getState().sendMessage(WORKER, 'ok')
    } finally {
      clock.mockRestore()
    }
    expect(said(WORKER)).toEqual([['what do you build?'], ['is the planner done?']])
  })

  it('a send the hive did not take keeps them, and its retry carries them', async () => {
    refuseNext = true
    await useHive.getState().sendMessage(WORKER, 'hello?')
    const failed = useHive.getState().pending[WORKER][0]
    expect(failed.status).toBe('failed')
    await useHive.getState().retryMessage(WORKER, failed.tempId)
    expect(said(WORKER)).toEqual([['what do you build?'], ['what do you build?']])
  })

  it('another person\'s own mind hears what it answered, never what she said with her own mind', async () => {
    // Kabir's review of #347: a message to another member's own mind carried every Ask exchange
    await useHive.getState().sendMessage(NOOR, 'hello Noor')
    await askMemory.rememberTurn({ turn_id: 'at_3', mind_id: NOOR, mind_name: 'Noor', words: 'what does Noor keep?', answer: 'Her diary.' })
    await useHive.getState().sendMessage(NOOR, 'and next?')
    expect(said(NOOR)).toEqual([null, ['what does Noor keep?']])
  })

  it('a message sent while another is still on its way carries none of them again', async () => {
    let open = () => {}
    holdNext = new Promise<void>((resolve) => { open = resolve })
    const first = useHive.getState().sendMessage(WORKER, 'first')
    await useHive.getState().sendMessage(WORKER, 'second')
    open()
    await first
    await useHive.getState().sendMessage(WORKER, 'third')
    expect(said(WORKER)).toEqual([['what do you build?'], null, null])
  })

  it('a memory that is no named person\'s carries nothing, since the hive takes from_ask from no one else', async () => {
    askMemory.use({ principal: 'user:operator', hive: 'sim@test' })
    await askMemory.whenReady()
    await askMemory.rememberTurn({ turn_id: 'at_9', mind_id: WORKER, mind_name: 'Worker', words: 'hi', answer: 'Hello.' })
    await useHive.getState().sendMessage(WORKER, 'hello')
    expect(said(WORKER)).toEqual([null])
  })

  it('what each chat heard is kept in her browser across a reload', async () => {
    await useHive.getState().sendMessage(WORKER, 'hello')
    await askMemory.flushed()
    const again = new AskMemoryStore({ backend: () => backend, persist: () => undefined, channel: null })
    again.use(ADA)
    await again.whenReady()
    expect(again.unheardBy({ id: WORKER })).toEqual([])
    expect(again.unheardBy({ id: TAIGA, personal_of: 'user:u_ada' }).map((e) => e.said)).toEqual(['my code word is HEMLOCK-SEVEN', 'what do you build?'])
  })
})
