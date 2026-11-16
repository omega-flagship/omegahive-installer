export interface Candidate { id: string; generation: number; tree_digest: string }
export interface FileSnapshot { path: string; digest: string; content: string }
export type FileOperation = { kind: 'create'; path: string } | { kind: 'move'; file: FileSnapshot; target: string } | { kind: 'remove'; file: FileSnapshot }
export function filePatch(ws: Candidate, operation: FileOperation, operationId: string) {
  const path = (value: string) => {
    if (!value || value.length > 1000 || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Use a relative file path inside this candidate')
    return value
  }
  const edits = operation.kind === 'create'
    ? [{ path: path(operation.path), expected_digest: null, content: '' }]
    : operation.kind === 'remove'
      ? [{ path: path(operation.file.path), expected_digest: operation.file.digest, content: null }]
      : [{ path: path(operation.file.path), expected_digest: operation.file.digest, content: null },
        { path: path(operation.target), expected_digest: null, content: operation.file.content }]
  if (new Set(edits.map((edit) => edit.path)).size !== edits.length) throw new Error('Choose a different destination path')
  return { operation_id: operationId, expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, edits }
}
