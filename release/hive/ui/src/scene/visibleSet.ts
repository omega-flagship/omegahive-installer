import type { Agent, Swarm } from '../api/types'
import { PRIVATE_APPS } from '../features/ask/view'
import { CLOUD_HIVE, personHive } from './rings'

/**
 * The one visibility helper (PLAN_HIVE_VIEW_SCALING r2 §4): what this viewer is shown, fixed BEFORE any grouping,
 * sizing, counting, linking or Ask context. The hive map, the Ask's context and the Still / Professional swarm lists
 * all take their swarms and minds from here, so nothing hidden leaves a trace in any of them.
 *
 * The host already scopes what reaches the browser (GET /api/swarms and agents pass hive.visibility). On top of that,
 * failing closed:
 * - archived swarms are not shown (lists may keep them, marked);
 * - personal-mind swarms (the host's `personal_of`) are never a planet; another person's personal mind or swarm is
 *   never shown at all, even if a host lists it by mistake (P8); the viewer's own mind is drawn alone, as "You";
 * - a private app's home (Atlas, Truth: features/ask/view isPrivateApp; an unreadable app id counts as private), and a
 *   swarm private to someone else that the viewer sees only through admin sight, become an AUTHORISED PLACEHOLDER:
 *   counted, never named, sized, placed, linked or attributed (P-2). In visitor or demo mode they are not shown at all;
 * - minds in a swarm that is not shown are not shown.
 * Then the shown swarms are grouped into hives: a swarm owned by a named person is in that person's hive, everything
 * else in the cloud hive.
 */

export interface Viewer {
  /** the signed-in principal (`user:…`), or null while unknown */
  principal: string | null
  /** an admin session (the hive password or a person with the admin role) */
  admin: boolean
  /** visitor or demo mode: names off, no placeholders */
  visitor: boolean
  /** the viewer's own personal mind (GET /api/me/mind), drawn as "You" */
  ownMind?: { id: string; swarm_id?: string | null } | null
  /** swarm ids the hive says are a private app's homes (programHomes for private apps) */
  privateHomes?: ReadonlySet<string>
  /**
   * Whether those homes are known (scene/privateHomes). Absent counts as 'pending': fail closed. Until 'resolved', any
   * swarm not already known to be the viewer's own personal one could be a private app's home: 'pending' shows none of
   * them; 'failed' shows them only as unattributed placeholders (none in visitor mode).
   */
  homesState?: 'pending' | 'failed' | 'resolved'
}

export const NO_VIEWER: Viewer = { principal: null, admin: false, visitor: false, ownMind: null, privateHomes: new Set(), homesState: 'pending' }

export interface VisibleSet {
  swarms: Swarm[]
  agents: Agent[]
  /** how many authorised placeholders to draw (never which objects they stand for) */
  placeholders: number
  /** shown swarm id → hive id */
  hiveOf: Record<string, string>
  /** the viewer's own hive id (a named person's), or null */
  ownHive: string | null
  /** where minds without a shown swarm gather: the viewer's own hive when they are only the viewer's own mind */
  wanderHive: string | null
  /** shown minds without a shown swarm */
  wanderers: number
}

/** Principals that are not a named person's: the hive's operator session. Their swarms are the cloud hive's. */
const isNamedPerson = (p: string | null | undefined): p is string => !!p && p.startsWith('user:') && p !== 'user:operator'

/** The hive a shown swarm belongs to: its owner's, when the owner is a named person; otherwise the cloud hive. */
export const hiveFor = (s: Pick<Swarm, 'owner'>): string => (isNamedPerson(s.owner) ? personHive(s.owner) : CLOUD_HIVE)

/** A swarm named exactly like a private app (Atlas, Truth): a home in all but the record, so private (fail closed). */
const namedLikePrivateApp = (name: string) => PRIVATE_APPS.has((name ?? '').normalize('NFKC').trim().toLowerCase())

type SwarmClass = 'shown' | 'placeholder' | 'hidden'

