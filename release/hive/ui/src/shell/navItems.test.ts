import { describe, expect, it } from 'vitest'
import { PATHS } from '../ui/iconPaths'
import { FEATURES } from '../features/registry'
import { navCommandsFor } from '../features/palette/navCommands'
import { APPS_SHOWN, EMPTY_PREFS, goKey, goKeysFor, isActive, ME_ITEM, NAV_ITEMS, NAV_SECTIONS, navItem, navMenu, navModel, PHONE_TABS, placesFor, scopedItems, scopedSections, TERMS, type NavScope } from './navItems'
import { dropPinned, toggleHidden, togglePin } from './navPrefs'
import navSource from './Nav.tsx?raw'
import menuSource from './NavMenu.tsx?raw'
import paletteSource from '../features/palette/CommandPalette.tsx?raw'
import shortcutsSource from './shortcuts.ts?raw'

const app = (id: string, enabled = true) => ({ id, name: id[0].toUpperCase() + id.slice(1), description: `${id} app`, icon: 'apps', enabled })
const ADMIN: NavScope = { admin: true, apps: [app('atlas'), app('omegatruth'), app('omegadesign', false)] }
const MEMBER: NavScope = { ...ADMIN, admin: false }
const labels = (s: NavScope) => scopedSections(s).map((x) => [x.label, x.items.map((i) => i.label)])

