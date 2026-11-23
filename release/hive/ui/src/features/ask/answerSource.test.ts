// Purpose: verify each Ask answer's source and the research held back for an asleep Research swarm: the intent frame as
// the page reads it, the rows the store derives from a turn's frames, the ask-answer screen's facts and words, and what
// MeTTa composes from them in every look, the press offered only where it can go through.
import { describe, expect, it, vi } from 'vitest'
import { checkAskEvent, readAsleepResearch, type AskEvent } from '../../api/ask'
import { ScreensSpace } from '../../screens/screenSpace'
import { turnRows, type AskRow, type TurnMeta } from '../../store/ask'
import type { ResearchWakeView } from '../../store/askResearchWake'
import { answerScreen, waitPhase } from './answerFacts'
import { answerSourceWords, researchWakeWords } from './words'

// it opens a real MeTTa space: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const LOOKS = ['classic', 'cosmos', 'flux', 'canvas', 'still', 'construct', 'professional']
const vega = { id: 'a_vega1', name: 'Vega' }
const at = '2026-11-20T05:13:00Z'
const frame = (seq: number, f: Record<string, unknown>): AskEvent => ({ type: 'ask', operation_id: 'op_res1', turn_id: 'at_res1', seq, at, ...f }) as unknown as AskEvent
const accepted = (conducted?: unknown) => frame(1, { phase: 'accepted', thread: { id: 'ses_t', mind: vega, budget_usd: 0.25, spent_usd: 0 }, ...(conducted !== undefined ? { conducted } : {}) })
const turn = (events: AskEvent[]): TurnMeta => ({
  op: 'op_res1', you: 'Look up whether the city aquarium opens next Sunday', state: 'done', lastSeq: events.length, outcomes: {}, notes: [], steers: [], moves: 0,
  tookOver: false, presence: 0, ahead: [], events,
})
const ASLEEP = 'The Research swarm is asleep, so I didn\'t send this yet. Waking it sends the request; here\'s what I can tell you myself meanwhile.'
const answers = (rows: AskRow[]) => rows.filter((r) => r.kind === 'answer')

describe('the intent frame, as the page reads it', () => {
  it('takes an intent move with its state and a refusal’s reason, and nothing malformed', () => {
    const ok = checkAskEvent(frame(3, { phase: 'intent', intent_id: 'ai_res1', state: 'refused', reason: 'researcher_asleep', links_rev: 2 }))
    expect(ok && ok.phase === 'intent' && [ok.state, ok.reason]).toEqual(['refused', 'researcher_asleep'])
    expect(checkAskEvent(frame(3, { phase: 'intent', intent_id: 'ai_res1', state: 'dispatching', dispatch_id: 'ad_1' }))).not.toBeNull()
    expect(checkAskEvent(frame(3, { phase: 'intent', intent_id: 'ai_res1', state: 'sent' }))).toBeNull()
    expect(checkAskEvent(frame(3, { phase: 'intent', intent_id: 'ai_res1', state: 'refused', reason: 'The swarm is asleep' }))).toBeNull()
    expect(checkAskEvent(frame(3, { phase: 'intent', intent_id: '../x', state: 'refused' }))).toBeNull()
  })
  it('reads an intent view as research held back by an asleep swarm only when it is exactly that', () => {
    const view = { kind: 'research.request', state: 'refused', last_refusal: { code: 'not_available', reason: 'researcher_asleep' }, destination: { to_swarm: 's_research' } }
    expect(readAsleepResearch(view)).toEqual({ swarm: 's_research' })
    expect(readAsleepResearch({ ...view, state: 'linked' })).toBeNull()
    expect(readAsleepResearch({ ...view, kind: 'task.create' })).toBeNull()
    expect(readAsleepResearch({ ...view, last_refusal: { code: 'not_available', reason: 'no_researcher' } })).toBeNull()
    expect(readAsleepResearch({ ...view, destination: {} })).toBeNull()
    expect(readAsleepResearch(null)).toBeNull()
  })
})

