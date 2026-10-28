import type { SymbolicRun } from './symbolicSession'
interface Metadata { id: string; rendered_atoms_digest: string; content_bytes: number; representation: string; context: Record<string, unknown> }
interface BytePage { snapshot_id: string; rendered_atoms_digest: string; encoding: string; content_type: string; data: string; after: number; next: number; eof: boolean; total_bytes: number }
const digestPattern = /^[a-f0-9]{64}$/
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
async function sha(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Verify resident rendered bytes against BOTH content hash and source/runtime snapshot identity. */
export class SnapshotAssembler {
  cursor = 0
  complete = false
  private chunks: Uint8Array[] = []
  readonly metadata: Metadata
  constructor(value: unknown, run: SymbolicRun) {
    const metadata = value as Metadata
    const context = { run_id: run.id, generation: run.generation, tree_digest: run.tree_digest,
      runtime_identity_digest: run.symbolic_session?.identity_digest, runtime: 'hyperon' }
    if (!metadata || !/^atoms_[a-f0-9]{64}$/.test(metadata.id) || !digestPattern.test(metadata.rendered_atoms_digest) ||
        !Number.isSafeInteger(metadata.content_bytes) || metadata.content_bytes < 2 || metadata.content_bytes > 262144 ||
        metadata.representation !== 'rendered-atom-multiset-v1' || canonical(metadata.context) !== canonical(context)) throw new Error('Snapshot metadata does not match selected run/source/runtime')
    this.metadata = structuredClone(metadata)
  }
  append(value: unknown) {
    const page = value as BytePage
    if (this.complete || !page || page.snapshot_id !== this.metadata.id || page.rendered_atoms_digest !== this.metadata.rendered_atoms_digest ||
        page.encoding !== 'base64' || page.content_type !== 'application/json; charset=utf-8' || page.after !== this.cursor ||
        page.total_bytes !== this.metadata.content_bytes || !Number.isSafeInteger(page.next) || page.next < this.cursor ||
        page.next > page.total_bytes || typeof page.eof !== 'boolean') throw new Error('Snapshot page has wrong identity or cursor')
    const bytes = Uint8Array.from(atob(page.data), c => c.charCodeAt(0))
    if (bytes.length > 8192 || page.next !== this.cursor + bytes.length || page.eof !== (page.next === page.total_bytes) || !bytes.length) throw new Error('Snapshot page has invalid byte bounds')
    this.chunks.push(bytes); this.cursor = page.next; this.complete = page.eof
  }
  async finish(): Promise<string[]> {
    if (!this.complete) throw new Error('Snapshot byte sequence is incomplete')
    const bytes = new Uint8Array(this.cursor)
    let after = 0
    for (const chunk of this.chunks) { bytes.set(chunk, after); after += chunk.length }
    if (await sha(bytes) !== this.metadata.rendered_atoms_digest) throw new Error('Snapshot content digest mismatch')
    const atoms: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!Array.isArray(atoms) || atoms.length > 4096 || atoms.some(atom => typeof atom !== 'string')) throw new Error('Snapshot is not a bounded rendered atom list')
    if (new TextDecoder().decode(bytes) !== canonical(atoms)) throw new Error('Snapshot bytes are not canonical JSON')
    const identity = canonical({ context: this.metadata.context, representation: this.metadata.representation, atoms })
    if ('atoms_' + await sha(new TextEncoder().encode(identity)) !== this.metadata.id) throw new Error('Snapshot identity digest mismatch')
    return atoms as string[]
  }
}
