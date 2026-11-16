/**
 * Language features on the Code canvas (phase 2, row 25): go to definition, rename with a preview of every change, and
 * completions previewed in place. The state and every rule live in ./languageSession (keyed to the context, fail
 * closed, previews bound to what made them, answers matched by identity); this hook only connects it to React.
 */
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { WorkspaceHead } from '../suggestions/contract'
import { LanguageSession, type SavedFile } from './languageSession'

export type { RenameFile, RenameState, CompletionState, SavedFile } from './languageSession'
type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

export function useLanguage({ call, ws, ctxKey, features, file, dirty, onWorkspace }: { call: Call | null; ws: (WorkspaceHead & { generation: number }) | null; ctxKey: string; features: ReadonlySet<string>; file: SavedFile | null; dirty: boolean; onWorkspace: (w: WorkspaceHead, touched: string[]) => Promise<void> }) {
  const session = useMemo(() => new LanguageSession(onWorkspace), []) // eslint-disable-line react-hooks/exhaustive-deps
  // the context is set before paint, so nothing from an earlier one is ever drawn or applied under a new one
  useLayoutEffect(() => {
    session.setContext({ key: ctxKey, call, ws, features }, onWorkspace)
  })
  const s = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const path = file?.path ?? null
  return {
    offer: session.offer(path),
    server: session.server(path),
    busy: s.busy,
    note: s.note,
    rename: s.rename,
    completion: s.completion,
    renameBlocked: s.rename ? session.renameBlocked() : null,
    completionBlocked: s.completion?.preview ? session.completionBlocked() : null,
    setNote: useCallback((n: string | null) => session.setNote(n), [session]),
    setRename: useCallback((_: null) => session.clearRename(), [session]),
    setCompletion: useCallback((_: null) => session.clearCompletion(), [session]),
    definition: useCallback((at: number) => session.definition(file, dirty, at), [session, file, dirty]),
    previewRename: useCallback((at: number, from: string, to: string) => session.previewRename(file, dirty, at, from, to), [session, file, dirty]),
    applyRename: useCallback(() => session.applyRename(), [session]),
    complete: useCallback((at: number) => session.complete(file, dirty, at), [session, file, dirty]),
    choose: useCallback((i: number) => session.choose(i, file), [session, file]),
    applyCompletion: useCallback(() => session.applyCompletion(), [session]),
  }
}
