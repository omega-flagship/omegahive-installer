import type { HiveInfo, KeyInfo, ProviderStatus, Swarm } from '../../api/types'
import type { BudgetRow } from '../usage/Limits'
import type { Route } from '../../lib/router'
import type { IconName } from '../../ui/iconPaths'

/**
 * The first-run checklist (classic audit row 49, P1 #7): five steps, each ticked from what the hive already reports.
 * Nothing is stored for it: a step is done when the hive's own state says so, `unknown` when this hive or this viewer
 * cannot read that state (never ticked on a guess). "Invite someone" is an admin step and is left out for others.
 */
export type StepState = 'done' | 'todo' | 'unknown'
export interface Step {
  id: 'provider' | 'payer' | 'limit' | 'swarm' | 'invite'
  label: string
  why: string
  /** Words for the current state (what was found). */
  found: string
  state: StepState
  icon: IconName
  route: Route
}

export interface SetupFacts {
  admin: boolean
  /** undefined: not readable here. */
  providers?: ProviderStatus[] | null
  keys?: KeyInfo[] | null
  budgets?: BudgetRow[] | null
  hive?: HiveInfo | null
  swarms: Swarm[]
  /** People besides the viewer, and open invitations (admins only). */
  people?: { people: number; invites: number } | null
}

export function setupSteps(f: SetupFacts): Step[] {
  const usable = f.providers?.filter((p) => p.connected || !p.needs_key) ?? null
  const payer = f.keys?.find((k) => k.default) ?? null
  const hiveRule = f.budgets?.find((b) => b.scope === 'hive' || b.scope.startsWith('hive:')) ?? null
  const hiveLimit = hiveRule ? hiveRule.limit_usd : f.budgets === undefined || f.budgets === null ? (f.hive?.limits?.hive_budget_usd ?? null) : null
  const live = f.swarms.filter((s) => !s.archived_at)
  const steps: Step[] = [
    {
      id: 'provider',
      label: 'Connect an AI provider',
      why: 'A mind cannot think until a provider is connected with a key.',
      state: usable === null ? 'unknown' : usable.length ? 'done' : 'todo',
      found: usable === null ? 'This hive does not list providers here.' : usable.length ? `Connected: ${usable.map((p) => p.label).join(', ')}` : 'No provider is connected yet.',
      icon: 'cpu',
      route: { name: 'models' },
    },
    {
      id: 'payer',
      label: 'Choose who pays',
      why: 'The hive default key pays for minds that have no key of their own.',
      state: f.keys === undefined || f.keys === null ? 'unknown' : payer ? 'done' : 'todo',
      found: f.keys === undefined || f.keys === null ? 'Keys are not readable here.' : payer ? `The hive default is ${payer.provider_label} ${payer.label} ${payer.hint}`.trim() : f.keys.length ? `${f.keys.length} key${f.keys.length === 1 ? '' : 's'}, none is the hive default.` : 'No keys yet.',
      icon: 'token',
      route: { name: 'me' },
    },
    {
      id: 'limit',
      label: 'Set a hive spending limit',
      why: 'A hard cap on what the whole hive may spend, before any mind starts.',
      state: hiveLimit === null ? (f.budgets === undefined && !f.hive ? 'unknown' : 'todo') : hiveLimit > 0 ? 'done' : 'todo',
      found: hiveLimit !== null && hiveLimit > 0 ? `Limit: $${hiveLimit.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : f.budgets === undefined && !f.hive ? 'Limits are not readable here.' : 'No hive-wide limit is set.',
      icon: 'gauge',
      route: { name: 'usage' },
    },
    {
      id: 'swarm',
      label: 'Start a swarm',
      why: 'A group of minds with one purpose and a shared commons.',
      state: live.length ? 'done' : 'todo',
      found: live.length ? `${live.length} swarm${live.length === 1 ? '' : 's'}` : 'No swarm yet.',
      icon: 'swarms',
      route: { name: 'launch' },
    },
  ]
  if (f.admin)
    steps.push({
      id: 'invite',
      label: 'Invite someone',
      why: 'Bring a colleague in, as a member or an admin.',
      state: f.people === undefined || f.people === null ? 'unknown' : f.people.people + f.people.invites > 0 ? 'done' : 'todo',
      found: f.people === undefined || f.people === null ? 'People are not readable here.' : f.people.people + f.people.invites > 0 ? `${f.people.people} other ${f.people.people === 1 ? 'person' : 'people'}, ${f.people.invites} invitation${f.people.invites === 1 ? '' : 's'} open` : 'Nobody else yet.',
      icon: 'people',
      route: { name: 'people' },
    })
  return steps
}

export const doneCount = (steps: Step[]) => steps.filter((s) => s.state === 'done').length

/** Dismissal is per person, in this browser (the hive's /api/me/ui only stores looks): keyed by their principal. */
export const dismissKey = (principal: string) => `omegahive.setup.dismissed.${principal}`
/** This browser's storage, or null where reading it throws (storage blocked: the page still starts). */
export const browserStore = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
export function isDismissed(principal: string | undefined, store: Pick<Storage, 'getItem'> | null = browserStore()): boolean {
  if (!principal || !store) return false
  try {
    return store.getItem(dismissKey(principal)) === '1'
  } catch {
    return false
  }
}
export function setDismissed(principal: string, dismissed: boolean, store: Pick<Storage, 'setItem' | 'removeItem'> | null = browserStore()): void {
  if (!store) return
  try {
    if (dismissed) store.setItem(dismissKey(principal), '1')
    else store.removeItem(dismissKey(principal))
  } catch {
    /* private mode: it shows again next time */
  }
}
