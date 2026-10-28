export interface MergeEntry { digest: string; size: number; executable: boolean }
export interface MergeFile { path: string; base: MergeEntry | null; ours: MergeEntry | null; incoming: MergeEntry | null; merged: MergeEntry | null; conflict: boolean; reason: string | null }
export type MergeChoice = 'ours' | 'incoming' | 'base' | 'delete' | 'manual'
export interface MergeDraft { choice: MergeChoice | ''; format: 'text' | 'base64'; content: string; executable: boolean }
export interface Resolution { path: string; choice: MergeChoice; content_base64?: string; executable?: boolean }

export function resolutionPayload(files: MergeFile[], drafts: Record<string, MergeDraft>): Resolution[] {
  let total = 0
  return files.filter(f => f.conflict).map<Resolution>(file => {
    const draft = drafts[file.path]
    if (!draft?.choice) throw new Error(`Choose a resolution for ${file.path}`)
    if (draft.choice !== 'manual') return { path: file.path, choice: draft.choice }
    let bytes: Uint8Array
    if (draft.format === 'text') bytes = new TextEncoder().encode(draft.content)
    else {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(draft.content)) throw new Error(`Invalid base64 for ${file.path}`)
      bytes = Uint8Array.from(atob(draft.content), c => c.charCodeAt(0))
    }
    if (bytes.length > 2097152) throw new Error(`Manual source exceeds 2 MiB for ${file.path}`)
    total += bytes.length
    if (total > 33554432) throw new Error('Manual resolutions exceed 32 MiB')
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { path: file.path, choice: 'manual', content_base64: btoa(binary), executable: draft.executable }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

export function canApplyMerge(source: { generation: number; tree_digest: string }, preview: { generation: number; tree_digest: string; file_count: number; conflict_count: number }, files: MergeFile[], eof: boolean, dirty: boolean, drafts: Record<string, MergeDraft>) {
  if (dirty || !eof || !preview.file_count || source.generation !== preview.generation || source.tree_digest !== preview.tree_digest) return false
  if (files.length !== preview.file_count || files.filter(f => f.conflict).length !== preview.conflict_count) return false
  try { resolutionPayload(files, drafts); return true } catch { return false }
}
