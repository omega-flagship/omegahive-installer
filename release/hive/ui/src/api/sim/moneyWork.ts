import { ApiError } from '../client'
import { simImage } from './studioImages'
import type {
  AppActivation,
  AppActivityRow,
  AppAttachment,
  AppOffer,
  ArtifactList,
  Asset,
  AssetStore,
  AttachBody,
  CostOverrun,
  CostReservation,
  RegisteredService,
  ResolveBody,
  ResolvedReservation,
  SwarmArtifact,
  SwarmServices,
  UploadAssetOptions,
} from '../moneyWork'
import { composeArtifacts, type FlowRow, type ShareRow } from '../../features/artifacts/artifacts'
import type { CollabRequest } from '../types'

/**
 * Invented, realistic data for the money, work and apps surfaces, so each one is visible in the demo.
 * Nothing here talks to a provider, a store or a hive; every id and digest is made up.
 */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const hex = (seed: string) => {
  let h = 2166136261
  let out = ''
  for (let i = 0; out.length < 64; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

/** The swarm a seeded mind belongs to (data.ts SEED_AGENTS). */
const SWARM_OF: Record<string, string> = { a_vega01: 's_lyra', a_deneb2: 's_lyra', a_altr03: 's_lyra', a_mira04: 's_lyra', a_coral5: 's_kelp', a_nori06: 's_kelp', a_sedg07: 's_kelp', a_anvl09: 's_forge', a_bell10: 's_forge', a_qnch11: 's_forge' }

const OFFERS: Record<string, AppOffer> = {
  'commons-explorer': { actions_offered: ['annotate', 'pin-belief'], channels_offered: ['commons'] },
  'contract-fixture': { actions_offered: ['mark-reviewed', 'raise-question'], channels_offered: ['review', 'notes'] },
}

/** As cost_reservations.py: a dispatched or reserved call counts as long-stuck after STALE_SECONDS; an unknown one is
 *  settled by the hive at its held worst case UNKNOWN_EXPIRY_SECONDS after it became unknown. */
const STALE_SECONDS = 900
const UNKNOWN_EXPIRY_SECONDS = 24 * 3600
const secAgo = (ms: number) => (Date.now() - ms) / 1000

export class SimMoneyWork {
  /** The sim plays the coming Platform fields (dispatched_at, unknown_at, resolvable, auto_settles_at) unless told not to,
   *  so the panel can be checked both ways; live 0aa6330 sends none of them. */
  timingFields = true
  private reservations: (CostReservation & { done?: ResolvedReservation })[] = [
    {
      id: 'chat:a_deneb2:1c7f9e2a',
      state: 'unknown',
      held_usd: 0.4875,
      scopes: ['agent:a_deneb2:total', 'swarm:s_lyra:month', 'key:k_sim2:month'],
      metadata: { agent: 'a_deneb2', model: 'anthropic/claude-opus-5-5', payer: 'swarm:s_lyra', key: 'k_sim2', kind: 'chat', payload_hash: hex('deneb-call') },
      observation: { response_id: 'msg_01Sim7Qx4dRk2', resolved_model: 'claude-opus-5-5', usage_origin: 'missing: the stream ended before usage' },
      dispatched_at: secAgo(5 * HOUR + 2 * MIN),
      unknown_at: secAgo(5 * HOUR),
    },
    {
      id: 'chat:a_coral5:8b20d4c1',
      state: 'unknown',
      held_usd: 0.0912,
      scopes: ['agent:a_coral5:total', 'swarm:s_kelp:month'],
      metadata: { agent: 'a_coral5', model: 'anthropic/claude-sonnet-5-5', payer: 'swarm:s_kelp', kind: 'chat', payload_hash: hex('coral-call') },
      observation: null,
      dispatched_at: secAgo(21 * HOUR + 5 * MIN),
      unknown_at: secAgo(21 * HOUR),
    },
    {
      id: 'chat:a_bell10:5d91e0c3',
      state: 'dispatched',
      held_usd: 0.0384,
      scopes: ['agent:a_bell10:total', 'swarm:s_forge:month'],
      metadata: { agent: 'a_bell10', model: 'anthropic/claude-haiku-5', kind: 'chat', payload_hash: hex('bell-call') },
      observation: null,
      dispatched_at: secAgo(42 * MIN),
      unknown_at: null,
    },
    {
      id: 'embed:a_anvl09:f03a6b77',
      state: 'dispatched',
      held_usd: 0.0021,
      scopes: ['agent:a_anvl09:total', 'swarm:s_forge:month'],
      metadata: { agent: 'a_anvl09', model: 'openai/text-embedding-4-small', kind: 'embedding', payload_hash: hex('anvil-embed') },
      observation: null,
      dispatched_at: secAgo(40_000),
      unknown_at: null,
    },
  ]
  private overruns: CostOverrun[] = [
    { reservation: 'chat:a_vega01:44e1aa90', agent: 'a_vega01', maximum: 120_000, actual: 163_400, source: 'settle', at: (Date.now() - 26 * HOUR) / 1000 },
  ]

  private stores: AssetStore[] = [
    { name: 'local', kind: 'local' },
    { name: 'cloud', kind: 's3' },
  ]
  private assets: Asset[] = [
    this.asset('lyra-sky-survey-0412.png', 'image/png', 2_418_112, 's_lyra', 'agent:a_vega01', 3 * HOUR, ['local', 'cloud'], false, [{ event: 'copied', to: 'cloud', at: ago(2 * HOUR), by: 'user:p_ada' }]),
    this.asset('lyra-mark-wordmark.svg', 'image/svg+xml', 6_310, 's_lyra', 'agent:a_deneb2', 26 * HOUR, ['local'], false),
    this.asset('lyra-nebula-backdrop-2400.jpg', 'image/jpeg', 1_204_877, 's_lyra', 'agent:a_mira04', 4 * 24 * HOUR, ['local'], false),
    this.asset('kelp-tide-model.pdf', 'application/pdf', 846_330, 's_kelp', 'agent:a_coral5', 20 * HOUR, ['local'], false),
    this.asset('forge-review-notes.md', 'text/markdown', 12_904, 's_forge', 'agent:a_anvl09', 2 * 24 * HOUR, ['local'], true),
    // INVENTED: a this-machine-only file whose cloud copy could not be removed yet (assets.py pending removal)
    { ...this.asset('consent-scan-redacted.pdf', 'application/pdf', 402_118, 's_forge', 'user:p_ada', 30 * HOUR, ['cloud', 'local'], true, [{ event: 'local_only', at: ago(29 * HOUR), by: 'user:p_ada' }, { event: 'local_only_cleanup', at: ago(29 * HOUR), by: 'user:p_ada', removed: [] }]), pending_removal: ['cloud'] },
    this.asset('design-original-board-v3.fig', 'application/octet-stream', 18_302_211, 's_forge', 'user:p_ada', 5 * 24 * HOUR, ['cloud'], false, [{ event: 'moved', to: 'cloud', removed: ['local'], at: ago(4 * 24 * HOUR), by: 'user:p_ada' }]),
  ]

  private services: Record<string, SwarmServices> = {
    s_forge: { swarm_id: 's_forge', kinds: ['code-review'], connection_only_kinds: ['security-review'] },
    s_lyra: { swarm_id: 's_lyra', kinds: [], connection_only_kinds: [] },
    s_kelp: { swarm_id: 's_kelp', kinds: ['plan'], connection_only_kinds: [] },
  }
  private registered: RegisteredService[] = [
    { id: 'svc_omegacode', name: 'omegacode', version: '0.9.4', address: 'http://127.0.0.1:8711', contract: 'omegacode/1', surfaces: ['code.workspaces', 'code.review'], capabilities: ['repo.read', 'repo.write', 'run.tests'], enabled: true, registered_at: ago(9 * 24 * HOUR), last_seen_at: ago(40_000) },
    { id: 'svc_render', name: 'render-farm', version: '0.2.0', address: 'http://127.0.0.1:8722', contract: 'render/1', surfaces: ['media.render'], capabilities: ['render.image'], enabled: false, registered_at: ago(3 * 24 * HOUR), last_seen_at: ago(30 * HOUR) },
  ]

  private activations: AppActivation[] = [
    { program: 'commons-explorer', swarm_id: 's_lyra', active: true },
    { program: 'commons-explorer', swarm_id: 's_kelp', active: false },
    { program: 'contract-fixture', swarm_id: 's_forge', active: true },
  ]
  private attachments: AppAttachment[] = [
    { id: 'at_sim01', program: 'commons-explorer', swarm_id: 's_lyra', mind_id: 'a_vega01', actor: 'explorer:vega', actions: ['annotate'], channels: ['commons'], policy: { annotate: 'allow' }, expires_at: null, status: 'active', granted_by: 'user:p_ada', revoked_by: null },
    { id: 'at_sim02', program: 'contract-fixture', swarm_id: 's_forge', mind_id: 'a_anvl09', actor: 'fixture:anvil', actions: ['mark-reviewed', 'raise-question'], channels: ['review'], policy: { 'mark-reviewed': 'ask', 'raise-question': 'allow' }, expires_at: new Date(Date.now() + 6 * 24 * HOUR).toISOString(), status: 'active', granted_by: 'user:p_ada', revoked_by: null },
  ]
  private activity: AppActivityRow[] = [
    { id: 'pa_s1', program: 'commons-explorer', swarm_id: 's_lyra', principal: 'agent:a_vega01', action: 'annotate', items: ['b_vega', 'b_deneb'], status: 'done', approval_id: null, created_at: ago(12 * MIN), finished_at: ago(12 * MIN - 1500) },
    { id: 'pa_s2', program: 'contract-fixture', swarm_id: 's_forge', principal: 'user:p_ada', action: 'mark-reviewed', items: ['c1'], status: 'done', approval_id: 'ap_sim9', created_at: ago(55 * MIN), finished_at: ago(54 * MIN) },
    { id: 'pa_s3', program: 'contract-fixture', swarm_id: 's_forge', principal: 'agent:a_anvl09', action: 'raise-question', items: ['e3'], status: 'failed', approval_id: null, created_at: ago(2 * HOUR), finished_at: ago(2 * HOUR - 800) },
    { id: 'pa_s4', program: 'commons-explorer', swarm_id: 's_lyra', principal: 'agent:a_deneb2', action: 'pin-belief', items: ['b_ring'], status: 'running', approval_id: null, created_at: ago(40_000), finished_at: null },
  ]
  private requests: CollabRequest[] = [
    { id: 'rq_sim1', kind: 'code-review', title: 'Review the lens-calibration patch', from_swarm: 's_lyra', from_goal: null, from_principal: 'agent:a_vega01', to_swarm: 's_forge', receiving_goal: 'g_sim_r1', state: 'working', depth: 1, created_at: ago(5 * HOUR), cancelled_at: null, budget: { root: 'swarm:s_lyra', limit_usd: 3, allocated_usd: 0.42 }, subject: { artifact_id: 'ar_simlens', revision: 3, digest: `sha256:${hex('lens-r3')}` } },
    { id: 'rq_sim2', kind: 'plan', title: 'Plan the tide-sensor rollout', from_swarm: 's_forge', from_goal: null, from_principal: 'agent:a_anvl09', to_swarm: 's_kelp', receiving_goal: 'g_sim_r2', state: 'completed', depth: 1, created_at: ago(30 * HOUR), cancelled_at: null, budget: { root: 'swarm:s_forge', limit_usd: 2, allocated_usd: 1.1 }, subject: { artifact_id: 'ar_simtide', revision: 1, digest: `sha256:${hex('tide-r1')}` } },
  ]
  private flows: Record<string, FlowRow[]> = {
    s_forge: [{ artifact_id: 'ar_simflow1', title: 'Nightly build and review', revision: 4 }],
    s_kelp: [{ artifact_id: 'ar_simflow2', title: 'Tide data intake', revision: 2 }],
  }
  private shares: ShareRow[] = [
    { id: 'sh_sim1', owner_id: 'a_deneb2', grantee_id: 'a_vega01', status: 'active', created_at: ago(70 * MIN), exhibit_id: 'ex_sim1', exhibit: { title: 'Supergiant spectra, annotated', bytes: 4_210, atoms: 18 } },
    { id: 'sh_sim2', owner_id: 'a_deneb2', grantee_id: 'a_altr03', status: 'active', created_at: ago(70 * MIN), exhibit_id: 'ex_sim1', exhibit: { title: 'Supergiant spectra, annotated', bytes: 4_210, atoms: 18 } },
    { id: 'sh_sim3', owner_id: 'a_nori06', grantee_id: 'a_coral5', status: 'expired', created_at: ago(26 * HOUR), exhibit_id: 'ex_sim2', exhibit: { title: 'Kelp canopy counts, week 40', bytes: 1_904, atoms: 7 } },
  ]
  /** Invented artifacts each swarm owns, at their latest exact revision (the Studio picker's list). */
  private swarmOwned: Record<string, SwarmArtifact[]> = {
    s_lyra: [
      this.owned('ar_simposter', 'studio-source', 'Night-sky festival poster', 4, 40 * MIN),
      this.owned('ar_simdeck', 'scene-deck', 'Observatory open-day deck', 2, 5 * HOUR),
      this.owned('ar_simlens', 'review-packet', 'Lens-calibration patch', 3, 6 * HOUR),
      this.owned('ar_simbrand', 'identity', 'Lyra identity', 7, 3 * 24 * HOUR),
    ],
    s_kelp: [this.owned('ar_simtidecard', 'studio-source', 'Tide-sensor field card', 1, 9 * HOUR)],
    s_forge: [this.owned('ar_simflow1', 'flow', 'Nightly build and review', 4, 2 * HOUR)],
  }
  private seq = 0

  constructor(private readonly delay: <T>(fn: () => T) => Promise<T>) {}

  private owned(id: string, kind: string, title: string, revision: number, age: number): SwarmArtifact {
    const h = hex(`${id}-r${revision}`)
    const turn = [...id].reduce((n, c) => n + c.charCodeAt(0), revision) % 64   // hex() opens with the seed's first character; turn it so invented digests read apart
    return { artifact_id: id, kind, title, revision, digest: `sha256:${h.slice(turn)}${h.slice(0, turn)}`, created_at: ago(age + 3 * 24 * HOUR), revised_at: ago(age) }
  }

  private asset(name: string, mime: string, bytes: number, swarm: string, by: string, age: number, placements: string[], localOnly: boolean, more: Asset['history'] = []): Asset {
    return { sha256: hex(name), mime, bytes, name, owner_swarm: swarm, owners: [swarm], created_by: by, created_at: ago(age), local_only: localOnly, placements, history: [{ at: ago(age), by, event: 'stored', store: placements.includes('local') || more.length ? 'local' : placements[0] }, ...more] }
  }

  // ---- reservations ----
  /** The hive's own resolvability test (cost_reservations.resolve): unknown, or in flight for longer than STALE_SECONDS. */
  private resolvable(r: CostReservation): boolean {
    return r.state === 'unknown' || Date.now() / 1000 - (r.dispatched_at ?? 0) > STALE_SECONDS
  }
  private row(r: CostReservation): CostReservation {
    const { dispatched_at, unknown_at, resolvable: _r, auto_settles_at: _a, ...base } = r
    if (!this.timingFields) return base
    return { ...base, dispatched_at: dispatched_at ?? null, unknown_at: unknown_at ?? null, resolvable: this.resolvable(r), auto_settles_at: r.state === 'unknown' && unknown_at ? unknown_at + UNKNOWN_EXPIRY_SECONDS : null }
  }
  listReservations() {
    return this.delay(() => clone(this.reservations.filter((r) => !r.done).map(({ done: _d, ...r }) => this.row(r))))
  }
  listOverruns() {
    return this.delay(() => clone(this.overruns))
  }
  resolveReservation(id: string, body: ResolveBody) {
    return this.delay((): ResolvedReservation => {
      if (body.action !== 'settle' && body.action !== 'release') throw new ApiError(400, 'bad_request', 'action is settle or release')
      if (!body.reason?.trim()) throw new ApiError(400, 'bad_request', 'a reason is required')
      const r = this.reservations.find((x) => x.id === id)
      if (!r || r.done || !this.resolvable(r)) throw new ApiError(400, 'bad_request', 'only an unknown (or long-stuck) liability can be resolved')
      const maximum = Math.round(r.held_usd * 1e6)
      if (body.action === 'settle') {
        if (!Number.isFinite(body.actual_usd) || body.actual_usd < 0) throw new ApiError(400, 'bad_request', 'Finite nonnegative cost required')
        const actual = Math.ceil(body.actual_usd * 1e6)
        r.done = { id, state: 'settled', maximum, actual }
        if (actual > maximum) this.overruns.push({ reservation: id, agent: r.metadata.agent ?? null, maximum, actual, source: 'resolve', at: Date.now() / 1000 })
      } else r.done = { id, state: 'released', maximum, actual: null }
      return clone(r.done)
    })
  }

  // ---- artifacts ----
  hiveArtifacts() {
    return this.delay((): ArtifactList => ({ items: composeArtifacts({ requests: this.requests, flows: this.flows, shares: this.shares, activity: this.activity }), missing: [] }))
  }

  /** How many artifacts a swarm owns (the swarm-delete counts), now. */
  artifactCount(swarmId: string): number {
    return (this.swarmOwned[swarmId] ?? []).length
  }

  swarmArtifacts(swarmId: string, opts: { kind?: string; limit?: number } = {}) {
    return this.delay((): SwarmArtifact[] => {
      if (!/^s_[\w-]+$/.test(swarmId)) throw new ApiError(404, 'not_found', 'no such swarm')
      const rows = (this.swarmOwned[swarmId] ?? []).filter((a) => !opts.kind || a.kind === opts.kind)
      return clone(rows.slice(0, Math.max(1, Math.min(opts.limit ?? 200, 200))))
    })
  }

  // ---- assets ----
  assetStores() {
    return this.delay(() => clone(this.stores))
  }
  listAssets(swarmId?: string) {
    return this.delay(() => clone(this.assets.filter((a) => !swarmId || a.owners.includes(swarmId))))
  }
  uploadAsset(file: Blob, opts: UploadAssetOptions) {
    return this.delay((): Asset => {
      if (!file.size) throw new ApiError(400, 'bad_request', 'an asset needs content')
      if (file.size > 100 * 1024 * 1024) throw new ApiError(413, 'too_large', 'assets are limited to 100 MB')
      const store = opts.store ?? 'local'
      const target = this.stores.find((s) => s.name === store)
      if (!target) throw new ApiError(400, 'bad_store', `no store '${store}'; stores: ${this.stores.map((s) => s.name).join(', ')}`)
      if (opts.local_only && target.kind !== 'local') throw new ApiError(403, 'local_only', 'this asset must stay on this machine')
      const name = opts.name || 'upload'
      const a = this.asset(`${name}#${++this.seq}`, file.type || 'application/octet-stream', file.size, opts.swarm_id ?? '', 'user:operator', 0, [store], !!opts.local_only)
      a.name = name
      a.owner_swarm = opts.swarm_id || null
      a.owners = opts.swarm_id ? [opts.swarm_id] : []
      this.assets.unshift(a)
      return clone(a)
    })
  }
  assetBlob(sha: string) {
    return this.delay(() => {
      const a = this.assets.find((x) => x.sha256 === sha)
      if (!a) throw new ApiError(404, 'not_found', 'no such asset')
      const image = simImage(a.mime)   // Studio slice 2: an image file downloads as a small invented image of its type
      if (image) return new Blob([image], { type: a.mime })
      return new Blob([`Simulated file: ${a.name}\nsha256 ${a.sha256}\nNo real bytes exist in the demo.\n`], { type: 'text/plain' })
    })
  }
  transferAsset(sha: string, to: string, move: boolean) {
    return this.delay((): Asset => {
      const a = this.assets.find((x) => x.sha256 === sha)
      if (!a) throw new ApiError(404, 'not_found', 'no such asset')
      const target = this.stores.find((s) => s.name === to)
      if (!target) throw new ApiError(400, 'bad_store', `no store '${to}'`)
      if (a.local_only && target.kind !== 'local') throw new ApiError(403, 'local_only', 'this asset must stay on this machine')
      const removed = move ? a.placements.filter((p) => p !== to) : []
      a.placements = move ? [to] : [...new Set([...a.placements, to])].sort()
      a.history.push({ at: new Date().toISOString(), by: 'user:operator', event: move ? 'moved' : 'copied', to, removed })
      return clone(a)
    })
  }

  /** POST /api/assets/{sha}/cleanup (assets.py cleanup; the admin check is the client's): retry removing a
   *  this-machine-only file's copies from other stores, one attempt each; a failure is recorded, never raised. */
  cleanupAsset(sha: string, by: string) {
    return this.delay((): Asset => {
      const a = this.assets.find((x) => x.sha256 === sha)
      if (!a) throw new ApiError(404, 'not_found', 'no such asset')
      const pending = a.local_only ? a.placements.filter((p) => this.stores.find((s) => s.name === p)?.kind !== 'local') : []
      if (!pending.length) return clone(a)
      a.placements = a.placements.filter((p) => !pending.includes(p))
      a.history.push({ at: new Date().toISOString(), by, event: 'local_only_cleanup', removed: pending })
      a.pending_removal = []
      return clone(a)
    })
  }
  /** SIM: what each swarm offers, for the capability catalogue. */
  servicesSnapshot() {
    return clone(this.services)
  }

  // ---- services ----
  swarmServices(swarmId: string) {
    return this.delay(() => clone(this.services[swarmId] ?? { swarm_id: swarmId, kinds: [], connection_only_kinds: [] }))
  }
  setSwarmServices(swarmId: string, body: { kinds: string[]; connection_only_kinds: string[] }) {
    return this.delay((): SwarmServices => {
      const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort()
      const kinds = norm(body.kinds)
      const priv = norm(body.connection_only_kinds)
      if (kinds.some((k) => priv.includes(k))) throw new ApiError(400, 'service_scope_overlap', 'a service kind must have one discovery scope')
      this.services[swarmId] = { swarm_id: swarmId, kinds, connection_only_kinds: priv }
      return clone(this.services[swarmId])
    })
  }
  registeredServices() {
    return this.delay(() => clone(this.registered))
  }
  setServiceEnabled(id: string, enabled: boolean) {
    return this.delay(() => {
      const s = this.registered.find((x) => x.id === id)
      if (!s) throw new ApiError(404, 'not_found', `no service ${id}`)
      s.enabled = enabled
      return clone(s)
    })
  }
  removeService(id: string) {
    return this.delay(() => {
      const before = this.registered.length
      this.registered = this.registered.filter((x) => x.id !== id)
      if (before === this.registered.length) throw new ApiError(404, 'not_found', `no service ${id}`)
      return { ok: true as const }
    })
  }

  // ---- app activations, attachments, offers, activity ----
  /**
   * The host's person-activity gate (program_actions.py: `app_attachments.required(entry) and not active(...)`): an app
   * that uses activations at all (any row for it) must be active in this swarm before a person's act or confirm.
   */
  appInactive(programId: string, swarmId: string): boolean {
    const rows = this.activations.filter((a) => a.program === programId)
    return rows.length > 0 && !rows.some((a) => a.swarm_id === swarmId && a.active)
  }
  /**
   * SIM ONLY, demo mode (D3, api/sim/demo3.ts): Studio is switched on in some swarms and held in another, and the held
   * swarm owns a design and a deck of its own (INVENTED), so a Save there is refused as the host refuses it.
   */
  seedDemoStudio(activations: AppActivation[], owned: Record<string, [string, string, string, number, number][]>) {
    for (const a of activations) if (!this.activations.some((x) => x.program === a.program && x.swarm_id === a.swarm_id)) this.activations.push({ ...a })
    for (const [swarm, rows] of Object.entries(owned)) {
      const list = (this.swarmOwned[swarm] ??= [])
      for (const [id, kind, title, revision, minutes] of rows) if (!list.some((x) => x.artifact_id === id)) list.unshift(this.owned(id, kind, title, revision, minutes * MIN))
    }
  }
  programActivations(programId: string) {
    return this.delay(() => clone(this.activations.filter((a) => a.program === programId)))
  }
  activateProgram(programId: string, swarmId: string) {
    return this.delay((): AppActivation => {
      const row = this.activations.find((a) => a.program === programId && a.swarm_id === swarmId)
      if (row) row.active = true
      else this.activations.push({ program: programId, swarm_id: swarmId, active: true })
      return { program: programId, swarm_id: swarmId, active: true }
    })
  }
  deactivateProgram(programId: string, swarmId: string) {
    return this.delay((): AppActivation => {
      const row = this.activations.find((a) => a.program === programId && a.swarm_id === swarmId)
      if (row) row.active = false
      for (const at of this.attachments) if (at.program === programId && at.swarm_id === swarmId && at.status === 'active') Object.assign(at, { status: 'revoked', revoked_by: 'user:operator' })
      return { program: programId, swarm_id: swarmId, active: false }
    })
  }
  programAttachments(programId: string) {
    return this.delay(() => clone(this.attachments.filter((a) => a.program === programId)))
  }
  offerProgram(programId: string, mindId: string) {
    return this.delay((): AppOffer => {
      const swarm = SWARM_OF[mindId]
      if (!swarm || !this.activations.some((a) => a.program === programId && a.swarm_id === swarm && a.active)) throw new ApiError(403, 'app_inactive', 'activate the app in this swarm first')
      return clone(OFFERS[programId] ?? { actions_offered: [], channels_offered: [] })
    })
  }
  attachProgram(programId: string, body: AttachBody) {
    return this.delay((): AppAttachment => {
      const offer = OFFERS[programId]
      const swarm = SWARM_OF[body.mind_id]
      if (!offer || !swarm) throw new ApiError(403, 'app_inactive', 'activate the app in this swarm first')
      if (!body.actions.length || body.actions.some((a) => !offer.actions_offered.includes(a))) throw new ApiError(400, 'bad_scope', 'review a subset of offered actions')
      if (this.attachments.some((a) => a.program === programId && a.mind_id === body.mind_id && (a.status === 'active' || a.status === 'binding'))) throw new ApiError(409, 'already_attached', 'mind already has an attachment for this app')
      const at: AppAttachment = { id: `at_sim${10 + ++this.seq}`, program: programId, swarm_id: swarm, mind_id: body.mind_id, actor: `${programId}:${body.mind_id}`, actions: body.actions, channels: body.channels ?? null, policy: body.policy, expires_at: body.expires_at ?? null, status: 'active', granted_by: 'user:operator', revoked_by: null }
      this.attachments.push(at)
      return clone(at)
    })
  }
  detachProgram(programId: string, attachmentId: string) {
    return this.delay((): AppAttachment => {
      const at = this.attachments.find((a) => a.id === attachmentId && a.program === programId)
      if (!at) throw new ApiError(404, 'not_found', 'attachment not in program')
      Object.assign(at, { status: 'revoked', revoked_by: 'user:operator' })
      return clone(at)
    })
  }
  programActivity(opts: { swarm_id?: string; program?: string; limit?: number } = {}) {
    return this.delay(() => clone(this.activity.filter((a) => (!opts.swarm_id || a.swarm_id === opts.swarm_id) && (!opts.program || a.program === opts.program)).slice(0, opts.limit ?? 100)))
  }
}
