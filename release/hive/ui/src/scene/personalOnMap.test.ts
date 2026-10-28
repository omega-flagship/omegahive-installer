import { describe, expect, it } from 'vitest'
import type { Agent, Swarm } from '../api/types'
import { mapData } from './personalOnMap'

/** The star map draws no personal-mind swarm as a planet; the person's own mind is "You". INVENTED ids and names. */
const sw = (id: string, name: string, personal_of: string | null = null): Swarm => ({ id, name, description: '', hue: 0, member_ids: [], created_at: '', personal_of })
const ag = (id: string, swarm_id: string | null, personal_of: string | null = null) => ({ id, name: id, swarm_id, personal_of, status: 'awake' }) as Agent

const swarms = [sw('s_team', 'Team'), sw('s_mine', 'Personal', 'user:p_me'), sw('s_theirs', 'Kelp', 'user:p_other')]
const agents = [ag('a_team', 's_team'), ag('a_me', 's_mine', 'user:p_me'), ag('a_them', 's_theirs', 'user:p_other'), ag('a_wander', null)]

describe('personal minds on the star map', () => {
  it('no personal swarm is a planet, by the host’s personal_of field (not the name)', () => {
    const out = mapData(swarms, agents, { id: 'a_me', swarm_id: 's_mine' })
    expect(out.swarms.map((s) => s.id)).toEqual(['s_team'])
  })
  it('someone else’s personal mind is not drawn; the person’s own is drawn alone as "You"', () => {
    const out = mapData(swarms, agents, { id: 'a_me', swarm_id: 's_mine' })
    expect(out.agents.map((a) => [a.id, a.name, a.swarm_id])).toEqual([['a_team', 'a_team', 's_team'], ['a_me', 'You', null], ['a_wander', 'a_wander', null]])
  })
  it('without the person’s own mind known, every personal mind and swarm stays off the map', () => {
    const out = mapData(swarms, agents, null)
    expect(out.swarms.map((s) => s.id)).toEqual(['s_team'])
    expect(out.agents.map((a) => a.id)).toEqual(['a_team', 'a_wander'])
  })
  it('a swarm named like a personal one but not marked stays a planet', () => {
    expect(mapData([sw('s_x', 'My personal mind')], [], null).swarms).toHaveLength(1)
  })
})
