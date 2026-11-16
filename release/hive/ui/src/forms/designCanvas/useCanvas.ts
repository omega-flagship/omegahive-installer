import { useCallback, useEffect, useRef, useState } from 'react'
import type { SwarmArtifact } from '../../api/moneyWork'
import { navigate, openInDesign, sameCreation, type CreationReference } from '../../lib/router'
import { useHive } from '../../store/store'
import { askConfirm } from '../../ui/confirm'
import type { FormActResult, FormProps } from '../contract'
import { readContext } from '../../lib/readContext'
import { adoptKept, canRedo, canUndo, commitRevision, current, holdForKeep, isDirty, nextRevision, openDoc, readSource, redo, releaseHold, saveParams, savedReference, sourceFocus, undo, type Change, type Doc, type StudioSource } from './model'
import { pictureName, sceneSvg } from './render'
import { LOAD_ERROR, saveSentence, type Mode } from './words'

export type Phase =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'error'; text: string; retry: boolean }
  | { kind: 'deck' }
  | { kind: 'ready' }

export interface Notice {
  text: string
  tone: 'ok' | 'warn' | 'error'
  /** a way forward, when there is one */
  action?: { label: string; run: () => void }
}
/** A custody receipt for something this canvas sent out of itself in this session. */
export interface Receipt {
  at: string
  what: string
  reference?: CreationReference
  outcome: 'kept' | 'refused' | 'unknown' | 'downloaded'
}

/**
 * Review B2: one delayed operation's fence, taken when it begins: the design generation, the identity (the store session
 * and the client's sign-in, lib/readContext, re-read synchronously from the store and the client at every check), and
 * every sign-in change the client reports meanwhile (`onAuthChange`, so A→B→A on one handle still counts). `reason()`
 * says why it no longer holds; `release()` stops listening.
 */
export interface CanvasFence {
  valid(): boolean
  reason(): null | 'design' | 'identity'
  release(): void
}

export interface CanvasProps extends FormProps {
  source?: CreationReference
  onDirty?: (dirty: boolean) => void
}

/**
 * The canvas's state: the loaded design (as a local revision history in Design's native shape), the selection, the
 * mode, the drawer, notices, and the two ways work leaves the canvas (keep in the hive, behind the host's confirm;
 * a picture download, behind the host's confirm dialog). Nothing else here writes anywhere.
 */
