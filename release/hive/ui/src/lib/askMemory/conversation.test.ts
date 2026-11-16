// Purpose: verify the person's Ask conversation as their browser keeps and carries it: every answered exchange with the
// mind that answered, the latest window a turn sends within the host's caps, the new-conversation mark across a reload,
// and the private-app fence.
import { describe, expect, it } from 'vitest'
import { memoryBackend, type MemoryBackend } from './backend'
import { buildFile, readFile } from './file'
import { AskMemoryStore } from './store'
import { CONVERSATION_ANSWER_MAX, CONVERSATION_LATEST_ANSWER_MAX, CONVERSATION_MAX, CONVERSATION_MAX_BYTES, CONVERSATION_SAID_MAX } from './types'

/**
 * Jon, 16 Nov: one identity mind, "context and continuity are consistently persistent regardless of which model you
 * interact", "without needing additional LLM calls to pass through convo". Invented lives only: Ada (user:p_inv_ada),
 * her own mind Taiga (a_inv_taiga) and a swarm's mind Worker (a_inv_worker).
 */
const T0 = Date.parse('2026-11-16T05:00:00Z')
const TAIGA = 'a_inv_taiga'
const WORKER = 'a_inv_worker'
const ADA = { principal: 'user:p_inv_ada', hive: 'sim@test' }

function store(backend: MemoryBackend = { ...memoryBackend(), durable: true }, clock = { t: T0 }) {
  const s = new AskMemoryStore({ backend: () => backend, now: () => clock.t, persist: () => undefined, channel: null })
  s.use(ADA)
  return { s, backend, clock }
}
const bytes = (x: string) => new TextEncoder().encode(x).length

describe('every answered exchange joins the conversation with the mind that answered it', () => {
  it('keeps exchanges answered by her own mind and by another mind, and carries them oldest first', async () => {
    const { s, clock } = store()
    await s.whenReady()
    expect(await s.rememberTurn({ turn_id: 'at_1', mind_id: TAIGA, mind_name: 'Taiga', words: 'my code word is HEMLOCK-SEVEN', answer: 'Noted.' })).toBe(true)
    clock.t += 60_000
    expect(await s.rememberTurn({ turn_id: 'at_2', mind_id: WORKER, mind_name: 'Worker', words: 'what do you build?', answer: 'The garden planner.' })).toBe(true)
    expect(s.getView().talks.map((t) => [t.mind_id, t.mind_name])).toEqual([[TAIGA, 'Taiga'], [WORKER, 'Worker']])
    expect(s.conversation()).toEqual([
      { said: 'my code word is HEMLOCK-SEVEN', answer: 'Noted.', by: TAIGA, at: T0 },
      { said: 'what do you build?', answer: 'The garden planner.', by: WORKER, at: T0 + 60_000 },
    ])
  })

  it('carries the latest CONVERSATION_MAX, each cut to its share, the latest answer keeping the most', async () => {
    const { s, clock } = store()
    await s.whenReady()
    for (let i = 0; i < CONVERSATION_MAX + 3; i++) {
      clock.t += 1000
      await s.rememberTurn({ turn_id: `at_${i}`, mind_id: TAIGA, words: `question ${i} ${'w'.repeat(900)}`, answer: `answer ${i} ${'a'.repeat(3000)}` })
    }
    const c = s.conversation()
    expect(c.map((e) => e.said.slice(0, 11))).toEqual(Array.from({ length: CONVERSATION_MAX }, (_, i) => `question ${i + 3}`.padEnd(11, ' ')))
    expect(c.every((e) => e.said.length <= CONVERSATION_SAID_MAX)).toBe(true)
    expect(c.slice(0, -1).every((e) => e.answer.length <= CONVERSATION_ANSWER_MAX)).toBe(true)
    expect(c[c.length - 1].answer.length).toBe(CONVERSATION_LATEST_ANSWER_MAX)
    expect(c[c.length - 1].answer.endsWith('…')).toBe(true)
  })

  it('drops the oldest until the whole fits the host\'s 8 KB, counting UTF-8 bytes', async () => {
    const { s, clock } = store()
    await s.whenReady()
    for (let i = 0; i < CONVERSATION_MAX; i++) {
      clock.t += 1000
      // four bytes a character: a 400-character cut is 1.6 KB
      await s.rememberTurn({ turn_id: `at_wide_${i}`, mind_id: TAIGA, words: '😀'.repeat(600), answer: '😀'.repeat(600) })
    }
    const c = s.conversation()
    const size = c.reduce((n, e) => n + bytes(e.said) + bytes(e.answer) + bytes(e.by), 0)
    expect(size).toBeLessThanOrEqual(CONVERSATION_MAX_BYTES)
    expect(c.length).toBeGreaterThan(0)
    expect(c[c.length - 1].at).toBe(T0 + CONVERSATION_MAX * 1000)   // the latest is never the one dropped
  })

  it('never keeps or carries a private app\'s words', async () => {
    const { s } = store()
    await s.whenReady()
    expect(await s.rememberTurn({ turn_id: 'at_p', mind_id: TAIGA, words: 'how did I sleep per Atlas?', answer: 'Seven hours.' })).toBe(false)
    expect(s.conversation()).toEqual([])
  })
})

