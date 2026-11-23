// Purpose: the facts and data the own-coding part of a mind's settings composes from (ownCoding.metta).
import type { Agent } from '../../api/types'
import { shown } from '../../lib/displayName'
import type { ScreenFacts } from '../../screens/screenSpace'

/**
 * Whether the mind's own coding is on (options.own_coding) and whether this person may switch it: the host's
 * may_switch_own_coding, its owner's alone. Absent on events and older hosts, so the switch is hidden only when the
 * host says no, and the host still refuses anyone else. Pure.
 */
export function ownCodingScreen(agent: Agent): { data: Record<string, unknown>; facts: ScreenFacts } {
  const on = agent.options?.own_coding === true
  return {
    data: { 'coding.name': shown(agent.name), 'coding.choice': [{ id: 'own-coding', label: 'Writes and runs its own code', on }] },
    facts: { flags: { 'coding.on': on, 'coding.owner': agent.may_switch_own_coding !== false } },
  }
}