export function useCanvas(props: CanvasProps) {
  const { source, view, act, scope, onDirty } = props
  const [loadedPhase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [loadedDoc, setDocState] = useState<Doc | null>(null)
  // nothing opened: the empty canvas (whatever was loaded before stays out of sight and out of reach)
  const phase: Phase = source ? loadedPhase : { kind: 'empty' }
  const doc = source ? loadedDoc : null
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('make')
  const [drawer, setDrawer] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [busy, setBusy] = useState<null | 'saving' | 'committing'>(null)
  const [recent, setRecent] = useState<SwarmArtifact[] | null>(null)
  /**
   * Stand-in r4 B1: the lifetime epoch the returned controls were rendered under. A cleanup moves the epoch on; a
   * StrictMode replay re-activates the same mount but never the controls rendered before it: it publishes fresh ones
   * by rendering again with the new epoch (Design r6 checks the control's captured epoch the same way).
   */
  const [lifeEpoch, setLifeEpoch] = useState(0)
  /** the latest doc for callbacks; written with every change of the doc (setDoc below) */
  const docRef = useRef<Doc | null>(null)
  const setDoc = useCallback((d: Doc | null) => {
    if (!lifetime.current.active) return
    docRef.current = d
    setDocState(d)
  }, [])
  /** the design generation: bumped whenever another design (or none) is opened; late async work checks it */
  const loadSeq = useRef(0)
  /** the Keep in flight, owned by its own record: only that record may finish it */
  const keeping = useRef<{ fence: CanvasFence } | null>(null)
  /** who set `busy`: only that operation clears it (an old completion never clears a newer operation's state) */
  const busyBy = useRef<object | null>(null)
  const takeBusy = (owner: object, kind: 'saving' | 'committing') => {
    if (!lifetime.current.active) return
    busyBy.current = owner
    setBusy(kind)
  }
  /**
   * Design r6 (adopted with Surface changes): one mounted lifetime. Cleanup withdraws it at once: operations begun
   * before (their fences, see `begin`) can no longer write, owned listeners are released, retained controls refuse.
   * StrictMode's effect replay re-activates the same mount; operations from before the replay stay withdrawn (epoch).
   * Surface: active from the first render (a render that never mounts publishes nothing anyone can call), so no
   * state is set in the setup effect and no extra render is needed to publish controls; declared after docRef so
   * the reviews' verbatim stand-in probes keep their hook slots.
   */
  const lifetime = useRef({ active: true, epoch: 0, releases: new Set<() => void>() })
  const dropBusy = (owner: object) => {
    if (busyBy.current !== owner) return
    busyBy.current = null
    if (lifetime.current.active) setBusy(null)
  }
  useEffect(() => {
    const own = lifetime.current
    own.active = true   // StrictMode replay: the same mount again (the cleanup already moved the epoch on)
    // a replay renders again so fresh controls carry the new epoch; the retired ones keep the old one and stay refused
    if (own.epoch > 0) void Promise.resolve().then(() => { if (own.active) setLifeEpoch(own.epoch) })
    return () => {
      own.active = false
      own.epoch++
      loadSeq.current++
      // Withdraw locally owned subscriptions now; already-invoked host transport is not cancelled here, and what it
      // already posted stays in the hive (Design's custody); only this canvas stops publishing about it.
      for (const release of [...own.releases]) release()
      own.releases.clear()
      docRef.current = null
      keeping.current = null
      busyBy.current = null
      setBusy(null)   // a replayed setup never inherits the withdrawn epoch's busy owner
    }
  }, [])
  const client = useHive((s) => s.client)
  const session = useHive((s) => (s as { session?: unknown }).session)
  // the rendered store, for a store without getState (test stand-ins); the app reads the live store at every check
  const rendered = useRef({ client: client as unknown, session: session as unknown })
  useEffect(() => {
    rendered.current = { client, session }
  })
  const storeNow = (): { client: unknown; session: unknown } => {
    const get = (useHive as unknown as { getState?: () => { client: unknown; session?: unknown } }).getState
    const st = typeof get === 'function' ? get() : rendered.current
    return { client: st.client, session: st.session }
  }
  const identityOf = (st: { client: unknown; session: unknown }) => readContext(st.client as object | null, st.session ?? null, scope ?? null)
  /** Begin a delayed operation: its fence (see CanvasFence). */
  const withdrawnFence = (): CanvasFence => ({ valid: () => false, reason: () => 'design', release: () => undefined })
  const begin = (): CanvasFence => {
    const own = lifetime.current
    if (!own.active) return withdrawnFence()
    const epoch = own.epoch
    const st = storeNow()
    const gen = loadSeq.current
    const who = identityOf(st)
    let changed = false
    let off: (() => void) | undefined
    const release = () => {
      own.releases.delete(release)
      off?.()
      off = undefined
    }
    const listen = (st.client as { onAuthChange?: (l: () => void) => () => void } | null)?.onAuthChange
    if (typeof listen === 'function') off = listen.call(st.client, () => { changed = true })
    own.releases.add(release)
    const reason = (): ReturnType<CanvasFence['reason']> => !own.active || epoch !== own.epoch ? 'design'
      : changed || identityOf(storeNow()) !== who ? 'identity' : gen !== loadSeq.current ? 'design' : null
    return { reason, valid: () => reason() === null, release }
  }

  // ---- reading the design: Design's own view of one exact source revision
  const load = useCallback(
    async (ref: CreationReference) => {
      if (!lifetime.current.active) return
      const n = ++loadSeq.current
      const fence = begin()
      if (!view) {
        fence.release()
        setPhase({ kind: 'error', text: 'This hive cannot read designs here yet. Open it in the Studio.', retry: false })
        return
      }
      setPhase({ kind: 'loading' })
      setNotice(null)   // a word about the design that was open before does not follow the person to this one
      try {
        const g = await view(sourceFocus(ref))
        fence.release()
        if (n !== loadSeq.current || !fence.valid()) return
        const got = readSource(g)
        if (got.kind === 'studio') {
          setDoc(openDoc(got.source, got.reference))
          setSelected(null)
          setPhase({ kind: 'ready' })
        } else if (got.kind === 'deck') setPhase({ kind: 'deck' })
        else setPhase({ kind: 'error', text: got.why, retry: false })
      } catch (e) {
        fence.release()
        if (n !== loadSeq.current || !fence.valid()) return
        const m = e instanceof Error ? e.message : ''
        setPhase({ kind: 'error', text: /not.?found|404|no such/i.test(m) ? 'That version of the design is no longer in the hive.' : /connect|network|fetch/i.test(m) ? 'The hive did not answer. Check the connection and try again.' : LOAD_ERROR, retry: true })
      }
    },
    [view, setDoc], // eslint-disable-line react-hooks/exhaustive-deps -- begin reads live state at call time
  )
  /** a design was asked for since the last empty canvas: only then does going empty drop a late answer */
  const hadSource = useRef(false)
  useEffect(() => {
    if (!source) {
      // a late answer for what was open before is dropped; a rerun with nothing open before (a new `view` on a
      // re-render, as under StrictMode) moves nothing on, so the recent-designs read in flight is not dropped
      if (hadSource.current) loadSeq.current++
      hadSource.current = false
      docRef.current = null
      return
    }
    hadSource.current = true
    // a save already moved the canvas to the kept revision: no second read of what is on screen
    if (docRef.current && sameCreation(docRef.current.reference, source)) return
    void load(source)
  }, [source, load])

  // ---- the person's recent designs in this swarm (a read through the host's artifact list), for the empty canvas
  useEffect(() => {
    if (phase.kind !== 'empty' || !scope || !client?.swarmArtifacts) return
    let live = true
    const fence = begin()   // the list belongs to the person it was read for
    const take = (a: SwarmArtifact[]) => {
      fence.release()
      if (live && fence.valid()) setRecent(a)
    }
    client.swarmArtifacts(scope, { kind: 'studio-source', limit: 6 }).then(take).catch(() => take([]))
    return () => {
      live = false
      fence.release()
    }
  }, [phase.kind, scope, client]) // eslint-disable-line react-hooks/exhaustive-deps -- begin reads live state at call time

  const dirty = !!doc && isDirty(doc)
  useEffect(() => onDirty?.(dirty), [dirty, onDirty])
  // leaving (another view, another app): whatever was not kept is discarded with the canvas, so the host is told
  useEffect(() => () => onDirty?.(false), [onDirty])
  // leaving the page with changes the hive does not have yet asks first (the host does the same for app frames)
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const stepBack = useCallback(() => {
    const d = docRef.current
    if (!d || !canUndo(d)) return
    setDoc(undo(d))
    setNotice(null)
  }, [setDoc])
  const stepForward = useCallback(() => {
    const d = docRef.current
    if (!d || !canRedo(d)) return
    setDoc(redo(d))
  }, [setDoc])


  // ---- local edits: one native revision per edit; a failed edit leaves the design as it was and says why
  const commit = useCallback(async (changes: (Change | null)[], opts: { select?: string | null; say?: string; generation?: CanvasFence } = {}) => {
    const list = changes.filter((c): c is Change => !!c)
    const before = docRef.current
    // work that began on another design or under another sign-in (a picture still being read) is dropped, silently
    if (opts.generation && !opts.generation.valid()) return false
    if (!before || !list.length) return false
    const fence = begin()
    takeBusy(fence, 'committing')
    try {
      const rev = await nextRevision(before, list)
      if (!fence.valid() || (opts.generation && !opts.generation.valid())) return false
      if (docRef.current !== before) {
        setNotice({ text: 'The design changed while that edit was being made; your newer work is kept.', tone: 'warn' })
        return false
      }
      setDoc(commitRevision(before, rev))
      if (opts.select !== undefined) setSelected(opts.select)
      if (opts.say) setNotice({ text: opts.say, tone: 'ok', action: { label: 'Undo', run: () => { if (fence.valid()) stepBack() } } })
      return true
    } catch (e) {
      if (fence.valid()) setNotice({ text: e instanceof Error ? e.message : 'That change could not be made.', tone: 'error' })
      return false
    } finally {
      fence.release()
      dropBusy(fence)
    }
  }, [setDoc, stepBack]) // eslint-disable-line react-hooks/exhaustive-deps -- begin reads live state at call time

  // ---- keep this version in the hive: Design's save-source, confirmed by the person in the host first (§9d).
  // Review B1: the Keep captures exactly what it sends (the doc, its current revision, its source and reference), the
  // design generation and the identity. Its answer may only adopt that: edits made meanwhile stay as newer, not-kept
  // work; a refused or unknown answer keeps everything; an answer for another design or identity writes nothing.
  const keep = useCallback(async () => {
    const d = docRef.current
    if (!d) return
    const live = keeping.current
    if (live && live.fence.valid()) {
      setNotice({ text: 'A version is already being kept. Wait for it to finish, then keep again.', tone: 'warn' })
      return
    }
    // Fix the exact JSON wire and its local snapshot before a fence, hold or busy state is installed.
    // Design's helper refuses an oversized envelope without starting a Keep.
    let sent: ReturnType<typeof saveParams>
    let capturedSource: StudioSource
    let capturedReference: CreationReference
    try {
      sent = saveParams(d)
      capturedSource = JSON.parse(sent.editable_source_json) as StudioSource
      capturedReference = { ...sent.source }
    } catch (e) {
      // Design's helper names a Studio export for this case; the canvas has none, so it says what can be done here
      const big = e instanceof Error && /confirmation limit/.test(e.message)
      setNotice({ text: big ? 'This version is larger than the hive’s 2 MB confirmation limit, so it was not sent. Remove or shrink a picture, then keep it again.' : e instanceof Error ? e.message : 'This version could not be prepared for keeping.', tone: 'warn' })
      return
    }
    // a Keep from before a sign-in change (or another design) is superseded: it can no longer finish anything
    const op = { fence: begin(), epoch: lifetime.current.epoch }
    keeping.current = op
    const rev = capturedSource.current
    setDoc(holdForKeep(d))
    takeBusy(op, 'saving')
    const finish = () => {
      op.fence.release()
      dropBusy(op)   // a superseded Keep leaves the newer operation's busy state alone
      if (keeping.current === op) keeping.current = null
    }
    let r: FormActResult
    try {
      r = op.fence.valid() ? await act('save-source', [], sent) : { status: 'refused', message: 'Not sent: the sign-in or the design changed.' }
    } finally {
      finish()
    }
    // the answer is adopted only under the identity, design and exact source it was sent for, read right now
    const why = op.fence.reason()
    if (!lifetime.current.active || lifetime.current.epoch !== op.epoch || why === 'identity') return   // signed in as someone else meanwhile (even A→B→A): the old answer is not theirs
    const at = new Date().toISOString()
    const ref = r.status === 'done' ? savedReference(r) : null
    const now = docRef.current
    if (why === 'design' || !now || !sameCreation(now.reference, capturedReference)) {
      // another design (or none) is open now: record what happened to the one that was kept; touch nothing on screen
      setReceipts((x) => [{ at, what: `Keep of revision ${rev.revision} (answered after another design was opened)`, ...(ref ? { reference: ref } : {}), outcome: ref ? 'kept' : r.unknown ? 'unknown' : 'refused' }, ...x])
      return
    }
    const said = saveSentence(r)
    if (r.status === 'done' && ref) {
      setReceipts((x) => [{ at, what: `Kept revision ${rev.revision} in the hive`, reference: ref, outcome: 'kept' }, ...x])
      const next = adoptKept(now, { source: capturedSource, revision: rev, reference: ref })
      if (!next) {
        setDoc(releaseHold(now))
        setNotice({ text: `Kept in the hive as revision ${ref.revision}. Your work on screen is unchanged and not kept yet.`, tone: 'warn' })
        return
      }
      setDoc(next)
      if (isDirty(next)) {
        setNotice({ text: `${said.text} It is revision ${ref.revision}. Your newer changes are not kept yet.`, tone: 'ok' })
        return
      }
      setNotice({ text: `${said.text} It is revision ${ref.revision} of this design.`, tone: 'ok' })
      if (scope) {
        onDirty?.(false)   // the host must not ask "discard unsaved edits?" for the version just kept
        const route = openInDesign(ref, scope)
        if (route) navigate(route, { replace: true })
      }
      return
    }
    setDoc(releaseHold(now))
    setReceipts((x) => [{ at, what: 'Keep in the hive', outcome: r.unknown ? 'unknown' : 'refused' }, ...x])
    setNotice({ text: said.text, tone: said.tone, ...(r.unknown ? { action: { label: 'Show versions', run: () => { if (op.fence.valid()) setDrawer(true) } } } : {}) })
  }, [act, scope, onDirty, setDoc]) // eslint-disable-line react-hooks/exhaustive-deps -- begin reads live state at call time

  // ---- a picture of the design to this device: the host's confirm first; nothing is sent anywhere
  const download = useCallback(async () => {
    const d = docRef.current
    if (!d) return
    const scene = current(d).scene
    let svg: string
    try {
      svg = sceneSvg(scene)
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : 'The picture could not be drawn.', tone: 'error' })
      return
    }
    const fence = begin()
    const ok = await askConfirm(`Save a picture of “${scene.title || 'this design'}” (${pictureName(scene)}, SVG) to this device? It is the canvas’s unverified mirror of Design’s drawing, not Design’s verified export. It is not shared with anyone and the hive keeps no copy.`, 'Save picture')
    fence.release()
    if (!ok || !fence.valid()) return   // confirmed after a sign-in change or on another design: nothing is saved
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = pictureName(scene)
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
    setReceipts((x) => [{ at: new Date().toISOString(), what: `Picture ${pictureName(scene)} saved to this device (unverified mirror of Design’s drawing)`, outcome: 'downloaded' }, ...x])
    setNotice({ text: 'Picture saved to this device (an unverified mirror of Design’s drawing).', tone: 'ok' })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- begin reads live state at call time

  // Retained controls belong to the mounted lifetime and the epoch they were rendered under: after unmount, and after a
  // StrictMode replay for controls rendered before it, they refuse (or settle) without writing.
  const controlsLive = () => lifetime.current.active && lifetime.current.epoch === lifeEpoch
  return {
    phase,
    doc,
    scene: doc ? current(doc).scene : null,
    revision: doc ? current(doc) : null,
    selected,
    select: (...args: Parameters<typeof setSelected>) => { if (controlsLive()) setSelected(...args) },
    mode,
    setMode: (...args: Parameters<typeof setMode>) => { if (controlsLive()) setMode(...args) },
    drawer,
    setDrawer: (...args: Parameters<typeof setDrawer>) => { if (controlsLive()) setDrawer(...args) },
    notice,
    setNotice: (...args: Parameters<typeof setNotice>) => { if (controlsLive()) setNotice(...args) },
    receipts,
    busy,
    dirty,
    recent,
    commit: (...args: Parameters<typeof commit>) => controlsLive() ? commit(...args) : Promise.resolve(false),
    undo: () => { if (controlsLive()) stepBack() },
    redo: () => { if (controlsLive()) stepForward() },
    canUndo: !!doc && canUndo(doc),
    canRedo: !!doc && canRedo(doc),
    keep: () => controlsLive() ? keep() : Promise.resolve(),
    download: () => controlsLive() ? download() : Promise.resolve(),
    retry: () => (controlsLive() && source ? load(source) : undefined),
    /** Begin delayed local work (a picture being read): pass it to commit, which drops the work if the fence no longer holds. */
    generation: () => controlsLive() ? begin() : withdrawnFence(),
  }
}
export type CanvasState = ReturnType<typeof useCanvas>
