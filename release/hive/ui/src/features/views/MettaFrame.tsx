/**
 * Purpose: draws a view a mind wrote in MeTTa. The view's MeTTa runs in a worker of its own (viewSession.ts), which
 * composes it with the hive's screen rules for the person's look (mettaView.ts); this draws the answer with the hive's
 * own blocks (screens/Screen.tsx). What surrounds the view, its bar, and everything from opening to a mistake to a stop,
 * is a screen of its own (views.metta view-host), composed from the facts stated here. When the mind saves a new
 * revision, the hive's revision notice reaches this page and the view takes it up in place, keeping what the person
 * typed. MeTTa decides what is drawn and says it; this file only states facts, carries presses to the worker and draws
 * what comes back.
 */
import { useEffect, useId, useReducer, useRef, useState } from 'react'
import type { ArtifactView, MettaArtifactView } from '../../api/moneyWork'
import { experienceById } from '../../experiences/registry'
import { shown } from '../../lib/displayName'
import { onStoreResync } from '../../lib/resync'
import { need } from '../../lib/useResource'
import { Screen, type ScreenHost } from '../../screens/Screen'
import { NotThePage } from '../../screens/openScreens'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { cx } from '../../lib/cx'
import type { ViewFrame } from './mettaView'
import type { DisplayMode } from './viewBridge'
import { dialogClass, toMaker, useDialogMode, type ViewPlace } from './viewChrome'
import { ViewBroken, ViewSession, ViewStopped, viewWorker, type ViewAsk, type ViewPort } from './viewSession'

/** Why something was not drawn: the problem in the view's own words, and, when it was a newer revision its mind saved,
 *  that revision's number, `other` when it is not one this view can take up (views.metta says the rest). */
type Slip = { problem: string; newer?: number; other?: boolean }
type Shown =
  | { phase: 'starting' }
  | { phase: 'drawn'; frame: ViewFrame; slipped: Slip | null }
  | { phase: 'broken'; why: Slip }
  | { phase: 'stopped' }
  | { phase: 'unsafe'; open: string[] }

/** views.metta places the drawn view in the island of this name */
const VIEW_ISLAND = 'view'

/** What a failed ask leaves on screen: a stop ends the view; its own mistake keeps a drawn view and says why. */
function after(e: unknown, before: Shown, newer?: number): Shown {
  if (e instanceof ViewStopped) return { phase: 'stopped' }
  if (e instanceof ViewBroken) return slip(before, { problem: e.message, newer })
  return { phase: 'broken', why: { problem: (e as Error)?.message ?? String(e), newer } }
}
/** A slip keeps a drawn view, with the reason under it; a view not yet drawn is broken, with the reason. */
const slip = (before: Shown, why: Slip): Shown => (before.phase === 'drawn' ? { ...before, slipped: why } : { phase: 'broken', why })

export interface MettaFrameProps {
  /** the view as the hive hands it out once its person ran it: with its text */
  view: MettaArtifactView & { source: string }
  place: ViewPlace
  onMessage?: (text: string, view: ArtifactView) => void
  /** told each time the view takes up a newer revision of itself, so the page around it can say which it shows */
  onRevision?: (revision: number) => void
  /** where the view's worker comes from: a real Worker by default; tests pass one that answers in their own thread */
  port?: () => ViewPort
}

