/**
 * Purpose: one saved revision drawn as an interactive view, inline where it is placed and fullscreen on request. A view
 * a mind wrote in MeTTa is composed and drawn by the hive's own screens (MettaFrame); an HTML view (MCP Apps) runs in a
 * frame. No view runs until the person asks: until their Run it a card stands in its place (ViewConsent), in chat as on
 * Artifacts, and an HTML view loads from the domains it declares only once they allow them for that revision.
 *
 * The frame is `sandbox="allow-scripts allow-forms"` without allow-same-origin, and the hive serves its document with
 * the CSP sandbox directive too (hive/core/views.py), so the view has an opaque origin: it cannot read the hive's
 * storage, where the person's token lives, nor call the hive as them. It talks to the hive only through ViewBridge.
 * A sandboxed frame may still navigate itself; the app document's frame-src 'self' (hive/core/app.py page_csp) keeps
 * that from reaching another site, and a frame that loads a second page is taken down.
 *
 * Everything a person sees here is MeTTa's (views.metta): where the view is opened, view-page on a page and view-chat
 * under a mind's message, and around the running view, view-host, in both paths. This file states the facts, carries
 * out presses and draws the frame; it writes no words.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactView, HtmlArtifactView, MettaArtifactView } from '../../api/moneyWork'
import { isNotFound, need, useResource } from '../../lib/useResource'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { experienceById } from '../../experiences/registry'
import { withResource } from '../../screens/resourceFacts'
import { NotThePage } from '../../screens/openScreens'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { hostContext } from './hostContext'
import { MettaFrame } from './MettaFrame'
import { askedDomains, useAnswer } from './consentAnswers'
import { RunCard } from './ViewConsent'
import { dialogClass, toMaker, useDialogMode, type ViewPlace } from './viewChrome'
import { ViewBridge, type DisplayMode, type DownloadFile } from './viewBridge'
import type { ViewPort } from './viewSession'

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
  /** Told each time a view written in MeTTa takes up a newer revision of itself (an HTML view keeps the one it opened). */
  onRevision?: (revision: number) => void
  /** Where a MeTTa view's worker comes from (tests); a real Worker by default. */
  port?: () => ViewPort
}

/** The islands views.metta places: the card before a view runs, and the view itself. */
const ISLAND = { run: 'run', view: 'view' } as const

const MIN_HEIGHT = 120
const FIRST_HEIGHT: Record<ViewFrameProps['place'], number> = { chat: 280, page: 420 }
/** The most an inline view takes before it scrolls inside: most of the window, so the page around it stays reachable. */
const inlineMax = () => Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.7))

export function ViewFrame({ artifactId, revision, place, onMessage, onRevision, port }: ViewFrameProps) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const res = useResource(() => need(client, 'artifactView', 'Views')(artifactId, revision), { context: `${artifactId}@${revision ?? 'latest'}` })
  const view = res.data
  // the person's own answer for the revision shown, then the view as the hive hands it out after that answer
  const grant = (reach: boolean) => async () => {
    if (!view) return
    await need(client, 'consentView', 'Views')(view.artifact_id, view.revision, reach)
    res.reload()
  }
  const maker = view?.mind_id && agents[view.mind_id] ? shown(agents[view.mind_id].name) : null
  // run, and handed out: the hive gives a view's text or document only after the person's Run it for that revision
  const ran = !!view && view.grant.ran && (view.carrier === 'metta' ? view.source !== null : view.document !== null)
  const { data, facts } = withResource(res, {
    data: {},
    facts: { flags: { 'view.gone': res.status === 'error' && isNotFound(res.error), 'view.ran': ran, 'view.document': view?.carrier === 'document' } },
  })
  const plan = compose(place === 'chat' ? 'view-chat' : 'view-page', facts)
  // a view's screens are the view's, never the page's: the stage does not arrange their parts
  return (
    <NotThePage.Provider value={true}><Screen plan={plan} host={{
      data,
      onAction: (action) => { if (action === 'retry') res.reload() },
      islands: view ? {
        [ISLAND.run]: <RunCard view={view} maker={maker} onRun={grant(false)} />,
        [ISLAND.view]: view.carrier === 'metta'
          // the view itself, never a copy: a frame keys its bridge and worker on the object, and a copy made on each
          // render would start them again whenever the page re-renders (view.ran makes the casts true)
          ? <MettaFrame view={view as MettaArtifactView & { source: string }} place={place} onMessage={onMessage} onRevision={onRevision} port={port} />
          : <LiveView view={view as HtmlArtifactView & { document: string }} maker={maker} place={place} onMessage={onMessage} onAllow={grant(true)} />,
      } : {},
    }} /></NotThePage.Provider>
  )
}