function classify(s: Swarm, v: Viewer, opts: { map: boolean; keepArchived: boolean }): SwarmClass {
  if (s.archived_at && !opts.keepArchived) return 'hidden'
  const mine = !!v.principal && s.personal_of === v.principal
  if (s.personal_of && !mine) return 'hidden'
  if (opts.map && (s.personal_of || (!!v.ownMind?.swarm_id && s.id === v.ownMind.swarm_id))) return 'hidden'
  // the viewer's own personal swarm (lists only; never a planet) is theirs, not an app's home
  if (mine) return 'shown'
  // private-app homes not known yet: nothing that could be one is named (stand-in hive-scale r1 P1-1)
  const homes = v.homesState ?? 'pending'
  if (homes === 'pending') return 'hidden'
  if (homes === 'failed') return v.visitor ? 'hidden' : 'placeholder'
  const privateHome = !!v.privateHomes?.has(s.id) || namedLikePrivateApp(s.name)
  const othersPrivate = s.visibility === 'private' && !!s.owner && s.owner !== v.principal && !(v.principal && s.shared_with?.includes(v.principal))
  if (privateHome || othersPrivate) return v.visitor ? 'hidden' : 'placeholder'
  return 'shown'
}

/**
 * The shown set. `map` (the hive map): no personal swarm is a planet and the viewer's own mind is "You" with no swarm.
 * Lists (`map: false`) keep the viewer's own personal swarm and, with `keepArchived`, archived swarms.
 */
export function visibleSet(swarms: Swarm[], agents: Agent[], viewer: Viewer = NO_VIEWER, opts: { map?: boolean; keepArchived?: boolean } = {}): VisibleSet {
  const o = { map: opts.map ?? true, keepArchived: opts.keepArchived ?? false }
  const cls = new Map<string, SwarmClass>()
  for (const s of swarms) cls.set(s.id, classify(s, viewer, o))
  const shown = swarms.filter((s) => cls.get(s.id) === 'shown')
  const placeholders = swarms.filter((s) => cls.get(s.id) === 'placeholder').length
  const shownIds = new Set(shown.map((s) => s.id))
  const own = viewer.ownMind
  const out: Agent[] = []
  for (const a of agents) {
    if (own && a.id === own.id) {
      out.push(o.map ? { ...a, name: 'You', swarm_id: null } : a)
      continue
    }
    if (a.personal_of && a.personal_of !== viewer.principal) continue
    if (o.map && a.personal_of) continue
    // a mind in a swarm that is not shown is not shown (placeholders carry no members; hidden swarms leave no trace)
    if (a.swarm_id && cls.has(a.swarm_id) && !shownIds.has(a.swarm_id)) continue
    // a mind private to someone else, outside any shown swarm: nothing of it on the map
    if (o.map && !a.swarm_id && a.visibility === 'private' && a.owner && a.owner !== viewer.principal) continue
    out.push(a)
  }
  // a shown swarm's member count leaves out every mind this viewer is not shown (a hidden mind changes no count)
  const outIds = new Set(out.map((a) => a.id))
  const hiddenMinds = new Set(agents.filter((a) => !outIds.has(a.id)).map((a) => a.id))
  if (hiddenMinds.size) for (let i = 0; i < shown.length; i++) if (shown[i].member_ids.some((id) => hiddenMinds.has(id))) shown[i] = { ...shown[i], member_ids: shown[i].member_ids.filter((id) => !hiddenMinds.has(id)) }
  const hiveOf: Record<string, string> = {}
  for (const s of shown) hiveOf[s.id] = hiveFor(s)
  const ownHive = isNamedPerson(viewer.principal) ? personHive(viewer.principal) : null
  const wander = out.filter((a) => !a.swarm_id || !shownIds.has(a.swarm_id))
  const onlyOwn = wander.length > 0 && !!own && wander.every((a) => a.id === own.id)
  const wanderHive = wander.length ? (onlyOwn && ownHive ? ownHive : CLOUD_HIVE) : null
  return { swarms: shown, agents: out, placeholders, hiveOf, ownHive, wanderHive, wanderers: wander.length }
}

/** The order lists group swarms in: the viewer's own hive, then the cloud hive, then other people's (by hive id). */
export function byHive(set: Pick<VisibleSet, 'hiveOf' | 'ownHive'>, nameOf: (s: Swarm) => string): (a: Swarm, b: Swarm) => number {
  const rank = (s: Swarm) => {
    const h = set.hiveOf[s.id] ?? hiveFor(s)
    return h === set.ownHive ? 0 : h === CLOUD_HIVE ? 1 : 2
  }
  return (a, b) => rank(a) - rank(b) || (rank(a) === 2 ? (set.hiveOf[a.id] ?? '').localeCompare(set.hiveOf[b.id] ?? '') : 0) || nameOf(a).localeCompare(nameOf(b))
}
