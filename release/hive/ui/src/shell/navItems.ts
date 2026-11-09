import type { Program } from '../api/types'
import { shown } from '../lib/displayName'
import type { Route } from '../lib/router'
import { iconOr, type IconName } from '../ui/iconPaths'

/**
 * The classic navigation, in one place (Classic nav redesign, 2026-10-06). The desktop rail, its top bar and dock
 * layouts, the phone bar and its More sheet, the `g` shortcuts and the command palette's navigation all read this
 * file, so a destination can never be in one and missing from another.
 */

/**
 * The work words (Motivations above Tasks, MOTIVATIONS_TASKS_HOST_DESIGN_20261005.md): the old
 * Goals and Boards pair became Motivations (the why) above Tasks (the work; Boards is now a view of Tasks).
 */
export const TERMS = {
  motivations: 'Motivations',
  tasks: 'Tasks',
} as const

/** One navigation destination. */
export interface NavItem {
  key: string
  label: string
  /** One plain line for the phone's More sheet and the rail tooltip. */
  blurb: string
  icon: IconName
  route: Route
  /** The route names this entry is "current" for (refined by `when`). */
  match: Route['name'][]
  /** A finer test, for entries that share a route name (Inbox and Policy rules; one app among all). */
  when?: (r: Route) => boolean
  /** The two-key shortcut, shown as `G X`. */
  keys?: [string, string]
  badge?: 'pending' | 'health' | 'held'
  /**
   * Admin-only: the hive refuses members the page (admin() guards), or it is an admin's job (the setup checklist). Policy
   * rules is an admin shortcut; every signed-in person still reaches it as Inbox → Rules (its "Go to" place).
   */
  admin?: true
  /** The registry feature this entry opens (features/registry.ts): the presence target and the coverage proof. */
  feature: string
  /** An app's own entry (Apps section): its program id and identity colour. */
  app?: { id: string; accent?: string }
  /** Places inside the page that are hard to find otherwise: its menu's "Go to" entries and palette search. */
  places?: NavPlace[]
}

/** A place inside a page: a route, and optionally the part of the page to bring into view (a heading's selector). */
export interface NavPlace {
  key: string
  label: string
  route: Route
  reveal?: string
  /** Only admins see this part of the page (the hive refuses members). */
  admin?: true
}

export type NavSectionId = 'home' | 'minds' | 'work' | 'apps' | 'watch' | 'admin'

export interface NavSection {
  id: NavSectionId
  label: string
  /** The icon a collapsed section shows on the icon-only rail. */
  icon: IconName
  items: NavItem[]
  /** Starts collapsed until the person opens it. */
  collapsed?: true
  /** The home section has no heading and cannot collapse. */
  fixed?: true
}

