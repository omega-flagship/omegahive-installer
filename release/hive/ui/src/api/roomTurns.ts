import type { RoomMessage } from './types'

/**
 * The minds a room's turn cap holds back now (hive/core rooms.py _held): those a stopped mind message @mentioned and was
 * never sent to, in the room's current run, after the last message with a turn count of 0 (a person's, or an
 * orchestrator mind's carry-on). A stopped message is one the hive's stop notice follows at the next seq with the same
 * count, so a delivery still under way or one that failed never counts, and raising the cap after a stop keeps them
 * held. A person's next message that @mentions no one reaches them, so they carry on. `but`, a mind carrying the room
 * on: leave out that mind and the stops its own messages made (rooms.py _held). In the order they were first held.
 * Pure. Time: one pass back to the run's start, then one over the run.
 */
export function heldBack(messages: readonly Pick<RoomMessage, 'seq' | 'sender' | 'mentions' | 'delivered_to' | 'mind_run'>[], but?: string): string[] {
  let since = messages.length
  while (since > 0 && messages[since - 1].mind_run !== 0) since--
  const held: string[] = []
  for (let i = since; i + 1 < messages.length; i++) {
    const m = messages[i]
    const next = messages[i + 1]
    const stopped = m.sender.startsWith('agent:') && next.sender === 'system:hive' && next.seq === m.seq + 1 && next.mind_run === m.mind_run
    if (stopped && m.sender !== but) for (const mind of m.mentions) if (!m.delivered_to.includes(mind) && !held.includes(mind) && mind !== but) held.push(mind)
  }
  return held
}
