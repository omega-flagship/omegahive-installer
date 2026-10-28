import type { AppActivityRow, ArtifactKind, HiveArtifact } from '../../api/moneyWork'
import type { CollabRequest } from '../../api/types'
import { creationReference } from '../../lib/router'

/** A swarm's flows (GET /api/swarms/{id}/flows): newest first, latest revision. */
export interface FlowRow {
  artifact_id: string
  title: string
  revision: number
}

/** The share fields the list reads (shares.view). */
export interface ShareRow {
  id: string
  owner_id: string
  grantee_id: string
  status: string
  created_at: string
  exhibit_id?: string | null
  exhibit?: { title: string; bytes: number; atoms: number }
  [extra: string]: unknown
}

const mindOf = (principal: string | null | undefined) => (principal && principal.startsWith('agent:') ? principal.slice(6) : null)

/**
 * The hive-level list, composed from what persons may already read: the artifact revisions sent for review
 * (requests), each swarm's flows, exhibits minds showed each other, and what apps finished. One row per thing;
 * an exhibit shown to several minds is one row.
 */
export function composeArtifacts(src: { requests?: CollabRequest[]; flows?: Record<string, FlowRow[]>; shares?: ShareRow[]; activity?: AppActivityRow[] }): HiveArtifact[] {
  const out: HiveArtifact[] = []
  for (const r of src.requests ?? []) {
    const ref = creationReference(r.subject)
    if (!ref) continue
    out.push({
      key: `review:${r.id}`,
      kind: 'review',
      title: r.title,
      swarm_id: r.from_swarm,
      mind_id: mindOf(r.from_principal),
      app: null,
      at: r.created_at,
      ref,
      artifact_id: ref.artifact_id,
      revision: ref.revision,
      state: r.state,
      to_swarm: r.to_swarm,
      detail: `For ${r.kind}`,
    })
  }
  for (const [swarm, rows] of Object.entries(src.flows ?? {})) {
    for (const f of rows) out.push({ key: `flow:${f.artifact_id}`, kind: 'flow', title: f.title, swarm_id: swarm, mind_id: null, app: null, at: '', artifact_id: f.artifact_id, revision: f.revision, detail: `Revision ${f.revision}` })
  }
  const seenExhibits = new Set<string>()
  for (const s of src.shares ?? []) {
    if (!s.exhibit_id || !s.exhibit || seenExhibits.has(s.exhibit_id)) continue
    seenExhibits.add(s.exhibit_id)
    out.push({
      key: `exhibit:${s.exhibit_id}`,
      kind: 'exhibit',
      title: s.exhibit.title,
      swarm_id: null,
      mind_id: s.owner_id,
      app: null,
      at: s.created_at,
      state: s.status,
      detail: `${s.exhibit.atoms} atoms · ${s.exhibit.bytes} bytes of text`,
    })
  }
  for (const a of src.activity ?? []) {
    if (a.status !== 'done') continue
    out.push({ key: `app:${a.id}`, kind: 'app-result', title: a.action, swarm_id: a.swarm_id, mind_id: mindOf(a.principal), app: a.program, at: a.finished_at ?? a.created_at, state: a.status, detail: a.items.length ? `${a.items.length} item${a.items.length === 1 ? '' : 's'}` : undefined })
  }
  return out.sort((x, y) => (y.at || '').localeCompare(x.at || ''))
}

export interface ArtifactFilter {
  kind: ArtifactKind | 'all'
  swarm: string
  mind: string
  app: string
  q: string
}

export const NO_FILTER: ArtifactFilter = { kind: 'all', swarm: '', mind: '', app: '', q: '' }

/** `swarmOfMind` fills in the swarm of a row that only names its mind (exhibits). */
export function filterArtifacts(items: HiveArtifact[], f: ArtifactFilter, swarmOfMind: (id: string) => string | null = () => null): HiveArtifact[] {
  const q = f.q.trim().toLowerCase()
  return items.filter((a) => {
    if (f.kind !== 'all' && a.kind !== f.kind) return false
    if (f.swarm && (a.swarm_id ?? (a.mind_id ? swarmOfMind(a.mind_id) : null)) !== f.swarm) return false
    if (f.mind && a.mind_id !== f.mind) return false
    if (f.app && a.app !== f.app) return false
    if (q && !`${a.title} ${a.detail ?? ''} ${a.artifact_id ?? ''}`.toLowerCase().includes(q)) return false
    return true
  })
}

export const KIND_LABEL: Record<ArtifactKind, string> = { review: 'Sent for review', flow: 'Flow', exhibit: 'Exhibit', 'app-result': 'App result' }
