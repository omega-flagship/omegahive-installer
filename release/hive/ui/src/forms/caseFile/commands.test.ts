import { describe, expect, it } from 'vitest'
import { fixtureDescribe, fixtureGraph } from './fixture'
import { bar, parseCommand, verbsFor } from './commands'

const items = new Map(fixtureGraph.items.map((i) => [i.id, i]))
const p = (line: string, fallback: string | null = null) => parseCommand(line, fixtureDescribe, items, fallback, 'q1')

describe('docket commands', () => {
  it('maps words to the program’s action ids', () => {
    expect(p('support c1')).toEqual({ kind: 'action', action: 'add-support', items: ['c1'], ignored: [] })
    expect(p('counter h2')).toMatchObject({ action: 'add-counterevidence', items: ['h2'] })
    expect(p('ask challenger a1')).toMatchObject({ action: 'ask-challenger', items: ['a1'] })
    expect(p('verify-claim c2')).toMatchObject({ action: 'verify-claim', items: ['c2'] })
  })
  it('dispatch scientist defaults to the row under the cursor, else the question; flags are named back as ignored', () => {
    expect(p('dispatch scientist')).toMatchObject({ action: 'ask-scientist', items: ['q1'] })
    expect(p('dispatch scientist', 'g1')).toMatchObject({ action: 'ask-scientist', items: ['g1'] })
    // evidence cannot take ask-scientist, so the cursor on e1 falls back to the question
    expect(p('dispatch scientist', 'e1')).toMatchObject({ items: ['q1'] })
    expect(p('dispatch scientist --budget 2')).toMatchObject({ action: 'ask-scientist', ignored: ['--budget'] })
  })
  it('refuses actions that do not apply, unknown verbs and unknown ids', () => {
    expect(p('challenge e1')).toMatchObject({ kind: 'error' })
    expect(p('fly c1')).toMatchObject({ kind: 'error' })
    expect(p('support c9')).toMatchObject({ kind: 'error', message: 'No item c9 in this case.' })
  })
  it('navigates', () => {
    expect(p('weigh h2')).toEqual({ kind: 'weigh', id: 'h2' })
    expect(p('open e3')).toEqual({ kind: 'open', id: 'e3' })
    expect(p('ex b')).toEqual({ kind: 'exhibit', mark: 'B' })
    expect(p('help')).toEqual({ kind: 'help' })
  })
  it('offers only the verbs that apply, marking the gated ones', () => {
    const v = verbsFor(fixtureDescribe, items.get('c1')!)
    expect(v.map((x) => x.key)).toEqual(['s', 'x', 'q', 'c', 'd', 'v'])
    expect(v.find((x) => x.key === 'd')!.gated).toBe(true)
    expect(v.find((x) => x.key === 's')!.gated).toBe(false)
    expect(verbsFor(fixtureDescribe, items.get('g1')!).map((x) => x.key)).toEqual(['d', 'i'])
  })
  it('draws weight bars to scale', () => {
    expect(bar(1, 2, 8)).toBe('████░░░░')
    expect(bar(0, 0, 4)).toBe('░░░░')
  })
})
