/**
 * The simulator's minds-side surfaces: memory shares between minds, each mind's tool inventory and reasoning activity,
 * the health mind, and moving minds between hives. Invented, but shaped exactly like hive/core's answers.
 */
import type { Agent } from '../types'
import { ApiError } from '../client'
import type { HiveIdentity, InventorySkill, MindActivity, MindExport, MindInventory, MindMove, Share, ShareRead } from '../../features/minds/types'
import { readBundle, type BundleSummary } from '../../features/minds/logic'

const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

type SkillSeed = [id: string, module: string | null, status: InventorySkill['status'], decision: 'allow' | 'ask' | 'deny', help: string | null, route?: string]
const SKILLS: SkillSeed[] = [
  ['send', null, 'callable', 'allow', 'Send a message to a person or another mind'],
  ['query', null, 'callable', 'allow', 'Ask the swarm commons a question'],
  ['remember', null, 'callable', 'allow', 'Write an atom to a private space'],
  ['search', null, 'callable', 'allow', 'Search the web'],
  ['pin', null, 'callable', 'allow', 'Keep a note in view'],
  ['metta', null, 'callable', 'ask', 'Run a MeTTa expression'],
  ['hive-publish', null, 'callable', 'allow', 'Publish a belief to the swarm commons'],
  ['hive-share-request', null, 'callable', 'allow', "Ask to read another mind's space for a while"],
  ['hive-share-offer', null, 'callable', 'ask', 'Open one of its spaces to another mind for a while'],
  ['hive-shared', null, 'callable', 'allow', 'Read a share it was given'],
  ['shell', null, 'callable', 'ask', 'Run a shell command in its sandbox'],
  ['nal-step', 'nal', 'callable', 'allow', 'One step of NAL inference'],
  ['nal-revise', 'nal', 'imported', 'allow', 'Revise two truth values'],
  ['pln-step', 'pln', 'configured', 'allow', 'One step of PLN inference'],
  ['image-gen', 'media', 'unknown', 'ask', null, 'media'],
  ['web-fetch', null, 'callable', 'deny', 'Fetch a URL'],
]

export class SimMinds {
  private shares: Share[] = []
  private reads = new Map<string, ShareRead[]>()
  private moves = new Map<string, MindMove[]>()
  private healthMindId: string | null = 'a_anvl09'
  private seq = 0
  identity: HiveIdentity = { id: 'h_5e1a9c', name: 'OmegaHive (demo)', home: true, owner: 'operator' }

  /** PATCH /api/hive/identity, as placement.set_identity: a blank name keeps the old one; at most 80 characters. */
  setIdentity(body: { name?: string; home?: boolean }): HiveIdentity {
    if (body.name !== undefined) this.identity = { ...this.identity, name: body.name.trim().slice(0, 80) || this.identity.name }
    if (body.home !== undefined) this.identity = { ...this.identity, home: !!body.home }
    return { ...this.identity }
  }

  constructor(private agents: Map<string, Agent>) {
    this.seed()
  }

  private name(id: string) {
    return this.agents.get(id)?.name ?? id
  }

