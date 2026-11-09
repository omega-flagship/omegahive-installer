import type { HiveSettings } from '../../api/types'
import type { Route } from '../../lib/router'
import type { IconName } from '../../ui/iconPaths'
import type { ResourceState } from '../../lib/useResource'
import type { ScreenFacts } from '../../screens/screenSpace'
import { withResource } from '../../screens/resourceFacts'

/**
 * What the Settings screen is told (settings.metta): the values they draw, bound by path, and this moment's facts
 * (counts and flags) from which MeTTa composes them. Pure: names and times come in through `Names`.
 */
export interface Names {
  app: (id: string) => string
  swarm: (id: string) => string
  /** a moment as the person reads it (the page passes the browser's own format) */
  when?: (iso: string) => string
}

/** Where the operator password is in its rotation: asked, confirming, or a new one shown once. */
export interface PasswordStep { confirming: boolean; fresh: string | null }

/** Below this much free disk the page warns. */
export const LOW_DISK_BYTES = 3e9
export const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`
const list = (xs: string[]) => xs.join(', ')

export function settingsScreen(res: ResourceState<HiveSettings>, names: Names, password: PasswordStep): { data: Record<string, unknown>; facts: ScreenFacts } {
  const s = res.data
  const loaded = (res.status === 'ready' || res.status === 'empty') && s !== undefined
  const flags: Record<string, boolean> = {
    'password.confirming': password.confirming,
    'password.fresh': password.fresh !== null,
  }
  const data: Record<string, unknown> = { 'password.fresh': password.fresh ?? '', 'settings.links': SETTINGS_LINKS }
  const links = { 'settings.links': SETTINGS_LINKS.length }
  // an answer with no settings in it has nothing to show yet: it reads as still loading
  const answered = res.status === 'ready' || res.status === 'empty'
  const state = answered && !loaded ? { status: 'loading' as const, error: undefined } : res
  if (!loaded) return withResource(state, { data, facts: { flags, counts: links } })

  const when = names.when ?? ((iso: string) => new Date(iso).toLocaleString())
  const homes = Object.entries(s.apps.homes).map(([app, ids]) => `${names.app(app)}: ${list(ids.map(names.swarm))}`)
  Object.assign(data, {
    'hive.name': s.hive.name,
    'hive.build': s.hive.build?.slice(0, 10) ?? 'unknown',
    'hive.started': when(s.hive.started_at),
    'hive.base_paths': list(s.hive.base_paths.map((b) => `${b}/`)),
    'signin.callback_path': s.signin.hive_google.callback_path,
    'disk.free': `${gb(s.disk.free_bytes)} of ${gb(s.disk.total_bytes)}`,
    'disk.hive_data': gb(s.disk.hive_data_bytes),
    'apps.homes': homes,
    'apps.sandbox_apps': list(s.apps.sandbox_apps.map(names.app)),
    'apps.sandbox_runtimes': list(s.apps.sandbox_runtimes),
    'apps.local_only_swarms': list(s.apps.local_only_swarms.map(names.swarm)),
  })
  Object.assign(flags, {
    'hive.supervised': s.hive.supervised,
    'signin.family_google': s.signin.family_google,
    'signin.hive_google': s.signin.hive_google.configured,
    'password.from_env': s.signin.password_from_env,
    'disk.low': s.disk.free_bytes < LOW_DISK_BYTES,
  })
  return withResource(state, {
    data,
    facts: {
      flags,
      counts: {
        ...links,
        'hive.base_paths': s.hive.base_paths.length,
        'apps.homes': homes.length,
        'apps.sandbox_apps': s.apps.sandbox_apps.length,
        'apps.sandbox_runtimes': s.apps.sandbox_runtimes.length,
        'apps.local_only_swarms': s.apps.local_only_swarms.length,
      },
    },
  })
}

/** The pages that own the rest of the hive's setup; `icon` names the icon its row leads with. */
export interface SettingsLink { id: string; label: string; body: string; icon: IconName; route: Route }
export const SETTINGS_LINKS: readonly SettingsLink[] = [
  { id: 'models', label: 'Models and keys', body: 'Providers, API keys, which model each mind uses', icon: 'cpu', route: { name: 'models' } },
  { id: 'usage', label: 'Spending limits', body: 'Hive, swarm and mind budgets', icon: 'chart', route: { name: 'usage' } },
  { id: 'people', label: 'People and invites', body: 'Who can use this hive, and their roles', icon: 'people', route: { name: 'people' } },
  { id: 'updates', label: 'Updates', body: 'App and platform updates, holds and history', icon: 'replay', route: { name: 'updates' } },
  { id: 'roles', label: 'Roles', body: 'Job descriptions and skill rules for minds', icon: 'roles', route: { name: 'roles' } },
  { id: 'approvals', label: 'Approval rules', body: 'What minds may do without asking', icon: 'rules', route: { name: 'approvals', tab: 'rules' } },
  { id: 'assets', label: 'Files and storage', body: 'Files minds and people stored, where they are kept', icon: 'database', route: { name: 'assets' } },
  { id: 'artifacts', label: 'Artifacts and findings', body: 'What minds and apps produced, across the hive', icon: 'layers', route: { name: 'artifacts' } },
]

/** The route a pressed link opens, by its id. */
export const linkRoute = (id: string): Route | undefined => SETTINGS_LINKS.find((l) => l.id === id)?.route
