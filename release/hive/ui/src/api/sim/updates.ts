import { ApiError } from '../client'
import type { PlaceHoldBody, UpdateHistoryRow, UpdateHold, UpdatesOverview } from '../types'
import type { UpdateRequestBody, UpdateRequestRecord } from '../missingUi'
import { checkHoldBody } from '../../features/updates/updates'

/**
 * INVENTED updates for the sim (R18: hive/core/updates.py at 0aa6330), so the Updates page and its holds can be seen
 * and checked: one platform build waiting, two apps, one active hold. Nothing restarts or reloads; every id is made up.
 */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

export class SimUpdates {
  private seq = 0
  private holds: UpdateHold[] = [
    { id: 'hold_sim1', scope: 'program:contract-fixture', reason: 'A contract review is mid-run; reload after it finishes.', held_by: 'user:operator', created_at: ago(40 * MIN), until: new Date(Date.now() + 3 * HOUR).toISOString(), released_at: null, released_by: null },
  ]
  private history: UpdateHistoryRow[] = [
    { id: 'uh_sim1', target: 'program:commons-explorer', by: 'user:operator', at: ago(26 * HOUR), before: { version: '0.3.0' }, after: { version: '0.3.1' }, ok: true, error: null, overrode: [] },
  ]
  /** updates.py requests: the latest pending one per target shows as that target's `request` (INVENTED seed) */
  private requests: UpdateRequestRecord[] = [
    { id: 'up_sim1', target: 'program:commons-explorer', note: 'Invented owner note: fixes the pin overlay.', receipts: [], requested_by: 'user:operator', created_at: ago(3 * HOUR), status: 'pending', closed_at: null, closed_by: null },
  ]
  private pending(target: string) {
    const r = this.requests.filter((x) => x.target === target && x.status === 'pending').sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    return r ? { id: r.id, target: r.target, note: r.note, receipts: [...r.receipts], requested_by: r.requested_by, created_at: r.created_at } : null
  }
  private platformWaiting = true
  private appsWaiting: Record<string, boolean> = { 'commons-explorer': true, 'contract-fixture': true }

  constructor(
    private readonly delay: <T>(fn: () => T) => Promise<T>,
    private readonly who: () => string,
    private readonly appIds: () => Promise<{ id: string; name: string }[]>,
  ) {}

  private active(): UpdateHold[] {
    const now = new Date().toISOString()
    return this.holds.filter((h) => !h.released_at && (!h.until || h.until > now))
  }

  async overview(): Promise<UpdatesOverview> {
    const apps = (await this.appIds()).filter((a) => a.id in this.appsWaiting)
    return this.delay(() => ({
      platform: {
        target: 'platform',
        running_build: '9c41d07e3b2a',
        source_build: '5ab3e210ffc1',
        started_at: ago(2 * 24 * HOUR),
        update_available: this.platformWaiting,
        commits_waiting: this.platformWaiting ? [{ commit: '5ab3e21', subject: 'Invented: tidy the gateway retry log' }, { commit: '77c09d4', subject: 'Invented: faster belief table paging' }] : [],
        supervised: true,
        request: this.pending('platform'),
      },
      apps: apps.map((a) => ({
        target: `program:${a.id}`, id: a.id, name: a.name, loaded_version: '0.3.1', disk_version: this.appsWaiting[a.id] ? '0.3.2' : '0.3.1',
        loaded_digest: null, disk_digest: null, load_error: null, update_available: this.appsWaiting[a.id], removed_on_disk: false,
        request: this.pending(`program:${a.id}`),
      })),
      holds: this.active().map((h) => ({ ...h })),
      history: this.history.map((h) => ({ ...h })),
    }))
  }

  /** POST /api/updates/requests (updates.py request; the admin check is the client's). */
  async request(body: UpdateRequestBody): Promise<UpdateRequestRecord> {
    const ids = (await this.appIds()).map((a) => a.id)
    return this.delay((): UpdateRequestRecord => {
      const t = typeof body?.target === 'string' ? body.target : ''
      if (t !== 'platform' && !(t.startsWith('program:') && ids.includes(t.slice(8)))) throw new ApiError(400, 'bad_target', "target is 'platform' or 'program:<app id>' of an app this hive has")
      const r: UpdateRequestRecord = {
        id: `up_sim${++this.seq + 1}`, target: t, note: String(body.note ?? '').trim().slice(0, 2000),
        receipts: (Array.isArray(body.receipts) ? body.receipts : []).slice(0, 20).map((x) => String(x).slice(0, 300)),
        requested_by: this.who(), created_at: new Date().toISOString(), status: 'pending', closed_at: null, closed_by: null,
      }
      this.requests.push(r)
      return { ...r, receipts: [...r.receipts] }
    })
  }

  placeHold(body: PlaceHoldBody) {
    return this.delay((): UpdateHold => {
      const why = checkHoldBody(body)
      if (why) throw new ApiError(400, 'bad_request', why)
      const h: UpdateHold = { id: `hold_sim${++this.seq + 1}`, scope: body.scope, reason: body.reason.trim().slice(0, 500), held_by: this.who(), created_at: new Date().toISOString(), until: body.until ?? null, released_at: null, released_by: null }
      this.holds.push(h)
      return { ...h }
    })
  }

  releaseHold(id: string) {
    return this.delay(() => {
      const h = this.holds.find((x) => x.id === id)
      if (!h || h.released_at) throw new ApiError(404, 'not_found', 'no such active hold')
      h.released_at = new Date().toISOString()
      h.released_by = this.who()
      return { id, released_by: h.released_by }
    })
  }

  applyUpdate(body: { target: string; override?: boolean; confirm?: string }) {
    return this.delay(() => {
      const scope = body.target === 'platform' ? 'restart' : body.target
      const blocking = this.active().filter((h) => h.scope === 'all' || h.scope === scope)
      if (blocking.length && !(body.override && body.confirm === body.target)) throw new ApiError(409, 'on_hold', `on hold: ${blocking.map((h) => h.reason).join('; ')}`)
      this.history.unshift({ id: `uh_sim${++this.seq + 1}`, target: body.target, by: this.who(), at: new Date().toISOString(), before: {}, after: {}, ok: true, error: null, overrode: blocking.map((h) => h.id) })
      for (const r of this.requests) if (r.target === body.target && r.status === 'pending') Object.assign(r, { status: 'applied', closed_at: new Date().toISOString(), closed_by: this.who() })
      if (body.target === 'platform') this.platformWaiting = false
      else this.appsWaiting[body.target.slice(8)] = false
      // the sim never restarts anything
      return { target: body.target, ok: true, restarting: false }
    })
  }
}