function LiveView({ view, maker, place, onMessage, onAllow }: { view: HtmlArtifactView & { document: string }; maker: string | null; onAllow: () => Promise<void> } & Pick<ViewFrameProps, 'place' | 'onMessage'>) {
  const ask = onMessage ?? (view.mind_id ? toMaker(place) : undefined)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDialogElement>(null)
  const bridgeRef = useRef<ViewBridge | null>(null)
  const titleId = useId()
  const look = useLook().current
  const compose = useCompose(experienceById(look?.experience).id)
  const [mode, setMode] = useState<DisplayMode>('inline')
  const [reported, setReported] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const [folded, setFolded] = useState(false)
  const [left, setLeft] = useState(false)
  // the person's Allow for the domains it declares, for this revision
  const allowing = useAnswer(onAllow)
  // A view's own document loads its frame once. Any later load is the view going somewhere else: a page of the hive's
  // own origin, which frame-src 'self' still allows, or the error page Chromium shows for an attempt it blocked. So
  // the frame is taken down and the bridge loses it. Counted per frame element, and the page gives every document it
  // loads a frame of its own (a frame shown again, a new ticket once domains are allowed), so each starts afresh.
  // The page cannot see where the frame went, and a view that leaves while still loading fires no load of its own.
  const loads = useRef(new WeakMap<object, number>())
  const onLoad = (e: { currentTarget: object }) => {
    const n = (loads.current.get(e.currentTarget) ?? 0) + 1
    loads.current.set(e.currentTarget, n)
    if (n > 1) setLeft(true)
  }
  // what the view asked for that the person confirms under it: a link to open or a file to save
  const [asking, setAsking] = useState<({ link: URL } | { file: DownloadFile }) & { answer: (yes: boolean) => void } | null>(null)
  const border = view.resource._meta.ui.prefersBorder !== false
  useDialogMode(boxRef, mode, setMode, folded || left)

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
  }, [folded, left])   // showing it again draws a new dialog

  // context changes reach the view: the look worn, the space it has, the display mode
  useEffect(() => {
    const update = () => bridgeRef.current?.setContext(hostContext(document, placement(mode)))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [mode, look, placement])

  const full = mode === 'fullscreen'
  const height = full ? undefined : Math.min(inlineMax(), Math.max(MIN_HEIGHT, reported ?? FIRST_HEIGHT[place ?? 'page']))
  const reaches = [...(view.resource._meta.ui.csp.connectDomains ?? []), ...(view.resource._meta.ui.csp.resourceDomains ?? [])]
  const asks = askedDomains(view)
  const drawn = !folded && !left
  // what MeTTa composes around the frame (views.metta view-host): its bar, the frame itself, a link or a file the view
  // asked for that the person opens, saves or declines, who made it and what it reaches, the domains it waits on, and
  // Show it again once put away or left
  const plan = compose('view-host', {
    flags: {
      'view.drawn': drawn, 'view.full': full, 'view.folded': folded, 'view.left': left,
      'view.asks-link': asking !== null && 'link' in asking, 'view.asks-file': asking !== null && 'file' in asking,
      'view.allow-failed': allowing.error !== null,
    },
    counts: { 'view.maker': maker ? 1 : 0, 'view.reaches': reaches.length, 'view.refused': view.refused.length, 'view.asks': asks.length },
  })
  const surroundings = (
    <NotThePage.Provider value={true}><Screen plan={plan} className="space-y-2" host={{
      data: {
        'view.title': view.title, 'view.title-id': titleId, 'view.full': full, 'view.maker': maker ?? '',
        'view.link': asking && 'link' in asking ? asking.link.href : '',
        'view.file-name': asking && 'file' in asking ? asking.file.name : '',
        'view.file-size': asking && 'file' in asking ? sizeOf(asking.file.bytes.length) : '',
        'view.reaches': reaches.join(', '), 'view.refused': view.refused.join(', '),
        'view.asks': asks.join(', '), 'view.allowing': allowing.busy, 'view.allow-error': allowing.error ?? '',
      },
      onAction: (action) => {
        if (action === 'fullscreen' || action === 'inline') setMode(action)
        else if (action === 'again') { setFolded(false); setLeft(false) }
        // the person opens the link with a click of their own, on the hive's page, in a tab apart from the hive
        else if (action === 'open' && asking && 'link' in asking) { window.open(asking.link.href, '_blank', 'noopener,noreferrer'); asking.answer(true) }
        else if (action === 'save' && asking && 'file' in asking) { saveFile(asking.file); asking.answer(true) }
        else if (action === 'decline') asking?.answer(false)
        else if (action === 'allow') allowing.answer()
      },
      islands: {
        [ISLAND.view]: drawn ? (
          <iframe
            // a new document from the page (a new ticket once its domains are allowed) is a new frame, so a frame that
            // loads twice was moved by the view itself
            key={view.document}
            ref={frameRef}
            // named by the bar's title, as the dialog is
            aria-labelledby={titleId}
            src={view.document}
            sandbox="allow-scripts allow-forms"
            allow={view.allow || undefined}
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            className={cx('block w-full bg-transparent', full ? 'min-h-0 flex-1' : border ? 'rounded-2xl border border-line' : '')}
            style={height === undefined ? undefined : { height }}
          />
        ) : null,
      },
    }} /></NotThePage.Provider>
  )
  // put away or left, the view is only what MeTTa says in its place
  if (!drawn) return <div data-view-left={left ? view.artifact_id : undefined}>{surroundings}</div>
  return (
    <dialog
      ref={boxRef}
      aria-labelledby={titleId}
      data-view={view.artifact_id}
      data-view-mode={mode}
      data-view-sized={reported === null ? undefined : ''}
      onCancel={(e) => { e.preventDefault(); setMode('inline') }}
      className={dialogClass(full)}
    >
      {surroundings}
    </dialog>
  )
}

/** A file's size as the platform writes the unit, in the hive's language: 3 bytes, 12 kB, 1.5 MB. */
const sizeOf = (n: number) => {
  const [value, unit] = n < 1024 ? [n, 'byte'] : n < 1024 * 1024 ? [n / 1024, 'kilobyte'] : [n / 1024 / 1024, 'megabyte']
  return new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: unit === 'byte' ? 'long' : 'short', maximumFractionDigits: unit === 'megabyte' ? 1 : 0 }).format(value)
}

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