const notRules = (r: Route) => !(r.name === 'approvals' && r.tab === 'rules')

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'home',
    label: 'Home',
    icon: 'hive',
    fixed: true,
    items: [
      { key: 'hive', label: 'Hive', blurb: 'Every mind, live', icon: 'hive', route: { name: 'hive' }, match: ['hive', 'dot'], keys: ['G', 'H'], feature: 'minds.see', places: [{ key: 'new', label: 'Create a new mind', route: { name: 'new' } }] },
      { key: 'inbox', label: 'Inbox', blurb: 'Decisions waiting on you', icon: 'inbox', route: { name: 'approvals' }, match: ['approvals'], when: notRules, keys: ['G', 'I'], badge: 'pending', feature: 'decide.approvals', places: [{ key: 'history', label: 'Decision history', route: { name: 'approvals', tab: 'history' } }, { key: 'rules', label: 'Policy rules', route: { name: 'approvals', tab: 'rules' } }] },
      { key: 'messages', label: 'Messages', blurb: 'DMs, groups, channels and sessions with minds and people', icon: 'chat', route: { name: 'messages' }, match: ['messages'], keys: ['G', 'T'], feature: 'talk.rooms' },
      { key: 'conversations', label: 'Recent conversations', blurb: 'Minds you talked to lately: straight back to their chat', icon: 'history', route: { name: 'conversations' }, match: ['conversations'], keys: ['G', 'V'], feature: 'talk.recent' },
    ],
  },
  {
    id: 'minds',
    label: 'People & minds',
    icon: 'swarms',
    items: [
      { key: 'swarms', label: 'Swarms', blurb: 'Groups of minds with one purpose; archived swarms too', icon: 'swarms', route: { name: 'swarms' }, match: ['swarms', 'swarm', 'launch', 'lifecycle'], keys: ['G', 'S'], feature: 'swarms.see', places: [{ key: 'launch', label: 'Start a swarm', route: { name: 'launch' } }, { key: 'archived', label: 'Archived swarms', route: { name: 'swarms' }, reveal: '#archived-h', admin: true }] },
      { key: 'explore', label: 'Explore', blurb: 'Every mind and swarm, filtered and grouped your way', icon: 'compass', route: { name: 'explore' }, match: ['explore'], keys: ['G', 'X'], feature: 'work.explore', places: [{ key: 'groups', label: 'My Explore groups', route: { name: 'explore' }, reveal: '[data-tour="my-groups"] button' }] },
      { key: 'roles', label: 'Roles', blurb: 'Job descriptions for minds', icon: 'roles', route: { name: 'roles' }, match: ['roles'], keys: ['G', 'R'], feature: 'build.roles' },
      { key: 'models', label: 'Models', blurb: 'AI providers and the models minds think with', icon: 'cpu', route: { name: 'models' }, match: ['models'], keys: ['G', 'M'], feature: 'build.models' },
      { key: 'tools', label: 'Tools', blurb: 'Skills of thought minds can use, and which minds have them', icon: 'spark', route: { name: 'tools' }, match: ['tools'], feature: 'build.tools' },
      { key: 'people', label: 'People', blurb: 'Who can use this hive, and invitations', icon: 'people', route: { name: 'people' }, match: ['people'], keys: ['G', 'O'], admin: true, feature: 'people.manage' },
      { key: 'connect', label: 'Add an outside agent', blurb: 'Bring Claude Code, Codex or any MCP client into a swarm', icon: 'plug', route: { name: 'connect' }, match: ['connect'], keys: ['G', 'A'], admin: true, feature: 'minds.outside', places: [{ key: 'invites', label: 'Outside-agent invitations', route: { name: 'connect' }, reveal: '#invites-h', admin: true }] },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    icon: 'target',
    items: [
      { key: 'motivations', label: TERMS.motivations, blurb: 'Why the work matters: aims held by people, swarms and minds', icon: 'target', route: { name: 'motivations' }, match: ['motivations'], keys: ['G', 'W'], feature: 'work.motivations', places: [{ key: 'unsorted', label: 'Tasks under no motivation', route: { name: 'tasks', motivation: 'none' } }] },
      { key: 'tasks', label: TERMS.tasks, blurb: 'The work itself, and work to review: in columns or a list, by swarm, mind or motivation', icon: 'columns', route: { name: 'tasks' }, match: ['tasks', 'goals', 'boards'], keys: ['G', 'G'], feature: 'work.goals', places: [{ key: 'list', label: 'Every task as a list', route: { name: 'tasks', view: 'list' } }] },
      { key: 'flow', label: 'Flow', blurb: 'Build connected workflows', icon: 'graph', route: { name: 'flow' }, match: ['flow'], keys: ['G', 'F'], feature: 'work.flow' },
      { key: 'code', label: 'Code', blurb: 'Code workspaces in this hive', icon: 'terminal', route: { name: 'code' }, match: ['code'], keys: ['G', 'C'], feature: 'build.code', places: [{ key: 'map', label: 'Repository map', route: { name: 'code', map: '' } }] },
      // the file explorer's slot: today the hive's files and stores (#/assets); the explorer will take this entry over
      { key: 'files', label: 'Files', blurb: 'Files, stores and transfers', icon: 'database', route: { name: 'assets' }, match: ['assets'], keys: ['G', 'Y'], feature: 'work.assets' },
      { key: 'artifacts', label: 'Artifacts', blurb: 'What minds and apps produced, and findings', icon: 'doc', route: { name: 'artifacts' }, match: ['artifacts'], feature: 'work.artifacts' },
    ],
  },
  {
    id: 'apps',
    label: 'Apps',
    icon: 'apps',
    // the enabled apps are listed by name above this entry (navModel)
    items: [{ key: 'programs', label: 'All apps', blurb: 'Every app in this hive: turn on or off, access and activity', icon: 'apps', route: { name: 'programs' }, match: ['programs', 'program'], keys: ['G', 'P'], feature: 'apps.list', places: [{ key: 'activity', label: 'What apps did lately', route: { name: 'programs' }, reveal: '#app-activity-h' }] }],
  },
  {
    id: 'watch',
    label: 'Watch',
    icon: 'pulse',
    items: [
      { key: 'health', label: 'Health', blurb: 'Errors across minds, and the mind that answers them', icon: 'pulse', route: { name: 'health' }, match: ['health'], keys: ['G', 'E'], badge: 'health', feature: 'watch.health' },
      { key: 'usage', label: 'Usage', blurb: 'Spend, tokens, limits and calls to settle', icon: 'chart', route: { name: 'usage' }, match: ['usage'], keys: ['G', 'U'], badge: 'held', feature: 'money.usage', places: [{ key: 'settle', label: 'Calls to settle', route: { name: 'usage' }, reveal: '#settle-h' }, { key: 'limits', label: 'Spending limits', route: { name: 'usage' }, reveal: '#limits-h' }] },
      { key: 'lab', label: 'Lab', blurb: 'Platform tests and benchmarks', icon: 'flask', route: { name: 'lab' }, match: ['lab'], keys: ['G', 'L'], feature: 'watch.lab' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: 'rules',
    collapsed: true,
    items: [
      { key: 'settings', label: 'Settings', blurb: 'How this hive is set up: name, sign-in, password, disk, apps', icon: 'rules', route: { name: 'settings' }, match: ['settings'], keys: ['G', 'J'], admin: true, feature: 'hive.settings', places: [{ key: 'services', label: 'Registered services', route: { name: 'settings' }, reveal: '#services-h', admin: true }, { key: 'ask-audit', label: 'Ask audit', route: { name: 'settings' }, reveal: '#ask-audit-h', admin: true }] },
      { key: 'updates', label: 'Updates', blurb: 'App and platform updates, holds and history', icon: 'replay', route: { name: 'updates' }, match: ['updates'], keys: ['G', 'D'], admin: true, feature: 'build.updates' },
      { key: 'rules', label: 'Policy rules', blurb: 'What minds may do without asking', icon: 'scale', route: { name: 'approvals', tab: 'rules' }, match: ['approvals'], when: (r) => !notRules(r), admin: true, feature: 'decide.rules' },
      { key: 'setup', label: 'Getting started', blurb: 'Setup checklist: provider, who pays, limit, a swarm, invites', icon: 'check', route: { name: 'setup' }, match: ['setup'], admin: true, feature: 'hive.setup' },
    ],
  },
]

/** The profile entry, at the foot of the rail and the More sheet. */
export const ME_ITEM: NavItem = { key: 'me', label: 'You & your keys', blurb: 'Your profile, API keys and how the hive looks to you', icon: 'user', route: { name: 'me' }, match: ['me'], keys: ['G', 'K'], feature: 'people.me' }

/** Every fixed destination (apps are added per hive by appItem). */
export const NAV_ITEMS: NavItem[] = [...NAV_SECTIONS.flatMap((s) => s.items), ME_ITEM]

export const navItem = (key: string): NavItem => {
  const it = NAV_ITEMS.find((i) => i.key === key)
  if (!it) throw new Error(`no nav item ${key}`)
  return it
}

/** The phone bar, around the central create button: Hive, Swarms, (+), Inbox, Health, then More. */
export const PHONE_TABS = { before: ['hive', 'swarms'], after: ['inbox', 'health'] } as const


export const isActive = (it: NavItem, r: Route): boolean => it.match.includes(r.name) && (!it.when || it.when(r))

/** At most this many apps are listed by name; the rest are one click away in All apps. */
export const APPS_SHOWN = 5

/** An enabled app's own entry. */
export function appItem(p: Pick<Program, 'id' | 'name' | 'description' | 'icon'>, accent?: string): NavItem {
  return {
    key: `app:${p.id}`,
    label: shown(p.name),
    blurb: shown(p.description) || 'An app in this hive',
    icon: iconOr(p.icon, 'apps'),
    route: { name: 'program', id: p.id },
    match: ['program'],
    when: (r) => r.name === 'program' && r.id === p.id,
    feature: 'apps.open',
    app: { id: p.id, accent },
  }
}

/** What one person's navigation can show: admin-only entries only for admins, apps that are on, by name. */
export interface NavScope {
  admin: boolean
  apps?: readonly Pick<Program, 'id' | 'name' | 'description' | 'icon' | 'enabled'>[] | null
  accentOf?: (id: string) => string | undefined
}

/** One person's sections: admin-only entries removed for members, the enabled apps listed in Apps. */
export function scopedSections(scope: NavScope): NavSection[] {
  const apps = (scope.apps ?? []).filter((p) => p.enabled).map((p) => appItem(p, scope.accentOf?.(p.id)))
  return NAV_SECTIONS.map((s) => ({ ...s, items: (s.id === 'apps' ? [...apps, ...s.items] : s.items).filter((i) => scope.admin || !i.admin) })).filter((s) => s.items.length)
}

/** The places inside an entry this person can use. */
export const placesFor = (it: NavItem, admin: boolean): NavPlace[] => (it.places ?? []).filter((p) => admin || !p.admin)

/** Every destination this person can reach from the navigation, in order: the palette's navigation list. */
export const scopedItems = (scope: NavScope): NavItem[] => [...scopedSections(scope).flatMap((s) => s.items), ME_ITEM]

/**
 * `g` then a key, for one person: exactly the destinations their navigation reaches (scopedItems), so a member's
 * keyboard never reaches an admin-only page the rail, More sheet and palette do not show them.
 */
export const goKeysFor = (admin: boolean): Record<string, Route> =>
  Object.fromEntries(scopedItems({ admin }).filter((i) => i.keys).map((i) => [i.keys![1].toLowerCase(), i.route]))

/** What `g` then `key` does for this person: go there; for a member, an admin-only entry is named, not opened; or nothing. */
export function goKey(key: string, admin: boolean): { go: Route } | { adminOnly: NavItem } | null {
  const k = key.toLowerCase()
  const to = goKeysFor(admin)[k]
  if (to) return { go: to }
  const it = NAV_ITEMS.find((i) => i.keys && i.keys[1].toLowerCase() === k)
  return it?.admin && !admin ? { adminOnly: it } : null
}

/** One person's arrangement: what they pinned (in order), what they hid, which sections they folded. */
export interface NavPrefs {
  pinned: string[]
  hidden: string[]
  /** Section id → collapsed; a missing id uses the section's default. */
  collapsed: Partial<Record<NavSectionId, boolean>>
}
export const EMPTY_PREFS: NavPrefs = { pinned: [], hidden: [], collapsed: {} }

export interface NavModelSection {
  section: NavSection
  /** What the section shows (pinned and hidden entries taken out; apps beyond APPS_SHOWN folded into All apps). */
  items: NavItem[]
  /** Entries the person hid here ("Show hidden"). */
  hidden: NavItem[]
  collapsed: boolean
  /** Enabled apps not listed by name (they are in All apps). */
  moreApps: number
}

export interface NavModel {
  pinned: NavItem[]
  sections: NavModelSection[]
}

/**
 * The navigation as one person sees it: the single source the rail, the top bar and dock, and the phone's More sheet
 * render. Pinned entries move to the Pinned group at the top, in the person's order; hidden entries leave their section
 * but stay listed under its "Show hidden"; the palette (scopedItems) still finds both.
 */
export function navModel(scope: NavScope, prefs: NavPrefs = EMPTY_PREFS): NavModel {
  const sections = scopedSections(scope)
  const all = new Map(sections.flatMap((s) => s.items).map((i) => [i.key, i]))
  const pinned = prefs.pinned.map((k) => all.get(k)).filter((i): i is NavItem => !!i)
  const pinnedKeys = new Set(pinned.map((i) => i.key))
  const hiddenKeys = new Set(prefs.hidden)
  return {
    pinned,
    sections: sections.map((section) => {
      const rest = section.items.filter((i) => !pinnedKeys.has(i.key))
      let items = rest.filter((i) => !hiddenKeys.has(i.key))
      let moreApps = 0
      if (section.id === 'apps') {
        const apps = items.filter((i) => i.app)
        moreApps = Math.max(0, apps.length - APPS_SHOWN)
        const listed = new Set(apps.slice(0, APPS_SHOWN))
        items = items.filter((i) => !i.app || listed.has(i))
      }
      return { section, items, hidden: rest.filter((i) => hiddenKeys.has(i.key)), collapsed: !section.fixed && (prefs.collapsed[section.id] ?? !!section.collapsed), moreApps }
    }),
  }
}

/** One line of an entry's menu (right-click, long-press, Shift+F10, the context-menu key). */
export interface NavMenuEntry {
  id: 'pin' | 'unpin' | 'up' | 'down' | 'tab' | 'hide' | 'show' | 'app-settings' | 'app-activity' | `go-${string}`
  label: string
  section?: 'This app' | 'Go to'
  place?: NavPlace
}

/**
 * What an entry's menu offers this person: Pin or Unpin; Move up / Move down inside Pinned (the keyboard's way to
 * reorder); Open in new tab; Hide or Show; an app's settings and activity; then the places inside its page.
 */
export function navMenu(it: NavItem, prefs: NavPrefs, model: NavModel, admin: boolean): NavMenuEntry[] {
  const pinned = prefs.pinned.includes(it.key)
  const at = model.pinned.findIndex((p) => p.key === it.key)
  const out: NavMenuEntry[] = [pinned ? { id: 'unpin', label: 'Unpin' } : { id: 'pin', label: 'Pin to top' }]
  if (pinned && at > 0) out.push({ id: 'up', label: 'Move up' })
  if (pinned && at >= 0 && at < model.pinned.length - 1) out.push({ id: 'down', label: 'Move down' })
  out.push({ id: 'tab', label: 'Open in new tab' })
  out.push(prefs.hidden.includes(it.key) ? { id: 'show', label: 'Show in menu' } : { id: 'hide', label: 'Hide from menu' })
  if (it.app) out.push({ id: 'app-settings', section: 'This app', label: 'Settings and access' }, { id: 'app-activity', section: 'This app', label: 'What apps did lately' })
  for (const place of placesFor(it, admin)) out.push({ id: `go-${place.key}`, section: 'Go to', label: place.label, place })
  return out
}
