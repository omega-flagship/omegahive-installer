// Purpose: prove the Ask speaks as the person's own mind and recalls what they discussed with it across threads.
import { describe, expect, it } from 'vitest'
import { memoryBackend } from '../../lib/askMemory/backend'
import { recall, MIND_TALKS_MAX, type Forgets } from '../../lib/askMemory/recall'
import { AskMemoryStore } from '../../lib/askMemory/store'
import type { Talk } from '../../lib/askMemory/types'
import { readCapabilities, type AskEvent } from '../../api/ask'
import { turnRows, type TurnMeta } from '../../store/ask'
import { answerText, keptMindTalk, keptWords } from './Earlier'
import { answererChip, chipWords, nativeAnswererWords, routeAround } from './answerer'

/**
 * mind-voice r1 (Jon 11-03 and 11-09: the Ask is the person's mind). Invented lives only: Ada (user:p_inv_ada) and her
 * mind Taiga (a_inv_taiga). Thread A: they discuss a travel app. Thread B: "what about that travel app?".
 */

const T0 = Date.parse('2026-11-09T12:00:00Z')
const none: Forgets = { tombs: [], salt: 'ab'.repeat(16), genAt: 0 }
const TAIGA = 'a_inv_taiga'
const A_WORDS = "Let's design a travel app for long-distance hikers: offline maps and resupply stops."
const A_ANSWER = "Taiga here. A hikers' travel app: offline trail maps first, then resupply stops along the route."
const threadA: Talk = { id: 'mind_at_inv_a', turn_id: 'at_inv_a', at: T0 - 3_600_000, words: A_WORDS, answer: A_ANSWER, truncated: false, kept_at: T0 - 3_599_000, mind_id: TAIGA }

describe('the mind remembers its earlier threads with the person', () => {
  it('a new thread asking "what about that travel app?" recalls thread A for that mind only', () => {
    const r = recall([], 'what about that travel app?', { now: T0, talks: [threadA], forgets: none, mind: TAIGA })
    expect(r.ids).toEqual(['mind_at_inv_a'])
    expect(r.notes[0].text).toMatch(/^earlier thread with you: they asked “Let's design a travel app/)
    // another mind's turn, or a turn to no mind, never gets it; an unrelated question does not either
    expect(recall([], 'what about that travel app?', { now: T0, talks: [threadA], forgets: none, mind: 'a_inv_other' }).ids).toEqual([])
    expect(recall([], 'what about that travel app?', { now: T0, talks: [threadA], forgets: none }).ids).toEqual([])
    expect(recall([], 'book a dentist for Tuesday', { now: T0, talks: [threadA], forgets: none, mind: TAIGA }).ids).toEqual([])
  })

  it('is bounded: at most MIND_TALKS_MAX earlier threads, most relevant first', () => {
    const many = Array.from({ length: 12 }, (_, i): Talk => ({ ...threadA, id: `mind_at_inv_${i}`, turn_id: `at_inv_${i}`, words: `travel app idea ${i}`, answer: `the travel app, part ${i}` }))
    const r = recall([], 'what about that travel app?', { now: T0, talks: many, forgets: none, mind: TAIGA })
    expect(r.ids.length).toBe(MIND_TALKS_MAX)
  })

  it('the store keeps a finished exchange with the mind and recalls it for that mind under mind_memory, memory off', async () => {
    const s = new AskMemoryStore({ backend: () => ({ ...memoryBackend(), durable: true }), now: () => T0, persist: () => undefined, channel: null })
    s.use({ principal: 'user:p_inv_ada', hive: 'sim@test' })
    await s.whenReady()
    s.hiveCaps(readCapabilities({ conductor: true, memory: false, mind_memory: true }))
    expect(await s.rememberTurn({ turn_id: 'at_inv_a', mind_id: TAIGA, words: A_WORDS, answer: A_ANSWER })).toBe(true)
    expect(s.getView().talks).toMatchObject([{ id: 'mind_at_inv_a', mind_id: TAIGA }])
    // thread B is a new thread, so a new conversation: thread A is no longer carried, and is recalled as Taiga's memory
    s.startConversation()
    expect(s.notesFor('what about that travel app?', TAIGA).ids).toEqual(['mind_at_inv_a'])
    expect(s.notesFor('what about that travel app?').ids).toEqual([])                 // a turn to anyone else: none
    expect(s.notesFor('what about that travel app?', 'a_inv_other').ids).toEqual([])
    // "Earlier" shows the words this browser kept, though the hive keeps none for a personal turn
    const w = keptWords({ text: '' }, keptMindTalk(s.getView().talks, 'at_inv_a'))
    expect(w).toEqual({ text: A_WORDS, removed: false, answer: A_ANSWER })
    // the host without the switch: memory off means none at all
    s.hiveCaps(readCapabilities({ conductor: true, memory: false }))
    expect(s.notesFor('what about that travel app?', TAIGA).ids).toEqual([])
  })
})

const ev = (seq: number, text: string, delta = false): AskEvent => ({ operation_id: 'op-inv-b', turn_id: 'at_inv_b', seq, at: '2026-11-09T12:00:00Z', phase: 'answer', text, ...(delta ? { delta: true } : {}) }) as unknown as AskEvent
const REPLY = "Taiga here: the hikers' travel app from before. Next I'd sketch the offline trail maps screen."

describe('the reply renders once', () => {
  it('a said piece then the whole answer is one answer row with the whole text', () => {
    const t = { op: 'op-inv-b', you: 'what about that travel app?', events: [ev(2, REPLY, true), ev(3, REPLY)], outcomes: {}, steers: [], notes: [], actingAs: { mind_id: TAIGA, name: 'Taiga' } } as unknown as TurnMeta
    const rows = turnRows(t, 'Taiga')
    const answers = rows.filter((r) => r.kind === 'answer')
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ text: REPLY, who: 'Taiga' })
    expect(rows.map((r) => r.text).join('\n').split(REPLY).length - 1).toBe(1)
    expect(rows.some((r) => /Ask conductor/.test(r.text ?? ''))).toBe(false)
  })

  it('"Earlier" reads the whole answer, not the pieces and the whole together', () => {
    expect(answerText([ev(2, REPLY, true), ev(3, REPLY)])).toBe(REPLY)
    expect(answerText([ev(2, 'Opening it.', true)])).toBe('Opening it.')               // cut off: the pieces alone
  })
})

