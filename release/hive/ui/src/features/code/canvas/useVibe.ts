/**
 * Vibe coding on the Code canvas: say what you want → it travels as an Ask turn and one `code.request` linkage intent →
 * the Code team's proposal is written into the code in place, with its caret, ink and notes → a plain summary → where
 * the hive puts proposals into the copy itself (copy-apply on), it is in your copy with Undo; otherwise keep or skip
 * each change → Accept/Reject through the existing confirm (DecisionDialog). The flow and its rules live in
 * ./vibeSession (request-fenced, identity-bound, file-bound, integrity per read); this hook connects it to React.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { CodeContext, HiveClient } from '../../../api/client'
import type { WorkspaceHead } from '../suggestions/contract'
import type { Choice, PendingDecision } from '../suggestions/model'
import type { Caps } from './features'
import type { FunctionPick } from './functionPick'
import { VibeSession, type SavedFile, type VibeState } from './vibeSession'
import { intentsClient } from './vibeRoute'
import { onIdentityChange } from '../../../lib/identityEpoch'

export { wholeLines, type SavedFile, type VibePhase, type Placed } from './vibeSession'

export function useVibe({ client, ctx, ws, file, dirty, onWorkspace, reduced, caps, turn }: {
  client: HiveClient | null
  ctx: CodeContext | null
  ws: WorkspaceHead | null
  file: SavedFile | null
  dirty: boolean
  onWorkspace: (current: WorkspaceHead, touched: string[]) => Promise<void>
  reduced: boolean
  /** the loaded service's features for this context (canvas/features): gate plain summaries and dependent groups */
  caps: Pick<Caps, 'status' | 'features'>
  /** the person's words as an Ask turn (askBridge useAskTurn): its operation id */
  turn?: (words: string) => Promise<string>
}) {
  const session = useMemo(() => new VibeSession(), [])
  useEffect(() => () => session.dispose(), [session])
  // a change of person: everything shown for the earlier one goes at once (its late answers are dropped by the binding)
  useEffect(() => onIdentityChange(() => session.reset()), [session])
  useEffect(() => {
    session.setDeps({ client, ctx, ws, onWorkspace, turn })
  })
  const s = useSyncExternalStore(session.subscribe, session.getState, session.getState)

  // the candidate moved under an open proposal: re-read and re-verify it (a stale one can only be dismissed)
  const bound = s.result?.read.content.binding.generation
  useEffect(() => {
    if (bound === undefined || !ws || bound === ws.generation) return
    session.setDeps({ client, ctx, ws, onWorkspace, turn })
    if (session.getState().phase.kind === 'applied' || session.getState().phase.kind === 'undone') return
    void session.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.generation])

  return {
    ...vibeFields(session, s, { client, file, dirty, caps }),
    ask: useCallback((words: string, range: { from: number; to: number } | null, who: (a: string) => string, fn?: FunctionPick | null) => session.ask(words, range, file, dirty, who, reduced, fn), [session, file, dirty, reduced]),
    choose: useCallback((id: string, c: Choice) => session.choose(id, c), [session]),
    review: useCallback((all?: 'reject') => session.review(file, dirty, caps, all), [session, file, dirty, caps]),
    send: useCallback((p: PendingDecision) => session.send(p), [session]),
    finish: useCallback(() => session.finish(), [session]),
    reset: useCallback(() => session.reset(), [session]),
    undo: useCallback(() => session.undo(), [session]),
    recheck: useCallback(() => session.recheck(), [session]),
    setReviewing: useCallback((p: PendingDecision | null) => session.setReviewing(p), [session]),
    setNote: useCallback((n: string | null) => session.setNote(n), [session]),
  }
}

/**
 * Everything the canvas shows of the vibe flow, from the session's state (the hook adds the actions). Exported so the
 * rendered confirm can be tested over a real session (r4).
 */
export function vibeFields(session: VibeSession, s: VibeState, o: { client: HiveClient | null; file: SavedFile | null; dirty: boolean; caps: Pick<Caps, 'status' | 'features'> }) {
  const { client, file, dirty, caps } = o
  const r = s.result
  const onFile = VibeSession.onFile(r, file, dirty)
  return {
    phase: s.phase,
    available: !!intentsClient(client),
    route: s.route,
    lands: s.lands,
    verify: s.verify,
    applied: s.applied,
    undoing: s.undo,
    instruction: r?.instruction ?? s.asking?.instruction ?? null,
    scope: r?.scope ?? s.asking?.scope ?? null,
    result: r,
    read: r?.read ?? null,
    /** the verdict only when it is for the read on screen */
    integrity: r && r.integrity.digest === r.read.record.digest ? r.integrity : null,
    /** placed changes only on the exact saved file they were placed on */
    placed: onFile && r ? r.placed : [],
    elsewhere: r?.elsewhere ?? [],
    onFile,
    staged: s.staged,
    presence: onFile ? s.presence : s.presence.count ? { ...s.presence, caret: null, selection: null, inks: [], notes: [] } : s.presence,
    pending: s.pending,
    reviewing: s.reviewing,
    note: s.note,
    blockedWhy: session.blockedWhy(file, dirty, caps),
    changeViews: session.changeViews(file, dirty),
    summary: r ? { text: (mind: string) => session.summary(mind, caps) } : null,
    facts: (p: PendingDecision, headline: string) => session.facts(p, headline),
  }
}
