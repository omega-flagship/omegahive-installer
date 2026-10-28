import { ApiError } from '../client'
import { creationReference } from '../../lib/router'
import {
  DRAFT_IDLE_DAYS,
  DRAFT_KEEP_REVISIONS,
  DRAFT_KEY,
  DRAFT_MAX_BYTES,
  draftBytes,
  draftConflict,
  type AppDraft,
  type AppDraftPut,
  type AppDraftSaved,
  type AppDraftSourceRef,
} from '../appDrafts'

/** What the drafts need to know about the caller and the hive (the SimClient provides it). */
export interface SimDraftScope {
  /** The session's principal when it is a named person, else null (the operator session saves no drafts). */
  person(): string | null
  /** 'enabled', 'disabled' or 'unknown' for a program id. */
  program(id: string): Promise<'enabled' | 'disabled' | 'unknown'>
  swarmVisible(id: string): boolean
}

interface Revision {
  revision: number
  saved_at: string
  body: Record<string, unknown>
  source_ref: AppDraftSourceRef | null
}

/**
 * Studio slice 2, simulated faithfully to Platform's candidate draft routes (INVENTED DATA; nothing leaves the
 * browser): scope (person, program, swarm) from the session and the route, never the body; signed-in person only;
 * app enabled; swarm visible; expected revision or 409 draft_conflict with current_revision; 413 draft_too_large over
 * 256 KB; the last 20 revisions kept; 30 days idle expiry.
 */
export class SimDrafts {
  private store = new Map<string, Revision[]>()
  /** The highest revision ever issued per key: revisions are never reused after delete or expiry (platform next8). */
  private issued = new Map<string, number>()
  constructor(private scope: SimDraftScope, private now: () => number = () => Date.now()) {}

  private async enter(programId: string, swarmId: string, key?: string): Promise<string> {
    const who = this.scope.person()
    if (!who) throw new ApiError(403, 'person_required', 'drafts belong to a signed-in person')
    const state = await this.scope.program(programId)
    if (state === 'unknown') throw new ApiError(404, 'not_found', `no app ${programId}`)
    if (state === 'disabled') throw new ApiError(403, 'program_disabled', `${programId} is not enabled`)
    if (typeof swarmId !== 'string' || !this.scope.swarmVisible(swarmId)) throw new ApiError(404, 'not_found', 'no such swarm')
    if (key !== undefined && !DRAFT_KEY.test(key)) throw new ApiError(400, 'bad_request', 'a draft key is a lowercase slug of at most 80 characters')
    this.expire()
    return `${who}\u0000${programId}\u0000${swarmId}\u0000`
  }

  private expire() {
    const cutoff = this.now() - DRAFT_IDLE_DAYS * 86_400_000
    for (const [k, revs] of this.store) if (Date.parse(revs[revs.length - 1].saved_at) < cutoff) this.store.delete(k)
  }

  async put(programId: string, key: string, body: AppDraftPut): Promise<AppDraftSaved> {
    const scope = await this.enter(programId, body?.swarm_id, key)
    const exp = body.expected_revision
    if (exp !== null && !(Number.isSafeInteger(exp) && exp >= 1)) throw new ApiError(400, 'bad_request', 'expected_revision is null or a revision number')
    if (!body.body || typeof body.body !== 'object' || Array.isArray(body.body)) throw new ApiError(400, 'bad_request', 'body is a JSON object')
    let source: AppDraftSourceRef | null = null
    if (body.source_ref !== undefined) {
      source = creationReference(body.source_ref) ?? null
      if (!source) throw new ApiError(400, 'bad_request', 'source_ref is an exact artifact reference')
    }
    if (draftBytes(body.body) > DRAFT_MAX_BYTES) throw new ApiError(413, 'draft_too_large', 'a draft is at most 256 KB')
    const revs = this.store.get(scope + key) ?? []
    const current = revs.length ? revs[revs.length - 1].revision : null
    if (exp !== current) throw draftConflict(current === null ? 'that draft no longer exists' : `that draft is at revision ${current}`, current)
    const next = Math.max(current ?? 0, this.issued.get(scope + key) ?? 0) + 1
    this.issued.set(scope + key, next)
    const saved: Revision = { revision: next, saved_at: new Date(this.now()).toISOString(), body: structuredClone(body.body), source_ref: source }
    this.store.set(scope + key, [...revs, saved].slice(-DRAFT_KEEP_REVISIONS))
    return { draft_key: key, revision: saved.revision, saved_at: saved.saved_at }
  }

  async list(programId: string, swarmId: string): Promise<{ drafts: AppDraftSaved[] }> {
    const scope = await this.enter(programId, swarmId)
    const drafts = [...this.store].filter(([k]) => k.startsWith(scope)).map(([k, revs]) => {
      const last = revs[revs.length - 1]
      return { draft_key: k.slice(scope.length), revision: last.revision, saved_at: last.saved_at }
    })
    return { drafts: drafts.sort((a, b) => b.saved_at.localeCompare(a.saved_at)) }
  }

  async get(programId: string, key: string, swarmId: string): Promise<AppDraft> {
    const scope = await this.enter(programId, swarmId, key)
    const revs = this.store.get(scope + key)
    if (!revs) throw new ApiError(404, 'draft_not_found', 'no such draft')
    const last = revs[revs.length - 1]
    return { draft_key: key, revision: last.revision, saved_at: last.saved_at, body: structuredClone(last.body), source_ref: last.source_ref }
  }

  async remove(programId: string, key: string, swarmId: string): Promise<{ deleted: string }> {
    const scope = await this.enter(programId, swarmId, key)
    if (!this.store.delete(scope + key)) throw new ApiError(404, 'draft_not_found', 'no such draft')
    return { deleted: key }
  }

  /** Test aid: how many revisions are retained for a key (not a route). */
  retained(principal: string, programId: string, swarmId: string, key: string): number {
    return this.store.get(`${principal}\u0000${programId}\u0000${swarmId}\u0000${key}`)?.length ?? 0
  }
}