export function MettaFrame({ view, place, onMessage, onRevision, port = viewWorker }: MettaFrameProps) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const makerName = view.mind_id && agents?.[view.mind_id] ? shown(agents[view.mind_id].name) : null
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const ask = onMessage ?? (view.mind_id ? toMaker(place) : undefined)

  const [shownNow, setShown] = useState<Shown>({ phase: 'starting' })
  const [run, setRun] = useState(0)            // a new run starts the view again
  const [revision, setRevision] = useState(view.revision)
  const [mode, setMode] = useState<DisplayMode>('inline')
  const boxRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const session = useRef<ViewSession | null>(null)
  const source = useRef(view.source)
  const shownRevision = useRef(view.revision)
  const lookRef = useRef(look)
  const askRef = useRef(ask)
  const revisionRef = useRef(onRevision)
  // what the person typed that the worker has not answered yet: the field keeps it while the answer is on its way
  const typed = useRef(new Map<string, { text: string; seq: number }>())
  const asked = useRef(0)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useDialogMode(boxRef, mode, setMode)
  useEffect(() => { askRef.current = ask; lookRef.current = look; revisionRef.current = onRevision })

  /** Send one ask; its answer replaces the frame, and its says go to the maker. */
  const send = (a: ViewAsk) => {
    const s = session.current
    if (!s) return
    const seq = ++asked.current
    s.ask(a).then((frame) => {
      for (const [k, t] of typed.current) if (t.seq <= seq) typed.current.delete(k)
      setShown({ phase: 'drawn', frame, slipped: null })
      for (const words of frame.says) askRef.current?.(words, view)
    }, (e) => setShown((before) => after(e, before)))
  }

  // the view's worker, for this run: opened with the latest source known, ended when the frame goes
  useEffect(() => {
    const s = new ViewSession(port())
    session.current = s
    typed.current.clear()
    let live = true
    setShown({ phase: 'starting' })
    void (async () => {
      try {
        const report = await s.ready
        if (!report.ok) {
          s.stop()
          if (live) setShown({ phase: 'unsafe', open: report.open })
          return
        }
        const frame = await s.ask({ kind: 'open', source: source.current, look: lookRef.current })
        if (live) {
          setShown({ phase: 'drawn', frame, slipped: null })
          revisionRef.current?.(shownRevision.current)
        }
      } catch (e) {
        if (live) setShown((before) => after(e, before))
      }
    })()
    return () => { live = false; s.stop(); if (session.current === s) session.current = null }
  }, [run, port])

  // another look composes the same view again, in that look
  const composedLook = useRef(look)
  useEffect(() => {
    if (composedLook.current === look) return
    composedLook.current = look
    if (shownNow.phase === 'drawn') send({ kind: 'look', look })
  })

  // the mind's change, live: the hive's revision notice (already filtered to what this person may see) names a newer
  // revision, and the view takes its source up in place; after a gap in the notices, it reads where the view stands
  useEffect(() => {
    if (!client) return
    let live = true
    const refresh = async () => {
      const latest = await need(client, 'artifactView', 'Views')(view.artifact_id)
      if (!live || latest.revision <= shownRevision.current) return
      shownRevision.current = latest.revision
      setRevision(latest.revision)
      if (latest.carrier !== 'metta' || latest.source === null) {
        setShown((before) => slip(before, { problem: '', newer: latest.revision, other: true }))
        return
      }
      source.current = latest.source
      const s = session.current
      if (!s || s.isStopped) return   // starting again opens the latest
      const seq = ++asked.current
      try {
        const frame = await s.ask({ kind: 'replace', source: latest.source, look: lookRef.current })
        for (const [k, t] of typed.current) if (t.seq <= seq) typed.current.delete(k)
        if (live) {
          setShown({ phase: 'drawn', frame, slipped: null })
          revisionRef.current?.(latest.revision)
        }
      } catch (e) {
        if (live) setShown((before) => after(e, before, latest.revision))
      }
    }
    const later = () => { void refresh().catch(() => undefined) }
    const off = client.subscribe?.((event) => {
      if (event.type === 'artifact.revision' && event.artifact_id === view.artifact_id && event.revision > shownRevision.current) later()
    })
    const offResync = onStoreResync(later)
    return () => { live = false; off?.(); offResync() }
  }, [client, view.artifact_id])

  const drawn = shownNow.phase === 'drawn' ? shownNow : null
  const why = shownNow.phase === 'broken' ? shownNow.why : drawn?.slipped ?? null
  const full = mode === 'fullscreen'
  const hostPlan = compose('view-host', {
    flags: {
      'view.full': full,
      'view.starting': shownNow.phase === 'starting',
      'view.drawn': drawn !== null,
      'view.broken': shownNow.phase === 'broken',
      'view.slipped': !!drawn?.slipped,
      'view.newer': why?.newer !== undefined,
      'view.other': !!why?.other,
      'view.stopped': shownNow.phase === 'stopped',
      'view.unsafe': shownNow.phase === 'unsafe',
    },
    counts: { 'view.maker': makerName ? 1 : 0 },
  })
  const viewHost: ScreenHost | null = drawn && {
    data: { ...drawn.frame.data, ...Object.fromEntries([...typed.current].map(([k, t]) => [k, t.text])) },
    onInput: (key, text) => {
      typed.current.set(key, { text, seq: asked.current + 1 })
      redraw()
      send({ kind: 'input', key, text, look })
    },
    onAction: (intent, item, on) => send({ kind: 'press', press: { intent, item: { id: item.id, value: item.value }, on }, look }),
    onOpen: (intent, item) => send({ kind: 'press', press: { intent, item: { id: item.id, value: item.value } }, look }),
  }
  return (
    <dialog
      ref={boxRef}
      aria-labelledby={titleId}
      data-view={view.artifact_id}
      data-view-carrier="metta"
      data-view-revision={revision}
      data-view-mode={mode}
      data-view-state={shownNow.phase}
      onCancel={(e) => { e.preventDefault(); setMode('inline') }}
      className={dialogClass(full)}
    >
      {/* a view's screens are the view's, never the page's: the stage does not arrange their parts */}
      <NotThePage.Provider value={true}>
      <Screen
        plan={hostPlan}
        className="space-y-2"
        host={{
          data: {
            'view.title': view.title, 'view.title-id': titleId, 'view.full': full,
            'view.problem': why?.problem ?? '', 'view.newer': why?.newer ?? '', 'view.maker': makerName ?? '',
          },
          onAction: (action) => {
            if (action === 'restart') setRun((n) => n + 1)
            else if (action === 'fullscreen' || action === 'inline') setMode(action)
          },
          islands: {
            // the view in its own box inline; full screen, the box takes the rest of the screen and scrolls inside
            [VIEW_ISLAND]: viewHost && drawn ? (
              <div className={cx(full ? 'min-h-0 flex-1 overflow-auto p-4' : 'rounded-2xl border border-line p-4')}>
                <Screen plan={drawn.frame.plan} host={viewHost} className="space-y-3" />
              </div>
            ) : null,
          },
        }}
      />
      </NotThePage.Provider>
    </dialog>
  )
}