describe('the rows a turn’s frames give', () => {
  it('a conducted turn’s answers come from the model its accepted frame names, alone; a turn the page can’t place says nothing', () => {
    const said = [frame(2, { phase: 'answer', text: 'The aquarium usually opens', delta: true }), frame(3, { phase: 'answer', text: 'The aquarium usually opens at nine on Sundays.' })]
    expect(answers(turnRows(turn([accepted('mind'), ...said]))).map((r) => r.source)).toEqual([{ kind: 'model', of: 'mind' }])
    expect(answers(turnRows(turn([accepted('ask'), ...said]))).map((r) => r.source)).toEqual([{ kind: 'model', of: 'ask' }])
    expect(answers(turnRows(turn([accepted(), ...said]))).map((r) => r.source)).toEqual([undefined])
    // a value the host never sends (an older host's true) names no model, so nothing is said
    expect(answers(turnRows(turn([accepted(true), ...said]))).map((r) => r.source)).toEqual([undefined])
  })
  it('research refused because the Research swarm is asleep waits under the turn’s last answer, and follows its intent', () => {
    const events = [accepted('mind'), frame(2, { phase: 'intent', intent_id: 'ai_res1', state: 'pending' }), frame(3, { phase: 'intent', intent_id: 'ai_res1', state: 'dispatching' }),
      frame(4, { phase: 'intent', intent_id: 'ai_res1', state: 'refused', reason: 'researcher_asleep' }), frame(5, { phase: 'answer', text: ASLEEP, delta: true }),
      frame(6, { phase: 'answer', text: `${ASLEEP} The aquarium usually opens at nine on Sundays.` }), frame(7, { phase: 'done', outcome: 'complete' })]
    const rows = answers(turnRows(turn(events)))
    expect(rows.map((r) => r.wait)).toEqual([{ intent: 'ai_res1', state: 'refused' }])
    // woken and sent again (from this page or another): the same intent's later frames move it on
    const sent = answers(turnRows(turn([...events, frame(8, { phase: 'intent', intent_id: 'ai_res1', state: 'dispatching' }), frame(9, { phase: 'intent', intent_id: 'ai_res1', state: 'linked' })])))
    expect(sent.map((r) => r.wait)).toEqual([{ intent: 'ai_res1', state: 'linked' }])
  })
  it('a refusal for any other reason, or another intent’s moves, puts nothing under the answer', () => {
    const rows = answers(turnRows(turn([accepted('mind'), frame(2, { phase: 'intent', intent_id: 'ai_res1', state: 'refused', reason: 'no_researcher' }),
      frame(3, { phase: 'intent', intent_id: 'ai_task1', state: 'linked' }), frame(4, { phase: 'answer', text: 'Here is what I know.' })])))
    expect(rows.map((r) => r.wait)).toEqual([undefined])
  })
})

describe('the words and facts under an answer', () => {
  const view = (v: Partial<ResearchWakeView>): ResearchWakeView => ({ phase: 'working', name: 'Research controller', ...v })
  it('names where an answer came from', () => {
    expect(answerSourceWords({ kind: 'model', of: 'mind' }, 'Vega')).toBe('From Vega’s model alone, without a web search.')
    expect(answerSourceWords({ kind: 'model', of: 'mind' })).toBe('From your mind’s model alone, without a web search.')
    // a swarm turn spoken in the person's own mind's voice: the model is the Ask's, never called the mind's
    expect(answerSourceWords({ kind: 'model', of: 'ask' }, 'Vega')).toBe('From the Ask’s model alone, without a web search.')
  })
  it('the intent’s own state wins over this page’s press, a request not read yet is checking, and each phase has its words', () => {
    expect(waitPhase('refused', null)).toBe('checking')
    expect(waitPhase('refused', view({ phase: 'checking' }))).toBe('checking')
    expect(waitPhase('refused', view({ phase: 'ready', press: 'wake' }))).toBe('ready')
    expect(waitPhase('dispatching', null)).toBe('working')
    expect(waitPhase('linked', null)).toBe('sent')
    expect(waitPhase('abandoned', view({ phase: 'failed' }))).toBe('closed')
    expect(waitPhase('refused', view({ phase: 'failed', unsent: 'gone' }))).toBe('closed')
    expect(waitPhase('refused', view({ phase: 'blocked', gate: 'authority' }))).toBe('blocked')
    expect(researchWakeWords('checking', null)).toBe('')
    expect(researchWakeWords('ready', null)).toBe('')
    expect(researchWakeWords('working', view({ step: 'waking' }))).toBe('Waking Research controller…')
    expect(researchWakeWords('working', null)).toBe('Sending the research to the Research swarm…')
    expect(researchWakeWords('sent', view({ phase: 'sent' }))).toBe('Sent to Research controller. Its report comes back to this conversation.')
    // who may wake it is the host's rule: its owner or a hive admin
    expect(researchWakeWords('blocked', view({ phase: 'blocked', gate: 'authority' }))).toBe('Only Research controller’s owner or a hive admin can wake it, so the research wasn’t sent.')
    expect(researchWakeWords('blocked', { phase: 'blocked', gate: 'authority' })).toBe('Only the Research swarm’s owner or a hive admin can wake it, so the research wasn’t sent.')
    expect(researchWakeWords('blocked', view({ phase: 'blocked' }))).toBe('Research controller can’t be woken right now, so the research wasn’t sent.')
    expect(researchWakeWords('blocked', view({ phase: 'blocked', gate: 'spending' }))).toBe('Research controller has reached its spending limit, so it can’t wake for this research.')
    expect(researchWakeWords('failed', view({ phase: 'failed', reason: 'start refused: no model key' }))).toBe('Couldn’t wake Research controller. The hive says: start refused: no model key.')
    expect(researchWakeWords('failed', view({ phase: 'failed', unsent: 'send' }))).toBe('Research controller is awake, but the research wasn’t sent. Press again to send it.')
    expect(researchWakeWords('closed', null)).toBe('This research can’t be sent from here any more. Ask again to send it.')
  })
  it('states a value only for what the row holds, so nothing is decided for a row with neither', () => {
    expect(answerScreen({ who: 'Vega', whoId: 'a_vega1' }, null).facts).toEqual({ flags: { 'answer.wait': false, 'answer.wait.awake': false }, values: {} })
    const both = answerScreen({ who: 'Vega', whoId: 'a_vega1', source: { kind: 'model', of: 'mind' }, wait: { intent: 'ai_res1', state: 'refused' } }, null)
    expect(both.facts).toEqual({ flags: { 'answer.wait': true, 'answer.wait.awake': false }, values: { 'answer.source': 'model', 'answer.wait.phase': 'checking' } })
    expect(both.data).toEqual({ 'answer.source.text': 'From Vega’s model alone, without a web search.', 'answer.wait.say': '' })
  })
  it('says the Research swarm is awake when the check found it so, or a press woke it and the send then failed', () => {
    const wait = { who: 'Vega', wait: { intent: 'ai_res1', state: 'refused' as const } }
    const awake = (v: ResearchWakeView) => answerScreen(wait, v).facts.flags?.['answer.wait.awake']
    expect(awake(view({ phase: 'ready', press: 'send' }))).toBe(true)
    expect(awake(view({ phase: 'failed', unsent: 'send' }))).toBe(true)
    expect(awake(view({ phase: 'ready', press: 'wake' }))).toBe(false)
    expect(awake(view({ phase: 'failed', reason: 'start refused: no model key' }))).toBe(false)
    // no request waits under this answer: nothing is awake for it
    expect(answerScreen({ who: 'Vega' }, view({ phase: 'ready', press: 'send' })).facts.flags?.['answer.wait.awake']).toBe(false)
  })
})

