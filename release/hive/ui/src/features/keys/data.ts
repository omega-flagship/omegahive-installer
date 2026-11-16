import type { Me } from '../../api/client'
import type { Agent, KeyInfo } from '../../api/types'
import { shown } from '../../lib/displayName'
import { money } from '../../lib/format'
import { identityLine } from '../../lib/identity'
import { plural } from '../../lib/plural'
import type { ResourceLike } from '../../screens/resourceFacts'
import { withResource } from '../../screens/resourceFacts'
import type { Compose, ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import type { ResourceState } from '../../lib/useResource'

/**
 * What the You page's screens are told (profile.metta): the values they draw (bound by path) and this moment's facts
 * (counts and flags) from which MeTTa composes them. Each provider's keys and each key are composed as their own small
 * screens, and the profile screen stacks them. Pure: composing is handed in. A key's secret is never here: the hive
 * sends only its last four characters (`hint`), and a key being added stays in the add-key form.
 */
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }

/** What the person is doing with each key, by key id. */
export interface KeyWork {
  editing: ReadonlySet<string>
  confirming: ReadonlySet<string>
}

export interface ProfileInput {
  me: ResourceState<Me>
  /** null until the keys are read */
  keys: KeyInfo[] | null
  /** why the last read of the keys failed (undefined when it did not) */
  keysError: unknown
  agents: Agent[]
  /** a client is connected, so there is a session to sign out of */
  connected: boolean
  signingOut: boolean
  adding: boolean
  work: KeyWork
}

/** The orb hue of the person signed in. */
export const ME_HUE = 150

/** The name at the top of the page: the person's own, the operator's, or "You" until the hive says. */
export function meName(me: ResourceState<Me>): string {
  return me.data?.person?.name ?? (me.data?.kind === 'password' ? 'Operator' : 'You')
}

/** Minds on a model that costs money (not a mock, local or Ollama model). */
export const paidMinds = (agents: Agent[]): number => agents.filter((a) => !/^(mock|local|ollama)\//.test(a.model)).length

/** One key's card: its facts and the words it draws. */
export function keyItem(k: KeyInfo, work: KeyWork, compose: Compose): StackItem {
  const acct = k.account
  const assigned = k.minds.filter((x) => x.assigned).length
  const flags = {
    'key.env': !!k.env,
    'key.default': k.default,
    'key.editing': work.editing.has(k.id),
    'key.confirming': work.confirming.has(k.id),
    'key.account_usage': !!acct && !acct.error && acct.usage != null,
    'key.account_limit': !!acct && acct.limit != null,
    'key.account_error': !!acct?.error,
  }
  return {
    id: k.id,
    plan: compose('profile-key', { flags, counts: { 'key.minds': k.minds.length, 'key.assigned': assigned } }),
    data: {
      'key.label': k.label,
      'key.hint': k.hint,
      'key.spent': money(k.spent_usd),
      'key.account_usage': acct?.usage != null ? money(acct.usage) : '',
      'key.account_limit': acct?.limit != null ? money(acct.limit) : '',
      'key.account_error': acct?.error ?? '',
      'key.assigned_n': assigned,
      'key.minds': k.minds.map((x) => ({ id: x.id, name: `${shown(x.name)}${x.assigned ? '' : ' (as the default)'}`, hue: x.hue, status: x.status })),
    },
  }
}

/** The keys grouped by provider, in the order the hive lists them, each group with its own composed cards. */
export function groupItems(keys: KeyInfo[], work: KeyWork, compose: Compose): StackItem[] {
  const by = new Map<string, KeyInfo[]>()
  for (const k of keys) by.set(k.provider, [...(by.get(k.provider) ?? []), k])
  return [...by.entries()].map(([provider, list]) => {
    const cards = list.map((k) => keyItem(k, work, compose))
    return {
      id: provider,
      plan: compose('profile-provider', { counts: { 'group.keys': cards.length } }),
      data: { 'group.label': list[0].provider_label, 'group.keys': cards },
    }
  })
}

/** Where the keys are: loading, read (empty or not), or failed. A failure after they were read keeps them on screen. */
export function keysResource(keys: KeyInfo[] | null, error: unknown): ResourceLike {
  if (keys) return { status: keys.length ? 'ready' : 'empty', error: undefined }
  return error !== undefined ? { status: 'error', error } : { status: 'loading', error: undefined }
}

/** The profile screen: who you are, the panels the page draws itself, and your keys. */
export function profileScreen(input: ProfileInput, compose: Compose): Composed {
  const { me, keys, keysError, agents, connected, signingOut, adding, work } = input
  const all = keys ?? []
  const total = all.reduce((t, k) => t + k.spent_usd, 0)
  const groups = groupItems(all, work, compose)
  return withResource(keysResource(keys, keysError), {
    data: {
      'me.name': meName(me),
      'me.hue': ME_HUE,
      'me.line': identityLine(me),
      'signout.busy': signingOut,
      'keys.summary': `${money(total)} spent through this hive · ${plural(paidMinds(agents), 'mind')} on paid models`,
      'keys.groups': groups,
    },
    facts: {
      counts: { 'keys.all': all.length },
      flags: { 'client.connected': connected, 'signout.busy': signingOut, 'keys.adding': adding, 'me.person': !!me.data?.person },
    },
  })
}
