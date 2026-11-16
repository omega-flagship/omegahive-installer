export interface SourceVersion { id: string; generation: number; tree_digest: string }
export interface Hunk { id: string; path: string; kind: 'text' | 'file' | 'mode'; reason?: string; before: { executable: boolean } | null; after: { executable: boolean } | null; before_start?: number; after_start?: number }
export interface Review { id: string; workspace_id: string; generation: number; tree_digest: string; hunks: Hunk[]; cursor: number; eof: boolean; currency: string }
export function selectionPayload(ws: SourceVersion, review: Review, ids: string[], operation: string) {
  if (review.workspace_id !== ws.id || review.generation !== ws.generation || review.tree_digest !== ws.tree_digest || review.currency !== 'current') throw new Error('The reviewed source changed. Create a fresh review.')
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !review.hunks.some(h => h.id === id))) throw new Error('Select unique hunks from this review.')
  return { review_id: review.id, operation_id: operation, hunk_ids: [...ids].sort(), expected_generation: review.generation, expected_tree_digest: review.tree_digest }
}
export function decodePages(pages: string[]) {
  const chunks = pages.map(p => Uint8Array.from(atob(p), c => c.charCodeAt(0)))
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('binary')
    return text
  } catch { return 'Binary bytes (hex):\n' + Array.from(bytes, c => c.toString(16).padStart(2, '0')).join(' ') }
}
