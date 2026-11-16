import { describe, expect, it } from 'vitest'
import type { Agent } from '../api/types'
import { chatPerson, chatSender, principalLabel } from './personNames'

/** Surface demo D2: the Apps activity line names a person, not their principal ("Ada Brightwater", never "p_ada"). */
const agents = { a_vega01: { id: 'a_vega01', name: 'Vega' } } as unknown as Record<string, Agent>

describe('principalLabel', () => {
  it('a person by the name the hive gives: from the people list, or the signed-in person’s own', () => {
    expect(principalLabel('user:p_ada', agents, { people: [{ id: 'p_ada', name: 'Ada Brightwater' }] })).toBe('Ada Brightwater')
    expect(principalLabel('user:p_ada', agents, { me: { principal: 'user:p_ada', person: { id: 'p_ada', email: 'ada@example.org', name: 'Ada Brightwater' } }, people: null })).toBe('Ada Brightwater')
  })
  it('a mind by its name; an unknown person by their id as before; anything else as given', () => {
    expect(principalLabel('agent:a_vega01', agents)).toBe('Vega')
    expect(principalLabel('agent:a_gone', agents)).toBe('a_gone')
    expect(principalLabel('user:p_rowan', agents, { people: [{ id: 'p_ada', name: 'Ada Brightwater' }] })).toBe('p_rowan')
    expect(principalLabel('user:p_blank', agents, { people: [{ id: 'p_blank', name: '  ' }] })).toBe('p_blank')
    expect(principalLabel('system:hive', agents)).toBe('system:hive')
  })
  it('someone else’s principal never takes the signed-in person’s name', () => {
    expect(principalLabel('user:p_tomas', agents, { me: { principal: 'user:p_ada', person: { id: 'p_ada', email: 'ada@example.org', name: 'Ada Brightwater' } } })).toBe('p_tomas')
  })
})

/**
 * followups r4: mind chats carry the real sender principal (Platform privacy r4, 5617f4e), and an admin's audit (or the
 * loopback operator's whole stream) shows other people's. FIXTURE messages, invented people.
 */
describe('chatSender: whose words in a mind chat', () => {
  const ada = { principal: 'user:p_ada', person: { id: 'p_ada', email: 'ada@example.org', name: 'Ada Brightwater' } }
  const operator = { principal: 'user:operator', person: null }
  const people = [{ id: 'p_ada', name: 'Ada Brightwater' }, { id: 'p_rowan', name: 'Rowan Vale' }]
  const fixture = [
    { direction: 'in', sender: 'user:p_ada', text: 'mine' },
    { direction: 'in', sender: 'user:p_rowan', text: 'rowan' },
    { direction: 'in', sender: 'user:p_tomas', text: 'not in the list' },
    { direction: 'in', sender: 'user:operator', text: 'hive password' },
  ]
  it('"You" only for the viewer’s own principal; others by name, else the principal without user:', () => {
    expect(fixture.map((m) => chatSender(m.sender, { me: ada, people }))).toEqual(['You', 'Rowan Vale', 'p_tomas', 'the operator'])
    // the people list not read: still never "You" for someone else
    expect(fixture.map((m) => chatSender(m.sender, { me: ada, people: null }))).toEqual(['You', 'p_rowan', 'p_tomas', 'the operator'])
  })
  it('the hive-password operator sees their own as "You", and every named person by name', () => {
    expect(fixture.map((m) => chatSender(m.sender, { me: operator, people }))).toEqual(['Ada Brightwater', 'Rowan Vale', 'p_tomas', 'You'])
    expect(fixture.map((m) => chatPerson(m.sender, { me: operator, people }).mine)).toEqual([false, false, false, true])
  })
  it('no viewer known yet: nobody is "You"', () => {
    expect(fixture.map((m) => chatSender(m.sender, { people }))).toEqual(['Ada Brightwater', 'Rowan Vale', 'p_tomas', 'the operator'])
    expect(fixture.some((m) => chatPerson(m.sender, {}).mine)).toBe(false)
  })
})
