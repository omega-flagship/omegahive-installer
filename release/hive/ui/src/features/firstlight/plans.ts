/**
 * "Think with your … plan": the owner's AI subscriptions this host already reaches through its local CLI bridges
 * (hive/core/subscription_cli.py: providers subscription-cli for a Claude plan, subscription-codex for a ChatGPT plan).
 *
 * A plan is offered only when the host lists that provider as configured, with at least one model, and has not seen it
 * fail to answer. It is offered only to the hive's owner (the host's SubscriptionGate admits the owner's own minds only).
 * Offering changes nothing: the model is set only on the owner's tap (store.thinkWith).
 */
import type { ProviderStatus } from '../../api/types'

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
