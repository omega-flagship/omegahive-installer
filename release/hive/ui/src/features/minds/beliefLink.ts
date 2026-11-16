// Purpose: the belief-link screen's adapter: a mind's link as the hive answers it, with the page's own state, made into
// the facts and words beliefLink.metta composes from, and a press made into the domains PUT …/belief-link takes.
import type { Agent, BeliefLink, BeliefLinkDomains } from '../../api/types'
import type { ScreenFacts } from '../../screens/screenSpace'

/** The chooser's four values: the mind's default, every belief, the subjects ticked, or none. */
export type LinkChoice = 'default' | 'all' | 'some' | 'none'

/**
 * The page's own state beside the link it read. `picking`: Some subjects was chosen while no subject is linked yet, so
 * the ticks show and nothing is written until one is ticked. `busy`: a change is being saved. `error`: why the last
 * change failed, until the next one.
 */
export interface LinkPage { picking: boolean; busy: boolean; error: string | null }
export const LINK_PAGE: LinkPage = { picking: false, busy: false, error: null }

/** What the owner chose, as the chooser shows it ([] is none, and a list of subjects is some). */
export function choiceOf(domains: BeliefLinkDomains): LinkChoice {
  if (domains === null) return 'default'
  if (domains === 'all') return 'all'
  return domains.length ? 'some' : 'none'
}

/** The owner's subjects to tick, in order: those its saved beliefs are about now and any still chosen it holds none about. */
export function subjectsOf(link: BeliefLink): { id: string; label: string; on: boolean }[] {
  const chosen = Array.isArray(link.domains) ? link.domains : []
  return [...new Set([...(link.known_domains ?? []), ...chosen])].sort().map((d) => ({ id: d, label: d, on: chosen.includes(d) }))
}

/** An admin's ticks: only the subjects linked now, each ticked, so a tick can only take one away (narrow). */
export function linkedSubjectsOf(link: BeliefLink): { id: string; label: string; on: boolean }[] {
  return Array.isArray(link.linked) ? [...link.linked].sort().map((d) => ({ id: d, label: d, on: true })) : []
}

/** "coffee", "coffee and tea", "coffee, tea and weather". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The kind of mind each reason the hive gives for a default of none names (hive.py link_default_reason). */
const KEPT_BY: Record<NonNullable<BeliefLink['default_reason']>, (own: boolean) => string> = {
  personal: (own) => (own ? 'Your own mind' : "A person's own mind"),
  researcher: () => 'A researcher',
  private: () => 'A private mind',
  shared: () => 'A mind shared with some people',
}

/** Why the mind's default is what it is, in the words of the reason the hive gives. */
function whyOf(link: BeliefLink, own: boolean): string {
  if (link.default === 'all') return 'A public mind shares every belief with its swarm until its owner narrows it.'
  const kind = link.default_reason ? KEPT_BY[link.default_reason](own) : 'This mind'
  return `${kind} shares none of its beliefs until ${own ? 'you choose' : 'its owner chooses'}.`
}

/**
 * The screen's facts and data for this moment. The default's words follow what the hive says the default is and why
 * (hive.py link_default and link_default_reason): every belief for a public mind, none for a person's own mind, a
 * researcher, or a private or shared mind. What the reader may change follows the rights the hive answers with the link
 * (Jon on #360 and #354): its owner sees every choice; an admin, who may only narrow it, can link none or untick a linked
 * subject, and never sees a choice that would let the swarm see more; anyone else gets no link at all.
 */
export function beliefLinkScreen(link: BeliefLink | undefined, agent: Agent, viewer: string | undefined, page: LinkPage): { data: Record<string, unknown>; facts: ScreenFacts } {
  const widen = !!link?.rights.widen
  const narrow = !widen && !!link?.rights.narrow
  const flags = { 'link.widen': widen, 'link.narrow': narrow, 'link.links': !!link && link.linked !== 'none', 'link.busy': page.busy, 'link.failed': !!page.error }
  if (!link) return { data: {}, facts: { flags, values: {}, counts: {} } }
  const own = !!viewer && (agent.personal_of === viewer || agent.owner === viewer)
  const only = own ? 'Only you' : 'Only its owner'
  const choice: LinkChoice = page.picking && !Array.isArray(link.domains) ? 'some' : choiceOf(link.domains)
  const subjects = subjectsOf(link)
  const linkedSubjects = linkedSubjectsOf(link)
  const now = !agent.swarm_id
    ? `It is in no swarm, so ${own ? 'only you see' : 'only its owner sees'} its beliefs. This applies once it joins one.`
    : link.linked === 'all' ? 'Its swarm sees every belief it holds, for as long as it holds it.'
      : link.linked === 'none' ? `${only} ${own ? 'see' : 'sees'} its beliefs. Its swarm sees none of them.`
        : `Its swarm sees its beliefs about ${listed(link.linked)}, and none of the others.`
  return {
    data: {
      'link.value': choice,
      'link.words.default': link.default === 'all' ? 'Default: every belief' : `Default: ${only.toLowerCase()}`,
      'link.words.none': only,
      'link.now': now,
      'link.why': whyOf(link, own),
      'link.subjects': subjects,
      'link.linked': linkedSubjects,
      'link.error': page.error ?? '',
    },
    facts: {
      flags,
      values: { 'link.choice': choice },
      counts: { 'link.subjects': subjects.length, 'link.linked': linkedSubjects.length },
    },
  }
}

/**
 * What a press asks of the hive: the domains to PUT, or `pick` when Some subjects is chosen with nothing linked by
 * subject yet (the ticks show, nothing is written), or null when it changes nothing. Unticking the last subject links
 * none ([]), which the chooser then shows as only its owner. An admin's Link none (`link-none`) is the chooser's none.
 */
export function linkPress(link: BeliefLink, action: string, value: unknown, checked?: boolean): { domains: BeliefLinkDomains } | 'pick' | null {
  const current = Array.isArray(link.domains) ? link.domains : []
  if (action === 'link-none') return linkPress(link, 'set-link', 'none')
  if (action === 'set-link') {
    if (value === 'default') return link.domains === null ? null : { domains: null }
    if (value === 'all') return link.domains === 'all' ? null : { domains: 'all' }
    if (value === 'none') return Array.isArray(link.domains) && !link.domains.length ? null : { domains: [] }
    if (value === 'some') return current.length ? null : 'pick'
    return null
  }
  if (action === 'pick-subject' && typeof value === 'string' && value) {
    const next = checked ? [...new Set([...current, value])].sort() : current.filter((d) => d !== value)
    return next.length === current.length && next.every((d, i) => d === current[i]) ? null : { domains: next }
  }
  return null
}
