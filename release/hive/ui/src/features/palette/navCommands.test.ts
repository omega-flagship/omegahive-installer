import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, scopedItems } from '../../shell/navItems'
import { navCommands, navCommandsFor, placeCommandsFor } from './navCommands'

describe('the palette navigates from the classic navigation itself, so the two cannot drift (audit rows 21, 48)', () => {
  it('has exactly one entry per nav destination, with the nav’s own label, icon, keys and route', () => {
    const cmds = navCommands()
    expect(cmds.map((c) => c.id)).toEqual(NAV_ITEMS.map((i) => `nav-${i.key}`))
    for (const [i, c] of cmds.entries()) {
      expect(c.label).toBe(NAV_ITEMS[i].label)
      expect(c.icon).toBe(NAV_ITEMS[i].icon)
      expect(c.keys).toEqual(NAV_ITEMS[i].keys)
      expect(c.route).toEqual(NAV_ITEMS[i].route)
    }
  })
  it('reaches the destinations the audit found missing and the ones the redesign added, and says Apps, never programs', () => {
    const labels = navCommands().map((c) => c.label)
    for (const l of ['Messages', 'Explore', 'Motivations', 'Tasks', 'Flow', 'Updates', 'Settings', 'All apps', 'Files', 'Artifacts', 'Policy rules', 'Getting started']) expect(labels).toContain(l)
    expect(labels.join(' ')).not.toMatch(/program/i)
  })
  it('opens each enabled app by name, for one person’s scope', () => {
    const scope = { admin: false, apps: [{ id: 'atlas', name: 'Atlas', description: 'maps', icon: 'apps', enabled: true }, { id: 'off', name: 'Off', description: '', icon: 'apps', enabled: false }] }
    const cmds = navCommandsFor(scope)
    expect(cmds.find((c) => c.id === 'nav-app:atlas')).toMatchObject({ label: 'Open Atlas', route: { name: 'program', id: 'atlas' } })
    expect(cmds.some((c) => c.id === 'nav-app:off' || c.id === 'nav-settings')).toBe(false)
    expect(cmds.map((c) => c.id)).toEqual(scopedItems(scope).map((i) => `nav-${i.key}`))
  })
  it('follows a change to the nav list', () => {
    const extra = { ...NAV_ITEMS[0], key: 'zz', label: 'Zed', route: { name: 'lab' as const } }
    expect(navCommands([...NAV_ITEMS, extra]).at(-1)).toMatchObject({ id: 'nav-zz', label: 'Zed', route: { name: 'lab' } })
  })
  it('finds the places inside pages by name, once each, for one person’s scope', () => {
    const member = placeCommandsFor({ admin: false, apps: [] }).map((c) => c.label)
    expect(member).toEqual(expect.arrayContaining(['Decision history', 'Policy rules', 'Start a swarm', 'Calls to settle', 'Spending limits', 'What apps did lately', 'Create a new mind']))
    expect(member).not.toContain('Archived swarms')
    const admin = placeCommandsFor({ admin: true, apps: [] })
    expect(admin.map((c) => c.label)).toContain('Archived swarms')
    // an admin's Policy rules is a nav entry of its own: not listed a second time
    expect(admin.filter((c) => c.label === 'Policy rules')).toEqual([])
    expect(new Set(admin.map((c) => c.id)).size).toBe(admin.length)
  })
})
