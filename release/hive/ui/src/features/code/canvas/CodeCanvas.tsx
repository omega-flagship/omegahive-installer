import { CODE_TEST_UNAVAILABLE } from '../testIntent'
/**
 * The Code workbench as one living canvas (Surface, LIVING_CANVAS_REDESIGN_OUTLINE "Code workbench", phase 1).
 *
 * The file you are on fills the screen; the files beside it are faint in the top line; a minimap shows where you are.
 * Saying what you want is the main way in: select something and press Change… (or ⌘K for the whole file), and the
 * mind's proposal is written into the code in place, with its caret, ink and notes; then a plain summary; then Accept
 * or Reject through the existing confirm. Select a line or block and its actions appear beside it: Explain (the
 * universal Ask), Change…, Test. Test results appear beside the lines they name. Workspaces, the task and grant, the
 * change history, every raw tool and the full proposal record live in one drawer.
 *
 * The workbench's state, saving, grant handling and every pane are unchanged (CodePage's Workbench owns them); this is
 * presentation and interaction over the same calls.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import type { CodeContext, HiveClient } from '../../../api/client'
import { bindTo } from '../../../lib/decisionGate'
import { readContext } from '../../../lib/readContext'
import type { SandboxTestHandler, SandboxTestReferences } from '../CodePage'
import { cx } from '../../../lib/cx'
import { isTypingTarget, useEscape, useMediaQuery, useReducedMotion } from '../../../lib/hooks'
import { useHive } from '../../../store/store'
import { DecisionDialog } from '../../../ui/DecisionDialog'
import { Icon, type IconName } from '../../../ui/Icon'
import { useAskView } from '../../ask/view'
import { OWNS_SHORTCUT } from '../../../lib/shortcutOwner'
import type { WorkspaceHead } from '../suggestions/contract'
import { authorLabel } from '../suggestions/model'
import { useAskRoom, useAskSend, useAskTurn } from './askBridge'
import type { Layers } from './layers'
import { Minimap, type MiniMark } from './Minimap'
import { useTestRun } from './useTestRun'
import { identity, useCodeFeatures } from './features'
import { fromLsp, wordAt, type Location } from './language'
import { CompletionList, DefinitionChooser, RenameCard, RenamePrompt } from './LanguageParts'
import { useLanguage } from './useLanguage'
import { renameViews } from './languageSession'
import { WAITING_FOR_YOU } from './vibeConsent'
import type { VibePhase } from './vibeSession'
import { Iterations } from './IterationsDrawer'
import { MergeReviewCard } from './MergeReviewCard'
import { byteAt, defNameAt, parseFunctionPreview, utf16At, type FunctionPick } from './functionPick'
import type { ChangeView } from './layers'
import { useVibe, type SavedFile } from './useVibe'
import { enclosingName, scopeWords } from './vibe'
import './codeCanvas.css'
import { useAskFillable } from '../../ask/fields'
import type { EvidenceCall, EvidenceSubject } from '../suggestions/projectTestEvidence'
import { WorkStream, type WorkActions } from './work/WorkStream'
import { nextRoundInstruction, workStages, type TestView, type Work } from './work/stages'
import { useControllerState, useProposalTestEvidence, type ControllerApplied } from './work/useWorkReads'
import { ActionRefused, canvasApplyGate, driverOf, routeActions, type RoutedActions } from './work/actions'
import { matchFiles } from './work/fileMatch'
import type { VibeResult } from './vibeSession'
import { guardComposing } from '../../ask/keys'

const Editor = lazy(() => import('../Editor').then((r) => ({ default: r.Editor })))

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

export type DrawerTab = 'files' | 'changes' | 'proposals' | 'tests' | 'history' | 'iterations' | 'review' | 'merge' | 'export' | 'recovery' | 'runtimes' | 'symbolic' | 'debug' | 'session'
export const DRAWER_TABS: { id: DrawerTab; label: string; icon: IconName; hint: string }[] = [
  { id: 'files', label: 'Files', icon: 'doc', hint: 'Every file; new, rename, remove' },
  { id: 'changes', label: 'Changes', icon: 'history', hint: 'Everything changed in this copy so far' },
  { id: 'proposals', label: 'Proposals', icon: 'mind', hint: 'Every proposal and decision, in full; write a change yourself' },
  { id: 'tests', label: 'Tests', icon: 'play', hint: 'Run any allowed command; full output; record as evidence' },
  { id: 'history', label: 'Evidence', icon: 'shield', hint: 'Past runs and verifications' },
  { id: 'iterations', label: 'Iterations', icon: 'history', hint: 'A quiet record of each attempt: what ran, its evidence, where it stood' },
  { id: 'review', label: 'Review', icon: 'columns', hint: 'Review and apply hunks selectively' },
  { id: 'merge', label: 'Merge', icon: 'layers', hint: 'Merge previews and conflicts' },
  { id: 'export', label: 'Git export', icon: 'external', hint: 'Export a commit or patch' },
  { id: 'recovery', label: 'Checkpoints', icon: 'reset', hint: 'Save a checkpoint; restore source' },
  { id: 'runtimes', label: 'Runtimes', icon: 'cpu', hint: 'Toolchains this copy runs with' },
  { id: 'symbolic', label: 'Symbolic', icon: 'graph', hint: 'A MeTTa session on this copy' },
  { id: 'debug', label: 'Debug', icon: 'bolt', hint: 'Step through a Python run' },
  { id: 'session', label: 'Session', icon: 'token', hint: 'Task, edit grant and workspace ids; stop editing' },
]

export interface CodeCanvasProps {
  label: string
  eyebrow: string
  client: HiveClient | null
  ctx: CodeContext | null
  call: Call | null
  ws: (WorkspaceHead & { generation: number }) | null
  files: string[]
  path: string | null
  file: SavedFile | null
  text: string
  dirty: boolean
  busy: string | null
  selection: { from: number; to: number } | null
  onText: (t: string) => void
  onSelect: (s: { from: number; to: number } | null) => void
  openFile: (p: string) => Promise<void> | void
  save: () => void
  onWorkspace: (current: WorkspaceHead, touched: string[]) => Promise<void>
  /** The existing panes, by drawer tab (CodePage's Workbench renders them; stateful panes stay mounted, hidden). */
  drawer: (tab: DrawerTab, go: (t: DrawerTab | null) => void) => ReactNode
  /** Notices the workbench must show (the grant was refused, …). */
  banner?: ReactNode
  /** Said while there is no workspace yet. */
  waiting?: string | null
  onBack: () => void
  onClose: () => void
  /** Keep ordinary runtime tools disconnected; sandbox Test is a separate original-intent seam. */
  embedded?: boolean
  sandboxTestAvailable?: boolean
  proposalOnly?: boolean
  onSandboxTest?: SandboxTestHandler
  sandboxTestStatus?: ReactNode
  backLabel?: string
}

const PROPOSAL_TABS: ReadonlySet<DrawerTab> = new Set(['files', 'changes', 'proposals', 'tests', 'history', 'session'])
const base = (p: string) => p.split('/').pop() ?? p
const NOTHING_DECLARED: ReadonlySet<string> = new Set()
const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length
/** one shown proposal, exactly (its record and digest), in one work context: the test on a copy is asked once per key */
const proposalKey = (context: unknown, r: VibeResult) => `${String(context)}|${r.read.record.id}|${r.read.record.digest}`

