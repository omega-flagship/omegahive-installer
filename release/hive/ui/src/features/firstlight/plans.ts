/**
 * "Think with your … plan": the owner's AI subscriptions this host already reaches through its local CLI bridges
 * (hive/core/subscription_cli.py: providers subscription-cli for a Claude plan, subscription-codex for a ChatGPT plan).
 *
 * A plan is offered only when the host lists that provider as configured, with at least one model, and has not seen it
 * fail to answer. It is offered only to the hive's owner (the host's SubscriptionGate admits the owner's own minds only).
 * Offering changes nothing: the model is set only on the owner's tap (store.thinkWith).
 */
import type { ModelOption, ProviderStatus } from '../../api/types'
import { KEY_PROVIDERS } from '../keys/keyProvider'

export interface Plan {
  provider: 'subscription-cli' | 'subscription-codex'
  /** the button's words */
  label: string
  /** the model the tap sets: the bridge's first listed model, as `<provider>/<model>` */
  model: string
}

const ORDER: ReadonlyArray<{ provider: Plan['provider']; label: string }> = [
  { provider: 'subscription-cli', label: 'Think with your Claude plan' },
  { provider: 'subscription-codex', label: 'Think with your ChatGPT plan' },
]

export function connectedPlans(providers: readonly ProviderStatus[] | null | undefined, owner: boolean): Plan[] {
  if (!owner || !providers) return []
  const out: Plan[] = []
  for (const { provider, label } of ORDER) {
    const p = providers.find((x) => x.name === provider)
    if (!p || !(p.configured ?? p.connected) || p.readiness === 'not_answering' || p.test_only) continue
    const first = p.models.find((m) => typeof m === 'string' && m.trim())
    if (!first) continue
    out.push({ provider, label, model: `${provider}/${first.trim()}` })
  }
  return out
}

/** The plan the mind already thinks with, if its model is one of them. */
export const currentPlan = (model: string | null, plans: readonly Plan[]): Plan | null =>
  plans.find((p) => model?.split('/')[0] === p.provider) ?? null

/**
 * The key First Light asks for: OpenRouter's, since one OpenRouter key reaches every model (Ahmad, 10 November: "why are
 * you not just using open router"). Other providers' keys still work; they are not what it leads with.
 */
export const LEAD_PROVIDER = KEY_PROVIDERS.find((p) => p.name === 'openrouter')!

/**
 * The model a mind moves onto when it thinks with a keyed provider: the remembered default (Models view) when it is
 * that provider's, else the create flow's pick among that provider's models (CreateFlow: a Sonnet, else the first).
 * Example: an Anthropic key on a hive listing anthropic/claude-opus-5-5 and anthropic/claude-sonnet-5-5 gives the Sonnet.
 */
export function modelForKey(provider: string, models: readonly ModelOption[], remembered: string | null): string | null {
  const mine = models.filter((m) => m.provider === provider)
  if (remembered && mine.some((m) => m.id === remembered)) return remembered
  return (mine.find((m) => m.id.includes('sonnet')) ?? mine[0])?.id ?? null
}

export interface KeyedWay {
  provider: string
  /** the provider's own name, for "Think with …" */
  label: string
  /** the model the tap sets (modelForKey) */
  model: string
}

/**
 * "Think with OpenRouter": a keyed provider this person's own mind can already be paid with: for the owner a stored key,
 * the hive default or an environment key; for anyone else their own saved key, a key granted to them, or the owner's
 * key where the owner lets others use it. The host decides which, per caller, by the gateway's own admission
 * (hive/core/app.py pay_route): a provider reads configured to this person only when it would pay for their mind, and
 * GET /api/models lists its models only then. So a member who saved their own Anthropic key is offered Think with
 * Anthropic, and one who holds no key they can pay with is offered nothing. Offered only while the host has not seen
 * the provider fail to answer, and only with a model the hive lists for it. Offering changes nothing: the model is set
 * only on the person's tap.
 */
export function keyedWays(providers: readonly ProviderStatus[] | null | undefined, models: readonly ModelOption[] | null | undefined, remembered: string | null): KeyedWay[] {
  if (!providers || !models) return []
  return providers.flatMap((p) => {
    if (!p.needs_key || !(p.configured ?? p.connected) || p.readiness === 'not_answering' || p.test_only) return []
    const model = modelForKey(p.name, models, remembered)
    return model ? [{ provider: p.name, label: p.label?.trim() || p.name, model }] : []
  })
}

