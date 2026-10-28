/** Pure logic for the minds-side surfaces (sharing, tools, moving, the health mind). No React, so it is tested in node. */
import type { Agent } from '../../api/types'
import type { InventorySkill, MindInventory, Share, SkillStatus } from './types'

// ---- memory shares ---------------------------------------------------------------------------

/** Still in force: active or requested, and not past its time (the hive closes lapsed shares on its next pass). */
export function shareOpen(s: Share, now = Date.now()): boolean {
  if (s.status !== 'active' && s.status !== 'requested') return false
  return !s.expires_at || Date.parse(s.expires_at) > now
}

export interface ShareSplit {
  /** Other minds that can read this mind's memory now. */
  readersOfMine: Share[]
  /** What this mind can read of others now. */
  readingOthers: Share[]
  /** Others asking to read this mind (it answers them itself). */
  askedOfMe: Share[]
  /** This mind asking to read others. */
  myAsks: Share[]
  /** Denied, revoked, expired or lapsed: the record stays. */
  closed: Share[]
}

export function splitShares(shares: Share[], agentId: string, now = Date.now()): ShareSplit {
  const out: ShareSplit = { readersOfMine: [], readingOthers: [], askedOfMe: [], myAsks: [], closed: [] }
  for (const s of shares) {
    const mine = s.owner_id === agentId
    if (!mine && s.grantee_id !== agentId) continue
    if (!shareOpen(s, now)) out.closed.push(s)
    else if (s.status === 'requested') (mine ? out.askedOfMe : out.myAsks).push(s)
    else (mine ? out.readersOfMine : out.readingOthers).push(s)
  }
  out.closed.sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))
  return out
}