export function CodeCanvas(p: CodeCanvasProps) {
  const reduced = useReducedMotion()
  const phone = useMediaQuery('(max-width: 699px)')
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const { room, present } = useAskRoom()
  const askSend = useAskSend()
  const askTurn = useAskTurn({ openThread: !p.embedded })
  const [view, setView] = useState<EditorView | null>(null)
  const [drawer, setDrawerState] = useState<DrawerTab | null>(null)
  const tabAllowed = (tab: DrawerTab) => !p.proposalOnly || PROPOSAL_TABS.has(tab)
  // once opened, the drawer stays mounted (hidden when closed): an open merge, export or session keeps its state
  const [lastTab, setLastTab] = useState<DrawerTab | null>(null)
  const setDrawer = useCallback((t: DrawerTab | null | ((d: DrawerTab | null) => DrawerTab | null)) => {
    setDrawerState((d) => {
      const next = typeof t === 'function' ? t(d) : t
      if (next && p.proposalOnly && !PROPOSAL_TABS.has(next)) return d
      if (next) setLastTab(next)
      return next
    })
  }, [p.proposalOnly])
  const toggleDrawer = useCallback(() => setDrawer(drawer ? null : (lastTab ?? 'files')), [drawer, lastTab, setDrawer])
  const [quick, setQuick] = useState(false)
  const [prompt, setPrompt] = useState<{ range: { from: number; to: number } | null } | null>(null)
  const [said, setSaid] = useState('')
  const canvasRef = useRef<HTMLElement>(null)

  const who = useCallback(
    (author: string) => {
      const id = author.startsWith('agent:') ? author.slice(6) : null
      return (id && agents[id]?.name) || authorLabel(author)
    },
    [agents],
  )
  // what the service supports, for exactly this client and work context (fails closed on any change; r3)
  const caps = useCodeFeatures(p.call, `${identity(p.client)}:${p.ctx?.task_id ?? ''}:${p.ctx?.grant_id ?? ''}:${p.ctx?.repository_id ?? ''}:${p.ws?.id ?? ''}`)
  const vibe = useVibe({ client: p.client, ctx: p.ctx, ws: p.ws, file: p.file, dirty: p.dirty, onWorkspace: p.onWorkspace, reduced, caps, turn: askTurn })
  const tests = useTestRun(p.proposalOnly ? null : p.call, p.ws)
  const [sandboxPending, setSandboxPending] = useState(false)
  // the work stream's test on a copy: which proposal it was asked for, and how the asking went
  const [testAsk, setTestAsk] = useState<{ key: string; kind: 'asking' | 'sent' | 'error'; text?: string } | null>(null)
  const sandboxBusy = useRef(false)
  const sandboxSequence = useRef(0)
  const sandboxLive = useRef(true)
  const sandboxContext = readContext(p.client, p.ctx?.task_id, p.ctx?.grant_id, p.ws?.id)
  const sandboxCurrent = useRef(sandboxContext)
  sandboxCurrent.current = sandboxContext
  const sandboxInputs = useRef({ text: p.text, path: p.path, file: p.file, result: vibe.result, available: !p.proposalOnly || p.sandboxTestAvailable === true })
  sandboxInputs.current = { text: p.text, path: p.path, file: p.file, result: vibe.result, available: !p.proposalOnly || p.sandboxTestAvailable === true }
  useEffect(() => { sandboxLive.current = true; return () => { sandboxLive.current = false; ++sandboxSequence.current } }, [])
  useEffect(() => {
    ++sandboxSequence.current; sandboxBusy.current = false; setSandboxPending(false); setTestAsk(null)
  }, [sandboxContext])
  const lang = useLanguage({ call: p.proposalOnly ? null : p.call, ws: p.ws, ctxKey: caps.key, features: !p.proposalOnly && caps.status === 'ready' ? caps.features : NOTHING_DECLARED, file: p.file, dirty: p.dirty, onWorkspace: p.onWorkspace })
  // language features in context (phase 2): where to land after "go to definition", the rename being asked for, and
  // the definition chooser when there is more than one place
  // `stale`: the text on screen when a jump to another file was asked for (land only once the new file's text arrives;
  // the workbench switches the path before the new text has loaded)
  const [reveal, setReveal] = useState<{ loc: Location; stale: string | null } | null>(null)
  const [renameAsk, setRenameAsk] = useState<{ at: number; name: string } | null>(null)
  const [chooser, setChooser] = useState<{ locations: Location[]; at: number } | null>(null)
  // a whole function picked by the service's parser (phase 2, row 26); it counts while it is exactly the selection
  const [pick, setPick] = useState<FunctionPick | null>(null)
  const [fnUnavailable, setFnUnavailable] = useState<string | null>(null)
  const mindId = vibe.read?.record.author.startsWith('agent:') ? vibe.read.record.author.slice(6) : null
  const mind = vibe.read ? { name: who(vibe.read.record.author), hue: (mindId && agents[mindId]?.hue) || 280 } : null

  // ---------------------------------------------------------------- the selection, in lines
  const sel = p.selection && p.selection.to > p.selection.from ? p.selection : null
  const selLines = sel ? { first: lineOf(p.text, sel.from), last: lineOf(p.text, Math.max(sel.from, sel.to - (p.text[sel.to - 1] === '\n' ? 1 : 0))) } : null
  const selWords = selLines ? (selLines.first === selLines.last ? `line ${selLines.first}` : `lines ${selLines.first}–${selLines.last}`) : null

  const pickHere = !p.proposalOnly && pick && sel && p.file && !p.dirty && pick.path === p.file.path && pick.digest === p.file.digest && pick.generation === p.ws?.generation && pick.from === sel.from && pick.to === sel.to ? pick : null
  const canPick = !p.proposalOnly && !!p.file && /\.pyi?$/.test(p.file.path) && !!p.call && !fnUnavailable && !p.dirty
  /** Select the whole function around an offset, exactly as the service's parser sees the saved file. */
  const pickFunction = useCallback(
    async (at: number) => {
      const f = p.file
      const ws = p.ws
      if (p.proposalOnly || !f || !ws || !p.call || p.dirty || !view) return
      const caret = Math.min(byteAt(f.content, at), Math.max(0, new TextEncoder().encode(f.content).length - 1))
      try {
        const pv = parseFunctionPreview(await p.call<unknown>('POST', `/v1/workspaces/${ws.id}/function-scope-preview`, { expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, path: f.path, source_digest: f.digest, caret_byte: caret }), f.path)
        const from = utf16At(f.content, pv.start_byte)
        const to = utf16At(f.content, pv.end_byte)
        if (from == null || to == null || view.state.doc.toString() !== f.content) return
        const name = /(?:def|class)\s+([A-Za-z_]\w*)/.exec(f.content.slice(from, to))?.[1] ?? 'this function'
        setPick({ ...pv, name, path: f.path, digest: f.digest, generation: ws.generation, from, to })
        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
        view.focus()
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'not_relayed' || code === 'function_language' || code === 'http_404') setFnUnavailable('Picking a whole function is not available here.')
        lang.setNote(code === 'function_scope_refused' ? 'There is no whole function around that spot.' : `The function could not be picked: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [p, view, lang],
  )

  // a selection that is exactly one name: the language actions apply to it
  const name = sel && !p.dirty ? (() => {
    const w = wordAt(p.text, sel.from)
    return w && w.from === sel.from && w.to === sel.to ? w : null
  })() : null

  // ---------------------------------------------------------------- what the Ask knows about this page
  useAskView(
    'code-canvas',
    p.path
      ? {
          title: p.path,
          summary: `Code canvas: ${p.path}${selWords ? `; ${selWords} selected` : ''}${p.dirty ? '; unsaved edits' : ''}${vibe.read ? `; a proposal with ${vibe.placed.length} change(s) is open` : ''}${tests.state.kind === 'done' && tests.state.tally ? `; last test run: ${tests.state.tally.text}` : ''}`,
        }
      : { title: 'Code canvas', summary: p.ws ? 'Code canvas: no file open yet' : 'Code canvas: preparing an isolated copy' },
  )

  // ---------------------------------------------------------------- actions
  const openPrompt = useCallback((range: { from: number; to: number } | null) => {
    setSaid('')
    setPrompt({ range })
  }, [])
  // the scope of the latest request, so "Ask for changes" asks again on exactly the same lines (or function, or file)
  const lastAsk = useRef<{ range: { from: number; to: number } | null; fn: FunctionPick | null } | null>(null)
  const change = useCallback(() => {
    const words = said.trim()
    if (!words || !prompt) return
    setPrompt(null)
    lastAsk.current = { range: prompt.range, fn: pickHere }
    void vibe.ask(words, prompt.range, who, pickHere)
  }, [said, prompt, vibe, who, pickHere])
  const explain = useCallback(() => {
    if (!p.path) return
    const what = selWords ? `${selWords} of ${p.path}` : p.path
    if (present) askSend(`Explain ${what} in plain words: what it does and why.`)
    else toast({ tone: 'info', title: 'The Ask is not in this look yet', body: 'Switch to Classic or Still to ask about code.' })
  }, [p.path, selWords, present, askSend, toast])
  const canTest = !p.proposalOnly || p.sandboxTestAvailable === true
  const test = useCallback(() => {
    if (!canTest) return toast({ tone: 'info', title: CODE_TEST_UNAVAILABLE })
    if (p.dirty) return toast({ tone: 'info', title: 'Save first', body: 'Tests run on exactly what is saved in this copy.' })
    const name = sel && p.file ? enclosingName(p.text, lineOf(p.text, sel.from)) : null
    const what = p.proposalOnly ? 'the tests for this retained proposal' : name ? `the tests, after ${name}` : 'the tests'
    if (!p.proposalOnly) { void tests.run(what); return }
    if (!p.onSandboxTest || !p.ws)
      return toast({ tone: 'info', title: 'Sandbox test admission is unavailable', body: 'No test has been started. The registered runner and original request controller must admit it.' })
    if (sandboxBusy.current) return
    const r = vibe.result
    const retained: SandboxTestReferences | undefined = r && !r.gone && r.integrity.ok
      && r.integrity.digest === r.read.record.digest && r.read.currency === 'current'
      && r.sent.workspace_id === p.ws.id && r.read.content.binding.generation === p.ws.generation
      && r.read.content.binding.tree_digest === p.ws.tree_digest
      ? { request_id: r.sent.request_id,
          proposal: { proposal_id: r.read.record.id, proposal_digest: `sha256:${r.read.record.digest}`,
            normalized_hunks_digest: `sha256:${r.read.content.digest}` },
          parent: { generation: r.read.content.binding.generation, tree_digest: `sha256:${r.read.content.binding.tree_digest}` } }
      : undefined
    if (!retained) return toast({ tone: 'info', title: 'Select a proposed change',
      body: 'Ask for a code change or select its retained proposal before requesting sandbox tests.' })
    const selection = sel && p.path ? { path: p.path, from: sel.from, to: sel.to } : undefined
    const ticket = ++sandboxSequence.current
    const context = sandboxContext
    const asked = r ? proposalKey(context, r) : ''
    sandboxBusy.current = true; setSandboxPending(true); setTestAsk({ key: asked, kind: 'asking' })
    void (async () => {
      try { await p.onSandboxTest!(what, selection, retained, () => sandboxLive.current
        && ticket === sandboxSequence.current && context === sandboxCurrent.current
        && sandboxInputs.current.available && sandboxInputs.current.text === p.text && sandboxInputs.current.path === p.path
        && sandboxInputs.current.file?.path === p.file?.path
        && sandboxInputs.current.file?.digest === p.file?.digest
        && sandboxInputs.current.file?.content === p.file?.content && sandboxInputs.current.result === r)
        if (sandboxLive.current && ticket === sandboxSequence.current && context === sandboxCurrent.current) setTestAsk({ key: asked, kind: 'sent' }) }
      catch {
        if (sandboxLive.current && ticket === sandboxSequence.current && context === sandboxCurrent.current) setTestAsk({ key: asked, kind: 'error', text: 'The request for a test run was not confirmed.' })
        if (sandboxLive.current && ticket === sandboxSequence.current && context === sandboxCurrent.current)
          toast({ tone: 'error', title: 'Sandbox test request was not confirmed', body: 'Check the existing Ask and test history before trying another request.' })
      } finally {
        if (sandboxLive.current && ticket === sandboxSequence.current && context === sandboxCurrent.current) {
          sandboxBusy.current = false; setSandboxPending(false)
        }
      }
    })()
  }, [canTest, p.proposalOnly, p.dirty, p.file, p.path, p.text, p.ws, p.onSandboxTest, sel, tests, toast, vibe.result, sandboxContext])

  // ---------------------------------------------------------------- the work stream (Create's bench: proposalOnly)
  const controllerOn = !!p.proposalOnly && ['working', 'writing', 'review', 'consented', 'applying'].includes(vibe.phase.kind)
  // the person's Apply landed through the engine (code.controller.applied): the workbench reads the applied paths again
  // through the same reload the canvas's own apply uses (onWorkspace: tree + the open file, unsaved drafts kept)
  const pWs = p.ws, pOnWorkspace = p.onWorkspace
  const onEngineApplied = useCallback((a: ControllerApplied) => {
    if (!pWs || a.workspace_id !== pWs.id || !a.after) return
    void pOnWorkspace({ ...pWs, generation: a.after.generation, tree_digest: a.after.tree_digest }, a.paths).catch(() => undefined)
  }, [pWs, pOnWorkspace])
  const { read: controllerRead, after: controllerAnswered } = useControllerState(p.client, sandboxContext, vibe.route?.request_id ?? null, controllerOn, undefined, onEngineApplied)
  const controller = controllerRead?.kind === 'engine' ? controllerRead.state : null
  // who drives this request: the engine (its person routes only), the canvas's own paths (no controller run), or not
  // known yet (nothing is offered, and no test is asked for, until it is)
  const driver = driverOf(p.client, vibe.route?.request_id ?? null, controllerRead)
  const driverKind = driver.kind
  // the test on a copy runs by itself once a verified proposal is in: once per proposal (and context), through the same
  // registered sandbox path as the Test button, with all of its binding checks
  const autoTested = useRef<string | null>(null)
  const shownKey = vibe.result ? proposalKey(sandboxContext, vibe.result) : null
  useEffect(() => {
    const r = vibe.result
    // the engine runs its own test on a fork for the requests it drives: the canvas asks only where none does
    if (driverKind !== 'none') return
    if (!p.proposalOnly || p.sandboxTestAvailable !== true || !p.onSandboxTest || !p.ws || p.dirty || !shownKey || !r) return
    if (vibe.phase.kind !== 'review' || r.gone || !r.integrity.ok || r.integrity.digest !== r.read.record.digest || r.read.currency !== 'current') return
    if (autoTested.current === shownKey || testAsk?.key === shownKey || sandboxBusy.current) return
    autoTested.current = shownKey
    test()
  }, [driverKind, vibe.phase.kind, vibe.result, shownKey, testAsk?.key, p.proposalOnly, p.sandboxTestAvailable, p.onSandboxTest, p.ws, p.dirty, test])
  const testedHere = testAsk && testAsk.key === shownKey ? testAsk : null
  const evidenceSubject = useMemo<EvidenceSubject | null>(() => {
    const r = vibe.result
    return r ? { workspace_id: r.sent.workspace_id, generation: r.read.content.binding.generation, tree_digest: r.read.content.binding.tree_digest, proposal_id: r.read.record.id, proposal_digest: r.read.record.digest, normalized_hunks_digest: r.read.content.digest } : null
  }, [vibe.result])
  const pCall = p.call
  const evidenceCall = useCallback<EvidenceCall>((method, route, body, query) => pCall!(method, route, body, query), [pCall])
  const evidence = useProposalTestEvidence(pCall ? evidenceCall : null, sandboxContext, evidenceSubject, !!p.proposalOnly && testedHere?.kind === 'sent')
  const testView: TestView = driverKind === 'engine' ? { kind: 'waiting' } : p.sandboxTestAvailable !== true || !p.onSandboxTest ? { kind: 'unavailable' } : !testedHere ? { kind: 'idle' } : testedHere.kind === 'asking' ? { kind: 'asking' } : testedHere.kind === 'error' ? { kind: 'error', text: testedHere.text ?? 'The request for a test run was not confirmed.' } : (evidence ?? { kind: 'waiting' })
  const work: Work | null = p.proposalOnly && vibe.phase.kind !== 'idle'
    ? workStages({
        phase: vibe.phase,
        instruction: vibe.instruction,
        scope: vibe.scope,
        team: vibe.route?.team ?? null,
        mind: mind?.name ?? null,
        sent: !!vibe.route,
        proposal: vibe.result ? { changes: vibe.result.read.content.hunks.filter((h) => h.path === vibe.result!.file.path).length, file: vibe.result.file.path, elsewhere: vibe.result.elsewhere.length, verified: !!vibe.integrity?.ok } : null,
        blocked: vibe.blockedWhy,
        test: testView,
        controller,
      })
    : null

  // Ask for changes: discard this proposal through the existing reject / decline path (its confirm included), then ask
  // again through the same Ask route on the same scope, with the person's note added (round 2, 3, …)
  const [followUp, setFollowUp] = useState<{ suggestion: string; instruction: string } | null>(null)
  const askChanges = useCallback((note: string) => {
    const r = vibe.result
    if (!r || !vibe.instruction || !note.trim()) return
    setFollowUp({ suggestion: r.read.record.id, instruction: nextRoundInstruction(vibe.instruction, note) })
    vibe.review('reject')
  }, [vibe])
  const vibeAsk = vibe.ask
  useEffect(() => {
    if (!followUp) return
    const ph = vibe.phase
    const discarded = (ph.kind === 'done' && ph.kept === 0) || (ph.kind === 'declined' && !ph.checking && !ph.unknown)
    if (discarded && vibe.result?.read.record.id === followUp.suggestion) {
      // follows the vibe session's own transitions (an external store): the new round goes out once, here
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFollowUp(null)
      const last = lastAsk.current
      void vibeAsk(followUp.instruction, last?.range ?? null, who, last?.fn ?? null)
      return
    }
    // the confirm is open, or the decision is on its way: wait for it
    if (vibe.reviewing || vibe.pending || (ph.kind === 'declined' && ph.checking)) return
    // closed without discarding (cancelled, refused, or anything else happened): no new round
    setFollowUp(null)
  }, [followUp, vibe.phase, vibe.reviewing, vibe.pending, vibe.result, vibeAsk, who])

  // the request said before any file is open (the empty state): find the file the words name, open it, ask on the whole
  // file through the same vibe.ask path; none or several → the chooser, with those first and the words kept
  const [opening, setOpening] = useState<{ words: string; candidates: string[] } | null>(null)
  const [askOnOpen, setAskOnOpen] = useState<{ path: string; words: string } | null>(null)
  const sayFirst = (words: string) => {
    const w = words.trim()
    if (!w) return
    const found = matchFiles(w, p.files, p.file ? { [p.file.path]: p.file.content } : {})
    if (found.length === 1) {
      setOpening(null)
      setAskOnOpen({ path: found[0], words: w })
      void p.openFile(found[0])
    } else {
      setOpening({ words: w, candidates: found })
      setQuick(true)
    }
  }
  useEffect(() => {
    if (!askOnOpen || p.path !== askOnOpen.path || p.file?.path !== askOnOpen.path || p.dirty || !p.ws) return
    const w = askOnOpen.words
    // the file the words named is now on screen (the workbench loaded it): ask once, here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAskOnOpen(null)
    lastAsk.current = { range: null, fn: null }
    void vibeAsk(w, null, who, null)
  }, [askOnOpen, p.path, p.file, p.dirty, p.ws, vibeAsk, who])

  // the three decisions, routed in one place (./work/actions): the engine's person routes, or the canvas's own paths
  const [engineCall, setEngineCall] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null })
  const routed: RoutedActions = routeActions(p.client, driver, { apply: () => vibe.review(), discard: () => vibe.review('reject'), askChanges }, controllerAnswered)
  const engineRun = (f: () => void | Promise<void>) => {
    const context = sandboxContext
    setEngineCall({ busy: true, note: null })
    void (async () => {
      let note: string | null = null
      try {
        await f()
      } catch (e) {
        // a refused person route arrives already in plain words (./work/actions); anything else, said the same calm way
        note = e instanceof ActionRefused ? e.message : 'That didn’t go through. Nothing changed.'
      }
      if (sandboxLive.current && context === sandboxCurrent.current) setEngineCall({ busy: false, note })
    })()
  }
  const streamActions: RoutedActions = routed.via !== 'engine' ? routed : {
    ...routed,
    apply: routed.apply && (() => engineRun(routed.apply!)),
    discard: routed.discard && (() => engineRun(routed.discard!)),
    askChanges: routed.askChanges && ((note: string) => engineRun(() => routed.askChanges!(note))),
  }

  const goTo = useCallback(
    (l: Location) => {
      setChooser(null)
      setReveal({ loc: l, stale: l.path !== p.path ? (p.file?.content ?? null) : null })
      if (l.path !== p.path) void p.openFile(l.path)
    },
    [p],
  )
  const definition = useCallback(
    async (at: number) => {
      const found = await lang.definition(at)
      if (!found?.length) return
      if (found.length === 1) goTo(found[0])
      else setChooser({ locations: found, at })
    },
    [lang, goTo],
  )
  const askRename = useCallback(
    (at: number) => {
      const w = wordAt(p.text, at)
      if (w && lang.offer.rename) setRenameAsk({ at: w.from, name: w.word })
    },
    [p.text, lang.offer.rename],
  )
  const complete = useCallback(
    (at: number) => {
      if (lang.offer.completion) void lang.complete(at)
    },
    [lang],
  )
  const caret = () => view?.state.selection.main.head ?? sel?.from ?? 0

  // land on a definition once its file is on screen: the new file loaded and the editor showing exactly it
  useEffect(() => {
    if (!reveal || !view || !p.file || p.path !== reveal.loc.path || (reveal.stale !== null && p.file.content === reveal.stale)) return
    const text = view.state.doc.toString()
    if (text !== p.file.content) return
    const a = fromLsp(text, reveal.loc.range.start)
    const z = fromLsp(text, reveal.loc.range.end)
    const t = window.setTimeout(() => setReveal(null))
    if (a != null) {
      view.dispatch({ selection: { anchor: a, head: z ?? a }, scrollIntoView: true })
      view.focus()
    }
    return () => window.clearTimeout(t)
  }, [reveal, view, p.path, p.file, p.text])

  // ---------------------------------------------------------------- keys (page-wide; the editor forwards its own)
  const editorKeys = useMemo(
    () => ({
      'Mod-k': () => (openPrompt(sel ? { from: sel.from, to: sel.to } : null), true),
      'Mod-e': () => (explain(), true),
      'Mod-;': () => canTest ? (test(), true) : false,
      'Mod-Enter': () => (vibe.phase.kind === 'review' ? (vibe.review(), true) : false),
      F12: () => (lang.offer.definition ? (void definition(caret()), true) : false),
      F2: () => (lang.offer.rename ? (askRename(caret()), true) : false),
      'Ctrl-Space': () => (lang.offer.completion ? (complete(caret()), true) : false),
      // Esc closes what is open beside the code; otherwise the editor keeps it (its search, its own panels)
      Escape: () => {
        if (prompt) setPrompt(null)
        else if (renameAsk) setRenameAsk(null)
        else if (chooser) setChooser(null)
        else if (view && !view.state.selection.main.empty) view.dispatch({ selection: { anchor: view.state.selection.main.head } })
        else return false
        return true
      },
    }),
    [canTest, openPrompt, sel, explain, test, vibe, prompt, view, lang.offer, definition, askRename, complete, renameAsk, chooser], // eslint-disable-line react-hooks/exhaustive-deps
  )
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || document.querySelector('[aria-modal="true"]')) return
      const k = e.key.toLowerCase()
      if (k === 'p') {
        e.preventDefault()
        setQuick(true)
      } else if (k === 'b' && !isTypingTarget(e.target)) {
        e.preventDefault()
        toggleDrawer()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [toggleDrawer])
  // Esc closes what is open over the code; it never leaves the canvas (Back and Close do that, on purpose)
  useEscape(() => (prompt ? setPrompt(null) : renameAsk ? setRenameAsk(null) : chooser ? setChooser(null) : lang.rename ? lang.setRename(null) : setDrawer(null)), !!prompt || !!drawer || !!renameAsk || !!chooser || !!lang.rename)

  // ---------------------------------------------------------------- the actions beside a selection
  const [beside, setBeside] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    const host = canvasRef.current
    if (!view || !sel || !host || phone) {
      const raf = requestAnimationFrame(() => setBeside(null))
      return () => cancelAnimationFrame(raf)
    }
    let raf = 0
    const measure = () => {
      raf = 0
      const h = host.getBoundingClientRect()
      const a = view.coordsAtPos(Math.min(sel.from, view.state.doc.length))
      const line = view.state.doc.lineAt(Math.min(sel.from, view.state.doc.length))
      const last = view.state.doc.lineAt(Math.min(Math.max(sel.from, sel.to - 1), view.state.doc.length))
      let right = 0
      for (let n = line.number; n <= Math.min(last.number, line.number + 40); n++) {
        const c = view.coordsAtPos(view.state.doc.line(n).to)
        if (c) right = Math.max(right, c.left)
      }
      const scroller = view.scrollDOM.getBoundingClientRect()
      if (!a || a.bottom < scroller.top || a.top > scroller.bottom) return setBeside(null)
      const left = Math.min(Math.max(right + 28, scroller.left + 120), scroller.right - 330)
      setBeside({ left: left - h.left, top: Math.max(scroller.top, a.top - 4) - h.top })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    schedule()
    view.scrollDOM.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      view.scrollDOM.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [view, sel, phone, p.text])

  // ---------------------------------------------------------------- what the editor draws
  const current = tests.state.kind === 'done' && !!p.ws && tests.state.run.generation === p.ws.generation && !p.dirty
  const marks = useMemo(() => (tests.state.kind === 'done' && current && p.path ? tests.state.marks.filter((m) => m.path === p.path).map((m) => ({ line: m.line, text: m.text, ok: m.ok })) : []), [tests.state, current, p.path])
  // a rename or completion preview is drawn in place, like a mind's change (it is not applied until confirmed)
  const languageViews: ChangeView[] = useMemo(() => {
    const out: ChangeView[] = []
    out.push(...renameViews(lang.rename, p.path))
    const pc = lang.completion?.preview
    if (pc?.change && pc.path === p.path) out.push({ id: 'completion', n: 1, from: pc.change.from, to: pc.change.to, after: pc.change.insert, state: 'keep' })
    return out
  }, [lang.rename, lang.completion, p.path])
  const forFile = p.file && !p.dirty ? p.file : null
  const layers: Layers = useMemo(() => ({ changes: [...vibe.changeViews, ...languageViews], presence: vibe.presence, who: mind, marks, reduced, ...(forFile ? { for: { path: forFile.path, text: forFile.content } } : {}) }), [vibe.changeViews, languageViews, vibe.presence, mind?.name, mind?.hue, marks, reduced, forFile?.path, forFile?.content]) // eslint-disable-line react-hooks/exhaustive-deps
  const mini: MiniMark[] = useMemo(() => [...vibe.placed.map((c) => ({ line: c.line, lastLine: c.lastLine, tone: 'mind' as const })), ...marks.map((m) => ({ line: m.line, tone: m.ok ? ('ok' as const) : ('bad' as const) })), ...(selLines ? [{ line: selLines.first, lastLine: selLines.last, tone: 'you' as const }] : [])], [vibe.placed, marks, selLines?.first, selLines?.last]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- neighbours
  const i = p.path ? p.files.indexOf(p.path) : -1
  const prev = i > 0 ? p.files[i - 1] : null
  const next = i >= 0 && i < p.files.length - 1 ? p.files[i + 1] : null
  const elsewhereMarks = tests.state.kind === 'done' ? [...new Set(tests.state.marks.filter((m) => m.path !== p.path && p.files.includes(m.path)).map((m) => m.path))] : []

  // ---------------------------------------------------------------- narration for screen readers
  const narration =
    lang.note ? lang.note : lang.rename ? `Rename preview: ${lang.rename.files.length} file(s). Review it, then Rename or Cancel.` : vibe.phase.kind === 'working' ? 'Asking a mind for the change…' : vibe.phase.kind === 'writing' && mind ? `${mind.name} is writing the change into the code.` : vibe.phase.kind === 'review' && mind ? `${mind.name} proposes ${vibe.placed.length} change${vibe.placed.length === 1 ? '' : 's'}. The summary is below the code.` : vibe.phase.kind === 'applying' ? 'Putting the change into your copy…' : vibe.phase.kind === 'consented' ? `You accepted it (${vibe.phase.valid}); waiting for the swarm to put it in.` : vibe.phase.kind === 'declined' ? (vibe.phase.checking ? 'Declined; checking it isn’t already in your copy.' : 'Declined.') : vibe.phase.kind === 'applied' ? (vibe.phase.beforeDecline ? 'This was already put in your copy before you declined. Undo puts it back.' : vibe.phase.authorization === 'unconsented' ? 'The swarm changed your copy without your OK. Undo puts it back.' : vibe.phase.authorization !== 'consented' ? 'The swarm changed your copy: check it’s what you accepted. Undo puts it back.' : vibe.phase.currency === 'current' ? 'The change is in your copy. Undo puts it back.' : 'The change went into your copy earlier; your copy has changed since.') : vibe.phase.kind === 'undone' ? (vibe.phase.elsewhere ? 'It was put into your copy and has already been undone.' : 'Undone: your copy is as it was.') : vibe.phase.kind === 'done' ? `Recorded: ${vibe.phase.kept} kept, ${vibe.phase.skipped} skipped.` : tests.state.kind === 'running' ? 'Running the tests…' : tests.state.kind === 'done' ? `Tests: ${tests.state.tally?.text ?? (tests.state.run.exit_code === 0 ? 'passed' : 'failed')}.` : ''

  // the reserved band: the Ask (which also clears Ω's corner); on a phone, the tab bar under it as well
  const bottom = phone ? Math.max(room, 84) + 52 : Math.max(room, 84)
  /** A small popover just under an offset in the code (clamped inside the canvas); on a phone, under the top line. */
  const popTarget = lang.completion?.at ?? chooser?.at ?? null
  const [popStyle, setPopStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (popTarget == null) return
    const raf = requestAnimationFrame(() => {
      const host = canvasRef.current?.getBoundingClientRect()
      const c = view?.coordsAtPos(Math.min(popTarget, view.state.doc.length))
      // on a phone: under the top line, clear of the keyboard, the Ask and the hive's toasts
      setPopStyle(phone || !host || !c ? { position: 'fixed', left: 8, right: 8, top: 112, width: 'auto' } : { left: Math.min(Math.max(8, c.left - host.left), host.width - 360), top: Math.min(c.bottom - host.top + 6, host.height - bottom - 260) })
    })
    return () => cancelAnimationFrame(raf)
  }, [popTarget, view, phone, bottom])
  const titleId = useId()

  return (
    <section
      ref={canvasRef}
      role={p.embedded ? 'region' : 'dialog'}
      aria-labelledby={titleId}
      className={cx('cc flex flex-col overflow-hidden', p.embedded ? 'relative z-0 h-full min-h-0 w-full' : 'xc-dress xc-page fixed inset-0 z-[25] md:top-[var(--page-top,12px)] md:bottom-[var(--page-bottom,12px)] md:right-3 md:left-[var(--rail-x,84px)] md:rounded-[24px] md:border md:border-line')}
      data-code-embedded={p.embedded || undefined}
      data-presence-region="page"
      data-reduced={reduced || undefined}
      data-phone={phone || undefined}
      style={{ ['--cc-bottom' as string]: `${bottom}px`, ['--mind-hue' as string]: String(mind?.hue ?? 280) }}
    >
      {/* the quiet top line: where you are, the files beside it, and the few things you do most */}
      <header className="cc-top">
        <button type="button" className="cc-tool" onClick={p.onBack} aria-label={p.backLabel ?? 'Back to everything running'} title="Back">
          <Icon name="back" size={17} />
        </button>
        <div className="cc-where">
          <h1 id={titleId} className="cc-eyebrow">
            <span className="sr-only">Code workbench: </span>
            {p.label}
            <span className="cc-gen">{p.eyebrow}{p.ws && !p.embedded ? ` · generation ${p.ws.generation}` : ''}</span>
          </h1>
          <nav className="cc-crumbs" aria-label="This file and the files beside it">
            {prev && !phone && (
              <button type="button" className="cc-near" onClick={() => void p.openFile(prev)} title={`Open ${prev}`}>
                {base(prev)}
              </button>
            )}
            <button type="button" className="cc-here" onClick={() => setQuick(true)} title="Open another file (⌘P)" aria-label={p.path ? `${p.path}${p.dirty ? ', unsaved edits' : ''}. Open another file` : 'Choose a file'}>
              {p.path ?? 'Choose a file'}
              {p.dirty && <span className="cc-dirty" aria-hidden="true" />}
              <Icon name="chevronDown" size={13} />
            </button>
            {next && !phone && (
              <button type="button" className="cc-near" onClick={() => void p.openFile(next)} title={`Open ${next}`}>
                {base(next)}
              </button>
            )}
          </nav>
        </div>
        <div className="cc-acts">
          {caps.status === 'failed' && (
            <button type="button" className="cc-pill cc-pill-bad" onClick={caps.retry} title={`Couldn’t check what the code service supports (${caps.why ?? 'no answer'}). Features that depend on it stay hidden until it answers. Press to try again.`}>
              Couldn’t check the service · Retry
            </button>
          )}
          {!p.proposalOnly && <TestPill state={tests.state} earlier={tests.state.kind === 'done' && !current} elsewhere={elsewhereMarks} open={(f) => void p.openFile(f)} details={() => setDrawer('tests')} />}
          {p.proposalOnly && p.sandboxTestStatus && <div role="status">{p.sandboxTestStatus}</div>}
          {p.path && (
            <button type="button" className="cc-act cc-act-mind" onClick={() => openPrompt(sel ? { from: sel.from, to: sel.to } : null)} title="Say what should change (⌘K)" data-presence-feature="code.change">
              <Icon name="sparkles" size={15} />
              <span>Change…</span>
            </button>
          )}
          {canTest && p.path && !phone && (
            <button type="button" className="cc-act" onClick={test} disabled={(p.proposalOnly ? sandboxPending : tests.state.kind === 'running') || !p.ws} title="Run the tests on what is saved (⌘;)">
              <Icon name="play" size={14} />
              <span>Test</span>
            </button>
          )}
          {p.path && (p.dirty || !phone) && (
            <button type="button" className={cx('cc-act', p.dirty && 'cc-act-save')} onClick={p.save} disabled={!p.dirty || !!p.busy} title="Save to this copy (⌘S)">
              <Icon name="check" size={14} />
              <span>{p.busy === 'save' ? 'Saving…' : p.dirty ? 'Save' : 'Saved'}</span>
            </button>
          )}
          <button type="button" className="cc-tool" onClick={toggleDrawer} aria-expanded={!!drawer} aria-controls="cc-drawer" aria-label="Open the drawer: files, changes, proposals, tests and tools" title="Drawer (⌘B)">
            <Icon name="panelOpen" size={17} />
          </button>
        </div>
        <button type="button" className="cc-tool cc-close" onClick={p.onClose} aria-label="Close" title="Close">
          <Icon name="x" size={17} />
        </button>
      </header>
      {p.banner}

      {/* the code owns ⌘K (Change…): the Ask's and the palette's ⌘K yield inside it, and work everywhere else */}
      <div className="cc-stage" data-presence-region="code-editor" {...{ [OWNS_SHORTCUT]: 'mod+k' }}>
        {p.path && p.file ? (
          <>
            <Suspense fallback={<div className="cc-loading">Opening {base(p.path)}…</div>}>
              <Editor path={p.path} content={p.file.content} onChange={p.onText} onSave={p.save} onSelect={p.onSelect} layers={layers} onView={setView} keys={editorKeys} label={`Code: ${p.path}`} onModClick={lang.offer.definition ? (at) => void definition(at) : undefined} localCompletion={!lang.offer.completion} onDoubleClick={canPick ? (at) => (defNameAt(p.text, at) ? void pickFunction(at) : undefined) : undefined} />
            </Suspense>
            {!phone && <Minimap view={view} text={p.text} marks={mini} />}
          </>
        ) : (
          <EmptyCanvas files={p.files} waiting={p.waiting ?? null} ready={!!p.ws} open={(f) => void p.openFile(f)} say={p.proposalOnly ? { words: opening?.words ?? '', onSay: sayFirst, busy: !!askOnOpen } : undefined} />
        )}
      </div>

      {/* actions beside a selection; on a phone, a bar above the Ask */}
      {sel && p.path && !prompt && !renameAsk && !lang.rename && !lang.completion && (beside || phone) && !['working', 'writing', 'review', 'applying'].includes(vibe.phase.kind) && (
        <div className={cx('cc-beside', phone && 'cc-beside-phone', !!name && 'cc-beside-name')} style={phone ? { bottom: bottom + 8 } : { left: beside!.left, top: beside!.top }} role="toolbar" aria-label={`Actions for ${selWords}`}>
          <span className="cc-beside-what">{pickHere ? `function ${pickHere.name}` : name ? name.word : selWords}</span>
          {canPick && !pickHere && (
            <button type="button" onClick={() => void pickFunction(sel.from)} title="Select the whole function around this (or double-click its name)">
              <Icon name="unfold" size={14} /> <span className="cc-beside-label">Function</span>
            </button>
          )}
          {name && lang.offer.definition && (
            <button type="button" onClick={() => void definition(name.from)} title="Go to where this is defined (⌘-click, F12)">
              <Icon name="locate" size={14} /> <span className="cc-beside-label">Definition</span>
            </button>
          )}
          {name && lang.offer.rename && (
            <button type="button" onClick={() => askRename(name.from)} title="Rename it everywhere, with a preview first (F2)">
              <Icon name="edit" size={14} /> <span className="cc-beside-label">Rename…</span>
            </button>
          )}
          {name && lang.offer.completion && (
            <button type="button" onClick={() => complete(name.to)} title="Complete this name (⌃Space)">
              <Icon name="list" size={14} /> <span className="cc-beside-label">Complete</span>
            </button>
          )}
          <button type="button" onClick={explain} title="Explain this in plain words (⌘E)">
            <Icon name="chat" size={14} /> Explain
          </button>
          <button type="button" className="cc-beside-mind" onClick={() => openPrompt({ from: sel.from, to: sel.to })} title="Say what should change (⌘K)">
            <Icon name="sparkles" size={14} /> Change…
          </button>
          {canTest && <button type="button" onClick={test} disabled={p.proposalOnly ? sandboxPending : tests.state.kind === 'running'} title={p.proposalOnly ? 'Request tests through the registered sandbox' : 'Run the tests (⌘;)'}>
            <Icon name="play" size={13} /> Test
          </button>}
        </div>
      )}

      {prompt && (
        <ChangePrompt
          copyApply={vibe.route?.copyApply ?? null}
          where={prompt.range ? (pickHere ? `the function ${pickHere.name}` : (selWords ?? 'the selection')) : `all of ${p.path ? base(p.path) : 'this file'}`}
          value={said}
          onChange={setSaid}
          onSend={change}
          onClose={() => setPrompt(null)}
          style={!phone && prompt.range && beside ? { left: beside.left, top: beside.top } : phone ? { bottom: bottom + 8 } : undefined}
          dirty={p.dirty}
          phone={phone}
        />
      )}

      {renameAsk && (
        <RenamePrompt
          name={renameAsk.name}
          phone={phone}
          busy={lang.busy === 'rename'}
          style={!phone && beside ? { left: beside.left, top: beside.top } : phone ? { bottom: bottom + 8 } : undefined}
          onClose={() => setRenameAsk(null)}
          onSend={(to) => {
            const ask = renameAsk
            setRenameAsk(null)
            void lang.previewRename(ask.at, ask.name, to)
          }}
        />
      )}
      <RenameCard lang={lang} phone={phone} bottom={bottom} open={(f) => void p.openFile(f)} />
      {lang.completion && <CompletionList lang={lang} style={popStyle} onDone={() => view?.focus()} />}
      {chooser && <DefinitionChooser locations={chooser.locations} style={popStyle} onGo={goTo} onClose={() => (setChooser(null), view?.focus())} />}
      {lang.note && (
        <p className="cc-langnote" role="status" style={{ bottom: bottom + 8 }}>
          <span>{lang.note}</span>
          <button type="button" className="cc-tool" onClick={() => lang.setNote(null)} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </p>
      )}

      <VibeCard vibe={vibe} mind={mind} file={vibe.result?.file.path ?? p.path} onTest={canTest ? (p.proposalOnly ? test : () => void tests.run('the tests, after the change')) : undefined} onDrawer={(t) => setDrawer(t)} bottom={bottom} phone={phone} stream={work ? { work, reduced, routed: streamActions, busy: !!followUp || engineCall.busy, note: engineCall.note, testsHere: !p.proposalOnly || p.sandboxTestAvailable === true } : undefined} />

      {lastTab && tabAllowed(drawer ?? lastTab) && (
        <Drawer tabs={DRAWER_TABS.filter((t) => tabAllowed(t.id)).map(t => p.proposalOnly && t.id === 'tests' ? { ...t, hint: 'Request and read sandbox tests for the retained proposal' } : t)} tab={drawer ?? lastTab} open={!!drawer} onTab={setDrawer} onClose={() => setDrawer(null)} phone={phone} bottom={bottom}>
          {(drawer ?? lastTab) === 'iterations' ? p.call && p.ws ? <Iterations call={p.call} ws={p.ws} ctxKey={caps.key} /> : null : p.drawer(drawer ?? lastTab, setDrawer)}
          {(drawer ?? lastTab) === 'changes' && p.call && p.ws && <MergeReviewCard call={p.call} ws={p.ws} caps={caps} />}
        </Drawer>
      )}
      {quick && <QuickOpen files={p.files} current={p.path} first={opening?.candidates} note={opening ? (opening.candidates.length ? `Which file did you mean for “${opening.words}”?` : `Which file should “${opening.words}” change?`) : undefined}
        onPick={(f) => { setQuick(false); if (opening) { setAskOnOpen({ path: f, words: opening.words }); setOpening(null) } void p.openFile(f) }} onClose={() => setQuick(false)} />}
      <p className="sr-only" aria-live="polite">{narration}</p>
    </section>
  )
}

// ------------------------------------------------------------------ pieces

function EmptyCanvas({ files, waiting, ready, open, say }: { files: string[]; waiting: string | null; ready: boolean; open: (f: string) => void; say?: { words: string; onSay: (w: string) => void; busy: boolean } }) {
  if (!ready || !files.length)
    return (
      <div className="cc-empty" role="status">
        <p className="cc-empty-title">{waiting ?? (ready ? 'Reading the files…' : 'Making your own copy to work in…')}</p>
        <p className="cc-empty-body">Edits go to an isolated copy. The running code is untouched until you choose to apply.</p>
      </div>
    )
  return (
    <div className="cc-empty">
      <p className="cc-empty-title">{say ? 'What should change?' : 'Open a file to start'}</p>
      {say ? <SayFirst key={say.words} initial={say.words} onSay={say.onSay} busy={say.busy} /> : null}
      <p className="cc-empty-body">{say ? 'Say it in your words, and the right file opens with the work alongside. Or open a file yourself. ⌘P opens any file.' : 'Then select anything and say what should change, or just start typing. ⌘P opens any file.'}</p>
      <ul className="cc-empty-files" aria-label="Files">
        {files.slice(0, 24).map((f) => (
          <li key={f}>
            <button type="button" onClick={() => open(f)}>
              <Icon name="doc" size={14} />
              <span>{f}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The request field on the empty canvas: say what should change, before any file is open. */
function SayFirst({ initial, onSay, busy }: { initial: string; onSay: (w: string) => void; busy: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <form
      className="cc-say"
      aria-label="Say what should change"
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) onSay(value)
      }}
    >
      <Icon name="sparkles" size={15} />
      <input
        className="cc-say-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Say what should change…"
        aria-label="Say what should change"
        onKeyDown={(e) => {
          if (guardComposing(e)) return
        }}
      />
      <button type="submit" className="cc-btn cc-btn-primary" disabled={!value.trim() || busy}>
        {busy ? 'Opening…' : 'Go'}
      </button>
    </form>
  )
}

function ChangePrompt({ where, value, onChange, onSend, onClose, style, dirty, phone, copyApply }: { where: string; value: string; onChange: (s: string) => void; onSend: () => void; onClose: () => void; style?: CSSProperties; dirty: boolean; phone: boolean; copyApply?: 'on' | 'off' | 'unknown' | null }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  // the Ask conductor may word the change here; sending stays this form's own act
  useAskFillable('code.change-prompt', 'What should change', 'prompt', onChange)
  return (
    <form
      className={cx('cc-prompt', !style && 'cc-prompt-top', phone && 'cc-prompt-phone')}
      style={style}
      onSubmit={(e) => {
        e.preventDefault()
        onSend()
      }}
      aria-label="Say what should change"
    >
      <label className="cc-prompt-label">
        <Icon name="sparkles" size={14} /> What should change in {where}?
      </label>
      <textarea
        ref={ref}
        value={value}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. make add actually add the two numbers"
        onKeyDown={(e) => {
          // an IME's confirming Enter belongs to the input method: never a half-composed request to a mind (r2.2 audit)
          if (guardComposing(e)) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      {dirty && <p className="cc-prompt-note">Save your edits first: the mind works on exactly what is saved.</p>}
      <div className="cc-prompt-row">
        <span className="cc-prompt-hint">{copyApply === 'on' ? 'A mind makes the change in your copy; you can undo it.' : copyApply ? 'A mind proposes; nothing changes until you accept.' : 'A mind works on your copy, never the running app.'}</span>
        <button type="button" className="cc-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="cc-btn cc-btn-primary" disabled={!value.trim() || dirty}>
          Propose
        </button>
      </div>
    </form>
  )
}

function TestPill({ state, earlier, elsewhere, open, details }: { state: ReturnType<typeof useTestRun>['state']; earlier: boolean; elsewhere: string[]; open: (f: string) => void; details: () => void }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'running')
    return (
      <span className="cc-pill" role="status">
        <span className="cc-pill-dot cc-pill-live" /> Testing…
      </span>
    )
  if (state.kind === 'error')
    return (
      <span className="cc-pill cc-pill-bad" role="status" title={state.text}>
        {state.unavailable ? 'Tests not available here' : 'Tests did not run'}
      </span>
    )
  const ok = state.run.exit_code === 0
  return (
    <span className="cc-pill-group">
      <button type="button" className={cx('cc-pill', ok ? 'cc-pill-ok' : 'cc-pill-bad', earlier && 'cc-pill-earlier')} onClick={details} title={`Run ${state.run.id} on generation ${state.run.generation}${earlier ? ' (an earlier version: the code has changed since)' : ''}. Open the full output.`}>
        <span aria-hidden="true">{ok ? '✓' : '✗'}</span> {state.tally?.text ?? (ok ? 'passed' : 'failed')}
        {earlier && <span className="cc-pill-note">earlier</span>}
      </button>
      {!earlier && elsewhere.slice(0, 2).map((f) => (
        <button key={f} type="button" className="cc-pill cc-pill-bad cc-pill-file" onClick={() => open(f)} title={`Results beside the lines in ${f}`}>
          in {base(f)}
        </button>
      ))}
    </span>
  )
}

/** The applied card's heading: never "accepted" unless the host's evidence says the person's OK was used (r5). */
function appliedHead(ph: Extract<VibePhase, { kind: 'applied' }>, mind: string, of: string): string {
  const earlier = ph.currency === 'stale' ? ' earlier' : ''
  if (ph.authorization === 'consented') return `${mind} changed ${ph.words.length === 1 ? 'one place' : `${ph.words.length || 'some'} places`} in your copy${of}${earlier}, with your OK.`
  if (ph.authorization === 'unconsented') return `The swarm changed your copy${of} without your OK${earlier}.`
  return ph.acceptedHere ? `The swarm changed your copy${of}${earlier} — check it’s what you accepted.` : `The swarm changed your copy${of}${earlier}.`
}

/** The work stream mode (Create's bench): the timeline replaces the working / writing / review lines of the card. */
export interface VibeStream {
  work: Work
  reduced: boolean
  /** the three decisions, already routed (./work/actions): the engine's person routes, or the canvas's own paths */
  routed: RoutedActions
  /** a decision (or a new round) is on its way */
  busy?: boolean
  /** a decision that didn't go through, said plainly */
  note?: string | null
  /** this hive runs tests on a copy (the canvas's own path holds Apply until the test passed) */
  testsHere?: boolean
}

export function VibeCard({ vibe, mind, file, onTest, onDrawer, bottom, phone, stream }: { vibe: ReturnType<typeof useVibe>; mind: { name: string; hue: number } | null; file: string | null; onTest?: () => void; onDrawer: (t: DrawerTab) => void; bottom: number; phone: boolean; stream?: VibeStream }) {
  const ph = vibe.phase
  const headRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (ph.kind === 'review' || ph.kind === 'applied') headRef.current?.focus({ preventScroll: true })
  }, [ph.kind])
  if (ph.kind === 'idle') return null
  // desktop: top right, clear of the Ask's thread and the hive's toasts (bottom); phone: just above the Ask
  const style = phone ? { bottom: bottom + 8 } : { top: 62 }
  const sum = vibe.summary && mind ? vibe.summary.text(mind.name) : null
  const keeping = vibe.placed.filter((c) => vibe.staged[c.id] === 'accept').length
  const skipping = vibe.placed.filter((c) => vibe.staged[c.id] === 'reject').length
  const reviewBody = ph.kind === 'review' && vibe.read ? (
        <>
          {!vibe.placed.length && <p className="cc-card-note">Its changes are in other files ({vibe.elsewhere.join(', ')}). Open the drawer's Proposals to see them in full.</p>}
          <ol className="cc-changes">
            {vibe.placed.map((c, n) => {
              const st = vibe.staged[c.id]
              return (
                <li key={c.id} data-skip={st === 'reject' || undefined}>
                  <span className="cc-change-n">{n + 1}</span>
                  <span className="cc-change-words">
                    {c.line === c.lastLine ? `Line ${c.line}` : `Lines ${c.line}–${c.lastLine}`}: {c.words}
                  </span>
                  <button type="button" className="cc-keep" aria-pressed={st !== 'reject'} onClick={() => vibe.choose(c.id, st === 'reject' ? 'accept' : 'reject')} aria-label={`${st === 'reject' ? 'Skipped' : 'Kept'}: change ${n + 1}. Press to ${st === 'reject' ? 'keep' : 'skip'} it`}>
                    {st === 'reject' ? 'Skipped' : 'Keep'}
                  </button>
                </li>
              )
            })}
          </ol>
          {sum && sum.lines.slice(vibe.placed.length).map((l) => <p key={l} className="cc-card-note">{l}</p>)}
          {vibe.elsewhere.length > 0 && vibe.placed.length > 0 && <p className="cc-card-note">It also changes {vibe.elsewhere.join(', ')} (in the drawer's Proposals).</p>}
          {/* in the work stream the reasons and checks fold away, so the decision stays in view */}
          {stream ? (
            <details className="cc-card-more">
              <summary>Why, and what was checked</summary>
          {sum?.why && <p className="cc-card-why">{sum.why}</p>}
          {vibe.scope && <p className="cc-card-fine">You allowed: {scopeWords(vibe.scope)}</p>}
          {vibe.integrity?.ok && vibe.onFile && <p className="cc-card-fine"><Icon name="shield" size={12} /> Checked in this browser: exactly what was retained. {vibe.lands === 'unknown' ? 'It may already be in your copy: check before confirming.' : 'Nothing changes until you accept and confirm.'}</p>}
          {vibe.verify && !vibe.verify.busy && (
            <div className="cc-card-row">
              <button type="button" className="cc-btn" onClick={() => void vibe.recheck()}>
                Try again
              </button>
            </div>
          )}
          {vibe.route && (
            <p className="cc-card-fine">
              {vibe.route.copyApply === 'off' ? 'This hive asks for your OK before a mind’s change goes into your copy: putting it in directly is not switched on here.' : vibe.route.copyApply === 'on' ? WAITING_FOR_YOU : 'Couldn’t check whether this hive lets a swarm put changes into your copy itself. This one waits for your OK; if it goes in without it, this card says so.'}
            </p>
          )}
            </details>
          ) : (
            <>
          {sum?.why && <p className="cc-card-why">{sum.why}</p>}
          {vibe.scope && <p className="cc-card-fine">You allowed: {scopeWords(vibe.scope)}</p>}
          {vibe.integrity?.ok && vibe.onFile && <p className="cc-card-fine"><Icon name="shield" size={12} /> Checked in this browser: exactly what was retained. {vibe.lands === 'unknown' ? 'It may already be in your copy: check before confirming.' : 'Nothing changes until you accept and confirm.'}</p>}
          {vibe.verify && !vibe.verify.busy && (
            <div className="cc-card-row">
              <button type="button" className="cc-btn" onClick={() => void vibe.recheck()}>
                Try again
              </button>
            </div>
          )}
          {vibe.route && (
            <p className="cc-card-fine">
              {vibe.route.copyApply === 'off' ? 'This hive asks for your OK before a mind’s change goes into your copy: putting it in directly is not switched on here.' : vibe.route.copyApply === 'on' ? WAITING_FOR_YOU : 'Couldn’t check whether this hive lets a swarm put changes into your copy itself. This one waits for your OK; if it goes in without it, this card says so.'}
            </p>
          )}
            </>
          )}
          {(vibe.note || vibe.blockedWhy) && <p className="cc-card-bad" role="alert">{vibe.note ?? vibe.blockedWhy}</p>}
          {vibe.pending?.unknown && (
            <div className="cc-card-bad" role="alert">
              <p>{vibe.pending.unknown}</p>
              <button type="button" className="cc-btn" onClick={() => vibe.setReviewing(vibe.pending)}>
                Retry the same decision
              </button>
            </div>
          )}
        </>
  ) : null
  const streaming = !!stream
  // the decision shows once the work says it is the person's turn; on the canvas's own paths, Apply keeps their checks
  const engine = stream?.routed.via === 'engine'
  // the canvas's own path: Apply waits for the test on a copy (the engine path says so itself, in actions[].available)
  const gate = stream && !engine ? canvasApplyGate(stream.work.stages, stream.testsHere === true) : { ok: true as const }
  const decide: WorkActions | null = stream && ph.kind === 'review' && vibe.read && stream.work.next === 'decide' ? {
    onApply: stream.routed.apply && gate.ok && !vibe.blockedWhy && (engine || keeping > 0) ? stream.routed.apply : null,
    onDiscard: stream.routed.discard,
    onAskChanges: stream.routed.askChanges,
    applyLabel: !engine && skipping ? `Apply ${keeping}, skip ${skipping}` : 'Apply',
    busy: !!vibe.pending || !!vibe.reviewing || !!stream.busy,
    line: gate.ok ? stream.routed.line : gate.why,
    alert: stream.note ?? null,
    noteMax: stream.routed.noteMax,
  } : null
  return (
    <aside className={cx('cc-card', phone && 'cc-card-phone', streaming && 'cc-card-stream')} style={style} aria-label="The mind's change">
      {stream && (
        <WorkStream
          work={stream.work}
          reduced={stream.reduced}
          actions={decide}
          body={{
            mind: ph.kind === 'working' && vibe.note ? <p className="cc-card-note">{vibe.note}</p> : undefined,
            change: ph.kind === 'writing' && mind ? (
              <button type="button" className="cc-btn" onClick={vibe.finish}>
                Skip ahead
              </button>
            ) : reviewBody ? (
              <>
                <h3 ref={headRef} tabIndex={-1} className="cc-card-head">
                  <span className="cc-mind-dot" />
                  {sum?.headline ?? `${mind?.name ?? 'The mind'} proposes a change.`}
                </h3>
                {reviewBody}
              </>
            ) : undefined,
          }}
        />
      )}
      {!streaming && ph.kind === 'working' && (
        <p className="cc-card-line" role="status">
          <span className="cc-pill-dot cc-pill-live" /> {ph.step === 'scope' ? 'Marking the lines for the mind…' : ph.step === 'turn' ? 'Handing your words to the Ask…' : ph.step === 'send' ? `Sending it to ${vibe.route?.team ?? 'the Code swarm'}…` : ph.step === 'starting' ? `Sent to ${vibe.route?.team ?? 'the Code swarm'}. Waiting for it to start a mind on this request…` : ph.step === 'mind' ? `${vibe.route?.team ?? 'The Code swarm'} is working on it…` : 'Reading what it proposed…'}
        </p>
      )}
      {!streaming && ph.kind === 'working' && vibe.note && <p className="cc-card-note">{vibe.note}</p>}
      {!streaming && ph.kind === 'writing' && mind && (
        <div className="cc-card-line" role="status">
          <span className="cc-mind-dot" />
          <span className="min-w-0 flex-1">
            <b>{mind.name}</b> is writing it in{file ? ` ${base(file)}` : ''}…
          </span>
          <button type="button" className="cc-btn" onClick={vibe.finish}>
            Skip ahead
          </button>
        </div>
      )}
      {!streaming && ph.kind === 'review' && vibe.read && (
        <div className="cc-card-review">
          <h2 ref={headRef} tabIndex={-1} className="cc-card-head">
            <span className="cc-mind-dot" />
            {sum?.headline ?? `${mind?.name ?? 'The mind'} proposes a change.`}
          </h2>
          {reviewBody}
          <div className="cc-card-row">
            <button type="button" className="cc-btn" onClick={vibe.reset} title="Close without deciding; the proposal stays in the drawer">
              Later
            </button>
            <button type="button" className="cc-btn" onClick={() => vibe.review('reject')} disabled={!!vibe.pending}>
              Reject
            </button>
            <button type="button" className="cc-btn cc-btn-primary" onClick={() => vibe.review()} disabled={!!vibe.blockedWhy || keeping === 0} title="Accept (⌘↵)">
              {skipping ? `Accept ${keeping}, skip ${skipping}` : 'Accept'}
            </button>
          </div>
        </div>
      )}
      {ph.kind === 'consented' && (
        <div className="cc-card-review">
          <h2 ref={headRef} tabIndex={-1} className="cc-card-head">
            <Icon name="check" size={15} />
            You accepted it. Your OK is {ph.valid}.
          </h2>
          <p className="cc-card-line" role="status">
            <span className="cc-pill-dot cc-pill-live" /> Waiting for {vibe.route?.team ?? 'the swarm'} to put it into your copy…
          </p>
          <p className="cc-card-fine">Only this exact proposal can go in. If it changes first, you’ll be asked to review it again.</p>
          {vibe.note && <p className="cc-card-bad" role="alert">{vibe.note}</p>}
        </div>
      )}
      {ph.kind === 'declined' && (
        <div className="cc-card-line" role="status">
          <Icon name="x" size={15} />
          <span className="min-w-0 flex-1">{ph.checking ? 'Declined. Checking it isn’t already in your copy…' : ph.unknown ? 'Declined. Couldn’t check whether it was already put in your copy: look in the drawer’s Changes.' : 'Declined. Nothing went into your copy, and the swarm can’t put this one in.'}</span>
          <button type="button" className="cc-tool" onClick={vibe.reset} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
      {!streaming && ph.kind === 'applying' && (
        <p className="cc-card-line" role="status">
          <span className="cc-pill-dot cc-pill-live" /> {mind ? <><b>{mind.name}</b>’s change is going into your copy…</> : 'The change is going into your copy…'}
        </p>
      )}
      {ph.kind === 'applied' && (
        <div className="cc-card-review">
          <h2 ref={headRef} tabIndex={-1} className="cc-card-head">
            <Icon name={ph.authorization === 'consented' ? 'check' : 'info'} size={15} />
            {appliedHead(ph, mind?.name ?? 'The mind', file ? ` of ${base(file)}` : '')}
          </h2>
          {ph.beforeDecline && <p className="cc-card-bad" role="alert">This was already put in your copy before you declined. {ph.currency === 'current' ? 'Undo puts your copy back as it was.' : 'Your copy has changed since, so Undo can’t put it back.'}</p>}
          {!ph.beforeDecline && ph.authorization === 'unconsented' && <p className="cc-card-bad" role="alert">You did not accept this change. {ph.currency === 'current' ? 'Undo puts your copy back as it was.' : 'Your copy has changed since, so Undo can’t put it back.'}</p>}
          {!ph.beforeDecline && ph.authorization !== 'consented' && ph.authorization !== 'unconsented' && <p className="cc-card-note">{ph.acceptedHere ? 'The hive doesn’t say which OK it was put in under, so check it’s what you accepted.' : 'This page has no record of your OK for it. Check it, or Undo.'}{ph.currency === 'current' ? '' : ' Your copy has changed since, so Undo can’t put it back.'}</p>}
          {ph.words.length > 0 && (
            <ol className="cc-changes">
              {ph.words.map((w, n) => (
                <li key={w}>
                  <span className="cc-change-n">{n + 1}</span>
                  <span className="cc-change-words">{w}</span>
                </li>
              ))}
            </ol>
          )}
          {vibe.instruction && <p className="cc-card-why">You asked: “{vibe.instruction}”.</p>}
          {ph.currency === 'stale' && <p className="cc-card-note">Your copy has changed since, so Undo can’t put it back without losing the later work. Change it by hand, or ask again.</p>}
          <p className="cc-card-fine">This is your copy, not the running app: nothing is deployed.</p>
          {vibe.undoing?.note && <p className="cc-card-bad" role="alert">{vibe.undoing.note}</p>}
          <div className="cc-card-row">
            {ph.currency === 'current' && (
              <button type="button" className="cc-btn" onClick={() => void vibe.undo()} disabled={!!vibe.undoing?.busy}>
                {vibe.undoing?.busy ? 'Undoing…' : vibe.undoing?.retry ? 'Undo again' : 'Undo'}
              </button>
            )}
            {onTest && <button type="button" className="cc-btn" onClick={onTest}>
              Test it
            </button>}
            <button type="button" className="cc-btn" onClick={() => onDrawer('changes')}>
              See the change
            </button>
            <button type="button" className="cc-tool" onClick={vibe.reset} aria-label="Close">
              <Icon name="x" size={15} />
            </button>
          </div>
        </div>
      )}
      {ph.kind === 'undone' && (
        <div className="cc-card-line" role="status">
          <Icon name="check" size={15} />
          <span className="min-w-0 flex-1">{ph.elsewhere ? 'It was put into your copy and has already been undone (perhaps in another tab).' : 'Undone: your copy is back as it was.'}</span>
          <button type="button" className="cc-tool" onClick={vibe.reset} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
      {ph.kind === 'done' && (
        <div className="cc-card-line" role="status">
          <Icon name="check" size={15} />
          <span className="min-w-0 flex-1">
            {ph.kept ? `Kept ${ph.kept} change${ph.kept === 1 ? '' : 's'}` : 'Rejected'}
            {ph.kept && ph.skipped ? `, skipped ${ph.skipped}` : ''}. {ph.change ? (stream ? 'It’s in your copy; nothing is deployed.' : `Your copy is now at generation ${ph.change.generation}; nothing is deployed.`) : 'The code is unchanged.'}
          </span>
          {ph.change && onTest && (
            <button type="button" className="cc-btn" onClick={onTest}>
              Test it
            </button>
          )}
          {ph.change && (
            <button type="button" className="cc-btn" onClick={() => onDrawer('changes')}>
              See the change
            </button>
          )}
          <button type="button" className="cc-tool" onClick={vibe.reset} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
      {(ph.kind === 'error' || ph.kind === 'unavailable') && (
        <div className={streaming ? 'cc-card-row' : 'cc-card-line'} role={streaming ? undefined : 'alert'}>
          {!streaming && <Icon name="info" size={15} />}
          {!streaming && <span className="min-w-0 flex-1">{ph.text}</span>}
          {ph.kind === 'unavailable' && (
            <button type="button" className="cc-btn" onClick={() => onDrawer('proposals')}>
              Write it yourself
            </button>
          )}
          <button type="button" className="cc-tool" onClick={vibe.reset} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
      )}

      {vibe.reviewing && vibe.read && (
        <DecisionDialog
          icon="check"
          eyebrow="The mind's change"
          title={vibe.reviewing.request.accepted_hunk_ids.length ? `Accept ${vibe.reviewing.request.accepted_hunk_ids.length} change${vibe.reviewing.request.accepted_hunk_ids.length === 1 ? '' : 's'}${vibe.reviewing.request.rejected_hunk_ids.length ? `, skip ${vibe.reviewing.request.rejected_hunk_ids.length}` : ''}` : 'Reject this change'}
          thing="This proposal"
          bound={bindTo(
            { digest: vibe.reviewing.request.suggestion_digest, generation: vibe.reviewing.request.expected_generation, tree: vibe.reviewing.request.expected_tree_digest, currency: 'current' },
            vibe.read.record.id === vibe.reviewing.request.suggestion_id ? { digest: vibe.read.record.digest, generation: vibe.read.content.binding.generation, tree: vibe.read.content.binding.tree_digest, currency: vibe.read.currency } : undefined,
            ['digest', 'generation', 'tree', 'currency'],
            () => (vibe.read?.currency !== 'current' ? 'The source changed (stale).' : null),
          )}
          // Create's bench (the work stream): the person's words only; the ids stay on the full Code page
          facts={vibe.facts(vibe.reviewing, sum?.headline ?? 'A proposed change').filter(([k]) => !stream || !['Proposal', 'Bound to', 'Operation'].includes(k))}
          actions={[{ label: vibe.reviewing.request.accepted_hunk_ids.length ? 'Accept' : 'Reject', busyLabel: 'Recording', tone: 'primary', run: () => vibe.send(vibe.reviewing!) }]}
          onClose={() => vibe.setReviewing(null)}
        />
      )}
    </aside>
  )
}

function Drawer({ tabs = DRAWER_TABS, tab, open, onTab, onClose, phone, bottom, children }: { tabs?: typeof DRAWER_TABS; tab: DrawerTab; open: boolean; onTab: (t: DrawerTab) => void; onClose: () => void; phone: boolean; bottom: number; children: ReactNode }) {
  const headId = useId()
  const t = DRAWER_TABS.find((x) => x.id === tab)!
  return (
    <aside id="cc-drawer" hidden={!open} className={cx('cc-drawer', phone && 'cc-drawer-phone')} aria-labelledby={headId} style={phone ? { bottom } : undefined}>
      <div className="cc-drawer-tabs" role="tablist" aria-label="Drawer" aria-orientation={phone ? 'horizontal' : 'vertical'}>
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={x.id === tab} aria-controls="cc-drawer-panel" title={x.hint} onClick={() => onTab(x.id)}>
            <Icon name={x.icon} size={15} />
            <span>{x.label}</span>
          </button>
        ))}
      </div>
      <div className="cc-drawer-body" role="tabpanel" id="cc-drawer-panel" aria-labelledby={headId}>
        <div className="cc-drawer-head">
          <h2 id={headId}>{t.label}</h2>
          <span className="cc-drawer-hint">{t.hint}</span>
          <button type="button" className="cc-tool" onClick={onClose} aria-label="Close the drawer">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="cc-drawer-content thin-scroll">{children}</div>
      </div>
    </aside>
  )
}

function QuickOpen({ files, current, onPick, onClose, first, note }: { files: string[]; current: string | null; onPick: (f: string) => void; onClose: () => void; first?: string[]; note?: string }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    // the candidates the person's words named come first, marked
    const ordered = first?.length ? [...first.filter((f) => files.includes(f)), ...files.filter((f) => !first.includes(f))] : files
    return (s ? ordered.filter((f) => f.toLowerCase().includes(s)) : ordered).slice(0, 50)
  }, [files, q, first])
  useEscape(onClose)
  const listId = useId()
  return (
    <div className="cc-quick-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cc-quick" role="dialog" aria-modal="true" aria-label="Open a file">
        {note && <p className="cc-quick-note">{note}</p>}
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setAt(0)
          }}
          placeholder={`Open a file (${files.length})`}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[at] ? `${listId}-${at}` : undefined}
          onKeyDown={(e) => {
            // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
            if (guardComposing(e)) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setAt((n) => Math.min(shown.length - 1, n + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setAt((n) => Math.max(0, n - 1))
            } else if (e.key === 'Enter' && shown[at]) {
              e.preventDefault()
              onPick(shown[at])
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label="Files">
          {shown.map((f, n) => (
            <li key={f} id={`${listId}-${n}`} role="option" aria-selected={n === at} data-current={f === current || undefined} data-named={first?.includes(f) || undefined} onPointerDown={(e) => e.preventDefault()} onClick={() => onPick(f)}>
              <span className="cc-quick-base">{base(f)}</span>
              <span className="cc-quick-dir">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
              {first?.includes(f) && <span className="sr-only">, named in your request</span>}
            </li>
          ))}
          {!shown.length && <li className="cc-quick-none">No file matches.</li>}
        </ul>
      </div>
    </div>
  )
}
