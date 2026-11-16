/**
 * SIM ONLY: the demo person's personal mind (Platform P1 shapes; versions as P3/P4 are drafted). Everything here is
 * INVENTED for demo mode: the person is the sim's Ada Brightwater, her mind is "Ada", and the conversations are made
 * up. No real person, no network.
 *
 * Fixture switches (SimOptions.personalMind, from ?mind= and ?mindversions=):
 * - mind: 'on' (default demo), 'null' ({mind: null}), 'absent' (404, a host without P1), 'person' (403 person_required)
 * - versions: false (default: 404, as every host until P3/P4) or true (an invented current and benchmark best)
 */
import { ApiError } from '../client'

export interface SimMindOptions {
  mind?: 'on' | 'null' | 'absent' | 'person'
  versions?: boolean
  /** copies the invented hive let go uncollected (?mindlost=1: 2 expired) */
  lost?: boolean
}

interface Version {
  id: string
  label: string
  score: { success: number; steps: number; cost_usd: number }
  measured_at: string
  suite_run_id: string
}

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

/** The invented versions: the one Ada's mind runs, and the benchmark's best waiting to be adopted. */
const VERSIONS: Version[] = [
  { id: 'mv_linnet6', label: 'v6 Linnet', score: { success: 0.81, steps: 8.2, cost_usd: 0.046 }, measured_at: '2026-09-02T10:00:00Z', suite_run_id: 'lr_4120' },
  { id: 'mv_wren7', label: 'v7 Wren', score: { success: 0.86, steps: 7.4, cost_usd: 0.041 }, measured_at: '2026-09-12T10:00:00Z', suite_run_id: 'lr_4301' },
  { id: 'mv_kestrel9', label: 'v9 Kestrel', score: { success: 0.93, steps: 5.9, cost_usd: 0.036 }, measured_at: '2026-10-06T10:00:00Z', suite_run_id: 'lr_4412' },
]

/** Invented swarm conversations the hive holds for Ada until her browser collects them. */
function seedInbox(now: number) {
  return [
    { id: 'pi_sim_frost01', turn_id: 'turn_sim_frost', created_at: iso(now - 2 * DAY), words: 'When is the first frost due at the garden?', answer: 'Around 24 October on the usual dates; the Garden swarm will cover the seedlings the week before.', truncated: false },
    { id: 'pi_sim_ledger2', turn_id: 'turn_sim_ledger', created_at: iso(now - DAY), words: 'Reconcile the March invoices for the bakery.', answer: 'Done: 42 invoices matched, two flagged for a second look (a duplicate flour order and a missing receipt).', truncated: false },
    { id: 'pi_sim_books03', turn_id: 'turn_sim_books', created_at: iso(now - 4 * 3_600_000), words: 'Pick October’s book for the reading circle.', answer: 'The circle chose “The Lantern Orchard”; copies are on hold at the branch library.', truncated: false },
  ]
}

export class SimPersonalMind {
  private opts: Required<SimMindOptions>
  private name = 'Ada'
  private current = 'mv_wren7'
  private previous: string | null = 'mv_linnet6'
  private adoptedAt: string
  private inbox: ReturnType<typeof seedInbox>

  constructor(opts: SimMindOptions = {}, now = Date.now()) {
    this.opts = { mind: opts.mind ?? 'on', versions: opts.versions ?? false, lost: opts.lost ?? false }
    this.inbox = seedInbox(now)
    this.adoptedAt = iso(now - 27 * DAY)
  }

  private gate(): void {
    if (this.opts.mind === 'absent') throw new ApiError(404, 'not_found', 'Not Found')
    if (this.opts.mind === 'person') throw new ApiError(403, 'person_required', 'A personal mind needs a signed-in person with an account here.')
  }
  private version(id: string | null) {
    const v = VERSIONS.find((x) => x.id === id)
    return v ? { ...v, score: { ...v.score } } : null
  }
  private view() {
    return {
      id: 'a_ada_own',
      name: this.name,
      swarm_id: 's_ada_own',
      status: 'asleep',
      budget_usd: 0,
      allowance_usd: 20,
      allowance_origin: 'person',
      // P1 leaves the version null until P3/P4; with the versions fixture it is the invented current one
      version: this.opts.versions ? this.version(this.current) : null,
      adopted_at: this.opts.versions ? this.adoptedAt : null,
      previous_version_id: this.opts.versions ? this.previous : null,
      created_at: '2026-08-28T09:00:00Z',
    }
  }

  get(): { mind: ReturnType<SimPersonalMind['view']> | null } {
    this.gate()
    return { mind: this.opts.mind === 'null' ? null : this.view() }
  }
  rename(name: unknown) {
    this.gate()
    if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'invalid', 'That isn’t in a shape the hive understands.')
    this.name = name.trim().slice(0, 80)
    if (this.opts.mind === 'null') this.opts.mind = 'on'
    return { mind: this.view(), created: false }
  }
  items(after: string | null, limit: number) {
    this.gate()
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 50))
    const from = after ? this.inbox.findIndex((x) => x.id === after) + 1 : 0
    const page = this.inbox.slice(from, from + n + 1)
    const more = page.length > n
    const out = page.slice(0, n).map((x) => ({ ...x }))
    return { items: out, next: more && out.length ? out[out.length - 1].id : null, dropped: 0, expired: this.opts.lost ? 2 : 0 }
  }
  ack(ids: unknown) {
    this.gate()
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((i) => typeof i === 'string' && i.length > 0 && i.length <= 64)) throw new ApiError(400, 'invalid', 'That isn’t in a shape the hive understands.')
    const before = this.inbox.length
    this.inbox = this.inbox.filter((x) => !ids.includes(x.id))
    return { deleted: before - this.inbox.length }
  }
  /** SIM ONLY: one more conversation held for Ada (tests; a demo step). */
  hold(item: { id: string; words: string; answer: string }, now = Date.now()) {
    this.inbox.push({ id: item.id, turn_id: `turn_${item.id}`, created_at: iso(now), words: item.words, answer: item.answer, truncated: false })
  }
  versions() {
    this.gate()
    if (!this.opts.versions) throw new ApiError(404, 'not_found', 'Not Found')
    return { current: this.version(this.current), best: this.version('mv_kestrel9'), candidates: VERSIONS.map((v) => ({ ...v, score: { ...v.score } })) }
  }
  adopt(versionId: unknown) {
    this.gate()
    if (!this.opts.versions) throw new ApiError(404, 'not_found', 'Not Found')
    if (!VERSIONS.some((v) => v.id === versionId)) throw new ApiError(404, 'unknown_version', 'That version is not one this hive knows.')
    if (versionId === this.current) throw new ApiError(409, 'already_current', 'Your mind already runs that version.')
    this.previous = this.current
    this.current = versionId as string
    this.adoptedAt = iso(Date.now())
    return { mind: this.view() }
  }
  rollback() {
    this.gate()
    if (!this.opts.versions) throw new ApiError(404, 'not_found', 'Not Found')
    if (!this.previous) throw new ApiError(409, 'nothing_to_roll_back', 'There is no earlier version to go back to.')
    this.current = this.previous
    this.previous = null
    this.adoptedAt = iso(Date.now())
    return { mind: this.view() }
  }
}
