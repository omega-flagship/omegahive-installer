import type { Route } from '../../lib/router'
import { NAV_ITEMS, placesFor, scopedItems, type NavItem, type NavScope } from '../../shell/navItems'
import type { IconName } from '../../ui/iconPaths'

/**
 * The palette's navigation entries, made from the classic navigation itself (shell/navItems.ts: the one list the rail,
 * phone bar, More sheet and `g` keys read), so a destination can never be in the navigation and missing from the
 * palette, or named differently there (classic audit rows 21 and 48). With a scope, the palette lists exactly what that
 * person's navigation can reach: admin-only entries for admins, and each enabled app by name. Pins and hidden entries
 * do not change the palette (a hidden entry is still found by search). Only search words are added here.
 */
const WORDS: Record<string, string> = {
  hive: 'home scene minds dots overview',
  messages: 'chat dm group channel room project talk conversation session sessions',
  explore: 'filter group facets views holarchy search everything nested',
  swarms: 'team swarm groups commons beliefs archived archive restore lifecycle vocabulary connections',
  flow: 'flows workflow studio pipeline templates runs',
  tasks: 'tasks goals kanban board boards list work review cross-swarm requests subtasks unsorted',
  motivations: 'motivations motivation why aims purposes goals objectives intentions reasons evolve objective',
  inbox: 'approve deny pending gate approvals decisions waiting answered asks requests history',
  health: 'errors failing broken problems loop crash denied stuck health mind',
  usage: 'spend cost tokens limits budgets money held calls settle reservations',
  lab: 'tests benchmarks bench ci suites scorecard',
  settings: 'hive setup sign-in password disk isolation identity name move',
  programs: 'apps programs plugins unfold map compare evidence fusion design commons evolve activity',
  models: 'openrouter anthropic openai key api provider providers catalogue catalog llm connect',
  roles: 'role prompt persona template personality job instructions',
  code: 'code edit source workbench developer omegacode diff test',
  files: 'files file explorer assets storage stores transfers upload documents',
  artifacts: 'artifacts findings results outputs exhibits revisions',
  updates: 'update reload restart platform holds hold history',
  rules: 'allow ask deny skills glob policy permissions rules',
  setup: 'first run setup checklist onboarding provider key limit invite start getting started',
  people: 'invite colleague team member admin email google access remove',
  connect: 'outside agent harness invite join code mcp claude codex hermes connect remote external',
  me: 'profile me keys api key billing pay credits look change ui',
}

export interface NavCommand {
  id: string
  label: string
  icon: IconName
  keys?: string[]
  keywords: string
  route: Route
  badge?: NavItem['badge']
}

export function navCommands(items: readonly NavItem[] = NAV_ITEMS): NavCommand[] {
  return items.map((it) => ({
    id: `nav-${it.key}`,
    label: it.app ? `Open ${it.label}` : it.label,
    icon: it.icon,
    keys: it.keys ? [...it.keys] : undefined,
    keywords: `${it.blurb} ${it.app ? `app program ${it.app.id}` : (WORDS[it.key] ?? '')}`.trim(),
    route: it.route,
    badge: it.badge,
  }))
}

/** One person's palette navigation: exactly what their navigation reaches. */
export const navCommandsFor = (scope: NavScope): NavCommand[] => navCommands(scopedItems(scope))

/** A place inside a page (navItems `places`), found by search: Decision history, Archived swarms, Calls to settle… */
export interface PlaceCommand {
  id: string
  label: string
  icon: IconName
  keywords: string
  route: Route
  reveal?: string
}

/** One person's searchable places inside their navigation's pages, from the same entries. */
export function placeCommandsFor(scope: NavScope): PlaceCommand[] {
  const items = scopedItems(scope)
  // a place that is already an entry of its own for this person (an admin's Policy rules) is listed once, as the entry
  const own = new Set(items.map((it) => JSON.stringify(it.route)))
  return items.flatMap((it) =>
    placesFor(it, scope.admin)
      .filter((p) => p.reveal || !own.has(JSON.stringify(p.route)))
      .map((p) => ({ id: `place-${it.key}-${p.key}`, label: p.label, icon: it.icon, keywords: `${it.label} ${p.key}`, route: p.route, reveal: p.reveal })),
  )
}
