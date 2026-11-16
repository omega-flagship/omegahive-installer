// Purpose: verify that a note the hive marks mind_only never reaches a person's page, and every other message still does.
import { describe, expect, it } from 'vitest'
import type { Message, RoomMessage } from '../api/types'
import { emptyData, mergeMessages, reduce, upsertMessage } from '../store/reducer'
import { forPeople } from './mindOnly'
import messagesPageSrc from '../features/messages/MessagesPage.tsx?raw'

const at = '2026-11-11T05:00:00.000Z'
const msg = (p: Partial<Message> = {}): Message => ({
  id: 'm_1', agent_id: 'a_own', conversation_id: 'c_a_own', direction: 'in', sender: 'user:u_ann', text: 'hi', created_at: at, ...p,
})
// what a Lisbon tester's own mind showed in its chat, as the hive now serves it (Hive.mind_only): invented ids
const ASSIGNED = msg({
  id: 'm_goal', sender: 'hive:goals', created_at: '2026-11-11T05:00:01.000Z', mind_only: true,
  text: 'Assigned to you: New goal g_x (priority 0.50): Ask thread. Read it with hive-goal-get g_x, claim it with hive-goal-claim g_x, and finish with hive-goal-done g_x <what was done>.',
})

describe('a note only the mind reads is never drawn for people', () => {
  it('forPeople leaves out exactly the marked notes, in order', () => {
    const wake = msg({ id: 'm_wake', sender: 'hive:schedule', text: '[WAKE wk_1] summarise my day', created_at: '2026-11-11T05:00:02.000Z' })
    const reply = msg({ id: 'm_out', direction: 'out', sender: 'agent:a_own', text: 'Here is your day.', created_at: '2026-11-11T05:00:03.000Z' })
    expect(forPeople([msg(), ASSIGNED, wake, reply]).map((m) => m.id)).toEqual(['m_1', 'm_wake', 'm_out'])
    expect(forPeople([])).toEqual([])
  })

  it('a live mind_only frame changes nothing a page reads: no chat line, no activity', () => {
    const s0 = reduce(emptyData(), { type: 'message', at, message: msg() })
    const s1 = reduce(s0, { type: 'message', at, message: ASSIGNED })
    expect(s1).toBe(s0)
    expect(s1.messages.a_own.map((m) => m.id)).toEqual(['m_1'])
    expect(s1.activity).toHaveLength(1)
  })

  it('a loaded or upserted list never holds one either', () => {
    expect(mergeMessages([msg()], [ASSIGNED, msg({ id: 'm_2', created_at: '2026-11-11T05:00:05.000Z' })]).map((m) => m.id)).toEqual(['m_1', 'm_2'])
    const list = [msg()]
    expect(upsertMessage(list, ASSIGNED)).toBe(list)
  })

  it('the Messages page draws a room through the same rule and fetches by every row', () => {
    const copy = { id: 'rm_1', room_id: 'r_dm', seq: 2, sender: 'system:hive', name: 'Hive', text: ASSIGNED.text, mentions: [], delivered_to: [], mind_run: 0, created_at: at, mind_only: true } as unknown as RoomMessage
    expect(forPeople([copy])).toEqual([])
    expect(messagesPageSrc).toContain('const messages = useMemo(() => forPeople(all), [all])')
    expect(messagesPageSrc).toContain('const last = all.length ? all[all.length - 1].seq : 0')
  })
})
