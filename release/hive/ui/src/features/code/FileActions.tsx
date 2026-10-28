import { useState } from 'react'
import { askConfirm } from '../../ui/confirm'
import { Button } from '../../ui/primitives'
import { filePatch, type Candidate, type FileOperation, type FileSnapshot } from './fileOperations'

type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => Promise<T>
export function FileActions({ call, ws, file, dirty, busy, onChanged }: {
  call: Call; ws: Candidate; file: FileSnapshot | null; dirty: boolean; busy: boolean;
  onChanged: (candidate: Candidate, selected: string | null) => Promise<void>
}) {
  const [mode, setMode] = useState<'create' | 'move' | null>(null)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const perform = async (operation: FileOperation) => {
    if (pending || busy) return
    const candidate = { ...ws }
    const selected = operation.kind === 'create' ? operation.path : operation.kind === 'move' ? operation.target : null
    let applied = false
    try {
      // Freeze both paths, content and expected versions before the confirmation can yield.
      const payload = filePatch(candidate, operation, `file-${crypto.randomUUID()}`)
      setPending(true); setError(null)
      const description = operation.kind === 'create' ? `Create ${operation.path}` : operation.kind === 'move' ? `Move ${operation.file.path} to ${operation.target}` : `Remove ${operation.file.path}`
      if (!(await askConfirm(`${description} in candidate generation ${candidate.generation}?${dirty ? ' Unsaved edits in the current file will be discarded.' : ''}`, operation.kind === 'remove' ? 'Remove from candidate' : operation.kind === 'move' ? 'Move file' : 'Create file'))) return
      const result = await call<{ workspace: Candidate }>('POST', `/v1/workspaces/${candidate.id}/patches`, payload)
      applied = true
      setMode(null); setName('')
      await onChanged(result.workspace, selected)
    } catch (e) { setError(`${applied ? 'File changed, but refresh failed: ' : ''}${e instanceof Error ? e.message : String(e)}`) }
    finally { setPending(false) }
  }
  const disabled = busy || pending
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-1">
      <Button disabled={disabled} onClick={() => { setMode('create'); setName(''); setError(null) }}>New file</Button>
      <Button disabled={disabled || !file} onClick={() => { setMode('move'); setName(file?.path ?? ''); setError(null) }}>Rename</Button>
      <Button disabled={disabled || !file} onClick={() => { if (file) void perform({ kind: 'remove', file: { ...file } }) }}>Remove</Button>
    </div>
    {mode && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (mode === 'create') void perform({ kind: 'create', path: name }); else if (file) void perform({ kind: 'move', file: { ...file }, target: name }) }}>
      <input autoFocus aria-label={mode === 'create' ? 'New file path' : 'Destination file path'} value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} placeholder="src/example.metta" className="min-h-9 w-full rounded-lg border border-line bg-black/25 px-2.5 font-mono text-xs" />
      <div className="flex gap-1"><Button type="submit" disabled={disabled || !name || (mode === 'move' && !file)}>{mode === 'create' ? 'Create empty file' : 'Move to this path'}</Button><Button type="button" disabled={disabled} onClick={() => setMode(null)}>Cancel</Button></div>
    </form>}
    {error && <p role="alert" className="break-words text-xs text-bad">File update needs attention: {error}</p>}
    <p className="text-[11px] text-ink-4">Candidate only. Existing destinations are never overwritten.</p>
  </div>
}
