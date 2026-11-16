import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Room } from '../../api/types'

/**
 * A room's settings show what people use often first, in everyday words: whether minds hear every message, the swarm
 * the room belongs to and who can find it. How many times minds reply to each other, the kind of room and the swarm
 * changes are rare, so they sit folded under More settings. A swarm's own room follows its swarm (the host refuses its
 * settings), so it only says how it works. The store is replaced at its module; INVENTED rooms and names only.
 */

vi.mock('../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store')>()
  // the selector answers from this test's hive; getState and the rest stay the store's own (modules read them as they load)
  const client = { updateRoom: async () => ({}), roomBecomeSwarm: async () => ({}) }
  const pick = (select: (s: unknown) => unknown) =>
    select({ ...real.useHive.getState(), client, swarms: { s_lyra: { id: 's_lyra', name: 'Lyra' } }, toast: () => undefined })
  return { ...real, useHive: Object.assign(pick, real.useHive) }
})

const { RoomSettings, turnWords } = await import('./MessagesPage')

const room = (over: Partial<Room>): Room => ({
  id: 'r_garden', kind: 'group', name: 'Garden', topic: '', owner: 'user:p_ada', visibility: 'private', shared_with: [], swarm_id: null,
  seq: 4, created_at: '2026-11-09T04:00:00Z', updated_at: '2026-11-09T05:00:00Z', settings: { minds_follow: false, turn_cap: 3 },
  members: [{ member: 'user:p_ada', role: 'owner', name: 'Ada' }, { member: 'agent:a_vega', role: 'member', name: 'Vega' }], ...over,
})
const html = (r: Room) => renderToStaticMarkup(createElement(RoomSettings, { room: r, onChanged: () => undefined }))

describe('a room’s settings', () => {
  it('open on whether minds hear every message and who can find the room, with the rest folded under More settings', () => {
    const page = html(room({}))
    expect(page).toContain('Every mind hears every message')
    expect(page).toContain('aria-label="Who can find it"')
    expect(page).toMatch(/aria-expanded="false"[^>]*>.*More settings/)
    for (const rare of ['Minds replying to each other', 'Kind of room', 'Make this room a swarm']) expect(page, rare).not.toContain(rare)
    expect(page).not.toContain('Mind turns in a row')
    expect(page).not.toContain('<select value="3"')   // no dropdown for the turn limit
  })

  it('name the swarm a room belongs to with the common Open first, and keep separating from it folded', () => {
    const page = html(room({ swarm_id: 's_lyra' }))
    expect(page).toContain('This room belongs to Lyra.')
    expect(page).toContain('Open Lyra')
    for (const old of ['Go on as a group', 'Open the swarm', 'Make it a swarm', 'Separate this room']) expect(page, old).not.toContain(old)
  })

  it('in a swarm’s own room, say how it works and offer only Open, since the room follows its swarm', () => {
    const page = html(room({ swarm_id: 's_lyra', team: true }))
    expect(page).toContain('This swarm&#x27;s room')
    expect(page).toContain('Every mind in Lyra is here.')
    expect(page).toContain('Open Lyra')
    expect(page).toContain('Minds hear only messages that @mention them. Minds can reply to each other up to 3 times in a row, then they wait for you.')
    for (const control of ['role="switch"', 'Who can find it', 'More settings']) expect(page, control).not.toContain(control)
  })

  it('in a DM, offer to make it a group', () => {
    const page = html(room({ kind: 'dm', name: '' }))
    expect(page).toContain('Turn into a room')
    expect(page).toContain('Make it a group')
    expect(page).not.toContain('More settings')
  })

  it('say the turn limit in everyday words', () => {
    expect(turnWords(0)).toBe('Minds never reply to each other on their own: each waits for you.')
    expect(turnWords(1)).toBe('Minds can reply to each other up to once in a row, then they wait for you.')
    expect(turnWords(8)).toBe('Minds can reply to each other up to 8 times in a row, then they wait for you.')
    expect(turnWords(null)).toBe('Minds can keep replying to each other, within each mind\'s hourly message limit.')
  })
})