  private seed() {
    const now = Date.now()
    const mk = (id: string, owner: string, grantee: string, over: Partial<Share>, startedMin: number): Share => {
      const a = this.agents.get(owner)
      return {
        id, kind: 'space', swarm_id: a?.swarm_id ?? 's_lyra', owner_id: owner, owner_name: this.name(owner), grantee_id: grantee,
        grantee_name: this.name(grantee), space: '&notes', pattern: null, exhibit_id: null, minutes: 30, reason: '', status: 'active',
        initiated_by: 'owner', created_at: iso(now - startedMin * MIN), decided_at: iso(now - startedMin * MIN), expires_at: null,
        reads: 0, last_read_at: null, ...over,
      }
    }
    this.shares = [
      mk('sh_v1n0te', 'a_vega01', 'a_deneb2', { minutes: 30, reason: 'for the gateway review', expires_at: iso(now + 18 * MIN), reads: 3, last_read_at: iso(now - 4 * MIN) }, 12),
      mk('sh_d2ep1s', 'a_deneb2', 'a_vega01', { space: '&episodes', pattern: 'latency', minutes: 60, initiated_by: 'grantee', reason: 'checking when p95 first rose', expires_at: iso(now + 42 * MIN), reads: 1, last_read_at: iso(now - 9 * MIN) }, 18),
      mk('sh_a3self', 'a_altr03', 'a_vega01', {}, 0),
      mk('sh_ex4gw', 'a_vega01', 'a_mira04', { kind: 'exhibit', space: null, exhibit_id: 'ex_9gw2', exhibit: { title: 'Gateway latency summary', atoms: 12, bytes: 3170 }, minutes: 120, expires_at: iso(now + 90 * MIN) }, 30),
      mk('sh_c5kelp', 'a_coral5', 'a_nori06', { space: '&self', minutes: 45, reason: 'so Nori can pick up the tide-table work', expires_at: iso(now + 25 * MIN), reads: 2, last_read_at: iso(now - 11 * MIN) }, 20),
      mk('sh_m6old', 'a_mira04', 'a_vega01', { space: '&episodes', minutes: 30, status: 'expired', expires_at: iso(now - 70 * MIN), reads: 4, last_read_at: iso(now - 95 * MIN) }, 100),
      mk('sh_v7rev', 'a_vega01', 'a_altr03', { minutes: 60, status: 'revoked', decided_at: iso(now - 3 * 60 * MIN), revoked_by: 'agent:a_vega01', reads: 1, last_read_at: iso(now - 3.2 * 60 * MIN) }, 220),
      mk('sh_s8den', 'a_coral5', 'a_sedg07', { space: '&self', initiated_by: 'grantee', reason: 'curious about the reef plan', status: 'denied', decided_at: iso(now - 26 * 60 * MIN) }, 1570),
    ]
    // Altair asks to read Vega's self space: only Vega answers it; a person can withdraw it.
    const ask = this.shares[2]
    Object.assign(ask, { space: '&self', status: 'requested', initiated_by: 'grantee', reason: 'to line up our gateway beliefs before the review', decided_at: null, created_at: iso(now - 6 * MIN), expires_at: iso(now + 54 * MIN) })
    for (const s of this.shares) {
      const list: ShareRead[] = []
      for (let i = 0; i < s.reads; i++)
        list.push({ id: ++this.seq, share_id: s.id, reader_id: s.grantee_id, q: i % 2 ? 'latency' : null, returned: 4 + (hash(s.id + i) % 30), created_at: i === 0 && s.last_read_at ? s.last_read_at : iso(Date.parse(s.created_at) + (i + 1) * 2 * MIN) })
      this.reads.set(s.id, list)
    }
    this.moves.set('a_qnch11', [
      { id: 'mv_q1', agent_id: 'a_qnch11', direction: 'in', other_hive: 'h_c10d07', other_name: 'Cloud hive', manifest_sha256: '9b1f0c55e2d84a7f6c3b0e1d2a9f8e7d6c5b4a3928170615f4e3d2c1b0a99887', status: 'arrived', detail: { files: 41 }, created_at: iso(now - 3 * 24 * 60 * MIN) },
    ])
    this.moves.set('a_altr03', [
      { id: 'mv_a1', agent_id: 'a_altr03', direction: 'out', other_hive: null, other_name: null, manifest_sha256: '3e7a1d09c4b2f5e8a6d3c1b0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0', status: 'exported', detail: { bytes: 2_412_377, files: 37 }, created_at: iso(now - 22 * MIN) },
    ])
  }

  // ---- shares --------------------------------------------------------------------------------

  /** Revoked shares say who ended them (Platform's coming revoked_by), unless told not to (live 0aa6330 sends none). */
  revokedByField = true

  list(opts: { agent_id?: string; status?: string } = {}): Share[] {
    // the coming R13 check: a mind this viewer cannot see answers 404 (in the sim: a mind that does not exist)
    if (opts.agent_id && !this.agents.has(opts.agent_id)) throw new ApiError(404, 'not_found', 'no such mind')
    return this.shares
      .filter((s) => (!opts.status || s.status === opts.status) && (!opts.agent_id || s.owner_id === opts.agent_id || s.grantee_id === opts.agent_id))
      .map((s) => this.view(s))
  }

  private view(s: Share): Share {
    const out: Share = { ...s, exhibit: s.exhibit && { ...s.exhibit } }
    if (this.revokedByField) out.revoked_by = s.revoked_by ?? null
    else delete out.revoked_by
    return out
  }

  shareReads(id: string): ShareRead[] {
    if (!this.shares.some((s) => s.id === id)) throw new ApiError(404, 'not_found', `no share ${id}`)
    return (this.reads.get(id) ?? []).map((r) => ({ ...r }))
  }

  revoke(id: string, by = 'user:operator'): Share {
    const s = this.shares.find((x) => x.id === id)
    if (!s) throw new ApiError(404, 'not_found', `no share ${id}`)
    if (s.status !== 'requested' && s.status !== 'active') throw new ApiError(409, 'not_open', `share is ${s.status}`)
    s.status = 'revoked'
    s.decided_at = iso(Date.now())
    s.revoked_by = by
    return this.view(s)
  }

  // ---- inventory -----------------------------------------------------------------------------

