import { describe, expect, it } from 'vitest'
import type { InventorySkill, Share } from './types'
import {
  availabilityWords,
  countSkills,
  exportBlockers,
  filterSkills,
  parseTar,
  pendingExport,
  readBundle,
  revokeContext,
  revokeEffect,
  shareOpen,
  shareSubject,
  splitShares,
  summarizeManifest,
} from './logic'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const at = (min: number) => new Date(NOW + min * 60_000).toISOString()

function share(over: Partial<Share>): Share {
  return {
    id: 'sh_1', kind: 'space', swarm_id: 's_1', owner_id: 'a_vega', owner_name: 'Vega', grantee_id: 'a_deneb', grantee_name: 'Deneb',
    space: 'notes', pattern: null, exhibit_id: null, minutes: 30, reason: '', status: 'active', initiated_by: 'owner',
    created_at: at(-10), decided_at: at(-10), expires_at: at(20), reads: 0, last_read_at: null, ...over,
  }
}

describe('shares', () => {
  it('is open only while active or requested and not past its time', () => {
    expect(shareOpen(share({}), NOW)).toBe(true)
    expect(shareOpen(share({ expires_at: at(-1) }), NOW)).toBe(false)
    expect(shareOpen(share({ status: 'revoked' }), NOW)).toBe(false)
    expect(shareOpen(share({ status: 'requested', expires_at: null }), NOW)).toBe(true)
  })

  it('splits by direction and state for one mind', () => {
    const list = [
      share({ id: 'out' }),
      share({ id: 'in', owner_id: 'a_deneb', owner_name: 'Deneb', grantee_id: 'a_vega', grantee_name: 'Vega' }),
      share({ id: 'ask-me', status: 'requested', initiated_by: 'grantee' }),
      share({ id: 'my-ask', status: 'requested', owner_id: 'a_mira', grantee_id: 'a_vega' }),
      share({ id: 'old', status: 'expired', decided_at: at(-60) }),
      share({ id: 'lapsed', expires_at: at(-5) }),
      share({ id: 'other', owner_id: 'a_x', grantee_id: 'a_y' }),
    ]
    const s = splitShares(list, 'a_vega', NOW)
    expect(s.readersOfMine.map((x) => x.id)).toEqual(['out'])
    expect(s.readingOthers.map((x) => x.id)).toEqual(['in'])
    expect(s.askedOfMe.map((x) => x.id)).toEqual(['ask-me'])
    expect(s.myAsks.map((x) => x.id)).toEqual(['my-ask'])
    expect(s.closed.map((x) => x.id)).toEqual(['lapsed', 'old'])
  })

  it('names what a share opens', () => {
    expect(shareSubject(share({}))).toBe('space notes, every atom in it')
    expect(shareSubject(share({ pattern: 'vega' }))).toBe('space notes, only atoms containing “vega”')
    expect(shareSubject(share({ kind: 'exhibit', space: null, exhibit: { title: 'Plan', atoms: 1, bytes: 3000 } }))).toBe('exhibit “Plan” (1 atom, 3 KB)')
  })

  it('shows every fact before a revoke, and says what it does', () => {
    const s = share({ reason: 'checking a claim', initiated_by: 'grantee', reads: 2, last_read_at: at(-1) })
    const rows = Object.fromEntries(revokeContext(s))
    expect(rows.Share).toBe('sh_1')
    expect(rows.Reader).toBe('Deneb (a_deneb)')
    expect(rows['How it began']).toBe('Deneb asked')
    expect(rows['Their reason']).toBe('checking a claim')
    expect(rows['Reads so far']).toMatch(/^2, last /)
    expect(revokeEffect(s)).toMatch(/Deneb loses access at once/)
    expect(revokeEffect(share({ status: 'requested' }))).toMatch(/request is withdrawn/)
  })
})

describe('tool inventory', () => {
  const skill = (id: string, status: InventorySkill['status'], module: string | null = 'core'): InventorySkill => ({
    id, module, status, signature: { parser: null, declared: null }, help: id === 'send' ? 'Send a message' : null, topic: null, effects: null, risk: null,
    metadata: 'unverified', policy: { decision: 'allow', reason: null, snapshot_at: at(0) }, route: { kind: 'none-declared' },
  })
  const skills = [skill('send', 'callable'), skill('query', 'callable'), skill('nal-step', 'imported', 'nal'), skill('shell', 'unknown')]

  it('counts and filters', () => {
    expect(countSkills(skills)).toEqual({ callable: 2, imported: 1, configured: 0, unknown: 1 })
    expect(filterSkills(skills, 'callable').map((s) => s.id)).toEqual(['send', 'query'])
    expect(filterSkills(skills, 'not-callable').map((s) => s.id)).toEqual(['nal-step', 'shell'])
    expect(filterSkills(skills, 'all', 'message').map((s) => s.id)).toEqual(['send'])
    expect(filterSkills(skills, 'all', 'NAL').map((s) => s.id)).toEqual(['nal-step'])
  })

  it('says how far to trust the list', () => {
    expect(availabilityWords({ availability: 'boot-receipt', stale_reason: null }).tone).toBe('good')
    expect(availabilityWords({ availability: 'receipt-stale', stale_reason: 'the mind is asleep' }).body).toMatch(/the mind is asleep/)
    expect(availabilityWords({ availability: 'no-boot-receipt', stale_reason: null }).title).toBe('No list yet')
  })
})

