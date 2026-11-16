import { describe, expect, it } from 'vitest'
import { searchHive, type Searchable } from './search'

const d: Searchable = {
  minds: [
    { id: 'ag_1', name: 'Mira', awake: true, swarm: 'Forge' },
    { id: 'ag_2', name: 'Vega', awake: false, swarm: '' },
  ],
  swarms: [{ id: 'sw_1', name: 'Forge' }],
  goals: { g1: { id: 'g1', swarm_id: 'sw_1', title: 'Tidy the build cache', detail: 'nightly budget notes', status: 'open', updated_at: '2026-10-04T00:00:00Z' } },
  beliefs: { sw_1: { '(--> cache stale)': { swarm_id: 'sw_1', statement: '(--> cache stale)', tv: { f: 0.9, c: 0.8 }, updated_at: '2026-10-04T00:00:00Z' } } },
}

describe('P2: search in place keeps and uses the typed words', () => {
  it('finds minds, swarms, goals and beliefs for exactly the typed text', () => {
    expect(searchHive('cache', d).map((f) => f.kind).sort()).toEqual(['belief', 'goal'])
    expect(searchHive('forge', d).map((f) => `${f.kind}:${f.id}`)).toEqual(['swarm:sw_1', 'mind:ag_1'])
    expect(searchHive('budget notes', d).map((f) => f.id)).toEqual(['g1'])
  })
  it('every word must match; nothing for unrelated text or empty text', () => {
    expect(searchHive('cache banana', d)).toEqual([])
    expect(searchHive('   ', d)).toEqual([])
  })
  it('results say where things live', () => {
    expect(searchHive('mira', d)[0].sub).toBe('mind in Forge, awake')
    expect(searchHive('tidy', d)[0].sub).toBe('task for Forge, open')
  })
})
