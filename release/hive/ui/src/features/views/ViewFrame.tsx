import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ArtifactView, HtmlArtifactView, MettaArtifactView } from '../../api/moneyWork'
import { need, useResource } from '../../lib/useResource'
import { ApiError } from '../../api/client'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Button, EmptyState, ErrorState, Skeleton } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { hostContext } from './hostContext'
import { MettaFrame } from './MettaFrame'
import { ReachPrompt, RunCard } from './ViewConsent'
import { dialogClass, toMaker, useDialogMode, type ViewPlace } from './viewChrome'
import { ViewBar } from './ViewBar'
import { ViewBridge, type DisplayMode, type DownloadFile } from './viewBridge'
import type { ViewPort } from './viewSession'

/**
 * One saved revision drawn as an interactive view, inline where it is placed and fullscreen on request. A view a mind
 * wrote in MeTTa is composed and drawn by the hive's own screens (MettaFrame); an HTML view (MCP Apps) runs in a frame.
 * No view runs until the person asks: until their Run it a card stands in its place (ViewConsent), in chat as on
 * Artifacts, and an HTML view reaches the domains it declares only once they allow them for that revision.
 *
 * The frame is `sandbox="allow-scripts allow-forms"` without allow-same-origin, and the hive serves its document with
 * the CSP sandbox directive too (hive/core/views.py), so the view has an opaque origin: it cannot read the hive's
 * storage, where the person's token lives, nor call the hive as them. It talks to the hive only through ViewBridge.
 */

export interface ViewFrameProps {
  artifactId: string
  /** The saved revision; the latest saved one when absent. */
  revision?: number
  /** Where it is drawn: a chat draws views only (never a plan's HTML, which stays text until the person asks), quietly
   *  drawing nothing when the artifact is not one; a page says why it cannot show a view. */
  place: ViewPlace
  /** The view's ui/message: words for the person to send, put where they can send them. By default they go into the
   *  message box of the mind that made the view (and a page opens that mind's chat); never sent by the view itself. */
  onMessage?: (text: string, view: ArtifactView) => void
  /** More controls for the bar above the frame (the page's Read the source). */
  extra?: ReactNode
  /** Told each time a view written in MeTTa takes up a newer revision of itself (an HTML view keeps the one it opened). */
  onRevision?: (revision: number) => void
  /** Where a MeTTa view's worker comes from (tests); a real Worker by default. */
  port?: () => ViewPort
}

const MIN_HEIGHT = 120
const FIRST_HEIGHT: Record<ViewFrameProps['place'], number> = { chat: 280, page: 420 }
/** The most an inline view takes before it scrolls inside: most of the window, so the page around it stays reachable. */
const inlineMax = () => Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.7))

export function ViewFrame({ artifactId, revision, place, onMessage, extra, onRevision, port }: ViewFrameProps) {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'artifactView', 'Views')(artifactId, revision), { context: `${artifactId}@${revision ?? 'latest'}` })
  const view = res.data
  // the person's own answer for the revision shown, then the view as the hive hands it out after that answer
  const grant = (reach: boolean) => async () => {
    if (!view) return
    await need(client, 'consentView', 'Views')(view.artifact_id, view.revision, reach)
    res.reload()
  }
  const drawn = view && <Consented view={view} place={place} onMessage={onMessage} extra={extra} onRevision={onRevision} port={port} grant={grant} />
  if (place === 'chat') {
    // a chat shows only what was made to be a view; anything else, or a view it cannot open, leaves the message as it is
    if (res.status !== 'ready' || !view || view.carrier === 'document') return null
    return drawn
  }
  if (res.status === 'unsupported') return <EmptyState icon="apps" title="This hive can't show views here" body="Ask the mind that made it to send you the text." />
  if (res.status === 'error') {
    const why = res.error instanceof ApiError && res.error.status === 415 ? res.error.message : res.error instanceof ApiError && res.error.status === 404 ? 'It is no longer here, or not shown to you.' : res.error instanceof Error ? res.error.message : undefined
    return <ErrorState title="Could not open the view" body={why} onRetry={res.reload} />
  }
  if (res.status !== 'ready' || !view) return <Skeleton className="h-64" />
  return drawn
}

