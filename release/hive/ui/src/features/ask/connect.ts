// Purpose: whether the signed-in person has any model the Ask could reach (omegahive-feedback#135), and the facts the
// ask-connect screen (connect.metta) composes from. The truth is the hive's own list of providers as it states them to
// THIS person (GET /api/providers, hive/core/app.py provider_view: `connected`/`configured` mean "you can pay for a call
// here", by the gateway's own admission), kept current by the providers.updated event. Never the owner's key: a
// provider someone else pays for reads unconfigured to a person it does not pay for.
import type { ProviderStatus } from '../../api/types'
import type { ScreenFacts } from '../../screens/screenSpace'
import { useHive } from '../../store/store'
import { FREE_PROVIDER, freeRoute } from '../firstlight/plans'

const listed = (p: ProviderStatus): boolean => p.models.some((m) => typeof m === 'string' && m.trim() !== '')

/**
 * Whether one provider gives this person a way to be answered. The demonstration model never counts. A provider that
 * needs a key counts once the hive says this person can pay there. Free inference counts while the hive offers it to
 * them with a model and calls a day (plans.freeRoute). A model on this computer, or a plan attached to the hive, counts
 * when it lists a model and the hive has not seen it fail to answer. (The host does not tell this page whose plan it
 * is, so a listed plan counts for whoever sees it: the bar is never closed on a guess.)
 */
export function providerUsable(p: ProviderStatus, all: readonly ProviderStatus[]): boolean {
  if (p.name === 'mock' || p.test_only || p.readiness === 'test_only') return false
  if (p.name === FREE_PROVIDER) return freeRoute(all) !== null
  if (p.needs_key) return !!(p.configured ?? p.connected)
  return !!(p.configured ?? p.connected) && listed(p) && p.readiness !== 'not_answering'
}

/**
 * true: the hive listed its providers for this person and none can answer them. false: at least one can, or the list
 * has not been read (unknown never closes the bar). A mind that is merely asleep is not this: waking is the Ask's own
 * work (store/askAutoWake).
 * Example: [openrouter with no key, mock] gives true; add a key and the hive's providers.updated makes it false.
 */
export function needsModel(providers: readonly ProviderStatus[] | null | undefined): boolean {
  return Array.isArray(providers) && !providers.some((p) => providerUsable(p, providers))
}

/** The same, read at the moment of a send (the handlers' own check, never a value captured at an earlier render). */
export const askNeedsModel = (): boolean => needsModel(useHive.getState().providers)

/** The ask-connect screen's facts. `held`: the person pressed Enter on words for a mind, which were kept. */
export function connectScreen(needs: boolean, held: boolean): { data: Record<string, unknown>; facts: ScreenFacts } {
  return { data: {}, facts: { flags: { 'ask.needs_model': needs, 'ask.held': needs && held } } }
}

const asked = new WeakSet<object>()
/** Read the providers once per connection when nothing has (the Models and You pages read them too). After that the
 *  hive's providers.updated event keeps them current, so a key added anywhere reopens the bar without a reload. */
export function ensureProviders(): void {
  const s = useHive.getState()
  const client = s.client as (object & { listProviders?: unknown }) | null
  if (!client || s.providers !== null || typeof client.listProviders !== 'function' || asked.has(client)) return
  asked.add(client)
  void s.loadProviders().catch(() => undefined)
}