describe('the person never appears as an answerer; their mind does', () => {
  // Haley (an invented person) has deployed her mind as Taiga
  const taiga = { id: TAIGA, name: 'Taiga', swarm_id: 's_inv_taiga' }
  const settings = { swarm_id: null, eligible: [] }
  it('the floating box chip names the mind, never "you" or the person', () => {
    const chip = answererChip({ settings, personal: taiga })!
    for (const words of [chipWords(chip), nativeAnswererWords(chip, 'construct'), nativeAnswererWords(chip, 'professional'), nativeAnswererWords(chip, 'still')]) {
      expect(words.toLowerCase()).toContain('taiga')
      expect(words).not.toMatch(/\byou\b|Haley/i)
    }
  })
  it('a page swarm that cannot answer routes to the mind, said by its name', () => {
    const r = routeAround({ swarm_id: 's_inv_evo' } as never, { swarm_id: null, eligible: [{ id: 's_inv_lyra', name: 'Lyra', orchestrator: { id: 'a_o', name: 'Orion', status: 'awake' } }] } as never, taiga, () => ({ name: 'Evolve', coordinator_id: null }) as never)
    expect(r.note).toBe('Answering: Taiga')
  })
  it('the mind’s thread says the mind answers for the person, in its name', () => {
    const t = { op: 'op-inv-c', you: 'hello', events: [ev(2, 'Taiga here.')], outcomes: {}, steers: [], notes: [], actingAs: { mind_id: TAIGA, name: 'Taiga' } } as unknown as TurnMeta
    const rows = turnRows(t, 'Taiga')
    expect(rows.find((r) => r.id.endsWith('#as'))?.text).toBe('Answering for you: your mind Taiga.')
    expect(rows.filter((r) => r.kind === 'answer').map((r) => (r as { who?: string }).who)).toEqual(['Taiga'])
  })
})
