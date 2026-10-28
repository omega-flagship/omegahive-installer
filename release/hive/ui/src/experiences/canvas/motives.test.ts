import { describe, expect, it } from 'vitest'
import type { Motivation } from '../../api/types'
import type { Goal } from '../sdk'
import { motivationRows, progressWords, servesWords, stickyLine } from './motives'
import { CARDS, HIVE_ENTRIES, NAV_FEATURES, wayFor } from './nav'

const mot = (id: string, status: Motivation['status'], created_at: string, owner = 'user:u_ada', created_by = owner): Motivation => ({
  id,
  title: `Motivation ${id}`,
  why: 'Synthetic reason',
  owner,
  swarm_id: null,
  status,
  visibility: 'public',
  rev: 1,
  parent_id: null,
  created_by,
  created_at,
  updated_at: created_at,
  status_changed_at: null,
})

describe('Canvas motivations', () => {
  it('a sticky names the first motivation it serves and how many more; none says nothing', () => {
    expect(stickyLine([])).toBeNull()
    expect(stickyLine([{ title: 'Ship the demo' }])).toBe('Ship the demo')
    expect(stickyLine([{ title: 'Ship the demo' }, { title: 'Learn' }, { title: 'Rest' }])).toBe('Ship the demo +2')
    expect(stickyLine([{ title: 'A very long motivation title that never fits' }], 12)).toBe('A very long…')
    expect(servesWords([])).toBe('')
    expect(servesWords([{ title: 'A' }, { title: 'B' }])).toBe(' Serves 2 motivations: A, B.')
  })

  it('progress counts each task once, however many motivations it serves', () => {
    const goals: Record<string, Pick<Goal, 'status'>> = { g1: { status: 'done' }, g2: { status: 'open' }, g3: { status: 'failed' }, g4: { status: 'cancelled' } }
    const links = { g1: [{ id: 'mo_a' }, { id: 'mo_b' }], g2: [{ id: 'mo_a' }], g3: [{ id: 'mo_a' }], g4: [{ id: 'mo_a' }] }
    const rows = motivationRows({ mo_a: mot('mo_a', 'active', '2026-10-01T00:00:00Z'), mo_b: mot('mo_b', 'paused', '2026-10-02T00:00:00Z'), mo_c: mot('mo_c', 'active', '2026-10-03T00:00:00Z') }, links, goals)
    // active first (newest first within), then paused
    expect(rows.map((r) => r.m.id)).toEqual(['mo_c', 'mo_a', 'mo_b'])
    expect(rows.map((r) => r.status)).toEqual(['Active', 'Active', 'Paused'])
    const a = rows[1].progress
    expect([a.total, a.done, a.failed, a.cancelled]).toEqual([4, 1, 1, 1])
    expect(progressWords(a)).toBe('1 of 3 tasks done · 1 failed · 1 cancelled')
    expect(progressWords(rows[2].progress)).toBe('1 of 1 task done')
    expect(progressWords(rows[0].progress)).toBe('No tasks yet')
  })

  it('Motivations is reached from the Hive panel as a native Canvas card', () => {
    expect(CARDS).toContain('work.motivations')
    const f = HIVE_ENTRIES.find((x) => x.id === 'work.motivations')
    expect(f && wayFor(f)).toBe('card')
    expect(NAV_FEATURES).toContain('work.motivations')
    expect(NAV_FEATURES).toContain('work.goals')
  })
})
