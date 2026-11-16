import { ApiError } from '../client'
import type { Agent, HiveEvent } from '../types'

/**
 * SIM ONLY: hive power, matching the live host (cf8bd9c, power 7973ca4; shape-equivalent to 293fe18).
 * Invented data only.
 *  - One snapshot is pending at a time. Off and plain Stop all record the minds meant to be awake into it (a later
 *    Off or Stop all ADDS to it, never replaces it); Stop all then Off turns the hive off.
 *  - GET: {state, since, by} to anyone signed in; an admin also gets minds_in_snapshot (0 when none). On: since/by are
 *    the latest restore's restored_at/restored_by.
 *  - POST off -> {state: 'off', since, stopped: n, failed: [{id, error}]} (a failed mind is still running).
 *  - POST on (also Wake all) -> {state: 'on', since, woken: [id], skipped: [{id, reason}], failed: [{id, error}]}:
 *    the pending snapshot's minds that still exist, are not in an archived swarm and are stopped or asleep; reasons
 *    'deleted', 'swarm archived', 'moved' or the mind's current status. No pending snapshot: nothing wakes. The
 *    snapshot is then marked restored.
 *  - Admin only (member 403). Idempotent on operation_id (<= 128 chars) for a finished run; a run cut short is redone
 *    by a replay (fixture cutShortNext); the same id with the other state is 409.
 *  - hive.power {state, since} to everyone after each off or on (never on a replay).
 */
export interface SimPowerHost {
  agents(): Agent[]
  agent(id: string): Agent | undefined
  archived(a: Agent): boolean
  moved(a: Agent): boolean
  stop(a: Agent): void
  wake(a: Agent): void
  emit(e: HiveEvent): void
  now(): string
}

interface Snapshot {
  created_at: string
  by: string
  minds: string[]
  state: 'off' | 'stopped' | 'restored'
  restored_at: string | null
  restored_by: string | null
}

export class SimPower {
  private snapshots: Snapshot[] = []
  private answers = new Map<string, { state: 'on' | 'off'; result: unknown }>()
  /** SIM ONLY fixtures: minds that refuse to stop (Off) or to start (On). */
  readonly failStop = new Set<string>()
  readonly failWake = new Set<string>()
  /** SIM ONLY fixture: how many of the next runs are cut short (the work is done, the answer is lost and nothing is
   *  stored), as on the live host (cf8bd9c): a replay of that id redoes the run, so its counts may differ. */
  cutShortNext = 0
  private host: SimPowerHost
  constructor(host: SimPowerHost) {
    this.host = host
  }

  private pending(): Snapshot | undefined {
    return [...this.snapshots].reverse().find((s) => !s.restored_at)
  }
  private latest(): Snapshot | undefined {
    return [...this.snapshots].sort((a, b) => (a.restored_at ?? a.created_at).localeCompare(b.restored_at ?? b.created_at)).at(-1)
  }

  view(admin: boolean) {
    const latest = this.latest()
    let out: Record<string, unknown>
    if (latest?.state === 'off') out = { state: 'off', since: latest.created_at, by: latest.by }
    else {
      const on = this.snapshots.filter((s) => s.restored_at).sort((a, b) => a.restored_at!.localeCompare(b.restored_at!)).at(-1)
      out = { state: 'on', since: on?.restored_at ?? null, by: on?.restored_by ?? null }
    }
    if (admin) out.minds_in_snapshot = this.pending()?.minds.length ?? 0
    return out
  }

  get state(): 'on' | 'off' {
    return this.view(false).state as 'on' | 'off'
  }

  /** Stop all's and Off's record step: the minds meant to be awake, added to the pending snapshot. */
  record(minds: string[], by: string, state: 'off' | 'stopped') {
    const row = this.pending()
    if (!row) {
      if (minds.length || state === 'off') this.snapshots.push({ created_at: this.host.now(), by, minds: [...minds], state, restored_at: null, restored_by: null })
      return
    }
    row.minds = [...row.minds, ...minds.filter((m) => !row.minds.includes(m))]
    if (state === 'off' && row.state !== 'off') Object.assign(row, { state: 'off', created_at: this.host.now(), by })
  }

  /** Minds meant to be awake (the sim has no desired state: anything not stopped), outside archived swarms. */
  wakeable(): Agent[] {
    return this.host.agents().filter((a) => a.status !== 'stopped' && !this.host.archived(a))
  }

  set(body: { state?: unknown; operation_id?: unknown }, who: { admin: boolean; principal: string }): unknown {
    if (!who.admin) throw new ApiError(403, 'forbidden', 'Only an admin can turn the hive off or on.')
    if (body.state !== 'on' && body.state !== 'off') throw new ApiError(400, 'bad_request', 'state is off or on')
    const op = body.operation_id
    if (typeof op !== 'string' || !op.length || op.length > 128) throw new ApiError(400, 'bad_request', 'operation_id is required (at most 128 characters)')
    const done = this.answers.get(op)
    if (done) {
      if (done.state !== body.state) throw new ApiError(409, 'operation_conflict', `operation ${op} was a power ${done.state}`)
      return structuredClone(done.result)
    }
    // a run cut short (failure or restart): the work done so far stays done, nothing is stored, no event, no answer
    if (this.cutShortNext > 0) {
      this.cutShortNext--
      if (body.state === 'off') this.off(who.principal)
      else this.on(who.principal, true)
      throw new ApiError(0, 'network', 'The answer was lost on the way back (invented).')
    }
    const result = body.state === 'off' ? this.off(who.principal) : this.on(who.principal)
    this.answers.set(op, { state: body.state, result })
    this.host.emit({ type: 'hive.power', at: this.host.now(), state: result.state, since: result.since })
    return structuredClone(result)
  }

  private off(by: string) {
    const all = this.host.agents()
    this.record(this.wakeable().map((a) => a.id), by, 'off')
    let stopped = 0
    const failed: { id: string; error: string }[] = []
    for (const a of all) {
      if (this.failStop.has(a.id)) {
        failed.push({ id: a.id, error: 'supervisor did not confirm the stop within 10 s (invented)' })
        continue
      }
      if (a.status !== 'stopped') stopped++
      this.host.stop(a)
    }
    return { state: 'off' as const, since: this.view(false).since as string, stopped, failed }
  }

  /** `cut`: the run stops halfway (after waking the first half), before the snapshot is marked restored. */
  private on(by: string, cut = false) {
    const row = this.pending()
    const woken: string[] = []
    const skipped: { id: string; reason: string }[] = []
    const failed: { id: string; error: string }[] = []
    const minds = row?.minds ?? []
    for (const id of cut ? minds.slice(0, Math.ceil(minds.length / 2)) : minds) {
      const a = this.host.agent(id)
      if (!a) skipped.push({ id, reason: 'deleted' })
      else if (this.host.archived(a)) skipped.push({ id, reason: 'swarm archived' })
      else if (this.host.moved(a)) skipped.push({ id, reason: 'moved' })
      else if (a.status !== 'stopped' && a.status !== 'asleep') skipped.push({ id, reason: a.status })
      else if (this.failWake.has(id)) failed.push({ id, error: 'start failed: model endpoint unreachable (invented)' })
      else {
        this.host.wake(a)
        woken.push(id)
      }
    }
    const since = this.host.now()
    if (cut) return { state: 'on' as const, since, woken, skipped, failed }
    if (row) Object.assign(row, { state: 'restored', restored_at: since, restored_by: by })
    return { state: 'on' as const, since: row ? since : ((this.view(false).since as string | null) ?? null), woken, skipped, failed }
  }
}