describe('a new conversation starts at New thread, and stays started across a reload', () => {
  it('carries nothing from before the mark, then what follows it; a reload reads the same mark', async () => {
    const backend: MemoryBackend = { ...memoryBackend(), durable: true }
    const clock = { t: T0 }
    const { s } = store(backend, clock)
    await s.whenReady()
    await s.rememberTurn({ turn_id: 'at_old', mind_id: TAIGA, words: 'the old topic', answer: 'Old answer.' })
    clock.t += 1000
    s.startConversation()
    await s.flushed()
    expect(s.conversation()).toEqual([])
    clock.t += 1000
    await s.rememberTurn({ turn_id: 'at_new', mind_id: WORKER, words: 'the new topic', answer: 'New answer.' })
    expect(s.conversation().map((e) => e.said)).toEqual(['the new topic'])
    // the page reloads: a new store over the same storage reads the mark and the talks again
    const again = store(backend, clock).s
    await again.whenReady()
    expect(again.getView().conversationSince).toBe(T0 + 1000)
    expect(again.conversation().map((e) => e.said)).toEqual(['the new topic'])
    expect(again.conversationTalks().map((t) => t.words)).toEqual(['the new topic'])
  })

  it('an exchange the turn carries is not recalled again as a note for her own mind', async () => {
    const { s } = store()
    await s.whenReady()
    s.hiveCaps({ conductor: true, memory: false, mind_memory: true })
    await s.rememberTurn({ turn_id: 'at_trip', mind_id: TAIGA, words: 'plan the hiking trip', answer: 'Trail maps first.' })
    expect(s.conversation().map((e) => e.said)).toEqual(['plan the hiking trip'])
    expect(s.notesFor('the hiking trip again', TAIGA).ids).toEqual([])
    s.startConversation()
    expect(s.notesFor('the hiking trip again', TAIGA).ids).toEqual(['mind_at_trip'])   // out of the window: recalled
  })
})

describe('the answering mind\'s name travels with the exchange through a memory file', () => {
  it('export, then restore into an empty memory, keeps mind_id and mind_name', async () => {
    const { s } = store()
    await s.whenReady()
    await s.rememberTurn({ turn_id: 'at_f', mind_id: WORKER, mind_name: 'Worker', words: 'what do you build?', answer: 'The garden planner.' })
    const v = s.getView()
    const file = buildFile({ beliefs: v.beliefs, talks: v.talks, tombs: [], gen: 0, gen_at: 0, salt: 'ab'.repeat(16) }, ADA, T0)
    const read = readFile(JSON.stringify(file), ADA)
    expect(read.ok && read.file.entries.filter((e) => e.type === 'talk')).toMatchObject([{ mind_id: WORKER, mind_name: 'Worker' }])
  })
})