describe('portable minds', () => {
  it('mirrors the server reasons a mind cannot be exported', () => {
    expect(exportBlockers({ kind: 'omega', status: 'stopped', name: 'Vega' })).toEqual([])
    expect(exportBlockers({ kind: 'omega', status: 'awake', name: 'Vega' })[0]).toMatch(/Stop or sleep Vega/)
    expect(exportBlockers({ kind: 'module', status: 'stopped', name: 'Wisp' })[0]).toMatch(/outside member/)
    expect(exportBlockers({ kind: 'omega', status: 'stopped', name: 'Vega', moved_to: 'h_1', moved_to_name: 'Cloud' })[0]).toMatch(/Cloud/)
  })

  it('finds the export still waiting to be settled', () => {
    const moves = [
      { direction: 'out', status: 'settled', created_at: at(-50), manifest_sha256: 'a' },
      { direction: 'in', status: 'arrived', created_at: at(-40), manifest_sha256: 'b' },
      { direction: 'out', status: 'exported', created_at: at(-5), manifest_sha256: 'c' },
    ]
    expect(pendingExport(moves)?.manifest_sha256).toBe('c')
    expect(pendingExport(moves.slice(0, 2))).toBeUndefined()
  })

  const manifest = {
    format: 'omegahive.mind/1', exported_at: at(0), from: { id: 'h_ab12', name: 'Home', home: true },
    mind: { id: 'a_vega01', name: 'Vega', kind: 'omega', model: 'm', owner: 'user:jon' }, role: null, swarm: { id: 's_lyra', name: 'Lyra' },
    messages: [{}, {}], wakeups: [{}], rules: [{ skill: 'shell', mode: 'deny' }], files: { 'workspace/memory/a.metta': 'x' },
  }

  function tarOf(files: Record<string, string>): Uint8Array {
    const enc = new TextEncoder()
    const blocks: Uint8Array[] = []
    for (const [name, text] of Object.entries(files)) {
      const data = enc.encode(text)
      const h = new Uint8Array(512)
      h.set(enc.encode(name), 0)
      h.set(enc.encode(data.length.toString(8).padStart(11, '0')), 124)
      h[156] = 48
      blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512))
    }
    blocks.push(new Uint8Array(1024))
    const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0))
    let o = 0
    for (const b of blocks) {
      out.set(b, o)
      o += b.length
    }
    return out
  }

  it('reads a tar and summarises the manifest', () => {
    const tar = tarOf({ 'workspace/memory/a.metta': 'x', 'manifest.json': JSON.stringify(manifest) })
    const entries = parseTar(tar)
    expect(entries.map((e) => e.name)).toEqual(['workspace/memory/a.metta', 'manifest.json'])
    const s = summarizeManifest(JSON.parse(new TextDecoder().decode(entries[1].data)))
    expect(s).toMatchObject({ mindId: 'a_vega01', mindName: 'Vega', files: 1, messages: 2, wakeups: 1, rules: [{ skill: 'shell', mode: 'deny' }] })
    expect(() => summarizeManifest({ format: 'other' })).toThrow(/unknown bundle format/)
  })

  it('opens a gzipped bundle', async () => {
    const raw = tarOf({ 'manifest.json': JSON.stringify(manifest) })
    const gz = await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    const s = await readBundle(gz)
    expect(s.fromHive.name).toBe('Home')
    await expect(readBundle(new TextEncoder().encode('nope').buffer as ArrayBuffer)).rejects.toThrow(/not a mind bundle/)
  })
})

describe('who ended a share (revoked_by, Platform’s coming field; audit row 37)', async () => {
  const { endedWords, revokedByWords } = await import('./logic')
  const base = { status: 'revoked' } as import('./types').Share
  it('keeps today’s words when the hive does not say', () => {
    expect(endedWords(base)).toBe('ended by a person or the owner')
    expect(endedWords({ ...base, revoked_by: null })).toBe('ended by a person or the owner')
  })
  it('names who ended it when it does', () => {
    expect(endedWords({ ...base, revoked_by: 'agent:a_vega01' }, (id) => (id === 'a_vega01' ? 'Vega' : undefined))).toBe('ended by Vega (a mind)')
    expect(revokedByWords('user:operator')).toBe('the operator (hive password)')
    expect(revokedByWords('user:p_ada')).toBe('a person (p_ada)')
    expect(revokedByWords('unknown')).toBe('someone the hive did not record (revoked before it kept this)')
    expect(endedWords({ ...base, status: 'expired', revoked_by: 'user:x' } as import('./types').Share)).toBe('ran out')
  })
})