/** What a share opens, in words: "space notes, only atoms containing “vega”" or "exhibit “Q3 plan” (12 atoms, 3 KB)". */
export function shareSubject(s: Share): string {
  if (s.kind === 'exhibit') {
    const e = s.exhibit
    return e ? `exhibit “${e.title}” (${e.atoms} atom${e.atoms === 1 ? '' : 's'}, ${kb(e.bytes)})` : 'an exhibit'
  }
  return `space ${s.space ?? '?'}${s.pattern ? `, only atoms containing “${s.pattern}”` : ', every atom in it'}`
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function ownerName(s: Share): string {
  return s.owner_name || s.owner_id
}
export function readerName(s: Share): string {
  return s.grantee_name || s.grantee_id
}

/** The exact rows a person sees before revoking: nothing about the share is left out. */
export function revokeContext(s: Share): [string, string][] {
  const rows: [string, string][] = [
    ['Share', s.id],
    ['Owner', `${ownerName(s)} (${s.owner_id})`],
    ['Reader', `${readerName(s)} (${s.grantee_id})`],
    ['Opens', shareSubject(s)],
    ['Status', s.status === 'requested' ? 'asked, not yet answered' : 'active'],
    ['How it began', s.kind === 'exhibit' ? `${ownerName(s)} exhibited it` : s.initiated_by === 'grantee' ? `${readerName(s)} asked` : `${ownerName(s)} offered it`],
  ]
  if (s.reason) rows.push([s.initiated_by === 'grantee' ? 'Their reason' : 'Note', s.reason])
  rows.push(['Started', s.created_at])
  if (s.expires_at) rows.push([s.status === 'requested' ? 'Request lapses' : 'Access ends', s.expires_at])
  rows.push(['Reads so far', s.reads ? `${s.reads}, last ${s.last_read_at ?? 'unknown'}` : 'none'])
  return rows
}

/**
 * Who ended a share, in words, from `revoked_by` (Platform's coming field). Null when the hive did not say: the caller
 * then keeps today's wording and never guesses. `mindName` names an `agent:<id>`.
 */
export function revokedByWords(by: string | null | undefined, mindName: (id: string) => string | undefined = () => undefined): string | null {
  if (typeof by !== 'string' || !by) return null
  // live 71de696: shares revoked before the field existed carry "unknown" (the hive did not record who)
  if (by === 'unknown') return 'someone the hive did not record (revoked before it kept this)'
  if (by === 'user:operator') return 'the operator (hive password)'
  if (by.startsWith('agent:')) {
    const id = by.slice(6)
    return `${mindName(id) ?? id} (a mind)`
  }
  if (by.startsWith('user:')) return `a person (${by.slice(5)})`
  return by
}

const STATUS_WORD: Record<string, string> = { denied: 'declined', revoked: 'ended by a person or the owner', expired: 'ran out', requested: 'lapsed unanswered', active: 'ran out' }

/** How a closed share ended: who ended a revoked one when the hive records it (revoked_by), else today's words. */
export function endedWords(s: Share, mindName: (id: string) => string | undefined = () => undefined): string {
  const who = s.status === 'revoked' ? revokedByWords(s.revoked_by, mindName) : null
  return who ? `ended by ${who}` : (STATUS_WORD[s.status] ?? s.status)
}

/** What revoking does, in plain words. */
export function revokeEffect(s: Share): string {
  const reader = readerName(s)
  if (s.status === 'requested') return `${reader}'s request is withdrawn and ${reader} is told. ${ownerName(s)} never has to answer it.`
  return `${reader} loses access at once and is told access was withdrawn. Anything ${reader} already read stays with ${reader}. This cannot be undone; ${ownerName(s)} can share again later.`
}

// ---- tool inventory --------------------------------------------------------------------------

export type SkillView = 'callable' | 'not-callable' | 'all'

export function countSkills(skills: InventorySkill[]): Record<SkillStatus, number> {
  const c: Record<SkillStatus, number> = { callable: 0, imported: 0, configured: 0, unknown: 0 }
  for (const s of skills) c[s.status] = (c[s.status] ?? 0) + 1
  return c
}

export function filterSkills(skills: InventorySkill[], view: SkillView, q = ''): InventorySkill[] {
  const needle = q.trim().toLowerCase()
  return skills.filter((s) => {
    if (view === 'callable' && s.status !== 'callable') return false
    if (view === 'not-callable' && s.status === 'callable') return false
    if (!needle) return true
    return s.id.toLowerCase().includes(needle) || (s.module ?? '').toLowerCase().includes(needle) || (s.help ?? '').toLowerCase().includes(needle)
  })
}

export const SKILL_STATUS_WORDS: Record<SkillStatus, string> = {
  callable: 'Callable: loaded, and its parser accepts it',
  imported: 'Imported: its module loaded and declares it, but the parser did not report it',
  configured: 'Configured: its module is set up but did not load',
  unknown: 'Unknown: no current boot receipt vouches for it',
}

/** How far to trust the list, from the mind's boot receipt. */
export function availabilityWords(inv: Pick<MindInventory, 'availability' | 'stale_reason'>): { tone: 'good' | 'warn' | 'muted'; title: string; body: string } {
  if (inv.availability === 'boot-receipt')
    return { tone: 'good', title: 'Current', body: 'The running mind sent this list when it booted, for this connection.' }
  if (inv.availability === 'receipt-stale')
    return { tone: 'warn', title: 'Out of date', body: `The last list is kept, but ${inv.stale_reason ?? 'it no longer matches the running mind'}. Every tool reads unknown until it boots again.` }
  return { tone: 'muted', title: 'No list yet', body: 'This mind has not sent a boot receipt, so nothing is known to be callable. It sends one each time it starts.' }
}

// ---- portable minds --------------------------------------------------------------------------

const EXPORTABLE = new Set(['created', 'stopped', 'asleep', 'error'])

/** Why this mind cannot be exported right now (empty when it can). Mirrors placement.export's checks. */
export function exportBlockers(agent: Pick<Agent, 'kind' | 'status' | 'name'> & { moved_to?: string | null; moved_to_name?: string | null }): string[] {
  const out: string[] = []
  if (agent.moved_to || (agent.status as string) === 'moved') out.push(`It already lives on ${agent.moved_to_name || agent.moved_to || 'another hive'}.`)
  if (agent.kind !== 'omega' && agent.kind !== 'iter') out.push('Only minds that run in a hive can move; an outside member just reconnects to the other hive.')
  if (!EXPORTABLE.has(agent.status)) out.push(`Stop or sleep ${agent.name} first: it is ${agent.status}.`)
  return out
}

/** A hive's id (h_ + hex) or a mind bundle's manifest digest, as the server writes them. */
export const looksLikeHiveId = (s: string) => /^h_[0-9a-f]{4,}$/.test(s.trim())
export const looksLikeSha256 = (s: string) => /^[0-9a-f]{64}$/.test(s.trim())

/** The last export of this mind that has not been settled, if any (moves are oldest first). */
export function pendingExport<T extends { direction: string; status: string; created_at: string }>(moves: T[]): T | undefined {
  return [...moves].reverse().find((m) => m.direction === 'out' && m.status === 'exported')
}

// ---- reading a mind bundle in the browser (preview before import) ----------------------------

export interface TarEntry {
  name: string
  size: number
  data: Uint8Array
}

/** A ustar archive's regular files. Throws on a malformed header. */
export function parseTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  const dec = new TextDecoder()
  const str = (o: number, n: number) => {
    const raw = buf.subarray(o, o + n)
    const end = raw.indexOf(0)
    return dec.decode(end < 0 ? raw : raw.subarray(0, end))
  }
  let off = 0
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break
    const name = str(off, 100)
    const sizeText = str(off + 124, 12).trim()
    const size = sizeText ? parseInt(sizeText, 8) : 0
    if (!Number.isFinite(size) || size < 0) throw new Error('not a mind bundle')
    const type = String.fromCharCode(buf[off + 156] || 48)
    const prefix = str(off + 345, 155)
    const full = prefix ? `${prefix}/${name}` : name
    const start = off + 512
    if (start + size > buf.length) throw new Error('the bundle is cut short')
    if (type === '0' || type === '\0') out.push({ name: full, size, data: buf.subarray(start, start + size) })
    off = start + Math.ceil(size / 512) * 512
  }
  return out
}