  inventory(agent: Agent): MindInventory {
    const at = iso(Date.now())
    const outside = agent.kind === 'module'
    const availability: MindInventory['availability'] = outside ? 'no-boot-receipt' : agent.status === 'awake' ? 'boot-receipt' : 'receipt-stale'
    const attested = availability === 'boot-receipt'
    const h = hash(agent.id)
    const pick = outside ? [] : SKILLS.filter((s, i) => !s[1] || agent.kind === 'omega' || (h >> i) & 1)
    const skills: InventorySkill[] = pick.map(([id, module, status, decision, help, route]) => ({
      id, module: module ?? 'core', signature: { parser: attested && status === 'callable' ? { arity: id === 'send' ? 2 : 1 } : null, declared: null },
      help, topic: null, effects: help ? (id.startsWith('hive-') || id === 'send' ? ['message'] : id === 'shell' ? ['process'] : null) : null,
      risk: id === 'shell' ? 'high' : id === 'web-fetch' || id === 'search' ? 'medium' : null,
      metadata: help ? 'verified-source' : 'unverified', status: attested ? status : 'unknown',
      policy: { decision, reason: decision === 'allow' ? 'role default' : decision === 'ask' ? 'asks a person each time' : 'hive rule: no direct fetches', snapshot_at: at },
      route: route ? { kind: route, note: 'the mind calls the vendor directly; no host metering route for media in this build' } : { kind: 'none-declared' },
    }))
    const loadedAt = agent.last_active_at ?? agent.created_at
    return {
      mind_id: agent.id, kind: agent.kind, availability,
      stale_reason: availability === 'receipt-stale' ? `the mind is ${agent.status}` : null,
      inventory_revision: outside ? null : `inv:${(h % 0xffffff).toString(16).padStart(6, '0')}`,
      loaded_at: outside ? null : loadedAt,
      process: outside ? null : { boot_id: `boot_${(h % 0xfffff).toString(16)}`, pid: 40_000 + (h % 9000) },
      modules: outside ? [] : [
        { id: 'nal', version: '0.4.2', source_digest: 'sha256:51c0…', configured: true, loaded: true, source_verified: true },
        { id: 'pln', version: '0.2.0', source_digest: 'sha256:a9e3…', configured: true, loaded: false, source_verified: false },
        { id: 'media', version: null, source_digest: null, configured: false, loaded: false, source_verified: false },
      ],
      core: outside ? null : { source_digest: 'sha256:0d7e…', source_verified: true },
      skills,
      dynamic: outside || !agent.swarm_id ? [] : [{ kind: 'flow', id: 'flow:triage', registry_revision: 'r12', swarm_id: agent.swarm_id, status: 'unknown' }],
      dynamic_status: 'ok',
      provider: { model: agent.model, resolved_model: agent.model.startsWith('ollama/') ? null : `${agent.model}-20260901`, payer_kind: agent.options?.key ? 'mind-owner' : 'hive', budget_route: [`agent:${agent.id}:total`, `swarm:${agent.swarm_id ?? '-'}:month`, 'hive:hard-total'], budget_route_note: 'key and person scopes join when a call is made with a key', snapshot_at: at },
      snapshot_at: at,
    }
  }

  activity(agent: Agent, cycles = 30): MindActivity {
    const h = hash(agent.id + 'act')
    const observed = agent.kind === 'module' ? 0 : Math.min(cycles, 8 + (h % 40))
    const dormant = agent.status !== 'awake' && h % 3 === 0
    const n = (k: number) => (dormant ? 0 : (h >>> k) % 9)
    const c = (k: number) => ({ attempted: n(k) + ((h >>> (k + 1)) & 1), ran: n(k) })
    const reasoning = { nal: c(1), pln: { attempted: 0, ran: 0 }, nars: c(4), metta: c(7) }
    const belief_writes = { mind: c(10), commons: c(13) }
    const sum = (o: Record<string, { ran: number }>) => Object.values(o).reduce((t, x) => t + x.ran, 0)
    const now = Date.now()
    return {
      mind_id: agent.id, cycles_requested: cycles, cycles_observed: observed,
      since: observed ? iso(now - observed * 7 * MIN) : null, until: observed ? iso(now - 2 * MIN) : null,
      reasoning, belief_writes, belief_writes_ran: sum(belief_writes), reasoning_ran: sum(reasoning),
      dormant: observed > 0 && sum(reasoning) === 0 && sum(belief_writes) === 0,
      basis: "recorded commands in this mind's traces (not the mind's own memory)",
    }
  }

  // ---- the health mind -----------------------------------------------------------------------

  healthMind() {
    return { agent_id: this.healthMindId }
  }
  setHealthMind(id: string | null) {
    if (id && !this.agents.has(id)) throw new ApiError(404, 'not_found', `no agent ${id}`)
    this.healthMindId = id || null
    return { agent_id: this.healthMindId }
  }

