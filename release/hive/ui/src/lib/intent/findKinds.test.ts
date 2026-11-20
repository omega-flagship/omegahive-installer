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

/**
 * A find with a kind word goes where its answer is (Jon's review of #563): a page it names outright, else the palette
 * when the palette lists something for the words, else the mind.
 */
describe('a find with a kind word goes to the page it names, the palette or the mind', () => {
  const opens = (text: string, w: World = world) => {
    const d = decide(resolve(text, scope, w), { orchestrator: true })
    return d.kind === 'run' && d.c.act?.do === 'search'
  }

  it('find tasks and find messages open their page itself, as #563 had them, never a choice beside the search', () => {
    for (const text of ['find tasks', 'find messages']) {
      const d = decide(resolve(text, scope, world), { orchestrator: true })
      expect(d.kind === 'run' && d.c.act?.do === 'feature', text).toBe(true)
      expect(resolve(text, scope, world).find((c) => c.key === 'search-explicit')?.confidence, text).toBe(0.3)
    }
  })

  it('a find the palette can answer and no page names outright runs the palette’s search, never the mind', () => {
    for (const text of ['search for files', 'look for artifacts']) {
      expect(resolve(text, scope, world).find((c) => c.key === 'search-explicit')?.confidence, text).toBe(0.9)
      expect(opens(text), text).toBe(true)
    }
  })

  it('a mind or swarm named for a kind is listed, so finding it opens the palette', () => {
    const named: World = { ...world, minds: [...world.minds, { id: 'a_notes01', name: 'Notes', awake: true, swarm: 'Lyra' }], swarms: [...world.swarms, { id: 's_plans', name: 'Plans' }] }
    expect(opens('find notes', named)).toBe(true)
    expect(opens('find plans', named)).toBe(true)
  })

  it('without such a mind or swarm, finding notes or plans goes to the mind', () => {
    for (const text of ['find notes', 'find plans', 'find memories']) {
      expect(resolve(text, scope, world).find((c) => c.key === 'search-explicit')?.confidence, text).toBe(0.3)
      expect(opens(text), text).toBe(false)
    }
  })
})
