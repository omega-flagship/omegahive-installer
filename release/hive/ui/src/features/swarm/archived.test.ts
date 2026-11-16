import { describe, expect, it } from 'vitest'
import type { Swarm } from '../../api/types'
import { archivedList } from './swarmEdit'

const sw = (id: string, archived_at: string | null): Swarm => ({ id, name: id, description: '', hue: 0, member_ids: [], created_at: '', archived_at })

describe('archived swarms list (GET /api/swarms?archived=1, then this session’s events)', () => {
  it('lists the fetched archived ones, newest first', () => {
    expect(archivedList([sw('a', '2026-10-01'), sw('b', null), sw('c', '2026-10-03')], {}).map((s) => s.id)).toEqual(['c', 'a'])
  })
  it('a swarm restored or archived since wins over the fetched copy', () => {
    expect(archivedList([sw('a', '2026-10-01')], { a: sw('a', null), d: sw('d', '2026-10-05') }).map((s) => s.id)).toEqual(['d'])
  })
})