describe('the classic navigation (redesign 2026-10-06)', () => {
  it('orders the rail Home, People & minds, Work, Apps, Watch, Admin, at most seven entries a section', () => {
    expect(labels(ADMIN)).toEqual([
      ['Home', ['Hive', 'Inbox', 'Messages', 'Recent conversations']],
      ['People & minds', ['Swarms', 'Explore', 'Roles', 'Models', 'Tools', 'People', 'Add an outside agent']],
      ['Work', [TERMS.motivations, TERMS.tasks, 'Flow', 'Code', 'Files', 'Artifacts']],
      ['Apps', ['Atlas', 'Omegatruth', 'All apps']],
      ['Watch', ['Health', 'Usage', 'Lab']],
      ['Admin', ['Settings', 'Updates', 'Policy rules', 'Getting started']],
    ])
    for (const s of NAV_SECTIONS) expect(s.items.length, s.id).toBeLessThanOrEqual(7)
  })
  it('a member sees no admin-only entry and no Admin section; everything else is the same', () => {
    expect(labels(MEMBER)).toEqual([
      ['Home', ['Hive', 'Inbox', 'Messages', 'Recent conversations']],
      ['People & minds', ['Swarms', 'Explore', 'Roles', 'Models', 'Tools']],
      ['Work', [TERMS.motivations, TERMS.tasks, 'Flow', 'Code', 'Files', 'Artifacts']],
      ['Apps', ['Atlas', 'Omegatruth', 'All apps']],
      ['Watch', ['Health', 'Usage', 'Lab']],
    ])
    // admin-only = the pages the hive refuses members (admin() guards: people, harness invites, settings, updates; Tasks,
    // which took over the admin-only Boards, reads GET /api/tasks, open to every signed-in person),
    // the setup checklist (an admin's job) and the Policy rules shortcut (members reach it as Inbox → Rules, below)
    expect(NAV_ITEMS.filter((i) => i.admin).map((i) => i.key).sort()).toEqual(['connect', 'people', 'rules', 'settings', 'setup', 'updates'])
  })
  it('lists enabled apps by name, at most APPS_SHOWN, the rest folded into All apps', () => {
    const many = { admin: true, apps: Array.from({ length: APPS_SHOWN + 3 }, (_, i) => app(`app${i}`)) }
    const apps = navModel(many).sections.find((s) => s.section.id === 'apps')!
    expect(apps.items.filter((i) => i.app)).toHaveLength(APPS_SHOWN)
    expect(apps.moreApps).toBe(3)
    expect(apps.items.at(-1)!.key).toBe('programs')
    expect(navModel(ADMIN).sections.find((s) => s.section.id === 'apps')!.items.map((i) => i.key)).not.toContain('app:omegadesign')
  })
  it('one source drives the rail, the phone More sheet and the palette: the same entries, names and routes', () => {
    for (const scope of [ADMIN, MEMBER]) {
      const model = navModel(scope)
      const shown = [...model.sections.flatMap((s) => s.items), ME_ITEM]
      const cmds = navCommandsFor(scope)
      expect(cmds.map((c) => c.id)).toEqual(scopedItems(scope).map((i) => `nav-${i.key}`))
      expect(shown.map((i) => i.key)).toEqual(scopedItems(scope).map((i) => i.key))
      for (const [n, c] of cmds.entries()) expect(c.route).toEqual(shown[n].route)
    }
    // the components read the model, never a list of their own
    expect(navSource).toContain('navModel(')
    expect(navSource).not.toMatch(/NAV_GROUPS|NAV_SECTIONS\.map/)
    expect(paletteSource).toContain('navCommandsFor(')
    expect(paletteSource).not.toMatch(/id: 'nav-(setup|rules)'|id: `program-\$\{p\.id\}`,/)
  })
  it('pins move an entry to Pinned in the person’s order; hidden entries leave their section but stay in the palette', () => {
    let prefs = togglePin({ pinned: [], hidden: [], collapsed: {} }, 'lab')
    prefs = dropPinned(prefs, 'app:atlas', 'lab')
    prefs = toggleHidden(prefs, 'flow')
    const model = navModel(ADMIN, prefs)
    expect(model.pinned.map((i) => i.key)).toEqual(['app:atlas', 'lab'])
    const work = model.sections.find((s) => s.section.id === 'work')!
    expect(work.items.map((i) => i.key)).not.toContain('flow')
    expect(work.hidden.map((i) => i.key)).toEqual(['flow'])
    expect(model.sections.find((s) => s.section.id === 'watch')!.items.map((i) => i.key)).not.toContain('lab')
    expect(navCommandsFor(ADMIN).map((c) => c.id)).toContain('nav-flow')
    // a member's stored pin on an admin-only entry is ignored
    expect(navModel(MEMBER, togglePin(prefs, 'settings')).pinned.map((i) => i.key)).toEqual(['app:atlas', 'lab'])
  })
  it('Admin starts folded; Home cannot fold; a person’s choice wins', () => {
    const fold = (p = {}) => Object.fromEntries(navModel(ADMIN, { pinned: [], hidden: [], collapsed: p }).sections.map((s) => [s.section.id, s.collapsed]))
    expect(fold()).toEqual({ home: false, minds: false, work: false, apps: false, watch: false, admin: true })
    expect(fold({ admin: false, work: true })).toMatchObject({ admin: false, work: true })
  })
  it('Inbox and Policy rules are told apart, and an app is current only on its own page', () => {
    expect(isActive(navItem('inbox'), { name: 'approvals', tab: 'history' })).toBe(true)
    expect(isActive(navItem('inbox'), { name: 'approvals', tab: 'rules' })).toBe(false)
    expect(isActive(navItem('rules'), { name: 'approvals', tab: 'rules' })).toBe(true)
    const atlas = navModel(ADMIN).sections.find((s) => s.section.id === 'apps')!.items[0]
    expect(isActive(atlas, { name: 'program', id: 'atlas' })).toBe(true)
    expect(isActive(atlas, { name: 'program', id: 'omegatruth' })).toBe(false)
  })
  it('gives every destination its own icon, and none of them the approval shield', () => {
    const icons = NAV_ITEMS.map((i) => i.icon)
    expect(new Set(icons).size).toBe(icons.length)
    expect(icons).not.toContain('shield')
    for (const i of icons) expect(PATHS[i]).toBeTruthy()
  })
  it('keeps every g-shortcut this person may use, with unique keys (Kimi K3 follow-up: g keys are scoped like the menu)', () => {
    const keys = NAV_ITEMS.flatMap((i) => (i.keys ? [i.keys[1]] : []))
    expect(new Set(keys).size).toBe(keys.length)
    const was: Record<string, string> = { h: 'hive', s: 'swarms', u: 'usage', i: 'approvals', g: 'tasks', w: 'motivations', l: 'lab', p: 'programs', m: 'models', k: 'me', o: 'people', e: 'health', c: 'code', r: 'roles', t: 'messages', x: 'explore', f: 'flow', j: 'settings', d: 'updates', a: 'connect', y: 'assets' }
    const adminOnly = new Set(['o', 'a', 'j', 'd'])
    const forAdmin = goKeysFor(true)
    const forMember = goKeysFor(false)
    for (const [k, name] of Object.entries(was)) {
      expect(forAdmin[k]?.name, k).toBe(name)
      expect(forMember[k]?.name, k).toBe(adminOnly.has(k) ? undefined : name)
    }
    // exactly the destinations each person's navigation lists, no more
    expect(Object.keys(forMember).sort()).toEqual(scopedItems({ admin: false }).flatMap((i) => (i.keys ? [i.keys[1].toLowerCase()] : [])).sort())
  })
  it('a member’s g to an admin-only page names it as admin-only and never opens it; an admin goes there', () => {
    for (const k of ['o', 'a', 'j', 'd']) {
      const m = goKey(k, false)
      expect(m && 'adminOnly' in m && m.adminOnly.admin, k).toBe(true)
      expect(m && 'go' in m, k).toBe(false)
      expect(goKey(k, true), k).toEqual({ go: NAV_ITEMS.find((i) => i.keys?.[1].toLowerCase() === k)!.route })
    }
    expect(goKey('h', false)).toEqual({ go: { name: 'hive' } })
    expect(goKey('q', false)).toBeNull()
    // Boards is a view of Tasks now: its old g-key opens nothing rather than a page that is gone
    expect(goKey('b', true)).toBeNull()
    expect(shortcutsSource).toContain('goKey(k, adminView)')
    expect(shortcutsSource).not.toMatch(/GO_KEYS/)
  })
  it('the palette offers a member no admin-only action either (Add an outside agent)', () => {
    expect(paletteSource).toMatch(/\.\.\.\(adminView \? \[\{ id: 'connect', group: 'Actions'/)
    expect(paletteSource).not.toMatch(/^\s*\{ id: 'connect', group: 'Actions'/m)
  })
  it('keeps the phone bar; everything else is in the labelled More sheet', () => {
    expect([...PHONE_TABS.before, ...PHONE_TABS.after]).toEqual(['hive', 'swarms', 'inbox', 'health'])
    expect(ME_ITEM.route).toEqual({ name: 'me' })
    expect(NAV_SECTIONS.flatMap((s) => s.items).some((i) => i.key === 'me')).toBe(false)
  })
  it('every registry feature with a classic page is reachable from the classic navigation (admin view)', () => {
    const items = scopedItems({ admin: true, apps: [app('atlas')] })
    const missing = FEATURES.filter((f) => f.classic).filter((f) => {
      const r = f.classic!
      // a page an entry opens, or a place inside it (a tab, a swarm's or a mind's panel, the hive scene, the create button)
      if (r.name === 'new') return false
      return !items.some((i) => i.match.includes(r.name))
    })
    expect(missing.map((f) => f.id)).toEqual([])
    // and every entry names a real feature (its presence target)
    for (const i of [...items, ME_ITEM]) expect(FEATURES.some((f) => f.id === i.feature), i.key).toBe(true)
  })
  it('a member reaches every feature whose page the hive lets members use', () => {
    const items = scopedItems({ admin: false, apps: [] })
    const adminOnly = new Set(['people', 'settings', 'updates', 'connect', 'setup'])
    const missing = FEATURES.filter((f) => f.classic && f.classic.name !== 'new' && !adminOnly.has(f.classic.name)).filter((f) => !items.some((i) => i.match.includes(f.classic!.name)))
    expect(missing.map((f) => f.id)).toEqual([])
  })

  it('places inside pages are reachable: members reach Policy rules from Inbox; Archived swarms is for admins', () => {
    const go = (key: string, admin: boolean) => placesFor(navItem(key), admin).map((p) => p.label)
    expect(go('inbox', false)).toEqual(['Decision history', 'Policy rules'])
    expect(go('swarms', false)).toEqual(['Start a swarm'])
    expect(go('swarms', true)).toEqual(['Start a swarm', 'Archived swarms'])
    expect(go('usage', false)).toEqual(['Calls to settle', 'Spending limits'])
    expect(navItem('inbox').places!.find((p) => p.key === 'rules')!.route).toEqual(navItem('rules').route)
    // every place lands on a page some entry is current for
    for (const it of NAV_ITEMS) for (const p of it.places ?? []) expect(NAV_ITEMS.some((i) => i.match.includes(p.route.name)) || p.route.name === 'new', `${it.key}/${p.key}`).toBe(true)
  })
})

describe('an entry’s menu (right-click, long-press, Shift+F10, the context-menu key)', () => {
  const model = (prefs = EMPTY_PREFS) => navModel(ADMIN, prefs)
  const ids = (key: string, prefs = EMPTY_PREFS, admin = true) => {
    const it = [...model(prefs).pinned, ...model(prefs).sections.flatMap((s) => [...s.items, ...s.hidden])].find((i) => i.key === key)!
    return navMenu(it, prefs, model(prefs), admin).map((e) => e.id)
  }
  it('offers Pin, Open in new tab and Hide; a pinned entry offers Unpin and Move up / Move down within Pinned', () => {
    expect(ids('flow')).toEqual(['pin', 'tab', 'hide'])
    const prefs = { ...EMPTY_PREFS, pinned: ['lab', 'flow', 'code'] }
    expect(ids('lab', prefs)).toEqual(['unpin', 'down', 'tab', 'hide'])
    expect(ids('flow', prefs)).toEqual(['unpin', 'up', 'down', 'tab', 'hide'])
    // Code carries one place, "Repository map" (Workbench Map r1), under Go to
    expect(ids('code', prefs)).toEqual(['unpin', 'up', 'tab', 'hide', 'go-map'])
  })
  it('a hidden entry offers Show; an app offers its settings and activity; places come last under Go to', () => {
    expect(ids('flow', { ...EMPTY_PREFS, hidden: ['flow'] })).toEqual(['pin', 'tab', 'show'])
    expect(ids('app:atlas')).toEqual(['pin', 'tab', 'hide', 'app-settings', 'app-activity'])
    const swarms = navMenu(navItem('swarms'), EMPTY_PREFS, model(), false)
    expect(swarms.filter((e) => e.section === 'Go to').map((e) => e.label)).toEqual(['Start a swarm'])
    expect(navMenu(navItem('swarms'), EMPTY_PREFS, model(), true).at(-1)).toMatchObject({ id: 'go-archived', place: { reveal: '#archived-h' } })
  })
  it('opens from the keyboard, wears the host chrome, is contained and closes on Escape', () => {
    expect(navSource).toMatch(/e\.shiftKey && e\.key === 'F10'\) \|\| e\.key === 'ContextMenu'/)
    expect(navSource).toContain('onContextMenu')
    expect(navSource).toMatch(/pointerType !== 'touch'/)
    expect(menuSource).toContain('useEscape(onClose)')
    expect(menuSource).toContain('useModalContainment(menu')
    expect(menuSource).toMatch(/className="xc-menu /)
    expect(menuSource).toMatch(/className="xc-item /)
    expect(menuSource).toContain('pointer-coarse:min-h-11')
  })
})
