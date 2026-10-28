/**
 * WorkbenchSuggestionPanel (kind: component), asked for by the OmegaCode owner: "minds alongside you" in the Code
 * workbench. Saved selection(s) -> human-issued scope -> a proposal (written by the person as explicit hunks, or, where a
 * route exists, by a mind from an instruction) -> retained proposal -> per-hunk decision -> one atomic ChangeSet, with
 * stale-remainder refusal. Contract: ./contract.ts (the implemented service contract).
 *
 * Availability is read from the hive's real answers (404 not_relayed, 503 service_unavailable), never from a count kept
 * here. The person-authored path uses only the relayed create route under the person's own session; the mind path is
 * shown as unavailable when the client has no route to dispatch an instruction (the live client has none yet).
 *
 * Rules kept here: a decision binds record.digest, the original hunk IDs and the proposal's own generation/tree; every
 * decision goes through DecisionDialog (full context, focus on the heading, held keys and the arming window refused);
 * unsaved editor edits are never overwritten (accepting into a dirty file refuses); an answer that never arrived is
 * retried only with the identical operation; nothing unavailable is shown as live.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { CodeContext, HiveClient } from '../../../api/client'
import { accepts, ARM_MS, bindTo } from '../../../lib/decisionGate'
import { cx } from '../../../lib/cx'
import { useIsDesktop } from '../../../lib/hooks'
import { DecisionDialog } from '../../../ui/DecisionDialog'
import { Icon } from '../../../ui/Icon'
import { parseCreateRecord, parseDecisionResult, parseHistoryPage, parseScopeRecord, parseSuggestionRead, PROPOSED_EXTENSION_GROUPS, verifyIntegrity, type ChangeSet, type Integrity, type SuggestionCreateRequest, type SuggestionHistoryItem, type SuggestionHunk, type SuggestionRead, type SuggestionScopeRecord, type WorkspaceHead } from './contract'
import { addRange, authoredMismatch, authoredProblem, authorLabel, createRequest, decisionRequest, describeFailure, diffRows, dirtyConflict, groupsOf, hunkStates, leftBehind, lineSpan, mergeHistory, newOperationId, personHunks, proposalSummary, rangeKey, receiptCheck, receiptOf, retryRequest, scopeRanges, stage, stagedProblem, type Choice, type Failure, type HunkState, type PendingDecision, type PickedRange, type Receipt, type Staged } from './model'
import { savedHunkRanges, savedSelection } from './savedSelection'
import { DEPENDENT_GROUPS, groupsProblem, identity, useCodeFeatures } from '../canvas/features'

export interface SavedFile {
  path: string
  content: string
  digest: string
}

const short = (s: string, n = 12) => (s.length > n ? `${s.slice(0, n)}…` : s)
const when = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Display-only view of a hunk's verified before text, positioned as whole lines. */
interface BeforeView {
  before: string
  first: number
  last: number
  prefix: string
  suffix: string
}

