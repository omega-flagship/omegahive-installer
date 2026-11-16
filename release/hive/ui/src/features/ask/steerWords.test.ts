import { describe, expect, it } from 'vitest'
import { steerUnreached } from './words'

/**
 * A follow-up that did not get through says who it failed to reach. Your mind is your Ask, so a personal thread never
 * says "coordinator" or "orchestrator"; only a swarm thread has a coordinator. INVENTED ids.
 */
describe('the unreached follow-up names who is answering', () => {
  const personal = { id: 'a_invented_mine' }
  it('a personal thread: your mind', () => {
    expect(steerUnreached({ mind: { id: 'a_invented_mine' } }, personal)).toBe('Didn’t reach your mind. It is still answering your first words.')
  })
  it('a swarm thread: the coordinator', () => {
    expect(steerUnreached({ mind: { id: 'a_invented_lead' } }, personal)).toBe('Didn’t reach the coordinator. It is still answering your first words.')
    expect(steerUnreached({ mind: { id: 'a_invented_lead' } }, null)).toMatch(/the coordinator/)
  })
  it('no thread yet: neither word', () => {
    expect(steerUnreached(null, personal)).not.toMatch(/coordinator|orchestrator|your mind/)
  })
})