/** The view once its person has run it, else the card that asks them to; an HTML view asks before it reaches out. */
function Consented({ view, place, onMessage, extra, onRevision, port, grant }: Omit<ViewFrameProps, 'artifactId' | 'revision'> & {
  view: ArtifactView; grant: (reach: boolean) => () => Promise<void> }) {
  const agents = useHive((s) => s.agents)
  const maker = view.mind_id && agents[view.mind_id] ? shown(agents[view.mind_id].name) : 'a mind'
  if (!view.grant.ran) return <RunCard view={view} maker={maker} onRun={grant(false)} />
  if (view.carrier === 'metta') {
    return view.source === null ? <RunCard view={view} maker={maker} onRun={grant(false)} />
      // the view itself, never a copy: a frame keys its bridge and worker on the object, and a copy made on each render
      // would start them again whenever the page re-renders (the null checks here make the casts true)
      : <MettaFrame view={view as MettaArtifactView & { source: string }} place={place} onMessage={onMessage} extra={extra} onRevision={onRevision} port={port} />
  }
  return view.document === null ? <RunCard view={view} maker={maker} onRun={grant(false)} />
    : <LiveView view={view as HtmlArtifactView & { document: string }} place={place} onMessage={onMessage} extra={extra} onAllow={grant(true)} />
}

