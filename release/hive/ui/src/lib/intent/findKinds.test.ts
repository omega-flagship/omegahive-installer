import { describe, expect, it } from 'vitest'
import { decide, resolve, type World } from './index'

/** A find or search naming a kind of hive thing the palette never lists goes to the mind, not to an empty palette. */
const world: World = { minds: [{ id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' }], swarms: [{ id: 's_lyra', name: 'Lyra' }], pending: 0 }
const scope = { experience: 'classic' }

describe('a find or search for an artifact goes to the mind (a tester’s two phrasings opened an empty palette, 20 Nov)', () => {
  for (const text of ['Find artifact of Marsupial List', 'Search the artifacts for the ID of the artifact continaining a list of marsupials'])
    it(text, () => {
      const cands = resolve(text, scope, world)
      expect(cands.find((c) => c.key === 'search-explicit')?.confidence).toBe(0.3)
      expect(decide(cands, { orchestrator: true }).kind).toBe('mind')
    })

  it('a search naming any kind the palette never lists does not run the palette', () => {
    for (const text of ['look for my tasks about the garden', 'find the file with the invoice', 'search my notes for the recipe']) {
      const d = decide(resolve(text, scope, world), { orchestrator: true })
      expect(d.kind === 'run' && d.c.act?.do === 'search', text).toBe(false)
    }
  })

  it('a search for what the palette lists still opens it at once', () => {
    const d = decide(resolve('find Vega', scope, world), { orchestrator: true })
    expect(d.kind).toBe('run')
    expect(d.kind === 'run' && d.c.act).toMatchObject({ do: 'search', text: 'Vega' })
  })
})
