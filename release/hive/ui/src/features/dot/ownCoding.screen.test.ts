// Purpose: test the own-coding part of a mind's settings (ownCoding.metta) end to end: the mind the host sent → facts
// → MeTTa composes → the renderer draws, off and on, for its owner and for anyone else.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../api/types'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { ownCodingScreen } from './ownCoding'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const space = ScreensSpace.open()
const mind = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'm_1', name: 'Wren', hue: 140, status: 'awake', swarm_id: null, kind: 'iter', ...over }) as Agent

const draw = (agent: Agent, look = 'classic') => {
  const { data, facts } = ownCodingScreen(agent)
  const plan = space.compose('own-coding', look, facts)
  return { plan, html: renderToStaticMarkup(createElement(Screen, { plan, host: { data, framed: true, onOpen: () => {}, onAction: () => {} } })) }
}

describe('Its own coding, composed by MeTTa', () => {
  it('off by default: it builds through Create, and its owner sees the switch, off', () => {
    const { html } = draw(mind())
    expect(html).toContain('Wren builds software through Create, and asks a person before each shell command it runs.')
    expect(html).toContain('aria-label="Let Wren write and run its own code"')
    expect(html).toContain('aria-checked="false"')
    expect(html).not.toContain('Only its owner can change this.')
  })
  it('switched on by its owner: it writes and runs its own code', () => {
    const { html } = draw(mind({ options: { own_coding: true } }))
    expect(html).toContain('Wren writes and runs its own code without Create, as a self-modifying Iter does.')
    expect(html).toContain('aria-checked="true"')
  })
  it('anyone the host says is not its owner reads how it is and gets no switch', () => {
    const { html } = draw(mind({ may_switch_own_coding: false, options: { own_coding: true } }))
    expect(html).toContain('Only its owner can change this.')
    expect(html).not.toContain('role="switch"')
  })
  it('the switch sends own-coding, which the settings turn into options.own_coding', () => {
    const { data, facts } = ownCodingScreen(mind())
    expect(data['coding.choice']).toEqual([{ id: 'own-coding', label: 'Writes and runs its own code', on: false }])
    expect(space.compose('own-coding', 'classic', facts).parts.find((p) => p.block === 'toggles')?.props.action).toBe('own-coding')
  })
  it('the guards stay clean and nothing falls back, in either look', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    for (const look of ['classic', 'cosmos']) expect(draw(mind(), look).plan.missing).toEqual([])
  })
})
