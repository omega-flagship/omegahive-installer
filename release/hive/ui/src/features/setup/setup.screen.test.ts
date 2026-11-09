import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'

// each file opens real MeTTa spaces: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

/** Getting started end to end: who is signed in and whether the hive view hides the checklist → MeTTa composes → drawn. */
const space = ScreensSpace.open()
const ISLANDS = { 'setup-checklist': createElement('section', { 'aria-label': 'Checklist fixture' }) }
const at = (signedIn: boolean, hidden: boolean, look = 'classic') => {
  const plan = space.compose('setup', look, { flags: { 'signed.in': signedIn, 'setup.hidden': hidden } })
  return { plan, orders: plan.parts.map((p) => p.order), html: renderToStaticMarkup(createElement(Screen, { plan, host: { data: {}, framed: true, islands: ISLANDS, onAction: () => {} } })) }
}

describe('Getting started, composed by MeTTa', () => {
  it('the opening words, then the checklist', () => {
    const { html } = at(false, false)
    expect(html).toContain('Five things that make a hive work.')
    expect(html.indexOf('Five things')).toBeLessThan(html.indexOf('Checklist fixture'))
  })
  it('signed in, shown on the hive view: says so, with a way to hide it, on one row', () => {
    const { html } = at(true, false)
    expect(html).toContain('Shown on your hive view until every step is done.')
    expect(html).toContain('Hide it there')
    expect(html).not.toContain('Show it there again')
    expect(html).toContain('data-screen-row="on-hive"')
  })
  it('signed in, hidden there: says so, with a way to show it again', () => {
    const { html } = at(true, true)
    expect(html).toContain('Hidden from your hive view.')
    expect(html).toContain('Show it there again')
    expect(html).not.toContain('Hide it there')
  })
  it('nobody signed in: no line about the hive view', () => {
    const { html } = at(false, true)
    expect(html).not.toContain('hive view')
  })
  it('the guards stay clean and nothing falls back', () => {
    expect(Object.values(space.guards()).flat()).toEqual([])
    expect(at(true, false, 'cosmos').plan.missing).toEqual([])
  })
})

describe('every part of Getting started can be reached', () => {
  it('signed out, shown there, and hidden there', () => {
    const seen = new Set<number>()
    const see = (o: number[]) => { o.forEach((x) => seen.add(x)); return o }
    expect(see(at(false, false).orders)).toEqual([10, 20])
    expect(see(at(true, false).orders)).toEqual([10, 20, 30, 31])
    expect(see(at(true, true).orders)).toEqual([10, 20, 32, 33])
    expect([...seen].sort((a, b) => a - b)).toEqual(space.orders('setup'))
  })
})