export function WorkbenchSuggestionPanel({
  client,
  ctx,
  ws,
  file,
  editorText,
  selection,
  dirty,
  onWorkspace,
  onOpenChanges,
}: {
  client: HiveClient | null
  ctx: CodeContext
  ws: WorkspaceHead
  /** The saved file open in the editor (service content + digest), or null. */
  file: SavedFile | null
  /** The editor's current text (differs from file.content while dirty). */
  editorText: string
  selection: { from: number; to: number } | null
  dirty: boolean
  /** The candidate moved (accepted ChangeSet, or another actor). `touched` are the paths whose source changed. */
  onWorkspace: (current: WorkspaceHead, touched: string[]) => Promise<void>
  onOpenChanges: () => void
}) {
  const desktop = useIsDesktop()
  const sim = !!client?.codeSimFixture
  const [availability, setAvailability] = useState<{ kind: 'probing' } | { kind: 'available' } | { kind: 'hidden'; why: string }>({ kind: 'probing' })
  const [history, setHistory] = useState<SuggestionHistoryItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [historyNote, setHistoryNote] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [read, setRead] = useState<SuggestionRead | null>(null)
  const [integrity, setIntegrity] = useState<Integrity | null>(null)
  const [befores, setBefores] = useState<Record<string, BeforeView>>({})
  const [staged, setStaged] = useState<Staged>({})
  const [scope, setScope] = useState<{ record: SuggestionScopeRecord; ranges: PickedRange[]; generation: number } | null>(null)
  const [selected, setSelected] = useState<PickedRange | { error: string } | null>(null)
  /** Ranges picked for the next scope (saved source only), in path/byte order. */
  const [picked, setPicked] = useState<PickedRange[]>([])
  const [instruction, setInstruction] = useState('')
  const canAsk = !!client?.codeSuggestionAsk
  // the loaded service's features for exactly this client and context: dependent groups are used only when it
  // declares them (Codex owner ruling §4); a changed context or a failed read fails closed (r3, stand-in P2-4)
  const capsCall = useCallback(<T,>(method: 'GET' | 'POST', path: string) => client!.codeProxy!<T>(method, path, { ...ctx }), [client, ctx])
  const caps = useCodeFeatures(client?.codeProxy ? capsCall : null, `${identity(client)}:${ctx.task_id}:${ctx.grant_id}:${ctx.repository_id}:${ws.id}`)
  const features = caps.features
  const [author, setAuthor] = useState<'person' | 'mind'>(canAsk ? 'mind' : 'person')
  /** The person's replacement text per scoped range (rangeKey -> text). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** A filed suggestion whose answer never arrived: retried only with the identical operation. */
  const [pendingCreate, setPendingCreate] = useState<{ request: SuggestionCreateRequest; unknown: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'bad' | 'ok' | 'info'; text: string } | null>(null)
  const [pending, setPending] = useState<PendingDecision | null>(null)
  const [reviewing, setReviewing] = useState<PendingDecision | null>(null)
  const [result, setResult] = useState<{ change?: ChangeSet; accepted: number; rejected: number; leftBehind: number } | null>(null)
  /** The last recorded decision and its receipt, for the identical-resend receipt check. */
  const [lastDecision, setLastDecision] = useState<{ request: PendingDecision['request']; receipt: Receipt } | null>(null)
  const seq = useRef(0)
  const proposalRef = useRef<HTMLElement>(null)
  const bannerRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // ----------------------------------------------------------------------------------------- availability + history

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!client?.codeSuggestionHistory) return
    try {
      const page = parseHistoryPage(await client.codeSuggestionHistory(ctx, ws.id, { limit: 20 }), ws.id)
      if (!alive.current) return
      setAvailability({ kind: 'available' })
      setHistory((cur) => mergeHistory(cur, page.items))
      setCursor((c) => c ?? page.next_cursor)
      setHistoryNote(null)
    } catch (e) {
      if (!alive.current) return
      const f = describeFailure(e)
      if (f.kind === 'unavailable') setAvailability({ kind: 'hidden', why: f.text })
      else {
        setAvailability({ kind: 'available' })
        setHistoryNote(`The proposal list did not load: ${f.text}`)
      }
    }
  }, [client, ctx, ws.id])

  const moreHistory = async () => {
    if (!cursor || !client?.codeSuggestionHistory) return
    try {
      const page = parseHistoryPage(await client.codeSuggestionHistory(ctx, ws.id, { limit: 20, cursor }), ws.id)
      setHistory((cur) => mergeHistory(cur, page.items))
      setCursor(page.next_cursor)
    } catch (e) {
      setHistoryNote(`More proposals did not load: ${describeFailure(e).text}`)
    }
  }

  // (re)list on open and whenever the candidate moves; work starts after the effect, never inside it
  useEffect(() => {
    void Promise.resolve().then(loadHistory)
  }, [loadHistory, ws.generation, ws.tree_digest])

  // ----------------------------------------------------------------------------------------- one proposal

  const loadBefores = useCallback(
    async (r: SuggestionRead) => {
      if (r.currency !== 'current' || !client?.codeProxy) return {}
      const out: Record<string, BeforeView> = {}
      for (const path of [...new Set(r.content.hunks.map((h) => h.path))]) {
        const f = await client.codeProxy<{ content: string; digest: string; generation: number }>('GET', `/v1/workspaces/${ws.id}/files`, { ...ctx, path, expected_generation: String(r.content.binding.generation) })
        const hunks = r.content.hunks.filter((h) => h.path === path)
        // display only: the saved text stands in for the editor text; the dirty-buffer rule is applied at decision time
        const views = await savedHunkRanges(new TextEncoder().encode(f.content), f.digest, f.content, hunks)
        for (const v of views) {
          const lineStart = f.content.lastIndexOf('\n', v.from - 1) + 1
          const end = f.content.indexOf('\n', v.to)
          const lineEnd = end === -1 ? f.content.length : end
          const span = lineSpan(f.content, v.from, v.to)
          out[v.id] = { before: v.before, first: span.first, last: span.last, prefix: f.content.slice(lineStart, v.from), suffix: v.before.endsWith('\n') ? '' : f.content.slice(v.to, lineEnd) }
        }
      }
      return out
    },
    [client, ctx, ws.id],
  )

  /** Read one proposal; only the newest read may change the panel (superseded answers are discarded). */
  const fetchProposal = useCallback(
    async (id: string): Promise<SuggestionRead | null> => {
      if (!client?.codeSuggestionRead) return null
      const mine = ++seq.current
      try {
        const r = parseSuggestionRead(await client.codeSuggestionRead(ctx, ws.id, id), { workspace_id: ws.id, suggestion_id: id })
        const check = await verifyIntegrity(r)
        if (mine !== seq.current || !alive.current) return null // superseded: a newer read owns the panel
        setRead(r)
        setIntegrity(check)
        setStaged((cur) => Object.fromEntries(Object.entries(cur).filter(([h]) => hunkStates(r).get(h)?.kind === 'open')))
        try {
          const views = await loadBefores(r)
          if (mine === seq.current && alive.current) setBefores((cur) => ({ ...cur, ...views }))
        } catch (e) {
          if (mine === seq.current && alive.current) setNote({ tone: 'bad', text: `The original text could not be verified: ${describeFailure(e).text}` })
        }
        return r
      } catch (e) {
        if (mine !== seq.current || !alive.current) return null
        setRead(null)
        setNote({ tone: 'bad', text: describeFailure(e).text })
        return null
      }
    },
    [client, ctx, ws.id, loadBefores],
  )
  const openProposal = useCallback(
    (id: string, keepStaged = false) => {
      setOpenId(id)
      if (!keepStaged) setStaged({})
      return fetchProposal(id)
    },
    [fetchProposal],
  )

  // a moved candidate re-reads the open proposal (its currency may now be stale)
  useEffect(() => {
    if (openId) void Promise.resolve(openId).then(fetchProposal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.generation, ws.tree_digest])

  // bring what just changed into view (DOM only)
  const openedId = read?.record.id
  useEffect(() => {
    if (openedId) proposalRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [openedId])
  useEffect(() => {
    if (result || pending?.unknown || note?.tone === 'bad') bannerRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [result, pending?.unknown, note])

  // ----------------------------------------------------------------------------------------- selection -> scope

  useEffect(() => {
    let live = true
    const go = async () => {
      if (!file || !selection || selection.from === selection.to) return null
      try {
        const bytes = new TextEncoder().encode(file.content)
        const s = await savedSelection(bytes, file.digest, editorText, selection.from, selection.to)
        const span = lineSpan(file.content, selection.from, selection.to)
        return { path: file.path, start_byte: s.start_byte, end_byte: s.end_byte, lines: span.first === span.last ? `line ${span.first}` : `lines ${span.first}–${span.last}`, text: file.content.slice(selection.from, selection.to) }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    void go().then((v) => live && setSelected(v))
    return () => {
      live = false
    }
  }, [file, selection, editorText])

  // picked ranges bind the saved source of one generation; a moved candidate drops them (never carried forward)
  const pickedGeneration = useRef(ws.generation)
  useEffect(() => {
    if (pickedGeneration.current === ws.generation) return
    pickedGeneration.current = ws.generation
    void Promise.resolve().then(() => setPicked([]))
  }, [ws.generation])

  const addSelected = () => {
    if (!selected || 'error' in selected) return
    const next = addRange(picked, selected)
    if (next.refused) setNote({ tone: 'bad', text: next.refused })
    else {
      setPicked(next.ranges)
      setNote(null)
    }
  }

  const mintScope = async () => {
    // the current selection counts when nothing was added yet (one-range scope in one click)
    const ranges = picked.length ? picked : selected && !('error' in selected) ? addRange([], selected).ranges : []
    if (!client?.codeSuggestionScope || !ranges.length || busy) return
    setBusy('scope')
    setNote(null)
    try {
      const raw = parseScopeRecord(await client.codeSuggestionScope(ctx, ws.id, { operation_id: newOperationId('scope'), expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, ranges: scopeRanges(ranges) }), ws.id)
      setScope({ record: raw, ranges, generation: ws.generation })
      setDrafts(Object.fromEntries(ranges.map((r) => [rangeKey(r), r.text])))
      setPicked([])
      setPendingCreate(null)
    } catch (e) {
      setNote({ tone: 'bad', text: `No scope was issued: ${describeFailure(e).text}` })
    } finally {
      setBusy(null)
    }
  }

  const ask = async () => {
    if (!client?.codeSuggestionAsk || !scope || scope.generation !== ws.generation || !instruction.trim() || busy) return
    setBusy('ask')
    setNote(null)
    try {
      const rec = (await client.codeSuggestionAsk(ctx, ws.id, { scope_id: scope.record.id, instruction })) as { id: string }
      await loadHistory()
      await openProposal(rec.id)
    } catch (e) {
      const f = describeFailure(e)
      if (f.kind === 'revoked' || f.kind === 'stale') setScope(null)
      setNote({ tone: 'bad', text: `No proposal was made: ${f.text}` })
    } finally {
      setBusy(null)
    }
  }

  /** File the person's own text as explicit hunks through the relayed create route (the person is the author). */
  const fileCreate = async (request: SuggestionCreateRequest) => {
    if (!client?.codeSuggestionCreate || busy) return
    setBusy('file')
    setNote(null)
    try {
      const rec = parseCreateRecord(await client.codeSuggestionCreate(ctx, ws.id, request), { workspace_id: ws.id, scope_id: request.scope_id })
      if (!alive.current) return
      setPendingCreate(null)
      await loadHistory()
      setOpenId(rec.id)
      setStaged({})
      const r = await fetchProposal(rec.id)
      if (!alive.current || !r) return
      // the retained proposal must be exactly what was written; anything else is said, never smoothed over
      const problems = authoredMismatch(r, request)
      setNote(problems.length ? { tone: 'bad', text: `The retained proposal differs from what you wrote: ${problems.join('; ')}. Do not accept it; reload and check.` } : { tone: 'ok', text: `Filed as ${rec.id}: ${request.hunks.length} hunk${request.hunks.length === 1 ? '' : 's'}, retained exactly as you wrote ${request.hunks.length === 1 ? 'it' : 'them'}. The service recorded the author as ${authorLabel(rec.author)} (your session).` })
    } catch (e) {
      if (!alive.current) return
      const f = describeFailure(e)
      if (f.kind === 'unknown') setPendingCreate({ request, unknown: `No definitive answer (${e instanceof Error ? e.message : String(e)}). The suggestion may or may not have been filed. Retrying sends the identical suggestion under the same operation; the service returns the original record if it was filed.` })
      else {
        setPendingCreate(null)
        if (f.kind === 'revoked' || f.kind === 'stale') setScope(null)
        setNote({ tone: 'bad', text: `No suggestion was filed: ${f.text}` })
      }
    } finally {
      setBusy(null)
    }
  }

  const fileAuthored = async () => {
    if (!scope || scope.generation !== ws.generation || busy) return
    const problem = authoredProblem(scope.ranges, drafts)
    if (problem) return setNote({ tone: 'bad', text: problem })
    await fileCreate(createRequest(scope.record.id, await personHunks(scope.ranges, drafts), newOperationId('suggest')))
  }

  // ----------------------------------------------------------------------------------------- decide

  const states = useMemo(() => (read ? hunkStates(read) : new Map<string, HunkState>()), [read])
  const groups = useMemo(() => (read ? groupsOf(read) : new Map<string, string[]>()), [read])
  const editor = useMemo(() => ({ path: file?.path ?? null, dirty }), [file, dirty])
  const grouped = read ? groupsProblem(read.content.hunk_groups, caps) : null
  const blockedWhy = !read ? null : grouped ? grouped : integrity && !integrity.ok ? `This proposal failed its integrity check (${integrity.problems[0]}). It cannot be decided.` : pending ? 'An earlier decision has no answer yet. Retry it or reload first.' : stagedProblem(read, staged) ?? dirtyConflict(read, staged, editor)

  const toggle = (h: SuggestionHunk, choice: Choice) => {
    if (!read) return
    const next = stage(read, staged, h.id, staged[h.id] === choice ? null : choice)
    if (next.refused) setNote({ tone: 'bad', text: next.refused })
    else {
      setStaged(next.staged)
      setNote(null)
    }
  }

  const review = () => {
    if (!read || blockedWhy) return
    setResult(null)
    setLastDecision(null)
    setReviewing({ request: decisionRequest(read, staged, newOperationId('decide')) })
  }

  const send = async (p: PendingDecision): Promise<true> => {
    if (!client?.codeSuggestionDecide || !read) return true
    const request = retryRequest(p)
    const decided = new Set([...request.accepted_hunk_ids, ...request.rejected_hunk_ids])
    const behind = leftBehind(read, {}).filter((h) => !decided.has(h.id)).length
    setPending(p)
    try {
      const r = parseDecisionResult(await client.codeSuggestionDecide(ctx, ws.id, request), request)
      if (!alive.current) return true
      setPending(null)
      if (p.resend) {
        const differs = receiptCheck(p.resend, r)
        setNote(differs ? { tone: 'bad', text: differs } : { tone: 'ok', text: `The service returned the original receipt: decision ${r.decision.id}${r.change ? `, ChangeSet ${r.change.id}` : ''}. Nothing was applied twice (the candidate is at generation ${r.workspace.generation}).` })
        await openProposal(request.suggestion_id, true)
        return true
      }
      setLastDecision({ request, receipt: receiptOf(r) })
      setStaged({})
      setResult({ change: r.change, accepted: request.accepted_hunk_ids.length, rejected: request.rejected_hunk_ids.length, leftBehind: r.change ? behind : 0 })
      setNote(null)
      if (r.change) await onWorkspace(r.workspace, r.change.paths)
      await loadHistory()
      await openProposal(request.suggestion_id, false)
    } catch (e) {
      if (!alive.current) return true
      const f: Failure = describeFailure(e)
      if (f.kind === 'unknown') setPending({ ...p, unknown: f.text })
      else {
        setPending(null)
        setStaged({}) // nothing was decided; the person chooses again on the re-read proposal
        if (f.kind === 'revoked') setScope(null) // a withdrawn issuer's scope is dead; a person must issue a fresh one
        setNote({ tone: 'bad', text: f.text })
        await openProposal(request.suggestion_id, true)
      }
    }
    return true
  }

  // ----------------------------------------------------------------------------------------- sim fixtures

  const fixture = async (action: 'external-edit' | 'revoke-issuer' | 'lose-next-answer' | 'revoke-grant') => {
    if (!client?.codeSimFixture || busy) return
    setBusy(action)
    try {
      const said = await client.codeSimFixture(action)
      setNote({ tone: 'info', text: `Simulator: ${said}` })
      if (action === 'external-edit' && client.codeProxy) {
        const current = await client.codeProxy<WorkspaceHead>('GET', `/v1/workspaces/${ws.id}`, { ...ctx })
        await onWorkspace(current, ['README.md'])
      }
    } finally {
      setBusy(null)
    }
  }

  const reload = async () => {
    if (busy) return
    setBusy('reload')
    try {
      if (client?.codeProxy) {
        const current = await client.codeProxy<WorkspaceHead>('GET', `/v1/workspaces/${ws.id}`, { ...ctx })
        if (current.generation !== ws.generation || current.tree_digest !== ws.tree_digest) await onWorkspace(current, [])
      }
      await loadHistory()
      if (openId) await openProposal(openId, true)
    } catch (e) {
      setNote({ tone: 'bad', text: `Reload failed: ${describeFailure(e).text}` })
    } finally {
      setBusy(null)
    }
  }

  // ----------------------------------------------------------------------------------------- render

  if (!client?.codeSuggestionHistory)
    return (
      <div className="space-y-2 p-4 text-[12.5px] text-ink-3" role="note">
        <h2 className="xc-heading text-[14px] font-semibold text-ink">Suggestions are not available here yet</h2>
        <p>This client has no suggestion calls, so nothing here can reach OmegaCode.</p>
      </div>
    )
  if (availability.kind === 'probing') return <div className="p-4 text-[12.5px] text-ink-3" role="status">Checking whether this hive relays suggestions…</div>
  if (availability.kind === 'hidden')
    return (
      <div className="space-y-2 p-4 text-[12.5px] text-ink-3" role="note" aria-label="Suggestions are not available">
        <h2 className="xc-heading text-[14px] font-semibold text-ink">Suggestions are not available here yet</h2>
        <p>{availability.why}</p>
        <p>Nothing here is offered as live until this hive answers the suggestion routes. The rest of the workbench is unaffected.</p>
        <button type="button" className="xc-button xc-subtle min-h-8 px-2 text-[12px]" onClick={() => { setAvailability({ kind: 'probing' }); void loadHistory() }}>
          Check again
        </button>
      </div>
    )

  const liveScope = scope && scope.generation === ws.generation ? scope : null
  const accepting = Object.values(staged).filter((c) => c === 'accept').length
  const rejecting = Object.values(staged).filter((c) => c === 'reject').length

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Suggestions">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="mind" size={14} />
        <h2 className="xc-heading min-w-0 flex-1 text-[13.5px] font-semibold text-ink">Suggestions</h2>
        {sim && <span className="rounded-full border border-warn/40 bg-warn/10 px-2 text-[10.5px] font-semibold text-warn" title={canAsk ? 'Simulator: invented source, invented mind, no live service' : 'Simulator: invented source, no live service, no mind route (as live)'}>invented sim data</span>}
        <button type="button" className="xc-button xc-subtle min-h-8 px-2 text-[12px]" disabled={!!busy} onClick={() => void reload()}>
          {busy === 'reload' ? 'Reloading…' : 'Reload'}
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3 pb-24 text-[12.5px]">
        <div ref={bannerRef} className="-mt-3 h-0 scroll-mt-3" aria-hidden />
        {note && (
          <p role={note.tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-lg border px-2.5 py-2 [overflow-wrap:anywhere]', note.tone === 'bad' ? 'border-bad/40 bg-bad/10 text-bad' : note.tone === 'ok' ? 'border-good/40 bg-good/10 text-good' : 'border-line bg-white/[0.03] text-ink-2')}>
            {note.text}
          </p>
        )}
        {pending?.unknown && (
          <div role="alert" className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-warn">
            <p className="font-semibold">Outcome unknown</p>
            <p className="[overflow-wrap:anywhere]">{pending.unknown}</p>
            <p className="text-ink-2">Same operation <span className="font-mono">{short(pending.request.operation_id, 24)}</span>, same {pending.request.accepted_hunk_ids.length} accept / {pending.request.rejected_hunk_ids.length} reject, bound to generation {pending.request.expected_generation}.</p>
            <div className="flex flex-wrap gap-2">
              <GatedButton className="xc-button xc-primary min-h-9 px-3" onActivate={() => void send(pending)} disabled={!!busy}>Retry the same decision</GatedButton>
              <button type="button" className="xc-button min-h-9 px-3" onClick={() => { setPending(null); void reload() }}>Reload instead</button>
            </div>
          </div>
        )}
        {result && (
          <div role="status" className="space-y-1.5 rounded-lg border border-good/40 bg-good/10 p-2.5 text-ink">
            <p className="font-semibold text-good">
              {result.accepted ? `Accepted ${result.accepted} hunk${result.accepted === 1 ? '' : 's'}` : 'Recorded'}
              {result.rejected ? `, rejected ${result.rejected}` : ''}
            </p>
            {result.change ? (
              <p className="[overflow-wrap:anywhere]">
                One atomic ChangeSet <span className="font-mono">{result.change.id}</span> moved the candidate to generation {result.change.generation} ({result.change.paths.join(', ')}).{' '}
                <button type="button" className="underline decoration-dotted underline-offset-2" onClick={onOpenChanges}>Open in Changes</button>
              </p>
            ) : (
              <p>Rejection is recorded in the decision history; source is unchanged.</p>
            )}
            {lastDecision && !pending && (
              <button type="button" className="xc-button xc-subtle min-h-8 px-2 text-[12px]" disabled={!!busy} onClick={() => setReviewing({ request: lastDecision.request, resend: lastDecision.receipt })}>
                Resend the identical decision (receipt check)
              </button>
            )}
            {result.leftBehind > 0 && <p className="text-ink-2">{result.leftBehind} undecided hunk{result.leftBehind === 1 ? ' is' : 's are'} now stale: the source moved, and {result.leftBehind === 1 ? 'it' : 'they'} can only come back as a fresh proposal on the new source.</p>}
          </div>
        )}

        <Section n={1} title="Selection scope">
          {scope && !liveScope && <p className="text-ink-3">The last scope bound generation {scope.generation}; the candidate has moved to generation {ws.generation}. A scope is never carried forward: select again.</p>}
          {liveScope ? (
            <div className="space-y-1.5">
              <ul className="space-y-0.5 text-ink" aria-label="Scoped ranges">
                {liveScope.ranges.map((r) => (
                  <li key={rangeKey(r)}><RangeLine r={r} /></li>
                ))}
              </ul>
              <p className="text-ink-3">Generation {liveScope.generation}. An edit ceiling only: it grants no edit, run, model or child-mind permission. Proposals must stay inside it.</p>
              <details className="text-ink-3">
                <summary className="cursor-pointer">Scope identity</summary>
                <p className="break-all font-mono text-[11px]">{liveScope.record.id} · {liveScope.record.digest} · {liveScope.record.author}</p>
              </details>
              <button type="button" className="xc-button xc-subtle min-h-8 px-2 text-[12px]" onClick={() => { setScope(null); setPendingCreate(null) }}>Choose another selection</button>
            </div>
          ) : (
            <div className="space-y-2">
              {!file ? (
                <p className="text-ink-3">Open a file and select the code that may change.</p>
              ) : !selected ? (
                <p className="text-ink-3">Select code in <span className="font-mono">{file.path}</span>. Only saved source can be scoped.</p>
              ) : 'error' in selected ? (
                <p role="alert" className="text-bad">{/dirty/.test(selected.error) ? 'You have unsaved edits. Save or discard them before choosing a scope: a scope binds exactly the saved source.' : `This selection cannot be scoped: ${selected.error}.`}</p>
              ) : (
                <div className="space-y-1.5" aria-label="Current selection">
                  <p className="text-ink"><RangeLine r={selected} /> · generation {ws.generation}</p>
                  <pre className="thin-scroll max-h-28 overflow-auto rounded-md border border-line bg-black/25 p-2 font-mono text-[11.5px] text-ink-2">{selected.text}</pre>
                  <button type="button" className="xc-button min-h-9 px-3" disabled={!!busy} onClick={addSelected}>Add this range</button>
                </div>
              )}
              {picked.length > 0 && (
                <div className="space-y-1">
                  <p className="eyebrow">Ranges for the scope ({picked.length})</p>
                  <ul className="space-y-1" aria-label="Ranges for the scope">
                    {picked.map((r) => (
                      <li key={rangeKey(r)} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-ink"><RangeLine r={r} /></span>
                        <button type="button" className="xc-button xc-subtle min-h-8 px-2 text-[12px]" aria-label={`Remove ${r.path} bytes ${r.start_byte}–${r.end_byte}`} onClick={() => setPicked((cur) => cur.filter((x) => rangeKey(x) !== rangeKey(r)))}>Remove</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(picked.length > 0 || (selected && !('error' in selected))) && (
                <button type="button" className="xc-button xc-primary min-h-9 px-3" disabled={!!busy || !client?.codeSuggestionScope} onClick={() => void mintScope()}>
                  {busy === 'scope' ? 'Issuing scope…' : picked.length > 1 ? `Use these ${picked.length} ranges as the edit scope` : 'Use as the edit scope'}
                </button>
              )}
            </div>
          )}
        </Section>

        <Section n={2} title="New proposal">
          <div className="flex gap-1" role="group" aria-label="Who writes the proposal">
            <button type="button" aria-pressed={author === 'person'} className={cx('xc-button min-h-8 flex-1 px-2 text-[12px]', author === 'person' && 'xc-primary')} onClick={() => setAuthor('person')}>Write it yourself</button>
            <button type="button" aria-pressed={author === 'mind'} className={cx('xc-button min-h-8 flex-1 px-2 text-[12px]', author === 'mind' && 'xc-primary')} onClick={() => setAuthor('mind')}>Instruction for a mind</button>
          </div>
          {author === 'person' ? (
            !liveScope ? (
              <p className="text-ink-3">Choose a scope first. Then write the new text for each range yourself; it is filed as your suggestion and decided like any other.</p>
            ) : (
              <div className="space-y-2" aria-label="Your suggestion">
                {liveScope.ranges.map((r) => {
                  const k = rangeKey(r)
                  const changed = drafts[k] !== undefined && drafts[k] !== r.text
                  return (
                    <div key={k} className="space-y-1">
                      <p className="text-ink-2"><RangeLine r={r} />{changed ? <span className="ml-1 text-good">· changed</span> : <span className="ml-1 text-ink-4">· unchanged (not filed)</span>}</p>
                      <p className="font-mono text-[11.5px] text-ink-3 [overflow-wrap:anywhere]">now: <span className="whitespace-pre-wrap text-ink-2">{r.text}</span></p>
                      <textarea value={drafts[k] ?? r.text} onChange={(e) => setDrafts((cur) => ({ ...cur, [k]: e.target.value }))} rows={Math.min(8, Math.max(1, r.text.split('\n').length))} spellCheck={false} aria-label={`New text for ${r.path} bytes ${r.start_byte}–${r.end_byte}`} className="xc-input w-full p-2 font-mono text-[12.5px]" />
                    </div>
                  )
                })}
                <p className="text-[11.5px] text-ink-3">You are the author. The service records the author from your signed-in session; no mind is involved. Each changed range is filed as one hunk that replaces that whole range.</p>
                {pendingCreate ? (
                  <div role="alert" className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-warn">
                    <p className="font-semibold">Outcome unknown</p>
                    <p className="[overflow-wrap:anywhere]">{pendingCreate.unknown}</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="xc-button xc-primary min-h-9 px-3" disabled={!!busy} onClick={() => void fileCreate(pendingCreate.request)}>Retry filing the same suggestion</button>
                      <button type="button" className="xc-button min-h-9 px-3" onClick={() => { setPendingCreate(null); void reload() }}>Reload instead</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="xc-button xc-primary min-h-9 px-3" disabled={!!busy || !client?.codeSuggestionCreate} onClick={() => void fileAuthored()}>
                    {busy === 'file' ? 'Filing…' : 'File as a suggestion'}
                  </button>
                )}
              </div>
            )
          ) : canAsk ? (
            <>
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} aria-label="Instruction for a mind" placeholder="What should change inside the scope?" className="xc-input w-full p-2 text-[13px]" />
              <button type="button" className="xc-button xc-primary mt-2 min-h-9 px-3" disabled={!!busy || !liveScope || !instruction.trim()} onClick={() => void ask()} title={!liveScope ? 'Choose a scope first' : undefined}>
                {busy === 'ask' ? 'The mind is proposing…' : 'Ask a mind'}
              </button>
              {sim && <p className="mt-1 text-[11.5px] text-ink-4">Simulator: an invented mind answers. It is not a real model.</p>}
            </>
          ) : (
            <div role="note" aria-label="Instruction for a mind is not available" className="space-y-1.5">
              <textarea disabled rows={2} aria-label="Instruction for a mind" placeholder="Not available here yet" className="xc-input w-full p-2 text-[13px] opacity-50" />
              <p className="text-ink-2">Not available yet: this hive has no route that sends an instruction to a mind, so nothing would receive it. Nothing is sent from here.</p>
              <p className="text-ink-3">You can write the change yourself instead. A proposal a mind files through its own suggestion action still appears under Proposals.</p>
            </div>
          )}
        </Section>

        <Section n={3} title="Proposals">
          {historyNote && <p role="alert" className="text-bad">{historyNote}</p>}
          {!history.length ? (
            <p className="text-ink-3">No retained proposals on this workspace yet.</p>
          ) : (
            <ul className="space-y-1">
              {history.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => void openProposal(h.id)} aria-current={h.id === openId ? 'true' : undefined} className={cx('xc-item flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left', h.id === openId && 'bg-white/[0.07]')}>
                    <span className="min-w-0 flex-1 truncate text-ink">{authorLabel(h.author)} · {h.hunk_count} hunk{h.hunk_count === 1 ? '' : 's'}</span>
                    <Currency c={h.currency} />
                    <span className="w-full text-[11px] text-ink-3">{when(h.created_at)} · generation {h.generation} · {h.accepted_count} accepted · {h.rejected_count} rejected</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cursor && <button type="button" className="xc-button xc-subtle mt-1 min-h-8 px-2 text-[12px]" onClick={() => void moreHistory()}>Older proposals</button>}
        </Section>

        {read && (
          <section ref={proposalRef} aria-label="Proposal" className="scroll-mt-2 space-y-2">
            <div className="rounded-lg border border-line p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-ink">Proposal by {authorLabel(read.record.author)}</span>
                <Currency c={read.currency} />
              </div>
              <p className="mt-1 text-ink-2">{proposalSummary(read)}</p>
              <p className="mt-1 text-ink-3">
                Bound to generation {read.content.binding.generation} · scope{' '}
                {Object.entries(read.content.scope).map(([p, r]) => `${p} bytes ${r.map(([a, z]) => `${a}–${z}`).join(', ')}`).join('; ')}
              </p>
              {integrity && (integrity.ok ? <p className="mt-1 text-good">Integrity verified in this browser: hunk IDs, proposal digest and record digest.</p> : <p role="alert" className="mt-1 text-bad">Integrity check failed: {integrity.problems.join('; ')}</p>)}
              {read.content.hunk_groups && !(caps.status === 'ready' && features.has(DEPENDENT_GROUPS)) && (
                <p className="mt-1 text-[11.5px] text-warn">
                  This proposal names dependency groups (“{PROPOSED_EXTENSION_GROUPS}”). {groupsProblem(read.content.hunk_groups, caps)}{' '}
                  {caps.status === 'failed' && <button type="button" className="underline decoration-dotted underline-offset-2" onClick={caps.retry}>Check again</button>}
                </p>
              )}
              {read.currency === 'stale' && <p className="mt-1 text-ink-2">The source has changed since this was proposed. Undecided hunks are stale and cannot be accepted or rejected here; there is no automatic rebase.</p>}
              <details className="mt-1 text-ink-3">
                <summary className="cursor-pointer">Identities</summary>
                <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 font-mono text-[11px]">
                  <dt>proposal</dt><dd className="break-all">{read.record.id}</dd>
                  <dt>record digest</dt><dd className="break-all">{read.record.digest}</dd>
                  <dt>tree</dt><dd className="break-all">{read.content.binding.tree_digest}</dd>
                  <dt>scope</dt><dd className="break-all">{read.content.scope_id}</dd>
                  {read.decisions.map((d) => (
                    <div key={d.id} className="contents"><dt>decision</dt><dd className="break-all">{d.id} · {d.actor}{d.change_id ? ` · ${d.change_id}` : ''}</dd></div>
                  ))}
                </dl>
              </details>
            </div>
            <ol className="space-y-2">
              {read.content.hunks.map((h, i) => (
                <HunkCard key={h.id} index={i + 1} hunk={h} state={states.get(h.id) ?? { kind: 'stale' }} group={groups.get(h.id) ?? [h.id]} hunks={read.content.hunks} before={befores[h.id]} staged={staged[h.id]} sideBySide={desktop} onToggle={toggle} />
              ))}
            </ol>
          </section>
        )}

        {sim && (
          <details className="rounded-lg border border-dashed border-warn/40 p-2.5 text-ink-3">
            <summary className="cursor-pointer text-warn">Simulator cases (invented)</summary>
            <p className="mt-1">Drive the qualification cases the live flow must also pass.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="xc-button min-h-8 px-2 text-[12px]" disabled={!!busy} onClick={() => void fixture('external-edit')}>Another actor edits</button>
              <button type="button" className="xc-button min-h-8 px-2 text-[12px]" disabled={!!busy} onClick={() => void fixture('revoke-issuer')}>Revoke the scope issuer</button>
              <button type="button" className="xc-button min-h-8 px-2 text-[12px]" disabled={!!busy} onClick={() => void fixture('lose-next-answer')}>Lose the next answer</button>
              <button type="button" className="xc-button min-h-8 px-2 text-[12px]" disabled={!!busy} onClick={() => void fixture('revoke-grant')}>Revoke the edit grant (hive)</button>
            </div>
          </details>
        )}
      </div>

      {read && (accepting > 0 || rejecting > 0) && read.currency === 'current' && (
        <div className="border-t border-line bg-black/20 px-3 py-2">
          {blockedWhy && <p className="mb-1.5 text-[12px] text-ink-2 [overflow-wrap:anywhere]" id="suggestion-blocked">{blockedWhy}</p>}
          <button type="button" className="xc-button xc-primary min-h-10 w-full px-3 text-[13px] aria-disabled:cursor-not-allowed aria-disabled:opacity-45" aria-disabled={!!blockedWhy} aria-describedby={blockedWhy ? 'suggestion-blocked' : undefined} onClick={review}>
            Review decision: accept {accepting}, reject {rejecting}
          </button>
        </div>
      )}

      {reviewing?.resend && read && (
        <DecisionDialog
          icon="check"
          eyebrow="Suggestion decision · receipt check"
          title="Resend the identical decision"
          thing="This decision"
          bound={bindTo(
            { decision: reviewing.resend.decision_id },
            read.record.id === reviewing.request.suggestion_id ? { decision: read.decisions.find((d) => d.id === reviewing.resend!.decision_id)?.id } : undefined,
            ['decision'],
          )}
          facts={[
            ['Proposal', <span key="p" className="font-mono">{reviewing.request.suggestion_id}</span>],
            ['Operation', <span key="o" className="font-mono">{reviewing.request.operation_id} (the same one)</span>],
            ['Payload', `identical: accept ${reviewing.request.accepted_hunk_ids.length}, reject ${reviewing.request.rejected_hunk_ids.length}, bound to generation ${reviewing.request.expected_generation}`],
            ['Original receipt', <span key="r" className="font-mono">{reviewing.resend.decision_id}{reviewing.resend.change_id ? ` · ${reviewing.resend.change_id}` : ''}</span>],
            ['Expected', 'The service returns that original receipt. Nothing is applied again; the candidate does not move.'],
          ]}
          actions={[{ label: 'Resend it', busyLabel: 'Resending', tone: 'primary', run: () => send(reviewing) }]}
          onClose={() => setReviewing(null)}
        />
      )}
      {reviewing && !reviewing.resend && read && (
        <DecisionDialog
          icon="check"
          eyebrow="Suggestion decision"
          title={decisionTitle(reviewing.request.accepted_hunk_ids.length, reviewing.request.rejected_hunk_ids.length)}
          thing="This proposal"
          bound={bindTo(
            { digest: reviewing.request.suggestion_digest, generation: reviewing.request.expected_generation, tree: reviewing.request.expected_tree_digest, currency: 'current' },
            read.record.id === reviewing.request.suggestion_id ? { digest: read.record.digest, generation: read.content.binding.generation, tree: read.content.binding.tree_digest, currency: read.currency } : undefined,
            ['digest', 'generation', 'tree', 'currency'],
            () => (read.currency !== 'current' ? 'The source changed (stale).' : dirtyConflict(read, staged, editor)),
          )}
          facts={decisionFacts(read, reviewing, befores, editor)}
          actions={[{ label: 'Record this decision', busyLabel: 'Recording', tone: 'primary', run: () => send(reviewing) }]}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  )
}

const hunks = (n: number) => `${n} hunk${n === 1 ? '' : 's'}`
function decisionTitle(accept: number, reject: number): string {
  if (accept && reject) return `Accept ${hunks(accept)}, reject ${hunks(reject)}`
  return accept ? `Accept ${hunks(accept)}` : `Reject ${hunks(reject)}`
}

function decisionFacts(read: SuggestionRead, p: PendingDecision, befores: Record<string, BeforeView>, editor: { path: string | null; dirty: boolean }): [string, ReactNode][] {
  const line = (id: string) => {
    const h = read.content.hunks.find((x) => x.id === id)!
    const b = befores[id]
    return (
      <span key={id} className="block">
        <span className="font-mono">{h.path}</span>
        {b ? (b.last !== b.first ? ` lines ${b.first}–${b.last}` : ` line ${b.first}`) : ''} · bytes {h.start_byte}–{h.end_byte}
        <span className="block font-mono text-[11px] text-ink-3 [overflow-wrap:anywhere]">hunk {id}</span>
        <span className="mt-0.5 block whitespace-pre-wrap rounded border border-line bg-black/20 p-1 font-mono text-[11.5px]">
          {b ? <><span className="text-bad">- {b.before || '(nothing)'}</span>{'\n'}</> : null}
          <span className="text-good">+ {h.replacement || '(removed)'}</span>
        </span>
      </span>
    )
  }
  const behind = read.content.hunks.filter((h) => hunkStates(read).get(h.id)?.kind === 'open' && !p.request.accepted_hunk_ids.includes(h.id) && !p.request.rejected_hunk_ids.includes(h.id))
  return [
    ['Proposal', <span key="p" className="font-mono">{read.record.id}</span>],
    ['Bound to', `generation ${p.request.expected_generation} · tree ${p.request.expected_tree_digest.slice(0, 16)}…`],
    ['Record digest', <span key="d" className="font-mono">{p.request.suggestion_digest}</span>],
    ['Accept', p.request.accepted_hunk_ids.length ? p.request.accepted_hunk_ids.map(line) : 'none'],
    ['Reject', p.request.rejected_hunk_ids.length ? p.request.rejected_hunk_ids.map(line) : 'none'],
    ['Left undecided', behind.length ? `${behind.length} hunk${behind.length === 1 ? '' : 's'}${p.request.accepted_hunk_ids.length ? ': these become stale once this is accepted and cannot be decided later' : ''}` : 'none'],
    ['Effect', p.request.accepted_hunk_ids.length ? 'One atomic ChangeSet on the candidate (not the running code). Nothing is deployed.' : 'Recorded in the decision history only; source is unchanged.'],
    ['Your editor', editor.dirty ? `Unsaved edits in ${editor.path} are kept as they are.` : 'No unsaved edits.'],
    ['Operation', <span key="o" className="font-mono">{p.request.operation_id}</span>],
  ]
}

function RangeLine({ r }: { r: PickedRange }) {
  return (
    <>
      <span className="font-mono">{r.path}</span> · {r.lines} · bytes {r.start_byte}–{r.end_byte}
    </>
  )
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="eyebrow flex items-center gap-1.5">
        <span className="inline-flex size-4 items-center justify-center rounded-full border border-line text-[10px]">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  )
}

function Currency({ c }: { c: 'current' | 'stale' }) {
  return <span className={cx('rounded-full border px-1.5 text-[10.5px] font-semibold', c === 'current' ? 'border-good/40 text-good' : 'border-warn/40 text-warn')}>{c === 'current' ? 'current source' : 'stale'}</span>
}

const STATE_LABEL: Record<HunkState['kind'], string> = { accepted: 'accepted', rejected: 'rejected', stale: 'stale: cannot be decided', open: 'waiting for you' }

function HunkCard({ index, hunk, state, group, hunks, before, staged, sideBySide, onToggle }: { index: number; hunk: SuggestionHunk; state: HunkState; group: string[]; hunks: SuggestionHunk[]; before?: BeforeView; staged?: Choice; sideBySide: boolean; onToggle: (h: SuggestionHunk, c: Choice) => void }) {
  const rows = before ? diffRows(before.before, hunk.replacement, before.first, before.prefix, before.suffix) : null
  const others = group.filter((id) => id !== hunk.id).map((id) => hunks.findIndex((h) => h.id === id) + 1)
  // a held Enter/Space never toggles again (browsers repeat clicks on a held key)
  const noRepeat = (e: KeyboardEvent) => {
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
  }
  return (
    <li className={cx('rounded-lg border p-2', staged === 'accept' ? 'border-good/50' : staged === 'reject' ? 'border-bad/50' : 'border-line')} aria-label={`Hunk ${index}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11.5px] text-ink">
          {index}. {hunk.path}
          {before ? ` · line${before.first === before.last ? '' : 's'} ${before.first}${before.first === before.last ? '' : `–${before.last}`}` : ` · bytes ${hunk.start_byte}–${hunk.end_byte}`}
        </span>
        <span className={cx('rounded-full border px-1.5 text-[10.5px]', state.kind === 'accepted' ? 'border-good/40 text-good' : state.kind === 'rejected' ? 'border-bad/40 text-bad' : state.kind === 'stale' ? 'border-warn/40 text-warn' : 'border-line text-ink-3')}>{STATE_LABEL[state.kind]}</span>
        {others.length > 0 && <span className="rounded-full border border-accent/40 px-1.5 text-[10.5px] text-accent-2" title="Dependent hunks are accepted or rejected together">with {others.map((n) => `#${n}`).join(', ')}</span>}
      </div>
      {rows ? (
        sideBySide ? (
          <div className="mt-1.5 grid grid-cols-2 gap-px overflow-hidden rounded border border-line bg-line font-mono text-[11.5px]" role="table" aria-label="Before and after, side by side">
            {rows.map((r, i) => (
              <div key={i} className="contents" role="row">
                <div role="cell" className={cx('flex min-w-0 gap-2 px-1.5 py-0.5', r.left ? 'bg-bad/10' : 'bg-black/30')}><span className="w-6 shrink-0 text-right text-ink-4">{r.left?.n}</span><span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-2">{r.left?.text}</span></div>
                <div role="cell" className={cx('flex min-w-0 gap-2 px-1.5 py-0.5', r.right ? 'bg-good/10' : 'bg-black/30')}><span className="w-6 shrink-0 text-right text-ink-4">{r.right?.n}</span><span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">{r.right?.text}</span></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1.5 overflow-hidden rounded border border-line font-mono text-[11.5px]" aria-label="Unified diff">
            {rows.filter((r) => r.left).map((r, i) => <div key={`l${i}`} className="flex gap-2 bg-bad/10 px-1.5 py-0.5"><span className="text-bad">-</span><span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-2">{r.left!.text}</span></div>)}
            {rows.filter((r) => r.right).map((r, i) => <div key={`r${i}`} className="flex gap-2 bg-good/10 px-1.5 py-0.5"><span className="text-good">+</span><span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">{r.right!.text}</span></div>)}
          </div>
        )
      ) : (
        <div className="mt-1.5 space-y-1">
          <p className="text-[11.5px] text-ink-3">The original text is not shown: it is not the current source and was not verified in this session. Suggested text:</p>
          <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded border border-line bg-good/10 p-1.5 font-mono text-[11.5px] text-ink">{hunk.replacement || '(removes the range)'}</pre>
        </div>
      )}
      {state.kind === 'open' && (
        <div className="mt-2 flex gap-2" role="group" aria-label={`Decision for hunk ${index}`}>
          <button type="button" aria-pressed={staged === 'accept'} onClick={() => onToggle(hunk, 'accept')} onKeyDown={noRepeat} className={cx('xc-button min-h-9 flex-1 px-2 text-[12.5px]', staged === 'accept' && 'xc-primary')}>
            {staged === 'accept' ? '✓ Accept' : 'Accept'}
          </button>
          <button type="button" aria-pressed={staged === 'reject'} onClick={() => onToggle(hunk, 'reject')} onKeyDown={noRepeat} className={cx('xc-button min-h-9 flex-1 px-2 text-[12.5px]', staged === 'reject' && 'xc-danger')}>
            {staged === 'reject' ? '✕ Reject' : 'Reject'}
          </button>
        </div>
      )}
      {(state.kind === 'accepted' || state.kind === 'rejected') && (
        <p className="mt-1.5 text-[11.5px] text-ink-3 [overflow-wrap:anywhere]">
          {state.kind === 'accepted' ? 'Accepted' : 'Rejected'} by {state.decision.actor} at {when(state.decision.created_at)}{state.decision.change_id ? ` · ChangeSet ${state.decision.change_id}` : ''}
        </p>
      )}
    </li>
  )
}

/** A button that refuses held keys and any activation inside the arming window after it appears (decisionGate). */
function GatedButton({ onActivate, disabled, className, children }: { onActivate: () => void; disabled?: boolean; className?: string; children: ReactNode }) {
  const [armed] = useState(() => performance.now())
  return (
    <button
      type="button"
      className={className}
      aria-disabled={disabled}
      title={`Activates ${ARM_MS} ms after it appears; held keys never activate it`}
      onKeyDown={(e) => {
        if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
      }}
      onClick={() => {
        if (disabled || !accepts({ at: performance.now() }, armed)) return
        onActivate()
      }}
    >
      {children}
    </button>
  )
}