function LiveView({ view, place, onMessage, extra, onAllow }: { view: HtmlArtifactView & { document: string }; onAllow: () => Promise<void> } & Omit<ViewFrameProps, 'artifactId' | 'revision' | 'onRevision' | 'port'>) {
  const agents = useHive((s) => s.agents)
  const makerName = view.mind_id && agents[view.mind_id] ? shown(agents[view.mind_id].name) : null
  const ask = onMessage ?? (view.mind_id ? toMaker(place) : undefined)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDialogElement>(null)
  const bridgeRef = useRef<ViewBridge | null>(null)
  const look = useLook().current
  const [mode, setMode] = useState<DisplayMode>('inline')
  const [reported, setReported] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const [folded, setFolded] = useState(false)
  // what the view asked for that the person confirms under it: a link to open or a file to save
  const [asking, setAsking] = useState<({ link: URL } | { file: DownloadFile }) & { answer: (yes: boolean) => void } | null>(null)
  const border = view.resource._meta.ui.prefersBorder !== false
  useDialogMode(boxRef, mode, setMode, folded)

  // the page's answers read the latest mode and message handler when the view asks, never during render
  const modeRef = useRef(mode)
  const messageRef = useRef(ask)
  useEffect(() => { modeRef.current = mode; messageRef.current = ask })

  const placement = useCallback((m: DisplayMode) => ({
    mode: m,
    width: m === 'fullscreen' ? window.innerWidth : (width || boxRef.current?.clientWidth || 600),
    height: m === 'fullscreen' ? window.innerHeight - 48 : inlineMax(),
  }), [width])

  // one confirmation at a time: a new request from the view declines the one still showing, so every request is answered
  const pending = useRef<((yes: boolean) => void) | null>(null)

  // one bridge per document, made before the frame's document can arrive (a layout effect runs before any network
  // answer), and told the frame is going away when it does
  useLayoutEffect(() => {
    const confirm = (what: { link: URL } | { file: DownloadFile }) => new Promise<boolean>((resolve) => {
      pending.current?.(false)
      const answer = (yes: boolean) => { if (pending.current === answer) { pending.current = null; setAsking(null) } resolve(yes) }
      pending.current = answer
      setAsking({ ...what, answer })
    })
    const bridge = new ViewBridge(() => frameRef.current?.contentWindow ?? null, {
      size: (_w, h) => { if (h !== undefined) setReported(h) },
      displayMode: (m) => { setMode(m); return m },
      message: messageRef.current ? (text) => messageRef.current?.(text, view) : undefined,
      openLink: (link) => confirm({ link }),
      download: (file) => confirm({ file }),
      log: (level, data) => { console.debug(`[view ${view.title}]`, level, data) },
      requestTeardown: () => { if (modeRef.current === 'fullscreen') setMode('inline'); else { bridgeRef.current?.teardown('folded'); setFolded(true) } },
      acting: () => {
        const active = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
        return document.activeElement === frameRef.current && (active ? active.isActive : true)
      },
    }, hostContext(document, { mode: modeRef.current, width: boxRef.current?.clientWidth || 600, height: inlineMax() }))
    bridgeRef.current = bridge
    const onWindowMessage = (e: MessageEvent) => { bridge.receive(e) }
    window.addEventListener('message', onWindowMessage)
    return () => {
      window.removeEventListener('message', onWindowMessage)
      bridge.teardown('closed')
      bridgeRef.current = null
    }
  }, [view])

  // the width it is drawn at, for the context and the first size
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const seen = new ResizeObserver(() => setWidth(box.clientWidth))
    seen.observe(box)
    return () => seen.disconnect()
  }, [folded])   // unfolding draws a new dialog

  // context changes reach the view: the look worn, the space it has, the display mode
  useEffect(() => {
    const update = () => bridgeRef.current?.setContext(hostContext(document, placement(mode)))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [mode, look, placement])

  if (folded) {
    return <Button variant="subtle" icon="apps" className="min-h-9 px-3 text-[12px]" onClick={() => setFolded(false)}>Show {view.title} again</Button>
  }

  const full = mode === 'fullscreen'
  const height = full ? undefined : Math.min(inlineMax(), Math.max(MIN_HEIGHT, reported ?? FIRST_HEIGHT[place ?? 'page']))
  const reaches = [...(view.resource._meta.ui.csp.connectDomains ?? []), ...(view.resource._meta.ui.csp.resourceDomains ?? [])]
  return (
    <dialog
      ref={boxRef}
      aria-label={`${view.title}, a view`}
      data-view={view.artifact_id}
      data-view-mode={mode}
      data-view-sized={reported === null ? undefined : ''}
      onCancel={(e) => { e.preventDefault(); setMode('inline') }}
      className={dialogClass(full)}
    >
      <ViewBar title={view.title} full={full} onMode={setMode} extra={extra} />
      <iframe
        ref={frameRef}
        title={`${view.title}, made by ${makerName ?? 'a mind'}`}
        src={view.document}
        sandbox="allow-scripts allow-forms"
        allow={view.allow || undefined}
        referrerPolicy="no-referrer"
        className={cx('block w-full bg-transparent', full ? 'h-[calc(100dvh-3rem)]' : border ? 'rounded-2xl border border-line' : '')}
        style={height === undefined ? undefined : { height }}
      />
      {asking && 'file' in asking && (
        <div role="alertdialog" aria-label="Save a file from the view" className={ASK}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Save {asking.file.name} ({sizeWords(asking.file.bytes.length)}) from this view?</span>
          <Button variant="subtle" className="min-h-9 px-3 text-[12px]" onClick={() => { saveFile(asking.file); asking.answer(true) }}>Save</Button>
          <Button variant="ghost" className="min-h-9 px-3 text-[12px]" onClick={() => asking.answer(false)}>Cancel</Button>
        </div>
      )}
      {asking && 'link' in asking && (
        // the person reads where the link goes and opens it with a click of their own, on the hive's page
        <div role="alertdialog" aria-label="Open a link from the view" className={ASK}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">This view wants to open <b className="font-medium text-ink">{asking.link.href}</b></span>
          {/* answered after the click has run its course: the link must still be in the page when it opens the tab */}
          <a href={asking.link.href} target="_blank" rel="noopener noreferrer" onClick={() => { setTimeout(() => asking.answer(true), 0) }}
            className="inline-flex min-h-9 items-center rounded-xl border border-line bg-tint/[0.06] px-3 text-[12px] font-medium text-ink hover:bg-tint/[0.1]">Open</a>
          <Button variant="ghost" className="min-h-9 px-3 text-[12px]" onClick={() => asking.answer(false)}>Cancel</Button>
        </div>
      )}
      {!full && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-4">
          View made by {makerName ?? 'a mind'}. It runs on its own and cannot see your hive.
          {reaches.length > 0 && ` It reaches ${reaches.join(', ')}.`}
          {view.refused.length > 0 && ` Not allowed: ${view.refused.join(', ')}.`}
        </p>
      )}
      {!full && <ReachPrompt view={view} onAllow={onAllow} />}
    </dialog>
  )
}

const ASK = 'mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line-2 bg-tint/[0.04] px-3 py-2 text-[12.5px] text-ink-2'

const sizeWords = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** The person said Save: the bytes become a file from the hive's page, never from the view's frame. */
function saveFile(file: DownloadFile) {
  const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mimeType }))
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