describe('what MeTTa composes under an answer, in every look', () => {
  const space = ScreensSpace.open()
  const compose = (look: string, r: Pick<AskRow, 'source' | 'wait' | 'who' | 'whoId'>, v: ResearchWakeView | null = null) =>
    space.compose('ask-answer', look, answerScreen(r, v).facts)
  const kinds = (look: string, r: Pick<AskRow, 'source' | 'wait' | 'who' | 'whoId'>, v: ResearchWakeView | null = null) =>
    compose(look, r, v).parts.map((p) => `${p.order}:${p.block}`)
  const alone = { who: 'Vega', source: { kind: 'model' as const, of: 'mind' as const } }
  const waiting = { ...alone, wait: { intent: 'ai_res1', state: 'refused' as const } }
  const ready = (press: 'wake' | 'send'): ResearchWakeView => ({ phase: 'ready', name: 'Research controller', press })
  const button = (look: string, v: ResearchWakeView) => compose(look, waiting, v).parts.find((p) => p.block === 'buttons')?.props.items
  it.each(LOOKS)('%s: the source line alone, the press once a check finds it can send, and nothing for a row with neither', (look) => {
    expect(kinds(look, alone)).toEqual(['10:note'])
    expect(kinds(look, { who: 'Vega' })).toEqual([])
    // not read yet: nothing offered, nothing said
    expect(kinds(look, waiting)).toEqual(['10:note'])
    expect(kinds(look, waiting, { phase: 'checking' })).toEqual(['10:note'])
    expect(kinds(look, waiting, ready('wake'))).toEqual(['10:note', '21:buttons'])
    expect(button(look, ready('wake'))).toEqual([['button', 'Wake Research and send', 'wake-research', [['variant', 'ghost']]]])
    // the coordinator awake already: the same press only sends, and says so
    expect(kinds(look, waiting, ready('send'))).toEqual(['10:note', '22:buttons'])
    expect(button(look, ready('send'))).toEqual([['button', 'Send the research', 'wake-research', [['variant', 'ghost']]]])
    expect(compose(look, waiting, ready('send')).missing).toEqual([])
    // a person who may not wake it gets the reason and no press
    expect(kinds(look, waiting, { phase: 'blocked', gate: 'authority', name: 'Research controller' })).toEqual(['10:note', '20:note'])
  })
  it.each(LOOKS)('%s: once pressed, its state is said, and the press comes back only after a wake or send that failed', (look) => {
    const v = (over: Partial<ResearchWakeView>): ResearchWakeView => ({ phase: 'working', name: 'Research controller', ...over })
    expect(kinds(look, waiting, v({ step: 'waking' }))).toEqual(['10:note', '20:note'])
    expect(kinds(look, waiting, v({ phase: 'blocked', gate: 'authority' }))).toEqual(['10:note', '20:note'])
    expect(kinds(look, waiting, v({ phase: 'failed' }))).toEqual(['10:note', '20:note', '21:buttons'])
    expect(kinds(look, waiting, v({ phase: 'failed', unsent: 'send' }))).toEqual(['10:note', '20:note', '22:buttons'])
    expect(kinds(look, { ...waiting, wait: { intent: 'ai_res1', state: 'linked' } })).toEqual(['10:note', '20:note'])
    expect(kinds(look, waiting, v({ phase: 'failed', unsent: 'gone' }))).toEqual(['10:note', '20:note'])
  })
})