export interface BundleSummary {
  format: string
  mindId: string
  mindName: string
  kind: string
  model: string
  owner: string | null
  fromHive: { id?: string; name?: string; home?: boolean }
  exportedAt: string
  swarm: { id: string; name: string } | null
  role: { id: string; name: string } | null
  files: number
  messages: number
  wakeups: number
  rules: { skill: string; mode: string }[]
}

export function summarizeManifest(m: Record<string, unknown>): BundleSummary {
  if (m.format !== 'omegahive.mind/1') throw new Error(`unknown bundle format ${JSON.stringify(m.format ?? null)}`)
  const mind = (m.mind ?? {}) as Record<string, unknown>
  const list = (k: string) => (Array.isArray(m[k]) ? (m[k] as unknown[]) : [])
  return {
    format: String(m.format),
    mindId: String(mind.id ?? ''),
    mindName: String(mind.name ?? ''),
    kind: String(mind.kind ?? ''),
    model: String(mind.model ?? ''),
    owner: (mind.owner as string | null) ?? null,
    fromHive: (m.from ?? {}) as BundleSummary['fromHive'],
    exportedAt: String(m.exported_at ?? ''),
    swarm: (m.swarm as BundleSummary['swarm']) ?? null,
    role: (m.role as BundleSummary['role']) ?? null,
    files: Object.keys((m.files ?? {}) as object).length,
    messages: list('messages').length,
    wakeups: list('wakeups').length,
    rules: list('rules').map((r) => ({ skill: String((r as Record<string, unknown>).skill), mode: String((r as Record<string, unknown>).mode) })),
  }
}

/** Gunzip a .omegamind.tgz and read its manifest, so a person sees exactly what arrives before importing it. */
export async function readBundle(bytes: ArrayBuffer): Promise<BundleSummary> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open the bundle to preview it.')
  let tar: Uint8Array
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    tar = new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    throw new Error('This is not a mind bundle (it is not gzip).')
  }
  const manifest = parseTar(tar).find((e) => e.name === 'manifest.json')
  if (!manifest) throw new Error('This bundle has no manifest.')
  try {
    return summarizeManifest(JSON.parse(new TextDecoder().decode(manifest.data)) as Record<string, unknown>)
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? 'The manifest is not readable.' : e instanceof Error ? e.message : String(e), { cause: e })
  }
}
