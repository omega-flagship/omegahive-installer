import type { Agent, AgentOptions, ProviderStatus } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago, money } from '../../lib/format'
import { plural } from '../../lib/plural'
import type { Compose, ScreenFacts, ScreenPlan } from '../../screens/screenSpace'
import { withResource } from '../../screens/resourceFacts'
import { HELP, routeSummary, type PickRow } from './modelUtil'

/**
 * What the Models screens are told (models.metta): the values they draw (bound by path) and this moment's facts
 * (counts and flags) from which MeTTa composes them. Each provider and each model in use is composed as its own small
 * screen, and the models screen stacks them. Pure: composing and the time are handed in.
 */
export interface Composed { data: Record<string, unknown>; facts: ScreenFacts }
/** One row of a stack: its id, the screen MeTTa composed for it, and the values that screen draws. */
export interface StackItem { id: string; plan: ScreenPlan; data: Record<string, unknown> }
export type DefaultModel = { model: string; options?: AgentOptions } | null

/** What the person is doing with each provider's key, by provider name. */
export interface KeyWork {
  replacing: ReadonlySet<string>
  confirming: ReadonlySet<string>
  checking: ReadonlySet<string>
  /** the provider named in #/models/<provider>: its key field takes focus */
  focus?: string
}

export interface ModelsInput {
  providers: ProviderStatus[] | null
  rows: PickRow[]
  agents: Agent[]
  def: DefaultModel
  work: KeyWork
  now: number
}

/** The sentence under a connected provider: which key it pays with, where that key lives, and the account's spend. */
export function keyLine(p: ProviderStatus): string {
  const where = p.source === 'env' ? ` from ${p.key_env} in the hive's environment` : ' stored in the hive'
  const account = p.account?.label ? ` · ${p.account.label}` : ''
  const spend = p.account && p.account.limit != null && p.account.usage != null ? ` · ${money(p.account.usage)} of ${money(p.account.limit)} used` : ''
  return `Key ${p.key_hint || 'set'}${where}${account}${spend}`
}

/** The line about OpenRouter's catalogue: how many models, how fresh, and any trouble fetching it. */
export function catalogueLine(c: NonNullable<ProviderStatus['catalog']>, now: number): string {
  const count = c.count ? `${plural(c.count, 'model')} in the catalogue` : 'Catalogue not fetched yet'
  const fetched = c.fetched_at ? ` · ${ago(new Date(c.fetched_at * 1000).toISOString(), now)}` : ''
  return `${count}${fetched}${c.error ? ` · ${c.error}` : ''}`
}

export function providerItem(p: ProviderStatus, work: KeyWork, now: number, compose: Compose): StackItem {
  const help = HELP[p.name]
  const flags = {
    'provider.connected': p.connected,
    'provider.ready': p.local || !p.needs_key,
    'provider.needs_key': p.needs_key,
    'provider.stored': p.source === 'stored',
    'provider.replacing': work.replacing.has(p.name),
    'provider.confirming': work.confirming.has(p.name),
    'provider.catalogue': p.name === 'openrouter' && p.connected && !!p.catalog,
  }
  return {
    id: p.name,
    plan: compose('models-provider', { flags }),
    data: {
      'provider.label': p.label,
      'provider.key_line': p.connected ? keyLine(p) : '',
      'provider.invite': `Paste a key to use ${p.label} models. It stays in the hive; minds call through the gateway and never see it.`,
      'provider.key_label': `${p.label} API key`,
      'provider.placeholder': help ? `${help.prefix}…` : 'API key',
      'provider.help': help ? `Find it at ${help.where}.` : '',
      'provider.help_url': help?.url ?? '',
      'provider.checking': work.checking.has(p.name),
      'provider.focus': work.focus === p.name,
      'provider.catalogue': p.catalog ? catalogueLine(p.catalog, now) : '',
    },
  }
}

/** Each model a mind runs on, the most used first, with the minds on it. */
export function inUseItems(agents: Agent[], rows: PickRow[], compose: Compose): StackItem[] {
  const byModel = new Map<string, Agent[]>()
  for (const a of agents) byModel.set(a.model, [...(byModel.get(a.model) ?? []), a])
  return [...byModel.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([model, minds]) => ({
      id: model,
      plan: compose('models-in-use', { counts: { 'use.minds': minds.length } }),
      data: {
        'use.name': rows.find((r) => r.id === model)?.name ?? model,
        'use.model': model,
        'use.minds': minds.map((a) => ({ id: a.id, name: shown(a.name), hue: a.hue, status: a.status })),
      },
    }))
}

/** The models screen: the providers, the default for new minds, the models in use. */
export function modelsScreen(input: ModelsInput, compose: Compose): Composed {
  const { providers, rows, agents, def, work, now } = input
  const all = (providers ?? []).map((p) => providerItem(p, work, now, compose))
  const ready = (providers ?? []).filter((p) => p.connected).length
  const row = def ? rows.find((r) => r.id === def.model) : undefined
  const inuse = inUseItems(agents, rows, compose)
  // the store holds the providers once read (null until then); it keeps no failure of its own
  return withResource({ status: providers ? 'ready' : 'loading', error: undefined }, {
    data: {
      'providers.all': all,
      // the provider named in #/models/<provider>: its card carries the focus ring
      'providers.focus': work.focus ?? '',
      'providers.summary': providers ? `${ready} of ${providers.length} ready` : '',
      'default.summary': row
        ? `New minds start on ${shown(row.name)}${row.provider === 'openrouter' ? ` · ${routeSummary(def?.options)}` : ''}. You can still change it for each mind.`
        : '',
      'models.inuse': inuse,
    },
    facts: {
      counts: { 'providers.all': all.length, 'models.inuse': inuse.length },
      flags: { 'default.set': def !== null, 'default.known': row !== undefined },
    },
  })
}
