import { describe, expect, it } from 'vitest'
import { askThreadTitle, firstWords, isAskThread } from './sessionTitle'
import type { Room, WorkSession } from '../../api/types'

/** j0-fixes r1 item 6 (J0 live: ten Sessions rows, all "Ask thread"). INVENTED rooms and sessions. */
const now = new Date('2026-10-17T15:00:00')
const room = (o: Partial<Room> = {}) => ({ kind: 'session' as const, name: 'Ask thread', topic: 'Session with Product Design', created_at: '2026-10-17T13:55:00', updated_at: '2026-10-17T14:27:00', ...o })
const session = (o: Partial<WorkSession> = {}) => ({ purpose: 'ask', title: 'Ask thread', mind: { id: 'a_pd', name: 'Product Design' }, status: 'active' as const, created_at: '2026-10-17T13:55:00', goal: null, ...o })

describe('an Ask thread’s row in Messages', () => {
  it('mind · first words · time, when the page has the words', () => {
    const t = askThreadTitle(room(), session(), 'Make a poster for the Elm Street spring picnic', now)!
    expect(t.title).toMatch(/^Product Design · Make a poster for the Elm… · \d{1,2}:27/)
    expect(t.ended).toBe(false)
  })
  it('without the words, they are left out (never invented); an ended session says so', () => {
    const t = askThreadTitle(room(), session({ status: 'ended' }), null, now)!
    expect(t.title).toMatch(/^Product Design · \d{1,2}:27/)
    expect(t.ended).toBe(true)
  })
  it('no session read yet: the mind from the host’s room topic; nothing at all known: "Ask thread"', () => {
    expect(askThreadTitle(room(), null, null, now)!.title).toMatch(/^Product Design · /)
    expect(askThreadTitle(room({ topic: '', updated_at: '', created_at: '' }), null, null, now)!.title).toBe('Ask thread')
  })
  it('an older day shows the date; other rooms keep their own title', () => {
    expect(askThreadTitle(room({ updated_at: '2026-10-12T09:00:00' }), session(), null, now)!.title).toMatch(/^Product Design · \S+ 12|^Product Design · 12 \S+/)
    expect(askThreadTitle(room({ name: 'Design review' }), session({ purpose: null, title: 'Design review' }), null, now)).toBeNull()
    expect(isAskThread({ kind: 'group', name: 'Ask thread' })).toBe(false)
  })
  it('first words are cut on a word', () => {
    expect(firstWords('Make a poster for the Elm Street spring picnic')).toBe('Make a poster for the Elm…')
    expect(firstWords('Short one')).toBe('Short one')
  })
})
