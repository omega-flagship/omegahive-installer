import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from './SimClient'

/**
 * As the host (rooms.py mirror_in, mirror_out, legacy_dm; hive.record_agent_message): a mind's chat lands in its DM
 * with the visitor, aliased c_<mind>, each copy keeping its message's own id; a mind's words in a room are also its
 * message, whose id the room copy keeps. So an activity line for any of them opens it (lib/activityLink). Sim data.
 */
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the simulator keeps minds’ messages in their rooms', () => {
  it('a person’s chat and the mind’s reply land in the DM aliased c_<mind>, each keeping its message’s id', async () => {
    const sim = new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })
    const sent = await sim.sendMessage('a_vega01', { text: 'how are the binaries tonight?' })
    expect(sent.conversation_id).toBe('c_a_vega01')
    vi.advanceTimersByTime(10_000)
    const reply = (await sim.listMessages('a_vega01')).filter((m) => m.direction === 'out').at(-1)!
    expect(reply.conversation_id).toBe('c_a_vega01')
    const dm = await sim.room('c_a_vega01')
    expect(dm).toMatchObject({ kind: 'dm', alias: 'c_a_vega01' })
    const copies = await sim.roomMessages('c_a_vega01')
    expect(copies.find((m) => m.source_message_id === sent.id)).toMatchObject({ text: 'how are the binaries tonight?', delivered_to: ['agent:a_vega01'] })
    expect(copies.find((m) => m.source_message_id === reply.id)).toMatchObject({ sender: 'agent:a_vega01', text: reply.text })
  })

  it('makes the DM on first use for a mind the visitor has not spoken with', async () => {
    const sim = new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })
    const sent = await sim.sendMessage('a_coral5', { text: 'hello' })
    expect((await sim.room('c_a_coral5')).alias).toBe('c_a_coral5')
    expect((await sim.roomMessages('c_a_coral5')).map((m) => m.source_message_id)).toContain(sent.id)
  })

  it('a mind’s words in a room are also its message, in the room’s conversation, whose id the copy keeps', async () => {
    const sim = new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })
    const room = await sim.createRoom({ kind: 'group', name: 'Plan', members: ['agent:a_vega01'] })
    await sim.postRoomMessage(room.id, '@Vega what do you think?')
    vi.advanceTimersByTime(10_000)
    const answer = (await sim.roomMessages(room.id)).find((m) => m.sender === 'agent:a_vega01')!
    const said = (await sim.listMessages('a_vega01')).find((m) => m.id === answer.source_message_id)!
    expect(said).toMatchObject({ direction: 'out', conversation_id: room.id, text: answer.text })
    // a room already holds it: nothing is copied back a second time
    expect((await sim.roomMessages(room.id)).filter((m) => m.text === answer.text)).toHaveLength(1)
  })
})
