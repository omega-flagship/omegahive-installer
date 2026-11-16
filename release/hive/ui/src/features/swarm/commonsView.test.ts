import { describe, expect, it } from 'vitest'
import { followTabLink, initialTab, initialView } from './commonsView'

/** Demo walk (demo-p2): the guided demos open `?tab=commons` and say "drawn as a sky", but the page showed its table. */
describe('the commons view a swarm page opens on', () => {
  it('a link to the commons itself opens the constellation', () => {
    expect(initialView('commons', true)).toBe('sky')
    expect(initialView('commons', false)).toBe('sky')
  })
  it('otherwise as before: the table, or the requests inbox on desktop', () => {
    expect(initialView(undefined, true)).toBe('list')
    expect(initialView('members', false)).toBe('list')
    expect(initialView('requests', true)).toBe('requests')
    expect(initialView('requests', false)).toBe('list')
  })
})

describe('the section a swarm page shows for its ?tab=', () => {
  it('each tab by name; requests with the team; settings and none on the commons', () => {
    expect(initialTab('members')).toBe('members')
    expect(initialTab('vocab')).toBe('vocab')
    expect(initialTab('requests')).toBe('members')
    expect(initialTab('settings')).toBe('commons')
    expect(initialTab(undefined)).toBe('commons')
  })
  it('a new ?tab= on the open page moves it there (audit P3 #27)', () => {
    expect(followTabLink(undefined, 'commons', true)).toEqual({ tab: 'commons', view: 'sky' })
    expect(followTabLink('commons', 'members', false)).toEqual({ tab: 'members' })
    expect(followTabLink('members', 'requests', true)).toEqual({ tab: 'members', view: 'requests' })
    expect(followTabLink('commons', 'settings', true)).toEqual({})
    expect(followTabLink('commons', undefined, true)).toEqual({})
  })
  it('the same ?tab= again never undoes the person’s own view (Kimi r1 #5)', () => {
    expect(followTabLink('commons', 'commons', true)).toEqual({})
  })
})
