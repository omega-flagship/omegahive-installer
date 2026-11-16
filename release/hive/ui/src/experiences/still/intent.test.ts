import { describe, expect, it } from 'vitest'
import { shortIds } from './ident'
import { CONSEQUENTIAL, understand, unsupported, type Suggestion, type World } from './intent'

const text = (s: Suggestion) => s.parts.map((p) => p.t).join('')
const runnable = (sugs: Suggestion[]) => sugs.filter((s) => s.act && CONSEQUENTIAL.has(s.act.do))

const twoMiras: World = {
  minds: [
    { id: 'ag_7d1c0a11f3', name: 'Mira', awake: false, swarm: 'Forge' },
    { id: 'ag_92be44c8e0', name: 'Mira', awake: false, swarm: 'Atlas Team' },
    { id: 'ag_0000vega01', name: 'Vega', awake: true, swarm: 'Forge' },
  ],
  swarms: [
    { id: 'sw_aaaa111111', name: 'Forge' },
    { id: 'sw_bbbb222222', name: 'Atlas Team' },
  ],
  pending: 0,
}

describe('R4: names that more than one thing carries', () => {
  it('two minds called Mira: wake offers a choice, never an action', () => {
    const sugs = understand('wake Mira', twoMiras)
    expect(runnable(sugs)).toEqual([])
    const choices = sugs.filter((s) => s.choice)
    expect(choices.map((s) => s.key)).toEqual(['which-mind-ag_7d1c0a11f3', 'which-mind-ag_92be44c8e0'])
    // each choice says which: swarm and a distinct short id
    expect(text(choices[0])).toContain('in Forge')
    expect(text(choices[1])).toContain('in Atlas Team')
    expect(text(choices[0])).not.toEqual(text(choices[1]))
    // the head line is first and does nothing on Enter
    expect(sugs[0].key).toBe('which-head')
    expect(sugs[0].act).toBeUndefined()
    expect(sugs[0].fill).toBeUndefined()
  })

  it('picking one fills name#id; that resolves to exactly the picked mind', () => {
    const pick = understand('wake Mira', twoMiras).find((s) => s.key === 'which-mind-ag_92be44c8e0')!
    expect(pick.fill).toMatch(/^wake Mira#[\w-]+ $/)
    const after = understand(pick.fill!, twoMiras)
    const acts = runnable(after)
    expect(acts).toHaveLength(1)
    expect(acts[0].act).toMatchObject({ do: 'wake', mind: { id: 'ag_92be44c8e0' } })
    expect(text(acts[0])).toContain('in Atlas Team')
  })

  it('send, sleep and analogous forms also require a choice, and the choice keeps the typed words', () => {
    for (const q of ['ask Mira about the logs', 'Mira, how are you', 'tell Mira to rest', '@Mira hello']) {
      const sugs = understand(q, twoMiras)
      expect(runnable(sugs), q).toEqual([])
      expect(sugs.filter((s) => s.choice), q).toHaveLength(2)
    }
    const pick = understand('ask Mira about the logs', twoMiras).find((s) => s.choice)!
    expect(pick.fill).toMatch(/^ask Mira#[\w-]+ about the logs$/)
    const after = runnable(understand(pick.fill!, twoMiras))
    expect(after).toHaveLength(1)
    expect(after[0].act).toMatchObject({ do: 'send', mind: { id: 'ag_7d1c0a11f3' }, text: 'What can you tell me about the logs?' })

    const asleep = { ...twoMiras, minds: twoMiras.minds.map((m) => ({ ...m, awake: true })) }
    expect(runnable(understand('put Mira to sleep', asleep))).toEqual([])
    expect(understand('put Mira to sleep', asleep).filter((s) => s.choice)).toHaveLength(2)
  })

  it('case-equivalent and Unicode-equivalent names collide too', () => {
    const w: World = {
      minds: [
        { id: 'ag_1111111111', name: 'mira', swarm: 'Forge' },
        { id: 'ag_2222222222', name: 'MIRA ', swarm: 'Forge' },
        { id: 'ag_3333333333', name: 'ＭＩＲＡ', swarm: '' },
      ],
      swarms: [],
      pending: 0,
    }
    const sugs = understand('wake Mira', w)
    expect(runnable(sugs)).toEqual([])
    expect(sugs.filter((s) => s.choice)).toHaveLength(3)
    expect(text(sugs.find((s) => s.key === 'which-mind-ag_3333333333')!)).toContain('no swarm')
  })

  it('a name shared by a mind and a swarm: the bare name and "X should …" ask which', () => {
    const w: World = {
      minds: [{ id: 'ag_forge00001', name: 'Forge', awake: true, swarm: 'Atlas Team' }],
      swarms: [{ id: 'sw_forge00001', name: 'Forge' }],
      pending: 0,
    }
    for (const q of ['Forge should tidy the logs', 'forge, hello', 'Forge']) {
      const sugs = understand(q, w)
      expect(runnable(sugs), q).toEqual([])
      const kinds = sugs.filter((s) => s.choice).map((s) => s.key.split('-')[1])
      expect(kinds, q).toEqual(['mind', 'swarm'])
    }
    // picking the swarm makes it a goal for the swarm only
    const pick = understand('Forge should tidy the logs', w).find((s) => s.key === 'which-swarm-sw_forge00001')!
    const acts = runnable(understand(pick.fill!, w))
    expect(acts).toHaveLength(1)
    expect(acts[0].act).toMatchObject({ do: 'goal', swarm: { id: 'sw_forge00001' }, title: 'Tidy the logs' })
    // picking the mind sends to the mind only
    const pm = understand('Forge should tidy the logs', w).find((s) => s.key === 'which-mind-ag_forge00001')!
    const am = runnable(understand(pm.fill!, w))
    expect(am).toHaveLength(1)
    expect(am[0].act).toMatchObject({ do: 'send', mind: { id: 'ag_forge00001' } })
  })

  it('two swarms with one name: goals need a choice with distinct ids', () => {
    const w: World = { minds: [], swarms: [{ id: 'sw_x00000001', name: 'Forge' }, { id: 'sw_y00000002', name: 'forge' }], pending: 0 }
    const sugs = understand('new goal for Forge: ship it', w)
    expect(runnable(sugs)).toEqual([])
    const ch = sugs.filter((s) => s.choice)
    expect(ch).toHaveLength(2)
    expect(ch[0].fill).toMatch(/^new goal for Forge#\w+: ship it$/)
    expect(runnable(understand(ch[1].fill!, w))[0].act).toMatchObject({ do: 'goal', swarm: { id: 'sw_y00000002' } })
  })

  it('a renamed target picked by id still resolves by id and says its current name and old one', () => {
    const pick = understand('wake Mira', twoMiras).find((s) => s.key === 'which-mind-ag_92be44c8e0')!
    const renamed: World = { ...twoMiras, minds: twoMiras.minds.map((m) => (m.id === 'ag_92be44c8e0' ? { ...m, name: 'Nova' } : m)) }
    const acts = runnable(understand(pick.fill!, renamed))
    expect(acts).toHaveLength(1)
    expect(acts[0].act).toMatchObject({ do: 'wake', mind: { id: 'ag_92be44c8e0', name: 'Nova' } })
    expect(text(acts[0])).toContain('Nova')
    expect(text(acts[0])).toContain('was “Mira”')
  })

  it('a removed target picked by id offers nothing to run', () => {
    const pick = understand('wake Mira', twoMiras).find((s) => s.key === 'which-mind-ag_92be44c8e0')!
    const gone: World = { ...twoMiras, minds: twoMiras.minds.filter((m) => m.id !== 'ag_92be44c8e0') }
    expect(runnable(understand(pick.fill!, gone))).toEqual([])
  })

  it('very short ids that are tails of one another still pick exactly one', () => {
    const w: World = { minds: [{ id: 'm1', name: 'Mira', swarm: '' }, { id: 'xm1', name: 'Mira', swarm: '' }], swarms: [], pending: 0 }
    for (const c of understand('wake Mira', w).filter((s) => s.choice)) {
      const acts = runnable(understand(c.fill!, w))
      expect(acts).toHaveLength(1)
      expect(c.key).toBe(`which-mind-${(acts[0].act as { mind: { id: string } }).mind.id}`)
    }
  })

  it('short ids are distinct even when tails collide', () => {
    const ids = shortIds(['ag_1_abcdef', 'ag_2_abcdef', 'x'])
    expect(ids.get('ag_1_abcdef')).not.toEqual(ids.get('ag_2_abcdef'))
    expect(ids.get('x')).toBe('x')
  })
})

describe('R4: every preview names its target with swarm and identity', () => {
  const w: World = {
    minds: [{ id: 'ag_solo000001', name: 'Mira', awake: false, swarm: 'Forge' }, { id: 'ag_vega000001', name: 'Vega', awake: true, awakeNow: true, swarm: '', maySleep: true }],
    swarms: [{ id: 'sw_forge00001', name: 'Forge' }],
    pending: 0,
  }
  it.each([
    ['wake Mira', 'wake', 'in Forge'],
    ['ask Mira what changed', 'send', 'in Forge'],
    ['Mira, hello', 'send', 'in Forge'],
    ['sleep Vega', 'sleep', 'no swarm'],
    ['new goal for Forge: tidy up', 'goal', 'swarm · #'],
    ['Forge should tidy up', 'goal', 'swarm · #'],
  ])('%s', (q, d, where) => {
    const acts = runnable(understand(q, w))
    expect(acts).toHaveLength(1)
    expect(acts[0].act!.do).toBe(d)
    const who = acts[0].parts.find((p) => p.who)
    expect(who?.t).toContain(where)
    expect(who?.t).toMatch(/#\w{6,}/)
  })
})

describe('P2: conditions and times are refused or questioned, never dropped', () => {
  const w: World = { minds: [{ id: 'ag_solo000001', name: 'Mira', awake: false, swarm: 'Forge' }, { id: 'ag_vega000001', name: 'Vega', awake: true, swarm: 'Forge' }], swarms: [{ id: 'sw_forge00001', name: 'Forge' }], pending: 0 }

  it.each(['wake Mira only after approval', 'wake Mira later', 'wake Mira if Vega is busy', 'wake Mira when the build is green', 'wake Mira tomorrow', 'wake Mira unless it is late', 'wake Mira after lunch', 'sleep Vega in 10 minutes', 'put Vega to sleep tonight'])('%s: nothing to run, and it says why', (q) => {
    const sugs = understand(q, w)
    expect(runnable(sugs)).toEqual([])
    expect(sugs[0].limit).toBe(true)
    expect(text(sugs[0])).toMatch(/can’t do conditions or timing yet/)
    // the fill drops the condition only visibly, and running needs another Enter
    expect(sugs[0].act).toBeUndefined()
    expect(sugs[0].fill).toMatch(/^(wake Mira|sleep Vega|put Vega to sleep)$/)
  })

  it('plain wake forms still work', () => {
    for (const q of ['wake Mira', 'wake Mira up', 'wake up Mira', 'wake Mira now', 'wake Mira.']) expect(runnable(understand(q, w))[0]?.act?.do, q).toBe('wake')
  })

  it.each(['tell Mira to deploy only after approval', 'ask Mira about the plan tomorrow', 'tell Mira to ship, once the tests pass', 'Mira, check the logs later', 'tell Mira to wait until noon'])('%s: first says it cannot hold a message; sending as written is a separate, explicit choice', (q) => {
    const sugs = understand(q, w)
    expect(sugs[0].limit).toBe(true)
    expect(sugs[0].act).toBeUndefined()
    expect(text(sugs[0])).toMatch(/can’t hold a message/)
    const send = runnable(sugs)
    expect(send).toHaveLength(1)
    expect(text(send[0])).toMatch(/^Send it now anyway, word for word/)
  })

  it.each(['new goal for Forge: ship it after review', 'new goal for Forge tomorrow: ship it', 'Forge should ship it only if green', 'new goal for Forge: when green, ship it'])('%s: goals too', (q) => {
    const sugs = understand(q, w)
    expect(sugs[0].limit).toBe(true)
    expect(runnable(sugs).every((s) => text(s).startsWith('Make it now anyway'))).toBe(true)
  })

  it('questions that start with if/when are messages, not conditions', () => {
    expect(understand('ask Mira if it rained', w)[0].act).toMatchObject({ do: 'send', text: 'If it rained?' })
    expect(understand('ask Mira when the build broke', w)[0].act?.do).toBe('send')
  })

  it('unsupported(): modes', () => {
    expect(unsupported('only after approval', 'strict')).toBe('only after approval')
    expect(unsupported('up', 'strict')).toBeNull()
    expect(unsupported('if it rained', 'words')).toBeNull()
    expect(unsupported('if it is green, ship', 'goal')).toBe('if it is green, ship')
    expect(unsupported('ship it later', 'words')).toBe('later')
  })
})

describe('P2: search keeps what was typed', () => {
  it('the search suggestion carries the exact text', () => {
    const s = understand('  vega’s  budget notes', twoMiras).find((x) => x.key === 'search')!
    expect(s.act).toEqual({ do: 'search', text: 'vega’s budget notes' })
  })
})
