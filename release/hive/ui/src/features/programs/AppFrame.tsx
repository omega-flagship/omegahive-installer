import { ApiError } from '../../api/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { appDocument, isFrameSender, revisionFrame, subscriptionTarget, type FrameDocument } from '../../lib/appFrame'
import { appContext, appPerson, BRIDGE_LIMITS, cancelledReply, parseBridgeMessage, pickedReply, rateLimit, type AppContext, type AppPerson, type PickAccept, type PickCandidate } from '../../lib/appBridge'
import { FrameAssetGrants, studioDispatcher } from '../../lib/studioBridge'
import { useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import type { ProgramUiRelease } from '../../api/types'
import { askMemory, hiveKey } from '../../lib/askMemory/store'
import { readMemoryThemes } from '../../lib/memoryTheme'
import { memoryHostCurrent, memoryNotice, memoryOpenBudget, memoryReasonTokens, memoryRefused, nextMemoryOpeningKey, parseMemoryRequest, readMemorySession, type MemorySession } from '../../lib/appMemory'
import { AppMemoryHost, type AppMemoryHostState } from './AppMemory'
import { useReducedMotion } from '../../lib/hooks'
import { type CreationReference } from '../../lib/router'
import { chromeFor, experienceById } from '../../experiences/registry'
import type { ExperienceChrome } from '../../experiences/chrome'
import { appIdentityTokens, appTheme } from '../../shell/appLook'
import { blockedReason, DEFAULT_VARIANT, useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { ErrorState } from '../../ui/primitives'
import { AppPicker } from './AppPicker'
import { FileViewer, OpenUrlPrompt } from './FrameOpsDialogs'
import {
  actFileError, actFileRefused, bindFrameRequest, checkUrl, declaredReads, FRAME_BUCKET, FRAME_OP_LIMITS, FRAME_WIRE, FrameGoals, fileRefused, frameBack, frameRefusal, goalNotice,
  parseFrameOp, readRefused, readReply, startedGoal, tokenBucket, urlRefused, viewable,
  type ShowMime,
} from '../../lib/frameOps'
import { CONFIRM_AGAIN, frameConfirmReply } from '../../lib/hostConfirm'
import { admitFrameAct } from './frameAct'
import { useHostConfirm, type HostConfirmFinal } from './HostConfirm'
import type { Insets, Reserved } from '../../lib/frameFit'
import { useStageFit } from './useStageFit'
import { parseFrameLive, WIRE } from '../studioLive/wire'
import { attachFrame, detachFrame, frameOutcome, framePiece } from '../studioLive/store'
import { askKeys, askObject, readAppAskRelease, type AppAskRelease } from '../../api/appAsk'
import { parseAppAsk } from '../../lib/appAsk'
import { useAppAsk, appAskVisible } from './AppAsk'
import { useAppLinks } from './AppLinks'
import { readAppPresentation, type AppLinkEntry, type AppPresentation } from '../../lib/appLinks'
import { restoreAfterConsent } from '../../lib/appLinkRestore'

/** J3 r4.3 O3: each frame document's mount generation (time-based so a reload never reuses an older one). */
let mountSeq = 0
const nextMount = () => Date.now() * 1000 + (++mountSeq % 1000)

/** The verified host UI envelope carries P8 themes beside P1's pinned identity. Neither crosses into srcdoc.
 * Keep P1's closed release parser unchanged: project only its two known fields after checking this host envelope. */
function appAskUiRelease(value: unknown): AppAskRelease | null {
  if (!askObject(value) || !askKeys(value, ['digest', 'version', 'memory_theme', 'memory_theme_dark'])) return null
  return readAppAskRelease({ digest: value.digest, version: value.version })
}

/** The bridge `context` for this app now: the experience and its chrome, the app's identity in the look, motion. */
function useFrameContext(programId: string, insets: Insets, reserved: Reserved, ask = false): AppContext {
  const look = useLook()
  const program = useHive((s) => s.programs?.find((p) => p.id === programId))
  const client = useHive((s) => s.client)
  const prefersReduced = useReducedMotion()
  const experience = experienceById(look.current?.experience).id
  const [chrome, setChrome] = useState<{ id: string; c: ExperienceChrome | null } | null>(null)
  useEffect(() => {
    let live = true
    void chromeFor(experience).then((c) => live && setChrome({ id: experience, c }), () => live && setChrome({ id: experience, c: null }))
    return () => {
      live = false
    }
  }, [experience])
  const chosen = look.worn
  const variant = chosen && !blockedReason(chosen) ? chosen : DEFAULT_VARIANT
  const theme = appTheme(program, look.current?.apps ?? 'owner')
  const appIdentity = useMemo(() => (theme ? appIdentityTokens(theme, variant) : null), [theme, variant])
  const reducedMotion = prefersReduced || look.motion === 'none'
  const picker = !!(client?.swarmArtifacts || client?.listAssets)
  // Studio slice 2: drafts need the routes and a signed-in person (/api/auth/me person_kind, local_operator)
  const drafts = !!(client?.putAppDraft && client.listAppDrafts && client.getAppDraft && client.deleteAppDraft)
  // studio-host-seam r1 (Surface P2): the person is re-read on every identity change, not only a new client
  const identity = useIdentityEpoch()
  const [person, setPerson] = useState<{ client: unknown; epoch: number; p: AppPerson | null } | null>(null)
  useEffect(() => {
    let live = true
    const binding = bindEpoch()
    const take = (p: AppPerson | null) => live && binding.commit(() => setPerson({ client, epoch: binding.epoch, p }))
    if (client?.me) void client.me().then((m) => take(appPerson(m)), () => take(null))
    return () => {
      live = false
    }
  }, [client, identity])
  const personNow = person?.client === client && person.epoch === identity ? person.p : null
  const chromeNow = chrome?.id === experience ? chrome.c : null
  // frame ops (§9c): reads need the route and at least one read the app declares (describe().reads)
  const describe = useHive((s) => s.programDetails[programId]?.describe ?? null)
  const reads = !!client?.programRead && (declaredReads(describe)?.size ?? 0) > 0
  // Fit (§9c): measured in the frame's own box; a change re-sends `context`
  return useMemo(
    () => appContext({ experience, chrome: chromeNow, identity: appIdentity, reducedMotion, picker, drafts, person: personNow, reads, frameOps: true, ask, insets, reserved }),
    [experience, chromeNow, appIdentity, reducedMotion, picker, drafts, personNow, reads, ask, insets, reserved],
  )
}

/** Runs an app's own interface (its pinned ui/ files) isolated, and answers its requests: `view` and `act` for THIS
 *  app in THIS swarm only, both fixed by the host. The frame never holds a token and has no network. */
export function AppFrame({ programId, swarmId, source, onDirty, onBack, entry, untrustedIntent, onFenceReady, onLinkDepth }: {
  programId: string
  swarmId: string
  source?: CreationReference
  onDirty?: (dirty: boolean) => void
  /** G7: the host's own Back (programBackOrExit), for a frame's `back-request` or forwarded `escape`. */
  onBack?: () => void
  /** Parent-held entry pass and view-only data; neither enters srcdoc/context. */
  entry?: AppLinkEntry
  untrustedIntent?: string
  onFenceReady?: (fence: (() => void) | null) => void
  onLinkDepth?: (linked: boolean) => void
}) {
  const client = useHive((s) => s.client)
  const frame = useRef<HTMLIFrameElement>(null)
  // studio-host-seam r1 (Surface P2): a document belongs to the identity it was loaded under (lib/identityEpoch). A
  // change of person, even on the same client (a re-login, a store re-init), loads a new document for the new person;
  // nothing the earlier one asks for is sent as them, and nothing that answers late is posted to it as a success.
  const identity = useIdentityEpoch()
  const [entryForDocument, setEntryForDocument] = useState(entry)
  const [requireNormalConsent, setRequireNormalConsent] = useState(false)
  const appLinkLifetime = useRef(!!entry)
  const [linked, setLinked] = useState<{ entry: AppLinkEntry; intent?: string; saved: { epoch: number; digest: string; snapshot: AppPresentation } | null } | null>(null)
  const restore = useRef<{ epoch: number; digest: string; snapshot: AppPresentation; entryId: string } | null>(null)
  const returning = useRef<symbol | null>(null)
  const snapshotFence = useRef(0)
  const stopTarget = useRef<(() => void) | null>(null)
  const [childLinked, setChildLinked] = useState(false)
  const fenceDocument = useRef<() => void>(() => undefined)
  const [loaded, setLoaded] = useState<{ doc: FrameDocument; binding: EpochBinding; release?: ProgramUiRelease; askRelease: AppAskRelease | null; memorySession: MemorySession | null; memoryDeadline: number | null } | null>(null)
  const [reload, setReload] = useState(0)
  const [askDocument, setAskDocument] = useState<string | null>(null)
  const frameLoads = useRef<string | null>(null)
  const doc = loaded?.doc ?? null
  const [error, setError] = useState<string | null>(null)
  const appName = useHive((s) => s.programs?.find((p) => p.id === programId)?.name) ?? programId
  const [layout, setLayout] = useState<'framed' | 'full'>('framed')
  const [memoryMode, setMemoryMode] = useState<'light' | 'dark'>('light')
  const [memoryOpening, setMemoryOpening] = useState<AppMemoryHostState | null>(null)
  const closeMemory = useRef<() => void>(() => undefined)
  const frameLoad = useRef<() => void>(() => undefined)
  const frameLifecycle = useRef<{ channel: string; initialLoaded: boolean } | null>(null)
  // Fit (§9c): the stage measured for this frame (safe areas, Ω), and where the host's notices go meanwhile
  const fit = useStageFit(frame, layout, !!doc)
  // Studio slice 1 (PROGRAMS.md §9): the data-only `context`, and one host picker at a time for this frame
  const [askLive, setAskLive] = useState(false)
  const context = useFrameContext(programId, fit.insets, fit.reserved, askLive)
  const contextNow = useRef(context)
  const linkRegistration = useRef<() => Promise<string | null>>(() => Promise.resolve(null))
  const post = useRef<((value: object) => void) | null>(null)   // the live frame's reply, while its bridge is installed
  const ask = useAppAsk({ client, app: programId, appName, channel: doc?.channel ?? null,
    release: loaded?.askRelease ?? null, binding: loaded?.binding ?? null, frame,
    person: context.person?.kind === 'person', documentReady: askDocument === doc?.channel,
    autoOpen: requireNormalConsent, entry: entryForDocument, entryFrame: () => linkRegistration.current(), post: (value) => post.current?.(value), active: setAskLive })
  const askNow = useRef(ask); askNow.current = ask
  const grants = useRef<FrameAssetGrants | null>(null)           // slice 2: files the person picked in THIS frame session
  const greeted = useRef(false)                                   // the frame said app-ready (it is listening)
  const [picker, setPicker] = useState<{ id: string; channel: string; accept: PickAccept[]; kinds: string[] | null } | null>(null)
  const pickerOpen = useRef(false)
  // frame ops (§9c): one host prompt/viewer/confirm of each kind at a time, answered to the frame that asked
  const [urlAsk, setUrlAsk] = useState<{ id: string; channel: string; url: URL } | null>(null)
  const [fileShow, setFileShow] = useState<{ id: string; channel: string; name: string; mime: ShowMime; bytes: ArrayBuffer } | null>(null)
  // §9d: every confirm act (file or not) goes through the host's own confirm; one at a time, answered exactly once
  const confirm = useHostConfirm(programId, swarmId)   // review B1: bound to this app and swarm, and the connection it was asked under
  const confirmNow = useRef(confirm)   // ask/isOpen/cancelAll are stable; the bridge below reads them through this
  const open = useRef({ url: false, file: false })
  const describe = useHive((s) => s.programDetails[programId]?.describe ?? null)
  const describeNow = useRef(describe)
  const onBackNow = useRef(onBack)
  useEffect(() => {
    describeNow.current = describe
    onBackNow.current = onBack
  }, [describe, onBack])
  const links = useAppLinks({ client, app: programId, swarm: swarmId, channel: doc?.channel ?? null,
    binding: loaded?.binding ?? null, person: context.person?.kind === 'person', documentReady: askDocument === doc?.channel,
    entry: entryForDocument, current: () => !!doc && !!loaded?.binding.current(), visible: () => appAskVisible(frame.current),
    modal: () => !!memoryOpening || pickerOpen.current || open.current.url || open.current.file || confirmNow.current.isOpen(),
    post: value => post.current?.(value),
    navigate: (next, intent, snapshot) => {
      const valid = readAppPresentation(snapshot)
      const saved = valid && loaded?.release ? { epoch: identity, digest: loaded.release.digest, snapshot: valid } : null
      appLinkLifetime.current = true
      fenceDocument.current() // authority dies before unmount or target rendering
      setAskDocument(null); setLoaded(null)
      setLinked({ entry: next, intent, saved })
      if (!saved) void client?.appLinkPresentation?.(next.id, true).catch(() => undefined)
    },
  })
  const linksNow = useRef(links); linksNow.current = links
  linkRegistration.current = links.ready
  const freshBack = async () => {
    if (!linked || returning.current) return
    const ticket = Symbol('back'), binding = bindEpoch(), previous = linked, fence = snapshotFence.current
    returning.current = ticket
    stopTarget.current?.()
    let saved: typeof restore.current = null
    try {
      if (previous.saved?.epoch === binding.epoch && client?.appLinkPresentation) {
        const answer = await client.appLinkPresentation(previous.entry.id)
        if (binding.current() && snapshotFence.current === fence && answer && typeof answer === 'object' && Object.keys(answer).join(',') === 'current' && (answer as { current?: unknown }).current === true) saved = { ...previous.saved, entryId: previous.entry.id }
      }
    } catch { /* fresh entry remains available; unknown freshness never restores */ }
    finally { if (returning.current === ticket) returning.current = null }
    if (!binding.current()) return
    setEntryForDocument(undefined) // never replay the caller's old C2 pass
    restore.current = saved
    setRequireNormalConsent(true)
    setLinked(null); setAskDocument(null); setLoaded(null); setReload(n => n + 1)
  }
  useEffect(() => {
    onFenceReady?.(() => { stopTarget.current?.(); fenceDocument.current(); linksNow.current.cancel() })
    const off = onIdentityChange(() => {
      stopTarget.current?.(); fenceDocument.current(); linksNow.current.cancel()
      if (appLinkLifetime.current) setRequireNormalConsent(true)
      setLinked(null); restore.current = null; snapshotFence.current++; returning.current = null; setEntryForDocument(undefined); setAskDocument(null); setLoaded(null)
    })
    return () => { off(); onFenceReady?.(null) }
  }, [onFenceReady])
  useEffect(() => {
    if (!linked?.saved || !client) return
    const id = linked.entry.id, binding = bindEpoch()
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const drop = () => { if (alive && binding.current()) { snapshotFence.current++; setLinked(value => value?.entry.id === id && value.saved ? { ...value, saved: null } : value) } }
    const off = client.subscribe(event => {
      const e = event as unknown as { type: string; program?: unknown }
      if ((e.type === 'program.release_changed' || e.type === 'app.grants_revoked' || e.type === 'app.release_refused') && e.program === programId) drop()
      if (e.type === 'program.updated' && e.program && typeof e.program === 'object') {
        const program = e.program as { id?: unknown; enabled?: unknown; digest?: unknown }
        if (program.id === programId && (program.enabled !== true || program.digest !== linked.saved?.digest)) drop()
      }
    })
    const check = async () => {
      try {
        const result = await client.appLinkPresentation?.(id)
        if (!alive || !binding.current()) return
        if (!result || typeof result !== 'object' || Object.keys(result).join(',') !== 'current' || (result as { current?: unknown }).current !== true) { drop(); return }
      } catch { drop(); return }
      timer = setTimeout(() => void check(), 500)
    }
    void check()
    return () => {
      alive = false; clearTimeout(timer); off()
      if (restore.current?.entryId !== id) void client.appLinkPresentation?.(id, true).catch(() => undefined)
    }
  }, [client, programId, linked?.saved ? linked.entry.id : null])
  useEffect(() => { onLinkDepth?.(!!linked); return () => onLinkDepth?.(false) }, [onLinkDepth, !!linked])
  const goalsRef = useRef<FrameGoals | null>(null)
  useEffect(() => {
    contextNow.current = context
    if (greeted.current) post.current?.({ type: 'context', ...context })   // and again whenever it changes
  }, [context])

  useEffect(() => {
    let live = true
    if (!client?.programUi || linked) return
    const binding = bindEpoch()
    // Session metadata is a document-load read, not a memory op. Its identity, principal and known expiry bind
    // every later local review. A hive that cannot report it can still render the app, without memory access.
    void Promise.all([client.programUi(programId), client.me ? client.me().catch(() => null) : Promise.resolve(null)]).then(([r, me]) => {
      if (!live) return
      binding.commit(() => {
        try {
          if (r.program !== programId) throw new Error('Unexpected app interface identity')
          const next = appDocument(r.files, location.origin, crypto.randomUUID(), crypto.randomUUID(), r.scripts)
          frameLifecycle.current = { channel: next.channel, initialLoaded: false }
          const memorySession = readMemorySession(me)
          const memoryDeadline = memorySession?.expiresAt == null ? null : performance.now() + Math.max(0, memorySession.expiresAt - Date.now())
          setLoaded({ doc: next, binding, release: r.release, askRelease: appAskUiRelease(r.release), memorySession, memoryDeadline })
        }
        catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      })
    }).catch((e) => live && binding.commit(() => setError(e instanceof Error ? e.message : String(e))))
    return () => { live = false; setLoaded(null); setError(null); setAskDocument(null) }
  }, [client, programId, identity, reload, linked])

  useEffect(() => {
    if (!loaded || !client) return
    const { doc, binding: docBinding } = loaded
    let disposed = false
    let releaseCurrent = true
    let memory: { id: string; controller: AbortController; opened: boolean } | null = null
    const send = (value: object, transfer: Transferable[] = []) => { if (!disposed) frame.current?.contentWindow?.postMessage({ ...value, channel: doc.channel }, '*', transfer) }
    // host-initiated posts (context, notices, dialog answers) only while the document's person is the current one
    const notify = (value: object, transfer: Transferable[] = []) => void docBinding.commit(() => send(value, transfer))
    post.current = notify
    const close = () => {
      const old = memory
      memory = null
      if (old) { old.controller.abort(); if (old.opened) notify(memoryNotice('closed', old.id)) }
      setMemoryOpening(null)
    }
    closeMemory.current = close
    frameLoad.current = () => { releaseCurrent = false; close() }
    const pageGone = () => { releaseCurrent = false; close(); linksNow.current.cancel() }
    window.addEventListener('pagehide', pageGone)
    const offMemoryIdentity = onIdentityChange(() => { close(); memoryOpenBudget.clear(); memoryReasonTokens.clear() })
    const release = loaded.release
    const themes = release ? readMemoryThemes(release) : null
    const memoryCurrent = () => {
      const currentProgram = useHive.getState().programs?.find((p) => p.id === programId)
      const view = askMemory.getView()
      return !!themes && memoryHostCurrent({ session: loaded.memorySession, owner: view.owner, hive: hiveKey(client.mode),
        program: currentProgram, releaseDigest: release?.digest, identityCurrent: docBinding.current(), ready: view.ready,
        documentCurrent: !disposed && releaseCurrent && (loaded.memoryDeadline === null || performance.now() < loaded.memoryDeadline)
          && frameLifecycle.current?.channel === doc.channel })
    }
    const offMemoryStore = useHive.subscribe(() => { if (memory && !memoryCurrent()) close() })
    const offMemoryOwner = askMemory.subscribe(() => { if (memory && !memoryCurrent()) close() })
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const checkExpiry = () => {
      const expires = loaded.memorySession?.expiresAt
      if (expires === null || expires === undefined) return
      const remaining = Math.min(expires - Date.now(), loaded.memoryDeadline === null ? Infinity : loaded.memoryDeadline - performance.now())
      if (remaining <= 0) { releaseCurrent = false; close(); return }
      expiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647))
    }
    checkExpiry()
    greeted.current = false
    const limits = { 'context?': rateLimit(...BRIDGE_LIMITS['context?']), pick: rateLimit(...BRIDGE_LIMITS.pick) }
    const frameGrants = new FrameAssetGrants()   // a new document (or a reload) starts with no picked files
    grants.current = frameGrants
    const studio = studioDispatcher({ client, programId, swarmId, draftSave: () => contextNow.current.capabilities.draftSave, grants: frameGrants })
    const subscribed = new Set<string>()   // r2.8: artifacts this frame asked for; each revision notice goes to it, nothing else
    const subscriptionEpoch = new Map<string, number>() // an older authorization cannot undo a later stop/restart
    const goals = new FrameGoals()          // G9: goals THIS frame's acts started; a new frame starts with none
    goalsRef.current = goals
    const bucket = tokenBucket(...FRAME_BUCKET)   // every message from the frame spends a token
    const opLimits = Object.fromEntries(Object.entries(FRAME_OP_LIMITS).map(([k, [n, ms]]) => [k, rateLimit(n, ms)])) as Record<keyof typeof FRAME_OP_LIMITS, (key: string) => boolean>
    const readsInflight = { n: 0 }
    let entryWaits = 0, entryAdmitted = false
    // J3 r4.3 O3: this document's mount for a live Studio session (Design's receiver runs inside the frame). Close goes
    // to the frame unconditionally (it carries nothing); everything else only while the document's person is current.
    const mount = nextMount()
    const livePort = { mount, programId, swarmId, post: (msg: object) => ((msg as { type?: string }).type === WIRE.close ? send(msg) : notify(msg)) }
    const stopEvents = client.subscribe((event) => {
      if (event.type === 'program.release_changed' && event.program === programId
        || event.type === 'program.updated' && event.program.id === programId && (!event.program.enabled || event.program.digest !== release?.digest)) {
        releaseCurrent = false; close()
      }
      for (const id of subscribed) {
        const out = revisionFrame(event as never, swarmId, id)
        if (out) notify(out)
      }
      // G9: only events the page itself received (already filtered for this viewer); status only, nothing fetched
      const notice = goalNotice(event as never, swarmId, goals)
      if (notice) notify(notice)
    })
    const hostModal = () => !!memory || pickerOpen.current || open.current.url || open.current.file || confirmNow.current.isOpen()
    // §9d: how a host confirm ended, told to the frame that asked (this document only): the result, never the token
    const settleAct = async (id: string, asked: Promise<HostConfirmFinal>, reply: (value: object) => void) => {
      const f = await asked
      if (!docBinding.current()) return reply({})   // an answer after a person change cannot commit host state
      if (f.kind === 'done') {
        goals.record(startedGoal(f.result))   // G9: only goals this frame's own act started
        return reply(frameConfirmReply(id, { kind: 'done', result: f.result }))
      }
      if (f.kind === 'declined') return reply(actFileRefused(id, f.uncertain ? 'unavailable' : 'declined', f.uncertain === false && f.running !== true))
      // review B1: cancelled by an identity change: the frame (if this document is still live) hears unavailable, no toast
      if (f.kind === 'stale') return reply(actFileRefused(id, 'unavailable', f.sent === false))
      if (f.kind === 'refused') {
        if (f.reason === 'confirm-required' && !disposed) useHive.getState().toast({ tone: 'error', title: CONFIRM_AGAIN, body: `${programId} asked for an action; nothing was done.` })
        return reply(actFileRefused(id, f.reason))
      }
      return reply(actFileRefused(id, actFileError(f.error), f.sent === false,
        f.sent === false && f.error instanceof ApiError && f.error.status === 403 && f.error.code === 'app_inactive' ? 'app_inactive' : undefined))
    }
    fenceDocument.current = () => {
      releaseCurrent = false
      askNow.current.fence(); linksNow.current.cancel(); confirmNow.current.cancelAll()
      close(); frameGrants.clear(); goals.clear(); subscribed.clear(); subscriptionEpoch.clear()
      disposed = true; post.current = null
    }
    const receive = async (event: MessageEvent) => {
      if (disposed || !releaseCurrent) return
      if (!isFrameSender(event, frame.current?.contentWindow ?? null, doc.channel)) return
      if (!bucket.take()) {
        const refused = frameRefusal(event.data, 'rate-limited')
        return refused ? notify(refused) : undefined
      }
      // studio-host-seam r1 (Surface P2): every request is bound to the identity it arrives under. One from a
      // document loaded for an earlier person is not sent; an answer that lands after a change of person is posted
      // as unknown ('unavailable', never act_not_sent), never as its result.
      const req = bindFrameRequest(docBinding, bindEpoch(), event.data)
      const reply = (value: object, transfer: Transferable[] = []) => {
        const out = req.settle(value)
        if (out) send(out, out === value ? transfer : [])
      }
      if (!req.admitted) return reply({})
      const m = event.data as { type?: string; id?: string; op?: string; body?: Record<string, unknown> }
      if (linksNow.current.presentation(event.data)) return
      if ((entryForDocument || requireNormalConsent) && m.type !== 'app-ready' && m.type !== 'context?') {
        if (entryWaits >= 4) { const out = frameRefusal(event.data, 'unavailable'); if (out) reply(out); return }
        entryWaits++
        let admitted = false
        try {
          if (!entryAdmitted) entryAdmitted = await askNow.current.ensureEntry()
          const fid = await linksNow.current.ready()
          if (entryAdmitted && fid) {
            const checked = entryForDocument && client.appLinkCheck ? await client.appLinkCheck(entryForDocument.id, { frame_id: fid })
              : client.appLinkCheckFrame ? await client.appLinkCheckFrame(programId, fid) : null
            admitted = !!checked && typeof checked === 'object' && Object.keys(checked).join(',') === 'current' && (checked as { current?: unknown }).current === true
          }
        } catch { admitted = false } finally { entryWaits-- }
        if (disposed || !releaseCurrent || !docBinding.current()) return
        if (!admitted) { const out = frameRefusal(event.data, 'unavailable'); if (out) reply(out); return }
      }
      const appLink = linksNow.current.receive(event.data)
      if (appLink) {
        const result = await appLink
        if (!disposed && releaseCurrent && docBinding.current() && result) reply(result)
        return
      }
      const askRequest = parseAppAsk(event.data)
      if (askRequest) {
        const result = await askNow.current.receive(event.data)
        if (result) return reply(result)
        const id = askRequest.ok ? askRequest.request.id : askRequest.id
        return id ? reply({ type: 'app-reply', id, ok: false, code: 'not_available', error: 'Ask is unavailable here.' }) : undefined
      }
      const memoryRequest = parseMemoryRequest(event.data)
      if (memoryRequest) {
        if (!memoryRequest.ok) return memoryRequest.id ? reply(memoryRefused(memoryRequest.id, memoryRequest.reason)) : undefined
        const asked = memoryRequest.request
        if (hostModal()) return reply(memoryRefused(asked.id, 'busy'))
        if (!memoryCurrent()) return reply(memoryRefused(asked.id, 'unavailable'))
        const reason = asked.token ? memoryReasonTokens.resolve(asked.token, programId, swarmId, release!.digest) : asked.topic
        if (!reason) return reply(memoryRefused(asked.id, 'invalid'))
        // Transient user activation is browser-owned. A frame message cannot claim that the person is active.
        const activelyUsed = document.visibilityState === 'visible' && document.hasFocus() && document.activeElement === frame.current && navigator.userActivation?.isActive === true
        if (!memoryOpenBudget.admit(`${docBinding.epoch}:${programId}`, activelyUsed)) return reply(memoryRefused(asked.id, 'rate-limited'))
        const controller = new AbortController()
        const pending = { id: asked.id, controller, opened: false }
        memory = pending
        const guard = { signal: controller.signal, current: () => memory === pending && !controller.signal.aborted && memoryCurrent() }
        const snapshot = await askMemory.openReview(guard)
        if (!guard.current()) return
        if (!snapshot) { close(); return reply(memoryRefused(asked.id, 'unavailable')) }
        setMemoryOpening({ hostKey: nextMemoryOpeningKey(), opening: { id: asked.id, appName, topic: reason, theme: asked.theme, themes: themes!, snapshot, guard } })
        pending.opened = true
        return reply(memoryNotice('opened', asked.id))
      }
      if (m.type === 'app-ready') {
        reply({ type: 'app-context', program: programId, swarm_id: swarmId, ...(source ? { source } : {}) })
        greeted.current = true
        reply({ type: 'context', ...contextNow.current })
        if (untrustedIntent !== undefined) reply({ type: 'app-view-input', input: { untrusted_intent: untrustedIntent }, authoritative: false })
        const retained = restore.current
        restore.current = null // one attempted restore; never retained as authority or logged
        if (retained && retained.epoch === docBinding.epoch && retained.digest === loaded.release?.digest && client.appLinkPresentation) {
          const current = () => !disposed && releaseCurrent && docBinding.current()
          void restoreAfterConsent({
            needsConsent: !!(requireNormalConsent || entryForDocument),
            ensureEntry: () => askNow.current.ensureEntry(),
            frame: () => linksNow.current.ready(),
            check: (fid) => entryForDocument && client.appLinkCheck ? client.appLinkCheck(entryForDocument.id, { frame_id: fid })
              : client.appLinkCheckFrame ? client.appLinkCheckFrame(programId, fid) : null,
            current,
            consume: () => client.appLinkPresentation!(retained.entryId, true),
            burn: () => void client.appLinkPresentation?.(retained.entryId, true).catch(() => undefined),
            restore: () => { const presentation = readAppPresentation(retained.snapshot); if (presentation) notify({ type: 'presentation-restore', ...presentation }) },
          }).catch(() => undefined)
        }
        // the app-ready path awaited the frame's admission above: attach only for the sign-in and document still current
        if (disposed || !releaseCurrent || !docBinding.current()) return
        return attachFrame(livePort)   // J3 r4.3 O3: may receive for this person's live session, if it is this app's
      }
      // J3 r4.3 O3: the receiver's current-piece captures and terminal outcomes, for THIS mount only (wire.ts)
      const live = parseFrameLive(event.data)
      if (live) {
        if (live.kind === 'piece' && live.receiver_generation === mount) framePiece(mount, live.session_id, live.capture)
        else if (live.kind === 'outcome' && live.receiver_generation === mount) frameOutcome(mount, live.session_id, live.report)
        return
      }
      const bridge = parseBridgeMessage(event.data)
      if (bridge) {
        if (!bridge.ok) return bridge.id ? reply(cancelledReply(bridge.id, bridge.reason === 'too-large' ? 'too-large' : 'invalid')) : undefined
        const msg = bridge.msg
        if (msg.type === 'context?') {
          if (!limits['context?']('context?')) return   // over its limit: ignored
          greeted.current = true
          return reply({ type: 'context', ...contextNow.current })
        }
        if (!limits.pick('pick')) return reply(cancelledReply(msg.id, 'rate-limited'))
        if (memory) return reply(cancelledReply(msg.id, 'busy'))
        if (pickerOpen.current) return reply(cancelledReply(msg.id, 'busy'))
        if (!contextNow.current.capabilities.picker) return reply(cancelledReply(msg.id, 'unavailable'))
        pickerOpen.current = true
        return setPicker({ id: msg.id, channel: doc.channel, accept: msg.accept, kinds: msg.kinds })
      }
      // Studio slice 2 (PROGRAMS.md §9b): drafts for THIS app in THIS swarm, and bytes of files picked in THIS frame
      const out = await studio(event.data)
      if (!docBinding.current()) return reply({})   // the null dispatcher path also crosses an async boundary
      if (out !== null) return out ? reply(out.reply, out.transfer) : undefined
      // Frame ops (PROGRAMS.md §9c): read, open-url, show-file, back/escape, layout, goal notices
      const op = parseFrameOp(event.data)
      if (op) {
        if (!op.ok) {
          if (op.type === 'subscribe' || op.type === 'unsubscribe') return
          if (!op.id) return
          if (op.type === 'read') return reply(readRefused(op.id, op.reason as never))
          if (op.type === 'open-url') return reply(urlRefused(op.id, 'invalid'))
          if (op.type === 'show-file') return reply(fileRefused(op.id, op.reason as never))
          return
        }
        const msg = op.msg
        switch (msg.type) {
          case 'read': {
            if (!opLimits.read('read')) return reply(readRefused(msg.id, 'rate-limited', msg.query))
            const read = client.programRead ? client.programRead.bind(client) : undefined
            return reply(await readReply(msg, { read: read as never, programId, swarmId, declared: declaredReads(describeNow.current), inflight: readsInflight }))
          }
          case 'open-url': {
            if (!opLimits['open-url']('open-url')) return reply(urlRefused(msg.id, 'rate-limited'))
            if (memory || open.current.url) return reply(urlRefused(msg.id, 'busy'))
            const u = checkUrl(msg.url)
            if (!u.ok) return reply(urlRefused(msg.id, u.reason))
            open.current.url = true
            return setUrlAsk({ id: msg.id, channel: doc.channel, url: u.url })
          }
          case 'show-file': {
            if (!opLimits['show-file']('show-file')) return reply(fileRefused(msg.id, 'rate-limited'))
            if (memory || open.current.file) return reply(fileRefused(msg.id, 'busy'))
            const v = viewable(msg.mime, msg.bytes)
            if (!v.ok) return reply(fileRefused(msg.id, v.reason))
            open.current.file = true
            setFileShow({ id: msg.id, channel: doc.channel, name: msg.name, mime: msg.mime, bytes: msg.bytes })
            return reply({ type: FRAME_WIRE.showFile.shown, id: msg.id })
          }
          case 'back-request':
          case 'escape':
            // the host decides: its own Back, unless one of its own dialogs is open (that dialog has Escape)
            if (!opLimits.back('back')) return
            frameBack(hostModal(), onBackNow.current)
            return
          case 'layout':
            if (!opLimits.layout('layout')) return
            if (msg.mode === 'light' || msg.mode === 'dark') setMemoryMode(msg.mode)
            else setLayout(msg.mode)
            return reply({ type: FRAME_WIRE.layout.set, mode: msg.mode })
          case 'subscribe':
          case 'unsubscribe':
            if (!opLimits.goal('goal')) return reply({ type: FRAME_WIRE.goal.refused, goal_id: msg.goal_id, reason: 'rate-limited' })
            if (msg.type === 'unsubscribe') {
              goals.unsubscribe(msg.goal_id)
              return reply({ type: FRAME_WIRE.goal.unsubscribed, goal_id: msg.goal_id })
            }
            return goals.subscribe(msg.goal_id)
              ? reply({ type: FRAME_WIRE.goal.subscribed, goal_id: msg.goal_id })
              : reply({ type: FRAME_WIRE.goal.refused, goal_id: msg.goal_id, reason: 'not-started-here' })
        }
        return
      }
      if (m.type === 'app-dirty') return onDirty?.((m as { dirty?: unknown }).dirty === true)   // the app says it holds edits not yet saved
      if (m.type !== 'app-request' || typeof m.id !== 'string') return
      if (m.op === 'subscribe' || m.op === 'unsubscribe') {
        const id = subscriptionTarget(m.op, m.body)
        try {
          if (!id) throw new Error('subscribe names one artifact_id')
          const epoch = (subscriptionEpoch.get(id) ?? 0) + 1
          subscriptionEpoch.set(id, epoch)
          if (m.op === 'unsubscribe') subscribed.delete(id)
          else {
            if (!client.artifactSubscription) throw new Error('subscribe is not available on this hive')
            await client.artifactSubscription(swarmId, id)   // the host checks this viewer may read that artifact in this swarm
            if (disposed) return   // the frame is gone with this component: there is no one to reply to
            if (!docBinding.current()) return reply({})   // do not add a subscription for a superseded identity
            // A later unsubscribe/subscribe for this artifact superseded this one: answer truthfully (not subscribed),
            // never with an invented error, so every app-request still gets exactly one reply (Kimi 2026-10-04).
            if (subscriptionEpoch.get(id) !== epoch)
              return reply({ type: 'app-reply', id: m.id, ok: true, result: { artifact_id: id, subscribed: false, superseded: true } })
            subscribed.add(id)
          }
          return reply({ type: 'app-reply', id: m.id, ok: true, result: { artifact_id: id, subscribed: m.op === 'subscribe' } })
        } catch (e) {
          return reply({ type: 'app-reply', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
      // the host fixes the swarm (the app cannot choose another), and only the host ever adds a confirm token (§9d)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { confirm_token: _frameToken, untrusted_intent: _frameIntent, ...frameBody } = (m.body ?? {}) as Record<string, unknown>
      const body: Record<string, unknown> = { ...frameBody, swarm_id: swarmId }
      if (m.op === 'view' && untrustedIntent !== undefined) body.untrusted_intent = untrustedIntent
      // G2 (§9c) and §9d: a file act or a confirm act is checked against describe (action, params, file type and
      // size) before any dialog or mint, then asked in the host's own confirm (frameAct.admitFrameAct)
      if (m.op === 'act') {
        if (memory) return reply({ type: 'app-reply', id: m.id, ok: false, error: 'busy', act_not_sent: true })
        const admitted = admitFrameAct(programId, swarmId, frameBody, describeNow.current, contextNow.current.capabilities.actFile, confirmNow.current)
        if (admitted.kind === 'refused') return reply(actFileRefused(m.id, admitted.reason, true))
        if (admitted.kind === 'asked') return void settleAct(m.id, admitted.asked, reply)
      }
      // this message may have waited on the network above (its entry or consent check): send the view or act only for
      // the sign-in, document and release still current
      if (disposed || !releaseCurrent || !docBinding.current()) return reply({})
      try {
        let result: unknown
        if (m.op === 'view') result = await client.programView(programId, body as never)
        else if (m.op === 'act') result = await client.programAct(programId, body as never)
        else throw new Error('unknown operation')
        if (!docBinding.current()) return reply({})   // a late result cannot commit another identity's host state
        if (m.op === 'act') goals.record(startedGoal(result as never))   // G9: only goals this frame's own act started
        reply({ type: 'app-reply', id: m.id, ok: true, result })
      } catch (e) {
        reply({ type: 'app-reply', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    window.addEventListener('message', receive)
    return () => {
      askNow.current.fence()   // P1 generation first; teardown cannot race a live resume/act callback
      linksNow.current.cancel(); fenceDocument.current = () => undefined
      close(); offMemoryIdentity(); offMemoryStore(); offMemoryOwner(); clearTimeout(expiryTimer); window.removeEventListener('pagehide', pageGone)
      closeMemory.current = () => undefined; frameLoad.current = () => undefined
      detachFrame(mount, 'unmount')   // J3 r4.3 O3: local receiving closes first (a frame message), then no more writes
      disposed = true; post.current = null; greeted.current = false; pickerOpen.current = false; setPicker(null)
      goals.clear(); if (goalsRef.current === goals) goalsRef.current = null   // G9: every subscription dropped
      open.current = { url: false, file: false }; setUrlAsk(null); setFileShow(null); setLayout('framed'); setMemoryMode('light')
      confirmNow.current.cancelAll()   // an open confirm goes with its frame; nothing is minted or sent for it
      frameGrants.clear(); if (grants.current === frameGrants) grants.current = null
      stopEvents(); subscribed.clear(); subscriptionEpoch.clear(); window.removeEventListener('message', receive); onDirty?.(false)
    }
  }, [loaded, client, programId, swarmId, source, onDirty, untrustedIntent, identity, entryForDocument, requireNormalConsent])

  // the person's answer goes to the frame that asked (same document, same channel), once
  const answer = (choice: PickCandidate | null) => {
    const asked = picker
    pickerOpen.current = false
    setPicker(null)
    if (!asked || asked.channel !== doc?.channel) return
    try {
      const out = choice ? pickedReply(asked.id, choice) : cancelledReply(asked.id)
      if ('asset' in out) grants.current?.grant(out.asset)   // only this frame session may then ask for its bytes
      post.current?.(out)
    } catch {
      post.current?.(cancelledReply(asked.id, 'invalid'))
    }
  }

  // G4: the person's own click opened it, or they cancelled
  const urlDone = (opened: boolean) => {
    const asked = urlAsk
    open.current.url = false
    setUrlAsk(null)
    if (asked && asked.channel === doc?.channel) post.current?.(opened ? { type: FRAME_WIRE.openUrl.opened, id: asked.id } : urlRefused(asked.id, 'declined'))
  }
  // G3: closing drops the bytes (the viewer revokes its blob URL)
  const fileDone = () => {
    const shownFile = fileShow
    open.current.file = false
    setFileShow(null)
    if (shownFile && shownFile.channel === doc?.channel) post.current?.({ type: FRAME_WIRE.showFile.closed, id: shownFile.id })
  }
  if (linked) return <div className="flex h-full min-h-0 flex-col">
    <div hidden={childLinked} className="shrink-0 border-b border-line bg-panel p-2"><button type="button" className="min-h-11 max-w-full whitespace-normal break-words rounded-full border border-line px-4 py-2 text-left text-sm" title="Back returns you to the app; apps that support presentation restore resume where you left off" onClick={freshBack}>← Back to {linked.entry.back_name}</button></div>
    <div className="min-h-0 flex-1"><AppFrame key={linked.entry.id} programId={linked.entry.app} swarmId={linked.entry.swarm_id}
      entry={linked.entry} untrustedIntent={linked.intent} onBack={freshBack} onLinkDepth={setChildLinked} onFenceReady={fence => { stopTarget.current = fence }} /></div>
  </div>
  if (error) return <ErrorState title="This app's interface did not load" body={error} />
  if (!doc) return <p className="p-6 text-[13px] text-ink-4">Loading the app…</p>
  return (
    <>
      {/* sandbox: scripts and downloads only. No allow-popups (links open through the host's open-url prompt), no
          allow-same-origin, no allow-top-navigation (the frame never navigates the host; it asks with back-request). */}
      {/* Fit (§9c): the frame takes the stage's height (the page is 100dvh), never a fixed minimum taller than the screen.
          Framed: the host pads it clear of the safe areas and of the bottom lane (Ω and host notices). Full-bleed: it
          fills the stage and honours `context.insets` and `context.reserved` itself. */}
      <div data-app-stage-box={layout} className="relative h-full w-full"
        style={layout === 'framed' ? { padding: `${fit.padding.top}px ${fit.padding.right}px ${fit.padding.bottom}px ${fit.padding.left}px` } : undefined}>
        <iframe ref={frame} key={doc.channel} srcDoc={doc.html} title={`${programId} interface`} referrerPolicy="no-referrer" onLoad={() => {
          if (frameLifecycle.current?.channel !== doc.channel) return
          const reloaded = frameLoads.current === doc.channel
          if (reloaded) askNow.current.fence()   // fence Ask before memory teardown or any verified-byte reload
          // A later document load closes memory. No numeric load count grants document authority.
          // Same-document history/hash changes do not emit load; this is not an in-frame navigation monitor.
          if (!frameLifecycle.current.initialLoaded) frameLifecycle.current.initialLoaded = true
          else frameLoad.current()
          if (reloaded) {
            if (appLinkLifetime.current) setRequireNormalConsent(true)
            setEntryForDocument(undefined); setAskDocument(null); setLoaded(null); setReload((n) => n + 1)
          } else { frameLoads.current = doc.channel; setAskDocument(doc.channel) }
        }}
          sandbox="allow-scripts allow-downloads" data-layout={layout}
          className={layout === 'full' ? 'absolute inset-0 block h-full w-full border-0' : 'block h-full min-h-0 w-full rounded-xl border-0'} />
        {ask.controls}
      </div>
      {urlAsk && <OpenUrlPrompt appName={appName} url={urlAsk.url} onOpened={() => urlDone(true)} onCancel={() => urlDone(false)} />}
      {fileShow && <FileViewer appName={appName} name={fileShow.name} mime={fileShow.mime} bytes={fileShow.bytes} onClose={fileDone} />}
      {confirm.dialog}
      {links.controls}
      <AppMemoryHost state={memoryOpening} mode={memoryMode} onClose={() => closeMemory.current()} />
      {picker && (
        <AppPicker appName={appName} swarmId={swarmId} accept={picker.accept} kinds={picker.kinds} onChoose={(c) => answer(c)} onCancel={() => answer(null)} />
      )}
    </>
  )
}
