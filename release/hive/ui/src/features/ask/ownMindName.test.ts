// Purpose: verify that the person's own mind is shown by the name they gave it, while other minds keep the Omega rule.
import { afterEach, describe, expect, it } from 'vitest'
import { setOwnMind, shownMind, threadLabel } from './words'
import { askRows } from './enter'
import { threadInfo } from './answerer'
import type { MyMind } from '../../api/ask'

describe('the person\'s own mind is shown by the name they gave it', () => {
  afterEach(() => setOwnMind(null))

  it('a mind the person named Omega is shown as Omega, in the Send to line and the thread\'s label alike', () => {
    setOwnMind({ id: 'a_own' })
    expect(shownMind('Omega', 'a_own')).toBe('Omega')
    expect(`Send to: ${shownMind('Omega', 'a_own')} (your mind) · Change`).toBe('Send to: Omega (your mind) · Change')
    expect(threadLabel('Omega', undefined, 'a_own')).toBe('Omega')
    // the thread's info line too, which a real hive showed as "Answers come from the orchestrator's own knowledge."
    const own: MyMind = { id: 'a_own', name: 'Omega', swarm_id: 's_own' }
    expect(threadInfo({ mind: { id: 'a_own', name: 'Omega' } }, own, shownMind)).toBe('Answers come from Omega’s own knowledge.')
    expect(threadInfo({ mind: { id: 'a_other', name: 'Omega' } }, own, shownMind)).toMatch(/^Answers come from the orchestrator’s own knowledge\./)
  })

  it('a mind the hive presents is still never shown as Omega, and the rule comes back once the person is gone', () => {
    setOwnMind({ id: 'a_own' })
    expect(shownMind('Juniper', 'a_own')).toBe('Juniper')
    expect(shownMind('Omega', 'a_other')).toBe('the orchestrator')
    expect(shownMind('Ω', 'a_other')).toBe('the orchestrator')
    setOwnMind(null)
    expect(shownMind('Omega')).toBe('the orchestrator')
    expect(shownMind('')).toBe('the orchestrator')
  })

  it('two minds named Omega do not share the own-mind exception', () => {
    setOwnMind({ id: 'a_own' })
    expect(shownMind('Omega', 'a_own')).toBe('Omega')
    expect(shownMind('Omega', 'a_other')).toBe('the orchestrator')
    expect(threadLabel('Omega', 'Omega', 'a_other', 'a_own')).toBe('the orchestrator about Omega')
    expect(shownMind('Omega')).toBe('the orchestrator')
    const own = askRows([], 'help me', 'Omega', { kind: 'mind' }, false, 'a_own')
    const other = askRows([], 'help me', 'Omega', { kind: 'mind' }, false, 'a_other')
    expect(own[0].parts?.map((part) => part.t).join('')).toBe('Ask Omega: help me')
    expect(other[0].parts?.map((part) => part.t).join('')).toBe('Ask the orchestrator: help me')
  })
})