  // ---- portable minds ------------------------------------------------------------------------

  movesOf(id: string): MindMove[] {
    if (!this.agents.has(id)) throw new ApiError(404, 'not_found', `no agent ${id}`)
    return (this.moves.get(id) ?? []).map((m) => ({ ...m, detail: { ...m.detail } }))
  }

  async export(agent: Agent, memory: Map<string, string[]>, messages: number): Promise<MindExport> {
    const moved = (agent as Agent & { moved_to?: string }).moved_to
    if (moved) throw new ApiError(409, 'moved', `this mind now lives on ${moved}`)
    if (agent.kind !== 'omega' && agent.kind !== 'iter') throw new ApiError(400, 'not_portable', 'only minds that run in a hive can move; an outside member just reconnects')
    if (!['created', 'stopped', 'asleep', 'error'].includes(agent.status)) throw new ApiError(409, 'mind_running', 'stop or sleep the mind before moving it')
    const enc = new TextEncoder()
    const files: Record<string, Uint8Array> = {}
    for (const [space, atoms] of memory) files[`workspace/memory/${space.replace(/^&/, '')}.metta`] = enc.encode(atoms.join('\n') + '\n')
    const digests: Record<string, string> = {}
    for (const [name, data] of Object.entries(files)) digests[name] = await sha256(data)
    const manifest = {
      format: 'omegahive.mind/1', exported_at: iso(Date.now()), from: this.identity,
      mind: { id: agent.id, name: agent.name, kind: agent.kind, model: agent.model, persona: agent.persona, hue: agent.hue, budget_usd: agent.budget_usd, owner: agent.owner ?? null, created_at: agent.created_at },
      role: null, swarm: agent.swarm_id ? { id: agent.swarm_id, name: agent.swarm_id } : null,
      messages: Array.from({ length: messages }, () => ({})), wakeups: [], rules: [{ scope: `agent:${agent.id}`, skill: 'web-fetch', mode: 'deny', note: 'hive rule', expires_at: null, origin: '' }],
      files: digests,
    }
    const manifestBytes = enc.encode(JSON.stringify(manifest, null, 1))
    const digest = await sha256(manifestBytes)
    const blob = await gzip(tar({ ...files, 'manifest.json': manifestBytes }))
    const list = this.moves.get(agent.id) ?? []
    list.push({ id: `mv_${++this.seq}`, agent_id: agent.id, direction: 'out', other_hive: null, other_name: null, manifest_sha256: digest, status: 'exported', detail: { bytes: blob.size, files: Object.keys(files).length }, created_at: iso(Date.now()) })
    this.moves.set(agent.id, list)
    return { blob, filename: `${agent.id}.omegamind.tgz`, manifest_sha256: digest, bytes: blob.size }
  }

  settle(agent: Agent, body: { to_hive: string; to_name: string; manifest_sha256: string }) {
    const list = this.moves.get(agent.id) ?? []
    const m = list.find((x) => x.direction === 'out' && x.manifest_sha256 === body.manifest_sha256)
    if (!m) throw new ApiError(409, 'not_exported', 'that bundle was not exported from this hive')
    Object.assign(m, { status: 'settled', other_hive: body.to_hive, other_name: body.to_name })
  }

  /** Reads the bundle like the hive does; the caller brings the mind to life. */
  async readImport(bundle: Blob): Promise<BundleSummary> {
    try {
      return await readBundle(await bundle.arrayBuffer())
    } catch (e) {
      throw new ApiError(400, 'bad_bundle', e instanceof Error ? e.message : 'not a mind bundle')
    }
  }

  arrived(agentId: string, s: BundleSummary, digest: string) {
    const list = this.moves.get(agentId) ?? []
    list.push({ id: `mv_${++this.seq}`, agent_id: agentId, direction: 'in', other_hive: s.fromHive.id ?? null, other_name: s.fromHive.name ?? null, manifest_sha256: digest, status: 'arrived', detail: { files: s.files }, created_at: iso(Date.now()) })
    this.moves.set(agentId, list)
  }
}

async function sha256(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function tar(files: Record<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [name, data] of Object.entries(files)) {
    const h = new Uint8Array(512)
    h.set(enc.encode(name.slice(0, 99)), 0)
    h.set(enc.encode('0000600\0'), 100)
    h.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124)
    h.set(enc.encode(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0'), 136)
    h.set(enc.encode('        '), 148)
    h[156] = 48
    h.set(enc.encode('ustar\0' + '00'), 257)
    let sum = 0
    for (const b of h) sum += b
    h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  parts.push(new Uint8Array(1024))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function gzip(data: Uint8Array): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') return new Blob([data as BlobPart], { type: 'application/gzip' })
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' })
}
