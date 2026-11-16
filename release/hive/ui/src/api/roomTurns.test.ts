import { describe, expect, it } from 'vitest'
import { heldBack } from './roomTurns'

/** Who a room's turn cap holds back, as rooms.py _held reads it from the stored messages. INVENTED names only. */
type Message = { seq: number; sender: string; mentions: string[]; delivered_to: string[]; mind_run: number }
/** A room's messages in order, each with the next seq. */
const log = (...messages: Omit<Message, 'seq'>[]): Message[] => messages.map((m, i) => ({ ...m, seq: i + 1 }))
const person = (): Omit<Message, 'seq'> => ({ sender: 'user:p_ada', mentions: [], delivered_to: [], mind_run: 0 })
const mind = (who: string, run: number, mentions: string[], delivered: string[] = mentions): Omit<Message, 'seq'> =>
  ({ sender: `agent:${who}`, mentions: mentions.map((m) => `agent:${m}`), delivered_to: delivered.map((m) => `agent:${m}`), mind_run: run })
const notice = (run: number): Omit<Message, 'seq'> => ({ sender: 'system:hive', mentions: [], delivered_to: [], mind_run: run })

describe('the minds a turn cap holds back', () => {
  it('are the minds a stopped message @mentioned: the one the hive’s stop notice follows', () => {
    expect(heldBack(log(person(), mind('a_vega', 1, ['a_orion']), mind('a_orion', 2, ['a_vega']), mind('a_vega', 3, ['a_orion'], []), notice(3))))
      .toEqual(['agent:a_orion'])
  })

  it('leave out a mention still being delivered or whose delivery failed, since no stop notice follows it', () => {
    expect(heldBack(log(person(), mind('a_vega', 1, ['a_orion'], []), mind('a_orion', 2, ['a_lyra'], [])))).toEqual([])
  })

  it('are none once a person speaks or an orchestrator mind carries them on, either of which starts a new run at 0', () => {
    const stopped = [mind('a_vega', 4, ['a_orion'], []), notice(4)]
    expect(heldBack(log(...stopped, person()))).toEqual([])
    expect(heldBack(log(...stopped, mind('a_lyra', 0, [], ['a_orion'])))).toEqual([])
    expect(heldBack(log(...stopped, person(), mind('a_orion', 1, ['a_vega'])))).toEqual([])
  })

  it('list each mind once, in the order they were held, and skip what every mind was sent', () => {
    expect(heldBack(log(mind('a_vega', 4, ['a_orion', 'a_lyra'], []), notice(4), mind('a_orion', 5, ['a_lyra', 'a_vega'], []), notice(5))))
      .toEqual(['agent:a_orion', 'agent:a_lyra', 'agent:a_vega'])
    expect(heldBack(log(person(), mind('a_vega', 1, ['a_orion']), mind('a_orion', 2, ['a_vega'])))).toEqual([])
    expect(heldBack([])).toEqual([])
  })

  it('read a system message as the stop only right after the message and with its count', () => {
    const before = log(person(), mind('a_vega', 4, ['a_orion'], []))
    expect(heldBack([...before, { ...notice(4), seq: 4 }])).toEqual([]) // a message between them the page has not loaded
    expect(heldBack([...before, { ...notice(5), seq: 3 }])).toEqual([]) // another run's count
  })

  it('leave out, for a mind carrying the room on, that mind and the stops its own messages made', () => {
    const stops = log(mind('a_orion', 4, ['a_vega'], []), notice(4), mind('a_vega', 5, ['a_orion'], []), notice(5), mind('a_lyra', 6, ['a_deneb'], []), notice(6))
    expect(heldBack(stops)).toEqual(['agent:a_vega', 'agent:a_orion', 'agent:a_deneb'])
    expect(heldBack(stops, 'agent:a_vega')).toEqual(['agent:a_deneb'])
  })
})
