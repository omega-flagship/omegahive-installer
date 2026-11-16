/**
 * Purpose: draws a view a mind wrote in MeTTa. The view's MeTTa runs in a worker of its own (viewSession.ts), which
 * composes it with the hive's screen rules for the person's look (mettaView.ts); this draws the answer with the hive's
 * own blocks (screens/Screen.tsx). What surrounds the view, from opening to a mistake to a stop, is a screen of its own
 * (views.metta), composed from the facts stated here. When the mind saves a new revision, the hive's revision notice
 * reaches this page and the view takes it up in place, keeping what the person typed. MeTTa decides what is drawn; this
 * file only states facts, carries presses to the worker and draws what comes back.
 */
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
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
import type { ViewFrame } from './mettaView'
import type { DisplayMode } from './viewBridge'
import { dialogClass, toMaker, useDialogMode, type ViewPlace } from './viewChrome'
import { ViewBar } from './ViewBar'
import { ViewBroken, ViewSession, ViewStopped, viewWorker, type ViewAsk, type ViewPort } from './viewSession'

type Shown =
  | { phase: 'starting' }
  | { phase: 'drawn'; frame: ViewFrame; slipped: string | null }
  | { phase: 'broken'; problem: string }
  | { phase: 'stopped' }
  | { phase: 'unsafe'; open: string[] }

/** views.metta places the drawn view in the island of this name */
const VIEW_ISLAND = 'view'

/** What a failed ask leaves on screen: a stop ends the view; its own mistake keeps a drawn view and says why. */
function after(e: unknown, before: Shown): Shown {
  if (e instanceof ViewBroken) return before.phase === 'drawn' ? { ...before, slipped: e.message } : { phase: 'broken', problem: e.message }
  if (e instanceof ViewStopped) return { phase: 'stopped' }
  return { phase: 'broken', problem: (e as Error)?.message ?? String(e) }
}

export interface MettaFrameProps {
  /** the view as the hive hands it out once its person ran it: with its text */
  view: MettaArtifactView & { source: string }
  place: ViewPlace
  onMessage?: (text: string, view: ArtifactView) => void
  extra?: ReactNode
  /** told each time the view takes up a newer revision of itself, so the page around it can say which it shows */
  onRevision?: (revision: number) => void
  /** where the view's worker comes from: a real Worker by default; tests pass one that answers in their own thread */
  port?: () => ViewPort
}

export function MettaFrame({ view, place, onMessage, extra, onRevision, port = viewWorker }: MettaFrameProps) {
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
        setShown((before) => after(new ViewBroken(`revision ${latest.revision} is not one this view can take up, so open the view again to see it`), before))
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
        const reason = e instanceof ViewBroken ? new ViewBroken(`revision ${latest.revision} can't be drawn: ${e.message}`) : e
        if (live) setShown((before) => after(reason, before))
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
  const problem = shownNow.phase === 'broken' ? shownNow.problem : drawn?.slipped ?? ''
  const hostPlan = compose('view-host', {
    flags: {
      'view.starting': shownNow.phase === 'starting',
      'view.drawn': drawn !== null,
      'view.broken': shownNow.phase === 'broken',
      'view.slipped': !!drawn?.slipped,
      'view.stopped': shownNow.phase === 'stopped',
      'view.unsafe': shownNow.phase === 'unsafe',
    },
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
  const full = mode === 'fullscreen'
  return (
    <dialog
      ref={boxRef}
      aria-label={`${view.title}, a view`}
      data-view={view.artifact_id}
      data-view-carrier="metta"
      data-view-revision={revision}
      data-view-mode={mode}
      data-view-state={shownNow.phase}
      onCancel={(e) => { e.preventDefault(); setMode('inline') }}
      className={dialogClass(full)}
    >
      <ViewBar title={view.title} full={full} onMode={setMode} extra={extra} />
      <div className={full ? 'h-[calc(100dvh-3rem)] overflow-auto p-4' : 'rounded-2xl border border-line p-4'}>
        {/* a view's screens are the view's, never the page's: the stage does not arrange their parts */}
        <NotThePage.Provider value={true}>
        <Screen
          plan={hostPlan}
          className="space-y-3"
          host={{
            data: { 'view.problem': problem, 'view.maker': makerName ?? 'a mind' },
            onAction: (action) => { if (action === 'restart') setRun((n) => n + 1) },
            islands: { [VIEW_ISLAND]: viewHost && drawn ? <Screen plan={drawn.frame.plan} host={viewHost} className="space-y-3" /> : null },
          }}
        />
        </NotThePage.Provider>
      </div>
    </dialog>
  )
}
