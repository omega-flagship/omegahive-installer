// Purpose: verify that the Ask names the mind whose voice answers, not the coordinator a turn is routed to.
import { describe, expect, it } from 'vitest'
import type { TurnMeta } from '../../store/ask'
import { turnRows } from '../../store/ask'
import { speaker, speakerName, threadInfo } from './answerer'
import { setOwnMind, shownMind } from './words'

const coord = { id: 'a_rev01', name: 'Review controller' }
const own = { id: 'a_ber01', name: 'Berton’s mind', swarm_id: 's_own', status: 'asleep' }
const turn = (over: Partial<TurnMeta> = {}): TurnMeta => ({
  op: 'ask:files', you: 'Can the hive see my linked folder?', state: 'done', lastSeq: 2, outcomes: {}, notes: [], steers: [], moves: 0, tookOver: false, presence: 0, ahead: [],
  events: [
    { type: 'ask', operation_id: 'ask:files', turn_id: 'at_1', seq: 1, at: '2026-11-10T22:31:00Z', phase: 'accepted', thread: { id: 'ses_rev', mind: coord, budget_usd: 0.25, spent_usd: 0 } },
    { type: 'ask', operation_id: 'ask:files', turn_id: 'at_1', seq: 2, at: '2026-11-10T22:31:08Z', phase: 'answer', text: 'I can tell you what I know.' },
  ],
  ...over,
})

describe('the mind whose voice answers is the one named', () => {
  it('an answer on a swarm’s thread is named by its speaker (speaks_as), never the coordinator it was routed to', () => {
    const rows = turnRows(turn({ speaksAs: { mind_id: own.id, name: own.name } }), coord.name)
    expect(rows.find((r) => r.kind === 'answer')).toMatchObject({ who: 'Berton’s mind', text: 'I can tell you what I know.' })
  })

  it('a turn from a host that does not say who speaks keeps the thread’s mind, as before', () => {
    expect(turnRows(turn(), coord.name).find((r) => r.kind === 'answer')?.who).toBe('Review controller')
  })

  it('the info line says whose voice it is before whose thread, and keeps the audit sentence', () => {
    const t = { mind: coord }
    expect(threadInfo(t, own, (n) => n, () => undefined, { mind_id: own.id, name: own.name }))
      .toBe('Your mind Berton’s mind answers for you here, working with Review controller. Admins can review this in the audit log.')
    expect(threadInfo(t, own, (n) => n)).toBe('Answers come from Review controller’s own knowledge. Admins can review this in the audit log.')
  })

  // the hive names a person's own mind "Your mind" until they name it (core/personal.py DEFAULT_MIND_NAME)
  it('the info line says an own mind with no name of its own once: "Your mind answers", never "Your mind Your mind"', () => {
    const unnamed = { ...own, name: 'Your mind' }
    expect(threadInfo({ mind: coord }, unnamed, (n) => n, () => undefined, { mind_id: own.id, name: 'Your mind' }))
      .toBe('Your mind answers for you here, working with Review controller. Admins can review this in the audit log.')
    expect(threadInfo({ mind: coord }, { ...own, name: 'Taiga' }, (n) => n, () => undefined, { mind_id: own.id, name: 'Taiga' }))
      .toBe('Your mind Taiga answers for you here, working with Review controller. Admins can review this in the audit log.')
  })

  it('the "Answering for you" note says an own mind with no name of its own once: "your mind", never "your mind Your mind"', () => {
    const note = (name: string) => turnRows(turn({ actingAs: { mind_id: own.id, name } }), coord.name).find((r) => r.id.endsWith('#as'))?.text
    expect(note('Your mind')).toBe('Answering for you: your mind.')
    expect(note('Taiga')).toBe('Answering for you: your mind Taiga.')
  })

  it('before sending: with the conductor on, the person’s own mind is the voice wherever the request goes', () => {
    expect(speakerName({ conductor: true, personal: own, reaches: 'Review controller' })).toBe('Berton’s mind')
    expect(speakerName({ conductor: false, personal: own, reaches: 'Review controller' })).toBe('Review controller')
    expect(speakerName({ conductor: true, personal: null, reaches: 'Review controller' })).toBe('Review controller')
  })

  it('#73 with #75: the voice is named by its own id, so an own mind called Omega is Omega on a coordinator’s thread', () => {
    const omega = { ...own, name: 'Omega' }
    setOwnMind(omega)
    try {
      const v = speaker({ conductor: true, personal: omega, reaches: coord.name, reachesId: coord.id })
      expect(v).toEqual({ name: 'Omega', id: omega.id })
      expect(shownMind(v.name, v.id)).toBe('Omega')
      // the routed coordinator's id would have hidden it: that is the pairing this guards
      expect(shownMind(v.name, coord.id)).toBe('the orchestrator')
      expect(speaker({ conductor: false, personal: omega, reaches: coord.name, reachesId: coord.id })).toEqual({ name: coord.name, id: coord.id })
    } finally {
      setOwnMind(null)
    }
  })
})