/**
 * Whether a mind on `model` has a way to think on this hive, as the ways above are offered: its provider is listed, is
 * not the demonstration model, has not been seen failing to answer, and needs no key or has one (configured). Example:
 * `openrouter/anthropic/claude-sonnet-5.5` thinks once the hive holds an OpenRouter key; `mock/echo` never does.
 */
export function canThink(model: string, providers: readonly ProviderStatus[] | null | undefined): boolean {
  const name = model.split('/')[0]
  const p = providers?.find((x) => x.name === name)
  return !!p && name !== 'mock' && !p.test_only && p.readiness !== 'test_only' && p.readiness !== 'not_answering' && (!p.needs_key || !!(p.configured ?? p.connected))
}

/** The models on this computer a mind can think with: local ones other than the demonstration model, on a provider
 * the host has not seen fail to answer. */
export function localModels(models: readonly ModelOption[] | null | undefined, providers: readonly ProviderStatus[] | null | undefined): ModelOption[] {
  return (models ?? []).filter((m) => {
    if (!m.local || m.provider === 'mock') return false
    const p = providers?.find((x) => x.name === m.provider)
    return !p?.test_only && p?.readiness !== 'not_answering' && p?.readiness !== 'test_only'
  })
}

/** The free route's provider name (hive/core/config.py FREE). */
export const FREE_PROVIDER = 'free'

export interface FreeRoute {
  /** the model the tap sets: the route's first listed model, the deploy's default, as `free/<model>` */
  model: string
  /** every model the deploy pays for, as `free/<model>` */
  models: string[]
  /** each person's model calls a day, as the host states it; null when an older host does not */
  dailyCalls: number | null
  /** where what a person writes goes to be answered: the endpoint's host */
  host: string
}

const hostOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? '').hostname
  } catch {
    return ''
  }
}

/**
 * The free route as the host states it to this person: the hive's deploy pays an endpoint for the minds of everyone it
 * admits, each person up to their model calls a day (hive/core/free_inference.py). There while the host lists it as
 * configured for them, with a model and calls a day; null otherwise: no free route, a day of no calls, or one the host
 * doesn't open to this person (a public visitor where the deploy hasn't opted visitors in). Example: a host listing
 * free with models ['minimax/minimax-m3.1-flash'], daily_calls 200 and base_url https://inference.asicloud.cudos.org/v1
 * gives { model: 'free/minimax/minimax-m3.1-flash', models: ['free/minimax/minimax-m3.1-flash'], dailyCalls: 200,
 * host: 'inference.asicloud.cudos.org' }.
 */
export function freeRoute(providers: readonly ProviderStatus[] | null | undefined): FreeRoute | null {
  const p = providers?.find((x) => x.name === FREE_PROVIDER)
  if (!p || !(p.configured ?? p.connected) || p.test_only || p.daily_calls === 0) return null
  const models = p.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => `${FREE_PROVIDER}/${m.trim()}`)
  if (models.length === 0) return null
  return { model: models[0], models, dailyCalls: typeof p.daily_calls === 'number' ? p.daily_calls : null, host: hostOf(p.base_url) }
}

/**
 * "Use free inference": offered to every signed-in person the route is there for, owner or not, unless the host has
 * seen it fail to answer. Offering changes nothing: the model is set only on the person's tap (store.thinkWith).
 */
export function freeWay(providers: readonly ProviderStatus[] | null | undefined): FreeRoute | null {
  const route = freeRoute(providers)
  return route && providers?.find((x) => x.name === FREE_PROVIDER)?.readiness !== 'not_answering' ? route : null
}

/** Whether a mind on `model` is set to think with the hive's free inference. */
export const onFreeWay = (model: string | null): boolean => model?.split('/')[0] === FREE_PROVIDER

/**
 * Why a mind set to think with free inference can't now: 'off' when the host no longer offers this person the free
 * route (the deploy took its key away, allows no calls, or doesn't open it to them), 'model' when it still does but no
 * longer offers the mind's model; null when it can, when the mind isn't set to it, and before the providers are read.
 * A route that only hasn't answered lately is no lapse: connectionState says that one.
 */
export type FreeLapse = 'off' | 'model'
export function freeLapse(model: string | null, providers: readonly ProviderStatus[] | null | undefined): FreeLapse | null {
  if (!onFreeWay(model) || !providers) return null
  const route = freeRoute(providers)
  return route === null ? 'off' : route.models.includes(model as string) ? null : 'model'
}
